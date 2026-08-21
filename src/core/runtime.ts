export type RuntimeState =
  | 'idle'
  | 'assembling-context'
  | 'compacting'
  | 'awaiting-model'
  | 'streaming'
  | 'awaiting-permission'
  | 'executing-tools'
  | 'persisting-results'
  | 'completed'
  | 'cancelled'
  | 'failed'

export type ModelMessage =
  | { role: 'system'; content: string }
  | {
      role: 'user'
      content: string
      contentBlocks?: readonly ModelContentBlock[]
      images?: readonly ModelImage[]
      documents?: readonly ModelDocument[]
    }
  | {
      role: 'assistant'
      content: string
      thinkingBlocks?: readonly ModelThinkingBlock[]
      toolCalls?: readonly ModelToolCall[]
    }
  | {
      role: 'tool'
      toolCallId: string
      content: string
      contentBlocks?: readonly ModelContentBlock[]
      images?: readonly ModelImage[]
      documents?: readonly ModelDocument[]
      isError: boolean
    }

export type ModelImageMediaType =
  'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'

export interface ModelImage {
  type: 'image'
  mediaType: ModelImageMediaType
  data: string
}

export type ModelDocumentMediaType =
  'application/pdf' | 'text/plain' | 'text/markdown' | 'application/json'

export interface ModelDocument {
  type: 'document'
  mediaType: ModelDocumentMediaType
  data: string
}

export type ModelContentBlock =
  { type: 'text'; text: string } | ModelImage | ModelDocument

export interface ModelToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}

export type ModelThinkingMode = 'enabled' | 'adaptive' | 'disabled'

export type ModelThinkingBlock =
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string }

export interface ModelThinkingConfig {
  mode: ModelThinkingMode
  maxTokens?: number
}

export interface ModelToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface ModelUsage {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
  webSearchRequests?: number
  /** Positive safe integer when the completing model's context window is known. */
  contextWindow?: number
  /** Positive safe integer when the completing model's max output tokens are known. */
  maxOutputTokens?: number
}

export type ModelUsageByModel = Readonly<Record<string, ModelUsage>>

export interface ModelWebSearch {
  allowedDomains?: readonly string[]
  blockedDomains?: readonly string[]
  maxUses: number
}

export type ModelTerminalReason =
  'end_turn' | 'tool_use' | 'max_tokens' | 'prompt_too_long'

export type ModelStreamEvent =
  | { type: 'text-delta'; delta: string }
  | {
      type: 'thinking-start'
      block: { type: 'thinking'; thinking: string } | ModelThinkingBlock
    }
  | { type: 'thinking-delta'; delta: string }
  | { type: 'thinking-signature-delta'; delta: string }
  | { type: 'thinking-stop'; block: ModelThinkingBlock }
  | { type: 'tool-call'; call: ModelToolCall }
  | { type: 'usage'; usage: ModelUsage }
  | { type: 'terminal'; reason: ModelTerminalReason }
  | {
      type: 'api-retry'
      attempt: number
      maxRetries: number
      retryDelayMs: number
      errorStatus: number | null
      error: ProviderErrorKind
    }
  | {
      type: 'api-attempt-duration'
      durationMs: number
    }

export interface ModelRequest {
  messages: readonly ModelMessage[]
  tools?: readonly ModelToolDefinition[]
  webSearch?: ModelWebSearch
  signal?: AbortSignal
  effort?: string
  thinking?: ModelThinkingConfig
  betas?: readonly string[]
}

export interface ModelProviderCapabilities {
  streaming: boolean
  usage: boolean
  tools: boolean
  images?: boolean
  documents?: boolean
  webSearch?: boolean
  thinking?: {
    modes: readonly ModelThinkingMode[]
    maxTokens: boolean
  }
  contextWindowTokens?: number
  maxOutputTokens?: number
  /** The provider emits exactly one terminal event as its final stream event. */
  terminalReasons?: boolean
}

export interface ModelProvider {
  readonly capabilities: ModelProviderCapabilities
  readonly model?: string
  complete(request: ModelRequest): AsyncIterable<ModelStreamEvent>
}

export type RuntimeEvent =
  | { type: 'state'; state: Exclude<RuntimeState, 'idle' | 'failed'> }
  | { type: 'text-delta'; delta: string }
  | {
      type: 'thinking-start'
      block: { type: 'thinking'; thinking: string } | ModelThinkingBlock
    }
  | { type: 'thinking-delta'; delta: string }
  | { type: 'thinking-signature-delta'; delta: string }
  | { type: 'thinking-stop'; block: ModelThinkingBlock }
  | {
      type: 'user-message'
      message: string
      attachments?: readonly string[]
      status: 'normal' | 'proactive'
    }
  | { type: 'usage'; usage: ModelUsage }
  | { type: 'terminal'; reason: ModelTerminalReason }
  | { type: 'tool-call'; call: ModelToolCall }
  | {
      type: 'permission-decision'
      callId: string
      behavior: PermissionBehavior
      reason?: string
      source?: 'auto-classifier' | 'rule' | 'mode' | 'default'
      autoModeOutcome?: AutoModePermissionOutcome
    }
  | {
      type: 'tool-result'
      callId: string
      content: string
      isError: boolean
    }
  | { type: 'shell-command'; callId: string; command: string }
  | {
      type: 'shell-result'
      callId: string
      stdout: string
      stderr: string
      isError: boolean
    }
  | { type: 'shell-cancelled'; callId: string }
  | { type: 'warning'; message: string }
  | {
      type: 'compact-boundary'
      trigger: 'manual' | 'auto'
      preTokens: number
      uuid: string
    }
  | {
      type: 'tool-progress'
      toolUseId: string
      toolName: string
      elapsedTimeSeconds: number
      taskId?: string
    }
  | {
      type: 'task-started'
      taskId: string
      toolUseId?: string
      description: string
      taskType?: string
      workflowName?: string
      prompt?: string
    }
  | {
      type: 'task-progress'
      taskId: string
      toolUseId?: string
      description: string
      usage: { totalTokens: number; toolUses: number; durationMs: number }
      lastToolName?: string
      summary?: string
    }
  | {
      type: 'task-notification'
      taskId: string
      toolUseId?: string
      status: 'completed' | 'failed' | 'stopped'
      outputFile: string
      summary: string
      usage?: { totalTokens: number; toolUses: number; durationMs: number }
    }
  | {
      type: 'session-state-changed'
      state: 'idle' | 'running' | 'requires_action'
    }
  | {
      type: 'api-retry'
      attempt: number
      maxRetries: number
      retryDelayMs: number
      errorStatus: number | null
      error: string
    }
  | {
      type: 'elicitation-complete'
      mcpServerName: string
      elicitationId: string
    }
  | {
      type: 'tool-use-summary'
      summary: string
      precedingToolUseIds: readonly string[]
    }
  | {
      type: 'hook'
      event: {
        type: 'started' | 'progress' | 'response'
        hookId: string
        hookName: string
        hookEvent: string
        stdout?: string
        stderr?: string
        output?: string
        exitCode?: number
        outcome?: 'success' | 'error' | 'cancelled'
      }
    }
  | { type: 'failed'; message: string; retryable: boolean }

export interface ToolExecutionResult {
  content: string
  contentBlocks?: readonly ModelContentBlock[]
  images?: readonly ModelImage[]
  documents?: readonly ModelDocument[]
  isError: boolean
  linesAdded?: number
  linesRemoved?: number
  usage?: ModelUsage
  modelUsage?: ModelUsageByModel
  accessedPaths?: readonly string[]
  followUpUserMessages?: readonly string[]
  nativeToolUseResult?: Record<string, unknown>
  nativeMcpMeta?: Record<string, unknown>
  durationApiMs?: number
  durationApiWithoutRetriesMs?: number
  durationToolMs?: number
  processOutput?: {
    stdout: string
    stderr: string
    exitCode: number
  }
}

export interface ToolExecutionContext {
  cwd: string
  messages?: readonly ModelMessage[]
  signal?: AbortSignal
  toolResultDirectory?: string
  originalCall?: ModelToolCall
  permissionUpdates?: readonly PermissionUpdate[]
  permissionPhase?: 'request' | 'execute'
  permissionApproved?: boolean
}

export interface ToolRegistry {
  definitions(): readonly ModelToolDefinition[]
  prepare(
    call: ModelToolCall,
    context: ToolExecutionContext,
  ): Promise<ModelToolCall>
  execute(
    call: ModelToolCall,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult>
}

export type PermissionBehavior = 'allow' | 'ask' | 'deny'

export type PermissionMode =
  | 'acceptEdits'
  | 'auto'
  | 'bypassPermissions'
  | 'manual'
  | 'dontAsk'
  | 'plan'
  | 'default'

export type PermissionUpdateDestination =
  'userSettings' | 'projectSettings' | 'localSettings' | 'session' | 'cliArg'

export type PermissionUpdateMode = Exclude<PermissionMode, 'auto' | 'manual'>

export interface PermissionRuleValue {
  toolName: string
  ruleContent?: string
}

export type PermissionUpdate =
  | {
      type: 'addRules'
      rules: readonly PermissionRuleValue[]
      behavior: PermissionBehavior
      destination: PermissionUpdateDestination
    }
  | {
      type: 'replaceRules'
      rules: readonly PermissionRuleValue[]
      behavior: PermissionBehavior
      destination: PermissionUpdateDestination
    }
  | {
      type: 'removeRules'
      rules: readonly PermissionRuleValue[]
      behavior: PermissionBehavior
      destination: PermissionUpdateDestination
    }
  | {
      type: 'setMode'
      mode: PermissionUpdateMode
      destination: PermissionUpdateDestination
    }
  | {
      type: 'addDirectories'
      directories: readonly string[]
      destination: PermissionUpdateDestination
    }
  | {
      type: 'removeDirectories'
      directories: readonly string[]
      destination: PermissionUpdateDestination
    }

export type PermissionApproval =
  | boolean
  | {
      behavior: 'allow'
      updatedInput?: Record<string, unknown>
      updatedPermissions?: readonly PermissionUpdate[]
      feedback?: string
    }
  | { behavior: 'deny'; message: string; interrupt?: boolean }

export interface PermissionResolutionContext {
  cwd: string
  messages?: readonly ModelMessage[]
  signal?: AbortSignal
  toolResultDirectory?: string
  originalCall?: ModelToolCall
  permissionUpdates?: readonly PermissionUpdate[]
}

export type PermissionDecisionSource =
  'auto-classifier' | 'rule' | 'mode' | 'default'

export type AutoModePermissionOutcome = 'blocked' | 'unavailable'

export type PermissionDecision =
  | {
      behavior: 'allow'
      source?: PermissionDecisionSource
    }
  | {
      behavior: 'ask'
      reason?: string
      suggestions?: readonly PermissionUpdate[]
      metadata?: Readonly<Record<string, unknown>>
      source?: PermissionDecisionSource
    }
  | {
      behavior: 'deny'
      reason: string
      source?: PermissionDecisionSource
    }

export interface PermissionResolver {
  resolve(
    call: ModelToolCall,
    context?: PermissionResolutionContext,
  ): PermissionDecision | Promise<PermissionDecision>
}

const permissionDecisionSources = new WeakMap<
  object,
  PermissionDecisionSource
>()
const autoModePermissionOutcomes = new WeakMap<
  object,
  AutoModePermissionOutcome
>()

export function annotatePermissionDecision<T extends PermissionDecision>(
  decision: T,
  source: PermissionDecisionSource,
): T {
  if (decision.source === undefined)
    permissionDecisionSources.set(decision, source)
  return decision
}

export function permissionDecisionSource(
  decision: PermissionDecision,
): PermissionDecisionSource | undefined {
  return decision.source ?? permissionDecisionSources.get(decision)
}

export function annotateAutoModePermissionOutcome<T extends PermissionDecision>(
  decision: T,
  outcome: AutoModePermissionOutcome,
): T {
  autoModePermissionOutcomes.set(decision, outcome)
  return decision
}

export function autoModePermissionOutcome(
  decision: PermissionDecision,
): AutoModePermissionOutcome | undefined {
  return autoModePermissionOutcomes.get(decision)
}

export interface AgentRunObserver {
  assistantCompleted(message: {
    content: string
    thinkingBlocks?: readonly ModelThinkingBlock[]
    toolCalls?: readonly ModelToolCall[]
  }): Promise<void>
  toolCompleted(call: ModelToolCall, result: ToolExecutionResult): Promise<void>
  followUpUserMessagesCompleted?(messages: readonly string[]): Promise<void>
}

export interface ToolUseSummaryOutcome {
  summary: string | null
  usage: ModelUsage
  modelUsage?: ModelUsageByModel
  durationApiMs: number
  durationApiWithoutRetriesMs: number
  meteredExternally: boolean
}

export interface AgentRuntimeOptions {
  tools?: ToolRegistry
  permissions?: PermissionResolver
  maxModelTurns?: number
  maxModelOutputBytes?: number
  maxToolCallsPerTurn?: number
  maxToolInputBytes?: number
  emitInitialContextState?: boolean
  costUsd?: (usage: ModelUsage) => number | undefined
  maxBudgetUsd?: number
  generateToolUseSummary?: (request: {
    tools: readonly {
      name: string
      input: Record<string, unknown>
      output: string
    }[]
    lastAssistantText?: string
    signal: AbortSignal
  }) => Promise<ToolUseSummaryOutcome | null>
}

export interface AgentRunRequest {
  messages: readonly ModelMessage[]
  cwd?: string
  toolResultDirectory?: string
  observer?: AgentRunObserver
  reloadMessages?: () => Promise<readonly ModelMessage[]>
  approveTool?: (
    call: ModelToolCall,
    originalCall?: ModelToolCall,
    decision?: PermissionDecision,
  ) => PermissionApproval | Promise<PermissionApproval>
  permissionUpdates?: readonly PermissionUpdate[]
  onPermissionUpdates?: (
    updates: readonly PermissionUpdate[],
  ) => void | Promise<void>
  onStop?: (text: string) => Promise<
    | readonly string[]
    | {
        messages: readonly string[]
        usage?: ModelUsage
        modelUsage?: ModelUsageByModel
        durationApiMs?: number
        durationApiWithoutRetriesMs?: number
      }
  >
  signal?: AbortSignal
  effort?: string
  thinking?: ModelThinkingConfig
  collectMetrics?: boolean
  maxModelTurns?: number
  betas?: readonly string[]
}

export interface AgentToolRecoveryRequest extends Pick<
  AgentRunRequest,
  | 'approveTool'
  | 'cwd'
  | 'observer'
  | 'onPermissionUpdates'
  | 'permissionUpdates'
  | 'signal'
  | 'toolResultDirectory'
> {
  approveRecovery?: (call: ModelToolCall) => boolean | Promise<boolean>
  messages?: readonly ModelMessage[]
}

export interface AgentRunResult {
  text: string
  usage: ModelUsage
  modelUsage?: ModelUsageByModel
  durationApiMs?: number
  durationApiWithoutRetriesMs?: number
  durationToolMs?: number
  linesAdded?: number
  linesRemoved?: number
  /** Model rows the session tracker still must record after at least one
   *  externally metered summary outcome; undefined when every summary outcome
   *  is still unrecorded (so inclusive fields stay authoritative). */
  unrecordedModelUsage?: ModelUsageByModel
  unrecordedDurationApiMs?: number
  unrecordedDurationApiWithoutRetriesMs?: number
}

export class ModelProviderError extends Error {
  override readonly name = 'ModelProviderError'
  readonly retryable: boolean
  readonly status?: number
  readonly retryDelayMs?: number
  readonly kind?: ProviderErrorKind

  constructor(
    message: string,
    options: {
      retryable: boolean
      kind?: ProviderErrorKind
      status?: number
      retryDelayMs?: number
      cause?: unknown
    },
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    )
    this.retryable = options.retryable
    if (options.kind !== undefined) this.kind = options.kind
    if (options.status !== undefined) this.status = options.status
    if (options.retryDelayMs !== undefined)
      this.retryDelayMs = options.retryDelayMs
  }
}

export class AgentRunCancelledError extends Error {
  override readonly name = 'AgentRunCancelledError'

  constructor() {
    super('Agent run cancelled')
  }
}

export type RuntimeEventSink = (event: RuntimeEvent) => void

const emptyUsage = (): ModelUsage => ({ inputTokens: 0, outputTokens: 0 })
export type ProviderErrorKind =
  | 'authentication_failed'
  | 'billing_error'
  | 'rate_limit'
  | 'invalid_request'
  | 'server_error'
  | 'timeout'
  | 'overloaded'
  | 'api_error'
  | 'prompt_too_long'
  | 'transport_error'
  | 'cancelled'
  | 'unknown'
  | 'max_output_tokens'

export function modelProviderErrorKind(
  error: ModelProviderError,
): ProviderErrorKind {
  if (error.kind !== undefined) return error.kind
  if (error.status === 401 || error.status === 403)
    return 'authentication_failed'
  if (error.status === 402) return 'billing_error'
  if (error.status === 429) return 'rate_limit'
  if (error.status !== undefined && error.status >= 400 && error.status < 500)
    return 'invalid_request'
  if (error.status !== undefined && error.status >= 500) return 'server_error'
  if (/max(?:imum)? output tokens/iu.test(error.message))
    return 'max_output_tokens'
  return 'unknown'
}
const unsupportedImageResult = 'Provider does not support image tool results'
const unsupportedDocumentResult =
  'Provider does not support document tool results'

function addUsage(left: ModelUsage, right: ModelUsage): ModelUsage {
  const cacheReadInputTokens =
    (left.cacheReadInputTokens ?? 0) + (right.cacheReadInputTokens ?? 0)
  const cacheCreationInputTokens =
    (left.cacheCreationInputTokens ?? 0) + (right.cacheCreationInputTokens ?? 0)
  const webSearchRequests =
    (left.webSearchRequests ?? 0) + (right.webSearchRequests ?? 0)
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    ...(cacheReadInputTokens === 0 ? {} : { cacheReadInputTokens }),
    ...(cacheCreationInputTokens === 0 ? {} : { cacheCreationInputTokens }),
    ...(webSearchRequests === 0 ? {} : { webSearchRequests }),
  }
}

function addLineMetric(
  field: 'linesAdded' | 'linesRemoved',
  value: number | undefined,
  total: number,
): number {
  if (value === undefined) return total
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a nonnegative safe integer`)
  }
  const sum = total + value
  if (!Number.isSafeInteger(sum)) {
    throw new Error(`${field} total overflow`)
  }
  return sum
}

function addToolDurationMetric(
  value: number | undefined,
  total: number,
): number {
  if (value === undefined) return total
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError('durationToolMs must be a finite nonnegative number')
  }
  const sum = total + value
  if (!Number.isFinite(sum) || sum < 0) {
    throw new TypeError('durationToolMs total overflow')
  }
  return sum
}

function addApiDurationMetric(
  value: number,
  total: number,
  field: 'durationApiMs' | 'durationApiWithoutRetriesMs',
): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${field} must be a finite nonnegative number`)
  }
  const sum = total + value
  if (!Number.isFinite(sum) || sum < 0) {
    throw new TypeError(`${field} total overflow`)
  }
  return sum
}

const modelUsageCounterFields = [
  'inputTokens',
  'outputTokens',
  'cacheReadInputTokens',
  'cacheCreationInputTokens',
  'webSearchRequests',
] as const

const modelUsageMetadataFields = ['contextWindow', 'maxOutputTokens'] as const

function hasNonZeroModelUsage(usage: ModelUsage): boolean {
  return (
    usage.inputTokens > 0 ||
    usage.outputTokens > 0 ||
    (usage.cacheReadInputTokens ?? 0) > 0 ||
    (usage.cacheCreationInputTokens ?? 0) > 0 ||
    (usage.webSearchRequests ?? 0) > 0
  )
}

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
  model: string,
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
  const metadata = mergeModelUsageMetadata(model, left, right)
  return {
    inputTokens,
    outputTokens,
    ...(cacheReadInputTokens === 0 ? {} : { cacheReadInputTokens }),
    ...(cacheCreationInputTokens === 0 ? {} : { cacheCreationInputTokens }),
    ...(webSearchRequests === 0 ? {} : { webSearchRequests }),
    ...metadata,
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
  map.set(model, addUsageChecked(model, existing, usage))
}

function mergeToolModelUsage(
  map: Map<string, ModelUsage>,
  breakdown: ModelUsageByModel,
): void {
  const entries = Object.entries(breakdown)
  if (entries.length === 0) return
  // Validate every key, counter, metadata, and merged sum before adding any
  // entry from this tool result so a malformed or conflicting breakdown never
  // merges partially.
  for (const [model, usage] of entries) {
    assertValidModelUsageEntry(model, usage)
    const existing = map.get(model)
    if (existing !== undefined) addUsageChecked(model, existing, usage)
  }
  for (const [model, usage] of entries) {
    mergeModelUsageEntry(map, model, usage)
  }
}

function enrichedProviderUsage(
  provider: ModelProvider,
  usage: ModelUsage,
): ModelUsage {
  const contextWindow = provider.capabilities.contextWindowTokens
  const maxOutputTokens = provider.capabilities.maxOutputTokens
  return {
    ...usage,
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
  }
}

function prepareProviderMessages(
  messages: readonly ModelMessage[],
  supportsImages: boolean,
  supportsDocuments: boolean,
): ModelMessage[] {
  if (supportsImages && supportsDocuments) return [...messages]
  if (
    messages.some(
      (message) => message.role === 'user' && message.images?.length,
    )
  ) {
    throw new Error('Provider does not support user image inputs')
  }
  if (
    !supportsDocuments &&
    messages.some(
      (message) => message.role === 'user' && message.documents?.length,
    )
  ) {
    throw new Error('Provider does not support user document inputs')
  }
  return messages.map((message) =>
    !supportsImages && message.role === 'tool' && message.images?.length
      ? {
          role: 'tool',
          toolCallId: message.toolCallId,
          content: unsupportedImageResult,
          isError: true,
        }
      : !supportsDocuments &&
          message.role === 'tool' &&
          message.documents?.length
        ? {
            role: 'tool',
            toolCallId: message.toolCallId,
            content: unsupportedDocumentResult,
            ...(supportsImages && message.images?.length
              ? { images: message.images }
              : {}),
            isError: true,
          }
        : message,
  )
}

export class AgentRuntime {
  constructor(
    private readonly provider: ModelProvider,
    private readonly emit: RuntimeEventSink = () => undefined,
    private readonly options: AgentRuntimeOptions = {},
  ) {}

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    if (this.options.emitInitialContextState !== false) {
      this.emit({ type: 'state', state: 'assembling-context' })
    }
    if (request.signal?.aborted) return this.cancel()

    const messages = [...request.messages]
    let usage = emptyUsage()
    let modelUsage = emptyUsage()
    const modelUsageByModel = new Map<string, ModelUsage>()
    const unrecordedModelUsageByModel = new Map<string, ModelUsage>()
    let durationApiMs = 0
    let durationApiWithoutRetriesMs = 0
    let unrecordedDurationApiMs = 0
    let unrecordedDurationApiWithoutRetriesMs = 0
    let sawExternallyMeteredSummary = false
    let durationToolMs = 0
    let linesAdded = 0
    let linesRemoved = 0
    const definitions = this.provider.capabilities.tools
      ? (this.options.tools?.definitions() ?? [])
      : []
    const maxModelTurns =
      request.maxModelTurns ?? this.options.maxModelTurns ?? 16
    const maxModelOutputBytes = this.options.maxModelOutputBytes ?? 1024 * 1024
    const maxToolCallsPerTurn = this.options.maxToolCallsPerTurn ?? 32
    const maxToolInputBytes = this.options.maxToolInputBytes ?? 1024 * 1024
    let pendingToolUseSummary:
      | {
          promise: Promise<ToolUseSummaryOutcome | null>
          precedingToolUseIds: readonly string[]
        }
      | undefined

    try {
      for (let turn = 0; turn < maxModelTurns; turn += 1) {
        if (pendingToolUseSummary) {
          const summaryRequest = pendingToolUseSummary
          pendingToolUseSummary = undefined
          // Only accounting callback/tracker errors can reject here; provider
          // and abort failures are swallowed into an outcome by the summary
          // helper, so a rejection must fail the turn (cost accounting closes).
          const outcome = await summaryRequest.promise
          if (outcome) {
            usage = addUsage(usage, outcome.usage)
            modelUsage = addUsage(modelUsage, outcome.usage)
            durationApiMs = addApiDurationMetric(
              outcome.durationApiMs,
              durationApiMs,
              'durationApiMs',
            )
            durationApiWithoutRetriesMs = addApiDurationMetric(
              outcome.durationApiWithoutRetriesMs,
              durationApiWithoutRetriesMs,
              'durationApiWithoutRetriesMs',
            )
            if (outcome.modelUsage) {
              mergeToolModelUsage(modelUsageByModel, outcome.modelUsage)
            }
            if (outcome.meteredExternally) {
              sawExternallyMeteredSummary = true
            } else {
              if (outcome.modelUsage) {
                mergeToolModelUsage(
                  unrecordedModelUsageByModel,
                  outcome.modelUsage,
                )
              }
              unrecordedDurationApiMs = addApiDurationMetric(
                outcome.durationApiMs,
                unrecordedDurationApiMs,
                'durationApiMs',
              )
              unrecordedDurationApiWithoutRetriesMs = addApiDurationMetric(
                outcome.durationApiWithoutRetriesMs,
                unrecordedDurationApiWithoutRetriesMs,
                'durationApiWithoutRetriesMs',
              )
            }
            if (outcome.summary) {
              this.emit({
                type: 'tool-use-summary',
                summary: outcome.summary,
                precedingToolUseIds: summaryRequest.precedingToolUseIds,
              })
            }
          }
        }
        const spent = this.options.costUsd?.(modelUsage)
        if (
          this.options.maxBudgetUsd !== undefined &&
          spent === undefined &&
          (modelUsage.inputTokens > 0 || modelUsage.outputTokens > 0)
        ) {
          throw new Error(
            'Cannot enforce maximum budget because model pricing is unavailable',
          )
        }
        if (
          this.options.maxBudgetUsd !== undefined &&
          spent !== undefined &&
          spent >= this.options.maxBudgetUsd
        ) {
          throw new Error(
            `Maximum budget of $${this.options.maxBudgetUsd.toFixed(6)} exceeded`,
          )
        }
        this.emit({ type: 'state', state: 'awaiting-model' })
        const providerRequest: ModelRequest = {
          messages: prepareProviderMessages(
            messages,
            this.provider.capabilities.images === true,
            this.provider.capabilities.documents === true,
          ),
        }
        if (definitions.length > 0) providerRequest.tools = definitions
        if (request.signal) providerRequest.signal = request.signal
        if (request.effort) providerRequest.effort = request.effort
        if (request.thinking) providerRequest.thinking = request.thinking
        if (request.betas?.length) providerRequest.betas = request.betas

        let text = ''
        let textBytes = 0
        const thinkingBlocks: ModelThinkingBlock[] = []
        let turnUsage = emptyUsage()
        let streaming = false
        const toolCalls: ModelToolCall[] = []
        let terminalReason: ModelTerminalReason | undefined

        const apiStartedAt = request.collectMetrics ? performance.now() : 0
        let turnApiDurationMs = 0
        let turnApiDurationWithoutRetriesMs: number | undefined
        let turnApiAttemptDurationSeen = false
        try {
          for await (const event of this.provider.complete(providerRequest)) {
            if (request.signal?.aborted) return this.cancel()
            if (terminalReason !== undefined) {
              throw new ModelProviderError(
                `Provider emitted ${event.type} after terminal reason ${terminalReason}`,
                { retryable: false },
              )
            }
            if (event.type === 'api-retry') {
              this.emit(event)
              continue
            }
            if (event.type === 'api-attempt-duration') {
              if (turnApiAttemptDurationSeen) {
                throw new Error(
                  'Provider emitted multiple api-attempt-duration events in one turn',
                )
              }
              turnApiAttemptDurationSeen = true
              const { durationMs } = event
              if (
                typeof durationMs !== 'number' ||
                !Number.isFinite(durationMs) ||
                durationMs < 0
              ) {
                throw new TypeError(
                  'api-attempt-duration durationMs must be a finite nonnegative number',
                )
              }
              turnApiDurationWithoutRetriesMs = durationMs
              continue
            }
            if (!streaming) {
              streaming = true
              this.emit({ type: 'state', state: 'streaming' })
            }
            if (event.type === 'text-delta') {
              textBytes += Buffer.byteLength(event.delta)
              if (textBytes > maxModelOutputBytes) {
                throw new Error(
                  `Model output exceeded ${maxModelOutputBytes} bytes`,
                )
              }
              text += event.delta
              this.emit(event)
            } else if (
              event.type === 'thinking-delta' ||
              event.type === 'thinking-signature-delta'
            ) {
              textBytes += Buffer.byteLength(event.delta)
              if (textBytes > maxModelOutputBytes) {
                throw new Error(
                  `Model output exceeded ${maxModelOutputBytes} bytes`,
                )
              }
              this.emit(event)
            } else if (event.type === 'thinking-stop') {
              thinkingBlocks.push(event.block)
              this.emit(event)
            } else if (event.type === 'thinking-start') {
              const initialThinking =
                event.block.type === 'redacted_thinking'
                  ? event.block.data
                  : event.block.thinking
              if (initialThinking.length > 0) {
                textBytes += Buffer.byteLength(initialThinking)
                if (textBytes > maxModelOutputBytes) {
                  throw new Error(
                    `Model output exceeded ${maxModelOutputBytes} bytes`,
                  )
                }
              }
              this.emit(event)
            } else if (event.type === 'tool-call') {
              if (toolCalls.length >= maxToolCallsPerTurn) {
                throw new Error(
                  `Model exceeded ${maxToolCallsPerTurn} tool calls in one turn`,
                )
              }
              if (
                Buffer.byteLength(JSON.stringify(event.call.input)) >
                maxToolInputBytes
              ) {
                throw new Error(
                  `Tool input exceeded ${maxToolInputBytes} bytes`,
                )
              }
              toolCalls.push(event.call)
              this.emit(event)
            } else if (event.type === 'terminal') {
              terminalReason = event.reason
              this.emit(event)
            } else {
              turnUsage = event.usage
              this.emit(event)
            }
          }
        } finally {
          if (request.collectMetrics) {
            turnApiDurationMs = Math.max(0, performance.now() - apiStartedAt)
            durationApiMs = addApiDurationMetric(
              turnApiDurationMs,
              durationApiMs,
              'durationApiMs',
            )
            unrecordedDurationApiMs = addApiDurationMetric(
              turnApiDurationMs,
              unrecordedDurationApiMs,
              'durationApiMs',
            )
          }
        }

        if (
          this.provider.capabilities.terminalReasons === true &&
          terminalReason === undefined
        ) {
          throw new ModelProviderError(
            'Provider stream ended without a terminal reason',
            { retryable: true },
          )
        }
        if (terminalReason === 'tool_use' && toolCalls.length === 0) {
          throw new ModelProviderError(
            'Provider reported tool_use without a completed tool call',
            { retryable: false },
          )
        }
        if (
          terminalReason !== undefined &&
          terminalReason !== 'tool_use' &&
          toolCalls.length > 0
        ) {
          throw new ModelProviderError(
            `Provider reported ${terminalReason} with completed tool calls`,
            { retryable: false },
          )
        }
        if (request.collectMetrics) {
          const turnApiDurationWithoutRetriesMsResolved =
            turnApiDurationWithoutRetriesMs ?? turnApiDurationMs
          durationApiWithoutRetriesMs = addApiDurationMetric(
            turnApiDurationWithoutRetriesMsResolved,
            durationApiWithoutRetriesMs,
            'durationApiWithoutRetriesMs',
          )
          unrecordedDurationApiWithoutRetriesMs = addApiDurationMetric(
            turnApiDurationWithoutRetriesMsResolved,
            unrecordedDurationApiWithoutRetriesMs,
            'durationApiWithoutRetriesMs',
          )
        }

        if (!streaming) this.emit({ type: 'state', state: 'streaming' })
        usage = addUsage(usage, turnUsage)
        modelUsage = addUsage(modelUsage, turnUsage)
        if (
          this.provider.model !== undefined &&
          this.provider.model.trim() !== '' &&
          hasNonZeroModelUsage(turnUsage)
        ) {
          const enrichedUsage = enrichedProviderUsage(this.provider, turnUsage)
          mergeModelUsageEntry(
            modelUsageByModel,
            this.provider.model,
            enrichedUsage,
          )
          mergeModelUsageEntry(
            unrecordedModelUsageByModel,
            this.provider.model,
            enrichedUsage,
          )
        }
        const assistantMessage =
          toolCalls.length === 0
            ? {
                role: 'assistant' as const,
                content: text,
                ...(thinkingBlocks.length > 0 ? { thinkingBlocks } : {}),
              }
            : {
                role: 'assistant' as const,
                content: text,
                ...(thinkingBlocks.length > 0 ? { thinkingBlocks } : {}),
                toolCalls,
              }
        await request.observer?.assistantCompleted(assistantMessage)
        messages.push(assistantMessage)

        if (toolCalls.length === 0) {
          const stopResult = (await request.onStop?.(text)) ?? []
          const stopBatch = Array.isArray(stopResult)
            ? null
            : (stopResult as {
                messages: readonly string[]
                usage?: ModelUsage
                modelUsage?: ModelUsageByModel
                durationApiMs?: number
                durationApiWithoutRetriesMs?: number
              })
          const stopMessages: readonly string[] = stopBatch
            ? stopBatch.messages
            : (stopResult as readonly string[])
          if (stopBatch?.usage) {
            usage = addUsage(usage, stopBatch.usage)
          }
          if (stopBatch?.modelUsage) {
            mergeToolModelUsage(modelUsageByModel, stopBatch.modelUsage)
            mergeToolModelUsage(
              unrecordedModelUsageByModel,
              stopBatch.modelUsage,
            )
          }
          if (stopBatch?.durationApiMs !== undefined) {
            durationApiMs = addApiDurationMetric(
              stopBatch.durationApiMs,
              durationApiMs,
              'durationApiMs',
            )
            unrecordedDurationApiMs = addApiDurationMetric(
              stopBatch.durationApiMs,
              unrecordedDurationApiMs,
              'durationApiMs',
            )
          }
          if (
            stopBatch?.durationApiWithoutRetriesMs !== undefined ||
            stopBatch?.durationApiMs !== undefined
          ) {
            const resolvedStopDurationWithoutRetriesMs =
              stopBatch.durationApiWithoutRetriesMs ??
              stopBatch.durationApiMs ??
              0
            durationApiWithoutRetriesMs = addApiDurationMetric(
              resolvedStopDurationWithoutRetriesMs,
              durationApiWithoutRetriesMs,
              'durationApiWithoutRetriesMs',
            )
            unrecordedDurationApiWithoutRetriesMs = addApiDurationMetric(
              resolvedStopDurationWithoutRetriesMs,
              unrecordedDurationApiWithoutRetriesMs,
              'durationApiWithoutRetriesMs',
            )
          }
          if (stopMessages.length > 0) {
            await request.observer?.followUpUserMessagesCompleted?.(
              stopMessages,
            )
            messages.push(
              ...stopMessages.map((content) => ({
                role: 'user' as const,
                content,
              })),
            )
            if (request.reloadMessages) {
              const reloadedMessages = await request.reloadMessages()
              if (request.signal?.aborted) return this.cancel()
              messages.splice(0, messages.length, ...reloadedMessages)
            }
            continue
          }
          this.emit({ type: 'state', state: 'completed' })
          const modelUsage =
            modelUsageByModel.size === 0
              ? undefined
              : Object.fromEntries(modelUsageByModel)
          return {
            text,
            usage,
            ...(modelUsage === undefined ? {} : { modelUsage }),
            ...(sawExternallyMeteredSummary
              ? {
                  unrecordedModelUsage: Object.fromEntries(
                    unrecordedModelUsageByModel,
                  ),
                  unrecordedDurationApiMs,
                  unrecordedDurationApiWithoutRetriesMs,
                }
              : {}),
            ...(durationApiMs === 0 ? {} : { durationApiMs }),
            ...(durationApiMs === 0 && durationApiWithoutRetriesMs === 0
              ? {}
              : { durationApiWithoutRetriesMs }),
            ...(durationToolMs === 0 ? {} : { durationToolMs }),
            ...(linesAdded === 0 ? {} : { linesAdded }),
            ...(linesRemoved === 0 ? {} : { linesRemoved }),
          }
        }

        const followUpUserMessages: string[] = []
        const completedTools: {
          name: string
          input: Record<string, unknown>
          output: string
        }[] = []
        for (const call of toolCalls) {
          const result = await this.completeToolCall(call, request, messages)
          completedTools.push({
            name: call.name,
            input: call.input,
            output: result.content,
          })
          if (result.usage) usage = addUsage(usage, result.usage)
          if (result.isError === false && result.modelUsage !== undefined) {
            mergeToolModelUsage(modelUsageByModel, result.modelUsage)
            mergeToolModelUsage(unrecordedModelUsageByModel, result.modelUsage)
          }
          durationApiMs = addApiDurationMetric(
            result.durationApiMs ?? 0,
            durationApiMs,
            'durationApiMs',
          )
          durationApiWithoutRetriesMs = addApiDurationMetric(
            result.durationApiWithoutRetriesMs ?? result.durationApiMs ?? 0,
            durationApiWithoutRetriesMs,
            'durationApiWithoutRetriesMs',
          )
          unrecordedDurationApiMs = addApiDurationMetric(
            result.durationApiMs ?? 0,
            unrecordedDurationApiMs,
            'durationApiMs',
          )
          unrecordedDurationApiWithoutRetriesMs = addApiDurationMetric(
            result.durationApiWithoutRetriesMs ?? result.durationApiMs ?? 0,
            unrecordedDurationApiWithoutRetriesMs,
            'durationApiWithoutRetriesMs',
          )
          durationToolMs = addToolDurationMetric(
            result.durationToolMs,
            durationToolMs,
          )
          if (result.isError === false) {
            linesAdded = addLineMetric(
              'linesAdded',
              result.linesAdded,
              linesAdded,
            )
            linesRemoved = addLineMetric(
              'linesRemoved',
              result.linesRemoved,
              linesRemoved,
            )
          }
          messages.push({
            role: 'tool',
            toolCallId: call.id,
            content: result.content,
            ...(result.contentBlocks
              ? { contentBlocks: result.contentBlocks }
              : {}),
            ...(result.images ? { images: result.images } : {}),
            ...(result.documents ? { documents: result.documents } : {}),
            isError: result.isError,
          })
          followUpUserMessages.push(...(result.followUpUserMessages ?? []))
        }
        if (this.options.generateToolUseSummary) {
          const summarySignal = request.signal ?? new AbortController().signal
          pendingToolUseSummary = {
            promise: this.options.generateToolUseSummary({
              tools: completedTools,
              ...(text ? { lastAssistantText: text } : {}),
              signal: summarySignal,
            }),
            precedingToolUseIds: toolCalls.map((call) => call.id),
          }
        }
        if (followUpUserMessages.length > 0) {
          await request.observer?.followUpUserMessagesCompleted?.(
            followUpUserMessages,
          )
          messages.push(
            ...followUpUserMessages.map((content) => ({
              role: 'user' as const,
              content,
            })),
          )
        }
        if (request.reloadMessages) {
          const reloadedMessages = await request.reloadMessages()
          if (request.signal?.aborted) return this.cancel()
          messages.splice(0, messages.length, ...reloadedMessages)
        }
      }

      throw new Error(`Agent exceeded ${maxModelTurns} model turns`)
    } catch (error) {
      if (request.signal?.aborted) return this.cancel()
      const message = error instanceof Error ? error.message : String(error)
      const retryable =
        error instanceof ModelProviderError ? error.retryable : false
      this.emit({ type: 'failed', message, retryable })
      throw error
    }
  }

  async recoverToolCalls(
    calls: readonly ModelToolCall[],
    request: AgentToolRecoveryRequest,
  ): Promise<ToolExecutionResult[]> {
    if (request.signal?.aborted) return this.cancel()
    const maxToolCallsPerTurn = this.options.maxToolCallsPerTurn ?? 32
    const maxToolInputBytes = this.options.maxToolInputBytes ?? 1024 * 1024
    if (calls.length > maxToolCallsPerTurn) {
      throw new Error(
        `Recovery exceeded ${maxToolCallsPerTurn} tool calls in one turn`,
      )
    }
    for (const call of calls) {
      if (Buffer.byteLength(JSON.stringify(call.input)) > maxToolInputBytes) {
        throw new Error(
          `Recovery tool input exceeded ${maxToolInputBytes} bytes`,
        )
      }
    }

    const results: ToolExecutionResult[] = []
    for (const call of calls) {
      this.emit({ type: 'tool-call', call })
      results.push(await this.completeToolCall(call, request))
    }
    const followUpUserMessages = results.flatMap(
      (result) => result.followUpUserMessages ?? [],
    )
    if (followUpUserMessages.length > 0) {
      await request.observer?.followUpUserMessagesCompleted?.(
        followUpUserMessages,
      )
    }
    return results
  }

  async executeDirectToolCall(
    call: ModelToolCall,
    request: AgentToolRecoveryRequest,
  ): Promise<ToolExecutionResult> {
    if (request.signal?.aborted) return this.cancel()
    const maxToolInputBytes = this.options.maxToolInputBytes ?? 1024 * 1024
    if (Buffer.byteLength(JSON.stringify(call.input)) > maxToolInputBytes) {
      throw new Error(`Direct tool input exceeded ${maxToolInputBytes} bytes`)
    }
    const result = await this.completeToolCall(
      call,
      request,
      request.messages ?? [],
      false,
    )
    const followUpUserMessages = result.followUpUserMessages ?? []
    if (followUpUserMessages.length > 0) {
      await request.observer?.followUpUserMessagesCompleted?.(
        followUpUserMessages,
      )
    }
    return result
  }

  private async completeToolCall(
    call: ModelToolCall,
    request: AgentToolRecoveryRequest,
    messages: readonly ModelMessage[] = request.messages ?? [],
    emitPresentation = true,
  ): Promise<ToolExecutionResult> {
    const startedAt = performance.now()
    const emitProgress = () =>
      this.emit({
        type: 'tool-progress',
        toolUseId: call.id,
        toolName: call.name,
        elapsedTimeSeconds: Math.max(
          0,
          Math.round(((performance.now() - startedAt) / 1000) * 1000) / 1000,
        ),
      })
    const progressTimer = emitPresentation
      ? setInterval(emitProgress, 1000)
      : undefined
    progressTimer?.unref()
    try {
      const executed = await this.executeTool(call, request, messages)
      const unsupportedImages =
        executed.images?.length && this.provider.capabilities.images !== true
      const unsupportedDocuments =
        executed.documents?.length &&
        this.provider.capabilities.documents !== true
      const result =
        unsupportedImages || unsupportedDocuments
          ? {
              content: unsupportedImages
                ? unsupportedImageResult
                : unsupportedDocumentResult,
              ...(this.provider.capabilities.images === true && executed.images
                ? { images: executed.images }
                : {}),
              isError: true,
              ...(executed.usage ? { usage: executed.usage } : {}),
              ...(executed.durationToolMs !== undefined
                ? { durationToolMs: executed.durationToolMs }
                : {}),
            }
          : executed
      this.emit({ type: 'state', state: 'persisting-results' })
      await request.observer?.toolCompleted(call, result)
      if (emitPresentation) {
        emitProgress()
        this.emit({
          type: 'tool-result',
          callId: call.id,
          content: result.content,
          isError: result.isError,
        })
      }
      return result
    } finally {
      if (progressTimer) clearInterval(progressTimer)
    }
  }

  private async executeTool(
    call: ModelToolCall,
    request: AgentToolRecoveryRequest,
    messages: readonly ModelMessage[],
  ): Promise<ToolExecutionResult> {
    const tools = this.options.tools
    const permissions = this.options.permissions
    if (!tools || !permissions) {
      await this.requireRecoveryApproval(call, request)
      return {
        content: `Tool ${call.name} is unavailable`,
        isError: true,
      }
    }

    const context: ToolExecutionContext = {
      cwd: request.cwd ?? '',
      messages,
      originalCall: call,
      permissionPhase: 'request',
      permissionUpdates: request.permissionUpdates ?? [],
    }
    if (request.signal) context.signal = request.signal
    if (request.toolResultDirectory) {
      context.toolResultDirectory = request.toolResultDirectory
    }

    let prepared: ModelToolCall
    try {
      prepared = await tools.prepare(call, context)
    } catch (error) {
      await this.requireRecoveryApproval(call, request)
      return {
        content: error instanceof Error ? error.message : String(error),
        isError: true,
      }
    }
    await this.requireRecoveryApproval(prepared, request)

    const decision = await permissions.resolve(prepared, context)
    const source = permissionDecisionSource(decision)
    const autoModeOutcome = autoModePermissionOutcome(decision)
    this.emit({
      type: 'permission-decision',
      callId: call.id,
      behavior: decision.behavior,
      ...('reason' in decision && decision.reason !== undefined
        ? { reason: decision.reason }
        : {}),
      ...(source === undefined ? {} : { source }),
      ...(autoModeOutcome === undefined ? {} : { autoModeOutcome }),
    })
    let allowed = decision.behavior === 'allow'
    let denialReason: string | undefined
    let interrupt = false
    let approvalFeedback: string | undefined
    if (decision.behavior === 'ask') {
      this.emit({ type: 'state', state: 'awaiting-permission' })
      const approval = request.approveTool
        ? await request.approveTool(prepared, call, decision)
        : false
      if (typeof approval === 'boolean') {
        allowed = approval
      } else if (approval.behavior === 'allow') {
        allowed = true
        approvalFeedback = approval.feedback?.trim() || undefined
        if (approval.updatedPermissions?.length) {
          const updatedPermissions = [
            ...(context.permissionUpdates ?? []),
            ...approval.updatedPermissions,
          ]
          await request.onPermissionUpdates?.(approval.updatedPermissions)
          context.permissionUpdates = updatedPermissions
        }
        if (approval.updatedInput) {
          try {
            prepared = await tools.prepare(
              { ...call, input: approval.updatedInput },
              context,
            )
          } catch (error) {
            return {
              content: error instanceof Error ? error.message : String(error),
              isError: true,
            }
          }
        }
      } else {
        allowed = false
        denialReason = approval.message
        interrupt = approval.interrupt === true
      }
    }
    if (!allowed) {
      if (interrupt) {
        throw new Error(denialReason ?? 'Permission prompt interrupted')
      }
      const reason =
        denialReason ??
        (decision.behavior === 'deny'
          ? decision.reason
          : decision.behavior === 'ask'
            ? (decision.reason ?? 'Permission approval was not provided')
            : 'Permission approval was not provided')
      return { content: reason, isError: true }
    }
    if (request.signal?.aborted) return this.cancel()

    this.emit({ type: 'state', state: 'executing-tools' })
    context.permissionPhase = 'execute'
    context.permissionApproved = true
    const toolStartedAt = performance.now()
    try {
      const result = await tools.execute(prepared, context)
      const durationToolMs = Math.max(0, performance.now() - toolStartedAt)
      const measuredResult = { ...result, durationToolMs }
      if (!approvalFeedback) return measuredResult
      return {
        ...measuredResult,
        followUpUserMessages: [
          ...(result.followUpUserMessages ?? []),
          approvalFeedback,
        ],
      }
    } catch (error) {
      if (request.signal?.aborted) return this.cancel()
      const durationToolMs = Math.max(0, performance.now() - toolStartedAt)
      return {
        content: error instanceof Error ? error.message : String(error),
        isError: true,
        durationToolMs,
      }
    }
  }

  private async requireRecoveryApproval(
    call: ModelToolCall,
    request: AgentToolRecoveryRequest,
  ): Promise<void> {
    if (request.signal?.aborted) return this.cancel()
    if (request.approveRecovery && !(await request.approveRecovery(call))) {
      throw new Error(`Tool call ${call.id} recovery was declined`)
    }
    if (request.signal?.aborted) return this.cancel()
  }

  private cancel(): never {
    this.emit({ type: 'state', state: 'cancelled' })
    throw new AgentRunCancelledError()
  }
}
