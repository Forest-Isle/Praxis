import { describe, expect, it } from 'vitest'

import { projectTuiMemorySurface } from './memory-surface-model.js'

describe('projectTuiMemorySurface', () => {
  it('projects values without changing entry identity', () => {
    const entries = [
      {
        kind: 'file' as const,
        label: 'User memory',
        path: '/memory/CLAUDE.md',
        displayPath: '/memory/CLAUDE.md',
        scope: 'user' as const,
      },
    ]
    const surface = projectTuiMemorySurface({
      autoMemoryEnabled: true,
      entries,
      selectedIndex: 0,
      openedIndex: null,
      dataPlane: 'claude',
    })

    expect(surface).toEqual({
      kind: 'memory-panel',
      autoMemoryEnabled: true,
      entries,
      selectedIndex: 0,
      openedIndex: null,
      loading: false,
      dataPlane: 'claude',
    })
    expect(surface.entries).toBe(entries)
  })
})
