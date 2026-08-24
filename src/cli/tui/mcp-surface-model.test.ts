import { describe, expect, it } from 'vitest'

import {
  projectTuiMcpSurface,
  type TuiMcpSurfaceModel,
} from './mcp-surface-model.js'

describe('projectTuiMcpSurface', () => {
  it('projects the semantic discriminant while preserving payload identity', () => {
    const model = { cwd: '/workspace', servers: [] }
    const state = { depth: 'list' as const, serverIndex: 0, selectedIndex: 0 }
    const surface = projectTuiMcpSurface({ model, state })

    expect(surface).toEqual({ kind: 'mcp-panel', model, state })
    expect(surface.kind).toBe('mcp-panel')
    expect(surface.model).toBe(model)
    expect(surface.state).toBe(state)
    expect(surface satisfies TuiMcpSurfaceModel).toBe(surface)
  })
})
