import { createHash } from 'node:crypto'
import { mkdir, open, readFile, rm } from 'node:fs/promises'
import { dirname } from 'node:path'

import type {
  ClaudeSchemaAdapter,
  ClaudeTranscriptEntry,
} from '../compatibility/claude/schema.js'

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

export interface ClaudeTranscriptStoreOptions {
  sessionFile: string
  lockFile: string
  schema: ClaudeSchemaAdapter
}

function hashLine(line: string): string {
  return createHash('sha256').update(line).digest('hex')
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

export class ClaudeTranscriptStore {
  private readonly sessionFile: string
  private readonly lockFile: string
  private readonly schema: ClaudeSchemaAdapter

  constructor(options: ClaudeTranscriptStoreOptions) {
    this.sessionFile = options.sessionFile
    this.lockFile = options.lockFile
    this.schema = options.schema
  }

  private async readSource(): Promise<string> {
    let source: string
    try {
      source = await readFile(this.sessionFile, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
      source = ''
    }

    return source
  }

  private parseSource(source: string, recover: boolean): TranscriptRecovery {
    const content = source.endsWith('\n') ? source.slice(0, -1) : source
    const lines = content.length === 0 ? [] : content.split('\n')
    const entries: ClaudeTranscriptEntry[] = []
    let issue: TranscriptParseIssue | null = null
    let byteOffset = 0

    for (const [index, line] of lines.entries()) {
      try {
        entries.push(this.schema.parse(line))
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
      byteOffset += Buffer.byteLength(line) + 1
    }
    const lastLine = lines.at(-1)

    return {
      entries,
      issue,
      tail: {
        byteLength: Buffer.byteLength(source),
        lastLineHash: lastLine === undefined ? null : hashLine(lastLine),
        lastUuid: findLogicalTailUuid(entries),
        newlineTerminated: source.length === 0 || source.endsWith('\n'),
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

  async append(
    expectedTail: TranscriptTail,
    entry: ClaudeTranscriptEntry,
  ): Promise<TranscriptAppendResult> {
    if (entry.parentUuid !== expectedTail.lastUuid) {
      throw new Error('Entry parentUuid does not match transcript tail')
    }
    if (typeof entry.uuid !== 'string' || entry.uuid.length === 0) {
      throw new Error('Appended Claude transcript entry must have a uuid')
    }

    await mkdir(dirname(this.lockFile), { recursive: true })

    let lockHandle
    try {
      lockHandle = await open(this.lockFile, 'wx')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        return { status: 'conflict', reason: 'locked' }
      }
      throw error
    }

    try {
      const current = await this.load()
      if (!tailsMatch(current.tail, expectedTail)) {
        return { status: 'conflict', reason: 'tail-changed' }
      }
      if (!current.tail.newlineTerminated) {
        throw new Error('Claude transcript is not newline-terminated')
      }

      const line = this.schema.serializeForAppend(entry)
      const encodedLine = Buffer.from(`${line}\n`)
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
      const expectedEnd = expectedTail.byteLength + encodedLine.length
      if (
        written.length !== expectedEnd ||
        !written
          .subarray(expectedTail.byteLength, expectedEnd)
          .equals(encodedLine)
      ) {
        return { status: 'conflict', reason: 'interleaved-write' }
      }

      return { status: 'appended', tail: (await this.load()).tail }
    } finally {
      await lockHandle.close()
      await rm(this.lockFile)
    }
  }
}
