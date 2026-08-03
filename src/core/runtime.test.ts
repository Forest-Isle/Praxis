import { describe, expect, it } from 'vitest'

import {
  AgentRunCancelledError,
  AgentRuntime,
  ModelProviderError,
  type ModelProvider,
  type ModelRequest,
  type RuntimeEvent,
  type ToolRegistry,
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
      role: 'tool',
      toolCallId: 'call_read',
      content: '# Praxis',
      isError: false,
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
})
