import { describe, expect, it, vi } from 'vitest'

import {
  type BackgroundAgentLifecycleSource,
  BackgroundAgentRunError,
  BackgroundAgentManager,
  type BackgroundAgentRunResult,
} from './background-agent-manager.js'
import type { LifecycleState } from '../core/agent-orchestration.js'

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
  initialState: LifecycleState = 'queued',
) {
  let state = initialState
  const listeners = new Set<(state: LifecycleState) => void>()
  const publish = (next: LifecycleState) => {
    state = next
    for (const listener of listeners) listener(next)
  }
  const lifecycle: BackgroundAgentLifecycleSource = {
    current: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  return {
    agentId: 'a0123456789abcdef',
    agentType: 'general-purpose',
    description: 'test agent',
    prompt: 'initial prompt',
    toolUseId: 'call_agent',
    outputFile: '/tmp/agent.output',
    resolvedModel: 'fixture-model',
    lifecycle,
    async run(message: string, signal: AbortSignal, continuation: boolean) {
      publish('running')
      const onAbort = () => publish('cancelling')
      signal.addEventListener('abort', onAbort, { once: true })
      try {
        const result = await run(message, signal, continuation)
        publish('completed')
        return result
      } catch (error) {
        publish(signal.aborted ? 'cancelled' : 'failed')
        throw error
      } finally {
        signal.removeEventListener('abort', onAbort)
      }
    },
  }
}

function controllableLifecycle(initial: LifecycleState = 'queued') {
  let state = initial
  const listeners = new Set<(state: LifecycleState) => void>()
  return {
    lifecycle: {
      current: () => state,
      subscribe(listener: (next: LifecycleState) => void) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    } satisfies BackgroundAgentLifecycleSource,
    publish(next: LifecycleState) {
      state = next
      for (const listener of listeners) listener(next)
    },
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
    expect(manager.notificationClaimAgentIds()).toEqual(['a0123456789abcdef'])

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
    expect(manager.notificationClaimAgentIds()).toEqual(['a0123456789abcdef'])
    await expect(
      manager.notifications({ waitForRunning: false }),
    ).resolves.toEqual({
      messages: [expect.stringContaining('<result>RESULT</result>')],
      usage: { inputTokens: 2, outputTokens: 1 },
    })
    expect(manager.notificationClaimAgentIds()).toEqual([])
    await expect(
      manager.notifications({ waitForRunning: false }),
    ).resolves.toEqual({
      messages: [],
      usage: { inputTokens: 0, outputTokens: 0 },
    })
  })

  it('retains an orphaned lifecycle when its promise rejects', async () => {
    const lifecycle: BackgroundAgentLifecycleSource = {
      current: () => 'orphaned',
      subscribe: () => () => undefined,
    }
    const manager = new BackgroundAgentManager()
    manager.launch({
      ...spec(async () => {
        throw new Error('orphan diagnostic')
      }),
      lifecycle,
    })
    await expect(
      manager.output('a0123456789abcdef', { block: true, timeout: 30_000 }),
    ).resolves.toContain('<status>interrupted</status>')
    expect(manager.snapshots()).toEqual([
      expect.objectContaining({
        status: 'orphaned',
        error: 'orphan diagnostic',
      }),
    ])
    await expect(
      manager.notifications({ waitForRunning: false }),
    ).resolves.toEqual({
      messages: [],
      usage: { inputTokens: 0, outputTokens: 0 },
    })
  })

  it('claims queued admission and keeps a timed-out cancellation nonterminal', async () => {
    const manager = new BackgroundAgentManager()
    let admissionClaims: readonly string[] = []
    manager.launch({
      ...spec(() => new Promise<BackgroundAgentRunResult>(() => undefined)),
      markBackground: () => {
        admissionClaims = manager.notificationClaimAgentIds()
      },
    })
    expect(admissionClaims).toEqual(['a0123456789abcdef'])
    await expect(
      manager.stopAndWait('a0123456789abcdef', 0),
    ).resolves.toContain('cancellation is still in progress')
    expect(manager.snapshots()).toEqual([
      expect.objectContaining({ status: 'cancelling' }),
    ])
    expect(manager.notificationClaimAgentIds()).toEqual(['a0123456789abcdef'])
    expect(
      JSON.parse(
        manager.send(
          'a0123456789abcdef',
          'continue while draining',
          undefined,
          'call_continue',
        ),
      ),
    ).toMatchObject({ success: false })
    await manager.close(0)
  })

  it('resumes a settled cancelled task under the same agent ID', async () => {
    const calls: { message: string; continuation: boolean }[] = []
    let releaseCancellation: (() => void) | undefined
    const cancellation = new Promise<void>((resolve) => {
      releaseCancellation = resolve
    })
    const manager = new BackgroundAgentManager()
    manager.launch(
      spec(async (message, signal, continuation) => {
        calls.push({ message, continuation })
        if (!continuation) {
          await new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => resolve(), { once: true })
          })
          await cancellation
          throw new Error('cancelled')
        }
        return completed('CONTINUED')
      }),
    )

    manager.stop('a0123456789abcdef')
    expect(
      JSON.parse(
        manager.send('a0123456789abcdef', 'too early', undefined, 'call_early'),
      ),
    ).toMatchObject({ success: false })
    releaseCancellation?.()
    await expect(
      manager.output('a0123456789abcdef', { block: true, timeout: 30_000 }),
    ).resolves.toContain('<status>stopped</status>')

    expect(
      JSON.parse(
        manager.send(
          'a0123456789abcdef',
          'continue after cancellation',
          undefined,
          'call_late',
        ),
      ),
    ).toMatchObject({ success: true })
    await expect(
      manager.output('a0123456789abcdef', { block: true, timeout: 30_000 }),
    ).resolves.toContain('CONTINUED')
    expect(calls).toEqual([
      { message: 'initial prompt', continuation: false },
      { message: 'continue after cancellation', continuation: true },
    ])
  })

  it('does not report cancellation success when the source ends orphaned', async () => {
    const controlled = controllableLifecycle()
    let rejectRun!: (error: Error) => void
    const manager = new BackgroundAgentManager()
    manager.launch({
      ...spec(
        () =>
          new Promise<BackgroundAgentRunResult>((_resolve, reject) => {
            rejectRun = reject
          }),
      ),
      lifecycle: controlled.lifecycle,
    })
    controlled.publish('running')

    const stopping = manager.stopAndWait('a0123456789abcdef', 30_000)
    controlled.publish('orphaned')
    rejectRun(new Error('orphan diagnostic'))

    await expect(stopping).resolves.toBe(
      'Task a0123456789abcdef cancellation ended with status interrupted',
    )
    expect(
      await manager.output('a0123456789abcdef', {
        block: false,
        timeout: 30_000,
      }),
    ).toContain('<status>interrupted</status>')
  })

  it('retains queued messages through orphaning and recovers them in FIFO order', async () => {
    const controlled = controllableLifecycle()
    const calls: { message: string; continuation: boolean }[] = []
    const finishers: ((result: BackgroundAgentRunResult) => void)[] = []
    const manager = new BackgroundAgentManager()
    manager.launch({
      ...spec(
        (message, _signal, continuation) =>
          new Promise((resolve) => {
            calls.push({ message, continuation })
            finishers.push(resolve)
          }),
      ),
      lifecycle: controlled.lifecycle,
    })
    controlled.publish('running')
    manager.send(
      'a0123456789abcdef',
      'accepted while live',
      undefined,
      'call_queued',
    )

    controlled.publish('orphaned')
    finishers[0]?.(completed('FIRST'))
    await expect(
      manager.output('a0123456789abcdef', { block: true, timeout: 30_000 }),
    ).resolves.toContain('<status>interrupted</status>')

    manager.send(
      'a0123456789abcdef',
      'recovery trigger',
      undefined,
      'call_recovery',
    )
    expect(calls).toEqual([
      { message: 'initial prompt', continuation: false },
      { message: 'accepted while live', continuation: true },
    ])
    controlled.publish('completed')
    finishers[1]?.(completed('QUEUED_RESULT'))
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(calls).toEqual([
      { message: 'initial prompt', continuation: false },
      { message: 'accepted while live', continuation: true },
      { message: 'recovery trigger', continuation: true },
    ])
    controlled.publish('completed')
    finishers[2]?.(completed('RECOVERY_RESULT'))
    await expect(
      manager.output('a0123456789abcdef', { block: true, timeout: 30_000 }),
    ).resolves.toContain('RECOVERY_RESULT')
  })

  it('reconciles a transcript-delivered notification before redelivery', async () => {
    const acknowledgeNotification = vi.fn(async () => undefined)
    const manager = new BackgroundAgentManager()
    manager.launch({
      ...spec(async () => completed('DELIVERED_RESULT')),
      acknowledgeNotification,
    })
    await manager.output('a0123456789abcdef', {
      block: true,
      timeout: 30_000,
    })
    await expect(
      manager.notifications({ waitForRunning: false, consume: false }),
    ).resolves.toMatchObject({ messages: [expect.any(String)] })

    await manager.acknowledgeDelivered(
      ({ agentId, toolUseId, status }) =>
        agentId === 'a0123456789abcdef' &&
        toolUseId === 'call_agent' &&
        status === 'completed',
    )

    expect(acknowledgeNotification).toHaveBeenCalledOnce()
    await expect(
      manager.notifications({ waitForRunning: false, consume: false }),
    ).resolves.toEqual({
      messages: [],
      usage: { inputTokens: 0, outputTokens: 0 },
    })
  })

  it('wakes a notification waiter when a noncooperative manager closes', async () => {
    const manager = new BackgroundAgentManager()
    manager.launch(spec(() => new Promise(() => undefined)))
    const waiting = manager.notifications({
      waitForRunning: true,
      consume: false,
    })

    await manager.close(0)

    await expect(waiting).resolves.toEqual({
      messages: [],
      usage: { inputTokens: 0, outputTokens: 0 },
    })
  })

  it('reports timeout retrieval status for zero and expired block waits', async () => {
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

    // Non-blocking retrieval of a live task stays not_ready.
    await expect(
      manager.output('a0123456789abcdef', { block: false, timeout: 0 }),
    ).resolves.toContain('<retrieval_status>not_ready</retrieval_status>')

    // block: true with timeout 0 returns an immediate timeout without waiting.
    await expect(
      manager.output('a0123456789abcdef', { block: true, timeout: 0 }),
    ).resolves.toContain('<retrieval_status>timeout</retrieval_status>')
    expect(manager.snapshots()[0]?.status).toBe('running')

    // An expired positive block timeout returns timeout and leaves the task live.
    await expect(
      manager.output('a0123456789abcdef', { block: true, timeout: 10 }),
    ).resolves.toContain('<retrieval_status>timeout</retrieval_status>')
    expect(manager.snapshots()[0]?.status).toBe('running')

    // Resolving before a positive timeout returns success.
    const blocking = manager.output('a0123456789abcdef', {
      block: true,
      timeout: 30_000,
    })
    finish?.(completed('RESULT'))
    await expect(blocking).resolves.toContain(
      '<retrieval_status>success</retrieval_status>',
    )

    // Timed-out retrievals never consumed the completion notification.
    await expect(
      manager.notifications({ waitForRunning: false }),
    ).resolves.toEqual({
      messages: [expect.stringContaining('<result>RESULT</result>')],
      usage: { inputTokens: 2, outputTokens: 1 },
    })
  })

  it('returns API durations once and preserves an explicit zero retry-free duration', async () => {
    const manager = new BackgroundAgentManager()
    manager.launch(
      spec(async () => ({
        ...completed('DURATION_RESULT'),
        durationApiMs: 12,
        durationApiWithoutRetriesMs: 0,
      })),
    )

    const first = await manager.notifications({ waitForRunning: true })
    expect(first).toMatchObject({
      messages: [expect.stringContaining('<result>DURATION_RESULT</result>')],
      usage: { inputTokens: 2, outputTokens: 1 },
      durationApiMs: 12,
      durationApiWithoutRetriesMs: 0,
    })
    await expect(
      manager.notifications({ waitForRunning: false }),
    ).resolves.toEqual({
      messages: [],
      usage: { inputTokens: 0, outputTokens: 0 },
    })
  })

  it('rejects invalid API durations without consuming their notification', async () => {
    const manager = new BackgroundAgentManager()
    manager.launch(
      spec(async () => ({
        ...completed('INVALID_DURATION'),
        durationApiMs: -1,
      })),
    )
    await manager.output('a0123456789abcdef', { block: true, timeout: 30_000 })

    await expect(
      manager.notifications({ waitForRunning: false }),
    ).rejects.toThrow('durationApiMs must be a finite nonnegative number')
    await expect(
      manager.notifications({ waitForRunning: false }),
    ).rejects.toThrow('durationApiMs must be a finite nonnegative number')
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

  it('boundedly drains close, clears live registrations, and emits no shutdown notification', async () => {
    let aborted = false
    const manager = new BackgroundAgentManager()
    manager.launch(
      spec(
        (_message, signal) =>
          new Promise(() => {
            signal.addEventListener(
              'abort',
              () => {
                aborted = true
              },
              { once: true },
            )
          }),
      ),
    )

    await expect(manager.close(10)).resolves.toBeUndefined()

    expect(aborted).toBe(true)
    expect(manager.snapshots()).toEqual([])
    await expect(
      manager.notifications({ waitForRunning: false }),
    ).resolves.toEqual({
      messages: [],
      usage: { inputTokens: 0, outputTokens: 0 },
    })
    expect(() => manager.launch(spec(async () => completed('late')))).toThrow(
      'manager is closed',
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
    const { messages } = await manager.notifications({ waitForRunning: false })
    expect(messages).toEqual([
      expect.stringContaining('<result>aborted</result>'),
    ])
    // Worktree metadata stays in the retrieval output, not the notification.
    expect(messages[0]).not.toContain('worktree-path')
    expect(messages[0]).not.toContain('worktree-warning')
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
        cacheCreationInputTokens1h: 1,
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
        cacheCreationInputTokens1h: 2,
        webSearchRequests: 2,
      },
      modelUsage: {
        'model-b': {
          inputTokens: 10,
          outputTokens: 5,
          cacheCreationInputTokens: 8,
          cacheCreationInputTokens1h: 4,
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
      cacheCreationInputTokens1h: 3,
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
        cacheCreationInputTokens1h: 4,
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

    const invalidAggregate = new BackgroundAgentManager()
    invalidAggregate.launch(
      spec(async () => ({
        text: 'BAD',
        usage: {
          inputTokens: 2,
          outputTokens: 1,
          cacheCreationInputTokens: 1,
          cacheCreationInputTokens1h: 2,
        },
        toolUseCount: 1,
        durationMs: 5,
      })),
    )
    await invalidAggregate.output('a0123456789abcdef', {
      block: true,
      timeout: 30_000,
    })
    await expect(
      invalidAggregate.notifications({ waitForRunning: false }),
    ).rejects.toThrow('invalid cacheCreationInputTokens1h counter')

    const invalidModel = new BackgroundAgentManager()
    invalidModel.launch(
      runWithModelUsage({
        'model-a': {
          inputTokens: 1,
          outputTokens: 1,
          cacheCreationInputTokens: 1,
          cacheCreationInputTokens1h: 2,
        },
      }),
    )
    await invalidModel.output('a0123456789abcdef', {
      block: true,
      timeout: 30_000,
    })
    await expect(
      invalidModel.notifications({ waitForRunning: false }),
    ).rejects.toThrow('invalid cacheCreationInputTokens1h counter')

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

  it('preserves known capability metadata across merged raw-model notifications', async () => {
    const manager = new BackgroundAgentManager()
    manager.launch(
      spec(async (_message, _signal, continuation) => ({
        text: continuation ? 'SECOND' : 'FIRST',
        usage: { inputTokens: 5, outputTokens: 2 },
        toolUseCount: 1,
        durationMs: 5,
        modelUsage: {
          'metadata-model': {
            inputTokens: 5,
            outputTokens: 2,
            contextWindow: 200_000,
            maxOutputTokens: 32_000,
          },
        },
      })),
    )
    await manager.output('a0123456789abcdef', {
      block: true,
      timeout: 30_000,
    })
    expect(
      manager.send(
        'a0123456789abcdef',
        'continue',
        'continue',
        'call_continue',
      ),
    ).toContain('"success":true')
    await manager.output('a0123456789abcdef', {
      block: true,
      timeout: 30_000,
    })

    const consumed = await manager.notifications({ waitForRunning: false })
    // Equal known metadata merges without conflict while counters sum.
    expect(consumed.modelUsage).toEqual({
      'metadata-model': {
        inputTokens: 10,
        outputTokens: 4,
        contextWindow: 200_000,
        maxOutputTokens: 32_000,
      },
    })
    // The aggregate usage stays counter-only.
    expect(consumed.usage).toEqual({
      inputTokens: 10,
      outputTokens: 4,
    })
  })

  it('rejects conflicting known metadata before any raw-model row is merged', async () => {
    const manager = new BackgroundAgentManager()
    manager.launch(
      spec(async (_message, _signal, continuation) => ({
        text: continuation ? 'SECOND' : 'FIRST',
        usage: { inputTokens: 5, outputTokens: 2 },
        toolUseCount: 1,
        durationMs: 5,
        modelUsage: continuation
          ? {
              // A valid new model in the same batch as the conflicting row: the
              // whole notification batch must reject before any row is visible.
              'other-model': { inputTokens: 1, outputTokens: 1 },
              'metadata-model': {
                inputTokens: 5,
                outputTokens: 2,
                contextWindow: 100_000,
                maxOutputTokens: 16_000,
              },
            }
          : {
              'metadata-model': {
                inputTokens: 5,
                outputTokens: 2,
                contextWindow: 200_000,
                maxOutputTokens: 32_000,
              },
            },
      })),
    )
    await manager.output('a0123456789abcdef', {
      block: true,
      timeout: 30_000,
    })
    expect(
      manager.send(
        'a0123456789abcdef',
        'continue',
        'continue',
        'call_continue',
      ),
    ).toContain('"success":true')
    await manager.output('a0123456789abcdef', {
      block: true,
      timeout: 30_000,
    })

    await expect(
      manager.notifications({ waitForRunning: false }),
    ).rejects.toThrow(
      'Model usage for "metadata-model" has conflicting contextWindow values: 200000 vs 100000',
    )
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

  it('serializes a completed notification with contract fields and total_tokens', async () => {
    const manager = new BackgroundAgentManager()
    manager.launch(spec(async () => completed('DONE')))
    const { messages } = await manager.notifications({ waitForRunning: true })
    const message = messages[0]
    expect(message).toContain('<task-id>a0123456789abcdef</task-id>')
    expect(message).toContain('<tool-use-id>call_agent</tool-use-id>')
    expect(message).toContain('<output-file>/tmp/agent.output</output-file>')
    expect(message).toContain('<status>completed</status>')
    expect(message).toContain(
      '<summary>Agent &quot;test agent&quot; finished</summary>',
    )
    expect(message).toContain('<result>DONE</result>')
    expect(message).toContain(
      '<usage><total_tokens>3</total_tokens><tool_uses>1</tool_uses><duration_ms>5</duration_ms></usage>',
    )
    expect(message).not.toContain('<note>')
    expect(message).not.toContain('subagent_tokens')
    expect(message).not.toContain('worktree-path')
    expect(message).not.toContain('worktree-warning')
  })

  it('serializes a stopped task notification as killed without deprecated tags', async () => {
    const manager = new BackgroundAgentManager()
    manager.launch(
      spec(
        (_message, signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => reject(new Error('aborted')),
              { once: true },
            )
          }),
      ),
    )
    manager.stop('a0123456789abcdef')
    await manager.output('a0123456789abcdef', {
      block: true,
      timeout: 30_000,
    })
    const { messages } = await manager.notifications({ waitForRunning: true })
    const message = messages[0]
    expect(message).toContain('<status>killed</status>')
    expect(message).not.toContain('<status>stopped</status>')
    expect(message).toContain(
      '<usage><total_tokens>0</total_tokens><tool_uses>0</tool_uses><duration_ms>0</duration_ms></usage>',
    )
    expect(message).not.toContain('<note>')
    expect(message).not.toContain('subagent_tokens')
    expect(message).not.toContain('worktree-path')
    expect(message).not.toContain('worktree-warning')
  })

  it('explicitly bulk-kills every live task and emits each killed notification once', async () => {
    const manager = new BackgroundAgentManager()
    const run = (_message: string, signal: AbortSignal) =>
      new Promise<BackgroundAgentRunResult>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        })
      })
    manager.launch(spec(run))
    manager.launch({
      ...spec(run),
      agentId: 'a1123456789abcdef',
      toolUseId: 'call_agent_two',
      outputFile: '/tmp/agent-two.output',
    })
    manager.registerPersisted(
      {
        ...spec(async () => completed('already done'), 'completed'),
        agentId: 'a2123456789abcdef',
      },
      { result: completed('already done') },
    )

    expect(manager.stopAll()).toEqual([
      'a0123456789abcdef',
      'a1123456789abcdef',
    ])
    expect(manager.stopAll()).toEqual([])
    await Promise.all(
      ['a0123456789abcdef', 'a1123456789abcdef'].map((agentId) =>
        manager.output(agentId, { block: true, timeout: 30_000 }),
      ),
    )

    const first = await manager.notifications({ waitForRunning: false })
    expect(first.messages).toHaveLength(2)
    expect(first.messages).toEqual([
      expect.stringContaining('<tool-use-id>call_agent</tool-use-id>'),
      expect.stringContaining('<tool-use-id>call_agent_two</tool-use-id>'),
    ])
    expect(
      first.messages.every((message) =>
        message.includes('<status>killed</status>'),
      ),
    ).toBe(true)
    await expect(
      manager.notifications({ waitForRunning: false }),
    ).resolves.toEqual({
      messages: [],
      usage: { inputTokens: 0, outputTokens: 0 },
    })
  })
})
