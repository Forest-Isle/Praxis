import {
  ModelProviderError,
  type ModelProvider,
  type ModelRequest,
  type ModelStreamEvent,
} from '../core/runtime.js'

export interface OpenAICompatibleProviderOptions {
  baseUrl: string
  apiKey: string
  model: string
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

function parseSseEvent(data: string): ModelStreamEvent[] {
  if (data === '[DONE]') return []

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

  const events: ModelStreamEvent[] = []
  const choices = value.choices
  if (Array.isArray(choices)) {
    const first = choices[0]
    if (isRecord(first) && isRecord(first.delta)) {
      const content = first.delta.content
      if (typeof content === 'string' && content.length > 0) {
        events.push({ type: 'text-delta', delta: content })
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

export class OpenAICompatibleProvider implements ModelProvider {
  readonly capabilities = { streaming: true, usage: true } as const
  readonly model: string
  private readonly endpoint: string
  private readonly fetchImplementation: typeof fetch

  constructor(private readonly options: OpenAICompatibleProviderOptions) {
    this.endpoint = `${options.baseUrl.replace(/\/+$/, '')}/chat/completions`
    this.model = options.model
    this.fetchImplementation = options.fetchImplementation ?? fetch
  }

  async *complete(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const requestInit: RequestInit = {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.options.model,
        messages: request.messages,
        stream: true,
        stream_options: { include_usage: true },
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
        payload = await response.json()
      } catch {
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

    try {
      while (true) {
        const { done, value } = await reader.read()
        buffer += decoder.decode(value, { stream: !done })
        buffer = buffer.replaceAll('\r\n', '\n')

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
            for (const event of parseSseEvent(data)) yield event
          }
          boundary = buffer.indexOf('\n\n')
        }

        if (done) break
      }
    } catch (error) {
      if (error instanceof ModelProviderError || request.signal?.aborted) {
        throw error
      }
      throw new ModelProviderError('Provider stream failed', {
        retryable: true,
        cause: error,
      })
    }
  }
}
