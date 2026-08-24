import { describe, expect, it } from 'vitest'
import {
  filterTuiSessionPickerChoices,
  projectTuiSessionPicker,
  tuiSessionPickerChoiceId,
} from './session-picker-model.js'

const sessions = [
  null,
  { sessionId: 'a', name: 'Alpha', lastPrompt: 'one', status: 'idle' },
  { sessionId: 'b', name: null, lastPrompt: 'Bravo prompt', status: 'busy' },
] as const

describe('projectTuiSessionPicker', () => {
  it('projects labels, stable ids, matching, and action semantics', () => {
    const model = projectTuiSessionPicker({
      choices: sessions,
      query: ' bravo ',
      selectedIndex: 99,
    })
    expect(model.query).toBe(' bravo ')
    expect(model.rows).toEqual([
      {
        id: 'session:b',
        kind: 'session',
        label: 'Bravo prompt',
        detail: 'b · busy',
        status: 'busy',
        ordinal: 0,
        selected: true,
      },
    ])
    expect(model.selectedId).toBe('session:b')
    expect(model.actions).toEqual({
      navigate: '↑/↓ to navigate',
      select: 'Enter to select',
      search: 'Type to search',
      cancel: 'Esc to cancel',
    })
  })

  it('bounds the visible window and represents empty results', () => {
    const choices = Array.from({ length: 12 }, (_, i) => ({
      sessionId: String(i),
      status: 'idle',
    }))
    const model = projectTuiSessionPicker({
      choices,
      query: '',
      selectedIndex: 10,
    })
    expect(model.visibleRange).toEqual({ start: 4, end: 12 })
    const empty = projectTuiSessionPicker({
      choices: sessions,
      query: 'missing',
      selectedIndex: 3,
    })
    expect(empty.rows).toEqual([])
    expect(empty.selectedIndex).toBeNull()
    expect(empty.selectedId).toBeNull()
    expect(empty.visibleRange).toEqual({ start: 0, end: 0 })
  })

  it('shares identity and filtering rules', () => {
    expect(tuiSessionPickerChoiceId(null)).toBe('new-session')
    expect(tuiSessionPickerChoiceId(sessions[1])).toBe('session:a')
    expect(filterTuiSessionPickerChoices(sessions, 'alpha')).toEqual([
      sessions[1],
    ])
  })
})
