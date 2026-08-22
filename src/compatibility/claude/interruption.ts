import type { ClaudeTranscriptEntry } from './schema.js'
import { selectClaudeActiveTranscript } from './history.js'

export type ClaudeInterruptionClassification =
  | { kind: 'complete' }
  | { kind: 'none' }
  | {
      kind: 'interrupted-prompt' | 'interrupted-turn'
      prompt?: string
      replayEntries?: ClaudeTranscriptEntry[]
      replayParentUuid?: string | null
    }

export const CLAUDE_INTERRUPTED_TURN_CONTINUATION =
  'Continue the interrupted turn using the available tool results and context.'

const PASSIVE_METADATA_TYPES = new Set([
  'agent-color',
  'agent-name',
  'agent-setting',
  'ai-title',
  'custom-title',
  'file-history-delta',
  'file-history-snapshot',
  'last-prompt',
  'mode',
  'permission-mode',
  'pr-link',
  'queue-operation',
  'relocated',
  'tag',
  'worktree-state',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function contentBlocks(
  entry: ClaudeTranscriptEntry,
): Record<string, unknown>[] {
  if (!isRecord(entry.message) || !Array.isArray(entry.message.content)) {
    return []
  }
  return entry.message.content.filter(isRecord)
}

function plainUserPrompt(entry: ClaudeTranscriptEntry): string | undefined {
  if (
    entry.type !== 'user' ||
    entry.isMeta === true ||
    entry.isCompactSummary === true ||
    !isRecord(entry.message) ||
    entry.message.role !== 'user'
  ) {
    return undefined
  }
  if (typeof entry.message.content === 'string') {
    const prompt = entry.message.content.trim()
    if (
      prompt.length === 0 ||
      /^<(?:command-name|local-command-caveat|local-command-stdout)>/u.test(
        prompt,
      )
    ) {
      return undefined
    }
    return entry.message.content
  }
  if (!Array.isArray(entry.message.content)) return undefined
  const blocks = entry.message.content.filter(isRecord)
  if (blocks.some((block) => block.type === 'tool_result')) return undefined
  const text = blocks
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => String(block.text))
    .join('')
  return text.trim().length === 0 ? undefined : text
}

function continuationState(
  entries: readonly ClaudeTranscriptEntry[],
  throughIndex: number,
): {
  prompt: string
  replayEntries: ClaudeTranscriptEntry[]
  replayParentUuid: string | null
} {
  const replayEntries = entries.slice(0, throughIndex + 1)
  const replayParentUuid = [...replayEntries]
    .reverse()
    .find((entry) => typeof entry.uuid === 'string')?.uuid
  return {
    prompt: CLAUDE_INTERRUPTED_TURN_CONTINUATION,
    replayEntries,
    replayParentUuid:
      typeof replayParentUuid === 'string' ? replayParentUuid : null,
  }
}

function assistantHasVisibleText(entry: ClaudeTranscriptEntry): boolean {
  if (!isRecord(entry.message) || entry.message.role !== 'assistant') {
    return false
  }
  if (typeof entry.message.content === 'string') {
    return entry.message.content.trim().length > 0
  }
  return contentBlocks(entry).some(
    (block) =>
      block.type === 'text' &&
      typeof block.text === 'string' &&
      block.text.trim().length > 0,
  )
}

function terminalToolResult(entry: ClaudeTranscriptEntry): boolean {
  if (entry.toolDenialKind !== undefined) return true
  const blocks = contentBlocks(entry).filter(
    (block) => block.type === 'tool_result',
  )
  return (
    blocks.length > 0 &&
    blocks.every(
      (block) =>
        block.is_error === true &&
        typeof block.content === 'string' &&
        /(?:user (?:rejected|declined)|doesn't want to proceed|interrupted)/iu.test(
          block.content,
        ),
    )
  )
}

/** Classifies only model-visible active-tail state; passive metadata never
 * creates a phantom continuation. */
export function classifyClaudeInterruption(
  source: readonly ClaudeTranscriptEntry[],
): ClaudeInterruptionClassification {
  const entries = selectClaudeActiveTranscript(source)
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (!entry || entry.isSidechain === true) continue
    if (PASSIVE_METADATA_TYPES.has(entry.type)) continue

    if (entry.type === 'assistant') {
      if (
        entry.isApiErrorMessage === true ||
        entry.synthetic === true ||
        entry.error === true
      ) {
        return { kind: 'none' }
      }
      if (assistantHasVisibleText(entry)) return { kind: 'complete' }
      // Thinking-only, whitespace, and unresolved tool-use-only assistants do
      // not hide the user prompt that was interrupted before a valid answer.
      continue
    }

    if (entry.type === 'user') {
      if (entry.isCompactSummary === true) return { kind: 'none' }
      const blocks = contentBlocks(entry)
      if (blocks.some((block) => block.type === 'tool_result')) {
        if (terminalToolResult(entry)) return { kind: 'none' }
        return {
          kind: 'interrupted-turn',
          ...continuationState(entries, index),
        }
      }
      const prompt = plainUserPrompt(entry)
      if (prompt !== undefined) {
        return {
          kind: 'interrupted-prompt',
          prompt,
          replayEntries: entries.slice(0, index),
          replayParentUuid:
            typeof entry.parentUuid === 'string' ? entry.parentUuid : null,
        }
      }
      return { kind: 'none' }
    }

    if (entry.type === 'attachment') {
      return {
        kind: 'interrupted-turn',
        ...continuationState(entries, index),
      }
    }
    if (
      entry.type === 'system' &&
      (entry.subtype === 'compact_boundary' ||
        entry.subtype === 'api_error' ||
        entry.subtype === 'local_command')
    ) {
      return { kind: 'none' }
    }
  }
  return { kind: 'none' }
}
