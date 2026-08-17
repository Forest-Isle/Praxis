import { describe, expect, it } from 'vitest'

import { AgentRunCancelledError, type ModelProvider } from '../core/runtime.js'
import {
  completeMeteredModelRequest,
  type MeteredModelCompletion,
} from './metered-model-completion.js'

describe('completeMeteredModelRequest', () => {
  it('returns text, tool calls, usage, model, and both API durations', async () => {
    const provider: ModelProvider = {
      model: 'fixture-model',
      capabilities: { streaming: true, usage: true, tools: false },
      async *complete() {
        yield { type: 'text-delta', delta: 'hello' }
        yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 2 } }
      },
    }

    const recorded: MeteredModelCompletion[] = []
    const result = await completeMeteredModelRequest(
      provider,
      { messages: [] },
      { onMetrics: (metrics) => recorded.push(metrics) },
    )

    expect(recorded).toHaveLength(1)
    expect(recorded[0]).toBe(result)
    expect(result.text).toBe('hello')
    expect(result.toolCalls).toEqual([])
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 2 })
    expect(result.model).toBe('fixture-model')
    expect(result.durationApiMs).toBeGreaterThanOrEqual(0)
    expect(result.durationApiWithoutRetriesMs).toBe(result.durationApiMs)
  })

  it('forwards text deltas to onTextDelta', async () => {
    const deltas: string[] = []
    const provider: ModelProvider = {
      capabilities: { streaming: true, usage: true, tools: false },
      async *complete() {
        yield { type: 'text-delta', delta: 'a' }
        yield { type: 'text-delta', delta: 'b' }
      },
    }

    const result = await completeMeteredModelRequest(
      provider,
      { messages: [] },
      { onTextDelta: (delta) => deltas.push(delta) },
    )

    expect(deltas).toEqual(['a', 'b'])
    expect(result.text).toBe('ab')
  })

  it('replaces usage with the final usage event and enriches absent capability metadata', async () => {
    const provider: ModelProvider = {
      model: 'fixture-model',
      capabilities: {
        streaming: true,
        usage: true,
        tools: false,
        contextWindowTokens: 200_000,
        maxOutputTokens: 32_000,
      },
      async *complete() {
        yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
        yield {
          type: 'usage',
          usage: { inputTokens: 7, outputTokens: 4, webSearchRequests: 2 },
        }
      },
    }

    const result = await completeMeteredModelRequest(provider, { messages: [] })

    expect(result.usage).toEqual({
      inputTokens: 7,
      outputTokens: 4,
      webSearchRequests: 2,
      contextWindow: 200_000,
      maxOutputTokens: 32_000,
    })
  })

  it('does not overwrite explicit usage metadata from the event', async () => {
    const provider: ModelProvider = {
      capabilities: {
        streaming: true,
        usage: true,
        tools: false,
        contextWindowTokens: 200_000,
        maxOutputTokens: 32_000,
      },
      async *complete() {
        yield {
          type: 'usage',
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            contextWindow: 100_000,
            maxOutputTokens: 8_000,
          },
        }
      },
    }

    const result = await completeMeteredModelRequest(provider, { messages: [] })

    expect(result.usage).toEqual({
      inputTokens: 1,
      outputTokens: 1,
      contextWindow: 100_000,
      maxOutputTokens: 8_000,
    })
  })

  it('does not enrich metadata from non-positive-safe-integer capabilities', async () => {
    const provider: ModelProvider = {
      capabilities: {
        streaming: true,
        usage: true,
        tools: false,
        contextWindowTokens: -5,
        maxOutputTokens: 1.5,
      },
      async *complete() {
        yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
      },
    }

    const result = await completeMeteredModelRequest(provider, { messages: [] })

    expect(result.usage.contextWindow).toBeUndefined()
    expect(result.usage.maxOutputTokens).toBeUndefined()
  })

  it('omits the model identity when the provider model is blank', async () => {
    const provider: ModelProvider = {
      model: '   ',
      capabilities: { streaming: true, usage: true, tools: false },
      async *complete() {
        yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
      },
    }

    const result = await completeMeteredModelRequest(provider, { messages: [] })

    expect('model' in result).toBe(false)
  })

  it('ignores api-retry events for content and metrics', async () => {
    const provider: ModelProvider = {
      model: 'fixture-model',
      capabilities: { streaming: true, usage: true, tools: false },
      async *complete() {
        yield {
          type: 'api-retry',
          attempt: 1,
          maxRetries: 2,
          retryDelayMs: 100,
          errorStatus: 429,
          error: 'rate_limit',
        }
        yield { type: 'text-delta', delta: 'ok' }
        yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1 } }
      },
    }

    const result = await completeMeteredModelRequest(provider, { messages: [] })

    expect(result.text).toBe('ok')
    expect(result.usage).toMatchObject({ inputTokens: 2, outputTokens: 1 })
  })

  it('prefers an explicit api-attempt-duration as the retry-free duration', async () => {
    const provider: ModelProvider = {
      model: 'fixture-model',
      capabilities: { streaming: true, usage: true, tools: false },
      async *complete() {
        yield { type: 'api-attempt-duration', durationMs: 12 }
        await new Promise((resolve) => setTimeout(resolve, 5))
        yield { type: 'text-delta', delta: 'hello' }
        yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 2 } }
      },
    }

    const result = await completeMeteredModelRequest(provider, { messages: [] })

    expect(result.durationApiWithoutRetriesMs).toBe(12)
    // The total is wall-clock measured and may be shorter than the provider's
    // self-reported attempt duration, so only finiteness is asserted here.
    expect(Number.isFinite(result.durationApiMs)).toBe(true)
    expect(result.durationApiMs).toBeGreaterThanOrEqual(0)
    expect(result.text).toBe('hello')
  })

  it('throws when multiple api-attempt-duration events are emitted', async () => {
    const provider: ModelProvider = {
      capabilities: { streaming: true, usage: true, tools: false },
      async *complete() {
        yield { type: 'api-attempt-duration', durationMs: 1 }
        yield { type: 'api-attempt-duration', durationMs: 2 }
      },
    }

    await expect(
      completeMeteredModelRequest(provider, { messages: [] }),
    ).rejects.toThrow(
      'Provider emitted multiple api-attempt-duration events in one attempt',
    )
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])(
    'throws TypeError for an invalid api-attempt-duration durationMs %s',
    async (durationMs) => {
      const provider: ModelProvider = {
        capabilities: { streaming: true, usage: true, tools: false },
        async *complete() {
          yield { type: 'api-attempt-duration', durationMs }
        },
      }

      await expect(
        completeMeteredModelRequest(provider, { messages: [] }),
      ).rejects.toThrow(
        'api-attempt-duration durationMs must be a finite nonnegative number',
      )
    },
  )

  it('collects tool calls without invoking them', async () => {
    const provider: ModelProvider = {
      capabilities: { streaming: true, usage: true, tools: true },
      async *complete() {
        yield {
          type: 'tool-call',
          call: { id: 'call_1', name: 'Read', input: { file_path: 'a.ts' } },
        }
        yield { type: 'text-delta', delta: 'done' }
        yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1 } }
      },
    }

    const result = await completeMeteredModelRequest(provider, { messages: [] })

    expect(result.toolCalls).toEqual([
      { id: 'call_1', name: 'Read', input: { file_path: 'a.ts' } },
    ])
    expect(result.text).toBe('done')
  })

  it('runs onMetrics exactly once in finally when the provider throws mid-stream', async () => {
    const recorded: MeteredModelCompletion[] = []
    const provider: ModelProvider = {
      model: 'fixture-model',
      capabilities: { streaming: true, usage: true, tools: false },
      async *complete() {
        yield { type: 'text-delta', delta: 'partial' }
        throw new Error('provider exploded')
      },
    }

    await expect(
      completeMeteredModelRequest(
        provider,
        { messages: [] },
        { onMetrics: (metrics) => recorded.push(metrics) },
      ),
    ).rejects.toThrow('provider exploded')
    expect(recorded).toHaveLength(1)
    const metrics = recorded[0]
    if (!metrics) throw new Error('expected one metrics callback')
    expect(metrics.text).toBe('partial')
    expect(metrics.usage).toEqual({ inputTokens: 0, outputTokens: 0 })
    expect(metrics.durationApiMs).toBeGreaterThanOrEqual(0)
    expect(metrics.durationApiWithoutRetriesMs).toBe(metrics.durationApiMs)
  })

  it('runs onMetrics exactly once when the provider throws before streaming', async () => {
    const recorded: MeteredModelCompletion[] = []
    const provider: ModelProvider = {
      capabilities: { streaming: true, usage: true, tools: false },
      complete() {
        throw new Error('sync provider failure')
      },
    }

    await expect(
      completeMeteredModelRequest(
        provider,
        { messages: [] },
        { onMetrics: (metrics) => recorded.push(metrics) },
      ),
    ).rejects.toThrow('sync provider failure')
    expect(recorded).toHaveLength(1)
    const metrics = recorded[0]
    if (!metrics) throw new Error('expected one metrics callback')
    expect(metrics.usage).toEqual({ inputTokens: 0, outputTokens: 0 })
  })

  it('does not run onMetrics when the input signal is already aborted before the provider call', async () => {
    const recorded: MeteredModelCompletion[] = []
    const controller = new AbortController()
    controller.abort()
    let providerCalled = false
    const provider: ModelProvider = {
      capabilities: { streaming: true, usage: true, tools: false },
      async *complete() {
        providerCalled = true
        yield { type: 'text-delta', delta: 'unreachable' }
      },
    }

    await expect(
      completeMeteredModelRequest(
        provider,
        { messages: [], signal: controller.signal },
        { onMetrics: (metrics) => recorded.push(metrics) },
      ),
    ).rejects.toBeInstanceOf(AgentRunCancelledError)
    expect(providerCalled).toBe(false)
    expect(recorded).toHaveLength(0)
  })

  it('runs onMetrics exactly once when the stream is aborted mid-flight', async () => {
    const recorded: MeteredModelCompletion[] = []
    const controller = new AbortController()
    let releaseNext: (() => void) | undefined
    let signalReached: (() => void) | undefined
    const reachedGate = new Promise<void>((resolve) => {
      signalReached = resolve
    })
    const gate = new Promise<void>((resolve) => {
      releaseNext = resolve
    })
    const provider: ModelProvider = {
      capabilities: { streaming: true, usage: true, tools: false },
      async *complete() {
        yield { type: 'text-delta', delta: 'partial' }
        signalReached?.()
        await gate
        yield { type: 'text-delta', delta: 'late' }
      },
    }

    const pending = completeMeteredModelRequest(
      provider,
      { messages: [], signal: controller.signal },
      { onMetrics: (metrics) => recorded.push(metrics) },
    )
    await reachedGate
    controller.abort()
    releaseNext?.()

    await expect(pending).rejects.toBeInstanceOf(AgentRunCancelledError)
    expect(recorded).toHaveLength(1)
    const metrics = recorded[0]
    if (!metrics) throw new Error('expected one metrics callback')
    expect(metrics.durationApiMs).toBeGreaterThanOrEqual(0)
  })
})
