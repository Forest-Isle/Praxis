import { cpus } from 'node:os'

import {
  createWorkflowAgentId,
  createWorkflowRunId,
  createWorkflowTaskId,
  formatWorkflowLaunch,
  isWorkflowRunId,
  isWorkflowTaskId,
  resolveClaudeWorkflowPaths,
} from '../compatibility/claude/workflow.js'
import { resolveClaudePaths } from '../compatibility/claude/paths.js'
import {
  workflowReplayDescriptor,
  workflowReplayKey,
} from '../compatibility/claude/workflow-replay.js'
import type { ModelUsage, ModelUsageByModel } from '../core/runtime.js'
import { ClaudeWorkflowStore } from '../persistence/claude-workflow-store.js'
import type {
  WorkflowAgentRunOptions,
  WorkflowAgentRunResult,
} from './subagent-service.js'
import {
  executeWorkflowScript,
  type WorkflowAgentOptions,
} from './workflow-runtime.js'
import {
  parseWorkflowScript,
  type ParsedWorkflowScript,
  type WorkflowMeta,
} from './workflow-meta.js'

const MAX_AGENTS = 1000
const MAX_CONCURRENCY = Math.min(16, Math.max(1, cpus().length - 2))

export interface WorkflowSource {
  script: string
  parsed: ParsedWorkflowScript
}

export interface WorkflowLaunchOptions {
  sessionId: string
  promptId: string
  script: string
  parsed: ParsedWorkflowScript
  args: unknown
  resumeFromRunId?: string
  defaultModel: string
  tokenBudget?: number | null
  runAgent(options: WorkflowAgentRunOptions): Promise<WorkflowAgentRunResult>
  resolveNested(reference: string): Promise<WorkflowSource>
  signal?: AbortSignal
}

export interface WorkflowLaunchResult {
  taskId: string
  runId: string
  content: string
  scriptFile: string
  transcriptDirectory: string
}

export interface WorkflowProgress {
  index: number
  agentId: string
  label: string
  phase?: string
  status: 'running' | 'completed' | 'error'
  cached?: boolean
  result?: unknown
  error?: string
  totalTokens: number
  toolCalls: number
  durationMs: number
  resolvedModel?: string
  requestedModel?: string
  requestedAgentType?: string
  queuedAt: number
  startedAt?: number
  promptPreview: string
  isolationPath?: string
  isolationRetained?: boolean
  isolationWarning?: string
}

interface WorkflowTask {
  taskId: string
  runId: string
  sessionId: string
  meta: WorkflowMeta
  script: string
  scriptFile: string
  transcriptDirectory: string
  store: ClaudeWorkflowStore
  args: unknown
  defaultModel: string
  startTime: number
  durationMs: number | null
  status: 'running' | 'completed' | 'failed' | 'killed'
  result: unknown
  error?: string
  logs: string[]
  phases: { title: string; detail?: string; model?: string }[]
  progress: WorkflowProgress[]
  agentCount: number
  totalTokens: number
  totalInputTokens: number
  totalToolCalls: number
  usage: ModelUsage
  modelUsage: Map<string, ModelUsage>
  controller: AbortController
  promise: Promise<void>
  notificationPending: boolean
}

export interface WorkflowTaskSnapshot {
  task_id: string
  task_type: 'local_workflow'
  status: WorkflowTask['status']
  summary: string
  run_id: string
  progress: readonly WorkflowProgress[]
  result: unknown
  startTime: number
  durationMs: number
  error?: string
}

class Semaphore {
  private active = 0
  private readonly waiters: (() => void)[] = []

  constructor(private readonly maximum: number) {}

  async use<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    if (this.active >= this.maximum) {
      await new Promise<void>((resolve, reject) => {
        const ready = () => {
          signal.removeEventListener('abort', aborted)
          resolve()
        }
        const aborted = () => {
          const index = this.waiters.indexOf(ready)
          if (index >= 0) this.waiters.splice(index, 1)
          reject(new Error('Workflow aborted'))
        }
        signal.addEventListener('abort', aborted, { once: true })
        this.waiters.push(ready)
      })
    }
    if (signal.aborted) throw new Error('Workflow aborted')
    this.active += 1
    try {
      return await operation()
    } finally {
      this.active -= 1
      this.waiters.shift()?.()
    }
  }
}

function combineSignals(
  parent: AbortSignal | undefined,
  own: AbortController,
): () => void {
  if (!parent) return () => undefined
  const abort = () => own.abort(parent.reason)
  if (parent.aborted) abort()
  else parent.addEventListener('abort', abort, { once: true })
  return () => parent.removeEventListener('abort', abort)
}

function validateAgentOptions(options: WorkflowAgentOptions): void {
  for (const field of [
    'label',
    'phase',
    'model',
    'effort',
    'agentType',
  ] as const) {
    const value = options[field]
    if (
      value !== undefined &&
      (typeof value !== 'string' || value.length === 0)
    ) {
      throw new Error(`agent ${field} must be a non-empty string`)
    }
  }
  if (
    options.effort !== undefined &&
    !['low', 'medium', 'high', 'xhigh', 'max'].includes(options.effort)
  ) {
    throw new Error('agent effort must be low, medium, high, xhigh, or max')
  }
  if (options.isolation !== undefined && options.isolation !== 'worktree') {
    throw new Error('agent isolation must be worktree')
  }
  if (
    options.schema !== undefined &&
    (!options.schema ||
      typeof options.schema !== 'object' ||
      Array.isArray(options.schema))
  ) {
    throw new Error('agent schema must be an object')
  }
}

const workflowUsageCounterFields = [
  'inputTokens',
  'outputTokens',
  'cacheReadInputTokens',
  'cacheCreationInputTokens',
  'webSearchRequests',
] as const

const workflowUsageMetadataFields = [
  'contextWindow',
  'maxOutputTokens',
] as const

function assertValidWorkflowUsage(usage: ModelUsage): void {
  for (const field of workflowUsageCounterFields) {
    const value = usage[field]
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new Error(`Workflow agent usage has an invalid ${field} counter`)
    }
  }
}

function addWorkflowUsageChecked(
  model: string | undefined,
  left: ModelUsage,
  right: ModelUsage,
): ModelUsage {
  assertValidWorkflowUsage(right)
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
    throw new Error('Workflow model usage total overflow')
  }
  // Aggregates without a model stay counter-only; per-model rows merge their
  // capability metadata with conflict rejection.
  const metadata =
    model === undefined ? {} : mergeWorkflowUsageMetadata(model, left, right)
  return {
    inputTokens,
    outputTokens,
    ...(cacheReadInputTokens === 0 ? {} : { cacheReadInputTokens }),
    ...(cacheCreationInputTokens === 0 ? {} : { cacheCreationInputTokens }),
    ...(webSearchRequests === 0 ? {} : { webSearchRequests }),
    ...metadata,
  }
}

function mergeWorkflowUsageMetadata(
  model: string,
  left: ModelUsage,
  right: ModelUsage,
): { contextWindow?: number; maxOutputTokens?: number } {
  const contextWindow = mergeWorkflowUsageMetadataField(
    model,
    'contextWindow',
    left.contextWindow,
    right.contextWindow,
  )
  const maxOutputTokens = mergeWorkflowUsageMetadataField(
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

function mergeWorkflowUsageMetadataField(
  model: string,
  field: string,
  left: number | undefined,
  right: number | undefined,
): number | undefined {
  if (left === undefined) return right
  if (right === undefined) return left
  if (left !== right) {
    throw new Error(
      `Workflow model usage for "${model}" has conflicting ${field} values: ${left} vs ${right}`,
    )
  }
  return left
}

function assertValidWorkflowModelUsageEntry(
  model: string,
  usage: ModelUsage,
): void {
  if (model.trim() === '') {
    throw new Error(
      'Workflow model usage breakdown contains a blank model name',
    )
  }
  assertValidWorkflowUsage(usage)
  for (const field of workflowUsageMetadataFields) {
    const value = usage[field]
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
      throw new Error(
        `Workflow model usage for "${model}" has an invalid ${field} metadata value`,
      )
    }
  }
}

function mergeWorkflowModelUsageEntry(
  map: Map<string, ModelUsage>,
  model: string,
  usage: ModelUsage,
): void {
  assertValidWorkflowModelUsageEntry(model, usage)
  const existing = map.get(model)
  if (existing === undefined) {
    map.set(model, { ...usage })
    return
  }
  map.set(model, addWorkflowUsageChecked(model, existing, usage))
}

function mergeWorkflowModelUsage(
  map: Map<string, ModelUsage>,
  breakdown: ModelUsageByModel,
): void {
  const entries = Object.entries(breakdown)
  if (entries.length === 0) return
  // Validate every key, counter, metadata, and merged sum before adding any
  // entry from this agent result so a malformed or conflicting breakdown never
  // merges partially.
  for (const [model, usage] of entries) {
    assertValidWorkflowModelUsageEntry(model, usage)
    const existing = map.get(model)
    if (existing !== undefined) addWorkflowUsageChecked(model, existing, usage)
  }
  for (const [model, usage] of entries) {
    mergeWorkflowModelUsageEntry(map, model, usage)
  }
}

export class WorkflowManager {
  private readonly tasks = new Map<string, WorkflowTask>()
  private readonly activeRuns = new Set<string>()

  async launch(options: WorkflowLaunchOptions): Promise<WorkflowLaunchResult> {
    const runId = options.resumeFromRunId ?? createWorkflowRunId()
    if (!isWorkflowRunId(runId))
      throw new Error(`Invalid workflow run ID: ${runId}`)
    const activeRunKey = `${options.sessionId}:${runId}`
    if (this.activeRuns.has(activeRunKey)) {
      throw new Error(`Workflow run ${runId} is already running`)
    }
    this.activeRuns.add(activeRunKey)
    const taskId = this.uniqueTaskId()
    const claudePaths = resolveClaudePaths({
      configDir: this.configRoot,
      cwd: this.currentCwd(),
      sessionId: options.sessionId,
    })
    const paths = resolveClaudeWorkflowPaths({
      projectRoot: claudePaths.projectRoot,
      sessionId: options.sessionId,
      runId,
      workflowName: options.parsed.meta.name,
    })
    const store = new ClaudeWorkflowStore(paths)
    try {
      await store.initialize(options.script)
    } catch (error) {
      this.activeRuns.delete(activeRunKey)
      throw error
    }
    const controller = new AbortController()
    const removeParentAbort = combineSignals(options.signal, controller)
    const task: WorkflowTask = {
      taskId,
      runId,
      sessionId: options.sessionId,
      meta: options.parsed.meta,
      script: options.script,
      scriptFile: paths.scriptFile,
      transcriptDirectory: paths.transcriptDirectory,
      store,
      args: structuredClone(options.args),
      defaultModel: options.defaultModel,
      startTime: Date.now(),
      durationMs: null,
      status: 'running',
      result: null,
      logs: [],
      phases: [],
      progress: [],
      agentCount: 0,
      totalTokens: 0,
      totalInputTokens: 0,
      totalToolCalls: 0,
      usage: { inputTokens: 0, outputTokens: 0 },
      modelUsage: new Map<string, ModelUsage>(),
      controller,
      promise: Promise.resolve(),
      notificationPending: false,
    }
    this.tasks.set(taskId, task)
    task.promise = this.execute(task, options)
      .catch(() => undefined)
      .finally(() => {
        removeParentAbort()
        this.activeRuns.delete(activeRunKey)
      })
    return {
      taskId,
      runId,
      content: formatWorkflowLaunch({
        taskId,
        summary: task.meta.description,
        transcriptDirectory: paths.transcriptDirectory,
        scriptFile: paths.scriptFile,
        runId,
      }),
      scriptFile: paths.scriptFile,
      transcriptDirectory: paths.transcriptDirectory,
    }
  }

  has(taskId: string): boolean {
    return this.tasks.has(taskId)
  }

  hasForSession(sessionId: string, taskId: string): boolean {
    return this.tasks.get(taskId)?.sessionId === sessionId
  }

  async output(
    taskId: string,
    options: { block: boolean; timeout: number },
  ): Promise<string> {
    const task = this.task(taskId)
    if (options.block && task.status === 'running') {
      await Promise.race([
        task.promise,
        new Promise<void>((resolve) => setTimeout(resolve, options.timeout)),
      ])
    }
    if (task.status === 'running') {
      return [
        '<retrieval_status>not_ready</retrieval_status>',
        '',
        `<task_id>${task.taskId}</task_id>`,
        '',
        '<task_type>local_workflow</task_type>',
        '',
        '<status>running</status>',
      ].join('\n')
    }
    task.notificationPending = false
    return `${JSON.stringify(this.summary(task), null, 2)}\n\n${this.notification(task)}`
  }

  stop(taskId: string): string {
    const task = this.task(taskId)
    if (task.status === 'running') task.controller.abort('TaskStop')
    return JSON.stringify({
      message: `Successfully stopped task: ${task.taskId} (${task.meta.description})`,
      task_id: task.taskId,
      task_type: 'local_workflow',
      command: task.meta.description,
    })
  }

  async stopAndWait(taskId: string): Promise<void> {
    const task = this.task(taskId)
    if (task.status !== 'running') {
      throw new Error(`Task ${taskId} is not running (status: ${task.status})`)
    }
    task.controller.abort('TaskStop')
    await task.promise
  }

  async notifications(waitForRunning: boolean): Promise<{
    messages: string[]
    usage: ModelUsage
    modelUsage?: ModelUsageByModel
  }> {
    if (waitForRunning) {
      await Promise.all(
        [...this.tasks.values()]
          .filter(({ status }) => status === 'running')
          .map(({ promise }) => promise),
      )
    }
    const messages: string[] = []
    let usage: ModelUsage = { inputTokens: 0, outputTokens: 0 }
    const modelUsage = new Map<string, ModelUsage>()
    for (const task of this.tasks.values()) {
      if (task.status === 'running' || !task.notificationPending) continue
      task.notificationPending = false
      messages.push(this.notification(task))
      usage = addWorkflowUsageChecked(undefined, usage, task.usage)
      for (const [model, entry] of task.modelUsage) {
        mergeWorkflowModelUsageEntry(modelUsage, model, entry)
      }
    }
    const modelUsageByModel =
      modelUsage.size === 0 ? undefined : Object.fromEntries(modelUsage)
    return {
      messages,
      usage,
      ...(modelUsageByModel === undefined
        ? {}
        : { modelUsage: modelUsageByModel }),
    }
  }

  list(sessionId?: string): readonly WorkflowTaskSnapshot[] {
    return [...this.tasks.values()]
      .filter((task) => sessionId === undefined || task.sessionId === sessionId)
      .map((task) => this.summary(task))
  }

  abortAll(): void {
    for (const task of this.tasks.values()) {
      if (task.status === 'running')
        task.controller.abort('Workflow manager closed')
    }
  }

  async close(): Promise<void> {
    this.abortAll()
    await Promise.all([...this.tasks.values()].map(({ promise }) => promise))
  }

  constructor(
    private readonly configRoot: string,
    private readonly cwd: string,
    private readonly cwdProvider?: () => string,
  ) {}

  private currentCwd(): string {
    return this.cwdProvider?.() ?? this.cwd
  }

  private async execute(
    task: WorkflowTask,
    options: WorkflowLaunchOptions,
  ): Promise<void> {
    const semaphore = new Semaphore(MAX_CONCURRENCY)
    const replay = await task.store.replayIndex()
    const replayByDescriptor = await task.store.replayByDescriptor()
    const replayByOrder = await task.store.replayByOrderedSequence(
      task.script,
      task.args,
      options.parsed.orderedReplaySafe,
    )
    const promptReplay = await task.store.replayByPrompt()
    let previousReplayKey = ''
    let currentPhase: string | undefined
    const host = (depth: number) => ({
      total: options.tokenBudget ?? null,
      spent: () => task.totalTokens,
      log: (message: string) => task.logs.push(message),
      phase: (title: string) => {
        currentPhase = title
        const declared = task.meta.phases?.find((item) => item.title === title)
        task.phases.push({
          title,
          ...(declared?.detail === undefined
            ? {}
            : { detail: declared.detail }),
          ...(declared?.model === undefined ? {} : { model: declared.model }),
        })
      },
      agent: async (prompt: string, agentOptions: WorkflowAgentOptions) => {
        validateAgentOptions(agentOptions)
        if (task.controller.signal.aborted) throw new Error('Workflow aborted')
        if (
          options.tokenBudget != null &&
          task.totalTokens >= options.tokenBudget
        ) {
          throw new Error(
            `Workflow token budget exhausted (${options.tokenBudget})`,
          )
        }
        task.agentCount += 1
        if (task.agentCount > MAX_AGENTS) {
          throw new Error(`Workflow agent count exceeded ${MAX_AGENTS}`)
        }
        const key = workflowReplayKey(prompt, agentOptions, previousReplayKey)
        previousReplayKey = key
        const hasSemanticOptions =
          agentOptions.model !== undefined ||
          agentOptions.effort !== undefined ||
          agentOptions.agentType !== undefined ||
          agentOptions.schema !== undefined ||
          agentOptions.isolation !== undefined
        const descriptor = workflowReplayDescriptor(prompt, agentOptions)
        const orderedIndex = task.agentCount - 1
        const orderedReplayKnown = orderedIndex < replayByOrder.length
        const cached =
          replay.get(key) ||
          replayByDescriptor.get(descriptor) ||
          replayByOrder[orderedIndex] ||
          (!orderedReplayKnown && !hasSemanticOptions
            ? promptReplay.get(prompt)
            : undefined)
        const label = agentOptions.label ?? prompt.slice(0, 80)
        const phaseTitle = agentOptions.phase ?? currentPhase
        const queuedAt = Date.now()
        if (cached) {
          task.progress.push({
            index: task.agentCount,
            agentId: cached.agentId,
            label,
            ...(phaseTitle ? { phase: phaseTitle } : {}),
            status: 'completed',
            cached: true,
            result: cached.result,
            totalTokens: 0,
            toolCalls: 0,
            durationMs: 0,
            queuedAt,
            promptPreview: prompt.slice(0, 200),
            ...(agentOptions.model
              ? { requestedModel: agentOptions.model }
              : {}),
            ...(agentOptions.agentType
              ? { requestedAgentType: agentOptions.agentType }
              : {}),
          })
          return cached.result
        }
        const agentId = createWorkflowAgentId()
        const progress: WorkflowProgress = {
          index: task.agentCount,
          agentId,
          label,
          ...(phaseTitle ? { phase: phaseTitle } : {}),
          status: 'running',
          totalTokens: 0,
          toolCalls: 0,
          durationMs: 0,
          queuedAt,
          promptPreview: prompt.slice(0, 200),
          ...(agentOptions.model ? { requestedModel: agentOptions.model } : {}),
          ...(agentOptions.agentType
            ? { requestedAgentType: agentOptions.agentType }
            : {}),
        }
        task.progress.push(progress)
        await task.store.append({ type: 'started', key, agentId })
        await task.store.appendMetadata({
          agentId,
          prompt,
          options: {
            ...(agentOptions.model ? { model: agentOptions.model } : {}),
            ...(agentOptions.effort ? { effort: agentOptions.effort } : {}),
            ...(agentOptions.agentType
              ? { agentType: agentOptions.agentType }
              : {}),
            ...(agentOptions.schema ? { schema: agentOptions.schema } : {}),
            ...(agentOptions.isolation
              ? { isolation: agentOptions.isolation }
              : {}),
          },
        })
        try {
          const result = await semaphore.use(() => {
            progress.startedAt = Date.now()
            return options.runAgent({
              sessionId: task.sessionId,
              promptId: options.promptId,
              runId: task.runId,
              agentId,
              transcriptDirectory: task.transcriptDirectory,
              prompt,
              ...(agentOptions.label ? { label: agentOptions.label } : {}),
              ...(agentOptions.model ? { model: agentOptions.model } : {}),
              ...(agentOptions.effort ? { effort: agentOptions.effort } : {}),
              ...(agentOptions.agentType
                ? { agentType: agentOptions.agentType }
                : {}),
              ...(agentOptions.schema ? { schema: agentOptions.schema } : {}),
              ...(agentOptions.isolation
                ? { isolation: agentOptions.isolation }
                : {}),
              signal: task.controller.signal,
            })
          }, task.controller.signal)
          progress.status = 'completed'
          progress.result = result.result
          progress.totalTokens = result.usage.outputTokens
          progress.toolCalls = result.toolUseCount
          progress.durationMs = result.durationMs
          progress.resolvedModel = result.resolvedModel
          if (result.isolationPath)
            progress.isolationPath = result.isolationPath
          if (result.isolationRetained !== undefined) {
            progress.isolationRetained = result.isolationRetained
          }
          if (result.isolationWarning) {
            progress.isolationWarning = result.isolationWarning
            task.logs.push(result.isolationWarning)
          }
          task.totalTokens += progress.totalTokens
          task.totalInputTokens += result.usage.inputTokens
          task.totalToolCalls += result.toolUseCount
          task.usage = addWorkflowUsageChecked(
            undefined,
            task.usage,
            result.usage,
          )
          if (result.modelUsage !== undefined) {
            mergeWorkflowModelUsage(task.modelUsage, result.modelUsage)
          }
          await task.store.append({
            type: 'result',
            key,
            agentId,
            result: result.result,
          })
          return result.result
        } catch (error) {
          progress.status = 'error'
          progress.error = (error as Error).message
          if (task.controller.signal.aborted) throw error
          await task.store.append({
            type: 'result',
            key,
            agentId,
            result: null,
          })
          return null
        }
      },
      workflow: async (
        reference: string | { scriptPath: string },
        nestedArgs: unknown,
      ) => {
        if (depth >= 1)
          throw new Error('Nested workflows may only be one level deep')
        const source = await options.resolveNested(
          typeof reference === 'string' ? reference : reference.scriptPath,
        )
        return executeWorkflowScript({
          body: source.parsed.body,
          args: nestedArgs,
          host: host(depth + 1),
          signal: task.controller.signal,
        })
      },
    })
    try {
      task.result = await executeWorkflowScript({
        body: options.parsed.body,
        args: task.args,
        host: host(0),
        signal: task.controller.signal,
      })
      task.status = 'completed'
    } catch (error) {
      task.result = null
      task.status = task.controller.signal.aborted ? 'killed' : 'failed'
      task.error = `${error instanceof Error ? (error.stack ?? error.message) : String(error)}`
    } finally {
      task.durationMs = Date.now() - task.startTime
      task.notificationPending = true
      await task.store.writeRun(this.runRecord(task))
    }
  }

  private runRecord(task: WorkflowTask): Record<string, unknown> {
    const durationMs = task.durationMs ?? Date.now() - task.startTime
    return {
      runId: task.runId,
      timestamp: new Date().toISOString(),
      taskId: task.taskId,
      script: task.script,
      scriptPath: task.scriptFile,
      args: task.args,
      result: task.result,
      agentCount: task.agentCount,
      logs: task.logs,
      durationMs,
      summary: task.meta.description,
      workflowName: task.meta.name,
      status: task.status,
      startTime: task.startTime,
      phases: task.phases,
      defaultModel: task.defaultModel,
      workflowProgress: this.nativeProgress(task),
      totalTokens: task.totalTokens,
      totalToolCalls: task.totalToolCalls,
      ...(task.error ? { error: task.error } : {}),
    }
  }

  private summary(task: WorkflowTask): WorkflowTaskSnapshot {
    return {
      task_id: task.taskId,
      task_type: 'local_workflow',
      status: task.status,
      summary: task.meta.description,
      run_id: task.runId,
      progress: task.progress,
      result: task.result,
      startTime: task.startTime,
      durationMs: task.durationMs ?? Date.now() - task.startTime,
      ...(task.error ? { error: task.error } : {}),
    }
  }

  private nativeProgress(task: WorkflowTask): Record<string, unknown>[] {
    const phases = task.phases.map((phase, index) => ({
      type: 'workflow_phase',
      index: index + 1,
      title: phase.title,
    }))
    const agents = task.progress.map((progress) => {
      const phaseIndex = progress.phase
        ? task.phases.findIndex(({ title }) => title === progress.phase) + 1
        : 0
      const resultPreview =
        progress.result === undefined
          ? undefined
          : typeof progress.result === 'string'
            ? progress.result.slice(0, 500)
            : JSON.stringify(progress.result).slice(0, 500)
      return {
        type: 'workflow_agent',
        index: progress.index,
        label: progress.label,
        ...(phaseIndex > 0 ? { phaseIndex, phaseTitle: progress.phase } : {}),
        agentId: progress.agentId,
        ...(progress.requestedAgentType
          ? { agentType: progress.requestedAgentType }
          : {}),
        model: progress.requestedModel ?? task.defaultModel,
        ...(progress.resolvedModel
          ? { fallbackModel: progress.resolvedModel }
          : {}),
        state:
          progress.status === 'completed'
            ? 'done'
            : progress.status === 'error'
              ? 'error'
              : 'running',
        ...(progress.startedAt ? { startedAt: progress.startedAt } : {}),
        queuedAt: progress.queuedAt,
        attempt: 1,
        promptPreview: progress.promptPreview,
        lastProgressAt:
          (progress.startedAt ?? progress.queuedAt) + progress.durationMs,
        tokens: progress.totalTokens,
        toolCalls: progress.toolCalls,
        durationMs: progress.durationMs,
        ...(resultPreview === undefined ? {} : { resultPreview }),
        ...(progress.cached ? { cached: true } : {}),
        ...(progress.error ? { error: progress.error } : {}),
        ...(progress.isolationPath
          ? { worktreePath: progress.isolationPath }
          : {}),
        ...(progress.isolationRetained !== undefined
          ? { worktreeRetained: progress.isolationRetained }
          : {}),
      }
    })
    return [...phases, ...agents]
  }

  private notification(task: WorkflowTask): string {
    const done = task.progress.filter(
      ({ status }) => status === 'completed',
    ).length
    const errors = task.progress.filter(
      ({ status }) => status === 'error',
    ).length
    const empty = task.progress.filter(
      ({ status, result }) =>
        status === 'completed' && (result === '' || result == null),
    ).length
    return [
      '<task-notification>',
      `<task-id>${task.taskId}</task-id>`,
      `<status>${task.status}</status>`,
      `<summary>${task.meta.description}</summary>`,
      `<result>${JSON.stringify(task.result)}</result>`,
      `<diagnostics>Inspect ${task.store.paths.journalFile}. Resume with Workflow({scriptPath: "${task.scriptFile}", resumeFromRunId: "${task.runId}"}).</diagnostics>`,
      '<usage>',
      `agent_count: ${task.agentCount}`,
      `agents_done: ${done}`,
      `agents_error: ${errors}`,
      'agents_skipped: 0',
      `agents_empty_result: ${empty}`,
      `subagent_tokens: ${task.totalTokens}`,
      `tool_uses: ${task.totalToolCalls}`,
      `duration_ms: ${task.durationMs ?? Date.now() - task.startTime}`,
      '</usage>',
      '</task-notification>',
    ].join('\n')
  }

  private uniqueTaskId(): string {
    let id = createWorkflowTaskId()
    while (this.tasks.has(id)) id = createWorkflowTaskId()
    return id
  }

  private task(taskId: string): WorkflowTask {
    if (!isWorkflowTaskId(taskId))
      throw new Error(`Invalid workflow task ID: ${taskId}`)
    const task = this.tasks.get(taskId)
    if (!task) throw new Error(`Unknown workflow task ${taskId}`)
    return task
  }
}

export { parseWorkflowScript }
