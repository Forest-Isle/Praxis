import { describe, expect, it } from 'vitest'

import {
  AgentRunCancelledError,
  AgentRuntime,
  ModelProviderError,
  type ModelProvider,
  type RuntimeEvent,
} from './runtime.js'

function providerFrom(complete: ModelProvider['complete']): ModelProvider {
  return {
    capabilities: { streaming: true, usage: true },
    complete,
  }
}

describe('AgentRuntime', () => {
  it('emits typed state, text, usage, and completion events', async () => {
    const provider = providerFrom(async function* () {
      yield { type: 'text-delta', delta: 'hel' }
      yield { type: 'text-delta', delta: 'lo' }
      yield {
        type: 'usage',
        usage: { inputTokens: 4, outputTokens: 2 },
      }
    })
    const events: RuntimeEvent[] = []
    const runtime = new AgentRuntime(provider, (event) => events.push(event))

    const result = await runtime.run({
      messages: [{ role: 'user', content: 'say hello' }],
    })

    expect(result).toEqual({
      text: 'hello',
      usage: { inputTokens: 4, outputTokens: 2 },
    })
    expect(
      events
        .filter((event) => event.type === 'state')
        .map((event) => event.state),
    ).toEqual([
      'assembling-context',
      'awaiting-model',
      'streaming',
      'completed',
    ])
    expect(events).toContainEqual({ type: 'text-delta', delta: 'hel' })
    expect(events).toContainEqual({
      type: 'usage',
      usage: { inputTokens: 4, outputTokens: 2 },
    })
  })

  it('classifies provider failures without leaking provider payloads', async () => {
    const provider = providerFrom(async function* () {
      yield* []
      throw new ModelProviderError('rate limited', { retryable: true })
    })
    const events: RuntimeEvent[] = []
    const runtime = new AgentRuntime(provider, (event) => events.push(event))

    await expect(
      runtime.run({ messages: [{ role: 'user', content: 'hello' }] }),
    ).rejects.toThrow('rate limited')
    expect(events.at(-1)).toEqual({
      type: 'failed',
      message: 'rate limited',
      retryable: true,
    })
  })

  it('propagates cancellation before provider execution', async () => {
    let called = false
    const provider = providerFrom(async function* () {
      called = true
      yield { type: 'text-delta', delta: 'unexpected' }
    })
    const controller = new AbortController()
    controller.abort()
    const events: RuntimeEvent[] = []
    const runtime = new AgentRuntime(provider, (event) => events.push(event))

    await expect(
      runtime.run({
        messages: [{ role: 'user', content: 'hello' }],
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(AgentRunCancelledError)
    expect(called).toBe(false)
    expect(events.at(-1)).toEqual({ type: 'state', state: 'cancelled' })
  })
})
