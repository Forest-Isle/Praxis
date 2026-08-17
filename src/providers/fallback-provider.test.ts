import { describe, expect, it, vi } from 'vitest'

import {
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
