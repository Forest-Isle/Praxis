import {
  isTranscriptEvent,
  type TranscriptEvent,
} from '../core/transcript-event.js'
import {
  createPreservationToken,
  readPreservationToken,
  decodeDocumentWith,
  diagnostic,
  type OpaquePreservationToken,
  type TranscriptCodec,
  type TranscriptDocumentResult,
  type TranscriptEncodeResult,
  type TranscriptLineResult,
} from '../core/transcript-codec.js'

const TOKEN_ID = Symbol('praxis.native.transcript.v1')

export class NativeTranscriptCodec implements TranscriptCodec {
  readonly id = 'praxis.transcript'
  readonly version: number
  readonly writeMode: 'read-only' | 'read-write'
  constructor(version: number = 1) {
    this.version = version
    this.writeMode = version === 1 ? 'read-write' : 'read-only'
  }
  decodeLine(
    line: string,
    lineNumber = 1,
    byteOffset = 0,
  ): TranscriptLineResult {
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      return {
        ok: false,
        issue: diagnostic(
          'corrupt-line',
          'Invalid JSON transcript line',
          byteOffset,
          lineNumber,
          { schemaVersion: this.version },
        ),
      }
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      return {
        ok: false,
        issue: diagnostic(
          'corrupt-line',
          'Transcript line must be an object',
          byteOffset,
          lineNumber,
          { schemaVersion: this.version },
        ),
      }
    const object = value as Record<string, unknown>
    if (
      object.schema !== this.id ||
      (typeof object.version !== 'number' && typeof object.version !== 'string')
    )
      return {
        ok: false,
        issue: diagnostic(
          'corrupt-line',
          'Invalid native transcript envelope',
          byteOffset,
          lineNumber,
          { schemaVersion: this.version },
        ),
      }
    if (object.version !== 1)
      return {
        ok: false,
        issue: diagnostic(
          'unsupported-version',
          `Unsupported native transcript version ${String(object.version)}`,
          byteOffset,
          lineNumber,
          { schemaVersion: object.version },
        ),
      }
    if (!isTranscriptEvent(object.event))
      return {
        ok: false,
        issue: diagnostic(
          'unsupported-event',
          'Invalid or unsupported TranscriptEvent',
          byteOffset,
          lineNumber,
          typeof object.event === 'object' && object.event !== null
            ? {
                eventKind: String(
                  (object.event as Record<string, unknown>).kind ?? '',
                ),
              }
            : {},
        ),
      }
    return {
      ok: true,
      record: {
        event: object.event,
        preservation: createPreservationToken(TOKEN_ID, {
          owner: TOKEN_ID,
          raw: line,
          event: object.event,
        }),
      },
    }
  }
  encodeLine(
    event: TranscriptEvent,
    preservation?: OpaquePreservationToken,
  ): TranscriptEncodeResult {
    if (this.writeMode === 'read-only')
      return {
        ok: false,
        issue: diagnostic(
          'unsupported-version',
          'Native codec is read-only',
          0,
          null,
          { schemaVersion: this.version },
        ),
      }
    if (!isTranscriptEvent(event))
      return {
        ok: false,
        issue: diagnostic(
          'unsupported-event',
          'Invalid TranscriptEvent',
          0,
          null,
          typeof event === 'object' && event !== null
            ? {
                eventKind: String(
                  (event as Record<string, unknown>).kind ?? '',
                ),
              }
            : {},
        ),
      }
    if (preservation) {
      const token = readPreservationToken(preservation, TOKEN_ID)
      if (!token)
        return {
          ok: false,
          issue: diagnostic(
            'unsupported-event',
            'Preservation token belongs to another codec',
            0,
            null,
          ),
        }
      return {
        ok: true,
        line:
          token.eventFingerprint === JSON.stringify(event)
            ? token.raw
            : JSON.stringify({ schema: this.id, version: 1, event }),
      }
    }
    return {
      ok: true,
      line: JSON.stringify({ schema: this.id, version: 1, event }),
    }
  }
  decodeDocument(source: string | Uint8Array): TranscriptDocumentResult {
    return decodeDocumentWith(this, source)
  }
}

export function createNativeTranscriptCodec(
  version = 1,
): NativeTranscriptCodec {
  return new NativeTranscriptCodec(version)
}
