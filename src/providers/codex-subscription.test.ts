import { describe, expect, it } from 'vitest'

import { ModelProviderError } from '../core/runtime.js'
import { CodexOAuthError } from './codex-oauth.js'
import {
  CODEX_RESPONSES_ENDPOINT,
  CodexSubscriptionProvider,
  serializeCodexRequest,
} from './codex-subscription.js'

const access = async () => ({
  accessToken: 'fixture-access-token',
  accountId: 'fixture-account',
  expiresAt: Date.now() + 60 * 60_000,
})

function response(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/event-stream' },
  })
}

async function events(provider: CodexSubscriptionProvider) {
  const result = []
  for await (const event of provider.complete({
    messages: [{ role: 'user', content: 'hello' }],
  }))
    result.push(event)
  return result
}

function providerFor(
  body: string,
  options: Partial<
    ConstructorParameters<typeof CodexSubscriptionProvider>[0]
  > = {},
) {
  return new CodexSubscriptionProvider({
    model: 'gpt-codex',
    access,
    fetchImplementation: async () => response(body),
    ...options,
  })
}

describe('CodexSubscriptionProvider', () => {
  it('serializes the fixed Responses request and media/tool shapes', () => {
    const body = serializeCodexRequest(
      {
        messages: [
          { role: 'system', content: 'one' },
          {
            role: 'user',
            content: 'fallback',
            contentBlocks: [
              { type: 'text', text: 'hello' },
              { type: 'image', mediaType: 'image/png', data: 'abc' },
            ],
            images: [{ type: 'image', mediaType: 'image/png', data: 'abc' }],
          },
          {
            role: 'assistant',
            content: 'answer',
            toolCalls: [{ id: 'call-1', name: 'lookup', input: { q: 'x' } }],
          },
          {
            role: 'tool',
            toolCallId: 'call-1',
            content: 'legacy-result',
            contentBlocks: [
              { type: 'text', text: 'block-result' },
              { type: 'image', mediaType: 'image/jpeg', data: 'xyz' },
            ],
            images: [{ type: 'image', mediaType: 'image/jpeg', data: 'xyz' }],
            isError: false,
          },
        ],
        thinking: { mode: 'enabled' },
        effort: 'high',
        tools: [
          {
            name: 'lookup',
            description: 'Find',
            inputSchema: { type: 'object' },
          },
        ],
      },
      'gpt-codex',
    )
    expect(body).toMatchObject({
      model: 'gpt-codex',
      store: false,
      stream: true,
      include: ['reasoning.encrypted_content'],
      instructions: 'one',
      reasoning: { effort: 'high', summary: 'auto' },
      tools: [{ type: 'function', name: 'lookup', strict: false }],
    })
    expect(body.input).toEqual([
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'hello' },
          { type: 'input_image', image_url: 'data:image/png;base64,abc' },
        ],
      },
      { role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
      {
        type: 'function_call',
        call_id: 'call-1',
        name: 'lookup',
        arguments: '{"q":"x"}',
      },
      {
        type: 'function_call_output',
        call_id: 'call-1',
        output: 'block-result',
      },
      {
        role: 'user',
        content: [
          { type: 'input_image', image_url: 'data:image/jpeg;base64,xyz' },
        ],
      },
    ])
  })

  it('maps text, usage, function calls, and terminal output', async () => {
    const calls: Array<{ input: string | URL | Request; init?: RequestInit }> =
      []
    const provider = new CodexSubscriptionProvider({
      model: 'gpt-codex',
      access,
      fetchImplementation: async (input, init) => {
        calls.push({ input, ...(init === undefined ? {} : { init }) })
        return response(
          [
            'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ok"}',
            'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"function_call","id":"item-1","call_id":"call-1","name":"lookup","arguments":"{\\"q\\":\\"x\\"}"}}',
            'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":2,"input_tokens_details":{"cached_tokens":1}}}}',
            '',
          ].join('\n\n'),
        )
      },
    })
    await expect(events(provider)).resolves.toEqual([
      { type: 'text-delta', delta: 'ok' },
      {
        type: 'tool-call',
        call: { id: 'call-1', name: 'lookup', input: { q: 'x' } },
      },
      {
        type: 'usage',
        usage: { inputTokens: 3, outputTokens: 2, cacheReadInputTokens: 1 },
      },
      { type: 'terminal', reason: 'tool_use' },
    ])
    expect(String(calls[0]?.input)).toBe(CODEX_RESPONSES_ENDPOINT)
    expect(new Headers(calls[0]?.init?.headers).get('chatgpt-account-id')).toBe(
      'fixture-account',
    )
  })

  it('refreshes once on a pre-output 401 and redacts provider failures', async () => {
    let accessCalls = 0
    let requests = 0
    const provider = new CodexSubscriptionProvider({
      model: 'gpt-codex',
      access: async (options) => {
        accessCalls++
        if (options?.forceAfter)
          return {
            accessToken: 'fresh',
            accountId: 'account',
            expiresAt: Date.now() + 100000,
          }
        return {
          accessToken: 'stale',
          accountId: 'account',
          expiresAt: Date.now() + 100000,
        }
      },
      fetchImplementation: async () => {
        requests++
        if (requests === 1) return response('{"secret":"provider detail"}', 401)
        return response('data: {"type":"response.completed","response":{}}\n\n')
      },
    })
    await expect(events(provider)).resolves.toEqual([
      { type: 'terminal', reason: 'end_turn' },
    ])
    expect(accessCalls).toBe(2)
    expect(requests).toBe(2)

    const failing = new CodexSubscriptionProvider({
      model: 'gpt-codex',
      access,
      fetchImplementation: async () =>
        response('{"message":"token-leak"}', 403),
    })
    const error = await (async () => {
      try {
        await events(failing)
        throw new Error('expected failure')
      } catch (value) {
        return value
      }
    })()
    expect(error).toBeInstanceOf(ModelProviderError)
    expect(String(error)).not.toContain('token-leak')

    let second401Accesses = 0
    const second401 = providerFor('', {
      access: async () => ({
        accessToken: `token-${++second401Accesses}`,
        accountId: 'account',
        expiresAt: Date.now() + 100000,
      }),
      fetchImplementation: async () => response('secret-body', 401),
    })
    await expect(events(second401)).rejects.toMatchObject({
      kind: 'authentication_failed',
      retryable: false,
      status: 401,
    })
    expect(second401Accesses).toBe(2)
  })

  it('fails closed for unsupported capabilities and incomplete streams', async () => {
    expect(() =>
      serializeCodexRequest(
        {
          messages: [{ role: 'user', content: 'x' }],
          webSearch: { maxUses: 1 },
        },
        'm',
      ),
    ).toThrow(/web search/iu)
    expect(() =>
      serializeCodexRequest(
        {
          messages: [{ role: 'user', content: 'x' }],
          thinking: { mode: 'enabled', maxTokens: 10 },
        },
        'm',
      ),
    ).toThrow(/token/iu)
    const provider = new CodexSubscriptionProvider({
      model: 'm',
      access,
      fetchImplementation: async () =>
        response('data: {"type":"response.output_text.delta","delta":"x"}\n\n'),
    })
    await expect(events(provider)).rejects.toMatchObject({
      kind: 'transport_error',
      retryable: true,
    })
  })

  it('classifies OAuth failures without leaking their messages', async () => {
    const provider = providerFor('', {
      access: async () => {
        throw new CodexOAuthError('refresh_failure', 'fixture-secret')
      },
    })
    await expect(events(provider)).rejects.toMatchObject({
      kind: 'authentication_failed',
      retryable: false,
    })
    try {
      await events(provider)
    } catch (error) {
      expect(String(error)).not.toContain('fixture-secret')
    }
    const cancelled = providerFor('', {
      access: async () => {
        throw new CodexOAuthError('authorization_cancelled', 'cancelled-secret')
      },
    })
    await expect(events(cancelled)).rejects.toMatchObject({
      kind: 'cancelled',
      retryable: false,
    })
  })

  it('rejects malformed usage values rather than silently dropping them', async () => {
    const invalidUsages = [
      {},
      { input_tokens: 1 },
      { input_tokens: 1.5, output_tokens: 1 },
      { input_tokens: -1, output_tokens: 1 },
      { input_tokens: Number.NaN, output_tokens: 1 },
      {
        input_tokens: 1,
        output_tokens: 1,
        input_tokens_details: { cached_tokens: -1 },
      },
    ]
    for (const usage of invalidUsages) {
      const provider = providerFor(
        `data: ${JSON.stringify({ type: 'response.completed', response: { usage } })}\n\n`,
      )
      await expect(events(provider)).rejects.toMatchObject({
        kind: 'invalid_request',
        retryable: false,
      })
    }
  })

  it('aggregates sequential reasoning parts and correlates the completed item', async () => {
    const body = [
      'data: {"type":"response.reasoning_summary_part.added","item_id":"reason-1"}',
      'data: {"type":"response.reasoning_summary_text.delta","item_id":"reason-1","delta":"first"}',
      'data: {"type":"response.reasoning_summary_part.done","item_id":"reason-1"}',
      'data: {"type":"response.reasoning_summary_part.added","item_id":"reason-1"}',
      'data: {"type":"response.reasoning_summary_text.delta","item_id":"reason-1","delta":"second"}',
      'data: {"type":"response.reasoning_summary_part.done","item_id":"reason-1"}',
      'data: {"type":"response.output_item.done","item":{"type":"reasoning","id":"reason-1","encrypted_content":"signature"}}',
      'data: {"type":"response.completed","response":{}}',
      '',
    ].join('\n\n')
    await expect(events(providerFor(body))).resolves.toEqual([
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
      { type: 'terminal', reason: 'end_turn' },
    ])
  })

  it('synthesizes a valid reasoning summary carried only by the done item', async () => {
    const body = [
      'data: {"type":"response.output_item.done","item":{"type":"reasoning","id":"reason-1","summary":[{"type":"summary_text","text":"summary"}],"encrypted_content":"sig"}}',
      'data: {"type":"response.completed","response":{}}',
      '',
    ].join('\n\n')
    await expect(events(providerFor(body))).resolves.toContainEqual({
      type: 'thinking-stop',
      block: { type: 'thinking', thinking: 'summary', signature: 'sig' },
    })
    await expect(
      events(providerFor(body, { maxReasoningBytes: 3 })),
    ).rejects.toMatchObject({ kind: 'invalid_request' })
  })

  it('bounds aggregate arguments, requires exact full/delta agreement, and validates indices', async () => {
    const delta = (id: string, text: string) =>
      `data: ${JSON.stringify({ type: 'response.function_call_arguments.delta', item_id: id, delta: text })}`
    const done = (id: string, args: string, index = 0) =>
      `data: ${JSON.stringify({ type: 'response.output_item.done', output_index: index, item: { type: 'function_call', id, call_id: `call-${id}`, name: 'fn', arguments: args } })}`
    await expect(
      events(
        providerFor(
          [
            delta('a', '{}'),
            delta('b', '{}'),
            done('a', '{}', 0),
            done('b', '{}', 1),
            'data: {"type":"response.completed","response":{}}',
            '',
          ].join('\n\n'),
          { maxToolArgumentsBytes: 3 },
        ),
      ),
    ).rejects.toMatchObject({ kind: 'invalid_request' })
    await expect(
      events(
        providerFor([delta('a', '{'), done('a', '{}', 0), ''].join('\n\n')),
      ),
    ).rejects.toMatchObject({ kind: 'invalid_request' })
    await expect(
      events(providerFor(`${done('a', '[]', 0)}\n\n`)),
    ).rejects.toMatchObject({ kind: 'invalid_request' })
  })

  it('rejects invalid thinking modes and bounds parser limits', async () => {
    expect(() =>
      serializeCodexRequest(
        {
          messages: [
            { role: 'system', content: 'a' },
            { role: 'system', content: 'b' },
            { role: 'user', content: 'x' },
          ],
          thinking: { mode: 'invalid' as never },
        },
        'm',
      ),
    ).toThrow(/thinking mode/iu)
    expect(
      () =>
        new CodexSubscriptionProvider({
          model: 'm',
          access,
          maxReasoningBytes: 0,
        }),
    ).toThrow()
    expect(
      () =>
        new CodexSubscriptionProvider({
          model: 'm',
          access,
          maxToolArgumentsBytes: 1.5,
        }),
    ).toThrow()
    const malformed = providerFor('data: not-json\n\n')
    await expect(events(malformed)).rejects.toMatchObject({
      kind: 'invalid_request',
      retryable: false,
    })
  })

  it('maps incomplete responses and redacts provider stream errors', async () => {
    const max = providerFor(
      'data: {"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"}}}\n\n',
    )
    await expect(events(max)).resolves.toEqual([
      { type: 'terminal', reason: 'max_tokens' },
    ])
    const unknown = providerFor(
      'data: {"type":"response.incomplete","response":{"incomplete_details":{"reason":"content_filter"}}}\n\n',
    )
    await expect(events(unknown)).rejects.toMatchObject({
      kind: 'invalid_request',
      retryable: false,
    })
    const failed = providerFor(
      'data: {"type":"response.failed","error":{"message":"secret-provider-error"}}\n\n',
    )
    await expect(events(failed)).rejects.toMatchObject({
      kind: 'api_error',
      retryable: true,
    })
  })

  it('cancels an unread stream when the consumer abandons iteration', async () => {
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
    const provider = new CodexSubscriptionProvider({
      model: 'm',
      access,
      fetchImplementation: async () => new Response(stream),
    })
    const iterable = provider.complete({
      messages: [{ role: 'user', content: 'x' }],
    })
    const iterator = iterable[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toEqual({
      value: { type: 'text-delta', delta: 'x' },
      done: false,
    })
    await iterator.return?.()
    expect(cancelled).toBe(true)
  })
})
