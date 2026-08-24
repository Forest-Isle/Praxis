import {
  AgentRunCancelledError,
  ModelProviderError,
  type ModelDocument,
  type ModelImage,
  type RuntimeEventSink,
} from '../core/runtime.js'
import type { LifecycleState } from '../core/agent-orchestration.js'

export type TurnTerminalState = Extract<
  LifecycleState,
  'completed' | 'failed' | 'cancelled'
>

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

export class TurnTerminalController {
  private terminal = false

  constructor(private readonly sink: RuntimeEventSink) {}

  emit: RuntimeEventSink = (event) => {
    if (
      event.type === 'state' &&
      (event.state === 'completed' ||
        event.state === 'cancelled' ||
        event.state === 'failed')
    ) {
      return
    }
    this.sink(event)
  }

  complete(): void {
    this.transition('completed')
  }

  fail(error: unknown, signal?: AbortSignal): void {
    if (this.terminal) return
    const cancelled =
      signal?.aborted === true ||
      error instanceof AgentRunCancelledError ||
      (error instanceof ModelProviderError && error.kind === 'cancelled')
    this.transition(cancelled ? 'cancelled' : 'failed')
  }

  private transition(state: TurnTerminalState): void {
    if (this.terminal) {
      throw new Error('Turn terminal transition already emitted')
    }
    this.terminal = true
    this.sink({ type: 'state', state })
  }
}
