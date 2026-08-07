import { describe, expect, it } from 'vitest'

import {
  BackgroundAgentManager,
  type BackgroundAgentRunResult,
} from './background-agent-manager.js'

const completed = (text: string): BackgroundAgentRunResult => ({
  text,
  usage: { inputTokens: 2, outputTokens: 1 },
  toolUseCount: 1,
  durationMs: 5,
})

function spec(
  run: (
    message: string,
    signal: AbortSignal,
    continuation: boolean,
  ) => Promise<BackgroundAgentRunResult>,
) {
  return {
    agentId: 'a0123456789abcdef',
    agentType: 'general-purpose',
    description: 'test agent',
    prompt: 'initial prompt',
    toolUseId: 'call_agent',
    outputFile: '/tmp/agent.output',
    resolvedModel: 'fixture-model',
    run,
  }
}

describe('BackgroundAgentManager', () => {
  it('returns live status, blocks for completion, and consumes one notification', async () => {
    let finish: ((result: BackgroundAgentRunResult) => void) | undefined
    const manager = new BackgroundAgentManager()
    manager.launch(
      spec(
        () =>
          new Promise((resolve) => {
            finish = resolve
          }),
      ),
    )

    await expect(
      manager.output('a0123456789abcdef', { block: false, timeout: 30_000 }),
    ).resolves.toContain('<status>running</status>')

    const output = manager.output('a0123456789abcdef', {
      block: true,
      timeout: 30_000,
    })
    finish?.(completed('RESULT'))
    await expect(output).resolves.toContain('<output>\nRESULT\n</output>')
    await expect(
      manager.notifications({ waitForRunning: false }),
    ).resolves.toEqual({
      messages: [expect.stringContaining('<result>RESULT</result>')],
      usage: { inputTokens: 2, outputTokens: 1 },
    })
    await expect(
      manager.notifications({ waitForRunning: false }),
    ).resolves.toEqual({
      messages: [],
      usage: { inputTokens: 0, outputTokens: 0 },
    })
  })

  it('stops only a running task and propagates its abort signal', async () => {
    let aborted = false
    const manager = new BackgroundAgentManager()
    manager.launch(
      spec(
        (_message, signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => {
                aborted = true
                reject(new Error('aborted'))
              },
              { once: true },
            )
          }),
      ),
    )

    expect(manager.stop('a0123456789abcdef')).toContain('stopped successfully')
    await Promise.resolve()
    expect(aborted).toBe(true)
    await expect(
      manager.output('a0123456789abcdef', { block: false, timeout: 0 }),
    ).resolves.toContain('<status>stopped</status>')
    expect(() => manager.stop('a0123456789abcdef')).toThrow(
      'is not running (status: stopped)',
    )
  })

  it('resumes a completed task under the same agent ID', async () => {
    const calls: { message: string; continuation: boolean }[] = []
    const manager = new BackgroundAgentManager()
    manager.launch(
      spec(async (message, _signal, continuation) => {
        calls.push({ message, continuation })
        return completed(continuation ? 'SECOND' : 'FIRST')
      }),
    )
    await manager.output('a0123456789abcdef', { block: true, timeout: 30_000 })
    await manager.notifications({ waitForRunning: false })

    expect(
      manager.send(
        'a0123456789abcdef',
        'continue work',
        'continue test',
        'call_message',
      ),
    ).toContain('"success":true')
    await manager.output('a0123456789abcdef', { block: true, timeout: 30_000 })
    expect(calls).toEqual([
      { message: 'initial prompt', continuation: false },
      { message: 'continue work', continuation: true },
    ])
    await expect(
      manager.notifications({ waitForRunning: false }),
    ).resolves.toEqual({
      messages: [
        expect.stringContaining('<tool-use-id>call_message</tool-use-id>'),
      ],
      usage: { inputTokens: 2, outputTokens: 1 },
    })
  })

  it('runs queued messages in order and settles each notification usage once', async () => {
    const calls: { message: string; continuation: boolean }[] = []
    const finishers: ((result: BackgroundAgentRunResult) => void)[] = []
    const manager = new BackgroundAgentManager()
    manager.launch(
      spec(
        (message, _signal, continuation) =>
          new Promise((resolve) => {
            calls.push({ message, continuation })
            finishers.push(resolve)
          }),
      ),
    )
    manager.send(
      'a0123456789abcdef',
      'first continuation',
      'first queued message',
      'call_message_1',
    )
    manager.send(
      'a0123456789abcdef',
      'second continuation',
      'second queued message',
      'call_message_2',
    )

    finishers[0]?.(completed('FIRST'))
    await manager.output('a0123456789abcdef', {
      block: true,
      timeout: 30_000,
    })
    expect(calls).toEqual([
      { message: 'initial prompt', continuation: false },
      { message: 'first continuation', continuation: true },
    ])
    await expect(
      manager.notifications({ waitForRunning: false }),
    ).resolves.toEqual({
      messages: [expect.stringContaining('<result>FIRST</result>')],
      usage: { inputTokens: 2, outputTokens: 1 },
    })

    finishers[1]?.(completed('SECOND'))
    await manager.output('a0123456789abcdef', {
      block: true,
      timeout: 30_000,
    })
    expect(calls.at(-1)).toEqual({
      message: 'second continuation',
      continuation: true,
    })
    const second = await manager.notifications({ waitForRunning: false })
    expect(second.messages).toEqual([
      expect.stringContaining('<tool-use-id>call_message_1</tool-use-id>'),
    ])
    expect(second.usage).toEqual({ inputTokens: 2, outputTokens: 1 })

    finishers[2]?.(completed('THIRD'))
    await manager.output('a0123456789abcdef', {
      block: true,
      timeout: 30_000,
    })
    const third = await manager.notifications({ waitForRunning: false })
    expect(third.messages).toEqual([
      expect.stringContaining('<tool-use-id>call_message_2</tool-use-id>'),
    ])
    expect(third.usage).toEqual({ inputTokens: 2, outputTokens: 1 })
    await expect(
      manager.notifications({ waitForRunning: false }),
    ).resolves.toEqual({
      messages: [],
      usage: { inputTokens: 0, outputTokens: 0 },
    })
  })

  it('validates IDs and bounded output waits', async () => {
    const manager = new BackgroundAgentManager()
    expect(() =>
      manager.launch(spec(async () => completed('done'))),
    ).not.toThrow()
    await expect(
      manager.output('invalid name!', { block: false, timeout: 0 }),
    ).rejects.toThrow('Invalid background agent ID')
    await expect(
      manager.output('a0123456789abcdef', {
        block: false,
        timeout: 600_001,
      }),
    ).rejects.toThrow('timeout must be between 0 and 600000')
  })

  it('resolves named agents for output, stop, and continuation', async () => {
    const manager = new BackgroundAgentManager()
    const namedSpec = {
      ...spec(async (_message, _signal, continuation) =>
        completed(continuation ? 'NAMED_SECOND' : 'NAMED_FIRST'),
      ),
      name: 'reviewer',
    }
    manager.launch(namedSpec)
    await expect(
      manager.output('reviewer', { block: true, timeout: 30_000 }),
    ).resolves.toContain('NAMED_FIRST')
    expect(
      manager.send('reviewer', 'continue', undefined, 'call_named_message'),
    ).toContain('"success":true')
    await expect(
      manager.output('reviewer', { block: true, timeout: 30_000 }),
    ).resolves.toContain('NAMED_SECOND')
  })
})
