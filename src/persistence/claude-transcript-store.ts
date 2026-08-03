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

export type TranscriptAppendResult =
  | { status: 'appended'; tail: TranscriptTail }
  | { status: 'conflict'; reason: 'locked' | 'tail-changed' }

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

  async load(): Promise<TranscriptSnapshot> {
    let source: string
    try {
      source = await readFile(this.sessionFile, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
      source = ''
    }

    const content = source.endsWith('\n') ? source.slice(0, -1) : source
    const lines = content.length === 0 ? [] : content.split('\n')
    const entries = lines.map((line) => this.schema.parse(line))
    const lastLine = lines.at(-1)

    return {
      entries,
      tail: {
        byteLength: Buffer.byteLength(source),
        lastLineHash: lastLine === undefined ? null : hashLine(lastLine),
        lastUuid: findLogicalTailUuid(entries),
        newlineTerminated: source.length === 0 || source.endsWith('\n'),
      },
    }
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
      await mkdir(dirname(this.sessionFile), { recursive: true })
      const sessionHandle = await open(this.sessionFile, 'a')
      try {
        const file = await sessionHandle.stat()
        if (file.size !== expectedTail.byteLength) {
          return { status: 'conflict', reason: 'tail-changed' }
        }
        await sessionHandle.writeFile(`${line}\n`, { encoding: 'utf8' })
        await sessionHandle.sync()
      } finally {
        await sessionHandle.close()
      }

      return { status: 'appended', tail: (await this.load()).tail }
    } finally {
      await lockHandle.close()
      await rm(this.lockFile)
    }
  }
}
