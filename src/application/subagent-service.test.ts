import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { resolveClaudePaths } from '../compatibility/claude/paths.js'
import type {
  ModelProvider,
  ModelRequest,
  PermissionResolver,
  ToolRegistry,
} from '../core/runtime.js'
import { AgentRunCancelledError } from '../core/runtime.js'
import { ClaudeExtensionCatalog } from '../extensions/claude-extensions.js'
import { ClaudeSessionService } from './session-service.js'
import { ClaudeSubagentExecutor } from './subagent-service.js'

const roots: string[] = []

const emptyTools: ToolRegistry = {
  definitions: () => [],
  async prepare(call) {
    return call
  },
  async execute(call) {
    throw new Error(`Unexpected base tool ${call.name}`)
  },
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  )
})

function entries(source: string): Record<string, unknown>[] {
  return source
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe('foreground Claude Agent execution', () => {
  it('persists native main result metadata, sidechain JSONL, and metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-subagent-test-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const requests: ModelRequest[] = []
    const provider: ModelProvider = {
      model: 'fixture-model',
      capabilities: { streaming: true, usage: true, tools: true },
      async *complete(request) {
        requests.push(request)
        const serialized = JSON.stringify(request.messages)
        if (serialized.includes('general-purpose subagent')) {
          yield { type: 'text-delta', delta: 'CHILD_RESULT' }
          yield {
            type: 'usage',
            usage: { inputTokens: 7, outputTokens: 3 },
          }
        } else if (serialized.includes('CHILD_RESULT')) {
          yield { type: 'text-delta', delta: 'MAIN_RESULT' }
          yield {
            type: 'usage',
            usage: { inputTokens: 5, outputTokens: 2 },
          }
        } else {
          yield {
            type: 'tool-call',
            call: {
              id: 'call_agent',
              name: 'Agent',
              input: {
                description: 'Return marker',
                prompt: 'Return CHILD_RESULT',
                subagent_type: 'general-purpose',
                run_in_background: false,
              },
            },
          }
          yield {
            type: 'usage',
            usage: { inputTokens: 3, outputTokens: 2 },
          }
        }
      },
    }
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider,
      tools: emptyTools,
      permissions: { resolve: () => ({ behavior: 'allow' }) },
      enableSubagents: true,
    })

    const result = await service.run('Delegate this task.')

    expect(result.text).toBe('MAIN_RESULT')
    expect(result.usage).toEqual({ inputTokens: 15, outputTokens: 7 })
    expect(requests).toHaveLength(3)
    const paths = resolveClaudePaths({
      configDir: configRoot,
      cwd,
      sessionId: result.sessionId,
    })
    const mainEntries = entries(await readFile(paths.sessionFile, 'utf8'))
    const toolResult = mainEntries.find(
      (entry) =>
        entry.type === 'user' &&
        typeof entry.toolUseResult === 'object' &&
        entry.toolUseResult !== null &&
        (entry.toolUseResult as Record<string, unknown>).agentId,
    )
    expect(toolResult?.toolUseResult).toMatchObject({
      status: 'completed',
      prompt: 'Return CHILD_RESULT',
      agentType: 'general-purpose',
      resolvedModel: 'fixture-model',
      totalTokens: 10,
      totalToolUseCount: 0,
      usage: { input_tokens: 7, output_tokens: 3 },
    })
    const nativeResult = toolResult?.toolUseResult as Record<string, unknown>
    const agentId = String(nativeResult.agentId)
    expect(agentId).toMatch(/^a[0-9a-f]{16}$/)

    const subagentDirectory = join(
      paths.projectRoot,
      result.sessionId,
      'subagents',
    )
    expect(await readdir(subagentDirectory)).toEqual([
      `agent-${agentId}.jsonl`,
      `agent-${agentId}.meta.json`,
    ])
    const sidechainEntries = entries(
      await readFile(join(subagentDirectory, `agent-${agentId}.jsonl`), 'utf8'),
    )
    expect(sidechainEntries).toHaveLength(2)
    expect(sidechainEntries[0]).toMatchObject({
      parentUuid: null,
      isSidechain: true,
      agentId,
      type: 'user',
      sessionId: result.sessionId,
      message: { role: 'user', content: 'Return CHILD_RESULT' },
    })
    expect(sidechainEntries[1]).toMatchObject({
      isSidechain: true,
      agentId,
      attributionAgent: 'general-purpose',
      type: 'assistant',
      sessionId: result.sessionId,
    })
    const mainPrompt = mainEntries.find(
      (entry) => entry.type === 'user' && entry.promptSource === 'interactive',
    )
    expect(sidechainEntries[0]?.promptId).toBe(mainPrompt?.promptId)
    expect(
      JSON.parse(
        await readFile(
          join(subagentDirectory, `agent-${agentId}.meta.json`),
          'utf8',
        ),
      ),
    ).toEqual({
      agentType: 'general-purpose',
      description: 'Return marker',
      toolUseId: 'call_agent',
      spawnDepth: 1,
    })
  })

  it('loads a shared custom agent definition into subagent context', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-custom-agent-test-'))
    roots.push(root)
    const requests: ModelRequest[] = []
    let mainTurn = 0
    const provider: ModelProvider = {
      capabilities: { streaming: true, usage: true, tools: true },
      async *complete(request) {
        requests.push(request)
        if (JSON.stringify(request.messages).includes('CUSTOM_REVIEW_POLICY')) {
          yield { type: 'text-delta', delta: 'CUSTOM_DONE' }
        } else if (mainTurn++ === 0) {
          yield {
            type: 'tool-call',
            call: {
              id: 'call_custom',
              name: 'Agent',
              input: {
                description: 'Review',
                prompt: 'Review this',
                subagent_type: 'reviewer',
                run_in_background: false,
              },
            },
          }
        } else {
          yield { type: 'text-delta', delta: 'MAIN_DONE' }
        }
      },
    }
    const extensions = new ClaudeExtensionCatalog({
      commands: [],
      skills: [],
      agents: [
        {
          path: join(root, 'config', 'agents', 'reviewer.md'),
          scope: 'user',
          content:
            '---\nname: reviewer\ndescription: Review code\n---\nCUSTOM_REVIEW_POLICY',
        },
      ],
    })
    const service = new ClaudeSessionService({
      configRoot: join(root, 'config'),
      cwd: join(root, 'project'),
      claudeVersion: '2.1.208',
      provider,
      tools: emptyTools,
      permissions: { resolve: () => ({ behavior: 'allow' }) },
      extensions,
      enableSubagents: true,
    })

    expect((await service.run('Use reviewer.')).text).toBe('MAIN_DONE')
    expect(
      requests.some((request) =>
        JSON.stringify(request.messages).includes('CUSTOM_REVIEW_POLICY'),
      ),
    ).toBe(true)
  })

  it('runs a background agent and persists its completion notification', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-background-agent-test-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    let launched = false
    const provider: ModelProvider = {
      capabilities: { streaming: true, usage: true, tools: true },
      async *complete(request) {
        const source = JSON.stringify(request.messages)
        if (source.includes('Do work') && !source.includes('call_background')) {
          yield { type: 'text-delta', delta: 'BACKGROUND_CHILD_DONE' }
          yield {
            type: 'usage',
            usage: { inputTokens: 2, outputTokens: 1 },
          }
        } else if (!launched) {
          launched = true
          yield {
            type: 'tool-call',
            call: {
              id: 'call_background',
              name: 'Agent',
              input: {
                description: 'Background',
                prompt: 'Do work',
                subagent_type: 'general-purpose',
                run_in_background: true,
              },
            },
          }
        } else if (source.includes('<task-notification>')) {
          yield { type: 'text-delta', delta: 'BACKGROUND_MAIN_DONE' }
        } else {
          yield { type: 'text-delta', delta: 'BACKGROUND_RUNNING' }
        }
      },
    }
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider,
      tools: emptyTools,
      permissions: { resolve: () => ({ behavior: 'allow' }) },
      enableSubagents: true,
    })

    const result = await service.run('Try background.')

    expect(result.text).toBe('BACKGROUND_MAIN_DONE')
    const paths = resolveClaudePaths({
      configDir: configRoot,
      cwd,
      sessionId: result.sessionId,
    })
    const mainEntries = entries(await readFile(paths.sessionFile, 'utf8'))
    const source = JSON.stringify(mainEntries)
    expect(source).toContain('"status":"async_launched"')
    expect(source).toContain('<status>completed</status>')
    expect(source).toContain('BACKGROUND_CHILD_DONE')
    expect(
      await readdir(join(paths.projectRoot, result.sessionId, 'subagents')),
    ).toHaveLength(2)
  })

  it('delivers a background Bash notification once inside a nested run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-nested-notify-test-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    let bashNotificationCalls = 0
    const executor = new ClaudeSubagentExecutor({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: {
        capabilities: { streaming: true, usage: true, tools: true },
        async *complete(request) {
          const source = JSON.stringify(request.messages)
          if (source.includes('BASH_TASK_DONE')) {
            yield { type: 'text-delta', delta: 'FOREGROUND_DONE' }
          } else {
            yield { type: 'text-delta', delta: 'FOREGROUND_WAITING' }
          }
        },
      },
      baseTools: emptyTools,
      permissions: { resolve: () => ({ behavior: 'allow' }) },
      async backgroundTaskNotifications() {
        bashNotificationCalls += 1
        return bashNotificationCalls === 1
          ? ['<task-notification>BASH_TASK_DONE</task-notification>']
          : []
      },
    })
    const registry = executor.registry(
      sessionId,
      0,
      () => 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    )
    const foreground = await registry.prepare(
      {
        id: 'call_nested_foreground',
        name: 'Agent',
        input: {
          description: 'Foreground child',
          prompt: 'FOREGROUND_PROMPT',
          run_in_background: false,
        },
      },
      { cwd },
    )

    await expect(registry.execute(foreground, { cwd })).resolves.toMatchObject({
      content: expect.stringContaining('FOREGROUND_DONE'),
    })
    expect(bashNotificationCalls).toBe(2)
    await expect(executor.notifications(false)).resolves.toEqual({
      messages: [],
      usage: { inputTokens: 0, outputTokens: 0 },
    })
  })

  it('does not deadlock concurrent background Agents at their stop boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-agent-barrier-test-'))
    roots.push(root)
    const cwd = join(root, 'project')
    let arrivals = 0
    let release!: () => void
    const barrier = new Promise<void>((resolveBarrier) => {
      release = resolveBarrier
    })
    const executor = new ClaudeSubagentExecutor({
      configRoot: join(root, 'config'),
      cwd,
      claudeVersion: '2.1.208',
      provider: {
        capabilities: { streaming: true, usage: true, tools: true },
        async *complete(request) {
          arrivals += 1
          if (arrivals === 2) release()
          await barrier
          const source = JSON.stringify(request.messages)
          yield {
            type: 'text-delta',
            delta: source.includes('BARRIER_ONE') ? 'AGENT_ONE' : 'AGENT_TWO',
          }
        },
      },
      baseTools: emptyTools,
      permissions: { resolve: () => ({ behavior: 'allow' }) },
      backgroundTaskNotifications: async () => [],
    })
    const registry = executor.registry(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      0,
      () => 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    )
    for (const [id, prompt] of [
      ['call_barrier_one', 'BARRIER_ONE'],
      ['call_barrier_two', 'BARRIER_TWO'],
    ] as const) {
      const call = await registry.prepare(
        {
          id,
          name: 'Agent',
          input: {
            description: prompt,
            prompt,
            run_in_background: true,
          },
        },
        { cwd },
      )
      await registry.execute(call, { cwd })
    }

    const collect = async () => {
      const first = await executor.notifications(true)
      const second = await executor.notifications(true)
      return [...first.messages, ...second.messages]
    }
    let timeout: NodeJS.Timeout | undefined
    const timedOut = new Promise<'timeout'>((resolveTimeout) => {
      timeout = setTimeout(() => resolveTimeout('timeout'), 750)
    })
    const messages = await Promise.race([collect(), timedOut])
    if (timeout) clearTimeout(timeout)
    expect(messages).not.toBe('timeout')
    expect(JSON.stringify(messages)).toContain('AGENT_ONE')
    expect(JSON.stringify(messages)).toContain('AGENT_TWO')
  })

  it('polls and resumes a completed background sidechain from a new executor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-background-resume-test-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const provider = (text: string): ModelProvider => ({
      model: 'fixture-model',
      capabilities: { streaming: true, usage: true, tools: true },
      async *complete() {
        yield { type: 'text-delta', delta: text }
        yield {
          type: 'usage',
          usage: { inputTokens: 2, outputTokens: 1 },
        }
      },
    })
    const options = {
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      baseTools: emptyTools,
      permissions: {
        resolve: () => ({ behavior: 'allow' as const }),
      },
    }
    const first = new ClaudeSubagentExecutor({
      ...options,
      provider: provider('FIRST_RESULT'),
    })
    const promptId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const firstRegistry = first.registry(sessionId, 0, () => promptId)
    const launched = await firstRegistry.execute(
      await firstRegistry.prepare(
        {
          id: 'call_launch',
          name: 'Agent',
          input: {
            description: 'Resume test',
            prompt: 'Initial work',
            run_in_background: true,
          },
        },
        { cwd },
      ),
      { cwd },
    )
    const agentId = String(launched.nativeToolUseResult?.agentId)
    const firstOutput = await firstRegistry.execute(
      await firstRegistry.prepare(
        {
          id: 'call_output',
          name: 'TaskOutput',
          input: { task_id: agentId, block: true, timeout: 30_000 },
        },
        { cwd },
      ),
      { cwd },
    )
    expect(firstOutput.content).toContain('FIRST_RESULT')

    const resumed = new ClaudeSubagentExecutor({
      ...options,
      provider: provider('SECOND_RESULT'),
    })
    const resumedRegistry = resumed.registry(sessionId, 0, () => promptId)
    const sent = await resumedRegistry.execute(
      await resumedRegistry.prepare(
        {
          id: 'call_message',
          name: 'SendMessage',
          input: {
            to: agentId,
            summary: 'resume completed agent',
            message: 'Continue the work',
          },
        },
        { cwd },
      ),
      { cwd },
    )
    expect(sent.content).toContain('"success":true')
    const secondOutput = await resumedRegistry.execute(
      await resumedRegistry.prepare(
        {
          id: 'call_output_again',
          name: 'TaskOutput',
          input: { task_id: agentId, block: true, timeout: 30_000 },
        },
        { cwd },
      ),
      { cwd },
    )
    expect(secondOutput.content).toContain('SECOND_RESULT')

    const paths = resolveClaudePaths({ configDir: configRoot, cwd, sessionId })
    const source = await readFile(
      join(paths.projectRoot, sessionId, 'subagents', `agent-${agentId}.jsonl`),
      'utf8',
    )
    expect(source).toContain('The coordinator sent a message')
    expect(source).toContain('SECOND_RESULT')
  })

  it('defaults to background and accepts model overrides while rejecting unsupported isolation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-agent-model-test-'))
    roots.push(root)
    const cwd = join(root, 'project')
    const selectedModels: string[] = []
    const provider = (text: string, model: string): ModelProvider => ({
      model,
      capabilities: { streaming: true, usage: true, tools: true },
      async *complete() {
        yield { type: 'text-delta', delta: text }
      },
    })
    const executor = new ClaudeSubagentExecutor({
      configRoot: join(root, 'config'),
      cwd,
      claudeVersion: '2.1.208',
      provider: provider('BASE', 'base-model'),
      providerForModel(model) {
        selectedModels.push(model)
        return provider('OVERRIDE', model)
      },
      baseTools: emptyTools,
      permissions: { resolve: () => ({ behavior: 'allow' }) },
    })
    const registry = executor.registry(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      0,
      () => 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    )

    const prepared = await registry.prepare(
      {
        id: 'call_model',
        name: 'Agent',
        input: {
          description: 'Override model',
          prompt: 'Use selected model',
          model: 'haiku',
        },
      },
      { cwd },
    )
    expect(prepared.input.run_in_background).toBe(true)
    const launched = await registry.execute(prepared, { cwd })
    expect(launched.nativeToolUseResult).toMatchObject({
      status: 'async_launched',
      resolvedModel: 'haiku',
    })
    expect(selectedModels).toEqual(['haiku'])
    await expect(executor.notifications(true)).resolves.toMatchObject({
      messages: [expect.stringContaining('OVERRIDE')],
    })

    await expect(
      registry.prepare(
        {
          id: 'call_isolation',
          name: 'Agent',
          input: {
            description: 'Isolated work',
            prompt: 'Use a worktree',
            isolation: 'worktree',
          },
        },
        { cwd },
      ),
    ).rejects.toThrow('Praxis does not support Agent isolation worktree yet')
  })

  it('enforces the session Agent call budget before creating another sidechain', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-agent-budget-test-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const executor = new ClaudeSubagentExecutor({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: {
        capabilities: { streaming: true, usage: true, tools: true },
        async *complete() {
          yield { type: 'text-delta', delta: 'BUDGET_CHILD_DONE' }
        },
      },
      baseTools: emptyTools,
      permissions: { resolve: () => ({ behavior: 'allow' }) },
      maxCalls: 1,
    })
    const registry = executor.registry(
      sessionId,
      0,
      () => '11111111-1111-4111-8111-111111111111',
    )
    const input = {
      description: 'Budget child',
      prompt: 'Return marker',
      subagent_type: 'general-purpose',
      run_in_background: false,
    }
    const first = await registry.prepare(
      { id: 'call_budget_1', name: 'Agent', input },
      { cwd },
    )
    await expect(registry.execute(first, { cwd })).resolves.toMatchObject({
      isError: false,
    })
    const second = await registry.prepare(
      { id: 'call_budget_2', name: 'Agent', input },
      { cwd },
    )

    await expect(registry.execute(second, { cwd })).rejects.toThrow(
      'Agent call count exceeded 1',
    )

    const paths = resolveClaudePaths({ configDir: configRoot, cwd, sessionId })
    expect(
      await readdir(join(paths.projectRoot, sessionId, 'subagents')),
    ).toHaveLength(2)
  })

  it('runs subagent tools through the shared preparation and permission path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-subagent-tool-test-'))
    roots.push(root)
    let mainTurn = 0
    let childTurn = 0
    const provider: ModelProvider = {
      capabilities: { streaming: true, usage: true, tools: true },
      async *complete(request) {
        const serialized = JSON.stringify(request.messages)
        if (serialized.includes('general-purpose subagent')) {
          if (childTurn++ === 0) {
            yield {
              type: 'tool-call',
              call: { id: 'call_probe', name: 'Probe', input: { value: 1 } },
            }
          } else {
            expect(serialized).toContain('PROBE_RESULT')
            yield { type: 'text-delta', delta: 'CHILD_TOOL_DONE' }
          }
        } else if (mainTurn++ === 0) {
          yield {
            type: 'tool-call',
            call: {
              id: 'call_agent_tool',
              name: 'Agent',
              input: {
                description: 'Use probe',
                prompt: 'Call Probe',
                subagent_type: 'general-purpose',
                run_in_background: false,
              },
            },
          }
        } else {
          expect(serialized).toContain('CHILD_TOOL_DONE')
          yield { type: 'text-delta', delta: 'MAIN_TOOL_DONE' }
        }
      },
    }
    const prepared: string[] = []
    const executed: string[] = []
    const tools: ToolRegistry = {
      definitions: () => [
        {
          name: 'Probe',
          description: 'Probe.',
          inputSchema: { type: 'object' },
        },
      ],
      async prepare(call) {
        prepared.push(call.name)
        return call
      },
      async execute(call) {
        executed.push(call.name)
        return { content: 'PROBE_RESULT', isError: false }
      },
    }
    const resolved: string[] = []
    const permissions: PermissionResolver = {
      resolve(call) {
        resolved.push(call.name)
        return { behavior: 'allow' }
      },
    }
    const service = new ClaudeSessionService({
      configRoot: join(root, 'config'),
      cwd: join(root, 'project'),
      claudeVersion: '2.1.208',
      provider,
      tools,
      permissions,
      enableSubagents: true,
    })

    expect((await service.run('Delegate probe.')).text).toBe('MAIN_TOOL_DONE')
    expect(prepared).toEqual(['Probe'])
    expect(executed).toEqual(['Probe'])
    expect(resolved).toEqual(['Agent', 'Probe'])
  })

  it('aggregates nested usage and tool counts while enforcing maximum depth', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-nested-agent-test-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const requests: ModelRequest[] = []
    const provider: ModelProvider = {
      capabilities: { streaming: true, usage: true, tools: true },
      async *complete(request) {
        requests.push(request)
        const scope =
          [...request.messages]
            .reverse()
            .find(
              (message) =>
                message.role === 'user' &&
                /^DEPTH_[1-4]$/u.test(message.content),
            )?.content ?? 'MAIN'
        const hasToolResult = request.messages.some(
          (message) => message.role === 'tool',
        )
        if (!hasToolResult) {
          const nextDepth = scope === 'MAIN' ? 1 : Number(scope.slice(-1)) + 1
          yield {
            type: 'tool-call',
            call: {
              id: `call_depth_${nextDepth}`,
              name: 'Agent',
              input: {
                description: `Spawn depth ${nextDepth}`,
                prompt: `DEPTH_${nextDepth}`,
                subagent_type: 'general-purpose',
                run_in_background: false,
              },
            },
          }
        } else {
          yield {
            type: 'text-delta',
            delta: scope === 'MAIN' ? 'NESTED_MAIN_DONE' : `${scope}_DONE`,
          }
        }
        yield {
          type: 'usage',
          usage: { inputTokens: 1, outputTokens: 1 },
        }
      },
    }
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider,
      tools: emptyTools,
      permissions: { resolve: () => ({ behavior: 'allow' }) },
      enableSubagents: true,
    })

    const result = await service.run('Exercise nested Agents.')

    expect(result.text).toBe('NESTED_MAIN_DONE')
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 10 })
    expect(requests).toHaveLength(10)
    const paths = resolveClaudePaths({
      configDir: configRoot,
      cwd,
      sessionId: result.sessionId,
    })
    const mainEntries = entries(await readFile(paths.sessionFile, 'utf8'))
    const mainAgentResult = mainEntries.find(
      (entry) =>
        entry.type === 'user' &&
        typeof entry.toolUseResult === 'object' &&
        entry.toolUseResult !== null &&
        (entry.toolUseResult as Record<string, unknown>).agentId,
    )?.toolUseResult as Record<string, unknown>
    expect(mainAgentResult).toMatchObject({
      totalTokens: 16,
      totalToolUseCount: 4,
      usage: { input_tokens: 8, output_tokens: 8 },
    })
    const sidechainDirectory = join(
      paths.projectRoot,
      result.sessionId,
      'subagents',
    )
    const sidechainFiles = await readdir(sidechainDirectory)
    expect(
      sidechainFiles.filter((name) => name.endsWith('.jsonl')),
    ).toHaveLength(4)
    const metadata = await Promise.all(
      sidechainFiles
        .filter((name) => name.endsWith('.meta.json'))
        .map(async (name) =>
          JSON.parse(await readFile(join(sidechainDirectory, name), 'utf8')),
        ),
    )
    expect(
      metadata
        .map((value) => (value as Record<string, unknown>).spawnDepth)
        .sort(),
    ).toEqual([1, 2, 3, 4])
    const sidechainSource = (
      await Promise.all(
        sidechainFiles
          .filter((name) => name.endsWith('.jsonl'))
          .map((name) => readFile(join(sidechainDirectory, name), 'utf8')),
      )
    ).join('\n')
    expect(sidechainSource).toContain('Agent spawn depth exceeded 4')
  })

  it('propagates cancellation into the active subagent without a fake result', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-subagent-cancel-test-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    let childStarted!: () => void
    const started = new Promise<void>((resolve) => {
      childStarted = resolve
    })
    const provider: ModelProvider = {
      capabilities: { streaming: true, usage: true, tools: true },
      async *complete(request) {
        if (
          JSON.stringify(request.messages).includes('general-purpose subagent')
        ) {
          childStarted()
          await new Promise<void>((resolve) => {
            request.signal?.addEventListener('abort', () => resolve(), {
              once: true,
            })
          })
          throw new DOMException('Aborted', 'AbortError')
        }
        yield {
          type: 'tool-call',
          call: {
            id: 'call_cancel_agent',
            name: 'Agent',
            input: {
              description: 'Wait',
              prompt: 'Wait for cancellation',
              subagent_type: 'general-purpose',
              run_in_background: false,
            },
          },
        }
      },
    }
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider,
      tools: emptyTools,
      permissions: { resolve: () => ({ behavior: 'allow' }) },
      enableSubagents: true,
    })
    const controller = new AbortController()
    const running = service.run('Start waiting agent.', controller.signal)
    await started
    controller.abort()

    await expect(running).rejects.toBeInstanceOf(AgentRunCancelledError)
    const projectRoot = resolveClaudePaths({
      configDir: configRoot,
      cwd,
      sessionId: '00000000-0000-4000-8000-000000000000',
    }).projectRoot
    const mainFile = (await readdir(projectRoot)).find((name) =>
      name.endsWith('.jsonl'),
    )
    if (!mainFile) throw new Error('Cancelled main transcript is missing')
    const mainEntries = entries(
      await readFile(join(projectRoot, mainFile), 'utf8'),
    )
    expect(JSON.stringify(mainEntries)).toContain('call_cancel_agent')
    expect(JSON.stringify(mainEntries)).not.toContain('tool_use_id')
    const sessionId = mainFile.slice(0, -'.jsonl'.length)
    const sidechainDirectory = join(projectRoot, sessionId, 'subagents')
    const sidechainFile = (await readdir(sidechainDirectory)).find((name) =>
      name.endsWith('.jsonl'),
    )
    if (!sidechainFile) throw new Error('Cancelled sidechain is missing')
    expect(
      entries(await readFile(join(sidechainDirectory, sidechainFile), 'utf8')),
    ).toHaveLength(1)
  })

  it('recovers an interrupted Agent call only after explicit approval', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-subagent-recovery-test-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const controller = new AbortController()
    const interrupted = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: {
        capabilities: { streaming: true, usage: true, tools: true },
        async *complete() {
          yield {
            type: 'tool-call',
            call: {
              id: 'call_recover_agent',
              name: 'Agent',
              input: {
                description: 'Recover child',
                prompt: 'Return RECOVERED_CHILD',
                subagent_type: 'general-purpose',
                run_in_background: false,
              },
            },
          }
        },
      },
      tools: emptyTools,
      permissions: {
        resolve() {
          controller.abort()
          return { behavior: 'allow' }
        },
      },
      enableSubagents: true,
    })
    await expect(
      interrupted.run('Start recoverable Agent.', controller.signal),
    ).rejects.toBeInstanceOf(AgentRunCancelledError)
    const projectRoot = resolveClaudePaths({
      configDir: configRoot,
      cwd,
      sessionId: '00000000-0000-4000-8000-000000000000',
    }).projectRoot
    const mainFile = (await readdir(projectRoot)).find((name) =>
      name.endsWith('.jsonl'),
    )
    if (!mainFile) throw new Error('Interrupted main transcript is missing')
    const sessionId = mainFile.slice(0, -'.jsonl'.length)
    const mainPath = join(projectRoot, mainFile)
    const interruptedSource = await readFile(mainPath, 'utf8')
    expect(interruptedSource).toContain('"promptSource":"interactive"')
    await writeFile(
      mainPath,
      interruptedSource.replace(
        '"promptSource":"interactive"',
        '"promptSource":"sdk"',
      ),
    )
    const approvals: string[] = []
    const recovered = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: {
        capabilities: { streaming: true, usage: true, tools: true },
        async *complete(request) {
          if (
            JSON.stringify(request.messages).includes(
              'general-purpose subagent',
            )
          ) {
            yield { type: 'text-delta', delta: 'RECOVERED_CHILD' }
            yield {
              type: 'usage',
              usage: { inputTokens: 4, outputTokens: 2 },
            }
          } else {
            yield { type: 'text-delta', delta: 'RECOVERED_MAIN' }
            yield {
              type: 'usage',
              usage: { inputTokens: 5, outputTokens: 3 },
            }
          }
        },
      },
      tools: emptyTools,
      permissions: { resolve: () => ({ behavior: 'allow' }) },
      approveRecovery(call) {
        approvals.push(call.id)
        return true
      },
      enableSubagents: true,
    })

    const result = await recovered.resume(sessionId, 'Continue recovery.')

    expect(result.text).toBe('RECOVERED_MAIN')
    expect(result.usage).toEqual({ inputTokens: 9, outputTokens: 5 })
    expect(approvals).toEqual(['call_recover_agent'])
    const source = await readFile(join(projectRoot, mainFile), 'utf8')
    expect(source).toContain('"status":"completed"')
    expect(source).toContain('RECOVERED_CHILD')
    const sidechains = await readdir(join(projectRoot, sessionId, 'subagents'))
    expect(sidechains.filter((name) => name.endsWith('.jsonl'))).toHaveLength(1)
  })
})
