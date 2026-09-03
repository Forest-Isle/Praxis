import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import type { PermissionResolver, ToolRegistry } from '../core/runtime.js'
import { parseTeamSnapshot, type TeamMember } from '../core/team-ownership.js'
import type { NativeTeamClaim } from '../persistence/native-team-store.js'
import {
  LocalTeam,
  LocalTeamManager,
  type TeamAgentRuntime,
} from './team-manager.js'
import type { TeamWorkspaceInput } from './team-workspace.js'
import { TeamMailboxService } from './team-mailbox.js'

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
const completedResult = {
  status: 'completed' as const,
  totalTokens: 0,
  durationMs: 0,
}
const taskInput = (id: string, blockedBy: string[] = []) => ({
  id,
  description: id,
  assignee: member.name,
  blockedBy,
  claims: {
    files: [id],
    publicContracts: [],
    generatedArtifacts: [],
    migrations: [],
    mergeTargets: [],
  },
})
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}
function mailbox(cwd: string, teamId: string, projectIdentity = cwd) {
  return new TeamMailboxService({
    nativeRoot: cwd,
    projectIdentity,
    teamId,
    participants: ['lead', 'worker'],
  })
}
describe('LocalTeamManager', () => {
  it('passes persisted generation, lead session, owner token and retains completed work', async () => {
    const nativeRoot = await mkdtemp(join(tmpdir(), 'praxis-team-manager-'))
    const cwd = process.cwd()
    const acquire = vi.fn(async (input: TeamWorkspaceInput) => {
      void input
      return {
        cwd,
        branch: null,
        retain: vi.fn(async () => undefined),
      }
    })
    const releaseAccepted = vi.fn(async () => undefined)
    try {
      const manager = await LocalTeamManager.open({
        nativeRoot,
        cwd,
        maxConcurrent: 1,
        baseTools,
        permissions,
        workspace: { acquire, releaseAccepted },
        runtime: { run: async () => completedResult },
      })
      const team = await manager.create({
        teamId: 'team-exact-identity',
        name: 'Exact Identity',
        leadSessionId: 'lead-exact',
        roster: [member],
        tasks: [taskInput('exact-task')],
      })
      const final = await team.waitForIdle()
      const input = acquire.mock.calls[0]?.[0]
      expect(input).toMatchObject({
        generation: 1,
        leadSessionId: 'lead-exact',
        executionToken: final.tasks[0]?.execution?.previousOwnerToken,
      })
      const workspace = await acquire.mock.results[0]?.value
      expect(workspace.retain).toHaveBeenCalledWith(
        'Team generation completed; pending Lead disposition',
      )
    } finally {
      await rm(nativeRoot, { recursive: true, force: true })
    }
  })

  it('retains failed runtime evidence after an adapter throw', async () => {
    const nativeRoot = await mkdtemp(join(tmpdir(), 'praxis-team-manager-'))
    const cwd = process.cwd()
    const retain = vi.fn(async () => undefined)
    try {
      const manager = await LocalTeamManager.open({
        nativeRoot,
        cwd,
        maxConcurrent: 1,
        baseTools,
        permissions,
        workspace: {
          acquire: async () => ({ cwd, branch: null, retain }),
          releaseAccepted: async () => undefined,
        },
        runtime: {
          run: async () => {
            throw new Error('runtime throw')
          },
        },
      })
      const team = await manager.create({
        teamId: 'team-failed-retain',
        name: 'Failed Retain',
        leadSessionId: 'lead-failed',
        roster: [member],
        tasks: [taskInput('failed-task')],
      })
      const final = await team.waitForIdle()
      expect(final.tasks[0]?.execution?.state).toBe('failed')
      expect(retain).toHaveBeenCalledWith(
        'Team generation failed evidence retained',
      )
    } finally {
      await rm(nativeRoot, { recursive: true, force: true })
    }
  })

  it('retains after running persistence failure and aggregates a retention failure', async () => {
    const cwd = process.cwd()
    const persistenceError = new Error('running persistence failed')
    const createdAt = new Date().toISOString()
    let current = parseTeamSnapshot({
      version: 1,
      revision: 0,
      teamId: 'team-running-save',
      name: 'Running Save',
      projectIdentity: cwd,
      leadSessionId: 'lead-running-save',
      roster: [member],
      tasks: [{ ...taskInput('running-task'), execution: null }],
      createdAt,
      updatedAt: createdAt,
      policy: { lead: 'hybrid', execution: 'sequential', commit: 'lead' },
      budgets: {
        maxAgents: 1,
        maxConcurrent: 1,
        maxTokens: 100,
        maxDurationMs: 100_000,
        shutdownDrainMs: 0,
      },
      usage: { totalTokens: 0, durationMs: 0, exhausted: null },
    })
    const claimRelease = vi.fn(async () => undefined)
    const claim: NativeTeamClaim = {
      teamId: current.teamId,
      token: 'running-save-owner',
      pid: 1,
      acquiredAt: createdAt,
      read: async () => current,
      save: async (_expectedRevision, next) => {
        if (next.tasks[0]?.execution?.state === 'running')
          throw persistenceError
        current = next
        return current
      },
      release: claimRelease,
    }
    const retain = vi.fn(async () => {
      throw new Error('retain failed')
    })
    const team = new LocalTeam(
      {
        nativeRoot: cwd,
        cwd,
        maxConcurrent: 1,
        baseTools,
        permissions,
        runtime: { run: async () => completedResult },
      },
      {
        acquire: async () => ({ cwd, branch: null, retain }),
        releaseAccepted: async () => undefined,
      },
      claim,
      mailbox(cwd, current.teamId),
    )
    let failure: unknown
    try {
      await team.initialize(false)
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(AggregateError)
    const errors = (failure as AggregateError).errors
    expect(errors).toEqual(expect.arrayContaining([persistenceError]))
    expect(
      errors.some(
        (error) => error instanceof Error && error.message === 'retain failed',
      ),
    ).toBe(true)
    expect(retain).toHaveBeenCalledWith(
      'Team persistence uncertainty after workspace acquire',
    )
    expect(claimRelease).toHaveBeenCalledOnce()
  })

  it('preserves final progress and workspace retention failures together', async () => {
    const cwd = process.cwd()
    const progressError = new Error('final progress persistence failed')
    const retentionError = new Error('terminal retention failed')
    const createdAt = new Date().toISOString()
    let current = parseTeamSnapshot({
      version: 1,
      revision: 0,
      teamId: 'team-progress-settlement',
      name: 'Progress Settlement',
      projectIdentity: cwd,
      leadSessionId: 'lead-progress-settlement',
      roster: [member],
      tasks: [{ ...taskInput('progress-task'), execution: null }],
      createdAt,
      updatedAt: createdAt,
      policy: { lead: 'hybrid', execution: 'sequential', commit: 'lead' },
      budgets: {
        maxAgents: 1,
        maxConcurrent: 1,
        maxTokens: 100,
        maxDurationMs: 100_000,
        shutdownDrainMs: 0,
      },
      usage: { totalTokens: 0, durationMs: 0, exhausted: null },
    })
    const release = vi.fn(async () => undefined)
    let saveCalls = 0
    const claim: NativeTeamClaim = {
      teamId: current.teamId,
      token: 'progress-owner-token',
      pid: 1,
      acquiredAt: createdAt,
      read: async () => current,
      save: async (_expectedRevision, next) => {
        saveCalls += 1
        if (saveCalls === 3) throw progressError
        current = next
        return current
      },
      release,
    }
    const retain = vi.fn(async () => {
      throw retentionError
    })
    const runtimeResult = deferred<typeof completedResult>()
    const team = new LocalTeam(
      {
        nativeRoot: cwd,
        cwd,
        maxConcurrent: 1,
        baseTools,
        permissions,
        runtime: { run: async () => runtimeResult.promise },
      },
      {
        acquire: async () => ({ cwd, branch: null, retain }),
        releaseAccepted: async () => undefined,
      },
      claim,
      mailbox(cwd, current.teamId),
    )

    await team.initialize(false)
    const waiting = team.waitForIdle()
    runtimeResult.resolve(completedResult)
    let failure: unknown
    try {
      await waiting
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toEqual([
      progressError,
      retentionError,
    ])
    expect(retain).toHaveBeenCalledWith(
      'Team persistence uncertainty; terminal evidence retained',
    )
    await team.stop({ drainMs: 0 })
    expect(release).toHaveBeenCalledOnce()
  })

  it('persists acceptance before release, retries release, and then pumps dependents', async () => {
    const nativeRoot = await mkdtemp(join(tmpdir(), 'praxis-team-manager-'))
    const cwd = process.cwd()
    const calls: string[] = []
    let team!: Awaited<ReturnType<LocalTeamManager['create']>>
    let attempts = 0
    const releaseAccepted = vi.fn(async () => {
      const persisted = await team.snapshot()
      expect(persisted.tasks[0]?.execution?.acceptance).toBe('accepted')
      calls.push('release')
      attempts += 1
      if (attempts === 1) throw new Error('release unavailable')
    })
    let runs = 0
    try {
      const manager = await LocalTeamManager.open({
        nativeRoot,
        cwd,
        maxConcurrent: 1,
        baseTools,
        permissions,
        workspace: {
          acquire: async () => ({
            cwd,
            branch: null,
            retain: async () => undefined,
          }),
          releaseAccepted,
        },
        runtime: {
          run: async () => {
            runs += 1
            return completedResult
          },
        },
      })
      team = await manager.create({
        teamId: 'team-accept-retry',
        name: 'Accept Retry',
        leadSessionId: 'lead-accept',
        roster: [member],
        tasks: [taskInput('first'), taskInput('second', ['first'])],
      })
      await team.waitForIdle()
      await expect(team.accept('first')).rejects.toThrow('release unavailable')
      expect(runs).toBe(1)
      await team.accept('first')
      await team.waitForIdle()
      expect(releaseAccepted).toHaveBeenCalledTimes(2)
      expect(runs).toBe(2)
      expect(calls).toEqual(['release', 'release'])
    } finally {
      await rm(nativeRoot, { recursive: true, force: true })
    }
  })

  it('rejects never invokes accepted release', async () => {
    const nativeRoot = await mkdtemp(join(tmpdir(), 'praxis-team-manager-'))
    const cwd = process.cwd()
    const releaseAccepted = vi.fn(async () => undefined)
    try {
      const manager = await LocalTeamManager.open({
        nativeRoot,
        cwd,
        maxConcurrent: 1,
        baseTools,
        permissions,
        workspace: {
          acquire: async () => ({
            cwd,
            branch: null,
            retain: async () => undefined,
          }),
          releaseAccepted,
        },
        runtime: { run: async () => completedResult },
      })
      const team = await manager.create({
        teamId: 'team-reject-release',
        name: 'Reject Release',
        leadSessionId: 'lead-reject',
        roster: [member],
        tasks: [taskInput('reject-task')],
      })
      await team.waitForIdle()
      await team.accept('reject-task', undefined, 'rejected')
      expect(releaseAccepted).not.toHaveBeenCalled()
    } finally {
      await rm(nativeRoot, { recursive: true, force: true })
    }
  })
  it('passes the assigned scoped mailbox endpoint to every launched runtime', async () => {
    const nativeRoot = await mkdtemp(
      join(tmpdir(), 'praxis-team-mailbox-runtime-'),
    )
    const cwd = process.cwd()
    let received: string | undefined
    const runtime: TeamAgentRuntime = {
      run: async ({ mailbox: endpoint }) => {
        received = endpoint.participant
        return { status: 'completed', totalTokens: 0, durationMs: 0 }
      },
    }
    try {
      const manager = await LocalTeamManager.open({
        nativeRoot,
        cwd,
        maxConcurrent: 1,
        baseTools,
        permissions,
        runtime,
        workspace: {
          acquire: async () => ({
            cwd,
            branch: null,
            retain: async () => undefined,
          }),
          releaseAccepted: async () => undefined,
        },
      })
      const team = await manager.create({
        teamId: 'team-mailbox-runtime',
        name: 'Mailbox Runtime',
        leadSessionId: 'lead-mailbox-runtime',
        roster: [member],
        tasks: [
          {
            id: 'mailbox-task',
            description: 'run',
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
        ],
      })
      await team.waitForIdle()
      expect(received).toBe('worker')
    } finally {
      await rm(nativeRoot, { recursive: true, force: true })
    }
  })

  it('runs independent Swarm tasks concurrently behind a real barrier', async () => {
    const nativeRoot = await mkdtemp(join(tmpdir(), 'praxis-team-swarm-'))
    const cwd = process.cwd()
    const release = deferred()
    const bothEntered = deferred()
    const entered: string[] = []
    try {
      const manager = await LocalTeamManager.open({
        nativeRoot,
        cwd,
        maxConcurrent: 2,
        baseTools,
        permissions,
        workspace: {
          acquire: async () => ({
            cwd,
            branch: null,
            retain: async () => undefined,
          }),
          releaseAccepted: async () => undefined,
        },
        runtime: {
          run: async ({ task }) => {
            entered.push(task.id)
            if (entered.length === 2) bothEntered.resolve()
            await release.promise
            return completedResult
          },
        },
      })
      const team = await manager.create({
        teamId: 'team-swarm-barrier',
        name: 'Swarm Barrier',
        leadSessionId: 'lead-swarm',
        executionPolicy: 'swarm',
        roster: [member],
        tasks: [taskInput('first'), taskInput('second')],
      })

      await bothEntered.promise
      expect(entered).toEqual(['first', 'second'])
      release.resolve()
      await expect(team.waitForIdle()).resolves.toMatchObject({
        tasks: [
          { execution: { state: 'completed' } },
          { execution: { state: 'completed' } },
        ],
      })
    } finally {
      release.resolve()
      await rm(nativeRoot, { recursive: true, force: true })
    }
  })

  it('keeps the default execution policy sequential until the first task settles', async () => {
    const nativeRoot = await mkdtemp(join(tmpdir(), 'praxis-team-sequential-'))
    const cwd = process.cwd()
    const firstEntered = deferred()
    const releaseFirst = deferred()
    const entered: string[] = []
    try {
      const manager = await LocalTeamManager.open({
        nativeRoot,
        cwd,
        maxConcurrent: 2,
        baseTools,
        permissions,
        workspace: {
          acquire: async () => ({
            cwd,
            branch: null,
            retain: async () => undefined,
          }),
          releaseAccepted: async () => undefined,
        },
        runtime: {
          run: async ({ task }) => {
            entered.push(task.id)
            if (task.id === 'first') {
              firstEntered.resolve()
              await releaseFirst.promise
            }
            return completedResult
          },
        },
      })
      const team = await manager.create({
        teamId: 'team-sequential-default',
        name: 'Sequential Default',
        leadSessionId: 'lead-sequential',
        roster: [member],
        tasks: [taskInput('first'), taskInput('second')],
      })

      await firstEntered.promise
      expect(entered).toEqual(['first'])
      releaseFirst.resolve()
      await team.waitForIdle()
      expect(entered).toEqual(['first', 'second'])
    } finally {
      releaseFirst.resolve()
      await rm(nativeRoot, { recursive: true, force: true })
    }
  })

  it('keeps conflicting and dependency-blocked work out of a Swarm launch batch', async () => {
    const nativeRoot = await mkdtemp(join(tmpdir(), 'praxis-team-admission-'))
    const cwd = process.cwd()
    const releaseFirst = deferred()
    const initialBatchEntered = deferred()
    const entered: string[] = []
    try {
      const manager = await LocalTeamManager.open({
        nativeRoot,
        cwd,
        maxConcurrent: 3,
        baseTools,
        permissions,
        workspace: {
          acquire: async () => ({
            cwd,
            branch: null,
            retain: async () => undefined,
          }),
          releaseAccepted: async () => undefined,
        },
        runtime: {
          run: async ({ task }) => {
            entered.push(task.id)
            if (entered.length === 2) initialBatchEntered.resolve()
            if (task.id === 'first') await releaseFirst.promise
            return completedResult
          },
        },
      })
      const first = taskInput('first')
      const team = await manager.create({
        teamId: 'team-admission-safety',
        name: 'Admission Safety',
        leadSessionId: 'lead-admission',
        executionPolicy: 'swarm',
        roster: [member],
        tasks: [
          { ...first, claims: { ...first.claims, files: ['shared'] } },
          {
            ...taskInput('conflicting'),
            claims: { ...first.claims, files: ['shared'] },
          },
          taskInput('dependent', ['first']),
          taskInput('free'),
        ],
      })

      await initialBatchEntered.promise
      expect(entered).toEqual(['first', 'free'])
      releaseFirst.resolve()
      const idle = await team.waitForIdle()
      expect(entered).toEqual(['first', 'free', 'conflicting'])
      expect(
        idle.tasks.find(({ id }) => id === 'dependent')?.execution,
      ).toBeNull()
    } finally {
      releaseFirst.resolve()
      await rm(nativeRoot, { recursive: true, force: true })
    }
  })

  it('persists token exhaustion, aborts active Swarm work, and never launches pending work', async () => {
    const nativeRoot = await mkdtemp(join(tmpdir(), 'praxis-team-tokens-'))
    const cwd = process.cwd()
    const entered: string[] = []
    const aborted: string[] = []
    try {
      const manager = await LocalTeamManager.open({
        nativeRoot,
        cwd,
        maxConcurrent: 2,
        baseTools,
        permissions,
        workspace: {
          acquire: async () => ({
            cwd,
            branch: null,
            retain: async () => undefined,
          }),
          releaseAccepted: async () => undefined,
        },
        runtime: {
          run: async ({ task, generation, reportProgress, signal }) => {
            entered.push(task.id)
            if (task.id === 'first')
              reportProgress({ generation, totalTokens: 5, durationMs: 1 })
            await new Promise<void>((resolve) => {
              const onAbort = () => {
                aborted.push(task.id)
                resolve()
              }
              if (signal.aborted) onAbort()
              else signal.addEventListener('abort', onAbort, { once: true })
            })
            return {
              ...completedResult,
              totalTokens: task.id === 'first' ? 5 : 0,
              durationMs: 1,
            }
          },
        },
      })
      const team = await manager.create({
        teamId: 'team-token-budget',
        name: 'Token Budget',
        leadSessionId: 'lead-token',
        executionPolicy: 'swarm',
        budgets: { maxTokens: 5, shutdownDrainMs: 100 },
        roster: [member],
        tasks: [taskInput('first'), taskInput('second'), taskInput('pending')],
      })

      const final = await team.waitForIdle()
      expect(final.usage).toMatchObject({
        totalTokens: 5,
        exhausted: { reason: 'tokens' },
      })
      expect(entered).toEqual(['first', 'second'])
      expect(new Set(aborted)).toEqual(new Set(['first', 'second']))
      expect(final.tasks.map((task) => task.execution?.state ?? null)).toEqual([
        'cancelled',
        'cancelled',
        null,
      ])
    } finally {
      await rm(nativeRoot, { recursive: true, force: true })
    }
  })

  it('preserves valid progress across runtime failure and ignores stale generations', async () => {
    const nativeRoot = await mkdtemp(join(tmpdir(), 'praxis-team-progress-'))
    const cwd = process.cwd()
    try {
      const manager = await LocalTeamManager.open({
        nativeRoot,
        cwd,
        maxConcurrent: 1,
        baseTools,
        permissions,
        workspace: {
          acquire: async () => ({
            cwd,
            branch: null,
            retain: async () => undefined,
          }),
          releaseAccepted: async () => undefined,
        },
        runtime: {
          run: async ({ generation, reportProgress }) => {
            reportProgress({
              generation: generation + 1,
              totalTokens: 99,
              durationMs: 99,
            })
            reportProgress({ generation, totalTokens: 3, durationMs: 4 })
            throw new Error('runtime failed after progress')
          },
        },
      })
      const team = await manager.create({
        teamId: 'team-progress-failure',
        name: 'Progress Failure',
        leadSessionId: 'lead-progress',
        roster: [member],
        tasks: [taskInput('progress-task')],
      })

      const final = await team.waitForIdle()
      expect(final.usage.totalTokens).toBe(3)
      expect(final.tasks[0]).toMatchObject({
        execution: { state: 'failed' },
        usage: { generation: 1, totalTokens: 3, durationMs: 4 },
      })
    } finally {
      await rm(nativeRoot, { recursive: true, force: true })
    }
  })

  it('enforces the durable wall deadline with fake time and returns from idle', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-25T00:00:00.000Z'))
    const nativeRoot = await mkdtemp(join(tmpdir(), 'praxis-team-duration-'))
    const cwd = process.cwd()
    let aborted = false
    try {
      const manager = await LocalTeamManager.open({
        nativeRoot,
        cwd,
        maxConcurrent: 1,
        baseTools,
        permissions,
        workspace: {
          acquire: async () => ({
            cwd,
            branch: null,
            retain: async () => undefined,
          }),
          releaseAccepted: async () => undefined,
        },
        runtime: {
          run: async ({ signal }) => {
            await new Promise<void>((resolve) => {
              const onAbort = () => {
                aborted = true
                resolve()
              }
              if (signal.aborted) onAbort()
              else signal.addEventListener('abort', onAbort, { once: true })
            })
            return { ...completedResult, durationMs: 100 }
          },
        },
      })
      const team = await manager.create({
        teamId: 'team-duration-budget',
        name: 'Duration Budget',
        leadSessionId: 'lead-duration',
        budgets: { maxDurationMs: 100, shutdownDrainMs: 50 },
        roster: [member],
        tasks: [taskInput('duration-task')],
      })
      const idle = team.waitForIdle()

      await vi.advanceTimersByTimeAsync(100)
      const final = await idle
      expect(aborted).toBe(true)
      expect(final.usage).toMatchObject({
        durationMs: 100,
        exhausted: { reason: 'duration' },
      })
      expect(final.tasks[0]?.execution?.state).toBe('cancelled')
    } finally {
      vi.useRealTimers()
      await rm(nativeRoot, { recursive: true, force: true })
    }
  })

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
      createdAt: new Date(Date.now() + 60_000).toISOString(),
      updatedAt: new Date(Date.now() + 60_000).toISOString(),
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
        runtime: {
          run: async ({ reportProgress }) => {
            reportProgress({ generation: 1, totalTokens: 0, durationMs: 0 })
            return { status: 'completed', totalTokens: 0, durationMs: 0 }
          },
        },
      },
      {
        acquire: async () => ({
          cwd,
          branch: null,
          retain: async () => undefined,
        }),
        releaseAccepted: async () => undefined,
      },
      {
        teamId: current.teamId,
        token: 'detach-token',
        pid: 1,
        acquiredAt: current.createdAt,
        read: async () => current,
        save,
        release,
      },
      mailbox(cwd, current.teamId),
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
      createdAt: new Date(Date.now() + 60_000).toISOString(),
      updatedAt: new Date(Date.now() + 60_000).toISOString(),
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
        runtime: {
          run: async ({ reportProgress }) => {
            reportProgress({ generation: 1, totalTokens: 0, durationMs: 0 })
            return { status: 'completed', totalTokens: 0, durationMs: 0 }
          },
        },
      },
      {
        acquire: async () => ({
          cwd,
          branch: null,
          retain: async () => undefined,
        }),
        releaseAccepted: async () => undefined,
      },
      {
        teamId: current.teamId,
        token: 'detach-token',
        pid: 1,
        acquiredAt: current.createdAt,
        read: async () => current,
        save: async () => current,
        release,
      },
      mailbox(cwd, current.teamId),
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
      workspace: {
        acquire: async () => ({
          cwd,
          branch: null,
          retain: async () => undefined,
        }),
        releaseAccepted: async () => undefined,
      },
      runtime: {
        run: async ({ task }: { task: { id: string } }) => {
          runtimeCalls.push(task.id)
          return { status: 'completed' as const, totalTokens: 0, durationMs: 0 }
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
        workspace: {
          acquire: async () => ({
            cwd,
            branch: null,
            retain: async () => undefined,
          }),
          releaseAccepted: async () => undefined,
        },
        runtime: {
          run: async ({ reportProgress }) => {
            reportProgress({ generation: 1, totalTokens: 0, durationMs: 0 })
            return { status: 'completed', totalTokens: 0, durationMs: 0 }
          },
        },
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
        policy: { commit: 'lead' },
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
    const retained = new Map<string, ReturnType<typeof vi.fn>>()
    try {
      const manager = await LocalTeamManager.open({
        nativeRoot,
        cwd,
        maxConcurrent: 2,
        baseTools,
        permissions,
        workspace: {
          acquire: async ({ taskId }) => {
            const retain = vi.fn(async () => undefined)
            retained.set(taskId, retain)
            return { cwd, branch: null, retain }
          },
          releaseAccepted: async () => undefined,
        },
        runtime: {
          run: async ({ task, signal }) => {
            if (task.id === 'fast') {
              return new Promise<{
                status: 'completed'
                totalTokens: number
                durationMs: number
              }>((resolve) => {
                const complete = () =>
                  resolve({
                    status: 'completed',
                    totalTokens: 0,
                    durationMs: 0,
                  })
                if (signal.aborted) complete()
                else signal.addEventListener('abort', complete, { once: true })
              })
            }
            await new Promise<void>(() => undefined)
            return { status: 'completed', totalTokens: 0, durationMs: 0 }
          },
        },
      })
      const team = await manager.create({
        teamId: 'team-stop',
        name: 'Stop Team',
        leadSessionId: 'lead-stop',
        executionPolicy: 'swarm',
        budgets: { shutdownDrainMs: 0 },
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
      await expect(team.stop({ drainMs: 1 })).rejects.toThrow(/drainMs/u)
      const final = await team.stop()
      const states = final.tasks.map((task) => task.execution?.state)
      expect(states).toEqual(['cancelled', 'orphaned'])
      expect(retained.get('fast')).toHaveBeenCalledWith(
        'Team generation cancelled evidence retained',
      )
      expect(retained.get('hung')).toHaveBeenCalledWith(
        'Team generation orphaned evidence retained',
      )
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
      createdAt: new Date(Date.now() + 60_000).toISOString(),
      updatedAt: new Date(Date.now() + 60_000).toISOString(),
    })
    let failedCompletion = false
    const release = vi.fn(async () => undefined)
    const retain = vi.fn(async () => undefined)
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
        runtime: {
          run: async ({ reportProgress }) => {
            reportProgress({ generation: 1, totalTokens: 0, durationMs: 0 })
            return {
              status: 'completed' as const,
              totalTokens: 0,
              durationMs: 0,
            }
          },
        },
      },
      {
        acquire: async () => ({
          cwd,
          branch: null,
          retain,
        }),
        releaseAccepted: async () => undefined,
      },
      claim,
      mailbox(cwd, current.teamId),
    )

    await team.initialize(false)
    await expect(team.waitForIdle()).rejects.toBe(persistenceError)
    expect(retain).toHaveBeenCalledWith(
      'Team persistence uncertainty; terminal evidence retained',
    )
    const final = await team.stop({ drainMs: 0 })
    expect(final.tasks[0]?.execution?.state).toBe('orphaned')
    expect(release).toHaveBeenCalledOnce()
  })

  it('attempts every stop retention and claim release while aggregating failures', async () => {
    const cwd = process.cwd()
    const createdAt = new Date().toISOString()
    let current = parseTeamSnapshot({
      version: 1,
      revision: 0,
      teamId: 'team-stop-settlement',
      name: 'Stop Settlement',
      projectIdentity: cwd,
      leadSessionId: 'lead-stop-settlement',
      roster: [
        { name: 'first', agentType: 'test', access: 'write' },
        { name: 'second', agentType: 'test', access: 'write' },
      ],
      tasks: ['first', 'second'].map((id) => ({
        id,
        description: id,
        assignee: id,
        blockedBy: [],
        claims: {
          files: [],
          publicContracts: [],
          generatedArtifacts: [],
          migrations: [],
          mergeTargets: [],
        },
        execution: null,
      })),
      createdAt,
      updatedAt: createdAt,
      policy: { lead: 'hybrid', execution: 'swarm', commit: 'lead' },
      budgets: {
        maxAgents: 2,
        maxConcurrent: 2,
        maxTokens: 100,
        maxDurationMs: 100_000,
        shutdownDrainMs: 50,
      },
      usage: { totalTokens: 0, durationMs: 0, exhausted: null },
    })
    let firstRetainCalls = 0
    const firstRetain = vi.fn(async () => {
      firstRetainCalls += 1
      if (firstRetainCalls > 1) throw new Error('first-retain')
    })
    const secondRetain = vi.fn(async () => undefined)
    const claimRelease = vi.fn(async () => {
      throw new Error('claim-release')
    })
    const claim: NativeTeamClaim = {
      teamId: current.teamId,
      token: 'stop-owner-token',
      pid: 1,
      acquiredAt: createdAt,
      read: async () => current,
      save: async (_expectedRevision, next) => {
        current = next
        return current
      },
      release: claimRelease,
    }
    const team = new LocalTeam(
      {
        nativeRoot: cwd,
        cwd,
        maxConcurrent: 2,
        baseTools,
        permissions,
        runtime: {
          run: async ({ signal }) => {
            await new Promise<void>((resolve) => {
              if (signal.aborted) resolve()
              else
                signal.addEventListener('abort', () => resolve(), {
                  once: true,
                })
            })
            return completedResult
          },
        },
      },
      {
        acquire: async ({ taskId }) => ({
          cwd,
          branch: null,
          retain: taskId === 'first' ? firstRetain : secondRetain,
        }),
        releaseAccepted: async () => undefined,
      },
      claim,
      mailbox(cwd, current.teamId),
    )
    await team.initialize(false)
    let stopError: unknown
    try {
      await team.stop({ drainMs: 20 })
    } catch (error) {
      stopError = error
    }
    expect(stopError).toBeInstanceOf(AggregateError)
    const flatten = (entry: unknown): string[] =>
      entry instanceof AggregateError
        ? entry.errors.flatMap((nested) => flatten(nested))
        : [entry instanceof Error ? entry.message : String(entry)]
    expect(flatten(stopError)).toEqual(
      expect.arrayContaining(['first-retain', 'claim-release']),
    )
    expect(firstRetain).toHaveBeenCalled()
    expect(secondRetain).toHaveBeenCalled()
    expect(claimRelease).toHaveBeenCalledOnce()
  })
})
