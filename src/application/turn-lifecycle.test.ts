import { describe, expect, it, vi } from 'vitest'

import { AgentRunCancelledError } from '../core/runtime.js'
import { TurnTerminalController } from './turn-lifecycle.js'

describe('TurnTerminalController', () => {
  it('filters inner terminal states and emits one outer terminal state', () => {
    const events: unknown[] = []
    const controller = new TurnTerminalController((event) => events.push(event))

    controller.emit({ type: 'state', state: 'completed' })
    controller.emit({ type: 'state', state: 'cancelled' })
    controller.emit({ type: 'state', state: 'assembling-context' })
    controller.emit({ type: 'text-delta', delta: 'hello' })
    controller.emit({ type: 'state', state: 'persisting-results' })
    controller.emit({ type: 'failed', message: 'diagnostic', retryable: false })
    controller.complete()

    expect(events).toEqual([
      { type: 'state', state: 'assembling-context' },
      { type: 'text-delta', delta: 'hello' },
      { type: 'state', state: 'persisting-results' },
      { type: 'failed', message: 'diagnostic', retryable: false },
      { type: 'state', state: 'completed' },
    ])
    expect(() => controller.complete()).toThrow(
      'Turn terminal transition already emitted',
    )
  })

  it('classifies failure and cancellation exactly once', () => {
    const failed = vi.fn()
    const controller = new TurnTerminalController(failed)
    controller.fail(new Error('boom'))
    expect(failed).toHaveBeenCalledWith({ type: 'state', state: 'failed' })
    expect(() => controller.fail(new Error('again'))).not.toThrow()
    expect(failed).toHaveBeenCalledTimes(1)

    const cancelled = vi.fn()
    const cancellation = new TurnTerminalController(cancelled)
    cancellation.fail(new AgentRunCancelledError())
    expect(cancelled).toHaveBeenCalledWith({
      type: 'state',
      state: 'cancelled',
    })
  })

  it('does not replace a terminal sink error with a second transition', () => {
    const sinkError = new Error('terminal sink failed')
    const events: unknown[] = []
    const controller = new TurnTerminalController((event) => {
      events.push(event)
      throw sinkError
    })

    expect(() => controller.complete()).toThrow(sinkError)
    expect(() => controller.fail(sinkError)).not.toThrow()
    expect(events).toEqual([{ type: 'state', state: 'completed' }])
  })
})
