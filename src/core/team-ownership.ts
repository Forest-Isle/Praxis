import {
  acceptLifecycle,
  parseAgentLifecycleSnapshot,
  type AgentLifecycleSnapshot,
} from './agent-orchestration.js'

export type TeamMemberAccess = 'read-only' | 'write'
export type TeamLeadPolicy = 'hybrid' | 'coordinator'
export type TeamExecutionPolicy = 'sequential' | 'swarm'
export type TeamCommitPolicy = 'lead'
export interface TeamBudgets {
  readonly maxAgents: number
  readonly maxConcurrent: number
  readonly maxTokens: number
  readonly maxDurationMs: number
  readonly shutdownDrainMs: number
}
export interface TeamUsage {
  readonly totalTokens: number
  readonly durationMs: number
  readonly exhausted: null | {
    readonly reason: 'tokens' | 'duration'
    readonly at: string
  }
}
export const DEFAULT_TEAM_BUDGETS: TeamBudgets = Object.freeze({
  maxAgents: 4,
  maxConcurrent: 4,
  maxTokens: 500000,
  maxDurationMs: 3600000,
  shutdownDrainMs: 5000,
})

export interface TeamMember {
  readonly name: string
  readonly agentType: string
  readonly access: TeamMemberAccess
}

export interface TeamTaskClaims {
  readonly files: readonly string[]
  readonly publicContracts: readonly string[]
  readonly generatedArtifacts: readonly string[]
  readonly migrations: readonly string[]
  readonly mergeTargets: readonly string[]
}

export interface TeamTask {
  readonly id: string
  readonly description: string
  readonly assignee: string
  readonly blockedBy: readonly string[]
  readonly claims: TeamTaskClaims
  readonly execution: AgentLifecycleSnapshot | null
  readonly usage: {
    readonly generation: number
    readonly totalTokens: number
    readonly durationMs: number
  }
}

export interface TeamSnapshot {
  readonly version: 2
  readonly revision: number
  readonly teamId: string
  readonly name: string
  readonly projectIdentity: string
  readonly leadSessionId: string
  readonly roster: readonly TeamMember[]
  readonly tasks: readonly TeamTask[]
  readonly createdAt: string
  readonly updatedAt: string
  readonly policy: {
    readonly lead: TeamLeadPolicy
    readonly execution: TeamExecutionPolicy
    readonly commit: TeamCommitPolicy
  }
  readonly budgets: TeamBudgets
  readonly usage: TeamUsage
}

export interface TeamAdmissionInput {
  readonly snapshot: TeamSnapshot
  readonly maxConcurrent: number
}

const lifecycleActive = new Set(['queued', 'running', 'waiting', 'cancelling'])
const TEAM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u
const claimKinds = [
  'files',
  'publicContracts',
  'generatedArtifacts',
  'migrations',
  'mergeTargets',
] as const

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Invalid Team value')
  return value as Record<string, unknown>
}

function closed(value: Record<string, unknown>, keys: readonly string[]): void {
  const allowed = new Set(keys)
  for (const key of Object.keys(value))
    if (!allowed.has(key)) throw new Error(`Unknown Team field: ${key}`)
}

function nonblank(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '')
    throw new Error(`Invalid ${label}`)
  return value
}

export function parseTeamId(value: unknown): string {
  if (typeof value !== 'string' || !TEAM_ID_PATTERN.test(value))
    throw new Error(`Invalid Team ID: ${String(value)}`)
  return value
}

function iso(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw new Error(`Invalid ${label} timestamp`)
  return value
}

function freeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>))
      freeze(child)
    Object.freeze(value)
  }
  return value
}

function claim(value: unknown): string {
  const result = nonblank(value, 'claim')
  if (
    result !== result.trim() ||
    result.includes('\\') ||
    result.includes('\0') ||
    result.startsWith('/') ||
    /^[A-Za-z]:\//.test(result)
  )
    throw new Error('Invalid repository-relative claim')
  const segments = result.split('/')
  if (
    segments.some(
      (segment) => segment === '' || segment === '.' || segment === '..',
    )
  )
    throw new Error('Invalid repository-relative claim')
  return result
}

function nextTeamTimestamp(current: TeamSnapshot): string {
  return new Date(
    Math.max(Date.now(), Date.parse(current.updatedAt)),
  ).toISOString()
}

function budget(value: unknown, key: keyof TeamBudgets, max?: number): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < (key === 'shutdownDrainMs' ? 0 : 1) ||
    (max !== undefined && (value as number) > max)
  )
    throw new Error(`Invalid Team budget: ${key}`)
  return value as number
}
export function parseTeamBudgetOverrides(
  value: unknown,
): Readonly<Partial<TeamBudgets>> {
  const source = record(value)
  closed(source, [
    'maxAgents',
    'maxConcurrent',
    'maxTokens',
    'maxDurationMs',
    'shutdownDrainMs',
  ])
  const result = {} as Record<keyof TeamBudgets, number>
  for (const key of Object.keys(source) as (keyof TeamBudgets)[])
    result[key] = budget(
      source[key],
      key,
      key === 'shutdownDrainMs' ? 600000 : undefined,
    )
  return freeze(result as Partial<TeamBudgets>)
}
function parseBudgets(value: unknown): TeamBudgets {
  const result = parseTeamBudgetOverrides(value)
  for (const key of [
    'maxAgents',
    'maxConcurrent',
    'maxTokens',
    'maxDurationMs',
    'shutdownDrainMs',
  ] as const)
    if (result[key] === undefined)
      throw new Error(`Invalid Team budget: ${key}`)
  const complete = result as TeamBudgets
  if (complete.maxConcurrent > complete.maxAgents)
    throw new Error('Invalid Team budget: maxConcurrent')
  return freeze(complete)
}
function parseUsage(value: unknown): TeamUsage {
  const source = record(value)
  closed(source, ['totalTokens', 'durationMs', 'exhausted'])
  if (
    !Number.isSafeInteger(source.totalTokens) ||
    (source.totalTokens as number) < 0 ||
    !Number.isSafeInteger(source.durationMs) ||
    (source.durationMs as number) < 0
  )
    throw new Error('Invalid Team usage')
  let exhausted: TeamUsage['exhausted'] = null
  if (source.exhausted !== null) {
    const entry = record(source.exhausted)
    closed(entry, ['reason', 'at'])
    if (entry.reason !== 'tokens' && entry.reason !== 'duration')
      throw new Error('Invalid Team exhaustion reason')
    exhausted = Object.freeze({
      reason: entry.reason,
      at: iso(entry.at, 'exhaustion'),
    })
  }
  return freeze({
    totalTokens: source.totalTokens as number,
    durationMs: source.durationMs as number,
    exhausted,
  })
}

function claims(value: unknown): TeamTaskClaims {
  const source = record(value)
  closed(source, claimKinds)
  const result = {} as Record<string, readonly string[]>
  for (const kind of claimKinds) {
    if (!Array.isArray(source[kind])) throw new Error(`Invalid ${kind} claims`)
    const values = source[kind].map(claim)
    if (new Set(values).size !== values.length)
      throw new Error('Duplicate claim')
    result[kind] = values
  }
  return freeze(result as unknown as TeamTaskClaims)
}

export function parseTeamSnapshot(value: unknown): TeamSnapshot {
  const source = record(value)
  closed(source, [
    'version',
    'revision',
    'teamId',
    'name',
    'projectIdentity',
    'leadSessionId',
    'roster',
    'tasks',
    'createdAt',
    'updatedAt',
    'policy',
    'budgets',
    'usage',
  ])
  if (source.version !== 1 && source.version !== 2)
    throw new Error('Invalid Team version')
  if (!Number.isSafeInteger(source.revision) || (source.revision as number) < 0)
    throw new Error('Invalid Team revision')
  const teamId = parseTeamId(source.teamId)
  const name = nonblank(source.name, 'Team name')
  const projectIdentity = nonblank(source.projectIdentity, 'project identity')
  const leadSessionId = nonblank(source.leadSessionId, 'lead session ID')
  const createdAt = iso(source.createdAt, 'createdAt')
  const updatedAt = iso(source.updatedAt, 'updatedAt')
  if (updatedAt < createdAt) throw new Error('updatedAt precedes createdAt')
  if (!Array.isArray(source.roster) || !Array.isArray(source.tasks))
    throw new Error('Invalid Team roster or tasks')
  const roster: TeamMember[] = source.roster.map((entry) => {
    const member = record(entry)
    closed(member, ['name', 'agentType', 'access'])
    const result = {
      name: nonblank(member.name, 'member name'),
      agentType: nonblank(member.agentType, 'agent type'),
      access: member.access,
    } as TeamMember
    if (result.access !== 'read-only' && result.access !== 'write')
      throw new Error('Invalid member access')
    return freeze(result)
  })
  const names = new Set(roster.map((member) => member.name))
  if (names.size !== roster.length || names.has('lead'))
    throw new Error('Invalid or reserved roster member name')
  const tasks: TeamTask[] = source.tasks.map((entry) => {
    const task = record(entry)
    closed(task, [
      'id',
      'description',
      'assignee',
      'blockedBy',
      'claims',
      'execution',
      'usage',
    ])
    const id = nonblank(task.id, 'task ID')
    const description = nonblank(task.description, 'task description')
    const assignee = nonblank(task.assignee, 'task assignee')
    if (!names.has(assignee))
      throw new Error('Task assignee is not a roster member')
    if (!Array.isArray(task.blockedBy)) throw new Error('Invalid task blockers')
    const blockedBy = task.blockedBy.map((blocker) =>
      nonblank(blocker, 'blocker ID'),
    )
    if (new Set(blockedBy).size !== blockedBy.length || blockedBy.includes(id))
      throw new Error('Invalid task blockers')
    const execution =
      task.execution === null
        ? null
        : parseAgentLifecycleSnapshot(task.execution)
    const taskUsage =
      source.version === 1
        ? {
            generation: execution?.generation ?? 0,
            totalTokens: 0,
            durationMs: 0,
          }
        : (() => {
            if (task.usage === undefined) throw new Error('Missing task usage')
            const u = record(task.usage)
            closed(u, ['generation', 'totalTokens', 'durationMs'])
            for (const key of [
              'generation',
              'totalTokens',
              'durationMs',
            ] as const)
              if (!Number.isSafeInteger(u[key]) || (u[key] as number) < 0)
                throw new Error('Invalid task usage')
            return {
              generation: u.generation as number,
              totalTokens: u.totalTokens as number,
              durationMs: u.durationMs as number,
            }
          })()
    return freeze({
      id,
      description,
      assignee,
      blockedBy: freeze(blockedBy),
      claims: claims(task.claims),
      execution,
      usage: freeze(taskUsage),
    })
  })
  const ids = new Set(tasks.map((task) => task.id))
  if (ids.size !== tasks.length) throw new Error('Duplicate task ID')
  for (const task of tasks)
    for (const blocker of task.blockedBy)
      if (!ids.has(blocker)) throw new Error('Unknown task blocker')
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error('Task dependency cycle')
    if (visited.has(id)) return
    visiting.add(id)
    const current = byId.get(id)
    if (!current) throw new Error('Unknown task blocker')
    for (const blocker of current.blockedBy) visit(blocker)
    visiting.delete(id)
    visited.add(id)
  }
  for (const task of tasks) visit(task.id)
  for (const task of tasks) {
    const generation = task.usage.generation
    if (
      source.version === 2 &&
      generation === 0 &&
      (task.execution !== null ||
        task.usage.totalTokens !== 0 ||
        task.usage.durationMs !== 0)
    )
      throw new Error('Task usage generation mismatch')
    if (
      source.version === 2 &&
      generation > 0 &&
      (task.execution === null || task.execution.generation !== generation)
    )
      throw new Error('Task usage generation mismatch')
  }
  const policy =
    source.version === 1
      ? {
          lead: 'hybrid' as const,
          execution: 'swarm' as const,
          commit: 'lead' as const,
        }
      : (() => {
          const p = record(source.policy)
          closed(p, ['lead', 'execution', 'commit'])
          if (
            (p.lead !== 'hybrid' && p.lead !== 'coordinator') ||
            (p.execution !== 'sequential' && p.execution !== 'swarm') ||
            p.commit !== 'lead'
          )
            throw new Error('Invalid Team policy')
          return { lead: p.lead, execution: p.execution, commit: p.commit }
        })()
  const budgets =
    source.version === 1
      ? {
          ...DEFAULT_TEAM_BUDGETS,
          maxAgents: Math.max(DEFAULT_TEAM_BUDGETS.maxAgents, roster.length),
        }
      : parseBudgets(source.budgets)
  if (roster.length > budgets.maxAgents)
    throw new Error('Team roster exceeds maxAgents')
  const usage =
    source.version === 1
      ? { totalTokens: 0, durationMs: 0, exhausted: null }
      : parseUsage(source.usage)
  const taskTotal = tasks.reduce((sum, task) => sum + task.usage.totalTokens, 0)
  if (usage.totalTokens !== taskTotal)
    throw new Error('Team token usage does not match tasks')
  return freeze({
    version: 2,
    revision: source.revision as number,
    teamId,
    name,
    projectIdentity,
    leadSessionId,
    roster: freeze(roster),
    tasks: freeze(tasks),
    createdAt,
    updatedAt,
    policy: freeze(policy) as {
      lead: TeamLeadPolicy
      execution: TeamExecutionPolicy
      commit: TeamCommitPolicy
    },
    budgets,
    usage,
  })
}

function claimSets(task: TeamTask): Map<string, Set<string>> {
  return new Map(claimKinds.map((kind) => [kind, new Set(task.claims[kind])]))
}

export function teamTasksConflict(left: TeamTask, right: TeamTask): boolean {
  const a = claimSets(left)
  const b = claimSets(right)
  return claimKinds.some((kind) => {
    const leftClaims = a.get(kind)
    const rightClaims = b.get(kind)
    return (
      leftClaims !== undefined &&
      rightClaims !== undefined &&
      [...leftClaims].some((value) => rightClaims.has(value))
    )
  })
}

export function selectTeamTaskAdmissions(
  input: TeamAdmissionInput,
): readonly string[] {
  const snapshot = parseTeamSnapshot(input.snapshot)
  if (!Number.isSafeInteger(input.maxConcurrent) || input.maxConcurrent <= 0)
    throw new Error('Invalid maxConcurrent')
  const active = snapshot.tasks.filter(
    (task) =>
      task.execution !== null && lifecycleActive.has(task.execution.state),
  )
  const effective = Math.min(
    input.maxConcurrent,
    snapshot.budgets.maxConcurrent,
    snapshot.budgets.maxAgents,
  )
  let remaining =
    (snapshot.policy.execution === 'sequential' ? 1 : effective) - active.length
  if (
    snapshot.usage.exhausted ||
    snapshot.usage.durationMs >= snapshot.budgets.maxDurationMs ||
    snapshot.usage.totalTokens >= snapshot.budgets.maxTokens
  )
    return []
  if (remaining <= 0) return []
  const selected: TeamTask[] = []
  const byId = new Map(snapshot.tasks.map((task) => [task.id, task]))
  for (const task of snapshot.tasks) {
    if (
      remaining === 0 ||
      task.execution !== null ||
      task.blockedBy.some((id) => {
        const dependency = byId.get(id)
        return (
          dependency === undefined ||
          dependency.execution === null ||
          dependency.execution.state !== 'completed' ||
          dependency.execution.acceptance !== 'accepted'
        )
      })
    )
      continue
    if (
      active.some((candidate) => teamTasksConflict(task, candidate)) ||
      selected.some((candidate) => teamTasksConflict(task, candidate))
    )
      continue
    selected.push(task)
    remaining--
  }
  return Object.freeze(selected.map((task) => task.id))
}

export function withTeamTaskExecution(
  snapshot: TeamSnapshot,
  taskId: string,
  execution: AgentLifecycleSnapshot,
): TeamSnapshot {
  const current = parseTeamSnapshot(snapshot)
  const parsed = parseAgentLifecycleSnapshot(execution)
  let found = false
  const tasks = current.tasks.map((task) => {
    if (task.id !== taskId) return task
    found = true
    return {
      ...task,
      execution: parsed,
      usage:
        task.usage.generation === parsed.generation
          ? task.usage
          : { generation: parsed.generation, totalTokens: 0, durationMs: 0 },
    }
  })
  if (!found) throw new Error('Unknown task ID')
  const totalTokens = tasks.reduce(
    (sum, task) => sum + task.usage.totalTokens,
    0,
  )
  return parseTeamSnapshot({
    ...current,
    revision: current.revision + 1,
    updatedAt: nextTeamTimestamp(current),
    usage: { ...current.usage, totalTokens },
    tasks,
  })
}

export function acceptTeamTaskExecution(
  snapshot: TeamSnapshot,
  taskId: string,
  generation?: number,
  acceptance: 'accepted' | 'rejected' = 'accepted',
): TeamSnapshot {
  const current = parseTeamSnapshot(snapshot)
  const task = current.tasks.find((candidate) => candidate.id === taskId)
  if (!task || task.execution === null) throw new Error('Task has no execution')
  const execution = acceptLifecycle(task.execution, generation, acceptance)
  return parseTeamSnapshot({
    ...current,
    revision: current.revision + 1,
    updatedAt: nextTeamTimestamp(current),
    tasks: current.tasks.map((candidate) =>
      candidate.id === taskId ? { ...candidate, execution } : candidate,
    ),
  })
}

export function recordTeamTaskProgress(
  snapshot: TeamSnapshot,
  taskId: string,
  progress: { generation: number; totalTokens: number; durationMs: number },
  exhaustedAt = new Date().toISOString(),
): TeamSnapshot {
  const current = parseTeamSnapshot(snapshot)
  if (
    !Number.isSafeInteger(progress.generation) ||
    progress.generation < 1 ||
    !Number.isSafeInteger(progress.totalTokens) ||
    progress.totalTokens < 0 ||
    !Number.isSafeInteger(progress.durationMs) ||
    progress.durationMs < 0
  )
    throw new Error('Invalid task progress')
  const task = current.tasks.find((candidate) => candidate.id === taskId)
  if (!task) throw new Error('Unknown task ID')
  if (!task.execution) throw new Error('Task has no execution')
  if (
    task.execution.generation !== progress.generation ||
    task.usage.generation !== progress.generation
  )
    throw new Error('Task progress generation mismatch')
  const usage = task.usage
  if (
    progress.totalTokens < usage.totalTokens ||
    progress.durationMs < usage.durationMs
  )
    throw new Error('Regressing task progress')
  const nextUsage = {
    ...usage,
    totalTokens: Math.max(usage.totalTokens, progress.totalTokens),
    durationMs: Math.max(usage.durationMs, progress.durationMs),
  }
  const totalTokens = current.tasks.reduce(
    (sum, candidate) =>
      sum +
      (candidate.id === taskId
        ? nextUsage.totalTokens
        : candidate.usage.totalTokens),
    0,
  )
  let exhausted = current.usage.exhausted
  if (!exhausted && totalTokens >= current.budgets.maxTokens) {
    exhausted = { reason: 'tokens', at: iso(exhaustedAt, 'exhaustion') }
  }
  return parseTeamSnapshot({
    ...current,
    revision: current.revision + 1,
    updatedAt: nextTeamTimestamp(current),
    usage: {
      ...current.usage,
      totalTokens,
      exhausted,
    },
    tasks: current.tasks.map((candidate) =>
      candidate.id === taskId ? { ...candidate, usage: nextUsage } : candidate,
    ),
  })
}

export function updateTeamUsageDuration(
  snapshot: TeamSnapshot,
  durationMs: number,
  exhaustedAt = new Date().toISOString(),
): TeamSnapshot {
  const current = parseTeamSnapshot(snapshot)
  if (!Number.isSafeInteger(durationMs) || durationMs < 0)
    throw new Error('Invalid Team duration')
  if (durationMs < current.usage.durationMs)
    throw new Error('Regressing Team duration')
  let exhausted = current.usage.exhausted
  if (!exhausted && durationMs >= current.budgets.maxDurationMs) {
    exhausted = { reason: 'duration', at: iso(exhaustedAt, 'exhaustion') }
  }
  return parseTeamSnapshot({
    ...current,
    revision: current.revision + 1,
    updatedAt: nextTeamTimestamp(current),
    usage: {
      ...current.usage,
      durationMs,
      exhausted,
    },
  })
}

export function markTeamBudgetExhausted(
  snapshot: TeamSnapshot,
  reason: 'tokens' | 'duration',
  at = new Date().toISOString(),
): TeamSnapshot {
  const current = parseTeamSnapshot(snapshot)
  iso(at, 'exhaustion')
  if (current.usage.exhausted) return current
  return parseTeamSnapshot({
    ...current,
    revision: current.revision + 1,
    updatedAt: nextTeamTimestamp(current),
    usage: {
      ...current.usage,
      exhausted: { reason, at },
    },
  })
}
