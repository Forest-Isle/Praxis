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

function statusFailure(
  status: number,
  diagnostics?: string,
): ModelProviderError {
  let result: ModelProviderError
  if (status === 401 || status === 403)
    result = failure('authentication_failed', false, status)
  else if (status === 402) result = failure('billing_error', false, status)
  else if (status === 408) result = failure('timeout', true, status)
  else if (status === 429) result = failure('rate_limit', true, status)
  else if (status === 529) result = failure('overloaded', true, status)
  else if (status >= 500) result = failure('server_error', true, status)
  else result = failure('invalid_request', false, status)
  if (diagnostics !== undefined)
    return new ModelProviderError(`${result.message} (${diagnostics})`, {
      retryable: result.retryable,
      ...(result.kind === undefined ? {} : { kind: result.kind }),
      ...(result.status === undefined ? {} : { status: result.status }),
    })
  return result
}

const safeDiagnostic = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u

function safeValue(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 128 &&
    safeDiagnostic.test(value)
  )
}

function parseErrorDiagnostics(
  body: string | undefined,
  headers: Headers,
): string | undefined {
  let parsed: unknown
  if (body !== undefined) {
    try {
      parsed = JSON.parse(body)
    } catch {
      parsed = undefined
    }
  }
  const object =
    typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  const nested =
    object?.error !== null &&
    typeof object?.error === 'object' &&
    !Array.isArray(object?.error)
      ? (object?.error as Record<string, unknown>)
      : undefined
  const values: Array<[string, unknown]> = [
    ['type', nested === undefined ? object?.type : nested.type],
    ['code', nested === undefined ? object?.code : nested.code],
    ['relay_request_id', headers.get('x-relay-request-id')],
    ['request_id', headers.get('x-request-id')],
    ['cf_ray', headers.get('cf-ray')],
  ]
  const seen = new Set<string>()
  const admitted: string[] = []
  for (const [key, raw] of values) {
    if (!safeValue(raw) || seen.has(raw)) continue
    seen.add(raw)
    admitted.push(`${key}=${raw}`)
  }
  return admitted.length === 0 ? undefined : admitted.join(', ')
}

async function readErrorBody(
  response: Response,
  maxBytes: number,
  onChunk: () => void,
): Promise<string | undefined> {
  const reader = response.body?.getReader()
  if (reader === undefined) return undefined
  const chunks: Uint8Array[] = []
  let total = 0
  let ended = false
  let failed = false
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) {
        ended = true
        break
      }
      if (next.value.byteLength > 0) onChunk()
      if (total + next.value.byteLength > maxBytes) {
        if (total < maxBytes) chunks.push(next.value.slice(0, maxBytes - total))
        total = maxBytes
        break
      }
      chunks.push(next.value)
      total += next.value.byteLength
    }
  } catch {
    failed = true
  } finally {
    if (!ended) {
      try {
        await reader.cancel()
      } catch {
        failed = true
      }
    }
    try {
      reader.releaseLock()
    } catch {
      failed = true
    }
  }
  if (failed || !ended) return undefined
  try {
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return new TextDecoder().decode(bytes)
  } catch {
    return undefined
  }
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
      const body = await readErrorBody(response, this.maxErrorBodyBytes, () =>
        reportProviderTransportActivity(request, 'response-chunk'),
      )
      throw statusFailure(
        response.status,
        parseErrorDiagnostics(body, response.headers),
      )
    }
    if (!response.body) throw failure('transport_error', true)
    yield* this.codec.stream(response.body, {
      ...(signal === undefined ? {} : { signal }),
      onChunk: () => reportProviderTransportActivity(request, 'response-chunk'),
    })
  }
}
