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

export interface TurnProjectionCursor {
  readonly lastEntryId: string | null
  readonly entryCount: number
}

export interface TurnPersistenceView {
  readonly projectionEntries: readonly NativeTranscriptEntry[]
  readonly projectionCursor: TurnProjectionCursor
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

export class TurnPersistence {
  private projectionEntries: NativeTranscriptEntry[]
  private projectionCursor: TurnProjectionCursor
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
    this.projectionCursor = deriveTurnProjectionCursor(this.projectionEntries)
  }

  view(): TurnPersistenceView {
    return {
      projectionEntries: structuredClone(this.projectionEntries),
      projectionCursor: structuredClone(this.projectionCursor),
      activeEvents: structuredClone(this.input.native.activeEvents()),
      activeMessages: structuredClone(this.input.native.activeMessages()),
      interruption: structuredClone(this.input.native.interruption()),
    }
  }

  refresh(): TurnPersistenceView {
    const entries = projectNativeSessionEntries(
      this.input.native.activeEvents(),
    )
    this.replaceProjection(entries)
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
        this.replaceProjection(staged.entries, staged.cursor)
        return {
          kind: 'projection',
          lastProjectionId: staged.cursor.lastEntryId,
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
          this.replaceProjection(staged.entries, staged.cursor)
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
    cursor: TurnProjectionCursor
  } {
    if (entries.length === 0)
      throw new Error('Cannot append an empty projection')
    const stagedEntries = [...this.projectionEntries, ...entries]
    return {
      entries: stagedEntries,
      cursor: deriveTurnProjectionCursor(stagedEntries),
    }
  }

  private replaceProjection(
    entries: readonly NativeTranscriptEntry[],
    cursor = deriveTurnProjectionCursor(entries),
  ): void {
    this.projectionEntries = structuredClone([...entries])
    this.projectionCursor = structuredClone(cursor)
  }
}

export const deriveTurnProjectionCursor = (
  entries: readonly NativeTranscriptEntry[],
): TurnProjectionCursor => {
  let lastEntryId: string | null = null
  for (const entry of entries) {
    if (typeof entry.uuid === 'string' && entry.uuid.length > 0)
      lastEntryId = entry.uuid
  }
  return { lastEntryId, entryCount: entries.length }
}
