import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { writeFileAtomically } from '../platform/atomic-write.js'
import {
  ExclusiveFileLease,
  type ExclusiveFileLeaseHandle,
} from '../platform/exclusive-file-lease.js'
import {
  createAgentLifecycle,
  isTerminalLifecycleState,
  markLifecycleOrphaned,
  parseAgentLifecycleSnapshot,
  recoverLifecycle,
  transitionLifecycle,
  transferLifecycleOwner,
  type AgentLifecycleSnapshot,
  type LifecycleOwner,
} from '../core/agent-orchestration.js'

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

export interface ClaudeJobLifecycleRecord {
  version: 1
  jobId: string
  lifecycle: AgentLifecycleSnapshot
  updatedAt: string
}

export interface ClaudeJobLifecycleView {
  state: ClaudeJobState
  lifecycleState: AgentLifecycleSnapshot['state']
  lifecycle: AgentLifecycleSnapshot | null
  legacy: boolean
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

function ownerFromLease(lease: {
  token: string
  pid: number
  createdAt: string
}): LifecycleOwner {
  return { token: lease.token, pid: lease.pid, acquiredAt: lease.createdAt }
}

function legacyLifecycleState(
  state: ClaudeJobState,
): AgentLifecycleSnapshot['state'] {
  if (state.state === 'stopped') return 'cancelled'
  if (state.state === 'failed') return 'failed'
  return state.tempo === 'active' ? 'running' : 'waiting'
}

function projectState(
  state: ClaudeJobState,
  lifecycle: AgentLifecycleSnapshot,
): ClaudeJobState {
  const next = {
    ...state,
    state:
      lifecycle.state === 'failed' || lifecycle.state === 'orphaned'
        ? ('failed' as const)
        : lifecycle.state === 'cancelled' || lifecycle.state === 'completed'
          ? ('stopped' as const)
          : ('working' as const),
    tempo:
      lifecycle.state === 'waiting'
        ? state.needs !== undefined
          ? ('blocked' as const)
          : ('idle' as const)
        : lifecycle.state === 'queued'
          ? state.needs !== undefined
            ? ('blocked' as const)
            : ('active' as const)
          : isTerminalLifecycleState(lifecycle.state)
            ? ('idle' as const)
            : ('active' as const),
    firstTerminalAt: isTerminalLifecycleState(lifecycle.state)
      ? lifecycle.terminalAt
      : null,
    updatedAt: new Date().toISOString(),
  }
  if (isTerminalLifecycleState(lifecycle.state)) {
    delete next.pid
    delete next.socketPath
    delete next.controlToken
    delete next.inFlight
    delete next.needs
  }
  return next
}

function projectionMatches(
  state: ClaudeJobState,
  projection: ClaudeJobState,
): boolean {
  return (
    state.state === projection.state &&
    state.tempo === projection.tempo &&
    state.firstTerminalAt === projection.firstTerminalAt &&
    state.pid === projection.pid &&
    state.socketPath === projection.socketPath &&
    state.controlToken === projection.controlToken &&
    state.needs === projection.needs &&
    JSON.stringify(state.inFlight) === JSON.stringify(projection.inFlight)
  )
}

type StateMutator = (state: ClaudeJobState) => ClaudeJobState

export class ClaudeJobExecution {
  private released = false
  constructor(
    private readonly store: ClaudeJobStore,
    private readonly lease: ExclusiveFileLeaseHandle,
    public readonly token: string,
    public readonly generation: number,
    public readonly jobId: string,
    private current: AgentLifecycleSnapshot,
  ) {}

  get snapshot(): AgentLifecycleSnapshot {
    return this.current
  }

  async update(mutateState: StateMutator): Promise<ClaudeJobState> {
    this.ensureActive()
    const result = await this.store.mutateExecution(
      this,
      (lifecycle, state) => ({ lifecycle, state: mutateState(state) }),
    )
    this.current = result.lifecycle
    return result.state
  }

  async running(mutateState?: StateMutator): Promise<AgentLifecycleSnapshot> {
    return this.transition('running', mutateState)
  }

  async waiting(mutateState?: StateMutator): Promise<AgentLifecycleSnapshot> {
    return this.transition('waiting', mutateState)
  }

  async beginCancellation(
    mutateState?: StateMutator,
  ): Promise<AgentLifecycleSnapshot> {
    return this.transition('cancelling', mutateState)
  }

  async finish(
    state: 'completed' | 'failed' | 'cancelled',
    mutateState?: StateMutator,
  ): Promise<AgentLifecycleSnapshot> {
    return this.transition(state, mutateState)
  }

  async handoff(): Promise<void> {
    if (this.released) return
    if (this.current.state !== 'queued')
      throw new Error('Lifecycle handoff is only allowed while queued')
    let ownershipError: unknown
    try {
      await this.store.assertExecutionOwner(this)
    } catch (error) {
      ownershipError = error
    }
    let releaseError: unknown
    try {
      await this.lease.release()
    } catch (error) {
      releaseError = error
    }
    if (releaseError === undefined) this.released = true
    if (ownershipError !== undefined && releaseError !== undefined) {
      throw new AggregateError(
        [ownershipError, releaseError],
        'Lifecycle handoff failed while releasing execution lease',
      )
    }
    if (ownershipError !== undefined) throw ownershipError
    if (releaseError !== undefined) throw releaseError
  }

  async release(): Promise<void> {
    if (this.released) return
    let orphanError: unknown
    if (!isTerminalLifecycleState(this.current.state)) {
      try {
        this.current = await this.store.orphanExecution(this)
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !/stale or missing/u.test(error.message)
        )
          orphanError = error
      }
    }
    let releaseError: unknown
    try {
      await this.lease.release()
    } catch (error) {
      releaseError = error
    }
    if (releaseError === undefined && orphanError === undefined)
      this.released = true
    if (orphanError !== undefined && releaseError !== undefined) {
      throw new AggregateError(
        [orphanError, releaseError],
        'Lifecycle orphaning and execution lease release both failed',
      )
    }
    if (orphanError !== undefined) throw orphanError
    if (releaseError !== undefined) throw releaseError
  }

  private async transition(
    next:
      | 'running'
      | 'waiting'
      | 'cancelling'
      | 'completed'
      | 'failed'
      | 'cancelled',
    mutateState?: StateMutator,
  ): Promise<AgentLifecycleSnapshot> {
    this.ensureActive()
    const result = await this.store.mutateExecution(
      this,
      (lifecycle, state) => ({
        lifecycle: transitionLifecycle(lifecycle, next, this.token),
        state: mutateState ? mutateState(state) : state,
      }),
    )
    this.current = result.lifecycle
    return result.lifecycle
  }

  private ensureActive(): void {
    if (this.released)
      throw new Error('Lifecycle execution has been released or is stale')
  }
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

  async createExecution(
    state: ClaudeJobState,
    dispatch: ClaudeJobDispatch,
  ): Promise<ClaudeJobExecution | null> {
    assertJobId(state.daemonShort)
    const id = state.daemonShort
    const ownerLease = await this.ownerLease(id).tryAcquire()
    if (!ownerLease) return null
    const directory = this.jobDirectory(id)
    let createdDirectory = false
    let lifecycleMayExist = false
    const cleanup = async (primary?: unknown): Promise<void> => {
      const failures: unknown[] = []
      if (createdDirectory) {
        try {
          await rm(directory, { recursive: true, force: true })
        } catch (error) {
          failures.push(error)
        }
      }
      if (lifecycleMayExist) {
        try {
          await rm(this.lifecyclePath(id), { force: true })
        } catch (error) {
          failures.push(error)
        }
      }
      try {
        await ownerLease.release()
      } catch (error) {
        failures.push(error)
      }
      if (failures.length > 0) {
        throw new AggregateError(
          primary === undefined ? failures : [primary, ...failures],
          'Claude job execution setup and cleanup failed',
        )
      }
      if (primary !== undefined) throw primary
    }
    try {
      await mkdir(dirname(directory), { recursive: true })
      try {
        await mkdir(directory)
        createdDirectory = true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        await cleanup()
        return null
      }
      const owner = ownerFromLease(ownerLease)
      const lifecycle = createAgentLifecycle(owner)
      const record: ClaudeJobLifecycleRecord = {
        version: 1,
        jobId: id,
        lifecycle,
        updatedAt: new Date().toISOString(),
      }
      lifecycleMayExist = true
      await this.writeLifecycle(record)
      await writeFileAtomically(
        this.dispatchPath(id),
        `${JSON.stringify(dispatch)}\n`,
      )
      await writeFileAtomically(
        this.statePath(id),
        `${JSON.stringify(state)}\n`,
      )
      return new ClaudeJobExecution(
        this,
        ownerLease,
        owner.token,
        lifecycle.generation,
        id,
        lifecycle,
      )
    } catch (error) {
      await cleanup(error)
      return null
    }
  }

  async readWithLifecycle(id: string): Promise<ClaudeJobLifecycleView> {
    assertJobId(id)
    const state = await this.read(id)
    const lifecycle = await this.readLifecycle(id)
    if (!lifecycle) {
      const projected = legacyLifecycleState(state)
      return {
        state,
        lifecycleState: projected,
        lifecycle: null,
        legacy: true,
      }
    }
    const projected = projectState(state, lifecycle.lifecycle)
    if (!projectionMatches(state, projected)) {
      const repaired = await this.withLock(id, async () => {
        const latestState = await this.read(id)
        const latest = await this.readLifecycle(id)
        if (!latest) return { state: latestState, lifecycle: null }
        const latestProjection = projectState(latestState, latest.lifecycle)
        if (!projectionMatches(latestState, latestProjection))
          await writeFileAtomically(
            this.statePath(id),
            `${JSON.stringify(latestProjection)}\n`,
          )
        return { state: latestProjection, lifecycle: latest.lifecycle }
      })
      if (!repaired.lifecycle)
        return {
          state: repaired.state,
          lifecycleState: legacyLifecycleState(repaired.state),
          lifecycle: null,
          legacy: true,
        }
      return {
        state: repaired.state,
        lifecycleState: repaired.lifecycle.state,
        lifecycle: repaired.lifecycle,
        legacy: false,
      }
    }
    return {
      state,
      lifecycleState: lifecycle.lifecycle.state,
      lifecycle: lifecycle.lifecycle,
      legacy: false,
    }
  }

  async listWithLifecycle(): Promise<ClaudeJobLifecycleView[]> {
    const states = await this.list()
    const views = await Promise.all(
      states.map(async (state) => {
        try {
          return await this.readWithLifecycle(state.daemonShort)
        } catch {
          return null
        }
      }),
    )
    return views.filter((view): view is ClaudeJobLifecycleView => view !== null)
  }

  async claimExecution(id: string): Promise<ClaudeJobExecution> {
    assertJobId(id)
    const lease = await this.ownerLease(id).tryAcquire()
    if (!lease)
      throw new Error(`Agent ${id} lifecycle execution is already owned`)
    try {
      const execution = await this.withLock(id, async () => {
        const state = await this.read(id)
        const existing = await this.readLifecycle(id)
        const owner = ownerFromLease(lease)
        let lifecycle: AgentLifecycleSnapshot
        if (!existing) {
          if (state.state !== 'working')
            throw new Error(`Cannot claim non-working legacy agent: ${id}`)
          if (
            state.pid !== undefined &&
            state.pid !== process.pid &&
            isProcessAlive(state.pid)
          )
            throw new Error(`Agent ${id} is owned by a live process`)
          lifecycle = transitionLifecycle(
            createAgentLifecycle(owner),
            'running',
            owner.token,
          )
          if (state.tempo !== 'active')
            lifecycle = transitionLifecycle(lifecycle, 'waiting', owner.token)
        } else if (existing.lifecycle.state === 'orphaned') {
          lifecycle = recoverLifecycle(existing.lifecycle, owner)
        } else if (isTerminalLifecycleState(existing.lifecycle.state)) {
          throw new Error(`Cannot claim terminal agent lifecycle: ${id}`)
        } else if (existing.lifecycle.state === 'queued') {
          lifecycle = transferLifecycleOwner(
            existing.lifecycle,
            existing.lifecycle.owner?.token ?? '',
            owner,
          )
        } else if (existing.lifecycle.owner) {
          const orphaned = markLifecycleOrphaned(
            existing.lifecycle,
            existing.lifecycle.owner.token,
          )
          lifecycle = recoverLifecycle(orphaned, owner)
        } else {
          throw new Error(`Invalid claimable lifecycle: ${id}`)
        }
        const next: ClaudeJobLifecycleRecord = {
          version: 1,
          jobId: id,
          lifecycle,
          updatedAt: new Date().toISOString(),
        }
        await this.writeLifecycle(next)
        const projected = projectState(state, lifecycle)
        await writeFileAtomically(
          this.statePath(id),
          `${JSON.stringify(projected)}\n`,
        )
        return new ClaudeJobExecution(
          this,
          lease,
          owner.token,
          lifecycle.generation,
          id,
          lifecycle,
        )
      })
      return execution
    } catch (error) {
      await lease.release()
      throw error
    }
  }

  async reconcileOwnerLoss(id: string): Promise<{
    owned: boolean
    view: ClaudeJobLifecycleView
  }> {
    assertJobId(id)
    const initial = await this.readWithLifecycle(id)
    if (!initial.lifecycle) {
      const pid = initial.state.pid
      return {
        owned: pid !== undefined && isProcessAlive(pid),
        view: initial,
      }
    }
    if (isTerminalLifecycleState(initial.lifecycle.state))
      return { owned: false, view: initial }
    const probe = await this.ownerLease(id).tryAcquire()
    if (!probe) {
      const reread = await this.readWithLifecycle(id)
      if (!reread.lifecycle || isTerminalLifecycleState(reread.lifecycle.state))
        return { owned: false, view: reread }
      return { owned: true, view: reread }
    }
    try {
      await this.withLock(id, async () => {
        const latest = await this.readLifecycle(id)
        if (!latest) return false
        if (isTerminalLifecycleState(latest.lifecycle.state)) return false
        if (
          latest.lifecycle.generation !== initial.lifecycle?.generation ||
          latest.lifecycle.owner?.token !== initial.lifecycle?.owner?.token
        )
          return false
        const orphaned = markLifecycleOrphaned(
          latest.lifecycle,
          latest.lifecycle.owner?.token ?? '',
        )
        await this.writeLifecycle({
          version: 1,
          jobId: id,
          lifecycle: orphaned,
          updatedAt: new Date().toISOString(),
        })
        const state = await this.read(id)
        await writeFileAtomically(
          this.statePath(id),
          `${JSON.stringify(projectState(state, orphaned))}\n`,
        )
        return true
      })
      return { owned: false, view: await this.readWithLifecycle(id) }
    } finally {
      await probe.release()
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

  async mutateExecution(
    execution: ClaudeJobExecution,
    operation: (
      lifecycle: AgentLifecycleSnapshot,
      state: ClaudeJobState,
    ) => { lifecycle: AgentLifecycleSnapshot; state: ClaudeJobState },
  ): Promise<{ lifecycle: AgentLifecycleSnapshot; state: ClaudeJobState }> {
    return this.withLock(this.jobIdFromExecution(execution), async () => {
      const current = await this.readLifecycle(
        this.jobIdFromExecution(execution),
      )
      const state = await this.read(this.jobIdFromExecution(execution))
      if (
        !current ||
        current.lifecycle.generation !== execution.generation ||
        current.lifecycle.owner?.token !== execution.token
      )
        throw new Error('Lifecycle execution owner token is stale or missing')
      const result = operation(current.lifecycle, state)
      if (result.state.daemonShort !== this.jobIdFromExecution(execution))
        throw new Error('Agent ID cannot change')
      const record: ClaudeJobLifecycleRecord = {
        version: 1,
        jobId: this.jobIdFromExecution(execution),
        lifecycle: result.lifecycle,
        updatedAt: new Date().toISOString(),
      }
      await this.writeLifecycle(record)
      const projected = projectState(
        { ...result.state, updatedAt: record.updatedAt },
        result.lifecycle,
      )
      await writeFileAtomically(
        this.statePath(this.jobIdFromExecution(execution)),
        `${JSON.stringify(projected)}\n`,
      )
      return { lifecycle: result.lifecycle, state: projected }
    })
  }

  async assertExecutionOwner(execution: ClaudeJobExecution): Promise<void> {
    await this.withLock(this.jobIdFromExecution(execution), async () => {
      const current = await this.readLifecycle(
        this.jobIdFromExecution(execution),
      )
      if (
        !current ||
        current.lifecycle.generation !== execution.generation ||
        current.lifecycle.owner?.token !== execution.token
      )
        throw new Error('Lifecycle execution owner token is stale or missing')
    })
  }

  async orphanExecution(
    execution: ClaudeJobExecution,
  ): Promise<AgentLifecycleSnapshot> {
    const result = await this.mutateExecution(execution, (lifecycle, state) => {
      const next = markLifecycleOrphaned(lifecycle, execution.token)
      return { lifecycle: next, state }
    })
    return result.lifecycle
  }

  private jobIdFromExecution(execution: ClaudeJobExecution): string {
    return execution.jobId
  }

  private async readLifecycle(
    id: string,
  ): Promise<ClaudeJobLifecycleRecord | null> {
    let source: string
    try {
      source = await readFile(this.lifecyclePath(id), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    let value: unknown
    try {
      value = JSON.parse(source)
    } catch (error) {
      throw new Error(
        `Invalid Claude job lifecycle: ${this.lifecyclePath(id)}`,
        {
          cause: error,
        },
      )
    }
    if (!isRecord(value))
      throw new Error(`Invalid Claude job lifecycle: ${this.lifecyclePath(id)}`)
    let lifecycle: AgentLifecycleSnapshot
    try {
      lifecycle = parseAgentLifecycleSnapshot(value.lifecycle)
    } catch {
      throw new Error(`Invalid Claude job lifecycle: ${this.lifecyclePath(id)}`)
    }
    if (
      !isRecord(value) ||
      value.version !== 1 ||
      value.jobId !== id ||
      typeof value.updatedAt !== 'string' ||
      Number.isNaN(Date.parse(value.updatedAt))
    )
      throw new Error(`Invalid Claude job lifecycle: ${this.lifecyclePath(id)}`)
    return { ...(value as unknown as ClaudeJobLifecycleRecord), lifecycle }
  }

  private async writeLifecycle(
    record: ClaudeJobLifecycleRecord,
  ): Promise<void> {
    await writeFileAtomically(
      this.lifecyclePath(record.jobId),
      `${JSON.stringify(record)}\n`,
      { mode: 0o600 },
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

  private lifecyclePath(id: string): string {
    return join(this.lockRoot, 'agent-lifecycle', `${id}.json`)
  }

  private ownerLease(id: string): ExclusiveFileLease {
    return new ExclusiveFileLease(
      join(this.lockRoot, 'locks', `job-${id}.owner.lock`),
    )
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
