import { describe, expect, it } from 'vitest'
import {
  projectTuiCommandPalette,
  tuiCommandPaletteCommandId,
} from './command-palette-model.js'

const commands = [
  { name: 'review', description: 'Review changes', source: 'builtin' as const },
  {
    name: 'rename',
    description: 'Rename conversation',
    source: 'builtin' as const,
  },
  {
    name: 'other',
    description: 'Review another thing',
    source: 'command' as const,
  },
]

describe('projectTuiCommandPalette', () => {
  it('uses shared filtering order and projects semantic stable rows', () => {
    const model = projectTuiCommandPalette({
      commands,
      query: 'rev',
      selectedIndex: 1,
    })
    expect(model.rows).toEqual([
      {
        id: 'command:review',
        name: 'review',
        invocation: '/review',
        description: 'Review changes',
        ordinal: 0,
        selected: false,
      },
      {
        id: 'command:other',
        name: 'other',
        invocation: '/other',
        description: 'Review another thing',
        ordinal: 1,
        selected: true,
      },
    ])
    expect(model.selectedId).toBe('command:other')
    expect(model.actions).toEqual({
      navigate: '↑/↓ to navigate',
      complete: 'Tab to complete',
      submit: 'Enter to run',
      cancel: 'Esc to cancel',
    })
  })

  it('normalizes invalid selection, bounds 12 rows, and handles empty results', () => {
    const many = Array.from({ length: 20 }, (_, index) => ({
      name: `cmd${index}`,
      description: '',
      source: 'command' as const,
    }))
    expect(
      projectTuiCommandPalette({ commands: many, query: '', selectedIndex: 99 })
        .visibleRange,
    ).toEqual({ start: 8, end: 20 })
    expect(
      projectTuiCommandPalette({
        commands,
        query: '',
        selectedIndex: Number.NaN,
      }).selectedIndex,
    ).toBe(0)
    const empty = projectTuiCommandPalette({
      commands,
      query: 'missing',
      selectedIndex: -2,
    })
    expect(empty).toMatchObject({
      rows: [],
      selectedIndex: null,
      selectedId: null,
      visibleRange: { start: 0, end: 0 },
    })
  })

  it('exposes stable identity independent of object shape', () => {
    expect(tuiCommandPaletteCommandId({ name: '/Review' })).toBe(
      'command:/review',
    )
  })
})
