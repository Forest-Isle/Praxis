import { createHash, randomBytes } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { createConnection, createServer, type Socket } from 'node:net'
import { mkdir, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { isTerminalLifecycleState } from '../core/agent-orchestration.js'
import type { RuntimeEventSink } from '../core/runtime.js'
import {
  ClaudeJobStore,
  type ClaudeJobExecution,
  isProcessAlive,
  newClaudeJobIdentity,
  type ClaudeJobState,
  type ClaudeJobDispatch,
  type ClaudeJobLifecycleView,
  type ClaudeJobSourceCheckpoint,
  type ClaudeJobTempo,
} from '../persistence/claude-job-store.js'
import {
  resolveDataPlanePaths,
  type DataPlane,
} from '../persistence/data-plane.js'
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
  kind: 'background' | 'interactive' | 'bg' | 'daemon' | 'daemon-worker'
  startedAt: number
  sessionId: string
  name: string
  status?: 'active' | 'idle' | 'busy' | 'waiting'
  tempo?: ClaudeJobTempo
  needs?: string
  state?: 'working' | 'stopped' | 'failed' | 'done'
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
  fork?(
    sessionId: string,
    targetSessionId?: string,
  ): Promise<{ parentSessionId: string; sessionId: string }>
  ensureFork?(
    sessionId: string,
    targetSessionId: string,
    checkpoint?: ClaudeJobSourceCheckpoint,
  ): Promise<{ parentSessionId: string; sessionId: string }>
  close?(): Promise<void>
}

export interface TopLevelAgentManagerOptions {
  configRoot: string
  dataPlane?: DataPlane
  cwd: string
  cliPath: string
  executablePath?: string
  environment?: NodeJS.ProcessEnv
  resolveProviderEnvironment?: (request: {
    cwd: string
    argv: readonly string[]
  }) => Promise<ProviderEnvironmentOverride>
  version: string
}

export interface ProviderEnvironmentOverride {
  PRAXIS_API_KEY?: string
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
const SOCKET_RETRY_INTERVAL_MS = 25

// Background workers are trusted Praxis runtimes, but still must not inherit
// unrelated credentials or shell startup injection from the launching shell.
// Provider/file credentials are restored explicitly because worker creates its
// own provider from the same CLI/environment contract.
const WORKER_RUNTIME_ENVIRONMENT = [
  'PRAXIS_API_KEY',
  'CLAUDE_CODE_SIMPLE',
  'PRAXIS_MODEL',
  'PRAXIS_PROVIDER',
  'PRAXIS_PROVIDER_PROFILE',
  'PRAXIS_PROVIDER_DEADLINE_MS',
  'PRAXIS_PROVIDER_CONNECT_TIMEOUT_MS',
  'PRAXIS_PROVIDER_IDLE_TIMEOUT_MS',
  'PRAXIS_BASE_URL',
  'PRAXIS_MAX_OUTPUT_TOKENS',
  'PRAXIS_ANTHROPIC_VERSION',
  'PRAXIS_ANTHROPIC_WEB_SEARCH',
  'PRAXIS_DISABLE_NONSTREAMING_FALLBACK',
  'PRAXIS_ANTHROPIC_PROMPT_CACHING',
  'PRAXIS_ANTHROPIC_PROMPT_CACHE_TTL',
  'PRAXIS_CONTEXT_WINDOW_TOKENS',
  'PRAXIS_CONTEXT_RESERVE_TOKENS',
  'PRAXIS_PRICING_JSON',
  'PRAXIS_FILES_BASE_URL',
  'PRAXIS_FILES_BEARER_TOKEN',
  'PRAXIS_FILES_API_KEY',
  'PRAXIS_PROVIDER_CREDENTIAL_STORE',
  'PRAXIS_MCP_OAUTH_STORE',
  'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING',
] as const

function workerEnvironment(
  source: NodeJS.ProcessEnv,
  configRoot: string,
  resolved?: ProviderEnvironmentOverride,
): Record<string, string> {
  const environment = sanitizeChildEnvironment({ PATH: source.PATH }, {})
  for (const name of WORKER_RUNTIME_ENVIRONMENT) {
    const value = source[name]
    if (value !== undefined) environment[name] = value
  }
  environment.PRAXIS_DATA_PLANE = 'native'
  environment.PRAXIS_HOME = configRoot
  if (resolved?.PRAXIS_API_KEY !== undefined)
    environment.PRAXIS_API_KEY = resolved.PRAXIS_API_KEY
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

export function topLevelAgentProcessRegistryRoot(
  configRoot: string,
  dataPlane?: DataPlane,
): string {
  void dataPlane
  return join(configRoot, 'state', 'sessions')
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
  delete next.needs
  return next
}

type NativeClaudeSession = TopLevelAgentSummary

function nativeClaudeSession(value: unknown): NativeClaudeSession | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return
  const record = value as Record<string, unknown>
  const interactive =
    Number.isSafeInteger(record.pid) &&
    typeof record.cwd === 'string' &&
    record.kind === 'interactive' &&
    Number.isSafeInteger(record.startedAt) &&
    typeof record.sessionId === 'string' &&
    typeof record.name === 'string' &&
    ['active', 'idle'].includes(String(record.status))
  if (interactive) return record as unknown as NativeClaudeSession
  const daemon =
    Number.isSafeInteger(record.pid) &&
    typeof record.cwd === 'string' &&
    ['bg', 'daemon', 'daemon-worker'].includes(String(record.kind)) &&
    Number.isSafeInteger(record.startedAt) &&
    typeof record.sessionId === 'string' &&
    typeof record.name === 'string' &&
    ['busy', 'idle', 'waiting'].includes(String(record.status))
  if (daemon) return record as unknown as NativeClaudeSession
  if (
    typeof record.id !== 'string' ||
    typeof record.cwd !== 'string' ||
    record.kind !== 'background' ||
    !Number.isSafeInteger(record.startedAt) ||
    typeof record.sessionId !== 'string' ||
    typeof record.name !== 'string' ||
    !['done', 'failed'].includes(String(record.state))
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

function transientSocketError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ECONNREFUSED'
}

function waitForSocketRetry(signal?: AbortSignal): Promise<void> {
  return new Promise((resolveWait, rejectWait) => {
    if (signal?.aborted) {
      rejectWait(new Error('Attach cancelled'))
      return
    }
    const abort = () => {
      clearTimeout(timer)
      rejectWait(new Error('Attach cancelled'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolveWait()
    }, SOCKET_RETRY_INTERVAL_MS)
    signal?.addEventListener('abort', abort, { once: true })
  })
}

async function connectToWorker(
  path: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Socket> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (signal?.aborted) throw new Error('Attach cancelled')
    const socket = createConnection(path)
    try {
      await new Promise<void>((resolveConnect, rejectConnect) => {
        const connected = () => {
          socket.removeListener('error', failed)
          resolveConnect()
        }
        const failed = (error: Error) => {
          socket.removeListener('connect', connected)
          rejectConnect(error)
        }
        socket.once('connect', connected)
        socket.once('error', failed)
      })
      return socket
    } catch (error) {
      socket.destroy()
      if (!transientSocketError(error) || Date.now() >= deadline) throw error
      await waitForSocketRetry(signal)
    }
  }
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
    this.store = new ClaudeJobStore(
      options.configRoot,
      join(options.configRoot, 'state'),
    )
  }

  async launch(options: {
    prompt: string
    argv: string[]
    resumeSessionId?: string
    cwd?: string
    deferInitialTurn?: boolean
    sourceSessionId?: string
    sourceCheckpoint?: ClaudeJobSourceCheckpoint
    initialDetail?: string
  }): Promise<{ id: string; sessionId: string }> {
    const cwd = await canonicalDirectory(options.cwd ?? this.options.cwd)
    let identity: { id: string; sessionId: string } | undefined
    let state: ClaudeJobState | undefined
    let execution: ClaudeJobExecution | undefined
    for (let attempt = 0; attempt < JOB_CREATE_ATTEMPTS; attempt += 1) {
      const generated = newClaudeJobIdentity()
      const sessionId = options.sourceSessionId
        ? generated.sessionId
        : (options.resumeSessionId ?? generated.sessionId)
      const now = new Date().toISOString()
      const candidate: ClaudeJobState = {
        state: 'working',
        detail: options.deferInitialTurn
          ? (options.initialDetail ?? options.prompt)
          : 'starting',
        tempo: options.deferInitialTurn ? 'blocked' : 'active',
        ...(options.deferInitialTurn
          ? { needs: 'send a prompt to start' }
          : {}),
        ...(options.deferInitialTurn
          ? {}
          : { inFlight: { tasks: 1, queued: 0, kinds: ['prompt'] } }),
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
      const created = await this.store.createExecution(candidate, {
        version: 1,
        argv: [...options.argv],
        resume: options.resumeSessionId !== undefined,
        ...(options.deferInitialTurn ? { deferInitialTurn: true } : {}),
        ...(options.sourceSessionId === undefined
          ? {}
          : { sourceSessionId: options.sourceSessionId }),
        ...(options.sourceCheckpoint === undefined
          ? {}
          : { sourceCheckpoint: options.sourceCheckpoint }),
      })
      if (created) {
        identity = { id: generated.id, sessionId }
        state = candidate
        execution = created
        break
      }
    }
    if (!identity || !state || !execution)
      throw new Error('Could not allocate agent ID')

    const allocatedExecution = execution
    let child: ChildProcess | undefined
    let resolvedProviderEnvironment: ProviderEnvironmentOverride | undefined
    const failLaunch = async (error: unknown): Promise<never> => {
      const sensitiveValues = [
        ...sensitiveEnvironmentValues(this.options.environment ?? process.env),
        ...(resolvedProviderEnvironment?.PRAXIS_API_KEY === undefined
          ? []
          : [resolvedProviderEnvironment.PRAXIS_API_KEY]),
      ]
      const message = redactSensitiveText(
        error instanceof Error ? error.message : String(error),
        sensitiveValues,
      )
      const secondary: unknown[] = []
      if (child?.pid !== undefined) {
        try {
          child.kill('SIGTERM')
        } catch (killError) {
          secondary.push(killError)
        }
      }
      try {
        await allocatedExecution.finish('failed', (current) => {
          const now = new Date().toISOString()
          return {
            ...clearWorkerFields(current),
            state: 'failed',
            detail: message,
            tempo: 'idle',
            updatedAt: now,
            firstTerminalAt: current.firstTerminalAt ?? now,
          }
        })
      } catch (finishError) {
        secondary.push(finishError)
      }
      try {
        await allocatedExecution.release()
      } catch (releaseError) {
        secondary.push(releaseError)
      }
      throw new AggregateError(
        [error, ...secondary],
        'Could not start background agent',
      )
    }
    try {
      resolvedProviderEnvironment =
        await this.options.resolveProviderEnvironment?.({
          cwd,
          argv: options.argv,
        })
      child = spawn(
        this.options.executablePath ?? process.execPath,
        [this.options.cliPath, '__background-worker', identity.id],
        {
          cwd,
          env: workerEnvironment(
            this.options.environment ?? process.env,
            this.options.configRoot,
            resolvedProviderEnvironment,
          ),
          detached: true,
          stdio: 'ignore',
        },
      )
      const spawnedChild = child
      await new Promise<void>((resolveSpawn, rejectSpawn) => {
        const spawned = () => {
          spawnedChild.removeListener('error', failed)
          resolveSpawn()
        }
        const failed = (error: Error) => {
          spawnedChild.removeListener('spawn', spawned)
          rejectSpawn(error)
        }
        spawnedChild.once('spawn', spawned)
        spawnedChild.once('error', failed)
      })
    } catch (error) {
      return failLaunch(error)
    }
    const childPid = child?.pid
    if (!childPid) {
      return failLaunch(new Error('worker failed to start'))
    }
    try {
      await execution.update((current) => ({
        ...current,
        pid: childPid,
        updatedAt: new Date().toISOString(),
      }))
    } catch (error) {
      return failLaunch(error)
    }
    child.unref()
    try {
      await execution.handoff()
    } catch (error) {
      const secondary: unknown[] = []
      try {
        child.kill('SIGTERM')
      } catch (killError) {
        secondary.push(killError)
      }
      try {
        await execution.release()
      } catch (releaseError) {
        secondary.push(releaseError)
      }
      try {
        const reconciliation = await this.store.reconcileOwnerLoss(identity.id)
        if (reconciliation.owned) {
          secondary.push(
            new Error(
              `Background agent handoff owner is still held for ${identity.id}`,
            ),
          )
        }
      } catch (reconcileError) {
        secondary.push(reconcileError)
      }
      throw new AggregateError(
        [error, ...secondary],
        'Background agent handoff failed',
      )
    }
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
    const reconciled = await Promise.all(
      (await this.store.listWithLifecycle()).map(
        async (view) =>
          (await this.readLifecycleView(view.state.daemonShort, view)).state,
      ),
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
              tempo: state.tempo,
              ...(state.needs === undefined ? {} : { needs: state.needs }),
              status:
                state.tempo === 'idle' || state.tempo === 'blocked'
                  ? ('idle' as const)
                  : ('active' as const),
            }
          : {}),
        state: state.state,
      }))
    const native = await this.nativeSessions(
      cwd,
      new Set(reconciled.map((state) => state.sessionId)),
      options.all,
    )
    return [...praxis, ...native].sort(
      (left, right) => right.startedAt - left.startedAt,
    )
  }

  private async readLifecycleView(
    id: string,
    known?: ClaudeJobLifecycleView,
    reconcileLegacy = true,
  ): Promise<ClaudeJobLifecycleView> {
    const view = known ?? (await this.store.readWithLifecycle(id))
    if (view.legacy || !view.lifecycle) {
      if (!reconcileLegacy) return view
      if (
        view.state.state !== 'working' ||
        (await this.workerAlive(view.state))
      )
        return view
      const state = await this.store.update(id, (current) => {
        if (current.state !== 'working' || current.pid !== view.state.pid)
          return current
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
      return { state, lifecycleState: 'failed', lifecycle: null, legacy: true }
    }
    if (isTerminalLifecycleState(view.lifecycle.state)) return view
    if (
      view.lifecycle.state === 'queued' &&
      view.state.pid !== undefined &&
      Number.isFinite(Date.parse(view.state.updatedAt)) &&
      Date.now() - Date.parse(view.state.updatedAt) <
        WORKER_REGISTRATION_GRACE_MS &&
      (await this.workerAlive(view.state))
    )
      return view
    return (await this.store.reconcileOwnerLoss(id)).view
  }

  private async nativeSessions(
    cwd: string | undefined,
    knownSessionIds: ReadonlySet<string>,
    all: boolean,
  ): Promise<TopLevelAgentSummary[]> {
    const registryRoot = topLevelAgentProcessRegistryRoot(
      this.options.configRoot,
    )
    let files: string[]
    try {
      files = await readdir(registryRoot)
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
              JSON.parse(await readFile(join(registryRoot, file), 'utf8')),
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
      .filter((session) => all || session.status !== undefined)
  }

  async logs(id: string): Promise<string> {
    await this.store.read(id)
    return this.store.output(id)
  }

  async review(
    agent: Pick<TopLevelAgentSummary, 'id' | 'cwd' | 'sessionId'>,
  ): Promise<string> {
    if (agent.id !== undefined) {
      try {
        await this.store.read(agent.id)
        return this.logs(agent.id)
      } catch (error) {
        if (!String(error).includes('No agent found')) throw error
      }
    }
    try {
      const paths = resolveDataPlanePaths({
        dataPlane: 'native',
        root: this.options.configRoot,
        cwd: agent.cwd,
        sessionId: agent.sessionId,
      })
      return await readFile(paths.sessionFile, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return 'No local transcript is available for this Claude session.\n'
      }
      throw error
    }
  }

  async stop(id: string): Promise<void> {
    let view = await this.readLifecycleView(id)
    if (view.lifecycle && isTerminalLifecycleState(view.lifecycleState)) {
      throw new Error(
        `Agent ${id} is not running (state: ${view.lifecycleState})`,
      )
    }
    if (!view.lifecycle && view.state.state !== 'working')
      throw new Error(`Agent ${id} is not running (state: ${view.state.state})`)
    const state = view.state
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
    const deadline = Date.now() + STARTUP_CONTROL_WAIT_MS
    for (;;) {
      view = await this.readLifecycleView(id)
      if (view.lifecycle) {
        if (view.lifecycleState === 'cancelled') return
        if (isTerminalLifecycleState(view.lifecycleState))
          throw new Error(
            `Agent ${id} stop ended in state ${view.lifecycleState}`,
          )
      } else if (stopped || view.state.state !== 'working') {
        if (stopped || view.state.state === 'stopped') {
          if (stopped && view.state.state === 'working') {
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
          return
        }
        throw new Error(`Agent ${id} stop ended in state ${view.state.state}`)
      }
      if (Date.now() >= deadline) {
        if (view.legacy) {
          const now = new Date().toISOString()
          await this.store.update(id, (current) => ({
            ...clearWorkerFields(current),
            state: 'stopped',
            detail: 'stopped',
            tempo: 'idle',
            updatedAt: now,
            firstTerminalAt: current.firstTerminalAt ?? now,
          }))
          return
        }
        throw new Error(`Agent ${id} cancellation is still in progress`)
      }
      await waitForSocketRetry()
    }
  }

  async attach(
    id: string,
    input: AsyncIterable<string | Uint8Array>,
    output: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const view = await this.readLifecycleView(id, undefined, false)
    const state = view.state
    if (
      (view.lifecycle &&
        !['queued', 'running', 'waiting'].includes(view.lifecycleState)) ||
      (!view.lifecycle && state.state !== 'working') ||
      !state.socketPath ||
      !state.controlToken
    ) {
      throw new Error(
        `Agent ${id} is not attachable (state: ${view.lifecycleState})`,
      )
    }
    const socket = await connectToWorker(
      state.socketPath,
      ATTACH_READY_WAIT_MS,
      signal,
    )
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
    const abort = () => socket.destroy()
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
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        socket.destroy()
        reject(new Error('Agent control request timed out'))
      }, timeoutMs)
      timer.unref?.()
      const finish = (operation: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket.end()
        operation()
      }
      socket.once('error', (error) => finish(() => reject(error)))
      socket.once('close', () =>
        finish(() => reject(new Error('Agent control request closed'))),
      )
      socket.once('connect', () => writeWire(socket, message))
      lines(socket, (response) => finish(() => resolveRequest(response)))
    })
  }

  private async workerAlive(state: ClaudeJobState): Promise<boolean> {
    if (state.pid === undefined || !isProcessAlive(state.pid)) return false
    try {
      const value = JSON.parse(
        await readFile(
          join(
            topLevelAgentProcessRegistryRoot(this.options.configRoot),
            `${state.pid}.json`,
          ),
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
      const updatedAt = Date.parse(state.updatedAt)
      return (
        Number.isFinite(updatedAt) &&
        Date.now() - updatedAt < WORKER_REGISTRATION_GRACE_MS
      )
    }
  }
}

export async function runTopLevelAgentWorker(options: {
  configRoot: string
  dataPlane?: DataPlane
  id: string
  createRuntime(
    eventSink: RuntimeEventSink,
    dispatch: ClaudeJobDispatch,
  ): Promise<TopLevelAgentRuntime>
}): Promise<void> {
  let stopRequested = false
  let requestCancellation: () => Promise<void> = async () => undefined
  let cancellationFinalizer: (() => Promise<void>) | undefined
  let activeController: AbortController | undefined
  const captureStop = () => {
    stopRequested = true
    void requestCancellation().catch(() => undefined)
    void cancellationFinalizer?.().catch(() => undefined)
  }
  process.once('SIGTERM', captureStop)
  process.once('SIGINT', captureStop)
  const removeCaptureListeners = () => {
    process.removeListener('SIGTERM', captureStop)
    process.removeListener('SIGINT', captureStop)
  }
  const store = new ClaudeJobStore(
    options.configRoot,
    join(options.configRoot, 'state'),
  )
  let execution: ClaudeJobExecution | undefined
  let cleanupClaimed: (() => Promise<void>) | undefined
  let executionReleased = false
  const releaseExecution = async (): Promise<void> => {
    if (executionReleased || !execution) return
    const failures: unknown[] = []
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await execution.release()
        executionReleased = true
        return
      } catch (error) {
        failures.push(error)
      }
    }
    throw new AggregateError(failures, 'Could not release agent execution')
  }
  let claimed = false
  let postClaimFailure: unknown
  let deferredFailure: unknown
  try {
    const initialView = await store.readWithLifecycle(options.id)
    if (
      initialView.lifecycle &&
      isTerminalLifecycleState(initialView.lifecycleState) &&
      initialView.lifecycleState !== 'orphaned'
    )
      return
    if (!initialView.lifecycle && initialView.state.state !== 'working') return
    const initial = initialView.state
    let dispatch = await store.readDispatch(options.id)
    const sensitiveValues = sensitiveEnvironmentValues(process.env)
    const safeText = (text: string): string =>
      redactSensitiveText(text, sensitiveValues)
    const safeErrorMessage = (error: unknown): string =>
      safeText(error instanceof Error ? error.message : String(error))
    const hasOwnedContention = (error: unknown): boolean =>
      error instanceof Error &&
      error.message ===
        `Agent ${options.id} lifecycle execution is already owned`
    const claimDeadline = Date.now() + WORKER_REGISTRATION_GRACE_MS
    for (;;) {
      try {
        execution = await store.claimExecution(options.id)
        claimed = true
        break
      } catch (error) {
        if (!hasOwnedContention(error) || Date.now() >= claimDeadline)
          throw error
        await waitForSocketRetry()
      }
    }
    const claimedExecution = execution
    if (!claimedExecution) throw new Error('Worker execution was not claimed')
    let runtime: TopLevelAgentRuntime | undefined
    let runtimeInitialization: Promise<TopLevelAgentRuntime> | undefined
    let runtimeInitializationError: unknown
    let runtimeClosed = false
    let server: ReturnType<typeof createServer> | undefined
    const clients = new Set<Socket>()
    let stopClient: Socket | undefined
    let outputWriteError: unknown
    let outputWrites = Promise.resolve()
    let liveTurnText = ''
    let sessionStarted = dispatch.resume || dispatch.handoffComplete === true
    let closing = false
    let setupStep = Promise.resolve()
    const runSetupStep = <T>(operation: () => Promise<T>): Promise<T> => {
      const next = setupStep.then(operation)
      setupStep = next.then(
        () => undefined,
        () => undefined,
      )
      return next
    }
    let listenPending = false
    let listenCancelled = false
    let rejectPendingListen: ((error: Error) => void) | undefined
    let serverClosePromise: Promise<void> | undefined
    let resolveServerClose: (() => void) | undefined
    let rejectServerClose: ((error: unknown) => void) | undefined
    let serverCloseRequested = false
    let serverCloseStarted = false
    let serverCloseError: unknown
    let invokeServerClose: (() => void) | undefined
    const settleServerClose = (error?: unknown) => {
      if (error !== undefined) rejectServerClose?.(error)
      else resolveServerClose?.()
      resolveServerClose = undefined
      rejectServerClose = undefined
    }
    const closeServer = (): Promise<void> => {
      if (!server) return Promise.resolve()
      const currentServer = server
      if (!serverClosePromise) {
        serverClosePromise = new Promise<void>((resolveClose, rejectClose) => {
          resolveServerClose = resolveClose
          rejectServerClose = rejectClose
        })
        const closeNow = () => {
          if (serverCloseStarted) return
          serverCloseStarted = true
          try {
            currentServer.close((error) => {
              if (error) {
                serverCloseError = error
                settleServerClose(error)
              } else settleServerClose()
            })
          } catch (error) {
            if (
              (error as NodeJS.ErrnoException).code === 'ERR_SERVER_NOT_RUNNING'
            )
              settleServerClose()
            else {
              serverCloseError = error
              settleServerClose(error)
            }
          }
        }
        invokeServerClose = closeNow
        if (currentServer.listening) closeNow()
        else if (!listenPending) settleServerClose()
        else serverCloseRequested = true
      } else if (currentServer.listening && serverCloseRequested) {
        invokeServerClose?.()
      }
      return serverClosePromise
    }
    const closePendingListen = () => {
      if (!listenPending) return
      listenCancelled = true
      const closePromise = closeServer()
      rejectPendingListen?.(new Error('Agent listen cancelled'))
      void closePromise.catch(() => undefined)
    }
    let turnQueue = Promise.resolve()
    let finishWorker: (() => void) | undefined
    const finished = new Promise<void>((resolveFinished) => {
      finishWorker = resolveFinished
    })
    const socketFile =
      initial.socketPath ?? socketPath(options.configRoot, options.id)
    const processFile = join(
      topLevelAgentProcessRegistryRoot(options.configRoot),
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
    const closeRuntime = async (): Promise<void> => {
      if (runtimeClosed) return
      runtimeClosed = true
      if (runtimeInitialization) {
        try {
          runtime = await runtimeInitialization
        } catch (error) {
          runtimeInitializationError = error
        }
      }
      await runtime?.close?.()
    }
    const closeControl = (destroy = false) => {
      for (const client of clients) {
        if (destroy) client.destroy()
        else client.end()
      }
      if (server?.listening || listenPending)
        void closeServer().catch(() => undefined)
    }
    cleanupClaimed = async () => {
      const failures: unknown[] = []
      closePendingListen()
      try {
        await setupStep
      } catch (error) {
        failures.push(error)
      }
      activeController?.abort()
      try {
        await outputWrites
      } catch (error) {
        failures.push(error)
      }
      try {
        await closeRuntime()
      } catch (error) {
        failures.push(error)
      }
      try {
        closeControl(true)
        await closeServer()
      } catch (error) {
        failures.push(error)
      }
      try {
        await rm(socketFile, { force: true })
      } catch (error) {
        failures.push(error)
      }
      try {
        await rm(processFile, { force: true })
      } catch (error) {
        failures.push(error)
      }
      stopClient?.destroy()
      stopClient = undefined
      if (failures.length > 0)
        throw new AggregateError(failures, 'Agent fallback cleanup failed')
    }
    const broadcast = (message: WireMessage) => {
      for (const client of clients) writeWire(client, message)
    }
    const lifecycleWrite = (() => {
      let chain = Promise.resolve()
      return <T>(operation: () => Promise<T>): Promise<T> => {
        const next = chain.then(operation)
        chain = next.then(
          () => undefined,
          () => undefined,
        )
        return next
      }
    })()
    let cancellationTransition: Promise<void> | undefined
    requestCancellation = () => {
      if (!cancellationTransition) {
        cancellationTransition = lifecycleWrite(async () => {
          if (
            ['queued', 'running', 'waiting'].includes(
              claimedExecution.snapshot.state,
            )
          )
            await claimedExecution.beginCancellation()
        }).then(() => undefined)
      }
      return cancellationTransition
    }
    const finalization = (
      outcome: 'cancelled' | 'failed',
      error?: unknown,
      skipTurnDrain = false,
    ): Promise<void> => {
      if (finalizationPromise) return finalizationPromise
      const operation = (async () => {
        const cancellationAtStart =
          outcome === 'cancelled' ||
          stopRequested ||
          claimedExecution.snapshot.state === 'cancelling'
        const detail = cancellationAtStart ? 'stopped' : safeErrorMessage(error)
        const failures: unknown[] = []
        try {
          if (cancellationAtStart) await requestCancellation()
        } catch (failure) {
          failures.push(failure)
        }
        closing = true
        activeController?.abort()
        closePendingListen()
        try {
          await setupStep
        } catch (failure) {
          if (!(cancellationAtStart && listenCancelled)) failures.push(failure)
        }
        if (!skipTurnDrain) {
          try {
            await turnQueue
          } catch (failure) {
            failures.push(failure)
          }
        }
        try {
          await outputWrites
          // A streaming write failure is already the primary fatal error when
          // runTurn routes that same object through failed finalization. It is
          // still a cancellation cleanup failure, and distinct queued errors
          // remain cleanup failures.
          if (
            outputWriteError &&
            (cancellationAtStart || outputWriteError !== error)
          )
            failures.push(outputWriteError)
        } catch (failure) {
          failures.push(failure)
        }
        if (!cancellationAtStart) {
          try {
            await store.appendOutput(options.id, `${detail}\n`)
            await store.trimOutput(options.id, MAX_JOB_OUTPUT_BYTES)
          } catch (failure) {
            failures.push(failure)
          }
        }
        try {
          await closeRuntime()
        } catch (failure) {
          failures.push(failure)
        }
        if (cancellationAtStart && runtimeInitializationError)
          failures.push(runtimeInitializationError)
        try {
          const deferServerDrain =
            cancellationAtStart && stopClient !== undefined
          closeControl(true)
          // Starting the close synchronously stops new accepts. For an
          // authenticated stop, retain the drain promise until after ack.
          await Promise.resolve()
          if (serverCloseError) throw serverCloseError
          if (!deferServerDrain) await closeServer()
        } catch (failure) {
          failures.push(failure)
        }
        try {
          await rm(socketFile, { force: true })
        } catch (failure) {
          failures.push(failure)
        }
        try {
          await rm(processFile, { force: true })
        } catch (failure) {
          failures.push(failure)
        }
        const cancellation =
          cancellationAtStart ||
          stopRequested ||
          String(claimedExecution.snapshot.state) === 'cancelling'
        if (cancellation && !cancellationAtStart) {
          try {
            await requestCancellation()
          } catch (failure) {
            failures.push(failure)
          }
        }
        if (failures.length > 0) {
          const diagnostic = safeText(
            failures.map((failure) => safeErrorMessage(failure)).join('; '),
          )
          try {
            if (!isTerminalLifecycleState(claimedExecution.snapshot.state))
              await lifecycleWrite(() =>
                claimedExecution.update((state) => ({
                  ...clearWorkerFields(state),
                  detail: diagnostic,
                  tempo: 'idle',
                  updatedAt: new Date().toISOString(),
                })),
              )
          } catch (diagnosticError) {
            failures.push(diagnosticError)
          }
          throw new AggregateError(failures, 'Agent cleanup failed')
        }
        if (isTerminalLifecycleState(claimedExecution.snapshot.state)) {
          return
        }
        const terminal = await lifecycleWrite(() =>
          claimedExecution.finish(
            cancellation ? 'cancelled' : 'failed',
            (state) => ({
              ...clearWorkerFields(state),
              ...(cancellation
                ? { detail, tempo: 'idle' as const }
                : {
                    state: 'failed' as const,
                    detail,
                    tempo: 'idle' as const,
                    firstTerminalAt:
                      state.firstTerminalAt ?? new Date().toISOString(),
                  }),
              updatedAt: new Date().toISOString(),
            }),
          ),
        )
        let timelineError: unknown
        try {
          await store.appendTimeline(options.id, {
            at: new Date().toISOString(),
            state: cancellation ? 'stopped' : 'failed',
            detail,
            text: detail,
          })
        } catch (failure) {
          timelineError = failure
        }
        if (cancellation && terminal.state === 'cancelled') {
          broadcast({ type: 'stopped' })
          if (stopClient) {
            writeWire(stopClient, { type: 'stopped' })
            stopClient.end()
            stopClient = undefined
          }
          try {
            await closeServer()
          } catch (failure) {
            throw new AggregateError(
              [failure],
              'Agent server close failed after cancellation',
            )
          }
        } else if (!cancellation) {
          broadcast({ type: 'failed', message: detail })
        }
        if (timelineError)
          throw new AggregateError(
            [timelineError],
            'Terminal lifecycle timeline projection failed',
          )
      })()
      const finalPromise = operation
        .catch((failure) => {
          finalizationError = failure
          throw failure
        })
        .finally(() => {
          closeControl(true)
          stopClient?.destroy()
          stopClient = undefined
          finishWorker?.()
        })
      finalizationPromise = finalPromise
      return finalPromise
    }
    let finalizationError: unknown
    let finalizationPromise: Promise<void> | undefined
    cancellationFinalizer = () => finalization('cancelled')

    const runTurn = async (
      prompt: string,
      resume: boolean,
      requestId?: string,
      client?: Socket,
    ): Promise<void> => {
      if (closing || stopRequested) return
      liveTurnText = ''
      outputWriteError = undefined
      activeController = new AbortController()
      const now = new Date().toISOString()
      if (
        !['running', 'waiting'].includes(claimedExecution.snapshot.state) ||
        closing ||
        stopRequested
      )
        return
      const activate = (state: ClaudeJobState): ClaudeJobState => {
        const next = {
          ...state,
          detail: safeText(prompt),
          tempo: 'active' as const,
          inFlight: { tasks: 1, queued: 0, kinds: ['prompt'] },
          updatedAt: now,
        }
        delete next.needs
        return next
      }
      let resumeTurn = resume
      try {
        if (claimedExecution.snapshot.state === 'waiting')
          await lifecycleWrite(() => claimedExecution.running(activate))
        else await lifecycleWrite(() => claimedExecution.update(activate))
        if (closing || stopRequested) return
        await writeProcessStatus('working')
        if (!sessionStarted && dispatch.sourceSessionId) {
          if (!runtime?.ensureFork && !runtime?.fork)
            throw new Error('Background handoff runtime cannot fork sessions')
          if (runtime.ensureFork)
            await runtime.ensureFork(
              dispatch.sourceSessionId,
              initial.sessionId,
              dispatch.sourceCheckpoint,
            )
          else await runtime.fork?.(dispatch.sourceSessionId, initial.sessionId)
          dispatch = await store.updateDispatch(options.id, (current) => {
            const next = {
              ...current,
              resume: true,
              handoffComplete: true,
            }
            delete next.sourceSessionId
            delete next.sourceCheckpoint
            return next
          })
          sessionStarted = true
          resumeTurn = true
        }
        const currentRuntime = runtime
        const currentController = activeController
        if (!currentRuntime || !currentController)
          throw new Error('Background agent runtime is not ready')
        const result = resumeTurn
          ? await currentRuntime.resume(
              initial.sessionId,
              prompt,
              currentController.signal,
            )
          : await currentRuntime.run(
              prompt,
              currentController.signal,
              initial.sessionId,
            )
        sessionStarted = true
        if (closing || stopRequested) return
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
        const idled = await lifecycleWrite(() =>
          claimedExecution.waiting((state) => {
            const next = {
              ...state,
              detail: resultText,
              tempo: 'idle' as const,
              inFlight: { tasks: 0, queued: 0, kinds: [] },
              tokens:
                state.tokens +
                result.usage.inputTokens +
                result.usage.outputTokens,
              updatedAt: completedAt,
            }
            delete next.needs
            return next
          }),
        )
        if (!closing && idled.state === 'waiting')
          await writeProcessStatus('idle')
        if (requestId && client)
          writeWire(client, { type: 'turn-complete', requestId })
      } catch (turnError) {
        if (closing || activeController?.signal.aborted || stopRequested) return
        const message = safeErrorMessage(turnError)
        const failedAt = new Date().toISOString()
        if (resumeTurn) {
          try {
            await store.appendOutput(options.id, `${message}\n`)
            await store.trimOutput(options.id, MAX_JOB_OUTPUT_BYTES)
            await store.appendTimeline(options.id, {
              at: failedAt,
              state: 'working',
              detail: message,
              text: message,
            })
            const idled = await lifecycleWrite(() =>
              claimedExecution.waiting((state) => {
                const next = {
                  ...state,
                  detail: message,
                  tempo: 'idle' as const,
                  inFlight: { tasks: 0, queued: 0, kinds: [] },
                  updatedAt: failedAt,
                }
                delete next.needs
                return next
              }),
            )
            if (!closing && idled.state === 'waiting')
              await writeProcessStatus('idle')
            if (requestId && client)
              writeWire(client, { type: 'turn-error', requestId, message })
          } catch (persistenceError) {
            await finalization('failed', persistenceError, true).catch(
              () => undefined,
            )
          }
        } else {
          await finalization('failed', turnError, true).catch(() => undefined)
        }
      } finally {
        activeController = undefined
      }
    }

    try {
      if (!initial.socketPath || !initial.controlToken) {
        const token = initial.controlToken ?? randomBytes(24).toString('hex')
        await runSetupStep(() =>
          lifecycleWrite(() =>
            claimedExecution.update((state) => ({
              ...state,
              socketPath: socketFile,
              controlToken: token,
              updatedAt: new Date().toISOString(),
            })),
          ),
        )
      }
      const current = await runSetupStep(() => store.read(options.id))
      const controlToken = current.controlToken
      if (!controlToken)
        throw new Error(`Agent ${options.id} has no control endpoint`)
      if (stopRequested || closing) {
        await finalization('cancelled')
        return
      }
      await runSetupStep(() =>
        lifecycleWrite(() =>
          claimedExecution.update((state) => ({
            ...state,
            pid: process.pid,
            updatedAt: new Date().toISOString(),
          })),
        ),
      )
      if (stopRequested || closing) {
        await finalization('cancelled')
        return
      }
      await runSetupStep(async () => {
        await mkdir(dirname(socketFile), { recursive: true })
        await rm(socketFile, { force: true })
      })
      if (stopRequested || closing) {
        await finalization('cancelled')
        return
      }
      if (claimedExecution.snapshot.state === 'queued') {
        await runSetupStep(() =>
          lifecycleWrite(() =>
            claimedExecution.running((state) => ({
              ...state,
              tempo: 'active',
              updatedAt: new Date().toISOString(),
            })),
          ),
        )
        if (dispatch.deferInitialTurn)
          await runSetupStep(() =>
            lifecycleWrite(() =>
              claimedExecution.waiting((state) => {
                const next = {
                  ...state,
                  tempo:
                    dispatch.handoffComplete === true
                      ? ('idle' as const)
                      : ('blocked' as const),
                  updatedAt: new Date().toISOString(),
                }
                if (dispatch.handoffComplete === true) delete next.needs
                else next.needs = 'send a prompt to start'
                return next
              }),
            ),
          )
      }
      if (stopRequested || closing) {
        await finalization('cancelled')
        return
      }
      runtimeInitialization = runSetupStep(() =>
        Promise.resolve().then(() =>
          options.createRuntime((event) => {
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
          }, dispatch),
        ),
      )
      try {
        runtime = await runtimeInitialization
      } catch (runtimeError) {
        if (stopRequested || closing)
          await finalization('cancelled', runtimeError)
        else await finalization('failed', runtimeError)
        return
      }
      if (stopRequested || closing) {
        await finalization('cancelled')
        return
      }
      server = createServer((client) => {
        let authenticated = false
        lines(client, (message) => {
          if (!authenticated) {
            if (message.type === 'stop' && message.token === controlToken) {
              authenticated = true
              stopClient = client
              void finalization('cancelled')
                .catch(() => undefined)
                .finally(() => {
                  if (stopClient === client) client.destroy()
                })
              return
            }
            if (message.type !== 'attach' || message.token !== controlToken) {
              client.destroy()
              return
            }
            authenticated = true
            clients.add(client)
            void store.output(options.id).then((history) => {
              writeWire(client, { type: 'ready', text: history })
            })
            return
          }
          if (message.type === 'detach') {
            client.end()
            return
          }
          if (message.type === 'prompt' && message.text && message.requestId) {
            const { text, requestId } = message
            turnQueue = turnQueue.then(() =>
              runTurn(text, sessionStarted, requestId, client),
            )
          }
        })
        client.once('close', () => clients.delete(client))
      })
      listenPending = true
      listenCancelled = false
      await runSetupStep(
        () =>
          new Promise<void>((resolveListen, rejectListen) => {
            let settled = false
            rejectPendingListen = (listenError) => {
              if (settled) return
              settled = true
              listenPending = false
              rejectListen(listenError)
            }
            const listening = () => {
              if (listenCancelled) {
                void closeServer().catch(() => undefined)
                void rm(socketFile, { force: true }).catch(() => undefined)
                return
              }
              if (settled) return
              settled = true
              listenPending = false
              rejectPendingListen = undefined
              server?.removeListener('error', failed)
              server?.removeListener('close', closed)
              resolveListen()
            }
            const closed = () => {
              if (serverClosePromise) settleServerClose()
              if (settled) return
              settled = true
              listenPending = false
              rejectPendingListen = undefined
              server?.removeListener('listening', listening)
              server?.removeListener('error', failed)
              rejectListen(new Error('Agent server closed before listening'))
            }
            const failed = (listenError: Error) => {
              if (serverClosePromise) settleServerClose()
              if (settled) return
              settled = true
              listenPending = false
              rejectPendingListen = undefined
              server?.removeListener('listening', listening)
              server?.removeListener('close', closed)
              rejectListen(listenError)
            }
            server?.once('listening', listening)
            server?.once('close', closed)
            server?.once('error', failed)
            try {
              server?.listen(socketFile)
            } catch (listenError) {
              failed(listenError as Error)
            }
          }),
      )
      if (stopRequested || closing) {
        closeControl(true)
        await rm(socketFile, { force: true }).catch(() => undefined)
        await finalization('cancelled')
        return
      }
      server.on('error', (serverError) => {
        void finalization('failed', serverError).catch(() => undefined)
      })
      const waitingForHandoff =
        dispatch.deferInitialTurn === true && dispatch.handoffComplete !== true
      const registered = await runSetupStep(() =>
        lifecycleWrite(() =>
          claimedExecution.update((state) => {
            const next = {
              ...state,
              pid: process.pid,
              detail: dispatch.deferInitialTurn ? state.detail : 'starting',
              tempo: dispatch.deferInitialTurn
                ? waitingForHandoff
                  ? ('blocked' as const)
                  : ('idle' as const)
                : ('active' as const),
              ...(waitingForHandoff ? { needs: 'send a prompt to start' } : {}),
              socketPath: socketFile,
              controlToken,
              updatedAt: new Date().toISOString(),
            }
            if (!waitingForHandoff) delete next.needs
            return next
          }),
        ),
      )
      if (registered.state !== 'working' || stopRequested || closing) {
        await finalization('cancelled')
        return
      }
      await runSetupStep(() =>
        writeProcessStatus(dispatch.deferInitialTurn ? 'idle' : 'working'),
      )
      if (stopRequested || closing) {
        closeControl(true)
        await rm(socketFile, { force: true }).catch(() => undefined)
        await rm(processFile, { force: true }).catch(() => undefined)
        await finalization('cancelled')
        return
      }
      if (!dispatch.deferInitialTurn)
        turnQueue = turnQueue.then(() =>
          runTurn(initial.intent, dispatch.resume),
        )
      await finished
      if (finalizationError) throw finalizationError
    } catch (error) {
      if (finalizationPromise) {
        try {
          await finalizationPromise
        } catch (finalizationFailure) {
          postClaimFailure = finalizationFailure
          throw finalizationFailure
        }
      } else if (!closing) {
        try {
          await finalization(stopRequested ? 'cancelled' : 'failed', error)
        } catch (finalizationFailure) {
          postClaimFailure = finalizationFailure
          throw finalizationFailure
        }
      }
    }
  } catch (error) {
    deferredFailure = error
  } finally {
    removeCaptureListeners()
    if (claimed) {
      const failures: unknown[] = []
      try {
        await cleanupClaimed?.()
      } catch (error) {
        failures.push(error)
      }
      try {
        await releaseExecution()
      } catch (error) {
        failures.push(error)
      }
      if (postClaimFailure !== undefined) failures.unshift(postClaimFailure)
      if (failures.length > 0)
        deferredFailure = new AggregateError(
          failures,
          'Agent worker cleanup failed',
        )
    }
  }
  if (deferredFailure !== undefined) throw deferredFailure
}
