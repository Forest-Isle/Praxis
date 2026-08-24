import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import type { PermissionResolver, ToolRegistry } from '../core/runtime.js'
import { parseTeamSnapshot, type TeamMember } from '../core/team-ownership.js'
import type { NativeTeamClaim } from '../persistence/native-team-store.js'
import { LocalTeam, LocalTeamManager } from './team-manager.js'

const member: TeamMember = {
  name: 'worker',
  agentType: 'test',
  access: 'read-only',
}
const baseTools: ToolRegistry = {
  definitions: () => [],
  prepare: async (call) => call,
  execute: async () => ({ content: '', isError: false }),
}
const permissions: PermissionResolver = {
  resolve: () => ({ behavior: 'allow' }),
}

describe('LocalTeamManager', () => {
  it('detaches once without mutation and rejects concurrent mutations', async () => {
    const cwd = process.cwd()
    const current = parseTeamSnapshot({
      version: 1,
      revision: 0,
      teamId: 'team-detach',
      name: 'Detach Team',
      projectIdentity: cwd,
      leadSessionId: 'lead-detach',
      roster: [],
      tasks: [],
      createdAt: '2026-08-24T00:00:00.000Z',
      updatedAt: '2026-08-24T00:00:00.000Z',
    })
    let releaseClaim!: () => void
    const releasePending = new Promise<void>((resolve) => {
      releaseClaim = resolve
    })
    const release = vi.fn(() => releasePending)
    const save = vi.fn()
    const team = new LocalTeam(
      {
        nativeRoot: cwd,
        cwd,
        maxConcurrent: 1,
        baseTools,
        permissions,
        runtime: { run: async () => 'completed' },
      },
      { acquire: async () => ({ cwd, branch: null }) },
      {
        teamId: current.teamId,
        token: 'detach-token',
        pid: 1,
        acquiredAt: current.createdAt,
        read: async () => current,
        save,
        release,
      },
    )
    await team.initialize(false)

    const first = team.detach()
    const second = team.detach()
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce())
    await expect(team.accept('missing')).rejects.toThrow('Team is detaching')
    await expect(team.stop()).rejects.toThrow('Team is detaching')
    releaseClaim()

    await expect(Promise.all([first, second])).resolves.toEqual([
      current,
      current,
    ])
    await expect(team.detach()).resolves.toBe(current)
    await expect(team.snapshot()).resolves.toBe(current)
    await expect(team.waitForIdle()).resolves.toBe(current)
    await expect(team.accept('missing')).rejects.toThrow('Team is detached')
    await expect(team.stop()).rejects.toThrow('Team is detached')
    expect(save).not.toHaveBeenCalled()
    expect(current.revision).toBe(0)
  })

  it('retains cleanup authority when claim release fails before detach completes', async () => {
    const cwd = process.cwd()
    const current = parseTeamSnapshot({
      version: 1,
      revision: 0,
      teamId: 'team-detach-failure',
      name: 'Detach Failure Team',
      projectIdentity: cwd,
      leadSessionId: 'lead-detach',
      roster: [],
      tasks: [],
      createdAt: '2026-08-24T00:00:00.000Z',
      updatedAt: '2026-08-24T00:00:00.000Z',
    })
    const release = vi
      .fn<NativeTeamClaim['release']>()
      .mockRejectedValueOnce(new Error('release failed'))
      .mockResolvedValueOnce(undefined)
    const team = new LocalTeam(
      {
        nativeRoot: cwd,
        cwd,
        maxConcurrent: 1,
        baseTools,
        permissions,
        runtime: { run: async () => 'completed' },
      },
      { acquire: async () => ({ cwd, branch: null }) },
      {
        teamId: current.teamId,
        token: 'detach-token',
        pid: 1,
        acquiredAt: current.createdAt,
        read: async () => current,
        save: async () => current,
        release,
      },
    )
    await team.initialize(false)

    await expect(team.detach()).rejects.toThrow('release failed')
    await expect(team.stop({ drainMs: 0 })).resolves.toBe(current)
    expect(release).toHaveBeenCalledTimes(2)
  })

  it('resumes after detach and admits a dependent task only after Lead acceptance', async () => {
    const nativeRoot = await mkdtemp(join(tmpdir(), 'praxis-team-detach-'))
    const cwd = process.cwd()
    const runtimeCalls: string[] = []
    const options = {
      nativeRoot,
      cwd,
      maxConcurrent: 2,
      baseTools,
      permissions,
      workspace: { acquire: async () => ({ cwd, branch: null }) },
      runtime: {
        run: async ({ task }: { task: { id: string } }) => {
          runtimeCalls.push(task.id)
          return 'completed' as const
        },
      },
    }
    try {
      const manager = await LocalTeamManager.open(options)
      const team = await manager.create({
        teamId: 'team-detach-resume',
        name: 'Detach Resume Team',
        leadSessionId: 'lead-detach',
        roster: [member],
        tasks: [
          {
            id: 'first',
            description: 'first',
            assignee: member.name,
            blockedBy: [],
            claims: {
              files: [],
              publicContracts: [],
              generatedArtifacts: [],
              migrations: [],
              mergeTargets: [],
            },
          },
          {
            id: 'second',
            description: 'second',
            assignee: member.name,
            blockedBy: ['first'],
            claims: {
              files: [],
              publicContracts: [],
              generatedArtifacts: [],
              migrations: [],
              mergeTargets: [],
            },
          },
        ],
      })
      const firstDetached = await team.detach()
      expect(runtimeCalls).toEqual(['first'])
      expect(firstDetached.tasks[0]?.execution).toMatchObject({
        state: 'completed',
        acceptance: 'pending',
      })
      expect(firstDetached.tasks[1]?.execution).toBeNull()

      const resumedManager = await LocalTeamManager.open(options)
      const resumed = await resumedManager.resume({
        teamId: 'team-detach-resume',
        leadSessionId: 'lead-detach',
      })
      await resumed.accept('first')
      const secondDetached = await resumed.detach()
      expect(runtimeCalls).toEqual(['first', 'second'])
      expect(secondDetached.tasks[1]?.execution?.state).toBe('completed')
    } finally {
      await rm(nativeRoot, { recursive: true, force: true })
    }
  })

  it('serializes lifecycle completion and does not poison idle after invalid accept', async () => {
    const nativeRoot = await mkdtemp(join(tmpdir(), 'praxis-team-manager-'))
    const cwd = process.cwd()
    try {
      const manager = await LocalTeamManager.open({
        nativeRoot,
        cwd,
        maxConcurrent: 1,
        baseTools,
        permissions,
        workspace: { acquire: async () => ({ cwd, branch: null }) },
        runtime: { run: async () => 'completed' },
      })
      const team = await manager.create({
        teamId: 'team-a',
        name: 'Test Team',
        leadSessionId: 'lead-1',
        roster: [member],
        tasks: [
          {
            id: 'task-a',
            description: 'test',
            assignee: 'worker',
            blockedBy: [],
            claims: {
              files: [],
              publicContracts: [],
              generatedArtifacts: [],
              migrations: [],
              mergeTargets: [],
            },
          },
        ],
      })
      const completed = await team.waitForIdle()
      expect(completed.tasks[0]?.execution?.state).toBe('completed')
      await expect(team.accept('missing')).rejects.toThrow(/execution|Unknown/u)
      await expect(team.snapshot()).resolves.toMatchObject({
        tasks: [{ execution: { state: 'completed' } }],
      })
      await expect(team.waitForIdle()).resolves.toMatchObject({
        tasks: [{ execution: { state: 'completed' } }],
      })
      await team.accept('task-a')
      await expect(team.stop({ drainMs: 0 })).resolves.toMatchObject({
        tasks: [{ execution: { acceptance: 'accepted' } }],
      })
    } finally {
      await rm(nativeRoot, { recursive: true, force: true })
    }
  })

  it('cancels drained runtimes and orphans only the still-active sibling', async () => {
    const nativeRoot = await mkdtemp(join(tmpdir(), 'praxis-team-manager-'))
    const cwd = process.cwd()
    try {
      const manager = await LocalTeamManager.open({
        nativeRoot,
        cwd,
        maxConcurrent: 2,
        baseTools,
        permissions,
        workspace: { acquire: async () => ({ cwd, branch: null }) },
        runtime: {
          run: async ({ task, signal }) => {
            if (task.id === 'fast') {
              return new Promise<'completed'>((resolve) => {
                const complete = () => resolve('completed')
                if (signal.aborted) complete()
                else signal.addEventListener('abort', complete, { once: true })
              })
            }
            await new Promise<void>(() => undefined)
            return 'completed'
          },
        },
      })
      const team = await manager.create({
        teamId: 'team-stop',
        name: 'Stop Team',
        leadSessionId: 'lead-stop',
        roster: [member],
        tasks: ['fast', 'hung'].map((id) => ({
          id,
          description: id,
          assignee: member.name,
          blockedBy: [],
          claims: {
            files: [id],
            publicContracts: [],
            generatedArtifacts: [],
            migrations: [],
            mergeTargets: [],
          },
        })),
      })
      const final = await team.stop({ drainMs: 0 })
      const states = final.tasks.map((task) => task.execution?.state)
      expect(states).toEqual(['cancelled', 'orphaned'])
      await expect(team.snapshot()).resolves.toBe(final)
      await expect(team.waitForIdle()).resolves.toBe(final)
      await expect(team.stop()).resolves.toBe(final)
      await expect(team.accept('fast')).rejects.toThrow(/stopped/u)
    } finally {
      await rm(nativeRoot, { recursive: true, force: true })
    }
  })

  it('preserves completion persistence failure and orphans it during stop', async () => {
    const cwd = process.cwd()
    const persistenceError = new Error('completion persistence failed')
    let current = parseTeamSnapshot({
      version: 1,
      revision: 0,
      teamId: 'team-persistence',
      name: 'Persistence Team',
      projectIdentity: cwd,
      leadSessionId: 'lead-persistence',
      roster: [member],
      tasks: [
        {
          id: 'task-persistence',
          description: 'persist completion',
          assignee: member.name,
          blockedBy: [],
          claims: {
            files: [],
            publicContracts: [],
            generatedArtifacts: [],
            migrations: [],
            mergeTargets: [],
          },
          execution: null,
        },
      ],
      createdAt: '2026-08-24T00:00:00.000Z',
      updatedAt: '2026-08-24T00:00:00.000Z',
    })
    let failedCompletion = false
    const release = vi.fn(async () => undefined)
    const claim: NativeTeamClaim = {
      teamId: current.teamId,
      token: 'owner-token',
      pid: 1,
      acquiredAt: current.createdAt,
      read: async () => current,
      save: async (expectedRevision, next) => {
        expect(expectedRevision).toBe(current.revision)
        const state = next.tasks[0]?.execution?.state
        if (state === 'completed' && !failedCompletion) {
          failedCompletion = true
          throw persistenceError
        }
        current = next
        return current
      },
      release,
    }
    const team = new LocalTeam(
      {
        nativeRoot: cwd,
        cwd,
        maxConcurrent: 1,
        baseTools,
        permissions,
        runtime: { run: async () => 'completed' },
      },
      { acquire: async () => ({ cwd, branch: null }) },
      claim,
    )

    await team.initialize(false)
    await expect(team.waitForIdle()).rejects.toBe(persistenceError)
    const final = await team.stop({ drainMs: 0 })
    expect(final.tasks[0]?.execution?.state).toBe('orphaned')
    expect(release).toHaveBeenCalledOnce()
  })
})
