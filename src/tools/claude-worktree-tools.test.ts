import { describe, expect, it } from 'vitest'

import {
  SessionWorktreeManager,
  WorkspaceContext,
} from '../application/session-worktree.js'
import type { ToolRegistry } from '../core/runtime.js'
import { ClaudeWorktreeToolRegistry } from './claude-worktree-tools.js'

const base: ToolRegistry = {
  definitions: () => [],
  prepare: async (call) => call,
  execute: async () => ({ content: 'base', isError: false }),
}

describe('ClaudeWorktreeToolRegistry', () => {
  it('exposes Claude-compatible definitions and delegates base tools', async () => {
    const workspace = new WorkspaceContext('/tmp')
    const manager = new SessionWorktreeManager({
      workspace,
      sessionId: '44444444-4444-4444-8444-444444444444',
    })
    const registry = new ClaudeWorktreeToolRegistry({
      base,
      manager,
      workspace,
    })
    expect(registry.definitions().map(({ name }) => name)).toEqual([
      'EnterWorktree',
      'ExitWorktree',
    ])
    expect(registry.definitions()[0]?.inputSchema).toMatchObject({
      type: 'object',
      properties: { name: { type: 'string' }, path: { type: 'string' } },
    })
    await expect(
      registry.prepare(
        { id: 'base', name: 'Read', input: { file_path: 'x' } },
        { cwd: '/tmp' },
      ),
    ).resolves.toEqual({ id: 'base', name: 'Read', input: { file_path: 'x' } })
  })
})
