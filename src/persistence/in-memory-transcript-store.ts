import type { ClaudeTranscriptEntry } from '../compatibility/claude/schema.js'
import type {
  ClaudeTranscriptLease,
  TranscriptAppendResult,
  TranscriptCreateResult,
  TranscriptLeaseResult,
  TranscriptReserveResult,
  TranscriptSnapshot,
  TranscriptTail,
} from './claude-transcript-store.js'

function tailsMatch(left: TranscriptTail, right: TranscriptTail): boolean {
  return (
    left.byteLength === right.byteLength &&
    left.lastLineHash === right.lastLineHash &&
    left.lastUuid === right.lastUuid &&
    left.newlineTerminated === right.newlineTerminated
  )
}

function lastUuid(entries: readonly ClaudeTranscriptEntry[]): string | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (typeof entry?.uuid === 'string') return entry.uuid
    if (typeof entry?.leafUuid === 'string') return entry.leafUuid
  }
  return null
}

export class InMemoryTranscriptStore {
  private entries: ClaudeTranscriptEntry[] = []
  private reserved = false
  private locked = false
  private revision = 0

  async create(
    entries: readonly ClaudeTranscriptEntry[],
  ): Promise<TranscriptCreateResult> {
    if (entries.length === 0) {
      throw new Error('Cannot create an empty Claude transcript')
    }
    if (this.reserved) {
      return { status: 'conflict', reason: 'already-exists' }
    }
    this.reserved = true
    this.entries = [...entries]
    this.revision += 1
    return { status: 'created', tail: this.tail() }
  }

  async reserve(): Promise<TranscriptReserveResult> {
    if (this.reserved) {
      return { status: 'conflict', reason: 'already-exists' }
    }
    this.reserved = true
    return { status: 'reserved' }
  }

  async withLease<T>(
    operation: (lease: ClaudeTranscriptLease) => Promise<T>,
  ): Promise<TranscriptLeaseResult<T>> {
    if (this.locked) return { status: 'conflict', reason: 'locked' }
    this.locked = true
    try {
      const value = await operation({
        load: () => this.load(),
        append: (expectedTail, entry) => this.appendMany(expectedTail, [entry]),
        appendMany: (expectedTail, entries) =>
          this.appendMany(expectedTail, entries),
        appendMetadataSnapshot: (expectedTail, entries) =>
          this.appendMany(expectedTail, entries),
      })
      return { status: 'completed', value }
    } finally {
      this.locked = false
    }
  }

  private async load(): Promise<TranscriptSnapshot> {
    return { entries: [...this.entries], tail: this.tail() }
  }

  private async appendMany(
    expectedTail: TranscriptTail,
    entries: readonly ClaudeTranscriptEntry[],
  ): Promise<TranscriptAppendResult> {
    if (entries.length === 0) {
      throw new Error('Cannot append an empty Claude transcript batch')
    }
    if (!tailsMatch(this.tail(), expectedTail)) {
      return { status: 'conflict', reason: 'tail-changed' }
    }
    const branchParentUuid = expectedTail.branchParentUuid
    const advancedLogicalTail = entries.some(
      (entry) =>
        typeof entry.uuid === 'string' &&
        ![
          'agent-name',
          'agent-setting',
          'custom-title',
          'pr-link',
          'worktree-state',
        ].includes(entry.type),
    )
    this.entries.push(...entries)
    this.revision += 1
    const tail = this.tail()
    return {
      status: 'appended',
      tail:
        branchParentUuid === undefined || advancedLogicalTail
          ? tail
          : { ...tail, branchParentUuid },
    }
  }

  private tail(): TranscriptTail {
    return {
      byteLength: this.entries.length,
      lastLineHash: this.revision === 0 ? null : `memory:${this.revision}`,
      lastUuid: lastUuid(this.entries),
      newlineTerminated: true,
    }
  }
}
