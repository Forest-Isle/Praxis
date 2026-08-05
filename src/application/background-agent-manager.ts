import type { ModelUsage } from '../core/runtime.js'

const AGENT_ID_PATTERN = /^a[0-9a-f]{16}$/u
const MAX_TIMEOUT_MS = 600_000

export interface BackgroundAgentRunResult {
  text: string
  usage: ModelUsage
  toolUseCount: number
  durationMs: number
}

export interface BackgroundAgentTaskSpec {
  agentId: string
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
}

function assertAgentId(agentId: string): void {
  if (!AGENT_ID_PATTERN.test(agentId)) {
    throw new Error(`Invalid background agent ID: ${agentId}`)
  }
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

export class BackgroundAgentManager {
  private readonly tasks = new Map<string, BackgroundAgentTask>()

  launch(spec: BackgroundAgentTaskSpec): BackgroundAgentSnapshot {
    assertAgentId(spec.agentId)
    if (this.tasks.has(spec.agentId)) {
      throw new Error(`Background agent ${spec.agentId} already exists`)
    }
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
    }
    this.tasks.set(spec.agentId, task)
    this.start(task, spec.prompt, false, spec.toolUseId)
    return this.snapshot(task)
  }

  registerCompleted(
    spec: BackgroundAgentTaskSpec,
    result: BackgroundAgentRunResult,
  ): BackgroundAgentSnapshot {
    assertAgentId(spec.agentId)
    const existing = this.tasks.get(spec.agentId)
    if (existing) return this.snapshot(existing)
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
    }
    this.tasks.set(spec.agentId, task)
    return this.snapshot(task)
  }

  has(agentId: string): boolean {
    return this.tasks.has(agentId)
  }

  snapshotById(agentId: string): BackgroundAgentSnapshot | null {
    const task = this.tasks.get(agentId)
    return task ? this.snapshot(task) : null
  }

  async output(
    agentId: string,
    options: { block: boolean; timeout: number },
  ): Promise<string> {
    assertAgentId(agentId)
    if (
      !Number.isFinite(options.timeout) ||
      options.timeout < 0 ||
      options.timeout > MAX_TIMEOUT_MS
    ) {
      throw new Error(`timeout must be between 0 and ${MAX_TIMEOUT_MS}`)
    }
    const task = this.tasks.get(agentId)
    if (!task) throw new Error(`No task found with ID: ${agentId}`)
    if (options.block && task.promise && task.status === 'running') {
      if (options.timeout === 0) {
        await task.promise
      } else {
        await waitBounded(task.promise, options.timeout)
      }
    }
    return this.formatOutput(task)
  }

  stop(agentId: string): string {
    assertAgentId(agentId)
    const task = this.tasks.get(agentId)
    if (!task) throw new Error(`No task found with ID: ${agentId}`)
    if (task.status !== 'running' || !task.controller) {
      throw new Error(`Task ${agentId} is not running (status: ${task.status})`)
    }
    task.status = 'stopped'
    task.error = 'Stopped by TaskStop'
    task.notifications.push({
      status: 'stopped',
      result: null,
      error: task.error,
      toolUseId: task.spec.toolUseId,
    })
    task.queuedMessages.length = 0
    task.controller.abort()
    return `Task ${agentId} stopped successfully`
  }

  send(
    agentId: string,
    message: string,
    summary: string | undefined,
    toolUseId: string,
  ): string {
    assertAgentId(agentId)
    if (message.trim().length === 0)
      throw new Error('message must not be empty')
    if (summary !== undefined && summary.length > 200) {
      throw new Error('summary must not exceed 200 characters')
    }
    const task = this.tasks.get(agentId)
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
      resumedAgentId: agentId,
    })
  }

  async notifications(options: {
    waitForRunning: boolean
  }): Promise<{ messages: string[]; usage: ModelUsage }> {
    if (
      options.waitForRunning &&
      ![...this.tasks.values()].some((task) => task.notifications.length > 0)
    ) {
      const running = [...this.tasks.values()]
        .filter((task) => task.status === 'running')
        .map((task) => task.promise)
        .filter((promise): promise is Promise<void> => promise !== null)
      if (running.length > 0) await Promise.race(running)
    }
    const notifications: string[] = []
    const usage: ModelUsage = { inputTokens: 0, outputTokens: 0 }
    for (const task of this.tasks.values()) {
      for (const notification of task.notifications.splice(0)) {
        notifications.push(this.formatNotification(task, notification))
        usage.inputTokens += notification.result?.usage.inputTokens ?? 0
        usage.outputTokens += notification.result?.usage.outputTokens ?? 0
      }
    }
    return { messages: notifications, usage }
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
    task.controller = controller
    task.result = null
    task.error = null
    task.promise = task.spec
      .run(message, controller.signal, continuation)
      .then((result) => {
        if (task.generation !== generation || task.status === 'stopped') return
        task.status = 'completed'
        task.result = result
        task.error = null
        task.notifications.push({
          status: 'completed',
          result,
          error: null,
          toolUseId,
        })
      })
      .catch((error: unknown) => {
        if (task.generation !== generation || task.status === 'stopped') return
        task.status = 'failed'
        task.result = null
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

  private snapshot(task: BackgroundAgentTask): BackgroundAgentSnapshot {
    return {
      agentId: task.spec.agentId,
      status: task.status,
      outputFile: task.spec.outputFile,
      result: task.result,
      error: task.error,
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
      `<output>\n${output}\n</output>`,
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
      `<tool-use-id>${notification.toolUseId}</tool-use-id>`,
      `<output-file>${task.spec.outputFile}</output-file>`,
      `<status>${notification.status}</status>`,
      `<summary>Agent "${task.spec.description}" finished</summary>`,
      '<note>A task-notification fires each time this agent stops with no live background children of its own. The user can send it another message and resume it, so the same task-id may notify more than once.</note>',
      `<result>${result}</result>`,
      usage,
      '</task-notification>',
    ]
      .filter((line) => line.length > 0)
      .join('\n')
  }
}
