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
