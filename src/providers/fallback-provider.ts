import {
  ModelProviderError,
  type ModelProvider,
  type ModelStreamEvent,
  type ModelRequest,
} from '../core/runtime.js'

const MAX_ATTEMPTS_PER_MODEL = 3
const RETRY_DELAYS_MS = [500, 1_000] as const

function retryable(error: unknown): boolean {
  return error instanceof ModelProviderError && error.retryable
}

export interface FallbackModelProviderOptions {
  providers: readonly ModelProvider[]
  retryDelayMs?: number
}

/** Routes each complete request through Claude's retry-then-fallback policy. */
export class FallbackModelProvider implements ModelProvider {
  readonly capabilities: ModelProvider['capabilities']
  private active: ModelProvider
  private readonly retryDelayMs: number
  private readonly fallbackProviders: readonly ModelProvider[]

  constructor(options: FallbackModelProviderOptions) {
    if (options.providers.length === 0) {
      throw new Error('Fallback provider requires at least one provider')
    }
    this.active = options.providers[0] as ModelProvider
    this.fallbackProviders = options.providers
    this.capabilities = this.active.capabilities
    this.retryDelayMs = options.retryDelayMs ?? 500
  }

  get model(): string {
    return this.active.model ?? 'praxis/provider'
  }

  async *complete(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    let lastError: unknown
    for (const provider of this.providers()) {
      for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_MODEL; attempt += 1) {
        this.active = provider
        try {
          // Buffer each attempt so a stream that fails after partial output
          // cannot duplicate text/tool events when retried.
          const events: ModelStreamEvent[] = []
          for await (const event of provider.complete(request))
            events.push(event)
          yield* events
          return
        } catch (error) {
          lastError = error
          if (!retryable(error)) throw error
          if (attempt + 1 < MAX_ATTEMPTS_PER_MODEL) {
            const retryMultiplier = RETRY_DELAYS_MS[attempt] ?? 500
            const delay = this.retryDelayMs * (retryMultiplier / 500)
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
