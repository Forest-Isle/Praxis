import { describe, expect, it, vi } from 'vitest'

import { ModelProviderError } from '../core/runtime.js'
import { OpenAICompatibleProvider } from './openai-compatible.js'

describe('OpenAICompatibleProvider', () => {
  it('streams text and usage from chat completions SSE', async () => {
    let capturedUrl = ''
    let capturedInit: RequestInit | undefined
    const fetchImplementation: typeof fetch = vi.fn(async (input, init) => {
      capturedUrl = String(input)
      capturedInit = init
      return new Response(
        [
          'data: {"choices":[{"delta":{"content":"hel"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
          'data: {"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":2}}\n\n',
          'data: [DONE]\n\n',
        ].join(''),
        { headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://provider.example/v1/',
      apiKey: 'secret',
      model: 'fixture-model',
      fetchImplementation,
    })

    const events = []
    for await (const event of provider.complete({
      messages: [{ role: 'user', content: 'hello' }],
    })) {
      events.push(event)
    }

    expect(events).toEqual([
      { type: 'text-delta', delta: 'hel' },
      { type: 'text-delta', delta: 'lo' },
      { type: 'usage', usage: { inputTokens: 4, outputTokens: 2 } },
    ])
    expect(capturedUrl).toBe('https://provider.example/v1/chat/completions')
    expect(capturedInit).toMatchObject({ method: 'POST' })
    expect(JSON.parse(String(capturedInit?.body))).toMatchObject({
      model: 'fixture-model',
      stream: true,
      stream_options: { include_usage: true },
    })
  })

  it('classifies retryable HTTP failures', async () => {
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://provider.example/v1',
      apiKey: 'secret',
      model: 'fixture-model',
      fetchImplementation: async () =>
        new Response('{"error":{"message":"slow down"}}', { status: 429 }),
    })

    let failure: unknown
    try {
      await provider.complete({ messages: [] })[Symbol.asyncIterator]().next()
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(ModelProviderError)
    expect(failure).toMatchObject({ retryable: true, status: 429 })
  })
})
