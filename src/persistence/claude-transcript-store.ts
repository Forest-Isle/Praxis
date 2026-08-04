import { createHash, randomUUID } from 'node:crypto'
import {
  link,
  mkdir,
  open,
  opendir,
  readFile,
  rename,
  rm,
} from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { TextDecoder } from 'node:util'

import type {
  ClaudeSchemaAdapter,
  ClaudeTranscriptEntry,
} from '../compatibility/claude/schema.js'
import {
  getClaudeContentBlocks,
  indexClaudeToolLinks,
} from '../compatibility/claude/tool-links.js'

export interface TranscriptTail {
  byteLength: number
  lastLineHash: string | null
  lastUuid: string | null
  newlineTerminated: boolean
}

export interface TranscriptSnapshot {
  entries: ClaudeTranscriptEntry[]
  tail: TranscriptTail
}

export interface TranscriptParseIssue {
  lineNumber: number
  byteOffset: number
  message: string
}

export interface TranscriptRecovery extends TranscriptSnapshot {
  issue: TranscriptParseIssue | null
}

export class ClaudeTranscriptParseError extends Error {
  override readonly name = 'ClaudeTranscriptParseError'

  constructor(
    readonly lineNumber: number,
    readonly byteOffset: number,
    options: ErrorOptions,
  ) {
    super(
      `Invalid Claude transcript JSON at line ${lineNumber}, byte ${byteOffset}`,
      options,
    )
  }
}

export type TranscriptAppendResult =
  | { status: 'appended'; tail: TranscriptTail }
  | {
      status: 'conflict'
      reason: 'interleaved-write' | 'locked' | 'tail-changed'
    }

export type TranscriptCreateResult =
  | { status: 'created'; tail: TranscriptTail }
  | { status: 'conflict'; reason: 'already-exists' }

export type TranscriptReserveResult =
  { status: 'reserved' } | { status: 'conflict'; reason: 'already-exists' }

export interface ClaudeTranscriptLease {
  load(): Promise<TranscriptSnapshot>
  append(
    expectedTail: TranscriptTail,
    entry: ClaudeTranscriptEntry,
  ): Promise<TranscriptAppendResult>
  appendMany(
    expectedTail: TranscriptTail,
    entries: readonly ClaudeTranscriptEntry[],
  ): Promise<TranscriptAppendResult>
}

export type TranscriptLeaseResult<T> =
  { status: 'completed'; value: T } | { status: 'conflict'; reason: 'locked' }

export interface ClaudeTranscriptStoreOptions {
  sessionFile: string
  lockFile: string
  schema: ClaudeSchemaAdapter
  writeProfile?: 'main' | 'sidechain'
}

interface LeaseLockMetadata {
  version: 1
  pid: number
  token: string
  createdAt: string
}

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })
const MAX_STALE_ARTIFACT_CLEANUP = 64

export function classifyTranscriptAppend(
  written: Uint8Array,
  previousByteLength: number,
  encodedLine: Uint8Array,
): 'appended' | 'interleaved-write' {
  const expectedEnd = previousByteLength + encodedLine.length
  if (
    written.length === expectedEnd &&
    Buffer.from(written)
      .subarray(previousByteLength, expectedEnd)
      .equals(encodedLine)
  ) {
    return 'appended'
  }
  return 'interleaved-write'
}

function hashLine(line: Uint8Array): string {
  return createHash('sha256').update(line).digest('hex')
}

function splitTranscriptLines(source: Buffer): Buffer[] {
  const contentEnd = source.at(-1) === 0x0a ? source.length - 1 : source.length
  if (contentEnd === 0) return []

  const lines: Buffer[] = []
  let lineStart = 0
  for (let index = 0; index < contentEnd; index += 1) {
    if (source[index] !== 0x0a) continue
    lines.push(source.subarray(lineStart, index))
    lineStart = index + 1
  }
  lines.push(source.subarray(lineStart, contentEnd))
  return lines
}

function parseLeaseLock(source: string): LeaseLockMetadata | null {
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  const lock = value as Record<string, unknown>
  if (
    lock.version !== 1 ||
    !Number.isSafeInteger(lock.pid) ||
    Number(lock.pid) <= 0 ||
    typeof lock.token !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/u.test(lock.token) ||
    typeof lock.createdAt !== 'string'
  ) {
    return null
  }
  return lock as unknown as LeaseLockMetadata
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function tailsMatch(left: TranscriptTail, right: TranscriptTail): boolean {
  return (
    left.byteLength === right.byteLength &&
    left.lastLineHash === right.lastLineHash &&
    left.lastUuid === right.lastUuid &&
    left.newlineTerminated === right.newlineTerminated
  )
}

function getEntryUuid(entry: ClaudeTranscriptEntry): string | null {
  if (typeof entry.uuid === 'string') return entry.uuid
  if (typeof entry.leafUuid === 'string') return entry.leafUuid
  return null
}

function findLogicalTailUuid(
  entries: readonly ClaudeTranscriptEntry[],
): string | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (!entry) continue
    const uuid = getEntryUuid(entry)
    if (uuid) return uuid
  }
  return null
}

function validateToolPairing(
  history: readonly ClaudeTranscriptEntry[],
  entry: ClaudeTranscriptEntry,
): void {
  const { toolCalls, completedToolCalls } = indexClaudeToolLinks(history)

  for (const block of getClaudeContentBlocks(entry)) {
    if (entry.type === 'assistant' && block.type === 'tool_use') {
      if (typeof block.id === 'string' && toolCalls.has(block.id)) {
        throw new Error(`Duplicate assistant tool_use id: ${block.id}`)
      }
      if (typeof block.id === 'string' && typeof entry.uuid === 'string') {
        toolCalls.set(block.id, entry.uuid)
      }
      continue
    }
    if (entry.type !== 'user' || block.type !== 'tool_result') continue

    const toolUseId = block.tool_use_id
    const sourceUuid = entry.sourceToolAssistantUUID
    if (
      typeof toolUseId !== 'string' ||
      typeof sourceUuid !== 'string' ||
      toolCalls.get(toolUseId) !== sourceUuid
    ) {
      throw new Error(
        `Tool result has no matching assistant tool_use: ${String(toolUseId)}`,
      )
    }
    if (completedToolCalls.has(toolUseId)) {
      throw new Error(`Tool result already exists: ${toolUseId}`)
    }
    completedToolCalls.add(toolUseId)
  }
}

function validateLastPromptLeaf(
  history: readonly ClaudeTranscriptEntry[],
  entry: ClaudeTranscriptEntry,
): void {
  if (entry.type !== 'last-prompt') return

  let leaf: ClaudeTranscriptEntry | undefined
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const candidate = history[index]
    if (candidate?.uuid === entry.leafUuid) {
      leaf = candidate
      break
    }
  }
  if (leaf?.type !== 'assistant') {
    throw new Error(
      'Claude last-prompt must reference the final assistant leaf',
    )
  }
  if (leaf.sessionId !== entry.sessionId) {
    throw new Error(
      'Claude last-prompt and leaf must belong to the same session',
    )
  }
}

export class ClaudeTranscriptStore {
  private readonly sessionFile: string
  private readonly lockFile: string
  private readonly schema: ClaudeSchemaAdapter
  private readonly writeProfile: 'main' | 'sidechain'

  constructor(options: ClaudeTranscriptStoreOptions) {
    this.sessionFile = options.sessionFile
    this.lockFile = options.lockFile
    this.schema = options.schema
    this.writeProfile = options.writeProfile ?? 'main'
  }

  private async readSource(): Promise<Buffer> {
    let source: Buffer
    try {
      source = await readFile(this.sessionFile)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
      source = Buffer.alloc(0)
    }

    return source
  }

  private parseSource(source: Buffer, recover: boolean): TranscriptRecovery {
    const lines = splitTranscriptLines(source)
    const entries: ClaudeTranscriptEntry[] = []
    let issue: TranscriptParseIssue | null = null
    let byteOffset = 0

    for (const [index, line] of lines.entries()) {
      try {
        entries.push(this.schema.parse(UTF8_DECODER.decode(line)))
      } catch (error) {
        issue = {
          lineNumber: index + 1,
          byteOffset,
          message: error instanceof Error ? error.message : String(error),
        }
        if (!recover) {
          throw new ClaudeTranscriptParseError(
            issue.lineNumber,
            issue.byteOffset,
            { cause: error },
          )
        }
        break
      }
      byteOffset += line.length + 1
    }
    if (recover && entries.length === 0 && issue === null) {
      issue = {
        lineNumber: 1,
        byteOffset: 0,
        message: 'Claude transcript contains no entries',
      }
    }
    const lastLine = lines.at(-1)

    return {
      entries,
      issue,
      tail: {
        byteLength: source.length,
        lastLineHash: lastLine === undefined ? null : hashLine(lastLine),
        lastUuid: findLogicalTailUuid(entries),
        newlineTerminated: source.length === 0 || source.at(-1) === 0x0a,
      },
    }
  }

  async load(): Promise<TranscriptSnapshot> {
    const { entries, tail } = this.parseSource(await this.readSource(), false)
    return { entries, tail }
  }

  async loadReadOnly(): Promise<TranscriptRecovery> {
    return this.parseSource(await this.readSource(), true)
  }

  async exportReadOnly(): Promise<Buffer> {
    return readFile(this.sessionFile)
  }

  async create(
    entries: readonly ClaudeTranscriptEntry[],
  ): Promise<TranscriptCreateResult> {
    if (entries.length === 0) {
      throw new Error('Cannot create an empty Claude transcript')
    }
    const source =
      this.writeProfile === 'sidechain'
        ? `${this.serializeNewSidechain(entries).join('\n')}\n`
        : `${entries.map((entry) => this.schema.serializeForFork(entry)).join('\n')}\n`
    await mkdir(dirname(this.sessionFile), { recursive: true })

    let sessionHandle
    try {
      sessionHandle = await open(this.sessionFile, 'wx')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        return { status: 'conflict', reason: 'already-exists' }
      }
      throw error
    }

    try {
      await sessionHandle.writeFile(source)
      await sessionHandle.sync()
    } finally {
      await sessionHandle.close()
    }
    return { status: 'created', tail: (await this.load()).tail }
  }

  async reserve(): Promise<TranscriptReserveResult> {
    await mkdir(dirname(this.sessionFile), { recursive: true })
    let handle
    try {
      handle = await open(this.sessionFile, 'wx')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        return { status: 'conflict', reason: 'already-exists' }
      }
      throw error
    }
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
    return { status: 'reserved' }
  }

  async withLease<T>(
    operation: (lease: ClaudeTranscriptLease) => Promise<T>,
  ): Promise<TranscriptLeaseResult<T>> {
    await mkdir(dirname(this.lockFile), { recursive: true })
    await this.cleanupStaleLeaseArtifacts()
    const lock = await this.acquireLeaseLock()
    if (!lock) return { status: 'conflict', reason: 'locked' }

    try {
      const value = await operation({
        load: () => this.load(),
        append: (expectedTail, entry) =>
          this.appendUnderLease(expectedTail, entry),
        appendMany: (expectedTail, entries) =>
          this.appendManyUnderLease(expectedTail, entries),
      })
      return { status: 'completed', value }
    } finally {
      await this.releaseOwnedLock(this.lockFile, lock.token)
    }
  }

  private async acquireLeaseLock(): Promise<LeaseLockMetadata | null> {
    const lock: LeaseLockMetadata = {
      version: 1,
      pid: process.pid,
      token: randomUUID(),
      createdAt: new Date().toISOString(),
    }
    const candidate = `${this.lockFile}.${lock.token}.candidate`
    const candidateHandle = await open(candidate, 'wx')
    try {
      try {
        await candidateHandle.writeFile(JSON.stringify(lock))
        await candidateHandle.sync()
      } finally {
        await candidateHandle.close()
      }
      try {
        await link(candidate, this.lockFile)
        return lock
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }

      let existing: LeaseLockMetadata | null
      try {
        existing = parseLeaseLock(await readFile(this.lockFile, 'utf8'))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        try {
          await link(candidate, this.lockFile)
          return lock
        } catch (linkError) {
          if ((linkError as NodeJS.ErrnoException).code === 'EEXIST') {
            return null
          }
          throw linkError
        }
      }
      if (!existing || isProcessAlive(existing.pid)) return null
      const reclaimGuard = `${this.lockFile}.${existing.token}.reclaim`
      if (
        !(await this.acquireReclaimGuard(candidate, reclaimGuard, lock.token))
      ) {
        return null
      }
      try {
        if (!(await this.ownsLock(reclaimGuard, lock.token))) return null
        let current: LeaseLockMetadata | null
        try {
          current = parseLeaseLock(await readFile(this.lockFile, 'utf8'))
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') current = null
          else throw error
        }
        if (current?.token !== existing.token || isProcessAlive(current.pid)) {
          return null
        }
        await rm(this.lockFile, { force: true })
        try {
          await link(candidate, this.lockFile)
          if (!(await this.ownsLock(reclaimGuard, lock.token))) {
            await this.releaseOwnedLock(this.lockFile, lock.token)
            return null
          }
          return lock
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null
          throw error
        }
      } finally {
        await this.releaseOwnedLock(reclaimGuard, lock.token)
      }
    } finally {
      await rm(candidate, { force: true })
    }
  }

  private async acquireReclaimGuard(
    candidate: string,
    reclaimGuard: string,
    token: string,
  ): Promise<boolean> {
    try {
      await link(candidate, reclaimGuard)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    let existing: LeaseLockMetadata | null
    try {
      existing = parseLeaseLock(await readFile(reclaimGuard, 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      try {
        await link(candidate, reclaimGuard)
        return true
      } catch (linkError) {
        if ((linkError as NodeJS.ErrnoException).code === 'EEXIST') return false
        throw linkError
      }
    }
    if (!existing || isProcessAlive(existing.pid)) return false
    const displacedGuard = `${reclaimGuard}.${token}.stale`
    try {
      try {
        await rename(reclaimGuard, displacedGuard)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        try {
          await link(candidate, reclaimGuard)
          return true
        } catch (linkError) {
          if ((linkError as NodeJS.ErrnoException).code === 'EEXIST') {
            return false
          }
          throw linkError
        }
      }

      const displaced = parseLeaseLock(await readFile(displacedGuard, 'utf8'))
      if (displaced?.token !== existing.token) {
        return false
      }
      try {
        await link(candidate, reclaimGuard)
        return true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
        throw error
      }
    } finally {
      await rm(displacedGuard, { force: true })
    }
  }

  private async ownsLock(lockFile: string, token: string): Promise<boolean> {
    let current: LeaseLockMetadata | null
    try {
      current = parseLeaseLock(await readFile(lockFile, 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
    return current?.token === token
  }

  private async cleanupStaleLeaseArtifacts(): Promise<void> {
    const directory = dirname(this.lockFile)
    const prefix = `${basename(this.lockFile)}.`
    const entries = await opendir(directory)
    let inspected = 0

    for await (const entry of entries) {
      if (
        !entry.isFile() ||
        !entry.name.startsWith(prefix) ||
        !/\.(?:candidate|stale)$/u.test(entry.name)
      ) {
        continue
      }
      if (inspected >= MAX_STALE_ARTIFACT_CLEANUP) return
      inspected += 1
      if (
        entry.name.endsWith('.stale') &&
        (await this.staleArtifactHasLiveOwner(entry.name))
      ) {
        continue
      }
      const artifact = join(directory, entry.name)
      let owner: LeaseLockMetadata | null
      try {
        owner = parseLeaseLock(await readFile(artifact, 'utf8'))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      if (!owner || isProcessAlive(owner.pid)) continue
      await this.releaseOwnedLock(artifact, owner.token)
    }
  }

  private async staleArtifactHasLiveOwner(name: string): Promise<boolean> {
    const match = /\.reclaim\.([A-Za-z0-9_-]{1,128})\.stale$/u.exec(name)
    const token = match?.[1]
    if (!token) return true

    let owner: LeaseLockMetadata | null
    try {
      owner = parseLeaseLock(
        await readFile(`${this.lockFile}.${token}.candidate`, 'utf8'),
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
    return !owner || owner.token !== token || isProcessAlive(owner.pid)
  }

  private async releaseOwnedLock(
    lockFile: string,
    token: string,
  ): Promise<void> {
    if (await this.ownsLock(lockFile, token)) {
      await rm(lockFile, { force: true })
    }
  }

  async append(
    expectedTail: TranscriptTail,
    entry: ClaudeTranscriptEntry,
  ): Promise<TranscriptAppendResult> {
    const result = await this.withLease((lease) =>
      lease.append(expectedTail, entry),
    )
    return result.status === 'completed'
      ? result.value
      : { status: 'conflict', reason: result.reason }
  }

  private async appendUnderLease(
    expectedTail: TranscriptTail,
    entry: ClaudeTranscriptEntry,
  ): Promise<TranscriptAppendResult> {
    return this.appendManyUnderLease(expectedTail, [entry])
  }

  private async appendManyUnderLease(
    expectedTail: TranscriptTail,
    entries: readonly ClaudeTranscriptEntry[],
  ): Promise<TranscriptAppendResult> {
    if (entries.length === 0) {
      throw new Error('Cannot append an empty Claude transcript batch')
    }
    const current = await this.load()
    if (!tailsMatch(current.tail, expectedTail)) {
      return { status: 'conflict', reason: 'tail-changed' }
    }
    if (!current.tail.newlineTerminated) {
      throw new Error('Claude transcript is not newline-terminated')
    }

    const history = [...current.entries]
    let logicalTailUuid = expectedTail.lastUuid
    const lines: string[] = []
    for (const entry of entries) {
      if (this.writeProfile === 'sidechain') {
        if (entry.parentUuid !== logicalTailUuid) {
          throw new Error('Sidechain entry parentUuid does not match tail')
        }
        const first = history[0]
        if (
          first &&
          (entry.sessionId !== first.sessionId ||
            entry.agentId !== first.agentId)
        ) {
          throw new Error('Sidechain entry identity does not match history')
        }
      } else if (entry.type === 'last-prompt') {
        if (entry.leafUuid !== logicalTailUuid) {
          throw new Error('Entry leafUuid does not match transcript tail')
        }
      } else if (entry.type === 'system') {
        if (
          entry.subtype !== 'compact_boundary' ||
          entry.parentUuid !== null ||
          !history.some(
            (candidate) => candidate.uuid === entry.logicalParentUuid,
          )
        ) {
          throw new Error(
            'Compact boundary logicalParentUuid does not reference transcript history',
          )
        }
      } else if (entry.type !== 'agent-setting') {
        if (entry.parentUuid !== logicalTailUuid) {
          throw new Error('Entry parentUuid does not match transcript tail')
        }
      }
      if (
        entry.type !== 'last-prompt' &&
        entry.type !== 'agent-setting' &&
        (typeof entry.uuid !== 'string' || entry.uuid.length === 0)
      ) {
        throw new Error('Appended Claude transcript entry must have a uuid')
      }
      if (this.writeProfile === 'main') validateLastPromptLeaf(history, entry)
      validateToolPairing(history, entry)
      lines.push(
        this.writeProfile === 'sidechain'
          ? this.schema.serializeForSidechainAppend(entry)
          : this.schema.serializeForAppend(entry),
      )
      history.push(entry)
      if (typeof entry.uuid === 'string') logicalTailUuid = entry.uuid
    }

    const encodedLine = Buffer.from(`${lines.join('\n')}\n`)
    await mkdir(dirname(this.sessionFile), { recursive: true })
    const sessionHandle = await open(this.sessionFile, 'a')
    try {
      const file = await sessionHandle.stat()
      if (file.size !== expectedTail.byteLength) {
        return { status: 'conflict', reason: 'tail-changed' }
      }
      await sessionHandle.writeFile(encodedLine)
      await sessionHandle.sync()
    } finally {
      await sessionHandle.close()
    }

    const written = await readFile(this.sessionFile)
    if (
      classifyTranscriptAppend(
        written,
        expectedTail.byteLength,
        encodedLine,
      ) === 'interleaved-write'
    ) {
      return { status: 'conflict', reason: 'interleaved-write' }
    }

    return { status: 'appended', tail: (await this.load()).tail }
  }

  private serializeNewSidechain(
    entries: readonly ClaudeTranscriptEntry[],
  ): string[] {
    const lines: string[] = []
    const history: ClaudeTranscriptEntry[] = []
    let logicalTailUuid: string | null = null
    for (const entry of entries) {
      if (entry.parentUuid !== logicalTailUuid) {
        throw new Error('Sidechain entry parentUuid does not match tail')
      }
      const first = history[0]
      if (
        first &&
        (entry.sessionId !== first.sessionId || entry.agentId !== first.agentId)
      ) {
        throw new Error('Sidechain entry identity does not match history')
      }
      validateToolPairing(history, entry)
      lines.push(this.schema.serializeForSidechainAppend(entry))
      history.push(entry)
      logicalTailUuid = typeof entry.uuid === 'string' ? entry.uuid : null
    }
    return lines
  }
}
