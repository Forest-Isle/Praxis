import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { isClaudeSessionId } from '../compatibility/claude/paths.js'
import { isClaudeAgentId } from '../compatibility/claude/sidechain.js'
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
  accounting?: {
    kind: 'detached'
    model: string
    delivered: boolean
  }
}

export interface PersistedSubagentLifecycle {
  version: 1
  sessionId: string
  agentId: string
  status: PersistedSubagentStatus
  updatedAt: string
  transcriptBytes?: number
  detail?: string
  result?: PersistedSubagentRunResult
  notifications?: PersistedSubagentNotification[]
}

const statuses = new Set<PersistedSubagentStatus>([
  'running',
  'completed',
  'failed',
  'killed',
])

function assertIdentity(sessionId: string, agentId: string): void {
  if (!isClaudeSessionId(sessionId)) {
    throw new Error(`Invalid subagent lifecycle session ID: ${sessionId}`)
  }
  if (!isClaudeAgentId(agentId)) {
    throw new Error(`Invalid subagent lifecycle agent ID: ${agentId}`)
  }
}

function isNonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function isNonnegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isUsage(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const usage = value as Record<string, unknown>
  if (
    !isNonnegativeInteger(usage.inputTokens) ||
    !isNonnegativeInteger(usage.outputTokens)
  ) {
    return false
  }
  for (const field of [
    'cacheReadInputTokens',
    'cacheCreationInputTokens',
    'webSearchRequests',
  ]) {
    if (usage[field] !== undefined && !isNonnegativeInteger(usage[field])) {
      return false
    }
  }
  for (const field of ['contextWindow', 'maxOutputTokens']) {
    if (
      usage[field] !== undefined &&
      (!Number.isSafeInteger(usage[field]) || Number(usage[field]) < 1)
    ) {
      return false
    }
  }
  return true
}

function isRunResult(value: unknown): value is PersistedSubagentRunResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const result = value as Record<string, unknown>
  if (
    typeof result.text !== 'string' ||
    !isUsage(result.usage) ||
    !isNonnegativeInteger(result.toolUseCount) ||
    !isNonnegativeInteger(result.durationMs)
  ) {
    return false
  }
  if (
    result.modelUsage !== undefined &&
    (typeof result.modelUsage !== 'object' ||
      result.modelUsage === null ||
      Array.isArray(result.modelUsage) ||
      !Object.values(result.modelUsage).every(isUsage))
  ) {
    return false
  }
  for (const field of ['durationApiMs', 'durationApiWithoutRetriesMs']) {
    if (result[field] !== undefined && !isNonnegativeNumber(result[field])) {
      return false
    }
  }
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
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
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

/** Praxis-private state for a retained Claude-compatible sidechain. */
export class SubagentLifecycleStore {
  private readonly path: string
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
  }

  async read(): Promise<PersistedSubagentLifecycle | null> {
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
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`Invalid subagent lifecycle state: ${this.path}`)
    }
    const record = value as Record<string, unknown>
    if (
      record.version !== 1 ||
      record.sessionId !== this.sessionId ||
      record.agentId !== this.agentId ||
      typeof record.status !== 'string' ||
      !statuses.has(record.status as PersistedSubagentStatus) ||
      typeof record.updatedAt !== 'string' ||
      Number.isNaN(Date.parse(record.updatedAt)) ||
      (record.transcriptBytes !== undefined &&
        !isNonnegativeInteger(record.transcriptBytes)) ||
      (record.detail !== undefined && typeof record.detail !== 'string') ||
      (record.result !== undefined && !isRunResult(record.result)) ||
      (record.notifications !== undefined &&
        (!Array.isArray(record.notifications) ||
          !record.notifications.every(isNotification)))
    ) {
      throw new Error(`Invalid subagent lifecycle state: ${this.path}`)
    }
    return record as unknown as PersistedSubagentLifecycle
  }

  write(
    status: PersistedSubagentStatus,
    detail?: string,
    terminal?: {
      result: PersistedSubagentRunResult
      notification?: Omit<PersistedSubagentNotification, 'result' | 'consumed'>
    },
  ): Promise<void> {
    return this.mutate(async (current) => {
      const notifications = [...(current?.notifications ?? [])]
      if (terminal?.notification) {
        notifications.push({
          ...terminal.notification,
          result: terminal.result,
          consumed: false,
        })
      }
      return this.record({
        status,
        ...(detail === undefined ? {} : { detail }),
        ...(terminal === undefined ? {} : { result: terminal.result }),
        ...(notifications.length === 0 ? {} : { notifications }),
      })
    })
  }

  acknowledgeNotification(id: string): Promise<void> {
    return this.mutate(async (current) => {
      if (!current) {
        throw new Error(`Missing subagent lifecycle state: ${this.path}`)
      }
      const notifications = current.notifications ?? []
      const matched = notifications.find(
        (notification) => notification.id === id && !notification.consumed,
      )
      if (!matched) return current
      return this.record(
        {
          status: current.status,
          ...(current.detail === undefined ? {} : { detail: current.detail }),
          ...(current.result === undefined ? {} : { result: current.result }),
          notifications: notifications.map((notification) =>
            notification.id === id
              ? { ...notification, consumed: true }
              : notification,
          ),
        },
        { transcriptBytes: current.transcriptBytes },
      )
    })
  }

  prepareNotificationDetached(id: string, model: string): Promise<void> {
    if (model.trim().length === 0) {
      throw new Error('Detached notification model must not be blank')
    }
    return this.mutate(async (current) => {
      if (!current) {
        throw new Error(`Missing subagent lifecycle state: ${this.path}`)
      }
      const notifications = current.notifications ?? []
      const matched = notifications.find(
        (notification) => notification.id === id,
      )
      if (!matched || matched.accounting?.kind === 'detached') return current
      return this.record(
        {
          status: current.status,
          ...(current.detail === undefined ? {} : { detail: current.detail }),
          ...(current.result === undefined ? {} : { result: current.result }),
          notifications: notifications.map((notification) =>
            notification.id === id
              ? {
                  ...notification,
                  accounting: {
                    kind: 'detached' as const,
                    model,
                    delivered: false,
                  },
                }
              : notification,
          ),
        },
        { transcriptBytes: current.transcriptBytes },
      )
    })
  }

  confirmNotificationDetached(id: string): Promise<void> {
    return this.mutate(async (current) => {
      if (!current) {
        throw new Error(`Missing subagent lifecycle state: ${this.path}`)
      }
      const notifications = current.notifications ?? []
      const matched = notifications.find(
        (notification) => notification.id === id,
      )
      if (!matched?.accounting || matched.accounting.delivered) return current
      return this.record(
        {
          status: current.status,
          ...(current.detail === undefined ? {} : { detail: current.detail }),
          ...(current.result === undefined ? {} : { result: current.result }),
          notifications: notifications.map((notification) =>
            notification.id === id && notification.accounting
              ? {
                  ...notification,
                  accounting: { ...notification.accounting, delivered: true },
                }
              : notification,
          ),
        },
        { transcriptBytes: current.transcriptBytes },
      )
    })
  }

  async matchesTranscript(
    record: PersistedSubagentLifecycle,
  ): Promise<boolean> {
    if (
      record.transcriptBytes === undefined ||
      this.transcriptPath === undefined
    ) {
      return true
    }
    try {
      return (await stat(this.transcriptPath)).size === record.transcriptBytes
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }

  private async record(
    value: Pick<
      PersistedSubagentLifecycle,
      'status' | 'detail' | 'result' | 'notifications'
    >,
    boundary?: { transcriptBytes: number | undefined },
  ): Promise<PersistedSubagentLifecycle> {
    let transcriptBytes = boundary?.transcriptBytes
    if (boundary === undefined && this.transcriptPath !== undefined) {
      try {
        transcriptBytes = (await stat(this.transcriptPath)).size
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    return {
      version: 1,
      sessionId: this.sessionId,
      agentId: this.agentId,
      status: value.status,
      updatedAt: new Date().toISOString(),
      ...(transcriptBytes === undefined ? {} : { transcriptBytes }),
      ...(value.detail === undefined ? {} : { detail: value.detail }),
      ...(value.result === undefined ? {} : { result: value.result }),
      ...(value.notifications === undefined
        ? {}
        : { notifications: value.notifications }),
    }
  }

  private mutate(
    mutation: (
      current: PersistedSubagentLifecycle | null,
    ) => Promise<PersistedSubagentLifecycle>,
  ): Promise<void> {
    const operation = this.mutation.then(async () => {
      const record = await mutation(await this.read())
      await writeFileAtomically(this.path, `${JSON.stringify(record)}\n`, {
        mode: 0o600,
      })
    })
    this.mutation = operation.catch(() => undefined)
    return operation
  }
}
