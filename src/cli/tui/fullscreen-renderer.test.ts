import { describe, expect, it } from 'vitest'

import { fullscreenInkRenderOptions } from './fullscreen-renderer.js'

describe('fullscreenInkRenderOptions', () => {
  it('disables incremental rendering for the fullscreen renderer', () => {
    expect(fullscreenInkRenderOptions('fullscreen', false)).toEqual({
      incrementalRendering: false,
      alternateScreen: true,
    })
  })

  it('keeps incremental rendering for the classic renderer', () => {
    expect(fullscreenInkRenderOptions('default', false)).toEqual({
      incrementalRendering: true,
      alternateScreen: false,
    })
  })

  it('keeps screen-reader rendering non-incremental in classic mode', () => {
    expect(fullscreenInkRenderOptions('default', true)).toEqual({
      incrementalRendering: false,
      alternateScreen: false,
    })
  })
})
