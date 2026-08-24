import { describe, expect, it } from 'vitest'

import {
  continueLifecycle,
  createAgentLifecycle,
  markLifecycleOrphaned,
  transitionLifecycle,
  type AgentLifecycleSnapshot,
} from './agent-orchestration.js'
import {
  acceptTeamTaskExecution,
  DEFAULT_TEAM_BUDGETS,
  markTeamBudgetExhausted,
  parseTeamBudgetOverrides,
  parseTeamSnapshot,
  parseTeamId,
  recordTeamTaskProgress,
  selectTeamTaskAdmissions,
  teamTasksConflict,
  updateTeamUsageDuration,
  withTeamTaskExecution,
} from './team-ownership.js'

const owner = (token: string) => ({
  token,
  pid: 1,
  acquiredAt: '2026-08-24T00:00:00.000Z',
})
const claims = (files: string[] = []) => ({
  files,
  publicContracts: [],
  generatedArtifacts: [],
  migrations: [],
  mergeTargets: [],
})
const base = (tasks: unknown[] = []) => ({
  version: 1,
  revision: 0,
  teamId: 'team-1',
  name: 'Team',
  projectIdentity: 'project',
  leadSessionId: 'lead-session',
  roster: [{ name: 'worker', agentType: 'agent', access: 'write' }],
  tasks,
  createdAt: '2026-08-24T00:00:00.000Z',
  updatedAt: '2026-08-24T00:00:00.000Z',
})
const task = (id: string, files: string[] = [], blockedBy: string[] = []) => ({
  id,
  description: id,
  assignee: 'worker',
  blockedBy,
  claims: claims(files),
  execution: null,
})

const snapshotWith = (
  tasks: unknown[],
  changes: Record<string, unknown> = {},
) => ({ ...base(tasks), ...changes })

const versionTwo = (
  tasks: unknown[] = [],
  changes: Record<string, unknown> = {},
) => ({
  ...parseTeamSnapshot(base(tasks)),
  policy: { lead: 'hybrid', execution: 'sequential', commit: 'lead' },
  ...changes,
})

const completed = (token = 'worker'): AgentLifecycleSnapshot => {
  let value = createAgentLifecycle(owner(token))
  value = transitionLifecycle(value, 'running', token)
  return transitionLifecycle(value, 'completed', token)
}

const terminal = (
  state: 'failed' | 'cancelled' | 'orphaned',
): AgentLifecycleSnapshot => {
  let value = createAgentLifecycle(owner('worker'))
  value = transitionLifecycle(value, 'running', 'worker')
  if (state === 'orphaned') return markLifecycleOrphaned(value, 'worker')
  if (state === 'cancelled') {
    value = transitionLifecycle(value, 'cancelling', 'worker')
    return transitionLifecycle(value, 'cancelled', 'worker')
  }
  return transitionLifecycle(value, 'failed', 'worker')
}

const parsedTask = (value: unknown, index = 0) => {
  const found = parseTeamSnapshot(value).tasks.at(index)
  if (!found) throw new Error('missing test task')
  return found
}

describe('team ownership contract', () => {
  it('uses one bounded Team ID contract', () => {
    expect(parseTeamId('team-1')).toBe('team-1')
    expect(parseTeamId('A_team-9')).toBe('A_team-9')
    for (const value of [
      '',
      ' ',
      '.',
      '..',
      'a/b',
      'a\\b',
      'a b',
      'a\0b',
      '/absolute',
      'a'.repeat(65),
    ])
      expect(() => parseTeamId(value)).toThrow(/Invalid Team ID/u)
  })

  it('migrates a literal v1 snapshot into a frozen strict v2 snapshot', () => {
    const snapshot = parseTeamSnapshot(base([task('one', ['src/a.ts'])]))
    expect(snapshot).toMatchObject({
      version: 2,
      policy: { lead: 'hybrid', execution: 'swarm', commit: 'lead' },
      budgets: DEFAULT_TEAM_BUDGETS,
      usage: { totalTokens: 0, durationMs: 0, exhausted: null },
      tasks: [
        {
          usage: { generation: 0, totalTokens: 0, durationMs: 0 },
        },
      ],
    })
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.policy)).toBe(true)
    expect(Object.isFrozen(snapshot.budgets)).toBe(true)
    expect(Object.isFrozen(snapshot.usage)).toBe(true)
    expect(Object.isFrozen(snapshot.tasks.at(0)?.usage)).toBe(true)
    expect(Object.isFrozen(snapshot.tasks.at(0)?.claims)).toBe(true)
  })

  it('rejects invalid claims and dependency cycles', () => {
    expect(() =>
      parseTeamSnapshot(base([task('one', ['../secret'])])),
    ).toThrow()
    expect(() =>
      parseTeamSnapshot(
        base([task('one', [], ['two']), task('two', [], ['one'])]),
      ),
    ).toThrow(/cycle/u)
  })

  it('requires every authoritative v2 policy, budget, and usage field', () => {
    const canonical = versionTwo([task('one')])
    const without = (key: string) =>
      Object.fromEntries(
        Object.entries(canonical).filter(([field]) => field !== key),
      )
    const first = canonical.tasks[0]
    if (!first) throw new Error('missing task fixture')
    const taskWithoutUsage = Object.fromEntries(
      Object.entries(first).filter(([field]) => field !== 'usage'),
    )
    for (const value of [
      without('policy'),
      without('budgets'),
      without('usage'),
      { ...canonical, tasks: [taskWithoutUsage] },
    ])
      expect(() => parseTeamSnapshot(value)).toThrow()
  })

  it('requires explicit Lead-owned v2 commits and validates budget overrides', () => {
    const canonical = versionTwo([task('one')])
    expect(() =>
      parseTeamSnapshot({
        ...canonical,
        policy: { lead: 'hybrid', execution: 'sequential' },
      }),
    ).toThrow(/Team field|policy/u)
    expect(() =>
      parseTeamSnapshot({
        ...canonical,
        policy: { ...canonical.policy, commit: 'members' },
      }),
    ).toThrow(/Invalid Team policy/u)

    const overrides = parseTeamBudgetOverrides({
      maxTokens: 123,
      shutdownDrainMs: 0,
    })
    expect(overrides).toEqual({ maxTokens: 123, shutdownDrainMs: 0 })
    expect(Object.isFrozen(overrides)).toBe(true)
    for (const value of [
      { unknown: 1 },
      { maxTokens: 1.5 },
      { maxAgents: 0 },
      { shutdownDrainMs: 600001 },
    ])
      expect(() => parseTeamBudgetOverrides(value)).toThrow()
  })

  it('rejects invalid budgets, unsafe counters, and oversized rosters', () => {
    const canonical = versionTwo([task('one')])
    for (const budgets of [
      { ...canonical.budgets, maxAgents: 1, maxConcurrent: 2 },
      { ...canonical.budgets, maxTokens: -1 },
      { ...canonical.budgets, maxDurationMs: Number.MAX_SAFE_INTEGER + 1 },
      { ...canonical.budgets, shutdownDrainMs: 600_001 },
    ])
      expect(() => parseTeamSnapshot({ ...canonical, budgets })).toThrow()

    expect(() =>
      parseTeamSnapshot({
        ...canonical,
        budgets: { ...canonical.budgets, maxAgents: 1, maxConcurrent: 1 },
        roster: [
          ...canonical.roster,
          { name: 'worker-2', agentType: 'agent', access: 'read-only' },
        ],
      }),
    ).toThrow(/roster exceeds maxAgents/u)

    const first = canonical.tasks[0]
    if (!first) throw new Error('missing task fixture')
    for (const value of [-1, Number.MAX_SAFE_INTEGER + 1])
      expect(() =>
        parseTeamSnapshot({
          ...canonical,
          tasks: [
            {
              ...first,
              usage: { ...first.usage, totalTokens: value },
            },
          ],
          usage: { ...canonical.usage, totalTokens: value },
        }),
      ).toThrow()
  })

  it('defaults new v2 Teams to sequential and requires explicit Swarm concurrency', () => {
    const tasks = [task('first'), task('second')]
    const sequential = parseTeamSnapshot(versionTwo(tasks))
    expect(
      selectTeamTaskAdmissions({ snapshot: sequential, maxConcurrent: 2 }),
    ).toEqual(['first'])
    const swarm = parseTeamSnapshot({
      ...versionTwo(tasks),
      policy: { lead: 'hybrid', execution: 'swarm', commit: 'lead' },
    })
    expect(
      selectTeamTaskAdmissions({ snapshot: swarm, maxConcurrent: 2 }),
    ).toEqual(['first', 'second'])
  })

  it('closes admission for explicit, token, and duration exhaustion', () => {
    const canonical = parseTeamSnapshot(versionTwo([task('one')]))
    const cases = [
      markTeamBudgetExhausted(canonical, 'tokens', '2026-08-24T00:00:01.000Z'),
      parseTeamSnapshot({
        ...canonical,
        budgets: { ...canonical.budgets, maxTokens: 1 },
        tasks: [
          {
            ...canonical.tasks[0],
            execution: createAgentLifecycle(owner('budget-worker')),
            usage: { generation: 1, totalTokens: 1, durationMs: 0 },
          },
        ],
        usage: { ...canonical.usage, totalTokens: 1 },
      }),
      parseTeamSnapshot({
        ...canonical,
        budgets: { ...canonical.budgets, maxDurationMs: 1 },
        usage: { ...canonical.usage, durationMs: 1 },
      }),
    ]
    for (const snapshot of cases)
      expect(selectTeamTaskAdmissions({ snapshot, maxConcurrent: 1 })).toEqual(
        [],
      )
  })

  it('admits stable disjoint work while serializing claims', () => {
    const snapshot = parseTeamSnapshot(
      base([
        task('first', ['src/a.ts']),
        task('second', ['src/b.ts']),
        task('third', ['src/a.ts']),
      ]),
    )
    expect(selectTeamTaskAdmissions({ snapshot, maxConcurrent: 2 })).toEqual([
      'first',
      'second',
    ])
    const first = snapshot.tasks.at(0)
    const third = snapshot.tasks.at(2)
    expect(first && third && teamTasksConflict(first, third)).toBe(true)
  })

  it('requires explicit lead acceptance after completion', () => {
    let execution: AgentLifecycleSnapshot = createAgentLifecycle(
      owner('worker'),
    )
    execution = transitionLifecycle(execution, 'running', 'worker')
    execution = transitionLifecycle(execution, 'completed', 'worker')
    const running = withTeamTaskExecution(
      parseTeamSnapshot(base([task('one')])),
      'one',
      execution,
    )
    expect(
      selectTeamTaskAdmissions({ snapshot: running, maxConcurrent: 1 }),
    ).toEqual([])
    const accepted = acceptTeamTaskExecution(running, 'one')
    expect(accepted.tasks[0]?.execution?.acceptance).toBe('accepted')
  })

  it('rejects closed-world, identity, timestamp, roster, and task violations', () => {
    const invalid = [
      snapshotWith([], { extra: true }),
      snapshotWith([], { version: 2 }),
      snapshotWith([], { revision: -1 }),
      snapshotWith([], { revision: 1.2 }),
      snapshotWith([], { teamId: ' ' }),
      snapshotWith([], { name: '' }),
      snapshotWith([], { projectIdentity: ' ' }),
      snapshotWith([], { leadSessionId: '' }),
      snapshotWith([], { createdAt: '2026-08-24T00:00:00Z' }),
      snapshotWith([], { updatedAt: '2026-08-23T00:00:00.000Z' }),
      snapshotWith([], {
        roster: [
          { name: 'worker', agentType: 'agent', access: 'write', extra: true },
        ],
      }),
      snapshotWith([], {
        roster: [
          { name: 'worker', agentType: 'agent', access: 'write' },
          { name: 'worker', agentType: 'other', access: 'read-only' },
        ],
      }),
      snapshotWith([], {
        roster: [{ name: 'lead', agentType: 'agent', access: 'write' }],
      }),
      snapshotWith([task('one')], { tasks: [{ ...task('one'), extra: true }] }),
      snapshotWith([task('one')], { tasks: [task('one'), task('one')] }),
      snapshotWith([{ ...task('one'), id: ' ' }]),
      snapshotWith([{ ...task('one'), description: '' }]),
      snapshotWith([{ ...task('one'), assignee: 'missing' }]),
    ]
    for (const value of invalid)
      expect(() => parseTeamSnapshot(value)).toThrow()
  })

  it('rejects every malformed blocker and repository claim form', () => {
    const malformed = [
      { ...task('one'), blockedBy: ['one'] },
      { ...task('one'), blockedBy: ['missing'] },
      { ...task('one'), blockedBy: ['missing', 'missing'] },
      { ...task('one'), claims: { ...claims(), extra: [] } },
      { ...task('one'), claims: { ...claims(), files: [''] } },
      { ...task('one'), claims: { ...claims(), files: ['a//b'] } },
      { ...task('one'), claims: { ...claims(), files: ['./a'] } },
      { ...task('one'), claims: { ...claims(), files: ['a/../b'] } },
      { ...task('one'), claims: { ...claims(), files: ['/absolute'] } },
      { ...task('one'), claims: { ...claims(), files: ['C:/absolute'] } },
      { ...task('one'), claims: { ...claims(), files: ['a\\b'] } },
      { ...task('one'), claims: { ...claims(), files: ['a\0b'] } },
      { ...task('one'), claims: { ...claims(), files: ['a', 'a'] } },
    ]
    for (const value of malformed)
      expect(() => parseTeamSnapshot(snapshotWith([value]))).toThrow()
  })

  it('defensively clones and freezes source graphs', () => {
    const sourceTask = task('one', ['src/a.ts'])
    const source = snapshotWith([sourceTask])
    const parsed = parseTeamSnapshot(source)
    const sourceMember = source.roster.at(0)
    if (!sourceMember) throw new Error('missing source member')
    sourceMember.name = 'changed'
    sourceTask.claims.files[0] = 'changed'
    expect(parsed.roster[0]?.name).toBe('worker')
    expect(parsed.tasks[0]?.claims.files[0]).toBe('src/a.ts')
    expect(Object.isFrozen(parsed.roster[0])).toBe(true)
    expect(Object.isFrozen(parsed.tasks[0]?.claims.files)).toBe(true)
  })

  it('keeps claim classes separate and consumes active capacity', () => {
    const left = task('left', ['same'])
    const right = task('right', ['same'])
    const cross = {
      ...task('cross'),
      claims: { ...claims(), migrations: ['same'] },
    }
    expect(
      teamTasksConflict(
        parsedTask(snapshotWith([left, right]), 0),
        parsedTask(snapshotWith([left, right]), 1),
      ),
    ).toBe(true)
    expect(
      teamTasksConflict(
        parsedTask(snapshotWith([left])),
        parsedTask(snapshotWith([cross])),
      ),
    ).toBe(false)
    const active = withTeamTaskExecution(
      parseTeamSnapshot(
        snapshotWith([
          task('active', ['same']),
          task('next', ['same']),
          task('free'),
        ]),
      ),
      'active',
      createAgentLifecycle(owner('worker')),
    )
    expect(
      selectTeamTaskAdmissions({ snapshot: active, maxConcurrent: 2 }),
    ).toEqual(['free'])
  })

  it('serializes selected conflicts and requires accepted dependencies', () => {
    const snapshot = parseTeamSnapshot(
      snapshotWith([
        task('first', ['same']),
        task('second', ['same']),
        task('third'),
      ]),
    )
    expect(selectTeamTaskAdmissions({ snapshot, maxConcurrent: 3 })).toEqual([
      'first',
      'third',
    ])
    const dependency = withTeamTaskExecution(
      parseTeamSnapshot(snapshotWith([task('dep')])),
      'dep',
      completed(),
    )
    const blocked = parseTeamSnapshot(
      snapshotWith([dependency.tasks[0], task('child', [], ['dep'])]),
    )
    expect(
      selectTeamTaskAdmissions({ snapshot: blocked, maxConcurrent: 1 }),
    ).toEqual([])
    const accepted = acceptTeamTaskExecution(dependency, 'dep')
    const ready = parseTeamSnapshot(
      snapshotWith([accepted.tasks[0], task('child', [], ['dep'])]),
    )
    expect(
      selectTeamTaskAdmissions({ snapshot: ready, maxConcurrent: 1 }),
    ).toEqual(['child'])
  })

  it('does not readmit terminal unaccepted executions and rejects invalid capacity', () => {
    const executions = ['failed', 'cancelled', 'orphaned'] as const
    for (const state of executions) {
      const snapshot = withTeamTaskExecution(
        parseTeamSnapshot(snapshotWith([task('one')])),
        'one',
        terminal(state),
      )
      expect(selectTeamTaskAdmissions({ snapshot, maxConcurrent: 1 })).toEqual(
        [],
      )
    }
    const snapshot = parseTeamSnapshot(snapshotWith([task('one')]))
    for (const maxConcurrent of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
      expect(() =>
        selectTeamTaskAdmissions({ snapshot, maxConcurrent }),
      ).toThrow()
  })

  it('keeps incomplete or rejected dependencies blocked', () => {
    const rejected = acceptTeamTaskExecution(
      withTeamTaskExecution(
        parseTeamSnapshot(snapshotWith([task('dep')])),
        'dep',
        completed(),
      ),
      'dep',
      undefined,
      'rejected',
    ).tasks.at(0)?.execution
    if (!rejected) throw new Error('missing rejected fixture')
    const dependencyStates: AgentLifecycleSnapshot[] = [
      completed(),
      rejected,
      terminal('failed'),
      terminal('cancelled'),
      terminal('orphaned'),
    ]
    for (const execution of dependencyStates) {
      const dependency = withTeamTaskExecution(
        parseTeamSnapshot(snapshotWith([task('dep')])),
        'dep',
        execution,
      )
      const dependencyTask = dependency.tasks.at(0)
      if (!dependencyTask) throw new Error('missing dependency fixture')
      const blocked = parseTeamSnapshot(
        snapshotWith([dependencyTask, task('child', [], ['dep'])]),
      )
      expect(
        selectTeamTaskAdmissions({ snapshot: blocked, maxConcurrent: 1 }),
      ).toEqual([])
    }
  })

  it('replaces execution, enforces current generation, and preserves future timestamps', () => {
    const future = '2099-01-01T00:00:00.000Z'
    const original = parseTeamSnapshot(
      snapshotWith([task('one')], { createdAt: future, updatedAt: future }),
    )
    const installed = withTeamTaskExecution(original, 'one', completed())
    expect(installed.revision).toBe(1)
    const replaced = withTeamTaskExecution(
      installed,
      'one',
      completed('new-worker'),
    )
    expect(replaced.revision).toBe(2)
    expect(replaced.updatedAt >= future).toBe(true)
    expect(() =>
      withTeamTaskExecution(original, 'missing', completed()),
    ).toThrow()
    expect(() => acceptTeamTaskExecution(replaced, 'one', 99)).toThrow()
    expect(() =>
      acceptTeamTaskExecution(
        parseTeamSnapshot(snapshotWith([task('one')])),
        'one',
      ),
    ).toThrow()
    const rejected = acceptTeamTaskExecution(
      replaced,
      'one',
      undefined,
      'rejected',
    )
    expect(rejected.tasks[0]?.execution?.acceptance).toBe('rejected')
  })

  it('enforces usage generations and resets aggregate usage for fresh executions', () => {
    const original = parseTeamSnapshot(
      versionTwo([task('one'), task('two')], {
        policy: { lead: 'hybrid', execution: 'swarm', commit: 'lead' },
      }),
    )
    const firstExecution = completed('first-owner')
    const secondExecution = completed('second-owner')
    let current = withTeamTaskExecution(original, 'one', firstExecution)
    current = recordTeamTaskProgress(current, 'one', {
      generation: 1,
      totalTokens: 10,
      durationMs: 20,
    })
    current = withTeamTaskExecution(current, 'two', secondExecution)
    current = recordTeamTaskProgress(current, 'two', {
      generation: 1,
      totalTokens: 7,
      durationMs: 8,
    })
    const nextExecution = continueLifecycle(
      firstExecution,
      owner('fresh-owner'),
    )
    const replaced = withTeamTaskExecution(current, 'one', nextExecution)
    expect(replaced.tasks[0]?.usage).toEqual({
      generation: 2,
      totalTokens: 0,
      durationMs: 0,
    })
    expect(replaced.usage.totalTokens).toBe(7)
    expect(() =>
      recordTeamTaskProgress(replaced, 'one', {
        generation: 1,
        totalTokens: 1,
        durationMs: 1,
      }),
    ).toThrow(/generation/u)

    const idle = parseTeamSnapshot(versionTwo([task('idle')]))
    expect(() =>
      recordTeamTaskProgress(idle, 'idle', {
        generation: 1,
        totalTokens: 1,
        durationMs: 1,
      }),
    ).toThrow(/execution/u)

    const idleTask = idle.tasks[0]
    if (!idleTask) throw new Error('missing idle task')
    expect(() =>
      parseTeamSnapshot({
        ...idle,
        tasks: [
          {
            ...idleTask,
            usage: { generation: 0, totalTokens: 1, durationMs: 0 },
          },
        ],
        usage: { ...idle.usage, totalTokens: 1 },
      }),
    ).toThrow(/generation/u)
  })

  it('rejects progress regressions and marks first budget exhaustion atomically', () => {
    const original = parseTeamSnapshot({
      ...versionTwo([task('one')]),
      budgets: { ...DEFAULT_TEAM_BUDGETS, maxTokens: 10, maxDurationMs: 50 },
    })
    let current = withTeamTaskExecution(
      original,
      'one',
      createAgentLifecycle(owner('worker')),
    )
    current = recordTeamTaskProgress(
      current,
      'one',
      { generation: 1, totalTokens: 10, durationMs: 20 },
      '2026-08-24T00:00:01.000Z',
    )
    expect(current.usage.exhausted).toEqual({
      reason: 'tokens',
      at: '2026-08-24T00:00:01.000Z',
    })
    expect(() =>
      recordTeamTaskProgress(current, 'one', {
        generation: 1,
        totalTokens: 9,
        durationMs: 20,
      }),
    ).toThrow(/Regressing task progress/u)
    current = updateTeamUsageDuration(current, 20)
    expect(() => updateTeamUsageDuration(current, 19)).toThrow(
      /Regressing Team duration/u,
    )
    const later = updateTeamUsageDuration(
      current,
      50,
      '2026-08-24T00:00:02.000Z',
    )
    expect(later.usage.exhausted).toEqual(current.usage.exhausted)
    const preserved = markTeamBudgetExhausted(
      later,
      'duration',
      '2026-08-24T00:00:03.000Z',
    )
    expect(preserved.revision).toBe(later.revision)
    expect(preserved.usage.exhausted).toEqual(later.usage.exhausted)
  })

  it('marks duration exhaustion when it is the first crossed budget', () => {
    const original = parseTeamSnapshot({
      ...versionTwo([task('one')]),
      budgets: { ...DEFAULT_TEAM_BUDGETS, maxDurationMs: 25 },
    })
    const exhausted = updateTeamUsageDuration(
      original,
      25,
      '2026-08-24T00:00:01.000Z',
    )
    expect(exhausted.usage.exhausted).toEqual({
      reason: 'duration',
      at: '2026-08-24T00:00:01.000Z',
    })
    expect(Object.isFrozen(exhausted.usage.exhausted)).toBe(true)
  })
})
