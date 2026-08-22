import {
  ModelProviderError,
  type ModelMessage,
  type ModelProvider,
  type ModelRequest,
  type ModelStreamEvent,
  type ModelTerminalReason,
  type ModelThinkingBlock,
  type ModelThinkingConfig,
  type ModelToolCall,
  type ProviderErrorKind,
} from '../core/runtime.js'
import { transportFailureKind } from './provider-errors.js'
import {
  createAnthropicPromptCachePolicyResolver,
  type AnthropicPromptCachePolicy,
} from './anthropic-prompt-cache.js'

export interface AnthropicCompatibleProviderOptions {
  baseUrl: string
  apiKey: string
  model: string
  maxOutputTokens?: number
  anthropicVersion?: string
  webSearch?: boolean
  promptCaching?: AnthropicPromptCachePolicy
  contextWindowTokens?: number
  thinking?: ModelThinkingConfig
  maxStreamBufferBytes?: number
  maxToolArgumentsBytes?: number
  maxToolCallsPerResponse?: number
  maxToolMetadataBytes?: number
  maxErrorBodyBytes?: number
  fetchImplementation?: typeof fetch
}

interface PendingToolCall {
  id: string
  name: string
  initialInput: Record<string, unknown>
  partialJson: string
}

interface StreamState {
  blocks: Map<
    number,
    'ignored' | 'text' | 'thinking' | 'redacted_thinking' | 'tool_use'
  >
  thinking: Map<number, ModelThinkingBlock>
  tools: Map<number, PendingToolCall>
  toolCallsSeen: number
  metadataBytes: number
  inputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  outputTokens: number
  webSearchRequests: number
  usageSeen: boolean
  messageStarted: boolean
  messageDeltaSeen: boolean
  terminalReason?: ModelTerminalReason
  terminal: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function webSearchLinks(value: unknown): { title: string; url: string }[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) =>
    isRecord(item) &&
    item.type === 'web_search_result' &&
    typeof item.title === 'string' &&
    typeof item.url === 'string'
      ? [{ title: item.title, url: item.url }]
      : [],
  )
}

function readWebSearchRequests(
  usage: Record<string, unknown>,
  state: StreamState,
): void {
  const serverToolUse = usage.server_tool_use
  if (serverToolUse === undefined) return
  if (!isRecord(serverToolUse)) {
    throw new ModelProviderError(
      'Provider returned an invalid server_tool_use usage object for web_search_requests',
      { retryable: false },
    )
  }
  const count = serverToolUse.web_search_requests
  if (count === undefined) return
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
    throw new ModelProviderError(
      'Provider returned an invalid web_search_requests counter',
      { retryable: false },
    )
  }
  // A present count is the latest cumulative value, never a delta.
  state.webSearchRequests = count
  if (count > 0) state.usageSeen = true
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`)
  }
  return value
}

function validateThinking(
  thinking: ModelThinkingConfig | undefined,
): ModelThinkingConfig | undefined {
  if (!thinking) return undefined
  if (!['enabled', 'adaptive', 'disabled'].includes(thinking.mode)) {
    throw new Error(`Unsupported thinking mode: ${thinking.mode}`)
  }
  if (thinking.maxTokens !== undefined) {
    positiveInteger(thinking.maxTokens, 'Max thinking tokens')
    if (thinking.mode === 'disabled') {
      throw new Error(
        'Max thinking tokens cannot be used when thinking is disabled',
      )
    }
  }
  return thinking
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500
}

function readErrorMessage(value: unknown, status: number): string {
  if (isRecord(value) && isRecord(value.error)) {
    const message = value.error.message
    if (typeof message === 'string' && message.length > 0) return message
  }
  return `Provider request failed with HTTP ${status}`
}

function isPromptTooLongError(type: string, message: string): boolean {
  return (
    ['prompt_too_long', 'context_length_exceeded'].includes(type) ||
    /prompt\s+(?:is\s+)?too long|context.{0,80}(?:exceed|too long)|maximum context length/iu.test(
      message,
    )
  )
}

function anthropicErrorKind(
  value: unknown,
  status?: number,
): ProviderErrorKind {
  const error = isRecord(value) && isRecord(value.error) ? value.error : value
  const type =
    isRecord(error) && typeof error.type === 'string' ? error.type : ''
  const message =
    isRecord(error) && typeof error.message === 'string' ? error.message : ''
  if (isPromptTooLongError(type, message)) return 'prompt_too_long'
  if (type === 'authentication_error' || status === 401 || status === 403)
    return 'authentication_failed'
  if (type === 'billing_error' || status === 402) return 'billing_error'
  if (type === 'rate_limit_error' || status === 429) return 'rate_limit'
  if (type === 'overloaded_error' || status === 529) return 'overloaded'
  if (type === 'api_error') return 'api_error'
  if (status === 408) return 'timeout'
  if (type === 'invalid_request_error') return 'invalid_request'
  if (status !== undefined && status >= 400 && status < 500)
    return 'invalid_request'
  if (status !== undefined && status >= 500) return 'server_error'
  return 'unknown'
}

function anthropicStopReason(value: unknown): ModelTerminalReason {
  if (value === 'end_turn' || value === 'stop_sequence' || value === 'refusal')
    return 'end_turn'
  if (value === 'tool_use') return 'tool_use'
  if (value === 'max_tokens') return 'max_tokens'
  if (value === 'model_context_window_exceeded') return 'prompt_too_long'
  if (typeof value !== 'string' || value.length === 0) {
    throw new ModelProviderError(
      'Provider message delta is missing stop reason',
      {
        retryable: false,
      },
    )
  }
  throw new ModelProviderError(
    `Provider returned unsupported stop reason ${value}`,
    { retryable: false },
  )
}

function completedToolCall(
  state: StreamState,
  index: number,
): ModelStreamEvent | null {
  const pending = state.tools.get(index)
  if (!pending) return null
  state.tools.delete(index)

  let input: unknown = pending.initialInput
  if (pending.partialJson.length > 0) {
    try {
      input = JSON.parse(pending.partialJson)
    } catch (error) {
      throw new ModelProviderError(
        `Provider returned malformed tool arguments for ${pending.name}`,
        { retryable: false, cause: error },
      )
    }
  }
  if (!pending.id || !pending.name || !isRecord(input)) {
    throw new ModelProviderError('Provider returned an invalid tool call', {
      retryable: false,
    })
  }
  const call: ModelToolCall = {
    id: pending.id,
    name: pending.name,
    input,
  }
  return { type: 'tool-call', call }
}

function parseSseEvent(
  data: string,
  state: StreamState,
  maxToolArgumentsBytes: number,
  maxToolCallsPerResponse: number,
  maxToolMetadataBytes: number,
): ModelStreamEvent[] {
  let value: unknown
  try {
    value = JSON.parse(data)
  } catch (error) {
    throw new ModelProviderError('Provider returned malformed SSE JSON', {
      retryable: false,
      cause: error,
    })
  }
  if (!isRecord(value) || typeof value.type !== 'string') return []

  if (value.type === 'error') {
    const error = isRecord(value.error) ? value.error : {}
    const message =
      typeof error.message === 'string'
        ? error.message
        : 'Provider stream returned an error'
    const kind = anthropicErrorKind(error)
    const retryable = [
      'api_error',
      'overloaded',
      'rate_limit',
      'timeout',
    ].includes(kind)
    throw new ModelProviderError(message, { kind, retryable })
  }

  if (value.type === 'message_start') {
    if (state.messageStarted || !isRecord(value.message)) {
      throw new ModelProviderError(
        'Provider returned an invalid message start',
        {
          retryable: false,
        },
      )
    }
    state.messageStarted = true
    const usage = value.message.usage
    if (isRecord(usage)) {
      const inputTokens = [
        usage.input_tokens,
        usage.cache_creation_input_tokens,
        usage.cache_read_input_tokens,
      ].reduce(
        (total: number, count) =>
          total + (typeof count === 'number' ? count : 0),
        0,
      )
      state.inputTokens = inputTokens
      state.cacheCreationInputTokens =
        typeof usage.cache_creation_input_tokens === 'number'
          ? usage.cache_creation_input_tokens
          : 0
      state.cacheReadInputTokens =
        typeof usage.cache_read_input_tokens === 'number'
          ? usage.cache_read_input_tokens
          : 0
      state.usageSeen = true
      readWebSearchRequests(usage, state)
    }
    return []
  }

  if (
    [
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ].includes(value.type) &&
    !state.messageStarted
  ) {
    throw new ModelProviderError(
      `Provider sent ${value.type} before message_start`,
      { retryable: false },
    )
  }

  if (
    state.messageDeltaSeen &&
    [
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
    ].includes(value.type)
  ) {
    throw new ModelProviderError(
      `Provider sent ${value.type} after message_delta`,
      { retryable: false },
    )
  }

  if (value.type === 'content_block_start') {
    if (typeof value.index !== 'number' || !isRecord(value.content_block)) {
      throw new ModelProviderError(
        'Provider returned an invalid content block start',
        { retryable: false },
      )
    }
    if (state.blocks.has(value.index)) {
      throw new ModelProviderError(
        `Provider restarted active content block ${value.index}`,
        { retryable: false },
      )
    }
    const block = value.content_block
    if (block.type === 'thinking') {
      if (typeof block.thinking !== 'string') {
        throw new ModelProviderError(
          'Provider returned an invalid thinking block',
          { retryable: false },
        )
      }
      const pending: ModelThinkingBlock = {
        type: 'thinking',
        thinking: block.thinking,
        signature: typeof block.signature === 'string' ? block.signature : '',
      }
      state.blocks.set(value.index, 'thinking')
      state.thinking.set(value.index, pending)
      return [
        {
          type: 'thinking-start',
          block: { type: 'thinking', thinking: block.thinking },
        },
      ]
    }
    if (block.type === 'redacted_thinking') {
      if (typeof block.data !== 'string') {
        throw new ModelProviderError(
          'Provider returned an invalid redacted thinking block',
          { retryable: false },
        )
      }
      const pending: ModelThinkingBlock = {
        type: 'redacted_thinking',
        data: block.data,
      }
      state.blocks.set(value.index, 'redacted_thinking')
      state.thinking.set(value.index, pending)
      return [{ type: 'thinking-start', block: pending }]
    }
    if (block.type === 'text') {
      state.blocks.set(value.index, 'text')
      return typeof block.text === 'string' && block.text.length > 0
        ? [{ type: 'text-delta', delta: block.text }]
        : []
    }
    if (block.type === 'web_search_tool_result') {
      state.blocks.set(value.index, 'ignored')
      const links = webSearchLinks(block.content)
      const serialized = links.length > 0 ? JSON.stringify(links) : ''
      state.metadataBytes += Buffer.byteLength(serialized)
      if (state.metadataBytes > maxToolMetadataBytes) {
        throw new ModelProviderError(
          `Provider tool metadata exceeded ${maxToolMetadataBytes} bytes`,
          { retryable: false },
        )
      }
      return serialized
        ? [{ type: 'text-delta', delta: `Links: ${serialized}\n\n` }]
        : []
    }
    if (block.type !== 'tool_use') {
      state.blocks.set(value.index, 'ignored')
      return []
    }
    if (!state.tools.has(value.index)) {
      if (state.toolCallsSeen >= maxToolCallsPerResponse) {
        throw new ModelProviderError(
          `Provider exceeded ${maxToolCallsPerResponse} tool calls in one response`,
          { retryable: false },
        )
      }
      const id = typeof block.id === 'string' ? block.id : ''
      const name = typeof block.name === 'string' ? block.name : ''
      if (!id || !name || !isRecord(block.input)) {
        throw new ModelProviderError('Provider returned an invalid tool call', {
          retryable: false,
        })
      }
      const initialInput = block.input
      const initialInputBytes = Buffer.byteLength(JSON.stringify(initialInput))
      if (initialInputBytes > maxToolArgumentsBytes) {
        throw new ModelProviderError(
          `Provider tool arguments exceeded ${maxToolArgumentsBytes} bytes`,
          { retryable: false },
        )
      }
      state.toolCallsSeen += 1
      state.metadataBytes +=
        Buffer.byteLength(id) + Buffer.byteLength(name) + initialInputBytes
      state.tools.set(value.index, {
        id,
        name,
        initialInput,
        partialJson: '',
      })
    }
    state.blocks.set(value.index, 'tool_use')
  }

  if (value.type === 'content_block_delta') {
    if (typeof value.index !== 'number' || !isRecord(value.delta)) {
      throw new ModelProviderError(
        'Provider returned an invalid content block delta',
        { retryable: false },
      )
    }
    const blockType = state.blocks.get(value.index)
    if (!blockType) {
      throw new ModelProviderError(
        `Provider updated inactive content block ${value.index}`,
        { retryable: false },
      )
    }
    if (blockType === 'ignored') return []
    if (value.delta.type === 'thinking_delta') {
      const pending = state.thinking.get(value.index)
      if (
        blockType !== 'thinking' ||
        pending?.type !== 'thinking' ||
        typeof value.delta.thinking !== 'string'
      ) {
        throw new ModelProviderError(
          `Provider sent thinking for non-thinking content block ${value.index}`,
          { retryable: false },
        )
      }
      pending.thinking += value.delta.thinking
      return [{ type: 'thinking-delta', delta: value.delta.thinking }]
    }
    if (value.delta.type === 'signature_delta') {
      const pending = state.thinking.get(value.index)
      if (
        blockType !== 'thinking' ||
        pending?.type !== 'thinking' ||
        typeof value.delta.signature !== 'string'
      ) {
        throw new ModelProviderError(
          `Provider sent a signature for non-thinking content block ${value.index}`,
          { retryable: false },
        )
      }
      pending.signature += value.delta.signature
      return [
        { type: 'thinking-signature-delta', delta: value.delta.signature },
      ]
    }
    if (value.delta.type === 'text_delta') {
      if (blockType !== 'text') {
        throw new ModelProviderError(
          `Provider sent text for non-text content block ${value.index}`,
          { retryable: false },
        )
      }
      return typeof value.delta.text === 'string' && value.delta.text.length > 0
        ? [{ type: 'text-delta', delta: value.delta.text }]
        : []
    }
    if (value.delta.type === 'input_json_delta') {
      if (blockType !== 'tool_use') {
        throw new ModelProviderError(
          `Provider sent tool input for non-tool content block ${value.index}`,
          { retryable: false },
        )
      }
      const pending = state.tools.get(value.index)
      if (!pending || typeof value.delta.partial_json !== 'string') {
        throw new ModelProviderError(
          `Provider returned invalid tool input for content block ${value.index}`,
          { retryable: false },
        )
      }
      pending.partialJson += value.delta.partial_json
      const inputBytes = Buffer.byteLength(pending.partialJson)
      state.metadataBytes += Buffer.byteLength(value.delta.partial_json)
      if (inputBytes > maxToolArgumentsBytes) {
        throw new ModelProviderError(
          `Provider tool arguments exceeded ${maxToolArgumentsBytes} bytes`,
          { retryable: false },
        )
      }
    }
    if (
      value.delta.type !== 'text_delta' &&
      value.delta.type !== 'input_json_delta' &&
      value.delta.type !== 'citations_delta' &&
      value.delta.type !== 'thinking_delta' &&
      value.delta.type !== 'signature_delta'
    ) {
      throw new ModelProviderError(
        `Provider returned an unsupported delta for content block ${value.index}`,
        { retryable: false },
      )
    }
  }

  if (state.metadataBytes > maxToolMetadataBytes) {
    throw new ModelProviderError(
      `Provider tool metadata exceeded ${maxToolMetadataBytes} bytes`,
      { retryable: false },
    )
  }

  if (value.type === 'content_block_stop') {
    if (typeof value.index !== 'number') {
      throw new ModelProviderError(
        'Provider returned an invalid content block stop',
        { retryable: false },
      )
    }
    const blockType = state.blocks.get(value.index)
    if (!blockType) {
      throw new ModelProviderError(
        `Provider stopped inactive content block ${value.index}`,
        { retryable: false },
      )
    }
    state.blocks.delete(value.index)
    if (blockType === 'thinking' || blockType === 'redacted_thinking') {
      const block = state.thinking.get(value.index)
      state.thinking.delete(value.index)
      if (!block) {
        throw new ModelProviderError(
          `Provider stopped missing thinking block ${value.index}`,
          { retryable: false },
        )
      }
      if (
        (block.type === 'thinking' && block.signature.length === 0) ||
        (block.type === 'redacted_thinking' && block.data.length === 0)
      ) {
        throw new ModelProviderError(
          `Provider returned incomplete ${block.type} block ${value.index}`,
          { retryable: false },
        )
      }
      return [{ type: 'thinking-stop', block }]
    }
    const event =
      blockType === 'tool_use' ? completedToolCall(state, value.index) : null
    return event ? [event] : []
  }

  if (value.type === 'message_delta') {
    if (
      state.blocks.size > 0 ||
      state.tools.size > 0 ||
      state.thinking.size > 0 ||
      !isRecord(value.usage)
    ) {
      throw new ModelProviderError(
        'Provider returned an invalid message delta',
        { retryable: false },
      )
    }
    state.messageDeltaSeen = true
    if (value.delta !== undefined && !isRecord(value.delta)) {
      throw new ModelProviderError(
        'Provider returned an invalid message delta',
        {
          retryable: false,
        },
      )
    }
    if (isRecord(value.delta) && value.delta.stop_reason !== undefined) {
      if (state.terminalReason !== undefined) {
        throw new ModelProviderError(
          'Provider returned multiple terminal stop reasons',
          { retryable: false },
        )
      }
      state.terminalReason = anthropicStopReason(value.delta.stop_reason)
    }
    if (typeof value.usage.output_tokens === 'number') {
      state.outputTokens = value.usage.output_tokens
      state.usageSeen = true
    }
    readWebSearchRequests(value.usage, state)
    return []
  }

  if (value.type === 'message_stop') {
    if (
      state.blocks.size > 0 ||
      state.tools.size > 0 ||
      state.thinking.size > 0
    ) {
      throw new ModelProviderError(
        'Provider stopped with unfinished content blocks',
        { retryable: false },
      )
    }
    if (!state.messageDeltaSeen) {
      throw new ModelProviderError(
        'Provider stopped before the terminal message delta',
        { retryable: false },
      )
    }
    if (state.terminalReason === undefined) {
      throw new ModelProviderError(
        'Provider message delta is missing stop reason',
        {
          retryable: false,
        },
      )
    }
    state.terminal = true
    const events: ModelStreamEvent[] = []
    if (state.usageSeen) {
      events.push({
        type: 'usage',
        usage: {
          inputTokens: state.inputTokens,
          outputTokens: state.outputTokens,
          ...(state.cacheReadInputTokens === 0
            ? {}
            : { cacheReadInputTokens: state.cacheReadInputTokens }),
          ...(state.cacheCreationInputTokens === 0
            ? {}
            : { cacheCreationInputTokens: state.cacheCreationInputTokens }),
          ...(state.webSearchRequests === 0
            ? {}
            : { webSearchRequests: state.webSearchRequests }),
        },
      })
      state.usageSeen = false
    }
    events.push({ type: 'terminal', reason: state.terminalReason })
    return events
  }

  return []
}

type AnthropicMessage = {
  role: 'user' | 'assistant'
  content: Record<string, unknown>[]
}

type AnthropicCacheControl = {
  type: 'ephemeral'
  ttl?: '1h'
}

const ANTHROPIC_CACHE_LOOKBACK_BLOCKS = 20

function cacheControl(ttl: '5m' | '1h'): AnthropicCacheControl {
  return {
    type: 'ephemeral',
    ...(ttl === '1h' ? { ttl } : {}),
  }
}

function markLatestCacheableMessageBlock(
  messages: AnthropicMessage[],
  control: AnthropicCacheControl,
): void {
  let inspectedBlocks = 0
  for (
    let messageIndex = messages.length - 1;
    messageIndex >= 0;
    messageIndex--
  ) {
    const content = messages[messageIndex]?.content
    if (!content) continue
    for (let blockIndex = content.length - 1; blockIndex >= 0; blockIndex--) {
      if (inspectedBlocks >= ANTHROPIC_CACHE_LOOKBACK_BLOCKS) return
      inspectedBlocks += 1
      const block = content[blockIndex]
      if (
        !block ||
        block.type === 'thinking' ||
        block.type === 'redacted_thinking'
      ) {
        continue
      }
      content[blockIndex] = { ...block, cache_control: control }
      return
    }
  }
}

function serializeMediaContent(
  message: Extract<ModelMessage, { role: 'user' | 'tool' }>,
): Record<string, unknown>[] {
  const blocks = message.contentBlocks
    ? [...message.contentBlocks]
    : message.content.length > 0
      ? [{ type: 'text' as const, text: message.content }]
      : []
  const mediaKeys = new Set(
    blocks
      .filter((block) => block.type !== 'text')
      .map((block) => `${block.type}\0${block.mediaType}\0${block.data}`),
  )
  for (const block of [
    ...(message.images ?? []),
    ...(message.documents ?? []),
  ]) {
    const key = `${block.type}\0${block.mediaType}\0${block.data}`
    if (mediaKeys.has(key)) continue
    mediaKeys.add(key)
    blocks.push(block)
  }
  return blocks.map((block) =>
    block.type === 'text'
      ? { type: 'text', text: block.text }
      : {
          type: block.type,
          source: {
            type: 'base64',
            media_type: block.mediaType,
            data: block.data,
          },
        },
  )
}

function serializeMessages(
  messages: readonly ModelMessage[],
  stableSystemMessageCount: number | undefined,
  promptCaching: AnthropicCacheControl | undefined,
): {
  system: Record<string, unknown>[]
  messages: AnthropicMessage[]
} {
  const system: Record<string, unknown>[] = []
  const serialized: AnthropicMessage[] = []
  let systemIndex = 0
  const append = (
    role: AnthropicMessage['role'],
    content: Record<string, unknown>[],
  ) => {
    if (content.length === 0) return
    const previous = serialized.at(-1)
    if (previous?.role === role) previous.content.push(...content)
    else serialized.push({ role, content })
  }

  for (const message of messages) {
    if (message.role === 'system') {
      const block = {
        type: 'text',
        text: `${systemIndex === 0 ? '' : '\n\n'}${message.content}`,
        ...(promptCaching && systemIndex + 1 === stableSystemMessageCount
          ? { cache_control: promptCaching }
          : {}),
      }
      system.push(block)
      systemIndex += 1
      continue
    }
    if (message.role === 'user') {
      append('user', serializeMediaContent(message))
      continue
    }
    if (message.role === 'tool') {
      if (message.contentBlocks) {
        const content = serializeMediaContent(message)
        append('user', [
          {
            type: 'tool_result',
            tool_use_id: message.toolCallId,
            content:
              content.length === 1 && content[0]?.type === 'text'
                ? content[0].text
                : content,
            ...(message.isError ? { is_error: true } : {}),
          },
        ])
      } else {
        const media = serializeMediaContent({ ...message, content: '' })
        append('user', [
          {
            type: 'tool_result',
            tool_use_id: message.toolCallId,
            content: message.content,
            is_error: message.isError,
          },
          ...media,
        ])
      }
      continue
    }
    if (message.role !== 'assistant') continue
    const content: Record<string, unknown>[] = []
    for (const block of message.thinkingBlocks ?? []) {
      if (
        (block.type === 'thinking' && block.signature.length === 0) ||
        (block.type === 'redacted_thinking' && block.data.length === 0)
      ) {
        throw new ModelProviderError(
          `Cannot replay incomplete ${block.type} block`,
          { retryable: false },
        )
      }
      content.push(block)
    }
    if (message.content.length > 0) {
      content.push({ type: 'text', text: message.content })
    }
    for (const call of message.toolCalls ?? []) {
      content.push({
        type: 'tool_use',
        id: call.id,
        name: call.name,
        input: call.input,
      })
    }
    append('assistant', content)
  }

  if (promptCaching) {
    markLatestCacheableMessageBlock(serialized, promptCaching)
  }
  return { system, messages: serialized }
}

function validateStableSystemPrefix(request: ModelRequest): void {
  const count = request.stableSystemMessageCount
  if (count === undefined) return
  const systemMessageCount = request.messages.filter(
    (message) => message.role === 'system',
  ).length
  if (!Number.isSafeInteger(count) || count < 0 || count > systemMessageCount) {
    throw new Error(
      'Stable system message count must identify a valid system-message prefix',
    )
  }
  if (
    request.messages
      .slice(0, count)
      .some((message) => message.role !== 'system')
  ) {
    throw new Error(
      'Stable system message count must identify a valid system-message prefix',
    )
  }
}

export class AnthropicCompatibleProvider implements ModelProvider {
  readonly capabilities: ModelProvider['capabilities']
  readonly model: string
  private readonly endpoint: string
  private readonly fetchImplementation: typeof fetch
  private readonly maxOutputTokens: number
  private readonly anthropicVersion: string
  private readonly maxStreamBufferBytes: number
  private readonly maxToolArgumentsBytes: number
  private readonly maxToolCallsPerResponse: number
  private readonly maxToolMetadataBytes: number
  private readonly maxErrorBodyBytes: number
  private readonly thinking: ModelThinkingConfig | undefined
  private readonly promptCaching: AnthropicCacheControl | undefined

  constructor(private readonly options: AnthropicCompatibleProviderOptions) {
    if (options.contextWindowTokens !== undefined) {
      positiveInteger(options.contextWindowTokens, 'Context window tokens')
    }
    this.endpoint = `${options.baseUrl.replace(/\/+$/, '')}/messages`
    this.model = options.model
    this.fetchImplementation = options.fetchImplementation ?? fetch
    this.maxOutputTokens = positiveInteger(
      options.maxOutputTokens ??
        (options.model.includes('claude-opus-4-6')
          ? 64_000
          : options.model.startsWith('claude-')
            ? 32_000
            : 8192),
      'Max output tokens',
    )
    this.capabilities = {
      streaming: true,
      usage: true,
      tools: true,
      images: true,
      documents: true,
      webSearch: options.webSearch === true,
      thinking: {
        modes: ['enabled', 'adaptive', 'disabled'],
        maxTokens: true,
      },
      ...(options.contextWindowTokens === undefined
        ? {}
        : { contextWindowTokens: options.contextWindowTokens }),
      maxOutputTokens: this.maxOutputTokens,
      terminalReasons: true,
    }
    this.thinking = validateThinking(options.thinking)
    const promptCaching =
      options.promptCaching === false
        ? undefined
        : (options.promptCaching ??
          createAnthropicPromptCachePolicyResolver(
            {},
            'native',
          )({
            baseUrl: options.baseUrl,
            model: options.model,
          }))
    this.promptCaching = promptCaching
      ? cacheControl(promptCaching.ttl)
      : undefined
    this.anthropicVersion = options.anthropicVersion ?? '2023-06-01'
    this.maxStreamBufferBytes = options.maxStreamBufferBytes ?? 1024 * 1024
    this.maxToolArgumentsBytes = options.maxToolArgumentsBytes ?? 1024 * 1024
    this.maxToolCallsPerResponse = options.maxToolCallsPerResponse ?? 32
    this.maxToolMetadataBytes = options.maxToolMetadataBytes ?? 1024 * 1024
    this.maxErrorBodyBytes = options.maxErrorBodyBytes ?? 64 * 1024
  }

  async *complete(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    validateStableSystemPrefix(request)
    if (request.webSearch && !this.capabilities.webSearch) {
      throw new Error('Provider does not support web search')
    }
    if (request.webSearch && request.tools?.length) {
      throw new Error('Web search cannot be combined with model tools')
    }
    const thinking = validateThinking(request.thinking ?? this.thinking)
    const maxTokens = Math.max(
      this.maxOutputTokens,
      thinking?.maxTokens === undefined ? 0 : thinking.maxTokens + 1,
    )
    const thinkingPayload =
      thinking === undefined
        ? undefined
        : thinking.mode === 'disabled'
          ? { type: 'disabled' }
          : {
              type: 'enabled',
              budget_tokens: thinking.maxTokens ?? maxTokens - 1,
            }
    const betas = [
      ...(request.betas ?? []),
      ...(thinking && thinking.mode !== 'disabled'
        ? ['interleaved-thinking-2025-05-14']
        : []),
    ].filter((beta, index, all) => all.indexOf(beta) === index)
    const serialized = serializeMessages(
      request.messages,
      request.stableSystemMessageCount,
      this.promptCaching,
    )
    const requestTools = request.tools
    const requestInit: RequestInit = {
      method: 'POST',
      headers: {
        'anthropic-version': this.anthropicVersion,
        'content-type': 'application/json',
        'x-api-key': this.options.apiKey,
        ...(betas.length ? { 'anthropic-beta': betas.join(',') } : {}),
      },
      body: JSON.stringify({
        model: this.options.model,
        max_tokens: maxTokens,
        messages: serialized.messages,
        stream: true,
        ...(thinkingPayload ? { thinking: thinkingPayload } : {}),
        ...(request.effort
          ? { output_config: { effort: request.effort } }
          : {}),
        ...(serialized.system.length ? { system: serialized.system } : {}),
        ...(request.webSearch
          ? {
              tools: [
                {
                  type: 'web_search_20250305',
                  name: 'web_search',
                  ...(request.webSearch.allowedDomains
                    ? { allowed_domains: request.webSearch.allowedDomains }
                    : {}),
                  ...(request.webSearch.blockedDomains
                    ? { blocked_domains: request.webSearch.blockedDomains }
                    : {}),
                  max_uses: positiveInteger(
                    request.webSearch.maxUses,
                    'Web search max uses',
                  ),
                },
              ],
              tool_choice: { type: 'tool', name: 'web_search' },
            }
          : requestTools?.length
            ? {
                tools: requestTools.map((tool, index) => ({
                  name: tool.name,
                  description: tool.description,
                  input_schema: tool.inputSchema,
                  ...(this.promptCaching && index === requestTools.length - 1
                    ? { cache_control: this.promptCaching }
                    : {}),
                })),
              }
            : {}),
      }),
    }
    if (request.signal) requestInit.signal = request.signal

    let response: Response
    try {
      response = await this.fetchImplementation(this.endpoint, requestInit)
    } catch (error) {
      const kind = transportFailureKind(error, request.signal)
      throw new ModelProviderError(
        kind === 'cancelled'
          ? 'Provider request cancelled'
          : kind === 'timeout'
            ? 'Provider request timed out'
            : 'Provider transport failed',
        {
          kind,
          retryable: kind === 'timeout' || kind === 'transport_error',
          cause: error,
        },
      )
    }

    if (!response.ok) {
      let payload: unknown
      try {
        const reader = response.body?.getReader()
        if (!reader) payload = null
        else {
          const chunks: Uint8Array[] = []
          let size = 0
          let ended = false
          try {
            while (true) {
              const { done, value } = await reader.read()
              if (done) {
                ended = true
                break
              }
              size += value.byteLength
              if (size > this.maxErrorBodyBytes) {
                throw new ModelProviderError(
                  `Provider error response exceeded ${this.maxErrorBodyBytes} bytes`,
                  { retryable: false, status: response.status },
                )
              }
              chunks.push(value)
            }
          } finally {
            if (!ended) {
              try {
                await reader.cancel()
              } catch {
                // Preserve the primary provider error.
              }
            }
            reader.releaseLock()
          }
          payload = JSON.parse(
            Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString(
              'utf8',
            ),
          )
        }
      } catch (error) {
        if (error instanceof ModelProviderError) throw error
        payload = null
      }
      throw new ModelProviderError(readErrorMessage(payload, response.status), {
        kind: anthropicErrorKind(payload, response.status),
        retryable: isRetryableStatus(response.status),
        status: response.status,
      })
    }
    if (!response.body) {
      throw new ModelProviderError('Provider response has no body', {
        kind: 'transport_error',
        retryable: true,
      })
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const state: StreamState = {
      blocks: new Map(),
      thinking: new Map(),
      tools: new Map(),
      toolCallsSeen: 0,
      metadataBytes: 0,
      inputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      outputTokens: 0,
      webSearchRequests: 0,
      usageSeen: false,
      messageStarted: false,
      messageDeltaSeen: false,
      terminal: false,
    }
    let streamEnded = false

    try {
      stream: while (true) {
        const { done, value } = await reader.read()
        buffer += decoder.decode(value, { stream: !done })
        buffer = buffer.replaceAll('\r\n', '\n')
        if (Buffer.byteLength(buffer) > this.maxStreamBufferBytes) {
          throw new ModelProviderError(
            `Provider stream buffer exceeded ${this.maxStreamBufferBytes} bytes`,
            { retryable: false },
          )
        }

        let boundary = buffer.indexOf('\n\n')
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const data = block
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n')
          if (data.length > 0) {
            for (const event of parseSseEvent(
              data,
              state,
              this.maxToolArgumentsBytes,
              this.maxToolCallsPerResponse,
              this.maxToolMetadataBytes,
            )) {
              yield event
            }
            if (state.terminal) break stream
          }
          boundary = buffer.indexOf('\n\n')
        }

        if (done) {
          streamEnded = true
          break
        }
      }
      if (!state.terminal) {
        throw new ModelProviderError(
          'Provider stream ended before a terminal event',
          { retryable: true },
        )
      }
    } catch (error) {
      if (error instanceof ModelProviderError) throw error
      const kind = transportFailureKind(error, request.signal)
      throw new ModelProviderError('Provider stream failed', {
        kind,
        retryable: kind === 'timeout' || kind === 'transport_error',
        cause: error,
      })
    } finally {
      if (!streamEnded) {
        try {
          await reader.cancel()
        } catch {
          // Preserve the primary provider error or consumer return.
        }
      }
      reader.releaseLock()
    }
  }
}
