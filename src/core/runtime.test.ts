import { describe, expect, it } from 'vitest'

import {
  AgentRunCancelledError,
  AgentRuntime,
  ModelProviderError,
  type ModelToolCall,
  type ModelProvider,
  type ModelRequest,
  type RuntimeEvent,
  type ToolRegistry,
} from './runtime.js'

function providerFrom(complete: ModelProvider['complete']): ModelProvider {
  return {
    capabilities: { streaming: true, usage: true, tools: true },
    complete,
  }
}

const image = {
  type: 'image' as const,
  mediaType: 'image/png' as const,
  data: 'aGVsbG8=',
}

describe('AgentRuntime', () => {
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

    expect(result).toEqual({
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
    expect(unsupportedResults).toEqual([
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
    const provider = providerFrom(async function* () {
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
      { content: 'Denied by local policy', isError: true },
    ])
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
})
