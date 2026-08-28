import type { TranscriptEvent } from '../core/transcript-event.js'
import type {
  NativeTranscriptAppendResult,
  NativeTranscriptCreateResult,
  NativeTranscriptLease,
  NativeTranscriptLeaseResult,
  NativeTranscriptReserveResult,
  NativeTranscriptSnapshot,
  NativeTranscriptTail,
} from './native-transcript-store.js'

export class InMemoryTranscriptStore {
  private records: { event: TranscriptEvent }[] = []
  private reserved = false
  private locked = false
  private revision = 0
  async create(
    events: readonly TranscriptEvent[],
  ): Promise<NativeTranscriptCreateResult> {
    if (events.length === 0)
      throw new Error('Cannot create an empty native transcript')
    if (this.reserved) return { status: 'conflict', reason: 'already-exists' }
    this.reserved = true
    this.records = events.map((event) => ({ event }))
    this.revision++
    return { status: 'created', tail: this.tail() }
  }
  async reserve(): Promise<NativeTranscriptReserveResult> {
    if (this.reserved) return { status: 'conflict', reason: 'already-exists' }
    this.reserved = true
    return { status: 'reserved' }
  }
  async withLease<T>(
    operation: (lease: NativeTranscriptLease) => Promise<T>,
  ): Promise<NativeTranscriptLeaseResult<T>> {
    if (this.locked) return { status: 'conflict', reason: 'locked' }
    this.locked = true
    try {
      const value = await operation({
        reserve: async () => {
          if (this.reserved)
            return { status: 'conflict', reason: 'already-exists' as const }
          this.reserved = true
          return { status: 'reserved' as const }
        },
        load: async () => this.load(),
        append: (tail, event) => this.appendMany(tail, [event]),
        appendMany: (tail, events) => this.appendMany(tail, events),
      })
      return { status: 'completed', value }
    } finally {
      this.locked = false
    }
  }
  async loadReadOnly(): Promise<{
    records: readonly { event: TranscriptEvent }[]
    tail: NativeTranscriptTail
    issue: null
  }> {
    return { ...(await this.load()), issue: null }
  }
  private async load(): Promise<NativeTranscriptSnapshot> {
    const records = this.records.map((record) => ({ event: record.event }))
    return { records, tail: this.tail() }
  }
  private async appendMany(
    expected: NativeTranscriptTail,
    events: readonly TranscriptEvent[],
  ): Promise<NativeTranscriptAppendResult> {
    if (!events.length)
      throw new Error('Cannot append an empty native transcript batch')
    if (
      expected.byteLength !== this.tail().byteLength ||
      expected.lastEventId !== this.tail().lastEventId
    )
      return { status: 'conflict', reason: 'tail-changed' }
    this.records.push(...events.map((event) => ({ event })))
    this.revision++
    return { status: 'appended', tail: this.tail() }
  }
  private tail(): NativeTranscriptTail {
    return {
      byteLength: this.records.length,
      lastLineHash: this.revision === 0 ? null : `memory:${this.revision}`,
      lastEventId: this.records.at(-1)?.event.id ?? null,
      newlineTerminated: true,
    }
  }
}
