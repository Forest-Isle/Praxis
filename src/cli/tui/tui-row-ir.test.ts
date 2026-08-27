import { describe, expect, it } from 'vitest'

import type { TranscriptPresentationEntry } from './transcript-presentation.js'
import { projectTuiRows } from './tui-row-ir.js'

const entry = (
  key: string,
  item: Extract<TranscriptPresentationEntry, { kind: 'item' }>['item'],
  viewportSlice?: string,
): TranscriptPresentationEntry => ({
  kind: 'item',
  key,
  item,
  ...(viewportSlice === undefined
    ? {}
    : {
        viewportSlice: {
          text: viewportSlice,
          rows: viewportSlice.split('\n').length,
        },
      }),
})

describe('projectTuiRows', () => {
  it('uses stable source-derived keys and preserves multiline empty lines', () => {
    const rows = projectTuiRows({
      entries: [entry('item-4', { kind: 'user', text: 'first\n\nlast' })],
      width: 80,
      mode: 'normal',
    })
    expect(rows.map((row) => row.key)).toEqual([
      'item-4:0',
      'item-4:1',
      'item-4:2',
    ])
    expect(rows[1]?.segments).toEqual([{ text: ' ', role: 'body' }])
    expect(
      rows.every((row) => row.source === 'item-4' && row.height === 1),
    ).toBe(true)
  })

  it('maps semantic item roles and prefers an existing viewport slice', () => {
    const rows = projectTuiRows({
      entries: [
        entry('assistant-1', { kind: 'assistant', text: 'answer' }),
        entry('thinking-1', { kind: 'thinking', text: 'internal' }),
        entry('warning-1', { kind: 'warning', text: 'problem' }),
        entry(
          'slice-1',
          { kind: 'assistant', text: 'source' },
          'visible\n+added\n-removed',
        ),
      ],
      width: 80,
      mode: 'audit',
    })
    expect(rows[0]?.segments[0]?.role).toBe('heading')
    expect(rows[0]?.segments[1]?.role).toBe('body')
    expect(rows[1]?.segments[0]?.role).toBe('muted')
    expect(rows[2]?.segments[0]?.role).toBe('error')
    expect(rows.slice(3).map((row) => row.segments[0])).toEqual([
      { text: 'visible', role: 'body' },
      { text: '+added', role: 'body' },
      { text: '-removed', role: 'body' },
    ])
  })
})
