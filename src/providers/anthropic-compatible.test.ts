import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ModelToolDefinition } from '../core/runtime.js'
import { AnthropicCompatibleProvider } from './anthropic-compatible.js'
import { DeadlineModelProvider } from './deadline-provider.js'

const withoutTerminal = <T extends { type: string }>(events: readonly T[]) =>
  events.filter((event) => event.type !== 'terminal')

afterEach(() => {
  vi.useRealTimers()
})

const withoutCacheMetadata = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(withoutCacheMetadata)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'cache_control')
      .map(([key, item]) => [key, withoutCacheMetadata(item)]),
  )
}

describe('AnthropicCompatibleProvider', () => {
  it('renders official Anthropic cache breakpoints at stable prompt boundaries', async () => {
    let body: Record<string, unknown> | undefined
    const provider = new AnthropicCompatibleProvider({
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: 'secret',
      model: 'claude-sonnet-4-20250514',
      fetchImplementation: async (_input, init) => {
        body = JSON.parse(String(init?.body))
        return new Response(
          'data: {"type":"message_start","message":{}}\n\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{}}\n\ndata: {"type":"message_stop"}\n\n',
        )
      },
    })

    for await (const event of provider.complete({
      messages: [
        { role: 'system', content: 'stable base' },
        { role: 'system', content: 'stable project' },
        { role: 'system', content: 'dynamic tail' },
        { role: 'user', content: 'earlier prompt' },
        { role: 'assistant', content: 'earlier answer' },
        { role: 'user', content: 'latest prompt' },
      ],
      stableSystemMessageCount: 2,
      tools: [
        {
          name: 'Read',
          description: 'Read a file',
          inputSchema: { type: 'object' },
        },
        {
          name: 'Edit',
          description: 'Edit a file',
          inputSchema: { type: 'object' },
        },
      ],
    })) {
      void event
    }

    expect(body?.system).toEqual([
      { type: 'text', text: 'stable base' },
      {
        type: 'text',
        text: '\n\nstable project',
        cache_control: { type: 'ephemeral' },
      },
      { type: 'text', text: '\n\ndynamic tail' },
    ])
    expect(body?.tools).toEqual([
      {
        name: 'Read',
        description: 'Read a file',
        input_schema: { type: 'object' },
      },
      {
        name: 'Edit',
        description: 'Edit a file',
        input_schema: { type: 'object' },
        cache_control: { type: 'ephemeral' },
      },
    ])
    expect(body?.messages).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: 'earlier prompt' }],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'earlier answer' }],
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'latest prompt',
            cache_control: { type: 'ephemeral' },
          },
        ],
      },
    ])
  })

  it('bounds the latest conversation breakpoint search to twenty blocks', async () => {
    let body: Record<string, unknown> | undefined
    const provider = new AnthropicCompatibleProvider({
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: 'secret',
      model: 'claude-sonnet-4-20250514',
      fetchImplementation: async (_input, init) => {
        body = JSON.parse(String(init?.body))
        return new Response(
          'data: {"type":"message_start","message":{}}\n\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{}}\n\ndata: {"type":"message_stop"}\n\n',
        )
      },
    })

    for await (const event of provider.complete({
      messages: [
        { role: 'user', content: 'outside the lookback window' },
        {
          role: 'assistant',
          content: '',
          thinkingBlocks: Array.from({ length: 20 }, (_, index) => ({
            type: 'thinking' as const,
            thinking: `thought ${index}`,
            signature: `signature ${index}`,
          })),
        },
      ],
    })) {
      void event
    }

    expect(JSON.stringify(body)).not.toContain('cache_control')
  })

  it('gates cache metadata by endpoint capability and preserves request semantics', async () => {
    const capture = async (
      baseUrl: string,
      promptCaching?: false | { ttl: '5m' | '1h' },
    ) => {
      let body: Record<string, unknown> | undefined
      const provider = new AnthropicCompatibleProvider({
        baseUrl,
        apiKey: 'secret',
        model: 'claude-sonnet-4-20250514',
        ...(promptCaching === undefined ? {} : { promptCaching }),
        fetchImplementation: async (_input, init) => {
          body = JSON.parse(String(init?.body))
          return new Response(
            'data: {"type":"message_start","message":{}}\n\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{}}\n\ndata: {"type":"message_stop"}\n\n',
          )
        },
      })
      for await (const event of provider.complete({
        messages: [
          { role: 'system', content: 'stable' },
          { role: 'user', content: 'prompt' },
        ],
        stableSystemMessageCount: 1,
        tools: [
          {
            name: 'Read',
            description: 'Read a file',
            inputSchema: { type: 'object' },
          },
        ],
      })) {
        void event
      }
      return body
    }
    const generic = await capture('https://relay.example/v1')
    const officialDisabled = await capture(
      'https://api.anthropic.com/v1',
      false,
    )
    const genericOneHour = await capture('https://relay.example/v1', {
      ttl: '1h',
    })

    expect(JSON.stringify(generic)).not.toContain('cache_control')
    expect(JSON.stringify(officialDisabled)).not.toContain('cache_control')
    expect(withoutCacheMetadata(genericOneHour)).toEqual(officialDisabled)
    expect(
      JSON.stringify(genericOneHour).match(/cache_control/gu),
    ).toHaveLength(3)
    expect(JSON.stringify(genericOneHour).match(/"ttl":"1h"/gu)).toHaveLength(3)
  })

  it('keeps stable prompt prefixes byte-identical as the conversation grows', async () => {
    const bodies: Record<string, unknown>[] = []
    const provider = new AnthropicCompatibleProvider({
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: 'secret',
      model: 'claude-sonnet-4-20250514',
      fetchImplementation: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)))
        return new Response(
          'data: {"type":"message_start","message":{}}\n\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{}}\n\ndata: {"type":"message_stop"}\n\n',
        )
      },
    })
    const tools: ModelToolDefinition[] = [
      {
        name: 'Read',
        description: 'Read a file',
        inputSchema: { type: 'object' },
      },
    ]
    const readTool = tools[0]
    if (!readTool) throw new Error('missing Read tool fixture')
    const send = async (
      messages: Parameters<typeof provider.complete>[0]['messages'],
      requestTools = tools,
    ) => {
      for await (const event of provider.complete({
        messages,
        stableSystemMessageCount: 1,
        tools: requestTools,
      })) {
        void event
      }
    }
    await send([
      { role: 'system', content: 'stable' },
      { role: 'system', content: 'dynamic' },
      { role: 'user', content: 'first prompt' },
    ])
    await send([
      { role: 'system', content: 'stable' },
      { role: 'system', content: 'dynamic' },
      { role: 'user', content: 'first prompt' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'second prompt' },
    ])
    await send([
      { role: 'system', content: 'stable' },
      { role: 'system', content: 'changed dynamic tail' },
      { role: 'user', content: 'third prompt' },
    ])
    await send(
      [
        { role: 'system', content: 'stable' },
        { role: 'system', content: 'changed dynamic tail' },
        { role: 'user', content: 'third prompt' },
      ],
      [
        {
          ...readTool,
          inputSchema: {
            type: 'object',
            properties: { file_path: { type: 'string' } },
          },
        },
      ],
    )

    const [first, second, changedTail, changedTool] = bodies
    expect(second?.tools).toEqual(first?.tools)
    expect(second?.system).toEqual(first?.system)
    expect(
      withoutCacheMetadata((second?.messages as unknown[]).slice(0, 1)),
    ).toEqual(withoutCacheMetadata(first?.messages))
    expect(JSON.stringify(first).match(/cache_control/gu)).toHaveLength(3)
    expect(JSON.stringify(second).match(/cache_control/gu)).toHaveLength(3)
    expect((changedTail?.system as unknown[])[0]).toEqual(
      (first?.system as unknown[])[0],
    )
    expect(changedTail?.system).not.toEqual(first?.system)
    expect(changedTool?.tools).not.toEqual(changedTail?.tools)
    expect(
      JSON.stringify({
        tools: changedTool?.tools,
        system: changedTool?.system,
        messages: changedTool?.messages,
      }),
    ).not.toBe(
      JSON.stringify({
        tools: changedTail?.tools,
        system: changedTail?.system,
        messages: changedTail?.messages,
      }),
    )
  })

  it('surfaces configured cache-control rejection without mutating or retrying', async () => {
    const fetchImplementation = vi.fn(async () =>
      Response.json(
        {
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: 'cache_control is not supported by this gateway',
          },
        },
        { status: 400 },
      ),
    )
    const provider = new AnthropicCompatibleProvider({
      baseUrl: 'https://relay.example/v1',
      apiKey: 'secret',
      model: 'fixture-model',
      promptCaching: { ttl: '5m' },
      fetchImplementation,
    })

    const completion = provider.complete({
      messages: [{ role: 'user', content: 'prompt' }],
    })
    const iterator = completion[Symbol.asyncIterator]()
    await expect(iterator.next()).rejects.toMatchObject({
      message: 'cache_control is not supported by this gateway',
      kind: 'invalid_request',
      retryable: false,
      status: 400,
    })
    expect(fetchImplementation).toHaveBeenCalledTimes(1)
  })

  it.each([
    {
      name: 'creation only',
      cacheCreation: 2,
      cacheRead: 0,
      expected: {
        inputTokens: 9,
        outputTokens: 0,
        cacheCreationInputTokens: 2,
      },
    },
    {
      name: 'read only',
      cacheCreation: 0,
      cacheRead: 3,
      expected: {
        inputTokens: 10,
        outputTokens: 0,
        cacheReadInputTokens: 3,
      },
    },
    {
      name: 'zero cache counters',
      cacheCreation: 0,
      cacheRead: 0,
      expected: { inputTokens: 7, outputTokens: 0 },
    },
  ])(
    'normalizes $name without double-counting regular input',
    async (fixture) => {
      const provider = new AnthropicCompatibleProvider({
        baseUrl: 'https://relay.example/v1',
        apiKey: 'secret',
        model: 'fixture-model',
        fetchImplementation: async () =>
          new Response(
            `data: ${JSON.stringify({
              type: 'message_start',
              message: {
                usage: {
                  input_tokens: 7,
                  cache_creation_input_tokens: fixture.cacheCreation,
                  cache_read_input_tokens: fixture.cacheRead,
                },
              },
            })}\n\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":0}}\n\ndata: {"type":"message_stop"}\n\n`,
          ),
      })
      const events = []
      for await (const event of provider.complete({ messages: [] })) {
        events.push(event)
      }

      expect(withoutTerminal(events)).toEqual([
        { type: 'usage', usage: fixture.expected },
      ])
    },
  )

  it('consumes and validates the provider-neutral stable system prefix hint', async () => {
    const provider = new AnthropicCompatibleProvider({
      baseUrl: 'https://api.anthropic.example/v1',
      apiKey: 'secret',
      model: 'fixture-model',
      fetchImplementation: vi.fn(),
    })

    const events = provider.complete({
      messages: [
        { role: 'system', content: 'stable' },
        { role: 'user', content: 'prompt' },
      ],
      stableSystemMessageCount: 2,
    })
    await expect(events[Symbol.asyncIterator]().next()).rejects.toThrow(
      'valid system-message prefix',
    )
  })

  it.each([
    ['end_turn', 'end_turn'],
    ['stop_sequence', 'end_turn'],
    ['refusal', 'end_turn'],
    ['tool_use', 'tool_use'],
    ['max_tokens', 'max_tokens'],
    ['model_context_window_exceeded', 'prompt_too_long'],
  ] as const)(
    'maps Anthropic stop reason %s to terminal reason %s',
    async (stopReason, terminalReason) => {
      const provider = new AnthropicCompatibleProvider({
        baseUrl: 'https://api.anthropic.example/v1',
        apiKey: 'secret',
        model: 'fixture-model',
        fetchImplementation: async () =>
          new Response(
            [
              'data: {"type":"message_start","message":{}}\n\n',
              `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: stopReason }, usage: {} })}\n\n`,
              'data: {"type":"message_stop"}\n\n',
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

  it('fails closed on a missing or unknown Anthropic stop reason', async () => {
    const consume = async (stopReason?: string) => {
      const delta = stopReason === undefined ? {} : { stop_reason: stopReason }
      const provider = new AnthropicCompatibleProvider({
        baseUrl: 'https://api.anthropic.example/v1',
        apiKey: 'secret',
        model: 'fixture-model',
        fetchImplementation: async () =>
          new Response(
            [
              'data: {"type":"message_start","message":{}}\n\n',
              `data: ${JSON.stringify({ type: 'message_delta', delta, usage: {} })}\n\n`,
              'data: {"type":"message_stop"}\n\n',
            ].join(''),
          ),
      })
      for await (const event of provider.complete({ messages: [] })) void event
    }

    await expect(consume()).rejects.toThrow('missing stop reason')
    await expect(consume('future_reason')).rejects.toThrow(
      'unsupported stop reason future_reason',
    )
  })

  it('rejects duplicate Anthropic terminal stop reasons', async () => {
    const provider = new AnthropicCompatibleProvider({
      baseUrl: 'https://api.anthropic.example/v1',
      apiKey: 'secret',
      model: 'fixture-model',
      fetchImplementation: async () =>
        new Response(
          [
            'data: {"type":"message_start","message":{}}\n\n',
            'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{}}\n\n',
            'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{}}\n\n',
          ].join(''),
        ),
    })

    await expect(
      provider.complete({ messages: [] })[Symbol.asyncIterator]().next(),
    ).rejects.toThrow('multiple terminal stop reasons')
  })

  it('exposes only an explicitly configured context window', () => {
    const provider = new AnthropicCompatibleProvider({
      baseUrl: 'https://api.anthropic.example/v1',
      apiKey: 'secret',
      model: 'fixture-model',
      webSearch: true,
      contextWindowTokens: 200_000,
    })

    expect(provider.capabilities).toEqual({
      streaming: true,
      usage: true,
      tools: true,
      images: true,
      documents: true,
      webSearch: true,
      thinking: {
        modes: ['enabled', 'adaptive', 'disabled'],
        maxTokens: true,
      },
      contextWindowTokens: 200_000,
      maxOutputTokens: 8_192,
      terminalReasons: true,
    })
    expect(
      () =>
        new AnthropicCompatibleProvider({
          baseUrl: 'https://api.anthropic.example/v1',
          apiKey: 'secret',
          model: 'fixture-model',
          maxOutputTokens: 0,
        }),
    ).toThrow('positive integer')
  })

  it('exposes the configured max output tokens as a capability', () => {
    const provider = new AnthropicCompatibleProvider({
      baseUrl: 'https://api.anthropic.example/v1',
      apiKey: 'secret',
      model: 'fixture-model',
      maxOutputTokens: 16_384,
    })
    expect(provider.capabilities.maxOutputTokens).toBe(16_384)
    expect(provider.capabilities.contextWindowTokens).toBeUndefined()
  })

  it('derives a default max output tokens capability per model family', () => {
    const claude = new AnthropicCompatibleProvider({
      baseUrl: 'https://api.anthropic.example/v1',
      apiKey: 'secret',
      model: 'claude-sonnet-4-20250514',
    })
    expect(claude.capabilities.maxOutputTokens).toBe(32_000)
    const opus = new AnthropicCompatibleProvider({
      baseUrl: 'https://api.anthropic.example/v1',
      apiKey: 'secret',
      model: 'claude-opus-4-6',
    })
    expect(opus.capabilities.maxOutputTokens).toBe(64_000)
    const generic = new AnthropicCompatibleProvider({
      baseUrl: 'https://api.anthropic.example/v1',
      apiKey: 'secret',
      model: 'fixture-model',
    })
    expect(generic.capabilities.maxOutputTokens).toBe(8_192)
  })

  it('maps thinking controls and preserves signed blocks across tool turns', async () => {
    let body: Record<string, unknown> | undefined
    let headers: Headers | undefined
    const provider = new AnthropicCompatibleProvider({
      baseUrl: 'https://api.anthropic.example/v1',
      apiKey: 'secret',
      model: 'fixture-model',
      maxOutputTokens: 1024,
      thinking: { mode: 'adaptive', maxTokens: 2048 },
      fetchImplementation: async (_input, init) => {
        body = JSON.parse(String(init?.body))
        headers = new Headers(init?.headers)
        return new Response(
          [
            'data: {"type":"message_start","message":{"usage":{"input_tokens":4}}}\n\n',
            'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"reason"}}\n\n',
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"signed"}}\n\n',
            'data: {"type":"content_block_stop","index":0}\n\n',
            'data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
            'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"done"}}\n\n',
            'data: {"type":"content_block_stop","index":1}\n\n',
            'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n',
            'data: {"type":"message_stop"}\n\n',
          ].join(''),
        )
      },
    })

    const events = []
    for await (const event of provider.complete({
      messages: [
        {
          role: 'assistant',
          content: '',
          thinkingBlocks: [
            { type: 'thinking', thinking: 'prior', signature: 'prior-sig' },
          ],
          toolCalls: [{ id: 'call_1', name: 'Read', input: { path: 'a' } }],
        },
        {
          role: 'tool',
          toolCallId: 'call_1',
          content: 'contents',
          isError: false,
        },
      ],
    })) {
      events.push(event)
    }

    expect(body?.max_tokens).toBe(2049)
    expect(body?.thinking).toEqual({
      type: 'enabled',
      budget_tokens: 2048,
    })
    expect(headers?.get('anthropic-beta')).toBe(
      'interleaved-thinking-2025-05-14',
    )
    expect((body?.messages as unknown[])[0]).toEqual({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'prior', signature: 'prior-sig' },
        {
          type: 'tool_use',
          id: 'call_1',
          name: 'Read',
          input: { path: 'a' },
        },
      ],
    })
    expect(withoutTerminal(events)).toEqual([
      { type: 'thinking-start', block: { type: 'thinking', thinking: '' } },
      { type: 'thinking-delta', delta: 'reason' },
      { type: 'thinking-signature-delta', delta: 'signed' },
      {
        type: 'thinking-stop',
        block: { type: 'thinking', thinking: 'reason', signature: 'signed' },
      },
      { type: 'text-delta', delta: 'done' },
      { type: 'usage', usage: { inputTokens: 4, outputTokens: 3 } },
    ])
  })

  it('maps disabled thinking and rejects a disabled token budget', async () => {
    let body: Record<string, unknown> | undefined
    const provider = new AnthropicCompatibleProvider({
      baseUrl: 'https://api.anthropic.example/v1',
      apiKey: 'secret',
      model: 'fixture-model',
      thinking: { mode: 'disabled' },
      fetchImplementation: async (_input, init) => {
        body = JSON.parse(String(init?.body))
        return new Response(
          'data: {"type":"message_start","message":{}}\n\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{}}\n\ndata: {"type":"message_stop"}\n\n',
        )
      },
    })
    for await (const event of provider.complete({
      messages: [{ role: 'user', content: 'hello' }],
    })) {
      void event
    }
    expect(body?.thinking).toEqual({ type: 'disabled' })
    expect(
      () =>
        new AnthropicCompatibleProvider({
          baseUrl: 'https://api.anthropic.example/v1',
          apiKey: 'secret',
          model: 'fixture-model',
          thinking: { mode: 'disabled', maxTokens: 1024 },
        }),
    ).toThrow('cannot be used when thinking is disabled')
  })

  it('streams redacted thinking as an opaque preserved block', async () => {
    const provider = new AnthropicCompatibleProvider({
      baseUrl: 'https://api.anthropic.example/v1',
      apiKey: 'secret',
      model: 'fixture-model',
      fetchImplementation: async () =>
        new Response(
          [
            'data: {"type":"message_start","message":{}}\n\n',
            'data: {"type":"content_block_start","index":0,"content_block":{"type":"redacted_thinking","data":"opaque"}}\n\n',
            'data: {"type":"content_block_stop","index":0}\n\n',
            'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{}}\n\n',
            'data: {"type":"message_stop"}\n\n',
          ].join(''),
        ),
    })
    const events = []
    for await (const event of provider.complete({ messages: [] })) {
      events.push(event)
    }
    expect(withoutTerminal(events)).toEqual([
      {
        type: 'thinking-start',
        block: { type: 'redacted_thinking', data: 'opaque' },
      },
      {
        type: 'thinking-stop',
        block: { type: 'redacted_thinking', data: 'opaque' },
      },
    ])
  })

  it('rejects incomplete thinking blocks before persistence or replay', async () => {
    const incompleteResponse = new AnthropicCompatibleProvider({
      baseUrl: 'https://api.anthropic.example/v1',
      apiKey: 'secret',
      model: 'fixture-model',
      fetchImplementation: async () =>
        new Response(
          [
            'data: {"type":"message_start","message":{}}\n\n',
            'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"reason"}}\n\n',
            'data: {"type":"content_block_stop","index":0}\n\n',
          ].join(''),
        ),
    })
    const responseStream = incompleteResponse.complete({ messages: [] })
    const responseEvents = responseStream[Symbol.asyncIterator]()
    await responseEvents.next()
    await expect(responseEvents.next()).rejects.toThrow(
      'incomplete thinking block',
    )

    let transported = false
    const invalidReplay = new AnthropicCompatibleProvider({
      baseUrl: 'https://api.anthropic.example/v1',
      apiKey: 'secret',
      model: 'fixture-model',
      fetchImplementation: async () => {
        transported = true
        return new Response()
      },
    })
    const replayStream = invalidReplay.complete({
      messages: [
        {
          role: 'assistant',
          content: '',
          thinkingBlocks: [
            { type: 'thinking', thinking: 'reason', signature: '' },
          ],
        },
      ],
    })
    const replayEvents = replayStream[Symbol.asyncIterator]()
    await expect(replayEvents.next()).rejects.toThrow(
      'Cannot replay incomplete thinking block',
    )
    expect(transported).toBe(false)
  })

  it('requires native web search to be explicitly enabled', async () => {
    const provider = new AnthropicCompatibleProvider({
      baseUrl: 'https://relay.example/v1',
      apiKey: 'secret',
      model: 'fixture-model',
    })

    expect(provider.capabilities.webSearch).toBe(false)
    const stream = provider.complete({
      messages: [{ role: 'user', content: 'search' }],
      webSearch: { maxUses: 8 },
    })
    const events = stream[Symbol.asyncIterator]()
    await expect(events.next()).rejects.toThrow(
      'Provider does not support web search',
    )
  })

  it('serializes explicit beta headers', async () => {
    let headers: Headers | undefined
    const provider = new AnthropicCompatibleProvider({
      baseUrl: 'https://relay.example/v1',
      apiKey: 'secret',
      model: 'fixture-model',
      fetchImplementation: async (_input, init) => {
        headers = new Headers(init?.headers)
        return new Response(
          [
            'data: {"type":"message_start","message":{"usage":{}}}\n\n',
            'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{}}\n\n',
            'data: {"type":"message_stop"}\n\n',
          ].join(''),
          {
            headers: { 'content-type': 'text/event-stream' },
          },
        )
      },
    })
    const events = []
    for await (const event of provider.complete({
      messages: [{ role: 'user', content: 'beta' }],
      betas: [
        'context-1m-2025-08-07',
        'fine-grained-tool-streaming-2025-05-14',
      ],
    })) {
      events.push(event)
    }
    expect(withoutTerminal(events)).toEqual([
      { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } },
    ])
    expect(headers?.get('anthropic-beta')).toBe(
      'context-1m-2025-08-07,fine-grained-tool-streaming-2025-05-14',
    )
  })

  it('serializes image tool results as native Anthropic content blocks', async () => {
    let body: Record<string, unknown> | undefined
    const provider = new AnthropicCompatibleProvider({
      baseUrl: 'https://api.anthropic.example/v1',
      apiKey: 'secret',
      model: 'fixture-model',
      webSearch: true,
      fetchImplementation: async (_input, init) => {
        body = JSON.parse(String(init?.body))
        return new Response(
          [
            'data: {"type":"message_start","message":{}}\n\n',
            'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{}}\n\n',
            'data: {"type":"message_stop"}\n\n',
          ].join(''),
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
      ],
    })) {
      events.push(event)
    }

    expect(withoutTerminal(events)).toEqual([])
    expect(body?.messages).toEqual([
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_image',
            content: '',
            is_error: false,
          },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: 'aGVsbG8=',
            },
          },
        ],
      },
    ])
  })

  it('serializes document tool results as native Anthropic content blocks', async () => {
    let body: Record<string, unknown> | undefined
    const provider = new AnthropicCompatibleProvider({
      baseUrl: 'https://api.anthropic.example/v1',
      apiKey: 'secret',
      model: 'fixture-model',
      fetchImplementation: async (_input, init) => {
        body = JSON.parse(String(init?.body))
        return new Response(
          'data: {"type":"message_start","message":{}}\n\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{}}\n\ndata: {"type":"message_stop"}\n\n',
        )
      },
    })

    for await (const event of provider.complete({
      messages: [
        {
          role: 'tool',
          toolCallId: 'call_pdf',
          content: 'PDF extracted',
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
    })) {
      void event
    }

    expect(body?.messages).toEqual([
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_pdf',
            content: 'PDF extracted',
            is_error: false,
          },
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: 'JVBERg==',
            },
          },
        ],
      },
    ])
  })

  it('nests ordered MCP media inside the Anthropic tool result', async () => {
    let body: Record<string, unknown> | undefined
    const provider = new AnthropicCompatibleProvider({
      baseUrl: 'https://api.anthropic.example/v1',
      apiKey: 'secret',
      model: 'fixture-model',
      fetchImplementation: async (_input, init) => {
        body = JSON.parse(String(init?.body))
        return new Response(
          'data: {"type":"message_start","message":{}}\n\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{}}\n\ndata: {"type":"message_stop"}\n\n',
        )
      },
    })
    for await (const event of provider.complete({
      messages: [
        {
          role: 'tool',
          toolCallId: 'call_mcp',
          content: 'audio',
          contentBlocks: [
            { type: 'text', text: 'audio' },
            {
              type: 'image',
              mediaType: 'image/png',
              data: 'aGVsbG8=',
            },
          ],
          isError: false,
        },
      ],
    })) {
      void event
    }
    expect(body?.messages).toEqual([
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_mcp',
            content: [
              { type: 'text', text: 'audio' },
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data: 'aGVsbG8=',
                },
              },
            ],
          },
        ],
      },
    ])
  })

  it('serializes user image attachments as native Anthropic content blocks', async () => {
    let body: Record<string, unknown> | undefined
    const provider = new AnthropicCompatibleProvider({
      baseUrl: 'https://api.anthropic.example/v1',
      apiKey: 'secret',
      model: 'fixture-model',
      fetchImplementation: async (_input, init) => {
        body = JSON.parse(String(init?.body))
        return new Response(
          'data: {"type":"message_start","message":{}}\n\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{}}\n\ndata: {"type":"message_stop"}\n\n',
        )
      },
    })
    for await (const event of provider.complete({
      messages: [
        {
          role: 'user',
          content: 'inspect',
          images: [{ type: 'image', mediaType: 'image/png', data: 'aGVsbG8=' }],
          documents: [
            {
              type: 'document',
              mediaType: 'application/pdf',
              data: 'JVBERg==',
            },
          ],
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
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: 'aGVsbG8=',
            },
          },
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: 'JVBERg==',
            },
          },
        ],
      },
    ])
  })

  it('merges user attachments with explicit content blocks without duplicates', async () => {
    let body: Record<string, unknown> | undefined
    const provider = new AnthropicCompatibleProvider({
      baseUrl: 'https://api.anthropic.example/v1',
      apiKey: 'secret',
      model: 'fixture-model',
      fetchImplementation: async (_input, init) => {
        body = JSON.parse(String(init?.body))
        return new Response(
          'data: {"type":"message_start","message":{}}\n\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{}}\n\ndata: {"type":"message_stop"}\n\n',
        )
      },
    })
    const promptImage = {
      type: 'image' as const,
      mediaType: 'image/png' as const,
      data: 'cHJvbXB0',
    }
    for await (const event of provider.complete({
      messages: [
        {
          role: 'user',
          content: 'prompt',
          contentBlocks: [{ type: 'text', text: 'prompt' }, promptImage],
          images: [
            promptImage,
            {
              type: 'image',
              mediaType: 'image/jpeg',
              data: 'dXNlcg==',
            },
          ],
          documents: [
            {
              type: 'document',
              mediaType: 'application/pdf',
              data: 'JVBERg==',
            },
          ],
        },
      ],
    })) {
      void event
    }
    expect(body?.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'prompt' },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: 'cHJvbXB0',
            },
          },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/jpeg',
              data: 'dXNlcg==',
            },
          },
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: 'JVBERg==',
            },
          },
        ],
      },
    ])
  })

  it('serializes Anthropic messages and streams text with aggregate usage', async () => {
    let capturedUrl = ''
    let capturedInit: RequestInit | undefined
    const fetchImplementation: typeof fetch = vi.fn(async (input, init) => {
      capturedUrl = String(input)
      capturedInit = init
      return new Response(
        [
          'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":7,"cache_creation_input_tokens":2,"cache_read_input_tokens":3,"server_tool_use":{"web_search_requests":2}}}}\n\n',
          'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}\n\n',
          'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
          'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":2,"server_tool_use":{"web_search_requests":3}}}\n\n',
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ].join(''),
        { headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const provider = new AnthropicCompatibleProvider({
      baseUrl: 'https://api.anthropic.example/v1/',
      apiKey: 'secret',
      model: 'fixture-model',
      maxOutputTokens: 4096,
      fetchImplementation,
    })

    const events = []
    for await (const event of provider.complete({
      effort: 'low',
      messages: [
        { role: 'system', content: 'system one' },
        { role: 'system', content: 'system two' },
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
        { role: 'user', content: 'continue' },
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
      { type: 'text-delta', delta: 'hello' },
      {
        type: 'usage',
        usage: {
          inputTokens: 12,
          outputTokens: 3,
          cacheCreationInputTokens: 2,
          cacheReadInputTokens: 3,
          webSearchRequests: 3,
        },
      },
    ])
    expect(capturedUrl).toBe('https://api.anthropic.example/v1/messages')
    expect(capturedInit).toMatchObject({
      method: 'POST',
      headers: {
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'x-api-key': 'secret',
      },
    })
    expect(JSON.parse(String(capturedInit?.body))).toEqual({
      model: 'fixture-model',
      max_tokens: 4096,
      system: [
        { type: 'text', text: 'system one' },
        { type: 'text', text: '\n\nsystem two' },
      ],
      stream: true,
      output_config: { effort: 'low' },
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'read it' }],
        },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'previous_call',
              name: 'Read',
              input: { file_path: 'old.txt' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'previous_call',
              content: 'old contents',
              is_error: false,
            },
            { type: 'text', text: 'continue' },
          ],
        },
      ],
      tools: [
        {
          name: 'Read',
          description: 'Read a file',
          input_schema: { type: 'object' },
        },
      ],
    })
  })

  it.each([
    ['a non-object server_tool_use usage', { server_tool_use: [] }],
    ['a negative counter', { server_tool_use: { web_search_requests: -1 } }],
    ['a fractional counter', { server_tool_use: { web_search_requests: 1.5 } }],
    ['a string counter', { server_tool_use: { web_search_requests: '3' } }],
    [
      'an unsafe integer counter',
      { server_tool_use: { web_search_requests: Number.MAX_SAFE_INTEGER + 1 } },
    ],
  ])(
    'rejects an invalid web search usage counter with %s',
    async (_case, usage) => {
      const provider = new AnthropicCompatibleProvider({
        baseUrl: 'https://api.anthropic.example/v1',
        apiKey: 'secret',
        model: 'fixture-model',
        fetchImplementation: async () =>
          new Response(
            [
              'data: {"type":"message_start","message":{"usage":{}}}\n\n',
              `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage })}\n\n`,
              'data: {"type":"message_stop"}\n\n',
            ].join(''),
          ),
      })

      await expect(
        provider.complete({ messages: [] })[Symbol.asyncIterator]().next(),
      ).rejects.toThrow('web_search_requests')
    },
  )

  it('maps native web search requests and preserves result links', async () => {
    let body: Record<string, unknown> | undefined
    const provider = new AnthropicCompatibleProvider({
      baseUrl: 'https://api.anthropic.example/v1',
      apiKey: 'secret',
      model: 'fixture-model',
      webSearch: true,
      fetchImplementation: async (_input, init) => {
        body = JSON.parse(String(init?.body))
        return new Response(
          [
            'data: {"type":"message_start","message":{"usage":{"input_tokens":3}}}\n\n',
            'data: {"type":"content_block_start","index":0,"content_block":{"type":"server_tool_use","id":"server_call","name":"web_search","input":{}}}\n\n',
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\":\\"marker\\"}"}}\n\n',
            'data: {"type":"content_block_stop","index":0}\n\n',
            'data: {"type":"content_block_start","index":1,"content_block":{"type":"web_search_tool_result","tool_use_id":"server_call","content":[{"type":"web_search_result","title":"Example","url":"https://example.com","encrypted_content":"opaque"}]}}\n\n',
            'data: {"type":"content_block_stop","index":1}\n\n',
            'data: {"type":"content_block_start","index":2,"content_block":{"type":"text","text":""}}\n\n',
            'data: {"type":"content_block_delta","index":2,"delta":{"type":"text_delta","text":"summary"}}\n\n',
            'data: {"type":"content_block_delta","index":2,"delta":{"type":"citations_delta","citation":{"type":"web_search_result_location","url":"https://example.com","title":"Example"}}}\n\n',
            'data: {"type":"content_block_stop","index":2}\n\n',
            'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}\n\n',
            'data: {"type":"message_stop"}\n\n',
          ].join(''),
        )
      },
    })

    const events = []
    for await (const event of provider.complete({
      messages: [
        { role: 'system', content: 'search system' },
        { role: 'user', content: 'search query' },
      ],
      webSearch: {
        allowedDomains: ['example.com'],
        maxUses: 8,
      },
    })) {
      events.push(event)
    }

    expect(withoutTerminal(events)).toEqual([
      {
        type: 'text-delta',
        delta: 'Links: [{"title":"Example","url":"https://example.com"}]\n\n',
      },
      { type: 'text-delta', delta: 'summary' },
      { type: 'usage', usage: { inputTokens: 3, outputTokens: 4 } },
    ])
    expect(body).toEqual({
      model: 'fixture-model',
      max_tokens: 8192,
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'search query' }],
        },
      ],
      stream: true,
      system: [{ type: 'text', text: 'search system' }],
      tools: [
        {
          type: 'web_search_20250305',
          name: 'web_search',
          allowed_domains: ['example.com'],
          max_uses: 8,
        },
      ],
      tool_choice: { type: 'tool', name: 'web_search' },
    })
  })

  it('assembles fragmented tool input and preserves tool order', async () => {
    const provider = new AnthropicCompatibleProvider({
      baseUrl: 'https://api.anthropic.example/v1',
      apiKey: 'secret',
      model: 'fixture-model',
      fetchImplementation: async () =>
        new Response(
          [
            'data: {"type":"message_start","message":{}}\n\n',
            'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"call_bash","name":"Bash","input":{}}}\n\n',
            'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\":"}}\n\n',
            'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"pwd\\"}"}}\n\n',
            'data: {"type":"content_block_stop","index":1}\n\n',
            'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{}}\n\n',
            'data: {"type":"message_stop"}\n\n',
          ].join(''),
        ),
    })

    const events = []
    for await (const event of provider.complete({ messages: [] })) {
      events.push(event)
    }
    expect(withoutTerminal(events)).toEqual([
      {
        type: 'tool-call',
        call: { id: 'call_bash', name: 'Bash', input: { command: 'pwd' } },
      },
    ])
  })

  it('classifies retryable HTTP and stream failures', async () => {
    const httpProvider = new AnthropicCompatibleProvider({
      baseUrl: 'https://api.anthropic.example/v1',
      apiKey: 'secret',
      model: 'fixture-model',
      fetchImplementation: async () =>
        new Response(
          '{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}',
          { status: 429 },
        ),
    })
    const streamProvider = new AnthropicCompatibleProvider({
      baseUrl: 'https://api.anthropic.example/v1',
      apiKey: 'secret',
      model: 'fixture-model',
      fetchImplementation: async () =>
        new Response(
          'data: {"type":"error","error":{"type":"overloaded_error","message":"busy"}}\n\n',
        ),
    })

    await expect(
      httpProvider.complete({ messages: [] })[Symbol.asyncIterator]().next(),
    ).rejects.toMatchObject({
      name: 'ModelProviderError',
      kind: 'rate_limit',
      message: 'slow down',
      retryable: true,
      status: 429,
    })
    await expect(
      streamProvider.complete({ messages: [] })[Symbol.asyncIterator]().next(),
    ).rejects.toMatchObject({
      name: 'ModelProviderError',
      kind: 'overloaded',
      message: 'busy',
      retryable: true,
    })
  })

  it('classifies context overflow, timeout, and cancellation explicitly', async () => {
    const context = new AnthropicCompatibleProvider({
      baseUrl: 'https://api.anthropic.example/v1',
      apiKey: 'secret',
      model: 'fixture-model',
      fetchImplementation: async () =>
        new Response(
          '{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long for the context window"}}',
          { status: 400 },
        ),
    })
    await expect(
      context.complete({ messages: [] })[Symbol.asyncIterator]().next(),
    ).rejects.toMatchObject({ kind: 'prompt_too_long', retryable: false })

    const timeoutError = new Error('timed out')
    timeoutError.name = 'TimeoutError'
    const timeout = new AnthropicCompatibleProvider({
      baseUrl: 'https://api.anthropic.example/v1',
      apiKey: 'secret',
      model: 'fixture-model',
      fetchImplementation: async () => Promise.reject(timeoutError),
    })
    await expect(
      timeout.complete({ messages: [] })[Symbol.asyncIterator]().next(),
    ).rejects.toMatchObject({ kind: 'timeout', retryable: true })

    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    const cancelled = new AnthropicCompatibleProvider({
      baseUrl: 'https://api.anthropic.example/v1',
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

  it.each([
    [500, 'api_error', 'api_error', true],
    [400, 'invalid_request_error', 'invalid_request', false],
  ] as const)(
    'classifies HTTP %s %s as %s',
    async (status, type, kind, retryable) => {
      const provider = new AnthropicCompatibleProvider({
        baseUrl: 'https://api.anthropic.example/v1',
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

  it('recovers malformed and rejects oversized streamed tool input', async () => {
    const malformed = new AnthropicCompatibleProvider({
      baseUrl: 'https://api.anthropic.example/v1',
      apiKey: 'secret',
      model: 'fixture-model',
      fetchImplementation: async () =>
        new Response(
          [
            'data: {"type":"message_start","message":{}}\n\n',
            'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call","name":"Read","input":{}}}\n\n',
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{"}}\n\n',
            'data: {"type":"content_block_stop","index":0}\n\n',
            'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{}}\n\n',
            'data: {"type":"message_stop"}\n\n',
          ].join(''),
        ),
    })
    const oversized = new AnthropicCompatibleProvider({
      baseUrl: 'https://api.anthropic.example/v1',
      apiKey: 'secret',
      model: 'fixture-model',
      maxToolArgumentsBytes: 4,
      fetchImplementation: async () =>
        new Response(
          [
            'data: {"type":"message_start","message":{}}\n\n',
            'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call","name":"Read","input":{}}}\n\n',
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"12345"}}\n\n',
          ].join(''),
        ),
    })

    const malformedEvents = []
    for await (const event of malformed.complete({ messages: [] })) {
      malformedEvents.push(event)
    }
    expect(malformedEvents).toContainEqual({
      type: 'tool-call',
      call: {
        id: 'call',
        name: 'Read',
        input: {},
        inputError: { kind: 'malformed_json', message: 'Malformed tool input' },
      },
    })
    expect(malformedEvents).toContainEqual({
      type: 'terminal',
      reason: 'tool_use',
    })
    await expect(
      oversized.complete({ messages: [] })[Symbol.asyncIterator]().next(),
    ).rejects.toThrow('tool arguments exceeded 4 bytes')
  })

  it('bounds streamed tool-call cardinality', async () => {
    const provider = new AnthropicCompatibleProvider({
      baseUrl: 'https://api.anthropic.example/v1',
      apiKey: 'secret',
      model: 'fixture-model',
      maxToolCallsPerResponse: 1,
      fetchImplementation: async () =>
        new Response(
          [
            'data: {"type":"message_start","message":{}}\n\n',
            'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"one","name":"Read","input":{}}}\n\n',
            'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"two","name":"Read","input":{}}}\n\n',
          ].join(''),
        ),
    })

    await expect(
      provider.complete({ messages: [] })[Symbol.asyncIterator]().next(),
    ).rejects.toThrow('exceeded 1 tool calls')
  })

  it('rejects premature EOF and cancels a stream abandoned by its consumer', async () => {
    const truncated = new AnthropicCompatibleProvider({
      baseUrl: 'https://api.anthropic.example/v1',
      apiKey: 'secret',
      model: 'fixture-model',
      fetchImplementation: async () =>
        new Response(
          [
            'data: {"type":"message_start","message":{}}\n\n',
            'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\n',
            'data: {"type":"content_block_stop","index":0}\n\n',
          ].join(''),
        ),
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
            [
              'data: {"type":"message_start","message":{}}\n\n',
              'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
              'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"first"}}\n\n',
            ].join(''),
          ),
        )
      },
      cancel() {
        cancelled = true
      },
    })
    const abandoned = new AnthropicCompatibleProvider({
      baseUrl: 'https://api.anthropic.example/v1',
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
    const provider = new AnthropicCompatibleProvider({
      baseUrl: 'https://api.anthropic.example/v1',
      apiKey: 'secret',
      model: 'fixture-model',
      maxErrorBodyBytes: 8,
      fetchImplementation: async () =>
        new Response('{"type":"error","error":{"message":"too large"}}', {
          status: 500,
        }),
    })

    await expect(
      provider.complete({ messages: [] })[Symbol.asyncIterator]().next(),
    ).rejects.toThrow('error response exceeded 8 bytes')
  })

  it('enforces content block lifecycle', async () => {
    const inactiveDelta = new AnthropicCompatibleProvider({
      baseUrl: 'https://api.anthropic.example/v1',
      apiKey: 'secret',
      model: 'fixture-model',
      fetchImplementation: async () =>
        new Response(
          [
            'data: {"type":"message_start","message":{}}\n\n',
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"invalid"}}\n\n',
          ].join(''),
        ),
    })
    const unfinishedTool = new AnthropicCompatibleProvider({
      baseUrl: 'https://api.anthropic.example/v1',
      apiKey: 'secret',
      model: 'fixture-model',
      fetchImplementation: async () =>
        new Response(
          [
            'data: {"type":"message_start","message":{}}\n\n',
            'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call","name":"Read","input":{}}}\n\n',
            'data: {"type":"message_stop"}\n\n',
          ].join(''),
        ),
    })
    const blockAfterMessageDelta = new AnthropicCompatibleProvider({
      baseUrl: 'https://api.anthropic.example/v1',
      apiKey: 'secret',
      model: 'fixture-model',
      fetchImplementation: async () =>
        new Response(
          [
            'data: {"type":"message_start","message":{}}\n\n',
            'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{}}\n\n',
            'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"late"}}\n\n',
          ].join(''),
        ),
    })

    await expect(
      inactiveDelta.complete({ messages: [] })[Symbol.asyncIterator]().next(),
    ).rejects.toThrow('inactive content block 0')
    await expect(
      unfinishedTool.complete({ messages: [] })[Symbol.asyncIterator]().next(),
    ).rejects.toThrow('unfinished content blocks')
    const blockAfterMessageDeltaStream = blockAfterMessageDelta.complete({
      messages: [],
    })
    const blockAfterMessageDeltaIterator =
      blockAfterMessageDeltaStream[Symbol.asyncIterator]()
    await expect(blockAfterMessageDeltaIterator.next()).rejects.toThrow(
      'after message_delta',
    )
  })

  it.each([
    ['empty id', { type: 'tool_use', id: '', name: 'Read', input: {} }],
    ['empty name', { type: 'tool_use', id: 'call', name: '', input: {} }],
    [
      'non-object input',
      { type: 'tool_use', id: 'call', name: 'Read', input: [] },
    ],
  ])('rejects invalid tool starts with %s', async (_case, contentBlock) => {
    const provider = new AnthropicCompatibleProvider({
      baseUrl: 'https://api.anthropic.example/v1',
      apiKey: 'secret',
      model: 'fixture-model',
      fetchImplementation: async () =>
        new Response(
          [
            'data: {"type":"message_start","message":{}}\n\n',
            `data: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: contentBlock })}\n\n`,
          ].join(''),
        ),
    })

    await expect(
      provider.complete({ messages: [] })[Symbol.asyncIterator]().next(),
    ).rejects.toThrow('invalid tool call')
  })

  it('completes and cancels the body at message_stop without waiting for EOF', async () => {
    let cancelled = false
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            [
              'data: {"type":"message_start","message":{}}\n\n',
              'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
              'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"done"}}\n\n',
              'data: {"type":"content_block_stop","index":0}\n\n',
              'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{}}\n\n',
              'data: {"type":"message_stop"}\n\n',
            ].join(''),
          ),
        )
      },
      cancel() {
        cancelled = true
      },
    })
    const provider = new AnthropicCompatibleProvider({
      baseUrl: 'https://api.anthropic.example/v1',
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

  it.each([200, 500])(
    'resets byte-idle timeout for Anthropic HTTP %s body activity',
    async (status) => {
      vi.useFakeTimers()
      let controller!: ReadableStreamDefaultController<Uint8Array>
      const body = new ReadableStream<Uint8Array>({
        start(streamController) {
          controller = streamController
        },
      })
      const provider = new DeadlineModelProvider({
        provider: new AnthropicCompatibleProvider({
          baseUrl: 'https://api.anthropic.example/v1',
          apiKey: 'secret',
          model: 'fixture-model',
          fetchImplementation: async () => new Response(body, { status }),
        }),
        deadlineMs: 1_000,
        connectTimeoutMs: 100,
        idleTimeoutMs: 20,
      })
      const completion = provider.complete({ messages: [] })
      const pending = completion[Symbol.asyncIterator]().next()
      let settled = false
      void pending.then(
        () => {
          settled = true
        },
        () => {
          settled = true
        },
      )
      const timedOut = expect(pending).rejects.toMatchObject({
        kind: 'timeout',
        retryable: true,
        timeoutPhase: 'idle',
        message: 'Provider stream idle timed out',
      })

      await vi.advanceTimersByTimeAsync(15)
      controller.enqueue(new TextEncoder().encode(': keepalive\n\n'))
      await vi.advanceTimersByTimeAsync(19)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await timedOut
    },
  )
})
