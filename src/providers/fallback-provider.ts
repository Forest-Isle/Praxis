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

async function waitForRetry(
  delayMs: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  throwIfAborted(signal)
  if (delayMs <= 0) return
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (result: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      result()
    }
    const onAbort = (): void =>
      finish(() => reject(cancellationError(signal as AbortSignal)))
    const timer = setTimeout(() => finish(resolve), delayMs)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
}

export interface FallbackModelProviderOptions {
  providers: readonly ModelProvider[]
  retryDelayMs?: number
  routeScope?: 'completion' | 'turn'
}

/** Routes each complete request through Claude's retry-then-fallback policy. */
export class FallbackModelProvider implements ModelProvider {
  private active: ModelProvider
  private readonly retryDelayMs: number
  private readonly configuredProviders: readonly ModelProvider[]
  private readonly routeScope: 'completion' | 'turn'
  private currentProviderIndex = 0
  private routeSealed = false

  constructor(options: FallbackModelProviderOptions) {
    if (options.providers.length === 0) {
      throw new Error('Fallback provider requires at least one provider')
    }
    this.active = options.providers[0] as ModelProvider
    this.configuredProviders = options.providers
    this.retryDelayMs = options.retryDelayMs ?? 500
    this.routeScope = options.routeScope ?? 'turn'
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
    for (const [providerIndex, provider] of this.providers()) {
      if (providerIndex > 0) validateCapabilities(provider, request)
      for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_MODEL; attempt += 1) {
        throwIfAborted(request.signal)
        this.currentProviderIndex = providerIndex
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
          this.currentProviderIndex = providerIndex
          this.active = provider
          this.routeSealed = this.routeScope === 'turn'
          yield {
            type: 'api-attempt-duration',
            durationMs:
              attemptDurationMs ??
              Math.max(0, performance.now() - attemptStartedAt),
          }
          yield* events
          return
        } catch (error) {
          throwIfAborted(request.signal)
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
            await waitForRetry(delay, request.signal)
          }
        }
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(String(lastError ?? 'All model providers failed'))
  }

  private providers(): readonly (readonly [number, ModelProvider])[] {
    if (this.routeSealed) {
      const provider = this.configuredProviders[this.currentProviderIndex]
      return provider === undefined
        ? []
        : [[this.currentProviderIndex, provider]]
    }
    return this.configuredProviders.map(
      (provider, index) => [index, provider] as const,
    )
  }
}

function validateCapabilities(
  provider: ModelProvider,
  request: ModelRequest,
): void {
  const capabilities = provider.capabilities
  if (!capabilities.streaming) {
    throw capabilityError(provider, 'streaming')
  }
  if (
    request.tools !== undefined &&
    request.tools.length > 0 &&
    !capabilities.tools
  ) {
    throw capabilityError(provider, 'tools')
  }
  const hasImages = request.messages.some(
    (message) =>
      ('images' in message &&
        message.images !== undefined &&
        message.images.length > 0) ||
      ('contentBlocks' in message &&
        message.contentBlocks?.some((block) => block.type === 'image') ===
          true),
  )
  if (hasImages && !capabilities.images)
    throw capabilityError(provider, 'images')
  const hasDocuments = request.messages.some(
    (message) =>
      ('documents' in message &&
        message.documents !== undefined &&
        message.documents.length > 0) ||
      ('contentBlocks' in message &&
        message.contentBlocks?.some((block) => block.type === 'document') ===
          true),
  )
  if (hasDocuments && !capabilities.documents)
    throw capabilityError(provider, 'documents')
  if (request.webSearch !== undefined && !capabilities.webSearch) {
    throw capabilityError(provider, 'webSearch')
  }
  const thinking = request.thinking
  if (thinking?.maxTokens !== undefined && !capabilities.thinking?.maxTokens) {
    throw capabilityError(provider, 'thinking maxTokens')
  }
  if (thinking !== undefined) {
    if (!capabilities.thinking?.modes.includes(thinking.mode)) {
      throw capabilityError(provider, `thinking mode ${thinking.mode}`)
    }
  }
}

function capabilityError(
  provider: ModelProvider,
  capability: string,
): ModelProviderError {
  return new ModelProviderError(
    `Provider ${provider.model ?? 'unknown'} does not support ${capability}`,
    { kind: 'invalid_request', retryable: false },
  )
}
