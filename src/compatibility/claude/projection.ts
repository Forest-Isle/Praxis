import type { ModelMessage, ModelToolCall } from '../../core/runtime.js'
import type { ClaudeTranscriptEntry } from './schema.js'

export interface ClaudeTextMessage {
  role: 'user' | 'assistant'
  content: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function projectClaudeTextMessages(
  entries: readonly ClaudeTranscriptEntry[],
): ClaudeTextMessage[] {
  const messages: ClaudeTextMessage[] = []
  for (const entry of entries) {
    if (!isRecord(entry.message)) continue
    const role = entry.message.role
    if (role !== 'user' && role !== 'assistant') continue
    const content = entry.message.content
    if (typeof content === 'string') {
      messages.push({ role, content })
      continue
    }
    if (!Array.isArray(content)) continue
    const text = content
      .filter(
        (block): block is Record<string, unknown> =>
          isRecord(block) && block.type === 'text',
      )
      .map((block) => block.text)
      .filter((value): value is string => typeof value === 'string')
      .join('')
    if (text.length > 0) messages.push({ role, content: text })
  }
  return messages
}

export function projectClaudeModelMessages(
  entries: readonly ClaudeTranscriptEntry[],
): ModelMessage[] {
  const messages: ModelMessage[] = []
  for (const entry of entries) {
    if (!isRecord(entry.message)) continue
    const role = entry.message.role
    const content = entry.message.content

    if (role === 'user') {
      if (typeof content === 'string') {
        messages.push({ role: 'user', content })
        continue
      }
      if (!Array.isArray(content)) continue
      const text = content
        .filter(
          (block): block is Record<string, unknown> =>
            isRecord(block) && block.type === 'text',
        )
        .map((block) => block.text)
        .filter((value): value is string => typeof value === 'string')
        .join('')
      if (text.length > 0) messages.push({ role: 'user', content: text })
      for (const block of content) {
        if (
          !isRecord(block) ||
          block.type !== 'tool_result' ||
          typeof block.tool_use_id !== 'string' ||
          typeof block.content !== 'string'
        ) {
          continue
        }
        messages.push({
          role: 'tool',
          toolCallId: block.tool_use_id,
          content: block.content,
          isError: block.is_error === true,
        })
      }
      continue
    }

    if (role !== 'assistant' || !Array.isArray(content)) continue
    const text = content
      .filter(
        (block): block is Record<string, unknown> =>
          isRecord(block) && block.type === 'text',
      )
      .map((block) => block.text)
      .filter((value): value is string => typeof value === 'string')
      .join('')
    const toolCalls: ModelToolCall[] = []
    for (const block of content) {
      if (
        !isRecord(block) ||
        block.type !== 'tool_use' ||
        typeof block.id !== 'string' ||
        typeof block.name !== 'string' ||
        !isRecord(block.input)
      ) {
        continue
      }
      toolCalls.push({
        id: block.id,
        name: block.name,
        input: block.input,
      })
    }
    if (text.length === 0 && toolCalls.length === 0) continue
    messages.push(
      toolCalls.length === 0
        ? { role: 'assistant', content: text }
        : { role: 'assistant', content: text, toolCalls },
    )
  }
  return messages
}

export function getClaudeLastPrompt(
  entries: readonly ClaudeTranscriptEntry[],
): string | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry?.type === 'last-prompt' && typeof entry.lastPrompt === 'string') {
      return entry.lastPrompt
    }
  }
  return null
}
