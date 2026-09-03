import { afterEach, describe, expect, it, vi } from 'vitest'

import type { PermissionResolver, ToolRegistry } from '../core/runtime.js'
import type { ClaudeTeamAgentRuntime } from './team-agent-runtime.js'
import { LocalTeamManager } from './team-manager.js'
import { LocalTeamCapability } from './team-capability.js'
import type { ClaudeHookRunner } from '../hooks/claude-hooks.js'
import { resolveDataPlanePaths } from '../persistence/data-plane.js'

const baseTools: ToolRegistry = {
  definitions: () => [],
  prepare: async (call) => call,
  execute: async () => ({ content: '', isError: false }),
}
const permissions: PermissionResolver = {
  resolve: () => ({ behavior: 'allow' }),
}

describe('LocalTeamCapability', () => {
  afterEach(() => vi.restoreAllMocks())

  it('has no construction side effects and shares one successful open', async () => {
    const manager = {} as LocalTeamManager
    const open = vi.spyOn(LocalTeamManager, 'open').mockResolvedValue(manager)
    const createRuntime = vi.fn(() => ({}) as ClaudeTeamAgentRuntime)
    const cwdProvider = vi.fn(() => '/active/workspace')
    const capability = new LocalTeamCapability({
      nativeRoot: '/native',
      cwd: cwdProvider,
      maxConcurrent: 4,
      baseTools,
      permissions,
      createRuntime,
    })

    expect(createRuntime).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()

    const first = capability.open()
    const second = capability.open()
    expect(first).toBe(second)
    await expect(first).resolves.toBe(manager)
    expect(createRuntime).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith({
      nativeRoot: '/native',
      cwd: '/active/workspace',
      maxConcurrent: 4,
      baseTools,
      permissions,
      runtime: createRuntime.mock.results[0]?.value,
    })
    await expect(capability.open()).resolves.toBe(manager)
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('clears only a failed open so a later explicit open retries', async () => {
    const manager = {} as LocalTeamManager
    const failure = new Error('transient')
    const open = vi
      .spyOn(LocalTeamManager, 'open')
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(manager)
    const createRuntime = vi.fn(() => ({}) as ClaudeTeamAgentRuntime)
    const capability = new LocalTeamCapability({
      nativeRoot: '/native',
      cwd: () => '/workspace',
      maxConcurrent: 2,
      baseTools,
      permissions,
      createRuntime,
    })

    const first = capability.open()
    const concurrent = capability.open()
    expect(first).toBe(concurrent)
    await expect(first).rejects.toBe(failure)

    await expect(capability.open()).resolves.toBe(manager)
    expect(createRuntime).toHaveBeenCalledTimes(2)
    expect(open).toHaveBeenCalledTimes(2)
  })

  it('passes a lazy trusted managed-worktree hook factory with exact context', async () => {
    const manager = {} as LocalTeamManager
    const open = vi.spyOn(LocalTeamManager, 'open').mockResolvedValue(manager)
    const signal = new AbortController().signal
    const runner = {
      run: vi.fn(async () => ({})),
    } as unknown as ClaudeHookRunner
    const cwd = '/active/workspace'
    const capability = new LocalTeamCapability({
      nativeRoot: '/native',
      cwd: () => cwd,
      maxConcurrent: 1,
      baseTools,
      permissions,
      createRuntime: () => ({}) as ClaudeTeamAgentRuntime,
      hooks: runner,
      permissionMode: 'bypassPermissions',
      signal,
    })

    await capability.open()
    const factory = open.mock.calls[0]?.[0].hooksFactory
    expect(factory).toBeTypeOf('function')
    const leadSessionId = '00000000-0000-4000-8000-000000000001'
    const hooks = factory?.(leadSessionId)
    await hooks?.afterCreate({
      worktreePath: '/project/.praxis/worktrees/team/team-a/hash',
      worktreeKind: 'team',
      worktreeId: 'a'.repeat(32),
      ownerId: 'team:team-a:1:hash:token',
      baseCommit: 'b'.repeat(40),
    })
    await hooks?.beforeRemove({
      worktreePath: '/project/.praxis/worktrees/team/team-a/hash',
      worktreeKind: 'team',
      worktreeId: 'a'.repeat(32),
      ownerId: 'team:team-a:1:hash:token',
      baseCommit: 'b'.repeat(40),
      reason: 'normal',
    })
    const transcriptPath = resolveDataPlanePaths({
      dataPlane: 'native',
      root: '/native',
      cwd,
      sessionId: leadSessionId,
    }).sessionFile
    expect(runner.run).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        session_id: leadSessionId,
        transcript_path: transcriptPath,
        cwd: '/project/.praxis/worktrees/team/team-a/hash',
        permission_mode: 'bypassPermissions',
        hook_event_name: 'WorktreeCreate',
      }),
      'team',
      signal,
    )
    expect(runner.run).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        hook_event_name: 'WorktreeRemove',
        reason: 'normal',
      }),
      'team',
      signal,
    )
  })
})
