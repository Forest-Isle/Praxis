import {
  NativeSessionTranscript,
  type NativeSessionTranscriptLease,
} from '../application/native-session-transcript.js'
import { InMemoryTranscriptStore } from './in-memory-transcript-store.js'

type NativeSidechainPaths = {
  readonly sessionId: string
  readonly agentId: string
}
type NativeSidechainMetadata = Record<string, unknown>

export class InMemorySidechainStore {
  private readonly store = new InMemoryTranscriptStore()
  private readonly transcript: NativeSessionTranscript
  private sidechainMetadata: NativeSidechainMetadata | undefined
  constructor(private readonly paths: NativeSidechainPaths) {
    this.transcript = new NativeSessionTranscript({
      sessionId: paths.sessionId,
      store: this.store as never,
    })
  }
  async create(
    prompt: string | { message?: { content?: string } },
    metadata: NativeSidechainMetadata,
  ): Promise<void> {
    this.sidechainMetadata = { ...metadata }
    const content =
      typeof prompt === 'string' ? prompt : prompt.message?.content
    if (typeof content !== 'string' || content.length === 0)
      throw new Error('native sidechain prompt must not be blank')
    await this.transcript.withLease({ kind: 'start' }, (lease) =>
      lease
        .appendMessages({ messages: [{ role: 'user', content }] })
        .then(() => undefined),
    )
  }
  withLease<T>(operation: (lease: NativeSessionTranscriptLease) => Promise<T>) {
    return this.transcript.withLease({ kind: 'resume' }, operation)
  }
  async loadReadOnly() {
    return this.store.loadReadOnly()
  }
  async metadata() {
    return this.sidechainMetadata ?? {}
  }
}
