import { describe, expect, it } from 'vitest'

import { createTuiStoreState, reduceTuiStore } from './tui-store.js'

describe('TUI store', () => {
  it('creates runtime and composer defaults', () => {
    expect(createTuiStoreState()).toEqual({
      busy: false,
      status: 'ready',
      activeText: '',
      activeThinking: '',
      composer: { text: '', cursor: 0 },
    })
  })

  it('clamps composer cursors to JavaScript string length', () => {
    expect(
      createTuiStoreState({
        composer: { text: '😀a', cursor: 99 },
      }).composer.cursor,
    ).toBe(3)
    expect(
      createTuiStoreState({
        composer: { text: 'abc', cursor: -1 },
      }).composer.cursor,
    ).toBe(0)
    expect(
      createTuiStoreState({
        composer: { text: 'abc', cursor: Number.NaN },
      }).composer.cursor,
    ).toBe(0)
  })

  it('preserves identity for no-op actions', () => {
    const state = createTuiStoreState({
      composer: { text: 'hello', cursor: 2 },
    })
    expect(
      reduceTuiStore(state, { type: 'set-composer', text: 'hello', cursor: 2 }),
    ).toBe(state)
    expect(reduceTuiStore(state, { type: 'set-busy', busy: false })).toBe(state)
  })

  it('preserves composer state across runtime transitions', () => {
    const state = createTuiStoreState({
      composer: { text: 'hello', cursor: 2 },
    })
    const next = reduceTuiStore(state, {
      type: 'set-status',
      status: 'working',
    })
    expect(next.status).toBe('working')
    expect(next.composer).toBe(state.composer)
  })

  it('publishes stream frames atomically and reset preserves composer', () => {
    const state = createTuiStoreState({
      composer: { text: 'hello', cursor: 2 },
    })
    const published = reduceTuiStore(state, {
      type: 'publish-stream-frame',
      text: 'answer',
      thinking: 'reasoning',
    })
    expect(published.activeText).toBe('answer')
    expect(published.activeThinking).toBe('reasoning')
    const reset = reduceTuiStore(published, { type: 'reset-stream' })
    expect(reset.activeText).toBe('')
    expect(reset.activeThinking).toBe('')
    expect(reset.composer).toBe(state.composer)
  })
})
