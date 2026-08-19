import { createHash } from 'node:crypto'
import { mkdir, open, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { TextDecoder } from 'node:util'

import type {
  ClaudeSchemaAdapter,
  ClaudeTranscriptEntry,
} from '../compatibility/claude/schema.js'
import {
  getClaudeContentBlocks,
  indexClaudeToolLinks,
  recoverClaudeToolResultLinks,
} from '../compatibility/claude/tool-links.js'
import { ExclusiveFileLease } from '../platform/exclusive-file-lease.js'

export interface TranscriptTail {
  byteLength: number
  lastLineHash: string | null
  lastUuid: string | null
  newlineTerminated: boolean
  branchParentUuid?: string
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

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })
const NON_TAIL_ENTRY_TYPES = new Set([
  'agent-color',
  'agent-name',
  'agent-setting',
  'custom-title',
  'file-history-delta',
  'file-history-snapshot',
  'permission-mode',
  'pr-link',
  'queue-operation',
  'relocated',
  'worktree-state',
])

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

function tailsMatch(left: TranscriptTail, right: TranscriptTail): boolean {
  return (
    left.byteLength === right.byteLength &&
    left.lastLineHash === right.lastLineHash &&
    left.lastUuid === right.lastUuid &&
    left.newlineTerminated === right.newlineTerminated
  )
}

function tailLogicalUuid(tail: TranscriptTail): string | null {
  return tail.branchParentUuid ?? tail.lastUuid
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
  const isNativeLocalCommandLeaf =
    leaf?.type === 'system' &&
    leaf.subtype === 'local_command' &&
    typeof leaf.content === 'string' &&
    leaf.content.startsWith('<local-command-stdout>') &&
    entry.lastPrompt === undefined
  if (leaf?.type !== 'assistant' && !isNativeLocalCommandLeaf) {
    throw new Error(
      'Claude last-prompt must reference the final assistant leaf',
    )
  }
  if (leaf?.sessionId !== entry.sessionId) {
    throw new Error(
      'Claude last-prompt and leaf must belong to the same session',
    )
  }
}

export class ClaudeTranscriptStore {
  private readonly sessionFile: string
  private readonly lease: ExclusiveFileLease
  private readonly schema: ClaudeSchemaAdapter
  private readonly writeProfile: 'main' | 'sidechain'

  constructor(options: ClaudeTranscriptStoreOptions) {
    this.sessionFile = options.sessionFile
    this.lease = new ExclusiveFileLease(options.lockFile)
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
    return { entries: recoverClaudeToolResultLinks(entries), tail }
  }

  async loadReadOnly(): Promise<TranscriptRecovery> {
    const recovery = this.parseSource(await this.readSource(), true)
    return {
      ...recovery,
      entries: recoverClaudeToolResultLinks(recovery.entries),
    }
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
    const lock = await this.lease.tryAcquire()
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
      await lock.release()
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
    let logicalTailUuid = tailLogicalUuid(expectedTail)
    const branchParentUuid = expectedTail.branchParentUuid
    let advancedLogicalTail = false
    let staleLastPromptLeaf = false
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
          staleLastPromptLeaf = true
          continue
        }
      } else if (
        entry.type === 'system' &&
        entry.subtype === 'compact_boundary'
      ) {
        if (
          entry.parentUuid !== null ||
          !history.some(
            (candidate) => candidate.uuid === entry.logicalParentUuid,
          )
        ) {
          throw new Error(
            'Compact boundary logicalParentUuid does not reference transcript history',
          )
        }
      } else if (!NON_TAIL_ENTRY_TYPES.has(entry.type)) {
        if (entry.parentUuid !== logicalTailUuid) {
          throw new Error('Entry parentUuid does not match transcript tail')
        }
      }
      if (
        entry.type !== 'last-prompt' &&
        !NON_TAIL_ENTRY_TYPES.has(entry.type) &&
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
      if (
        typeof entry.uuid === 'string' &&
        !NON_TAIL_ENTRY_TYPES.has(entry.type)
      ) {
        logicalTailUuid = entry.uuid
        advancedLogicalTail = true
      }
    }

    if (staleLastPromptLeaf) {
      return { status: 'conflict', reason: 'tail-changed' }
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

    const tail = (await this.load()).tail
    return {
      status: 'appended',
      tail:
        branchParentUuid === undefined || advancedLogicalTail
          ? tail
          : { ...tail, branchParentUuid },
    }
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
