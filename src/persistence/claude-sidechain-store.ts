import { mkdir, open, readFile, rm } from 'node:fs/promises'

import type {
  ClaudeSchemaAdapter,
  ClaudeTranscriptEntry,
} from '../compatibility/claude/schema.js'
import type {
  ClaudeSidechainMetadata,
  ClaudeSidechainPaths,
} from '../compatibility/claude/sidechain.js'
import {
  ClaudeTranscriptStore,
  type ClaudeTranscriptLease,
  type TranscriptSnapshot,
} from './claude-transcript-store.js'

export class ClaudeSidechainStore {
  private readonly transcript: ClaudeTranscriptStore

  constructor(
    private readonly paths: ClaudeSidechainPaths,
    lockFile: string,
    schema: ClaudeSchemaAdapter,
  ) {
    this.transcript = new ClaudeTranscriptStore({
      sessionFile: paths.transcriptFile,
      lockFile,
      schema,
      writeProfile: 'sidechain',
    })
  }

  async create(
    root: ClaudeTranscriptEntry,
    metadata: ClaudeSidechainMetadata,
  ): Promise<void> {
    await this.createWithMetadata(root, metadata)
  }

  async createWorkflow(
    root: ClaudeTranscriptEntry,
    metadata: { agentType: string; spawnDepth: 1 },
  ): Promise<void> {
    await this.createWithMetadata(root, metadata)
  }

  private async createWithMetadata(
    root: ClaudeTranscriptEntry,
    metadata: ClaudeSidechainMetadata | { agentType: string; spawnDepth: 1 },
  ): Promise<void> {
    if (
      root.sessionId !== this.paths.sessionId ||
      root.agentId !== this.paths.agentId
    ) {
      throw new Error('Claude sidechain root identity does not match paths')
    }
    await mkdir(this.paths.directory, { recursive: true })
    let metadataCreated = false
    try {
      const metadataHandle = await open(this.paths.metadataFile, 'wx')
      metadataCreated = true
      try {
        await metadataHandle.writeFile(`${JSON.stringify(metadata)}\n`)
        await metadataHandle.sync()
      } finally {
        await metadataHandle.close()
      }
    } catch (error) {
      if (metadataCreated) await rm(this.paths.metadataFile, { force: true })
      throw error
    }

    try {
      const result = await this.transcript.create([root])
      if (result.status === 'conflict') {
        throw new Error('Claude sidechain transcript already exists')
      }
    } catch (error) {
      await rm(this.paths.metadataFile, { force: true })
      throw error
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

  async loadReadOnly(): Promise<TranscriptSnapshot> {
    return this.transcript.loadReadOnly()
  }

  async metadata(): Promise<ClaudeSidechainMetadata> {
    const source = await readFile(this.paths.metadataFile, 'utf8')
    const value: unknown = JSON.parse(source)
    if (!value || typeof value !== 'object') {
      throw new Error('Claude sidechain metadata must be an object')
    }
    const record = value as Record<string, unknown>
    if (
      typeof record.agentType !== 'string' ||
      typeof record.description !== 'string' ||
      typeof record.toolUseId !== 'string' ||
      typeof record.spawnDepth !== 'number' ||
      (record.name !== undefined && typeof record.name !== 'string') ||
      (record.permissionMode !== undefined &&
        (typeof record.permissionMode !== 'string' ||
          ![
            'acceptEdits',
            'auto',
            'bypassPermissions',
            'default',
            'dontAsk',
            'plan',
          ].includes(record.permissionMode))) ||
      (record.isolation !== undefined && record.isolation !== 'worktree')
    ) {
      throw new Error('Claude sidechain metadata is invalid')
    }
    return {
      agentType: record.agentType,
      description: record.description,
      toolUseId: record.toolUseId,
      spawnDepth: record.spawnDepth,
      ...(record.name === undefined ? {} : { name: record.name }),
      ...(record.permissionMode === undefined
        ? {}
        : {
            permissionMode: record.permissionMode as
              | 'acceptEdits'
              | 'auto'
              | 'bypassPermissions'
              | 'default'
              | 'dontAsk'
              | 'plan',
          }),
      ...(record.isolation === undefined
        ? {}
        : { isolation: record.isolation }),
    }
  }
}
