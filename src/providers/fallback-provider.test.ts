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
    expect(events).toEqual([text('ok')])
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
})
