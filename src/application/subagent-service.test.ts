import { execFile } from 'node:child_process'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { resolveClaudePaths } from '../compatibility/claude/paths.js'
import type {
  ModelProvider,
  ModelRequest,
  PermissionResolver,
  RuntimeEvent,
  ToolRegistry,
} from '../core/runtime.js'
import { AgentRunCancelledError } from '../core/runtime.js'
import { ClaudeExtensionCatalog } from '../extensions/claude-extensions.js'
import { ClaudeHookRunner } from '../hooks/claude-hooks.js'
import { ClaudePermissionResolver } from '../permissions/claude-permission-resolver.js'
import type { ClaudeMcpRuntime } from '../mcp/claude-mcp-tools.js'
import { resolveDataPlanePaths } from '../persistence/data-plane.js'
import { SubagentLifecycleStore } from '../persistence/subagent-lifecycle-store.js'
import { LocalToolRegistry } from '../tools/local-tools.js'
import { ClaudeSessionService } from './session-service.js'
import {
  type AgentPermissionMode,
  agentMemoryPrompt,
  ClaudeSubagentExecutor,
  StructuredOutputRegistry,
} from './subagent-service.js'

const roots: string[] = []
const execFileAsync = promisify(execFile)
const originalSubagentModel = process.env.CLAUDE_CODE_SUBAGENT_MODEL

const emptyTools: ToolRegistry = {
  definitions: () => [],
  async prepare(call) {
    return call
  },
  async execute(call) {
    throw new Error(`Unexpected base tool ${call.name}`)
  },
}

describe('StructuredOutputRegistry', () => {
  it('appends a hidden schema tool, validates input, and captures exactly once', async () => {
    const capture = { calls: 0, value: undefined as unknown }
    const registry = new StructuredOutputRegistry(
      emptyTools,
      {
        type: 'object',
        properties: { answer: { type: 'string' } },
        required: ['answer'],
        additionalProperties: false,
      },
      capture,
    )
    expect(registry.definitions().map(({ name }) => name)).toEqual([
      'StructuredOutput',
    ])
    const call = {
      id: 'structured',
      name: 'StructuredOutput',
      input: { answer: 'ok' },
    }
    await registry.prepare(call, { cwd: '/tmp' })
    await registry.execute(call, { cwd: '/tmp' })
    expect(capture).toEqual({ calls: 1, value: { answer: 'ok' } })
    expect(() => registry.prepare(call, { cwd: '/tmp' })).toThrow(
      'exactly once',
    )
  })

  it('rejects schema-invalid structured values before execution', async () => {
    const registry = new StructuredOutputRegistry(
      emptyTools,
      { type: 'object', required: ['answer'] },
      { calls: 0, value: undefined },
    )
    expect(() =>
      registry.prepare(
        { id: 'structured', name: 'StructuredOutput', input: {} },
        { cwd: '/tmp' },
      ),
    ).toThrow('validation failed')
  })
})

beforeEach(() => {
  delete process.env.CLAUDE_CODE_SUBAGENT_MODEL
})

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  )
  if (originalSubagentModel === undefined) {
    delete process.env.CLAUDE_CODE_SUBAGENT_MODEL
  } else {
    process.env.CLAUDE_CODE_SUBAGENT_MODEL = originalSubagentModel
  }
})

async function gitRepository(prefix: string) {
  const fixtureRoot = await mkdtemp(join(tmpdir(), prefix))
  roots.push(fixtureRoot)
  const cwd = join(fixtureRoot, 'repo')
  await execFileAsync('git', ['init', cwd])
  await writeFile(join(cwd, 'tracked.txt'), 'base\n')
  await execFileAsync('git', ['-C', cwd, 'add', 'tracked.txt'])
  await execFileAsync('git', [
    '-C',
    cwd,
    '-c',
    'user.name=Praxis Test',
    '-c',
    'user.email=praxis@example.invalid',
    'commit',
    '-m',
    'fixture',
  ])
  return { fixtureRoot, cwd, configRoot: join(fixtureRoot, 'config') }
}

function entries(source: string): Record<string, unknown>[] {
  return source
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe('foreground Claude Agent execution', () => {
  it('keeps foreground Agent transcripts in memory without disk sidechains', async () => {
    const root = await mkdtemp(
      join(tmpdir(), 'praxis-subagent-ephemeral-test-'),
    )
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const requests: ModelRequest[] = []
    const provider: ModelProvider = {
      model: 'ephemeral-fixture-model',
      capabilities: { streaming: true, usage: true, tools: true },
      async *complete(request) {
        requests.push(request)
        const child = request.messages.some(
          (message) =>
            message.role === 'system' &&
            message.content.includes('general-purpose subagent'),
        )
        if (child) {
          yield { type: 'text-delta', delta: 'FOREGROUND_CHILD_RESULT' }
          yield {
            type: 'usage',
            usage: { inputTokens: 4, outputTokens: 2 },
          }
        } else if (
          request.messages.some((message) => message.role === 'tool')
        ) {
          yield { type: 'text-delta', delta: 'MAIN_DONE' }
          yield {
            type: 'usage',
            usage: { inputTokens: 2, outputTokens: 1 },
          }
        } else {
          yield {
            type: 'tool-call',
            call: {
              id: 'foreground_agent',
              name: 'Agent',
              input: {
                description: 'Foreground child',
                prompt: 'Run foreground child',
                subagent_type: 'general-purpose',
                run_in_background: false,
              },
            },
          }
          yield {
            type: 'usage',
            usage: { inputTokens: 5, outputTokens: 2 },
          }
        }
      },
    }
    const runtimeEvents: RuntimeEvent[] = []
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider,
      tools: emptyTools,
      permissions: { resolve: () => ({ behavior: 'allow' }) },
      eventSink: (event) => runtimeEvents.push(event),
      enableSubagents: true,
      sessionPersistence: false,
    })

    const result = await service.run('Delegate ephemerally.')

    expect(result.text).toBe('MAIN_DONE')
    expect(result.usage.inputTokens).toBeGreaterThan(0)
    expect(result.usage.outputTokens).toBeGreaterThan(0)
    expect(requests).toHaveLength(3)
    expect(runtimeEvents).toContainEqual(
      expect.objectContaining({
        type: 'task-started',
        description: 'Foreground child',
      }),
    )
    expect(runtimeEvents).toContainEqual(
      expect.objectContaining({
        type: 'task-notification',
        status: 'completed',
        summary: 'FOREGROUND_CHILD_RESULT',
      }),
    )
    const paths = resolveClaudePaths({
      configDir: configRoot,
      cwd,
      sessionId: result.sessionId,
    })
    await expect(readFile(paths.sessionFile)).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await expect(
      readdir(join(paths.projectRoot, result.sessionId)),
    ).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('propagates child model usage and reports child line changes once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-subagent-modelusage-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    let childTurn = 0
    const childProvider: ModelProvider = {
      model: 'child-raw-model',
      capabilities: { streaming: true, usage: true, tools: true },
      async *complete() {
        if (childTurn === 0) {
          yield {
            type: 'tool-call',
            call: {
              id: 'call_write_ok',
              name: 'Write',
              input: { file_path: 'ok.txt', content: 'ok' },
            },
          }
        } else if (childTurn === 1) {
          yield {
            type: 'tool-call',
            call: {
              id: 'call_write_err',
              name: 'Write',
              input: { file_path: 'err.txt', content: 'err' },
            },
          }
        } else {
          yield { type: 'text-delta', delta: 'CHILD_MODEL_DONE' }
        }
        childTurn += 1
        yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1 } }
      },
    }
    const parentProvider: ModelProvider = {
      model: 'parent-raw-model',
      capabilities: { streaming: true, usage: true, tools: true },
      async *complete() {
        yield { type: 'text-delta', delta: 'PARENT_UNUSED' }
        throw new Error('Parent provider must not stream in this test')
      },
    }
    const writeTools: ToolRegistry = {
      definitions: () => [
        {
          name: 'Write',
          description: 'Write a file.',
          inputSchema: { type: 'object' },
        },
      ],
      async prepare(call) {
        return call
      },
      async execute(call) {
        if (call.input.file_path === 'ok.txt') {
          return {
            content: 'WROTE_OK',
            isError: false,
            linesAdded: 3,
            linesRemoved: 1,
          }
        }
        return {
          content: 'WROTE_ERR',
          isError: true,
          linesAdded: 7,
          linesRemoved: 2,
        }
      },
    }
    const lineChanges: { linesAdded: number; linesRemoved: number }[] = []
    const executor = new ClaudeSubagentExecutor({
      configRoot,
      dataPlane: 'claude',
      cwd,
      claudeVersion: '2.1.208',
      provider: parentProvider,
      baseTools: writeTools,
      permissions: { resolve: () => ({ behavior: 'allow' }) },
      providerForModel: () => childProvider,
      onLineChanges: (changes) => {
        lineChanges.push(changes)
      },
    })
    const registry = executor.registry(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      0,
      () => 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    )
    const call = await registry.prepare(
      {
        id: 'call_model_usage',
        name: 'Agent',
        input: {
          description: 'Model usage child',
          prompt: 'CHILD_MODEL_PROMPT',
          subagent_type: 'general-purpose',
          model: 'child-raw-model',
          run_in_background: false,
        },
      },
      { cwd },
    )
    const agentResult = await registry.execute(call, { cwd })

    expect(agentResult.usage).toEqual({ inputTokens: 6, outputTokens: 3 })
    expect(agentResult.modelUsage).toEqual({
      'child-raw-model': { inputTokens: 6, outputTokens: 3 },
    })
    expect(agentResult.linesAdded).toBeUndefined()
    expect(agentResult.linesRemoved).toBeUndefined()
    expect(lineChanges).toEqual([{ linesAdded: 3, linesRemoved: 1 }])
  })

  it('carries raw-model usage through workflow results and background notifications exactly once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-raw-model-carry-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const provider: ModelProvider = {
      model: 'raw-cache-model',
      capabilities: { streaming: true, usage: true, tools: true },
      async *complete(request) {
        const source = JSON.stringify(request.messages)
        if (source.includes('WORKFLOW_PROMPT')) {
          yield { type: 'text-delta', delta: 'WORKFLOW_DONE' }
          yield {
            type: 'usage',
            usage: {
              inputTokens: 4,
              outputTokens: 2,
              cacheReadInputTokens: 9,
            },
          }
        } else {
          yield { type: 'text-delta', delta: 'BACKGROUND_DONE' }
          yield {
            type: 'usage',
            usage: {
              inputTokens: 3,
              outputTokens: 1,
              cacheReadInputTokens: 6,
            },
          }
        }
      },
    }
    const executor = new ClaudeSubagentExecutor({
      configRoot,
      dataPlane: 'claude',
      cwd,
      claudeVersion: '2.1.208',
      provider,
      baseTools: emptyTools,
      permissions: { resolve: () => ({ behavior: 'allow' }) },
    })

    const workflow = await executor.runWorkflowAgent({
      sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      promptId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      runId: 'raw-model-run',
      agentId: 'a1234567890abcdef',
      transcriptDirectory: join(root, 'workflow'),
      prompt: 'WORKFLOW_PROMPT',
    })
    expect(workflow.modelUsage).toEqual({
      'raw-cache-model': {
        inputTokens: 4,
        outputTokens: 2,
        cacheReadInputTokens: 9,
      },
    })
    expect(workflow.usage).toEqual({
      inputTokens: 4,
      outputTokens: 2,
      cacheReadInputTokens: 9,
    })

    const registry = executor.registry(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      0,
      () => 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    )
    await registry.execute(
      await registry.prepare(
        {
          id: 'call_raw_background',
          name: 'Agent',
          input: {
            description: 'Raw model background',
            prompt: 'BACKGROUND_PROMPT',
            subagent_type: 'general-purpose',
            run_in_background: true,
          },
        },
        { cwd },
      ),
      { cwd },
    )

    const first = await executor.notifications(true)
    expect(first).toMatchObject({
      messages: [expect.stringContaining('BACKGROUND_DONE')],
      usage: {
        inputTokens: 3,
        outputTokens: 1,
        cacheReadInputTokens: 6,
      },
      modelUsage: {
        'raw-cache-model': {
          inputTokens: 3,
          outputTokens: 1,
          cacheReadInputTokens: 6,
        },
      },
    })
    expect(first.durationApiMs).toBeGreaterThanOrEqual(0)
    expect(first.durationApiWithoutRetriesMs).toBe(first.durationApiMs)
    await expect(executor.notifications(false)).resolves.toEqual({
      messages: [],
      usage: { inputTokens: 0, outputTokens: 0 },
    })
  })

  it('reports child line changes before persisting the tool-result entry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-subagent-line-order-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    let childTurn = 0
    const childProvider: ModelProvider = {
      model: 'child-raw-model',
      capabilities: { streaming: true, usage: true, tools: true },
      async *complete() {
        if (childTurn === 0) {
          yield {
            type: 'tool-call',
            call: {
              id: 'call_write_ok',
              name: 'Write',
              input: { file_path: 'ok.txt', content: 'ok' },
            },
          }
        } else {
          yield { type: 'text-delta', delta: 'CHILD_MODEL_DONE' }
        }
        childTurn += 1
        yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1 } }
      },
    }
    const parentProvider: ModelProvider = {
      model: 'parent-raw-model',
      capabilities: { streaming: true, usage: true, tools: true },
      async *complete() {
        yield { type: 'text-delta', delta: 'PARENT_UNUSED' }
        throw new Error('Parent provider must not stream in this test')
      },
    }
    const writeTools: ToolRegistry = {
      definitions: () => [
        {
          name: 'Write',
          description: 'Write a file.',
          inputSchema: { type: 'object' },
        },
      ],
      async prepare(call) {
        return call
      },
      async execute() {
        return {
          content: 'WROTE_OK',
          isError: false,
          linesAdded: 3,
          linesRemoved: 1,
        }
      },
    }
    const lineChanges: { linesAdded: number; linesRemoved: number }[] = []
    const rejection = new Error('line change accounting failed')
    const executor = new ClaudeSubagentExecutor({
      configRoot,
      dataPlane: 'claude',
      cwd,
      claudeVersion: '2.1.208',
      provider: parentProvider,
      baseTools: writeTools,
      permissions: { resolve: () => ({ behavior: 'allow' }) },
      providerForModel: () => childProvider,
      onLineChanges: (changes) => {
        lineChanges.push(changes)
        throw rejection
      },
    })
    const registry = executor.registry(
      sessionId,
      0,
      () => 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    )
    const call = await registry.prepare(
      {
        id: 'call_line_order',
        name: 'Agent',
        input: {
          description: 'Line ordering child',
          prompt: 'CHILD_MODEL_PROMPT',
          subagent_type: 'general-purpose',
          model: 'child-raw-model',
          run_in_background: false,
        },
      },
      { cwd },
    )
    await expect(registry.execute(call, { cwd })).rejects.toThrow(rejection)

    expect(lineChanges).toEqual([{ linesAdded: 3, linesRemoved: 1 }])

    const paths = resolveClaudePaths({ configDir: configRoot, cwd, sessionId })
    const sidechainDirectory = join(paths.projectRoot, sessionId, 'subagents')
    const transcriptFile = (await readdir(sidechainDirectory)).find((name) =>
      name.endsWith('.jsonl'),
    )
    if (!transcriptFile) {
      throw new Error('Subagent sidechain transcript is missing')
    }
    const transcript = entries(
      await readFile(join(sidechainDirectory, transcriptFile), 'utf8'),
    )
    const persistedToolResultIds = transcript.flatMap((entry) => {
      if (entry.type !== 'user') return []
      const message = entry.message
      if (typeof message !== 'object' || message === null) return []
      const content = (message as Record<string, unknown>).content
      if (!Array.isArray(content)) return []
      return content.flatMap((block) => {
        if (typeof block !== 'object' || block === null) return []
        const record = block as Record<string, unknown>
        if (record.type !== 'tool_result') return []
        return typeof record.tool_use_id === 'string'
          ? [record.tool_use_id]
          : []
      })
    })
    expect(persistedToolResultIds).not.toContain('call_write_ok')
  })

  it('rejects background Agent execution when persistence is disabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-subagent-ephemeral-bg-'))
    roots.push(root)
    const executor = new ClaudeSubagentExecutor({
      configRoot: join(root, 'config'),
      dataPlane: 'claude',
      cwd: join(root, 'project'),
      claudeVersion: '2.1.208',
      provider: {
        capabilities: { streaming: true, usage: true, tools: true },
        async *complete() {
          yield { type: 'text-delta', delta: 'unused' }
        },
      },
      baseTools: emptyTools,
      permissions: { resolve: () => ({ behavior: 'allow' }) },
      persistence: 'memory',
    })

    expect(() =>
      executor.prepare(
        {
          id: 'background_agent',
          name: 'Agent',
          input: {
            description: 'Background child',
            prompt: 'Run in background',
            subagent_type: 'general-purpose',
            run_in_background: true,
          },
        },
        0,
      ),
    ).toThrow('Background agents require session persistence')
    await expect(
      executor.runWorkflowAgent({
        sessionId: '11111111-1111-4111-8111-111111111111',
        promptId: 'prompt',
        runId: 'run',
        agentId: 'agent',
        transcriptDirectory: join(root, 'workflow'),
        prompt: 'Run workflow',
      }),
    ).rejects.toThrow('Workflow agents require session persistence')
  })

  it.each([
    { dataPlane: 'native' as const, projectDirectory: 'sessions' },
    { dataPlane: 'claude' as const, projectDirectory: 'projects' },
  ])(
    'stores $dataPlane sidechains and locks in that data plane',
    async ({ dataPlane, projectDirectory }) => {
      const root = await mkdtemp(join(tmpdir(), `praxis-${dataPlane}-agent-`))
      roots.push(root)
      const configRoot = join(root, 'config')
      const cwd = join(root, 'project')
      await mkdir(cwd, { recursive: true })
      const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      const executor = new ClaudeSubagentExecutor({
        configRoot,
        dataPlane,
        cwd,
        claudeVersion: '2.1.208',
        provider: {
          capabilities: { streaming: true, usage: true, tools: true },
          async *complete() {
            yield { type: 'text-delta', delta: 'SIDECHAIN_DONE' }
            yield {
              type: 'usage',
              usage: { inputTokens: 2, outputTokens: 1 },
            }
          },
        },
        baseTools: emptyTools,
        permissions: { resolve: () => ({ behavior: 'allow' }) },
      })
      const registry = executor.registry(
        sessionId,
        0,
        () => 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      )
      const result = await registry.execute(
        await registry.prepare(
          {
            id: `call_${dataPlane}`,
            name: 'Agent',
            input: {
              description: `${dataPlane} paths`,
              prompt: 'Return the marker',
              subagent_type: 'general-purpose',
              run_in_background: false,
            },
          },
          { cwd },
        ),
        { cwd },
      )
      const agentId = String(result.nativeToolUseResult?.agentId)
      const paths =
        dataPlane === 'native'
          ? resolveDataPlanePaths({
              dataPlane,
              root: configRoot,
              cwd,
              sessionId,
            })
          : resolveClaudePaths({ configDir: configRoot, cwd, sessionId })
      const transcript = join(
        paths.projectRoot,
        sessionId,
        'subagents',
        `agent-${agentId}.jsonl`,
      )
      await expect(readFile(transcript, 'utf8')).resolves.toContain(
        'SIDECHAIN_DONE',
      )
      expect((await stat(join(paths.praxisRoot, 'locks'))).isDirectory()).toBe(
        true,
      )
      const wrongProjectRoot = join(
        configRoot,
        projectDirectory === 'sessions' ? 'projects' : 'sessions',
      )
      await expect(stat(wrongProjectRoot)).rejects.toMatchObject({
        code: 'ENOENT',
      })
      const wrongLockRoot = join(
        configRoot,
        dataPlane === 'native' ? 'praxis' : 'state',
      )
      await expect(stat(wrongLockRoot)).rejects.toMatchObject({
        code: 'ENOENT',
      })
    },
  )

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
      permissionMode: 'default',
    })
  })

  it('loads a shared custom agent definition into subagent context', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-custom-agent-test-'))
    roots.push(root)
    const requests: ModelRequest[] = []
    const selectedModels: string[] = []
    let mainTurn = 0
    const provider: ModelProvider = {
      model: 'parent-model',
      capabilities: { streaming: true, usage: true, tools: true },
      async *complete(request) {
        requests.push(request)
        if (mainTurn++ === 0) {
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
    const childProvider: ModelProvider = {
      model: 'agent-model',
      capabilities: { streaming: true, usage: true, tools: true },
      async *complete(request) {
        requests.push(request)
        yield { type: 'text-delta', delta: 'CUSTOM_DONE' }
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
            "---\nname: reviewer\ndescription: Review code\ntools: [Read, Bash, Edit, TaskOutput]\ndisallowedTools: 'Bash(git:*)'\nmodel: agent-model\neffort: high\n---\nCUSTOM_REVIEW_POLICY",
        },
      ],
    })
    const tools: ToolRegistry = {
      definitions: () =>
        ['Read', 'Bash', 'Edit', 'TaskOutput'].map((name) => ({
          name,
          description: name,
          inputSchema: { type: 'object' },
        })),
      prepare: async (call) => call,
      execute: async (call) => ({
        content: call.name,
        isError: false,
      }),
    }
    const service = new ClaudeSessionService({
      configRoot: join(root, 'config'),
      cwd: join(root, 'project'),
      claudeVersion: '2.1.208',
      provider,
      providerForModel(model) {
        selectedModels.push(model)
        return childProvider
      },
      tools,
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
    const childRequest = requests.find((request) =>
      JSON.stringify(request.messages).includes('CUSTOM_REVIEW_POLICY'),
    )
    expect(selectedModels).toEqual(['agent-model'])
    expect(childRequest?.tools?.map(({ name }) => name)).toEqual([
      'Read',
      'Edit',
    ])
    expect(childRequest?.effort).toBe('high')
  })

  it('uses a custom agent maxTurns limit for the child loop', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-agent-turn-limit-test-'))
    roots.push(root)
    const cwd = join(root, 'project')
    let requests = 0
    const tools: ToolRegistry = {
      definitions: () => [
        {
          name: 'Read',
          description: 'Read',
          inputSchema: { type: 'object' },
        },
      ],
      prepare: async (call) => call,
      execute: async () => ({ content: 'READ', isError: false }),
    }
    const executor = new ClaudeSubagentExecutor({
      configRoot: join(root, 'config'),
      dataPlane: 'claude',
      cwd,
      claudeVersion: '2.1.208',
      provider: {
        capabilities: { streaming: true, usage: true, tools: true },
        async *complete() {
          requests += 1
          yield {
            type: 'tool-call',
            call: { id: `read_${requests}`, name: 'Read', input: {} },
          }
        },
      },
      baseTools: tools,
      permissions: { resolve: () => ({ behavior: 'allow' }) },
      extensions: new ClaudeExtensionCatalog({
        commands: [],
        skills: [],
        agents: [
          {
            path: join(root, 'config', 'agents', 'bounded.md'),
            scope: 'user',
            content:
              '---\nname: bounded\ndescription: Stop promptly.\ntools: [Read]\nmaxTurns: 2\n---\nBOUNDED_AGENT',
          },
        ],
      }),
    })
    const registry = executor.registry(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      0,
      () => 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    )
    const prepared = await registry.prepare(
      {
        id: 'call_bounded',
        name: 'Agent',
        input: {
          description: 'Bounded child',
          prompt: 'Keep reading',
          subagent_type: 'bounded',
          run_in_background: false,
        },
      },
      { cwd },
    )

    await expect(registry.execute(prepared, { cwd })).rejects.toThrow(
      'Maximum model turns of 2 exceeded',
    )
    expect(requests).toBe(2)
  })

  it('does not invent a model turn limit for a default child loop', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-agent-unbounded-test-'))
    roots.push(root)
    const cwd = join(root, 'project')
    let requests = 0
    const tools: ToolRegistry = {
      definitions: () => [
        {
          name: 'Read',
          description: 'Read',
          inputSchema: { type: 'object' },
        },
      ],
      prepare: async (call) => call,
      execute: async () => ({ content: 'READ', isError: false }),
    }
    const executor = new ClaudeSubagentExecutor({
      configRoot: join(root, 'config'),
      dataPlane: 'claude',
      cwd,
      claudeVersion: '2.1.208',
      provider: {
        capabilities: { streaming: true, usage: true, tools: true },
        async *complete() {
          requests += 1
          if (requests <= 17) {
            yield {
              type: 'tool-call',
              call: { id: `read_${requests}`, name: 'Read', input: {} },
            }
            return
          }
          yield { type: 'text-delta', delta: 'CHILD_DONE' }
        },
      },
      baseTools: tools,
      permissions: { resolve: () => ({ behavior: 'allow' }) },
      extensions: new ClaudeExtensionCatalog({
        commands: [],
        skills: [],
        agents: [],
      }),
    })
    const registry = executor.registry(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      0,
      () => 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    )
    const prepared = await registry.prepare(
      {
        id: 'call_unbounded',
        name: 'Agent',
        input: {
          description: 'Unbounded child',
          prompt: 'Keep reading until done',
          subagent_type: 'general-purpose',
          run_in_background: false,
        },
      },
      { cwd },
    )

    await expect(registry.execute(prepared, { cwd })).resolves.toMatchObject({
      isError: false,
    })
    expect(requests).toBe(18)
  })

  it('applies custom agent launch controls and preserves protected parent permission modes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-agent-launch-test-'))
    roots.push(root)
    const cwd = join(root, 'project')
    const extensions = new ClaudeExtensionCatalog({
      commands: [],
      skills: [],
      agents: [
        {
          path: join(root, 'config', 'agents', 'isolated.md'),
          scope: 'user',
          content:
            '---\nname: isolated\ndescription: Work alone.\npermissionMode: plan\nbackground: true\nisolation: worktree\n---\nISOLATED_AGENT',
        },
      ],
    })
    const createExecutor = (parentMode: AgentPermissionMode = 'default') =>
      new ClaudeSubagentExecutor({
        configRoot: join(root, 'config'),
        dataPlane: 'claude',
        cwd,
        claudeVersion: '2.1.208',
        provider: {
          capabilities: { streaming: true, usage: true, tools: true },
          async *complete() {
            yield { type: 'text-delta', delta: 'DONE' }
          },
        },
        baseTools: emptyTools,
        permissions: { resolve: () => ({ behavior: 'allow' }) },
        permissionResolverForMode: () => ({
          resolve: () => ({ behavior: 'allow' }),
        }),
        parentPermissionMode: () => parentMode,
        extensions,
      })
    const prepare = (executor: ClaudeSubagentExecutor, subagentType: string) =>
      executor
        .registry(
          'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          0,
          () => 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        )
        .prepare(
          {
            id: `call_${subagentType}`,
            name: 'Agent',
            input: {
              description: 'Launch controls',
              prompt: 'Apply launch controls',
              subagent_type: subagentType,
              run_in_background: false,
            },
          },
          { cwd },
        )

    await expect(prepare(createExecutor(), 'isolated')).resolves.toMatchObject({
      input: {
        mode: 'plan',
        isolation: 'worktree',
        run_in_background: true,
      },
    })
    await expect(
      prepare(createExecutor('bypassPermissions'), 'isolated'),
    ).resolves.toMatchObject({
      input: { mode: 'bypassPermissions' },
    })
    await expect(
      prepare(createExecutor(), 'general-purpose'),
    ).resolves.toMatchObject({ input: { run_in_background: false } })
    await expect(
      prepare(createExecutor('plan'), 'general-purpose'),
    ).resolves.toMatchObject({ input: { mode: 'plan' } })
    await expect(
      prepare(createExecutor('dontAsk'), 'general-purpose'),
    ).resolves.toMatchObject({ input: { mode: 'dontAsk' } })

    for (const mode of ['plan', 'dontAsk'] as const) {
      const executor = createExecutor(mode)
      const registry = executor.registry(
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        0,
        () => 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      )
      const call = await registry.prepare(
        {
          id: `call_inherit_${mode}`,
          name: 'Agent',
          input: {
            description: `Inherit ${mode}`,
            prompt: `Use ${mode}`,
            subagent_type: 'general-purpose',
            run_in_background: false,
          },
        },
        { cwd },
      )
      await registry.execute(call, { cwd })
    }
    const paths = resolveClaudePaths({
      configDir: join(root, 'config'),
      cwd,
      sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    })
    const metadata = await Promise.all(
      (
        await readdir(
          join(
            paths.projectRoot,
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            'subagents',
          ),
        )
      )
        .filter((file) => file.endsWith('.meta.json'))
        .map(async (file) =>
          JSON.parse(
            await readFile(
              join(
                paths.projectRoot,
                'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                'subagents',
                file,
              ),
              'utf8',
            ),
          ),
        ),
    )
    expect(metadata.map((entry) => entry.permissionMode).sort()).toEqual([
      'dontAsk',
      'plan',
    ])
  })

  it('loads native custom agent memory and preloads declared skills', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-agent-memory-test-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const memoryDirectory = join(cwd, '.praxis', 'agent-memory', 'rememberer')
    await mkdir(memoryDirectory, { recursive: true })
    await writeFile(join(memoryDirectory, 'MEMORY.md'), 'AGENT_MEMORY_MARKER')
    const requests: ModelRequest[] = []
    let mainTurn = 0
    const provider: ModelProvider = {
      capabilities: { streaming: true, usage: true, tools: true },
      async *complete(request) {
        requests.push(request)
        const child = request.messages.some(
          (message) =>
            message.role === 'system' &&
            message.content.includes('REMEMBERER_POLICY'),
        )
        if (child) {
          yield { type: 'text-delta', delta: 'MEMORY_DONE' }
        } else if (mainTurn++ === 0) {
          yield {
            type: 'tool-call',
            call: {
              id: 'call_rememberer',
              name: 'Agent',
              input: {
                description: 'Use memory',
                prompt: 'Recall the marker',
                subagent_type: 'rememberer',
                run_in_background: false,
              },
            },
          }
        } else {
          yield { type: 'text-delta', delta: 'MAIN_DONE' }
        }
      },
    }
    const tools: ToolRegistry = {
      definitions: () =>
        ['Bash', 'Read', 'Edit', 'Write'].map((name) => ({
          name,
          description: name,
          inputSchema: { type: 'object' },
        })),
      prepare: async (call) => call,
      execute: async (call) => ({ content: call.name, isError: false }),
    }
    const extensions = new ClaudeExtensionCatalog({
      commands: [],
      skills: [
        {
          path: join(configRoot, 'skills', 'review', 'SKILL.md'),
          scope: 'user',
          content:
            '---\nname: review\ndescription: Review remembered facts.\n---\nSKILL_PRELOAD_MARKER',
        },
      ],
      agents: [
        {
          path: join(configRoot, 'agents', 'rememberer.md'),
          scope: 'user',
          content:
            '---\nname: rememberer\ndescription: Remember facts.\ntools: [Bash]\nskills: [review, missing]\nmemory: project\n---\nREMEMBERER_POLICY',
        },
      ],
    })
    const service = new ClaudeSessionService({
      configRoot,
      dataPlane: 'native',
      cwd,
      claudeVersion: '2.1.208',
      provider,
      tools,
      permissions: { resolve: () => ({ behavior: 'allow' }) },
      extensions,
      enableSubagents: true,
      sessionPersistence: false,
    })

    await expect(service.run('Delegate with memory.')).resolves.toMatchObject({
      text: 'MAIN_DONE',
    })
    const childRequest = requests.find((request) =>
      request.messages.some(
        (message) =>
          message.role === 'system' &&
          message.content.includes('REMEMBERER_POLICY'),
      ),
    )
    expect(childRequest?.tools?.map(({ name }) => name)).toEqual([
      'Bash',
      'Read',
      'Edit',
      'Write',
    ])
    expect(JSON.stringify(childRequest?.messages)).toContain(
      'AGENT_MEMORY_MARKER',
    )
    expect(JSON.stringify(childRequest?.messages)).toContain(memoryDirectory)
    expect(JSON.stringify(childRequest?.messages)).toContain(
      '<skill-format>true</skill-format>',
    )
    expect(JSON.stringify(childRequest?.messages)).toContain(
      'SKILL_PRELOAD_MARKER',
    )
    expect(JSON.stringify(childRequest?.messages)).not.toContain(
      '<command-name>missing</command-name>',
    )
  })

  it('retains project agent memory under .claude in explicit compatibility mode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-agent-memory-compat-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const memoryDirectory = join(cwd, '.claude', 'agent-memory', 'rememberer')
    await mkdir(memoryDirectory, { recursive: true })
    await writeFile(join(memoryDirectory, 'MEMORY.md'), 'COMPAT_MEMORY_MARKER')
    const extensions = new ClaudeExtensionCatalog({
      commands: [],
      skills: [],
      agents: [
        {
          path: join(configRoot, 'agents', 'rememberer.md'),
          scope: 'user',
          content:
            '---\nname: rememberer\ndescription: Remember facts.\nmemory: project\n---\nRemember.',
        },
      ],
    })

    const prompt = await agentMemoryPrompt(
      configRoot,
      cwd,
      extensions.agent('rememberer'),
      'claude',
    )

    expect(prompt).toContain('COMPAT_MEMORY_MARKER')
    expect(prompt).toContain(memoryDirectory)
  })

  it('stores local agent memory under the native project .praxis directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-agent-memory-local-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const memoryDirectory = join(
      cwd,
      '.praxis',
      'agent-memory-local',
      'reviewer',
    )
    await mkdir(memoryDirectory, { recursive: true })
    await writeFile(join(memoryDirectory, 'MEMORY.md'), 'LOCAL_MEMORY_MARKER')
    const extensions = new ClaudeExtensionCatalog({
      commands: [],
      skills: [],
      agents: [
        {
          path: join(configRoot, 'agents', 'reviewer.md'),
          scope: 'user',
          content:
            '---\nname: reviewer\ndescription: Review facts.\nmemory: local\n---\nReview.',
        },
      ],
    })

    const prompt = await agentMemoryPrompt(
      configRoot,
      cwd,
      extensions.agent('reviewer'),
      'native',
    )

    expect(prompt).toContain('LOCAL_MEMORY_MARKER')
    expect(prompt).toContain(memoryDirectory)
  })

  it('scopes frontmatter hooks to the custom agent lifecycle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-agent-hooks-test-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const hookCalls: { command: string; event: string }[] = []
    const hooks = new ClaudeHookRunner({
      cwd,
      settings: [
        {
          path: join(configRoot, 'settings.json'),
          scope: 'user',
          value: {
            hooks: {
              SubagentStart: [
                { hooks: [{ type: 'command', command: 'global-start' }] },
              ],
              PreToolUse: [
                {
                  matcher: 'Read',
                  hooks: [{ type: 'command', command: 'global-pre' }],
                },
              ],
              SubagentStop: [
                { hooks: [{ type: 'command', command: 'global-stop' }] },
              ],
              SessionStart: [
                { hooks: [{ type: 'command', command: 'wrong-start' }] },
              ],
              UserPromptSubmit: [
                { hooks: [{ type: 'command', command: 'wrong-prompt' }] },
              ],
              SessionEnd: [
                { hooks: [{ type: 'command', command: 'wrong-end' }] },
              ],
            },
          },
        },
      ],
      async executeCommand(command, input) {
        hookCalls.push({ command, event: input.hook_event_name })
        return { stdout: '', stderr: '', exitCode: 0, durationMs: 1 }
      },
    })
    let mainTurn = 0
    const provider: ModelProvider = {
      capabilities: { streaming: true, usage: true, tools: true },
      async *complete(request) {
        const child = request.messages.some(
          (message) =>
            message.role === 'system' &&
            message.content.includes('HOOK_AGENT_POLICY'),
        )
        const hasToolResult = request.messages.some(
          (message) => message.role === 'tool',
        )
        if (child && !hasToolResult) {
          yield {
            type: 'tool-call',
            call: { id: 'call_read', name: 'Read', input: {} },
          }
        } else if (child) {
          yield { type: 'text-delta', delta: 'HOOK_CHILD_DONE' }
        } else if (mainTurn++ === 0) {
          yield {
            type: 'tool-call',
            call: {
              id: 'call_hook_agent',
              name: 'Agent',
              input: {
                description: 'Run hooks',
                prompt: 'Read once',
                subagent_type: 'hook-agent',
                run_in_background: false,
              },
            },
          }
        } else {
          yield { type: 'text-delta', delta: 'HOOK_MAIN_DONE' }
        }
      },
    }
    const tools: ToolRegistry = {
      definitions: () => [
        { name: 'Read', description: 'Read', inputSchema: { type: 'object' } },
      ],
      prepare: async (call) => call,
      execute: async () => ({ content: 'READ', isError: false }),
    }
    const extensions = new ClaudeExtensionCatalog({
      commands: [],
      skills: [],
      agents: [
        {
          path: join(configRoot, 'agents', 'hook-agent.md'),
          scope: 'user',
          content:
            '---\nname: hook-agent\ndescription: Exercise hooks.\ntools: [Read]\nhooks:\n  SubagentStart:\n    - hooks:\n        - type: command\n          command: agent-start\n  PreToolUse:\n    - matcher: Read\n      hooks:\n        - type: command\n          command: agent-pre\n  Stop:\n    - hooks:\n        - type: command\n          command: agent-stop\n---\nHOOK_AGENT_POLICY',
        },
      ],
    })
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider,
      tools,
      permissions: { resolve: () => ({ behavior: 'allow' }) },
      extensions,
      hooks,
      enableSubagents: true,
      sessionPersistence: false,
    })

    await expect(service.run('Delegate with hooks.')).resolves.toMatchObject({
      text: 'HOOK_MAIN_DONE',
    })
    expect(
      hookCalls.filter(({ command }) => !command.startsWith('wrong-')),
    ).toEqual([
      { command: 'global-start', event: 'SubagentStart' },
      { command: 'agent-start', event: 'SubagentStart' },
      { command: 'global-pre', event: 'PreToolUse' },
      { command: 'agent-pre', event: 'PreToolUse' },
      { command: 'global-stop', event: 'SubagentStop' },
      { command: 'agent-stop', event: 'SubagentStop' },
    ])
  })

  it('adds and closes agent-specific MCP tools', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-agent-mcp-test-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const connections: unknown[][] = []
    let closed = 0
    const mcp: ClaudeMcpRuntime = {
      inspect: async () => [],
      reconnect: async () => undefined,
      authenticate: async () => undefined,
      reload: async () => undefined,
      tools: async () => [],
      async connectAgent({ specs, base }) {
        connections.push([...specs])
        const tools: ToolRegistry = {
          definitions: () => [
            ...base.definitions(),
            {
              name: 'mcp__agent_fixture__probe',
              description: 'Agent MCP probe',
              inputSchema: { type: 'object' },
            },
          ],
          prepare: async (call, context) =>
            call.name === 'mcp__agent_fixture__probe'
              ? call
              : base.prepare(call, context),
          execute: async (call, context) =>
            call.name === 'mcp__agent_fixture__probe'
              ? { content: 'AGENT_MCP_RESULT', isError: false }
              : base.execute(call, context),
        }
        return {
          tools,
          async close() {
            closed += 1
          },
        }
      },
    }
    let mainTurn = 0
    const provider: ModelProvider = {
      capabilities: { streaming: true, usage: true, tools: true },
      async *complete(request) {
        const child = request.messages.some(
          (message) =>
            message.role === 'system' &&
            message.content.includes('MCP_AGENT_POLICY'),
        )
        const hasToolResult = request.messages.some(
          (message) => message.role === 'tool',
        )
        if (child && !hasToolResult) {
          expect(request.tools?.map(({ name }) => name)).toContain(
            'mcp__agent_fixture__probe',
          )
          yield {
            type: 'tool-call',
            call: {
              id: 'call_agent_mcp',
              name: 'mcp__agent_fixture__probe',
              input: {},
            },
          }
        } else if (child) {
          expect(JSON.stringify(request.messages)).toContain('AGENT_MCP_RESULT')
          yield { type: 'text-delta', delta: 'MCP_CHILD_DONE' }
        } else if (mainTurn++ === 0) {
          yield {
            type: 'tool-call',
            call: {
              id: 'call_mcp_agent',
              name: 'Agent',
              input: {
                description: 'Use MCP',
                prompt: 'Call the agent MCP tool',
                subagent_type: 'mcp-agent',
                run_in_background: false,
              },
            },
          }
        } else {
          yield { type: 'text-delta', delta: 'MCP_MAIN_DONE' }
        }
      },
    }
    const extensions = new ClaudeExtensionCatalog({
      commands: [],
      skills: [],
      agents: [
        {
          path: join(configRoot, 'agents', 'mcp-agent.md'),
          scope: 'user',
          content:
            '---\nname: mcp-agent\ndescription: Use a private MCP server.\ntools: [Read]\ndisallowedTools: [mcp__agent_fixture__probe]\nmcpServers:\n  - agent-fixture\n  - agent-inline:\n      command: fixture\n---\nMCP_AGENT_POLICY',
        },
      ],
    })
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider,
      tools: emptyTools,
      permissions: { resolve: () => ({ behavior: 'allow' }) },
      extensions,
      mcp,
      enableSubagents: true,
      sessionPersistence: false,
    })

    await expect(service.run('Delegate with MCP.')).resolves.toMatchObject({
      text: 'MCP_MAIN_DONE',
    })
    expect(connections).toEqual([
      ['agent-fixture', { 'agent-inline': { command: 'fixture' } }],
    ])
    expect(closed).toBe(1)
  })

  it('limits the built-in statusline setup agent to Read and Edit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-statusline-agent-test-'))
    roots.push(root)
    let mainTurn = 0
    let childTools: string[] = []
    const provider: ModelProvider = {
      capabilities: { streaming: true, usage: true, tools: true },
      async *complete(request) {
        if (JSON.stringify(request.messages).includes('statusLine command')) {
          childTools = request.tools?.map(({ name }) => name) ?? []
          yield { type: 'text-delta', delta: 'CHILD_DONE' }
        } else if (mainTurn++ === 0) {
          yield {
            type: 'tool-call',
            call: {
              id: 'call_statusline',
              name: 'Agent',
              input: {
                description: 'Configure status line',
                prompt: 'Configure statusLine',
                subagent_type: 'statusline-setup',
                run_in_background: false,
              },
            },
          }
        } else {
          yield { type: 'text-delta', delta: 'MAIN_DONE' }
        }
      },
    }
    const tools: ToolRegistry = {
      definitions: () =>
        ['Read', 'Edit', 'Bash'].map((name) => ({
          name,
          description: name,
          inputSchema: { type: 'object' },
        })),
      async prepare(call) {
        return call
      },
      async execute(call) {
        return { content: call.name, isError: false }
      },
    }
    const service = new ClaudeSessionService({
      configRoot: join(root, 'config'),
      cwd: join(root, 'project'),
      claudeVersion: '2.1.208',
      provider,
      tools,
      permissions: { resolve: () => ({ behavior: 'allow' }) },
      extensions: new ClaudeExtensionCatalog({
        commands: [],
        skills: [],
        agents: [],
      }),
      enableSubagents: true,
    })

    expect((await service.run('/statusline')).text).toBe('MAIN_DONE')
    expect(childTools).toEqual(['Read', 'Edit'])
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
    const sidechainFiles = await readdir(
      join(paths.projectRoot, result.sessionId, 'subagents'),
    )
    expect(sidechainFiles).toHaveLength(2)
    const agentId = sidechainFiles
      .find((file) => file.endsWith('.jsonl'))
      ?.slice('agent-'.length, -'.jsonl'.length)
    expect(agentId).toBeDefined()
    await expect(
      new SubagentLifecycleStore(
        paths.praxisRoot,
        result.sessionId,
        String(agentId),
      ).read(),
    ).resolves.toMatchObject({ status: 'completed' })
  })

  it('persists a failed background lifecycle before exposing terminal output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-failed-agent-state-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    let turn = 0
    const provider: ModelProvider = {
      model: 'fixture-model',
      capabilities: { streaming: true, usage: true, tools: true },
      async *complete() {
        if (turn++ === 0) {
          yield {
            type: 'tool-call',
            call: { id: 'call_before_failure', name: 'Probe', input: {} },
          }
          yield {
            type: 'usage',
            usage: { inputTokens: 7, outputTokens: 3 },
          }
          return
        }
        throw new Error('FAILED_AGENT_FIXTURE')
      },
    }
    const tools: ToolRegistry = {
      definitions: () => [
        { name: 'Probe', description: 'Probe.', inputSchema: {} },
      ],
      async prepare(call) {
        return call
      },
      async execute() {
        return { content: 'PROBE_COMPLETED', isError: false }
      },
    }
    const executor = new ClaudeSubagentExecutor({
      configRoot,
      dataPlane: 'claude',
      cwd,
      claudeVersion: '2.1.237',
      provider,
      baseTools: tools,
      permissions: { resolve: () => ({ behavior: 'allow' }) },
    })
    const registry = executor.registry(
      sessionId,
      0,
      () => 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    )
    await registry.execute(
      await registry.prepare(
        {
          id: 'call_failed_agent',
          name: 'Agent',
          input: {
            description: 'Failed fixture',
            prompt: 'FAIL_NOW',
            run_in_background: true,
          },
        },
        { cwd },
      ),
      { cwd },
    )
    const agentId = executor.backgroundSnapshots()[0]?.agentId
    expect(agentId).toBeDefined()
    const output = await registry.execute(
      await registry.prepare(
        {
          id: 'call_failed_output',
          name: 'TaskOutput',
          input: { task_id: agentId, block: true, timeout: 30_000 },
        },
        { cwd },
      ),
      { cwd },
    )
    expect(output.content).toContain('<status>failed</status>')
    const paths = resolveClaudePaths({ configDir: configRoot, cwd, sessionId })
    const lifecycleStore = new SubagentLifecycleStore(
      paths.praxisRoot,
      sessionId,
      String(agentId),
    )
    await expect(lifecycleStore.read()).resolves.toMatchObject({
      status: 'failed',
      detail: 'FAILED_AGENT_FIXTURE',
      result: {
        usage: { inputTokens: 7, outputTokens: 3 },
        modelUsage: {
          'fixture-model': { inputTokens: 7, outputTokens: 3 },
        },
        toolUseCount: 1,
      },
      notifications: [
        {
          status: 'failed',
          consumed: false,
          result: { usage: { inputTokens: 7, outputTokens: 3 } },
        },
      ],
    })
    const reopened = new ClaudeSubagentExecutor({
      configRoot,
      dataPlane: 'claude',
      cwd,
      claudeVersion: '2.1.237',
      provider,
      baseTools: tools,
      permissions: { resolve: () => ({ behavior: 'allow' }) },
    })
    await reopened.hydratePersistedTasks(sessionId, cwd)
    await expect(reopened.notifications(false)).resolves.toMatchObject({
      messages: [expect.stringContaining('<status>failed</status>')],
      usage: { inputTokens: 7, outputTokens: 3 },
      modelUsage: {
        'fixture-model': { inputTokens: 7, outputTokens: 3 },
      },
    })
    expect(turn).toBe(2)
  })

  it('hands a running foreground agent to background without repeating committed tool work', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-agent-handoff-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    let toolExecutions = 0
    let childTurn = 0
    let secondTurnStarted!: () => void
    const secondTurn = new Promise<void>((resolve) => {
      secondTurnStarted = resolve
    })
    let releaseSecondTurn!: () => void
    const release = new Promise<void>((resolve) => {
      releaseSecondTurn = resolve
    })
    const provider: ModelProvider = {
      model: 'fixture-model',
      capabilities: { streaming: true, usage: true, tools: true },
      async *complete() {
        if (childTurn++ === 0) {
          yield {
            type: 'tool-call',
            call: { id: 'call_once', name: 'Probe', input: {} },
          }
        } else {
          secondTurnStarted()
          await release
          yield { type: 'text-delta', delta: 'HANDOFF_DONE' }
          yield {
            type: 'usage',
            usage: { inputTokens: 3, outputTokens: 2 },
          }
        }
      },
    }
    const tools: ToolRegistry = {
      definitions: () => [
        { name: 'Probe', description: 'Probe once.', inputSchema: {} },
      ],
      async prepare(call) {
        return call
      },
      async execute() {
        toolExecutions += 1
        return { content: 'PROBE_DONE', isError: false }
      },
    }
    const executor = new ClaudeSubagentExecutor({
      configRoot,
      dataPlane: 'claude',
      cwd,
      claudeVersion: '2.1.237',
      provider,
      baseTools: tools,
      permissions: { resolve: () => ({ behavior: 'allow' }) },
    })
    const registry = executor.registry(
      sessionId,
      0,
      () => 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    )
    const parentController = new AbortController()
    const prepared = await registry.prepare(
      {
        id: 'call_foreground_handoff',
        name: 'Agent',
        input: {
          description: 'Handoff fixture',
          prompt: 'Use Probe then finish',
          run_in_background: false,
        },
      },
      { cwd, signal: parentController.signal },
    )
    const execution = registry.execute(prepared, {
      cwd,
      signal: parentController.signal,
    })
    await secondTurn

    const adopted = executor.backgroundForegroundTask()
    const launched = await execution
    expect(launched.nativeToolUseResult).toMatchObject({
      isAsync: true,
      status: 'async_launched',
      agentId: adopted.agentId,
    })
    expect(toolExecutions).toBe(1)
    parentController.abort()
    releaseSecondTurn()

    const output = await registry.execute(
      await registry.prepare(
        {
          id: 'call_handoff_output',
          name: 'TaskOutput',
          input: {
            task_id: adopted.agentId,
            block: true,
            timeout: 30_000,
          },
        },
        { cwd },
      ),
      { cwd },
    )
    expect(output.content).toContain('HANDOFF_DONE')
    expect(toolExecutions).toBe(1)
    const firstNotification = await executor.notifications(false)
    expect(firstNotification.messages).toEqual([
      expect.stringContaining('<status>completed</status>'),
    ])
    expect(firstNotification.usage).toEqual({
      inputTokens: 3,
      outputTokens: 2,
    })
    await expect(executor.notifications(false)).resolves.toEqual({
      messages: [],
      usage: { inputTokens: 0, outputTokens: 0 },
    })

    const sidechainPath = String(launched.nativeToolUseResult?.outputFile)
    const sidechain = await readFile(sidechainPath, 'utf8')
    expect(sidechain.match(/"id":"call_once"/gu) ?? []).toHaveLength(1)
    expect(sidechain.match(/"tool_use_id":"call_once"/gu) ?? []).toHaveLength(1)
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
      dataPlane: 'claude',
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
      dataPlane: 'claude',
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

  it('aborts and drains multiple live agents on close without terminal notifications or transcript deletion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-agent-close-drain-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    let startedCount = 0
    let bothStarted!: () => void
    const started = new Promise<void>((resolve) => {
      bothStarted = resolve
    })
    const events: RuntimeEvent[] = []
    const executor = new ClaudeSubagentExecutor({
      configRoot,
      dataPlane: 'claude',
      cwd,
      claudeVersion: '2.1.237',
      provider: {
        capabilities: { streaming: true, usage: true, tools: false },
        async *complete(request) {
          startedCount += 1
          if (startedCount === 2) bothStarted()
          await new Promise<void>((_resolve, reject) => {
            request.signal?.addEventListener(
              'abort',
              () => reject(request.signal?.reason ?? new Error('aborted')),
              { once: true },
            )
          })
          yield { type: 'text-delta', delta: 'UNREACHABLE_AFTER_ABORT' }
        },
      },
      baseTools: emptyTools,
      permissions: { resolve: () => ({ behavior: 'allow' }) },
      eventSink: (event) => events.push(event),
    })
    const registry = executor.registry(
      sessionId,
      0,
      () => 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    )
    for (const index of [1, 2]) {
      await registry.execute(
        await registry.prepare(
          {
            id: `call_close_${index}`,
            name: 'Agent',
            input: {
              description: `Close fixture ${index}`,
              prompt: `WAIT_${index}`,
              run_in_background: true,
            },
          },
          { cwd },
        ),
        { cwd },
      )
    }
    await started

    await executor.close()

    expect(executor.backgroundSnapshots()).toEqual([])
    expect(
      events.filter((event) => event.type === 'task-notification'),
    ).toEqual([])
    const paths = resolveClaudePaths({ configDir: configRoot, cwd, sessionId })
    const retained = await readdir(
      join(paths.projectRoot, sessionId, 'subagents'),
    )
    expect(retained.filter((file) => file.endsWith('.jsonl'))).toHaveLength(2)
    expect(retained.filter((file) => file.endsWith('.meta.json'))).toHaveLength(
      2,
    )
  })

  it('explicitly bulk-kills live agents with retained state and one notification each', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-agent-bulk-kill-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    let startedCount = 0
    let bothStarted!: () => void
    const started = new Promise<void>((resolve) => {
      bothStarted = resolve
    })
    const executor = new ClaudeSubagentExecutor({
      configRoot,
      dataPlane: 'claude',
      cwd,
      claudeVersion: '2.1.237',
      provider: {
        capabilities: { streaming: true, usage: true, tools: false },
        async *complete(request) {
          startedCount += 1
          if (startedCount === 2) bothStarted()
          await new Promise<void>((_resolve, reject) => {
            request.signal?.addEventListener(
              'abort',
              () => reject(request.signal?.reason ?? new Error('aborted')),
              { once: true },
            )
          })
          yield { type: 'text-delta', delta: 'UNREACHABLE_AFTER_ABORT' }
        },
      },
      baseTools: emptyTools,
      permissions: { resolve: () => ({ behavior: 'allow' }) },
    })
    const registry = executor.registry(
      sessionId,
      0,
      () => 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    )
    for (const index of [1, 2]) {
      await registry.execute(
        await registry.prepare(
          {
            id: `call_bulk_${index}`,
            name: 'Agent',
            input: {
              description: `Bulk fixture ${index}`,
              prompt: `WAIT_${index}`,
              run_in_background: true,
            },
          },
          { cwd },
        ),
        { cwd },
      )
    }
    await started
    const agentIds = executor
      .backgroundSnapshots()
      .map((snapshot) => snapshot.agentId)

    expect([...executor.stopAllBackgroundTasks()].sort()).toEqual(
      [...agentIds].sort(),
    )
    expect(executor.stopAllBackgroundTasks()).toEqual([])
    await Promise.all(
      agentIds.map(async (agentId, index) =>
        registry.execute(
          await registry.prepare(
            {
              id: `call_bulk_output_${index}`,
              name: 'TaskOutput',
              input: { task_id: agentId, block: true, timeout: 30_000 },
            },
            { cwd },
          ),
          { cwd },
        ),
      ),
    )
    const first = await executor.notifications(false)
    expect(first.messages).toHaveLength(2)
    expect(
      first.messages.every((message) =>
        message.includes('<status>killed</status>'),
      ),
    ).toBe(true)
    await expect(executor.notifications(false)).resolves.toEqual({
      messages: [],
      usage: { inputTokens: 0, outputTokens: 0 },
    })
    const paths = resolveClaudePaths({ configDir: configRoot, cwd, sessionId })
    for (const agentId of agentIds) {
      await expect(
        new SubagentLifecycleStore(paths.praxisRoot, sessionId, agentId).read(),
      ).resolves.toMatchObject({ status: 'killed' })
    }
  })

  it('polls and resumes a completed background sidechain from a new executor', async () => {
    const { configRoot, cwd } = await gitRepository(
      'praxis-background-resume-test-',
    )
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
      dataPlane: 'claude' as const,
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
            name: 'reviewer',
            isolation: 'worktree',
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
    const worktreePath = String(launched.nativeToolUseResult?.worktreePath)
    expect(firstOutput.content).toContain(
      `<worktree_path>${worktreePath}</worktree_path>`,
    )
    expect(firstOutput.content).toContain(
      '<worktree_retained>false</worktree_retained>',
    )
    await expect(stat(worktreePath)).rejects.toMatchObject({ code: 'ENOENT' })

    const recoveryEvents: RuntimeEvent[] = []
    const resumed = new ClaudeSubagentExecutor({
      ...options,
      provider: provider('SECOND_RESULT'),
      eventSink: (event) => recoveryEvents.push(event),
    })
    const resumedRegistry = resumed.registry(sessionId, 0, () => promptId)
    const sent = await resumedRegistry.execute(
      await resumedRegistry.prepare(
        {
          id: 'call_message',
          name: 'SendMessage',
          input: {
            to: 'reviewer',
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
    await expect(stat(worktreePath)).rejects.toMatchObject({ code: 'ENOENT' })
    const recoveredNotifications = await resumed.notifications(false)
    expect(recoveredNotifications.messages).toHaveLength(2)
    expect(recoveredNotifications.messages).toEqual([
      expect.stringContaining('<tool-use-id>call_launch</tool-use-id>'),
      expect.stringContaining('<tool-use-id>call_message</tool-use-id>'),
    ])
    expect(recoveredNotifications.usage).toEqual({
      inputTokens: 4,
      outputTokens: 2,
    })

    const reopened = new ClaudeSubagentExecutor({
      ...options,
      provider: provider('UNUSED_RESULT'),
    })
    const reopenedRegistry = reopened.registry(sessionId, 0, () => promptId)
    await reopenedRegistry.execute(
      await reopenedRegistry.prepare(
        {
          id: 'call_reopened_output',
          name: 'TaskOutput',
          input: { task_id: agentId, block: false, timeout: 0 },
        },
        { cwd },
      ),
      { cwd },
    )
    await expect(reopened.notifications(false)).resolves.toEqual({
      messages: [],
      usage: { inputTokens: 0, outputTokens: 0 },
    })

    const paths = resolveClaudePaths({ configDir: configRoot, cwd, sessionId })
    const lifecycleStore = new SubagentLifecycleStore(
      paths.praxisRoot,
      sessionId,
      agentId,
      join(paths.projectRoot, sessionId, 'subagents', `agent-${agentId}.jsonl`),
    )
    const deliveredId = '99999999-9999-4999-8999-999999999999'
    await lifecycleStore.write('completed', undefined, {
      result: {
        text: 'SECOND_RESULT',
        usage: { inputTokens: 2, outputTokens: 1 },
        toolUseCount: 0,
        durationMs: 1,
      },
      notification: {
        id: deliveredId,
        status: 'completed',
        toolUseId: 'call_already_appended',
        error: null,
      },
    })
    await lifecycleStore.prepareNotificationDetached(
      deliveredId,
      'fixture-model',
    )
    const reconciled = new ClaudeSubagentExecutor({
      ...options,
      provider: provider('UNUSED_RECONCILED_RESULT'),
      notificationDelivered: ({ toolUseId }) =>
        toolUseId === 'call_already_appended',
    })
    await reconciled.hydratePersistedTasks(sessionId, cwd)
    await expect(reconciled.notifications(false)).resolves.toEqual({
      messages: [],
      usage: { inputTokens: 0, outputTokens: 0 },
    })
    const reconciledLifecycle = await lifecycleStore.read()
    expect(
      reconciledLifecycle?.notifications?.find(
        (notification) => notification.id === deliveredId,
      ),
    ).toMatchObject({
      id: deliveredId,
      consumed: true,
      accounting: {
        kind: 'detached',
        model: 'fixture-model',
        delivered: true,
      },
    })

    const pendingId = '88888888-8888-4888-8888-888888888888'
    await lifecycleStore.write('completed', undefined, {
      result: {
        text: 'SECOND_RESULT',
        usage: { inputTokens: 2, outputTokens: 1 },
        toolUseCount: 0,
        durationMs: 1,
      },
      notification: {
        id: pendingId,
        status: 'completed',
        toolUseId: 'call_pending_after_restart',
        error: null,
      },
    })
    const automaticallyRecovered = new ClaudeSubagentExecutor({
      ...options,
      provider: provider('UNUSED_AUTOMATIC_RESULT'),
    })
    await automaticallyRecovered.hydratePersistedTasks(sessionId, cwd)
    await expect(automaticallyRecovered.notifications(false)).resolves.toEqual({
      messages: [
        expect.stringContaining(
          '<tool-use-id>call_pending_after_restart</tool-use-id>',
        ),
      ],
      usage: { inputTokens: 2, outputTokens: 1 },
    })
    const afterAutomaticDelivery = new ClaudeSubagentExecutor({
      ...options,
      provider: provider('UNUSED_AFTER_AUTOMATIC_RESULT'),
    })
    await afterAutomaticDelivery.hydratePersistedTasks(sessionId, cwd)
    await expect(afterAutomaticDelivery.notifications(false)).resolves.toEqual({
      messages: [],
      usage: { inputTokens: 0, outputTokens: 0 },
    })

    const source = await readFile(
      join(paths.projectRoot, sessionId, 'subagents', `agent-${agentId}.jsonl`),
      'utf8',
    )
    expect(source).toContain('The coordinator sent a message')
    expect(source).toContain('SECOND_RESULT')
    expect(
      entries(source)
        .map((entry) => entry.cwd)
        .filter((value) => typeof value === 'string'),
    ).toEqual(expect.arrayContaining([worktreePath, cwd]))
    expect(recoveryEvents).toContainEqual({
      type: 'warning',
      message: expect.stringContaining('falling back to parent cwd'),
    })
    expect(
      JSON.parse(
        await readFile(
          join(
            paths.projectRoot,
            sessionId,
            'subagents',
            `agent-${agentId}.meta.json`,
          ),
          'utf8',
        ),
      ),
    ).toMatchObject({
      name: 'reviewer',
      isolation: 'worktree',
      worktreePath,
    })
  })

  it('snapshots explicit spawn cwd and restores it for a fresh-process continuation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-agent-cwd-snapshot-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const configuredCwd = join(root, 'configured')
    const spawnCwd = join(root, 'spawn-snapshot')
    const changedCwd = join(root, 'changed-parent')
    await Promise.all(
      [configuredCwd, spawnCwd, changedCwd].map((directory) =>
        mkdir(directory, { recursive: true }),
      ),
    )
    const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const promptId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    let liveCwd = configuredCwd
    const observedCwds: string[] = []
    const provider = (text: string): ModelProvider => ({
      capabilities: { streaming: true, usage: true, tools: true },
      async *complete() {
        yield { type: 'text-delta', delta: text }
        yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1 } }
      },
    })
    const options = {
      configRoot,
      dataPlane: 'claude' as const,
      cwd: configuredCwd,
      cwdProvider: () => liveCwd,
      claudeVersion: '2.1.237',
      baseTools: emptyTools,
      permissions: { resolve: () => ({ behavior: 'allow' as const }) },
      contextAssembler: {
        async assemble(context?: { cwd?: string }) {
          observedCwds.push(context?.cwd ?? '')
          return { systemMessages: [] }
        },
      },
    }
    const first = new ClaudeSubagentExecutor({
      ...options,
      provider: provider('FIRST_CWD_RESULT'),
    })
    const firstRegistry = first.registry(sessionId, 0, () => promptId)
    const launched = await firstRegistry.execute(
      await firstRegistry.prepare(
        {
          id: 'call_cwd_launch',
          name: 'Agent',
          input: {
            description: 'Cwd snapshot',
            prompt: 'Observe cwd',
            name: 'cwd-reviewer',
            run_in_background: true,
          },
        },
        { cwd: spawnCwd },
      ),
      { cwd: spawnCwd },
    )
    liveCwd = changedCwd
    const agentId = String(launched.nativeToolUseResult?.agentId)
    await firstRegistry.execute(
      await firstRegistry.prepare(
        {
          id: 'call_cwd_output',
          name: 'TaskOutput',
          input: { task_id: agentId, block: true, timeout: 30_000 },
        },
        { cwd: spawnCwd },
      ),
      { cwd: spawnCwd },
    )
    expect(observedCwds).toEqual([spawnCwd])
    const paths = resolveClaudePaths({
      configDir: configRoot,
      cwd: spawnCwd,
      sessionId,
    })
    const sidechainPath = join(
      paths.projectRoot,
      sessionId,
      'subagents',
      `agent-${agentId}.jsonl`,
    )
    expect(entries(await readFile(sidechainPath, 'utf8'))[0]?.cwd).toBe(
      spawnCwd,
    )

    const resumed = new ClaudeSubagentExecutor({
      ...options,
      provider: provider('SECOND_CWD_RESULT'),
    })
    const resumedRegistry = resumed.registry(sessionId, 0, () => promptId)
    await resumedRegistry.execute(
      await resumedRegistry.prepare(
        {
          id: 'call_cwd_message',
          name: 'SendMessage',
          input: {
            to: 'cwd-reviewer',
            summary: 'continue in snapshot',
            message: 'Continue from persisted cwd',
          },
        },
        { cwd: spawnCwd },
      ),
      { cwd: spawnCwd },
    )
    await resumedRegistry.execute(
      await resumedRegistry.prepare(
        {
          id: 'call_cwd_done',
          name: 'TaskOutput',
          input: { task_id: agentId, block: true, timeout: 30_000 },
        },
        { cwd: spawnCwd },
      ),
      { cwd: spawnCwd },
    )
    expect(observedCwds).toEqual([spawnCwd, spawnCwd])
    expect(liveCwd).toBe(changedCwd)
  })

  it('hydrates an incomplete sidechain without replay and resumes it through one filtered continuation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-interrupted-agent-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const agentId = 'areviewer-0123456789abcdef'
    const promptId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const paths = resolveClaudePaths({ configDir: configRoot, cwd, sessionId })
    const directory = join(paths.projectRoot, sessionId, 'subagents')
    await mkdir(directory, { recursive: true })
    const common = {
      isSidechain: true,
      agentId,
      promptId,
      timestamp: '2026-08-23T00:00:00.000Z',
      userType: 'external',
      entrypoint: 'cli',
      cwd,
      sessionId,
      version: '2.1.237',
      gitBranch: null,
    }
    const rootUuid = '11111111-1111-4111-8111-111111111111'
    const toolAssistantUuid = '22222222-2222-4222-8222-222222222222'
    const toolResultUuid = '33333333-3333-4333-8333-333333333333'
    const interruptedUuid = '44444444-4444-4444-8444-444444444444'
    await writeFile(
      join(directory, `agent-${agentId}.jsonl`),
      [
        {
          ...common,
          type: 'user',
          parentUuid: null,
          uuid: rootUuid,
          message: { role: 'user', content: 'INTERRUPTED_ROOT' },
        },
        {
          ...common,
          type: 'assistant',
          parentUuid: rootUuid,
          uuid: toolAssistantUuid,
          attributionAgent: 'general-purpose',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'call_complete',
                name: 'Read',
                input: { file_path: '/tmp/a' },
              },
              {
                type: 'tool_use',
                id: 'call_dangling',
                name: 'Read',
                input: { file_path: '/tmp/b' },
              },
            ],
          },
        },
        {
          ...common,
          type: 'user',
          parentUuid: toolAssistantUuid,
          uuid: toolResultUuid,
          sourceToolAssistantUUID: toolAssistantUuid,
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'call_complete',
                content: 'ORIGINAL_RESULT',
              },
            ],
          },
        },
        {
          ...common,
          type: 'assistant',
          parentUuid: toolResultUuid,
          uuid: interruptedUuid,
          attributionAgent: 'general-purpose',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'thinking',
                thinking: 'ORPHAN_THINKING',
                signature: 'sig',
              },
              { type: 'text', text: '   ' },
            ],
          },
        },
        {
          type: 'content-replacement',
          sessionId,
          replacements: [
            {
              kind: 'tool-result',
              toolUseId: 'call_complete',
              replacement: 'RECONSTRUCTED_RESULT',
            },
          ],
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n') + '\n',
    )
    await writeFile(
      join(directory, `agent-${agentId}.meta.json`),
      `${JSON.stringify({
        agentType: 'general-purpose',
        description: 'Interrupted fixture',
        toolUseId: 'call_origin',
        spawnDepth: 1,
        name: 'interrupted-reviewer',
        compatibleUnknown: 'preserved',
      })}\n`,
    )
    const requests: ModelRequest[] = []
    const executor = new ClaudeSubagentExecutor({
      configRoot,
      dataPlane: 'claude',
      cwd,
      claudeVersion: '2.1.237',
      provider: {
        model: 'fixture-model',
        capabilities: { streaming: true, usage: true, tools: true },
        async *complete(request) {
          requests.push(request)
          yield { type: 'text-delta', delta: 'RESUMED_RESULT' }
          yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1 } }
        },
      },
      baseTools: emptyTools,
      permissions: { resolve: () => ({ behavior: 'allow' }) },
    })
    const registry = executor.registry(sessionId, 0, () => promptId)

    const interrupted = await registry.execute(
      await registry.prepare(
        {
          id: 'call_interrupted_output',
          name: 'TaskOutput',
          input: { task_id: agentId, block: false, timeout: 0 },
        },
        { cwd },
      ),
      { cwd },
    )
    expect(interrupted.content).toContain('<status>interrupted</status>')
    expect(requests).toHaveLength(0)

    const sent = await registry.execute(
      await registry.prepare(
        {
          id: 'call_interrupted_message',
          name: 'SendMessage',
          input: {
            to: 'interrupted-reviewer',
            summary: 'resume interrupted fixture',
            message: 'CONTINUE_ONCE',
          },
        },
        { cwd },
      ),
      { cwd },
    )
    expect(sent.content).toContain('"success":true')
    const output = await registry.execute(
      await registry.prepare(
        {
          id: 'call_interrupted_done',
          name: 'TaskOutput',
          input: { task_id: agentId, block: true, timeout: 30_000 },
        },
        { cwd },
      ),
      { cwd },
    )
    expect(output.content).toContain('RESUMED_RESULT')
    expect(requests).toHaveLength(1)
    const resumedContext = JSON.stringify(requests[0]?.messages)
    expect(resumedContext).toContain('RECONSTRUCTED_RESULT')
    expect(resumedContext).toContain('CONTINUE_ONCE')
    expect(resumedContext).not.toContain('ORIGINAL_RESULT')
    expect(resumedContext).not.toContain('call_dangling')
    expect(resumedContext).not.toContain('ORPHAN_THINKING')
    expect(resumedContext.match(/CONTINUE_ONCE/gu) ?? []).toHaveLength(1)
  })

  it.each([
    ['failed', 'failed'],
    ['killed', 'stopped'],
  ] as const)(
    'hydrates and explicitly resumes a persisted %s sidechain from a fresh executor',
    async (persistedStatus, outputStatus) => {
      const root = await mkdtemp(join(tmpdir(), 'praxis-terminal-agent-'))
      roots.push(root)
      const configRoot = join(root, 'config')
      const cwd = join(root, 'project')
      const sessionId =
        persistedStatus === 'failed'
          ? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
          : 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
      const agentId =
        persistedStatus === 'failed'
          ? 'afailed-0123456789abcdef'
          : 'akilled-0123456789abcdef'
      const promptId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
      const paths = resolveClaudePaths({
        configDir: configRoot,
        cwd,
        sessionId,
      })
      const directory = join(paths.projectRoot, sessionId, 'subagents')
      await mkdir(directory, { recursive: true })
      await writeFile(
        join(directory, `agent-${agentId}.jsonl`),
        `${JSON.stringify({
          parentUuid: null,
          isSidechain: true,
          agentId,
          promptId,
          type: 'user',
          message: { role: 'user', content: 'TERMINAL_ROOT' },
          uuid: '11111111-1111-4111-8111-111111111111',
          timestamp: '2026-08-23T00:00:00.000Z',
          userType: 'external',
          entrypoint: 'cli',
          cwd,
          sessionId,
          version: '2.1.237',
          gitBranch: null,
        })}\n`,
      )
      await writeFile(
        join(directory, `agent-${agentId}.meta.json`),
        `${JSON.stringify({
          agentType: 'general-purpose',
          description: `${persistedStatus} fixture`,
          toolUseId: `call_${persistedStatus}_origin`,
          spawnDepth: 1,
          name: `${persistedStatus}-reviewer`,
        })}\n`,
      )
      await new SubagentLifecycleStore(
        paths.praxisRoot,
        sessionId,
        agentId,
      ).write(persistedStatus, `${persistedStatus} before restart`)
      let requests = 0
      const executor = new ClaudeSubagentExecutor({
        configRoot,
        dataPlane: 'claude',
        cwd,
        claudeVersion: '2.1.237',
        provider: {
          model: 'fixture-model',
          capabilities: { streaming: true, usage: true, tools: true },
          async *complete() {
            requests += 1
            yield { type: 'text-delta', delta: 'TERMINAL_RESUMED' }
            yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1 } }
          },
        },
        baseTools: emptyTools,
        permissions: { resolve: () => ({ behavior: 'allow' }) },
      })
      const registry = executor.registry(sessionId, 0, () => promptId)

      const before = await registry.execute(
        await registry.prepare(
          {
            id: `call_${persistedStatus}_output`,
            name: 'TaskOutput',
            input: { task_id: agentId, block: false, timeout: 0 },
          },
          { cwd },
        ),
        { cwd },
      )
      expect(before.content).toContain(`<status>${outputStatus}</status>`)
      expect(requests).toBe(0)

      await registry.execute(
        await registry.prepare(
          {
            id: `call_${persistedStatus}_message`,
            name: 'SendMessage',
            input: {
              to: `${persistedStatus}-reviewer`,
              summary: `resume ${persistedStatus}`,
              message: 'EXPLICIT_TERMINAL_CONTINUATION',
            },
          },
          { cwd },
        ),
        { cwd },
      )
      const after = await registry.execute(
        await registry.prepare(
          {
            id: `call_${persistedStatus}_done`,
            name: 'TaskOutput',
            input: { task_id: agentId, block: true, timeout: 30_000 },
          },
          { cwd },
        ),
        { cwd },
      )
      expect(after.content).toContain('TERMINAL_RESUMED')
      expect(requests).toBe(1)
      await expect(
        new SubagentLifecycleStore(paths.praxisRoot, sessionId, agentId).read(),
      ).resolves.toMatchObject({ status: 'completed' })
    },
  )

  it('contains corrupt persisted lifecycle recovery without mutating the parent or sidechain transcript', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-corrupt-agent-state-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3'
    const agentId = 'acorrupt-0123456789abcdef'
    const promptId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const paths = resolveClaudePaths({ configDir: configRoot, cwd, sessionId })
    const directory = join(paths.projectRoot, sessionId, 'subagents')
    await mkdir(directory, { recursive: true })
    const sidechainPath = join(directory, `agent-${agentId}.jsonl`)
    const sidechainSource = `${JSON.stringify({
      parentUuid: null,
      isSidechain: true,
      agentId,
      promptId,
      type: 'user',
      message: { role: 'user', content: 'CORRUPT_STATE_ROOT' },
      uuid: '11111111-1111-4111-8111-111111111111',
      timestamp: '2026-08-23T00:00:00.000Z',
      userType: 'external',
      entrypoint: 'cli',
      cwd,
      sessionId,
      version: '2.1.237',
      gitBranch: null,
    })}\n`
    await writeFile(sidechainPath, sidechainSource)
    await writeFile(
      join(directory, `agent-${agentId}.meta.json`),
      JSON.stringify({
        agentType: 'general-purpose',
        description: 'Corrupt lifecycle fixture',
        toolUseId: 'call_corrupt_origin',
        spawnDepth: 1,
      }),
    )
    const parentSource = '{"type":"parent-sentinel"}\n'
    await mkdir(paths.projectRoot, { recursive: true })
    await writeFile(paths.sessionFile, parentSource)
    const lifecyclePath = join(
      paths.praxisRoot,
      'subagent-lifecycle',
      sessionId,
      `${agentId}.json`,
    )
    await mkdir(join(paths.praxisRoot, 'subagent-lifecycle', sessionId), {
      recursive: true,
    })
    await writeFile(lifecyclePath, '{bad')
    const recoveryEvents: RuntimeEvent[] = []
    const executor = new ClaudeSubagentExecutor({
      configRoot,
      dataPlane: 'claude',
      cwd,
      claudeVersion: '2.1.237',
      provider: {
        capabilities: { streaming: true, usage: true, tools: true },
        async *complete() {
          await Promise.reject(new Error('provider must not run'))
          yield { type: 'text-delta', delta: 'UNREACHABLE_PROVIDER_RESULT' }
        },
      },
      baseTools: emptyTools,
      permissions: { resolve: () => ({ behavior: 'allow' }) },
      eventSink: (event) => recoveryEvents.push(event),
    })
    const registry = executor.registry(sessionId, 0, () => promptId)

    await expect(
      registry.execute(
        await registry.prepare(
          {
            id: 'call_corrupt_output',
            name: 'TaskOutput',
            input: { task_id: agentId, block: false, timeout: 0 },
          },
          { cwd },
        ),
        { cwd },
      ),
    ).rejects.toThrow('Corrupt subagent lifecycle state')
    await expect(
      executor.hydratePersistedTasks(sessionId, cwd),
    ).resolves.toBeUndefined()
    expect(recoveryEvents).toContainEqual({
      type: 'warning',
      message: expect.stringContaining(
        `Background agent ${agentId} could not be recovered automatically`,
      ),
    })
    await expect(readFile(paths.sessionFile, 'utf8')).resolves.toBe(
      parentSource,
    )
    await expect(readFile(sidechainPath, 'utf8')).resolves.toBe(sidechainSource)
  })

  it('finds and resumes nested workflow sidechains by agent ID and name', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-nested-sidechain-test-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const promptId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const agentId = 'a1234567890abcdef'
    const runId = 'wf_fixture_run'
    const name = 'nested-fixture'
    const paths = resolveClaudePaths({ configDir: configRoot, cwd, sessionId })
    const nestedDirectory = join(
      paths.projectRoot,
      sessionId,
      'subagents',
      'workflows',
      runId,
    )
    await mkdir(nestedDirectory, { recursive: true })
    const rootEntry = {
      parentUuid: null,
      isSidechain: true,
      agentId,
      promptId,
      type: 'user',
      message: { role: 'user', content: 'NESTED_FIXTURE_PROMPT' },
      uuid: '11111111-1111-4111-8111-111111111111',
      timestamp: '2026-08-20T00:00:00.000Z',
      userType: 'external',
      entrypoint: 'cli',
      cwd,
      sessionId,
      version: '2.1.208',
      gitBranch: null,
    }
    const assistantEntry = {
      parentUuid: rootEntry.uuid,
      isSidechain: true,
      agentId,
      attributionAgent: 'general-purpose',
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'NESTED_FIXTURE_DONE' }],
      },
      uuid: '22222222-2222-4222-8222-222222222222',
      timestamp: '2026-08-20T00:00:01.000Z',
      userType: 'external',
      entrypoint: 'cli',
      cwd,
      sessionId,
      version: '2.1.208',
      gitBranch: null,
    }
    await writeFile(
      join(nestedDirectory, `agent-${agentId}.jsonl`),
      [JSON.stringify(rootEntry), JSON.stringify(assistantEntry)].join('\n') +
        '\n',
    )
    await writeFile(
      join(nestedDirectory, `agent-${agentId}.meta.json`),
      JSON.stringify({
        agentType: 'general-purpose',
        description: 'Nested workflow fixture',
        toolUseId: 'call_nested_fixture',
        spawnDepth: 1,
        name,
      }),
    )
    const provider = (text: string): ModelProvider => ({
      model: 'fixture-model',
      capabilities: { streaming: true, usage: true, tools: true },
      async *complete() {
        yield { type: 'text-delta', delta: text }
        yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1 } }
      },
    })
    const options = {
      configRoot,
      dataPlane: 'claude' as const,
      cwd,
      claudeVersion: '2.1.208',
      baseTools: emptyTools,
      permissions: { resolve: () => ({ behavior: 'allow' as const }) },
    }

    const byId = new ClaudeSubagentExecutor({
      ...options,
      provider: provider('NESTED_ID_DONE'),
    })
    const byIdRegistry = byId.registry(sessionId, 0, () => promptId)
    const idOutput = await byIdRegistry.execute(
      await byIdRegistry.prepare(
        {
          id: 'call_nested_output_id',
          name: 'TaskOutput',
          input: { task_id: agentId, block: true, timeout: 30_000 },
        },
        { cwd },
      ),
      { cwd },
    )
    expect(idOutput.content).toContain('NESTED_FIXTURE_DONE')

    const resumed = new ClaudeSubagentExecutor({
      ...options,
      provider: provider('NESTED_RESUME_DONE'),
    })
    const resumedRegistry = resumed.registry(sessionId, 0, () => promptId)
    const sent = await resumedRegistry.execute(
      await resumedRegistry.prepare(
        {
          id: 'call_nested_message',
          name: 'SendMessage',
          input: {
            to: name,
            summary: 'resume nested fixture',
            message: 'Continue nested work',
          },
        },
        { cwd },
      ),
      { cwd },
    )
    expect(sent.content).toContain('"success":true')
    const nameOutput = await resumedRegistry.execute(
      await resumedRegistry.prepare(
        {
          id: 'call_nested_output_name',
          name: 'TaskOutput',
          input: { task_id: name, block: true, timeout: 30_000 },
        },
        { cwd },
      ),
      { cwd },
    )
    expect(nameOutput.content).toContain('NESTED_RESUME_DONE')

    const source = await readFile(
      join(nestedDirectory, `agent-${agentId}.jsonl`),
      'utf8',
    )
    expect(source).toContain('The coordinator sent a message')
    expect(source).toContain('NESTED_RESUME_DONE')
    const rootSidechainDirectory = join(
      paths.projectRoot,
      sessionId,
      'subagents',
    )
    const nestedMetadata = await readFile(
      join(nestedDirectory, `agent-${agentId}.meta.json`),
      'utf8',
    )
    await Promise.all([
      writeFile(join(rootSidechainDirectory, `agent-${agentId}.jsonl`), source),
      writeFile(
        join(rootSidechainDirectory, `agent-${agentId}.meta.json`),
        nestedMetadata,
      ),
    ])
    const ambiguousById = new ClaudeSubagentExecutor({
      ...options,
      provider: provider('AMBIGUOUS_ID_MUST_NOT_RUN'),
    })
    const ambiguousIdRegistry = ambiguousById.registry(
      sessionId,
      0,
      () => promptId,
    )
    await expect(
      ambiguousIdRegistry.execute(
        await ambiguousIdRegistry.prepare(
          {
            id: 'call_ambiguous_id',
            name: 'TaskOutput',
            input: { task_id: agentId, block: false, timeout: 0 },
          },
          { cwd },
        ),
        { cwd },
      ),
    ).rejects.toThrow(`Ambiguous persisted background agent ${agentId}`)

    const ambiguousByName = new ClaudeSubagentExecutor({
      ...options,
      provider: provider('AMBIGUOUS_NAME_MUST_NOT_RUN'),
    })
    const ambiguousNameRegistry = ambiguousByName.registry(
      sessionId,
      0,
      () => promptId,
    )
    await expect(
      ambiguousNameRegistry.execute(
        await ambiguousNameRegistry.prepare(
          {
            id: 'call_ambiguous_name',
            name: 'SendMessage',
            input: { to: name, message: 'MUST_NOT_APPEND' },
          },
          { cwd },
        ),
        { cwd },
      ),
    ).rejects.toThrow(`Ambiguous persisted background agent ${name}`)
    const automaticWarnings: RuntimeEvent[] = []
    const automatic = new ClaudeSubagentExecutor({
      ...options,
      provider: provider('AMBIGUOUS_AUTOMATIC_MUST_NOT_RUN'),
      eventSink: (event) => automaticWarnings.push(event),
    })
    await expect(
      automatic.hydratePersistedTasks(sessionId, cwd),
    ).resolves.toBeUndefined()
    expect(automaticWarnings).toContainEqual({
      type: 'warning',
      message: expect.stringContaining(
        `Ambiguous persisted background agent ${agentId}`,
      ),
    })
    await expect(automatic.notifications(false)).resolves.toEqual({
      messages: [],
      usage: { inputTokens: 0, outputTokens: 0 },
    })
    await expect(
      readFile(join(nestedDirectory, `agent-${agentId}.jsonl`), 'utf8'),
    ).resolves.toBe(source)
    await expect(
      readFile(join(rootSidechainDirectory, `agent-${agentId}.jsonl`), 'utf8'),
    ).resolves.toBe(source)
  })

  it('recovers a metadata-free nested sidechain transcript by exact agent ID', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-legacy-nested-test-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const promptId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const agentId = 'a1234567890abcdef'
    const paths = resolveClaudePaths({ configDir: configRoot, cwd, sessionId })
    const nestedDirectory = join(
      paths.projectRoot,
      sessionId,
      'subagents',
      'legacy',
    )
    await mkdir(nestedDirectory, { recursive: true })
    const rootEntry = {
      parentUuid: null,
      isSidechain: true,
      agentId,
      promptId,
      type: 'user',
      message: { role: 'user', content: 'LEGACY_FIXTURE_PROMPT' },
      uuid: '11111111-1111-4111-8111-111111111111',
      timestamp: '2026-08-20T00:00:00.000Z',
      userType: 'external',
      entrypoint: 'cli',
      cwd,
      sessionId,
      version: '2.1.208',
      gitBranch: null,
    }
    const assistantEntry = {
      parentUuid: rootEntry.uuid,
      isSidechain: true,
      agentId,
      attributionAgent: 'general-purpose',
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'LEGACY_FIXTURE_DONE' }],
      },
      uuid: '22222222-2222-4222-8222-222222222222',
      timestamp: '2026-08-20T00:00:01.000Z',
      userType: 'external',
      entrypoint: 'cli',
      cwd,
      sessionId,
      version: '2.1.208',
      gitBranch: null,
    }
    await writeFile(
      join(nestedDirectory, `agent-${agentId}.jsonl`),
      [JSON.stringify(rootEntry), JSON.stringify(assistantEntry)].join('\n') +
        '\n',
    )
    const executor = new ClaudeSubagentExecutor({
      configRoot,
      dataPlane: 'claude',
      cwd,
      claudeVersion: '2.1.208',
      provider: {
        model: 'fixture-model',
        capabilities: { streaming: true, usage: true, tools: true },
        async *complete() {
          yield* []
          throw new Error('A recovered sidechain must not call the provider')
        },
      },
      baseTools: emptyTools,
      permissions: { resolve: () => ({ behavior: 'allow' }) },
    })
    const registry = executor.registry(sessionId, 0, () => promptId)

    const output = await registry.execute(
      await registry.prepare(
        {
          id: 'call_legacy_output',
          name: 'TaskOutput',
          input: { task_id: agentId, block: true, timeout: 30_000 },
        },
        { cwd },
      ),
      { cwd },
    )

    expect(output.content).toContain('LEGACY_FIXTURE_DONE')
    const snapshot = executor
      .backgroundSnapshots()
      .find((task) => task.agentId === agentId)
    expect(snapshot).toMatchObject({
      agentId,
      status: 'completed',
      description: 'Recovered Claude sidechain',
      name: null,
      result: {
        text: 'LEGACY_FIXTURE_DONE',
        usage: { inputTokens: 0, outputTokens: 0 },
      },
    })
    expect(await readdir(nestedDirectory)).toEqual([`agent-${agentId}.jsonl`])
  })

  it('publishes and preserves hosted Agent identity and permission controls', async () => {
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
      dataPlane: 'claude',
      cwd,
      claudeVersion: '2.1.208',
      provider: provider('BASE', 'base-model'),
      providerForModel(model) {
        selectedModels.push(model)
        return provider('OVERRIDE', model)
      },
      baseTools: emptyTools,
      permissions: { resolve: () => ({ behavior: 'allow' }) },
      permissionResolverForMode: () => ({
        resolve: () => ({ behavior: 'allow' }),
      }),
    })
    const registry = executor.registry(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      0,
      () => 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    )

    expect(executor.definitions().inputSchema.properties).not.toHaveProperty(
      'name',
    )
    expect(executor.definitions().inputSchema.properties).not.toHaveProperty(
      'team_name',
    )
    expect(executor.definitions().inputSchema.properties).not.toHaveProperty(
      'mode',
    )

    const prepared = await registry.prepare(
      {
        id: 'call_model',
        name: 'Agent',
        input: {
          description: 'Override model',
          prompt: 'Use selected model',
          model: 'haiku',
          name: 'reviewer',
          team_name: 'deprecated-team',
          mode: 'plan',
          run_in_background: true,
        },
      },
      { cwd },
    )
    expect(prepared.input.run_in_background).toBe(true)
    expect(prepared.input).toMatchObject({
      name: 'reviewer',
      team_name: 'deprecated-team',
      mode: 'plan',
    })
    const launched = await registry.execute(prepared, { cwd })
    expect(launched.nativeToolUseResult).toMatchObject({
      status: 'async_launched',
      resolvedModel: 'haiku',
    })
    expect(selectedModels).toEqual(['haiku'])
    await expect(executor.notifications(true)).resolves.toMatchObject({
      messages: [expect.stringContaining('OVERRIDE')],
    })

    process.env.CLAUDE_CODE_SUBAGENT_MODEL = 'environment-model'
    const environmentPrepared = await registry.prepare(
      {
        id: 'call_environment_model',
        name: 'Agent',
        input: {
          description: 'Environment model',
          prompt: 'Use environment model',
          model: 'opus',
          run_in_background: false,
        },
      },
      { cwd },
    )
    expect(environmentPrepared.input.model).toBe('environment-model')
    await expect(
      registry.execute(environmentPrepared, { cwd }),
    ).resolves.toMatchObject({ content: expect.stringContaining('OVERRIDE') })
    expect(selectedModels).toEqual(['haiku', 'environment-model'])
    delete process.env.CLAUDE_CODE_SUBAGENT_MODEL

    await expect(
      registry.prepare(
        {
          id: 'call_isolation',
          name: 'Agent',
          input: {
            description: 'Isolated work',
            prompt: 'Use a worktree',
            isolation: 'remote',
          },
        },
        { cwd },
      ),
    ).rejects.toThrow('Praxis does not support Agent isolation remote')
  })

  it('enforces Agent mode inside the child runtime and hook context', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-agent-mode-test-'))
    roots.push(root)
    const cwd = join(root, 'project')
    const requests: ModelRequest[] = []
    let writeExecutions = 0
    const hookInputs: Record<string, unknown>[] = []
    const tools: ToolRegistry = {
      definitions: () => [
        {
          name: 'Write',
          description: 'Write a file',
          inputSchema: {
            type: 'object',
            properties: { file_path: { type: 'string' } },
            required: ['file_path'],
          },
        },
      ],
      prepare: async (call) => call,
      execute: async () => {
        writeExecutions += 1
        return { content: 'WRITTEN', isError: false }
      },
    }
    const provider: ModelProvider = {
      capabilities: { streaming: true, usage: true, tools: true },
      async *complete(request) {
        requests.push(request)
        if (request.messages.some((message) => message.role === 'tool')) {
          yield { type: 'text-delta', delta: 'PLAN_MODE_DONE' }
          return
        }
        yield {
          type: 'tool-call',
          call: {
            id: 'call_write',
            name: 'Write',
            input: { file_path: join(cwd, 'blocked.txt') },
          },
        }
      },
    }
    const hooks = {
      async run(input: Record<string, unknown>) {
        hookInputs.push(input)
        return { executions: [], additionalContext: [] }
      },
    } as unknown as ClaudeHookRunner
    const executor = new ClaudeSubagentExecutor({
      configRoot: join(root, 'config'),
      dataPlane: 'claude',
      cwd,
      claudeVersion: '2.1.208',
      provider,
      baseTools: tools,
      permissions: { resolve: () => ({ behavior: 'allow' }) },
      permissionResolverForMode: (mode) =>
        new ClaudePermissionResolver({
          cwd,
          settings: [],
          permissionMode: mode,
        }),
      hooks,
    })
    const registry = executor.registry(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      0,
      () => 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    )
    const call = await registry.prepare(
      {
        id: 'call_plan_agent',
        name: 'Agent',
        input: {
          description: 'Plan only',
          prompt: 'Try to write',
          mode: 'plan',
          run_in_background: false,
        },
      },
      { cwd },
    )

    const result = await registry.execute(call, { cwd })

    expect(result.content).toContain('PLAN_MODE_DONE')
    expect(writeExecutions).toBe(0)
    expect(JSON.stringify(requests)).toContain(
      'Cannot use Write while in plan mode',
    )
    expect(hookInputs.length).toBeGreaterThan(0)
    expect(hookInputs.every((input) => input.permission_mode === 'plan')).toBe(
      true,
    )
  })

  it('exposes ExitPlanMode only to effective plan-mode subagents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-plan-mode-tools-test-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    let exitPlanExecutions = 0
    const tools: ToolRegistry = {
      definitions: () => [
        {
          name: 'ExitPlanMode',
          description: 'Exit plan mode.',
          inputSchema: { type: 'object' },
        },
      ],
      prepare: async (call) => call,
      execute: async () => {
        exitPlanExecutions += 1
        return { content: 'EXIT_PLAN_RESULT', isError: false }
      },
    }
    const extensions = new ClaudeExtensionCatalog({
      commands: [],
      skills: [],
      agents: [
        {
          path: join(configRoot, 'agents', 'planner.md'),
          scope: 'user',
          content:
            '---\nname: planner\ndescription: Plan only.\npermissionMode: plan\n---\nPLANNER_POLICY',
        },
      ],
    })
    const childToolSets: string[][] = []
    const provider = (): ModelProvider => {
      let childTurn = 0
      return {
        model: 'plan-mode-fixture-model',
        capabilities: { streaming: true, usage: true, tools: true },
        async *complete(request) {
          const exposed =
            request.tools?.some(({ name }) => name === 'ExitPlanMode') ?? false
          if (childTurn++ === 0) {
            childToolSets.push(request.tools?.map(({ name }) => name) ?? [])
            if (exposed) {
              yield {
                type: 'tool-call',
                call: {
                  id: `call_exit_${childToolSets.length}`,
                  name: 'ExitPlanMode',
                  input: {},
                },
              }
              return
            }
          }
          yield {
            type: 'text-delta',
            delta: `CHILD_${childToolSets.length}_DONE`,
          }
        },
      }
    }
    const createExecutor = (parentMode: AgentPermissionMode = 'default') =>
      new ClaudeSubagentExecutor({
        configRoot,
        dataPlane: 'claude',
        cwd,
        claudeVersion: '2.1.208',
        provider: provider(),
        baseTools: tools,
        permissions: { resolve: () => ({ behavior: 'allow' }) },
        permissionResolverForMode: () => ({
          resolve: () => ({ behavior: 'allow' }),
        }),
        parentPermissionMode: () => parentMode,
        extensions,
      })
    const runChild = async (
      executor: ClaudeSubagentExecutor,
      subagentType: string,
      mode?: string,
    ) => {
      const registry = executor.registry(
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        0,
        () => 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      )
      const prepared = await registry.prepare(
        {
          id: `call_${subagentType}_${childToolSets.length}`,
          name: 'Agent',
          input: {
            description: subagentType,
            prompt: 'Plan the work',
            subagent_type: subagentType,
            ...(mode ? { mode } : {}),
            run_in_background: false,
          },
        },
        { cwd },
      )
      return registry.execute(prepared, { cwd })
    }

    const planResult = await runChild(createExecutor(), 'planner')
    expect(planResult.content).toContain('CHILD_1_DONE')
    const overrideResult = await runChild(
      createExecutor(),
      'general-purpose',
      'plan',
    )
    expect(overrideResult.content).toContain('CHILD_2_DONE')
    await runChild(createExecutor(), 'general-purpose')
    await runChild(createExecutor('bypassPermissions'), 'planner')

    expect(childToolSets[0]).toContain('ExitPlanMode')
    expect(childToolSets[1]).toContain('ExitPlanMode')
    expect(childToolSets[2]).not.toContain('ExitPlanMode')
    expect(childToolSets[3]).not.toContain('ExitPlanMode')
    expect(exitPlanExecutions).toBe(2)
  })

  it('runs an isolated Agent in a clean worktree and removes it', async () => {
    const { configRoot, cwd } = await gitRepository(
      'praxis-agent-worktree-clean-',
    )
    const toolCwds: string[] = []
    const contextCwds: string[] = []
    const requestMessages: ModelRequest['messages'][] = []
    let turn = 0
    const tools: ToolRegistry = {
      definitions: () => [
        {
          name: 'InspectCwd',
          description: 'Inspect current working directory',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
      prepare: async (call) => call,
      execute: async (_call, context) => {
        toolCwds.push(context.cwd)
        return { content: context.cwd, isError: false }
      },
    }
    const provider: ModelProvider = {
      capabilities: { streaming: true, usage: true, tools: true },
      async *complete(request) {
        requestMessages.push(request.messages)
        if (turn++ === 0) {
          yield {
            type: 'tool-call',
            call: { id: 'call_cwd', name: 'InspectCwd', input: {} },
          }
          return
        }
        yield { type: 'text-delta', delta: 'ISOLATED_DONE' }
      },
    }
    const executor = new ClaudeSubagentExecutor({
      configRoot,
      dataPlane: 'claude',
      cwd,
      claudeVersion: '2.1.208',
      provider,
      baseTools: tools,
      permissions: { resolve: () => ({ behavior: 'allow' }) },
      contextAssembler: {
        async assemble(options) {
          const contextCwd = options?.cwd ?? ''
          contextCwds.push(contextCwd)
          return {
            systemMessages: [
              { role: 'system', content: `CONTEXT_CWD:${contextCwd}` },
            ],
          }
        },
      },
    })
    const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const registry = executor.registry(
      sessionId,
      0,
      () => 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    )
    const call = await registry.prepare(
      {
        id: 'call_clean_worktree',
        name: 'Agent',
        input: {
          description: 'Clean isolation',
          prompt: 'Inspect only',
          isolation: 'worktree',
          run_in_background: false,
        },
      },
      { cwd },
    )

    const result = await registry.execute(call, { cwd })

    const worktreePath = String(result.nativeToolUseResult?.worktreePath)
    expect(toolCwds).toEqual([worktreePath])
    expect(contextCwds).toEqual([worktreePath, worktreePath])
    expect(requestMessages).toHaveLength(2)
    expect(
      requestMessages.every((messages) =>
        JSON.stringify(messages).includes(`CONTEXT_CWD:${worktreePath}`),
      ),
    ).toBe(true)
    expect(result.nativeToolUseResult).toMatchObject({
      worktreePath,
      worktreeRetained: false,
    })
    const paths = resolveClaudePaths({ configDir: configRoot, cwd, sessionId })
    const agentId = String(result.nativeToolUseResult?.agentId)
    const [rootEntry] = entries(
      await readFile(
        join(
          paths.projectRoot,
          sessionId,
          'subagents',
          `agent-${agentId}.jsonl`,
        ),
        'utf8',
      ),
    )
    expect(rootEntry?.cwd).toBe(worktreePath)
    await expect(stat(worktreePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects an oversized subagent context before provider transport', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-agent-budget-test-'))
    roots.push(root)
    const cwd = join(root, 'project')
    let providerCalls = 0
    const executor = new ClaudeSubagentExecutor({
      configRoot: join(root, 'config'),
      dataPlane: 'claude',
      cwd,
      claudeVersion: '2.1.208',
      provider: {
        capabilities: {
          streaming: true,
          usage: true,
          tools: true,
          contextWindowTokens: 100,
        },
        async *complete() {
          providerCalls += 1
          yield { type: 'text-delta', delta: 'unexpected' }
        },
      },
      baseTools: emptyTools,
      permissions: { resolve: () => ({ behavior: 'allow' }) },
      contextReserveTokens: 20,
      contextAssembler: {
        async assemble() {
          return {
            systemMessages: [
              { role: 'system', content: 'OVERSIZED_CONTEXT '.repeat(500) },
            ],
          }
        },
      },
    })
    const registry = executor.registry(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      0,
      () => 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    )
    const call = await registry.prepare(
      {
        id: 'call_oversized_context',
        name: 'Agent',
        input: {
          description: 'Budget probe',
          prompt: 'Inspect context budget',
          run_in_background: false,
        },
      },
      { cwd },
    )

    await expect(registry.execute(call, { cwd })).rejects.toThrow(
      /window=100.*reserve=20.*available=80/,
    )
    expect(providerCalls).toBe(0)
  })

  it('retains an isolated Agent worktree containing changes', async () => {
    const { configRoot, cwd } = await gitRepository(
      'praxis-agent-worktree-dirty-',
    )
    let turn = 0
    const tools = new LocalToolRegistry({ cwd })
    const provider: ModelProvider = {
      capabilities: { streaming: true, usage: true, tools: true },
      async *complete() {
        if (turn++ === 0) {
          yield {
            type: 'tool-call',
            call: {
              id: 'call_dirty',
              name: 'Write',
              input: {
                file_path: 'agent-change.txt',
                content: 'changed\n',
              },
            },
          }
          return
        }
        yield { type: 'text-delta', delta: 'DIRTY_DONE' }
      },
    }
    const executor = new ClaudeSubagentExecutor({
      configRoot,
      dataPlane: 'claude',
      cwd,
      claudeVersion: '2.1.208',
      provider,
      baseTools: tools,
      permissions: { resolve: () => ({ behavior: 'allow' }) },
    })
    const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const registry = executor.registry(
      sessionId,
      0,
      () => 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    )
    const call = await registry.prepare(
      {
        id: 'call_dirty_worktree',
        name: 'Agent',
        input: {
          description: 'Dirty isolation',
          prompt: 'Make a change',
          isolation: 'worktree',
          run_in_background: false,
        },
      },
      { cwd },
    )

    const result = await registry.execute(call, { cwd })

    const worktreePath = String(result.nativeToolUseResult?.worktreePath)
    expect(result.nativeToolUseResult).toMatchObject({
      worktreePath,
      worktreeRetained: true,
      worktreeWarning: expect.stringContaining(worktreePath),
    })
    expect(result.content).toContain(worktreePath)
    expect(await readFile(join(worktreePath, 'agent-change.txt'), 'utf8')).toBe(
      'changed\n',
    )
    await expect(
      readFile(join(cwd, 'agent-change.txt'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' })

    const resumedCwds: string[] = []
    const resumed = new ClaudeSubagentExecutor({
      configRoot,
      dataPlane: 'claude',
      cwd,
      claudeVersion: '2.1.208',
      provider: {
        capabilities: { streaming: true, usage: true, tools: false },
        async *complete() {
          yield { type: 'text-delta', delta: 'RETAINED_RESUME_DONE' }
        },
      },
      baseTools: emptyTools,
      permissions: { resolve: () => ({ behavior: 'allow' }) },
      contextAssembler: {
        async assemble(options) {
          resumedCwds.push(options?.cwd ?? '')
          return { systemMessages: [] }
        },
      },
    })
    const resumedRegistry = resumed.registry(
      sessionId,
      0,
      () => 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    )
    const agentId = String(result.nativeToolUseResult?.agentId)
    await resumedRegistry.execute(
      await resumedRegistry.prepare(
        {
          id: 'call_retained_resume',
          name: 'SendMessage',
          input: { to: agentId, message: 'Continue in retained worktree' },
        },
        { cwd },
      ),
      { cwd },
    )
    const resumedOutput = await resumedRegistry.execute(
      await resumedRegistry.prepare(
        {
          id: 'call_retained_output',
          name: 'TaskOutput',
          input: { task_id: agentId, block: true, timeout: 30_000 },
        },
        { cwd },
      ),
      { cwd },
    )
    expect(resumedOutput.content).toContain('RETAINED_RESUME_DONE')
    expect(resumedCwds).toEqual([worktreePath])
    expect(await readFile(join(worktreePath, 'agent-change.txt'), 'utf8')).toBe(
      'changed\n',
    )
  })

  it('enforces the session Agent call budget before creating another sidechain', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-agent-budget-test-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const executor = new ClaudeSubagentExecutor({
      configRoot,
      dataPlane: 'claude',
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

  it('rejects recursive Agent calls inside an external subagent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-nested-agent-test-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const requests: ModelRequest[] = []
    const provider: ModelProvider = {
      capabilities: { streaming: true, usage: true, tools: true },
      async *complete(request) {
        requests.push(request)
        const child = request.messages.some(
          (message) =>
            message.role === 'system' &&
            message.content.includes('general-purpose subagent'),
        )
        const hasToolResult = request.messages.some(
          (message) => message.role === 'tool',
        )
        if (!hasToolResult) {
          yield {
            type: 'tool-call',
            call: {
              id: child ? 'nested_agent' : 'root_agent',
              name: 'Agent',
              input: {
                description: child ? 'Nested child' : 'Root child',
                prompt: child ? 'DEPTH_2' : 'DEPTH_1',
                subagent_type: 'general-purpose',
                run_in_background: false,
              },
            },
          }
        } else {
          yield {
            type: 'text-delta',
            delta: child ? 'CHILD_DONE' : 'MAIN_DONE',
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

    const result = await service.run('Exercise recursive Agent rejection.')

    expect(result.text).toBe('MAIN_DONE')
    expect(requests).toHaveLength(4)
    const childRequest = requests.find((request) =>
      JSON.stringify(request.messages).includes('DEPTH_1'),
    )
    expect(childRequest?.tools?.map(({ name }) => name)).not.toContain('Agent')
    const paths = resolveClaudePaths({
      configDir: configRoot,
      cwd,
      sessionId: result.sessionId,
    })
    const sidechainDirectory = join(
      paths.projectRoot,
      result.sessionId,
      'subagents',
    )
    const sidechainFiles = await readdir(sidechainDirectory)
    expect(
      sidechainFiles.filter((name) => name.endsWith('.jsonl')),
    ).toHaveLength(1)
    const sidechainSource = (
      await Promise.all(
        sidechainFiles
          .filter((name) => name.endsWith('.jsonl'))
          .map((name) => readFile(join(sidechainDirectory, name), 'utf8')),
      )
    ).join('\n')
    expect(sidechainSource).toContain('Tool Agent is unavailable to this agent')
  })

  it('propagates cancellation into the active subagent with one terminal result', async () => {
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
    expect(JSON.stringify(mainEntries)).toContain(
      '"tool_use_id":"call_cancel_agent"',
    )
    expect(JSON.stringify(mainEntries)).toContain('Agent cancelled:')
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
      interruptedSource
        .split('\n')
        .filter((line) => !line.includes('"tool_use_id":"call_recover_agent"'))
        .join('\n')
        .replace('"promptSource":"interactive"', '"promptSource":"sdk"'),
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
