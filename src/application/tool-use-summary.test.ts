import { describe, expect, it, vi } from 'vitest'

import {
  generateToolUseSummary,
  type ToolUseSummaryInput,
} from './tool-use-summary.js'

describe('generateToolUseSummary', () => {
  it('uses the provider with the Claude summary prompt and returns a structured outcome', async () => {
    let request: unknown
    const provider = {
      capabilities: { streaming: true, usage: true, tools: false },
      async *complete(nextRequest: unknown) {
        request = nextRequest
        yield { type: 'text-delta' as const, delta: 'Read config.json' }
      },
    }
    const tools: ToolUseSummaryInput[] = [
      { name: 'Read', input: { file_path: 'config.json' }, output: '{}' },
    ]

    const outcome = await generateToolUseSummary(
      provider,
      tools,
      new AbortController().signal,
      'I need the config',
    )
    expect(outcome).toMatchObject({
      summary: 'Read config.json',
      usage: { inputTokens: 0, outputTokens: 0 },
      durationApiMs: expect.any(Number),
      durationApiWithoutRetriesMs: expect.any(Number),
      meteredExternally: false,
    })
    expect(outcome?.modelUsage).toBeUndefined()
    expect(request).toMatchObject({
      messages: [
        {
          role: 'system',
          content: expect.stringContaining('short summary label'),
        },
        {
          role: 'user',
          content: expect.stringContaining('Tool: Read'),
        },
      ],
    })
  })

  it('does not call the provider after cancellation', async () => {
    const controller = new AbortController()
    let called = false
    const provider = {
      capabilities: { streaming: true, usage: true, tools: false },
      async *complete() {
        called = true
        yield { type: 'text-delta' as const, delta: 'unused' }
      },
    }
    controller.abort()

    await expect(
      generateToolUseSummary(provider, [], controller.signal),
    ).resolves.toBeNull()
    expect(called).toBe(false)
  })

  it('returns null for a pre-aborted signal without invoking the provider or callback', async () => {
    const controller = new AbortController()
    controller.abort()
    let called = false
    const onMetrics = vi.fn()
    const provider = {
      capabilities: { streaming: true, usage: true, tools: false },
      async *complete() {
        called = true
        yield { type: 'text-delta' as const, delta: 'unused' }
      },
    }

    await expect(
      generateToolUseSummary(
        provider,
        [{ name: 'Read', input: {}, output: '{}' }],
        controller.signal,
        undefined,
        onMetrics,
      ),
    ).resolves.toBeNull()
    expect(called).toBe(false)
    expect(onMetrics).not.toHaveBeenCalled()
  })

  it('captures usage, model metadata, and retry-free durations and meters externally via the callback', async () => {
    const provider = {
      model: 'summary-model',
      capabilities: {
        streaming: true,
        usage: true,
        tools: false,
        contextWindowTokens: 200_000,
        maxOutputTokens: 32_000,
      },
      async *complete() {
        yield { type: 'api-attempt-duration' as const, durationMs: 7 }
        yield { type: 'text-delta' as const, delta: 'Read config.json' }
        yield {
          type: 'usage' as const,
          usage: { inputTokens: 5, outputTokens: 3 },
        }
      },
    }
    let recorded: unknown
    const outcome = await generateToolUseSummary(
      provider,
      [{ name: 'Read', input: { file_path: 'config.json' }, output: '{}' }],
      new AbortController().signal,
      'inspect',
      (metrics) => {
        recorded = metrics
      },
    )
    expect(recorded).toMatchObject({
      usage: { inputTokens: 5, outputTokens: 3 },
      model: 'summary-model',
      durationApiWithoutRetriesMs: 7,
    })
    expect(outcome).toMatchObject({
      summary: 'Read config.json',
      usage: { inputTokens: 5, outputTokens: 3 },
      durationApiWithoutRetriesMs: 7,
      meteredExternally: true,
    })
    expect(outcome?.modelUsage).toEqual({
      'summary-model': {
        inputTokens: 5,
        outputTokens: 3,
        contextWindow: 200_000,
        maxOutputTokens: 32_000,
      },
    })
  })

  it('returns a null summary when the summary model emits a tool call', async () => {
    const provider = {
      model: 'summary-model',
      capabilities: { streaming: true, usage: true, tools: false },
      async *complete() {
        yield {
          type: 'tool-call' as const,
          call: { id: 'c1', name: 'Read', input: {} },
        }
        yield {
          type: 'usage' as const,
          usage: { inputTokens: 2, outputTokens: 1 },
        }
      },
    }
    const outcome = await generateToolUseSummary(
      provider,
      [{ name: 'Read', input: {}, output: '{}' }],
      new AbortController().signal,
    )
    expect(outcome?.summary).toBeNull()
    expect(outcome?.modelUsage).toEqual({
      'summary-model': { inputTokens: 2, outputTokens: 1 },
    })
    expect(outcome?.meteredExternally).toBe(false)
  })

  it('swallows provider failures into a null-summary outcome with captured metrics', async () => {
    const provider = {
      model: 'summary-model',
      capabilities: { streaming: true, usage: true, tools: false },
      async *complete() {
        yield { type: 'text-delta' as const, delta: 'partial' }
        throw new Error('provider exploded')
      },
    }
    const onMetrics = vi.fn()
    const outcome = await generateToolUseSummary(
      provider,
      [{ name: 'Read', input: {}, output: '{}' }],
      new AbortController().signal,
      undefined,
      onMetrics,
    )
    expect(outcome?.summary).toBeNull()
    expect(onMetrics).toHaveBeenCalledTimes(1)
    expect(outcome).toMatchObject({
      summary: null,
      usage: { inputTokens: 0, outputTokens: 0 },
      durationApiMs: expect.any(Number),
      durationApiWithoutRetriesMs: expect.any(Number),
      meteredExternally: true,
    })
    expect(outcome?.modelUsage).toBeUndefined()
  })

  it('propagates accounting callback errors instead of swallowing them', async () => {
    const provider = {
      capabilities: { streaming: true, usage: true, tools: false },
      async *complete() {
        yield { type: 'text-delta' as const, delta: 'Read config' }
      },
    }
    const onMetrics = vi.fn(() => {
      throw new Error('tracker unavailable')
    })
    await expect(
      generateToolUseSummary(
        provider,
        [{ name: 'Read', input: {}, output: '{}' }],
        new AbortController().signal,
        undefined,
        onMetrics,
      ),
    ).rejects.toThrow('tracker unavailable')
  })
})
