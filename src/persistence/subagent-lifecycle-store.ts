import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { isClaudeSessionId } from '../compatibility/claude/paths.js'
import { isClaudeAgentId } from '../compatibility/claude/sidechain.js'
import {
  createAgentLifecycle,
  continueLifecycle,
  isTerminalLifecycleState,
  markLifecycleOrphaned,
  parseAgentLifecycleSnapshot,
  recoverLifecycle,
  transitionLifecycle,
  type AgentLifecycleSnapshot,
  type LifecycleOwner,
  type LifecycleState,
} from '../core/agent-orchestration.js'
import {
  ExclusiveFileLease,
  type ExclusiveFileLeaseHandle,
} from '../platform/exclusive-file-lease.js'
import { writeFileAtomically } from '../platform/atomic-write.js'

export type PersistedSubagentStatus =
  'running' | 'completed' | 'failed' | 'killed'

export interface PersistedSubagentRunResult {
  text: string
  usage: {
    inputTokens: number
    outputTokens: number
    cacheReadInputTokens?: number
    cacheCreationInputTokens?: number
    webSearchRequests?: number
    contextWindow?: number
    maxOutputTokens?: number
  }
  modelUsage?: Record<string, PersistedSubagentRunResult['usage']>
  durationApiMs?: number
  durationApiWithoutRetriesMs?: number
  toolUseCount: number
  durationMs: number
  isolationPath?: string
  isolationRetained?: boolean
  isolationWarning?: string
}

export interface PersistedSubagentNotification {
  id: string
  status: 'completed' | 'failed' | 'killed'
  toolUseId: string
  result: PersistedSubagentRunResult | null
  error: string | null
  consumed: boolean
  accounting?: { kind: 'detached'; model: string; delivered: boolean }
}

/** `status` is a read-only compatibility projection and is never persisted. */
export interface PersistedSubagentLifecycle {
  version: 2
  sessionId: string
  agentId: string
  lifecycle: AgentLifecycleSnapshot
  updatedAt: string
  transcriptBytes?: number
  detail?: string
  result?: PersistedSubagentRunResult
  notifications?: PersistedSubagentNotification[]
  readonly status?: PersistedSubagentStatus
}

type StoredLifecycle = Omit<PersistedSubagentLifecycle, 'status'>

function statusFor(snapshot: AgentLifecycleSnapshot): PersistedSubagentStatus {
  if (snapshot.state === 'completed') return 'completed'
  if (snapshot.state === 'failed') return 'failed'
  if (snapshot.state === 'cancelled') return 'killed'
  return 'running'
}

function publicRecord(record: StoredLifecycle): PersistedSubagentLifecycle {
  return Object.assign({ ...record }, { status: statusFor(record.lifecycle) })
}

function assertIdentity(sessionId: string, agentId: string): void {
  if (!isClaudeSessionId(sessionId))
    throw new Error(`Invalid subagent lifecycle session ID: ${sessionId}`)
  if (!isClaudeAgentId(agentId))
    throw new Error(`Invalid subagent lifecycle agent ID: ${agentId}`)
}

function isNonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}
function isNonnegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isUsage(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false
  const usage = value as Record<string, unknown>
  if (
    !isNonnegativeInteger(usage.inputTokens) ||
    !isNonnegativeInteger(usage.outputTokens)
  )
    return false
  for (const field of [
    'cacheReadInputTokens',
    'cacheCreationInputTokens',
    'webSearchRequests',
  ])
    if (usage[field] !== undefined && !isNonnegativeInteger(usage[field]))
      return false
  for (const field of ['contextWindow', 'maxOutputTokens'])
    if (
      usage[field] !== undefined &&
      (!Number.isSafeInteger(usage[field]) || Number(usage[field]) < 1)
    )
      return false
  return true
}

function isRunResult(value: unknown): value is PersistedSubagentRunResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false
  const result = value as Record<string, unknown>
  if (
    typeof result.text !== 'string' ||
    !isUsage(result.usage) ||
    !isNonnegativeInteger(result.toolUseCount) ||
    !isNonnegativeInteger(result.durationMs)
  )
    return false
  if (
    result.modelUsage !== undefined &&
    (typeof result.modelUsage !== 'object' ||
      result.modelUsage === null ||
      Array.isArray(result.modelUsage) ||
      !Object.values(result.modelUsage).every(isUsage))
  )
    return false
  for (const field of ['durationApiMs', 'durationApiWithoutRetriesMs'])
    if (result[field] !== undefined && !isNonnegativeNumber(result[field]))
      return false
  return (
    (result.isolationPath === undefined ||
      typeof result.isolationPath === 'string') &&
    (result.isolationRetained === undefined ||
      typeof result.isolationRetained === 'boolean') &&
    (result.isolationWarning === undefined ||
      typeof result.isolationWarning === 'string')
  )
}

function isNotification(
  value: unknown,
): value is PersistedSubagentNotification {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false
  const notification = value as Record<string, unknown>
  const accounting = notification.accounting
  return (
    typeof notification.id === 'string' &&
    /^[0-9a-f-]{36}$/iu.test(notification.id) &&
    ['completed', 'failed', 'killed'].includes(String(notification.status)) &&
    typeof notification.toolUseId === 'string' &&
    notification.toolUseId.length > 0 &&
    (notification.result === null || isRunResult(notification.result)) &&
    (notification.error === null || typeof notification.error === 'string') &&
    typeof notification.consumed === 'boolean' &&
    (accounting === undefined ||
      (typeof accounting === 'object' &&
        accounting !== null &&
        !Array.isArray(accounting) &&
        (accounting as Record<string, unknown>).kind === 'detached' &&
        typeof (accounting as Record<string, unknown>).model === 'string' &&
        String((accounting as Record<string, unknown>).model).trim().length >
          0 &&
        typeof (accounting as Record<string, unknown>).delivered === 'boolean'))
  )
}

function ownerFromLease(lease: ExclusiveFileLeaseHandle): LifecycleOwner {
  return { token: lease.token, pid: lease.pid, acquiredAt: lease.createdAt }
}

export class SubagentExecution {
  private released = false
  constructor(
    private readonly store: SubagentLifecycleStore,
    private readonly lease: ExclusiveFileLeaseHandle,
    public readonly token: string,
    public readonly generation: number,
    private current: AgentLifecycleSnapshot,
  ) {}
  get snapshot(): AgentLifecycleSnapshot {
    return this.current
  }
  async transition(state: LifecycleState): Promise<AgentLifecycleSnapshot> {
    this.ensureActive()
    this.current = await this.store.mutateOwned(
      this.lease,
      this.generation,
      (record) =>
        this.store.withLifecycle(
          record,
          transitionLifecycle(record.lifecycle, state, this.token),
        ),
    )
    return this.current
  }
  async running(): Promise<AgentLifecycleSnapshot> {
    return this.transition('running')
  }
  async beginCancellation(): Promise<AgentLifecycleSnapshot> {
    return this.transition('cancelling')
  }
  async finish(
    state: 'completed' | 'failed' | 'cancelled',
    result?: PersistedSubagentRunResult,
    detail?: string,
    notification?: Omit<PersistedSubagentNotification, 'result' | 'consumed'>,
  ): Promise<AgentLifecycleSnapshot> {
    this.ensureActive()
    this.current = await this.store.mutateOwned(
      this.lease,
      this.generation,
      (record) => {
        const lifecycle = transitionLifecycle(
          record.lifecycle,
          state,
          this.token,
        )
        const notifications = [...(record.notifications ?? [])]
        if (notification && result)
          notifications.push({ ...notification, result, consumed: false })
        return this.store.withLifecycle(record, lifecycle, {
          ...(detail === undefined ? {} : { detail }),
          ...(result === undefined ? {} : { result }),
          ...(notifications.length === 0 ? {} : { notifications }),
        })
      },
      true,
    )
    return this.current
  }
  async release(): Promise<void> {
    if (this.released) return
    try {
      if (!isTerminalLifecycleState(this.current.state))
        this.current = await this.store.mutateOwned(
          this.lease,
          this.generation,
          (record) =>
            this.store.withLifecycle(
              record,
              markLifecycleOrphaned(record.lifecycle, this.token),
            ),
        )
    } finally {
      this.released = true
      await this.lease.release()
    }
  }
  private ensureActive(): void {
    if (this.released) throw new Error('Lifecycle execution has been released')
  }
}

export class SubagentLifecycleStore {
  private readonly path: string
  private readonly ownerLock: ExclusiveFileLease
  private readonly mutationLock: ExclusiveFileLease
  private mutation: Promise<void> = Promise.resolve()
  constructor(
    praxisRoot: string,
    private readonly sessionId: string,
    private readonly agentId: string,
    private readonly transcriptPath?: string,
  ) {
    assertIdentity(sessionId, agentId)
    this.path = join(
      praxisRoot,
      'subagent-lifecycle',
      sessionId,
      `${agentId}.json`,
    )
    this.ownerLock = new ExclusiveFileLease(`${this.path}.owner.lock`)
    this.mutationLock = new ExclusiveFileLease(`${this.path}.mutation.lock`)
  }
  async read(): Promise<PersistedSubagentLifecycle | null> {
    const record = await this.readStored()
    return record ? publicRecord(record) : null
  }

  async acquire(
    mode: 'start' | 'continue' | 'recover' = 'start',
  ): Promise<SubagentExecution> {
    const lease = await this.ownerLock.tryAcquire()
    if (!lease)
      throw new Error(
        `Subagent lifecycle execution is already owned: ${this.path}`,
      )
    let mutationLease: ExclusiveFileLeaseHandle
    try {
      mutationLease = await this.acquireMutationLock()
    } catch (error) {
      await lease.release()
      throw error
    }
    try {
      const record = await this.readStored()
      const owner = ownerFromLease(lease)
      let lifecycle: AgentLifecycleSnapshot
      if (!record) {
        if (mode !== 'start')
          throw new Error(
            `Cannot ${mode} missing subagent lifecycle state: ${this.path}`,
          )
        lifecycle = createAgentLifecycle(owner)
      } else if (mode === 'start') {
        throw new Error(`Subagent lifecycle already exists: ${this.path}`)
      } else if (mode === 'recover') {
        lifecycle = recoverLifecycle(record.lifecycle, owner)
      } else {
        lifecycle = continueLifecycle(record.lifecycle, owner)
      }
      const next = this.withLifecycle(
        record ?? this.baseRecord(lifecycle),
        lifecycle,
      )
      await this.writeStored(next, false)
      return new SubagentExecution(
        this,
        lease,
        owner.token,
        lifecycle.generation,
        lifecycle,
      )
    } catch (error) {
      await lease.release()
      throw error
    } finally {
      await mutationLease.release()
    }
  }
  start(): Promise<SubagentExecution> {
    return this.acquire('start')
  }
  continue(): Promise<SubagentExecution> {
    return this.acquire('continue')
  }
  recover(): Promise<SubagentExecution> {
    return this.acquire('recover')
  }
  async reconcileOwnerLoss(): Promise<{
    owned: boolean
    snapshot: AgentLifecycleSnapshot | null
  }> {
    const current = await this.readStored()
    if (!current || isTerminalLifecycleState(current.lifecycle.state)) {
      return { owned: false, snapshot: current?.lifecycle ?? null }
    }
    const probe = await this.ownerLock.tryAcquire()
    if (!probe) {
      const reread = await this.readStored()
      if (!reread || isTerminalLifecycleState(reread.lifecycle.state)) {
        return { owned: false, snapshot: reread?.lifecycle ?? null }
      }
      return { owned: true, snapshot: reread.lifecycle }
    }
    try {
      const observed = await this.readStored()
      if (!observed || isTerminalLifecycleState(observed.lifecycle.state)) {
        return { owned: false, snapshot: observed?.lifecycle ?? null }
      }
      const reconciled = await this.mutate(async (latest) => {
        if (!latest) return observed
        if (
          latest.lifecycle.generation !== observed.lifecycle.generation ||
          latest.lifecycle.owner?.token !== observed.lifecycle.owner?.token
        )
          return latest
        return this.withLifecycle(
          latest,
          markLifecycleOrphaned(
            latest.lifecycle,
            latest.lifecycle.owner?.token ?? '',
          ),
        )
      })
      return { owned: false, snapshot: reconciled.lifecycle }
    } finally {
      await probe.release()
    }
  }
  acknowledgeNotification(id: string): Promise<void> {
    return this.mutate(async (current) => {
      if (!current)
        throw new Error(`Missing subagent lifecycle state: ${this.path}`)
      const notifications = current.notifications ?? []
      if (!notifications.some((n) => n.id === id && !n.consumed)) return current
      return this.withLifecycle(current, current.lifecycle, {
        notifications: notifications.map((n) =>
          n.id === id ? { ...n, consumed: true } : n,
        ),
      })
    }).then(() => undefined)
  }
  prepareNotificationDetached(id: string, model: string): Promise<void> {
    if (model.trim().length === 0)
      throw new Error('Detached notification model must not be blank')
    return this.mutate(async (current) => {
      if (!current)
        throw new Error(`Missing subagent lifecycle state: ${this.path}`)
      const notifications = current.notifications ?? []
      const matched = notifications.find((n) => n.id === id)
      if (!matched || matched.accounting?.kind === 'detached') return current
      return this.withLifecycle(current, current.lifecycle, {
        notifications: notifications.map((n) =>
          n.id === id
            ? {
                ...n,
                accounting: {
                  kind: 'detached' as const,
                  model,
                  delivered: false,
                },
              }
            : n,
        ),
      })
    }).then(() => undefined)
  }
  confirmNotificationDetached(id: string): Promise<void> {
    return this.mutate(async (current) => {
      if (!current)
        throw new Error(`Missing subagent lifecycle state: ${this.path}`)
      const notifications = current.notifications ?? []
      const matched = notifications.find((n) => n.id === id)
      if (!matched?.accounting || matched.accounting.delivered) return current
      return this.withLifecycle(current, current.lifecycle, {
        notifications: notifications.map((n) =>
          n.id === id && n.accounting
            ? { ...n, accounting: { ...n.accounting, delivered: true } }
            : n,
        ),
      })
    }).then(() => undefined)
  }
  async matchesTranscript(
    record: PersistedSubagentLifecycle,
  ): Promise<boolean> {
    if (
      record.transcriptBytes === undefined ||
      this.transcriptPath === undefined
    )
      return true
    try {
      return (await stat(this.transcriptPath)).size === record.transcriptBytes
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }

  private baseRecord(lifecycle: AgentLifecycleSnapshot): StoredLifecycle {
    return {
      version: 2,
      sessionId: this.sessionId,
      agentId: this.agentId,
      lifecycle,
      updatedAt: new Date().toISOString(),
    }
  }
  withLifecycle(
    current: StoredLifecycle,
    lifecycle: AgentLifecycleSnapshot,
    extra: Partial<
      Pick<StoredLifecycle, 'detail' | 'result' | 'notifications'>
    > = {},
  ): StoredLifecycle {
    return {
      version: 2,
      sessionId: this.sessionId,
      agentId: this.agentId,
      lifecycle,
      updatedAt: new Date().toISOString(),
      ...(extra.detail === undefined
        ? current.detail === undefined
          ? {}
          : { detail: current.detail }
        : { detail: extra.detail }),
      ...(extra.result === undefined
        ? current.result === undefined
          ? {}
          : { result: current.result }
        : { result: extra.result }),
      ...(extra.notifications === undefined
        ? current.notifications === undefined
          ? {}
          : { notifications: current.notifications }
        : { notifications: extra.notifications }),
      ...(current.transcriptBytes === undefined
        ? {}
        : { transcriptBytes: current.transcriptBytes }),
    }
  }
  async mutateOwned(
    lease: ExclusiveFileLeaseHandle,
    generation: number,
    operation: (current: StoredLifecycle) => StoredLifecycle,
    refreshTranscript = false,
  ): Promise<AgentLifecycleSnapshot> {
    const record = await this.mutate(async (current) => {
      if (!current)
        throw new Error(`Missing subagent lifecycle state: ${this.path}`)
      if (
        current.lifecycle.generation !== generation ||
        current.lifecycle.owner?.token !== lease.token
      )
        throw new Error('Lifecycle execution owner token is stale or missing')
      return operation(current)
    }, refreshTranscript)
    return record.lifecycle
  }
  private mutate(
    operation: (current: StoredLifecycle | null) => Promise<StoredLifecycle>,
    refreshTranscript = false,
  ): Promise<StoredLifecycle> {
    const queued = this.mutation.then(async () => {
      const lock = await this.acquireMutationLock()
      try {
        const result = await operation(await this.readStored())
        await this.writeStored(result, refreshTranscript)
        return result
      } finally {
        await lock.release()
      }
    })
    this.mutation = queued.then(
      () => undefined,
      () => undefined,
    )
    return queued
  }
  private async acquireMutationLock(): Promise<ExclusiveFileLeaseHandle> {
    const deadline = Date.now() + 5_000
    for (;;) {
      const lock = await this.mutationLock.tryAcquire()
      if (lock) return lock
      if (Date.now() >= deadline)
        throw new Error(`Subagent lifecycle mutation is busy: ${this.path}`)
      await new Promise<void>((resolve) => setTimeout(resolve, 10))
    }
  }

  private async readStored(): Promise<StoredLifecycle | null> {
    let source: string
    try {
      source = await readFile(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    let value: unknown
    try {
      value = JSON.parse(source)
    } catch (error) {
      throw new Error(`Corrupt subagent lifecycle state: ${this.path}`, {
        cause: error,
      })
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      throw new Error(`Invalid subagent lifecycle state: ${this.path}`)
    const record = value as Record<string, unknown>
    if (record.version === 1) return this.normalizeLegacy(record)
    let lifecycle: AgentLifecycleSnapshot
    try {
      lifecycle = parseAgentLifecycleSnapshot(record.lifecycle)
    } catch {
      throw new Error(`Invalid subagent lifecycle state: ${this.path}`)
    }
    if (
      record.version !== 2 ||
      record.sessionId !== this.sessionId ||
      record.agentId !== this.agentId ||
      typeof record.updatedAt !== 'string' ||
      Number.isNaN(Date.parse(record.updatedAt)) ||
      (record.transcriptBytes !== undefined &&
        !isNonnegativeInteger(record.transcriptBytes)) ||
      (record.detail !== undefined && typeof record.detail !== 'string') ||
      (record.result !== undefined && !isRunResult(record.result)) ||
      (record.notifications !== undefined &&
        (!Array.isArray(record.notifications) ||
          !record.notifications.every(isNotification)))
    )
      throw new Error(`Invalid subagent lifecycle state: ${this.path}`)
    return { ...(record as unknown as StoredLifecycle), lifecycle }
  }
  private normalizeLegacy(record: Record<string, unknown>): StoredLifecycle {
    if (
      record.sessionId !== this.sessionId ||
      record.agentId !== this.agentId ||
      typeof record.status !== 'string' ||
      !['running', 'completed', 'failed', 'killed'].includes(record.status) ||
      typeof record.updatedAt !== 'string' ||
      Number.isNaN(Date.parse(record.updatedAt)) ||
      (record.transcriptBytes !== undefined &&
        !isNonnegativeInteger(record.transcriptBytes)) ||
      (record.detail !== undefined && typeof record.detail !== 'string') ||
      (record.result !== undefined && !isRunResult(record.result)) ||
      (record.notifications !== undefined &&
        (!Array.isArray(record.notifications) ||
          !record.notifications.every(isNotification)))
    )
      throw new Error(`Invalid subagent lifecycle state: ${this.path}`)
    const status = record.status as PersistedSubagentStatus
    const state: LifecycleState =
      status === 'killed'
        ? 'cancelled'
        : status === 'running'
          ? 'orphaned'
          : status
    const terminal = isTerminalLifecycleState(state)
    let lifecycle: AgentLifecycleSnapshot
    try {
      lifecycle = parseAgentLifecycleSnapshot({
        generation: 1,
        revision: 0,
        state,
        owner: null,
        previousOwnerToken: null,
        terminalAt: terminal ? (record.updatedAt as string) : null,
        acceptance: 'pending',
      })
    } catch {
      throw new Error(`Invalid subagent lifecycle state: ${this.path}`)
    }
    return {
      version: 2,
      sessionId: this.sessionId,
      agentId: this.agentId,
      lifecycle,
      updatedAt: record.updatedAt as string,
      ...(record.transcriptBytes === undefined
        ? {}
        : { transcriptBytes: record.transcriptBytes as number }),
      ...(record.detail === undefined
        ? {}
        : { detail: record.detail as string }),
      ...(record.result === undefined
        ? {}
        : { result: record.result as PersistedSubagentRunResult }),
      ...(record.notifications === undefined
        ? {}
        : {
            notifications:
              record.notifications as PersistedSubagentNotification[],
          }),
    }
  }
  private async writeStored(
    record: StoredLifecycle,
    refreshTranscript: boolean,
  ): Promise<void> {
    let transcriptBytes = record.transcriptBytes
    if (refreshTranscript && this.transcriptPath !== undefined) {
      try {
        transcriptBytes = (await stat(this.transcriptPath)).size
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    const next =
      transcriptBytes === undefined ? record : { ...record, transcriptBytes }
    await writeFileAtomically(this.path, `${JSON.stringify(next)}\n`, {
      mode: 0o600,
    })
  }
}
