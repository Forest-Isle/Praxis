import { describe, expect, it } from 'vitest'

import {
  projectTuiEffortSurface,
  projectTuiModelSurface,
} from './model-effort-surface-model.js'

describe('model and effort surface projectors', () => {
  it('preserves model options identity and values', () => {
    const options = [
      { label: 'Default', description: 'Recommended', selected: true },
      { label: 'custom', description: 'Current', model: 'custom' },
    ] as const
    const surface = projectTuiModelSurface({
      options,
      effort: 'high',
      selectedIndex: 1,
    })
    expect(surface).toEqual({
      kind: 'model-panel',
      options,
      effort: 'high',
      selectedIndex: 1,
    })
    expect(surface.options).toBe(options)
  })

  it('projects exact effort options and preserves selection', () => {
    const surface = projectTuiEffortSurface({
      effort: 'xhigh',
      selectedIndex: 3,
    })
    expect(surface).toEqual({
      kind: 'effort-panel',
      options: [
        {
          label: 'low',
          description: 'Fastest and least deliberative.',
          selected: false,
        },
        {
          label: 'medium',
          description: 'Use this effort for the next session turns.',
          selected: false,
        },
        {
          label: 'high',
          description: 'Use this effort for the next session turns.',
          selected: false,
        },
        {
          label: 'xhigh',
          description: 'Use this effort for the next session turns.',
          selected: true,
        },
        {
          label: 'max',
          description: 'Highest available reasoning effort.',
          selected: false,
        },
      ],
      selectedIndex: 3,
    })
  })
})
