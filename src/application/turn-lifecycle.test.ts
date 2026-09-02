import { describe, expect, it, vi } from 'vitest'

import {
  AgentRunCancelledError,
  ModelProviderError,
  type RuntimeEvent,
} from '../core/runtime.js'
import { TurnCoordinator, type TurnRequest } from './turn-lifecycle.js'

const request = (
  sessionId = 'session-1',
  submission: TurnRequest['submission'] = { kind: 'prompt', text: 'hello' },
): TurnRequest => ({
  activation: { kind: 'start', sessionId },
  submission,
})

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

const createCoordinator = (events: RuntimeEvent[] = []) =>
  new TurnCoordinator({
    eventSink: (event) => events.push(event),
    createSteeringId: (() => {
      let next = 0
      return () => `steering-${++next}`
    })(),
  })

describe('TurnCoordinator', () => {
  it('registers synchronously, rejects a duplicate, and cleans up after completion', async () => {
    const events: RuntimeEvent[] = []
    const coordinator = createCoordinator(events)
    const gate = deferred()
    let started = false
    const run = coordinator.run(request(), async () => {
      started = true
      await gate.promise
      return 'done'
    })

    expect(started).toBe(true)
    await expect(
      coordinator.run(request(), async () => 'other'),
    ).rejects.toThrow(
      'conflict: locked (session session-1 already has an active turn)',
    )
    expect(
      events.filter(
        (event) => event.type === 'state' && event.state === 'failed',
      ),
    ).toHaveLength(1)
    gate.resolve()
    await expect(run).resolves.toBe('done')
    expect(
      events.filter(
        (event) => event.type === 'state' && event.state === 'completed',
      ),
    ).toHaveLength(1)
    expect(events).toContainEqual({ type: 'state', state: 'completed' })
    await expect(coordinator.run(request(), async () => 'later')).resolves.toBe(
      'later',
    )
  })

  it('validates before conflict, emits failure, and leaves the first run active', async () => {
    const events: RuntimeEvent[] = []
    const coordinator = createCoordinator(events)
    const gate = deferred()
    const first = coordinator.run(request(), async () => gate.promise)

    await expect(
      coordinator.run(
        request('session-1', { kind: 'prompt', text: '' }),
        async () => undefined,
      ),
    ).rejects.toThrow('Prompt must not be empty')
    expect(
      events.filter(
        (event) => event.type === 'state' && event.state === 'failed',
      ),
    ).toHaveLength(1)
    expect(coordinator.steer('session-1', 'still active').kind).toBe('accepted')

    gate.resolve()
    await first
    expect(
      events.filter(
        (event) => event.type === 'state' && event.state === 'completed',
      ),
    ).toHaveLength(1)
  })

  it('classifies a pre-aborted invalid request as cancelled without disturbing the active turn', async () => {
    const events: RuntimeEvent[] = []
    const coordinator = createCoordinator(events)
    const gate = deferred()
    const first = coordinator.run(request(), async () => gate.promise)
    const controller = new AbortController()
    controller.abort()

    await expect(
      coordinator.run(
        {
          ...request('session-1', { kind: 'prompt', text: '' }),
          signal: controller.signal,
        },
        async () => undefined,
      ),
    ).rejects.toThrow('Prompt must not be empty')
    expect(
      events.filter(
        (event) => event.type === 'state' && event.state === 'cancelled',
      ),
    ).toHaveLength(1)
    expect(
      events.filter(
        (event) => event.type === 'state' && event.state === 'failed',
      ),
    ).toHaveLength(0)
    expect(coordinator.steer('session-1', 'still active').kind).toBe('accepted')

    gate.resolve()
    await first
    await expect(
      coordinator.run(request(), async () => 'reused'),
    ).resolves.toBe('reused')
  })

  it('filters inner terminal states and emits one outer terminal state', async () => {
    const events: RuntimeEvent[] = []
    const coordinator = createCoordinator(events)

    await coordinator.run(request(), async ({ emit }) => {
      emit({ type: 'state', state: 'completed' })
      emit({ type: 'state', state: 'cancelled' })
      emit({ type: 'state', state: 'assembling-context' })
      emit({ type: 'text-delta', delta: 'hello' })
      emit({ type: 'state', state: 'persisting-results' })
      emit({ type: 'failed', message: 'diagnostic', retryable: false })
      return undefined
    })

    expect(events).toEqual([
      { type: 'state', state: 'assembling-context' },
      { type: 'text-delta', delta: 'hello' },
      { type: 'state', state: 'persisting-results' },
      { type: 'failed', message: 'diagnostic', retryable: false },
      { type: 'state', state: 'completed' },
    ])
  })

  it('translates steering commands and exposes no steering for shell turns', async () => {
    const coordinator = createCoordinator()
    const gate = deferred()
    let steering: TurnRequest['submission'] | undefined
    const run = coordinator.run(request(), async (scope) => {
      expect(scope.steering).toBeDefined()
      const accepted = coordinator.steer('session-1', ' follow up ')
      expect(accepted.kind).toBe('accepted')
      steering = { kind: 'prompt', text: scope.steering?.take()?.content ?? '' }
      await gate.promise
    })
    expect(steering).toEqual({ kind: 'prompt', text: 'follow up' })
    expect(coordinator.steer('session-1', '   ')).toEqual({ kind: 'empty' })
    const shellGate = deferred()
    const shellRun = coordinator.run(
      request('shell-session', { kind: 'shell', command: 'printf hi' }),
      async (scope) => {
        expect(scope.steering).toBeUndefined()
        await shellGate.promise
      },
    )
    expect(coordinator.steer('shell-session', 'no')).toEqual({
      kind: 'not-steerable',
    })
    shellGate.resolve()
    gate.resolve()
    await Promise.all([run, shellRun])
  })

  it('supports withdrawal and reports sealed or missing turns', async () => {
    const coordinator = createCoordinator()
    const gate = deferred()
    const run = coordinator.run(request(), async ({ steering }) => {
      const accepted = coordinator.steer('session-1', 'pending')
      expect(accepted.kind).toBe('accepted')
      if (accepted.kind === 'accepted') {
        expect(
          coordinator.withdrawSteering('session-1', accepted.item.id),
        ).toEqual({ kind: 'withdrawn', item: accepted.item })
        expect(
          coordinator.withdrawSteering('session-1', accepted.item.id),
        ).toEqual({ kind: 'not-pending' })
      }
      steering?.takeOrSeal()
      expect(coordinator.steer('session-1', 'after seal')).toEqual({
        kind: 'turn-completing',
      })
      await gate.promise
    })
    gate.resolve()
    await run
    expect(coordinator.steer('session-1', 'after')).toEqual({
      kind: 'no-active-turn',
    })
    expect(coordinator.withdrawSteering('session-1', 'missing')).toEqual({
      kind: 'no-active-turn',
    })
  })

  it('classifies failed and cancelled work and rejects pending steering', async () => {
    const events: RuntimeEvent[] = []
    const coordinator = createCoordinator(events)
    const failedGate = deferred()
    const failedRun = coordinator.run(request('failed'), async () => {
      expect(coordinator.steer('failed', 'pending')).toMatchObject({
        kind: 'accepted',
      })
      await failedGate.promise
      throw new Error('boom')
    })
    failedGate.resolve()
    await expect(failedRun).rejects.toThrow('boom')
    expect(events).toContainEqual({ type: 'state', state: 'failed' })
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'user-input-rejected',
        reason: 'failed',
      }),
    )
    await expect(
      coordinator.run(request('failed'), async () => 'retry after failure'),
    ).resolves.toBe('retry after failure')

    const controller = new AbortController()
    const cancelledRun = coordinator.run(
      { ...request('cancelled'), signal: controller.signal },
      async () => {
        expect(coordinator.steer('cancelled', 'pending')).toMatchObject({
          kind: 'accepted',
        })
        controller.abort()
        throw new AgentRunCancelledError()
      },
    )
    await expect(cancelledRun).rejects.toBeInstanceOf(AgentRunCancelledError)
    expect(events).toContainEqual({ type: 'state', state: 'cancelled' })
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'user-input-rejected',
        reason: 'cancelled',
      }),
    )

    const providerCancelledRun = coordinator.run(
      request('provider-cancelled'),
      async () => {
        expect(
          coordinator.steer('provider-cancelled', 'pending'),
        ).toMatchObject({
          kind: 'accepted',
        })
        throw new ModelProviderError('provider cancelled', {
          retryable: false,
          kind: 'cancelled',
        })
      },
    )
    await expect(providerCancelledRun).rejects.toBeInstanceOf(
      ModelProviderError,
    )
    expect(events).toContainEqual({ type: 'state', state: 'cancelled' })
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'user-input-rejected',
        reason: 'cancelled',
      }),
    )
    await expect(
      coordinator.run(
        request('provider-cancelled'),
        async () => 'retry after cancellation',
      ),
    ).resolves.toBe('retry after cancellation')
  })

  it('seals pending steering on close and keeps shell records until their work exits', async () => {
    const events: RuntimeEvent[] = []
    const coordinator = createCoordinator(events)
    const promptGate = deferred()
    const promptRun = coordinator.run(request('prompt'), async () => {
      expect(coordinator.steer('prompt', 'pending')).toMatchObject({
        kind: 'accepted',
      })
      await promptGate.promise
    })
    coordinator.close()
    coordinator.close()
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'user-input-rejected',
        reason: 'closed',
      }),
    )
    expect(coordinator.steer('prompt', 'after close')).toEqual({
      kind: 'turn-completing',
    })

    const shellGate = deferred()
    const shellRun = coordinator.run(
      request('shell', { kind: 'shell', command: 'printf hi' }),
      async () => shellGate.promise,
    )
    coordinator.close()
    expect(coordinator.steer('shell', 'no')).toEqual({ kind: 'not-steerable' })
    shellGate.resolve()
    promptGate.resolve()
    await Promise.all([promptRun, shellRun])
  })

  it('seals before a terminal sink error and unregisters the run', async () => {
    const sinkError = new Error('terminal sink failed')
    let failTerminal = true
    const sink = vi.fn((event: RuntimeEvent) => {
      if (event.type === 'state' && event.state === 'completed')
        if (failTerminal) {
          failTerminal = false
          throw sinkError
        }
    })
    const coordinator = new TurnCoordinator({
      eventSink: sink,
      createSteeringId: () => 'steering',
    })
    await expect(
      coordinator.run(request(), async () => undefined),
    ).rejects.toBe(sinkError)
    expect(sink).toHaveBeenCalledTimes(1)
    await expect(coordinator.run(request(), async () => 'later')).resolves.toBe(
      'later',
    )
  })

  it('processes every mailbox before rethrowing the first close sink error', async () => {
    const firstError = new Error('first pending rejection failed')
    const events: RuntimeEvent[] = []
    let throwFirst = true
    const sink = vi.fn((event: RuntimeEvent) => {
      if (event.type === 'user-input-rejected' && throwFirst) {
        throwFirst = false
        throw firstError
      }
      events.push(event)
    })
    const coordinator = new TurnCoordinator({
      eventSink: sink,
      createSteeringId: (() => {
        let next = 0
        return () => `steering-${++next}`
      })(),
    })
    const one = deferred()
    const two = deferred()
    const runOne = coordinator.run(request('one'), async () => one.promise)
    const runTwo = coordinator.run(request('two'), async () => two.promise)
    expect(coordinator.steer('one', 'first pending')).toMatchObject({
      kind: 'accepted',
    })
    expect(coordinator.steer('two', 'second pending')).toMatchObject({
      kind: 'accepted',
    })

    expect(() => coordinator.close()).toThrow(firstError)
    expect(coordinator.steer('one', 'sealed')).toEqual({
      kind: 'turn-completing',
    })
    expect(coordinator.steer('two', 'sealed')).toEqual({
      kind: 'turn-completing',
    })
    expect(
      events.filter((event) => event.type === 'user-input-rejected'),
    ).toHaveLength(1)
    expect(sink).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'user-input-rejected',
        content: 'second pending',
        reason: 'closed',
      }),
    )
    one.resolve()
    two.resolve()
    await Promise.all([runOne, runTwo])
  })
})
