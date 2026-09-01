import {
  ModelProviderError,
  type ModelProvider,
  type ModelRequest,
  type ModelStreamEvent,
  type ProviderTimeoutPhase,
} from '../core/runtime.js'
import {
  detachProviderTransportActivity,
  observeProviderTransportActivity,
  type ProviderTransportActivity,
} from './provider-transport-activity.js'

export const DEFAULT_PROVIDER_DEADLINE_MS = 90_000
export const DEFAULT_PROVIDER_CONNECT_TIMEOUT_MS = 90_000
export const DEFAULT_PROVIDER_IDLE_TIMEOUT_MS = 90_000

export interface DeadlineModelProviderOptions {
  provider: ModelProvider
  deadlineMs?: number
  connectTimeoutMs?: number
  idleTimeoutMs?: number
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
  private readonly connectTimeoutMs: number
  private readonly idleTimeoutMs: number
  private readonly connectTimeoutExplicit: boolean
  private readonly idleTimeoutExplicit: boolean
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
    const connectTimeoutMs = options.connectTimeoutMs ?? deadlineMs
    if (
      !Number.isFinite(connectTimeoutMs) ||
      !Number.isInteger(connectTimeoutMs) ||
      connectTimeoutMs <= 0
    )
      throw new Error('Provider connect timeout must be a positive integer')
    const idleTimeoutMs = options.idleTimeoutMs ?? deadlineMs
    if (
      !Number.isFinite(idleTimeoutMs) ||
      !Number.isInteger(idleTimeoutMs) ||
      idleTimeoutMs <= 0
    )
      throw new Error('Provider idle timeout must be a positive integer')
    this.provider = options.provider
    this.deadlineMs = deadlineMs
    this.connectTimeoutMs = connectTimeoutMs
    this.idleTimeoutMs = idleTimeoutMs
    this.connectTimeoutExplicit = options.connectTimeoutMs !== undefined
    this.idleTimeoutExplicit = options.idleTimeoutMs !== undefined
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
    let totalDueAt: number | undefined
    let phaseDueAt: number | undefined
    let phase: ProviderTimeoutPhase = 'connect'
    let pullPending = false
    let hasPulled = false
    let instrumentedRequest: ModelRequest | undefined
    let underlying: AsyncIterator<ModelStreamEvent> | undefined
    let cleanupStarted = false
    const interruptionDeferred = deferred<Interruption>()

    const interruptionError = (): ModelProviderError => {
      if (interruption?.kind === 'timeout') {
        const timeoutPhase =
          interruption.cause instanceof TimeoutCause
            ? interruption.cause.phase
            : undefined
        const message =
          timeoutPhase === 'connect'
            ? 'Provider connection timed out'
            : timeoutPhase === 'idle'
              ? 'Provider stream idle timed out'
              : 'Provider request timed out'
        return new ModelProviderError(message, {
          kind: 'timeout',
          retryable: true,
          cause: interruption.cause,
          ...(timeoutPhase === undefined ? {} : { timeoutPhase }),
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
      if (instrumentedRequest)
        detachProviderTransportActivity(instrumentedRequest)
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

    class TimeoutCause extends Error {
      readonly phase: ProviderTimeoutPhase
      constructor(timeoutPhase: ProviderTimeoutPhase) {
        super('Provider request timed out')
        this.name = 'TimeoutError'
        this.phase = timeoutPhase
      }
    }
    const scheduleDeadline = (): void => {
      if (deadlineStartedAt === undefined || closed) return
      if (timer !== undefined) clearTimeout(timer)
      const now = performance.now()
      const remainingTotal = (totalDueAt ?? now) - now
      const remainingPhase = pullPending
        ? (phaseDueAt ?? now) - now
        : Number.POSITIVE_INFINITY
      const remainingMs = Math.min(remainingTotal, remainingPhase)
      if (remainingMs <= 0) {
        const phaseTimeoutExplicit =
          phase === 'connect'
            ? this.connectTimeoutExplicit
            : this.idleTimeoutExplicit
        finish({
          kind: 'timeout',
          cause: new TimeoutCause(
            remainingPhase < remainingTotal ||
              (remainingPhase <= remainingTotal && phaseTimeoutExplicit)
              ? phase
              : 'total',
          ),
        })
        return
      }
      timer = setTimeout(
        scheduleDeadline,
        Math.min(remainingMs, MAX_TIMER_DELAY_MS),
      )
    }

    const onTransportActivity = (reported: ProviderTransportActivity): void => {
      if (closed || deadlineStartedAt === undefined) return
      const now = performance.now()
      if (reported === 'request-started') {
        phase = 'connect'
        phaseDueAt = now + this.connectTimeoutMs
      } else {
        phase = 'idle'
        phaseDueAt = now + this.idleTimeoutMs
      }
      scheduleDeadline()
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
      totalDueAt = deadlineStartedAt + this.deadlineMs
      phaseDueAt = deadlineStartedAt + this.connectTimeoutMs
      scheduleDeadline()

      instrumentedRequest = { ...request, signal: controller.signal }
      observeProviderTransportActivity(instrumentedRequest, onTransportActivity)
      const iterable = this.provider.complete(instrumentedRequest)
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
      pullPending = true
      if (hasPulled) {
        phaseDueAt =
          performance.now() +
          (phase === 'connect' ? this.connectTimeoutMs : this.idleTimeoutMs)
      }
      hasPulled = true
      scheduleDeadline()
      if (interruption !== undefined) throw interruptionError()
      try {
        const result = underlying.next()
        nextPromise = Promise.resolve(result)
      } catch (error) {
        pullPending = false
        scheduleDeadline()
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
      pullPending = false
      scheduleDeadline()
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
      } else {
        phase = 'idle'
        phaseDueAt = performance.now() + this.idleTimeoutMs
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
