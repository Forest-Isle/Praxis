import type { TranscriptItem } from './claude-style.js'

/**
 * Rows reserved outside the shrinkable fullscreen transcript region: the top
 * identity chrome, the composer separator/prompt/footer, and the status line,
 * plus a small headroom so the active streaming tail stays visible below the
 * projected history suffix. Fullscreen computes the transcript budget as
 * `rows - FULLSCREEN_TRANSCRIPT_RESERVED_ROWS`.
 */
export const FULLSCREEN_TRANSCRIPT_RESERVED_ROWS = 12

/**
 * Conservative width-aware row estimate for a block of text. Blank lines still
 * occupy a row, and every logical line wraps across `Math.ceil(length / width)`
 * rows so the estimate leans high and never drops content that would actually
 * fit.
 */
function wrappedLineCount(text: string, width: number): number {
  if (text === '') return 1
  const usable = Math.max(1, width)
  let rows = 0
  for (const line of text.split('\n')) {
    rows += Math.max(1, Math.ceil(line.length / usable))
  }
  return rows
}

function bounded(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text
}

/**
 * Compact marker prepended to the projected tail of an oversized newest item so
 * the truncation is visually explicit while the newest lines remain visible.
 */
export const TRANSCRIPT_TRUNCATION_MARKER = '…'

/**
 * Projects a text block to the longest trailing suffix (newest content) that
 * fits `budget` terminal rows, prefixed with the truncation marker. The marker
 * merges into the first kept line, so the result is exactly
 * `${TRANSCRIPT_TRUNCATION_MARKER}${suffix}`. A text that already fits is
 * returned unchanged.
 */
function projectTextTail(text: string, budget: number, width: number): string {
  if (wrappedLineCount(text, width) <= budget) return text
  const lines = text.split('\n')
  let start = lines.length
  // Wrapped rows of every kept line after the current front line (marker-free).
  let rowsAfter = 0
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]
    if (line === undefined) break
    // This line becomes the front of the tail and carries the marker.
    if (
      rowsAfter +
        wrappedLineCount(`${TRANSCRIPT_TRUNCATION_MARKER}${line}`, width) >
      budget
    ) {
      break
    }
    start = index
    rowsAfter += wrappedLineCount(line, width)
  }
  return `${TRANSCRIPT_TRUNCATION_MARKER}${lines.slice(start).join('\n')}`
}

/**
 * Returns a cloned oversized text-bearing item whose text/summary is a bounded
 * trailing suffix that fits `budget` rows, preserving the newest content and
 * the item kind without mutating the input. Non-text display items (context,
 * tool, tool-result, shell, shell-result) are returned unchanged.
 */
function projectOversizedItem(
  item: TranscriptItem,
  budget: number,
  width: number,
): TranscriptItem {
  switch (item.kind) {
    case 'user':
    case 'assistant':
    case 'notice':
    case 'warning':
    case 'local-result':
      return { ...item, text: projectTextTail(item.text, budget, width) }
    case 'thinking':
      return {
        ...item,
        text: projectTextTail(item.text, Math.max(1, budget - 1), width),
      }
    case 'compact':
      return {
        ...item,
        summary: projectTextTail(item.summary, Math.max(1, budget - 1), width),
      }
    default:
      return item
  }
}

/**
 * Deterministic estimate of the terminal rows one transcript item occupies in
 * the TUI presentation. It is intentionally conservative (leans toward
 * overestimation) so the suffix projector keeps the newest content visible
 * rather than dropping items that would actually render.
 */
export function estimateTranscriptLines(
  item: TranscriptItem,
  width: number,
): number {
  switch (item.kind) {
    case 'user':
    case 'assistant':
    case 'notice':
    case 'warning':
    case 'local-result':
      return wrappedLineCount(item.text, width)
    case 'thinking':
      return 1 + wrappedLineCount(item.text, width)
    case 'compact':
      return 1 + wrappedLineCount(item.summary, width)
    case 'context':
      return 12 + item.skills.length + item.memoryFiles.length
    case 'tool':
      return 1 + (item.detail ? 1 : 0)
    case 'tool-result':
      return 1 + wrappedLineCount(bounded(item.text, 500), width)
    case 'shell':
      return 2 + wrappedLineCount(item.command, width)
    case 'shell-result':
      return wrappedLineCount(
        bounded(`${item.stdout}\n${item.stderr}`, 500),
        width,
      )
  }
}

export function transcriptLineCount(
  items: readonly TranscriptItem[],
  width: number,
): number {
  return items.reduce(
    (total, item) => total + estimateTranscriptLines(item, width),
    0,
  )
}

/**
 * Pure, deterministic suffix projector for the fullscreen transcript region.
 *
 * Given transcript items, a terminal row budget, and the usable width, it
 * returns the longest suffix of items whose conservative line estimate fits
 * the budget. The newest user/assistant content is always retained; if even
 * the newest item exceeds the budget, that item is projected as a bounded tail
 * clone rather than rendering an empty transcript (or clipping the tail below
 * the viewport). Ordering and item object identity are preserved for items
 * that fit and the input is never mutated.
 */
export function projectTranscriptTail(
  items: readonly TranscriptItem[],
  budget: number,
  width: number,
): readonly TranscriptItem[] {
  if (items.length === 0) return []
  const usableBudget = Math.max(1, budget)
  let rows = 0
  let start = items.length
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item === undefined) break
    const estimate = estimateTranscriptLines(item, width)
    if (rows + estimate > usableBudget) {
      // Stop at the first item that no longer fits. When no item has been
      // added yet, even the newest item exceeds the budget: returning it whole
      // would let Ink clip the oversized tail below the viewport, so project a
      // bounded suffix clone that keeps the newest content visible instead.
      return start === items.length
        ? [projectOversizedItem(item, usableBudget, width)]
        : items.slice(start)
    }
    rows += estimate
    start = index
  }
  return items.slice(start)
}

/** Projects a fixed-size transcript window, measured upward from the newest row. */
export function projectTranscriptWindow(
  items: readonly TranscriptItem[],
  budget: number,
  width: number,
  scrollOffset: number,
): readonly TranscriptItem[] {
  if (scrollOffset <= 0) return projectTranscriptTail(items, budget, width)
  const endRows = Math.max(0, transcriptLineCount(items, width) - scrollOffset)
  const startRows = Math.max(0, endRows - budget)
  let rows = 0
  let start = 0
  let end = 0
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    if (!item) break
    const nextRows = rows + estimateTranscriptLines(item, width)
    if (nextRows <= startRows) {
      start = index + 1
    }
    if (rows < endRows) end = index + 1
    rows = nextRows
    if (rows >= endRows) break
  }
  return items.slice(start, end)
}
