import { describe, expect, it } from 'vitest'

import { projectTuiConfigSurface } from './config-surface-model.js'

describe('projectTuiConfigSurface', () => {
  it('preserves semantic payload identity and applies presentation defaults', () => {
    const snapshot = {
      settings: {
        autoCompactEnabled: false,
        permissions: { defaultMode: 'plan' },
        theme: 'dark-ansi',
      },
      state: { respectGitignore: false },
    }
    const status = {
      version: '0.7.0',
      sessionId: 'session-fixture',
      cwd: '/work',
      model: 'fixture-model',
      settingSources: ['user'],
    }
    const usage = {
      totalCostUsd: 0,
      apiDurationMs: 0,
      wallDurationMs: 0,
      linesAdded: 0,
      linesRemoved: 0,
      hasUnknownModelCost: false,
      modelUsage: [],
    }
    const effectiveValues = { model: 'haiku' }
    const surface = projectTuiConfigSurface({
      tab: 'status',
      snapshot,
      status,
      usage,
      effectiveValues,
    })

    expect(surface).toMatchObject({
      kind: 'config-panel',
      tab: 'status',
      query: '',
      selectedIndex: 0,
      searchFocused: true,
    })
    expect(surface.snapshot).toBe(snapshot)
    expect(surface.status).toBe(status)
    expect(surface.usage).toBe(usage)
    expect(surface.effectiveValues).toBe(effectiveValues)
  })
})
