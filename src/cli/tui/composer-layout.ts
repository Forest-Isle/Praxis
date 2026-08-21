// Pure, side-effect-free width policy for the composer chrome. Keeps the
// separator line and footer inside a usable 12..100 column band so narrow
// terminals keep a stable bottom composer without overflowing labels, and
// omits the optional editor-mode hint below 100 usable columns.
export interface ComposerLayout {
  lineWidth: number
  footerWidth: number
  showEditorHint: boolean
}

const MIN_COMPOSER_WIDTH = 12
const MAX_COMPOSER_WIDTH = 100

export function composerLayoutForWidth(width: number): ComposerLayout {
  const usableWidth = Number.isFinite(width)
    ? Math.min(Math.max(width, MIN_COMPOSER_WIDTH), MAX_COMPOSER_WIDTH)
    : MIN_COMPOSER_WIDTH
  return {
    lineWidth: usableWidth,
    footerWidth: usableWidth,
    showEditorHint: usableWidth >= MAX_COMPOSER_WIDTH,
  }
}
