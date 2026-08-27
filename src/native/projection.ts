import type {
  ModelDocument,
  ModelDocumentMediaType,
  ModelContentBlock,
  ModelImage,
  ModelImageMediaType,
  ModelMessage,
  ModelThinkingBlock,
  ModelToolCall,
} from '../core/runtime.js'
import type { NativeTranscriptEntry } from './schema.js'
import { selectClaudeActiveTranscript } from './history.js'
import { parseClaudeCompactSummary } from './compaction.js'

export interface ClaudeTextMessage {
  role: 'user' | 'assistant'
  content: string
}

export type ClaudeDisplayTranscriptItem =
  | { kind: 'user' | 'assistant' | 'thinking'; text: string }
  | { kind: 'compact'; summary: string }
  | { kind: 'tool'; call: ModelToolCall; detail: string }
  | { kind: 'tool-result'; callId: string; text: string; isError: boolean }
  | { kind: 'shell'; callId: string; command: string }
  | {
      kind: 'shell-result'
      callId: string
      stdout: string
      stderr: string
      isError: boolean
    }

function compactedEntries(
  entries: readonly NativeTranscriptEntry[],
): readonly NativeTranscriptEntry[] {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const summary = entries[index]
    if (summary?.isCompactSummary !== true) continue
    const metadata = summary.summarizeMetadata
    if (
      typeof metadata === 'object' &&
      metadata !== null &&
      (metadata as Record<string, unknown>).direction === 'from'
    ) {
      const boundary = entries.find(
        (entry) => entry.uuid === summary.parentUuid,
      )
      const compactMetadata = boundary?.compactMetadata
      const segment =
        typeof compactMetadata === 'object' && compactMetadata !== null
          ? (compactMetadata as Record<string, unknown>).preservedSegment
          : undefined
      const headUuid =
        typeof segment === 'object' && segment !== null
          ? (segment as Record<string, unknown>).headUuid
          : undefined
      const preservedStart = entries.findIndex(
        (entry) => entry.uuid === headUuid,
      )
      return entries.slice(preservedStart >= 0 ? preservedStart : index)
    }
    return entries.slice(index)
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

function textBlocks(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(
      (block): block is Record<string, unknown> =>
        isRecord(block) &&
        block.type === 'text' &&
        typeof block.text === 'string',
    )
    .map((block) => block.text as string)
    .join('')
}

function bashEnvelope(
  content: unknown,
):
  | { kind: 'input'; command: string }
  | { kind: 'output'; stdout: string; stderr: string }
  | null {
  if (typeof content !== 'string') return null
  const input = /^<bash-input>([\s\S]*)<\/bash-input>$/u.exec(content)
  if (input) return { kind: 'input', command: input[1] ?? '' }
  const output =
    /^<bash-stdout>([\s\S]*)<\/bash-stdout><bash-stderr>([\s\S]*)<\/bash-stderr>$/u.exec(
      content,
    )
  return output
    ? { kind: 'output', stdout: output[1] ?? '', stderr: output[2] ?? '' }
    : null
}

/** Projects the active Claude JSONL branch into read-only CLI display items. */
export function projectClaudeDisplayTranscript(
  entries: readonly NativeTranscriptEntry[],
): ClaudeDisplayTranscriptItem[] {
  const items: ClaudeDisplayTranscriptItem[] = []
  let pendingShell: { callId: string; command: string } | null = null

  for (const entry of compactedEntries(selectClaudeActiveTranscript(entries))) {
    if (!isRecord(entry.message)) continue
    const role = entry.message.role
    const content = entry.message.content

    if (role === 'user') {
      if (entry.isCompactSummary === true && typeof content === 'string') {
        const summary = parseClaudeCompactSummary(content)
        if (summary !== null) items.push({ kind: 'compact', summary })
        continue
      }
      const shell = bashEnvelope(content)
      if (shell?.kind === 'input') {
        pendingShell = {
          callId:
            typeof entry.uuid === 'string'
              ? entry.uuid
              : `shell-${items.length}`,
          command: shell.command,
        }
        items.push({ kind: 'shell', ...pendingShell })
        continue
      }
      if (shell?.kind === 'output' && pendingShell) {
        items.push({
          kind: 'shell-result',
          callId: pendingShell.callId,
          stdout: shell.stdout,
          stderr: shell.stderr,
          isError: shell.stderr.length > 0,
        })
        pendingShell = null
        continue
      }
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!isRecord(block) || block.type !== 'tool_result') continue
          if (typeof block.tool_use_id !== 'string') continue
          const projected = projectToolResultContent(block.content)
          items.push({
            kind: 'tool-result',
            callId: block.tool_use_id,
            text: projected?.content ?? '[structured tool result omitted]',
            isError: block.is_error === true,
          })
        }
      }
      if (typeof entry.sourceToolAssistantUUID === 'string') continue
      const text = textBlocks(content)
      if (text) items.push({ kind: 'user', text })
      continue
    }

    if (role !== 'assistant' || !Array.isArray(content)) continue
    for (const block of content) {
      if (!isRecord(block)) continue
      if (block.type === 'thinking' && typeof block.thinking === 'string') {
        if (block.thinking)
          items.push({ kind: 'thinking', text: block.thinking })
        continue
      }
      if (block.type === 'text' && typeof block.text === 'string') {
        if (block.text) items.push({ kind: 'assistant', text: block.text })
        continue
      }
      if (
        block.type === 'tool_use' &&
        typeof block.id === 'string' &&
        typeof block.name === 'string' &&
        isRecord(block.input)
      ) {
        items.push({
          kind: 'tool',
          call: { id: block.id, name: block.name, input: block.input },
          detail: '',
        })
      }
    }
  }
  return items
}

function projectNestedMemory(entry: NativeTranscriptEntry): string | null {
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

function projectHookContext(entry: NativeTranscriptEntry): string | null {
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
  entries: readonly NativeTranscriptEntry[],
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
  entries: readonly NativeTranscriptEntry[],
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

function sidechainToolResultReplacements(
  entries: readonly NativeTranscriptEntry[],
): Map<string, string> {
  const replacements = new Map<string, string>()
  for (const entry of entries) {
    if (
      entry.type !== 'content-replacement' ||
      !Array.isArray(entry.replacements)
    ) {
      continue
    }
    for (const replacement of entry.replacements) {
      if (
        isRecord(replacement) &&
        replacement.kind === 'tool-result' &&
        typeof replacement.toolUseId === 'string' &&
        typeof replacement.replacement === 'string'
      ) {
        replacements.set(replacement.toolUseId, replacement.replacement)
      }
    }
  }
  return replacements
}

/** Builds restart/SendMessage context without mutating the retained sidechain.
 * Only complete tool call/result pairs survive. Ambiguous duplicate IDs fail
 * locally because silently choosing one could resume the wrong operation. */
export function projectClaudeSidechainContinuationMessages(
  entries: readonly NativeTranscriptEntry[],
): ModelMessage[] {
  const messages = projectClaudeModelMessages(entries)
  const callCounts = new Map<string, number>()
  const resultCounts = new Map<string, number>()
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const call of message.toolCalls ?? []) {
        callCounts.set(call.id, (callCounts.get(call.id) ?? 0) + 1)
      }
    } else if (message.role === 'tool') {
      resultCounts.set(
        message.toolCallId,
        (resultCounts.get(message.toolCallId) ?? 0) + 1,
      )
    }
  }
  for (const [toolUseId, count] of callCounts) {
    if (count > 1) {
      throw new Error(
        `Claude sidechain continuation has duplicate tool ID ${toolUseId}`,
      )
    }
  }
  for (const [toolUseId, count] of resultCounts) {
    if (count > 1) {
      throw new Error(
        `Claude sidechain continuation has duplicate tool result ${toolUseId}`,
      )
    }
  }
  const pairedToolIds = new Set(
    [...callCounts.keys()].filter(
      (toolUseId) => resultCounts.get(toolUseId) === 1,
    ),
  )
  const replacements = sidechainToolResultReplacements(entries)
  return messages.flatMap((message): ModelMessage[] => {
    if (message.role === 'assistant') {
      const toolCalls = (message.toolCalls ?? []).filter((call) =>
        pairedToolIds.has(call.id),
      )
      if (message.content.trim().length === 0 && toolCalls.length === 0) {
        return []
      }
      return [
        {
          role: 'assistant',
          content: message.content,
          ...(message.thinkingBlocks
            ? { thinkingBlocks: message.thinkingBlocks }
            : {}),
          ...(toolCalls.length === 0 ? {} : { toolCalls }),
        },
      ]
    }
    if (message.role === 'tool') {
      if (!pairedToolIds.has(message.toolCallId)) return []
      const replacement = replacements.get(message.toolCallId)
      return [
        replacement === undefined
          ? message
          : {
              role: 'tool',
              toolCallId: message.toolCallId,
              content: replacement,
              isError: message.isError,
            },
      ]
    }
    return [message]
  })
}

export function getClaudeLastPrompt(
  entries: readonly NativeTranscriptEntry[],
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
  entries: readonly NativeTranscriptEntry[],
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
