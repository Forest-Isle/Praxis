import { describe, expect, it } from 'vitest'
import { projectTuiBtwSurface, type TuiBtwEntry } from './btw-surface-model.js'

describe('projectTuiBtwSurface', () => {
  it('preserves entries identity and all values', () => {
    const entries: readonly TuiBtwEntry[] = [
      {
        id: 1,
        question: 'What is this?',
        answer: 'A side question',
        status: 'error',
        error: 'Failed',
      },
    ]
    const input = { entries, selectedIndex: -2, scrollOffset: 7, copied: true }

    expect(projectTuiBtwSurface(input)).toEqual({
      kind: 'btw-panel',
      ...input,
    })
    expect(projectTuiBtwSurface(input).entries).toBe(entries)
  })
})
