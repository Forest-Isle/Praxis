import type { ModelMessage, ModelToolCall } from '../../core/runtime.js'
import type { ClaudeTranscriptEntry } from './schema.js'

export interface ClaudeTextMessage {
  role: 'user' | 'assistant'
  content: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function projectToolResultContent(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  const parts = content.flatMap((block) => {
    if (!isRecord(block)) return []
    if (block.type === 'text' && typeof block.text === 'string') {
      return [block.text]
    }
    if (block.type === 'image') {
      return ['[image tool result omitted: unsupported media]']
    }
    return [`[${String(block.type ?? 'structured')} tool result omitted]`]
  })
  return parts.join('\n') || '[empty structured tool result]'
}

function projectNestedMemory(entry: ClaudeTranscriptEntry): string | null {
  if (entry.type !== 'attachment' || !isRecord(entry.attachment)) return null
  if (
    entry.attachment.type !== 'nested_memory' ||
    !isRecord(entry.attachment.content) ||
    typeof entry.attachment.content.content !== 'string'
  ) {
    return null
  }
  return entry.attachment.content.content
}

function projectHookContext(entry: ClaudeTranscriptEntry): string | null {
  if (entry.type !== 'attachment' || !isRecord(entry.attachment)) return null
  if (
    entry.attachment.type === 'hook_success' &&
    typeof entry.attachment.content === 'string'
  ) {
    return entry.attachment.content || null
  }
  if (
    entry.attachment.type === 'hook_additional_context' &&
    Array.isArray(entry.attachment.content)
  ) {
    const content = entry.attachment.content.filter(
      (value): value is string => typeof value === 'string',
    )
    return content.join('\n') || null
  }
  return null
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
  const messages: ModelMessage[] = entries.flatMap((entry) => {
    const attachmentContext =
      projectNestedMemory(entry) ?? projectHookContext(entry)
    return attachmentContext === null || attachmentContext.length === 0
      ? []
      : [{ role: 'system' as const, content: attachmentContext }]
  })
  for (const entry of entries) {
    if (
      projectNestedMemory(entry) !== null ||
      projectHookContext(entry) !== null
    ) {
      continue
    }
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
          typeof block.tool_use_id !== 'string'
        ) {
          continue
        }
        const toolContent = projectToolResultContent(block.content)
        if (toolContent === null) continue
        messages.push({
          role: 'tool',
          toolCallId: block.tool_use_id,
          content: toolContent,
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

export function getClaudeAgentSetting(
  entries: readonly ClaudeTranscriptEntry[],
): string | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (
      entry?.type === 'agent-setting' &&
      typeof entry.agentSetting === 'string' &&
      entry.agentSetting.length > 0
    ) {
      return entry.agentSetting
    }
  }
  return null
}
