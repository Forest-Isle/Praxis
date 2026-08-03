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
      isError: boolean
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
}

export type ModelStreamEvent =
  | { type: 'text-delta'; delta: string }
  | { type: 'tool-call'; call: ModelToolCall }
  | { type: 'usage'; usage: ModelUsage }

export interface ModelRequest {
  messages: readonly ModelMessage[]
  tools?: readonly ModelToolDefinition[]
  signal?: AbortSignal
}

export interface ModelProviderCapabilities {
  streaming: boolean
  usage: boolean
  tools: boolean
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
  isError: boolean
  accessedPaths?: readonly string[]
  followUpUserMessages?: readonly string[]
}

export interface ToolExecutionContext {
  cwd: string
  signal?: AbortSignal
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

export type PermissionDecision =
  | { behavior: 'allow' }
  | { behavior: 'ask'; reason?: string }
  | { behavior: 'deny'; reason: string }

export interface PermissionResolver {
  resolve(call: ModelToolCall): PermissionDecision | Promise<PermissionDecision>
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
}

export interface AgentRunRequest {
  messages: readonly ModelMessage[]
  cwd?: string
  observer?: AgentRunObserver
  reloadMessages?: () => Promise<readonly ModelMessage[]>
  approveTool?: (call: ModelToolCall) => boolean | Promise<boolean>
  onStop?: (text: string) => Promise<readonly string[]>
  signal?: AbortSignal
}

export type AgentToolRecoveryRequest = Pick<
  AgentRunRequest,
  'approveTool' | 'cwd' | 'observer' | 'signal'
>

export interface AgentRunResult {
  text: string
  usage: ModelUsage
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

function addUsage(left: ModelUsage, right: ModelUsage): ModelUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
  }
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
    const definitions = this.provider.capabilities.tools
      ? (this.options.tools?.definitions() ?? [])
      : []
    const maxModelTurns = this.options.maxModelTurns ?? 16
    const maxModelOutputBytes = this.options.maxModelOutputBytes ?? 1024 * 1024
    const maxToolCallsPerTurn = this.options.maxToolCallsPerTurn ?? 32
    const maxToolInputBytes = this.options.maxToolInputBytes ?? 1024 * 1024

    try {
      for (let turn = 0; turn < maxModelTurns; turn += 1) {
        this.emit({ type: 'state', state: 'awaiting-model' })
        const providerRequest: ModelRequest = { messages: [...messages] }
        if (definitions.length > 0) providerRequest.tools = definitions
        if (request.signal) providerRequest.signal = request.signal

        let text = ''
        let textBytes = 0
        let turnUsage = emptyUsage()
        let streaming = false
        const toolCalls: ModelToolCall[] = []

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
              throw new Error(`Tool input exceeded ${maxToolInputBytes} bytes`)
            }
            toolCalls.push(event.call)
            this.emit(event)
          } else {
            turnUsage = event.usage
            this.emit(event)
          }
        }

        if (!streaming) this.emit({ type: 'state', state: 'streaming' })
        usage = addUsage(usage, turnUsage)
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
          const stopMessages = (await request.onStop?.(text)) ?? []
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
          return { text, usage }
        }

        const followUpUserMessages: string[] = []
        for (const call of toolCalls) {
          const result = await this.completeToolCall(call, request)
          messages.push({
            role: 'tool',
            toolCallId: call.id,
            content: result.content,
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
  ): Promise<ToolExecutionResult> {
    const result = await this.executeTool(call, request)
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
  ): Promise<ToolExecutionResult> {
    const tools = this.options.tools
    const permissions = this.options.permissions
    if (!tools || !permissions) {
      return {
        content: `Tool ${call.name} is unavailable`,
        isError: true,
      }
    }

    const context: ToolExecutionContext = { cwd: request.cwd ?? '' }
    if (request.signal) context.signal = request.signal

    let prepared: ModelToolCall
    try {
      prepared = await tools.prepare(call, context)
    } catch (error) {
      return {
        content: error instanceof Error ? error.message : String(error),
        isError: true,
      }
    }
    if (request.signal?.aborted) return this.cancel()

    const decision = await permissions.resolve(prepared)
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

  private cancel(): never {
    this.emit({ type: 'state', state: 'cancelled' })
    throw new AgentRunCancelledError()
  }
}
