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

  it('surfaces the required 404 model-not-found diagnostics exactly', async () => {
    const provider = providerFor(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              type: 'invalid_request_error',
              code: 'model_not_found',
              message: 'secret',
            },
          }),
          {
            status: 404,
            headers: { 'x-request-id': 'req_123', 'cf-ray': 'ray-456' },
          },
        ),
    )
    const error = await collect(provider).catch((value: unknown) => value)
    expect(error).toMatchObject({
      message:
        'Codex Responses provider request failed with HTTP 404 (type=invalid_request_error, code=model_not_found, request_id=req_123, cf_ray=ray-456)',
      status: 404,
      kind: 'invalid_request',
      retryable: false,
    })
    expect(String(error)).not.toContain('secret')
  })

  it('uses top-level identifiers and omits unsafe or duplicate values', async () => {
    const provider = providerFor(
      async () =>
        new Response(
          JSON.stringify({ type: 'same', code: 'same', message: 'password' }),
          {
            status: 422,
            headers: {
              'x-request-id': 'bad value',
              'cf-ray': 'same',
              'x-secret': 'hidden',
            },
          },
        ),
    )
    const error = await collect(provider).catch((value: unknown) => value)
    expect(error).toMatchObject({
      message:
        'Codex Responses provider request failed with HTTP 422 (type=same)',
    })
    expect(String(error)).not.toContain('password')
    expect(String(error)).not.toContain('hidden')
  })

  it('does not parse partial JSON and preserves the exact status-only message', async () => {
    const provider = providerFor(async () =>
      response('{"error":{"type":"partial"}', 404),
    )
    const error = await collect(provider).catch((value: unknown) => value)
    expect(error).toMatchObject({
      message: 'Codex Responses provider request failed with HTTP 404',
      status: 404,
      kind: 'invalid_request',
      retryable: false,
    })
  })

  it('omits non-string, oversized, unsafe, and arbitrary identifiers exactly', async () => {
    const provider = providerFor(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              type: 123,
              code: 'x'.repeat(129),
              message: 'body-secret',
            },
          }),
          {
            status: 400,
            headers: {
              'x-request-id': 'bad value',
              'cf-ray': 'y'.repeat(129),
              'x-arbitrary': 'arbitrary-secret',
            },
          },
        ),
    )
    const error = await collect(provider).catch((value: unknown) => value)
    expect(error).toMatchObject({
      message: 'Codex Responses provider request failed with HTTP 400',
    })
    expect(String(error)).not.toContain('body-secret')
    expect(String(error)).not.toContain('arbitrary-secret')
  })

  it('preserves safe headers when body reading rejects', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('secret-read-failure'))
      },
      cancel() {
        throw new Error('secret-cancel-failure')
      },
    })
    const provider = providerFor(
      async () =>
        new Response(body, {
          status: 503,
          headers: { 'x-request-id': 'read-safe' },
        }),
    )
    const error = await collect(provider).catch((value: unknown) => value)
    expect(error).toMatchObject({
      message:
        'Codex Responses provider request failed with HTTP 503 (request_id=read-safe)',
      status: 503,
      kind: 'server_error',
    })
    expect(String(error)).not.toContain('secret-')
  })

  it('preserves safe headers when cancelling an oversized body rejects', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('body-secret'))
      },
      cancel() {
        throw new Error('secret-cancel-failure')
      },
    })
    const provider = providerFor(
      async () =>
        new Response(body, {
          status: 502,
          headers: { 'cf-ray': 'cancel-safe' },
        }),
      { maxErrorBodyBytes: 4 },
    )
    const error = await collect(provider).catch((value: unknown) => value)
    expect(error).toMatchObject({
      message:
        'Codex Responses provider request failed with HTTP 502 (cf_ray=cancel-safe)',
      status: 502,
      kind: 'server_error',
    })
    expect(String(error)).not.toContain('secret-')
    expect(String(error)).not.toContain('body-secret')
  })

  it('keeps safe headers when an oversized body is cancelled', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"type":"hidden"}'))
      },
      cancel() {
        cancelled = true
      },
    })
    const provider = providerFor(
      async () =>
        new Response(body, {
          status: 500,
          headers: { 'x-request-id': 'req-safe' },
        }),
      { maxErrorBodyBytes: 4 },
    )
    const error = await collect(provider).catch((value: unknown) => value)
    expect(error).toMatchObject({
      message:
        'Codex Responses provider request failed with HTTP 500 (request_id=req-safe)',
    })
    expect(String(error)).not.toContain('hidden')
    expect(cancelled).toBe(true)
  })

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
