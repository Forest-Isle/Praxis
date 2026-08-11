import { describe, expect, it } from 'vitest'

import { createComposerEditor } from './composer-editor.js'
import {
  composerImageIds,
  deleteComposerImageBackward,
  deleteComposerImageForward,
  insertComposerImageMarker,
  moveComposerCursorAcrossImages,
} from './composer-images.js'

describe('composer image markers', () => {
  it('inserts markers at the real cursor and separates adjacent images', () => {
    const first = insertComposerImageMarker(createComposerEditor('start'), 1)
    expect(first).toEqual({ text: 'start[Image #1]', cursor: 15 })
    expect(insertComposerImageMarker(first, 2)).toEqual({
      text: 'start[Image #1] [Image #2]',
      cursor: 26,
    })
    expect(
      insertComposerImageMarker(createComposerEditor('abcd', 2), 3),
    ).toEqual({ text: 'ab[Image #3]cd', cursor: 12 })
  })

  it('moves across and deletes complete markers atomically', () => {
    const text = 'a[Image #12]b'
    expect(
      moveComposerCursorAcrossImages(createComposerEditor(text, 12), -1),
    ).toEqual({ text, cursor: 1 })
    expect(
      moveComposerCursorAcrossImages(createComposerEditor(text, 1), 1),
    ).toEqual({ text, cursor: 12 })
    expect(deleteComposerImageBackward(createComposerEditor(text, 12))).toEqual(
      { text: 'ab', cursor: 1 },
    )
    expect(deleteComposerImageForward(createComposerEditor(text, 1))).toEqual({
      text: 'ab',
      cursor: 1,
    })
  })

  it('returns marker IDs in prompt order', () => {
    expect(composerImageIds('[Image #8] x [Image #2]')).toEqual([8, 2])
  })
})
