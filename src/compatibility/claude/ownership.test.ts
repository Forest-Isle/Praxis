import { describe, expect, it } from 'vitest'

import { CLAUDE_DATA_OWNERSHIP, getDataOwnership } from './ownership.js'

describe('Claude shared-data ownership', () => {
  it('keeps conversations and memory on the shared Claude data plane', () => {
    expect(getDataOwnership('transcript')).toMatchObject({
      plane: 'shared',
      praxisAccess: 'append-only',
    })
    expect(getDataOwnership('auto-memory')).toMatchObject({
      plane: 'shared',
      praxisAccess: 'read-write',
    })
    expect(getDataOwnership('durable-task-graph')).toMatchObject({
      plane: 'shared',
      praxisAccess: 'read-write',
      location: 'tasks/<session-id>/',
    })
    expect(getDataOwnership('scheduled-prompts')).toMatchObject({
      plane: 'shared',
      praxisAccess: 'read-write',
      location: '.claude/scheduled_tasks.json',
    })
  })

  it('starts settings, hooks, and MCP in compatibility-safe read-only mode', () => {
    expect(getDataOwnership('settings').praxisAccess).toBe('read-only')
    expect(getDataOwnership('hooks').praxisAccess).toBe('read-only')
    expect(getDataOwnership('mcp').praxisAccess).toBe('read-only')
  })

  it('stores operational state only in the Praxis sidecar plane', () => {
    for (const resource of [
      'provider-payload',
      'search-index',
      'session-lock',
    ] as const) {
      expect(getDataOwnership(resource)).toMatchObject({
        plane: 'praxis-sidecar',
        praxisAccess: 'read-write',
      })
    }

    expect(
      CLAUDE_DATA_OWNERSHIP.filter((policy) => policy.plane === 'shared').map(
        (policy) => policy.resource,
      ),
    ).not.toContain('provider-payload')
  })
})
