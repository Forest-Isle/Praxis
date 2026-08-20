import { describe, expect, it } from 'vitest'

import type { ToolRegistry } from '../core/runtime.js'
import {
  CLAUDE_CODE_DISABLE_CRON,
  CLAUDE_CODE_ENABLE_TASKS,
  ClaudeCapabilityToolRegistry,
  PRAXIS_ENABLE_WORKFLOW_SCRIPTS,
  resolveClaudeToolCapabilities,
} from './claude-capabilities.js'

function names(input: Parameters<typeof resolveClaudeToolCapabilities>[0]) {
  return [...resolveClaudeToolCapabilities(input)].sort()
}

describe('resolveClaudeToolCapabilities', () => {
  it('gates tasks by interactive/simple runtime and honors explicit environment overrides', () => {
    expect(
      names({ role: 'main', interactive: false, simpleMode: false }),
    ).not.toContain('TaskCreate')
    expect(
      names({ role: 'main', interactive: true, simpleMode: false }),
    ).toContain('TaskCreate')
    expect(
      names({ role: 'main', interactive: true, simpleMode: true }),
    ).not.toContain('TaskCreate')
    expect(
      names({
        role: 'main',
        interactive: false,
        simpleMode: true,
        env: { [CLAUDE_CODE_ENABLE_TASKS]: 'true' },
      }),
    ).not.toContain('TaskCreate')
  })

  it('cannot re-enable gated tools in simple mode via gates, env, allow-list, or coordinator role', () => {
    const base = {
      role: 'main' as const,
      interactive: true,
      simpleMode: true,
    }
    const allowList = [
      'TaskCreate',
      'TaskGet',
      'TaskList',
      'TaskUpdate',
      'Workflow',
      'CronCreate',
      'CronDelete',
      'CronList',
      'ScheduleWakeup',
      'Agent',
      'TaskOutput',
      'TaskStop',
      'SendMessage',
    ]
    expect(
      names({
        ...base,
        tasks: true,
        workflowScripts: true,
        agentTriggers: true,
        backgroundAgents: true,
        subagents: true,
        env: {
          [CLAUDE_CODE_ENABLE_TASKS]: 'true',
          [PRAXIS_ENABLE_WORKFLOW_SCRIPTS]: 'true',
          [CLAUDE_CODE_DISABLE_CRON]: 'false',
        },
      }),
    ).toEqual([])
    expect(names({ ...base, tools: allowList })).toEqual([])
    expect(
      names({
        role: 'coordinator',
        interactive: true,
        simpleMode: true,
        tools: ['SendMessage'],
      }),
    ).toEqual([])
  })

  it('applies workflow and cron gates with explicit booleans over environment', () => {
    expect(
      names({
        role: 'main',
        interactive: false,
        simpleMode: false,
        env: {
          [PRAXIS_ENABLE_WORKFLOW_SCRIPTS]: 'true',
          [CLAUDE_CODE_DISABLE_CRON]: 'false',
        },
      }),
    ).toEqual(expect.arrayContaining(['Workflow', 'CronCreate']))
    expect(
      names({
        role: 'main',
        interactive: false,
        simpleMode: false,
        workflowScripts: false,
        agentTriggers: false,
        env: {
          [PRAXIS_ENABLE_WORKFLOW_SCRIPTS]: 'true',
          [CLAUDE_CODE_DISABLE_CRON]: 'false',
        },
      }),
    ).not.toEqual(expect.arrayContaining(['Workflow', 'CronCreate']))
  })

  it('gives a truthy CLAUDE_CODE_DISABLE_CRON priority over an enabled agentTriggers gate', () => {
    const cronTools = ['CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup']
    const base = {
      role: 'main' as const,
      interactive: true,
      simpleMode: false,
    }
    expect(names({ ...base, agentTriggers: true })).toEqual(
      expect.arrayContaining(cronTools),
    )
    for (const value of ['1', 'true', 'yes', 'on', 'TRUE']) {
      expect(
        names({
          ...base,
          agentTriggers: true,
          env: { [CLAUDE_CODE_DISABLE_CRON]: value },
        }),
      ).not.toEqual(expect.arrayContaining(cronTools))
    }
    expect(
      names({
        ...base,
        agentTriggers: true,
        env: { [CLAUDE_CODE_DISABLE_CRON]: 'false' },
      }),
    ).toEqual(expect.arrayContaining(cronTools))
  })

  it('suppresses recursive worker tools and applies allow then deny precedence', () => {
    expect(
      names({
        role: 'worker',
        interactive: true,
        simpleMode: false,
        subagents: true,
        backgroundAgents: true,
        tools: ['Agent', 'TaskOutput', 'TaskStop', 'TaskCreate'],
      }),
    ).toEqual(['TaskCreate'])
    expect(
      names({
        role: 'main',
        interactive: true,
        simpleMode: false,
        tools: ['TaskCreate'],
        disallowedTools: ['TaskCreate'],
      }),
    ).toEqual([])
  })

  it('requires explicit coordinator coordination tools and rejects unknown capability names', () => {
    expect(
      names({ role: 'coordinator', interactive: true, simpleMode: false }),
    ).not.toContain('SendMessage')
    expect(
      names({
        role: 'coordinator',
        interactive: true,
        simpleMode: false,
        tools: ['SendMessage'],
      }),
    ).toEqual(['SendMessage'])
    expect(() =>
      resolveClaudeToolCapabilities({
        role: 'main',
        interactive: true,
        simpleMode: false,
        tools: ['Read'],
      }),
    ).toThrow('Unknown capability tool')
  })
})

describe('ClaudeCapabilityToolRegistry', () => {
  it('filters advertised gated tools and rejects disabled calls before execution', async () => {
    const base: ToolRegistry = {
      definitions: () =>
        ['Read', 'TaskCreate'].map((name) => ({
          name,
          description: name,
          inputSchema: { type: 'object' },
        })),
      prepare: async (call) => call,
      execute: async () => ({ content: 'ok', isError: false }),
    }
    const registry = new ClaudeCapabilityToolRegistry(base, new Set())
    expect(registry.definitions().map(({ name }) => name)).toEqual(['Read'])
    await expect(
      registry.prepare(
        { id: 'task', name: 'TaskCreate', input: {} },
        { cwd: '/tmp' },
      ),
    ).rejects.toThrow('unavailable')
    await expect(
      registry.execute(
        { id: 'task', name: 'TaskCreate', input: {} },
        { cwd: '/tmp' },
      ),
    ).rejects.toThrow('unavailable')
  })
})
