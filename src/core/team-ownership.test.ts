import { describe, expect, it } from 'vitest'

import {
  createAgentLifecycle,
  markLifecycleOrphaned,
  transitionLifecycle,
  type AgentLifecycleSnapshot,
} from './agent-orchestration.js'
import {
  acceptTeamTaskExecution,
  parseTeamSnapshot,
  parseTeamId,
  selectTeamTaskAdmissions,
  teamTasksConflict,
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

  it('parses a frozen flat snapshot and rejects invalid claims/cycles', () => {
    const snapshot = parseTeamSnapshot(base([task('one', ['src/a.ts'])]))
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.tasks.at(0)?.claims)).toBe(true)
    expect(() =>
      parseTeamSnapshot(base([task('one', ['../secret'])])),
    ).toThrow()
    expect(() =>
      parseTeamSnapshot(
        base([task('one', [], ['two']), task('two', [], ['one'])]),
      ),
    ).toThrow(/cycle/u)
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
})
