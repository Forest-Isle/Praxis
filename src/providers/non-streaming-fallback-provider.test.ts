import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  AgentRuntime,
  ModelProviderError,
  type ModelProvider,
  type ModelStreamEvent,
} from '../core/runtime.js'
import {
  isNonStreamingFallbackEligible,
  markNonStreamingFallbackEligible,
  NonStreamingFallbackModelProvider,
} from './non-streaming-fallback-provider.js'
import { DeadlineModelProvider } from './deadline-provider.js'
import { reportProviderTransportActivity } from './provider-transport-activity.js'

const provider = (
  complete: ModelProvider['complete'],
  streaming = true,
): ModelProvider => ({
  model: 'fixture',
  capabilities: {
    streaming,
    usage: true,
    tools: true,
    terminalReasons: true,
  },
  complete,
})

const terminal: ModelStreamEvent = { type: 'terminal', reason: 'end_turn' }

afterEach(() => {
  vi.useRealTimers()
})

describe('NonStreamingFallbackModelProvider', () => {
  it('commits only fallback text usage and tool effects in AgentRuntime', async () => {
    const primary = async function* (): AsyncGenerator<ModelStreamEvent> {
      yield { type: 'text-delta', delta: 'partial' } as ModelStreamEvent
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
      yield {
        type: 'tool-call',
        call: { id: 'primary', name: 'Read', input: {} },
      } as ModelStreamEvent
      throw markNonStreamingFallbackEligible(
        new ModelProviderError('truncated', {
          kind: 'transport_error',
          retryable: true,
        }),
      )
    }
    let fallbackCalls = 0
    const fallback = async function* (): AsyncGenerator<ModelStreamEvent> {
      fallbackCalls += 1
      if (fallbackCalls === 1) {
        yield { type: 'text-delta', delta: 'fallback' } as ModelStreamEvent
        yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 3 } }
        yield {
          type: 'tool-call',
          call: { id: 'fallback', name: 'Read', input: {} },
        } as ModelStreamEvent
        yield { type: 'terminal', reason: 'tool_use' } as ModelStreamEvent
      } else {
        yield { type: 'terminal', reason: 'end_turn' } as ModelStreamEvent
      }
    }
    const execute = vi.fn(async () => ({ content: 'ok', isError: false }))
    const runtime = new AgentRuntime(
      new NonStreamingFallbackModelProvider({
        provider: provider(primary),
        nonStreamingProvider: provider(fallback, false),
      }),
      undefined,
      {
        tools: {
          definitions: () => [],
          prepare: async (call) => call,
          execute,
        },
        permissions: { resolve: () => ({ behavior: 'allow' }) },
      },
    )
    const result = await runtime.run({
      messages: [{ role: 'user', content: 'read' }],
    })
    expect(result.text).toBe('')
    expect(result.usage).toEqual({ inputTokens: 2, outputTokens: 3 })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'fallback' }),
      expect.anything(),
    )
  })

  it('buffers failed primary output and replays once through fallback', async () => {
    const primary = vi.fn(async function* () {
      yield { type: 'text-delta', delta: 'partial' } as ModelStreamEvent
      throw markNonStreamingFallbackEligible(
        new ModelProviderError('stream broke', {
          kind: 'server_error',
          retryable: true,
          status: 503,
        }),
      )
    })
    const fallback = vi.fn(async function* () {
      yield { type: 'text-delta', delta: 'complete' } as ModelStreamEvent
      yield terminal
    })
    const wrapped = new NonStreamingFallbackModelProvider({
      provider: provider(primary),
      nonStreamingProvider: provider(fallback, false),
    })
    const events = []
    for await (const event of wrapped.complete({ messages: [] }))
      events.push(event)
    expect(events).toEqual([
      {
        type: 'api-retry',
        attempt: 1,
        maxRetries: 1,
        retryDelayMs: 0,
        errorStatus: 503,
        error: 'server_error',
      },
      { type: 'text-delta', delta: 'complete' },
      terminal,
    ])
    expect(fallback).toHaveBeenCalledTimes(1)
    expect(
      events.some(
        (event) => event.type === 'text-delta' && event.delta === 'partial',
      ),
    ).toBe(false)
  })

  it('only accepts explicit markers or idle timeout errors', () => {
    const marked = markNonStreamingFallbackEligible(new Error('marked'))
    expect(isNonStreamingFallbackEligible(marked)).toBe(true)
    expect(isNonStreamingFallbackEligible(new Error('other'))).toBe(false)
    expect(
      isNonStreamingFallbackEligible(
        new ModelProviderError('idle', {
          kind: 'timeout',
          retryable: true,
          timeoutPhase: 'idle',
        }),
      ),
    ).toBe(true)
  })

  it.each([
    [
      'unmarked transport error',
      new ModelProviderError('unmarked', {
        kind: 'transport_error',
        retryable: true,
      }),
    ],
    [
      'connect timeout',
      new ModelProviderError('connect', {
        kind: 'timeout',
        retryable: true,
        timeoutPhase: 'connect',
      }),
    ],
    [
      'total timeout',
      new ModelProviderError('total', {
        kind: 'timeout',
        retryable: true,
        timeoutPhase: 'total',
      }),
    ],
    [
      'provider cancellation',
      new ModelProviderError('cancelled', {
        kind: 'cancelled',
        retryable: false,
      }),
    ],
  ])(
    'preserves an ineligible %s without calling fallback',
    async (_name, error) => {
      const fallback = vi.fn(async function* () {
        yield terminal
      })
      const wrapped = new NonStreamingFallbackModelProvider({
        provider: provider(async function* () {
          throw error
          yield terminal
        }),
        nonStreamingProvider: provider(fallback, false),
      })
      const consume = async () => {
        for await (const event of wrapped.complete({ messages: [] })) void event
      }

      await expect(consume()).rejects.toBe(error)
      expect(fallback).not.toHaveBeenCalled()
    },
  )

  it('preserves an eligible error when no fallback provider exists', async () => {
    const error = markNonStreamingFallbackEligible(
      new ModelProviderError('eligible', {
        kind: 'transport_error',
        retryable: true,
      }),
    )
    const wrapped = new NonStreamingFallbackModelProvider({
      provider: provider(async function* () {
        throw error
        yield terminal
      }),
    })
    const consume = async () => {
      for await (const event of wrapped.complete({ messages: [] })) void event
    }

    await expect(consume()).rejects.toBe(error)
  })

  it('lets caller cancellation win before fallback starts', async () => {
    const controller = new AbortController()
    const fallback = vi.fn(async function* () {
      yield terminal
    })
    const wrapped = new NonStreamingFallbackModelProvider({
      provider: provider(async function* () {
        controller.abort('cancelled-by-caller')
        throw markNonStreamingFallbackEligible(
          new ModelProviderError('eligible', {
            kind: 'transport_error',
            retryable: true,
          }),
        )
        yield terminal
      }),
      nonStreamingProvider: provider(fallback, false),
    })
    const consume = async () => {
      for await (const event of wrapped.complete({
        messages: [],
        signal: controller.signal,
      }))
        void event
    }

    await expect(consume()).rejects.toMatchObject({
      kind: 'cancelled',
      retryable: false,
    })
    expect(fallback).not.toHaveBeenCalled()
  })

  it('hides failed fallback content and propagates its error', async () => {
    const fallbackError = new ModelProviderError('fallback failed', {
      kind: 'server_error',
      retryable: true,
    })
    const wrapped = new NonStreamingFallbackModelProvider({
      provider: provider(async function* () {
        throw markNonStreamingFallbackEligible(
          new ModelProviderError('stream failed', {
            kind: 'transport_error',
            retryable: true,
          }),
        )
        yield terminal
      }),
      nonStreamingProvider: provider(async function* () {
        yield { type: 'text-delta', delta: 'must-stay-buffered' }
        throw fallbackError
      }, false),
    })
    const iterator = wrapped.complete({ messages: [] })[Symbol.asyncIterator]()

    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'api-retry' },
      done: false,
    })
    await expect(iterator.next()).rejects.toBe(fallbackError)
  })

  it('rejects fallback events after terminal without exposing content', async () => {
    const wrapped = new NonStreamingFallbackModelProvider({
      provider: provider(async function* () {
        throw markNonStreamingFallbackEligible(
          new ModelProviderError('stream failed', {
            kind: 'transport_error',
            retryable: true,
          }),
        )
        yield terminal
      }),
      nonStreamingProvider: provider(async function* () {
        yield terminal
        yield { type: 'text-delta', delta: 'after-terminal' }
      }, false),
    })
    const iterator = wrapped.complete({ messages: [] })[Symbol.asyncIterator]()

    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'api-retry' },
      done: false,
    })
    await expect(iterator.next()).rejects.toThrow('after its terminal event')
  })

  it('starts a fresh connect deadline after the primary idle timeout', async () => {
    vi.useFakeTimers()
    const primary = new DeadlineModelProvider({
      provider: provider((request) => {
        reportProviderTransportActivity(request, 'response-received')
        return {
          [Symbol.asyncIterator]: () => ({
            next: () => new Promise<IteratorResult<ModelStreamEvent>>(() => {}),
          }),
        }
      }),
      deadlineMs: 1_000,
      connectTimeoutMs: 100,
      idleTimeoutMs: 20,
    })
    const nonStreaming = new DeadlineModelProvider({
      provider: provider(
        () => ({
          [Symbol.asyncIterator]: () => ({
            next: () => new Promise<IteratorResult<ModelStreamEvent>>(() => {}),
          }),
        }),
        false,
      ),
      deadlineMs: 1_000,
      connectTimeoutMs: 30,
      idleTimeoutMs: 100,
    })
    const completion = new NonStreamingFallbackModelProvider({
      provider: primary,
      nonStreamingProvider: nonStreaming,
    }).complete({ messages: [] })
    const iterator = completion[Symbol.asyncIterator]()

    const retry = iterator.next()
    await vi.advanceTimersByTimeAsync(20)
    await expect(retry).resolves.toMatchObject({
      value: { type: 'api-retry' },
      done: false,
    })

    const fallback = iterator.next()
    let settled = false
    void fallback.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    await vi.advanceTimersByTimeAsync(29)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await expect(fallback).rejects.toMatchObject({
      timeoutPhase: 'connect',
      message: 'Provider connection timed out',
    })
  })
})
