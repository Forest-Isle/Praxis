import type {
  ModelDocument,
  ModelDocumentMediaType,
  ModelContentBlock,
  ModelImage,
  ModelImageMediaType,
  ModelMessage,
  ModelThinkingBlock,
  ModelToolCall,
} from '../../core/runtime.js'
import type { ClaudeTranscriptEntry } from './schema.js'
import { selectClaudeActiveTranscript } from './history.js'

export interface ClaudeTextMessage {
  role: 'user' | 'assistant'
  content: string
}

function compactedEntries(
  entries: readonly ClaudeTranscriptEntry[],
): readonly ClaudeTranscriptEntry[] {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]?.isCompactSummary === true) return entries.slice(index)
  }
  return entries
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const IMAGE_MEDIA_TYPES = new Set<ModelImageMediaType>([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
])
const DOCUMENT_MEDIA_TYPES = new Set<ModelDocumentMediaType>([
  'application/pdf',
  'text/plain',
  'text/markdown',
  'application/json',
])

function projectToolResultContent(content: unknown): {
  content: string
  contentBlocks: ModelContentBlock[]
  images: ModelImage[]
  documents: ModelDocument[]
} | null {
  if (typeof content === 'string') {
    return {
      content,
      contentBlocks: [],
      images: [],
      documents: [],
    }
  }
  if (!Array.isArray(content)) return null
  const parts: string[] = []
  const contentBlocks: ModelContentBlock[] = []
  const images: ModelImage[] = []
  const documents: ModelDocument[] = []
  for (const block of content) {
    if (!isRecord(block)) {
      parts.push('[structured tool result omitted]')
      continue
    }
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
      contentBlocks.push({ type: 'text', text: block.text })
      continue
    }
    if (
      block.type === 'image' &&
      isRecord(block.source) &&
      block.source.type === 'base64' &&
      typeof block.source.media_type === 'string' &&
      IMAGE_MEDIA_TYPES.has(block.source.media_type as ModelImageMediaType) &&
      typeof block.source.data === 'string'
    ) {
      const image = {
        type: 'image',
        mediaType: block.source.media_type as ModelImageMediaType,
        data: block.source.data,
      } as const
      images.push(image)
      contentBlocks.push(image)
      continue
    }
    if (
      block.type === 'document' &&
      isRecord(block.source) &&
      block.source.type === 'base64' &&
      typeof block.source.media_type === 'string' &&
      DOCUMENT_MEDIA_TYPES.has(
        block.source.media_type as ModelDocumentMediaType,
      ) &&
      typeof block.source.data === 'string'
    ) {
      const document = {
        type: 'document',
        mediaType: block.source.media_type as ModelDocumentMediaType,
        data: block.source.data,
      } as const
      documents.push(document)
      contentBlocks.push(document)
      continue
    }
    parts.push(`[${String(block.type ?? 'structured')} tool result omitted]`)
  }
  return {
    content:
      parts.join('\n') ||
      (images.length > 0 || documents.length > 0
        ? ''
        : '[empty structured tool result]'),
    contentBlocks:
      images.length > 0 || documents.length > 0 ? contentBlocks : [],
    images,
    documents,
  }
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
  for (const entry of compactedEntries(selectClaudeActiveTranscript(entries))) {
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
  const active = selectClaudeActiveTranscript(entries)
  const compacted = compactedEntries(active)
  const messages: ModelMessage[] = active.flatMap((entry) => {
    const attachmentContext = projectNestedMemory(entry)
    return attachmentContext === null || attachmentContext.length === 0
      ? []
      : [{ role: 'system' as const, content: attachmentContext }]
  })
  messages.push(
    ...compacted.flatMap((entry) => {
      const hookContext = projectHookContext(entry)
      return hookContext === null || hookContext.length === 0
        ? []
        : [{ role: 'system' as const, content: hookContext }]
    }),
  )
  for (const entry of compacted) {
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
      const images = content.flatMap((block): ModelImage[] => {
        if (
          !isRecord(block) ||
          block.type !== 'image' ||
          !isRecord(block.source) ||
          block.source.type !== 'base64' ||
          typeof block.source.media_type !== 'string' ||
          !IMAGE_MEDIA_TYPES.has(
            block.source.media_type as ModelImageMediaType,
          ) ||
          typeof block.source.data !== 'string'
        )
          return []
        return [
          {
            type: 'image',
            mediaType: block.source.media_type as ModelImageMediaType,
            data: block.source.data,
          },
        ]
      })
      const documents = content.flatMap((block): ModelDocument[] => {
        if (
          !isRecord(block) ||
          block.type !== 'document' ||
          !isRecord(block.source) ||
          block.source.type !== 'base64' ||
          typeof block.source.media_type !== 'string' ||
          !DOCUMENT_MEDIA_TYPES.has(
            block.source.media_type as ModelDocumentMediaType,
          ) ||
          typeof block.source.data !== 'string'
        )
          return []
        return [
          {
            type: 'document',
            mediaType: block.source.media_type as ModelDocumentMediaType,
            data: block.source.data,
          },
        ]
      })
      if (text.length > 0 || images.length > 0 || documents.length > 0) {
        messages.push({
          role: 'user',
          content: text,
          ...(images.length > 0 ? { images } : {}),
          ...(documents.length > 0 ? { documents } : {}),
        })
      }
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
          content: toolContent.content,
          ...(Array.isArray(entry.toolUseResult) &&
          toolContent.contentBlocks.length > 0
            ? { contentBlocks: toolContent.contentBlocks }
            : {}),
          ...(toolContent.images.length > 0
            ? { images: toolContent.images }
            : {}),
          ...(toolContent.documents.length > 0
            ? { documents: toolContent.documents }
            : {}),
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
    const thinkingBlocks: ModelThinkingBlock[] = []
    for (const block of content) {
      if (
        isRecord(block) &&
        block.type === 'thinking' &&
        typeof block.thinking === 'string' &&
        typeof block.signature === 'string'
      ) {
        thinkingBlocks.push({
          type: 'thinking',
          thinking: block.thinking,
          signature: block.signature,
        })
        continue
      }
      if (
        isRecord(block) &&
        block.type === 'redacted_thinking' &&
        typeof block.data === 'string'
      ) {
        thinkingBlocks.push({ type: 'redacted_thinking', data: block.data })
        continue
      }
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
    if (
      text.length === 0 &&
      toolCalls.length === 0 &&
      thinkingBlocks.length === 0
    )
      continue
    messages.push(
      toolCalls.length === 0
        ? {
            role: 'assistant',
            content: text,
            ...(thinkingBlocks.length > 0 ? { thinkingBlocks } : {}),
          }
        : {
            role: 'assistant',
            content: text,
            ...(thinkingBlocks.length > 0 ? { thinkingBlocks } : {}),
            toolCalls,
          },
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
