import { describe, expect, it } from 'vitest'

import {
  createTuiRuntimeKernelState,
  reduceTuiRuntimeKernel,
} from './tui-runtime-kernel.js'

describe('TUI runtime kernel', () => {
  it('creates the documented defaults and accepts initial values', () => {
    expect(createTuiRuntimeKernelState()).toEqual({
      busy: false,
      status: 'ready',
      activeText: '',
      activeThinking: '',
    })
    expect(
      createTuiRuntimeKernelState({ busy: true, status: 'working' }),
    ).toEqual({
      busy: true,
      status: 'working',
      activeText: '',
      activeThinking: '',
    })
  })

  it('reduces busy and status transitions', () => {
    const initial = createTuiRuntimeKernelState()
    const busy = reduceTuiRuntimeKernel(initial, {
      type: 'set-busy',
      busy: true,
    })
    expect(busy.busy).toBe(true)
    expect(
      reduceTuiRuntimeKernel(busy, { type: 'set-status', status: 'working' }),
    ).toEqual({
      ...busy,
      status: 'working',
    })
  })

  it('publishes text and thinking atomically', () => {
    const state = reduceTuiRuntimeKernel(createTuiRuntimeKernelState(), {
      type: 'publish-stream-frame',
      text: 'answer',
      thinking: 'reasoning',
    })
    expect(state).toEqual({
      busy: false,
      status: 'ready',
      activeText: 'answer',
      activeThinking: 'reasoning',
    })
  })

  it('returns the same object for no-op transitions', () => {
    const state = createTuiRuntimeKernelState({
      busy: true,
      status: 'working',
      activeText: 'answer',
      activeThinking: 'reasoning',
    })
    expect(
      reduceTuiRuntimeKernel(state, { type: 'set-busy', busy: true }),
    ).toBe(state)
    expect(
      reduceTuiRuntimeKernel(state, { type: 'set-status', status: 'working' }),
    ).toBe(state)
    expect(
      reduceTuiRuntimeKernel(state, {
        type: 'publish-stream-frame',
        text: 'answer',
        thinking: 'reasoning',
      }),
    ).toBe(state)
    const empty = createTuiRuntimeKernelState()
    expect(reduceTuiRuntimeKernel(empty, { type: 'reset-stream' })).toBe(empty)
  })

  it('resets both stream fields while preserving runtime flags', () => {
    const state = createTuiRuntimeKernelState({
      busy: true,
      status: 'working',
      activeText: 'answer',
      activeThinking: 'reasoning',
    })
    expect(reduceTuiRuntimeKernel(state, { type: 'reset-stream' })).toEqual({
      busy: true,
      status: 'working',
      activeText: '',
      activeThinking: '',
    })
  })
})
