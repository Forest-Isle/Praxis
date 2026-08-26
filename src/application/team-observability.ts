import { readFile, lstat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import {
  parseTeamMailboxMessage,
  type TeamMailboxMessage,
} from '../core/team-mailbox.js'
import type { TeamSnapshot, TeamTask } from '../core/team-ownership.js'
import { sanitizeProjectPath } from '../platform/project-path-key.js'

export interface TeamDashboard {
  readonly team: {
    id: string
    name: string
    projectIdentity: string
    leadPolicy: string
    executionPolicy: string
    commitPolicy: string
    lifecycle: string
    revision: number
    createdAt: string
    updatedAt: string
  }
  readonly agents: readonly {
    name: string
    agentType: string
    access: string
    lifecycle: string
    taskId: string | null
    generation: number
    usage: { totalTokens: number; durationMs: number }
  }[]
  readonly tasks: readonly {
    id: string
    description: string
    assignee: string
    blockedBy: readonly string[]
    state: string
    claims: TeamTask['claims']
    generation: number
    usage: { totalTokens: number; durationMs: number }
    acceptance: 'pending' | 'accepted' | 'rejected' | 'not-applicable'
  }[]
  readonly worktrees: readonly {
    taskId: string
    path: string | null
    branch: string | null
    access: string
    present: boolean
  }[]
  readonly mailbox: {
    totalRecords: number
    retainedRecords: number
    pendingByRecipient: Readonly<Record<string, number>>
    highestSequence: number
    prunedThrough: number
  }
  readonly budgets: {
    configured: { maxTokens: number; maxDurationMs: number }
    used: { totalTokens: number; durationMs: number }
    exhaustedReason: string | null
  }
  readonly health: {
    status: 'healthy' | 'idle' | 'blocked' | 'degraded' | 'stopping'
    blockers: readonly string[]
    activeCount: number
  }
  readonly events: readonly {
    kind: string
    at: string
    summary: string
    detail?: string
  }[]
}

export interface TeamObservabilityOptions {
  readonly mailbox?: TeamMailboxAudit
  readonly worktrees?: readonly TeamWorktreeEvidence[]
  readonly maxEvents?: number
}
export interface TeamMailboxAudit {
  readonly totalRecords: number
  readonly retainedRecords: number
  readonly pendingByRecipient: Readonly<Record<string, number>>
  readonly highestSequence: number
  readonly prunedThrough: number
  readonly records: readonly TeamMailboxMessage[]
}
export interface TeamWorktreeEvidence {
  readonly taskId: string
  readonly path: string
  readonly branch: string | null
  readonly access: string
  readonly present: boolean
}

function freeze<T>(value: T): T {
  return Object.freeze(value)
}
function taskState(task: TeamTask): string {
  return (
    task.execution?.state ?? (task.blockedBy.length ? 'blocked' : 'pending')
  )
}

export function projectTeamDashboard(
  snapshot: TeamSnapshot,
  options: TeamObservabilityOptions = {},
): TeamDashboard {
  const tasks = snapshot.tasks.map((task) => ({
    id: task.id,
    description: task.description,
    assignee: task.assignee,
    blockedBy: freeze([...task.blockedBy]),
    claims: task.claims,
    state: taskState(task),
    generation: task.usage.generation,
    usage: {
      totalTokens: task.usage.totalTokens,
      durationMs: task.usage.durationMs,
    },
    acceptance: task.execution?.acceptance ?? ('not-applicable' as const),
  }))
  const taskByAgent = new Map(tasks.map((task) => [task.assignee, task]))
  const agents = snapshot.roster.map((member) => {
    const task = taskByAgent.get(member.name)
    return {
      name: member.name,
      agentType: member.agentType,
      access: member.access,
      lifecycle: task?.state ?? 'idle',
      taskId: task?.id ?? null,
      generation: task?.generation ?? 0,
      usage: task?.usage ?? { totalTokens: 0, durationMs: 0 },
    }
  })
  const active = tasks.filter((task) =>
    ['queued', 'running', 'waiting', 'cancelling'].includes(task.state),
  ).length
  const blockers = tasks
    .filter((task) => task.state === 'blocked' || task.state === 'failed')
    .map((task) => `${task.id}: ${task.state}`)
  if (snapshot.usage.exhausted)
    blockers.push(`budget exhausted: ${snapshot.usage.exhausted.reason}`)
  const lifecycle = snapshot.usage.exhausted
    ? 'stopping'
    : active
      ? 'active'
      : 'idle'
  const status = snapshot.usage.exhausted
    ? 'stopping'
    : blockers.length
      ? 'blocked'
      : active
        ? 'healthy'
        : 'idle'
  const mailboxEvents = (options.mailbox?.records ?? []).map((record) => ({
    kind: 'mailbox',
    at: record.createdAt,
    summary: `${record.sender} -> ${record.recipients.join(',')} ${record.payload.kind}${'phase' in record.payload ? `/${record.payload.phase}` : ''}`,
  }))
  const events =
    (options.maxEvents === undefined ? 32 : options.maxEvents) <= 0
      ? []
      : [
          {
            kind: 'team',
            at: snapshot.updatedAt,
            summary: `${snapshot.name} revision ${snapshot.revision}`,
          },
          ...blockers.map((detail) => ({
            kind: 'blocker',
            at: snapshot.updatedAt,
            summary: detail,
          })),
          ...mailboxEvents,
        ].slice(0, options.maxEvents ?? 32)
  return freeze({
    team: {
      id: snapshot.teamId,
      name: snapshot.name,
      projectIdentity: snapshot.projectIdentity,
      leadPolicy: snapshot.policy.lead,
      executionPolicy: snapshot.policy.execution,
      commitPolicy: snapshot.policy.commit,
      lifecycle,
      revision: snapshot.revision,
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt,
    },
    agents: freeze(agents),
    tasks: freeze(tasks),
    worktrees: freeze((options.worktrees ?? []).map((entry) => ({ ...entry }))),
    mailbox: options.mailbox
      ? {
          totalRecords: options.mailbox.totalRecords,
          retainedRecords: options.mailbox.retainedRecords,
          pendingByRecipient: options.mailbox.pendingByRecipient,
          highestSequence: options.mailbox.highestSequence,
          prunedThrough: options.mailbox.prunedThrough,
        }
      : {
          totalRecords: 0,
          retainedRecords: 0,
          pendingByRecipient: {},
          highestSequence: 0,
          prunedThrough: 0,
        },
    budgets: {
      configured: {
        maxTokens: snapshot.budgets.maxTokens,
        maxDurationMs: snapshot.budgets.maxDurationMs,
      },
      used: {
        totalTokens: snapshot.usage.totalTokens,
        durationMs: snapshot.usage.durationMs,
      },
      exhaustedReason: snapshot.usage.exhausted?.reason ?? null,
    },
    health: { status, blockers: freeze(blockers), activeCount: active },
    events: freeze(events),
  })
}

export function renderTeamSummary(dashboard: TeamDashboard): string {
  const h = dashboard.health
  const base = `${dashboard.team.name} (${dashboard.team.id}): ${h.status}, ${h.activeCount} active, ${dashboard.tasks.length} tasks`
  return h.blockers.length
    ? `${base} — ${h.blockers.slice(0, 3).join('; ')}`
    : base
}
export function renderTeamAudit(dashboard: TeamDashboard): string {
  return dashboard.events
    .map(
      (event) =>
        `${event.at} [${event.kind}] ${event.summary}${event.detail ? ` — ${event.detail}` : ''}`,
    )
    .join('\n')
}

export async function readTeamMailboxAudit(input: {
  nativeRoot: string
  snapshot: TeamSnapshot
  maxRecords?: number
  maxBytes?: number
}): Promise<TeamMailboxAudit> {
  const maxRecords = input.maxRecords ?? 64
  const maxBytes = input.maxBytes ?? 256 * 1024
  if (!Number.isSafeInteger(maxRecords) || maxRecords <= 0)
    throw new Error('Invalid Team mailbox maxRecords')
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
    throw new Error('Invalid Team mailbox maxBytes')
  const mailboxDir = join(
    resolve(input.nativeRoot),
    'state',
    'teams',
    sanitizeProjectPath(input.snapshot.projectIdentity),
    input.snapshot.teamId,
    'mailbox',
  )
  const messagesPath = join(mailboxDir, 'messages.jsonl')
  const statePath = join(mailboxDir, 'state.json')
  try {
    await lstat(messagesPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return {
        totalRecords: 0,
        retainedRecords: 0,
        pendingByRecipient: Object.fromEntries(
          ['lead', ...input.snapshot.roster.map((member) => member.name)].map(
            (member) => [member, 0],
          ),
        ),
        highestSequence: 0,
        prunedThrough: 0,
        records: [],
      }
    throw error
  }
  let prunedThrough = 0
  let cursors: Record<string, number> = {}
  try {
    const state = JSON.parse(await readFile(statePath, 'utf8')) as Record<
      string,
      unknown
    >
    if (
      state.teamId !== input.snapshot.teamId ||
      state.projectIdentity !== input.snapshot.projectIdentity ||
      !Number.isSafeInteger(state.prunedThrough) ||
      (state.prunedThrough as number) < 0 ||
      typeof state.cursors !== 'object' ||
      state.cursors === null
    )
      throw new Error('Invalid Team mailbox state')
    prunedThrough = state.prunedThrough as number
    cursors = state.cursors as Record<string, number>
    for (const cursor of Object.values(cursors))
      if (!Number.isSafeInteger(cursor) || cursor < 0)
        throw new Error('Invalid Team mailbox cursor')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new Error(`Corrupt Team mailbox record: ${statePath}`, {
        cause: error,
      })
  }
  const retainedRows: TeamMailboxMessage[] = []
  const retainedSizes: number[] = []
  let retainedBytes = 0
  let totalRecords = 0
  let highestSequence = 0
  let previous = prunedThrough
  const pendingByRecipient: Record<string, number> = {}
  for (const member of ['lead', ...input.snapshot.roster.map((m) => m.name)])
    pendingByRecipient[member] = 0
  const reader = createInterface({
    input: createReadStream(messagesPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })
  try {
    for await (const line of reader) {
      if (!line) continue
      const bytes = Buffer.byteLength(line, 'utf8') + 1
      let record: TeamMailboxMessage
      try {
        record = parseTeamMailboxMessage(JSON.parse(line))
      } catch (error) {
        throw new Error(`Corrupt Team mailbox record: ${messagesPath}`, {
          cause: error,
        })
      }
      if (
        record.teamId !== input.snapshot.teamId ||
        record.sequence <= previous
      )
        throw new Error(`Corrupt Team mailbox record: ${messagesPath}`)
      previous = record.sequence
      totalRecords += 1
      highestSequence = record.sequence
      for (const recipient of record.recipients)
        if (
          recipient in pendingByRecipient &&
          record.sequence > (cursors[recipient] ?? prunedThrough)
        )
          pendingByRecipient[recipient] =
            (pendingByRecipient[recipient] ?? 0) + 1
      retainedRows.push(record)
      retainedSizes.push(bytes)
      retainedBytes += bytes
      while (retainedRows.length > maxRecords || retainedBytes > maxBytes) {
        retainedBytes -= retainedSizes.shift() ?? 0
        retainedRows.shift()
      }
    }
  } finally {
    reader.close()
  }
  /*
   * The stream above deliberately keeps only the bounded tail while still
   * validating ordering and counting pending messages across the file.
   */
  return {
    totalRecords,
    retainedRecords: retainedRows.length,
    pendingByRecipient,
    highestSequence,
    prunedThrough,
    records: freeze(retainedRows),
  }
}

export async function readTeamWorktreeEvidence(input: {
  nativeRoot: string
  snapshot: TeamSnapshot
  maxEntries?: number
}): Promise<readonly TeamWorktreeEvidence[]> {
  const root = join(
    resolve(input.nativeRoot),
    'state',
    'team-worktrees',
    sanitizeProjectPath(input.snapshot.projectIdentity),
    input.snapshot.teamId,
  )
  try {
    const rootStat = await lstat(root)
    if (rootStat.isSymbolicLink())
      throw new Error(`Unsafe Team worktree symlink: ${root}`)
    if (!rootStat.isDirectory()) return []
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const result: TeamWorktreeEvidence[] = []
  const limit = input.maxEntries ?? 64
  if (!Number.isSafeInteger(limit) || limit <= 0)
    throw new Error('Invalid Team worktree maxEntries')
  const members = new Map(
    input.snapshot.roster.map((member) => [member.name, member]),
  )
  for (const task of input.snapshot.tasks) {
    if (result.length >= limit) break
    if (task.usage.generation <= 0) continue
    const member = members.get(task.assignee)
    if (!member || member.access !== 'write') continue
    const hash = createHash('sha256')
      .update(
        `${input.snapshot.projectIdentity}\0${input.snapshot.teamId}\0${task.id}\0${task.usage.generation}`,
      )
      .digest('hex')
      .slice(0, 24)
    const path = join(root, hash)
    let stat
    try {
      stat = await lstat(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    if (stat.isSymbolicLink())
      throw new Error(`Unsafe Team worktree symlink: ${path}`)
    if (!stat.isDirectory()) continue
    let branch: string | null = null
    try {
      branch =
        (await readFile(join(path, '.praxis-branch'), 'utf8')).trim() || null
    } catch {
      /* optional metadata */
    }
    result.push({
      taskId: task.id,
      path,
      branch: branch ?? `praxis/team/${input.snapshot.teamId}/${hash}`,
      access: 'write',
      present: true,
    })
  }
  return freeze(result)
}
