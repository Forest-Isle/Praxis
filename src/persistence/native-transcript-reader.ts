import { lstat, open, readFile } from 'node:fs/promises'
import { TextDecoder } from 'node:util'
import {
  diagnostic,
  type DecodedTranscriptRecord,
  type TranscriptCodecDiagnostic,
} from '../core/transcript-codec.js'
import { createNativeTranscriptCodec } from './native-transcript-codec.js'

export const NATIVE_TRANSCRIPT_INDEX_HEAD_BYTES = 64 * 1024
export const NATIVE_TRANSCRIPT_INDEX_TAIL_BYTES = 128 * 1024
export const NATIVE_TRANSCRIPT_INDEX_CONCURRENCY = 32
const MAX_PROBE_LINE_BYTES = 1024 * 1024
const CANONICAL_DECLARATION_PREFIX = Buffer.from(
  '{"schema":"praxis.transcript","version":',
)
const CANONICAL_EVENT_SEPARATOR = Buffer.from(',"event":')
const MAX_CANONICAL_DECLARATION_BYTES = 256
const UTF8 = new TextDecoder('utf-8', { fatal: true })
export interface TranscriptFileFacts {
  byteLength: number
  newlineTerminated: boolean
  updatedAt: string
}
export interface NativeTranscriptFullRead extends TranscriptFileFacts {
  format: 'native'
  codecId: string
  codecVersion: string | number
  records: readonly DecodedTranscriptRecord[]
  issue: TranscriptCodecDiagnostic | null
  validPrefixByteLength: number
  writeMode: 'read-only'
  raw: Buffer
}
export interface UnsupportedTranscriptFullRead extends TranscriptFileFacts {
  format: 'unsupported'
  raw: Buffer
}
export type TranscriptReadResult =
  NativeTranscriptFullRead | UnsupportedTranscriptFullRead
export interface NativeTranscriptIndex extends TranscriptFileFacts {
  format: 'native'
  codecId: string
  codecVersion: string | number
  records: readonly DecodedTranscriptRecord[]
  issue: TranscriptCodecDiagnostic | null
}
export interface UnsupportedTranscriptIndex extends TranscriptFileFacts {
  format: 'unsupported'
}
export type TranscriptIndexResult =
  NativeTranscriptIndex | UnsupportedTranscriptIndex
export interface NativeTranscriptIndexRequest {
  sessionId: string
  path: string
}
export type NativeTranscriptIndexResponse = NativeTranscriptIndexRequest &
  (
    | { result: TranscriptIndexResult; error?: never }
    | { result?: never; error: unknown }
  )
export class NativeTranscriptIndexCandidateError extends Error {
  override readonly name = 'NativeTranscriptIndexCandidateError'
}
function facts(
  size: number,
  mtime: Date,
  newlineTerminated: boolean,
): TranscriptFileFacts {
  return { byteLength: size, updatedAt: mtime.toISOString(), newlineTerminated }
}
function declaration(line: string): {
  declared: boolean
  version?: string | number
} {
  try {
    const value = JSON.parse(line) as Record<string, unknown>
    if (!value || value.schema !== 'praxis.transcript')
      return { declared: false }
    return {
      declared: true,
      version:
        typeof value.version === 'string' || typeof value.version === 'number'
          ? value.version
          : 0,
    }
  } catch {
    return { declared: false }
  }
}
function probe(
  source: Buffer,
  options: { allowUnterminated?: boolean; maxLineBytes?: number } = {},
): string | null {
  const maxLineBytes = options.maxLineBytes ?? MAX_PROBE_LINE_BYTES
  let start = 0
  while (start < source.length) {
    let end = source.indexOf(0x0a, start)
    if (end < 0) {
      if (!options.allowUnterminated) return null
      end = source.length
    }
    if (end - start > maxLineBytes) return null
    const line = source.subarray(start, end)
    start = end + 1
    if (!line.length) continue
    try {
      return UTF8.decode(line)
    } catch {
      return null
    }
  }
  return null
}
function canonicalPrefixDeclaration(source: Buffer): {
  declared: boolean
  version?: string | number
} {
  if (
    source.length < CANONICAL_DECLARATION_PREFIX.length ||
    !source
      .subarray(0, CANONICAL_DECLARATION_PREFIX.length)
      .equals(CANONICAL_DECLARATION_PREFIX)
  )
    return { declared: false }
  const declarationEnd = source.indexOf(
    CANONICAL_EVENT_SEPARATOR,
    CANONICAL_DECLARATION_PREFIX.length,
  )
  if (declarationEnd < 0 || declarationEnd > MAX_CANONICAL_DECLARATION_BYTES)
    return { declared: false }
  try {
    const version = JSON.parse(
      UTF8.decode(
        source.subarray(CANONICAL_DECLARATION_PREFIX.length, declarationEnd),
      ),
    ) as unknown
    return typeof version === 'string' || typeof version === 'number'
      ? { declared: true, version }
      : { declared: true, version: 0 }
  } catch {
    return { declared: true, version: 0 }
  }
}
function nativeResult(
  source: Buffer,
  metadata: { mtime: Date },
): NativeTranscriptFullRead | null {
  const line = probe(source, {
    allowUnterminated: true,
    maxLineBytes: Number.POSITIVE_INFINITY,
  })
  const parsed = line ? declaration(line) : { declared: false }
  const info = parsed.declared ? parsed : canonicalPrefixDeclaration(source)
  if (!info.declared) return null
  const version = info.version ?? 0
  const codec = createNativeTranscriptCodec(
    typeof version === 'number' ? version : 0,
  )
  const decoded = codec.decodeDocument(source)
  return {
    ...facts(
      source.length,
      metadata.mtime,
      source.length === 0 || source.at(-1) === 0x0a,
    ),
    format: 'native',
    codecId: codec.id,
    codecVersion: version,
    records: decoded.records,
    issue: decoded.issue,
    validPrefixByteLength: decoded.validPrefixByteLength,
    writeMode: 'read-only',
    raw: source,
  }
}
export async function readNativeTranscript(
  path: string,
): Promise<TranscriptReadResult> {
  const metadata = await lstat(path)
  if (!metadata.isFile()) throw new Error(`Expected a regular file: ${path}`)
  const source = await readFile(path)
  const native = nativeResult(source, metadata)
  if (native) return native
  return {
    ...facts(
      source.length,
      metadata.mtime,
      source.length === 0 || source.at(-1) === 0x0a,
    ),
    format: 'unsupported',
    raw: source,
  }
}
interface WindowLine {
  source: Buffer
  offset: number
  lineNumber: number | null
  terminated: boolean
}
function linesInWindow(
  source: Buffer,
  absoluteStart: number,
  discardLeading: boolean,
  discardTrailing: boolean,
  lineNumber: number | null,
): WindowLine[] {
  let start = 0
  if (discardLeading) {
    const newline = source.indexOf(0x0a)
    if (newline < 0) return []
    start = newline + 1
  }
  let end = source.length
  if (discardTrailing && source.at(-1) !== 0x0a) {
    const newline = source.lastIndexOf(0x0a)
    if (newline < start) return []
    end = newline + 1
  }
  const result: WindowLine[] = []
  let lineStart = start
  for (let i = start; i < end; i++)
    if (source[i] === 0x0a) {
      result.push({
        source: source.subarray(lineStart, i),
        offset: absoluteStart + lineStart,
        lineNumber: lineNumber === null ? null : lineNumber + result.length,
        terminated: true,
      })
      lineStart = i + 1
    }
  if (!discardTrailing && lineStart < end)
    result.push({
      source: source.subarray(lineStart, end),
      offset: absoluteStart + lineStart,
      lineNumber: lineNumber === null ? null : lineNumber + result.length,
      terminated: false,
    })
  return result
}
async function readWindow(
  handle: Awaited<ReturnType<typeof open>>,
  length: number,
  position: number,
): Promise<Buffer> {
  const buffer = Buffer.alloc(length)
  let total = 0
  while (total < length) {
    const { bytesRead } = await handle.read(
      buffer,
      total,
      length - total,
      position + total,
    )
    if (bytesRead === 0) break
    total += bytesRead
  }
  return buffer.subarray(0, total)
}
async function indexOne(path: string): Promise<TranscriptIndexResult> {
  const pathMetadata = await lstat(path)
  if (!pathMetadata.isFile())
    throw new NativeTranscriptIndexCandidateError(
      `Expected a regular file: ${path}`,
    )
  const handle = await open(path, 'r')
  try {
    const metadata = await handle.stat()
    const size = metadata.size
    const total =
      NATIVE_TRANSCRIPT_INDEX_HEAD_BYTES + NATIVE_TRANSCRIPT_INDEX_TAIL_BYTES
    const wholeFile = size <= total
    const headLength = wholeFile ? size : NATIVE_TRANSCRIPT_INDEX_HEAD_BYTES
    const head = await readWindow(handle, headLength, 0)
    const tailStart = wholeFile
      ? head.length
      : size - NATIVE_TRANSCRIPT_INDEX_TAIL_BYTES
    const tailLength = wholeFile ? 0 : NATIVE_TRANSCRIPT_INDEX_TAIL_BYTES
    const tail = await readWindow(handle, tailLength, tailStart)
    const tailStartsMidLine =
      !wholeFile && (await readWindow(handle, 1, tailStart - 1)).at(0) !== 0x0a
    const newlineTerminated =
      size === 0 || (tailLength ? tail.at(-1) === 0x0a : head.at(-1) === 0x0a)
    let first = probe(head, { allowUnterminated: wholeFile })
    if (first === null && !wholeFile) {
      const probeLength = Math.min(size, MAX_PROBE_LINE_BYTES + 1)
      first = probe(await readWindow(handle, probeLength, 0))
    }
    const parsed = first ? declaration(first) : { declared: false }
    const info = parsed.declared ? parsed : canonicalPrefixDeclaration(head)
    const file = facts(size, metadata.mtime, newlineTerminated)
    if (!info.declared) return { ...file, format: 'unsupported' }
    const version = info.version ?? 0
    const codec = createNativeTranscriptCodec(
      typeof version === 'number' ? version : 0,
    )
    if (version !== 1)
      return {
        ...file,
        format: 'native',
        codecId: codec.id,
        codecVersion: version,
        records: [],
        issue: diagnostic(
          'unsupported-version',
          `Unsupported native transcript version ${String(version)}`,
          0,
          1,
          { schemaVersion: version },
        ),
      }
    const records: DecodedTranscriptRecord[] = []
    let issue: TranscriptCodecDiagnostic | null = null
    const windows = !wholeFile
      ? [
          ...linesInWindow(head, 0, false, true, 1),
          ...linesInWindow(tail, tailStart, tailStartsMidLine, false, null),
        ]
      : linesInWindow(head, 0, false, false, 1)
    for (const line of windows) {
      let text: string
      try {
        text = UTF8.decode(line.source)
      } catch {
        if (!line.terminated) break
        issue = {
          kind: 'corrupt-line',
          message: 'Invalid UTF-8 transcript line',
          byteOffset: line.offset,
          lineNumber: line.lineNumber,
        }
        break
      }
      const decoded = codec.decodeLine(
        text,
        line.lineNumber ?? undefined,
        line.offset,
      )
      if (!decoded.ok) {
        if (!line.terminated)
          try {
            JSON.parse(text)
          } catch {
            break
          }
        issue = decoded.issue
        break
      }
      records.push(decoded.record)
    }
    return {
      ...file,
      format: 'native',
      codecId: codec.id,
      codecVersion: version,
      records,
      issue,
    }
  } finally {
    await handle.close()
  }
}
export async function readNativeTranscriptIndexes(
  requests: readonly NativeTranscriptIndexRequest[],
  concurrency = NATIVE_TRANSCRIPT_INDEX_CONCURRENCY,
): Promise<NativeTranscriptIndexResponse[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1)
    throw new Error(
      'Native transcript index concurrency must be a positive integer',
    )
  const result = new Array<NativeTranscriptIndexResponse>(requests.length)
  let next = 0
  const worker = async () => {
    while (next < requests.length) {
      const index = next++
      const request = requests[index]
      if (!request) continue
      try {
        result[index] = { ...request, result: await indexOne(request.path) }
      } catch (error) {
        result[index] = { ...request, error }
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, requests.length) }, worker),
  )
  return result
}
export async function exportNativeTranscript(path: string): Promise<Buffer> {
  const metadata = await lstat(path)
  if (!metadata.isFile()) throw new Error(`Expected a regular file: ${path}`)
  return readFile(path)
}
