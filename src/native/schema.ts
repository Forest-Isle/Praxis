/**
 * Non-authoritative in-memory projection used by the session facade while it
 * is being migrated to TranscriptEvent records. Native persistence never
 * parses or serializes this shape; `praxis.transcript` v1 is handled by
 * NativeTranscriptCodec.
 */
export type NativeTranscriptEntry = Record<string, unknown> & {
  type: string
}

const FORKABLE_ENTRY_TYPES = new Set([
  'agent-color',
  'agent-name',
  'agent-setting',
  'ai-title',
  'assistant',
  'attachment',
  'custom-title',
  'last-prompt',
  'mode',
  'permission-mode',
  'pr-link',
  'system',
  'user',
])

export function isNativeForkableEntryType(type: string): boolean {
  return FORKABLE_ENTRY_TYPES.has(type)
}

/** Copy only projection metadata; persisted native events are copied by
 * NativeSessionTranscript.forkTo and retain their event identity semantics. */
export function copyNativeEntryWithSessionId(
  entry: NativeTranscriptEntry,
  sessionId: string,
): NativeTranscriptEntry {
  return { ...entry, sessionId }
}
