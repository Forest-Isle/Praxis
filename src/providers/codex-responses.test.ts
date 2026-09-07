import { describe, expect, it } from 'vitest'

import { ModelProviderError, type ModelRequest } from '../core/runtime.js'
import {
  CodexResponsesProvider,
  type CodexResponsesProviderOptions,
} from './codex-responses.js'

function response(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/event-stream' },
  })
}

const completed = 'data: {"type":"response.completed","response":{}}\n\n'

function providerFor(
  fetchImplementation: NonNullable<
    CodexResponsesProviderOptions['fetchImplementation']
  >,
  options: Partial<CodexResponsesProviderOptions> = {},
): CodexResponsesProvider {
  return new CodexResponsesProvider({
    baseUrl: 'https://relay.example.test/v1///',
    apiKey: 'fixture-key',
    model: 'gpt-codex',
    fetchImplementation,
    ...options,
  })
}

async function collect(
  provider: CodexResponsesProvider,
  request?: ModelRequest,
) {
  const events = []
  for await (const event of provider.complete(
    request ?? { messages: [{ role: 'user', content: 'hello' }] },
  ))
    events.push(event)
  return events
}

describe('CodexResponsesProvider', () => {
  it('exposes fixed capabilities and validates error limits', () => {
    const provider = providerFor(async () => response(completed), {
      contextWindowTokens: 123_456,
    })
    expect(provider.capabilities).toMatchObject({
      contextWindowTokens: 123_456,
      documents: false,
      webSearch: false,
      terminalReasons: true,
      thinking: {
        modes: ['disabled', 'enabled', 'adaptive'],
        maxTokens: false,
      },
    })
    for (const maxErrorBodyBytes of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
      expect(() =>
        providerFor(async () => response(completed), { maxErrorBodyBytes }),
      ).toThrow(/positive integers/)
  })

  it('sends the native request dialect and maps the SSE response', async () => {
    let input: string | URL | Request = ''
    let init: RequestInit | undefined
    const provider = providerFor(async (request, requestInit) => {
      input = request
      init = requestInit
      return response(
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ok"}\n\n' +
          completed,
      )
    })
    await expect(collect(provider)).resolves.toEqual([
      { type: 'text-delta', delta: 'ok' },
      { type: 'terminal', reason: 'end_turn' },
    ])
    expect(String(input)).toBe('https://relay.example.test/v1/responses')
    expect(Object.fromEntries(new Headers(init?.headers).entries())).toEqual({
      accept: 'text/event-stream',
      authorization: 'Bearer fixture-key',
      'content-type': 'application/json',
      'openai-beta': 'responses=experimental',
      originator: 'praxis',
    })
    expect(JSON.parse(String(init?.body))).toMatchObject({
      input: [{ type: 'message', role: 'user' }],
      tool_choice: 'auto',
      parallel_tool_calls: true,
    })
  })

  it.each([
    [401, 'authentication_failed'],
    [402, 'billing_error'],
    [408, 'timeout'],
    [429, 'rate_limit'],
    [529, 'overloaded'],
    [500, 'server_error'],
    [400, 'invalid_request'],
  ] as const)(
    'classifies HTTP %i as %s without exposing response bodies',
    async (status, kind) => {
      const provider = providerFor(async () =>
        response('{"secret":"hidden"}', status),
      )
      const error = await collect(provider).catch((value: unknown) => value)
      expect(error).toBeInstanceOf(ModelProviderError)
      expect(error).toMatchObject({ kind, status })
      expect(String(error)).not.toContain('hidden')
    },
  )

  it('bounds and cancels unfinished error bodies without leaking them', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('secret-body'))
      },
      cancel() {
        cancelled = true
      },
    })
    const provider = providerFor(
      async () => new Response(body, { status: 500 }),
      { maxErrorBodyBytes: 4 },
    )
    const error = await collect(provider).catch((value: unknown) => value)
    expect(error).toMatchObject({ kind: 'server_error', status: 500 })
    expect(String(error)).not.toContain('secret-body')
    expect(cancelled).toBe(true)
  })

  it.each([
    ['cancelled', { name: 'AbortError' }, true],
    ['timeout', { name: 'TimeoutError' }, false],
    ['timeout', { code: 'ETIMEDOUT' }, false],
    ['transport_error', { message: 'secret transport failure' }, false],
  ] as const)(
    'classifies fetch rejection as %s',
    async (kind, thrown, aborted) => {
      const controller = new AbortController()
      if (aborted) controller.abort()
      const provider = providerFor(async () => {
        throw thrown
      })
      const error = await collect(provider, {
        signal: controller.signal,
        messages: [{ role: 'user', content: 'hello' }],
      }).catch((value: unknown) => value)
      expect(error).toMatchObject({
        kind,
        retryable: kind !== 'cancelled',
      })
      expect(String(error)).not.toContain('secret transport failure')
    },
  )
})
