import { describe, expect, it } from 'vitest'

import {
  BackgroundAgentRunError,
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
    expect(manager.snapshots()).toEqual([
      expect.objectContaining({
        agentId: 'a0123456789abcdef',
        status: 'completed',
        description: 'test agent',
        name: null,
        result: expect.objectContaining({ text: 'RESULT', durationMs: 5 }),
        startedAt: expect.any(Number),
      }),
    ])
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
    const stoppedDuration = manager.snapshots()[0]?.durationMs
    expect(stoppedDuration).toEqual(expect.any(Number))
    await Promise.resolve()
    expect(aborted).toBe(true)
    await expect(
      manager.output('a0123456789abcdef', { block: true, timeout: 30_000 }),
    ).resolves.toContain('<status>stopped</status>')
    expect(manager.snapshots()[0]?.durationMs).toBe(stoppedDuration)
    expect(() => manager.stop('a0123456789abcdef')).toThrow(
      'is not running (status: stopped)',
    )
  })

  it('retains terminal duration for a failed task without a result snapshot', async () => {
    const manager = new BackgroundAgentManager()
    manager.launch(
      spec(async () => {
        throw new BackgroundAgentRunError('failed agent', completed('partial'))
      }),
    )

    await manager.output('a0123456789abcdef', {
      block: true,
      timeout: 30_000,
    })
    expect(manager.snapshots()).toEqual([
      expect.objectContaining({
        status: 'failed',
        result: null,
        error: 'failed agent',
        durationMs: 5,
      }),
    ])
  })

  it('publishes retained isolation metadata only after TaskStop cleanup settles', async () => {
    const manager = new BackgroundAgentManager()
    manager.launch(
      spec(
        (_message, signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () =>
                reject(
                  new BackgroundAgentRunError('aborted', {
                    text: 'aborted',
                    usage: { inputTokens: 0, outputTokens: 0 },
                    toolUseCount: 0,
                    durationMs: 1,
                    isolationPath: '/tmp/retained-agent',
                    isolationRetained: true,
                    isolationWarning: 'worktree was retained',
                  }),
                ),
              { once: true },
            )
          }),
      ),
    )

    manager.stop('a0123456789abcdef')
    await expect(
      manager.output('a0123456789abcdef', { block: true, timeout: 30_000 }),
    ).resolves.toMatch(/worktree_path>\/tmp\/retained-agent/u)
    await expect(
      manager.notifications({ waitForRunning: false }),
    ).resolves.toMatchObject({
      messages: [expect.stringContaining('/tmp/retained-agent')],
    })
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

  it('aggregates raw-model usage across consumed notifications once', async () => {
    const firstResult: BackgroundAgentRunResult = {
      text: 'FIRST',
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadInputTokens: 10,
        cacheCreationInputTokens: 4,
        webSearchRequests: 3,
      },
      modelUsage: {
        'model-a': {
          inputTokens: 30,
          outputTokens: 10,
          cacheReadInputTokens: 5,
          webSearchRequests: 2,
        },
        'model-b': { inputTokens: 40, outputTokens: 20 },
      },
      toolUseCount: 1,
      durationMs: 5,
    }
    const secondResult: BackgroundAgentRunResult = {
      text: 'SECOND',
      usage: {
        inputTokens: 60,
        outputTokens: 30,
        cacheReadInputTokens: 2,
        cacheCreationInputTokens: 7,
        webSearchRequests: 2,
      },
      modelUsage: {
        'model-b': {
          inputTokens: 10,
          outputTokens: 5,
          cacheCreationInputTokens: 8,
        },
        'model-c': {
          inputTokens: 20,
          outputTokens: 15,
          cacheReadInputTokens: 3,
          webSearchRequests: 1,
        },
      },
      toolUseCount: 1,
      durationMs: 5,
    }
    const manager = new BackgroundAgentManager()
    manager.launch(
      spec((_message, _signal, continuation) =>
        Promise.resolve(continuation ? secondResult : firstResult),
      ),
    )
    await manager.output('a0123456789abcdef', { block: true, timeout: 30_000 })
    expect(
      manager.send(
        'a0123456789abcdef',
        'continue work',
        'continue test',
        'call_message',
      ),
    ).toContain('"success":true')
    await manager.output('a0123456789abcdef', { block: true, timeout: 30_000 })

    // One call consumes both notifications, so overlapping raw models merge.
    const consumed = await manager.notifications({ waitForRunning: false })
    expect(consumed.messages).toEqual([
      expect.stringContaining('<tool-use-id>call_agent</tool-use-id>'),
      expect.stringContaining('<tool-use-id>call_message</tool-use-id>'),
    ])
    // Aggregate usage stays the plain sum of each result.usage (including the
    // cache and web-search counters) and is not re-derived from the raw-model
    // breakdown, which keeps per-model web search counts unmerged.
    expect(consumed.usage).toEqual({
      inputTokens: 160,
      outputTokens: 80,
      cacheReadInputTokens: 12,
      cacheCreationInputTokens: 11,
      webSearchRequests: 5,
    })
    expect(consumed.modelUsage).toEqual({
      'model-a': {
        inputTokens: 30,
        outputTokens: 10,
        cacheReadInputTokens: 5,
        webSearchRequests: 2,
      },
      'model-b': {
        inputTokens: 50,
        outputTokens: 25,
        cacheCreationInputTokens: 8,
      },
      'model-c': {
        inputTokens: 20,
        outputTokens: 15,
        cacheReadInputTokens: 3,
        webSearchRequests: 1,
      },
    })
    const modelUsage = consumed.modelUsage
    if (modelUsage !== undefined) {
      expect(Object.keys(modelUsage)).toEqual(['model-a', 'model-b', 'model-c'])
      // Returned entries are copies; mutating them cannot alter stored results.
      const merged = modelUsage['model-b']
      if (merged !== undefined) {
        merged.inputTokens = 999
        expect(
          manager.snapshots()[0]?.result?.modelUsage?.['model-b']?.inputTokens,
        ).toBe(10)
      }
    }

    const empty = await manager.notifications({ waitForRunning: false })
    expect(empty).toEqual({
      messages: [],
      usage: { inputTokens: 0, outputTokens: 0 },
    })
    expect('modelUsage' in empty).toBe(false)
  })

  it('fails explicitly on malformed or overflowing raw-model usage', async () => {
    const runWithModelUsage = (
      modelUsage: NonNullable<BackgroundAgentRunResult['modelUsage']>,
    ) =>
      spec(async () => ({
        text: 'BAD',
        usage: { inputTokens: 2, outputTokens: 1 },
        modelUsage,
        toolUseCount: 1,
        durationMs: 5,
      }))

    const blank = new BackgroundAgentManager()
    blank.launch(
      runWithModelUsage({
        'model-a': { inputTokens: 1, outputTokens: 1 },
        ' ': { inputTokens: 1, outputTokens: 1 },
      }),
    )
    await blank.output('a0123456789abcdef', { block: true, timeout: 30_000 })
    await expect(
      blank.notifications({ waitForRunning: false }),
    ).rejects.toThrow('blank model name')

    const negative = new BackgroundAgentManager()
    negative.launch(
      runWithModelUsage({
        'model-a': { inputTokens: -1, outputTokens: 1 },
      }),
    )
    await negative.output('a0123456789abcdef', { block: true, timeout: 30_000 })
    await expect(
      negative.notifications({ waitForRunning: false }),
    ).rejects.toThrow('invalid inputTokens counter')

    const overflow = new BackgroundAgentManager()
    overflow.launch(
      spec(async (_message, _signal, continuation) => ({
        text: continuation ? 'OVERFLOW' : 'HUGE',
        usage: { inputTokens: 2, outputTokens: 1 },
        modelUsage: {
          'model-a': { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0 },
        },
        toolUseCount: 1,
        durationMs: 5,
      })),
    )
    await overflow.output('a0123456789abcdef', { block: true, timeout: 30_000 })
    expect(
      overflow.send(
        'a0123456789abcdef',
        'continue',
        'continue overflow',
        'call_overflow',
      ),
    ).toContain('"success":true')
    await overflow.output('a0123456789abcdef', { block: true, timeout: 30_000 })
    await expect(
      overflow.notifications({ waitForRunning: false }),
    ).rejects.toThrow('Model usage total overflow')

    const negativeAggregate = new BackgroundAgentManager()
    negativeAggregate.launch(
      spec(async () => ({
        text: 'BAD',
        usage: { inputTokens: -1, outputTokens: 1 },
        toolUseCount: 1,
        durationMs: 5,
      })),
    )
    await negativeAggregate.output('a0123456789abcdef', {
      block: true,
      timeout: 30_000,
    })
    await expect(
      negativeAggregate.notifications({ waitForRunning: false }),
    ).rejects.toThrow('invalid inputTokens counter')

    const aggregateOverflow = new BackgroundAgentManager()
    aggregateOverflow.launch(
      spec(async (_message, _signal, continuation) => ({
        text: continuation ? 'OVERFLOW' : 'HUGE',
        usage: { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 },
        toolUseCount: 1,
        durationMs: 5,
      })),
    )
    await aggregateOverflow.output('a0123456789abcdef', {
      block: true,
      timeout: 30_000,
    })
    expect(
      aggregateOverflow.send(
        'a0123456789abcdef',
        'continue',
        'continue overflow',
        'call_overflow',
      ),
    ).toContain('"success":true')
    await aggregateOverflow.output('a0123456789abcdef', {
      block: true,
      timeout: 30_000,
    })
    await expect(
      aggregateOverflow.notifications({ waitForRunning: false }),
    ).rejects.toThrow('Model usage total overflow')
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

  it('rejects duplicate agent names and escapes notification identifiers', async () => {
    const manager = new BackgroundAgentManager()
    manager.launch({
      ...spec(async () => completed('first')),
      name: 'reviewer',
      toolUseId: 'call<bad&',
    })
    expect(() =>
      manager.launch({
        ...spec(async () => completed('second')),
        agentId: 'a1123456789abcdef',
        name: 'reviewer',
      }),
    ).toThrow('name already exists')
    const notification = await manager.notifications({ waitForRunning: true })
    expect(notification.messages[0]).toContain(
      '<tool-use-id>call&lt;bad&amp;</tool-use-id>',
    )
  })
})
