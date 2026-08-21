import { describe, expect, it } from 'vitest'

import { createComposerEditor } from './composer-editor.js'
import { insertComposerImageMarker } from './composer-images.js'
import { routeComposerKey } from './composer-key-router.js'

const projection = (
  overrides: {
    value?: string
    left?: boolean
    right?: boolean
    backspace?: boolean
    delete?: boolean
    ctrl?: boolean
    meta?: boolean
    escape?: boolean
  } = {},
) => ({
  value: '',
  left: false,
  right: false,
  backspace: false,
  delete: false,
  ctrl: false,
  meta: false,
  escape: false,
  ...overrides,
})

describe('composer key router', () => {
  it('inserts printable input as an edit transition', () => {
    const result = routeComposerKey(
      createComposerEditor('a😀b', 2),
      projection({ value: 'X' }),
    )
    expect(result).toEqual({
      kind: 'edit',
      editor: { text: 'a😀Xb', cursor: 3 },
    })
  })

  it('delegates arrows to image-aware movement and Meta to word movement', () => {
    const text = 'a[Image #12]b'
    expect(
      routeComposerKey(
        createComposerEditor(text, 12),
        projection({ left: true }),
      ),
    ).toEqual({ kind: 'edit', editor: { text, cursor: 1 } })
    expect(
      routeComposerKey(
        createComposerEditor(text, 1),
        projection({ right: true }),
      ),
    ).toEqual({ kind: 'edit', editor: { text, cursor: 12 } })
    expect(
      routeComposerKey(
        createComposerEditor('hello world'),
        projection({ left: true, meta: true }),
      ),
    ).toEqual({ kind: 'edit', editor: { text: 'hello world', cursor: 6 } })
  })

  it('delegates Backspace/Delete to atomic image-marker deletion', () => {
    const text = 'a[Image #12]b'
    expect(
      routeComposerKey(
        createComposerEditor(text, 12),
        projection({ backspace: true }),
      ),
    ).toEqual({ kind: 'edit', editor: { text: 'ab', cursor: 1 } })
    expect(
      routeComposerKey(
        createComposerEditor(text, 1),
        projection({ delete: true }),
      ),
    ).toEqual({ kind: 'edit', editor: { text: 'ab', cursor: 1 } })
  })

  it('routes Ctrl-W/U/K to word, start, and end deletion', () => {
    const atEnd = createComposerEditor('review local changes')
    expect(
      routeComposerKey(atEnd, projection({ ctrl: true, value: 'w' })),
    ).toEqual({ kind: 'edit', editor: { text: 'review local ', cursor: 13 } })
    const atStart = createComposerEditor('review local changes', 13)
    expect(
      routeComposerKey(atStart, projection({ ctrl: true, value: 'u' })),
    ).toEqual({ kind: 'edit', editor: { text: 'changes', cursor: 0 } })
    expect(
      routeComposerKey(atStart, projection({ ctrl: true, value: 'k' })),
    ).toEqual({ kind: 'edit', editor: { text: 'review local ', cursor: 13 } })
  })

  it('routes Ctrl-A/E and Ctrl-B/F cursor movement', () => {
    const state = createComposerEditor('abcdef', 3)
    expect(
      routeComposerKey(state, projection({ ctrl: true, value: 'a' })),
    ).toEqual({ kind: 'edit', editor: { text: 'abcdef', cursor: 0 } })
    expect(
      routeComposerKey(state, projection({ ctrl: true, value: 'e' })),
    ).toEqual({ kind: 'edit', editor: { text: 'abcdef', cursor: 6 } })
    expect(
      routeComposerKey(state, projection({ ctrl: true, value: 'b' })),
    ).toEqual({ kind: 'edit', editor: { text: 'abcdef', cursor: 2 } })
    expect(
      routeComposerKey(state, projection({ ctrl: true, value: 'f' })),
    ).toEqual({ kind: 'edit', editor: { text: 'abcdef', cursor: 4 } })
  })

  it('recognizes raw control characters without a ctrl flag', () => {
    const state = createComposerEditor('abcdef', 3)
    expect(
      routeComposerKey(state, projection({ value: String.fromCharCode(1) })),
    ).toEqual({ kind: 'edit', editor: { text: 'abcdef', cursor: 0 } })
  })

  it('returns a pure cancel result for Escape without mutating state', () => {
    const state = createComposerEditor('hello')
    const result = routeComposerKey(state, projection({ escape: true }))
    expect(result).toEqual({ kind: 'cancel' })
    expect(state).toEqual({ text: 'hello', cursor: 5 })
  })

  it('returns noop for unsupported and non-printable input', () => {
    expect(routeComposerKey(createComposerEditor('x'), projection())).toEqual({
      kind: 'noop',
    })
    expect(
      routeComposerKey(createComposerEditor('x'), projection({ value: '\t' })),
    ).toEqual({ kind: 'noop' })
    expect(
      routeComposerKey(
        createComposerEditor('x'),
        projection({ value: 'y', ctrl: true }),
      ),
    ).toEqual({ kind: 'noop' })
    expect(
      routeComposerKey(
        createComposerEditor('x'),
        projection({ value: 'y', meta: true }),
      ),
    ).toEqual({ kind: 'noop' })
  })

  it('normalizes off-range cursor input before routing', () => {
    expect(
      routeComposerKey(
        createComposerEditor('ab', 99),
        projection({ value: 'X' }),
      ),
    ).toEqual({ kind: 'edit', editor: { text: 'abX', cursor: 3 } })
    expect(
      routeComposerKey(
        insertComposerImageMarker(createComposerEditor('x'), 3),
        projection({ left: true }),
      ),
    ).toEqual({ kind: 'edit', editor: { text: 'x[Image #3]', cursor: 1 } })
  })
})
