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
}

export interface ModelWebSearch {
  allowedDomains?: readonly string[]
  blockedDomains?: readonly string[]
  maxUses: number
}

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
  | {
      type: 'api-retry'
      attempt: number
      maxRetries: number
      retryDelayMs: number
      errorStatus: number | null
      error: ProviderErrorKind
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
  usage?: ModelUsage
  accessedPaths?: readonly string[]
  followUpUserMessages?: readonly string[]
  nativeToolUseResult?: Record<string, unknown>
  nativeMcpMeta?: Record<string, unknown>
  durationApiMs?: number
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

export type PermissionApproval =
  | boolean
  | {
      behavior: 'allow'
      updatedInput?: Record<string, unknown>
      feedback?: string
    }
  | { behavior: 'deny'; message: string; interrupt?: boolean }

export interface PermissionResolutionContext {
  cwd: string
  messages?: readonly ModelMessage[]
  signal?: AbortSignal
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
  }) => Promise<string | null>
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
  onStop?: (
    text: string,
  ) => Promise<
    readonly string[] | { messages: readonly string[]; usage?: ModelUsage }
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
  'approveTool' | 'cwd' | 'observer' | 'signal' | 'toolResultDirectory'
> {
  approveRecovery?: (call: ModelToolCall) => boolean | Promise<boolean>
  messages?: readonly ModelMessage[]
}

export interface AgentRunResult {
  text: string
  usage: ModelUsage
  durationApiMs?: number
}

export class ModelProviderError extends Error {
  override readonly name = 'ModelProviderError'
  readonly retryable: boolean
  readonly status?: number
  readonly retryDelayMs?: number

  constructor(
    message: string,
    options: {
      retryable: boolean
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
  | 'unknown'
  | 'max_output_tokens'

export function modelProviderErrorKind(
  error: ModelProviderError,
): ProviderErrorKind {
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
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    ...(cacheReadInputTokens === 0 ? {} : { cacheReadInputTokens }),
    ...(cacheCreationInputTokens === 0 ? {} : { cacheCreationInputTokens }),
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
    let durationApiMs = 0
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
          promise: Promise<string | null>
          precedingToolUseIds: readonly string[]
        }
      | undefined

    try {
      for (let turn = 0; turn < maxModelTurns; turn += 1) {
        if (pendingToolUseSummary) {
          const summaryRequest = pendingToolUseSummary
          pendingToolUseSummary = undefined
          try {
            const summary = await summaryRequest.promise
            if (summary) {
              this.emit({
                type: 'tool-use-summary',
                summary,
                precedingToolUseIds: summaryRequest.precedingToolUseIds,
              })
            }
          } catch {
            // Summaries are auxiliary SDK output and never fail the turn.
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

        const apiStartedAt = request.collectMetrics ? performance.now() : 0
        try {
          for await (const event of this.provider.complete(providerRequest)) {
            if (request.signal?.aborted) return this.cancel()
            if (event.type === 'api-retry') {
              this.emit(event)
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
            } else {
              turnUsage = event.usage
              this.emit(event)
            }
          }
        } finally {
          if (request.collectMetrics) {
            durationApiMs += Math.max(0, performance.now() - apiStartedAt)
          }
        }

        if (!streaming) this.emit({ type: 'state', state: 'streaming' })
        usage = addUsage(usage, turnUsage)
        modelUsage = addUsage(modelUsage, turnUsage)
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
              })
          const stopMessages: readonly string[] = stopBatch
            ? stopBatch.messages
            : (stopResult as readonly string[])
          if (stopBatch?.usage) {
            usage = addUsage(usage, stopBatch.usage)
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
          return {
            text,
            usage,
            ...(durationApiMs === 0 ? {} : { durationApiMs }),
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
          durationApiMs += result.durationApiMs ?? 0
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

    const context: ToolExecutionContext = { cwd: request.cwd ?? '', messages }
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
    try {
      const result = await tools.execute(prepared, context)
      if (!approvalFeedback) return result
      return {
        ...result,
        followUpUserMessages: [
          ...(result.followUpUserMessages ?? []),
          approvalFeedback,
        ],
      }
    } catch (error) {
      if (request.signal?.aborted) return this.cancel()
      return {
        content: error instanceof Error ? error.message : String(error),
        isError: true,
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
