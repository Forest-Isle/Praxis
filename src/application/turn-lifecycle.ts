import {
  AgentRunCancelledError,
  ModelProviderError,
  type ModelDocument,
  type ModelImage,
  type RuntimeEventSink,
} from '../core/runtime.js'
import {
  ActiveTurnInputMailbox,
  type ActiveTurnInputCommandResult,
  type ActiveTurnInputPort,
  type SteeringItem,
} from '../core/active-turn-input.js'

export type TurnActivation =
  | { kind: 'start'; sessionId: string; name?: string }
  | {
      kind: 'resume'
      sessionId: string
      name?: string
      atMessageId?: string
    }

export type TurnSubmission =
  | {
      kind: 'prompt'
      text: string
      images?: readonly ModelImage[]
      documents?: readonly ModelDocument[]
    }
  | { kind: 'shell'; command: string }
  | { kind: 'retry'; prompt: string }

export interface TurnRequest {
  activation: TurnActivation
  submission: TurnSubmission
  signal?: AbortSignal
}

export interface TurnScope {
  readonly emit: RuntimeEventSink
  readonly signal: AbortSignal
  readonly steering?: ActiveTurnInputPort
}

export interface TurnCoordinatorOptions {
  readonly eventSink: RuntimeEventSink
  readonly createSteeringId: () => string
}

interface ActiveTurnRecord {
  readonly mailbox?: ActiveTurnInputMailbox
  readonly controller: AbortController
  readonly settled: Promise<void>
  readonly settle: () => void
  terminal: boolean
}

/** Owns the lifecycle and active-turn coordination for one session service. */
export class TurnCoordinator {
  private readonly activeTurns = new Map<string, ActiveTurnRecord>()
  private closing = false
  private closePromise: Promise<void> | undefined

  constructor(private readonly options: TurnCoordinatorOptions) {}

  async run<T>(
    request: TurnRequest,
    work: (scope: TurnScope) => Promise<T>,
  ): Promise<T> {
    const { sessionId } = request.activation
    const mailbox =
      request.submission.kind === 'shell'
        ? undefined
        : new ActiveTurnInputMailbox(this.options.createSteeringId)
    let settle!: () => void
    const settled = new Promise<void>((resolve) => {
      settle = resolve
    })
    const controller = new AbortController()
    const record: ActiveTurnRecord = {
      ...(mailbox ? { mailbox } : {}),
      controller,
      settled,
      settle,
      terminal: false,
    }
    let terminalState: 'completed' | 'failed' | 'cancelled' = 'failed'
    let pendingFailure: { readonly error: unknown } | undefined
    let callerAbort: (() => void) | undefined

    const scope: TurnScope = {
      signal: controller.signal,
      emit: (event) => {
        if (
          event.type === 'state' &&
          (event.state === 'completed' ||
            event.state === 'failed' ||
            event.state === 'cancelled')
        ) {
          return
        }
        this.options.eventSink(event)
      },
      ...(mailbox ? { steering: mailbox } : {}),
    }

    try {
      if (request.signal?.aborted) controller.abort(request.signal.reason)
      this.validateRequest(request)
      if (this.activeTurns.has(sessionId)) {
        throw new Error(
          `conflict: locked (session ${sessionId} already has an active turn)`,
        )
      }
      if (this.closing) throw new Error('turn coordinator is closed')
      this.activeTurns.set(sessionId, record)
      if (request.signal && !request.signal.aborted) {
        callerAbort = () => controller.abort(request.signal?.reason)
        request.signal.addEventListener('abort', callerAbort, { once: true })
      }
      const result = await work(scope)
      if (controller.signal.aborted) throw new AgentRunCancelledError()
      terminalState = 'completed'
      this.transition(record, 'completed')
      return result
    } catch (error) {
      if (!record.terminal) {
        terminalState = this.terminalState(error, controller.signal)
        this.transition(record, terminalState)
      }
      throw error
    } finally {
      try {
        if (mailbox) {
          pendingFailure = this.rejectPending(
            mailbox.close(),
            terminalState === 'cancelled' ? 'cancelled' : 'failed',
          )
        }
      } finally {
        if (callerAbort && request.signal) {
          request.signal.removeEventListener('abort', callerAbort)
        }
        if (this.activeTurns.get(sessionId) === record) {
          this.activeTurns.delete(sessionId)
        }
      }
      record.settle()
      if (pendingFailure) {
        // A rejected-input sink failure intentionally retains its prior precedence.
        // eslint-disable-next-line no-unsafe-finally -- compatibility is covered by the sink-error regression
        throw pendingFailure.error
      }
    }
  }

  steer(sessionId: string, content: string): ActiveTurnInputCommandResult {
    const active = this.activeTurns.get(sessionId)
    if (!active) return { kind: 'no-active-turn' }
    if (!active.mailbox) return { kind: 'not-steerable' }
    const result = active.mailbox.enqueue(content)
    if (result.kind === 'accepted' || result.kind === 'empty') return result
    return { kind: 'turn-completing' }
  }

  withdrawSteering(
    sessionId: string,
    id: string,
  ): ActiveTurnInputCommandResult {
    const active = this.activeTurns.get(sessionId)
    if (!active) return { kind: 'no-active-turn' }
    if (!active.mailbox) return { kind: 'not-steerable' }
    const result = active.mailbox.withdraw(id)
    return result.kind === 'withdrawn' ? result : { kind: 'not-pending' }
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closing = true
    const snapshot = [...this.activeTurns.values()]
    let firstFailure: { readonly error: unknown } | undefined
    let resolveClose!: () => void
    let rejectClose!: (error: unknown) => void
    this.closePromise = new Promise<void>((resolve, reject) => {
      resolveClose = resolve
      rejectClose = reject
    })
    void (async () => {
      for (const active of snapshot) {
        if (active.mailbox) {
          const failure = this.rejectPending(active.mailbox.close(), 'closed')
          firstFailure ??= failure
        }
        active.controller.abort()
      }
      await Promise.allSettled(snapshot.map((active) => active.settled))
      if (firstFailure) rejectClose(firstFailure.error)
      else resolveClose()
    })()
    return this.closePromise
  }

  private validateRequest(request: TurnRequest): void {
    const { activation, submission } = request
    const prompt =
      submission.kind === 'shell'
        ? `! ${submission.command}`
        : submission.kind === 'retry'
          ? submission.prompt
          : submission.text
    const images = submission.kind === 'prompt' ? (submission.images ?? []) : []
    const documents =
      submission.kind === 'prompt' ? (submission.documents ?? []) : []
    if (prompt.length === 0 && images.length === 0 && documents.length === 0) {
      throw new Error('Prompt must not be empty')
    }
    if (activation.name !== undefined && activation.name.length === 0) {
      throw new Error('Session name must not be empty')
    }
    if (submission.kind === 'shell' && submission.command.trim().length === 0) {
      throw new Error('Shell command must not be empty')
    }
  }

  private terminalState(
    error: unknown,
    signal: AbortSignal | undefined,
  ): 'failed' | 'cancelled' {
    return signal?.aborted === true ||
      error instanceof AgentRunCancelledError ||
      (error instanceof ModelProviderError && error.kind === 'cancelled')
      ? 'cancelled'
      : 'failed'
  }

  private transition(
    record: ActiveTurnRecord,
    state: 'completed' | 'failed' | 'cancelled',
  ): void {
    if (record.terminal) return
    record.terminal = true
    this.options.eventSink({ type: 'state', state })
  }

  private rejectPending(
    items: readonly SteeringItem[],
    reason: 'closed' | 'failed' | 'cancelled',
  ): { readonly error: unknown } | undefined {
    let firstFailure: { readonly error: unknown } | undefined
    for (const item of items) {
      try {
        this.options.eventSink({
          type: 'user-input-rejected',
          id: item.id,
          content: item.content,
          reason,
        })
      } catch (error) {
        firstFailure ??= { error }
      }
    }
    return firstFailure
  }
}
