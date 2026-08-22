import { createHash } from 'node:crypto'
import { lstat, open } from 'node:fs/promises'
import { TextDecoder } from 'node:util'

import type {
  ClaudeSchemaAdapter,
  ClaudeTranscriptEntry,
} from '../compatibility/claude/schema.js'
import type { TranscriptParseIssue } from './claude-transcript-store.js'
import type { TranscriptTail } from './claude-transcript-store.js'
import { isClaudeDurableLastPromptSnapshot } from '../compatibility/claude/history.js'

export const CLAUDE_SESSION_INDEX_HEAD_BYTES = 64 * 1024
export const CLAUDE_SESSION_INDEX_TAIL_BYTES = 128 * 1024
export const CLAUDE_SESSION_INDEX_CONCURRENCY = 32

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })

export interface ClaudeSessionIndex {
  entries: ClaudeTranscriptEntry[]
  tailEntries: ClaudeTranscriptEntry[]
  issue: TranscriptParseIssue | null
  byteLength: number
  newlineTerminated: boolean
  updatedAt: string
  tail: TranscriptTail
}

function logicalTailUuid(
  entries: readonly ClaudeTranscriptEntry[],
): string | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (!entry) continue
    if (
      entry.type === 'last-prompt' &&
      isClaudeDurableLastPromptSnapshot(entries, index)
    ) {
      continue
    }
    if (typeof entry.uuid === 'string') return entry.uuid
    if (typeof entry.leafUuid === 'string') return entry.leafUuid
  }
  return null
}

export interface ClaudeSessionIndexRequest {
  sessionId: string
  path: string
}

export type ClaudeSessionIndexResult = ClaudeSessionIndexRequest &
  (
    | { index: ClaudeSessionIndex; error?: never }
    | { index?: never; error: unknown }
  )

export class ClaudeSessionIndexCandidateError extends Error {
  override readonly name = 'ClaudeSessionIndexCandidateError'
}

interface WindowLine {
  source: Buffer
  byteOffset: number
  lineNumber: number | null
  tail: boolean
}

function completeLines(
  source: Buffer,
  absoluteStart: number,
  discardLeadingPartial: boolean,
  discardTrailingPartial: boolean,
  lineNumberStart: number | null,
  tail: boolean,
): WindowLine[] {
  let start = 0
  if (discardLeadingPartial) {
    const newline = source.indexOf(0x0a)
    if (newline < 0) return []
    start = newline + 1
  }
  let end = source.length
  if (discardTrailingPartial && source.at(-1) !== 0x0a) {
    const newline = source.lastIndexOf(0x0a)
    if (newline < start) return []
    end = newline + 1
  }

  const lines: WindowLine[] = []
  let lineStart = start
  for (let index = start; index < end; index += 1) {
    if (source[index] !== 0x0a) continue
    if (index > lineStart) {
      lines.push({
        source: source.subarray(lineStart, index),
        byteOffset: absoluteStart + lineStart,
        lineNumber:
          lineNumberStart === null ? null : lineNumberStart + lines.length,
        tail,
      })
    }
    lineStart = index + 1
  }
  if (!discardTrailingPartial && lineStart < end) {
    lines.push({
      source: source.subarray(lineStart, end),
      byteOffset: absoluteStart + lineStart,
      lineNumber:
        lineNumberStart === null ? null : lineNumberStart + lines.length,
      tail,
    })
  }
  return lines
}

async function readWindow(
  handle: Awaited<ReturnType<typeof open>>,
  length: number,
  position: number,
): Promise<Buffer> {
  const buffer = Buffer.alloc(length)
  const { bytesRead } = await handle.read(buffer, 0, length, position)
  return buffer.subarray(0, bytesRead)
}

/**
 * Reads only bounded head/tail windows for session discovery. A partial final
 * line is treated as an in-progress append and ignored. Full JSONL and graph
 * validation remains the responsibility of inspect/resume.
 */
export async function readClaudeSessionIndex(
  path: string,
  schema: ClaudeSchemaAdapter,
): Promise<ClaudeSessionIndex> {
  const pathMetadata = await lstat(path)
  if (!pathMetadata.isFile())
    throw new ClaudeSessionIndexCandidateError(
      `Expected a regular file: ${path}`,
    )
  const handle = await open(path, 'r')
  try {
    const metadata = await handle.stat()
    const byteLength = metadata.size
    const wholeFileThreshold =
      CLAUDE_SESSION_INDEX_HEAD_BYTES + CLAUDE_SESSION_INDEX_TAIL_BYTES
    let lines: WindowLine[]
    let newlineTerminated = true

    if (byteLength <= wholeFileThreshold) {
      const source = await readWindow(handle, byteLength, 0)
      newlineTerminated = source.length === 0 || source.at(-1) === 0x0a
      lines = completeLines(source, 0, false, !newlineTerminated, 1, true)
    } else {
      const head = await readWindow(handle, CLAUDE_SESSION_INDEX_HEAD_BYTES, 0)
      const tailStart = byteLength - CLAUDE_SESSION_INDEX_TAIL_BYTES
      const tail = await readWindow(
        handle,
        CLAUDE_SESSION_INDEX_TAIL_BYTES,
        tailStart,
      )
      newlineTerminated = tail.length === 0 || tail.at(-1) === 0x0a
      lines = [
        ...completeLines(head, 0, false, true, 1, false),
        ...completeLines(tail, tailStart, true, !newlineTerminated, null, true),
      ]
    }

    const entries: ClaudeTranscriptEntry[] = []
    const tailEntries: ClaudeTranscriptEntry[] = []
    let issue: TranscriptParseIssue | null = null
    for (const line of lines) {
      try {
        const entry = schema.parse(UTF8_DECODER.decode(line.source))
        entries.push(entry)
        if (line.tail) tailEntries.push(entry)
      } catch (error) {
        issue = {
          lineNumber: line.lineNumber,
          byteOffset: line.byteOffset,
          message: error instanceof Error ? error.message : String(error),
        }
        break
      }
    }

    return {
      entries,
      tailEntries,
      issue,
      byteLength,
      newlineTerminated,
      updatedAt: metadata.mtime.toISOString(),
      tail: {
        byteLength,
        lastLineHash:
          lines.at(-1) === undefined
            ? null
            : createHash('sha256')
                .update(lines.at(-1)?.source ?? Buffer.alloc(0))
                .digest('hex'),
        lastUuid: logicalTailUuid(entries),
        newlineTerminated,
      },
    }
  } finally {
    await handle.close()
  }
}

/** Reads a discovery set with a fixed worker pool so large projects cannot
 * exhaust the process file-descriptor limit. Results preserve input order. */
export async function readClaudeSessionIndexes(
  requests: readonly ClaudeSessionIndexRequest[],
  schema: ClaudeSchemaAdapter,
  concurrency = CLAUDE_SESSION_INDEX_CONCURRENCY,
): Promise<ClaudeSessionIndexResult[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error(
      'Claude session index concurrency must be a positive integer',
    )
  }
  const results = new Array<ClaudeSessionIndexResult>(requests.length)
  let nextIndex = 0
  const worker = async () => {
    while (nextIndex < requests.length) {
      const index = nextIndex
      nextIndex += 1
      const request = requests[index]
      if (request === undefined) continue
      try {
        results[index] = {
          ...request,
          index: await readClaudeSessionIndex(request.path, schema),
        }
      } catch (error) {
        results[index] = { ...request, error }
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, requests.length) }, async () =>
      worker(),
    ),
  )
  return results
}
