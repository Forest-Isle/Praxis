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
  readonly steering?: ActiveTurnInputPort
}

export interface TurnCoordinatorOptions {
  readonly eventSink: RuntimeEventSink
  readonly createSteeringId: () => string
}

interface ActiveTurnRecord {
  readonly mailbox?: ActiveTurnInputMailbox
  terminal: boolean
}

/** Owns the lifecycle and active-turn coordination for one session service. */
export class TurnCoordinator {
  private readonly activeTurns = new Map<string, ActiveTurnRecord>()

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
    const record: ActiveTurnRecord = {
      ...(mailbox ? { mailbox } : {}),
      terminal: false,
    }
    let terminalState: 'completed' | 'failed' | 'cancelled' = 'failed'
    let pendingFailure: { readonly error: unknown } | undefined

    const scope: TurnScope = {
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
      this.validateRequest(request)
      if (this.activeTurns.has(sessionId)) {
        throw new Error(
          `conflict: locked (session ${sessionId} already has an active turn)`,
        )
      }
      this.activeTurns.set(sessionId, record)
      const result = await work(scope)
      terminalState = 'completed'
      this.transition(record, 'completed')
      return result
    } catch (error) {
      if (!record.terminal) {
        terminalState = this.terminalState(error, request.signal)
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
        if (this.activeTurns.get(sessionId) === record) {
          this.activeTurns.delete(sessionId)
        }
      }
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

  close(): void {
    let firstFailure: { readonly error: unknown } | undefined
    for (const active of this.activeTurns.values()) {
      if (!active.mailbox) continue
      const failure = this.rejectPending(active.mailbox.close(), 'closed')
      firstFailure ??= failure
    }
    if (firstFailure) throw firstFailure.error
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
