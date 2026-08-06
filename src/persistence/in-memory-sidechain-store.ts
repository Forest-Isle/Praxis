import type {
  ClaudeSidechainMetadata,
  ClaudeSidechainPaths,
} from '../compatibility/claude/sidechain.js'
import type { ClaudeTranscriptEntry } from '../compatibility/claude/schema.js'
import type { ClaudeTranscriptLease } from './claude-transcript-store.js'
import { InMemoryTranscriptStore } from './in-memory-transcript-store.js'

export class InMemorySidechainStore {
  private readonly transcript = new InMemoryTranscriptStore()

  constructor(
    private readonly paths: Pick<ClaudeSidechainPaths, 'sessionId' | 'agentId'>,
  ) {}

  async create(
    root: ClaudeTranscriptEntry,
    metadata: ClaudeSidechainMetadata,
  ): Promise<void> {
    this.assertIdentity(root)
    void metadata
    const result = await this.transcript.create([root])
    if (result.status === 'conflict') {
      throw new Error('Claude sidechain transcript already exists')
    }
  }

  async withLease<T>(
    operation: (lease: ClaudeTranscriptLease) => Promise<T>,
  ): Promise<T> {
    const result = await this.transcript.withLease(operation)
    if (result.status === 'conflict') {
      throw new Error('Claude sidechain transcript is locked')
    }
    return result.value
  }

  private assertIdentity(root: ClaudeTranscriptEntry): void {
    if (
      root.sessionId !== this.paths.sessionId ||
      root.agentId !== this.paths.agentId
    ) {
      throw new Error('Claude sidechain root identity does not match paths')
    }
  }
}
