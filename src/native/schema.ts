/**
 * Non-authoritative in-memory projection used by the session facade while it
 * is being migrated to TranscriptEvent records. Native persistence never
 * parses or serializes this shape; `praxis.transcript` v1 is handled by
 * NativeTranscriptCodec.
 */
export type NativeTranscriptEntry = Record<string, unknown> & {
  type: string
}
