import { describe, expect, it } from 'vitest'
import {
  projectTuiMentionPicker,
  tuiMentionEntryId,
} from './mention-picker-model.js'

describe('mention picker model', () => {
  const files = [
    { path: 'src/', directory: true },
    { path: 'src/a.ts', directory: false },
  ]
  const agents = [{ name: 'review', description: 'Review code' }]

  it('preserves filtering order and projects stable identities', () => {
    const model = projectTuiMentionPicker({
      files,
      agents,
      query: '',
      selectedIndex: 1,
    })
    expect(model.rows.map((row) => row.id)).toEqual([
      'file:src/',
      'agent:review',
      'file:src/a.ts',
    ])
    expect(model.selectedId).toBe('agent:review')
    expect(model.rows.filter((row) => row.selected)).toHaveLength(1)
    expect(
      tuiMentionEntryId({ kind: 'file', path: 'x', directory: false }),
    ).toBe('file:x')
  })

  it('normalizes selection and bounds the visible window', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      path: `f${i}`,
      directory: false,
    }))
    const model = projectTuiMentionPicker({
      files: many,
      agents: [],
      query: '',
      selectedIndex: 19,
    })
    expect(model.selectedIndex).toBe(19)
    expect(model.visibleRange).toEqual({ start: 8, end: 20 })
    expect(
      projectTuiMentionPicker({
        files: [],
        agents: [],
        query: '',
        selectedIndex: NaN,
      }).selectedIndex,
    ).toBeNull()
  })

  it('exposes semantic action labels and empty state', () => {
    const model = projectTuiMentionPicker({
      files: [],
      agents: [],
      query: 'x',
      selectedIndex: 0,
    })
    expect(model.rows).toEqual([])
    expect(model.visibleRange).toEqual({ start: 0, end: 0 })
    expect(model.actions.select).toContain('Enter')
  })
})
