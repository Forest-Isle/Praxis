import {
  isModelDocument,
  isModelImage,
  isTranscriptEvent,
  type TranscriptEvent,
  type TranscriptMessagesEvent,
} from '../../core/transcript-event.js'
import type {
  ModelContentBlock,
  ModelDocument,
  ModelImage,
  ModelMessage,
} from '../../core/runtime.js'
import {
  formatClaudeCompactSummary,
  parseClaudeCompactSummary,
} from './compaction.js'
import {
  selectClaudeSchemaAdapter,
  type ClaudeTranscriptEntry,
} from './schema.js'
import {
  createPreservationToken,
  readPreservationToken,
  decodeDocumentWith,
  diagnostic,
  type OpaquePreservationToken,
  type TranscriptCodec,
  type TranscriptDocumentResult,
  type TranscriptEncodeResult,
  type TranscriptLineResult,
} from '../../core/transcript-codec.js'

const TOKEN_ID = Symbol('claude.transcript')
export interface ClaudeTranscriptCodecOptions {
  version: string
  cwd: string
  gitBranch?: string | null
  entrypoint?: string
}
const isString = (value: unknown): value is string => typeof value === 'string'
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const decodeIdentity = (
  entry: ClaudeTranscriptEntry,
): {
  id: string
  parentId: string | null
  sessionId: string
  timestamp: string
} | null => {
  if (
    !isString(entry.uuid) ||
    !isString(entry.sessionId) ||
    !isString(entry.timestamp) ||
    !isString(entry.version) ||
    !Object.prototype.hasOwnProperty.call(entry, 'parentUuid')
  )
    return null
  if (entry.parentUuid !== null && !isString(entry.parentUuid)) return null
  return {
    id: entry.uuid,
    parentId: entry.parentUuid as string | null,
    sessionId: entry.sessionId,
    timestamp: entry.timestamp,
  }
}
function decodeMediaBlock(
  block: Record<string, unknown>,
): ModelImage | ModelDocument | null {
  if (
    (block.type !== 'image' && block.type !== 'document') ||
    !isRecord(block.source) ||
    block.source.type !== 'base64' ||
    !isString(block.source.media_type) ||
    !isString(block.source.data)
  )
    return null
  const media = {
    type: block.type,
    mediaType: block.source.media_type as ModelDocument['mediaType'],
    data: block.source.data,
  }
  return isModelImage(media) || isModelDocument(media) ? media : null
}
function decodeContentBlocks(
  content: readonly unknown[],
): { content: string; contentBlocks: ModelContentBlock[] } | null {
  if (content.length === 0) return null
  const contentBlocks: ModelContentBlock[] = []
  let contentText = ''
  for (const raw of content) {
    if (!isRecord(raw)) return null
    if (raw.type === 'text' && isString(raw.text)) {
      contentText += raw.text
      contentBlocks.push({ type: 'text', text: raw.text })
      continue
    }
    const media = decodeMediaBlock(raw)
    if (!media) return null
    contentBlocks.push(media)
  }
  return { content: contentText, contentBlocks }
}
function userEvent(entry: ClaudeTranscriptEntry): TranscriptEvent | null {
  const identity = decodeIdentity(entry)
  if (!identity || !isRecord(entry.message) || entry.message.role !== 'user')
    return null
  const content = entry.message.content
  if (isString(content)) {
    return {
      kind: 'messages',
      ...identity,
      messages: [{ role: 'user', content }],
    }
  }
  if (!Array.isArray(content) || content.length === 0) return null
  const messages: ModelMessage[] = []
  let pendingUserBlocks: ModelContentBlock[] = []
  const flushUser = () => {
    if (pendingUserBlocks.length === 0) return
    messages.push({
      role: 'user',
      content: pendingUserBlocks
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join(''),
      contentBlocks: pendingUserBlocks,
    })
    pendingUserBlocks = []
  }
  for (const raw of content) {
    if (!isRecord(raw)) return null
    if (raw.type === 'tool_result' && isString(raw.tool_use_id)) {
      flushUser()
      if (isString(raw.content)) {
        messages.push({
          role: 'tool',
          toolCallId: raw.tool_use_id,
          content: raw.content,
          isError: raw.is_error === true,
        })
        continue
      }
      if (!Array.isArray(raw.content)) return null
      const decoded = decodeContentBlocks(raw.content)
      if (!decoded) return null
      messages.push({
        role: 'tool',
        toolCallId: raw.tool_use_id,
        ...decoded,
        isError: raw.is_error === true,
      })
      continue
    }
    if (raw.type === 'text' && isString(raw.text)) {
      pendingUserBlocks.push({ type: 'text', text: raw.text })
      continue
    }
    const media = decodeMediaBlock(raw)
    if (!media) return null
    pendingUserBlocks.push(media)
  }
  flushUser()
  return messages.length ? { kind: 'messages', ...identity, messages } : null
}
function assistantEvent(entry: ClaudeTranscriptEntry): TranscriptEvent | null {
  const identity = decodeIdentity(entry)
  if (
    !identity ||
    !isRecord(entry.message) ||
    entry.message.role !== 'assistant' ||
    !Array.isArray(entry.message.content)
  )
    return null
  let content = ''
  const thinkingBlocks: (
    | { type: 'thinking'; thinking: string; signature: string }
    | { type: 'redacted_thinking'; data: string }
  )[] = []
  const toolCalls: {
    id: string
    name: string
    input: Record<string, unknown>
  }[] = []
  for (const raw of entry.message.content) {
    if (!isRecord(raw)) return null
    if (raw.type === 'text' && isString(raw.text)) content += raw.text
    else if (
      raw.type === 'thinking' &&
      isString(raw.thinking) &&
      isString(raw.signature)
    )
      thinkingBlocks.push({
        type: 'thinking',
        thinking: raw.thinking,
        signature: raw.signature,
      })
    else if (raw.type === 'redacted_thinking' && isString(raw.data))
      thinkingBlocks.push({ type: 'redacted_thinking', data: raw.data })
    else if (
      raw.type === 'tool_use' &&
      isString(raw.id) &&
      isString(raw.name) &&
      isRecord(raw.input)
    )
      toolCalls.push({ id: raw.id, name: raw.name, input: raw.input })
    else return null
  }
  let result: TranscriptMessagesEvent = {
    kind: 'messages',
    ...identity,
    messages: [
      {
        role: 'assistant',
        content,
        ...(thinkingBlocks.length ? { thinkingBlocks } : {}),
        ...(toolCalls.length ? { toolCalls } : {}),
      },
    ],
  }
  if (isString(entry.message.model))
    result = { ...result, model: entry.message.model }
  const stop = entry.message.stop_reason
  if (stop === 'end_turn' || stop === 'tool_use' || stop === 'max_tokens')
    result = { ...result, terminalReason: stop }
  return result
}

function encodeMediaBlock(media: ModelImage | ModelDocument) {
  return {
    type: media.type,
    source: {
      type: 'base64',
      media_type: media.mediaType,
      data: media.data,
    },
  }
}

function encodeCanonicalContent(
  message: Extract<ModelMessage, { role: 'user' | 'tool' }>,
): Record<string, unknown>[] {
  if (message.contentBlocks !== undefined) {
    const textContent = message.contentBlocks
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('')
    if (textContent !== message.content) {
      throw new Error('Canonical content blocks disagree with message content')
    }
    const images = message.contentBlocks.filter(
      (block): block is ModelImage => block.type === 'image',
    )
    const documents = message.contentBlocks.filter(
      (block): block is ModelDocument => block.type === 'document',
    )
    if (
      (message.images !== undefined &&
        JSON.stringify(message.images) !== JSON.stringify(images)) ||
      (message.documents !== undefined &&
        JSON.stringify(message.documents) !== JSON.stringify(documents))
    ) {
      throw new Error(
        'Canonical content blocks disagree with message media arrays',
      )
    }
    return message.contentBlocks.map((block) =>
      block.type === 'text'
        ? { type: 'text', text: block.text }
        : encodeMediaBlock(block),
    )
  }

  const blocks: Record<string, unknown>[] = []
  if (message.content.length > 0)
    blocks.push({ type: 'text', text: message.content })
  blocks.push(
    ...(message.images ?? []).map(encodeMediaBlock),
    ...(message.documents ?? []).map(encodeMediaBlock),
  )
  return blocks
}

function encodeUserBatch(
  event: TranscriptMessagesEvent,
): ClaudeTranscriptEntry {
  if (event.model !== undefined || event.terminalReason !== undefined) {
    throw new Error('User and tool batches cannot carry assistant metadata')
  }
  if (
    event.messages.length === 1 &&
    event.messages[0]?.role === 'user' &&
    event.messages[0].contentBlocks === undefined &&
    event.messages[0].images === undefined &&
    event.messages[0].documents === undefined
  ) {
    return {
      type: 'user',
      message: { role: 'user', content: event.messages[0].content },
    }
  }

  const content: Record<string, unknown>[] = []
  let previousWasUser = false
  for (const message of event.messages) {
    if (message.role === 'user') {
      if (previousWasUser) {
        throw new Error(
          'Adjacent user messages cannot be represented by one Claude entry',
        )
      }
      const blocks = encodeCanonicalContent(message)
      if (blocks.length === 0) {
        throw new Error(
          'An empty user message cannot be represented inside a Claude batch',
        )
      }
      content.push(...blocks)
      previousWasUser = true
      continue
    }
    if (message.role !== 'tool') {
      throw new Error('Claude message batches must be all user/tool messages')
    }
    const blocks = encodeCanonicalContent(message)
    if (blocks.some((block) => block.type !== 'text')) {
      throw new Error(
        'Claude tool media requires provider metadata unavailable in TranscriptEvent',
      )
    }
    content.push({
      type: 'tool_result',
      tool_use_id: message.toolCallId,
      content:
        message.contentBlocks === undefined &&
        (message.images?.length ?? 0) === 0 &&
        (message.documents?.length ?? 0) === 0
          ? message.content
          : blocks,
      is_error: message.isError,
    })
    previousWasUser = false
  }
  return { type: 'user', message: { role: 'user', content } }
}

function emptyAssistantUsage() {
  return {
    input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
    server_tool_use: {
      web_search_requests: 0,
      web_fetch_requests: 0,
    },
    service_tier: 'standard',
    cache_creation: {
      ephemeral_1h_input_tokens: 0,
      ephemeral_5m_input_tokens: 0,
    },
    inference_geo: '',
  }
}

function encodeAssistant(
  event: TranscriptMessagesEvent,
): ClaudeTranscriptEntry {
  if (event.messages.length !== 1 || event.messages[0]?.role !== 'assistant') {
    throw new Error('A Claude assistant entry requires one assistant message')
  }
  if (!event.model) {
    throw new Error('A Claude assistant entry requires a model')
  }
  if (event.terminalReason === 'prompt_too_long') {
    throw new Error('prompt_too_long is not a persisted assistant terminal')
  }
  const message = event.messages[0]
  const content: Record<string, unknown>[] = [...(message.thinkingBlocks ?? [])]
  if (message.content.length > 0)
    content.push({ type: 'text', text: message.content })
  content.push(
    ...(message.toolCalls ?? []).map((call) => ({
      type: 'tool_use',
      id: call.id,
      name: call.name,
      input: call.input,
    })),
  )
  if (content.length === 0) {
    throw new Error('A Claude assistant entry requires persisted content')
  }
  return {
    type: 'assistant',
    message: {
      id: event.id,
      type: 'message',
      role: 'assistant',
      model: event.model,
      content,
      stop_reason:
        event.terminalReason ??
        (message.toolCalls?.length ? 'tool_use' : 'end_turn'),
      stop_sequence: null,
      usage: emptyAssistantUsage(),
      stop_details: null,
    },
  }
}

export class ClaudeTranscriptCodec implements TranscriptCodec {
  readonly id = 'claude'
  readonly version: string
  readonly writeMode: 'read-only' | 'read-write'
  private readonly adapter
  constructor(private readonly options: ClaudeTranscriptCodecOptions) {
    this.version = options.version
    this.adapter = selectClaudeSchemaAdapter(options.version)
    this.writeMode = this.adapter.writeMode
  }
  decodeLine(
    line: string,
    lineNumber = 1,
    byteOffset = 0,
  ): TranscriptLineResult {
    let entry: ClaudeTranscriptEntry
    try {
      entry = this.adapter.parse(line)
    } catch (error) {
      return {
        ok: false,
        issue: diagnostic(
          'corrupt-line',
          error instanceof Error
            ? error.message
            : 'Invalid Claude transcript line',
          byteOffset,
          lineNumber,
          { schemaVersion: this.version },
        ),
      }
    }
    const identity = decodeIdentity(entry)
    let event: TranscriptEvent | null = null
    if (
      entry.type === 'system' &&
      entry.subtype === 'compact_boundary' &&
      identity &&
      isString(entry.logicalParentUuid) &&
      isRecord(entry.compactMetadata)
    ) {
      const m = entry.compactMetadata as Record<string, unknown>
      if (
        (m.trigger === 'auto' || m.trigger === 'manual') &&
        typeof m.preTokens === 'number' &&
        typeof m.postTokens === 'number' &&
        typeof m.durationMs === 'number' &&
        [m.preTokens, m.postTokens, m.durationMs].every(
          (v) => Number.isFinite(v) && v >= 0,
        )
      )
        event = {
          kind: 'context-boundary',
          ...identity,
          logicalParentId: entry.logicalParentUuid,
          trigger: m.trigger,
          preTokens: m.preTokens,
          postTokens: m.postTokens,
          durationMs: m.durationMs,
        }
    } else if (
      entry.type === 'user' &&
      entry.isCompactSummary === true &&
      isRecord(entry.message) &&
      isString(entry.message.content) &&
      identity
    ) {
      const summary = parseClaudeCompactSummary(entry.message.content)
      if (summary !== null)
        event = { kind: 'context-summary', ...identity, summary }
    } else if (entry.type === 'user') event = userEvent(entry)
    else if (entry.type === 'assistant') event = assistantEvent(entry)
    if (!event || !isTranscriptEvent(event))
      return {
        ok: false,
        issue: diagnostic(
          'unsupported-event',
          `Unsupported Claude transcript entry type ${entry.type}`,
          byteOffset,
          lineNumber,
          { eventKind: entry.type },
        ),
      }
    return {
      ok: true,
      record: {
        event,
        preservation: createPreservationToken(TOKEN_ID, {
          owner: TOKEN_ID,
          raw: line,
          event,
        }),
      },
    }
  }
  encodeLine(
    event: TranscriptEvent,
    preservation?: OpaquePreservationToken,
  ): TranscriptEncodeResult {
    if (this.writeMode === 'read-only')
      return {
        ok: false,
        issue: diagnostic(
          'unsupported-version',
          `Unsupported Claude Code transcript version ${this.version}`,
          0,
          null,
          { schemaVersion: this.version },
        ),
      }
    if (!isTranscriptEvent(event))
      return {
        ok: false,
        issue: diagnostic(
          'unsupported-event',
          'Invalid TranscriptEvent',
          0,
          null,
        ),
      }
    if (preservation) {
      const token = readPreservationToken(preservation, TOKEN_ID)
      if (!token)
        return {
          ok: false,
          issue: diagnostic(
            'unsupported-event',
            'Preservation token belongs to another codec',
            0,
            null,
          ),
        }
      if (token.eventFingerprint === JSON.stringify(event))
        return { ok: true, line: token.raw }
    }
    const common = {
      uuid: event.id,
      parentUuid: event.parentId,
      sessionId: event.sessionId,
      timestamp: event.timestamp,
      cwd: this.options.cwd,
      version: this.version,
      gitBranch: this.options.gitBranch ?? null,
      isSidechain: false,
      userType: 'external',
      entrypoint: this.options.entrypoint ?? 'cli',
    }
    let entry: ClaudeTranscriptEntry
    if (event.kind === 'context-summary')
      entry = {
        ...common,
        type: 'user',
        promptId: event.id,
        isCompactSummary: true,
        isVisibleInTranscriptOnly: true,
        message: {
          role: 'user',
          content: formatClaudeCompactSummary(event.summary),
        },
      }
    else if (event.kind === 'context-boundary') {
      if (event.parentId !== null)
        return {
          ok: false,
          issue: diagnostic(
            'unsupported-event',
            'Claude compact boundaries require a null parent',
            0,
            null,
            { eventKind: event.kind },
          ),
        }
      entry = {
        ...common,
        type: 'system',
        subtype: 'compact_boundary',
        content: 'Conversation compacted',
        parentUuid: null,
        isMeta: false,
        level: 'info',
        logicalParentUuid: event.logicalParentId,
        compactMetadata: {
          trigger: event.trigger,
          preTokens: event.preTokens,
          postTokens: event.postTokens,
          durationMs: event.durationMs,
          cumulativeDroppedTokens: Math.max(
            0,
            event.preTokens - event.postTokens,
          ),
          preservedSegment: {
            headUuid: event.logicalParentId,
            anchorUuid: event.logicalParentId,
            tailUuid: event.logicalParentId,
          },
          preservedMessages: {
            anchorUuid: event.logicalParentId,
            uuids: [event.logicalParentId],
            allUuids: [event.logicalParentId],
          },
        },
      }
    } else
      try {
        entry = {
          ...common,
          ...(event.messages[0]?.role === 'assistant'
            ? encodeAssistant(event)
            : encodeUserBatch(event)),
        }
      } catch (error) {
        return {
          ok: false,
          issue: diagnostic(
            'unsupported-event',
            error instanceof Error ? error.message : 'Unsupported Claude event',
            0,
            null,
            { eventKind: event.kind },
          ),
        }
      }
    try {
      return { ok: true, line: this.adapter.serializeForAppend(entry) }
    } catch (error) {
      return {
        ok: false,
        issue: diagnostic(
          'unsupported-event',
          error instanceof Error ? error.message : 'Unsupported Claude event',
          0,
          null,
          { eventKind: event.kind },
        ),
      }
    }
  }
  decodeDocument(source: string | Uint8Array): TranscriptDocumentResult {
    return decodeDocumentWith(this, source)
  }
}
export function createClaudeTranscriptCodec(
  options: ClaudeTranscriptCodecOptions,
): ClaudeTranscriptCodec {
  return new ClaudeTranscriptCodec(options)
}
