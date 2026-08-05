import { describe, expect, it } from 'vitest'

import type { ToolRegistry } from '../core/runtime.js'
import { FilteredToolRegistry } from './filtered-tool-registry.js'

function registry(): ToolRegistry {
  return {
    definitions: () =>
      ['Read', 'Write', 'Bash'].map((name) => ({
        name,
        description: name,
        inputSchema: { type: 'object' },
      })),
    prepare: async (call) => call,
    execute: async () => ({ content: 'ok', isError: false }),
  }
}

describe('FilteredToolRegistry', () => {
  it('supports explicit, empty, default, and exact deny selections', () => {
    expect(
      new FilteredToolRegistry(registry(), { tools: ['Read', 'Write'] })
        .definitions()
        .map((definition) => definition.name),
    ).toEqual(['Read', 'Write'])
    expect(
      new FilteredToolRegistry(registry(), { tools: [] }).definitions(),
    ).toEqual([])
    expect(
      new FilteredToolRegistry(registry(), {
        tools: ['default'],
        disallowedTools: ['Write', 'Bash(rm *)'],
      })
        .definitions()
        .map((definition) => definition.name),
    ).toEqual(['Read', 'Bash'])
  })

  it('rejects unknown selections and blocks disabled calls at execution boundaries', async () => {
    expect(
      () => new FilteredToolRegistry(registry(), { tools: ['Unknown'] }),
    ).toThrow('Unknown tool')
    const filtered = new FilteredToolRegistry(registry(), { tools: ['Read'] })
    const call = { id: 'write', name: 'Write', input: {} }
    await expect(filtered.prepare(call, { cwd: '/workspace' })).rejects.toThrow(
      'disabled',
    )
    await expect(filtered.execute(call, { cwd: '/workspace' })).rejects.toThrow(
      'disabled',
    )
  })
})
