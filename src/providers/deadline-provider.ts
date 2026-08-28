import {
  ModelProviderError,
  type ModelProvider,
  type ModelRequest,
  type ModelStreamEvent,
} from '../core/runtime.js'

export const DEFAULT_PROVIDER_DEADLINE_MS = 90_000

export interface DeadlineModelProviderOptions {
  provider: ModelProvider
  deadlineMs?: number
}

type InterruptionKind = 'cancelled' | 'timeout' | 'return'
type Interruption = { kind: InterruptionKind; cause: unknown }
type ProviderIteratorResult = IteratorResult<ModelStreamEvent>

const MAX_TIMER_DELAY_MS = 2_147_483_647

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve
  })
  return { promise, resolve }
}

/** Bounds each streamed completion while preserving the wrapped provider's API. */
export class DeadlineModelProvider implements ModelProvider {
  private readonly provider: ModelProvider
  private readonly deadlineMs: number
  declare readonly model?: string

  constructor(options: DeadlineModelProviderOptions) {
    const deadlineMs =
      options.deadlineMs === undefined
        ? DEFAULT_PROVIDER_DEADLINE_MS
        : options.deadlineMs
    if (
      !Number.isFinite(deadlineMs) ||
      !Number.isInteger(deadlineMs) ||
      deadlineMs <= 0
    ) {
      throw new Error('Provider deadline must be a positive integer')
    }
    this.provider = options.provider
    this.deadlineMs = deadlineMs
    Object.defineProperty(this, 'model', {
      configurable: false,
      enumerable: true,
      get: () => this.provider.model,
    })
  }

  get capabilities(): ModelProvider['capabilities'] {
    return this.provider.capabilities
  }

  complete(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    let started = false
    let closed = false
    let interruption: Interruption | undefined
    let controller: AbortController | undefined
    let callerSignal: AbortSignal | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let deadlineStartedAt: number | undefined
    let underlying: AsyncIterator<ModelStreamEvent> | undefined
    let cleanupStarted = false
    const interruptionDeferred = deferred<Interruption>()

    const interruptionError = (): ModelProviderError => {
      if (interruption?.kind === 'timeout') {
        return new ModelProviderError('Provider request timed out', {
          kind: 'timeout',
          retryable: true,
          cause: interruption.cause,
        })
      }
      return new ModelProviderError('Provider request cancelled', {
        kind: 'cancelled',
        retryable: false,
        cause: interruption?.cause,
      })
    }

    const bestEffortUnderlyingReturn = (): void => {
      const iterator = underlying
      if (!iterator || cleanupStarted) return
      cleanupStarted = true
      let returnMethod: AsyncIterator<ModelStreamEvent>['return']
      try {
        returnMethod = iterator.return
      } catch {
        return
      }
      if (!returnMethod) return
      try {
        const result = returnMethod.call(iterator)
        if (result && typeof result.then === 'function') {
          void Promise.resolve(result).catch(() => undefined)
        }
      } catch {
        // Cleanup is best effort; preserve the original completion outcome.
      }
    }

    const clearResources = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      callerSignal?.removeEventListener('abort', onCallerAbort)
    }

    const finish = (outcome: Interruption): void => {
      if (interruption !== undefined) return
      interruption = outcome
      closed = true
      interruptionDeferred.resolve(outcome)
      controller?.abort(outcome.cause)
      clearResources()
      if (outcome.kind !== 'return') bestEffortUnderlyingReturn()
    }

    const onCallerAbort = (): void =>
      finish({ kind: 'cancelled', cause: callerSignal?.reason })

    const timeoutCause = new Error('Provider request timed out')
    timeoutCause.name = 'TimeoutError'
    const scheduleDeadline = (): void => {
      if (deadlineStartedAt === undefined || closed) return
      const elapsedMs = Math.max(0, performance.now() - deadlineStartedAt)
      const remainingMs = this.deadlineMs - elapsedMs
      if (remainingMs <= 0) {
        finish({ kind: 'timeout', cause: timeoutCause })
        return
      }
      timer = setTimeout(
        scheduleDeadline,
        Math.min(remainingMs, MAX_TIMER_DELAY_MS),
      )
    }

    const start = (): void => {
      if (started || closed) return
      started = true
      controller = new AbortController()
      callerSignal = request.signal
      if (callerSignal?.aborted) onCallerAbort()
      else
        callerSignal?.addEventListener('abort', onCallerAbort, { once: true })
      if (interruption !== undefined) return
      deadlineStartedAt = performance.now()
      scheduleDeadline()

      const iterable = this.provider.complete({
        ...request,
        signal: controller.signal,
      })
      underlying = iterable[Symbol.asyncIterator]()
      if (interruption !== undefined) bestEffortUnderlyingReturn()
    }

    const next = async (): Promise<ProviderIteratorResult> => {
      try {
        start()
      } catch (error) {
        if (interruption !== undefined) throw interruptionError()
        closed = true
        clearResources()
        bestEffortUnderlyingReturn()
        throw error
      }
      if (interruption?.kind === 'return')
        return { done: true, value: undefined }
      if (interruption !== undefined) throw interruptionError()
      if (closed || !underlying) return { done: true, value: undefined }

      let nextPromise: Promise<ProviderIteratorResult>
      try {
        const result = underlying.next()
        nextPromise = Promise.resolve(result)
      } catch (error) {
        if (interruption !== undefined) throw interruptionError()
        closed = true
        clearResources()
        bestEffortUnderlyingReturn()
        throw error
      }

      if (interruption !== undefined) {
        void nextPromise.catch(() => undefined)
        throw interruptionError()
      }

      const result = await Promise.race([
        nextPromise.then(
          (value) => ({ type: 'result' as const, value }),
          (error: unknown) => ({ type: 'error' as const, error }),
        ),
        interruptionDeferred.promise.then((outcome) => ({
          type: 'interruption' as const,
          outcome,
        })),
      ])
      const observedInterruption =
        interruption ??
        (result.type === 'interruption' ? result.outcome : undefined)
      if (observedInterruption !== undefined) {
        if (result.type === 'result') void nextPromise.catch(() => undefined)
        if (observedInterruption.kind === 'return')
          return { done: true, value: undefined }
        throw interruptionError()
      }
      if (result.type === 'error') {
        closed = true
        clearResources()
        bestEffortUnderlyingReturn()
        throw result.error
      }
      if (result.type === 'interruption') {
        if (result.outcome.kind === 'return')
          return { done: true, value: undefined }
        throw interruptionError()
      }
      if (result.value.done) {
        closed = true
        clearResources()
      }
      return result.value
    }

    const returnFromConsumer = async (): Promise<ProviderIteratorResult> => {
      if (!started) {
        closed = true
        return { done: true, value: undefined }
      }
      if (!closed) {
        finish({ kind: 'return', cause: undefined })
        bestEffortUnderlyingReturn()
      }
      return { done: true, value: undefined }
    }

    const result: AsyncIterable<ModelStreamEvent> &
      AsyncIterator<ModelStreamEvent> = {
      [Symbol.asyncIterator]() {
        return result
      },
      next,
      return: returnFromConsumer,
    }
    return result
  }
}
