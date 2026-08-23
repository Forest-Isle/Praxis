import type { TranscriptEvent } from './transcript-event.js'

export type TranscriptCodecDiagnostic =
  | {
      kind: 'unsupported-version'
      lineNumber: number | null
      byteOffset: number
      message: string
      schemaVersion: string | number
    }
  | {
      kind: 'corrupt-line'
      lineNumber: number | null
      byteOffset: number
      message: string
      schemaVersion?: string | number
    }
  | {
      kind: 'unsupported-event'
      lineNumber: number | null
      byteOffset: number
      message: string
      eventKind?: string
    }

export interface OpaquePreservationToken {
  readonly __opaqueToken: unique symbol
}
type TokenPayload = {
  owner: symbol
  raw: string
  eventFingerprint: string
}
export type PreservationTokenSource = {
  owner: symbol
  raw: string
  event: TranscriptEvent
}
const tokenPayloads = new WeakMap<object, TokenPayload>()
export function createPreservationToken(
  owner: symbol,
  source: PreservationTokenSource,
): OpaquePreservationToken {
  const token = Object.freeze({})
  tokenPayloads.set(token, {
    owner: source.owner,
    raw: source.raw,
    eventFingerprint: JSON.stringify(source.event),
  })
  return token as OpaquePreservationToken
}
export function readPreservationToken(
  token: OpaquePreservationToken,
  owner: symbol,
): TokenPayload | null {
  const payload = tokenPayloads.get(token as object)
  return payload?.owner === owner ? payload : null
}
export interface DecodedTranscriptRecord {
  readonly event: TranscriptEvent
  readonly preservation?: OpaquePreservationToken
}
export type TranscriptLineResult =
  | { ok: true; record: DecodedTranscriptRecord }
  | { ok: false; issue: TranscriptCodecDiagnostic }
export type TranscriptEncodeResult =
  { ok: true; line: string } | { ok: false; issue: TranscriptCodecDiagnostic }
export interface TranscriptDocumentResult {
  readonly records: readonly DecodedTranscriptRecord[]
  readonly issue: TranscriptCodecDiagnostic | null
  readonly validPrefixByteLength: number
}
export interface TranscriptCodec {
  readonly id: string
  readonly version: string | number
  readonly writeMode: 'read-only' | 'read-write'
  decodeLine(
    line: string,
    lineNumber?: number,
    byteOffset?: number,
  ): TranscriptLineResult
  encodeLine(
    event: TranscriptEvent,
    preservation?: OpaquePreservationToken,
  ): TranscriptEncodeResult
  decodeDocument(source: string | Uint8Array): TranscriptDocumentResult
}

export function diagnostic(
  kind: TranscriptCodecDiagnostic['kind'],
  message: string,
  byteOffset: number,
  lineNumber: number | null,
  extra: Partial<TranscriptCodecDiagnostic> = {},
): TranscriptCodecDiagnostic {
  return {
    kind,
    message,
    byteOffset,
    lineNumber,
    ...extra,
  } as TranscriptCodecDiagnostic
}

export function decodeDocumentWith(
  codec: TranscriptCodec,
  source: string | Uint8Array,
): TranscriptDocumentResult {
  const bytes =
    typeof source === 'string' ? new TextEncoder().encode(source) : source
  const lines: { bytes: Uint8Array; terminatorBytes: number }[] = []
  let start = 0
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x0a) {
      lines.push({ bytes: bytes.subarray(start, i), terminatorBytes: 1 })
      start = i + 1
    }
  }
  if (start < bytes.length) {
    lines.push({ bytes: bytes.subarray(start), terminatorBytes: 0 })
  }
  const records: DecodedTranscriptRecord[] = []
  let offset = 0
  for (const [index, sourceLine] of lines.entries()) {
    const bytesLine = sourceLine.bytes
    let line: string
    try {
      line = new TextDecoder('utf-8', { fatal: true }).decode(bytesLine)
    } catch {
      return {
        records,
        issue: diagnostic(
          'corrupt-line',
          'Invalid UTF-8 transcript line',
          offset,
          index + 1,
        ),
        validPrefixByteLength: offset,
      }
    }
    const result = codec.decodeLine(line, index + 1, offset)
    if (!result.ok)
      return { records, issue: result.issue, validPrefixByteLength: offset }
    records.push(result.record)
    offset += bytesLine.length + sourceLine.terminatorBytes
  }
  return { records, issue: null, validPrefixByteLength: offset }
}
