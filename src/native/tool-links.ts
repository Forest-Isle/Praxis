import type { NativeTranscriptEntry } from './schema.js'
import { selectClaudeActiveTranscript } from './history.js'

export function getClaudeContentBlocks(
  entry: NativeTranscriptEntry,
): Record<string, unknown>[] {
  if (
    typeof entry.message !== 'object' ||
    entry.message === null ||
    Array.isArray(entry.message)
  ) {
    return []
  }
  const content = (entry.message as Record<string, unknown>).content
  if (!Array.isArray(content)) return []
  return content.filter(
    (block): block is Record<string, unknown> =>
      typeof block === 'object' && block !== null && !Array.isArray(block),
  )
}

export function indexClaudeToolLinks(
  entries: readonly NativeTranscriptEntry[],
): {
  toolCalls: Map<string, string>
  toolNames: Map<string, string>
  completedToolCalls: Set<string>
} {
  const toolCalls = new Map<string, string>()
  const toolNames = new Map<string, string>()
  const completedToolCalls = new Set<string>()

  for (const entry of entries) {
    for (const block of getClaudeContentBlocks(entry)) {
      if (
        entry.type === 'assistant' &&
        block.type === 'tool_use' &&
        typeof block.id === 'string' &&
        typeof entry.uuid === 'string'
      ) {
        toolCalls.set(block.id, entry.uuid)
        if (typeof block.name === 'string') toolNames.set(block.id, block.name)
      }
      if (
        entry.type === 'user' &&
        block.type === 'tool_result' &&
        typeof block.tool_use_id === 'string'
      ) {
        completedToolCalls.add(block.tool_use_id)
      }
    }
  }

  return { toolCalls, toolNames, completedToolCalls }
}

export function recoverClaudeToolResultLinks(
  entries: readonly NativeTranscriptEntry[],
): NativeTranscriptEntry[] {
  // Index each tool_use id to the uuid of its unique assistant entry. An id
  // declared by more than one assistant tool_use block, or by an assistant
  // entry without a string uuid, is ambiguous and is never recoverable.
  const assistantUuidById = new Map<string, string>()
  const assistantIdCounts = new Map<string, number>()
  for (const entry of entries) {
    if (entry.type !== 'assistant') continue
    for (const block of getClaudeContentBlocks(entry)) {
      if (block.type !== 'tool_use' || typeof block.id !== 'string') continue
      const count = (assistantIdCounts.get(block.id) ?? 0) + 1
      assistantIdCounts.set(block.id, count)
      if (count === 1 && typeof entry.uuid === 'string') {
        assistantUuidById.set(block.id, entry.uuid)
      } else {
        assistantUuidById.delete(block.id)
      }
    }
  }

  // Count every tool_result reference so a recovered link never duplicates a
  // result that was already completed elsewhere in the transcript.
  const resultIdCounts = new Map<string, number>()
  for (const entry of entries) {
    if (entry.type !== 'user') continue
    for (const block of getClaudeContentBlocks(entry)) {
      if (
        block.type !== 'tool_result' ||
        typeof block.tool_use_id !== 'string'
      ) {
        continue
      }
      resultIdCounts.set(
        block.tool_use_id,
        (resultIdCounts.get(block.tool_use_id) ?? 0) + 1,
      )
    }
  }

  const recovered: NativeTranscriptEntry[] = []
  for (const entry of entries) {
    if (
      entry.type === 'user' &&
      typeof entry.sourceToolAssistantUUID !== 'string'
    ) {
      const blocks = getClaudeContentBlocks(entry).filter(
        (block) => block.type === 'tool_result',
      )
      const sourceUuids = new Set<string>()
      let linkable = true
      for (const block of blocks) {
        // Malformed tool_result blocks (non-string tool_use_id) are never
        // recovered and prevent linking the whole entry.
        if (typeof block.tool_use_id !== 'string') {
          linkable = false
          break
        }
        const sourceUuid = assistantUuidById.get(block.tool_use_id)
        if (
          sourceUuid === undefined ||
          resultIdCounts.get(block.tool_use_id) !== 1
        ) {
          linkable = false
          break
        }
        sourceUuids.add(sourceUuid)
        // A single entry has one sourceToolAssistantUUID, so every recoverable
        // block must resolve to the same assistant entry.
        if (sourceUuids.size > 1) {
          linkable = false
          break
        }
      }
      if (linkable && sourceUuids.size === 1) {
        recovered.push({
          ...entry,
          sourceToolAssistantUUID: [...sourceUuids][0],
        })
        continue
      }
    }
    recovered.push(entry)
  }

  return recovered
}

export function findUnresolvedClaudeToolCalls(
  entries: readonly NativeTranscriptEntry[],
): { id: string; name: string; input: Record<string, unknown> }[] {
  const active = selectClaudeActiveTranscript(entries)
  const { completedToolCalls } = indexClaudeToolLinks(active)
  const unresolved = new Map<
    string,
    { id: string; name: string; input: Record<string, unknown> }
  >()
  for (const entry of active) {
    if (entry.type !== 'assistant') continue
    for (const block of getClaudeContentBlocks(entry)) {
      if (
        block.type === 'tool_use' &&
        typeof block.id === 'string' &&
        typeof block.name === 'string' &&
        typeof block.input === 'object' &&
        block.input !== null &&
        !Array.isArray(block.input) &&
        !completedToolCalls.has(block.id)
      ) {
        unresolved.set(block.id, {
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        })
      }
    }
  }
  return [...unresolved.values()]
}
