import { describe, expect, it } from 'vitest'

import {
  composerEditorSegments,
  createComposerEditor,
  deleteComposerBackward,
  deleteComposerForward,
  deleteComposerToEnd,
  deleteComposerToStart,
  deleteComposerWordBackward,
  insertComposerText,
  moveComposerCursor,
  moveComposerCursorByWord,
} from './composer-editor.js'

describe('composer editor', () => {
  it('inserts and deletes at the real cursor position', () => {
    const inserted = insertComposerText(createComposerEditor('abcd', 2), 'X')
    expect(inserted).toEqual({ text: 'abXcd', cursor: 3 })
    expect(deleteComposerBackward(inserted)).toEqual({
      text: 'abcd',
      cursor: 2,
    })
    expect(deleteComposerForward(createComposerEditor('abcd', 2))).toEqual({
      text: 'abd',
      cursor: 2,
    })
  })

  it('keeps cursor operations on code-point boundaries', () => {
    const state = createComposerEditor('a😀b', 2)
    expect(moveComposerCursor(state, -1)).toEqual({ text: 'a😀b', cursor: 1 })
    expect(insertComposerText(state, 'X')).toEqual({ text: 'a😀Xb', cursor: 3 })
    expect(composerEditorSegments(state)).toEqual({
      before: 'a😀',
      current: 'b',
      after: '',
    })
  })

  it('moves and removes complete words and line ends', () => {
    const state = createComposerEditor('review local changes')
    const wordStart = moveComposerCursorByWord(state, 'backward')
    expect(wordStart).toEqual({
      text: 'review local changes',
      cursor: 13,
    })
    expect(deleteComposerWordBackward(state)).toEqual({
      text: 'review local ',
      cursor: 13,
    })
    expect(deleteComposerToStart(wordStart)).toEqual({
      text: 'changes',
      cursor: 0,
    })
    expect(deleteComposerToEnd(wordStart)).toEqual({
      text: 'review local ',
      cursor: 13,
    })
  })
})
