import { mkdir, open, readFile, rm } from 'node:fs/promises'
import { basename, isAbsolute, resolve } from 'node:path'

import {
  NativeSessionTranscript,
  type NativeSessionTranscriptLease,
} from './native-session-transcript.js'
import { NativeTranscriptStore } from '../persistence/native-transcript-store.js'

export type NativeSidechainPermissionMode =
  'acceptEdits' | 'auto' | 'bypassPermissions' | 'default' | 'dontAsk' | 'plan'

export interface NativeSidechainMetadata {
  readonly agentType: string
  readonly description: string
  readonly toolUseId: string
  readonly spawnDepth: number
  readonly cwd: string
  readonly promptId: string
  readonly name?: string
  readonly permissionMode?: NativeSidechainPermissionMode
  readonly isolation?: 'worktree'
  readonly parentAgentId?: string
  readonly worktreePath?: string
}

export interface NativeSidechainPaths {
  readonly sessionId: string
  readonly agentId: string
  readonly directory: string
  readonly transcriptFile: string
  readonly metadataFile: string
  readonly lockFile?: string
}

const permissionModes = new Set<NativeSidechainPermissionMode>([
  'acceptEdits',
  'auto',
  'bypassPermissions',
  'default',
  'dontAsk',
  'plan',
])
const requiredKeys = [
  'agentType',
  'description',
  'toolUseId',
  'spawnDepth',
  'cwd',
  'promptId',
]
const optionalKeys = [
  'name',
  'permissionMode',
  'isolation',
  'parentAgentId',
  'worktreePath',
]

function nonBlank(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    !value.includes('\0')
  )
}
function assertPaths(paths: NativeSidechainPaths): void {
  for (const value of [
    paths.sessionId,
    paths.agentId,
    paths.directory,
    paths.transcriptFile,
    paths.metadataFile,
  ]) {
    if (!nonBlank(value)) throw new Error('native sidechain paths are invalid')
  }
  if (
    !isAbsolute(paths.directory) ||
    !isAbsolute(paths.transcriptFile) ||
    !isAbsolute(paths.metadataFile)
  )
    throw new Error('native sidechain paths must be absolute')
  const directory = resolve(paths.directory)
  if (
    resolve(paths.transcriptFile) !==
      resolve(directory, `agent-${paths.agentId}.jsonl`) ||
    resolve(paths.metadataFile) !==
      resolve(directory, `agent-${paths.agentId}.meta.json`) ||
    basename(paths.transcriptFile) !== `agent-${paths.agentId}.jsonl` ||
    basename(paths.metadataFile) !== `agent-${paths.agentId}.meta.json`
  )
    throw new Error('native sidechain paths do not match agent identity')
  if (
    paths.lockFile !== undefined &&
    (!nonBlank(paths.lockFile) || !isAbsolute(paths.lockFile))
  )
    throw new Error('native sidechain lock path is invalid')
}
function validateMetadata(value: unknown): NativeSidechainMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('native sidechain metadata must be an object')
  const record = value as Record<string, unknown>
  if (
    Object.keys(record).some(
      (key) => !requiredKeys.includes(key) && !optionalKeys.includes(key),
    )
  )
    throw new Error('native sidechain metadata contains unknown fields')
  if (requiredKeys.some((key) => !(key in record)))
    throw new Error('native sidechain metadata is invalid')
  if (![record.agentType, record.description, record.toolUseId].every(nonBlank))
    throw new Error('native sidechain metadata is invalid')
  if (
    !Number.isSafeInteger(record.spawnDepth) ||
    Number(record.spawnDepth) <= 0
  )
    throw new Error('native sidechain metadata is invalid')
  if (!nonBlank(record.cwd) || !isAbsolute(record.cwd))
    throw new Error('native sidechain metadata cwd is invalid')
  if (!nonBlank(record.promptId))
    throw new Error('native sidechain metadata promptId is invalid')
  if (record.name !== undefined && !nonBlank(record.name))
    throw new Error('native sidechain metadata name is invalid')
  if (
    record.permissionMode !== undefined &&
    (typeof record.permissionMode !== 'string' ||
      !permissionModes.has(
        record.permissionMode as NativeSidechainPermissionMode,
      ))
  )
    throw new Error('native sidechain metadata permissionMode is invalid')
  if (record.isolation !== undefined && record.isolation !== 'worktree')
    throw new Error('native sidechain metadata isolation is invalid')
  if (
    record.parentAgentId !== undefined &&
    (typeof record.parentAgentId !== 'string' ||
      !/^a[0-9a-f]{16}$/u.test(record.parentAgentId))
  )
    throw new Error('native sidechain metadata parentAgentId is invalid')
  if (
    record.worktreePath !== undefined &&
    (!nonBlank(record.worktreePath) || !isAbsolute(record.worktreePath))
  )
    throw new Error('native sidechain metadata worktreePath is invalid')
  return {
    ...record,
    spawnDepth: Number(record.spawnDepth),
  } as NativeSidechainMetadata
}

export class NativeSidechainTranscript {
  private readonly transcript: NativeSessionTranscript
  private readonly store: NativeTranscriptStore
  constructor(private readonly paths: NativeSidechainPaths) {
    assertPaths(paths)
    this.store = new NativeTranscriptStore({
      transcriptFile: paths.transcriptFile,
      lockFile: paths.lockFile ?? `${paths.transcriptFile}.lock`,
    })
    this.transcript = new NativeSessionTranscript({
      sessionId: paths.sessionId,
      store: this.store,
    })
  }
  async create(
    prompt: string,
    metadata: NativeSidechainMetadata,
  ): Promise<void> {
    if (!nonBlank(prompt))
      throw new Error('native sidechain prompt must not be blank')
    const checked = validateMetadata(metadata)
    await mkdir(this.paths.directory, { recursive: true })
    let created = false
    try {
      const handle = await open(this.paths.metadataFile, 'wx')
      created = true
      try {
        await handle.writeFile(`${JSON.stringify(checked)}\n`)
        await handle.sync()
      } finally {
        await handle.close()
      }
      await this.transcript.withLease({ kind: 'start' }, async (lease) => {
        await lease.appendMessages({
          messages: [{ role: 'user', content: prompt }],
        })
      })
    } catch (error) {
      if (created) await rm(this.paths.metadataFile, { force: true })
      throw error
    }
  }
  withLease<T>(
    operation: (lease: NativeSessionTranscriptLease) => Promise<T>,
  ): Promise<T> {
    return this.transcript.withLease({ kind: 'resume' }, operation)
  }
  async loadReadOnly() {
    const snapshot = await this.store.loadReadOnly()
    if (snapshot.issue)
      throw new Error(
        `Invalid native sidechain transcript: ${snapshot.issue.message}`,
      )
    if (
      snapshot.records.some(
        (record) => record.event.sessionId !== this.paths.sessionId,
      )
    )
      throw new Error(
        'native sidechain transcript sessionId does not match paths',
      )
    return snapshot
  }
  async metadata(): Promise<NativeSidechainMetadata> {
    return validateMetadata(
      JSON.parse(await readFile(this.paths.metadataFile, 'utf8')),
    )
  }
}
