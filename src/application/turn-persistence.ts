import type { ModelMessage } from '../core/runtime.js'
import type { TranscriptEvent } from '../core/transcript-event.js'
import type { NativeTranscriptEntry } from '../native/schema.js'
import { projectNativeSessionEntries } from './native-session-projection.js'
import type {
  NativeCompactionAppend,
  NativeInterruption,
  NativeMessageAppend,
  NativeSessionTranscriptLease,
} from './native-session-transcript.js'
import type { NativeTranscriptTail } from '../persistence/native-transcript-store.js'

export interface TurnPersistenceView {
  readonly projectionEntries: readonly NativeTranscriptEntry[]
  readonly projectionTail: NativeTranscriptTail
  readonly activeEvents: readonly TranscriptEvent[]
  readonly activeMessages: readonly ModelMessage[]
  readonly interruption: NativeInterruption
}

export type TurnPersistenceCommand =
  | {
      readonly kind: 'projection'
      readonly entries: readonly NativeTranscriptEntry[]
    }
  | {
      readonly kind: 'messages'
      readonly input: NativeMessageAppend
      readonly projectionEntries?: readonly NativeTranscriptEntry[]
    }
  | {
      readonly kind: 'tool-execution-started'
      readonly callId: string
    }
  | {
      readonly kind: 'tool-completion'
      readonly input: Parameters<
        NativeSessionTranscriptLease['appendToolCompletion']
      >[0]
    }
  | {
      readonly kind: 'compaction'
      readonly input: NativeCompactionAppend
    }

export type TurnPersistenceReceipt =
  | { readonly kind: 'projection'; readonly lastProjectionId: string | null }
  | { readonly kind: 'messages'; readonly eventId: string }
  | { readonly kind: 'tool-execution-started'; readonly callId: string }
  | { readonly kind: 'tool-completion'; readonly callId: string }
  | {
      readonly kind: 'compaction'
      readonly boundaryId: string
      readonly summaryId: string
    }

const emptyProjectionTail = (): NativeTranscriptTail => ({
  byteLength: 0,
  lastLineHash: null,
  lastEventId: null,
  newlineTerminated: true,
})

export class TurnPersistence {
  private projectionEntries: NativeTranscriptEntry[]
  private projectionTail: NativeTranscriptTail = emptyProjectionTail()
  private commitQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly input: {
      readonly native: NativeSessionTranscriptLease
      readonly initialProjectionEntries?: readonly NativeTranscriptEntry[]
    },
  ) {
    this.projectionEntries = structuredClone(
      input.initialProjectionEntries
        ? [...input.initialProjectionEntries]
        : projectNativeSessionEntries(input.native.activeEvents()),
    )
  }

  view(): TurnPersistenceView {
    return {
      projectionEntries: structuredClone(this.projectionEntries),
      projectionTail: structuredClone(this.projectionTail),
      activeEvents: structuredClone(this.input.native.activeEvents()),
      activeMessages: structuredClone(this.input.native.activeMessages()),
      interruption: structuredClone(this.input.native.interruption()),
    }
  }

  refresh(): TurnPersistenceView {
    this.projectionEntries = structuredClone(
      projectNativeSessionEntries(this.input.native.activeEvents()),
    )
    return this.view()
  }

  commit(command: TurnPersistenceCommand): Promise<TurnPersistenceReceipt> {
    let ownership:
      | { readonly ok: true; readonly command: TurnPersistenceCommand }
      | { readonly ok: false; readonly error: unknown }
    try {
      ownership = { ok: true, command: structuredClone(command) }
    } catch (error) {
      ownership = { ok: false, error }
    }
    const operation = this.commitQueue.then(() => {
      if (!ownership.ok) throw ownership.error
      return this.commitCommand(ownership.command)
    })
    this.commitQueue = operation.then(
      () => undefined,
      () => undefined,
    )
    return operation
  }

  private async commitCommand(
    command: TurnPersistenceCommand,
  ): Promise<TurnPersistenceReceipt> {
    switch (command.kind) {
      case 'projection': {
        const staged = this.stageProjection(command.entries)
        this.projectionEntries = staged.entries
        this.projectionTail = staged.tail
        const lastProjectionId = [...command.entries]
          .reverse()
          .find((entry) => typeof entry.uuid === 'string')?.uuid
        return {
          kind: 'projection',
          lastProjectionId:
            typeof lastProjectionId === 'string' ? lastProjectionId : null,
        }
      }
      case 'messages': {
        if (command.input.messages.length === 0)
          throw new Error('native transcript cannot append empty messages')
        const staged =
          command.projectionEntries === undefined
            ? undefined
            : this.stageProjection(command.projectionEntries)
        const eventId = await this.input.native.appendMessages(command.input)
        if (staged) {
          this.projectionEntries = staged.entries
          this.projectionTail = staged.tail
        }
        return { kind: 'messages', eventId }
      }
      case 'tool-execution-started':
        await this.input.native.beginToolExecution(command.callId)
        return { kind: 'tool-execution-started', callId: command.callId }
      case 'tool-completion':
        await this.input.native.appendToolCompletion(command.input)
        return { kind: 'tool-completion', callId: command.input.callId }
      case 'compaction': {
        const result = await this.input.native.appendCompaction(command.input)
        return { kind: 'compaction', ...result }
      }
      default:
        throw new Error('Unknown turn persistence command')
    }
  }

  private stageProjection(entries: readonly NativeTranscriptEntry[]): {
    entries: NativeTranscriptEntry[]
    tail: NativeTranscriptTail
  } {
    if (entries.length === 0)
      throw new Error('Cannot append an empty projection')
    const stagedEntries = [...this.projectionEntries, ...entries]
    const lastUuidValue = [...entries]
      .reverse()
      .find((entry) => typeof entry.uuid === 'string')?.uuid
    const lastUuid =
      typeof lastUuidValue === 'string' ? lastUuidValue : undefined
    const byteLength = this.projectionTail.byteLength + entries.length
    return {
      entries: stagedEntries,
      tail: {
        ...this.projectionTail,
        byteLength,
        lastLineHash: `projection:${byteLength}`,
        lastEventId:
          typeof lastUuid === 'string'
            ? lastUuid
            : this.projectionTail.lastEventId,
        ...(this.projectionTail.branchParentId === undefined
          ? {}
          : { branchParentId: null }),
      },
    }
  }
}
