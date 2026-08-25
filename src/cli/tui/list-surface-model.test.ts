import { describe, expect, it } from 'vitest'

import { projectTuiListSurface } from './list-surface-model.js'

describe('projectTuiListSurface', () => {
  it('projects agents and preserves generic list rows', () => {
    const agents = projectTuiListSurface({
      kind: 'agents',
      agents: [
        { name: 'reviewer', description: 'Reviews changes' },
        { name: 'builder', description: 'Builds features' },
      ],
      selectedIndex: 1,
    })
    expect(agents).toEqual({
      kind: 'list-panel',
      title: 'Agents',
      rows: [
        { label: 'reviewer', description: 'Reviews changes' },
        { label: 'builder', description: 'Builds features' },
      ],
      emptyText: 'No agents configured',
      selectedIndex: 1,
    })

    const rows = [{ label: 'Background', description: 'Running' }]
    const list = projectTuiListSurface({
      kind: 'list',
      title: 'Tasks',
      rows,
      emptyText: 'Empty',
      selectedIndex: 0,
    })
    expect(list.rows).toBe(rows)
    expect(list).toMatchObject({
      kind: 'list-panel',
      title: 'Tasks',
      emptyText: 'Empty',
      selectedIndex: 0,
    })
  })
})
