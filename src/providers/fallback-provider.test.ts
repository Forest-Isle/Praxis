import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  AgentRuntime,
  ModelProviderError,
  type ModelProvider,
  type ModelRequest,
  type ModelStreamEvent,
} from '../core/runtime.js'
import { FallbackModelProvider } from './fallback-provider.js'
import { DeadlineModelProvider } from './deadline-provider.js'

function provider(
  model: string,
  complete: ModelProvider['complete'],
): ModelProvider {
  return {
    model,
    capabilities: { streaming: true, usage: true, tools: true },
    complete,
  }
}

const text = (value: string): ModelStreamEvent => ({
  type: 'text-delta',
  delta: value,
})

describe('FallbackModelProvider', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('cancels before starting an attempt', async () => {
    const controller = new AbortController()
    controller.abort('cancelled')
    const primary = vi.fn(async function* () {
      yield text('must not run')
    })
    const routed = new FallbackModelProvider({
      providers: [provider('primary', primary)],
    })

    const completion = routed.complete({
      messages: [],
      signal: controller.signal,
    })
    const iterator = completion[Symbol.asyncIterator]()
    await expect(iterator.next()).rejects.toMatchObject({
      kind: 'cancelled',
      retryable: false,
    })
    expect(primary).not.toHaveBeenCalled()
  })

  it('cancels an abort-aware retry delay without starting another attempt', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    let attempts = 0
    const primary = vi.fn(async function* () {
      attempts += 1
      throw new ModelProviderError('overloaded', {
        kind: 'server_error',
        retryable: true,
      })
      yield text('unreachable')
    })
    const routed = new FallbackModelProvider({
      providers: [provider('primary', primary)],
      retryDelayMs: 1000,
    })
    const completion = routed.complete({
      messages: [],
      signal: controller.signal,
    })
    const iterator = completion[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'api-retry' },
      done: false,
    })
    const pending = iterator.next()
    controller.abort('cancelled')
    await expect(pending).rejects.toMatchObject({
      kind: 'cancelled',
      retryable: false,
    })
    await vi.runOnlyPendingTimersAsync()
    expect(attempts).toBe(1)
  })

  it('discards timed-out partial attempts before fallback succeeds', async () => {
    vi.useFakeTimers()
    let attempts = 0
    const primary = new DeadlineModelProvider({
      provider: provider('primary', async function* () {
        attempts += 1
        yield text(`discarded-${attempts}`)
        await new Promise<void>(() => {})
      }),
      deadlineMs: 50,
    })
    const fallback = provider('fallback', async function* () {
      yield text('recovered')
      yield { type: 'terminal', reason: 'end_turn' }
    })
    const routed = new FallbackModelProvider({
      providers: [primary, fallback],
      retryDelayMs: 0,
    })
    const events: ModelStreamEvent[] = []
    const consuming = (async () => {
      for await (const item of routed.complete({ messages: [] }))
        events.push(item)
    })()
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await vi.advanceTimersByTimeAsync(50)
      await Promise.resolve()
    }
    await consuming
    expect(attempts).toBe(3)
    expect(events.filter((item) => item.type === 'text-delta')).toEqual([
      text('recovered'),
    ])
  })

  it('preserves one terminal event from the successful buffered attempt', async () => {
    let attempts = 0
    const routed = new FallbackModelProvider({
      providers: [
        provider('primary', async function* () {
          attempts += 1
          yield text(`attempt-${attempts}`)
          if (attempts === 1) {
            throw new ModelProviderError('disconnected', {
              kind: 'transport_error',
              retryable: true,
            })
          }
          yield { type: 'terminal', reason: 'end_turn' }
        }),
      ],
      retryDelayMs: 0,
    })

    const events = []
    for await (const event of routed.complete({ messages: [] })) {
      events.push(event)
    }

    expect(events).toEqual([
      expect.objectContaining({
        type: 'api-retry',
        error: 'transport_error',
      }),
      expect.objectContaining({ type: 'api-attempt-duration' }),
      text('attempt-2'),
      { type: 'terminal', reason: 'end_turn' },
    ])
  })

  it('retries a terminal-capable provider that ends without a reason', async () => {
    const complete = vi.fn(async function* () {
      yield text('discarded')
    })
    const routed = new FallbackModelProvider({
      providers: [
        {
          ...provider('strict', complete),
          capabilities: {
            streaming: true,
            usage: true,
            tools: true,
            terminalReasons: true,
          },
        },
      ],
      retryDelayMs: 0,
    })

    const consume = async () => {
      for await (const event of routed.complete({ messages: [] })) void event
    }
    await expect(consume()).rejects.toThrow('without a terminal reason')
    expect(complete).toHaveBeenCalledTimes(3)
  })

  it('routes typed prompt-too-long directly to context recovery without retry or fallback', async () => {
    const primary = vi.fn(async function* () {
      throw new ModelProviderError('opaque context failure', {
        kind: 'prompt_too_long',
        retryable: true,
      })
      yield text('unreachable')
    })
    const fallback = vi.fn(async function* () {
      yield text('must not run')
    })
    const routed = new FallbackModelProvider({
      providers: [provider('primary', primary), provider('fallback', fallback)],
      retryDelayMs: 0,
    })

    const consume = async () => {
      for await (const event of routed.complete({ messages: [] })) void event
    }
    await expect(consume()).rejects.toMatchObject({
      kind: 'prompt_too_long',
    })
    expect(primary).toHaveBeenCalledTimes(1)
    expect(fallback).not.toHaveBeenCalled()
  })

  it('commits successful content and usage once after discarding a partial attempt', async () => {
    let attempts = 0
    const underlying: ModelProvider = {
      model: 'strict',
      capabilities: {
        streaming: true,
        usage: true,
        tools: true,
        terminalReasons: true,
      },
      async *complete() {
        attempts += 1
        yield { type: 'text-delta', delta: `attempt-${attempts}` }
        yield {
          type: 'usage',
          usage:
            attempts === 1
              ? { inputTokens: 100, outputTokens: 100 }
              : { inputTokens: 2, outputTokens: 1 },
        }
        if (attempts === 1) {
          throw new ModelProviderError('disconnected', {
            kind: 'transport_error',
            retryable: true,
          })
        }
        yield { type: 'terminal', reason: 'end_turn' }
      },
    }
    const routed = new FallbackModelProvider({
      providers: [underlying],
      retryDelayMs: 0,
    })
    const committed: unknown[] = []
    const runtime = new AgentRuntime(routed)

    const result = await runtime.run({
      messages: [{ role: 'user', content: 'answer' }],
      observer: {
        async assistantCompleted(message) {
          committed.push(message)
        },
        async toolCompleted() {},
      },
    })

    expect(result).toMatchObject({
      text: 'attempt-2',
      usage: { inputTokens: 2, outputTokens: 1 },
    })
    expect(committed).toEqual([{ role: 'assistant', content: 'attempt-2' }])
  })

  it('does not execute a tool call from a discarded partial attempt', async () => {
    let attempts = 0
    const underlying: ModelProvider = {
      model: 'strict',
      capabilities: {
        streaming: true,
        usage: true,
        tools: true,
        terminalReasons: true,
      },
      async *complete() {
        attempts += 1
        if (attempts === 1) {
          yield {
            type: 'tool-call',
            call: {
              id: 'discarded-call',
              name: 'Read',
              input: { file_path: '/tmp/discarded' },
            },
          }
          throw new ModelProviderError('disconnected', {
            kind: 'transport_error',
            retryable: true,
          })
        }
        yield text('recovered')
        yield { type: 'terminal', reason: 'end_turn' }
      },
    }
    const routed = new FallbackModelProvider({
      providers: [underlying],
      retryDelayMs: 0,
    })
    const execute = vi.fn(async () => ({
      content: 'should not execute',
      isError: false,
    }))
    const events: Array<{ type: string }> = []
    const runtime = new AgentRuntime(routed, (event) => events.push(event), {
      tools: {
        definitions: () => [],
        prepare: async (call) => call,
        execute,
      },
      permissions: { resolve: () => ({ behavior: 'allow' }) },
    })

    const result = await runtime.run({
      messages: [{ role: 'user', content: 'answer' }],
    })

    expect(result.text).toBe('recovered')
    expect(execute).not.toHaveBeenCalled()
    expect(events.some((event) => event.type === 'tool-call')).toBe(false)
    expect(events.some((event) => event.type === 'tool-result')).toBe(false)
  })

  it('retries each model three times before moving to next fallback', async () => {
    const primary = vi.fn(async function* () {
      throw new ModelProviderError('overloaded', {
        retryable: true,
        status: 529,
      })
      yield text('unreachable')
    })
    const fallback = vi.fn(async function* () {
      yield text('ok')
    })
    const routed = new FallbackModelProvider({
      providers: [provider('primary', primary), provider('fallback', fallback)],
      retryDelayMs: 0,
    })
    const events = []
    for await (const event of routed.complete({ messages: [] }))
      events.push(event)
    expect(events).toEqual([
      {
        type: 'api-retry',
        attempt: 1,
        maxRetries: 2,
        retryDelayMs: 0,
        errorStatus: 529,
        error: 'server_error',
      },
      {
        type: 'api-retry',
        attempt: 2,
        maxRetries: 2,
        retryDelayMs: 0,
        errorStatus: 529,
        error: 'server_error',
      },
      expect.objectContaining({ type: 'api-attempt-duration' }),
      text('ok'),
    ])
    const attemptDurationEvents = events.filter(
      (event) => event.type === 'api-attempt-duration',
    )
    expect(attemptDurationEvents).toHaveLength(1)
    expect(attemptDurationEvents[0]?.durationMs).toBeGreaterThanOrEqual(0)
    expect(primary).toHaveBeenCalledTimes(3)
    expect(fallback).toHaveBeenCalledTimes(1)
    expect(routed.model).toBe('fallback')
  })

  it('sticks to a fallback provider after tool-use success', async () => {
    const primary = vi.fn(async function* (request: ModelRequest) {
      void request
      throw new ModelProviderError('overloaded', {
        kind: 'server_error',
        retryable: true,
      })
      yield text('unreachable')
    })
    const fallback = vi.fn(async function* (request: ModelRequest) {
      const hasToolResult = request.messages.some(
        (message) => message.role === 'tool',
      )
      if (hasToolResult) yield text('fallback final')
      else {
        yield {
          type: 'tool-call' as const,
          call: { id: 'call-1', name: 'Read', input: { file_path: '/tmp/x' } },
        }
      }
      yield {
        type: 'terminal' as const,
        reason: hasToolResult ? 'end_turn' : 'tool_use',
      } satisfies ModelStreamEvent
    })
    const routed = new FallbackModelProvider({
      providers: [provider('primary', primary), provider('fallback', fallback)],
      retryDelayMs: 0,
    })

    const execute = vi.fn(async () => ({
      content: 'tool result',
      isError: false,
    }))
    const runtime = new AgentRuntime(routed, undefined, {
      tools: {
        definitions: () => [{ name: 'Read', description: '', inputSchema: {} }],
        prepare: async (call) => call,
        execute,
      },
      permissions: { resolve: () => ({ behavior: 'allow' }) },
    })
    const result = await runtime.run({ messages: [] })

    expect(primary).toHaveBeenCalledTimes(3)
    expect(fallback).toHaveBeenCalledTimes(2)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(result.text).toBe('fallback final')
    expect(primary.mock.calls[0]?.[0].messages).toEqual([])
  })

  it('does not enter fallback after the primary route is sealed', async () => {
    let primaryCalls = 0
    const primary = vi.fn(async function* () {
      primaryCalls += 1
      if (primaryCalls === 1) {
        yield text('primary success')
        return
      }
      throw new ModelProviderError('primary continuation failed', {
        retryable: true,
      })
      yield text('unreachable')
    })
    const fallback = vi.fn(async function* () {
      yield text('must not run')
    })
    const routed = new FallbackModelProvider({
      providers: [provider('primary', primary), provider('fallback', fallback)],
      retryDelayMs: 0,
    })

    for await (const event of routed.complete({ messages: [] })) void event
    await expect(
      (async () => {
        for await (const event of routed.complete({ messages: [] })) void event
      })(),
    ).rejects.toThrow('primary continuation failed')

    expect(primary).toHaveBeenCalledTimes(4)
    expect(fallback).not.toHaveBeenCalled()
  })

  it('preserves completion-scoped fallback reset for reusable auxiliary clients', async () => {
    let primaryCalls = 0
    const primary = vi.fn(async function* () {
      primaryCalls += 1
      if (primaryCalls <= 3) {
        throw new ModelProviderError('primary unavailable', { retryable: true })
      }
      yield text('primary recovered')
    })
    const fallback = vi.fn(async function* () {
      yield text('fallback success')
    })
    const routed = new FallbackModelProvider({
      providers: [provider('primary', primary), provider('fallback', fallback)],
      retryDelayMs: 0,
      routeScope: 'completion',
    })

    for await (const event of routed.complete({ messages: [] })) void event
    for await (const event of routed.complete({ messages: [] })) void event

    expect(primary).toHaveBeenCalledTimes(4)
    expect(fallback).toHaveBeenCalledTimes(1)
  })

  it('does not advance beyond a sealed fallback after retry exhaustion', async () => {
    const primary = vi.fn(async function* () {
      throw new ModelProviderError('overloaded', { retryable: true })
      yield text('unreachable')
    })
    let fallbackCalls = 0
    const fallback = vi.fn(async function* () {
      fallbackCalls += 1
      if (fallbackCalls === 1) {
        yield text('recovered')
        return
      }
      throw new ModelProviderError('fallback down', { retryable: true })
      yield text('unreachable')
    })
    const later = vi.fn(async function* () {
      yield text('must not run')
    })
    const routed = new FallbackModelProvider({
      providers: [
        provider('primary', primary),
        provider('fallback', fallback),
        provider('later', later),
      ],
      retryDelayMs: 0,
    })
    for await (const event of routed.complete({ messages: [] })) void event
    await expect(
      (async () => {
        for await (const event of routed.complete({ messages: [] })) void event
      })(),
    ).rejects.toThrow('fallback down')
    expect(fallback).toHaveBeenCalledTimes(4)
    expect(later).not.toHaveBeenCalled()
  })

  it('rejects an incompatible fallback before invoking it', async () => {
    const primary = vi.fn(async function* () {
      throw new ModelProviderError('overloaded', { retryable: true })
      yield text('unreachable')
    })
    const fallback = vi.fn(async function* () {
      yield text('must not run')
    })
    const routed = new FallbackModelProvider({
      providers: [
        provider('primary', primary),
        {
          ...provider('fallback', fallback),
          capabilities: { streaming: true, usage: true, tools: false },
        },
      ],
      retryDelayMs: 0,
    })
    await expect(
      (async () => {
        for await (const event of routed.complete({
          messages: [],
          tools: [{ name: 'Read', description: '', inputSchema: {} }],
        }))
          void event
      })(),
    ).rejects.toMatchObject({ kind: 'invalid_request', retryable: false })
    expect(fallback).not.toHaveBeenCalled()
  })

  it.each([
    ['non-streaming', { streaming: false }, { messages: [] }],
    [
      'tools',
      { tools: false },
      {
        messages: [],
        tools: [{ name: 'Read', description: '', inputSchema: {} }],
      },
    ],
    [
      'legacy images',
      { images: false },
      {
        messages: [
          {
            role: 'user',
            content: '',
            images: [{ type: 'image', mediaType: 'image/png', data: 'x' }],
          },
        ],
      },
    ],
    [
      'content-block images',
      { images: false },
      {
        messages: [
          {
            role: 'user',
            content: '',
            contentBlocks: [
              { type: 'image', mediaType: 'image/png', data: 'x' },
            ],
          },
        ],
      },
    ],
    [
      'legacy documents',
      { documents: false },
      {
        messages: [
          {
            role: 'user',
            content: '',
            documents: [
              { type: 'document', mediaType: 'text/plain', data: 'x' },
            ],
          },
        ],
      },
    ],
    [
      'content-block documents',
      { documents: false },
      {
        messages: [
          {
            role: 'user',
            content: '',
            contentBlocks: [
              { type: 'document', mediaType: 'text/plain', data: 'x' },
            ],
          },
        ],
      },
    ],
    [
      'web search',
      { webSearch: false },
      { messages: [], webSearch: { maxUses: 1 } },
    ],
    [
      'enabled thinking mode',
      { thinking: { modes: ['disabled'], maxTokens: true } },
      { messages: [], thinking: { mode: 'enabled' } },
    ],
    [
      'adaptive thinking mode',
      { thinking: { modes: ['enabled'], maxTokens: true } },
      { messages: [], thinking: { mode: 'adaptive' } },
    ],
    [
      'disabled thinking mode',
      { thinking: { modes: ['enabled'], maxTokens: true } },
      { messages: [], thinking: { mode: 'disabled' } },
    ],
    [
      'thinking max tokens',
      { thinking: { modes: ['enabled'], maxTokens: false } },
      { messages: [], thinking: { mode: 'enabled', maxTokens: 10 } },
    ],
  ] as const)(
    '%s fallback capability mismatch fails closed',
    async (_, unsupported, request) => {
      const primary = vi.fn(async function* () {
        throw new ModelProviderError('overloaded', { retryable: true })
        yield text('unreachable')
      })
      const fallback = vi.fn(async function* () {
        yield text('must not run')
      })
      const routed = new FallbackModelProvider({
        providers: [
          provider('primary', primary),
          {
            ...provider('fallback', fallback),
            capabilities: {
              ...provider('fallback', fallback).capabilities,
              ...unsupported,
            },
          },
        ],
        retryDelayMs: 0,
      })
      await expect(
        (async () => {
          for await (const event of routed.complete(request)) void event
        })(),
      ).rejects.toMatchObject({ kind: 'invalid_request', retryable: false })
      expect(fallback).not.toHaveBeenCalled()
    },
  )

  it('exposes the capabilities of the currently active provider', async () => {
    const primaryCapabilities = {
      streaming: true,
      usage: true,
      tools: true,
      contextWindowTokens: 100_000,
      maxOutputTokens: 4_096,
    }
    const fallbackCapabilities = {
      streaming: true,
      usage: true,
      tools: true,
      contextWindowTokens: 200_000,
      maxOutputTokens: 8_192,
    }
    const routed = new FallbackModelProvider({
      providers: [
        {
          ...provider('primary', async function* () {
            throw new ModelProviderError('overloaded', {
              retryable: true,
              status: 529,
            })
            yield text('unreachable')
          }),
          capabilities: primaryCapabilities,
        },
        {
          ...provider('fallback', async function* () {
            yield text('ok')
          }),
          capabilities: fallbackCapabilities,
        },
      ],
      retryDelayMs: 0,
    })
    // Before routing, the initial active provider's capabilities are exposed.
    expect(routed.capabilities).toEqual(primaryCapabilities)
    for await (const event of routed.complete({ messages: [] })) void event
    // After fallback routing, the active provider's capabilities are exposed.
    expect(routed.capabilities).toEqual(fallbackCapabilities)
  })

  it('does not retry non-retryable errors or replay partial streams', async () => {
    const primary = vi.fn(async function* () {
      yield text('partial')
      throw new ModelProviderError('bad request', { retryable: false })
    })
    const fallback = vi.fn(async function* () {
      yield text('fallback')
    })
    const routed = new FallbackModelProvider({
      providers: [provider('primary', primary), provider('fallback', fallback)],
      retryDelayMs: 0,
    })
    const consume = async () => {
      const events: ModelStreamEvent[] = []
      for await (const event of routed.complete({ messages: [] }))
        events.push(event)
      return events
    }
    await expect(consume()).rejects.toThrow('bad request')
    expect(primary).toHaveBeenCalledTimes(1)
    expect(fallback).not.toHaveBeenCalled()
  })

  it('uses the underlying attempt duration for the wrapper terminal metric', async () => {
    const timed = provider('timed', async function* () {
      yield { type: 'api-attempt-duration', durationMs: 123 }
      yield text('timed ok')
    })
    const inner = new FallbackModelProvider({
      providers: [timed],
      retryDelayMs: 0,
    })
    const routed = new FallbackModelProvider({
      providers: [provider('outer', () => inner.complete({ messages: [] }))],
      retryDelayMs: 0,
    })
    const events = []
    for await (const event of routed.complete({ messages: [] }))
      events.push(event)
    expect(events).toEqual([
      { type: 'api-attempt-duration', durationMs: 123 },
      text('timed ok'),
    ])
  })

  it('rejects duplicate or invalid underlying attempt duration metadata', async () => {
    const consume = async (routed: FallbackModelProvider) => {
      const events: ModelStreamEvent[] = []
      for await (const event of routed.complete({ messages: [] }))
        events.push(event)
      return events
    }
    const duplicate = new FallbackModelProvider({
      providers: [
        provider('dup', async function* () {
          yield { type: 'api-attempt-duration', durationMs: 1 }
          yield { type: 'api-attempt-duration', durationMs: 2 }
          yield text('unreachable')
        }),
      ],
      retryDelayMs: 0,
    })
    await expect(consume(duplicate)).rejects.toThrow(
      'Provider emitted multiple api-attempt-duration events in one attempt',
    )

    const invalid = new FallbackModelProvider({
      providers: [
        provider('bad', async function* () {
          yield { type: 'api-attempt-duration', durationMs: -3 }
        }),
      ],
      retryDelayMs: 0,
    })
    await expect(consume(invalid)).rejects.toThrow(
      'api-attempt-duration durationMs must be a finite nonnegative number',
    )
  })
})
