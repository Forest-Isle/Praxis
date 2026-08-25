import { describe, expect, it } from 'vitest'

import { projectTuiHooksSurface } from './hooks-surface-model.js'

describe('projectTuiHooksSurface', () => {
  it('preserves the hook configuration identity', () => {
    const configuration = {
      events: [],
      hookCount: 0,
    }
    const surface = projectTuiHooksSurface({
      configuration,
      depth: 'events',
      eventIndex: 1,
      matcherIndex: 2,
      hookIndex: 3,
    })

    expect(surface).toEqual({
      kind: 'hooks-panel',
      configuration,
      depth: 'events',
      eventIndex: 1,
      matcherIndex: 2,
      hookIndex: 3,
    })
    expect(surface.configuration).toBe(configuration)
  })
})
