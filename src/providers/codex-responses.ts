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

export interface CodexResponsesProviderOptions {
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

function failure(
  kind: ProviderErrorKind,
  retryable: boolean,
  status?: number,
): ModelProviderError {
  return new ModelProviderError(
    status === undefined
      ? 'Codex Responses provider request failed'
      : `Codex Responses provider request failed with HTTP ${status}`,
    { kind, retryable, ...(status === undefined ? {} : { status }) },
  )
}

function statusFailure(status: number): ModelProviderError {
  if (status === 401 || status === 403)
    return failure('authentication_failed', false, status)
  if (status === 402) return failure('billing_error', false, status)
  if (status === 408) return failure('timeout', true, status)
  if (status === 429) return failure('rate_limit', true, status)
  if (status === 529) return failure('overloaded', true, status)
  if (status >= 500) return failure('server_error', true, status)
  return failure('invalid_request', false, status)
}

export class CodexResponsesProvider implements ModelProvider {
  readonly model: string
  readonly capabilities: ModelProvider['capabilities']
  private readonly fetchImplementation: typeof fetch
  private readonly codec: ResponsesCodec
  private readonly maxErrorBodyBytes: number

  constructor(private readonly options: CodexResponsesProviderOptions) {
    this.model = options.model
    this.fetchImplementation = options.fetchImplementation ?? fetch
    this.maxErrorBodyBytes = options.maxErrorBodyBytes ?? 64 * 1024
    if (
      !Number.isSafeInteger(this.maxErrorBodyBytes) ||
      this.maxErrorBodyBytes <= 0
    )
      throw new Error(
        'Codex Responses provider limits must be positive integers',
      )
    this.codec = new ResponsesCodec({
      providerLabel: 'Codex Responses provider',
      requestDialect: 'codex-native',
      ...(options.thinking === undefined ? {} : { thinking: options.thinking }),
      ...(options.maxStreamBufferBytes === undefined
        ? {}
        : { maxStreamBufferBytes: options.maxStreamBufferBytes }),
      ...(options.maxToolArgumentsBytes === undefined
        ? {}
        : { maxToolArgumentsBytes: options.maxToolArgumentsBytes }),
      ...(options.maxToolCallsPerResponse === undefined
        ? {}
        : { maxToolCallsPerResponse: options.maxToolCallsPerResponse }),
      ...(options.maxToolMetadataBytes === undefined
        ? {}
        : { maxToolMetadataBytes: options.maxToolMetadataBytes }),
      ...(options.maxReasoningBytes === undefined
        ? {}
        : { maxReasoningBytes: options.maxReasoningBytes }),
    })
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
            originator: 'praxis',
            'OpenAI-Beta': 'responses=experimental',
          },
          body: JSON.stringify(body),
          ...(signal ? { signal } : {}),
        },
      )
      reportProviderTransportActivity(request, 'response-received')
    } catch (error) {
      if (signal?.aborted) throw failure('cancelled', false)
      if (
        typeof error === 'object' &&
        error !== null &&
        'name' in error &&
        error.name === 'TimeoutError'
      )
        throw failure('timeout', true)
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ETIMEDOUT'
      )
        throw failure('timeout', true)
      throw failure('transport_error', true)
    }
    if (!response.ok) {
      const reader = response.body?.getReader()
      if (reader) {
        let total = 0
        let ended = false
        try {
          while (true) {
            const next = await reader.read()
            if (next.done) {
              ended = true
              break
            }
            if (next.value.byteLength > 0)
              reportProviderTransportActivity(request, 'response-chunk')
            total += next.value.byteLength
            if (total > this.maxErrorBodyBytes) break
          }
        } catch {
          /* preserve the redacted HTTP status classification */
        } finally {
          if (!ended) {
            try {
              await reader.cancel()
            } catch {
              /* preserve the redacted HTTP status classification */
            }
          }
          reader.releaseLock()
        }
      }
      throw statusFailure(response.status)
    }
    if (!response.body) throw failure('transport_error', true)
    yield* this.codec.stream(response.body, {
      ...(signal === undefined ? {} : { signal }),
      onChunk: () => reportProviderTransportActivity(request, 'response-chunk'),
    })
  }
}
