import { createHash, randomBytes } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { createConnection, createServer, type Socket } from 'node:net'
import { mkdir, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { resolveClaudePaths } from '../compatibility/claude/paths.js'
import type { RuntimeEventSink } from '../core/runtime.js'
import {
  ClaudeJobStore,
  isProcessAlive,
  newClaudeJobIdentity,
  type ClaudeJobState,
  type ClaudeJobDispatch,
} from '../persistence/claude-job-store.js'
import { writeFileAtomically } from '../platform/atomic-write.js'
import {
  redactSensitiveText,
  sanitizeChildEnvironment,
  sensitiveEnvironmentValues,
} from '../platform/sensitive-data.js'
import type { SessionRunResult } from './session-service.js'

export interface TopLevelAgentSummary {
  pid?: number
  id?: string
  cwd: string
  kind: 'background' | 'interactive'
  startedAt: number
  sessionId: string
  name: string
  status?: 'active' | 'idle'
  state?: 'working' | 'stopped' | 'failed'
}

export interface TopLevelAgentRuntime {
  run(
    prompt: string,
    signal: AbortSignal,
    sessionId: string,
  ): Promise<SessionRunResult>
  resume(
    sessionId: string,
    prompt: string,
    signal: AbortSignal,
  ): Promise<SessionRunResult>
  close?(): Promise<void>
}

export interface TopLevelAgentManagerOptions {
  configRoot: string
  cwd: string
  cliPath: string
  executablePath?: string
  environment?: NodeJS.ProcessEnv
  version: string
}

interface WireMessage {
  type: string
  token?: string
  text?: string
  requestId?: string
  status?: string
  message?: string
}

const STARTUP_CONTROL_WAIT_MS = 1_000
const ATTACH_READY_WAIT_MS = 5_000
const WORKER_REGISTRATION_GRACE_MS = 5_000
const JOB_CREATE_ATTEMPTS = 32
const MAX_JOB_OUTPUT_BYTES = 1024 * 1024
const MAX_ATTACH_PROMPT_BYTES = 1024 * 1024
const MAX_WIRE_LINE_BYTES = 8 * 1024 * 1024
const MAX_SOCKET_BUFFER_BYTES = 10 * 1024 * 1024

// Background workers are trusted Praxis runtimes, but still must not inherit
// unrelated credentials or shell startup injection from the launching shell.
// Provider/file credentials are restored explicitly because worker creates its
// own provider from the same CLI/environment contract.
const WORKER_RUNTIME_ENVIRONMENT = [
  'PRAXIS_API_KEY',
  'PRAXIS_MODEL',
  'PRAXIS_PROVIDER',
  'PRAXIS_BASE_URL',
  'PRAXIS_MAX_OUTPUT_TOKENS',
  'PRAXIS_ANTHROPIC_VERSION',
  'PRAXIS_ANTHROPIC_WEB_SEARCH',
  'PRAXIS_CONTEXT_WINDOW_TOKENS',
  'PRAXIS_CONTEXT_RESERVE_TOKENS',
  'PRAXIS_PRICING_JSON',
  'PRAXIS_FILES_BASE_URL',
  'PRAXIS_FILES_BEARER_TOKEN',
  'PRAXIS_FILES_API_KEY',
  'PRAXIS_MCP_OAUTH_STORE',
  'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING',
] as const

function workerEnvironment(
  source: NodeJS.ProcessEnv,
  configRoot: string,
): Record<string, string> {
  const environment = sanitizeChildEnvironment({}, source)
  for (const name of WORKER_RUNTIME_ENVIRONMENT) {
    const value = source[name]
    if (value !== undefined) environment[name] = value
  }
  environment.CLAUDE_CONFIG_DIR = configRoot
  return environment
}

function socketPath(configRoot: string, id: string): string {
  const owner = typeof process.getuid === 'function' ? process.getuid() : 0
  const rootHash = createHash('sha256')
    .update(configRoot)
    .digest('hex')
    .slice(0, 12)
  return join(tmpdir(), `praxis-agent-${owner}`, rootHash, `${id}.sock`)
}

function writeWire(socket: Socket, message: WireMessage): void {
  if (socket.destroyed) return
  if (socket.writableLength > MAX_SOCKET_BUFFER_BYTES) {
    socket.destroy()
    return
  }
  socket.write(`${JSON.stringify(message)}\n`)
}

function clearWorkerFields(state: ClaudeJobState): ClaudeJobState {
  const next = { ...state }
  delete next.pid
  delete next.socketPath
  delete next.controlToken
  delete next.inFlight
  return next
}

interface NativeClaudeSession {
  pid: number
  cwd: string
  kind: 'interactive'
  startedAt: number
  sessionId: string
  name: string
  status: 'active' | 'idle'
}

function nativeClaudeSession(value: unknown): NativeClaudeSession | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return
  const record = value as Record<string, unknown>
  if (
    !Number.isSafeInteger(record.pid) ||
    typeof record.cwd !== 'string' ||
    record.kind !== 'interactive' ||
    !Number.isSafeInteger(record.startedAt) ||
    typeof record.sessionId !== 'string' ||
    typeof record.name !== 'string' ||
    !['active', 'idle'].includes(String(record.status))
  )
    return
  return record as unknown as NativeClaudeSession
}

function parseWire(line: string): WireMessage | null {
  try {
    const value = JSON.parse(line) as unknown
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      typeof (value as Record<string, unknown>).type !== 'string'
    ) {
      return null
    }
    return value as WireMessage
  } catch {
    return null
  }
}

function lines(socket: Socket, receive: (message: WireMessage) => void): void {
  let buffer = ''
  socket.setEncoding('utf8')
  socket.on('data', (chunk: string) => {
    buffer += chunk
    if (
      Buffer.byteLength(buffer) > MAX_WIRE_LINE_BYTES &&
      !buffer.includes('\n')
    ) {
      socket.destroy()
      return
    }
    for (;;) {
      const newline = buffer.indexOf('\n')
      if (newline < 0) break
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (Buffer.byteLength(line) > MAX_WIRE_LINE_BYTES) {
        socket.destroy()
        return
      }
      const message = parseWire(line)
      if (message) receive(message)
    }
  })
}

async function canonicalDirectory(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return resolve(path)
  }
}

export class TopLevelAgentManager {
  private readonly store: ClaudeJobStore

  constructor(private readonly options: TopLevelAgentManagerOptions) {
    this.store = new ClaudeJobStore(options.configRoot)
  }

  async launch(options: {
    prompt: string
    argv: string[]
    resumeSessionId?: string
    cwd?: string
  }): Promise<{ id: string; sessionId: string }> {
    const cwd = await canonicalDirectory(options.cwd ?? this.options.cwd)
    let identity: { id: string; sessionId: string } | undefined
    let state: ClaudeJobState | undefined
    for (let attempt = 0; attempt < JOB_CREATE_ATTEMPTS; attempt += 1) {
      const generated = newClaudeJobIdentity()
      const sessionId = options.resumeSessionId ?? generated.sessionId
      const now = new Date().toISOString()
      const candidate: ClaudeJobState = {
        state: 'working',
        detail: 'starting',
        tempo: 'active',
        inFlight: { tasks: 1, queued: 0, kinds: ['prompt'] },
        tokens: 0,
        output: null,
        children: null,
        template: 'bg',
        respawnFlags: [...options.argv],
        intent: options.prompt,
        sessionId,
        resumeSessionId: sessionId,
        daemonShort: generated.id,
        cliVersion: this.options.version,
        cwd,
        backend: 'daemon',
        praxisOwner: 1,
        createdAt: now,
        updatedAt: now,
        firstTerminalAt: null,
        socketPath: socketPath(this.options.configRoot, generated.id),
        controlToken: randomBytes(24).toString('hex'),
      }
      if (
        await this.store.create(candidate, {
          version: 1,
          argv: [...options.argv],
          resume: options.resumeSessionId !== undefined,
        })
      ) {
        identity = { id: generated.id, sessionId }
        state = candidate
        break
      }
    }
    if (!identity || !state) throw new Error('Could not allocate agent ID')

    let child: ChildProcess
    try {
      child = spawn(
        this.options.executablePath ?? process.execPath,
        [this.options.cliPath, '__background-worker', identity.id],
        {
          cwd,
          env: workerEnvironment(
            this.options.environment ?? process.env,
            this.options.configRoot,
          ),
          detached: true,
          stdio: 'ignore',
        },
      )
      await new Promise<void>((resolveSpawn, rejectSpawn) => {
        const spawned = () => {
          child.removeListener('error', failed)
          resolveSpawn()
        }
        const failed = (error: Error) => {
          child.removeListener('spawn', spawned)
          rejectSpawn(error)
        }
        child.once('spawn', spawned)
        child.once('error', failed)
      })
    } catch (error) {
      const failedAt = new Date().toISOString()
      const message = redactSensitiveText(
        error instanceof Error ? error.message : String(error),
        sensitiveEnvironmentValues(this.options.environment ?? process.env),
      )
      await this.store.update(identity.id, (current) => ({
        ...clearWorkerFields(current),
        state: 'failed',
        detail: message,
        tempo: 'idle',
        updatedAt: failedAt,
        firstTerminalAt: failedAt,
      }))
      throw new Error('Could not start background agent', { cause: error })
    }
    const childPid = child.pid
    if (!childPid) {
      await this.store.update(identity.id, (current) => ({
        ...clearWorkerFields(current),
        state: 'failed',
        detail: 'worker failed to start',
        tempo: 'idle',
        updatedAt: new Date().toISOString(),
        firstTerminalAt: new Date().toISOString(),
      }))
      throw new Error('Could not start background agent')
    }
    child.unref()
    await this.store.update(identity.id, (current) => ({
      ...current,
      pid: childPid,
      updatedAt: new Date().toISOString(),
    }))
    return identity
  }

  async list(options: {
    cwd?: string
    all: boolean
  }): Promise<TopLevelAgentSummary[]> {
    const cwd =
      options.cwd === undefined
        ? undefined
        : await canonicalDirectory(options.cwd)
    const states = await this.store.list()
    const reconciled = await Promise.all(
      states.map(async (state) => {
        if (state.state !== 'working' || (await this.workerAlive(state))) {
          return state
        }
        return this.store.update(state.daemonShort, (current) => {
          if (current.state !== 'working' || current.pid !== state.pid) {
            return current
          }
          const now = new Date().toISOString()
          return {
            ...clearWorkerFields(current),
            state: 'failed',
            detail: 'worker exited unexpectedly',
            tempo: 'idle',
            updatedAt: now,
            firstTerminalAt: current.firstTerminalAt ?? now,
          }
        })
      }),
    )
    const praxis = reconciled
      .filter((state) => cwd === undefined || state.cwd === cwd)
      .filter((state) => options.all || state.state === 'working')
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((state) => ({
        ...(state.state === 'working' && state.pid !== undefined
          ? { pid: state.pid }
          : {}),
        id: state.daemonShort,
        cwd: state.cwd,
        kind: 'background' as const,
        startedAt: Date.parse(state.createdAt),
        sessionId: state.sessionId,
        name: state.intent,
        ...(state.state === 'working'
          ? {
              status:
                state.tempo === 'idle'
                  ? ('idle' as const)
                  : ('active' as const),
            }
          : {}),
        state: state.state,
      }))
    const native = await this.nativeSessions(
      cwd,
      new Set(reconciled.map((state) => state.sessionId)),
    )
    return [...praxis, ...native].sort(
      (left, right) => right.startedAt - left.startedAt,
    )
  }

  private async nativeSessions(
    cwd: string | undefined,
    knownSessionIds: ReadonlySet<string>,
  ): Promise<TopLevelAgentSummary[]> {
    let files: string[]
    try {
      files = await readdir(join(this.options.configRoot, 'sessions'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const sessions = await Promise.all(
      files
        .filter((file) => file.endsWith('.json'))
        .map(async (file) => {
          try {
            return nativeClaudeSession(
              JSON.parse(
                await readFile(
                  join(this.options.configRoot, 'sessions', file),
                  'utf8',
                ),
              ),
            )
          } catch {
            return undefined
          }
        }),
    )
    return sessions
      .filter(
        (session): session is NativeClaudeSession => session !== undefined,
      )
      .filter((session) => !knownSessionIds.has(session.sessionId))
      .filter((session) => cwd === undefined || session.cwd === cwd)
  }

  async logs(id: string): Promise<string> {
    await this.store.read(id)
    return this.store.output(id)
  }

  async review(
    agent: Pick<TopLevelAgentSummary, 'id' | 'cwd' | 'sessionId'>,
  ): Promise<string> {
    if (agent.id !== undefined) return this.logs(agent.id)
    try {
      return await readFile(
        resolveClaudePaths({
          configDir: this.options.configRoot,
          cwd: agent.cwd,
          sessionId: agent.sessionId,
        }).sessionFile,
        'utf8',
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return 'No local transcript is available for this Claude session.\n'
      }
      throw error
    }
  }

  async stop(id: string): Promise<void> {
    const state = await this.store.read(id)
    if (state.state !== 'working') {
      throw new Error(`Agent ${id} is not running (state: ${state.state})`)
    }
    let stopped = false
    if (state.socketPath && state.controlToken) {
      try {
        const response = await this.request(
          state.socketPath,
          { type: 'stop', token: state.controlToken },
          STARTUP_CONTROL_WAIT_MS,
        )
        stopped = response.type === 'stopped'
      } catch {
        // Worker may still be between spawn and control-socket initialization.
      }
    }
    if (
      !stopped &&
      state.pid !== undefined &&
      (await this.workerAlive(state))
    ) {
      process.kill(state.pid, 'SIGTERM')
    }
    const now = new Date().toISOString()
    await this.store.update(id, (current) => ({
      ...clearWorkerFields(current),
      state: 'stopped',
      detail: 'stopped',
      tempo: 'idle',
      updatedAt: now,
      firstTerminalAt: current.firstTerminalAt ?? now,
    }))
  }

  async attach(
    id: string,
    input: AsyncIterable<string | Uint8Array>,
    output: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const state = await this.store.read(id)
    if (state.state !== 'working' || !state.socketPath || !state.controlToken) {
      throw new Error(`Agent ${id} is not attachable (state: ${state.state})`)
    }
    const socket = createConnection(state.socketPath)
    await new Promise<void>((resolveConnect, reject) => {
      socket.once('connect', resolveConnect)
      socket.once('error', reject)
    })
    let readyResolve: (() => void) | undefined
    let readyReject: ((error: Error) => void) | undefined
    let isReady = false
    const ready = new Promise<void>((resolveReady, rejectReady) => {
      readyResolve = resolveReady
      readyReject = rejectReady
    })
    const readyTimer = setTimeout(() => {
      readyReject?.(new Error(`Agent ${id} attach handshake timed out`))
      socket.destroy()
    }, ATTACH_READY_WAIT_MS)
    const completions = new Map<
      string,
      { resolve: () => void; reject: (error: Error) => void }
    >()
    lines(socket, (message) => {
      if (message.type === 'ready') {
        isReady = true
        clearTimeout(readyTimer)
        if (message.text) output(message.text)
        readyResolve?.()
      } else if (message.type === 'output' && message.text) {
        output(message.text)
      } else if (message.type === 'turn-complete' && message.requestId) {
        completions.get(message.requestId)?.resolve()
        completions.delete(message.requestId)
      } else if (message.type === 'turn-error' && message.requestId) {
        completions
          .get(message.requestId)
          ?.reject(new Error(message.message ?? 'Agent turn failed'))
        completions.delete(message.requestId)
      }
    })
    const connectionClosed = () => {
      const error = new Error(`Agent ${id} detached unexpectedly`)
      if (!isReady) readyReject?.(error)
      for (const completion of completions.values()) completion.reject(error)
      completions.clear()
    }
    socket.once('close', connectionClosed)
    writeWire(socket, { type: 'attach', token: state.controlToken })
    const abort = () => socket.destroy(new Error('Attach cancelled'))
    signal?.addEventListener('abort', abort, { once: true })
    try {
      await ready
      const decoder = new TextDecoder()
      let inputBuffer = ''
      const sendPrompt = async (prompt: string) => {
        if (prompt.trim().length === 0) return
        if (Buffer.byteLength(prompt) > MAX_ATTACH_PROMPT_BYTES) {
          throw new Error(
            `Agent prompt exceeds ${MAX_ATTACH_PROMPT_BYTES} bytes`,
          )
        }
        const requestId = randomBytes(12).toString('hex')
        const completion = new Promise<void>((resolveTurn, rejectTurn) => {
          completions.set(requestId, {
            resolve: resolveTurn,
            reject: rejectTurn,
          })
        })
        writeWire(socket, { type: 'prompt', text: prompt, requestId })
        await completion
      }
      for await (const chunk of input) {
        if (signal?.aborted) break
        inputBuffer +=
          typeof chunk === 'string'
            ? chunk
            : decoder.decode(chunk, { stream: true })
        if (
          Buffer.byteLength(inputBuffer) > MAX_ATTACH_PROMPT_BYTES &&
          !inputBuffer.includes('\n')
        ) {
          throw new Error(
            `Agent prompt exceeds ${MAX_ATTACH_PROMPT_BYTES} bytes`,
          )
        }
        for (;;) {
          const newline = inputBuffer.indexOf('\n')
          if (newline < 0) break
          const prompt = inputBuffer.slice(0, newline).replace(/\r$/u, '')
          inputBuffer = inputBuffer.slice(newline + 1)
          await sendPrompt(prompt)
        }
      }
      inputBuffer += decoder.decode()
      await sendPrompt(inputBuffer.replace(/\r$/u, ''))
      writeWire(socket, { type: 'detach' })
    } finally {
      clearTimeout(readyTimer)
      signal?.removeEventListener('abort', abort)
      socket.removeListener('close', connectionClosed)
      socket.end()
    }
  }

  private async request(
    path: string,
    message: WireMessage,
    timeoutMs: number,
  ): Promise<WireMessage> {
    return new Promise((resolveRequest, reject) => {
      const socket = createConnection(path)
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error('Agent control request timed out'))
      }, timeoutMs)
      timer.unref?.()
      const finish = (operation: () => void) => {
        clearTimeout(timer)
        socket.end()
        operation()
      }
      socket.once('error', (error) => finish(() => reject(error)))
      socket.once('connect', () => writeWire(socket, message))
      lines(socket, (response) => finish(() => resolveRequest(response)))
    })
  }

  private async workerAlive(state: ClaudeJobState): Promise<boolean> {
    if (state.pid === undefined || !isProcessAlive(state.pid)) return false
    try {
      const value = JSON.parse(
        await readFile(
          join(this.options.configRoot, 'sessions', `${state.pid}.json`),
          'utf8',
        ),
      ) as unknown
      return (
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        (value as Record<string, unknown>).pid === state.pid &&
        (value as Record<string, unknown>).jobId === state.daemonShort &&
        (value as Record<string, unknown>).sessionId === state.sessionId
      )
    } catch {
      const createdAt = Date.parse(state.createdAt)
      return (
        state.detail === 'starting' &&
        Number.isFinite(createdAt) &&
        Date.now() - createdAt < WORKER_REGISTRATION_GRACE_MS
      )
    }
  }
}

export async function runTopLevelAgentWorker(options: {
  configRoot: string
  id: string
  createRuntime(
    eventSink: RuntimeEventSink,
    dispatch: ClaudeJobDispatch,
  ): Promise<TopLevelAgentRuntime>
}): Promise<void> {
  const store = new ClaudeJobStore(options.configRoot)
  const initial = await store.read(options.id)
  const dispatch = await store.readDispatch(options.id)
  const sensitiveValues = sensitiveEnvironmentValues(process.env)
  const safeText = (text: string): string =>
    redactSensitiveText(text, sensitiveValues)
  const safeErrorMessage = (error: unknown): string =>
    safeText(error instanceof Error ? error.message : String(error))
  if (initial.state !== 'working') return
  if (!initial.socketPath || !initial.controlToken) {
    throw new Error(`Agent ${options.id} has no control endpoint`)
  }
  const socketFile = initial.socketPath
  const processFile = join(
    options.configRoot,
    'sessions',
    `${process.pid}.json`,
  )
  const processStartedAt = Date.now()
  const writeProcessStatus = (status: 'working' | 'idle') => {
    const now = Date.now()
    return writeFileAtomically(
      processFile,
      `${JSON.stringify({
        pid: process.pid,
        sessionId: initial.sessionId,
        cwd: initial.cwd,
        startedAt: processStartedAt,
        version: initial.cliVersion,
        kind: 'bg',
        entrypoint: 'cli',
        name: initial.intent,
        jobId: options.id,
        status,
        updatedAt: now,
        statusUpdatedAt: now,
      })}\n`,
    )
  }
  await mkdir(dirname(socketFile), { recursive: true })
  await rm(socketFile, { force: true })

  const clients = new Set<Socket>()
  const broadcast = (message: WireMessage) => {
    for (const client of clients) writeWire(client, message)
  }
  let liveTurnText = ''
  let outputWriteError: unknown
  let outputWrites = Promise.resolve()
  let runtime: TopLevelAgentRuntime
  try {
    runtime = await options.createRuntime((event) => {
      if (event.type === 'text-delta') {
        const delta = safeText(event.delta)
        liveTurnText += delta
        outputWrites = outputWrites
          .then(() => store.appendOutput(options.id, delta))
          .catch((error: unknown) => {
            outputWriteError = error
          })
        broadcast({ type: 'output', text: delta })
      }
    }, dispatch)
  } catch (error) {
    const message = safeErrorMessage(error)
    const failedAt = new Date().toISOString()
    await store.appendOutput(options.id, `${message}\n`)
    await store.appendTimeline(options.id, {
      at: failedAt,
      state: 'failed',
      detail: message,
      text: message,
    })
    await store.update(options.id, (state) => ({
      ...clearWorkerFields(state),
      state: 'failed',
      detail: message,
      tempo: 'idle',
      updatedAt: failedAt,
      firstTerminalAt: state.firstTerminalAt ?? failedAt,
    }))
    return
  }
  let activeController: AbortController | undefined
  let closing = false
  let turnQueue = Promise.resolve()
  let finishWorker: (() => void) | undefined
  const finished = new Promise<void>((resolveFinished) => {
    finishWorker = resolveFinished
  })

  const server = createServer((client) => {
    let authenticated = false
    lines(client, (message) => {
      if (!authenticated) {
        if (message.type === 'stop' && message.token === initial.controlToken) {
          authenticated = true
          writeWire(client, { type: 'stopped' })
          void setStopped('stopped').catch(() => undefined)
          return
        }
        if (
          message.type !== 'attach' ||
          message.token !== initial.controlToken
        ) {
          client.destroy()
          return
        }
        authenticated = true
        clients.add(client)
        void store.output(options.id).then((history) => {
          writeWire(client, {
            type: 'ready',
            text: history,
          })
        })
        return
      }
      if (message.type === 'detach') {
        client.end()
        return
      }
      if (message.type === 'prompt' && message.text && message.requestId) {
        const { text, requestId } = message
        turnQueue = turnQueue.then(() => runTurn(text, true, requestId, client))
      }
    })
    client.once('close', () => clients.delete(client))
  })

  const closeControl = () => {
    for (const client of clients) client.end()
    if (server.listening) server.close()
    finishWorker?.()
  }

  const setStopped = async (detail: string) => {
    if (closing) return
    liveTurnText = ''
    closing = true
    activeController?.abort()
    const now = new Date().toISOString()
    try {
      await store.update(options.id, (state) => ({
        ...clearWorkerFields(state),
        state: 'stopped',
        detail,
        tempo: 'idle',
        updatedAt: now,
        firstTerminalAt: state.firstTerminalAt ?? now,
      }))
      await store.appendTimeline(options.id, {
        at: now,
        state: 'stopped',
        detail,
        text: detail,
      })
    } finally {
      broadcast({ type: 'stopped' })
      closeControl()
    }
  }

  const failWorker = async (error: unknown) => {
    if (closing) return
    closing = true
    activeController?.abort()
    const message = safeErrorMessage(error)
    const now = new Date().toISOString()
    try {
      await store.appendOutput(options.id, `${message}\n`)
      await store.trimOutput(options.id, MAX_JOB_OUTPUT_BYTES)
      await store.appendTimeline(options.id, {
        at: now,
        state: 'failed',
        detail: message,
        text: message,
      })
      await store.update(options.id, (state) => ({
        ...clearWorkerFields(state),
        state: 'failed',
        detail: message,
        tempo: 'idle',
        updatedAt: now,
        firstTerminalAt: state.firstTerminalAt ?? now,
      }))
    } finally {
      broadcast({ type: 'failed', message })
      closeControl()
    }
  }

  async function runTurn(
    prompt: string,
    resume: boolean,
    requestId?: string,
    client?: Socket,
  ): Promise<void> {
    if (closing) return
    liveTurnText = ''
    outputWriteError = undefined
    activeController = new AbortController()
    const now = new Date().toISOString()
    const activated = await store.update(options.id, (state) =>
      state.state !== 'working'
        ? state
        : {
            ...state,
            detail: safeText(prompt),
            tempo: 'active',
            inFlight: { tasks: 1, queued: 0, kinds: ['prompt'] },
            updatedAt: now,
          },
    )
    if (closing || activated.state !== 'working') return
    await writeProcessStatus('working')
    try {
      const result = resume
        ? await runtime.resume(
            initial.sessionId,
            prompt,
            activeController.signal,
          )
        : await runtime.run(prompt, activeController.signal, initial.sessionId)
      if (closing) return
      const completedAt = new Date().toISOString()
      await outputWrites
      if (outputWriteError) throw outputWriteError
      const resultText = safeText(result.text)
      if (liveTurnText.length === 0 && resultText.length > 0) {
        broadcast({ type: 'output', text: resultText })
        await store.appendOutput(options.id, resultText)
      }
      await store.appendOutput(options.id, '\n')
      await store.trimOutput(options.id, MAX_JOB_OUTPUT_BYTES)
      await store.appendTimeline(options.id, {
        at: completedAt,
        state: 'working',
        detail: resultText,
        text: resultText,
      })
      const idled = await store.update(options.id, (state) =>
        state.state !== 'working'
          ? state
          : {
              ...state,
              detail: resultText,
              tempo: 'idle',
              inFlight: { tasks: 0, queued: 0, kinds: [] },
              tokens:
                state.tokens +
                result.usage.inputTokens +
                result.usage.outputTokens,
              updatedAt: completedAt,
            },
      )
      if (!closing && idled.state === 'working') {
        await writeProcessStatus('idle')
      }
      if (requestId && client) {
        writeWire(client, { type: 'turn-complete', requestId })
      }
    } catch (error) {
      if (closing || activeController.signal.aborted) return
      const message = safeErrorMessage(error)
      const failedAt = new Date().toISOString()
      if (resume) {
        try {
          await store.appendOutput(options.id, `${message}\n`)
          await store.trimOutput(options.id, MAX_JOB_OUTPUT_BYTES)
          await store.appendTimeline(options.id, {
            at: failedAt,
            state: 'working',
            detail: message,
            text: message,
          })
          const idled = await store.update(options.id, (state) =>
            state.state !== 'working'
              ? state
              : {
                  ...state,
                  detail: message,
                  tempo: 'idle',
                  inFlight: { tasks: 0, queued: 0, kinds: [] },
                  updatedAt: failedAt,
                },
          )
          if (!closing && idled.state === 'working') {
            await writeProcessStatus('idle')
          }
          if (requestId && client) {
            writeWire(client, { type: 'turn-error', requestId, message })
          }
        } catch (persistenceError) {
          await failWorker(persistenceError)
        }
      } else {
        await failWorker(error)
      }
    } finally {
      activeController = undefined
    }
  }

  server.on(
    'error',
    (error) => void failWorker(error).catch(() => closeControl()),
  )

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(socketFile, resolveListen)
  })
  const registered = await store.update(options.id, (state) =>
    state.state !== 'working'
      ? state
      : {
          ...state,
          pid: process.pid,
          detail: 'starting',
          tempo: 'active',
          socketPath: socketFile,
          updatedAt: new Date().toISOString(),
        },
  )
  if (registered.state !== 'working') {
    server.close()
    await runtime.close?.()
    await rm(socketFile, { force: true })
    return
  }
  await writeProcessStatus('working')

  const stop = () => void setStopped('stopped').catch(() => undefined)
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  turnQueue = turnQueue.then(() => runTurn(initial.intent, dispatch.resume))
  try {
    await finished
  } finally {
    process.removeListener('SIGTERM', stop)
    process.removeListener('SIGINT', stop)
    await turnQueue.catch(() => undefined)
    await outputWrites
    await runtime.close?.()
    await rm(socketFile, { force: true })
    await rm(processFile, { force: true })
  }
}
