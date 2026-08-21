import { describe, expect, it, vi } from 'vitest'

import {
  AgentRuntime,
  ModelProviderError,
  type ModelProvider,
  type ModelStreamEvent,
} from '../core/runtime.js'
import { FallbackModelProvider } from './fallback-provider.js'

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
