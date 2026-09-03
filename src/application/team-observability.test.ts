import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseTeamSnapshot } from '../core/team-ownership.js'
import {
  projectTeamDashboard,
  readTeamMailboxAudit,
  readTeamWorktreeEvidence,
  renderTeamAudit,
} from './team-observability.js'

function snapshot(projectIdentity = '/tmp/project') {
  return parseTeamSnapshot({
    version: 2,
    revision: 3,
    teamId: 'observability',
    name: 'Observability',
    projectIdentity,
    leadSessionId: 'lead',
    roster: [{ name: 'worker', agentType: 'worker', access: 'write' }],
    tasks: [
      {
        id: 'task-0',
        description: 'prepare',
        assignee: 'worker',
        blockedBy: [],
        claims: {
          files: [],
          publicContracts: [],
          generatedArtifacts: [],
          migrations: [],
          mergeTargets: [],
        },
        execution: null,
        usage: { generation: 0, totalTokens: 0, durationMs: 0 },
      },
      {
        id: 'task-1',
        description: 'inspect',
        assignee: 'worker',
        blockedBy: ['task-0'],
        claims: {
          files: ['src/a.ts'],
          publicContracts: [],
          generatedArtifacts: [],
          migrations: [],
          mergeTargets: [],
        },
        execution: null,
        usage: { generation: 0, totalTokens: 0, durationMs: 0 },
      },
    ],
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:01.000Z',
    policy: { lead: 'coordinator', execution: 'swarm', commit: 'lead' },
    budgets: {
      maxAgents: 4,
      maxConcurrent: 2,
      maxTokens: 100,
      maxDurationMs: 1000,
      shutdownDrainMs: 10,
    },
    usage: { totalTokens: 0, durationMs: 0, exhausted: null },
  })
}

function evidenceSnapshot(projectIdentity: string) {
  const base = snapshot(projectIdentity)
  return parseTeamSnapshot({
    ...base,
    tasks: base.tasks.map((task) =>
      task.id === 'task-1'
        ? {
            ...task,
            execution: {
              generation: 1,
              revision: 0,
              state: 'completed' as const,
              owner: null,
              previousOwnerToken: 'token',
              terminalAt: '2026-08-01T00:00:00.000Z',
              acceptance: 'pending' as const,
            },
            usage: { generation: 1, totalTokens: 0, durationMs: 0 },
          }
        : task,
    ),
  })
}

describe('Team observability', () => {
  it('projects policy, dependencies, claims, usage and bounded events', () => {
    const dashboard = projectTeamDashboard(snapshot(), { maxEvents: 1 })
    expect(dashboard.team.leadPolicy).toBe('coordinator')
    const task = dashboard.tasks.find((entry) => entry.id === 'task-1')
    expect(task?.blockedBy).toEqual(['task-0'])
    expect(task?.claims.files).toEqual(['src/a.ts'])
    expect(task?.usage.durationMs).toBe(0)
    expect(dashboard.events).toHaveLength(1)
  })

  it('reads missing mailbox without creating state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-observability-'))
    const audit = await readTeamMailboxAudit({
      nativeRoot: root,
      snapshot: snapshot(),
    })
    expect(audit.pendingByRecipient).toEqual({ lead: 0, worker: 0 })
    await expect(stat(join(root, 'state'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('renders mailbox events', () => {
    const dashboard = projectTeamDashboard(snapshot(), {
      mailbox: {
        totalRecords: 1,
        retainedRecords: 1,
        pendingByRecipient: {},
        highestSequence: 1,
        prunedThrough: 0,
        records: [
          {
            version: 1,
            sequence: 1,
            messageId: 'm',
            teamId: 'observability',
            sender: 'lead',
            recipients: ['worker'],
            payload: { kind: 'text', text: 'hello' },
            createdAt: '2026-08-01T00:00:01.000Z',
          },
        ],
      },
    })
    expect(renderTeamAudit(dashboard)).toContain('[mailbox]')
  })

  it('retains only the bounded mailbox tail while counting pending records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-observability-bounded-'))
    const mailbox = join(
      root,
      'state',
      'teams',
      '-tmp-project',
      'observability',
      'mailbox',
    )
    await mkdir(mailbox, { recursive: true })
    const rows = Array.from({ length: 200 }, (_, index) => ({
      version: 1,
      sequence: index + 1,
      messageId: `m-${index + 1}`,
      teamId: 'observability',
      sender: 'lead',
      recipients: ['worker'],
      payload: { kind: 'text', text: `message-${index + 1}` },
      createdAt: '2026-08-01T00:00:00.000Z',
    }))
    await writeFile(
      join(mailbox, 'messages.jsonl'),
      `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
    )
    await writeFile(
      join(mailbox, 'state.json'),
      `${JSON.stringify({
        version: 1,
        teamId: 'observability',
        projectIdentity: '/tmp/project',
        cursors: { lead: 0, worker: 0 },
        prunedThrough: 0,
      })}\n`,
    )
    const audit = await readTeamMailboxAudit({
      nativeRoot: root,
      snapshot: snapshot(),
      maxRecords: 3,
      maxBytes: 1024,
    })
    expect(audit.totalRecords).toBe(200)
    expect(audit.retainedRecords).toBe(3)
    expect(audit.records.map((record) => record.sequence)).toEqual([
      198, 199, 200,
    ])
    expect(audit.pendingByRecipient.worker).toBe(200)
  })

  it('projects managed worktrees first and falls back to exact legacy paths', async () => {
    const project = await mkdtemp(
      join(tmpdir(), 'praxis-observability-project-'),
    )
    const nativeRoot = await mkdtemp(
      join(tmpdir(), 'praxis-observability-native-'),
    )
    const current = evidenceSnapshot(project)
    const hash = createHash('sha256')
      .update(`${project}\0observability\0task-1\0${1}`)
      .digest('hex')
      .slice(0, 24)
    const managed = join(
      project,
      '.praxis',
      'worktrees',
      'team',
      'observability',
      hash,
    )
    const legacy = join(
      nativeRoot,
      'state',
      'team-worktrees',
      project.replace(/[^a-zA-Z0-9]/g, '-'),
      'observability',
      hash,
    )
    await mkdir(managed, { recursive: true })
    await mkdir(legacy, { recursive: true })
    const entries = await readTeamWorktreeEvidence({
      nativeRoot,
      snapshot: current,
    })
    expect(entries).toEqual([
      expect.objectContaining({
        taskId: 'task-1',
        path: managed,
        present: true,
      }),
    ])
    await stat(legacy)
    await rm(managed, { recursive: true, force: true })
    await expect(
      readTeamWorktreeEvidence({ nativeRoot, snapshot: current }),
    ).resolves.toEqual([
      expect.objectContaining({
        taskId: 'task-1',
        path: legacy,
        present: true,
      }),
    ])
  })

  it('rejects Team worktree root and task symlinks without creating state', async () => {
    const project = await mkdtemp(
      join(tmpdir(), 'praxis-observability-project-'),
    )
    const nativeRoot = await mkdtemp(
      join(tmpdir(), 'praxis-observability-native-'),
    )
    const current = evidenceSnapshot(project)
    const managedTeam = join(project, '.praxis', 'worktrees', 'team')
    const target = await mkdtemp(join(tmpdir(), 'praxis-observability-target-'))
    await mkdir(join(project, '.praxis', 'worktrees'), { recursive: true })
    await symlink(target, managedTeam)
    await expect(
      readTeamWorktreeEvidence({ nativeRoot, snapshot: current }),
    ).rejects.toThrow(/symlink/u)
    await stat(target)
  })

  it('rejects exact managed and legacy task symlinks without touching targets', async () => {
    const project = await mkdtemp(
      join(tmpdir(), 'praxis-observability-project-'),
    )
    const nativeRoot = await mkdtemp(
      join(tmpdir(), 'praxis-observability-native-'),
    )
    const current = evidenceSnapshot(project)
    const hash = createHash('sha256')
      .update(`${project}\0observability\0task-1\0${1}`)
      .digest('hex')
      .slice(0, 24)
    const managed = join(
      project,
      '.praxis',
      'worktrees',
      'team',
      'observability',
      hash,
    )
    const legacy = join(
      nativeRoot,
      'state',
      'team-worktrees',
      project.replace(/[^a-zA-Z0-9]/g, '-'),
      'observability',
      hash,
    )
    const target = await mkdtemp(join(tmpdir(), 'praxis-observability-target-'))
    await mkdir(resolve(managed, '..'), { recursive: true })
    await symlink(target, managed)
    await expect(
      readTeamWorktreeEvidence({ nativeRoot, snapshot: current }),
    ).rejects.toThrow(/symlink/u)
    await stat(target)
    await rm(managed, { force: true })
    await mkdir(resolve(legacy, '..'), { recursive: true })
    await symlink(target, legacy)
    await expect(
      readTeamWorktreeEvidence({ nativeRoot, snapshot: current }),
    ).rejects.toThrow(/symlink/u)
    await stat(target)
  })

  it('keeps missing bounded Team worktree layouts read-only', async () => {
    const project = await mkdtemp(
      join(tmpdir(), 'praxis-observability-project-'),
    )
    const nativeRoot = await mkdtemp(
      join(tmpdir(), 'praxis-observability-native-'),
    )
    const result = await readTeamWorktreeEvidence({
      nativeRoot,
      snapshot: evidenceSnapshot(project),
      maxEntries: 1,
    })
    expect(result).toEqual([])
    await expect(stat(join(project, '.praxis'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await expect(stat(join(nativeRoot, 'state'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})
