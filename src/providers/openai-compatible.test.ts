import { describe, expect, it, vi } from 'vitest'

import { ModelProviderError } from '../core/runtime.js'
import { OpenAICompatibleProvider } from './openai-compatible.js'

describe('OpenAICompatibleProvider', () => {
  it('exposes an explicitly configured context window', () => {
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://provider.example/v1',
      apiKey: 'secret',
      model: 'fixture-model',
      contextWindowTokens: 200_000,
    })

    expect(provider.capabilities.contextWindowTokens).toBe(200_000)
    expect(
      () =>
        new OpenAICompatibleProvider({
          baseUrl: 'https://provider.example/v1',
          apiKey: 'secret',
          model: 'fixture-model',
          contextWindowTokens: 0,
        }),
    ).toThrow('positive integer')
  })

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
      effort: 'high',
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
      reasoning_effort: 'high',
      stream: true,
      stream_options: { include_usage: true },
    })
  })

  it('serializes image tool results as a paired tool result and user image', async () => {
    let body: Record<string, unknown> | undefined
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://provider.example/v1',
      apiKey: 'secret',
      model: 'fixture-model',
      fetchImplementation: async (_input, init) => {
        body = JSON.parse(String(init?.body))
        return new Response('data: [DONE]\n\n')
      },
    })

    const events = []
    for await (const event of provider.complete({
      messages: [
        {
          role: 'tool',
          toolCallId: 'call_image',
          content: '',
          images: [{ type: 'image', mediaType: 'image/png', data: 'aGVsbG8=' }],
          isError: false,
        },
        {
          role: 'tool',
          toolCallId: 'call_text',
          content: 'text result',
          isError: false,
        },
      ],
    })) {
      events.push(event)
    }

    expect(events).toEqual([])
    expect(body?.messages).toEqual([
      {
        role: 'tool',
        tool_call_id: 'call_image',
        content: 'Image tool result attached.',
      },
      {
        role: 'tool',
        tool_call_id: 'call_text',
        content: 'text result',
      },
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,aGVsbG8=' },
          },
        ],
      },
    ])
  })

  it('fails closed when a document is passed directly to the provider', async () => {
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://provider.example/v1',
      apiKey: 'secret',
      model: 'fixture-model',
      fetchImplementation: async () => new Response('data: [DONE]\n\n'),
    })
    const stream = provider.complete({
      messages: [
        {
          role: 'tool',
          toolCallId: 'call_pdf',
          content: '',
          documents: [
            {
              type: 'document',
              mediaType: 'application/pdf',
              data: 'JVBERg==',
            },
          ],
          isError: false,
        },
      ],
    })
    await expect(stream[Symbol.asyncIterator]().next()).rejects.toThrow(
      'does not support document tool results',
    )
  })

  it('serializes user image attachments as OpenAI vision content', async () => {
    let body: Record<string, unknown> | undefined
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://provider.example/v1',
      apiKey: 'secret',
      model: 'fixture-model',
      fetchImplementation: async (_input, init) => {
        body = JSON.parse(String(init?.body))
        return new Response('data: [DONE]\n\n')
      },
    })
    for await (const event of provider.complete({
      messages: [
        {
          role: 'user',
          content: 'inspect',
          images: [{ type: 'image', mediaType: 'image/png', data: 'aGVsbG8=' }],
        },
      ],
    })) {
      void event
    }
    expect(body?.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'inspect' },
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,aGVsbG8=' },
          },
        ],
      },
    ])
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

  it('parses CRLF-framed SSE split across transport chunks', async () => {
    const encoder = new TextEncoder()
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode('data: {"choices":[{"delta":{"content":"ok"}}]}\r'),
        )
        controller.enqueue(encoder.encode('\n\r'))
        controller.enqueue(encoder.encode('\ndata: [DONE]\r\n\r\n'))
        controller.close()
      },
    })
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://provider.example/v1',
      apiKey: 'secret',
      model: 'fixture-model',
      fetchImplementation: async () => new Response(body),
    })

    const events = []
    for await (const event of provider.complete({ messages: [] })) {
      events.push(event)
    }
    expect(events).toEqual([{ type: 'text-delta', delta: 'ok' }])
  })

  it('serializes tools and assembles fragmented tool call arguments', async () => {
    let body: Record<string, unknown> | undefined
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://provider.example/v1',
      apiKey: 'secret',
      model: 'fixture-model',
      fetchImplementation: async (_input, init) => {
        body = JSON.parse(String(init?.body))
        return new Response(
          [
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_read","type":"function","function":{"name":"Read","arguments":"{\\"file_"}}]}}]}\n\n',
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"path\\":\\"README.md\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
            'data: [DONE]\n\n',
          ].join(''),
        )
      },
    })

    const events = []
    for await (const event of provider.complete({
      messages: [
        { role: 'user', content: 'read it' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            {
              id: 'previous_call',
              name: 'Read',
              input: { file_path: 'old.txt' },
            },
          ],
        },
        {
          role: 'tool',
          toolCallId: 'previous_call',
          content: 'old contents',
          isError: false,
        },
      ],
      tools: [
        {
          name: 'Read',
          description: 'Read a file',
          inputSchema: { type: 'object' },
        },
      ],
    })) {
      events.push(event)
    }

    expect(events).toEqual([
      {
        type: 'tool-call',
        call: {
          id: 'call_read',
          name: 'Read',
          input: { file_path: 'README.md' },
        },
      },
    ])
    expect(body?.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'Read',
          description: 'Read a file',
          parameters: { type: 'object' },
        },
      },
    ])
    expect(body?.messages).toEqual([
      { role: 'user', content: 'read it' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'previous_call',
            type: 'function',
            function: {
              name: 'Read',
              arguments: '{"file_path":"old.txt"}',
            },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'previous_call',
        content: 'old contents',
      },
    ])
  })

  it('rejects oversized streamed tool arguments', async () => {
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://provider.example/v1',
      apiKey: 'secret',
      model: 'fixture-model',
      maxToolArgumentsBytes: 8,
      fetchImplementation: async () =>
        new Response(
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call","function":{"name":"Read","arguments":"{\\"file_path\\":\\"too-long\\"}"}}]}}]}\n\n',
        ),
    })

    const stream = provider.complete({ messages: [] })
    await expect(stream[Symbol.asyncIterator]().next()).rejects.toThrow(
      'tool arguments exceeded 8 bytes',
    )
  })

  it('bounds pending streamed tool-call cardinality', async () => {
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://provider.example/v1',
      apiKey: 'secret',
      model: 'fixture-model',
      maxToolCallsPerResponse: 1,
      fetchImplementation: async () =>
        new Response(
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"one"},{"index":1,"id":"two"}]}}]}\n\n',
        ),
    })

    const stream = provider.complete({ messages: [] })
    await expect(stream[Symbol.asyncIterator]().next()).rejects.toThrow(
      'exceeded 1 tool calls',
    )
  })

  it('rejects premature EOF and cancels a stream abandoned by its consumer', async () => {
    const truncated = new OpenAICompatibleProvider({
      baseUrl: 'https://provider.example/v1',
      apiKey: 'secret',
      model: 'fixture-model',
      fetchImplementation: async () =>
        new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'),
    })
    const consume = async () => {
      const stream = truncated.complete({ messages: [] })
      const iterator = stream[Symbol.asyncIterator]()
      while (!(await iterator.next()).done) continue
    }
    await expect(consume()).rejects.toMatchObject({
      name: 'ModelProviderError',
      retryable: true,
    })

    let cancelled = false
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"choices":[{"delta":{"content":"first"}}]}\n\n',
          ),
        )
      },
      cancel() {
        cancelled = true
      },
    })
    const abandoned = new OpenAICompatibleProvider({
      baseUrl: 'https://provider.example/v1',
      apiKey: 'secret',
      model: 'fixture-model',
      fetchImplementation: async () => new Response(body),
    })
    const abandonedStream = abandoned.complete({ messages: [] })
    const iterator = abandonedStream[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toMatchObject({ done: false })
    await iterator.return?.()
    expect(cancelled).toBe(true)
  })

  it('bounds non-success response bodies', async () => {
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://provider.example/v1',
      apiKey: 'secret',
      model: 'fixture-model',
      maxErrorBodyBytes: 8,
      fetchImplementation: async () =>
        new Response('{"error":{"message":"too large"}}', { status: 500 }),
    })

    await expect(
      provider.complete({ messages: [] })[Symbol.asyncIterator]().next(),
    ).rejects.toThrow('error response exceeded 8 bytes')
  })

  it('completes and cancels the body at DONE without waiting for EOF', async () => {
    let cancelled = false
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            [
              'data: {"choices":[{"delta":{"content":"done"}}]}\n\n',
              'data: [DONE]\n\n',
            ].join(''),
          ),
        )
      },
      cancel() {
        cancelled = true
      },
    })
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://provider.example/v1',
      apiKey: 'secret',
      model: 'fixture-model',
      fetchImplementation: async () => new Response(body),
    })

    const events = []
    for await (const event of provider.complete({ messages: [] })) {
      events.push(event)
    }
    expect(events).toEqual([{ type: 'text-delta', delta: 'done' }])
    expect(cancelled).toBe(true)
  })

  it.each([
    ['connection', async () => Promise.reject(new TypeError('offline'))],
    [
      'stream',
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new TypeError('disconnected'))
            },
          }),
        ),
    ],
  ])(
    'classifies %s transport failures as retryable',
    async (_name, fetcher) => {
      const provider = new OpenAICompatibleProvider({
        baseUrl: 'https://provider.example/v1',
        apiKey: 'secret',
        model: 'fixture-model',
        fetchImplementation: fetcher,
      })

      const stream = provider.complete({ messages: [] })
      const next = stream[Symbol.asyncIterator]().next()
      await expect(next).rejects.toMatchObject({
        name: 'ModelProviderError',
        retryable: true,
      })
    },
  )
})
