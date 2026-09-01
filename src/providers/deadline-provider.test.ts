import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  ModelProviderError,
  type ModelRequest,
  type ModelProvider,
  type ModelStreamEvent,
} from '../core/runtime.js'
import {
  DEFAULT_PROVIDER_CONNECT_TIMEOUT_MS,
  DEFAULT_PROVIDER_DEADLINE_MS,
  DEFAULT_PROVIDER_IDLE_TIMEOUT_MS,
  DeadlineModelProvider,
} from './deadline-provider.js'
import { reportProviderTransportActivity } from './provider-transport-activity.js'

const event: ModelStreamEvent = { type: 'text-delta', delta: 'ok' }
const execFileAsync = promisify(execFile)

function provider(
  complete: ModelProvider['complete'],
  overrides: Partial<ModelProvider> = {},
): ModelProvider {
  return {
    model: 'fixture',
    capabilities: { streaming: true, usage: true, tools: true },
    complete,
    ...overrides,
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('DeadlineModelProvider', () => {
  it('reports a typed connect timeout before response activity', async () => {
    vi.useFakeTimers()
    const completion = new DeadlineModelProvider({
      provider: provider(() => ({
        [Symbol.asyncIterator]: () => ({
          next: () => new Promise<IteratorResult<ModelStreamEvent>>(() => {}),
        }),
      })),
      deadlineMs: 1_000,
      connectTimeoutMs: 20,
      idleTimeoutMs: 1_000,
    }).complete({ messages: [] })

    const pending = completion[Symbol.asyncIterator]().next()
    const timedOut = expect(pending).rejects.toMatchObject({
      kind: 'timeout',
      retryable: true,
      timeoutPhase: 'connect',
      message: 'Provider connection timed out',
    })
    await vi.advanceTimersByTimeAsync(20)
    await timedOut
  })

  it('switches from connect to typed idle timeout when headers arrive', async () => {
    vi.useFakeTimers()
    const completion = new DeadlineModelProvider({
      provider: provider((request) => {
        reportProviderTransportActivity(request, 'response-received')
        return {
          [Symbol.asyncIterator]: () => ({
            next: () => new Promise<IteratorResult<ModelStreamEvent>>(() => {}),
          }),
        }
      }),
      deadlineMs: 1_000,
      connectTimeoutMs: 20,
      idleTimeoutMs: 30,
    }).complete({ messages: [] })

    const pending = completion[Symbol.asyncIterator]().next()
    const timedOut = expect(pending).rejects.toMatchObject({
      kind: 'timeout',
      retryable: true,
      timeoutPhase: 'idle',
      message: 'Provider stream idle timed out',
    })
    await vi.advanceTimersByTimeAsync(30)
    await timedOut
  })

  it('resets idle on non-event byte activity', async () => {
    vi.useFakeTimers()
    let observedRequest: ModelRequest | undefined
    const completion = new DeadlineModelProvider({
      provider: provider((request) => {
        observedRequest = request
        reportProviderTransportActivity(request, 'response-received')
        return {
          [Symbol.asyncIterator]: () => ({
            next: () => new Promise<IteratorResult<ModelStreamEvent>>(() => {}),
          }),
        }
      }),
      deadlineMs: 1_000,
      connectTimeoutMs: 100,
      idleTimeoutMs: 30,
    }).complete({ messages: [] })

    const pending = completion[Symbol.asyncIterator]().next()
    let settled = false
    void pending.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    const timedOut = expect(pending).rejects.toMatchObject({
      timeoutPhase: 'idle',
    })
    await vi.advanceTimersByTimeAsync(25)
    reportProviderTransportActivity(
      observedRequest as ModelRequest,
      'response-chunk',
    )
    await vi.advanceTimersByTimeAsync(29)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await timedOut
  })

  it('keeps the absolute total deadline despite byte activity', async () => {
    vi.useFakeTimers()
    let observedRequest: ModelRequest | undefined
    const completion = new DeadlineModelProvider({
      provider: provider((request) => {
        observedRequest = request
        reportProviderTransportActivity(request, 'response-received')
        return {
          [Symbol.asyncIterator]: () => ({
            next: () => new Promise<IteratorResult<ModelStreamEvent>>(() => {}),
          }),
        }
      }),
      deadlineMs: 100,
      connectTimeoutMs: 50,
      idleTimeoutMs: 50,
    }).complete({ messages: [] })

    const pending = completion[Symbol.asyncIterator]().next()
    const timedOut = expect(pending).rejects.toMatchObject({
      kind: 'timeout',
      retryable: true,
      timeoutPhase: 'total',
      message: 'Provider request timed out',
    })
    await vi.advanceTimersByTimeAsync(40)
    reportProviderTransportActivity(
      observedRequest as ModelRequest,
      'response-chunk',
    )
    await vi.advanceTimersByTimeAsync(40)
    reportProviderTransportActivity(
      observedRequest as ModelRequest,
      'response-chunk',
    )
    await vi.advanceTimersByTimeAsync(20)
    await timedOut
  })

  it('prefers the specific phase when connect and total expire together', async () => {
    vi.useFakeTimers()
    const completion = new DeadlineModelProvider({
      provider: provider(() => ({
        [Symbol.asyncIterator]: () => ({
          next: () => new Promise<IteratorResult<ModelStreamEvent>>(() => {}),
        }),
      })),
      deadlineMs: 20,
      connectTimeoutMs: 20,
      idleTimeoutMs: 100,
    }).complete({ messages: [] })

    const pending = completion[Symbol.asyncIterator]().next()
    const timedOut = expect(pending).rejects.toMatchObject({
      timeoutPhase: 'connect',
      message: 'Provider connection timed out',
    })
    await vi.advanceTimersByTimeAsync(20)
    await timedOut
  })

  it('starts its deadline on first consumption and times out a hung first next', async () => {
    vi.useFakeTimers()
    const complete = vi.fn(() => ({
      [Symbol.asyncIterator]: (): AsyncIterator<ModelStreamEvent> => ({
        next: () => new Promise<IteratorResult<ModelStreamEvent>>(() => {}),
      }),
    }))
    const wrapped = new DeadlineModelProvider({
      provider: provider(complete),
      deadlineMs: 100,
    })
    const iterator = wrapped.complete({ messages: [] })[Symbol.asyncIterator]()
    expect(complete).not.toHaveBeenCalled()
    const next = iterator.next()
    expect(complete).toHaveBeenCalledTimes(1)
    const timedOut = expect(next).rejects.toMatchObject({
      kind: 'timeout',
      retryable: true,
      message: 'Provider request timed out',
    })
    await vi.advanceTimersByTimeAsync(100)
    await timedOut
  })

  it('keeps an explicit legacy deadline as the implicit phase bound', async () => {
    vi.useFakeTimers()
    const completion = new DeadlineModelProvider({
      provider: provider(() => ({
        [Symbol.asyncIterator]: () => ({
          next: () => new Promise<IteratorResult<ModelStreamEvent>>(() => {}),
        }),
      })),
      deadlineMs: 180_000,
    }).complete({ messages: [] })

    const pending = completion[Symbol.asyncIterator]().next()
    let settled = false
    void pending.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    const timedOut = expect(pending).rejects.toMatchObject({
      timeoutPhase: 'total',
      message: 'Provider request timed out',
    })
    await vi.advanceTimersByTimeAsync(90_000)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(90_000)
    await timedOut
  })

  it('counts synchronous provider setup against the first connect phase', async () => {
    vi.useFakeTimers()
    const underlyingNext = vi.fn(
      () => new Promise<IteratorResult<ModelStreamEvent>>(() => {}),
    )
    const completion = new DeadlineModelProvider({
      provider: provider(() => {
        vi.advanceTimersByTime(25)
        return {
          [Symbol.asyncIterator]: () => ({ next: underlyingNext }),
        }
      }),
      deadlineMs: 1_000,
      connectTimeoutMs: 20,
      idleTimeoutMs: 100,
    }).complete({ messages: [] })

    await expect(
      completion[Symbol.asyncIterator]().next(),
    ).rejects.toMatchObject({
      timeoutPhase: 'connect',
      message: 'Provider connection timed out',
    })
    expect(underlyingNext).not.toHaveBeenCalled()
  })

  it('keeps an otherwise idle process alive until the typed deadline', async () => {
    const moduleUrl = JSON.stringify(
      new URL('./deadline-provider.ts', import.meta.url).href,
    )
    const source = `
      const { DeadlineModelProvider } = await import(${moduleUrl})
      const provider = {
        capabilities: { streaming: true, usage: true, tools: false },
        complete: () => ({
          [Symbol.asyncIterator]: () => ({
            next: () => new Promise(() => {}),
          }),
        }),
      }
      const completion = new DeadlineModelProvider({
        provider,
        deadlineMs: 20,
      }).complete({ messages: [] })
      try {
        await completion[Symbol.asyncIterator]().next()
      } catch (error) {
        process.stdout.write(JSON.stringify({
          kind: error.kind,
          retryable: error.retryable,
          message: error.message,
        }))
      }
    `

    const { stdout } = await execFileAsync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', source],
      { cwd: process.cwd(), timeout: 5_000 },
    )
    expect(JSON.parse(stdout)).toEqual({
      kind: 'timeout',
      retryable: true,
      message: 'Provider request timed out',
    })
  })

  it('returns promptly while an underlying next and cleanup both remain hung', async () => {
    vi.useFakeTimers()
    let returnCalled = 0
    let resolveNext!: (result: IteratorResult<ModelStreamEvent>) => void
    const complete = vi.fn(() => ({
      [Symbol.asyncIterator]: () => ({
        next: () =>
          new Promise<IteratorResult<ModelStreamEvent>>((resolve) => {
            resolveNext = resolve
          }),
        return: () => {
          returnCalled += 1
          return new Promise<IteratorResult<ModelStreamEvent>>(() => {})
        },
      }),
    }))
    const completion = new DeadlineModelProvider({
      provider: provider(complete),
      deadlineMs: 80,
    }).complete({ messages: [] })
    const iterator = completion[Symbol.asyncIterator]()
    const pendingNext = iterator.next()
    const pendingReturn = iterator.return?.()
    await expect(pendingReturn).resolves.toEqual({
      done: true,
      value: undefined,
    })
    await expect(pendingNext).resolves.toEqual({
      done: true,
      value: undefined,
    })
    expect(returnCalled).toBe(1)
    resolveNext({ done: true, value: undefined })
    await vi.advanceTimersByTimeAsync(80)
  })

  it('does not start the provider after a return before first consumption', async () => {
    const complete = vi.fn(async function* () {
      yield event
    })
    const completion = new DeadlineModelProvider({
      provider: provider(complete),
    }).complete({ messages: [] })
    const iterator = completion[Symbol.asyncIterator]()
    await expect(iterator.return?.()).resolves.toEqual({
      done: true,
      value: undefined,
    })
    await expect(iterator.next()).resolves.toEqual({
      done: true,
      value: undefined,
    })
    expect(complete).not.toHaveBeenCalled()
  })

  it('keeps timeout typed when the provider rejects from its abort listener', async () => {
    vi.useFakeTimers()
    const rawError = new Error('provider abort rejection')
    let rejectNext!: (error: unknown) => void
    const complete = vi.fn((request: ModelRequest) => {
      request.signal?.addEventListener('abort', () => rejectNext(rawError))
      return {
        [Symbol.asyncIterator]: (): AsyncIterator<ModelStreamEvent> => ({
          next: () =>
            new Promise<IteratorResult<ModelStreamEvent>>(
              (_resolve, reject) => {
                rejectNext = reject
              },
            ),
          return: async () => ({ done: true as const, value: undefined }),
        }),
      }
    })
    const completion = new DeadlineModelProvider({
      provider: provider(complete),
      deadlineMs: 20,
    }).complete({ messages: [] })
    const iterator = completion[Symbol.asyncIterator]()
    const pending = iterator.next()
    const timedOut = expect(pending).rejects.toMatchObject({
      kind: 'timeout',
      retryable: true,
    })
    await vi.advanceTimersByTimeAsync(20)
    await timedOut
  })

  it.each(['complete', 'iterator'] as const)(
    'cleans up when caller cancellation occurs during provider %s initialization',
    async (abortAt) => {
      const controller = new AbortController()
      const reason = new Error(`cancel during ${abortAt}`)
      const returnMethod = vi.fn(async () => ({
        done: true as const,
        value: undefined,
      }))
      const complete = vi.fn(() => {
        if (abortAt === 'complete') controller.abort(reason)
        return {
          [Symbol.asyncIterator]: (): AsyncIterator<ModelStreamEvent> => {
            if (abortAt === 'iterator') controller.abort(reason)
            return {
              next: () =>
                new Promise<IteratorResult<ModelStreamEvent>>(() => {}),
              return: returnMethod,
            }
          },
        }
      })
      const completion = new DeadlineModelProvider({
        provider: provider(complete),
      }).complete({ messages: [], signal: controller.signal })

      await expect(
        completion[Symbol.asyncIterator]().next(),
      ).rejects.toMatchObject({
        kind: 'cancelled',
        retryable: false,
        cause: reason,
      })
      expect(returnMethod).toHaveBeenCalledTimes(1)
    },
  )

  it.each<[string, () => IteratorResult<ModelStreamEvent> | undefined]>([
    [
      'event',
      (): IteratorResult<ModelStreamEvent> => ({ value: event, done: false }),
    ],
    [
      'done',
      (): IteratorResult<ModelStreamEvent> => ({
        value: undefined,
        done: true,
      }),
    ],
    ['throw', (): undefined => undefined],
  ])(
    'contains synchronous caller abort before underlying %s result',
    async (_name, makeResult) => {
      const controller = new AbortController()
      const reason = new Error('synchronous cancellation')
      const complete = vi.fn(() => ({
        [Symbol.asyncIterator]: (): AsyncIterator<ModelStreamEvent> => ({
          next: () => {
            controller.abort(reason)
            const result = makeResult()
            if (result === undefined) throw new Error('underlying throw')
            return Promise.resolve(result)
          },
          return: async () => ({ done: true as const, value: undefined }),
        }),
      }))
      const completion = new DeadlineModelProvider({
        provider: provider(complete),
      }).complete({ messages: [], signal: controller.signal })
      const iterator = completion[Symbol.asyncIterator]()
      await expect(iterator.next()).rejects.toMatchObject({
        kind: 'cancelled',
        retryable: false,
        cause: reason,
      })
    },
  )

  it('times out a later next against the same absolute deadline', async () => {
    vi.useFakeTimers()
    let count = 0
    const complete = vi.fn(() => ({
      [Symbol.asyncIterator]: () => ({
        next: () => {
          count += 1
          return count === 1
            ? Promise.resolve({ value: event, done: false as const })
            : new Promise<IteratorResult<ModelStreamEvent>>(() => {})
        },
      }),
    }))
    const completion = new DeadlineModelProvider({
      provider: provider(complete),
      deadlineMs: 100,
    }).complete({ messages: [] })
    const iterator = completion[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toEqual({
      value: event,
      done: false,
    })
    const pending = iterator.next()
    const timedOut = expect(pending).rejects.toMatchObject({ kind: 'timeout' })
    await vi.advanceTimersByTimeAsync(100)
    await timedOut
  })

  it('does not treat a consumer pause as stream idle time', async () => {
    vi.useFakeTimers()
    let count = 0
    const complete = vi.fn(() => ({
      [Symbol.asyncIterator]: () => ({
        next: () => {
          count += 1
          return count === 1
            ? Promise.resolve({ value: event, done: false as const })
            : new Promise<IteratorResult<ModelStreamEvent>>(() => {})
        },
      }),
    }))
    const completion = new DeadlineModelProvider({
      provider: provider(complete),
      deadlineMs: 1_000,
      idleTimeoutMs: 100,
    }).complete({ messages: [] })
    const iterator = completion[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toEqual({
      value: event,
      done: false,
    })
    await vi.advanceTimersByTimeAsync(200)
    const pending = iterator.next()
    const timedOut = expect(pending).rejects.toMatchObject({
      kind: 'timeout',
      timeoutPhase: 'idle',
      message: 'Provider stream idle timed out',
    })
    await vi.advanceTimersByTimeAsync(100)
    await timedOut
  })

  it('keeps the timeout outcome when caller cancellation follows it', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const completion = new DeadlineModelProvider({
      provider: provider(() => ({
        [Symbol.asyncIterator]: () => ({
          next: () => new Promise<IteratorResult<ModelStreamEvent>>(() => {}),
        }),
      })),
      deadlineMs: 10,
    }).complete({ messages: [], signal: controller.signal })
    const iterator = completion[Symbol.asyncIterator]()
    const pending = iterator.next()
    const timedOut = expect(pending).rejects.toMatchObject({
      kind: 'timeout',
      retryable: true,
    })
    await vi.advanceTimersByTimeAsync(10)
    controller.abort('late caller cancellation')
    await timedOut
  })

  it('does not call the provider when the caller is already aborted', async () => {
    const complete = vi.fn(async function* () {
      yield event
    })
    const controller = new AbortController()
    const reason = new Error('stop')
    controller.abort(reason)
    const completion = new DeadlineModelProvider({
      provider: provider(complete),
    }).complete({ messages: [], signal: controller.signal })
    const iterator = completion[Symbol.asyncIterator]()

    await expect(iterator.next()).rejects.toMatchObject({
      kind: 'cancelled',
      retryable: false,
      cause: reason,
    })
    expect(complete).not.toHaveBeenCalled()
  })

  it('cancels a later hung next and cleans up without awaiting return', async () => {
    let returnCalled = 0
    const controller = new AbortController()
    let nextCount = 0
    const complete = vi.fn(() => ({
      [Symbol.asyncIterator]: () => ({
        next: () => {
          nextCount += 1
          return nextCount === 1
            ? Promise.resolve({ value: event, done: false })
            : new Promise<IteratorResult<ModelStreamEvent>>(() => {})
        },
        return: () => {
          returnCalled += 1
          return new Promise<IteratorResult<ModelStreamEvent>>(() => {})
        },
      }),
    }))
    const completion = new DeadlineModelProvider({
      provider: provider(complete),
    }).complete({ messages: [], signal: controller.signal })
    const iterator = completion[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toEqual({
      value: event,
      done: false,
    })
    const pending = iterator.next()
    controller.abort('cancelled by caller')
    await expect(pending).rejects.toMatchObject({
      kind: 'cancelled',
      retryable: false,
    })
    expect(returnCalled).toBe(1)
  })

  it('keeps the first observed cause when caller cancellation wins the deadline', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const completion = new DeadlineModelProvider({
      provider: provider(async function* () {
        await new Promise<void>(() => {})
        yield event
      }),
      deadlineMs: 100,
    }).complete({ messages: [], signal: controller.signal })
    const iterator = completion[Symbol.asyncIterator]()
    const pending = iterator.next()
    controller.abort('caller')
    await expect(pending).rejects.toMatchObject({
      kind: 'cancelled',
      retryable: false,
      cause: 'caller',
    })
    await vi.advanceTimersByTimeAsync(100)
  })

  it('forwards events, dynamic getters, consumer return, and underlying errors', async () => {
    let model = 'one'
    const capabilities = { streaming: true, usage: true, tools: true }
    const underlyingError = new ModelProviderError('typed', {
      retryable: false,
      kind: 'invalid_request',
    })
    let returnCalled = 0
    const wrappedProvider: ModelProvider = {
      get model() {
        return model
      },
      get capabilities() {
        return capabilities
      },
      complete: () => {
        const iterator = {
          async next() {
            throw underlyingError
          },
          async return() {
            returnCalled += 1
            return { done: true as const, value: undefined }
          },
          [Symbol.asyncIterator]() {
            return this
          },
        }
        return iterator
      },
    }
    const wrapped = new DeadlineModelProvider({ provider: wrappedProvider })
    expect(wrapped.model).toBe('one')
    model = 'two'
    expect(wrapped.model).toBe('two')
    expect(wrapped.capabilities).toBe(capabilities)
    const iterator = wrapped.complete({ messages: [] })[Symbol.asyncIterator]()
    await expect(iterator.next()).rejects.toBe(underlyingError)
    expect(returnCalled).toBe(1)
  })

  it('preserves a complete normal stream in order', async () => {
    const events: ModelStreamEvent[] = [
      { type: 'text-delta', delta: 'hello' },
      { type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } },
      { type: 'terminal', reason: 'end_turn' },
    ]
    const completion = new DeadlineModelProvider({
      provider: provider(async function* () {
        yield* events
      }),
    }).complete({ messages: [] })
    const actual: ModelStreamEvent[] = []
    for await (const item of completion) actual.push(item)
    expect(actual).toEqual(events)
  })

  it('returns promptly on consumer return and contains cleanup rejection', async () => {
    let returnCalled = 0
    const wrappedProvider = provider(() => {
      const iterator = {
        next: async () => ({ value: event, done: false as const }),
        return: () => {
          returnCalled += 1
          return Promise.reject(new Error('cleanup failed'))
        },
        [Symbol.asyncIterator]() {
          return this
        },
      }
      return iterator
    })
    const completion = new DeadlineModelProvider({
      provider: wrappedProvider,
    }).complete({ messages: [] })
    const iterator = completion[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toEqual({
      value: event,
      done: false,
    })
    await expect(iterator.return?.()).resolves.toMatchObject({ done: true })
    expect(returnCalled).toBe(1)
  })

  it('rejects invalid deadline values', () => {
    const values = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]
    for (const deadlineMs of values) {
      expect(
        () =>
          new DeadlineModelProvider({
            provider: provider(async function* () {}),
            deadlineMs,
          }),
      ).toThrow('positive integer')
      expect(
        () =>
          new DeadlineModelProvider({
            provider: provider(async function* () {}),
            connectTimeoutMs: deadlineMs,
          }),
      ).toThrow('Provider connect timeout must be a positive integer')
      expect(
        () =>
          new DeadlineModelProvider({
            provider: provider(async function* () {}),
            idleTimeoutMs: deadlineMs,
          }),
      ).toThrow('Provider idle timeout must be a positive integer')
    }
    expect(DEFAULT_PROVIDER_DEADLINE_MS).toBe(90_000)
    expect(DEFAULT_PROVIDER_CONNECT_TIMEOUT_MS).toBe(90_000)
    expect(DEFAULT_PROVIDER_IDLE_TIMEOUT_MS).toBe(90_000)
  })
})
