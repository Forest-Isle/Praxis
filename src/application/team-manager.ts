import {
  createAgentLifecycle,
  markLifecycleOrphaned,
  transitionLifecycle,
  type LifecycleOwner,
} from '../core/agent-orchestration.js'
import type { PermissionResolver, ToolRegistry } from '../core/runtime.js'
import {
  type TeamMember,
  type TeamSnapshot,
  type TeamTask,
  parseTeamSnapshot,
  selectTeamTaskAdmissions,
  withTeamTaskExecution,
  acceptTeamTaskExecution,
} from '../core/team-ownership.js'
import {
  NativeTeamStore,
  type NativeTeamClaim,
} from '../persistence/native-team-store.js'
import {
  NativeTeamWorkspaceProvider,
  type TeamWorkspaceProvider,
} from './team-workspace.js'
import { TeamMemberToolRegistry } from '../tools/team-member-tools.js'

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface TeamCreateTaskInput extends Omit<TeamTask, 'execution'> {}

export interface TeamCreateInput {
  readonly teamId: string
  readonly name: string
  readonly leadSessionId: string
  readonly roster: readonly TeamMember[]
  readonly tasks: readonly TeamCreateTaskInput[]
}

export interface TeamAgentRuntime {
  run(input: {
    readonly teamId: string
    readonly task: TeamTask
    readonly member: TeamMember
    readonly generation: number
    readonly cwd: string
    readonly branch: string | null
    readonly tools: ToolRegistry
    readonly permissions: PermissionResolver
    readonly signal: AbortSignal
  }): Promise<'completed' | 'failed' | 'orphaned'>
}

export interface LocalTeamManagerOptions {
  readonly nativeRoot: string
  readonly cwd: string
  readonly maxConcurrent: number
  readonly baseTools: ToolRegistry
  readonly permissions: PermissionResolver
  readonly runtime: TeamAgentRuntime
  readonly workspace?: TeamWorkspaceProvider
}

function owner(claim: NativeTeamClaim): LifecycleOwner {
  return {
    token: claim.token,
    pid: claim.pid,
    acquiredAt: claim.acquiredAt,
  }
}

function now(): string {
  return new Date().toISOString()
}

export class LocalTeamManager {
  private constructor(
    private readonly store: NativeTeamStore,
    private readonly options: LocalTeamManagerOptions,
    private readonly workspace: TeamWorkspaceProvider,
  ) {}

  static async open(
    options: LocalTeamManagerOptions,
  ): Promise<LocalTeamManager> {
    if (
      !Number.isSafeInteger(options.maxConcurrent) ||
      options.maxConcurrent <= 0
    )
      throw new Error('Invalid maxConcurrent')
    const store = await NativeTeamStore.open({
      nativeRoot: options.nativeRoot,
      cwd: options.cwd,
    })
    const workspace =
      options.workspace ??
      (await NativeTeamWorkspaceProvider.open({
        nativeRoot: options.nativeRoot,
        cwd: options.cwd,
        projectIdentity: store.projectIdentity,
      }))
    return new LocalTeamManager(store, options, workspace)
  }

  async create(input: TeamCreateInput): Promise<LocalTeam> {
    const timestamp = now()
    const snapshot = parseTeamSnapshot({
      version: 1,
      revision: 0,
      teamId: input.teamId,
      name: input.name,
      projectIdentity: this.store.projectIdentity,
      leadSessionId: input.leadSessionId,
      roster: input.roster,
      tasks: input.tasks.map((task) => ({ ...task, execution: null })),
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    let claim: NativeTeamClaim | undefined
    let team: LocalTeam | undefined
    try {
      claim = await this.store.createAndClaim(snapshot)
      team = new LocalTeam(this.options, this.workspace, claim)
      await team.initialize(false)
      return team
    } catch (error) {
      if (!team) await claim?.release()
      throw error
    }
  }

  async resume(input: {
    teamId: string
    leadSessionId: string
  }): Promise<LocalTeam> {
    let claim: NativeTeamClaim | undefined
    let team: LocalTeam | undefined
    try {
      claim = await this.store.claim(input.teamId)
      const current = await claim.read()
      if (current.leadSessionId !== input.leadSessionId)
        throw new Error('Team lead session mismatch')
      team = new LocalTeam(this.options, this.workspace, claim)
      await team.initialize(true)
      return team
    } catch (error) {
      if (!team) await claim?.release()
      throw error
    }
  }

  list(): Promise<readonly TeamSnapshot[]> {
    return this.store.list()
  }
}

interface ActiveRuntime {
  generation: number
  controller: AbortController
  promise: Promise<void>
  runtimeSettled: boolean
  settled: boolean
}

export class LocalTeam {
  private mutation: Promise<unknown> = Promise.resolve()
  private readonly active = new Map<string, ActiveRuntime>()
  private admissionOpen = true
  private stopping: Promise<TeamSnapshot> | undefined
  private detaching: Promise<TeamSnapshot> | undefined
  private detachedSnapshot: TeamSnapshot | undefined
  private finalSnapshot: TeamSnapshot | undefined
  private pumpFailure: unknown
  private readonly indeterminate = new Set<string>()

  constructor(
    private readonly options: LocalTeamManagerOptions,
    private readonly workspace: TeamWorkspaceProvider,
    private readonly claim: NativeTeamClaim,
  ) {}

  async initialize(resume: boolean): Promise<void> {
    try {
      if (resume) await this.enqueue(() => this.reconcileOrphans())
      await this.pump()
    } catch (error) {
      await this.stop({ drainMs: 0 }).catch(() => undefined)
      throw error
    }
  }

  snapshot(): Promise<TeamSnapshot> {
    if (this.finalSnapshot) return Promise.resolve(this.finalSnapshot)
    if (this.detachedSnapshot) return Promise.resolve(this.detachedSnapshot)
    return this.enqueue(() => this.claim.read())
  }

  async waitForIdle(): Promise<TeamSnapshot> {
    if (this.finalSnapshot) return this.finalSnapshot
    if (this.detachedSnapshot) return this.detachedSnapshot
    for (;;) {
      if (this.pumpFailure) throw this.pumpFailure
      await this.mutation
      if (this.active.size > 0) {
        await Promise.allSettled(
          [...this.active.values()].map((entry) => entry.promise),
        )
        continue
      }
      await this.pump()
      await this.mutation
      if (this.active.size === 0) {
        const snapshot = await this.claim.read()
        if (
          selectTeamTaskAdmissions({
            snapshot,
            maxConcurrent: this.options.maxConcurrent,
          }).length === 0
        )
          return snapshot
      }
    }
  }

  async accept(
    taskId: string,
    generation?: number,
    decision: 'accepted' | 'rejected' = 'accepted',
  ): Promise<TeamSnapshot> {
    if (this.detaching) throw new Error('Team is detaching')
    if (this.detachedSnapshot) throw new Error('Team is detached')
    if (!this.admissionOpen || this.finalSnapshot)
      throw new Error('Team is stopped')
    await this.enqueue(async () => {
      const current = await this.claim.read()
      const next = acceptTeamTaskExecution(
        current,
        taskId,
        generation,
        decision,
      )
      return this.claim.save(current.revision, next)
    })
    await this.pump()
    return this.snapshot()
  }

  async stop(options: { drainMs?: number } = {}): Promise<TeamSnapshot> {
    if (this.detaching) throw new Error('Team is detaching')
    if (this.detachedSnapshot) throw new Error('Team is detached')
    if (this.finalSnapshot) return this.finalSnapshot
    if (this.stopping) return this.stopping
    this.stopping = this.stopInternal(options.drainMs ?? 5_000)
    try {
      this.finalSnapshot = await this.stopping
      return this.finalSnapshot
    } finally {
      this.stopping = undefined
    }
  }

  async detach(): Promise<TeamSnapshot> {
    if (this.finalSnapshot || this.stopping) throw new Error('Team is stopping')
    if (this.detachedSnapshot) return this.detachedSnapshot
    if (this.detaching) return this.detaching
    this.detaching = this.detachInternal()
    try {
      const snapshot = await this.detaching
      this.detachedSnapshot = snapshot
      return snapshot
    } catch (error) {
      this.detaching = undefined
      throw error
    } finally {
      if (this.detachedSnapshot) this.detaching = undefined
    }
  }

  private async detachInternal(): Promise<TeamSnapshot> {
    for (;;) {
      await this.mutation
      if (this.pumpFailure) throw this.pumpFailure
      if (this.active.size > 0) {
        await Promise.allSettled(
          [...this.active.values()].map((entry) => entry.promise),
        )
        continue
      }
      await this.pump()
      await this.mutation
      if (this.active.size > 0) continue
      const current = await this.claim.read()
      if (
        selectTeamTaskAdmissions({
          snapshot: current,
          maxConcurrent: this.options.maxConcurrent,
        }).length > 0
      )
        continue
      const snapshot = await this.enqueue(() => this.claim.read())
      if (this.active.size > 0) continue
      await this.claim.release()
      return snapshot
    }
  }

  private async stopInternal(drainMs: number): Promise<TeamSnapshot> {
    if (!Number.isFinite(drainMs) || drainMs < 0)
      throw new Error('Invalid drainMs')
    this.admissionOpen = false
    await this.enqueue(() => this.markCancelling())
    const activeAtStop = [...this.active.entries()]
    for (const entry of this.active.values()) entry.controller.abort()
    const runtimes = [...this.active.values()].map((entry) => entry.promise)
    if (runtimes.length > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, drainMs)
      })
      const winner = await Promise.race([
        Promise.allSettled(runtimes).then(() => 'drained' as const),
        timeout.then(() => 'timeout' as const),
      ])
      if (timer) clearTimeout(timer)
      // Individual completion is determined from each tracked runtime below;
      // one timed-out sibling must not orphan a sibling that drained.
      void winner
    }
    const snapshot = await this.enqueue(() => this.finishStopping(activeAtStop))
    await this.claim.release()
    return snapshot
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(operation, operation)
    this.mutation = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private async reconcileOrphans(): Promise<void> {
    let current = await this.claim.read()
    for (const task of current.tasks) {
      const execution = task.execution
      if (
        execution &&
        ['queued', 'running', 'waiting', 'cancelling'].includes(
          execution.state,
        ) &&
        execution.owner?.token !== this.claim.token
      ) {
        const nextExecution = markLifecycleOrphaned(
          execution,
          execution.owner?.token ?? '',
        )
        const next = withTeamTaskExecution(current, task.id, nextExecution)
        current = await this.claim.save(current.revision, next)
      }
    }
  }

  private async pump(): Promise<void> {
    if (!this.admissionOpen) return
    try {
      await this.enqueue(() => this.pumpMutation())
    } catch (error) {
      this.pumpFailure ??= error
      throw error
    }
  }

  private async pumpMutation(): Promise<void> {
    if (!this.admissionOpen) return
    for (;;) {
      let current = await this.claim.read()
      const selected = selectTeamTaskAdmissions({
        snapshot: current,
        maxConcurrent: this.options.maxConcurrent,
      })
      if (selected.length === 0) return
      const launches: Array<{
        task: TeamTask
        member: TeamMember
        cwd: string
        branch: string | null
      }> = []
      for (const taskId of selected) {
        const task = current.tasks.find((candidate) => candidate.id === taskId)
        if (!task) throw new Error(`Unknown admitted task: ${taskId}`)
        const queued = withTeamTaskExecution(
          current,
          task.id,
          createAgentLifecycle(owner(this.claim), 1),
        )
        current = await this.claim.save(current.revision, queued)
        const member = current.roster.find(
          (candidate) => candidate.name === task.assignee,
        )
        if (!member) throw new Error(`Unknown Team member: ${task.assignee}`)
        let workspace
        try {
          workspace = await this.workspace.acquire({
            teamId: current.teamId,
            taskId: task.id,
            generation: 1,
            access: member.access,
          })
        } catch {
          const failed = transitionLifecycle(
            current.tasks.find((candidate) => candidate.id === task.id)
              ?.execution ?? createAgentLifecycle(owner(this.claim)),
            'failed',
            this.claim.token,
          )
          current = await this.claim.save(
            current.revision,
            withTeamTaskExecution(current, task.id, failed),
          )
          continue
        }
        const queuedTask = current.tasks.find(
          (candidate) => candidate.id === task.id,
        )
        if (!queuedTask?.execution)
          throw new Error('Missing queued Team execution')
        const running = transitionLifecycle(
          queuedTask.execution,
          'running',
          this.claim.token,
        )
        current = await this.claim.save(
          current.revision,
          withTeamTaskExecution(current, task.id, running),
        )
        const persistedTask = current.tasks.find(
          (candidate) => candidate.id === task.id,
        )
        if (!persistedTask) throw new Error('Missing running Team task')
        launches.push({
          task: persistedTask,
          member,
          cwd: workspace.cwd,
          branch: workspace.branch,
        })
      }
      for (const launch of launches)
        this.launch(launch.task, launch.member, launch.cwd, launch.branch)
      if (launches.length === selected.length) return
    }
  }

  private launch(
    task: TeamTask,
    member: TeamMember,
    cwd: string,
    branch: string | null,
  ): void {
    const controller = new AbortController()
    const entry = {} as ActiveRuntime
    const promise = (async () => {
      let result: 'completed' | 'failed' | 'orphaned'
      try {
        result = await this.options.runtime.run({
          teamId: this.claim.teamId,
          task,
          member,
          generation: task.execution?.generation ?? 1,
          cwd,
          branch,
          tools: new TeamMemberToolRegistry({
            base: this.options.baseTools,
            access: member.access,
            cwd,
          }),
          permissions: this.options.permissions,
          signal: controller.signal,
        })
        entry.runtimeSettled = true
      } catch {
        entry.runtimeSettled = true
        await this.complete(task.id, task.execution?.generation ?? 1, 'failed')
        entry.settled = true
        this.active.delete(task.id)
        return
      }
      try {
        await this.complete(task.id, task.execution?.generation ?? 1, result)
      } finally {
        entry.settled = true
        this.active.delete(task.id)
      }
    })()
    entry.generation = task.execution?.generation ?? 1
    entry.controller = controller
    entry.promise = promise
    entry.runtimeSettled = false
    entry.settled = false
    this.active.set(task.id, entry)
  }

  private async complete(
    taskId: string,
    generation: number,
    result: 'completed' | 'failed' | 'orphaned',
  ): Promise<void> {
    try {
      await this.enqueue(async () => {
        const current = await this.claim.read()
        const task = current.tasks.find((candidate) => candidate.id === taskId)
        if (!task?.execution || task.execution.generation !== generation) return
        if (!['queued', 'running', 'waiting'].includes(task.execution.state))
          return
        const nextExecution =
          result === 'orphaned'
            ? markLifecycleOrphaned(task.execution, this.claim.token)
            : transitionLifecycle(task.execution, result, this.claim.token)
        await this.claim.save(
          current.revision,
          withTeamTaskExecution(current, taskId, nextExecution),
        )
      })
    } catch (error) {
      this.indeterminate.add(taskId)
      this.pumpFailure ??= error
      return
    }
    if (this.admissionOpen) {
      try {
        await this.pump()
      } catch (error) {
        this.pumpFailure ??= error
      }
    }
  }

  private async markCancelling(): Promise<void> {
    let current = await this.claim.read()
    for (const task of current.tasks) {
      const execution = task.execution
      if (
        execution &&
        ['queued', 'running', 'waiting'].includes(execution.state)
      ) {
        const next = transitionLifecycle(
          execution,
          'cancelling',
          this.claim.token,
        )
        current = await this.claim.save(
          current.revision,
          withTeamTaskExecution(current, task.id, next),
        )
      }
    }
  }

  private async finishStopping(
    activeAtStop: readonly [string, ActiveRuntime][],
  ): Promise<TeamSnapshot> {
    let current = await this.claim.read()
    const tracked = new Map(activeAtStop)
    for (const task of current.tasks) {
      const execution = task.execution
      if (execution?.state !== 'cancelling') continue
      const active = tracked.get(task.id)
      const next =
        this.indeterminate.has(task.id) ||
        (active !== undefined && !active.settled)
          ? markLifecycleOrphaned(execution, this.claim.token)
          : transitionLifecycle(execution, 'cancelled', this.claim.token)
      current = await this.claim.save(
        current.revision,
        withTeamTaskExecution(current, task.id, next),
      )
    }
    return current
  }
}
