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
  type TeamLeadPolicy,
  type TeamExecutionPolicy,
  type TeamCommitPolicy,
  DEFAULT_TEAM_BUDGETS,
  parseTeamSnapshot,
  selectTeamTaskAdmissions,
  withTeamTaskExecution,
  acceptTeamTaskExecution,
  recordTeamTaskProgress,
  updateTeamUsageDuration,
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
import { TeamMailboxService, type TeamMailboxEndpoint } from './team-mailbox.js'

const MAX_TIMER_MS = 2_147_483_647

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface TeamCreateTaskInput extends Omit<
  TeamTask,
  'execution' | 'usage'
> {}

export interface TeamCreateInput {
  readonly teamId: string
  readonly name: string
  readonly leadSessionId: string
  readonly roster: readonly TeamMember[]
  readonly tasks: readonly TeamCreateTaskInput[]
  readonly leadPolicy?: TeamLeadPolicy
  readonly executionPolicy?: TeamExecutionPolicy
  readonly commitPolicy?: TeamCommitPolicy
  readonly budgets?: Partial<typeof DEFAULT_TEAM_BUDGETS>
}

export interface TeamAgentProgress {
  readonly generation: number
  readonly totalTokens: number
  readonly durationMs: number
}

export interface TeamAgentRunResult {
  readonly status: 'completed' | 'failed' | 'orphaned'
  readonly totalTokens: number
  readonly durationMs: number
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
    readonly mailbox: TeamMailboxEndpoint
    readonly reportProgress: (progress: TeamAgentProgress) => void
  }): Promise<TeamAgentRunResult>
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

function parseTeamAgentRunResult(value: unknown): TeamAgentRunResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Invalid Team agent result')
  const result = value as Record<string, unknown>
  if (
    Object.keys(result).some(
      (key) => !['status', 'totalTokens', 'durationMs'].includes(key),
    ) ||
    !['completed', 'failed', 'orphaned'].includes(String(result.status)) ||
    !Number.isSafeInteger(result.totalTokens) ||
    Number(result.totalTokens) < 0 ||
    !Number.isSafeInteger(result.durationMs) ||
    Number(result.durationMs) < 0
  )
    throw new Error('Invalid Team agent result')
  return Object.freeze({
    status: result.status as TeamAgentRunResult['status'],
    totalTokens: result.totalTokens as number,
    durationMs: result.durationMs as number,
  })
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
    if (
      input.budgets?.maxConcurrent !== undefined &&
      input.budgets.maxConcurrent > this.options.maxConcurrent
    )
      throw new Error('Team maxConcurrent exceeds local host ceiling')
    const timestamp = now()
    const snapshot = parseTeamSnapshot({
      version: 2,
      revision: 0,
      teamId: input.teamId,
      name: input.name,
      projectIdentity: this.store.projectIdentity,
      leadSessionId: input.leadSessionId,
      roster: input.roster,
      tasks: input.tasks.map((task) => ({
        ...task,
        execution: null,
        usage: { generation: 0, totalTokens: 0, durationMs: 0 },
      })),
      policy: {
        lead: input.leadPolicy ?? 'hybrid',
        execution: input.executionPolicy ?? 'sequential',
        commit: input.commitPolicy ?? 'lead',
      },
      budgets: { ...DEFAULT_TEAM_BUDGETS, ...(input.budgets ?? {}) },
      usage: { totalTokens: 0, durationMs: 0, exhausted: null },
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    let claim: NativeTeamClaim | undefined
    let team: LocalTeam | undefined
    try {
      claim = await this.store.createAndClaim(snapshot)
      team = new LocalTeam(
        this.options,
        this.workspace,
        claim,
        new TeamMailboxService({
          nativeRoot: (this.options as LocalTeamManagerOptions).nativeRoot,
          projectIdentity: this.store.projectIdentity,
          teamId: snapshot.teamId,
          participants: [
            'lead',
            ...snapshot.roster.map((member) => member.name),
          ],
        }),
      )
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
      team = new LocalTeam(
        this.options,
        this.workspace,
        claim,
        new TeamMailboxService({
          nativeRoot: (this.options as LocalTeamManagerOptions).nativeRoot,
          projectIdentity: this.store.projectIdentity,
          teamId: current.teamId,
          participants: [
            'lead',
            ...current.roster.map((member) => member.name),
          ],
        }),
      )
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
  private readonly progressWrites = new Map<string, Promise<void>>()
  private readonly stopStarted: Promise<void>
  private readonly resolveStopStarted: () => void
  private deadlineTimer: ReturnType<typeof setTimeout> | undefined
  private progressOpen = true

  constructor(
    private readonly options: LocalTeamManagerOptions,
    private readonly workspace: TeamWorkspaceProvider,
    private readonly claim: NativeTeamClaim,
    private readonly mailbox: TeamMailboxService,
  ) {
    let resolveStopStarted!: () => void
    this.stopStarted = new Promise<void>((resolve) => {
      resolveStopStarted = resolve
    })
    this.resolveStopStarted = resolveStopStarted
  }

  mailboxEndpoint(participant: string): TeamMailboxEndpoint {
    return this.mailbox.endpoint(participant)
  }

  async initialize(resume: boolean): Promise<void> {
    try {
      if (resume) await this.enqueue(() => this.reconcileOrphans())
      await this.initializeDeadline()
      await this.pump()
    } catch (error) {
      await this.stop({ drainMs: 0 }).catch(() => undefined)
      throw error
    }
  }

  snapshot(): Promise<TeamSnapshot> {
    if (this.finalSnapshot) return Promise.resolve(this.finalSnapshot)
    if (this.detachedSnapshot) return Promise.resolve(this.detachedSnapshot)
    if (this.stopping) return this.stopping
    return this.enqueue(() => this.claim.read())
  }

  async waitForIdle(): Promise<TeamSnapshot> {
    if (this.finalSnapshot) return this.finalSnapshot
    if (this.detachedSnapshot) return this.detachedSnapshot
    if (this.stopping) return this.stopping
    for (;;) {
      if (this.pumpFailure) throw this.pumpFailure
      await this.mutation
      if (this.stopping) return this.stopping
      if (!this.admissionOpen && this.active.size === 0) {
        const snapshot = await this.claim.read()
        if (snapshot.usage.exhausted) {
          this.beginBudgetShutdown()
          if (this.stopping) return this.stopping
        }
        return snapshot
      }
      if (this.active.size > 0) {
        await Promise.race([
          Promise.allSettled(
            [...this.active.values()].map((entry) => entry.promise),
          ),
          this.stopStarted,
        ])
        if (this.stopping) return this.stopping
        continue
      }
      await this.pump()
      await this.mutation
      if (this.stopping) return this.stopping
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
    const stopping = this.stopWithBudget(options.drainMs)
    this.stopping = stopping
    try {
      this.finalSnapshot = await stopping
      return this.finalSnapshot
    } finally {
      if (this.stopping === stopping) this.stopping = undefined
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
      if (this.stopping) throw new Error('Team is stopping')
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
      this.clearDeadlineTimer()
      this.progressOpen = false
      await this.mutation
      if (this.stopping) throw new Error('Team is stopping')
      const snapshot = await this.enqueue(() => this.claim.read())
      await this.claim.release()
      return snapshot
    }
  }

  private async stopWithBudget(
    requestedDrainMs?: number,
  ): Promise<TeamSnapshot> {
    const current = await this.enqueue(() => this.claim.read())
    const drainMs = requestedDrainMs ?? current.budgets.shutdownDrainMs
    if (
      !Number.isSafeInteger(drainMs) ||
      drainMs < 0 ||
      drainMs > current.budgets.shutdownDrainMs
    )
      throw new Error('Invalid drainMs')
    this.resolveStopStarted()
    try {
      return await this.stopInternal(drainMs)
    } catch (error) {
      this.pumpFailure ??= error
      throw error
    }
  }

  private async stopInternal(drainMs: number): Promise<TeamSnapshot> {
    this.clearDeadlineTimer()
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
    this.progressOpen = false
    await this.mutation
    const snapshot = await this.enqueue(() => this.finishStopping(activeAtStop))
    await this.claim.release()
    return snapshot
  }

  private clearDeadlineTimer(): void {
    if (!this.deadlineTimer) return
    clearTimeout(this.deadlineTimer)
    this.deadlineTimer = undefined
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
      let result!: TeamAgentRunResult
      try {
        result = parseTeamAgentRunResult(
          await this.options.runtime.run({
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
            mailbox: this.mailbox.endpoint(member.name),
            reportProgress: (progress) => {
              if (entry.runtimeSettled || entry.settled) return
              void this.queueProgress(
                task.id,
                task.execution?.generation ?? 1,
                progress,
              )
            },
          }),
        )
        entry.runtimeSettled = true
      } catch {
        entry.runtimeSettled = true
        try {
          await (this.progressWrites.get(task.id) ?? Promise.resolve())
        } catch {
          entry.settled = true
          this.active.delete(task.id)
          this.progressWrites.delete(task.id)
          return
        }
        await this.complete(task.id, task.execution?.generation ?? 1, {
          status: 'failed',
        })
        entry.settled = true
        this.active.delete(task.id)
        this.progressWrites.delete(task.id)
        return
      }
      try {
        await (this.progressWrites.get(task.id) ?? Promise.resolve())
        await this.queueProgress(task.id, entry.generation, {
          generation: entry.generation,
          totalTokens: result.totalTokens,
          durationMs: result.durationMs,
        })
        await this.complete(task.id, entry.generation, {
          status: result.status,
        })
      } finally {
        entry.settled = true
        this.active.delete(task.id)
        this.progressWrites.delete(task.id)
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
    result: Pick<TeamAgentRunResult, 'status'>,
  ): Promise<void> {
    if (!this.progressOpen || this.finalSnapshot || this.detachedSnapshot)
      return
    try {
      await this.enqueue(async () => {
        const current = await this.claim.read()
        const task = current.tasks.find((candidate) => candidate.id === taskId)
        if (!task?.execution || task.execution.generation !== generation) return
        if (
          !['queued', 'running', 'waiting', 'cancelling'].includes(
            task.execution.state,
          )
        )
          return
        const nextExecution =
          result.status === 'orphaned'
            ? markLifecycleOrphaned(task.execution, this.claim.token)
            : transitionLifecycle(
                task.execution,
                task.execution.state === 'cancelling'
                  ? 'cancelled'
                  : result.status,
                this.claim.token,
              )
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

  private queueProgress(
    taskId: string,
    generation: number,
    progress: TeamAgentProgress,
  ): Promise<void> {
    if (!this.progressOpen || this.finalSnapshot || this.detachedSnapshot)
      return Promise.resolve()
    const write = this.enqueue(() =>
      this.persistProgress(taskId, generation, progress),
    )
    const settled = write.then((exhausted) => {
      if (exhausted) this.beginBudgetShutdown()
    })
    this.progressWrites.set(taskId, settled)
    void settled.catch((error) => {
      this.indeterminate.add(taskId)
      this.pumpFailure ??= error
    })
    return settled
  }

  private async persistProgress(
    taskId: string,
    generation: number,
    progress: TeamAgentProgress,
  ): Promise<boolean> {
    const current = await this.claim.read()
    const task = current.tasks.find((candidate) => candidate.id === taskId)
    if (
      progress.generation !== generation ||
      !task?.execution ||
      task.execution.generation !== generation ||
      !['queued', 'running', 'waiting', 'cancelling'].includes(
        task.execution.state,
      )
    )
      return false
    const taskNext = recordTeamTaskProgress(current, taskId, progress)
    let saved = await this.claim.save(current.revision, taskNext)
    const next = updateTeamUsageDuration(
      saved,
      Math.max(
        saved.usage.durationMs,
        Date.now() - Date.parse(saved.createdAt),
      ),
    )
    saved = await this.claim.save(saved.revision, next)
    const exhausted = saved.usage.exhausted !== null
    if (exhausted) this.admissionOpen = false
    return exhausted
  }

  private async initializeDeadline(): Promise<void> {
    const snapshot = await this.claim.read()
    if (snapshot.usage.exhausted) {
      this.admissionOpen = false
      this.beginBudgetShutdown()
      return
    }
    const deadline =
      Date.parse(snapshot.createdAt) + snapshot.budgets.maxDurationMs
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      const exhausted = await this.enqueue(() => this.exhaustDuration())
      if (exhausted) this.beginBudgetShutdown()
      return
    }
    const delay = Math.min(remaining, MAX_TIMER_MS)
    this.deadlineTimer = setTimeout(() => {
      this.deadlineTimer = undefined
      void this.initializeDeadline().catch((error) => {
        this.pumpFailure ??= error
      })
    }, delay)
    if (typeof this.deadlineTimer === 'object' && 'unref' in this.deadlineTimer)
      this.deadlineTimer.unref()
  }

  private async exhaustDuration(): Promise<boolean> {
    const current = await this.claim.read()
    if (current.usage.exhausted) {
      this.admissionOpen = false
      return true
    }
    const next = updateTeamUsageDuration(
      current,
      Math.max(
        current.usage.durationMs,
        Date.now() - Date.parse(current.createdAt),
        current.budgets.maxDurationMs,
      ),
    )
    const saved = await this.claim.save(current.revision, next)
    const exhausted = saved.usage.exhausted !== null
    if (exhausted) this.admissionOpen = false
    return exhausted
  }

  private beginBudgetShutdown(): void {
    if (this.stopping || this.finalSnapshot || this.detachedSnapshot) return
    this.admissionOpen = false
    const shutdown = this.stopWithBudget()
    this.stopping = shutdown
    void shutdown
      .then((snapshot) => {
        this.finalSnapshot = snapshot
      })
      .catch((error) => {
        this.pumpFailure ??= error
      })
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
