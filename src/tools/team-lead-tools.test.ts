import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'
import type { ToolRegistry } from '../core/runtime.js'
import { TeamLeadOperations } from '../application/team-lead-operations.js'
import { LocalTeamManager } from '../application/team-manager.js'
import { TeamLeadToolRegistry } from './team-lead-tools.js'

const base: ToolRegistry = {
  definitions: () => [
    { name: 'Read', description: 'read', inputSchema: { type: 'object' } },
  ],
  prepare: async (call) => call,
  execute: vi.fn(async () => ({ content: 'base', isError: false })),
}
const snapshot = { teamId: 'team-a' }
function registry(
  enabled = [
    'TeamCreate',
    'TeamResume',
    'TeamList',
    'TeamAccept',
    'TeamStop',
    'TeamSend',
  ],
  toolRegistry: ToolRegistry = base,
) {
  const operations = {
    activeLeadPolicy: vi.fn<() => 'hybrid' | 'coordinator'>(() => 'hybrid'),
    create: vi.fn(async () => snapshot),
    resume: vi.fn(async () => snapshot),
    list: vi.fn(async () => [snapshot]),
    accept: vi.fn(async () => snapshot),
    stop: vi.fn(async () => snapshot),
    send: vi.fn(async () => ({ teamId: 'team-a', sequence: 1 })),
  }
  return {
    registry: new TeamLeadToolRegistry(
      toolRegistry,
      operations as never,
      'lead-a',
      enabled,
    ),
    operations,
  }
}

describe('TeamLeadToolRegistry', () => {
  it('validates and routes the gated typed TeamSend tool', async () => {
    const f = registry(['TeamSend'])
    await f.registry.execute(
      {
        id: 'send-call',
        name: 'TeamSend',
        input: {
          teamId: 'team-a',
          to: 'worker',
          payload: { kind: 'text', text: 'hello' },
        },
      },
      { cwd: '.' },
    )
    expect(f.operations.send).toHaveBeenCalledWith(
      expect.objectContaining({ teamId: 'team-a', to: 'worker' }),
      'lead-a',
      'send-call',
    )
    await expect(
      f.registry.execute(
        {
          id: 'bad',
          name: 'TeamSend',
          input: { teamId: 'team-a', to: 'worker', payload: { kind: 'wat' } },
        },
        { cwd: '.' },
      ),
    ).rejects.toThrow()
    expect(
      registry(['TeamList'])
        .registry.definitions()
        .map(({ name }) => name),
    ).not.toContain('TeamSend')
  })

  it('advertises the selected five tools with closed schemas and delegates base tools', async () => {
    const f = registry(['TeamList'])
    expect(f.registry.definitions().map((d) => d.name)).toEqual([
      'Read',
      'TeamList',
    ])
    expect(
      f.registry.schedulingPolicy?.({ id: 'x', name: 'TeamList', input: {} }),
    ).toMatchObject({ concurrency: 'exclusive', cancelOnInterrupt: true })
    await expect(
      f.registry.execute({ id: 'r', name: 'Read', input: {} }, { cwd: '.' }),
    ).resolves.toMatchObject({ content: 'base' })
    await expect(
      f.registry.execute(
        { id: 'l', name: 'TeamList', input: {} },
        { cwd: '.' },
      ),
    ).resolves.toEqual({
      content: JSON.stringify({ teams: [snapshot] }),
      isError: false,
      nativeToolUseResult: { teams: [snapshot] },
    })
    await expect(
      f.registry.execute(
        { id: 'l', name: 'TeamList', input: { extra: true } },
        { cwd: '.' },
      ),
    ).rejects.toThrow(/Unknown Team field/u)
  })

  it('passes policy and budgets through TeamCreate and preserves omitted drain', async () => {
    const f = registry(['TeamCreate', 'TeamStop'])
    const input = {
      teamId: 'team-a',
      name: 'A',
      roster: [],
      tasks: [],
      leadPolicy: 'coordinator',
      executionPolicy: 'swarm',
      commitPolicy: 'lead',
      budgets: {
        maxAgents: 2,
        maxConcurrent: 1,
        maxTokens: 10,
        maxDurationMs: 20,
        shutdownDrainMs: 30,
      },
    }
    await f.registry.execute(
      { id: 'c', name: 'TeamCreate', input },
      { cwd: '.' },
    )
    expect(f.operations.create).toHaveBeenCalledWith(input, 'lead-a')
    await expect(
      f.registry.execute(
        {
          id: 'invalid-commit',
          name: 'TeamCreate',
          input: { ...input, commitPolicy: 'members' },
        },
        { cwd: '.' },
      ),
    ).rejects.toThrow(/Invalid commitPolicy/u)
    await expect(
      f.registry.execute(
        {
          id: 'invalid-budget',
          name: 'TeamCreate',
          input: { ...input, budgets: { maxTokens: 1.5 } },
        },
        { cwd: '.' },
      ),
    ).rejects.toThrow(/Invalid Team budget: maxTokens/u)
    expect(f.operations.create).toHaveBeenCalledTimes(1)
    await f.registry.execute(
      { id: 's', name: 'TeamStop', input: { teamId: 'team-a' } },
      { cwd: '.' },
    )
    expect(f.operations.stop).toHaveBeenCalledWith(
      { teamId: 'team-a' },
      'lead-a',
    )
  })

  it('filters and rejects every non-allowlisted path for a Coordinator', async () => {
    const baseExecute = vi.fn(async (call: { name: string }) => ({
      content: call.name,
      isError: false,
    }))
    const representativeBase: ToolRegistry = {
      definitions: () =>
        [
          'Read',
          'Agent',
          'TaskCreate',
          'AskUserQuestion',
          'SendMessage',
          'Monitor',
          'mcp__arbitrary__tool',
        ].map((name) => ({
          name,
          description: name,
          inputSchema: { type: 'object' },
        })),
      prepare: async (call) => call,
      execute: baseExecute as never,
    }
    const f = registry(['TeamList'], representativeBase)
    expect(f.registry.definitions().map(({ name }) => name)).toContain('Read')
    const prepared = await f.registry.prepare(
      { id: 'r', name: 'Read', input: {} },
      { cwd: '.' },
    )
    expect(prepared.name).toBe('Read')
    f.operations.activeLeadPolicy.mockReturnValue('coordinator')
    expect(f.registry.definitions().map(({ name }) => name)).toEqual([
      'Agent',
      'TaskCreate',
      'AskUserQuestion',
      'SendMessage',
      'Monitor',
      'TeamList',
    ])
    await expect(
      f.registry.prepare({ id: 'r', name: 'Read', input: {} }, { cwd: '.' }),
    ).rejects.toThrow(/Coordinator/u)
    await expect(f.registry.execute(prepared, { cwd: '.' })).rejects.toThrow(
      /Coordinator/u,
    )
    expect(baseExecute).not.toHaveBeenCalled()
    expect(() =>
      f.registry.schedulingPolicy({ id: 'r', name: 'Read', input: {} }),
    ).toThrow(/Coordinator/u)
    await expect(
      f.registry.execute(
        { id: 'm', name: 'mcp__arbitrary__tool', input: {} },
        { cwd: '.' },
      ),
    ).rejects.toThrow(/Coordinator/u)
    await expect(
      f.registry.execute({ id: 'a', name: 'Agent', input: {} }, { cwd: '.' }),
    ).resolves.toMatchObject({ content: 'Agent' })
    expect(baseExecute).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Agent' }),
      expect.anything(),
    )
    await expect(
      f.registry.execute(
        { id: 't', name: 'TeamList', input: {} },
        { cwd: '.' },
      ),
    ).resolves.toBeDefined()
  })

  it('applies defaults, validates nested input, and rejects unavailable names', async () => {
    const f = registry(['TeamCreate', 'TeamAccept', 'TeamStop', 'NotATeam'])
    const create = {
      teamId: 'team-a',
      name: 'A',
      roster: [{ name: 'worker', agentType: 'x', access: 'write' }],
      tasks: [
        {
          id: 'task',
          description: 'd',
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
    }
    await f.registry.execute(
      { id: 'c', name: 'TeamCreate', input: create },
      { cwd: '.' },
    )
    expect(f.operations.create).toHaveBeenCalled()
    await expect(
      f.registry.execute(
        {
          id: 'bad',
          name: 'TeamCreate',
          input: {
            ...create,
            roster: [{ ...create.roster[0], unknown: true }],
          },
        },
        { cwd: '.' },
      ),
    ).rejects.toThrow(/Unknown Team field/u)
    await f.registry.execute(
      {
        id: 'a',
        name: 'TeamAccept',
        input: { teamId: 'team-a', taskId: 'task' },
      },
      { cwd: '.' },
    )
    expect(f.operations.accept).toHaveBeenCalledWith(
      expect.objectContaining({ decision: 'accepted' }),
      'lead-a',
    )
    await f.registry.execute(
      { id: 's', name: 'TeamStop', input: { teamId: 'team-a' } },
      { cwd: '.' },
    )
    expect(f.operations.stop).toHaveBeenCalledWith(
      { teamId: 'team-a' },
      'lead-a',
    )
    expect(() =>
      f.registry.schedulingPolicy?.({ id: 'x', name: 'TeamResume', input: {} }),
    ).toThrow(/unavailable/u)
  })

  it('does not operate after interruption and rejects invalid ranges', async () => {
    const f = registry()
    const signal = AbortSignal.abort()
    await expect(
      f.registry.execute(
        { id: 's', name: 'TeamStop', input: { teamId: 'team-a' } },
        { cwd: '.', signal },
      ),
    ).rejects.toThrow(/interrupted/u)
    expect(f.operations.stop).not.toHaveBeenCalled()
    await expect(
      f.registry.prepare(
        {
          id: 's',
          name: 'TeamStop',
          input: { teamId: 'team-a', drainMs: 600001 },
        },
        { cwd: '.' },
      ),
    ).rejects.toThrow(/Invalid drainMs/u)
    await expect(
      f.registry.prepare(
        {
          id: 'a',
          name: 'TeamAccept',
          input: { teamId: 'team-a', taskId: 'x', decision: 'maybe' },
        },
        { cwd: '.' },
      ),
    ).rejects.toThrow(/Invalid decision/u)
  })

  it('creates, completes, accepts, admits a dependent task, and stops through the model registry', async () => {
    const nativeRoot = await mkdtemp(join(tmpdir(), 'praxis-team-lead-tools-'))
    const cwd = process.cwd()
    const runtimeCalls: string[] = []
    try {
      const manager = await LocalTeamManager.open({
        nativeRoot,
        cwd,
        maxConcurrent: 2,
        baseTools: base,
        permissions: { resolve: () => ({ behavior: 'allow' }) },
        workspace: { acquire: async () => ({ cwd, branch: null }) },
        runtime: {
          run: async ({ task }) => {
            runtimeCalls.push(task.id)
            return { status: 'completed', totalTokens: 0, durationMs: 0 }
          },
        },
      })
      const operations = new TeamLeadOperations({
        open: async () => manager,
      } as never)
      const tools = new TeamLeadToolRegistry(base, operations, 'lead-a', [
        'TeamCreate',
        'TeamAccept',
        'TeamStop',
      ])
      const claims = {
        files: [],
        publicContracts: [],
        generatedArtifacts: [],
        migrations: [],
        mergeTargets: [],
      }
      await tools.execute(
        {
          id: 'create',
          name: 'TeamCreate',
          input: {
            teamId: 'dependent-team',
            name: 'Dependent Team',
            roster: [
              { name: 'worker', agentType: 'test', access: 'read-only' },
            ],
            tasks: [
              {
                id: 'first',
                description: 'first',
                assignee: 'worker',
                blockedBy: [],
                claims,
              },
              {
                id: 'second',
                description: 'second',
                assignee: 'worker',
                blockedBy: ['first'],
                claims,
              },
            ],
          },
        },
        { cwd },
      )
      const beforeAcceptance = await operations.waitForIdle(
        'dependent-team',
        'lead-a',
      )
      expect(runtimeCalls).toEqual(['first'])
      expect(beforeAcceptance.tasks[0]?.execution?.state).toBe('completed')
      expect(beforeAcceptance.tasks[1]?.execution).toBeNull()

      await tools.execute(
        {
          id: 'accept',
          name: 'TeamAccept',
          input: { teamId: 'dependent-team', taskId: 'first' },
        },
        { cwd },
      )
      const afterAcceptance = await operations.waitForIdle(
        'dependent-team',
        'lead-a',
      )
      expect(runtimeCalls).toEqual(['first', 'second'])
      expect(afterAcceptance.tasks[1]?.execution?.state).toBe('completed')

      await expect(
        tools.execute(
          {
            id: 'stop',
            name: 'TeamStop',
            input: { teamId: 'dependent-team', drainMs: 0 },
          },
          { cwd },
        ),
      ).resolves.toMatchObject({ isError: false })
    } finally {
      await rm(nativeRoot, { recursive: true, force: true })
    }
  })
})
