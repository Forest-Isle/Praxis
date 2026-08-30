import { describe, expect, it } from 'vitest'

import {
  clampTranscriptScrollOffset,
  createTerminalSelectionContext,
  createTerminalSelectionState,
  parseTerminalMouseReport,
  projectTerminalSelection,
  refreshTerminalSelection,
  releaseTerminalSelection,
  startTerminalSelection,
  updateTerminalSelection,
} from './terminal-selection.js'
import type { QuietFrame } from './quiet-frame.js'

const frame = (texts: readonly string[]): QuietFrame => ({
  columns: 30,
  rows: 8,
  density: 'standard',
  lines: texts.map((text, index) => ({
    key: `line:${index}`,
    segments: [{ text, role: 'body' as const }],
    height: 1,
    region:
      index < texts.length - 1
        ? ('transcript' as const)
        : ('composer' as const),
  })),
})

describe('terminal selection', () => {
  it('parses complete SGR reports and rejects unrelated or invalid input', () => {
    expect(parseTerminalMouseReport('[<0;5;6M')).toEqual({
      kind: 'press',
      column: 4,
      row: 5,
    })
    expect(parseTerminalMouseReport('\u001b[<32;5;6M')).toEqual({
      kind: 'drag',
      column: 4,
      row: 5,
    })
    expect(parseTerminalMouseReport('[<0;5;6m')).toEqual({
      kind: 'release',
      column: 4,
      row: 5,
    })
    expect(parseTerminalMouseReport('[<64;1;1M')).toEqual({
      kind: 'wheel',
      direction: 'older',
      column: 0,
      row: 0,
    })
    expect(parseTerminalMouseReport('[<65;1;1M')).toEqual({
      kind: 'wheel',
      direction: 'newer',
      column: 0,
      row: 0,
    })
    for (const value of ['', '[<0;5', '[<1;5;6M', '[<0;0;6M', '[<0;5;6'])
      expect(parseTerminalMouseReport(value)).toBeNull()
    expect(parseTerminalMouseReport('[<0;9007199254740992;1M')).toBeNull()
  })

  it('normalizes malformed transcript facts and refreshes same-size changed rows', () => {
    const initial = createTerminalSelectionContext(
      frame(['one', 'two', '❯ draft']),
      Number.NaN,
      0,
      0,
    )
    expect(initial.transcriptRowCount).toBe(0)
    const context = createTerminalSelectionContext(
      frame(['one', 'two', '❯ draft']),
      2,
      0,
      0,
    )
    const state = updateTerminalSelection(
      startTerminalSelection(context, { column: 0, row: 0 }),
      context,
      { column: 1, row: 1 },
    )
    const changed = createTerminalSelectionContext(
      frame(['ONE', 'two', '❯ draft']),
      2,
      0,
      0,
    )
    const refreshed = refreshTerminalSelection(state, changed)
    expect(refreshed.rows.get(0)).toBe('ONE')
    expect(refreshed).not.toBe(state)
  })

  it('copies forward and reverse multiline ranges without splitting graphemes', () => {
    const source = frame(['alpha', '界👩‍💻omega', 'omega', '❯ draft'])
    const context = createTerminalSelectionContext(source, 3, 0, 0)
    const started = startTerminalSelection(context, { column: 1, row: 0 })
    const updated = updateTerminalSelection(started, context, {
      column: 4,
      row: 2,
    })
    expect(
      releaseTerminalSelection(updated, context, { column: 4, row: 2 }).text,
    ).toBe('lpha\n界👩‍💻omega\nomega')

    const reverse = startTerminalSelection(context, { column: 4, row: 2 })
    const reverseUpdated = updateTerminalSelection(reverse, context, {
      column: 1,
      row: 0,
    })
    expect(
      releaseTerminalSelection(reverseUpdated, context, { column: 1, row: 0 })
        .text,
    ).toBe('lpha\n界👩‍💻omega\nomega')

    const wideContext = createTerminalSelectionContext(
      frame(['界👩‍💻z', '❯ draft']),
      1,
      0,
      0,
    )
    const wide = startTerminalSelection(wideContext, { column: 1, row: 0 })
    expect(
      releaseTerminalSelection(wide, wideContext, { column: 3, row: 0 }).text,
    ).toBe('界👩‍💻')
  })

  it('maps rows to stable global ordinals, projects selection, and refreshes at an edge', () => {
    const source = frame(['old', 'middle', 'new', '❯ draft'])
    const context = createTerminalSelectionContext(source, 8, 2, 5)
    expect(context.visibleTranscriptRows.map((row) => row.logicalRow)).toEqual([
      8, 9, 10,
    ])
    let state = createTerminalSelectionState()
    state = startTerminalSelection(context, { column: 0, row: 0 })
    state = updateTerminalSelection(state, context, { column: 2, row: 2 })
    expect(state.edge).toBe('newer')
    expect(
      projectTerminalSelection(source, state, context).lines[0]?.segments[0]
        ?.role,
    ).toBe('textSelection')
    const refreshedContext = createTerminalSelectionContext(
      frame(['older', 'newer', '❯ draft']),
      8,
      1,
      5,
    )
    const refreshed = refreshTerminalSelection(state, refreshedContext, 'newer')
    expect(refreshed.focus?.row).toBe(11)
    expect(refreshed.rows.get(11)).toBe('newer')
  })

  it('clamps wheel offsets to the transcript bounds', () => {
    expect(clampTranscriptScrollOffset(-1, 4)).toBe(0)
    expect(clampTranscriptScrollOffset(9, 4)).toBe(4)
    expect(clampTranscriptScrollOffset(2, 4)).toBe(2)
  })
})
