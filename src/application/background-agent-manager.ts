import { randomUUID } from 'node:crypto'

import type { ModelUsage, ModelUsageByModel } from '../core/runtime.js'
import { isClaudeAgentId } from '../compatibility/claude/sidechain.js'

const MAX_TIMEOUT_MS = 600_000
const DEFAULT_CLOSE_DRAIN_MS = 5_000

export interface BackgroundAgentRunResult {
  text: string
  usage: ModelUsage
  modelUsage?: ModelUsageByModel
  durationApiMs?: number
  durationApiWithoutRetriesMs?: number
  toolUseCount: number
  durationMs: number
  isolationPath?: string
  isolationRetained?: boolean
  isolationWarning?: string
  notificationId?: string
}

export class BackgroundAgentRunError extends Error {
  constructor(
    message: string,
    readonly result?: BackgroundAgentRunResult,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'BackgroundAgentRunError'
  }
}

export class BackgroundAgentShutdownError extends Error {
  constructor() {
    super('Background agent manager closed')
    this.name = 'BackgroundAgentShutdownError'
  }
}

export interface BackgroundAgentTaskSpec {
  agentId: string
  name?: string
  agentType: string
  description: string
  prompt: string
  toolUseId: string
  outputFile: string
  resolvedModel: string
  markBackground?(): void
  acknowledgeNotification?(notificationId: string): Promise<void>
  prepareNotificationDetached?(
    notificationId: string,
    model: string,
  ): Promise<void>
  confirmNotificationDetached?(notificationId: string): Promise<void>
  run(
    message: string,
    signal: AbortSignal,
    continuation: boolean,
    toolUseId: string,
  ): Promise<BackgroundAgentRunResult>
}

type BackgroundAgentStatus =
  'running' | 'completed' | 'failed' | 'stopped' | 'interrupted'

interface BackgroundAgentTask {
  spec: BackgroundAgentTaskSpec
  status: BackgroundAgentStatus
  controller: AbortController | null
  promise: Promise<void> | null
  result: BackgroundAgentRunResult | null
  error: string | null
  notifications: BackgroundAgentNotification[]
  generation: number
  queuedMessages: { message: string; toolUseId: string }[]
  startedAt: number
  durationMs: number | null
  suppressNotifications: boolean
}

interface BackgroundAgentNotification {
  id: string
  status: Exclude<BackgroundAgentStatus, 'running'>
  result: BackgroundAgentRunResult | null
  error: string | null
  toolUseId: string
}

export interface BackgroundAgentNotificationIdentity {
  agentId: string
  toolUseId: string
  status: 'completed' | 'failed' | 'killed'
}

export interface BackgroundAgentSnapshot {
  agentId: string
  status: BackgroundAgentStatus
  outputFile: string
  result: BackgroundAgentRunResult | null
  error: string | null
  name: string | null
  description: string
  startedAt: number
  durationMs: number | null
}

function assertAgentId(agentId: string): void {
  if (!isClaudeAgentId(agentId)) {
    throw new Error(`Invalid background agent ID: ${agentId}`)
  }
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

export function backgroundAgentNotificationMarkers(
  notification: BackgroundAgentNotificationIdentity,
): readonly string[] {
  return [
    `<task-id>${notification.agentId}</task-id>`,
    `<tool-use-id>${escapeXml(notification.toolUseId)}</tool-use-id>`,
    `<status>${notification.status}</status>`,
  ]
}

function waitBounded(
  operation: Promise<void>,
  milliseconds: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds)
    timer.unref?.()
    operation.then(
      () => {
        clearTimeout(timer)
        resolve()
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

const modelUsageCounterFields = [
  'inputTokens',
  'outputTokens',
  'cacheReadInputTokens',
  'cacheCreationInputTokens',
  'webSearchRequests',
] as const

const modelUsageMetadataFields = ['contextWindow', 'maxOutputTokens'] as const

function assertValidModelUsageEntry(model: string, usage: ModelUsage): void {
  if (model.trim() === '') {
    throw new Error('Model usage breakdown contains a blank model name')
  }
  for (const field of modelUsageCounterFields) {
    const value = usage[field]
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new Error(
        `Model usage for "${model}" has an invalid ${field} counter`,
      )
    }
  }
  for (const field of modelUsageMetadataFields) {
    const value = usage[field]
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
      throw new Error(
        `Model usage for "${model}" has an invalid ${field} metadata value`,
      )
    }
  }
}

function mergeModelUsageMetadata(
  model: string,
  left: ModelUsage,
  right: ModelUsage,
): { contextWindow?: number; maxOutputTokens?: number } {
  const contextWindow = mergeModelUsageMetadataField(
    model,
    'contextWindow',
    left.contextWindow,
    right.contextWindow,
  )
  const maxOutputTokens = mergeModelUsageMetadataField(
    model,
    'maxOutputTokens',
    left.maxOutputTokens,
    right.maxOutputTokens,
  )
  return {
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
  }
}

function mergeModelUsageMetadataField(
  model: string,
  field: string,
  left: number | undefined,
  right: number | undefined,
): number | undefined {
  if (left === undefined) return right
  if (right === undefined) return left
  if (left !== right) {
    throw new Error(
      `Model usage for "${model}" has conflicting ${field} values: ${left} vs ${right}`,
    )
  }
  return left
}

function addUsageChecked(
  model: string | undefined,
  left: ModelUsage,
  right: ModelUsage,
): ModelUsage {
  const inputTokens = left.inputTokens + right.inputTokens
  const outputTokens = left.outputTokens + right.outputTokens
  const cacheReadInputTokens =
    (left.cacheReadInputTokens ?? 0) + (right.cacheReadInputTokens ?? 0)
  const cacheCreationInputTokens =
    (left.cacheCreationInputTokens ?? 0) + (right.cacheCreationInputTokens ?? 0)
  const webSearchRequests =
    (left.webSearchRequests ?? 0) + (right.webSearchRequests ?? 0)
  if (
    !Number.isSafeInteger(inputTokens) ||
    !Number.isSafeInteger(outputTokens) ||
    !Number.isSafeInteger(cacheReadInputTokens) ||
    !Number.isSafeInteger(cacheCreationInputTokens) ||
    !Number.isSafeInteger(webSearchRequests)
  ) {
    throw new Error('Model usage total overflow')
  }
  // Aggregates without a model stay counter-only; per-model rows merge their
  // capability metadata with conflict rejection.
  const metadata =
    model === undefined ? {} : mergeModelUsageMetadata(model, left, right)
  return {
    inputTokens,
    outputTokens,
    ...(cacheReadInputTokens === 0 ? {} : { cacheReadInputTokens }),
    ...(cacheCreationInputTokens === 0 ? {} : { cacheCreationInputTokens }),
    ...(webSearchRequests === 0 ? {} : { webSearchRequests }),
    ...metadata,
  }
}

function assertValidResultUsage(usage: ModelUsage): void {
  for (const field of modelUsageCounterFields) {
    const value = usage[field]
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new Error(`Model usage total has an invalid ${field} counter`)
    }
  }
}

function addApiDuration(
  value: number,
  total: number,
  field: 'durationApiMs' | 'durationApiWithoutRetriesMs',
): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${field} must be a finite nonnegative number`)
  }
  const next = total + value
  if (!Number.isFinite(next) || next < 0) {
    throw new TypeError(`${field} total overflow`)
  }
  return next
}

function mergeModelUsageEntry(
  map: Map<string, ModelUsage>,
  model: string,
  usage: ModelUsage,
): void {
  assertValidModelUsageEntry(model, usage)
  const existing = map.get(model)
  if (existing === undefined) {
    map.set(model, { ...usage })
    return
  }
  map.set(model, addUsageChecked(model, existing, usage))
}

function mergeToolModelUsage(
  map: Map<string, ModelUsage>,
  breakdown: ModelUsageByModel,
): void {
  const entries = Object.entries(breakdown)
  if (entries.length === 0) return
  // Validate every key, counter, metadata, and merged sum before adding any
  // entry from this breakdown so malformed or conflicting data never merges
  // partially.
  for (const [model, usage] of entries) {
    assertValidModelUsageEntry(model, usage)
    const existing = map.get(model)
    if (existing !== undefined) addUsageChecked(model, existing, usage)
  }
  for (const [model, usage] of entries) {
    mergeModelUsageEntry(map, model, usage)
  }
}

export class BackgroundAgentManager {
  private readonly tasks = new Map<string, BackgroundAgentTask>()
  private readonly names = new Map<string, string>()
  private readonly closedSignal: Promise<void>
  private resolveClosed!: () => void
  private closed = false

  constructor() {
    this.closedSignal = new Promise<void>((resolve) => {
      this.resolveClosed = resolve
    })
  }

  launch(spec: BackgroundAgentTaskSpec): BackgroundAgentSnapshot {
    const { task } = this.registerTask(
      spec,
      {
        status: 'running',
        controller: null,
        result: null,
        error: null,
        generation: 0,
        startedAt: Date.now(),
        durationMs: null,
      },
      'throw',
    )
    spec.markBackground?.()
    this.start(task, spec.prompt, false, spec.toolUseId)
    return this.snapshot(task)
  }

  adopt(options: {
    spec: BackgroundAgentTaskSpec
    controller: AbortController
    operation: Promise<BackgroundAgentRunResult>
    startedAt: number
  }): BackgroundAgentSnapshot {
    const { spec } = options
    const { task } = this.registerTask(
      spec,
      {
        status: 'running',
        controller: options.controller,
        result: null,
        error: null,
        generation: 1,
        startedAt: options.startedAt,
        durationMs: null,
      },
      'throw',
    )
    spec.markBackground?.()
    this.track(task, options.operation, 1, spec.toolUseId)
    return this.snapshot(task)
  }

  registerCompleted(
    spec: BackgroundAgentTaskSpec,
    result: BackgroundAgentRunResult,
  ): BackgroundAgentSnapshot {
    const { task } = this.registerTask(
      spec,
      {
        status: 'completed',
        controller: null,
        result,
        error: null,
        generation: 0,
        startedAt: Date.now() - result.durationMs,
        durationMs: result.durationMs,
      },
      'return-existing',
    )
    return this.snapshot(task)
  }

  registerInterrupted(
    spec: BackgroundAgentTaskSpec,
    error = 'Persisted agent was interrupted before completion',
  ): BackgroundAgentSnapshot {
    const { task } = this.registerTask(
      spec,
      {
        status: 'interrupted',
        controller: null,
        result: null,
        error,
        generation: 0,
        startedAt: Date.now(),
        durationMs: 0,
      },
      'return-existing',
    )
    return this.snapshot(task)
  }

  registerTerminal(
    spec: BackgroundAgentTaskSpec,
    status: 'failed' | 'stopped',
    error: string,
  ): BackgroundAgentSnapshot {
    const { task } = this.registerTask(
      spec,
      {
        status,
        controller: null,
        result: null,
        error,
        generation: 0,
        startedAt: Date.now(),
        durationMs: 0,
      },
      'return-existing',
    )
    return this.snapshot(task)
  }

  registerPersistedNotification(
    agentId: string,
    notification: {
      id: string
      status: 'completed' | 'failed' | 'stopped'
      result: BackgroundAgentRunResult | null
      error: string | null
      toolUseId: string
    },
  ): void {
    const task = this.tasks.get(agentId)
    if (!task) throw new Error(`No task found with ID: ${agentId}`)
    if (task.notifications.some(({ id }) => id === notification.id)) return
    task.notifications.push(notification)
  }

  has(agentId: string): boolean {
    return this.tasks.has(this.resolveOptional(agentId) ?? agentId)
  }

  notificationClaimAgentIds(): string[] {
    return [...this.tasks.entries()]
      .filter(
        ([, task]) =>
          task.status === 'running' || task.notifications.length > 0,
      )
      .map(([agentId]) => agentId)
  }

  snapshotById(agentId: string): BackgroundAgentSnapshot | null {
    const task = this.tasks.get(agentId)
    return task ? this.snapshot(task) : null
  }

  snapshots(): readonly BackgroundAgentSnapshot[] {
    return [...this.tasks.values()]
      .sort((left, right) => right.startedAt - left.startedAt)
      .map((task) => this.snapshot(task))
  }

  async output(
    agentId: string,
    options: { block: boolean; timeout: number },
  ): Promise<string> {
    agentId = this.resolveRequired(agentId)
    if (
      !Number.isFinite(options.timeout) ||
      options.timeout < 0 ||
      options.timeout > MAX_TIMEOUT_MS
    ) {
      throw new Error(`timeout must be between 0 and ${MAX_TIMEOUT_MS}`)
    }
    const task = this.tasks.get(agentId)
    if (!task) throw new Error(`No task found with ID: ${agentId}`)

    // A positive block wait settles a pending task chain — a stopped task's
    // cleanup chain included — or lets the timeout elapse. Zero-timeout and
    // non-blocking retrievals never wait.
    if (options.block && options.timeout > 0 && task.promise) {
      await waitBounded(task.promise, options.timeout)
    }

    // The retrieval outcome reflects the task's state after any wait: success
    // once terminal, not_ready for non-blocking retrievals, and timeout for a
    // blocking retrieval whose window (including zero) closed while live.
    const retrieval: 'not_ready' | 'success' | 'timeout' =
      task.status !== 'running'
        ? 'success'
        : options.block
          ? 'timeout'
          : 'not_ready'
    return this.formatOutput(task, retrieval)
  }

  stop(agentId: string): string {
    agentId = this.resolveRequired(agentId)
    const task = this.tasks.get(agentId)
    if (!task) throw new Error(`No task found with ID: ${agentId}`)
    this.stopTask(task, 'Stopped by TaskStop')
    return `Task ${agentId} stopped successfully`
  }

  async stopAndWait(
    agentId: string,
    timeout = DEFAULT_CLOSE_DRAIN_MS,
  ): Promise<string> {
    const message = this.stop(agentId)
    const task = this.tasks.get(agentId)
    if (task?.promise) await waitBounded(task.promise, timeout)
    return message
  }

  stopAll(): readonly string[] {
    const stopped: string[] = []
    for (const task of this.tasks.values()) {
      if (task.status !== 'running' || !task.controller) continue
      this.stopTask(task, 'Stopped by explicit bulk kill')
      stopped.push(task.spec.agentId)
    }
    return stopped
  }

  async close(drainMilliseconds = DEFAULT_CLOSE_DRAIN_MS): Promise<void> {
    if (this.closed) return
    if (
      !Number.isFinite(drainMilliseconds) ||
      drainMilliseconds < 0 ||
      drainMilliseconds > MAX_TIMEOUT_MS
    ) {
      throw new Error(
        `close drain must be between 0 and ${MAX_TIMEOUT_MS} milliseconds`,
      )
    }
    this.closed = true
    this.resolveClosed()
    const running: Promise<void>[] = []
    for (const task of this.tasks.values()) {
      if (task.status === 'running' && task.controller) {
        task.status = 'stopped'
        task.error = 'Stopped because the background agent manager closed'
        task.suppressNotifications = true
        task.notifications.length = 0
        task.queuedMessages.length = 0
        task.controller.abort(new BackgroundAgentShutdownError())
      }
      if (task.promise) running.push(task.promise)
    }
    await waitBounded(
      Promise.allSettled(running).then(() => undefined),
      drainMilliseconds,
    )
    this.tasks.clear()
    this.names.clear()
  }

  send(
    agentId: string,
    message: string,
    summary: string | undefined,
    toolUseId: string,
  ): string {
    if (message.trim().length === 0)
      throw new Error('message must not be empty')
    if (summary !== undefined && summary.length > 200) {
      throw new Error('summary must not exceed 200 characters')
    }
    const resolvedAgentId = this.resolveOptional(agentId)
    const task = resolvedAgentId ? this.tasks.get(resolvedAgentId) : undefined
    if (!task) {
      return JSON.stringify({
        success: false,
        message: `No agent named '${agentId}' is reachable.\nCheck the spelling, or use the agent ID from a background agent's spawn result.`,
      })
    }
    const priorStatus = task.status
    if (task.promise && task.status === 'running') {
      task.queuedMessages.push({ message, toolUseId })
    } else {
      this.start(task, message, true, toolUseId)
    }
    return JSON.stringify({
      success: true,
      message: `Agent "${agentId}" was ${priorStatus}; resumed it in the background with your message. You'll be notified when it finishes. Output: ${task.spec.outputFile}`,
      resumedAgentId: task.spec.agentId,
    })
  }

  async notifications(options: {
    waitForRunning: boolean
    excludeAgentId?: string
    consume?: boolean
  }): Promise<{
    messages: string[]
    usage: ModelUsage
    modelUsage?: ModelUsageByModel
    durationApiMs?: number
    durationApiWithoutRetriesMs?: number
  }> {
    const eligibleTasks = [...this.tasks.entries()].filter(
      ([agentId]) => agentId !== options.excludeAgentId,
    )
    if (
      options.waitForRunning &&
      !eligibleTasks.some(([, task]) => task.notifications.length > 0)
    ) {
      const running = eligibleTasks
        .map(([, task]) => task)
        .filter((task) => task.status === 'running')
        .map((task) => task.promise)
        .filter((promise): promise is Promise<void> => promise !== null)
      if (running.length > 0) {
        await Promise.race([Promise.race(running), this.closedSignal])
      }
    }
    const notifications: string[] = []
    let usage: ModelUsage = { inputTokens: 0, outputTokens: 0 }
    const modelUsageByModel = new Map<string, ModelUsage>()
    let durationApiMs = 0
    let durationApiWithoutRetriesMs = 0
    let durationSeen = false
    const consumedTasks: BackgroundAgentTask[] = []
    for (const [, task] of eligibleTasks) {
      if (task.notifications.length === 0) continue
      for (const notification of task.notifications) {
        notifications.push(this.formatNotification(task, notification))
        if (notification.result) {
          assertValidResultUsage(notification.result.usage)
          usage = addUsageChecked(undefined, usage, notification.result.usage)
        }
        if (notification.result?.modelUsage) {
          mergeToolModelUsage(modelUsageByModel, notification.result.modelUsage)
        }
        if (
          notification.result?.durationApiMs !== undefined ||
          notification.result?.durationApiWithoutRetriesMs !== undefined
        ) {
          durationSeen = true
          const total = notification.result.durationApiMs ?? 0
          durationApiMs = addApiDuration(total, durationApiMs, 'durationApiMs')
          durationApiWithoutRetriesMs = addApiDuration(
            notification.result.durationApiWithoutRetriesMs ?? total,
            durationApiWithoutRetriesMs,
            'durationApiWithoutRetriesMs',
          )
        }
      }
      consumedTasks.push(task)
    }
    const modelUsage =
      modelUsageByModel.size === 0
        ? undefined
        : Object.fromEntries(modelUsageByModel)
    if (options.consume !== false) {
      for (const task of consumedTasks) {
        if (!task.spec.acknowledgeNotification) continue
        for (const notification of task.notifications) {
          await task.spec.acknowledgeNotification(notification.id)
        }
      }
    }
    const result = {
      messages: notifications,
      usage,
      ...(modelUsage === undefined ? {} : { modelUsage }),
      ...(durationSeen ? { durationApiMs, durationApiWithoutRetriesMs } : {}),
    }
    if (options.consume !== false) {
      for (const task of consumedTasks) task.notifications.splice(0)
    }
    return result
  }

  async acknowledge(messages: readonly string[]): Promise<void> {
    await this.forEachMatchingNotification(
      messages,
      async (task, notification) => {
        await task.spec.acknowledgeNotification?.(notification.id)
        task.notifications.splice(task.notifications.indexOf(notification), 1)
      },
    )
  }

  async prepareNotificationsDetached(
    messages: readonly string[],
  ): Promise<void> {
    await this.forEachMatchingNotification(
      messages,
      async (task, notification) => {
        await task.spec.prepareNotificationDetached?.(
          notification.id,
          task.spec.resolvedModel,
        )
      },
    )
  }

  async confirmNotificationsDetached(
    messages: readonly string[],
  ): Promise<void> {
    await this.forEachMatchingNotification(
      messages,
      async (task, notification) => {
        await task.spec.confirmNotificationDetached?.(notification.id)
      },
    )
  }

  private async forEachMatchingNotification(
    messages: readonly string[],
    operation: (
      task: BackgroundAgentTask,
      notification: BackgroundAgentNotification,
    ) => Promise<void>,
  ): Promise<void> {
    const remaining = [...messages]
    for (const task of this.tasks.values()) {
      for (const notification of [...task.notifications]) {
        const message = this.formatNotification(task, notification)
        const index = remaining.indexOf(message)
        if (index < 0) continue
        await operation(task, notification)
        remaining.splice(index, 1)
      }
    }
  }

  async acknowledgeDelivered(
    delivered: (notification: BackgroundAgentNotificationIdentity) => boolean,
  ): Promise<void> {
    for (const [agentId, task] of this.tasks) {
      for (const notification of [...task.notifications]) {
        if (notification.status === 'interrupted') continue
        const status =
          notification.status === 'stopped' ? 'killed' : notification.status
        if (
          !delivered({ agentId, toolUseId: notification.toolUseId, status })
        ) {
          continue
        }
        await task.spec.acknowledgeNotification?.(notification.id)
        task.notifications.splice(task.notifications.indexOf(notification), 1)
      }
    }
  }

  async acknowledgeDeliveredAsDetached(
    delivered: (notification: BackgroundAgentNotificationIdentity) => boolean,
  ): Promise<void> {
    for (const [agentId, task] of this.tasks) {
      for (const notification of [...task.notifications]) {
        if (notification.status === 'interrupted') continue
        const status =
          notification.status === 'stopped' ? 'killed' : notification.status
        if (
          !delivered({ agentId, toolUseId: notification.toolUseId, status })
        ) {
          continue
        }
        await task.spec.prepareNotificationDetached?.(
          notification.id,
          task.spec.resolvedModel,
        )
        await task.spec.confirmNotificationDetached?.(notification.id)
        await task.spec.acknowledgeNotification?.(notification.id)
        task.notifications.splice(task.notifications.indexOf(notification), 1)
      }
    }
  }

  private start(
    task: BackgroundAgentTask,
    message: string,
    continuation: boolean,
    toolUseId: string,
  ): void {
    task.generation += 1
    const generation = task.generation
    const controller = new AbortController()
    task.status = 'running'
    task.startedAt = Date.now()
    task.durationMs = null
    task.controller = controller
    task.result = null
    task.error = null
    this.track(
      task,
      task.spec.run(message, controller.signal, continuation, toolUseId),
      generation,
      toolUseId,
    )
  }

  private track(
    task: BackgroundAgentTask,
    operation: Promise<BackgroundAgentRunResult>,
    generation: number,
    toolUseId: string,
  ): void {
    task.promise = operation
      .then((result) => {
        if (task.generation !== generation) return
        if (task.status === 'stopped') {
          this.finishStopped(task, result)
          return
        }
        task.status = 'completed'
        task.result = result
        task.durationMs = result.durationMs
        task.error = null
        task.notifications.push({
          id: result.notificationId ?? randomUUID(),
          status: 'completed',
          result,
          error: null,
          toolUseId,
        })
      })
      .catch((error: unknown) => {
        if (task.generation !== generation) return
        if (task.status === 'stopped') {
          this.finishStopped(
            task,
            error instanceof BackgroundAgentRunError ? error.result : undefined,
          )
          return
        }
        const failedResult =
          error instanceof BackgroundAgentRunError ? error.result : undefined
        task.status = 'failed'
        task.result = null
        task.durationMs =
          failedResult?.durationMs ?? Date.now() - task.startedAt
        task.error = error instanceof Error ? error.message : String(error)
        task.notifications.push({
          id: failedResult?.notificationId ?? randomUUID(),
          status: 'failed',
          result: failedResult ?? null,
          error: task.error,
          toolUseId,
        })
      })
      .finally(() => {
        if (task.generation !== generation) return
        task.controller = null
        task.promise = null
        const next = task.queuedMessages.shift()
        if (next && task.status !== 'stopped') {
          this.start(task, next.message, true, next.toolUseId)
        }
      })
  }

  private registerTask(
    spec: BackgroundAgentTaskSpec,
    state: Pick<
      BackgroundAgentTask,
      | 'status'
      | 'controller'
      | 'result'
      | 'error'
      | 'generation'
      | 'startedAt'
      | 'durationMs'
    >,
    duplicate: 'throw' | 'return-existing',
  ): { task: BackgroundAgentTask; created: boolean } {
    if (this.closed) throw new Error('Background agent manager is closed')
    assertAgentId(spec.agentId)
    if (
      spec.name !== undefined &&
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(spec.name)
    ) {
      throw new Error(`Invalid background agent name: ${spec.name}`)
    }
    const existing = this.tasks.get(spec.agentId)
    if (existing) {
      if (duplicate === 'throw') {
        throw new Error(`Background agent ${spec.agentId} already exists`)
      }
      return { task: existing, created: false }
    }
    this.assertNameAvailable(spec.name, spec.agentId)
    if (spec.name !== undefined) this.names.set(spec.name, spec.agentId)
    const task: BackgroundAgentTask = {
      spec,
      ...state,
      promise: null,
      notifications: [],
      queuedMessages: [],
      suppressNotifications: false,
    }
    this.tasks.set(spec.agentId, task)
    return { task, created: true }
  }

  private resolveOptional(identifier: string): string | undefined {
    if (isClaudeAgentId(identifier)) return identifier
    return this.names.get(identifier)
  }

  private stopTask(task: BackgroundAgentTask, reason: string): void {
    if (task.status !== 'running' || !task.controller) {
      throw new Error(
        `Task ${task.spec.agentId} is not running (status: ${task.status})`,
      )
    }
    task.status = 'stopped'
    task.error = reason
    task.durationMs ??= Date.now() - task.startedAt
    task.queuedMessages.length = 0
    task.controller.abort()
  }

  private assertNameAvailable(name: string | undefined, agentId: string): void {
    if (name === undefined) return
    const existing = this.names.get(name)
    if (existing !== undefined && existing !== agentId) {
      throw new Error(`Background agent name already exists: ${name}`)
    }
  }

  private finishStopped(
    task: BackgroundAgentTask,
    result: BackgroundAgentRunResult | undefined,
  ): void {
    const stoppedResult: BackgroundAgentRunResult = result ?? {
      text: task.error ?? 'Stopped by TaskStop',
      usage: { inputTokens: 0, outputTokens: 0 },
      toolUseCount: 0,
      durationMs: 0,
    }
    task.result = stoppedResult
    task.durationMs ??= stoppedResult.durationMs || Date.now() - task.startedAt
    if (!task.suppressNotifications) {
      task.notifications.push({
        id: stoppedResult.notificationId ?? randomUUID(),
        status: 'stopped',
        result: stoppedResult,
        error: task.error,
        toolUseId: task.spec.toolUseId,
      })
    }
  }

  private resolveRequired(identifier: string): string {
    const resolved = this.resolveOptional(identifier)
    if (
      !isClaudeAgentId(identifier) &&
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(identifier)
    ) {
      assertAgentId(identifier)
    }
    if (!resolved) throw new Error(`No task found with ID: ${identifier}`)
    return resolved
  }

  private snapshot(task: BackgroundAgentTask): BackgroundAgentSnapshot {
    return {
      agentId: task.spec.agentId,
      status: task.status,
      outputFile: task.spec.outputFile,
      result: task.result,
      error: task.error,
      name: task.spec.name ?? null,
      description: task.spec.description,
      startedAt: task.startedAt,
      durationMs: task.durationMs,
    }
  }

  private formatOutput(
    task: BackgroundAgentTask,
    retrieval: 'not_ready' | 'success' | 'timeout',
  ): string {
    const output = task.result?.text ?? task.error ?? ''
    return [
      `<retrieval_status>${retrieval}</retrieval_status>`,
      `<task_id>${task.spec.agentId}</task_id>`,
      '<task_type>local_agent</task_type>',
      `<status>${task.status}</status>`,
      ...(task.result?.isolationPath
        ? [
            `<worktree_path>${escapeXml(task.result.isolationPath)}</worktree_path>`,
            `<worktree_retained>${String(task.result.isolationRetained)}</worktree_retained>`,
            ...(task.result.isolationWarning
              ? [
                  `<worktree_warning>${escapeXml(task.result.isolationWarning)}</worktree_warning>`,
                ]
              : []),
          ]
        : []),
      `<output>\n${escapeXml(output)}\n</output>`,
    ].join('\n\n')
  }

  private formatNotification(
    task: BackgroundAgentTask,
    notification: BackgroundAgentNotification,
  ): string {
    const result = notification.result?.text ?? notification.error ?? ''
    const status =
      notification.status === 'stopped' ? 'killed' : notification.status
    const usage = notification.result
      ? `<usage><total_tokens>${notification.result.usage.inputTokens + notification.result.usage.outputTokens}</total_tokens><tool_uses>${notification.result.toolUseCount}</tool_uses><duration_ms>${notification.result.durationMs}</duration_ms></usage>`
      : ''
    return [
      '<task-notification>',
      `<task-id>${task.spec.agentId}</task-id>`,
      `<tool-use-id>${escapeXml(notification.toolUseId)}</tool-use-id>`,
      `<output-file>${escapeXml(task.spec.outputFile)}</output-file>`,
      `<status>${status}</status>`,
      `<summary>Agent &quot;${escapeXml(task.spec.description)}&quot; finished</summary>`,
      `<result>${escapeXml(result)}</result>`,
      usage,
      '</task-notification>',
    ]
      .filter((line) => line.length > 0)
      .join('\n')
  }
}
