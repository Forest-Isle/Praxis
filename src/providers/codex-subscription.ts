import {
  ModelProviderError,
  type ModelProvider,
  type ModelRequest,
  type ModelStreamEvent,
  type ModelThinkingConfig,
  type ProviderErrorKind,
} from '../core/runtime.js'
import {
  CodexOAuthError,
  type CodexOAuthAccess,
  type CodexOAuthAccessOptions,
} from './codex-oauth.js'
import { reportProviderTransportActivity } from './provider-transport-activity.js'
import { ResponsesCodec } from './responses-codec.js'

export const CODEX_RESPONSES_ENDPOINT =
  'https://chatgpt.com/backend-api/codex/responses'

export type CodexOAuthAccessResolver = (
  options?: CodexOAuthAccessOptions,
) => Promise<CodexOAuthAccess>

export interface CodexSubscriptionProviderOptions {
  model: string
  access: CodexOAuthAccessResolver
  fetchImplementation?: typeof fetch
  maxStreamBufferBytes?: number
  maxToolArgumentsBytes?: number
  maxToolCallsPerResponse?: number
  maxToolMetadataBytes?: number
  maxReasoningBytes?: number
  maxErrorBodyBytes?: number
  thinking?: ModelThinkingConfig
}

const DEFAULT_MAX_ERROR = 64 * 1024

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error('Codex transport limits must be positive integers')
  return value
}

function providerError(
  kind: ProviderErrorKind,
  retryable: boolean,
  status?: number,
): ModelProviderError {
  return new ModelProviderError(
    status === undefined
      ? 'Codex subscription provider request failed'
      : `Codex subscription provider request failed with HTTP ${status}`,
    { kind, retryable, ...(status === undefined ? {} : { status }) },
  )
}

function statusKind(status: number): {
  kind: ProviderErrorKind
  retryable: boolean
} {
  if (status === 401 || status === 403)
    return { kind: 'authentication_failed', retryable: false }
  if (status === 408) return { kind: 'timeout', retryable: true }
  if (status === 429) return { kind: 'rate_limit', retryable: true }
  if (status >= 500) return { kind: 'server_error', retryable: true }
  return { kind: 'invalid_request', retryable: false }
}

function transportError(
  error: unknown,
  signal?: AbortSignal,
): ModelProviderError {
  if (signal?.aborted) return providerError('cancelled', false)
  if (
    isRecord(error) &&
    (error.name === 'TimeoutError' || error.code === 'ETIMEDOUT')
  )
    return providerError('timeout', true)
  return providerError('transport_error', true)
}

function accessError(error: unknown, signal?: AbortSignal): ModelProviderError {
  if (
    signal?.aborted ||
    (error instanceof CodexOAuthError &&
      error.code === 'authorization_cancelled')
  )
    return providerError('cancelled', false)
  if (error instanceof CodexOAuthError)
    return providerError('authentication_failed', false)
  if (error instanceof ModelProviderError) return error
  return transportError(error, signal)
}

async function drainBody(
  response: Response,
  maxBytes: number,
  request: ModelRequest,
): Promise<void> {
  const reader = response.body?.getReader()
  if (!reader) return
  let total = 0
  let ended = false
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) {
        ended = true
        return
      }
      if (next.value.byteLength > 0)
        reportProviderTransportActivity(request, 'response-chunk')
      total += next.value.byteLength
      if (total > maxBytes) return
    }
  } finally {
    if (!ended) {
      try {
        await reader.cancel()
      } catch {
        /* preserve the primary error */
      }
    }
    reader.releaseLock()
  }
}

export class CodexSubscriptionProvider implements ModelProvider {
  readonly model: string
  readonly capabilities: ModelProvider['capabilities'] = {
    streaming: true,
    usage: true,
    tools: true,
    images: true,
    documents: false,
    webSearch: false,
    thinking: { modes: ['disabled', 'enabled', 'adaptive'], maxTokens: false },
    terminalReasons: true,
  }

  private readonly fetchImplementation: typeof fetch
  private readonly maxErrorBodyBytes: number
  private readonly responsesCodec: ResponsesCodec

  constructor(private readonly options: CodexSubscriptionProviderOptions) {
    this.model = options.model
    this.fetchImplementation = options.fetchImplementation ?? fetch
    this.maxErrorBodyBytes = positiveInteger(
      options.maxErrorBodyBytes,
      DEFAULT_MAX_ERROR,
    )
    this.responsesCodec = new ResponsesCodec({
      providerLabel: 'Codex subscription provider',
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
  }

  async *complete(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const body = this.responsesCodec.serialize(request, this.model)
    const signal = request.signal
    let access: CodexOAuthAccess
    try {
      access = await this.options.access(signal === undefined ? {} : { signal })
    } catch (error) {
      throw accessError(error, signal)
    }

    let refreshed = false
    let response: Response
    while (true) {
      const headers = {
        Authorization: `Bearer ${access.accessToken}`,
        'chatgpt-account-id': access.accountId,
        originator: 'praxis',
        'OpenAI-Beta': 'responses=experimental',
        accept: 'text/event-stream',
        'content-type': 'application/json',
      }
      try {
        reportProviderTransportActivity(request, 'request-started')
        response = await this.fetchImplementation(CODEX_RESPONSES_ENDPOINT, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          ...(signal ? { signal } : {}),
        })
        reportProviderTransportActivity(request, 'response-received')
      } catch (error) {
        throw transportError(error, signal)
      }

      if (response.status === 401 && !refreshed) {
        refreshed = true
        try {
          await drainBody(response, this.maxErrorBodyBytes, request)
        } catch {
          /* ignore unread body failures while refreshing credentials */
        }
        try {
          reportProviderTransportActivity(request, 'request-started')
          access = await this.options.access({
            forceAfter: access.accessToken,
            ...(signal === undefined ? {} : { signal }),
          })
        } catch (error) {
          throw accessError(error, signal)
        }
        continue
      }

      if (!response.ok) {
        try {
          await drainBody(response, this.maxErrorBodyBytes, request)
        } catch {
          /* preserve the redacted transport error */
        }
        const status = response.status
        const classified = statusKind(status)
        throw providerError(classified.kind, classified.retryable, status)
      }
      break
    }

    if (!response.body) throw providerError('transport_error', true)
    yield* this.responsesCodec.stream(response.body, {
      ...(signal === undefined ? {} : { signal }),
      onChunk: () => reportProviderTransportActivity(request, 'response-chunk'),
    })
  }
}
