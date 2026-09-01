import {
  ModelProviderError,
  modelProviderErrorKind,
  type ModelProvider,
  type ModelRequest,
  type ModelStreamEvent,
} from '../core/runtime.js'

const eligibleErrors = new WeakSet<object>()

/** Marks a provider error as safe for the bounded non-streaming replay. */
export function markNonStreamingFallbackEligible<T extends Error>(error: T): T {
  eligibleErrors.add(error)
  return error
}

export function isNonStreamingFallbackEligible(error: unknown): boolean {
  return (
    (typeof error === 'object' &&
      error !== null &&
      eligibleErrors.has(error)) ||
    (error instanceof ModelProviderError && error.timeoutPhase === 'idle')
  )
}

function cancellationError(signal: AbortSignal): ModelProviderError {
  return new ModelProviderError('Provider request cancelled', {
    kind: 'cancelled',
    retryable: false,
    cause: signal.reason,
  })
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw cancellationError(signal)
}

/** Replays an eligible failed streaming request through one non-streaming call. */
export class NonStreamingFallbackModelProvider implements ModelProvider {
  private readonly provider: ModelProvider
  private readonly nonStreamingProvider: ModelProvider | undefined

  constructor(options: {
    provider: ModelProvider
    nonStreamingProvider?: ModelProvider
  }) {
    this.provider = options.provider
    this.nonStreamingProvider = options.nonStreamingProvider
    Object.defineProperty(this, 'model', {
      configurable: false,
      enumerable: true,
      get: () => this.provider.model,
    })
  }

  declare readonly model?: string

  get capabilities(): ModelProvider['capabilities'] {
    return this.provider.capabilities
  }

  async *complete(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const primaryEvents: ModelStreamEvent[] = []
    let primaryTerminal = false
    try {
      for await (const event of this.provider.complete(request)) {
        if (primaryTerminal) {
          throw new ModelProviderError(
            `Provider emitted ${event.type} after its terminal event`,
            { retryable: false },
          )
        }
        if (event.type === 'terminal') primaryTerminal = true
        primaryEvents.push(event)
      }
      if (
        this.provider.capabilities.terminalReasons === true &&
        !primaryTerminal
      ) {
        throw new ModelProviderError(
          'Provider stream ended without a terminal reason',
          { retryable: true },
        )
      }
      yield* primaryEvents
      return
    } catch (error) {
      throwIfAborted(request.signal)
      if (
        !this.nonStreamingProvider ||
        !isNonStreamingFallbackEligible(error)
      ) {
        throw error
      }
      throwIfAborted(request.signal)
      if (error instanceof ModelProviderError) {
        yield {
          type: 'api-retry',
          attempt: 1,
          maxRetries: 1,
          retryDelayMs: 0,
          errorStatus: error.status ?? null,
          error: modelProviderErrorKind(error),
        }
      } else {
        // The retry event contract carries a typed provider error kind. An
        // explicitly marked non-ModelProviderError is still replayable.
        yield {
          type: 'api-retry',
          attempt: 1,
          maxRetries: 1,
          retryDelayMs: 0,
          errorStatus: null,
          error: 'server_error',
        }
      }

      const fallbackEvents: ModelStreamEvent[] = []
      let fallbackTerminal = false
      for await (const event of this.nonStreamingProvider.complete(request)) {
        if (fallbackTerminal) {
          throw new ModelProviderError(
            `Provider emitted ${event.type} after its terminal event`,
            { retryable: false },
          )
        }
        if (event.type === 'terminal') fallbackTerminal = true
        fallbackEvents.push(event)
      }
      if (
        this.nonStreamingProvider.capabilities.terminalReasons === true &&
        !fallbackTerminal
      ) {
        throw new ModelProviderError(
          'Provider stream ended without a terminal reason',
          { retryable: true },
        )
      }
      yield* fallbackEvents
    }
  }
}
