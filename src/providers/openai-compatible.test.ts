import { describe, expect, it, vi } from 'vitest'

import { ModelProviderError } from '../core/runtime.js'
import { OpenAICompatibleProvider } from './openai-compatible.js'

const withoutTerminal = <T extends { type: string }>(events: readonly T[]) =>
  events.filter((event) => event.type !== 'terminal')

describe('OpenAICompatibleProvider', () => {
  it.each([
    ['stop', 'end_turn'],
    ['content_filter', 'end_turn'],
    ['tool_calls', 'tool_use'],
    ['length', 'max_tokens'],
  ] as const)(
    'maps OpenAI finish reason %s to terminal reason %s',
    async (finishReason, terminalReason) => {
      const provider = new OpenAICompatibleProvider({
        baseUrl: 'https://provider.example/v1',
        apiKey: 'secret',
        model: 'fixture-model',
        fetchImplementation: async () =>
          new Response(
            [
              `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason }] })}\n\n`,
              'data: [DONE]\n\n',
            ].join(''),
          ),
      })

      const events = []
      for await (const event of provider.complete({ messages: [] })) {
        events.push(event)
      }

      expect(events).toEqual([{ type: 'terminal', reason: terminalReason }])
      expect(provider.capabilities.terminalReasons).toBe(true)
    },
  )

  it('fails closed on a missing or unknown OpenAI finish reason', async () => {
    const consume = async (finishReason?: string) => {
      const chunks =
        finishReason === undefined
          ? ['data: [DONE]\n\n']
          : [
              `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason }] })}\n\n`,
              'data: [DONE]\n\n',
            ]
      const provider = new OpenAICompatibleProvider({
        baseUrl: 'https://provider.example/v1',
        apiKey: 'secret',
        model: 'fixture-model',
        fetchImplementation: async () => new Response(chunks.join('')),
      })
      for await (const event of provider.complete({ messages: [] })) void event
    }

    await expect(consume()).rejects.toThrow('missing finish reason')
    await expect(consume('future_reason')).rejects.toThrow(
      'unsupported finish reason future_reason',
    )
  })

  it('rejects duplicate OpenAI finish reasons', async () => {
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://provider.example/v1',
      apiKey: 'secret',
      model: 'fixture-model',
      fetchImplementation: async () =>
        new Response(
          [
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
            'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n',
          ].join(''),
        ),
    })

    await expect(
      provider.complete({ messages: [] })[Symbol.asyncIterator]().next(),
    ).rejects.toThrow('multiple finish reasons')
  })

  it('exposes an explicitly configured context window', () => {
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://provider.example/v1',
      apiKey: 'secret',
      model: 'fixture-model',
      contextWindowTokens: 200_000,
    })

    expect(provider.capabilities.contextWindowTokens).toBe(200_000)
    expect(provider.capabilities.thinking).toEqual({
      modes: ['disabled'],
      maxTokens: false,
    })
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

  it('maps disabled thinking by suppressing reasoning effort', async () => {
    let body: Record<string, unknown> | undefined
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://provider.example/v1',
      apiKey: 'secret',
      model: 'fixture-model',
      thinking: { mode: 'disabled' },
      fetchImplementation: async (_input, init) => {
        body = JSON.parse(String(init?.body))
        return new Response(
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        )
      },
    })
    for await (const event of provider.complete({
      effort: 'high',
      messages: [{ role: 'user', content: 'hello' }],
    })) {
      void event
    }
    expect(body).not.toHaveProperty('reasoning_effort')
  })

  it('rejects thinking modes without a lossless provider mapping', () => {
    expect(
      () =>
        new OpenAICompatibleProvider({
          baseUrl: 'https://provider.example/v1',
          apiKey: 'secret',
          model: 'fixture-model',
          thinking: { mode: 'enabled' },
        }),
    ).toThrow('does not support enabled, adaptive, or token-budgeted thinking')
    expect(
      () =>
        new OpenAICompatibleProvider({
          baseUrl: 'https://provider.example/v1',
          apiKey: 'secret',
          model: 'fixture-model',
          thinking: { mode: 'disabled', maxTokens: 1024 },
        }),
    ).toThrow('does not support enabled, adaptive, or token-budgeted thinking')
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
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
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

    expect(withoutTerminal(events)).toEqual([
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
        return new Response(
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        )
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

    expect(withoutTerminal(events)).toEqual([])
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
        return new Response(
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        )
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
    expect(failure).toMatchObject({
      kind: 'rate_limit',
      retryable: true,
      status: 429,
    })
  })

  it('classifies context overflow errors explicitly', async () => {
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://provider.example/v1',
      apiKey: 'secret',
      model: 'fixture-model',
      fetchImplementation: async () =>
        new Response(
          '{"error":{"code":"context_length_exceeded","message":"maximum context length exceeded"}}',
          { status: 400 },
        ),
    })

    await expect(
      provider.complete({ messages: [] })[Symbol.asyncIterator]().next(),
    ).rejects.toMatchObject({ kind: 'prompt_too_long', retryable: false })
  })

  it.each([
    [529, 'overloaded_error', 'overloaded', true],
    [500, 'api_error', 'api_error', true],
    [400, 'invalid_request_error', 'invalid_request', false],
  ] as const)(
    'classifies HTTP %s %s as %s',
    async (status, type, kind, retryable) => {
      const provider = new OpenAICompatibleProvider({
        baseUrl: 'https://provider.example/v1',
        apiKey: 'secret',
        model: 'fixture-model',
        fetchImplementation: async () =>
          new Response(JSON.stringify({ error: { type, message: type } }), {
            status,
          }),
      })

      await expect(
        provider.complete({ messages: [] })[Symbol.asyncIterator]().next(),
      ).rejects.toMatchObject({ kind, retryable })
    },
  )

  it('classifies stream errors, timeout, and cancellation explicitly', async () => {
    const streamError = new OpenAICompatibleProvider({
      baseUrl: 'https://provider.example/v1',
      apiKey: 'secret',
      model: 'fixture-model',
      fetchImplementation: async () =>
        new Response(
          'data: {"error":{"type":"overloaded_error","message":"busy"}}\n\n',
        ),
    })
    await expect(
      streamError.complete({ messages: [] })[Symbol.asyncIterator]().next(),
    ).rejects.toMatchObject({ kind: 'overloaded', retryable: true })

    const timeoutError = new Error('timed out')
    timeoutError.name = 'TimeoutError'
    const timeout = new OpenAICompatibleProvider({
      baseUrl: 'https://provider.example/v1',
      apiKey: 'secret',
      model: 'fixture-model',
      fetchImplementation: async () => Promise.reject(timeoutError),
    })
    await expect(
      timeout.complete({ messages: [] })[Symbol.asyncIterator]().next(),
    ).rejects.toMatchObject({ kind: 'timeout', retryable: true })

    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    const cancelled = new OpenAICompatibleProvider({
      baseUrl: 'https://provider.example/v1',
      apiKey: 'secret',
      model: 'fixture-model',
      fetchImplementation: async () => Promise.reject(controller.signal.reason),
    })
    const cancelledStream = cancelled.complete({
      messages: [],
      signal: controller.signal,
    })
    await expect(
      cancelledStream[Symbol.asyncIterator]().next(),
    ).rejects.toMatchObject({ kind: 'cancelled', retryable: false })
  })

  it('parses CRLF-framed SSE split across transport chunks', async () => {
    const encoder = new TextEncoder()
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode('data: {"choices":[{"delta":{"content":"ok"}}]}\r'),
        )
        controller.enqueue(encoder.encode('\n\r'))
        controller.enqueue(
          encoder.encode(
            '\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\r\n\r\ndata: [DONE]\r\n\r\n',
          ),
        )
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
    expect(withoutTerminal(events)).toEqual([
      { type: 'text-delta', delta: 'ok' },
    ])
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

    expect(withoutTerminal(events)).toEqual([
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
              'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
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
    expect(withoutTerminal(events)).toEqual([
      { type: 'text-delta', delta: 'done' },
    ])
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
        kind: 'transport_error',
        name: 'ModelProviderError',
        retryable: true,
      })
    },
  )
})
