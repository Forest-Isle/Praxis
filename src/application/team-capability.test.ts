import { afterEach, describe, expect, it, vi } from 'vitest'

import type { PermissionResolver, ToolRegistry } from '../core/runtime.js'
import type { ClaudeTeamAgentRuntime } from './team-agent-runtime.js'
import { LocalTeamManager } from './team-manager.js'
import { LocalTeamCapability } from './team-capability.js'

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
})
