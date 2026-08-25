import { describe, expect, it } from 'vitest'

import type { TuiSandboxSnapshot } from './sandbox-settings.js'
import { projectTuiSandboxSurface } from './sandbox-surface-model.js'

describe('projectTuiSandboxSurface', () => {
  it('projects the semantic kind and preserves required values and snapshot identity', () => {
    const snapshot = {} as TuiSandboxSnapshot
    const surface = projectTuiSandboxSurface({
      snapshot,
      tab: 'config',
      selectedIndex: 3,
    })
    expect(surface).toEqual({
      kind: 'sandbox-panel',
      snapshot,
      tab: 'config',
      selectedIndex: 3,
    })
    expect(surface.snapshot).toBe(snapshot)
  })
})
