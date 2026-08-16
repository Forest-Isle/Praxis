import type { ModelUsage, ModelUsageByModel } from '../core/runtime.js'

const AGENT_ID_PATTERN = /^a[0-9a-f]{16}$/u
const MAX_TIMEOUT_MS = 600_000

export interface BackgroundAgentRunResult {
  text: string
  usage: ModelUsage
  modelUsage?: ModelUsageByModel
  toolUseCount: number
  durationMs: number
  isolationPath?: string
  isolationRetained?: boolean
  isolationWarning?: string
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

export interface BackgroundAgentTaskSpec {
  agentId: string
  name?: string
  agentType: string
  description: string
  prompt: string
  toolUseId: string
  outputFile: string
  resolvedModel: string
  run(
    message: string,
    signal: AbortSignal,
    continuation: boolean,
  ): Promise<BackgroundAgentRunResult>
}

type BackgroundAgentStatus = 'running' | 'completed' | 'failed' | 'stopped'

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
}

interface BackgroundAgentNotification {
  status: Exclude<BackgroundAgentStatus, 'running'>
  result: BackgroundAgentRunResult | null
  error: string | null
  toolUseId: string
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
  if (!AGENT_ID_PATTERN.test(agentId)) {
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
] as const

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
}

function addUsageChecked(left: ModelUsage, right: ModelUsage): ModelUsage {
  const inputTokens = left.inputTokens + right.inputTokens
  const outputTokens = left.outputTokens + right.outputTokens
  const cacheReadInputTokens =
    (left.cacheReadInputTokens ?? 0) + (right.cacheReadInputTokens ?? 0)
  const cacheCreationInputTokens =
    (left.cacheCreationInputTokens ?? 0) + (right.cacheCreationInputTokens ?? 0)
  if (
    !Number.isSafeInteger(inputTokens) ||
    !Number.isSafeInteger(outputTokens) ||
    !Number.isSafeInteger(cacheReadInputTokens) ||
    !Number.isSafeInteger(cacheCreationInputTokens)
  ) {
    throw new Error('Model usage total overflow')
  }
  return {
    inputTokens,
    outputTokens,
    ...(cacheReadInputTokens === 0 ? {} : { cacheReadInputTokens }),
    ...(cacheCreationInputTokens === 0 ? {} : { cacheCreationInputTokens }),
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
  map.set(model, addUsageChecked(existing, usage))
}

function mergeToolModelUsage(
  map: Map<string, ModelUsage>,
  breakdown: ModelUsageByModel,
): void {
  const entries = Object.entries(breakdown)
  if (entries.length === 0) return
  // Validate every key, counter, and merged sum before adding any entry from
  // this breakdown so malformed data never merges partially.
  for (const [model, usage] of entries) {
    assertValidModelUsageEntry(model, usage)
    const existing = map.get(model)
    if (existing !== undefined) addUsageChecked(existing, usage)
  }
  for (const [model, usage] of entries) {
    mergeModelUsageEntry(map, model, usage)
  }
}

export class BackgroundAgentManager {
  private readonly tasks = new Map<string, BackgroundAgentTask>()
  private readonly names = new Map<string, string>()
  private closed = false

  launch(spec: BackgroundAgentTaskSpec): BackgroundAgentSnapshot {
    if (this.closed) throw new Error('Background agent manager is closed')
    assertAgentId(spec.agentId)
    if (
      spec.name !== undefined &&
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(spec.name)
    ) {
      throw new Error(`Invalid background agent name: ${spec.name}`)
    }
    if (this.tasks.has(spec.agentId)) {
      throw new Error(`Background agent ${spec.agentId} already exists`)
    }
    this.assertNameAvailable(spec.name, spec.agentId)
    if (spec.name !== undefined) this.names.set(spec.name, spec.agentId)
    const task: BackgroundAgentTask = {
      spec,
      status: 'running',
      controller: null,
      promise: null,
      result: null,
      error: null,
      notifications: [],
      generation: 0,
      queuedMessages: [],
      startedAt: Date.now(),
      durationMs: null,
    }
    this.tasks.set(spec.agentId, task)
    this.start(task, spec.prompt, false, spec.toolUseId)
    return this.snapshot(task)
  }

  registerCompleted(
    spec: BackgroundAgentTaskSpec,
    result: BackgroundAgentRunResult,
  ): BackgroundAgentSnapshot {
    if (this.closed) throw new Error('Background agent manager is closed')
    assertAgentId(spec.agentId)
    if (
      spec.name !== undefined &&
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(spec.name)
    ) {
      throw new Error(`Invalid background agent name: ${spec.name}`)
    }
    const existing = this.tasks.get(spec.agentId)
    if (existing) return this.snapshot(existing)
    this.assertNameAvailable(spec.name, spec.agentId)
    if (spec.name !== undefined) this.names.set(spec.name, spec.agentId)
    const task: BackgroundAgentTask = {
      spec,
      status: 'completed',
      controller: null,
      promise: null,
      result,
      error: null,
      notifications: [],
      generation: 0,
      queuedMessages: [],
      startedAt: Date.now() - result.durationMs,
      durationMs: result.durationMs,
    }
    this.tasks.set(spec.agentId, task)
    return this.snapshot(task)
  }

  has(agentId: string): boolean {
    return this.tasks.has(this.resolveOptional(agentId) ?? agentId)
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
    if (options.block && task.promise) {
      if (options.timeout === 0) {
        await task.promise
      } else {
        await waitBounded(task.promise, options.timeout)
      }
    }
    return this.formatOutput(task)
  }

  stop(agentId: string): string {
    agentId = this.resolveRequired(agentId)
    const task = this.tasks.get(agentId)
    if (!task) throw new Error(`No task found with ID: ${agentId}`)
    if (task.status !== 'running' || !task.controller) {
      throw new Error(`Task ${agentId} is not running (status: ${task.status})`)
    }
    task.status = 'stopped'
    task.error = 'Stopped by TaskStop'
    task.durationMs ??= Date.now() - task.startedAt
    task.queuedMessages.length = 0
    task.controller.abort()
    return `Task ${agentId} stopped successfully`
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const running: Promise<void>[] = []
    for (const task of this.tasks.values()) {
      if (task.status !== 'running' || !task.controller) continue
      task.status = 'stopped'
      task.error = 'Stopped because the background agent manager closed'
      task.queuedMessages.length = 0
      task.controller.abort()
      if (task.promise) running.push(task.promise)
    }
    await Promise.allSettled(running)
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
  }): Promise<{
    messages: string[]
    usage: ModelUsage
    modelUsage?: ModelUsageByModel
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
      if (running.length > 0) await Promise.race(running)
    }
    const notifications: string[] = []
    let usage: ModelUsage = { inputTokens: 0, outputTokens: 0 }
    const modelUsageByModel = new Map<string, ModelUsage>()
    for (const [, task] of eligibleTasks) {
      for (const notification of task.notifications.splice(0)) {
        notifications.push(this.formatNotification(task, notification))
        if (notification.result) {
          assertValidResultUsage(notification.result.usage)
          usage = addUsageChecked(usage, notification.result.usage)
        }
        if (notification.result?.modelUsage) {
          mergeToolModelUsage(modelUsageByModel, notification.result.modelUsage)
        }
      }
    }
    const modelUsage =
      modelUsageByModel.size === 0
        ? undefined
        : Object.fromEntries(modelUsageByModel)
    return modelUsage === undefined
      ? { messages: notifications, usage }
      : { messages: notifications, usage, modelUsage }
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
    task.promise = task.spec
      .run(message, controller.signal, continuation)
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
          status: 'failed',
          result: null,
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

  private resolveOptional(identifier: string): string | undefined {
    if (AGENT_ID_PATTERN.test(identifier)) return identifier
    return this.names.get(identifier)
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
    task.notifications.push({
      status: 'stopped',
      result: stoppedResult,
      error: task.error,
      toolUseId: task.spec.toolUseId,
    })
  }

  private resolveRequired(identifier: string): string {
    const resolved = this.resolveOptional(identifier)
    if (
      !AGENT_ID_PATTERN.test(identifier) &&
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

  private formatOutput(task: BackgroundAgentTask): string {
    const output = task.result?.text ?? task.error ?? ''
    const retrieval = task.status === 'running' ? 'not_ready' : 'success'
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
    const usage = notification.result
      ? `<usage><subagent_tokens>${notification.result.usage.inputTokens + notification.result.usage.outputTokens}</subagent_tokens><tool_uses>${notification.result.toolUseCount}</tool_uses><duration_ms>${notification.result.durationMs}</duration_ms></usage>`
      : ''
    return [
      '<task-notification>',
      `<task-id>${task.spec.agentId}</task-id>`,
      `<tool-use-id>${escapeXml(notification.toolUseId)}</tool-use-id>`,
      `<output-file>${escapeXml(task.spec.outputFile)}</output-file>`,
      `<status>${notification.status}</status>`,
      `<summary>Agent &quot;${escapeXml(task.spec.description)}&quot; finished</summary>`,
      '<note>A task-notification fires each time this agent stops with no live background children of its own. The user can send it another message and resume it, so the same task-id may notify more than once.</note>',
      ...(notification.result?.isolationPath
        ? [
            `<worktree-path>${escapeXml(notification.result.isolationPath)}</worktree-path>`,
            `<worktree-retained>${String(notification.result.isolationRetained)}</worktree-retained>`,
            ...(notification.result.isolationWarning
              ? [
                  `<worktree-warning>${escapeXml(notification.result.isolationWarning)}</worktree-warning>`,
                ]
              : []),
          ]
        : []),
      `<result>${escapeXml(result)}</result>`,
      usage,
      '</task-notification>',
    ]
      .filter((line) => line.length > 0)
      .join('\n')
  }
}
