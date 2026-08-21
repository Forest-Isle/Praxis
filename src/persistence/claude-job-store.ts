import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { writeFileAtomically } from '../platform/atomic-write.js'
import { ExclusiveFileLease } from '../platform/exclusive-file-lease.js'

export type ClaudeJobLifecycleState = 'working' | 'stopped' | 'failed'
export type ClaudeJobTempo = 'active' | 'blocked' | 'idle'

export interface ClaudeJobState {
  state: ClaudeJobLifecycleState
  detail: string
  tempo: ClaudeJobTempo
  needs?: string
  inFlight?: { tasks: number; queued: number; kinds: string[] } | undefined
  tokens: number
  output: null
  children: null
  template: 'bg'
  respawnFlags: string[]
  intent: string
  sessionId: string
  resumeSessionId: string
  daemonShort: string
  cliVersion: string
  cwd: string
  backend: 'daemon'
  praxisOwner: 1
  createdAt: string
  updatedAt: string
  firstTerminalAt: string | null
  pid?: number
  socketPath?: string
  controlToken?: string
}

export interface ClaudeJobTimelineEntry {
  at: string
  state: ClaudeJobLifecycleState
  detail: string
  text: string
}

export interface ClaudeJobSourceCheckpoint {
  resumeSessionAt: string
  entryCount: number
}

export interface ClaudeJobDispatch {
  version: 1
  argv: string[]
  resume: boolean
  deferInitialTurn?: boolean
  handoffComplete?: boolean
  sourceSessionId?: string
  sourceCheckpoint?: ClaudeJobSourceCheckpoint
}

const JOB_ID_PATTERN = /^[0-9a-f]{8}$/u
const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const LOCK_WAIT_MS = 5_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertJobId(id: string): void {
  if (!JOB_ID_PATTERN.test(id)) throw new Error(`Invalid agent ID: ${id}`)
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function parseState(source: string, filePath: string): ClaudeJobState {
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch (error) {
    throw new Error(`Invalid Claude job JSON: ${filePath}`, { cause: error })
  }
  if (!isRecord(value)) throw new Error(`Invalid Claude job: ${filePath}`)
  const state = value
  const inFlight = state.inFlight
  if (
    !['working', 'stopped', 'failed'].includes(String(state.state)) ||
    typeof state.detail !== 'string' ||
    !['active', 'blocked', 'idle'].includes(String(state.tempo)) ||
    (state.needs !== undefined && typeof state.needs !== 'string') ||
    !Number.isSafeInteger(state.tokens) ||
    Number(state.tokens) < 0 ||
    state.output !== null ||
    state.children !== null ||
    state.template !== 'bg' ||
    !stringArray(state.respawnFlags) ||
    typeof state.intent !== 'string' ||
    typeof state.sessionId !== 'string' ||
    !SESSION_ID_PATTERN.test(state.sessionId) ||
    typeof state.resumeSessionId !== 'string' ||
    !SESSION_ID_PATTERN.test(state.resumeSessionId) ||
    typeof state.daemonShort !== 'string' ||
    !JOB_ID_PATTERN.test(state.daemonShort) ||
    typeof state.cliVersion !== 'string' ||
    typeof state.cwd !== 'string' ||
    state.backend !== 'daemon' ||
    state.praxisOwner !== 1 ||
    typeof state.createdAt !== 'string' ||
    typeof state.updatedAt !== 'string' ||
    (state.firstTerminalAt !== null &&
      typeof state.firstTerminalAt !== 'string') ||
    (state.pid !== undefined &&
      (!Number.isSafeInteger(state.pid) || Number(state.pid) <= 0)) ||
    (state.socketPath !== undefined && typeof state.socketPath !== 'string') ||
    (state.controlToken !== undefined &&
      typeof state.controlToken !== 'string') ||
    (inFlight !== undefined &&
      (!isRecord(inFlight) ||
        !Number.isSafeInteger(inFlight.tasks) ||
        !Number.isSafeInteger(inFlight.queued) ||
        !stringArray(inFlight.kinds)))
  ) {
    throw new Error(`Invalid Claude job: ${filePath}`)
  }
  return state as unknown as ClaudeJobState
}

function parseDispatch(source: string, filePath: string): ClaudeJobDispatch {
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch (error) {
    throw new Error(`Invalid Praxis job dispatch JSON: ${filePath}`, {
      cause: error,
    })
  }
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !stringArray(value.argv) ||
    typeof value.resume !== 'boolean' ||
    (value.deferInitialTurn !== undefined &&
      typeof value.deferInitialTurn !== 'boolean') ||
    (value.handoffComplete !== undefined &&
      typeof value.handoffComplete !== 'boolean') ||
    (value.sourceSessionId !== undefined &&
      (typeof value.sourceSessionId !== 'string' ||
        !SESSION_ID_PATTERN.test(value.sourceSessionId))) ||
    (value.sourceCheckpoint !== undefined &&
      (!isRecord(value.sourceCheckpoint) ||
        typeof value.sourceCheckpoint.resumeSessionAt !== 'string' ||
        !SESSION_ID_PATTERN.test(value.sourceCheckpoint.resumeSessionAt) ||
        !Number.isSafeInteger(value.sourceCheckpoint.entryCount) ||
        Number(value.sourceCheckpoint.entryCount) <= 0))
  ) {
    throw new Error(`Invalid Praxis job dispatch: ${filePath}`)
  }
  return value as unknown as ClaudeJobDispatch
}

export class ClaudeJobStore {
  constructor(
    private readonly configRoot: string,
    private readonly lockRoot = join(configRoot, 'praxis'),
  ) {}

  async create(
    state: ClaudeJobState,
    dispatch: ClaudeJobDispatch,
  ): Promise<boolean> {
    assertJobId(state.daemonShort)
    const directory = this.jobDirectory(state.daemonShort)
    await mkdir(dirname(directory), { recursive: true })
    try {
      await mkdir(directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
      throw error
    }
    try {
      await writeFileAtomically(
        this.statePath(state.daemonShort),
        `${JSON.stringify(state)}\n`,
      )
      await writeFileAtomically(
        this.dispatchPath(state.daemonShort),
        `${JSON.stringify(dispatch)}\n`,
      )
      return true
    } catch (error) {
      await rm(directory, { recursive: true, force: true })
      throw error
    }
  }

  async read(id: string): Promise<ClaudeJobState> {
    assertJobId(id)
    try {
      return parseState(
        await readFile(this.statePath(id), 'utf8'),
        this.statePath(id),
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`No agent found with ID: ${id}`)
      }
      throw error
    }
  }

  async readDispatch(id: string): Promise<ClaudeJobDispatch> {
    assertJobId(id)
    try {
      return parseDispatch(
        await readFile(this.dispatchPath(id), 'utf8'),
        this.dispatchPath(id),
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`No agent dispatch found with ID: ${id}`)
      }
      throw error
    }
  }

  async updateDispatch(
    id: string,
    mutate: (dispatch: ClaudeJobDispatch) => ClaudeJobDispatch,
  ): Promise<ClaudeJobDispatch> {
    return this.withLock(id, async () => {
      const next = mutate(await this.readDispatch(id))
      await writeFileAtomically(
        this.dispatchPath(id),
        `${JSON.stringify(next)}\n`,
      )
      return next
    })
  }

  async list(): Promise<ClaudeJobState[]> {
    let names: string[]
    try {
      names = await readdir(join(this.configRoot, 'jobs'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const states = await Promise.all(
      names
        .filter((name) => JOB_ID_PATTERN.test(name))
        .map(async (id) => {
          try {
            return await this.read(id)
          } catch {
            return null
          }
        }),
    )
    return states.filter((state): state is ClaudeJobState => state !== null)
  }

  async update(
    id: string,
    mutate: (state: ClaudeJobState) => ClaudeJobState,
  ): Promise<ClaudeJobState> {
    return this.withLock(id, async () => {
      const next = mutate(await this.read(id))
      if (next.daemonShort !== id) throw new Error('Agent ID cannot change')
      await writeFileAtomically(this.statePath(id), `${JSON.stringify(next)}\n`)
      return next
    })
  }

  async appendTimeline(
    id: string,
    entry: ClaudeJobTimelineEntry,
  ): Promise<void> {
    assertJobId(id)
    await this.withLock(id, async () => {
      const path = this.timelinePath(id)
      await mkdir(dirname(path), { recursive: true })
      const handle = await open(path, 'a', 0o600)
      try {
        await handle.writeFile(`${JSON.stringify(entry)}\n`)
        await handle.sync()
      } finally {
        await handle.close()
      }
    })
  }

  async timeline(id: string): Promise<ClaudeJobTimelineEntry[]> {
    assertJobId(id)
    let source: string
    try {
      source = await readFile(this.timelinePath(id), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const entries: ClaudeJobTimelineEntry[] = []
    for (const line of source.split('\n')) {
      if (line.length === 0) continue
      try {
        const value = JSON.parse(line) as unknown
        if (
          isRecord(value) &&
          typeof value.at === 'string' &&
          ['working', 'stopped', 'failed'].includes(String(value.state)) &&
          typeof value.detail === 'string' &&
          typeof value.text === 'string'
        ) {
          entries.push(value as unknown as ClaudeJobTimelineEntry)
        }
      } catch {
        // Preserve earlier durable output if a process died during its last append.
      }
    }
    return entries
  }

  async appendOutput(id: string, text: string): Promise<void> {
    assertJobId(id)
    if (text.length === 0) return
    const path = this.outputPath(id)
    await mkdir(dirname(path), { recursive: true })
    const handle = await open(path, 'a', 0o600)
    try {
      await handle.writeFile(text)
    } finally {
      await handle.close()
    }
  }

  async output(id: string): Promise<string> {
    assertJobId(id)
    try {
      return await readFile(this.outputPath(id), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
      throw error
    }
  }

  async trimOutput(id: string, maxBytes: number): Promise<void> {
    assertJobId(id)
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new Error('maxBytes must be a positive integer')
    }
    let content: Buffer
    try {
      content = await readFile(this.outputPath(id))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    if (content.byteLength <= maxBytes) return
    let start = content.byteLength - maxBytes
    let byte = content[start]
    while (byte !== undefined && (byte & 0xc0) === 0x80) {
      start += 1
      byte = content[start]
    }
    await writeFileAtomically(
      this.outputPath(id),
      content.subarray(start).toString('utf8'),
    )
  }

  private async withLock<T>(
    id: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const lease = new ExclusiveFileLease(
      join(this.lockRoot, 'locks', `job-${id}.lock`),
    )
    const deadline = Date.now() + LOCK_WAIT_MS
    while (true) {
      const handle = await lease.tryAcquire()
      if (handle) {
        try {
          return await operation()
        } finally {
          await handle.release()
        }
      }
      if (Date.now() >= deadline) throw new Error(`Agent ${id} is busy`)
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }

  private jobDirectory(id: string): string {
    return join(this.configRoot, 'jobs', id)
  }

  private statePath(id: string): string {
    return join(this.jobDirectory(id), 'state.json')
  }

  private dispatchPath(id: string): string {
    return join(this.jobDirectory(id), 'dispatch.json')
  }

  private timelinePath(id: string): string {
    return join(this.jobDirectory(id), 'timeline.jsonl')
  }

  private outputPath(id: string): string {
    return join(this.jobDirectory(id), 'output.log')
  }
}

export function newClaudeJobIdentity(): { id: string; sessionId: string } {
  const sessionId = randomUUID()
  return { id: sessionId.slice(0, 8), sessionId }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
