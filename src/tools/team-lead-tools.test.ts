import { describe, expect, it } from 'vitest'

import type {
  ModelToolCall,
  ToolRegistry,
  ToolExecutionContext,
} from '../core/runtime.js'
import type { TeamLeadOperations } from '../application/team-lead-operations.js'
import {
  COORDINATOR_LEAD_ALLOWLIST,
  TeamLeadToolRegistry,
} from './team-lead-tools.js'

const sessionId = 'session-lead'
const snapshot = { teamId: 'team-alpha', revision: 1 }

function call(
  name: string,
  input: Record<string, unknown> = {},
  id = name,
): ModelToolCall {
  return { id, name, input }
}

function createInput(): Record<string, unknown> {
  return {
    teamId: 'team-alpha',
    name: 'Alpha Team',
    roster: [{ name: 'worker-a', agentType: 'worker', access: 'write' }],
    tasks: [
      {
        id: 'task-a',
        description: 'Implement the task',
        assignee: 'worker-a',
        blockedBy: [],
        claims: {
          files: ['src/example.ts'],
          publicContracts: [],
          generatedArtifacts: [],
          migrations: [],
          mergeTargets: [],
        },
      },
    ],
    leadPolicy: 'hybrid',
    executionPolicy: 'sequential',
    commitPolicy: 'lead',
    budgets: {
      maxAgents: 2,
      maxConcurrent: 1,
      maxTokens: 1000,
      maxDurationMs: 10_000,
      shutdownDrainMs: 1000,
    },
  }
}

function baseRegistry(
  schedulingPolicy?: ToolRegistry['schedulingPolicy'],
): ToolRegistry {
  const registry: ToolRegistry = {
    definitions: () =>
      ['Read', 'TaskCreate', 'SendMessage'].map((name) => ({
        name,
        description: name,
        inputSchema: {},
      })),
    prepare: async (toolCall) => toolCall,
    execute: async (toolCall) => ({
      content: JSON.stringify({ base: toolCall.name }),
      isError: false,
    }),
  }
  if (schedulingPolicy) registry.schedulingPolicy = schedulingPolicy
  return registry
}

function fakeOperations() {
  const calls: Array<{
    method: string
    args: readonly unknown[]
  }> = []
  let activeLeadPolicy: 'hybrid' | 'coordinator' = 'hybrid'
  const operations = {
    activeLeadPolicy: () => activeLeadPolicy,
    create: async (...args: readonly unknown[]) => {
      calls.push({ method: 'create', args })
      return snapshot
    },
    resume: async (...args: readonly unknown[]) => {
      calls.push({ method: 'resume', args })
      return snapshot
    },
    list: async (...args: readonly unknown[]) => {
      calls.push({ method: 'list', args })
      return [snapshot]
    },
    accept: async (...args: readonly unknown[]) => {
      calls.push({ method: 'accept', args })
      return snapshot
    },
    stop: async (...args: readonly unknown[]) => {
      calls.push({ method: 'stop', args })
      return snapshot
    },
    send: async (...args: readonly unknown[]) => {
      calls.push({ method: 'send', args })
      return { messageId: 'message-1', sequence: 1 }
    },
  }
  return {
    calls,
    operations: operations as unknown as TeamLeadOperations,
    setLeadPolicy: (policy: 'hybrid' | 'coordinator') => {
      activeLeadPolicy = policy
    },
  }
}

const context = (overrides: Partial<ToolExecutionContext> = {}) => ({
  cwd: process.cwd(),
  ...overrides,
})

describe('TeamLeadToolRegistry', () => {
  it('exposes enabled Team tools and routes all six operations with native result metadata', async () => {
    const fake = fakeOperations()
    const registry = new TeamLeadToolRegistry(
      baseRegistry(),
      fake.operations,
      sessionId,
      [
        'TeamCreate',
        'TeamResume',
        'TeamList',
        'TeamAccept',
        'TeamStop',
        'TeamSend',
      ],
    )
    expect(registry.definitions().map(({ name }) => name)).toEqual([
      'Read',
      'TaskCreate',
      'SendMessage',
      'TeamCreate',
      'TeamResume',
      'TeamList',
      'TeamAccept',
      'TeamStop',
      'TeamSend',
    ])

    const results = [
      await registry.execute(call('TeamCreate', createInput()), context()),
      await registry.execute(
        call('TeamResume', { teamId: 'team-alpha' }),
        context(),
      ),
      await registry.execute(call('TeamList'), context()),
      await registry.execute(
        call('TeamAccept', { teamId: 'team-alpha', taskId: 'task-a' }),
        context(),
      ),
      await registry.execute(
        call('TeamStop', { teamId: 'team-alpha', drainMs: 500 }),
        context(),
      ),
      await registry.execute(
        call(
          'TeamSend',
          {
            teamId: 'team-alpha',
            to: 'worker-a',
            payload: { kind: 'text', text: 'hello' },
          },
          'send-call-1',
        ),
        context(),
      ),
    ]
    for (const result of results) {
      expect(result.isError).toBe(false)
      expect(JSON.parse(result.content)).toEqual(result.nativeToolUseResult)
    }
    expect(fake.calls.map(({ method }) => method)).toEqual([
      'create',
      'resume',
      'list',
      'accept',
      'stop',
      'send',
    ])
    expect(fake.calls[0]?.args[1]).toBe(sessionId)
    expect(fake.calls[1]?.args).toEqual(['team-alpha', sessionId])
    expect(fake.calls[3]?.args[0]).toMatchObject({ decision: 'accepted' })
    expect(fake.calls[4]?.args[0]).toEqual({
      teamId: 'team-alpha',
      drainMs: 500,
    })
    expect(fake.calls[5]?.args[1]).toBe(sessionId)
    expect(fake.calls[5]?.args[2]).toBe('send-call-1')
  })

  it('filters Hybrid and Coordinator Lead capabilities at every registry boundary', async () => {
    const fake = fakeOperations()
    const registry = new TeamLeadToolRegistry(
      baseRegistry(),
      fake.operations,
      sessionId,
      ['TeamCreate'],
    )
    expect(registry.definitions().map(({ name }) => name)).toContain('Read')
    expect(registry.definitions().map(({ name }) => name)).toContain(
      'TeamCreate',
    )

    fake.setLeadPolicy('coordinator')
    const coordinatorNames = registry.definitions().map(({ name }) => name)
    expect(coordinatorNames).not.toContain('Read')
    expect(coordinatorNames).toContain('TaskCreate')
    expect(coordinatorNames).toContain('TeamCreate')
    await expect(registry.prepare(call('Read'), context())).rejects.toThrow(
      /Coordinator Lead/u,
    )
    expect(() => registry.schedulingPolicy(call('Read'))).toThrow(
      /Coordinator Lead/u,
    )
    await expect(registry.execute(call('Read'), context())).rejects.toThrow(
      /Coordinator Lead/u,
    )
    await expect(
      registry.prepare(call('TaskCreate'), context()),
    ).resolves.toMatchObject({
      name: 'TaskCreate',
    })
    await expect(
      registry.prepare(call('TeamCreate', createInput()), context()),
    ).resolves.toMatchObject({
      name: 'TeamCreate',
    })
    expect(COORDINATOR_LEAD_ALLOWLIST).toContain('TaskCreate')
  })

  it('validates every Team input shape and rejects unavailable or interrupted calls', async () => {
    const fake = fakeOperations()
    const registry = new TeamLeadToolRegistry(
      baseRegistry(),
      fake.operations,
      sessionId,
      ['TeamCreate', 'TeamAccept', 'TeamStop', 'TeamSend'],
    )
    const malformed: Array<[string, ModelToolCall]> = []
    const rosterName = createInput()
    const rosterNameMember = (
      rosterName.roster as Array<Record<string, unknown>>
    )[0]
    if (!rosterNameMember) throw new Error('test roster is incomplete')
    rosterNameMember.name = ''
    malformed.push(['empty roster name', call('TeamCreate', rosterName)])
    const rosterAccess = createInput()
    const rosterAccessMember = (
      rosterAccess.roster as Array<Record<string, unknown>>
    )[0]
    if (!rosterAccessMember) throw new Error('test roster is incomplete')
    rosterAccessMember.access = 'admin'
    malformed.push(['invalid roster access', call('TeamCreate', rosterAccess)])
    const rosterExtra = createInput()
    const rosterExtraMember = (
      rosterExtra.roster as Array<Record<string, unknown>>
    )[0]
    if (!rosterExtraMember) throw new Error('test roster is incomplete')
    rosterExtraMember.extra = true
    malformed.push(['unknown roster field', call('TeamCreate', rosterExtra)])
    const taskDescription = createInput()
    const taskDescriptionItem = (
      taskDescription.tasks as Array<Record<string, unknown>>
    )[0]
    if (!taskDescriptionItem) throw new Error('test task is incomplete')
    taskDescriptionItem.description = ''
    malformed.push([
      'empty task description',
      call('TeamCreate', taskDescription),
    ])
    const taskBlockedBy = createInput()
    const taskBlockedByItem = (
      taskBlockedBy.tasks as Array<Record<string, unknown>>
    )[0]
    if (!taskBlockedByItem) throw new Error('test task is incomplete')
    taskBlockedByItem.blockedBy = [1]
    malformed.push(['invalid blockedBy', call('TeamCreate', taskBlockedBy)])
    const taskClaims = createInput()
    const taskClaimsItem = (
      taskClaims.tasks as Array<Record<string, unknown>>
    )[0]
    if (!taskClaimsItem || !taskClaimsItem.claims)
      throw new Error('test task is incomplete')
    ;(taskClaimsItem.claims as Record<string, unknown>).files = [1]
    malformed.push(['invalid claim array', call('TeamCreate', taskClaims)])
    const policy = createInput()
    policy.leadPolicy = 'invalid'
    malformed.push(['invalid lead policy', call('TeamCreate', policy)])
    const budget = createInput()
    budget.budgets = { maxAgents: 0 }
    malformed.push(['invalid budget', call('TeamCreate', budget)])
    malformed.push([
      'invalid generation',
      call('TeamAccept', {
        teamId: 'team-alpha',
        taskId: 'task-a',
        generation: Number.MAX_SAFE_INTEGER + 1,
      }),
    ])
    malformed.push([
      'invalid drain',
      call('TeamStop', { teamId: 'team-alpha', drainMs: 0.5 }),
    ])
    malformed.push([
      'invalid recipients',
      call('TeamSend', {
        teamId: 'team-alpha',
        to: [],
        payload: { kind: 'text', text: 'hello' },
      }),
    ])
    malformed.push([
      'invalid payload',
      call('TeamSend', {
        teamId: 'team-alpha',
        to: 'worker-a',
        payload: { kind: 'task', phase: 'request' },
      }),
    ])

    for (const [label, toolCall] of malformed) {
      await expect(registry.prepare(toolCall, context())).rejects.toThrow()
      await expect(registry.execute(toolCall, context())).rejects.toThrow()
      expect(fake.calls, label).toHaveLength(0)
    }
    await expect(
      registry.prepare(call('TeamResume', { teamId: 'team-alpha' }), context()),
    ).rejects.toThrow(/unavailable/u)
    await expect(
      registry.execute(call('TeamResume', { teamId: 'team-alpha' }), context()),
    ).rejects.toThrow(/unavailable/u)
    await expect(
      registry.execute(
        call('TeamList'),
        context({ signal: AbortSignal.abort() }),
      ),
    ).rejects.toThrow(/unavailable/u)
    expect(fake.calls).toHaveLength(0)

    const allEnabled = new TeamLeadToolRegistry(
      baseRegistry(),
      fake.operations,
      sessionId,
      ['TeamList'],
    )
    await expect(
      allEnabled.execute(
        call('TeamList'),
        context({ signal: AbortSignal.abort() }),
      ),
    ).rejects.toThrow(/interrupted/u)
    expect(fake.calls).toHaveLength(0)
  })

  it('keeps Team operations exclusive and preserves base scheduling', () => {
    const fake = fakeOperations()
    const delegated = {
      concurrency: 'concurrent' as const,
      abortGroupOnError: true,
    }
    const registry = new TeamLeadToolRegistry(
      baseRegistry(() => delegated),
      fake.operations,
      sessionId,
      [
        'TeamCreate',
        'TeamResume',
        'TeamList',
        'TeamAccept',
        'TeamStop',
        'TeamSend',
      ],
    )
    for (const name of [
      'TeamCreate',
      'TeamResume',
      'TeamList',
      'TeamAccept',
      'TeamStop',
      'TeamSend',
    ])
      expect(registry.schedulingPolicy(call(name))).toEqual({
        concurrency: 'exclusive',
        cancelOnInterrupt: true,
      })
    expect(registry.schedulingPolicy(call('Read'))).toBe(delegated)
    const fallback = new TeamLeadToolRegistry(
      baseRegistry(),
      fake.operations,
      sessionId,
      ['TeamList'],
    )
    expect(fallback.schedulingPolicy(call('Read'))).toEqual({
      concurrency: 'concurrent',
    })
  })
})
