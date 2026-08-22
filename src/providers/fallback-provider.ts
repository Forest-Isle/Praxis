import {
  modelProviderErrorKind,
  ModelProviderError,
  type ModelProvider,
  type ModelStreamEvent,
  type ModelRequest,
} from '../core/runtime.js'

const MAX_ATTEMPTS_PER_MODEL = 3
const RETRY_DELAYS_MS = [500, 1_000] as const

function retryable(error: unknown): boolean {
  return (
    error instanceof ModelProviderError &&
    error.retryable &&
    modelProviderErrorKind(error) !== 'prompt_too_long'
  )
}

export interface FallbackModelProviderOptions {
  providers: readonly ModelProvider[]
  retryDelayMs?: number
}

/** Routes each complete request through Claude's retry-then-fallback policy. */
export class FallbackModelProvider implements ModelProvider {
  private active: ModelProvider
  private readonly retryDelayMs: number
  private readonly fallbackProviders: readonly ModelProvider[]

  constructor(options: FallbackModelProviderOptions) {
    if (options.providers.length === 0) {
      throw new Error('Fallback provider requires at least one provider')
    }
    this.active = options.providers[0] as ModelProvider
    this.fallbackProviders = options.providers
    this.retryDelayMs = options.retryDelayMs ?? 500
  }

  /** Capabilities of the currently active provider after any fallback routing. */
  get capabilities(): ModelProvider['capabilities'] {
    return this.active.capabilities
  }

  get model(): string {
    return this.active.model ?? 'praxis/provider'
  }

  async *complete(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    let lastError: unknown
    for (const provider of this.providers()) {
      for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_MODEL; attempt += 1) {
        this.active = provider
        const attemptStartedAt = performance.now()
        try {
          // Buffer each attempt so a stream that fails after partial output
          // cannot duplicate text/tool events when retried.
          const events: ModelStreamEvent[] = []
          let attemptDurationMs: number | undefined
          let terminalSeen = false
          for await (const event of provider.complete(request)) {
            if (terminalSeen) {
              throw new ModelProviderError(
                `Provider emitted ${event.type} after its terminal event`,
                { retryable: false },
              )
            }
            if (event.type === 'api-attempt-duration') {
              // Consume the underlying attempt timing rather than replaying it
              // so nested wrappers report a single retry-free duration.
              if (attemptDurationMs !== undefined) {
                throw new Error(
                  'Provider emitted multiple api-attempt-duration events in one attempt',
                )
              }
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
              attemptDurationMs = durationMs
              continue
            }
            if (event.type === 'terminal') terminalSeen = true
            events.push(event)
          }
          if (provider.capabilities.terminalReasons === true && !terminalSeen) {
            throw new ModelProviderError(
              'Provider stream ended without a terminal reason',
              { retryable: true },
            )
          }
          yield {
            type: 'api-attempt-duration',
            durationMs:
              attemptDurationMs ??
              Math.max(0, performance.now() - attemptStartedAt),
          }
          yield* events
          return
        } catch (error) {
          lastError = error
          if (!retryable(error)) throw error
          if (attempt + 1 < MAX_ATTEMPTS_PER_MODEL) {
            const retryMultiplier = RETRY_DELAYS_MS[attempt] ?? 500
            const delay = this.retryDelayMs * (retryMultiplier / 500)
            if (error instanceof ModelProviderError) {
              yield {
                type: 'api-retry',
                attempt: attempt + 1,
                maxRetries: MAX_ATTEMPTS_PER_MODEL - 1,
                retryDelayMs: delay,
                errorStatus: error.status ?? null,
                error: modelProviderErrorKind(error),
              }
            }
            if (delay > 0)
              await new Promise((resolve) => setTimeout(resolve, delay))
          }
        }
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(String(lastError ?? 'All model providers failed'))
  }

  private providers(): readonly ModelProvider[] {
    return this.fallbackProviders
  }
}
