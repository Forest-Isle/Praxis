import { describe, expect, it } from 'vitest'

import { projectTuiTaskSurface } from './task-surface-model.js'

describe('projectTuiTaskSurface', () => {
  it('preserves task and state identities without transforming inputs', () => {
    const tasks = [
      {
        id: 'task-1',
        kind: 'shell' as const,
        status: 'running' as const,
        label: 'sleep 1',
        createdAtMs: 1,
      },
    ]
    const state = { depth: 'list' as const, selectedIndex: 0, scrollOffset: 0 }

    const surface = projectTuiTaskSurface({ tasks, state })

    expect(surface).toEqual({ kind: 'tasks-panel', tasks, state })
    expect(surface.tasks).toBe(tasks)
    expect(surface.state).toBe(state)
  })
})
