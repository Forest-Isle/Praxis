import {
  ModelProviderError,
  type ModelMessage,
  type ModelProvider,
  type ModelRequest,
  type ModelStreamEvent,
  type ModelToolCall,
} from '../core/runtime.js'

export interface AnthropicCompatibleProviderOptions {
  baseUrl: string
  apiKey: string
  model: string
  maxOutputTokens?: number
  anthropicVersion?: string
  contextWindowTokens?: number
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
  blocks: Map<number, 'ignored' | 'text' | 'tool_use'>
  tools: Map<number, PendingToolCall>
  toolCallsSeen: number
  metadataBytes: number
  inputTokens: number
  outputTokens: number
  usageSeen: boolean
  messageStarted: boolean
  messageDeltaSeen: boolean
  terminal: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`)
  }
  return value
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
    const retryable = [
      'api_error',
      'overloaded_error',
      'rate_limit_error',
    ].includes(String(error.type))
    throw new ModelProviderError(message, { retryable })
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
      state.usageSeen = true
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
    if (block.type === 'text') {
      state.blocks.set(value.index, 'text')
      return typeof block.text === 'string' && block.text.length > 0
        ? [{ type: 'text-delta', delta: block.text }]
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
      blockType !== 'ignored'
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
    const event =
      blockType === 'tool_use' ? completedToolCall(state, value.index) : null
    return event ? [event] : []
  }

  if (value.type === 'message_delta') {
    if (
      state.blocks.size > 0 ||
      state.tools.size > 0 ||
      !isRecord(value.usage)
    ) {
      throw new ModelProviderError(
        'Provider returned an invalid message delta',
        { retryable: false },
      )
    }
    state.messageDeltaSeen = true
    if (typeof value.usage.output_tokens === 'number') {
      state.outputTokens = value.usage.output_tokens
      state.usageSeen = true
    }
    return []
  }

  if (value.type === 'message_stop') {
    if (state.blocks.size > 0 || state.tools.size > 0) {
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
    state.terminal = true
    const events: ModelStreamEvent[] = []
    if (state.usageSeen) {
      events.push({
        type: 'usage',
        usage: {
          inputTokens: state.inputTokens,
          outputTokens: state.outputTokens,
        },
      })
      state.usageSeen = false
    }
    return events
  }

  return []
}

type AnthropicMessage = {
  role: 'user' | 'assistant'
  content: Record<string, unknown>[]
}

function serializeMessages(messages: readonly ModelMessage[]): {
  system: string
  messages: AnthropicMessage[]
} {
  const system: string[] = []
  const serialized: AnthropicMessage[] = []
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
      system.push(message.content)
      continue
    }
    if (message.role === 'user') {
      append('user', [{ type: 'text', text: message.content }])
      continue
    }
    if (message.role === 'tool') {
      const content = message.images?.length
        ? [
            ...(message.content.length > 0
              ? [{ type: 'text', text: message.content }]
              : []),
            ...message.images.map((image) => ({
              type: 'image',
              source: {
                type: 'base64',
                media_type: image.mediaType,
                data: image.data,
              },
            })),
          ]
        : message.content
      append('user', [
        {
          type: 'tool_result',
          tool_use_id: message.toolCallId,
          content,
          is_error: message.isError,
        },
      ])
      continue
    }
    if (message.role !== 'assistant') continue
    const content: Record<string, unknown>[] = []
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

  return { system: system.join('\n\n'), messages: serialized }
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

  constructor(private readonly options: AnthropicCompatibleProviderOptions) {
    if (options.contextWindowTokens !== undefined) {
      positiveInteger(options.contextWindowTokens, 'Context window tokens')
    }
    this.capabilities = {
      streaming: true,
      usage: true,
      tools: true,
      images: true,
      ...(options.contextWindowTokens === undefined
        ? {}
        : { contextWindowTokens: options.contextWindowTokens }),
    }
    this.endpoint = `${options.baseUrl.replace(/\/+$/, '')}/messages`
    this.model = options.model
    this.fetchImplementation = options.fetchImplementation ?? fetch
    this.maxOutputTokens = positiveInteger(
      options.maxOutputTokens ?? 8192,
      'Max output tokens',
    )
    this.anthropicVersion = options.anthropicVersion ?? '2023-06-01'
    this.maxStreamBufferBytes = options.maxStreamBufferBytes ?? 1024 * 1024
    this.maxToolArgumentsBytes = options.maxToolArgumentsBytes ?? 1024 * 1024
    this.maxToolCallsPerResponse = options.maxToolCallsPerResponse ?? 32
    this.maxToolMetadataBytes = options.maxToolMetadataBytes ?? 1024 * 1024
    this.maxErrorBodyBytes = options.maxErrorBodyBytes ?? 64 * 1024
  }

  async *complete(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const serialized = serializeMessages(request.messages)
    const requestInit: RequestInit = {
      method: 'POST',
      headers: {
        'anthropic-version': this.anthropicVersion,
        'content-type': 'application/json',
        'x-api-key': this.options.apiKey,
      },
      body: JSON.stringify({
        model: this.options.model,
        max_tokens: this.maxOutputTokens,
        messages: serialized.messages,
        stream: true,
        ...(serialized.system ? { system: serialized.system } : {}),
        ...(request.tools?.length
          ? {
              tools: request.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                input_schema: tool.inputSchema,
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
      if (request.signal?.aborted) throw error
      throw new ModelProviderError('Provider transport failed', {
        retryable: true,
        cause: error,
      })
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
        retryable: isRetryableStatus(response.status),
        status: response.status,
      })
    }
    if (!response.body) {
      throw new ModelProviderError('Provider response has no body', {
        retryable: true,
      })
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const state: StreamState = {
      blocks: new Map(),
      tools: new Map(),
      toolCallsSeen: 0,
      metadataBytes: 0,
      inputTokens: 0,
      outputTokens: 0,
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
      if (error instanceof ModelProviderError || request.signal?.aborted) {
        throw error
      }
      throw new ModelProviderError('Provider stream failed', {
        retryable: true,
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
