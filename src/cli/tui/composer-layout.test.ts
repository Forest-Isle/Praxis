import { describe, expect, it } from 'vitest'

import { composerLayoutForWidth } from './composer-layout.js'

describe('composerLayoutForWidth', () => {
  it('clamps narrow terminals to the 12-column usable minimum', () => {
    expect(composerLayoutForWidth(5)).toEqual({
      lineWidth: 12,
      footerWidth: 12,
      showEditorHint: false,
    })
    expect(composerLayoutForWidth(0)).toEqual({
      lineWidth: 12,
      footerWidth: 12,
      showEditorHint: false,
    })
  })

  it('passes through normal widths unchanged', () => {
    expect(composerLayoutForWidth(12)).toEqual({
      lineWidth: 12,
      footerWidth: 12,
      showEditorHint: false,
    })
    expect(composerLayoutForWidth(60)).toEqual({
      lineWidth: 60,
      footerWidth: 60,
      showEditorHint: false,
    })
    expect(composerLayoutForWidth(99)).toEqual({
      lineWidth: 99,
      footerWidth: 99,
      showEditorHint: false,
    })
  })

  it('caps the layout at the 100-column maximum', () => {
    expect(composerLayoutForWidth(100)).toEqual({
      lineWidth: 100,
      footerWidth: 100,
      showEditorHint: true,
    })
    expect(composerLayoutForWidth(200)).toEqual({
      lineWidth: 100,
      footerWidth: 100,
      showEditorHint: true,
    })
  })

  it('degrades non-finite widths deterministically to the minimum', () => {
    for (const width of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      expect(composerLayoutForWidth(width)).toEqual({
        lineWidth: 12,
        footerWidth: 12,
        showEditorHint: false,
      })
    }
  })

  it('shows the editor hint only at or above the 100-column threshold', () => {
    expect(composerLayoutForWidth(99).showEditorHint).toBe(false)
    expect(composerLayoutForWidth(100).showEditorHint).toBe(true)
    expect(composerLayoutForWidth(140).showEditorHint).toBe(true)
  })
})
