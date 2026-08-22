import { describe, expect, it, vi } from 'vitest'

import {
  AgentRunCancelledError,
  AgentRuntime,
  annotateAutoModePermissionOutcome,
  annotatePermissionDecision,
  ModelProviderError,
  type ModelToolCall,
  type ModelProvider,
  type ModelRequest,
  type RuntimeEvent,
  type ToolExecutionResult,
  type ToolRegistry,
} from './runtime.js'

function providerFrom(complete: ModelProvider['complete']): ModelProvider {
  return {
    capabilities: { streaming: true, usage: true, tools: true },
    complete,
  }
}

function terminalProvider(complete: ModelProvider['complete']): ModelProvider {
  return {
    capabilities: {
      streaming: true,
      usage: true,
      tools: true,
      terminalReasons: true,
    },
    complete,
  }
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const image = {
  type: 'image' as const,
  mediaType: 'image/png' as const,
  data: 'aGVsbG8=',
}

describe('AgentRuntime', () => {
  it('passes the stable system prefix boundary to the provider', async () => {
    let captured: ModelRequest | undefined
    const runtime = new AgentRuntime(
      providerFrom(async function* (request) {
        captured = request
        yield { type: 'text-delta', delta: 'done' }
      }),
    )

    await runtime.run({
      messages: [
        { role: 'system', content: 'stable' },
        { role: 'system', content: 'volatile' },
        { role: 'user', content: 'prompt' },
      ],
      stableSystemMessageCount: 1,
    })

    expect(captured?.stableSystemMessageCount).toBe(1)
  })

  it('emits the typed provider terminal reason to runtime observers', async () => {
    const events: RuntimeEvent[] = []
    const runtime = new AgentRuntime(
      terminalProvider(async function* () {
        yield { type: 'text-delta', delta: 'partial' }
        yield { type: 'terminal', reason: 'max_tokens' }
      }),
      (event) => events.push(event),
    )

    await expect(
      runtime.run({ messages: [{ role: 'user', content: 'continue' }] }),
    ).resolves.toMatchObject({ text: 'partial' })
    expect(events).toContainEqual({ type: 'terminal', reason: 'max_tokens' })
  })

  it('surfaces prompt-too-long terminal state without committing an assistant or running Stop hooks', async () => {
    let assistantCompletions = 0
    let stopHooks = 0
    const runtime = new AgentRuntime(
      terminalProvider(async function* () {
        yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 0 } }
        yield { type: 'terminal', reason: 'prompt_too_long' }
      }),
    )

    await expect(
      runtime.run({
        messages: [{ role: 'user', content: 'oversized' }],
        observer: {
          async assistantCompleted() {
            assistantCompletions += 1
          },
          async toolCompleted() {},
        },
        async onStop() {
          stopHooks += 1
          return []
        },
      }),
    ).rejects.toMatchObject({
      kind: 'prompt_too_long',
      retryable: false,
    })
    expect(assistantCompletions).toBe(0)
    expect(stopHooks).toBe(0)
  })

  it('keeps healthy output live while deferring prompt-too-long failure presentation', async () => {
    let releaseProvider: () => void = () => undefined
    const providerReleased = new Promise<void>((resolve) => {
      releaseProvider = resolve
    })
    let sawText: () => void = () => undefined
    const textObserved = new Promise<void>((resolve) => {
      sawText = resolve
    })
    let completed = false
    const runtime = new AgentRuntime(
      terminalProvider(async function* () {
        yield { type: 'text-delta', delta: 'live' }
        await providerReleased
        yield { type: 'terminal', reason: 'end_turn' }
      }),
      (event) => {
        if (event.type === 'text-delta') sawText()
      },
    )

    const run = runtime
      .run({
        messages: [{ role: 'user', content: 'stream' }],
        deferFailureKinds: ['prompt_too_long'],
      })
      .then((result) => {
        completed = true
        return result
      })
    await textObserved
    expect(completed).toBe(false)
    releaseProvider()
    await expect(run).resolves.toMatchObject({ text: 'live' })
  })

  it('pairs a pending tool call once before surfacing prompt-too-long', async () => {
    const events: RuntimeEvent[] = []
    const persisted: string[] = []
    let executions = 0
    const runtime = new AgentRuntime(
      terminalProvider(async function* () {
        yield {
          type: 'tool-call',
          call: { id: 'pending-read', name: 'Read', input: {} },
        }
        yield { type: 'terminal', reason: 'prompt_too_long' }
      }),
      (event) => events.push(event),
      {
        tools: {
          definitions: () => [
            {
              name: 'Read',
              description: 'Read a file',
              inputSchema: { type: 'object' },
            },
          ],
          schedulingPolicy: () => ({
            concurrency: 'exclusive',
            startAfterAssistant: true,
          }),
          async prepare(call) {
            return call
          },
          async execute() {
            executions += 1
            return { content: 'must not execute', isError: false }
          },
        },
        permissions: { resolve: () => ({ behavior: 'allow' }) },
      },
    )

    await expect(
      runtime.run({
        messages: [{ role: 'user', content: 'oversized' }],
        observer: {
          async assistantCompleted() {
            persisted.push('assistant')
          },
          async toolCompleted() {
            persisted.push('tool')
          },
        },
      }),
    ).rejects.toMatchObject({ kind: 'prompt_too_long' })

    expect(executions).toBe(0)
    expect(persisted).toEqual([])
    expect(
      events.filter(
        (event) =>
          event.type === 'tool-result' && event.callId === 'pending-read',
      ),
    ).toEqual([
      expect.objectContaining({
        type: 'tool-result',
        callId: 'pending-read',
        isError: true,
      }),
    ])
  })

  it('fails deterministically when a terminal-capable provider omits its reason', async () => {
    const runtime = new AgentRuntime(
      terminalProvider(async function* () {
        yield { type: 'text-delta', delta: 'partial' }
      }),
    )

    await expect(
      runtime.run({ messages: [{ role: 'user', content: 'missing' }] }),
    ).rejects.toThrow('without a terminal reason')
  })

  it('rejects events after terminal and terminal/tool-call mismatches', async () => {
    const afterTerminal = new AgentRuntime(
      terminalProvider(async function* () {
        yield { type: 'terminal', reason: 'end_turn' }
        yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
      }),
    )
    await expect(
      afterTerminal.run({ messages: [{ role: 'user', content: 'late' }] }),
    ).rejects.toThrow('usage after terminal reason end_turn')

    const missingTool = new AgentRuntime(
      terminalProvider(async function* () {
        yield { type: 'terminal', reason: 'tool_use' }
      }),
    )
    await expect(
      missingTool.run({ messages: [{ role: 'user', content: 'tool' }] }),
    ).rejects.toThrow('tool_use without a completed tool call')
  })

  it('collects provider API duration only when metrics are requested', async () => {
    const provider = providerFrom(async function* () {
      yield { type: 'text-delta', delta: 'measured' }
      yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1 } }
    })
    const runtime = new AgentRuntime(provider)
    const result = await runtime.run({
      messages: [{ role: 'user', content: 'measure' }],
      collectMetrics: true,
    })
    expect(result.durationApiMs).toBeGreaterThanOrEqual(0)
  })

  it('reports the provider attempt duration as the retry-free API duration', async () => {
    const provider = providerFrom(async function* () {
      yield { type: 'api-attempt-duration', durationMs: 7 }
      yield { type: 'text-delta', delta: 'measured' }
      yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1 } }
    })
    const runtime = new AgentRuntime(provider)
    const result = await runtime.run({
      messages: [{ role: 'user', content: 'measure' }],
      collectMetrics: true,
    })
    expect(result.durationApiWithoutRetriesMs).toBe(7)
    expect(result.durationApiMs).toBeGreaterThanOrEqual(0)
  })

  it('preserves an explicit zero provider attempt duration while the total duration is present', async () => {
    const provider = providerFrom(async function* () {
      yield { type: 'api-attempt-duration', durationMs: 0 }
      yield { type: 'text-delta', delta: 'measured' }
      yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1 } }
    })
    const runtime = new AgentRuntime(provider)
    const result = await runtime.run({
      messages: [{ role: 'user', content: 'measure' }],
      collectMetrics: true,
    })
    expect(result.durationApiWithoutRetriesMs).toBe(0)
    expect(result.durationApiMs).toBeGreaterThanOrEqual(0)
  })

  it('falls back to the surrounding elapsed duration when the provider reports no attempt metric', async () => {
    const provider = providerFrom(async function* () {
      yield { type: 'text-delta', delta: 'measured' }
      yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1 } }
    })
    const runtime = new AgentRuntime(provider)
    const result = await runtime.run({
      messages: [{ role: 'user', content: 'measure' }],
      collectMetrics: true,
    })
    expect(result.durationApiWithoutRetriesMs).toBeDefined()
    expect(result.durationApiWithoutRetriesMs).toBe(result.durationApiMs)
  })

  it('omits the retry-free metric when metrics are not collected', async () => {
    const provider = providerFrom(async function* () {
      yield { type: 'api-attempt-duration', durationMs: 7 }
      yield { type: 'text-delta', delta: 'measured' }
      yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1 } }
    })
    const runtime = new AgentRuntime(provider)
    const result = await runtime.run({
      messages: [{ role: 'user', content: 'measure' }],
    })
    expect(result.durationApiWithoutRetriesMs).toBeUndefined()
    expect(result.durationApiMs).toBeUndefined()
  })

  it('propagates nested tool retry-free API duration across turns', async () => {
    let turn = 0
    const provider = providerFrom(async function* () {
      turn += 1
      yield { type: 'api-attempt-duration', durationMs: turn * 10 }
      if (turn === 1) {
        yield {
          type: 'tool-call',
          call: { id: 'call_duration', name: 'Read', input: {} },
        }
        return
      }
      yield { type: 'text-delta', delta: 'done' }
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    })
    const runtime = new AgentRuntime(provider, undefined, {
      tools: {
        definitions: () => [],
        prepare: async (call) => call,
        execute: async () => ({
          content: 'nested',
          isError: false,
          durationApiMs: 100,
          durationApiWithoutRetriesMs: 80,
        }),
      },
      permissions: { resolve: () => ({ behavior: 'allow' }) },
    })
    const result = await runtime.run({
      messages: [{ role: 'user', content: 'inspect' }],
      collectMetrics: true,
    })
    expect(result.text).toBe('done')
    expect(result.durationApiWithoutRetriesMs).toBe(10 + 20 + 80)
    expect(result.durationApiMs).toBeGreaterThanOrEqual(100)
  })

  it('falls back to a tool durationApiMs when the tool reports no retry-free duration', async () => {
    let turn = 0
    const provider = providerFrom(async function* () {
      turn += 1
      yield { type: 'api-attempt-duration', durationMs: 5 }
      if (turn === 1) {
        yield {
          type: 'tool-call',
          call: { id: 'call_legacy', name: 'Read', input: {} },
        }
        return
      }
      yield { type: 'text-delta', delta: 'done' }
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    })
    const runtime = new AgentRuntime(provider, undefined, {
      tools: {
        definitions: () => [],
        prepare: async (call) => call,
        execute: async () => ({
          content: 'legacy',
          isError: false,
          durationApiMs: 100,
        }),
      },
      permissions: { resolve: () => ({ behavior: 'allow' }) },
    })
    const result = await runtime.run({
      messages: [{ role: 'user', content: 'inspect' }],
      collectMetrics: true,
    })
    expect(result.durationApiWithoutRetriesMs).toBe(5 + 5 + 100)
  })

  it('rejects invalid provider attempt duration metadata', async () => {
    const runWith = async (durationMs: number) => {
      const provider = providerFrom(async function* () {
        yield { type: 'api-attempt-duration', durationMs }
        yield { type: 'text-delta', delta: 'unexpected' }
      })
      return new AgentRuntime(provider).run({
        messages: [{ role: 'user', content: 'measure' }],
        collectMetrics: true,
      })
    }
    const message =
      'api-attempt-duration durationMs must be a finite nonnegative number'
    await expect(runWith(-1)).rejects.toThrow(message)
    await expect(runWith(Number.NaN)).rejects.toThrow(message)
    await expect(runWith(Number.POSITIVE_INFINITY)).rejects.toThrow(message)
  })

  it('rejects duplicate provider attempt duration metadata in one turn', async () => {
    const provider = providerFrom(async function* () {
      yield { type: 'api-attempt-duration', durationMs: 1 }
      yield { type: 'api-attempt-duration', durationMs: 2 }
      yield { type: 'text-delta', delta: 'unexpected' }
    })
    await expect(
      new AgentRuntime(provider).run({
        messages: [{ role: 'user', content: 'measure' }],
        collectMetrics: true,
      }),
    ).rejects.toThrow(
      'Provider emitted multiple api-attempt-duration events in one turn',
    )
  })

  it('measures a successful tool execution wall time exactly', async () => {
    let turn = 0
    const provider = providerFrom(async function* () {
      if (turn++ === 0) {
        yield {
          type: 'tool-call',
          call: { id: 'call_success', name: 'Read', input: {} },
        }
        return
      }
      yield { type: 'text-delta', delta: 'done' }
    })
    const now = vi
      .spyOn(performance, 'now')
      .mockReturnValueOnce(0) // completeToolCall startedAt
      .mockReturnValueOnce(100) // executeTool start
      .mockReturnValueOnce(250) // executeTool end
      .mockReturnValue(0)
    const runtime = new AgentRuntime(provider, undefined, {
      tools: {
        definitions: () => [],
        prepare: async (call) => call,
        execute: async () => ({ content: 'ok', isError: false }),
      },
      permissions: { resolve: () => ({ behavior: 'allow' }) },
    })
    try {
      const result = await runtime.run({
        messages: [{ role: 'user', content: 'inspect' }],
      })
      expect(result.text).toBe('done')
      expect(result.durationToolMs).toBe(150)
    } finally {
      now.mockRestore()
    }
  })

  it('measures a thrown tool execution wall time exactly', async () => {
    let turn = 0
    const provider = providerFrom(async function* () {
      if (turn++ === 0) {
        yield {
          type: 'tool-call',
          call: { id: 'call_thrown', name: 'Bash', input: {} },
        }
        return
      }
      yield { type: 'text-delta', delta: 'recovered' }
    })
    const now = vi
      .spyOn(performance, 'now')
      .mockReturnValueOnce(0) // completeToolCall startedAt
      .mockReturnValueOnce(10) // executeTool start
      .mockReturnValueOnce(40) // executeTool end after the throw
      .mockReturnValue(0)
    const runtime = new AgentRuntime(provider, undefined, {
      tools: {
        definitions: () => [],
        prepare: async (call) => call,
        execute: async () => {
          throw new Error('boom')
        },
      },
      permissions: { resolve: () => ({ behavior: 'allow' }) },
    })
    try {
      const result = await runtime.run({
        messages: [{ role: 'user', content: 'inspect' }],
      })
      expect(result.text).toBe('recovered')
      expect(result.durationToolMs).toBe(30)
    } finally {
      now.mockRestore()
    }
  })

  it('contributes zero tool duration for denied, unavailable, and prepare-failed tools', async () => {
    const runWith = async (
      options: ConstructorParameters<typeof AgentRuntime>[2],
    ) => {
      let turn = 0
      const provider = providerFrom(async function* () {
        if (turn++ === 0) {
          yield {
            type: 'tool-call',
            call: { id: 'call_zero', name: 'Bash', input: {} },
          }
          return
        }
        yield { type: 'text-delta', delta: 'done' }
      })
      const runtime = new AgentRuntime(provider, undefined, options)
      return runtime.run({
        messages: [{ role: 'user', content: 'run' }],
      })
    }

    const denied = await runWith({
      tools: {
        definitions: () => [],
        prepare: async (call) => call,
        execute: async () => ({ content: 'unexpected', isError: false }),
      },
      permissions: {
        resolve: () => ({ behavior: 'deny', reason: 'Denied by policy' }),
      },
    })
    expect(denied.text).toBe('done')
    expect(denied.durationToolMs).toBeUndefined()

    const unavailable = await runWith(undefined)
    expect(unavailable.text).toBe('done')
    expect(unavailable.durationToolMs).toBeUndefined()

    const prepareFailed = await runWith({
      tools: {
        definitions: () => [],
        prepare: async () => {
          throw new Error('prepare failed')
        },
        execute: async () => ({ content: 'unexpected', isError: false }),
      },
      permissions: { resolve: () => ({ behavior: 'allow' }) },
    })
    expect(prepareFailed.text).toBe('done')
    expect(prepareFailed.durationToolMs).toBeUndefined()
  })

  it('replaces a nested tool-reported duration with the outer execution measurement', async () => {
    let turn = 0
    const provider = providerFrom(async function* () {
      if (turn++ === 0) {
        yield {
          type: 'tool-call',
          call: { id: 'call_nested', name: 'Agent', input: {} },
        }
        return
      }
      yield { type: 'text-delta', delta: 'done' }
    })
    const now = vi
      .spyOn(performance, 'now')
      .mockReturnValueOnce(0) // completeToolCall startedAt
      .mockReturnValueOnce(100) // executeTool start
      .mockReturnValueOnce(250) // executeTool end
      .mockReturnValue(0)
    const runtime = new AgentRuntime(provider, undefined, {
      tools: {
        definitions: () => [],
        prepare: async (call) => call,
        execute: async () => ({
          content: 'nested',
          isError: false,
          durationToolMs: 9999,
        }),
      },
      permissions: { resolve: () => ({ behavior: 'allow' }) },
    })
    try {
      const result = await runtime.run({
        messages: [{ role: 'user', content: 'inspect' }],
      })
      expect(result.text).toBe('done')
      expect(result.durationToolMs).toBe(150)
    } finally {
      now.mockRestore()
    }
  })

  it('aggregates successful and failed tool durations exactly once across turns', async () => {
    let turn = 0
    const provider = providerFrom(async function* () {
      turn += 1
      if (turn === 1) {
        yield {
          type: 'tool-call',
          call: { id: 'call_error', name: 'Read', input: {} },
        }
        return
      }
      if (turn === 2) {
        yield {
          type: 'tool-call',
          call: { id: 'call_thrown_agg', name: 'Bash', input: {} },
        }
        return
      }
      yield { type: 'text-delta', delta: 'done' }
    })
    const now = vi
      .spyOn(performance, 'now')
      .mockReturnValueOnce(0) // call_error startedAt
      .mockReturnValueOnce(100) // call_error execute start
      .mockReturnValueOnce(200) // call_error execute end
      .mockReturnValueOnce(0) // call_error emitProgress
      .mockReturnValueOnce(0) // call_thrown_agg startedAt
      .mockReturnValueOnce(300) // call_thrown_agg execute start
      .mockReturnValueOnce(500) // call_thrown_agg execute end
      .mockReturnValue(0)
    const runtime = new AgentRuntime(provider, undefined, {
      tools: {
        definitions: () => [],
        prepare: async (call) => call,
        execute: async (call) => {
          if (call.id === 'call_thrown_agg') throw new Error('boom')
          return { content: 'failed', isError: true }
        },
      },
      permissions: { resolve: () => ({ behavior: 'allow' }) },
    })
    try {
      const result = await runtime.run({
        messages: [{ role: 'user', content: 'inspect' }],
      })
      expect(result.text).toBe('done')
      expect(result.durationToolMs).toBe(300)
    } finally {
      now.mockRestore()
    }
  })

  it('omits the tool duration field when the accumulated value is exactly zero', async () => {
    const provider = providerFrom(async function* () {
      yield { type: 'text-delta', delta: 'hello' }
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    })
    const result = await new AgentRuntime(provider).run({
      messages: [{ role: 'user', content: 'say hello' }],
    })
    expect(result.text).toBe('hello')
    expect(result.durationToolMs).toBeUndefined()
  })

  it('stops before a new model turn after a priced budget is exhausted', async () => {
    let calls = 0
    const provider = providerFrom(async function* () {
      calls += 1
      yield { type: 'text-delta', delta: 'first' }
      yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1 } }
    })
    const runtime = new AgentRuntime(provider, undefined, {
      costUsd: (usage) => usage.inputTokens / 1_000_000,
      maxBudgetUsd: 0.000001,
    })
    await expect(
      runtime.run({
        messages: [{ role: 'user', content: 'budget' }],
        onStop: async () => ['continue'],
      }),
    ).rejects.toThrow('Maximum budget')
    expect(calls).toBe(1)
  })

  it('continues beyond the former default model turn limit', async () => {
    let calls = 0
    let toolExecutions = 0
    const provider = providerFrom(async function* () {
      calls += 1
      if (calls <= 17) {
        yield {
          type: 'tool-call',
          call: { id: `call_${calls}`, name: 'Read', input: {} },
        }
        return
      }
      yield { type: 'text-delta', delta: 'done' }
    })
    const runtime = new AgentRuntime(provider, undefined, {
      tools: {
        definitions: () => [],
        prepare: async (call) => call,
        execute: async () => {
          toolExecutions += 1
          return { content: 'read', isError: false }
        },
      },
      permissions: { resolve: () => ({ behavior: 'allow' }) },
    })

    await expect(
      runtime.run({ messages: [{ role: 'user', content: 'continue' }] }),
    ).resolves.toMatchObject({ text: 'done' })
    expect(calls).toBe(18)
    expect(toolExecutions).toBe(17)
  })

  it('honors a per-run maximum model turn limit', async () => {
    let calls = 0
    const provider = providerFrom(async function* () {
      calls += 1
      yield { type: 'text-delta', delta: `turn-${calls}` }
    })

    await expect(
      new AgentRuntime(provider).run({
        messages: [{ role: 'user', content: 'limit' }],
        maxModelTurns: 1,
        onStop: async () => ['continue'],
      }),
    ).rejects.toThrow('Maximum model turns of 1 exceeded')
    expect(calls).toBe(1)
  })

  it('honors a runtime-level maximum model turn limit', async () => {
    let calls = 0
    const provider = providerFrom(async function* () {
      calls += 1
      yield { type: 'text-delta', delta: `turn-${calls}` }
    })

    await expect(
      new AgentRuntime(provider, undefined, { maxModelTurns: 2 }).run({
        messages: [{ role: 'user', content: 'limit' }],
        onStop: async () => ['continue'],
      }),
    ).rejects.toThrow('Maximum model turns of 2 exceeded')
    expect(calls).toBe(2)
  })

  it.each([0, -1, 1.5, Number.POSITIVE_INFINITY])(
    'rejects an invalid explicit model turn limit of %s',
    async (maxModelTurns) => {
      const runtime = new AgentRuntime(
        providerFrom(async function* () {
          yield { type: 'text-delta', delta: 'unused' }
        }),
      )

      await expect(
        runtime.run({
          messages: [{ role: 'user', content: 'limit' }],
          maxModelTurns,
        }),
      ).rejects.toThrow('maxModelTurns must be a positive integer')
    },
  )

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

  it('preserves signed thinking for tool follow-ups without mixing it into text', async () => {
    const requests: ModelRequest[] = []
    const provider = providerFrom(async function* (request) {
      requests.push(request)
      if (requests.length === 1) {
        yield {
          type: 'thinking-start',
          block: { type: 'thinking', thinking: '' },
        }
        yield { type: 'thinking-delta', delta: 'private' }
        yield { type: 'thinking-signature-delta', delta: 'signed' }
        yield {
          type: 'thinking-stop',
          block: {
            type: 'thinking',
            thinking: 'private',
            signature: 'signed',
          },
        }
        yield {
          type: 'tool-call',
          call: { id: 'call_1', name: 'Read', input: {} },
        }
        return
      }
      yield { type: 'text-delta', delta: 'public answer' }
    })
    const persisted: unknown[] = []
    const events: RuntimeEvent[] = []
    const runtime = new AgentRuntime(provider, (event) => events.push(event), {
      tools: {
        definitions: () => [
          { name: 'Read', description: 'read', inputSchema: {} },
        ],
        prepare: async (call) => call,
        execute: async () => ({ content: 'contents', isError: false }),
      },
      permissions: { resolve: () => ({ behavior: 'allow' }) },
    })
    const result = await runtime.run({
      messages: [{ role: 'user', content: 'inspect' }],
      thinking: { mode: 'enabled', maxTokens: 2048 },
      observer: {
        assistantCompleted: async (message) => {
          persisted.push(message)
        },
        toolCompleted: async () => undefined,
      },
    })

    expect(result.text).toBe('public answer')
    expect(requests[0]?.thinking).toEqual({
      mode: 'enabled',
      maxTokens: 2048,
    })
    expect(requests[1]?.messages).toContainEqual({
      role: 'assistant',
      content: '',
      thinkingBlocks: [
        { type: 'thinking', thinking: 'private', signature: 'signed' },
      ],
      toolCalls: [{ id: 'call_1', name: 'Read', input: {} }],
    })
    expect(persisted).toContainEqual({
      role: 'assistant',
      content: '',
      thinkingBlocks: [
        { type: 'thinking', thinking: 'private', signature: 'signed' },
      ],
      toolCalls: [{ id: 'call_1', name: 'Read', input: {} }],
    })
    expect(events).toContainEqual({ type: 'thinking-delta', delta: 'private' })
  })

  it('continues after a stop hook blocks completion', async () => {
    const requests: ModelRequest[] = []
    let turn = 0
    const provider = providerFrom(async function* (request) {
      requests.push(request)
      yield {
        type: 'text-delta',
        delta: turn++ === 0 ? 'first answer' : 'revised answer',
      }
    })
    const followUps: string[][] = []
    const runtime = new AgentRuntime(provider)

    const result = await runtime.run({
      messages: [{ role: 'user', content: 'answer' }],
      onStop: async () =>
        turn === 1 ? ['Stop hook blocked: revise response'] : [],
      observer: {
        async assistantCompleted() {},
        async toolCompleted() {},
        async followUpUserMessagesCompleted(messages) {
          followUps.push([...messages])
        },
      },
    })

    expect(result.text).toBe('revised answer')
    expect(requests).toHaveLength(2)
    expect(requests[1]?.messages.at(-1)).toEqual({
      role: 'user',
      content: 'Stop hook blocked: revise response',
    })
    expect(followUps).toEqual([['Stop hook blocked: revise response']])
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

  it('forwards provider retry lifecycle without starting an assistant stream', async () => {
    const events: RuntimeEvent[] = []
    const provider = providerFrom(async function* () {
      yield {
        type: 'api-retry',
        attempt: 1,
        maxRetries: 2,
        retryDelayMs: 0,
        errorStatus: 503,
        error: 'server_error',
      }
      yield { type: 'text-delta', delta: 'ok' }
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    })
    const result = await new AgentRuntime(provider, (event) =>
      events.push(event),
    ).run({
      messages: [{ role: 'user', content: 'retry' }],
    })
    expect(result.text).toBe('ok')
    expect(events).toContainEqual({
      type: 'api-retry',
      attempt: 1,
      maxRetries: 2,
      retryDelayMs: 0,
      errorStatus: 503,
      error: 'server_error',
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

  it('stops an active stream when cancellation is requested', async () => {
    const controller = new AbortController()
    const events: RuntimeEvent[] = []
    const provider = providerFrom(async function* (request) {
      expect(request.signal).toBe(controller.signal)
      yield { type: 'text-delta', delta: 'partial' }
      controller.abort()
      yield { type: 'text-delta', delta: 'ignored' }
    })
    const runtime = new AgentRuntime(provider, (event) => events.push(event))

    await expect(
      runtime.run({
        messages: [{ role: 'user', content: 'hello' }],
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(AgentRunCancelledError)
    expect(events.at(-1)).toEqual({ type: 'state', state: 'cancelled' })
    expect(events).not.toContainEqual({ type: 'state', state: 'completed' })
    expect(events).not.toContainEqual({ type: 'text-delta', delta: 'ignored' })
  })

  it('runs an allowed tool call and returns its result to the provider', async () => {
    const requests: ModelRequest[] = []
    let turn = 0
    const provider = providerFrom(async function* (request) {
      requests.push(request)
      if (turn++ === 0) {
        yield {
          type: 'tool-call',
          call: {
            id: 'call_read',
            name: 'Read',
            input: { file_path: 'README.md' },
          },
        }
        yield {
          type: 'usage',
          usage: { inputTokens: 5, outputTokens: 3 },
        }
        return
      }
      yield { type: 'text-delta', delta: 'Praxis is local-first.' }
      yield {
        type: 'usage',
        usage: { inputTokens: 8, outputTokens: 4 },
      }
    })
    const tools: ToolRegistry = {
      definitions: () => [
        {
          name: 'Read',
          description: 'Read a file',
          inputSchema: { type: 'object' },
        },
      ],
      async prepare(call) {
        return {
          ...call,
          input: { file_path: '/workspace/README.md' },
        }
      },
      async execute() {
        return { content: '# Praxis', isError: false }
      },
    }
    const persisted: string[] = []
    const events: RuntimeEvent[] = []
    const runtime = new AgentRuntime(provider, (event) => events.push(event), {
      tools,
      permissions: { resolve: () => ({ behavior: 'allow' }) },
    })

    const result = await runtime.run({
      cwd: '/workspace',
      messages: [{ role: 'user', content: 'What is this project?' }],
      reloadMessages: async () => [
        { role: 'user', content: 'What is this project?' },
        { role: 'system', content: 'ACTIVE_READ_RULE' },
      ],
      observer: {
        async assistantCompleted(message) {
          persisted.push(message.toolCalls?.[0]?.id ?? message.content)
        },
        async toolCompleted(call, toolResult) {
          persisted.push(`${call.id}:${toolResult.content}`)
        },
      },
    })

    expect(result).toMatchObject({
      text: 'Praxis is local-first.',
      usage: { inputTokens: 13, outputTokens: 7 },
    })
    expect(requests).toHaveLength(2)
    expect(requests[0]?.tools).toEqual(tools.definitions())
    expect(requests[1]?.messages.at(-1)).toEqual({
      role: 'system',
      content: 'ACTIVE_READ_RULE',
    })
    expect(persisted).toEqual([
      'call_read',
      'call_read:# Praxis',
      'Praxis is local-first.',
    ])
    expect(events).toContainEqual({
      type: 'permission-decision',
      callId: 'call_read',
      behavior: 'allow',
    })
    expect(events).toContainEqual({
      type: 'tool-result',
      callId: 'call_read',
      content: '# Praxis',
      isError: false,
    })
  })

  it('starts completed concurrent tool calls before the provider stream ends and exposes results in completion order', async () => {
    const startedA = deferred()
    const startedB = deferred()
    const releaseA = deferred()
    const releaseB = deferred()
    const finishProvider = deferred()
    const observedB = deferred()
    const events: RuntimeEvent[] = []
    let turn = 0
    const provider = providerFrom(async function* () {
      if (turn++ > 0) {
        yield { type: 'text-delta', delta: 'done' }
        return
      }
      yield {
        type: 'tool-call',
        call: { id: 'safe_a', name: 'SafeA', input: {} },
      }
      await startedA.promise
      yield {
        type: 'tool-call',
        call: { id: 'safe_b', name: 'SafeB', input: {} },
      }
      await startedB.promise
      await finishProvider.promise
    })
    const runtime = new AgentRuntime(
      provider,
      (event) => {
        events.push(event)
        if (event.type === 'tool-result' && event.callId === 'safe_b') {
          observedB.resolve()
        }
      },
      {
        tools: {
          definitions: () => [],
          schedulingPolicy: () => ({ concurrency: 'concurrent' }),
          prepare: async (call) => call,
          execute: async (call) => {
            if (call.id === 'safe_a') {
              startedA.resolve()
              await releaseA.promise
            } else {
              startedB.resolve()
              await releaseB.promise
            }
            return { content: call.id, isError: false }
          },
        },
        permissions: { resolve: () => ({ behavior: 'allow' }) },
      },
    )

    const running = runtime.run({
      messages: [{ role: 'user', content: 'parallel' }],
    })
    await startedA.promise
    await startedB.promise
    releaseB.resolve()
    await observedB.promise
    expect(
      events.some(
        (event) => event.type === 'tool-result' && event.callId === 'safe_a',
      ),
    ).toBe(false)
    finishProvider.resolve()
    releaseA.resolve()
    await expect(running).resolves.toMatchObject({ text: 'done' })
    expect(
      events
        .filter((event) => event.type === 'tool-result')
        .map((event) => event.callId),
    ).toEqual(['safe_b', 'safe_a'])
  })

  it('treats exclusive tools as FIFO barriers between concurrent groups', async () => {
    const releases = new Map(
      ['safe_a', 'safe_b', 'unsafe_c', 'safe_d'].map((id) => [id, deferred()]),
    )
    const started: string[] = []
    const startedSignals = new Map(
      ['safe_a', 'safe_b', 'unsafe_c', 'safe_d'].map((id) => [id, deferred()]),
    )
    let turn = 0
    const provider = providerFrom(async function* () {
      if (turn++ > 0) {
        yield { type: 'text-delta', delta: 'done' }
        return
      }
      for (const [id, name] of [
        ['safe_a', 'Safe'],
        ['safe_b', 'Safe'],
        ['unsafe_c', 'Unsafe'],
        ['safe_d', 'Safe'],
      ] as const) {
        yield { type: 'tool-call', call: { id, name, input: {} } }
      }
    })
    const resultOrder: string[] = []
    const runtime = new AgentRuntime(
      provider,
      (event) => {
        if (event.type === 'tool-result') resultOrder.push(event.callId)
      },
      {
        tools: {
          definitions: () => [],
          schedulingPolicy: (call) => ({
            concurrency: call.name === 'Safe' ? 'concurrent' : 'exclusive',
          }),
          prepare: async (call) => call,
          execute: async (call) => {
            started.push(call.id)
            startedSignals.get(call.id)?.resolve()
            await releases.get(call.id)?.promise
            return { content: call.id, isError: false }
          },
        },
        permissions: { resolve: () => ({ behavior: 'allow' }) },
      },
    )

    const running = runtime.run({
      messages: [{ role: 'user', content: 'barriers' }],
    })
    await Promise.all([
      startedSignals.get('safe_a')?.promise,
      startedSignals.get('safe_b')?.promise,
    ])
    expect(started).toEqual(['safe_a', 'safe_b'])
    releases.get('safe_b')?.resolve()
    releases.get('safe_a')?.resolve()
    await startedSignals.get('unsafe_c')?.promise
    expect(started).toEqual(['safe_a', 'safe_b', 'unsafe_c'])
    releases.get('unsafe_c')?.resolve()
    await startedSignals.get('safe_d')?.promise
    expect(started).toEqual(['safe_a', 'safe_b', 'unsafe_c', 'safe_d'])
    releases.get('safe_d')?.resolve()

    await expect(running).resolves.toMatchObject({ text: 'done' })
    expect(resultOrder).toEqual(['safe_b', 'safe_a', 'unsafe_c', 'safe_d'])
  })

  it('executes missing and throwing classifiers exclusively', async () => {
    for (const classifier of ['missing', 'throwing'] as const) {
      const firstStarted = deferred()
      const secondStarted = deferred()
      const releaseFirst = deferred()
      let secondHasStarted = false
      let turn = 0
      const provider = providerFrom(async function* () {
        if (turn++ > 0) {
          yield { type: 'text-delta', delta: 'done' }
          return
        }
        yield {
          type: 'tool-call',
          call: { id: 'first', name: 'Unknown', input: {} },
        }
        await firstStarted.promise
        yield {
          type: 'tool-call',
          call: { id: 'second', name: 'Unknown', input: {} },
        }
      })
      const baseTools: ToolRegistry = {
        definitions: () => [],
        prepare: async (call) => call,
        execute: async (call) => {
          if (call.id === 'first') {
            firstStarted.resolve()
            await releaseFirst.promise
          } else {
            secondHasStarted = true
            secondStarted.resolve()
          }
          return { content: call.id, isError: false }
        },
      }
      const runtime = new AgentRuntime(provider, undefined, {
        tools:
          classifier === 'throwing'
            ? {
                ...baseTools,
                schedulingPolicy: () => {
                  throw new Error('classifier failed')
                },
              }
            : baseTools,
        permissions: { resolve: () => ({ behavior: 'allow' }) },
      })
      const running = runtime.run({
        messages: [{ role: 'user', content: classifier }],
      })
      await firstStarted.promise
      expect(secondHasStarted).toBe(false)
      releaseFirst.resolve()
      await secondStarted.promise
      await expect(running).resolves.toMatchObject({ text: 'done' })
    }
  })

  it('keeps safe siblings running after an independent read failure', async () => {
    const releases = new Map([
      ['read_a', deferred<ToolExecutionResult>()],
      ['read_b', deferred<ToolExecutionResult>()],
    ])
    const startedSignals = new Map([
      ['read_a', deferred()],
      ['read_b', deferred()],
    ])
    const readAResult = deferred()
    const started = new Set<string>()
    let turn = 0
    const provider = providerFrom(async function* () {
      if (turn++ > 0) {
        yield { type: 'text-delta', delta: 'done' }
        return
      }
      yield {
        type: 'tool-call',
        call: { id: 'read_a', name: 'Read', input: {} },
      }
      yield {
        type: 'tool-call',
        call: { id: 'read_b', name: 'Read', input: {} },
      }
    })
    const results: string[] = []
    const runtime = new AgentRuntime(
      provider,
      (event) => {
        if (event.type === 'tool-result') {
          results.push(event.callId)
          if (event.callId === 'read_a') readAResult.resolve()
        }
      },
      {
        tools: {
          definitions: () => [],
          schedulingPolicy: () => ({ concurrency: 'concurrent' }),
          prepare: async (call) => call,
          execute: async (call) => {
            started.add(call.id)
            startedSignals.get(call.id)?.resolve()
            const release = releases.get(call.id)
            if (!release) throw new Error(`missing release for ${call.id}`)
            return release.promise
          },
        },
        permissions: { resolve: () => ({ behavior: 'allow' }) },
      },
    )
    const running = runtime.run({
      messages: [{ role: 'user', content: 'read' }],
    })
    await Promise.all(
      [...startedSignals.values()].map((signal) => signal.promise),
    )
    releases.get('read_a')?.resolve({ content: 'failed', isError: true })
    await readAResult.promise
    expect(results).toEqual(['read_a'])
    expect(started.has('read_b')).toBe(true)
    releases.get('read_b')?.resolve({ content: 'ok', isError: false })
    await expect(running).resolves.toMatchObject({ text: 'done' })
    expect(results).toEqual(['read_a', 'read_b'])
  })

  it('aborts streamed siblings after a Bash error and emits one result per call', async () => {
    const bashRelease = deferred()
    const startedSignals = new Map(
      ['read_a', 'bash_b', 'read_c'].map((id) => [id, deferred()]),
    )
    let turn = 0
    const provider = providerFrom(async function* () {
      if (turn++ > 0) {
        yield { type: 'text-delta', delta: 'done' }
        return
      }
      for (const [id, name] of [
        ['read_a', 'Read'],
        ['bash_b', 'Bash'],
        ['read_c', 'Read'],
      ] as const) {
        yield { type: 'tool-call', call: { id, name, input: {} } }
      }
    })
    const results: RuntimeEvent[] = []
    const runtime = new AgentRuntime(
      provider,
      (event) => {
        if (event.type === 'tool-result') results.push(event)
      },
      {
        tools: {
          definitions: () => [],
          schedulingPolicy: (call) => ({
            concurrency: 'concurrent',
            cancelOnInterrupt: true,
            ...(call.name === 'Bash' ? { abortGroupOnError: true } : {}),
          }),
          prepare: async (call) => call,
          execute: async (call, context) => {
            startedSignals.get(call.id)?.resolve()
            if (call.name === 'Bash') {
              await bashRelease.promise
              return { content: 'bash failed', isError: true }
            }
            if (!context.signal) throw new Error('missing execution signal')
            const signal = context.signal
            return new Promise<ToolExecutionResult>((_resolve, reject) =>
              signal.addEventListener('abort', () => reject(signal.reason), {
                once: true,
              }),
            )
          },
        },
        permissions: { resolve: () => ({ behavior: 'allow' }) },
      },
    )
    const running = runtime.run({
      messages: [{ role: 'user', content: 'group' }],
    })
    await Promise.all(
      [...startedSignals.values()].map((signal) => signal.promise),
    )
    bashRelease.resolve()
    await expect(running).resolves.toMatchObject({ text: 'done' })
    expect(results).toHaveLength(3)
    expect(
      results
        .map((event) => event.type === 'tool-result' && event.callId)
        .sort(),
    ).toEqual(['bash_b', 'read_a', 'read_c'])
    expect(
      results.every((event) => event.type === 'tool-result' && event.isError),
    ).toBe(true)
  })

  it('emits progress early but persists the assistant before its completed tool result', async () => {
    const started = deferred()
    const peerStarted = deferred()
    const release = deferred()
    const releasePeer = deferred()
    const finishProvider = deferred()
    const events: RuntimeEvent[] = []
    const toolResult = deferred()
    const persisted: string[] = []
    let turn = 0
    const provider = providerFrom(async function* () {
      if (turn++ > 0) {
        yield { type: 'text-delta', delta: 'done' }
        return
      }
      yield { type: 'tool-call', call: { id: 'read', name: 'Read', input: {} } }
      yield {
        type: 'tool-call',
        call: { id: 'peer', name: 'Read', input: {} },
      }
      await finishProvider.promise
    })
    const runtime = new AgentRuntime(
      provider,
      (event) => {
        events.push(event)
        if (event.type === 'tool-result') toolResult.resolve()
      },
      {
        tools: {
          definitions: () => [],
          schedulingPolicy: () => ({ concurrency: 'concurrent' }),
          prepare: async (call) => call,
          execute: async (call) => {
            if (call.id === 'read') {
              started.resolve()
              await release.promise
            } else {
              peerStarted.resolve()
              await releasePeer.promise
            }
            return { content: call.id, isError: false }
          },
        },
        permissions: { resolve: () => ({ behavior: 'allow' }) },
      },
    )
    const running = runtime.run({
      messages: [{ role: 'user', content: 'read' }],
      observer: {
        assistantCompleted: async () => {
          persisted.push('assistant')
        },
        toolCompleted: async () => {
          persisted.push('tool')
        },
      },
    })
    await started.promise
    await peerStarted.promise
    expect(events.some((event) => event.type === 'tool-progress')).toBe(true)
    release.resolve()
    await toolResult.promise
    expect(
      events
        .filter((event) => event.type === 'tool-result')
        .map((event) => event.callId),
    ).toEqual(['read'])
    expect(persisted).toEqual([])
    releasePeer.resolve()
    finishProvider.resolve()
    await expect(running).resolves.toMatchObject({ text: 'done' })
    expect(persisted).toEqual(['assistant', 'tool', 'tool', 'assistant'])
  })

  it('cancels only opted-in tools on request interruption and waits for unknown tools', async () => {
    const safeStarted = deferred()
    const unknownStarted = deferred()
    const releaseUnknown = deferred()
    const finishProvider = deferred()
    const controller = new AbortController()
    const safeResult = deferred()
    const resultIds: string[] = []
    const provider = providerFrom(async function* () {
      yield { type: 'tool-call', call: { id: 'safe', name: 'Read', input: {} } }
      yield {
        type: 'tool-call',
        call: { id: 'unknown', name: 'Unknown', input: {} },
      }
      await finishProvider.promise
    })
    const runtime = new AgentRuntime(
      provider,
      (event) => {
        if (event.type === 'tool-result') {
          resultIds.push(event.callId)
          if (event.callId === 'safe') safeResult.resolve()
        }
      },
      {
        tools: {
          definitions: () => [],
          schedulingPolicy: (call) =>
            call.name === 'Read'
              ? { concurrency: 'concurrent', cancelOnInterrupt: true }
              : { concurrency: 'exclusive' },
          prepare: async (call) => call,
          execute: async (call, context) => {
            if (call.name === 'Read') {
              safeStarted.resolve()
              if (!context.signal) throw new Error('missing signal')
              const signal = context.signal
              return new Promise<ToolExecutionResult>((_resolve, reject) =>
                signal.addEventListener('abort', () => reject(signal.reason), {
                  once: true,
                }),
              )
            }
            unknownStarted.resolve()
            expect(context.signal?.aborted).toBe(false)
            await releaseUnknown.promise
            return { content: 'unknown complete', isError: false }
          },
        },
        permissions: { resolve: () => ({ behavior: 'allow' }) },
      },
    )
    const running = runtime.run({
      messages: [{ role: 'user', content: 'interrupt' }],
      signal: controller.signal,
    })
    await safeStarted.promise
    controller.abort()
    await safeResult.promise
    expect(resultIds).toEqual(['safe'])
    finishProvider.resolve()
    await unknownStarted.promise
    expect(resultIds).toEqual(['safe'])
    releaseUnknown.resolve()
    await expect(running).rejects.toBeInstanceOf(AgentRunCancelledError)
    expect(resultIds).toEqual(['safe', 'unknown'])
  })

  it('drains unknown tools when an abort-aware provider exits its stream', async () => {
    const safeStarted = deferred()
    const unknownStarted = deferred()
    const releaseUnknown = deferred()
    const controller = new AbortController()
    const resultIds: string[] = []
    const provider = providerFrom(async function* (request) {
      yield { type: 'tool-call', call: { id: 'safe', name: 'Read', input: {} } }
      yield {
        type: 'tool-call',
        call: { id: 'unknown', name: 'Unknown', input: {} },
      }
      await new Promise<void>((resolve) =>
        request.signal?.addEventListener('abort', () => resolve(), {
          once: true,
        }),
      )
      throw new DOMException('aborted provider', 'AbortError')
    })
    const runtime = new AgentRuntime(
      provider,
      (event) => {
        if (event.type === 'tool-result') resultIds.push(event.callId)
      },
      {
        tools: {
          definitions: () => [],
          schedulingPolicy: (call) =>
            call.name === 'Read'
              ? { concurrency: 'concurrent', cancelOnInterrupt: true }
              : { concurrency: 'exclusive' },
          prepare: async (call) => call,
          execute: async (call, context) => {
            if (call.name === 'Read') {
              safeStarted.resolve()
              if (!context.signal) throw new Error('missing signal')
              const signal = context.signal
              return new Promise<ToolExecutionResult>((_resolve, reject) =>
                signal.addEventListener('abort', () => reject(signal.reason), {
                  once: true,
                }),
              )
            }
            unknownStarted.resolve()
            expect(context.signal?.aborted).toBe(false)
            await releaseUnknown.promise
            return { content: 'unknown complete', isError: false }
          },
        },
        permissions: { resolve: () => ({ behavior: 'allow' }) },
      },
    )
    const running = runtime.run({
      messages: [{ role: 'user', content: 'interrupt provider' }],
      signal: controller.signal,
    })
    await safeStarted.promise
    controller.abort()
    await unknownStarted.promise
    expect(resultIds).toEqual(['safe'])
    releaseUnknown.resolve()
    await expect(running).rejects.toBeInstanceOf(AgentRunCancelledError)
    expect(resultIds).toEqual(['safe', 'unknown'])
  })

  it('executes permission-approved updated input and preserves the tool call id', async () => {
    let turn = 0
    const provider = providerFrom(async function* () {
      if (turn++ === 0) {
        yield {
          type: 'tool-call',
          call: {
            id: 'call_permission',
            name: 'Bash',
            input: { command: 'original' },
          },
        }
        return
      }
      yield { type: 'text-delta', delta: 'done' }
    })
    const executed: ModelToolCall[] = []
    const runtime = new AgentRuntime(provider, undefined, {
      tools: {
        definitions: () => [],
        prepare: async (call) => call,
        execute: async (call) => {
          executed.push(call)
          return { content: 'updated', isError: false }
        },
      },
      permissions: { resolve: () => ({ behavior: 'ask' }) },
    })
    const prompts: unknown[] = []

    await runtime.run({
      messages: [{ role: 'user', content: 'run' }],
      approveTool: async (call, originalCall, decision) => {
        prompts.push({ call, originalCall, decision })
        return {
          behavior: 'allow',
          updatedInput: { command: 'updated' },
        }
      },
    })

    expect(prompts).toEqual([
      {
        call: {
          id: 'call_permission',
          name: 'Bash',
          input: { command: 'original' },
        },
        originalCall: {
          id: 'call_permission',
          name: 'Bash',
          input: { command: 'original' },
        },
        decision: { behavior: 'ask' },
      },
    ])
    expect(executed).toEqual([
      {
        id: 'call_permission',
        name: 'Bash',
        input: { command: 'updated' },
      },
    ])
  })

  it('adds permission approval feedback after the completed tool result', async () => {
    let turn = 0
    const requests: ModelRequest[] = []
    const provider = providerFrom(async function* (request) {
      requests.push(request)
      if (turn++ === 0) {
        yield {
          type: 'tool-call',
          call: { id: 'call_feedback', name: 'Bash', input: {} },
        }
        return
      }
      yield { type: 'text-delta', delta: 'done' }
    })
    const runtime = new AgentRuntime(provider, undefined, {
      tools: {
        definitions: () => [],
        prepare: async (call) => call,
        execute: async () => ({
          content: 'command output',
          isError: false,
          followUpUserMessages: ['tool follow-up'],
        }),
      },
      permissions: { resolve: () => ({ behavior: 'ask' }) },
    })

    await runtime.run({
      messages: [{ role: 'user', content: 'run' }],
      approveTool: () => ({
        behavior: 'allow',
        feedback: 'use the focused test next',
      }),
    })

    expect(requests[1]?.messages.slice(-3)).toEqual([
      {
        role: 'tool',
        toolCallId: 'call_feedback',
        content: 'command output',
        isError: false,
      },
      { role: 'user', content: 'tool follow-up' },
      { role: 'user', content: 'use the focused test next' },
    ])
  })

  it('uses permission prompt denial messages as failed tool results', async () => {
    let turn = 0
    const requests: ModelRequest[] = []
    const provider = providerFrom(async function* (request) {
      requests.push(request)
      if (turn++ === 0) {
        yield {
          type: 'tool-call',
          call: { id: 'call_denied', name: 'Bash', input: {} },
        }
        return
      }
      yield { type: 'text-delta', delta: 'denied' }
    })
    const runtime = new AgentRuntime(provider, undefined, {
      tools: {
        definitions: () => [],
        prepare: async (call) => call,
        execute: async () => ({ content: 'unexpected', isError: false }),
      },
      permissions: { resolve: () => ({ behavior: 'ask' }) },
    })

    await runtime.run({
      messages: [{ role: 'user', content: 'run' }],
      approveTool: () => ({ behavior: 'deny', message: 'DENIED_BY_MCP' }),
    })

    expect(requests[1]?.messages.at(-1)).toEqual({
      role: 'tool',
      toolCallId: 'call_denied',
      content: 'DENIED_BY_MCP',
      isError: true,
    })
  })

  it('aborts the run when a permission prompt denial requests interruption', async () => {
    let modelTurns = 0
    const results: RuntimeEvent[] = []
    const persisted: string[] = []
    const provider = providerFrom(async function* () {
      modelTurns += 1
      yield {
        type: 'tool-call',
        call: { id: 'call_interrupted', name: 'Bash', input: {} },
      }
    })
    const runtime = new AgentRuntime(
      provider,
      (event) => {
        if (event.type === 'tool-result') results.push(event)
      },
      {
        tools: {
          definitions: () => [],
          prepare: async (call) => call,
          execute: async () => ({ content: 'unexpected', isError: false }),
        },
        permissions: { resolve: () => ({ behavior: 'ask' }) },
      },
    )

    await expect(
      runtime.run({
        messages: [{ role: 'user', content: 'run' }],
        approveTool: () => ({
          behavior: 'deny',
          message: 'DENIED_BY_MCP',
          interrupt: true,
        }),
        observer: {
          assistantCompleted: async () => undefined,
          toolCompleted: async (call) => {
            persisted.push(call.id)
          },
        },
      }),
    ).rejects.toThrow('DENIED_BY_MCP')
    expect(modelTurns).toBe(1)
    expect(results).toEqual([
      expect.objectContaining({
        type: 'tool-result',
        callId: 'call_interrupted',
        isError: true,
      }),
    ])
    expect(persisted).toEqual(['call_interrupted'])
  })

  it('emits a provider-backed tool-use summary for completed tool batches', async () => {
    let turn = 0
    const provider = providerFrom(async function* () {
      if (turn++ === 0) {
        yield {
          type: 'tool-call',
          call: { id: 'call_summary', name: 'Read', input: { file_path: 'a' } },
        }
        return
      }
      yield { type: 'text-delta', delta: 'done' }
    })
    const summaries: unknown[] = []
    const runtime = new AgentRuntime(
      provider,
      (event) => summaries.push(event),
      {
        tools: {
          definitions: () => [],
          async prepare(call) {
            return call
          },
          async execute() {
            return { content: 'file contents', isError: false }
          },
        },
        permissions: { resolve: () => ({ behavior: 'allow' }) },
        generateToolUseSummary: async ({ tools, lastAssistantText }) => {
          expect(tools).toEqual([
            {
              name: 'Read',
              input: { file_path: 'a' },
              output: 'file contents',
            },
          ])
          expect(lastAssistantText).toBeUndefined()
          return {
            summary: 'Read a',
            usage: { inputTokens: 0, outputTokens: 0 },
            durationApiMs: 0,
            durationApiWithoutRetriesMs: 0,
            meteredExternally: false,
          }
        },
      },
    )

    await runtime.run({ messages: [{ role: 'user', content: 'inspect' }] })
    expect(summaries).toContainEqual({
      type: 'tool-use-summary',
      summary: 'Read a',
      precedingToolUseIds: ['call_summary'],
    })
  })

  it('splits inclusive totals from the session-unrecorded subset for externally metered summaries', async () => {
    let turn = 0
    const provider: ModelProvider = {
      model: 'claude-x',
      capabilities: { streaming: true, usage: true, tools: true },
      async *complete() {
        turn += 1
        yield { type: 'api-attempt-duration', durationMs: turn === 1 ? 10 : 5 }
        if (turn === 1) {
          yield {
            type: 'tool-call',
            call: { id: 'call_a', name: 'Read', input: {} },
          }
          yield {
            type: 'usage',
            usage: { inputTokens: 10, outputTokens: 5 },
          }
          return
        }
        yield { type: 'text-delta', delta: 'done' }
        yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
      },
    }
    const runtime = new AgentRuntime(provider, undefined, {
      tools: {
        definitions: () => [],
        prepare: async (call) => call,
        execute: async () => ({ content: 'contents', isError: false }),
      },
      permissions: { resolve: () => ({ behavior: 'allow' }) },
      generateToolUseSummary: async () => ({
        summary: 'Read a',
        usage: { inputTokens: 4, outputTokens: 2 },
        modelUsage: { 'claude-x': { inputTokens: 4, outputTokens: 2 } },
        durationApiMs: 30,
        durationApiWithoutRetriesMs: 20,
        meteredExternally: true,
      }),
    })

    const result = await runtime.run({
      messages: [{ role: 'user', content: 'inspect' }],
      collectMetrics: true,
    })
    expect(result.text).toBe('done')
    // Public totals remain inclusive of the externally metered summary.
    expect(result.usage).toEqual({ inputTokens: 15, outputTokens: 8 })
    expect(result.modelUsage?.['claude-x']).toEqual({
      inputTokens: 15,
      outputTokens: 8,
    })
    expect(result.durationApiWithoutRetriesMs).toBe(10 + 20 + 5)
    // The inclusive total carries the mock summary's own wall duration.
    expect(result.durationApiMs).toBeGreaterThanOrEqual(30)
    // The unrecorded subset excludes the externally committed summary metrics.
    expect(result.unrecordedModelUsage?.['claude-x']).toEqual({
      inputTokens: 11,
      outputTokens: 6,
    })
    expect(result.unrecordedDurationApiWithoutRetriesMs).toBe(10 + 5)
    expect(result.unrecordedDurationApiMs).toBeDefined()
  })

  it('keeps non-externally-metered summary metrics in the unrecorded session totals', async () => {
    let turn = 0
    const provider: ModelProvider = {
      model: 'claude-x',
      capabilities: { streaming: true, usage: true, tools: true },
      async *complete() {
        turn += 1
        yield { type: 'api-attempt-duration', durationMs: turn === 1 ? 10 : 5 }
        if (turn === 1) {
          yield {
            type: 'tool-call',
            call: { id: 'call_a', name: 'Read', input: {} },
          }
          yield {
            type: 'usage',
            usage: { inputTokens: 10, outputTokens: 5 },
          }
          return
        }
        yield { type: 'text-delta', delta: 'done' }
        yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
      },
    }
    const runtime = new AgentRuntime(provider, undefined, {
      tools: {
        definitions: () => [],
        prepare: async (call) => call,
        execute: async () => ({ content: 'contents', isError: false }),
      },
      permissions: { resolve: () => ({ behavior: 'allow' }) },
      generateToolUseSummary: async () => ({
        summary: 'Read a',
        usage: { inputTokens: 4, outputTokens: 2 },
        modelUsage: { 'claude-x': { inputTokens: 4, outputTokens: 2 } },
        durationApiMs: 30,
        durationApiWithoutRetriesMs: 20,
        meteredExternally: false,
      }),
    })

    const result = await runtime.run({
      messages: [{ role: 'user', content: 'inspect' }],
      collectMetrics: true,
    })
    expect(result.usage).toEqual({ inputTokens: 15, outputTokens: 8 })
    expect(result.modelUsage?.['claude-x']).toEqual({
      inputTokens: 15,
      outputTokens: 8,
    })
    expect(result.durationApiWithoutRetriesMs).toBe(10 + 20 + 5)
    // No externally metered summary was observed, so no unrecorded subset is
    // emitted and the inclusive fields stay authoritative for the session.
    expect(result.unrecordedModelUsage).toBeUndefined()
    expect(result.unrecordedDurationApiMs).toBeUndefined()
    expect(result.unrecordedDurationApiWithoutRetriesMs).toBeUndefined()
  })

  it('preserves a retry-free summary duration when its measured total is zero', async () => {
    let turn = 0
    const provider = providerFrom(async function* () {
      if (turn++ === 0) {
        yield {
          type: 'tool-call',
          call: { id: 'call_a', name: 'Read', input: {} },
        }
        return
      }
      yield { type: 'text-delta', delta: 'done' }
    })
    const runtime = new AgentRuntime(provider, undefined, {
      tools: {
        definitions: () => [],
        prepare: async (call) => call,
        execute: async () => ({ content: 'contents', isError: false }),
      },
      permissions: { resolve: () => ({ behavior: 'allow' }) },
      generateToolUseSummary: async () => ({
        summary: null,
        usage: { inputTokens: 0, outputTokens: 0 },
        durationApiMs: 0,
        durationApiWithoutRetriesMs: 7,
        meteredExternally: false,
      }),
    })

    const result = await runtime.run({
      messages: [{ role: 'user', content: 'inspect' }],
    })
    expect(result.durationApiMs).toBeUndefined()
    expect(result.durationApiWithoutRetriesMs).toBe(7)
  })

  it('adds stop-batch API durations and preserves an explicit zero retry-free value', async () => {
    const runtime = new AgentRuntime(
      providerFrom(async function* () {
        yield { type: 'api-attempt-duration', durationMs: 5 }
        yield { type: 'text-delta', delta: 'done' }
      }),
    )

    const result = await runtime.run({
      messages: [{ role: 'user', content: 'duration' }],
      collectMetrics: true,
      onStop: async () => ({
        messages: [],
        durationApiMs: 12,
        durationApiWithoutRetriesMs: 0,
      }),
    })

    expect(result.durationApiMs).toBeGreaterThanOrEqual(12)
    expect(result.durationApiWithoutRetriesMs).toBe(5)
  })

  it('counts summary usage toward the cost budget even when the summary is null', async () => {
    let turn = 0
    let calls = 0
    const provider = providerFrom(async function* () {
      calls += 1
      if (turn++ === 0) {
        yield {
          type: 'tool-call',
          call: { id: 'call_a', name: 'Read', input: {} },
        }
        return
      }
      yield { type: 'text-delta', delta: 'done' }
    })
    const runtime = new AgentRuntime(provider, undefined, {
      tools: {
        definitions: () => [],
        prepare: async (call) => call,
        execute: async () => ({ content: '', isError: false }),
      },
      permissions: { resolve: () => ({ behavior: 'allow' }) },
      costUsd: (usage) => usage.inputTokens / 1_000_000,
      maxBudgetUsd: 0.000002,
      generateToolUseSummary: async () => ({
        summary: null,
        usage: { inputTokens: 3, outputTokens: 0 },
        durationApiMs: 5,
        durationApiWithoutRetriesMs: 5,
        meteredExternally: false,
      }),
    })

    await expect(
      runtime.run({
        messages: [{ role: 'user', content: 'budget' }],
        onStop: async () => ['continue'],
      }),
    ).rejects.toThrow('Maximum budget')
    expect(calls).toBe(1)
  })

  it('propagates summary accounting failures so cost accounting fails closed', async () => {
    let turn = 0
    const provider = providerFrom(async function* () {
      if (turn++ === 0) {
        yield {
          type: 'tool-call',
          call: { id: 'call_a', name: 'Read', input: {} },
        }
        return
      }
      yield { type: 'text-delta', delta: 'done' }
    })
    const runtime = new AgentRuntime(provider, undefined, {
      tools: {
        definitions: () => [],
        prepare: async (call) => call,
        execute: async () => ({ content: '', isError: false }),
      },
      permissions: { resolve: () => ({ behavior: 'allow' }) },
      generateToolUseSummary: async () => {
        throw new Error('tracker unavailable')
      },
    })

    await expect(
      runtime.run({ messages: [{ role: 'user', content: 'inspect' }] }),
    ).rejects.toThrow('tracker unavailable')
  })

  it('passes completed tool history to later tools and recovery', async () => {
    let turn = 0
    const provider = providerFrom(async function* () {
      if (turn === 0) {
        turn += 1
        yield {
          type: 'tool-call',
          call: { id: 'read', name: 'Read', input: { file_path: 'a.ipynb' } },
        }
        return
      }
      if (turn === 1) {
        turn += 1
        yield {
          type: 'tool-call',
          call: {
            id: 'edit',
            name: 'NotebookEdit',
            input: { notebook_path: '/workspace/a.ipynb', new_source: 'new' },
          },
        }
        return
      }
      yield { type: 'text-delta', delta: 'done' }
    })
    const histories: string[][] = []
    const tools: ToolRegistry = {
      definitions: () => [],
      async prepare(call, context) {
        histories.push((context.messages ?? []).map((message) => message.role))
        return call
      },
      async execute(call) {
        return { content: `${call.name} complete`, isError: false }
      },
    }
    const runtime = new AgentRuntime(provider, undefined, {
      tools,
      permissions: { resolve: () => ({ behavior: 'allow' }) },
    })
    const observer = {
      async assistantCompleted() {},
      async toolCompleted() {},
    }

    await runtime.run({
      cwd: '/workspace',
      messages: [{ role: 'user', content: 'edit notebook' }],
      observer,
    })
    await runtime.recoverToolCalls(
      [{ id: 'recover', name: 'NotebookEdit', input: {} }],
      {
        cwd: '/workspace',
        messages: [{ role: 'user', content: 'persisted history' }],
        observer,
      },
    )

    expect(histories).toEqual([
      ['user', 'assistant'],
      ['user', 'assistant', 'tool', 'assistant'],
      ['user'],
    ])
  })

  it('passes the explicit session identity through tool preparation and execution', async () => {
    let turn = 0
    const provider = providerFrom(async function* () {
      if (turn++ === 0) {
        yield {
          type: 'tool-call',
          call: { id: 'session-tool', name: 'Bash', input: {} },
        }
        return
      }
      yield { type: 'text-delta', delta: 'done' }
    })
    const sessions: Array<string | undefined> = []
    const runtime = new AgentRuntime(provider, undefined, {
      tools: {
        definitions: () => [],
        async prepare(call, context) {
          sessions.push(context.sessionId)
          return call
        },
        async execute(_call, context) {
          sessions.push(context.sessionId)
          return { content: 'done', isError: false }
        },
      },
      permissions: { resolve: () => ({ behavior: 'allow' }) },
    })

    await runtime.run({
      sessionId: 'session-a',
      messages: [{ role: 'user', content: 'run tool' }],
    })

    expect(sessions).toEqual(['session-a', 'session-a'])
  })

  it('forwards image tool results only to image-capable providers', async () => {
    const requests: ModelRequest[] = []
    let turn = 0
    const provider: ModelProvider = {
      capabilities: {
        streaming: true,
        usage: true,
        tools: true,
        images: true,
      },
      async *complete(request) {
        requests.push(request)
        if (turn++ === 0) {
          yield {
            type: 'tool-call',
            call: { id: 'call_image', name: 'Read', input: {} },
          }
          return
        }
        yield { type: 'text-delta', delta: 'seen' }
      },
    }
    const tools: ToolRegistry = {
      definitions: () => [],
      async prepare(call) {
        return call
      },
      async execute() {
        return { content: '', images: [image], isError: false }
      },
    }
    const runtime = new AgentRuntime(provider, undefined, {
      tools,
      permissions: { resolve: () => ({ behavior: 'allow' }) },
    })

    await runtime.run({ messages: [{ role: 'user', content: 'inspect' }] })

    expect(requests[1]?.messages.at(-1)).toEqual({
      role: 'tool',
      toolCallId: 'call_image',
      content: '',
      images: [image],
      isError: false,
    })

    const unsupportedResults: unknown[] = []
    let unsupportedTurn = 0
    const unsupported = new AgentRuntime(
      providerFrom(async function* () {
        if (unsupportedTurn++ === 0) {
          yield {
            type: 'tool-call',
            call: { id: 'call_image', name: 'Read', input: {} },
          }
          return
        }
        yield { type: 'text-delta', delta: 'fallback' }
      }),
      undefined,
      {
        tools,
        permissions: { resolve: () => ({ behavior: 'allow' }) },
      },
    )
    await unsupported.run({
      messages: [{ role: 'user', content: 'inspect' }],
      observer: {
        async assistantCompleted() {},
        async toolCompleted(_call, result) {
          unsupportedResults.push(result)
        },
      },
    })
    expect(unsupportedResults).toMatchObject([
      {
        content: 'Provider does not support image tool results',
        isError: true,
      },
    ])
  })

  it('rejects user image input before calling an image-incapable provider', async () => {
    let called = false
    const runtime = new AgentRuntime({
      capabilities: {
        streaming: true,
        usage: true,
        tools: false,
        images: false,
      },
      async *complete() {
        called = true
        yield { type: 'text-delta' as const, delta: 'unexpected' }
      },
    })
    await expect(
      runtime.run({
        messages: [
          {
            role: 'user',
            content: 'inspect',
            images: [
              { type: 'image', mediaType: 'image/png', data: 'aGVsbG8=' },
            ],
          },
        ],
      }),
    ).rejects.toThrow('does not support user image inputs')
    expect(called).toBe(false)
  })

  it('fails closed for unsupported document tool results and user documents', async () => {
    const document = {
      type: 'document' as const,
      mediaType: 'application/pdf' as const,
      data: 'JVBERg==',
    }
    let turn = 0
    const requests: ModelRequest[] = []
    const provider: ModelProvider = {
      capabilities: { streaming: true, usage: true, tools: true },
      async *complete(request) {
        requests.push(request)
        if (turn++ === 0) {
          yield {
            type: 'tool-call',
            call: { id: 'call_pdf', name: 'Read', input: {} },
          }
          return
        }
        yield { type: 'text-delta', delta: 'fallback' }
      },
    }
    const runtime = new AgentRuntime(provider, undefined, {
      tools: {
        definitions: () => [],
        async prepare(call) {
          return call
        },
        async execute() {
          return { content: 'attached', documents: [document], isError: false }
        },
      },
      permissions: { resolve: () => ({ behavior: 'allow' }) },
    })
    await runtime.run({ messages: [{ role: 'user', content: 'inspect' }] })
    expect(requests[1]?.messages.at(-1)).toEqual({
      role: 'tool',
      toolCallId: 'call_pdf',
      content: 'Provider does not support document tool results',
      isError: true,
    })

    let called = false
    const userRuntime = new AgentRuntime({
      capabilities: { streaming: true, usage: true, tools: false },
      async *complete() {
        called = true
        yield { type: 'text-delta' as const, delta: 'unexpected' }
      },
    })
    await expect(
      userRuntime.run({
        messages: [{ role: 'user', content: 'inspect', documents: [document] }],
      }),
    ).rejects.toThrow('does not support user document inputs')
    expect(called).toBe(false)
  })

  it('replaces image results restored before each unsupported provider request', async () => {
    const requests: ModelRequest[] = []
    let turn = 0
    const provider = providerFrom(async function* (request) {
      requests.push(request)
      if (turn++ === 0) {
        yield {
          type: 'tool-call',
          call: { id: 'call_reload', name: 'Read', input: {} },
        }
        return
      }
      yield { type: 'text-delta', delta: 'fallback' }
    })
    const runtime = new AgentRuntime(provider, undefined, {
      tools: {
        definitions: () => [],
        async prepare(call) {
          return call
        },
        async execute() {
          return { content: 'temporary', isError: false }
        },
      },
      permissions: { resolve: () => ({ behavior: 'allow' }) },
    })

    await runtime.run({
      messages: [
        { role: 'user', content: 'inspect prior result' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call_prior', name: 'Read', input: {} }],
        },
        {
          role: 'tool',
          toolCallId: 'call_prior',
          content: '',
          images: [image],
          isError: false,
        },
      ],
      reloadMessages: async () => [
        { role: 'user', content: 'inspect reloaded result' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call_reload', name: 'Read', input: {} }],
        },
        {
          role: 'tool',
          toolCallId: 'call_reload',
          content: '',
          images: [image],
          isError: false,
        },
      ],
    })

    const fallback = {
      role: 'tool',
      toolCallId: 'call_prior',
      content: 'Provider does not support image tool results',
      isError: true,
    }
    expect(requests[0]?.messages.at(-1)).toEqual(fallback)
    expect(requests[1]?.messages.at(-1)).toEqual({
      ...fallback,
      toolCallId: 'call_reload',
    })
  })

  it('returns denied tools as error results without executing them', async () => {
    let turn = 0
    let executed = false
    const requests: ModelRequest[] = []
    const provider = providerFrom(async function* (request) {
      requests.push(request)
      if (turn++ === 0) {
        yield {
          type: 'tool-call',
          call: {
            id: 'call_shell',
            name: 'Bash',
            input: { command: 'rm generated.txt' },
          },
        }
        return
      }
      yield { type: 'text-delta', delta: 'I could not remove it.' }
    })
    const tools: ToolRegistry = {
      definitions: () => [],
      async prepare(call) {
        return call
      },
      async execute() {
        executed = true
        return { content: 'unexpected', isError: false }
      },
    }
    const results: { content: string; isError: boolean }[] = []
    const runtime = new AgentRuntime(provider, undefined, {
      tools,
      permissions: {
        resolve: () => ({
          behavior: 'deny',
          reason: 'Denied by local policy',
          followUpUserMessages: ['Permission hook says retry is available'],
        }),
      },
    })

    const result = await runtime.run({
      messages: [{ role: 'user', content: 'remove it' }],
      observer: {
        async assistantCompleted() {},
        async toolCompleted(_call, toolResult) {
          results.push(toolResult)
        },
      },
    })

    expect(result.text).toBe('I could not remove it.')
    expect(executed).toBe(false)
    expect(results).toEqual([
      {
        content: 'Denied by local policy',
        isError: true,
        followUpUserMessages: ['Permission hook says retry is available'],
      },
    ])
    expect(requests[1]?.messages.at(-1)).toEqual({
      role: 'user',
      content: 'Permission hook says retry is available',
    })
  })

  it('fails closed when model output or tool calls exceed run bounds', async () => {
    const textProvider = providerFrom(async function* () {
      yield { type: 'text-delta', delta: '1234' }
      yield { type: 'text-delta', delta: '56' }
    })
    const textRuntime = new AgentRuntime(textProvider, undefined, {
      maxModelOutputBytes: 5,
    })
    await expect(
      textRuntime.run({ messages: [{ role: 'user', content: 'respond' }] }),
    ).rejects.toThrow('Model output exceeded 5 bytes')

    const toolProvider = providerFrom(async function* () {
      yield {
        type: 'tool-call',
        call: { id: 'one', name: 'Read', input: { file_path: 'one' } },
      }
      yield {
        type: 'tool-call',
        call: { id: 'two', name: 'Read', input: { file_path: 'two' } },
      }
    })
    const toolRuntime = new AgentRuntime(toolProvider, undefined, {
      maxToolCallsPerTurn: 1,
    })
    await expect(
      toolRuntime.run({ messages: [{ role: 'user', content: 'inspect' }] }),
    ).rejects.toThrow('Model exceeded 1 tool calls in one turn')
    await expect(
      toolRuntime.recoverToolCalls(
        [
          { id: 'one', name: 'Read', input: { file_path: 'one' } },
          { id: 'two', name: 'Read', input: { file_path: 'two' } },
        ],
        {},
      ),
    ).rejects.toThrow('Recovery exceeded 1 tool calls in one turn')
  })

  it('finalizes follow-up user context from recovered tool calls', async () => {
    const followUps: string[][] = []
    const runtime = new AgentRuntime(
      providerFrom(async function* () {
        yield* []
      }),
      undefined,
      {
        tools: {
          definitions: () => [],
          async prepare(call) {
            return call
          },
          async execute() {
            return {
              content: 'Launching skill: probe',
              isError: false,
              followUpUserMessages: ['SKILL_CONTEXT'],
            }
          },
        },
        permissions: { resolve: () => ({ behavior: 'allow' }) },
      },
    )

    await runtime.recoverToolCalls(
      [{ id: 'call_skill', name: 'Skill', input: { skill: 'probe' } }],
      {
        observer: {
          async assistantCompleted() {},
          async toolCompleted() {},
          async followUpUserMessagesCompleted(messages) {
            followUps.push([...messages])
          },
        },
      },
    )

    expect(followUps).toEqual([['SKILL_CONTEXT']])
  })

  it('executes a direct tool through permission checks without tool presentation events', async () => {
    const events: RuntimeEvent[] = []
    const completed: string[] = []
    const runtime = new AgentRuntime(
      providerFrom(async function* () {
        yield* []
      }),
      (event) => events.push(event),
      {
        tools: {
          definitions: () => [],
          async prepare(call) {
            return { ...call, input: { command: 'prepared' } }
          },
          async execute(call) {
            return {
              content: String(call.input.command),
              isError: false,
            }
          },
        },
        permissions: { resolve: () => ({ behavior: 'allow' }) },
      },
    )

    const result = await runtime.executeDirectToolCall(
      { id: 'shell-direct', name: 'Bash', input: { command: 'original' } },
      {
        observer: {
          async assistantCompleted() {},
          async toolCompleted(call) {
            completed.push(call.id)
          },
        },
      },
    )

    expect(result).toMatchObject({ content: 'prepared', isError: false })
    expect(completed).toEqual(['shell-direct'])
    expect(events).toContainEqual({
      type: 'permission-decision',
      callId: 'shell-direct',
      behavior: 'allow',
    })
    expect(events.some((event) => event.type === 'tool-call')).toBe(false)
    expect(events.some((event) => event.type === 'tool-result')).toBe(false)
  })

  it('emits the classifier source for classified permission decisions', async () => {
    const events: RuntimeEvent[] = []
    const runtime = new AgentRuntime(
      providerFrom(async function* () {
        yield* []
      }),
      (event) => events.push(event),
      {
        tools: {
          definitions: () => [],
          async prepare(call) {
            return call
          },
          async execute() {
            return { content: 'unused', isError: false }
          },
        },
        permissions: {
          resolve: () =>
            annotateAutoModePermissionOutcome(
              annotatePermissionDecision(
                { behavior: 'deny', reason: 'classifier policy' },
                'auto-classifier',
              ),
              'blocked',
            ),
        },
      },
    )
    await runtime.executeDirectToolCall(
      { id: 'classified', name: 'Bash', input: { command: 'dangerous' } },
      { observer: { async assistantCompleted() {}, async toolCompleted() {} } },
    )
    expect(events).toContainEqual({
      type: 'permission-decision',
      callId: 'classified',
      behavior: 'deny',
      reason: 'classifier policy',
      source: 'auto-classifier',
      autoModeOutcome: 'blocked',
    })
  })

  it('approves a recovered tool after preparation and before execution', async () => {
    const approvals: ModelToolCall[] = []
    let executed = false
    const runtime = new AgentRuntime(
      providerFrom(async function* () {
        yield* []
      }),
      undefined,
      {
        tools: {
          definitions: () => [],
          async prepare(call) {
            return { ...call, input: { command: 'prepared command' } }
          },
          async execute() {
            executed = true
            return { content: 'unexpected', isError: false }
          },
        },
        permissions: { resolve: () => ({ behavior: 'allow' }) },
      },
    )

    await expect(
      runtime.recoverToolCalls(
        [{ id: 'call_recovery', name: 'Bash', input: { command: 'original' } }],
        {
          approveRecovery(call) {
            approvals.push(call)
            return false
          },
        },
      ),
    ).rejects.toThrow('recovery was declined')

    expect(approvals).toEqual([
      {
        id: 'call_recovery',
        name: 'Bash',
        input: { command: 'prepared command' },
      },
    ])
    expect(executed).toBe(false)
  })

  it('requires recovery approval before resolving an unavailable tool', async () => {
    let approvals = 0
    const runtime = new AgentRuntime(
      providerFrom(async function* () {
        yield* []
      }),
    )

    await expect(
      runtime.recoverToolCalls(
        [{ id: 'call_missing', name: 'Missing', input: {} }],
        {
          approveRecovery() {
            approvals += 1
            return false
          },
        },
      ),
    ).rejects.toThrow('recovery was declined')
    expect(approvals).toBe(1)
  })

  it('applies approved permission updates before tool execution', async () => {
    const applied: unknown[] = []
    const runtime = new AgentRuntime(
      providerFrom(async function* () {
        yield* []
      }),
      undefined,
      {
        tools: {
          definitions: () => [],
          async prepare(call, context) {
            expect(context.permissionPhase).toBe('request')
            return call
          },
          async execute(_call, context) {
            expect(context.permissionPhase).toBe('execute')
            expect(context.permissionApproved).toBe(true)
            expect(context.permissionUpdates).toEqual([
              {
                type: 'addDirectories',
                directories: ['/shared'],
                destination: 'session',
              },
            ])
            return { content: 'updated', isError: false }
          },
        },
        permissions: {
          resolve: () => ({ behavior: 'ask' }),
        },
      },
    )
    await expect(
      runtime.executeDirectToolCall(
        { id: 'permission-update', name: 'Write', input: {} },
        {
          observer: {
            async assistantCompleted() {},
            async toolCompleted() {},
          },
          approveTool: () => ({
            behavior: 'allow',
            updatedPermissions: [
              {
                type: 'addDirectories',
                directories: ['/shared'],
                destination: 'session',
              },
            ],
          }),
          onPermissionUpdates(updates) {
            applied.push(...updates)
          },
        },
      ),
    ).resolves.toMatchObject({ content: 'updated', isError: false })
    expect(applied).toHaveLength(1)
  })

  it('aggregates successful line metrics across turns and ignores error results', async () => {
    let turn = 0
    const requests: ModelRequest[] = []
    const provider = providerFrom(async function* (request) {
      requests.push(request)
      if (turn === 0) {
        turn += 1
        yield {
          type: 'tool-call',
          call: { id: 'write_a', name: 'Write', input: {} },
        }
        yield {
          type: 'tool-call',
          call: { id: 'edit_a', name: 'Edit', input: {} },
        }
        return
      }
      if (turn === 1) {
        turn += 1
        yield {
          type: 'tool-call',
          call: { id: 'write_b', name: 'Write', input: {} },
        }
        return
      }
      yield { type: 'text-delta', delta: 'done' }
    })
    const resultsByCall = new Map<string, ToolExecutionResult>([
      [
        'write_a',
        { content: 'wrote a', isError: false, linesAdded: 3, linesRemoved: 1 },
      ],
      [
        'edit_a',
        {
          content: 'edit failed',
          isError: true,
          linesAdded: 99,
          linesRemoved: 99,
        },
      ],
      ['write_b', { content: 'wrote b', isError: false, linesAdded: 5 }],
    ])
    const runtime = new AgentRuntime(provider, undefined, {
      tools: {
        definitions: () => [],
        async prepare(call) {
          return call
        },
        async execute(call) {
          return resultsByCall.get(call.id) ?? { content: '', isError: false }
        },
      },
      permissions: { resolve: () => ({ behavior: 'allow' }) },
    })

    const result = await runtime.run({
      messages: [{ role: 'user', content: 'edit files' }],
    })

    expect(requests).toHaveLength(3)
    expect(result.text).toBe('done')
    expect(result.linesAdded).toBe(8)
    expect(result.linesRemoved).toBe(1)
  })

  it('rejects malformed present line metrics instead of corrupting totals', async () => {
    const runWith = async (results: Record<string, ToolExecutionResult>) => {
      let turn = 0
      const provider = providerFrom(async function* () {
        if (turn++ === 0) {
          yield {
            type: 'tool-call',
            call: { id: 'write_a', name: 'Write', input: {} },
          }
          return
        }
        yield {
          type: 'tool-call',
          call: { id: 'write_b', name: 'Write', input: {} },
        }
      })
      const runtime = new AgentRuntime(provider, undefined, {
        tools: {
          definitions: () => [],
          async prepare(call) {
            return call
          },
          async execute(call) {
            return results[call.id] ?? { content: '', isError: false }
          },
        },
        permissions: { resolve: () => ({ behavior: 'allow' }) },
      })
      return runtime.run({
        messages: [{ role: 'user', content: 'edit files' }],
      })
    }

    await expect(
      runWith({
        write_a: { content: 'a', isError: false, linesAdded: -1 },
      }),
    ).rejects.toThrow('linesAdded')
    await expect(
      runWith({
        write_a: { content: 'a', isError: false, linesRemoved: 1.5 },
      }),
    ).rejects.toThrow('linesRemoved')
    await expect(
      runWith({
        write_a: {
          content: 'a',
          isError: false,
          linesAdded: Number.MAX_SAFE_INTEGER,
        },
        write_b: { content: 'b', isError: false, linesAdded: 1 },
      }),
    ).rejects.toThrow('linesAdded total overflow')
  })

  it('propagates raw-model usage across provider turns and nested tool results', async () => {
    let turn = 0
    const requests: ModelRequest[] = []
    const provider: ModelProvider = {
      model: 'claude-3-5-sonnet',
      capabilities: { streaming: true, usage: true, tools: true },
      async *complete(request) {
        requests.push(request)
        if (turn++ === 0) {
          yield {
            type: 'tool-call',
            call: { id: 'read', name: 'Read', input: {} },
          }
          yield {
            type: 'tool-call',
            call: { id: 'bad', name: 'Bad', input: {} },
          }
          yield {
            type: 'usage',
            usage: {
              inputTokens: 10,
              outputTokens: 5,
              cacheReadInputTokens: 100,
              cacheCreationInputTokens: 50,
              webSearchRequests: 4,
            },
          }
          return
        }
        yield { type: 'text-delta', delta: 'done' }
        yield {
          type: 'usage',
          usage: {
            inputTokens: 20,
            outputTokens: 10,
            cacheReadInputTokens: 30,
            webSearchRequests: 2,
          },
        }
      },
    }
    const resultsByCall = new Map<string, ToolExecutionResult>([
      [
        'read',
        {
          content: 'nested',
          isError: false,
          usage: { inputTokens: 3, outputTokens: 1 },
          modelUsage: {
            'claude-3-5-sonnet': {
              inputTokens: 2,
              outputTokens: 2,
              cacheReadInputTokens: 10,
              webSearchRequests: 1,
            },
            'subagent-alpha': { inputTokens: 4, outputTokens: 3 },
          },
        },
      ],
      [
        'bad',
        {
          content: 'nope',
          isError: true,
          modelUsage: {
            'ignored-model': { inputTokens: 99, outputTokens: 99 },
          },
        },
      ],
    ])
    const runtime = new AgentRuntime(provider, undefined, {
      tools: {
        definitions: () => [],
        async prepare(call) {
          return call
        },
        async execute(call) {
          return resultsByCall.get(call.id) ?? { content: '', isError: false }
        },
      },
      permissions: { resolve: () => ({ behavior: 'allow' }) },
    })

    const result = await runtime.run({
      messages: [{ role: 'user', content: 'read nested' }],
    })

    expect(requests).toHaveLength(2)
    expect(result.text).toBe('done')
    // Total usage is unchanged by the nested breakdown: no double counting.
    expect(result.usage).toEqual({
      inputTokens: 33,
      outputTokens: 16,
      cacheReadInputTokens: 130,
      cacheCreationInputTokens: 50,
      webSearchRequests: 6,
    })
    // First-insertion order is stable: parent model first, then nested model.
    expect(Object.keys(result.modelUsage ?? {})).toEqual([
      'claude-3-5-sonnet',
      'subagent-alpha',
    ])
    // Provider turns and the matching nested model aggregate cache fields.
    expect(result.modelUsage?.['claude-3-5-sonnet']).toEqual({
      inputTokens: 32,
      outputTokens: 17,
      cacheReadInputTokens: 140,
      cacheCreationInputTokens: 50,
      webSearchRequests: 7,
    })
    expect(result.modelUsage?.['subagent-alpha']).toEqual({
      inputTokens: 4,
      outputTokens: 3,
    })
    // An error tool result's breakdown is ignored.
    expect(result.modelUsage?.['ignored-model']).toBeUndefined()

    // A malformed nested breakdown rejects the run before any partial merge.
    let malformedTurn = 0
    const malformedProvider: ModelProvider = {
      model: 'claude-3-5-sonnet',
      capabilities: { streaming: true, usage: true, tools: true },
      async *complete() {
        if (malformedTurn++ === 0) {
          yield {
            type: 'tool-call',
            call: { id: 'read', name: 'Read', input: {} },
          }
          yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
          return
        }
        yield { type: 'text-delta', delta: 'done' }
        yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
      },
    }
    const malformedRuntime = new AgentRuntime(malformedProvider, undefined, {
      tools: {
        definitions: () => [],
        async prepare(call) {
          return call
        },
        async execute() {
          return {
            content: 'nested',
            isError: false,
            modelUsage: {
              'subagent-alpha': { inputTokens: 4, outputTokens: 3 },
              '': { inputTokens: 1, outputTokens: 1 },
            },
          }
        },
      },
      permissions: { resolve: () => ({ behavior: 'allow' }) },
    })
    await expect(
      malformedRuntime.run({
        messages: [{ role: 'user', content: 'bad nested' }],
      }),
    ).rejects.toThrow('blank model name')
  })

  it('merges onStop raw-model breakdowns across follow-up turns and validates malformed batches', async () => {
    let turn = 0
    let stopCalls = 0
    const requests: ModelRequest[] = []
    const provider: ModelProvider = {
      model: 'claude-3-5-sonnet',
      capabilities: { streaming: true, usage: true, tools: true },
      async *complete(request) {
        requests.push(request)
        if (turn++ === 0) {
          yield { type: 'text-delta', delta: 'first answer' }
          yield {
            type: 'usage',
            usage: {
              inputTokens: 10,
              outputTokens: 5,
              cacheReadInputTokens: 100,
              cacheCreationInputTokens: 50,
              webSearchRequests: 4,
            },
          }
          return
        }
        yield { type: 'text-delta', delta: 'revised answer' }
        yield {
          type: 'usage',
          usage: {
            inputTokens: 6,
            outputTokens: 4,
            cacheReadInputTokens: 20,
            webSearchRequests: 2,
          },
        }
      },
    }
    const runtime = new AgentRuntime(provider)

    const result = await runtime.run({
      messages: [{ role: 'user', content: 'answer' }],
      onStop: async () => {
        if (stopCalls++ === 0) {
          return {
            messages: ['Stop hook: revise response'],
            usage: {
              inputTokens: 24,
              outputTokens: 13,
              cacheReadInputTokens: 40,
              cacheCreationInputTokens: 5,
              webSearchRequests: 3,
            },
            modelUsage: {
              // Overlaps the parent model: must merge, not replace or recount.
              'claude-3-5-sonnet': {
                inputTokens: 20,
                outputTokens: 10,
                cacheReadInputTokens: 30,
                cacheCreationInputTokens: 5,
                webSearchRequests: 2,
              },
              // First raw model observed from onStop.
              'raw-model-x': {
                inputTokens: 4,
                outputTokens: 3,
                cacheReadInputTokens: 10,
                webSearchRequests: 1,
              },
            },
          }
        }
        return []
      },
    })

    expect(requests).toHaveLength(2)
    expect(result.text).toBe('revised answer')
    // The stop batch aggregate usage counts exactly once; its modelUsage
    // breakdown is attribution only and never re-added to the aggregate.
    expect(result.usage).toEqual({
      inputTokens: 40,
      outputTokens: 22,
      cacheReadInputTokens: 160,
      cacheCreationInputTokens: 55,
      webSearchRequests: 9,
    })
    // Parent-first insertion order, then raw models first observed from onStop.
    expect(Object.keys(result.modelUsage ?? {})).toEqual([
      'claude-3-5-sonnet',
      'raw-model-x',
    ])
    // Duplicate parent-model keys merge across provider turns and the stop batch.
    expect(result.modelUsage?.['claude-3-5-sonnet']).toEqual({
      inputTokens: 36,
      outputTokens: 19,
      cacheReadInputTokens: 150,
      cacheCreationInputTokens: 55,
      webSearchRequests: 8,
    })
    expect(result.modelUsage?.['raw-model-x']).toEqual({
      inputTokens: 4,
      outputTokens: 3,
      cacheReadInputTokens: 10,
      webSearchRequests: 1,
    })

    // A malformed onStop breakdown rejects the run before any partial merge.
    const malformedRuntime = new AgentRuntime(
      providerFrom(async function* () {
        yield { type: 'text-delta', delta: 'done' }
        yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
      }),
    )
    await expect(
      malformedRuntime.run({
        messages: [{ role: 'user', content: 'bad' }],
        onStop: async () => ({
          messages: [],
          modelUsage: {
            'claude-3-5-sonnet': { inputTokens: 1, outputTokens: 1 },
            '': { inputTokens: 1, outputTokens: 1 },
          },
        }),
      }),
    ).rejects.toThrow('blank model name')

    // An invalid web-search counter in an onStop breakdown also rejects before
    // any partial raw-model-map mutation.
    const invalidCounterRuntime = new AgentRuntime(
      providerFrom(async function* () {
        yield { type: 'text-delta', delta: 'done' }
        yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
      }),
    )
    await expect(
      invalidCounterRuntime.run({
        messages: [{ role: 'user', content: 'bad counter' }],
        onStop: async () => ({
          messages: [],
          modelUsage: {
            'claude-3-5-sonnet': { inputTokens: 1, outputTokens: 1 },
            'raw-model-y': {
              inputTokens: 1,
              outputTokens: 1,
              webSearchRequests: -1,
            },
          },
        }),
      }),
    ).rejects.toThrow('invalid webSearchRequests counter')

    // Overflow when merging an onStop breakdown also fails explicitly.
    const overflowRuntime = new AgentRuntime({
      model: 'claude-3-5-sonnet',
      capabilities: { streaming: true, usage: true, tools: true },
      async *complete() {
        yield { type: 'text-delta', delta: 'done' }
        yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
      },
    })
    await expect(
      overflowRuntime.run({
        messages: [{ role: 'user', content: 'overflow' }],
        onStop: async () => ({
          messages: [],
          modelUsage: {
            'claude-3-5-sonnet': {
              inputTokens: Number.MAX_SAFE_INTEGER,
              outputTokens: Number.MAX_SAFE_INTEGER,
            },
          },
        }),
      }),
    ).rejects.toThrow('Model usage total overflow')
  })

  it('enriches the main-model raw usage row with provider capability metadata', async () => {
    const provider: ModelProvider = {
      model: 'claude-3-5-sonnet',
      capabilities: {
        streaming: true,
        usage: true,
        tools: true,
        contextWindowTokens: 200_000,
        maxOutputTokens: 32_000,
      },
      async *complete() {
        yield { type: 'text-delta', delta: 'done' }
        yield {
          type: 'usage',
          usage: {
            inputTokens: 20,
            outputTokens: 10,
            cacheReadInputTokens: 30,
            webSearchRequests: 2,
          },
        }
      },
    }
    const runtime = new AgentRuntime(provider)
    const result = await runtime.run({
      messages: [{ role: 'user', content: 'answer' }],
    })
    // The per-model row carries the provider's known capability metadata.
    expect(result.modelUsage).toEqual({
      'claude-3-5-sonnet': {
        inputTokens: 20,
        outputTokens: 10,
        cacheReadInputTokens: 30,
        webSearchRequests: 2,
        contextWindow: 200_000,
        maxOutputTokens: 32_000,
      },
    })
    // The aggregate total stays counter-only.
    expect(result.usage).toEqual({
      inputTokens: 20,
      outputTokens: 10,
      cacheReadInputTokens: 30,
      webSearchRequests: 2,
    })
  })

  it('rejects a conflicting nested batch before any raw-model row is added', async () => {
    const provider: ModelProvider = {
      model: 'claude-3-5-sonnet',
      capabilities: {
        streaming: true,
        usage: true,
        tools: true,
        contextWindowTokens: 200_000,
        maxOutputTokens: 32_000,
      },
      async *complete() {
        yield {
          type: 'tool-call',
          call: { id: 'read', name: 'Read', input: {} },
        }
        yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
        yield { type: 'text-delta', delta: 'done' }
        yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 2 } }
      },
    }
    const runtime = new AgentRuntime(provider, undefined, {
      tools: {
        definitions: () => [],
        async prepare(call) {
          return call
        },
        async execute() {
          return {
            content: 'nested',
            isError: false,
            usage: { inputTokens: 2, outputTokens: 1 },
            modelUsage: {
              // Valid new model in the same batch as the conflicting row: the
              // whole batch must reject before either row becomes observable.
              'subagent-alpha': { inputTokens: 4, outputTokens: 3 },
              'claude-3-5-sonnet': {
                inputTokens: 2,
                outputTokens: 1,
                contextWindow: 100_000,
                maxOutputTokens: 16_000,
              },
            },
          }
        },
      },
      permissions: { resolve: () => ({ behavior: 'allow' }) },
    })
    await expect(
      runtime.run({ messages: [{ role: 'user', content: 'read' }] }),
    ).rejects.toThrow(
      'Model usage for "claude-3-5-sonnet" has conflicting contextWindow values: 200000 vs 100000',
    )
  })

  it('rejects invalid metadata values in raw usage rows', async () => {
    const runtime = new AgentRuntime(
      providerFrom(async function* () {
        yield { type: 'text-delta', delta: 'done' }
        yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
      }),
    )
    await expect(
      runtime.run({
        messages: [{ role: 'user', content: 'bad metadata' }],
        onStop: async () => ({
          messages: [],
          modelUsage: {
            'claude-3-5-sonnet': {
              inputTokens: 1,
              outputTokens: 1,
              contextWindow: 0,
            },
          },
        }),
      }),
    ).rejects.toThrow('invalid contextWindow metadata value')
  })
})
