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
  | { role: 'system' | 'user'; content: string }
  | {
      role: 'assistant'
      content: string
      toolCalls?: readonly ModelToolCall[]
    }
  | {
      role: 'tool'
      toolCallId: string
      content: string
      images?: readonly ModelImage[]
      isError: boolean
    }

export type ModelImageMediaType =
  'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'

export interface ModelImage {
  type: 'image'
  mediaType: ModelImageMediaType
  data: string
}

export interface ModelToolCall {
  id: string
  name: string
  input: Record<string, unknown>
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
  | { type: 'tool-call'; call: ModelToolCall }
  | { type: 'usage'; usage: ModelUsage }

export interface ModelRequest {
  messages: readonly ModelMessage[]
  tools?: readonly ModelToolDefinition[]
  webSearch?: ModelWebSearch
  signal?: AbortSignal
  effort?: string
}

export interface ModelProviderCapabilities {
  streaming: boolean
  usage: boolean
  tools: boolean
  images?: boolean
  webSearch?: boolean
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
  | { type: 'usage'; usage: ModelUsage }
  | { type: 'tool-call'; call: ModelToolCall }
  | {
      type: 'permission-decision'
      callId: string
      behavior: PermissionBehavior
    }
  | {
      type: 'tool-result'
      callId: string
      content: string
      isError: boolean
    }
  | { type: 'warning'; message: string }
  | { type: 'failed'; message: string; retryable: boolean }

export interface ToolExecutionResult {
  content: string
  images?: readonly ModelImage[]
  isError: boolean
  usage?: ModelUsage
  accessedPaths?: readonly string[]
  followUpUserMessages?: readonly string[]
  nativeToolUseResult?: Record<string, unknown>
  durationApiMs?: number
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

export interface PermissionResolutionContext {
  cwd: string
  messages?: readonly ModelMessage[]
  signal?: AbortSignal
}

export type PermissionDecision =
  | { behavior: 'allow' }
  | { behavior: 'ask'; reason?: string }
  | { behavior: 'deny'; reason: string }

export interface PermissionResolver {
  resolve(
    call: ModelToolCall,
    context?: PermissionResolutionContext,
  ): PermissionDecision | Promise<PermissionDecision>
}

export interface AgentRunObserver {
  assistantCompleted(message: {
    content: string
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
}

export interface AgentRunRequest {
  messages: readonly ModelMessage[]
  cwd?: string
  toolResultDirectory?: string
  observer?: AgentRunObserver
  reloadMessages?: () => Promise<readonly ModelMessage[]>
  approveTool?: (call: ModelToolCall) => boolean | Promise<boolean>
  onStop?: (
    text: string,
  ) => Promise<
    readonly string[] | { messages: readonly string[]; usage?: ModelUsage }
  >
  signal?: AbortSignal
  effort?: string
  collectMetrics?: boolean
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

  constructor(
    message: string,
    options: { retryable: boolean; status?: number; cause?: unknown },
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    )
    this.retryable = options.retryable
    if (options.status !== undefined) this.status = options.status
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
const unsupportedImageResult = 'Provider does not support image tool results'

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
): ModelMessage[] {
  if (supportsImages) return [...messages]
  return messages.map((message) =>
    message.role === 'tool' && message.images?.length
      ? {
          role: 'tool',
          toolCallId: message.toolCallId,
          content: unsupportedImageResult,
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
    const maxModelTurns = this.options.maxModelTurns ?? 16
    const maxModelOutputBytes = this.options.maxModelOutputBytes ?? 1024 * 1024
    const maxToolCallsPerTurn = this.options.maxToolCallsPerTurn ?? 32
    const maxToolInputBytes = this.options.maxToolInputBytes ?? 1024 * 1024

    try {
      for (let turn = 0; turn < maxModelTurns; turn += 1) {
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
          ),
        }
        if (definitions.length > 0) providerRequest.tools = definitions
        if (request.signal) providerRequest.signal = request.signal
        if (request.effort) providerRequest.effort = request.effort

        let text = ''
        let textBytes = 0
        let turnUsage = emptyUsage()
        let streaming = false
        const toolCalls: ModelToolCall[] = []

        const apiStartedAt = request.collectMetrics ? performance.now() : 0
        try {
          for await (const event of this.provider.complete(providerRequest)) {
            if (request.signal?.aborted) return this.cancel()
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
            ? { role: 'assistant' as const, content: text }
            : {
                role: 'assistant' as const,
                content: text,
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
        for (const call of toolCalls) {
          const result = await this.completeToolCall(call, request, messages)
          if (result.usage) usage = addUsage(usage, result.usage)
          durationApiMs += result.durationApiMs ?? 0
          messages.push({
            role: 'tool',
            toolCallId: call.id,
            content: result.content,
            ...(result.images ? { images: result.images } : {}),
            isError: result.isError,
          })
          followUpUserMessages.push(...(result.followUpUserMessages ?? []))
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

  private async completeToolCall(
    call: ModelToolCall,
    request: AgentToolRecoveryRequest,
    messages: readonly ModelMessage[] = request.messages ?? [],
  ): Promise<ToolExecutionResult> {
    const executed = await this.executeTool(call, request, messages)
    const result =
      executed.images?.length && this.provider.capabilities.images !== true
        ? {
            content: unsupportedImageResult,
            isError: true,
            ...(executed.usage ? { usage: executed.usage } : {}),
          }
        : executed
    this.emit({ type: 'state', state: 'persisting-results' })
    await request.observer?.toolCompleted(call, result)
    this.emit({
      type: 'tool-result',
      callId: call.id,
      content: result.content,
      isError: result.isError,
    })
    return result
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
    this.emit({
      type: 'permission-decision',
      callId: call.id,
      behavior: decision.behavior,
    })
    let allowed = decision.behavior === 'allow'
    if (decision.behavior === 'ask') {
      this.emit({ type: 'state', state: 'awaiting-permission' })
      allowed = request.approveTool
        ? await request.approveTool(prepared)
        : false
    }
    if (!allowed) {
      const reason =
        decision.behavior === 'deny'
          ? decision.reason
          : decision.behavior === 'ask'
            ? (decision.reason ?? 'Permission approval was not provided')
            : 'Permission approval was not provided'
      return { content: reason, isError: true }
    }
    if (request.signal?.aborted) return this.cancel()

    this.emit({ type: 'state', state: 'executing-tools' })
    try {
      return await tools.execute(prepared, context)
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
