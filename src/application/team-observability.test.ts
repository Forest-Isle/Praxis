import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { parseTeamSnapshot } from '../core/team-ownership.js'
import { resolveProjectIdentity } from '../platform/project-identity.js'
import { sanitizeProjectPath } from '../platform/project-path-key.js'
import {
  projectTeamDashboard,
  readTeamMailboxAudit,
  readTeamWorktreeEvidence,
  renderTeamAudit,
  renderTeamSummary,
} from './team-observability.js'
import { NativeTeamWorkspaceProvider } from './team-workspace.js'

const exec = promisify(execFile)

async function git(cwd: string, ...args: string[]): Promise<void> {
  await exec('git', ['-C', cwd, ...args])
}

async function gitRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'praxis-observability-git-'))
  await git(root, 'init', '-q')
  await git(root, 'config', 'user.email', 'praxis@example.test')
  await git(root, 'config', 'user.name', 'Praxis Test')
  await writeFile(join(root, 'tracked.txt'), 'base\n')
  await git(root, 'add', 'tracked.txt')
  await git(root, 'commit', '-qm', 'seed')
  return root
}

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

  it('projects worktree lifecycle into health, bounded events, and summary', () => {
    const base = snapshot()
    const ready = parseTeamSnapshot({
      ...base,
      tasks: base.tasks.map((task) => ({ ...task, blockedBy: [] })),
    })
    const unsafeWorktree = {
      taskId: 'unsafe-task',
      path: '/tmp/unsafe',
      branch: null,
      access: 'write' as const,
      present: true,
      status: 'unsafe' as const,
      reason:
        'managed checkout ownership evidence may be outside bounded registry',
    }
    const retainedWorktree = {
      taskId: 'retained-task',
      path: '/tmp/retained',
      branch: null,
      access: 'write' as const,
      present: true,
      status: 'retained' as const,
      reason: 'legacy Team worktree is outside the managed lifecycle',
    }
    const worktrees = [unsafeWorktree, retainedWorktree]
    const dashboard = projectTeamDashboard(ready, {
      maxEvents: 2,
      worktrees,
    })
    expect(dashboard.health.status).toBe('degraded')
    expect(
      dashboard.events.filter((event) => event.kind === 'worktree'),
    ).toHaveLength(1)
    expect(renderTeamSummary(dashboard)).toContain('unsafe 1')
    expect(renderTeamSummary(dashboard)).toContain('retained 1')
    expect(
      projectTeamDashboard(ready, { worktrees: [retainedWorktree] }).health
        .status,
    ).toBe('idle')
    expect(
      projectTeamDashboard(base, { worktrees: [unsafeWorktree] }).health.status,
    ).toBe('blocked')
    const exhausted = parseTeamSnapshot({
      ...ready,
      usage: {
        ...ready.usage,
        exhausted: {
          reason: 'tokens',
          at: '2026-08-01T00:00:01.000Z',
        },
      },
    })
    expect(
      projectTeamDashboard(exhausted, { worktrees: [unsafeWorktree] }).health
        .status,
    ).toBe('stopping')
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
        status: 'unsafe',
        reason: 'managed and legacy Team worktree paths are both present',
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
        status: 'retained',
        reason: 'legacy Team worktree is outside the managed lifecycle',
      }),
    ])
  })

  it('uses the managed health record as authoritative Team evidence', async () => {
    const project = await gitRepository()
    const nativeRoot = await mkdtemp(
      join(tmpdir(), 'praxis-observability-native-'),
    )
    const identity = await resolveProjectIdentity(project)
    const current = evidenceSnapshot(identity)
    const provider = await NativeTeamWorkspaceProvider.open({
      nativeRoot,
      cwd: project,
      projectIdentity: identity,
    })
    const workspace = await provider.acquire({
      teamId: 'observability',
      taskId: 'task-1',
      generation: 1,
      access: 'write',
      leadSessionId: 'lead',
      executionToken: 'token',
    })
    await workspace.retain('observability retention')
    const entries = await readTeamWorktreeEvidence({
      nativeRoot,
      snapshot: current,
    })
    expect(entries).toEqual([
      expect.objectContaining({
        status: 'retained',
        reason: 'observability retention',
        present: true,
      }),
    ])
    await rm(project, { recursive: true, force: true })
    await rm(nativeRoot, { recursive: true, force: true })
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

  it('reports a managed task path without bounded ownership as unsafe', async () => {
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
    await mkdir(resolve(managed, '..'), { recursive: true })
    await writeFile(managed, 'not a directory\n')
    await expect(
      readTeamWorktreeEvidence({ nativeRoot, snapshot: current }),
    ).resolves.toEqual([
      expect.objectContaining({
        path: managed,
        status: 'unsafe',
        reason: `Unsafe Team worktree path is not a directory: ${managed}`,
      }),
    ])
  })

  it('distinguishes a present managed path outside the bounded registry window', async () => {
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
    await mkdir(managed, { recursive: true })
    const registry = join(
      nativeRoot,
      'state',
      'managed-worktrees',
      sanitizeProjectPath(await resolveProjectIdentity(project)),
    )
    await mkdir(registry, { recursive: true })
    await Promise.all(
      Array.from({ length: 65 }, (_, index) =>
        writeFile(
          join(registry, `${String(index).padStart(2, '0')}.json`),
          '{invalid',
        ),
      ),
    )
    await expect(
      readTeamWorktreeEvidence({ nativeRoot, snapshot: current }),
    ).resolves.toEqual([
      expect.objectContaining({
        path: managed,
        status: 'unsafe',
        reason:
          'managed checkout ownership evidence may be outside bounded registry',
      }),
    ])
  })
})
