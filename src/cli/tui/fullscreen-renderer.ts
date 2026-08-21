import type { TuiRendererMode } from './tui-view-model.js'

/** Stable terminal-frame policy for the fullscreen renderer. */

export interface FullscreenInkRenderOptions {
  incrementalRendering: boolean
  alternateScreen: boolean
}

/**
 * The Ink render options for an interactive session. Fullscreen uses a stable
 * terminal-frame policy: incremental rendering is disabled (every frame is a
 * full redraw that erases the previous viewport) while classic and screen-reader
 * modes keep their current behavior.
 */
export function fullscreenInkRenderOptions(
  currentRenderer: TuiRendererMode,
  axScreenReader: boolean | undefined,
): FullscreenInkRenderOptions {
  return {
    incrementalRendering: currentRenderer !== 'fullscreen' && !axScreenReader,
    alternateScreen: currentRenderer === 'fullscreen',
  }
}
