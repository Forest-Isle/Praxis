export type RuntimeState =
  | 'idle'
  | 'assembling-context'
  | 'awaiting-model'
  | 'streaming'
  | 'completed'
  | 'cancelled'
  | 'failed'

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ModelUsage {
  inputTokens: number
  outputTokens: number
}

export type ModelStreamEvent =
  { type: 'text-delta'; delta: string } | { type: 'usage'; usage: ModelUsage }

export interface ModelRequest {
  messages: readonly ModelMessage[]
  signal?: AbortSignal
}

export interface ModelProviderCapabilities {
  streaming: boolean
  usage: boolean
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
  | { type: 'failed'; message: string; retryable: boolean }

export interface AgentRunRequest {
  messages: readonly ModelMessage[]
  signal?: AbortSignal
}

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

export class AgentRuntime {
  constructor(
    private readonly provider: ModelProvider,
    private readonly emit: RuntimeEventSink = () => undefined,
  ) {}

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    this.emit({ type: 'state', state: 'assembling-context' })
    if (request.signal?.aborted) return this.cancel()

    this.emit({ type: 'state', state: 'awaiting-model' })
    let text = ''
    let usage = emptyUsage()
    let streaming = false

    try {
      const providerRequest: ModelRequest = { messages: request.messages }
      if (request.signal) providerRequest.signal = request.signal

      for await (const event of this.provider.complete(providerRequest)) {
        if (request.signal?.aborted) return this.cancel()
        if (!streaming) {
          streaming = true
          this.emit({ type: 'state', state: 'streaming' })
        }
        if (event.type === 'text-delta') {
          text += event.delta
          this.emit(event)
        } else {
          usage = event.usage
          this.emit(event)
        }
      }
    } catch (error) {
      if (request.signal?.aborted) return this.cancel()
      const message = error instanceof Error ? error.message : String(error)
      const retryable =
        error instanceof ModelProviderError ? error.retryable : false
      this.emit({ type: 'failed', message, retryable })
      throw error
    }

    if (!streaming) this.emit({ type: 'state', state: 'streaming' })
    this.emit({ type: 'state', state: 'completed' })
    return { text, usage }
  }

  private cancel(): never {
    this.emit({ type: 'state', state: 'cancelled' })
    throw new AgentRunCancelledError()
  }
}
