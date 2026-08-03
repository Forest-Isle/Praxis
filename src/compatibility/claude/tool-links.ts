import type { ClaudeTranscriptEntry } from './schema.js'

export function getClaudeContentBlocks(
  entry: ClaudeTranscriptEntry,
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
  entries: readonly ClaudeTranscriptEntry[],
): {
  toolCalls: Map<string, string>
  completedToolCalls: Set<string>
} {
  const toolCalls = new Map<string, string>()
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

  return { toolCalls, completedToolCalls }
}

export function findUnresolvedClaudeToolCalls(
  entries: readonly ClaudeTranscriptEntry[],
): { id: string; name: string; input: Record<string, unknown> }[] {
  const { completedToolCalls } = indexClaudeToolLinks(entries)
  const unresolved = new Map<
    string,
    { id: string; name: string; input: Record<string, unknown> }
  >()
  for (const entry of entries) {
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
