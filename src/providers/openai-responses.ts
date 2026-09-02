import {
  ModelProviderError,
  type ModelProvider,
  type ModelRequest,
  type ModelStreamEvent,
  type ModelThinkingConfig,
  type ProviderErrorKind,
} from '../core/runtime.js'
import { ResponsesCodec } from './responses-codec.js'
import { reportProviderTransportActivity } from './provider-transport-activity.js'

export interface OpenAIResponsesProviderOptions {
  baseUrl: string
  apiKey: string
  model: string
  contextWindowTokens?: number
  thinking?: ModelThinkingConfig
  maxStreamBufferBytes?: number
  maxToolArgumentsBytes?: number
  maxToolCallsPerResponse?: number
  maxToolMetadataBytes?: number
  maxReasoningBytes?: number
  maxErrorBodyBytes?: number
  fetchImplementation?: typeof fetch
}

function error(
  kind: ProviderErrorKind,
  retryable: boolean,
  status?: number,
): ModelProviderError {
  return new ModelProviderError(
    status === undefined
      ? 'OpenAI Responses provider request failed'
      : `OpenAI Responses provider request failed with HTTP ${status}`,
    { kind, retryable, ...(status === undefined ? {} : { status }) },
  )
}

function statusError(status: number): ModelProviderError {
  if (status === 401 || status === 403)
    return error('authentication_failed', false, status)
  if (status === 402) return error('billing_error', false, status)
  if (status === 408) return error('timeout', true, status)
  if (status === 429) return error('rate_limit', true, status)
  if (status === 529) return error('overloaded', true, status)
  if (status >= 500) return error('server_error', true, status)
  return error('invalid_request', false, status)
}

function classifyErrorBody(body: string, status: number): ModelProviderError {
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch {
    return statusError(status)
  }
  const record =
    value && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : undefined
  const nested =
    record?.error && typeof record.error === 'object'
      ? (record.error as Record<string, unknown>)
      : record
  const text = [nested?.type, nested?.code, nested?.message]
    .filter((item): item is string => typeof item === 'string')
    .join(' ')
  if (
    /context[_ -]?length|prompt[_ -]?too[_ -]?long|context.{0,40}(?:exceed|too long)/iu.test(
      text,
    )
  )
    return error('prompt_too_long', false, status)
  if (nested?.type === 'overloaded_error')
    return error('overloaded', true, status)
  return statusError(status)
}

async function readErrorBody(
  response: Response,
  maxBytes: number,
  request: ModelRequest,
): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const decoder = new TextDecoder()
  let body = ''
  let remaining = maxBytes
  let ended = false
  try {
    while (remaining > 0) {
      const next = await reader.read()
      if (next.done) {
        ended = true
        body += decoder.decode()
        break
      }
      if (next.value.byteLength > 0)
        reportProviderTransportActivity(request, 'response-chunk')
      const chunk = next.value.subarray(0, remaining)
      body += decoder.decode(chunk, { stream: chunk.byteLength === remaining })
      remaining -= chunk.byteLength
      if (chunk.byteLength < next.value.byteLength) break
    }
    return body
  } finally {
    if (!ended) {
      try {
        await reader.cancel()
      } catch {
        /* preserve the redacted HTTP error */
      }
    }
    reader.releaseLock()
  }
}

export class OpenAIResponsesProvider implements ModelProvider {
  readonly model: string
  readonly capabilities: ModelProvider['capabilities']
  private readonly fetchImplementation: typeof fetch
  private readonly codec: ResponsesCodec
  private readonly maxErrorBodyBytes: number

  constructor(private readonly options: OpenAIResponsesProviderOptions) {
    this.model = options.model
    this.fetchImplementation = options.fetchImplementation ?? fetch
    this.codec = new ResponsesCodec({
      providerLabel: 'OpenAI Responses provider',
      ...options,
    })
    this.maxErrorBodyBytes = options.maxErrorBodyBytes ?? 64 * 1024
    if (
      !Number.isSafeInteger(this.maxErrorBodyBytes) ||
      this.maxErrorBodyBytes <= 0
    )
      throw new Error(
        'OpenAI Responses provider limits must be positive integers',
      )
    this.capabilities = {
      streaming: true,
      usage: true,
      tools: true,
      images: true,
      documents: false,
      webSearch: false,
      thinking: {
        modes: ['disabled', 'enabled', 'adaptive'],
        maxTokens: false,
      },
      ...(options.contextWindowTokens === undefined
        ? {}
        : { contextWindowTokens: options.contextWindowTokens }),
      terminalReasons: true,
    }
  }

  async *complete(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const body = this.codec.serialize(request, this.model)
    const signal = request.signal
    let response: Response
    try {
      reportProviderTransportActivity(request, 'request-started')
      response = await this.fetchImplementation(
        `${this.options.baseUrl.replace(/\/+$/u, '')}/responses`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.options.apiKey}`,
            accept: 'text/event-stream',
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
          ...(signal ? { signal } : {}),
        },
      )
      reportProviderTransportActivity(request, 'response-received')
    } catch {
      if (signal?.aborted) throw error('cancelled', false)
      throw error('transport_error', true)
    }
    if (!response.ok) {
      let body = ''
      try {
        body = await readErrorBody(response, this.maxErrorBodyBytes, request)
      } catch {
        /* preserve the redacted status classification */
      }
      throw classifyErrorBody(body, response.status)
    }
    if (!response.body) throw error('transport_error', true)
    yield* this.codec.stream(response.body, {
      ...(signal === undefined ? {} : { signal }),
      onChunk: () => reportProviderTransportActivity(request, 'response-chunk'),
    })
  }
}
