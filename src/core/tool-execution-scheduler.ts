import type { ModelToolCall, ToolSchedulingPolicy } from './runtime.js'

interface ScheduledToolResult<TResult> {
  call: ModelToolCall
  result: TResult
}

interface ToolExecutionSchedulerOptions<TResult> {
  parentSignal?: AbortSignal
  execute(call: ModelToolCall, signal: AbortSignal): Promise<TResult>
  isError(result: TResult): boolean
  cancelledResult(call: ModelToolCall, reason: unknown): TResult
  failedResult(call: ModelToolCall, reason: unknown): TResult
  resultCompleted(call: ModelToolCall, result: TResult): void
}

const settled = Promise.resolve()

export class ToolExecutionScheduler<TResult> {
  private readonly groupController = new AbortController()
  private readonly exclusiveStart: Promise<void>
  private releaseExclusiveStart!: () => void
  private exclusiveStarted = false
  private hasFailure = false
  private firstFailure: unknown
  private readonly scheduled: Promise<void>[] = []
  private readonly completionOrder: ScheduledToolResult<TResult>[] = []
  private precedingBarrier: Promise<void> = settled
  private concurrentGroup: Promise<void>[] = []

  constructor(
    private readonly options: ToolExecutionSchedulerOptions<TResult>,
  ) {
    this.exclusiveStart = new Promise((resolve) => {
      this.releaseExclusiveStart = resolve
    })
  }

  schedule(call: ModelToolCall, policy: ToolSchedulingPolicy): void {
    const predecessors =
      policy.concurrency === 'exclusive'
        ? Promise.allSettled([
            ...(policy.startAfterAssistant ? [this.exclusiveStart] : []),
            this.precedingBarrier,
            ...this.concurrentGroup,
          ]).then(() => undefined)
        : this.precedingBarrier
    const signal = this.executionSignal(policy)
    const execution = predecessors.then(async () => {
      let result: TResult
      try {
        if (signal.aborted) throw signal.reason
        result = await this.options.execute(call, signal)
        if (signal.aborted) throw signal.reason
      } catch (error) {
        if (signal.aborted) {
          result = this.options.cancelledResult(call, error)
        } else {
          if (!this.hasFailure) {
            this.hasFailure = true
            this.firstFailure = error
          }
          result = this.options.failedResult(call, error)
        }
      }
      this.record(call, result)
      if (policy.abortGroupOnError && this.options.isError(result)) {
        this.groupController.abort(
          new Error(`Tool ${call.name} failed; cancelling streamed siblings`),
        )
      }
    })
    this.scheduled.push(execution)
    if (policy.concurrency === 'exclusive') {
      this.precedingBarrier = execution.catch(() => undefined)
      this.concurrentGroup = []
    } else {
      this.concurrentGroup.push(execution.catch(() => undefined))
    }
  }

  abort(reason?: unknown): void {
    this.releaseExclusiveTools()
    this.groupController.abort(reason)
  }

  releaseExclusiveTools(): void {
    if (this.exclusiveStarted) return
    this.exclusiveStarted = true
    this.releaseExclusiveStart()
  }

  async settle(): Promise<readonly ScheduledToolResult<TResult>[]> {
    await Promise.all(this.scheduled)
    return this.completionOrder
  }

  get failure(): { error: unknown } | undefined {
    return this.hasFailure ? { error: this.firstFailure } : undefined
  }

  private record(call: ModelToolCall, result: TResult): void {
    this.completionOrder.push({ call, result })
    this.options.resultCompleted(call, result)
  }

  private executionSignal(policy: ToolSchedulingPolicy): AbortSignal {
    const signals = [this.groupController.signal]
    if (policy.cancelOnInterrupt && this.options.parentSignal) {
      signals.push(this.options.parentSignal)
    }
    return signals.length === 1
      ? this.groupController.signal
      : AbortSignal.any(signals)
  }
}
