import { describe, expect, it } from 'vitest'

import {
  SessionWorktreeManager,
  WorkspaceContext,
} from '../application/session-worktree.js'
import type { ToolRegistry } from '../core/runtime.js'
import { ClaudeWorktreeToolRegistry } from './claude-worktree-tools.js'

const base: ToolRegistry = {
  definitions: () => [],
  schedulingPolicy: () => ({ concurrency: 'concurrent' }),
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
    expect(
      registry.schedulingPolicy({
        id: 'enter',
        name: 'EnterWorktree',
        input: {},
      }),
    ).toMatchObject({ concurrency: 'exclusive' })
    expect(
      registry.schedulingPolicy({ id: 'read', name: 'Read', input: {} }),
    ).toEqual({ concurrency: 'concurrent' })
    await expect(
      registry.prepare(
        { id: 'base', name: 'Read', input: { file_path: 'x' } },
        { cwd: '/tmp' },
      ),
    ).resolves.toEqual({ id: 'base', name: 'Read', input: { file_path: 'x' } })
  })

  it('describes the Praxis worktree root in native mode', () => {
    const workspace = new WorkspaceContext('/tmp')
    const manager = new SessionWorktreeManager({
      workspace,
      sessionId: '55555555-5555-4555-8555-555555555555',
      dataPlane: 'native',
    })
    const registry = new ClaudeWorktreeToolRegistry({
      base,
      manager,
      workspace,
      dataPlane: 'native',
    })
    const enter = registry
      .definitions()
      .find(({ name }) => name === 'EnterWorktree')
    expect(enter?.inputSchema.properties).toMatchObject({
      path: { description: expect.stringContaining('.praxis/worktrees') },
    })
  })
})
