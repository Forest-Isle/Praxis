import {
  ModelProviderError,
  type ModelMessage,
  type ModelProvider,
  type ModelRequest,
  type ModelStreamEvent,
  type ModelTerminalReason,
  type ModelThinkingConfig,
  type ModelToolCall,
  type ProviderErrorKind,
} from '../core/runtime.js'
import { transportFailureKind } from './provider-errors.js'

export interface OpenAICompatibleProviderOptions {
  baseUrl: string
  apiKey: string
  model: string
  contextWindowTokens?: number
  thinking?: ModelThinkingConfig
  maxStreamBufferBytes?: number
  maxToolArgumentsBytes?: number
  maxToolCallsPerResponse?: number
  maxToolMetadataBytes?: number
  maxErrorBodyBytes?: number
  fetchImplementation?: typeof fetch
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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

interface PendingToolCall {
  id: string
  name: string
  arguments: string
}

interface PendingToolState {
  calls: Map<number, PendingToolCall>
  metadataBytes: number
  done: boolean
  terminal: boolean
  terminalEmitted: boolean
  terminalReason?: ModelTerminalReason
}

function openAiFinishReason(value: unknown): ModelTerminalReason {
  if (value === 'stop' || value === 'content_filter') return 'end_turn'
  if (value === 'tool_calls' || value === 'function_call') return 'tool_use'
  if (value === 'length') return 'max_tokens'
  if (typeof value !== 'string' || value.length === 0) {
    throw new ModelProviderError('Provider stream is missing finish reason', {
      retryable: false,
    })
  }
  throw new ModelProviderError(
    `Provider returned unsupported finish reason ${value}`,
    { retryable: false },
  )
}

function openAiErrorKind(value: unknown, status?: number): ProviderErrorKind {
  const error = isRecord(value) && isRecord(value.error) ? value.error : value
  const type =
    isRecord(error) && typeof error.type === 'string' ? error.type : ''
  const code =
    isRecord(error) && typeof error.code === 'string' ? error.code : ''
  const message =
    isRecord(error) && typeof error.message === 'string' ? error.message : ''
  if (
    ['context_length_exceeded', 'prompt_too_long'].includes(type) ||
    ['context_length_exceeded', 'prompt_too_long'].includes(code) ||
    /prompt\s+(?:is\s+)?too long|context.{0,80}(?:exceed|too long)|maximum context length/iu.test(
      message,
    )
  ) {
    return 'prompt_too_long'
  }
  if (status === 401 || status === 403) return 'authentication_failed'
  if (status === 402) return 'billing_error'
  if (status === 408) return 'timeout'
  if (type === 'rate_limit_error' || status === 429) return 'rate_limit'
  if (type === 'overloaded_error' || status === 529) return 'overloaded'
  if (type === 'api_error' || type === 'server_error') return 'api_error'
  if (status !== undefined && status >= 400 && status < 500)
    return 'invalid_request'
  if (status !== undefined && status >= 500) return 'server_error'
  return 'unknown'
}

function completedToolCallEvents(
  pending: PendingToolState,
): ModelStreamEvent[] {
  const events = [...pending.calls.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, call]): ModelStreamEvent => {
      let input: unknown
      try {
        input = JSON.parse(call.arguments || '{}')
      } catch (error) {
        throw new ModelProviderError(
          `Provider returned malformed tool arguments for ${call.name}`,
          { retryable: false, cause: error },
        )
      }
      if (!isRecord(input) || !call.id || !call.name) {
        throw new ModelProviderError('Provider returned an invalid tool call', {
          retryable: false,
        })
      }
      const completed: ModelToolCall = {
        id: call.id,
        name: call.name,
        input,
      }
      return { type: 'tool-call', call: completed }
    })
  pending.calls.clear()
  pending.metadataBytes = 0
  return events
}

function parseSseEvent(
  data: string,
  pendingTools: PendingToolState,
  maxToolArgumentsBytes: number,
  maxToolCallsPerResponse: number,
  maxToolMetadataBytes: number,
): ModelStreamEvent[] {
  if (data === '[DONE]') {
    if (pendingTools.terminalReason === undefined) {
      throw new ModelProviderError('Provider stream is missing finish reason', {
        retryable: false,
      })
    }
    pendingTools.done = true
    pendingTools.terminal = true
    pendingTools.terminalEmitted = true
    return [
      ...completedToolCallEvents(pendingTools),
      { type: 'terminal', reason: pendingTools.terminalReason },
    ]
  }

  let value: unknown
  try {
    value = JSON.parse(data)
  } catch (error) {
    throw new ModelProviderError('Provider returned malformed SSE JSON', {
      retryable: false,
      cause: error,
    })
  }
  if (!isRecord(value)) return []
  if (isRecord(value.error)) {
    const kind = openAiErrorKind(value)
    const message =
      typeof value.error.message === 'string'
        ? value.error.message
        : 'Provider stream returned an error'
    throw new ModelProviderError(message, {
      kind,
      retryable: ['api_error', 'overloaded', 'rate_limit', 'timeout'].includes(
        kind,
      ),
    })
  }

  const events: ModelStreamEvent[] = []
  const choices = value.choices
  if (Array.isArray(choices)) {
    const first = choices[0]
    if (isRecord(first) && isRecord(first.delta)) {
      const content = first.delta.content
      if (typeof content === 'string' && content.length > 0) {
        events.push({ type: 'text-delta', delta: content })
      }
      const toolCalls = first.delta.tool_calls
      if (Array.isArray(toolCalls)) {
        for (const value of toolCalls) {
          if (!isRecord(value) || typeof value.index !== 'number') continue
          let pending = pendingTools.calls.get(value.index)
          if (!pending) {
            if (pendingTools.calls.size >= maxToolCallsPerResponse) {
              throw new ModelProviderError(
                `Provider exceeded ${maxToolCallsPerResponse} tool calls in one response`,
                { retryable: false },
              )
            }
            pending = { id: '', name: '', arguments: '' }
          }
          if (typeof value.id === 'string') {
            pending.id += value.id
            pendingTools.metadataBytes += Buffer.byteLength(value.id)
          }
          if (isRecord(value.function)) {
            if (typeof value.function.name === 'string') {
              pending.name += value.function.name
              pendingTools.metadataBytes += Buffer.byteLength(
                value.function.name,
              )
            }
            if (typeof value.function.arguments === 'string') {
              pending.arguments += value.function.arguments
              pendingTools.metadataBytes += Buffer.byteLength(
                value.function.arguments,
              )
              if (
                Buffer.byteLength(pending.arguments) > maxToolArgumentsBytes
              ) {
                throw new ModelProviderError(
                  `Provider tool arguments exceeded ${maxToolArgumentsBytes} bytes`,
                  { retryable: false },
                )
              }
            }
          }
          if (pendingTools.metadataBytes > maxToolMetadataBytes) {
            throw new ModelProviderError(
              `Provider tool metadata exceeded ${maxToolMetadataBytes} bytes`,
              { retryable: false },
            )
          }
          pendingTools.calls.set(value.index, pending)
        }
      }
    }
    if (
      isRecord(first) &&
      first.finish_reason !== null &&
      first.finish_reason !== undefined
    ) {
      if (pendingTools.terminalReason !== undefined) {
        throw new ModelProviderError(
          'Provider returned multiple finish reasons',
          { retryable: false },
        )
      }
      pendingTools.terminal = true
      pendingTools.terminalReason = openAiFinishReason(first.finish_reason)
      if (pendingTools.calls.size > 0) {
        events.push(...completedToolCallEvents(pendingTools))
      }
    }
  }

  if (isRecord(value.usage)) {
    const inputTokens = value.usage.prompt_tokens
    const outputTokens = value.usage.completion_tokens
    if (typeof inputTokens === 'number' && typeof outputTokens === 'number') {
      events.push({ type: 'usage', usage: { inputTokens, outputTokens } })
    }
  }
  return events
}

function serializeMessage(message: ModelMessage): Record<string, unknown> {
  if (message.role === 'tool') {
    if (message.documents?.length) {
      throw new Error(
        'OpenAI-compatible provider does not support document tool results',
      )
    }
    return {
      role: 'tool',
      tool_call_id: message.toolCallId,
      content:
        message.content ||
        (message.images?.length ? 'Image tool result attached.' : ''),
    }
  }
  if (message.role === 'assistant' && message.toolCalls?.length) {
    return {
      role: 'assistant',
      content: message.content || null,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: {
          name: call.name,
          arguments: JSON.stringify(call.input),
        },
      })),
    }
  }
  if (message.role === 'user' && message.images?.length) {
    if (message.documents?.length) {
      throw new Error(
        'OpenAI-compatible provider does not support user documents',
      )
    }
    return {
      role: 'user',
      content: [
        ...(message.content.length > 0
          ? [{ type: 'text', text: message.content }]
          : []),
        ...message.images.map((image) => ({
          type: 'image_url',
          image_url: { url: `data:${image.mediaType};base64,${image.data}` },
        })),
      ],
    }
  }
  if (message.role === 'user' && message.documents?.length) {
    throw new Error(
      'OpenAI-compatible provider does not support user documents',
    )
  }
  return { role: message.role, content: message.content }
}

function serializeMessages(
  messages: readonly ModelMessage[],
): Record<string, unknown>[] {
  const serialized: Record<string, unknown>[] = []
  let pendingImages: Record<string, unknown>[] = []
  const flushImages = () => {
    if (pendingImages.length === 0) return
    serialized.push({ role: 'user', content: pendingImages })
    pendingImages = []
  }
  for (const message of messages) {
    if (message.role !== 'tool') flushImages()
    serialized.push(serializeMessage(message))
    if (message.role === 'tool') {
      pendingImages.push(
        ...(message.images ?? []).map((image) => ({
          type: 'image_url',
          image_url: {
            url: `data:${image.mediaType};base64,${image.data}`,
          },
        })),
      )
    }
  }
  flushImages()
  return serialized
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly capabilities: ModelProvider['capabilities']
  readonly model: string
  private readonly endpoint: string
  private readonly fetchImplementation: typeof fetch
  private readonly maxStreamBufferBytes: number
  private readonly maxToolArgumentsBytes: number
  private readonly maxToolCallsPerResponse: number
  private readonly maxToolMetadataBytes: number
  private readonly maxErrorBodyBytes: number
  private readonly thinking: ModelThinkingConfig | undefined

  constructor(private readonly options: OpenAICompatibleProviderOptions) {
    if (
      options.contextWindowTokens !== undefined &&
      (!Number.isInteger(options.contextWindowTokens) ||
        options.contextWindowTokens <= 0)
    ) {
      throw new Error('Context window tokens must be a positive integer')
    }
    this.capabilities = {
      streaming: true,
      usage: true,
      tools: true,
      images: true,
      thinking: { modes: ['disabled'], maxTokens: false },
      terminalReasons: true,
      ...(options.contextWindowTokens === undefined
        ? {}
        : { contextWindowTokens: options.contextWindowTokens }),
    }
    this.endpoint = `${options.baseUrl.replace(/\/+$/, '')}/chat/completions`
    this.model = options.model
    this.fetchImplementation = options.fetchImplementation ?? fetch
    this.maxStreamBufferBytes = options.maxStreamBufferBytes ?? 1024 * 1024
    this.maxToolArgumentsBytes = options.maxToolArgumentsBytes ?? 1024 * 1024
    this.maxToolCallsPerResponse = options.maxToolCallsPerResponse ?? 32
    this.maxToolMetadataBytes = options.maxToolMetadataBytes ?? 1024 * 1024
    this.maxErrorBodyBytes = options.maxErrorBodyBytes ?? 64 * 1024
    if (
      options.thinking &&
      (options.thinking.mode !== 'disabled' ||
        options.thinking.maxTokens !== undefined)
    ) {
      throw new Error(
        'OpenAI-compatible provider does not support enabled, adaptive, or token-budgeted thinking',
      )
    }
    this.thinking = options.thinking
  }

  async *complete(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const thinking = request.thinking ?? this.thinking
    if (
      thinking &&
      (thinking.mode !== 'disabled' || thinking.maxTokens !== undefined)
    ) {
      throw new Error(
        'OpenAI-compatible provider does not support enabled, adaptive, or token-budgeted thinking',
      )
    }
    const requestInit: RequestInit = {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.options.model,
        messages: serializeMessages(request.messages),
        stream: true,
        ...(request.effort && thinking?.mode !== 'disabled'
          ? { reasoning_effort: request.effort }
          : {}),
        stream_options: { include_usage: true },
        ...(request.tools?.length
          ? {
              tools: request.tools.map((tool) => ({
                type: 'function',
                function: {
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.inputSchema,
                },
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
        kind: openAiErrorKind(payload, response.status),
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
    const pendingTools: PendingToolState = {
      calls: new Map(),
      metadataBytes: 0,
      done: false,
      terminal: false,
      terminalEmitted: false,
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
              pendingTools,
              this.maxToolArgumentsBytes,
              this.maxToolCallsPerResponse,
              this.maxToolMetadataBytes,
            )) {
              yield event
            }
            if (pendingTools.done) break stream
          }
          boundary = buffer.indexOf('\n\n')
        }

        if (done) {
          streamEnded = true
          break
        }
      }
      if (!pendingTools.terminal) {
        throw new ModelProviderError(
          'Provider stream ended before a terminal event',
          { retryable: true },
        )
      }
      if (!pendingTools.terminalEmitted) {
        if (pendingTools.terminalReason === undefined) {
          throw new ModelProviderError(
            'Provider stream is missing finish reason',
            {
              retryable: false,
            },
          )
        }
        pendingTools.terminalEmitted = true
        yield { type: 'terminal', reason: pendingTools.terminalReason }
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
