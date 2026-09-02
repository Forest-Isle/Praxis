import { describe, expect, it, vi } from 'vitest'

import type { ModelRequest, ModelStreamEvent } from '../core/runtime.js'
import {
  OpenAIResponsesProvider,
  type OpenAIResponsesProviderOptions,
} from './openai-responses.js'

const completed = 'data: {"type":"response.completed","response":{}}\n\n'

function response(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/event-stream' },
  })
}

function chunkedResponse(body: string, width = 13): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < body.length; offset += width)
          controller.enqueue(encoder.encode(body.slice(offset, offset + width)))
        controller.close()
      },
    }),
  )
}

function providerFor(
  body: string,
  options: Partial<OpenAIResponsesProviderOptions> = {},
): OpenAIResponsesProvider {
  return new OpenAIResponsesProvider({
    baseUrl: 'https://api.example.test/v1/',
    apiKey: 'fixture-key',
    model: 'gpt-responses',
    fetchImplementation: async () => response(body),
    ...options,
  })
}

async function collect(
  provider: OpenAIResponsesProvider,
  request: ModelRequest = {
    messages: [{ role: 'user', content: 'hello' }],
  },
): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = []
  for await (const event of provider.complete(request)) events.push(event)
  return events
}

async function rejected(
  provider: OpenAIResponsesProvider,
  request?: ModelRequest,
): Promise<unknown> {
  try {
    await collect(provider, request)
    throw new Error('expected provider failure')
  } catch (error) {
    return error
  }
}

describe('OpenAIResponsesProvider', () => {
  it('sends only public headers and the complete stateless Responses history', async () => {
    const calls: Array<{ input: string | URL | Request; init?: RequestInit }> =
      []
    const provider = providerFor(completed, {
      thinking: { mode: 'enabled' },
      fetchImplementation: async (input, init) => {
        calls.push({ input, ...(init === undefined ? {} : { init }) })
        return response(completed)
      },
    })
    const request: ModelRequest = {
      messages: [
        { role: 'system', content: 'first' },
        { role: 'system', content: 'second' },
        {
          role: 'user',
          content: 'fallback',
          contentBlocks: [
            { type: 'text', text: 'question' },
            { type: 'image', mediaType: 'image/png', data: 'user-image' },
          ],
        },
        {
          role: 'assistant',
          content: 'working',
          thinkingBlocks: [
            { type: 'thinking', thinking: 'summary', signature: 'encrypted' },
          ],
          toolCalls: [{ id: 'call-1', name: 'lookup', input: { q: 'x' } }],
        },
        {
          role: 'tool',
          toolCallId: 'call-1',
          content: 'fallback-result',
          contentBlocks: [
            { type: 'text', text: 'result' },
            { type: 'image', mediaType: 'image/jpeg', data: 'tool-image' },
          ],
          isError: false,
        },
      ],
      tools: [
        {
          name: 'lookup',
          description: 'Look up a value',
          inputSchema: { type: 'object' },
        },
      ],
      thinking: { mode: 'enabled' },
      effort: 'high',
    }

    await expect(collect(provider, request)).resolves.toEqual([
      { type: 'terminal', reason: 'end_turn' },
    ])
    expect(String(calls[0]?.input)).toBe(
      'https://api.example.test/v1/responses',
    )
    const headers = Object.fromEntries(
      new Headers(calls[0]?.init?.headers).entries(),
    )
    expect(headers).toEqual({
      accept: 'text/event-stream',
      authorization: 'Bearer fixture-key',
      'content-type': 'application/json',
    })
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<
      string,
      unknown
    >
    expect(body).toMatchObject({
      model: 'gpt-responses',
      store: false,
      stream: true,
      include: ['reasoning.encrypted_content'],
      instructions: 'first\n\nsecond',
      reasoning: { effort: 'high', summary: 'auto' },
      tools: [{ type: 'function', name: 'lookup', strict: false }],
    })
    expect(body).not.toHaveProperty('previous_response_id')
    expect(body.input).toEqual([
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'question' },
          {
            type: 'input_image',
            image_url: 'data:image/png;base64,user-image',
          },
        ],
      },
      {
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: 'summary' }],
        encrypted_content: 'encrypted',
      },
      {
        role: 'assistant',
        content: [{ type: 'output_text', text: 'working' }],
      },
      {
        type: 'function_call',
        call_id: 'call-1',
        name: 'lookup',
        arguments: '{"q":"x"}',
      },
      {
        type: 'function_call_output',
        call_id: 'call-1',
        output: 'result',
      },
      {
        role: 'user',
        content: [
          {
            type: 'input_image',
            image_url: 'data:image/jpeg;base64,tool-image',
          },
        ],
      },
    ])
  })

  it('parses fragmented CRLF text, multipart reasoning, tools, cached usage, and one terminal', async () => {
    const frames = [
      '{"type":"response.reasoning_summary_part.added","item_id":"reason-1"}',
      '{"type":"response.reasoning_summary_text.delta","item_id":"reason-1","delta":"first"}',
      '{"type":"response.reasoning_summary_part.done","item_id":"reason-1"}',
      '{"type":"response.reasoning_summary_part.added","item_id":"reason-1"}',
      '{"type":"response.reasoning_summary_text.delta","item_id":"reason-1","delta":"second"}',
      '{"type":"response.reasoning_summary_part.done","item_id":"reason-1"}',
      '{"type":"response.output_item.done","item":{"type":"reasoning","id":"reason-1","encrypted_content":"signature"}}',
      '{"type":"response.output_text.delta","delta":"answer"}',
      '{"type":"response.function_call_arguments.delta","item_id":"item-1","delta":"{\\"q\\":"}',
      '{"type":"response.function_call_arguments.delta","item_id":"item-1","delta":"\\"x\\"}"}',
      '{"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","id":"item-1","call_id":"call-1","name":"lookup","arguments":"{\\"q\\":\\"x\\"}"}}',
      '{"type":"response.completed","response":{"usage":{"input_tokens":5,"output_tokens":3,"input_tokens_details":{"cached_tokens":2}}}}',
    ]
    const wire =
      frames.map((frame) => `data: ${frame}`).join('\r\n\r\n') + '\r\n\r\n'
    const provider = providerFor('', {
      fetchImplementation: async () => chunkedResponse(wire, 7),
    })

    await expect(collect(provider)).resolves.toEqual([
      { type: 'thinking-start', block: { type: 'thinking', thinking: '' } },
      { type: 'thinking-delta', delta: 'first' },
      { type: 'thinking-delta', delta: '\n' },
      { type: 'thinking-delta', delta: 'second' },
      { type: 'thinking-signature-delta', delta: 'signature' },
      {
        type: 'thinking-stop',
        block: {
          type: 'thinking',
          thinking: 'first\nsecond',
          signature: 'signature',
        },
      },
      { type: 'text-delta', delta: 'answer' },
      {
        type: 'tool-call',
        call: { id: 'call-1', name: 'lookup', input: { q: 'x' } },
      },
      {
        type: 'usage',
        usage: { inputTokens: 5, outputTokens: 3, cacheReadInputTokens: 2 },
      },
      { type: 'terminal', reason: 'tool_use' },
    ])
  })

  it('recognizes CRLF frame delimiters split across adjacent chunks', async () => {
    const encoder = new TextEncoder()
    const chunks = [
      'data: {"type":"response.output_text.delta","delta":"ok"}\r',
      '\n\r',
      '\ndata: {"type":"response.completed","response":{}}\r',
      '\n\r',
      '\n',
    ]
    const provider = providerFor('', {
      fetchImplementation: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (const chunk of chunks)
                controller.enqueue(encoder.encode(chunk))
              controller.close()
            },
          }),
        ),
    })

    await expect(collect(provider)).resolves.toEqual([
      { type: 'text-delta', delta: 'ok' },
      { type: 'terminal', reason: 'end_turn' },
    ])
  })

  it('recovers malformed function arguments and maps incomplete terminals', async () => {
    const malformed = providerFor(
      [
        'data: {"type":"response.output_item.done","item":{"type":"function_call","id":"item-1","call_id":"call-1","name":"lookup","arguments":"{"}}',
        'data: {"type":"response.completed","response":{}}',
        '',
      ].join('\n\n'),
    )
    await expect(collect(malformed)).resolves.toEqual([
      {
        type: 'tool-call',
        call: {
          id: 'call-1',
          name: 'lookup',
          input: {},
          inputError: {
            kind: 'malformed_json',
            message: 'Malformed tool input',
          },
        },
      },
      { type: 'terminal', reason: 'tool_use' },
    ])

    const incomplete = providerFor(
      'data: {"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"}}}\n\n',
    )
    await expect(collect(incomplete)).resolves.toEqual([
      { type: 'terminal', reason: 'max_tokens' },
    ])
    await expect(
      collect(
        providerFor(
          'data: {"type":"response.incomplete","response":{"incomplete_details":{"reason":"content_filter"}}}\n\n',
        ),
      ),
    ).rejects.toMatchObject({ kind: 'invalid_request', retryable: false })
  })

  it('rejects premature EOF and cancels an abandoned response stream', async () => {
    await expect(
      collect(
        providerFor(
          'data: {"type":"response.output_text.delta","delta":"partial"}\n\n',
        ),
      ),
    ).rejects.toMatchObject({ kind: 'transport_error', retryable: true })

    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"type":"response.output_text.delta","delta":"x"}\n\n',
          ),
        )
      },
      cancel() {
        cancelled = true
      },
    })
    const provider = providerFor('', {
      fetchImplementation: async () => new Response(stream),
    })
    const completion = provider.complete({
      messages: [{ role: 'user', content: 'x' }],
    })
    const iterator = completion[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toEqual({
      value: { type: 'text-delta', delta: 'x' },
      done: false,
    })
    await iterator.return?.()
    expect(cancelled).toBe(true)
  })

  it('maps fetch cancellation without retrying', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetchImplementation = vi.fn(async () => {
      throw new Error('secret transport detail')
    })
    const provider = providerFor('', { fetchImplementation })
    await expect(
      collect(provider, {
        messages: [{ role: 'user', content: 'x' }],
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ kind: 'cancelled', retryable: false })
    expect(fetchImplementation).toHaveBeenCalledTimes(1)
  })

  it('cancels a pending response-body read when the request signal aborts', async () => {
    let cancelled = false
    let markPulled!: () => void
    const pulled = new Promise<void>((resolve) => {
      markPulled = resolve
    })
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        markPulled()
      },
      cancel() {
        cancelled = true
      },
    })
    const controller = new AbortController()
    const pending = collect(
      providerFor('', {
        fetchImplementation: async () => new Response(stream),
      }),
      {
        messages: [{ role: 'user', content: 'x' }],
        signal: controller.signal,
      },
    )

    await pulled
    controller.abort()
    await expect(pending).rejects.toMatchObject({
      kind: 'cancelled',
      retryable: false,
    })
    expect(cancelled).toBe(true)
  })

  it.each([
    [
      401,
      { error: { message: 'secret-auth' } },
      'authentication_failed',
      false,
    ],
    [402, { error: { message: 'secret-billing' } }, 'billing_error', false],
    [408, { error: { message: 'secret-timeout' } }, 'timeout', true],
    [429, { error: { message: 'secret-rate' } }, 'rate_limit', true],
    [529, { error: { type: 'overloaded_error' } }, 'overloaded', true],
    [500, { error: { message: 'secret-server' } }, 'server_error', true],
    [400, { error: { message: 'secret-invalid' } }, 'invalid_request', false],
    [
      400,
      {
        error: {
          code: 'context_length_exceeded',
          message: 'secret context marker',
        },
      },
      'prompt_too_long',
      false,
    ],
  ] as const)(
    'maps and redacts public HTTP %s errors',
    async (status, body, kind, retryable) => {
      const fetchImplementation = vi.fn(async () =>
        Response.json(body, { status }),
      )
      const failure = await rejected(providerFor('', { fetchImplementation }))
      expect(failure).toMatchObject({ kind, retryable, status })
      expect(String(failure)).not.toContain('secret')
      expect(fetchImplementation).toHaveBeenCalledTimes(1)
    },
  )

  it('bounds and redacts oversized HTTP errors', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            '{"error":{"message":"secret-error-body-that-is-too-long"}}',
          ),
        )
      },
      cancel() {
        cancelled = true
      },
    })
    const failure = await rejected(
      providerFor('', {
        maxErrorBodyBytes: 8,
        fetchImplementation: async () => new Response(body, { status: 400 }),
      }),
    )
    expect(failure).toMatchObject({ kind: 'invalid_request', status: 400 })
    expect(String(failure)).not.toContain('secret')
    expect(cancelled).toBe(true)
  })

  it('enforces every aggregate Responses codec bound', async () => {
    await expect(
      collect(providerFor('12345', { maxStreamBufferBytes: 4 })),
    ).rejects.toMatchObject({ kind: 'invalid_request' })
    await expect(
      collect(
        providerFor(
          'data: {"type":"response.function_call_arguments.delta","item_id":"a","delta":"{}"}\n\n',
          { maxToolArgumentsBytes: 1 },
        ),
      ),
    ).rejects.toMatchObject({ kind: 'invalid_request' })
    await expect(
      collect(
        providerFor(
          [
            'data: {"type":"response.function_call_arguments.delta","item_id":"a","delta":""}',
            'data: {"type":"response.function_call_arguments.delta","item_id":"b","delta":""}',
            '',
          ].join('\n\n'),
          { maxToolCallsPerResponse: 1 },
        ),
      ),
    ).rejects.toMatchObject({ kind: 'invalid_request' })
    await expect(
      collect(
        providerFor(
          'data: {"type":"response.function_call_arguments.delta","item_id":"long-id","delta":""}\n\n',
          { maxToolMetadataBytes: 2 },
        ),
      ),
    ).rejects.toMatchObject({ kind: 'invalid_request' })
    await expect(
      collect(
        providerFor(
          'data: {"type":"response.output_item.done","item":{"type":"reasoning","id":"r","summary":[{"type":"summary_text","text":"summary"}],"encrypted_content":"signature"}}\n\n',
          { maxReasoningBytes: 3 },
        ),
      ),
    ).rejects.toMatchObject({ kind: 'invalid_request' })
  })

  it('fails closed before fetch for unsupported request capabilities', async () => {
    const fetchImplementation = vi.fn(async () => response(completed))
    const provider = providerFor('', { fetchImplementation })
    const requests: ModelRequest[] = [
      {
        messages: [{ role: 'user', content: 'x' }],
        webSearch: { maxUses: 1 },
      },
      {
        messages: [{ role: 'user', content: 'x' }],
        betas: ['future'],
      },
      {
        messages: [
          {
            role: 'user',
            content: 'x',
            documents: [
              { type: 'document', mediaType: 'text/plain', data: 'x' },
            ],
          },
        ],
      },
      {
        messages: [{ role: 'user', content: 'x' }],
        thinking: { mode: 'enabled', maxTokens: 10 },
      },
    ]
    for (const request of requests)
      await expect(collect(provider, request)).rejects.toMatchObject({
        kind: 'invalid_request',
        retryable: false,
      })
    expect(fetchImplementation).not.toHaveBeenCalled()
    expect(() =>
      providerFor('', {
        thinking: { mode: 'invalid' as never },
      }),
    ).toThrow(/OpenAI Responses provider.*thinking mode/iu)
    expect(() =>
      providerFor('', {
        thinking: { mode: 'enabled', maxTokens: 1 },
      }),
    ).toThrow(/OpenAI Responses provider.*token budgets/iu)
  })

  it('uses public provider labels for malformed stream errors', async () => {
    const failure = await rejected(providerFor('data: not-json\n\n'))
    expect(failure).toMatchObject({ kind: 'invalid_request', retryable: false })
    expect(String(failure)).toContain('OpenAI Responses provider')
    expect(String(failure)).not.toContain('Codex')
  })

  it('redacts provider stream failures behind the shared error contract', async () => {
    const failure = await rejected(
      providerFor(
        'data: {"type":"response.failed","error":{"message":"secret-provider-detail"}}\n\n',
      ),
    )
    expect(failure).toMatchObject({ kind: 'api_error', retryable: true })
    expect(String(failure)).toContain('OpenAI Responses provider')
    expect(String(failure)).not.toContain('secret-provider-detail')
  })
})
