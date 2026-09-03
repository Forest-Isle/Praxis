import { execFile } from 'node:child_process'
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  projectContextSnapshot,
  type ContextSnapshot,
} from '../core/context.js'
import { assembleContextSnapshot } from '../core/prompt-composer.js'
import type {
  ModelProvider,
  ModelRequest,
  PermissionResolver,
  RuntimeEvent,
  ToolRegistry,
} from '../core/runtime.js'
import { AgentRunCancelledError, ModelProviderError } from '../core/runtime.js'
import { ClaudeExtensionCatalog } from '../extensions/claude-extensions.js'
import { ClaudeHookRunner } from '../hooks/claude-hooks.js'
import type { ClaudeHookCommandExecutor } from '../hooks/claude-hooks.js'
import { ClaudePermissionResolver } from '../permissions/claude-permission-resolver.js'
import type { ClaudeMcpRuntime } from '../mcp/claude-mcp-tools.js'
import { resolveDataPlanePaths } from '../persistence/data-plane.js'
import { ManagedWorktreeStore } from '../persistence/managed-worktree-store.js'
import { sanitizeProjectPath } from '../platform/project-path-key.js'
import {
  SubagentExecution,
  SubagentLifecycleStore,
  type PersistedSubagentRunResult,
} from '../persistence/subagent-lifecycle-store.js'
import { FallbackModelProvider } from '../providers/fallback-provider.js'
import { LocalToolRegistry } from '../tools/local-tools.js'
import { NativeSidechainTranscript } from './native-sidechain-transcript.js'
import { createAgentWorktree } from './agent-worktree.js'
import { parseAgentWorktreeOwner } from './agent-worktree-owner.js'
import { reconcileManagedWorktrees } from './managed-worktree.js'
import { BackgroundAgentRunError } from './background-agent-manager.js'
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

async function persistTerminal(
  store: SubagentLifecycleStore,
  state: 'completed' | 'failed' | 'cancelled',
  detail?: string,
  result?: PersistedSubagentRunResult,
  notification?: {
    id: string
    status: 'completed' | 'failed' | 'killed'
    toolUseId: string
    error: string | null
  },
): Promise<void> {
  const execution = (await store.read())
    ? await store.continue()
    : await store.start()
  await execution.running()
  if (state === 'cancelled') await execution.beginCancellation()
  await execution.finish(state, result, detail, notification)
  await execution.release()
}

function contextSnapshot(system: readonly string[] = []): ContextSnapshot {
  return {
    sections: system.map((content, index) => ({
      id: `test-system-${index}`,
      content,
      placement: 'system',
      stability: 'session',
    })),
  }
}

async function seedIncompleteIsolatedSidechain(options: {
  configRoot: string
  cwd: string
  sessionId: string
  agentId: string
  worktreePath: string
  name: string
}): Promise<void> {
  const paths = resolveDataPlanePaths({
    dataPlane: 'native',
    root: options.configRoot,
    cwd: options.cwd,
    sessionId: options.sessionId,
  })
  const directory = join(paths.projectRoot, options.sessionId, 'subagents')
  await mkdir(directory, { recursive: true })
  const transcript = new NativeSidechainTranscript({
    sessionId: options.sessionId,
    agentId: options.agentId,
    directory,
    transcriptFile: join(directory, `agent-${options.agentId}.jsonl`),
    metadataFile: join(directory, `agent-${options.agentId}.meta.json`),
    lockFile: join(
      paths.praxisRoot,
      'locks',
      `${options.sessionId}-${options.agentId}.lock`,
    ),
  })
  await transcript.create('RESTORE_ISOLATION_ROOT', {
    agentType: 'general-purpose',
    description: 'Restore isolated checkout',
    toolUseId: 'call_restore_isolation_origin',
    spawnDepth: 1,
    cwd: options.worktreePath,
    promptId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    isolation: 'worktree',
    worktreePath: options.worktreePath,
    name: options.name,
  })
}

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

function nativeEnvelope(
  sessionId: string,
  id: string,
  parentId: string | null,
  messages: ModelRequest['messages'],
  timestamp: string,
): string {
  return `${JSON.stringify({
    schema: 'praxis.transcript',
    version: 1,
    event: {
      kind: 'messages',
      id,
      parentId,
      sessionId,
      timestamp,
      messages,
    },
  })}\n`
}

describe('foreground Claude Agent execution', () => {
  it('keeps a turn fallback route through an Agent tool continuation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-turn-fallback-'))
    roots.push(root)
    let primaryCalls = 0
    let fallbackCalls = 0
    const primary: ModelProvider = {
      model: 'primary-model',
      capabilities: {
        streaming: true,
        usage: true,
        tools: true,
        terminalReasons: true,
      },
      async *complete() {
        primaryCalls += 1
        yield* []
        throw new ModelProviderError('primary unavailable', {
          retryable: true,
          kind: 'overloaded',
        })
      },
    }
    const fallback: ModelProvider = {
      model: 'fallback-model',
      capabilities: {
        streaming: true,
        usage: true,
        tools: true,
        terminalReasons: true,
      },
      async *complete() {
        fallbackCalls += 1
        if (fallbackCalls === 1) {
          yield {
            type: 'tool-call',
            call: {
              id: 'read-fallback',
              name: 'Read',
              input: { file_path: 'fixture.txt' },
            },
          }
          yield { type: 'terminal', reason: 'tool_use' }
          return
        }
        yield { type: 'text-delta', delta: 'fallback complete' }
        yield { type: 'terminal', reason: 'end_turn' }
      },
    }
    const providerForTurn = vi.fn(
      () =>
        new FallbackModelProvider({
          providers: [primary, fallback],
          retryDelayMs: 0,
          routeScope: 'turn',
        }),
    )
    const executor = new ClaudeSubagentExecutor({
      configRoot: join(root, 'config'),
      dataPlane: 'native',
      cwd: root,
      claudeVersion: '2.1.208',
      provider: primary,
      providerForTurn,
      baseTools: {
        definitions: () => [
          {
            name: 'Read',
            description: 'Read a fixture',
            inputSchema: { type: 'object' },
          },
        ],
        prepare: async (call) => call,
        execute: async () => ({ content: 'fixture', isError: false }),
      },
      permissions: { resolve: () => ({ behavior: 'allow' }) },
    })

    const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const cwd = root
    const registry = executor.registry(
      sessionId,
      0,
      () => 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    )
    const call = await registry.prepare(
      {
        id: 'turn-fallback-agent',
        name: 'Agent',
        input: {
          description: 'Read fixture',
          prompt: 'Read the fixture',
          subagent_type: 'general-purpose',
          run_in_background: false,
        },
      },
      { cwd },
    )
    const result = await registry.execute(call, { cwd })

    expect(result.content).toContain('fallback complete')
    expect(providerForTurn).toHaveBeenCalledTimes(1)
    expect(providerForTurn).toHaveBeenCalledWith(undefined)
    expect(primaryCalls).toBe(3)
    expect(fallbackCalls).toBe(2)
  })

  it('allocates a fresh provider for each background Agent follow-up', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-background-turns-'))
    roots.push(root)
    const clients: ModelProvider[] = []
    const providerForTurn = vi.fn(() => {
      const label = clients.length === 0 ? 'initial' : 'follow-up'
      const client: ModelProvider = {
        model: label,
        capabilities: { streaming: true, usage: true, tools: true },
        async *complete() {
          yield { type: 'text-delta', delta: label }
          yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
        },
      }
      clients.push(client)
      return client
    })
    const executor = new ClaudeSubagentExecutor({
      configRoot: join(root, 'config'),
      dataPlane: 'native',
      cwd: root,
      claudeVersion: '2.1.208',
      provider: {
        capabilities: { streaming: true, usage: true, tools: true },
        async *complete() {
          yield { type: 'text-delta', delta: 'unused' }
        },
      },
      providerForTurn,
      baseTools: emptyTools,
      permissions: { resolve: () => ({ behavior: 'allow' }) },
    })
    const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const registry = executor.registry(
      sessionId,
      0,
      () => 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    )
    const launched = await registry.execute(
      await registry.prepare(
        {
          id: 'background-turn-agent',
          name: 'Agent',
          input: {
            description: 'Background turn',
            prompt: 'Initial task',
            run_in_background: true,
          },
        },
        { cwd: root },
      ),
      { cwd: root },
    )
    const agentId = String(launched.nativeToolUseResult?.agentId)
    const firstOutput = await registry.execute(
      await registry.prepare(
        {
          id: 'background-turn-output',
          name: 'TaskOutput',
          input: { task_id: agentId, block: true, timeout: 30_000 },
        },
        { cwd: root },
      ),
      { cwd: root },
    )
    expect(firstOutput.content).toContain('initial')
    const sent = await registry.execute(
      await registry.prepare(
        {
          id: 'background-turn-send',
          name: 'SendMessage',
          input: { to: agentId, message: 'Follow up' },
        },
        { cwd: root },
      ),
      { cwd: root },
    )
    expect(sent.content).toContain('resumedAgentId')
    const secondOutput = await registry.execute(
      await registry.prepare(
        {
          id: 'background-turn-output-2',
          name: 'TaskOutput',
          input: { task_id: agentId, block: true, timeout: 30_000 },
        },
        { cwd: root },
      ),
      { cwd: root },
    )
    expect(secondOutput.content).toContain('follow-up')
    expect(providerForTurn).toHaveBeenCalledTimes(2)
    expect(clients).toHaveLength(2)
    expect(clients[0]).not.toBe(clients[1])
    await executor.close()
  })

  it('allocates distinct providers for independent Workflow invocations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-workflow-turns-'))
    roots.push(root)
    const clients: ModelProvider[] = []
    const models: (string | undefined)[] = []
    const providerForTurn = vi.fn((model?: string) => {
      models.push(model)
      const client: ModelProvider = {
        model: model ?? 'inherited-model',
        capabilities: { streaming: true, usage: true, tools: true },
        async *complete() {
          yield { type: 'text-delta', delta: model ?? 'inherited' }
          yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
        },
      }
      clients.push(client)
      return client
    })
    const executor = new ClaudeSubagentExecutor({
      configRoot: join(root, 'config'),
      dataPlane: 'native',
      cwd: root,
      claudeVersion: '2.1.208',
      provider: {
        capabilities: { streaming: true, usage: true, tools: true },
        async *complete() {
          yield { type: 'text-delta', delta: 'unused' }
        },
      },
      providerForTurn,
      baseTools: emptyTools,
      permissions: { resolve: () => ({ behavior: 'allow' }) },
    })
    const run = (model: string, suffix: string) =>
      executor.runWorkflowAgent({
        sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        promptId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        runId: `workflow-turn-${suffix}`,
        agentId: `a1234567890abcde${suffix}`,
        transcriptDirectory: join(root, `workflow-${suffix}`),
        prompt: `Workflow ${suffix}`,
        model,
      })

    await expect(run('workflow-model-a', '1')).resolves.toMatchObject({
      result: 'workflow-model-a',
    })
    await expect(run('workflow-model-b', '2')).resolves.toMatchObject({
      result: 'workflow-model-b',
    })
    expect(providerForTurn).toHaveBeenCalledTimes(2)
    expect(models).toEqual(['workflow-model-a', 'workflow-model-b'])
    expect(clients[0]).not.toBe(clients[1])
    await executor.close()
  })

  it('runs Workflow isolation in the owned repo-local cwd and reports retention', async () => {
    const { configRoot, cwd, fixtureRoot } = await gitRepository(
      'praxis-workflow-owned-isolation-',
    )
    const toolCwds: string[] = []
    let turn = 0
    const executor = new ClaudeSubagentExecutor({
      configRoot,
      dataPlane: 'native',
      cwd,
      claudeVersion: '2.1.208',
      provider: {
        capabilities: { streaming: true, usage: true, tools: true },
        async *complete() {
          if (turn++ === 0) {
            yield {
              type: 'tool-call',
              call: { id: 'workflow_touch', name: 'TouchCwd', input: {} },
            }
            return
          }
          yield { type: 'text-delta', delta: 'WORKFLOW_ISOLATED' }
        },
      },
      baseTools: {
        definitions: () => [
          {
            name: 'TouchCwd',
            description: 'Write in the active cwd',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
        prepare: async (call) => call,
        execute: async (_call, context) => {
          toolCwds.push(context.cwd)
          await writeFile(join(context.cwd, 'workflow-change.txt'), 'changed\n')
          return { content: 'changed', isError: false }
        },
      },
      permissions: { resolve: () => ({ behavior: 'allow' }) },
    })

    try {
      const result = await executor.runWorkflowAgent({
        sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        promptId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        runId: 'owned-isolation-run',
        agentId: 'a1234567890abcdef',
        transcriptDirectory: join(fixtureRoot, 'workflow'),
        prompt: 'Touch the isolated cwd',
        isolation: 'worktree',
      })
      const expectedPath = join(
        await realpath(cwd),
        '.praxis',
        'worktrees',
        'workflow',
        'owned-isolation-run-a1234567890abcdef',
      )

      expect(toolCwds).toEqual([expectedPath])
      expect(result).toMatchObject({
        result: 'WORKFLOW_ISOLATED',
        isolationPath: expectedPath,
        isolationRetained: true,
        isolationWarning: expect.stringContaining(expectedPath),
      })
      expect(
        await readFile(join(expectedPath, 'workflow-change.txt'), 'utf8'),
      ).toBe('changed\n')
      await expect(
        readFile(join(cwd, 'workflow-change.txt'), 'utf8'),
      ).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await executor.close()
    }
  })

  it('wires trusted lifecycle hooks through Workflow isolation without transcript writes', async () => {
    const { configRoot, cwd, fixtureRoot } = await gitRepository(
      'praxis-workflow-hooks-',
    )
    const hookCalls: {
      command: string
      input: Record<string, unknown>
      signal: AbortSignal | undefined
    }[] = []
    const hookExecutor: ClaudeHookCommandExecutor = async (
      command,
      input,
      _timeout,
      signal,
    ) => {
      hookCalls.push({ command, input, signal })
      return {
        stdout: JSON.stringify({
          hookSpecificOutput: {
            additionalContext: `HOOK_CONTEXT_${input.hook_event_name}`,
          },
        }),
        stderr: '',
        exitCode: 0,
        durationMs: 1,
      }
    }
    const hooks = new ClaudeHookRunner({
      settings: [
        {
          path: '/project.json',
          scope: 'project',
          value: {
            hooks: {
              WorktreeCreate: [
                {
                  matcher: 'workflow',
                  hooks: [{ type: 'command', command: 'workflow-create' }],
                },
              ],
              WorktreeRemove: [
                {
                  matcher: 'workflow',
                  hooks: [{ type: 'command', command: 'workflow-remove' }],
                },
              ],
            },
          },
        },
      ],
      cwd,
      executeCommand: hookExecutor,
    })
    const controller = new AbortController()
    const agentId = 'a1234567890abcdef'
    const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const transcriptPath = join(
      fixtureRoot,
      'workflow',
      `agent-${agentId}.jsonl`,
    )
    const executor = new ClaudeSubagentExecutor({
      configRoot,
      dataPlane: 'native',
      cwd,
      claudeVersion: '2.1.208',
      provider: {
        capabilities: { streaming: true, usage: true, tools: true },
        async *complete() {
          yield { type: 'text-delta', delta: 'WORKFLOW_HOOKED' }
          yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
        },
      },
      baseTools: emptyTools,
      permissions: { resolve: () => ({ behavior: 'allow' }) },
      hooks,
    })

    try {
      const result = await executor.runWorkflowAgent({
        sessionId,
        promptId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        runId: 'workflow-hooks-run',
        agentId,
        transcriptDirectory: join(fixtureRoot, 'workflow'),
        prompt: 'Run with lifecycle hooks',
        isolation: 'worktree',
        signal: controller.signal,
      })

      expect(result).toMatchObject({
        result: 'WORKFLOW_HOOKED',
        isolationRetained: false,
      })
      expect(hookCalls).toHaveLength(2)
      expect(hookCalls.map(({ command }) => command)).toEqual([
        'workflow-create',
        'workflow-remove',
      ])
      const createInput = hookCalls[0]?.input
      const removeInput = hookCalls[1]?.input
      expect(createInput).toMatchObject({
        session_id: sessionId,
        transcript_path: transcriptPath,
        permission_mode: 'default',
        hook_event_name: 'WorktreeCreate',
        worktree_kind: 'workflow',
        owner_id: `workflow:workflow-hooks-run:${agentId}`,
        cwd: expect.any(String),
        worktree_path: expect.any(String),
        worktree_id: expect.any(String),
        base_commit: expect.any(String),
      })
      expect(removeInput).toEqual({
        ...createInput,
        hook_event_name: 'WorktreeRemove',
        reason: 'normal',
      })
      expect(createInput?.cwd).toBe(createInput?.worktree_path)
      expect(removeInput?.cwd).toBe(removeInput?.worktree_path)
      expect(
        hookCalls.every(({ signal }) => signal === controller.signal),
      ).toBe(true)
      const transcript = await readFile(transcriptPath, 'utf8')
      expect(transcript).not.toContain('workflow-create')
      expect(transcript).not.toContain('workflow-remove')
      expect(transcript).not.toContain('HOOK_CONTEXT_')
    } finally {
      await executor.close()
    }
  })

  it('installs the no-hook stop boundary for durable follow-ups', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-durable-stop-test-'))
    roots.push(root)
    let projected = 0
    let acknowledged = 0
    const executor = new ClaudeSubagentExecutor({
      configRoot: join(root, 'config'),
      dataPlane: 'native',
      cwd: join(root, 'project'),
      claudeVersion: '2.1.208',
      provider: {
        capabilities: { streaming: true, usage: true, tools: true },
        async *complete() {
          yield { type: 'text-delta', delta: 'WORKER_DONE' }
        },
      },
      baseTools: emptyTools,
      permissions: { resolve: () => ({ behavior: 'allow' }) },
      durableFollowUpSource: async () => {
        projected += 1
        if (projected > 1) return null
        return {
          id: 'durable-stop-batch',
          messages: ['<team-mailbox-message>MAILBOX</team-mailbox-message>'],
          acknowledge: async () => {
            acknowledged += 1
          },
        }
      },
    })

    await executor.runWorkflowAgent({
      sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      promptId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      runId: 'durable-stop-run',
      agentId: 'a1234567890abcdef',
      transcriptDirectory: join(root, 'workflow'),
      prompt: 'WORKER_PROMPT',
    })

    expect(projected).toBeGreaterThan(0)
    expect(acknowledged).toBe(1)
  })

  it('awaits an asynchronously owned SendMessage result', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-owned-send-await-'))
    roots.push(root)
    let completed = false
    const executor = new ClaudeSubagentExecutor({
      configRoot: join(root, 'config'),
      dataPlane: 'native',
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
      sendOwnedBackgroundAgent: async () => {
        await Promise.resolve()
        completed = true
        return 'owned result'
      },
    })
    const registry = executor.registry(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      0,
      () => 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    )
    const result = await registry.execute(
      await registry.prepare(
        {
          id: 'owned-send',
          name: 'SendMessage',
          input: { to: 'worker', message: 'hello' },
        },
        { cwd: join(root, 'project') },
      ),
      { cwd: join(root, 'project') },
    )
    expect(completed).toBe(true)
    expect(result.content).toBe('owned result')
  })

  it('defers MCP schemas for default subagent turns and supports direct loading opt-out', async () => {
    const run = async (deferMcpTools: boolean | undefined) => {
      const root = await mkdtemp(
        join(tmpdir(), 'praxis-subagent-deferred-mcp-'),
      )
      roots.push(root)
      const requests: ModelRequest[] = []
      let searched = false
      const executor = new ClaudeSubagentExecutor({
        configRoot: join(root, 'config'),
        dataPlane: 'native',
        cwd: join(root, 'project'),
        claudeVersion: '2.1.208',
        provider: {
          capabilities: { streaming: true, usage: true, tools: true },
          async *complete(request) {
            requests.push(request)
            if (
              !searched &&
              request.tools?.some(({ name }) => name === 'ToolSearch')
            ) {
              searched = true
              yield {
                type: 'tool-call',
                call: {
                  id: 'subagent-tool-search',
                  name: 'ToolSearch',
                  input: { query: 'fixture search' },
                },
              }
            } else {
              yield { type: 'text-delta', delta: 'SUBAGENT_DONE' }
            }
            yield {
              type: 'usage',
              usage: { inputTokens: 4, outputTokens: 2 },
            }
          },
        },
        baseTools: {
          definitions: () => [
            {
              name: 'Read',
              description: 'Read files',
              inputSchema: { type: 'object' },
            },
            {
              name: 'mcp__fixture__search',
              description: 'Search fixture documents',
              inputSchema: { type: 'object' },
            },
          ],
          prepare: async (call) => call,
          execute: async () => ({ content: 'fixture', isError: false }),
        },
        ...(deferMcpTools === undefined ? {} : { deferMcpTools }),
        permissions: { resolve: () => ({ behavior: 'allow' }) },
      })

      try {
        await executor.runWorkflowAgent({
          sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          promptId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          runId: 'deferred-mcp-run',
          agentId: 'a1234567890abcdef',
          transcriptDirectory: join(root, 'workflow'),
          prompt: 'Search the fixture',
        })
      } finally {
        await executor.close()
      }
      return requests.map(
        (request) => request.tools?.map(({ name }) => name) ?? [],
      )
    }

    const deferred = await run(undefined)
    expect(deferred).toHaveLength(2)
    expect(deferred[0]).toContain('ToolSearch')
    expect(deferred[0]).not.toContain('mcp__fixture__search')
    expect(deferred[1]).toContain('mcp__fixture__search')

    const direct = await run(false)
    expect(direct).toHaveLength(1)
    expect(direct[0]).toContain('mcp__fixture__search')
    expect(direct[0]).not.toContain('ToolSearch')
  })

  it('assembles one canonical structured-output section for workflow subagents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-workflow-context-test-'))
    roots.push(root)
    const cwd = join(root, 'project')
    const snapshots: ContextSnapshot[] = []
    const requests: ModelRequest[] = []
    let turn = 0
    const executor = new ClaudeSubagentExecutor({
      configRoot: join(root, 'config'),
      dataPlane: 'native',
      cwd,
      claudeVersion: '2.1.208',
      provider: {
        capabilities: { streaming: true, usage: true, tools: true },
        async *complete(request) {
          requests.push(request)
          if (turn++ === 0) {
            yield {
              type: 'tool-call',
              call: {
                id: 'structured',
                name: 'StructuredOutput',
                input: { answer: 'ok' },
              },
            }
            return
          }
          yield { type: 'text-delta', delta: 'done' }
        },
      },
      baseTools: emptyTools,
      permissions: { resolve: () => ({ behavior: 'allow' }) },
      contextAssembler: {
        async assemble(options) {
          const snapshot = await assembleContextSnapshot(undefined, options)
          snapshots.push(snapshot)
          return snapshot
        },
      },
    })

    const result = await executor.runWorkflowAgent({
      sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      promptId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      runId: 'structured-context-run',
      agentId: 'a1234567890abcdef',
      transcriptDirectory: join(root, 'workflow'),
      prompt: 'Return an answer',
      schema: {
        type: 'object',
        properties: { answer: { type: 'string' } },
        required: ['answer'],
        additionalProperties: false,
      },
    })

    expect(result.result).toEqual({ answer: 'ok' })
    expect(snapshots).toHaveLength(2)
    for (const snapshot of snapshots) {
      expect(
        snapshot.sections.filter(
          (section) => section.id === 'structured-output',
        ),
      ).toEqual([
        {
          id: 'structured-output',
          content: expect.stringContaining('requested JSON Schema'),
          placement: 'system',
          stability: 'volatile',
        },
      ])
      expect(projectContextSnapshot(snapshot).stableSystemSectionCount).toBe(1)
    }
    expect(
      requests.every((request) => request.stableSystemMessageCount === 1),
    ).toBe(true)
  })

  it('writes workflow Agent sidechains with the canonical native codec', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-native-workflow-agent-'))
    roots.push(root)
    const cwd = join(root, 'project')
    const transcriptDirectory = join(root, 'workflow')
    const executor = new ClaudeSubagentExecutor({
      configRoot: join(root, 'config'),
      dataPlane: 'native',
      cwd,
      claudeVersion: '2.1.208',
      persistence: 'disk',
      experimentalNativeTranscriptWrites: true,
      provider: {
        model: 'native-workflow-model',
        capabilities: { streaming: true, usage: true, tools: false },
        async *complete() {
          yield { type: 'text-delta', delta: 'NATIVE_WORKFLOW_DONE' }
          yield {
            type: 'usage',
            usage: { inputTokens: 2, outputTokens: 1 },
          }
        },
      },
      baseTools: emptyTools,
      permissions: { resolve: () => ({ behavior: 'allow' }) },
    })

    await expect(
      executor.runWorkflowAgent({
        sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        promptId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        runId: 'native-workflow-run',
        agentId: 'a1234567890abcdef',
        transcriptDirectory,
        prompt: 'Return the native workflow marker',
      }),
    ).resolves.toMatchObject({ result: 'NATIVE_WORKFLOW_DONE' })
    const source = await readFile(
      join(transcriptDirectory, 'agent-a1234567890abcdef.jsonl'),
      'utf8',
    )
    expect(source).toContain('"schema":"praxis.transcript"')
    expect(source).not.toContain('isSidechain')
    expect(
      JSON.parse(
        await readFile(
          join(transcriptDirectory, 'agent-a1234567890abcdef.meta.json'),
          'utf8',
        ),
      ),
    ).toMatchObject({
      agentType: 'workflow-subagent',
      description: 'Workflow agent',
      toolUseId: 'workflow:native-workflow-run',
      spawnDepth: 1,
      cwd,
      promptId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    })
    await executor.close()
  })

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
      dataPlane: 'native',
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
    const paths = resolveDataPlanePaths({
      dataPlane: 'native',
      root: configRoot,
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
      dataPlane: 'native',
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
      dataPlane: 'native',
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
      dataPlane: 'native',
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

    const paths = resolveDataPlanePaths({
      dataPlane: 'native',
      root: configRoot,
      cwd,
      sessionId,
    })
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
      dataPlane: 'native',
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

  it.each([{ dataPlane: 'native' as const, projectDirectory: 'sessions' }])(
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
        ...(dataPlane === 'native'
          ? {
              persistence: 'disk' as const,
              experimentalNativeTranscriptWrites: true,
            }
          : {}),
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
      const paths = resolveDataPlanePaths({
        dataPlane: 'native',
        root: configRoot,
        cwd,
        sessionId,
      })
      const transcript = join(
        paths.projectRoot,
        sessionId,
        'subagents',
        `agent-${agentId}.jsonl`,
      )
      const source = await readFile(transcript, 'utf8')
      expect(source).toContain('SIDECHAIN_DONE')
      if (dataPlane === 'native') {
        expect(source).toContain('"schema":"praxis.transcript"')
        expect(source).not.toContain('"isSidechain"')
        const metadata = JSON.parse(
          await readFile(
            join(
              paths.projectRoot,
              sessionId,
              'subagents',
              `agent-${agentId}.meta.json`,
            ),
            'utf8',
          ),
        )
        expect(metadata).toMatchObject({
          agentType: 'general-purpose',
          description: 'native paths',
          toolUseId: 'call_native',
          spawnDepth: 1,
          cwd,
          promptId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        })
      }
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
      const wrongLockRoot = join(configRoot, 'praxis')
      await expect(stat(wrongLockRoot)).rejects.toMatchObject({
        code: 'ENOENT',
      })
    },
  )

  it('persists canonical native Agent tool claims, results, and follow-ups', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-native-agent-tools-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    await mkdir(cwd, { recursive: true })
    const sessionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    const requests: ModelRequest[] = []
    const tools: ToolRegistry = {
      definitions: () => [
        {
          name: 'fixture_tool',
          description: 'returns a fixture',
          inputSchema: { type: 'object' },
        },
      ],
      async prepare(call) {
        return call
      },
      async execute() {
        return {
          content: 'NATIVE_TOOL_RESULT',
          isError: false,
          followUpUserMessages: ['NATIVE_TOOL_FOLLOW_UP'],
        }
      },
    }
    const executor = new ClaudeSubagentExecutor({
      configRoot,
      dataPlane: 'native',
      cwd,
      claudeVersion: '2.1.208',
      persistence: 'disk',
      experimentalNativeTranscriptWrites: true,
      provider: {
        model: 'native-agent-model',
        capabilities: { streaming: true, usage: true, tools: true },
        async *complete(request) {
          requests.push(request)
          if (
            !JSON.stringify(request.messages).includes('NATIVE_TOOL_RESULT')
          ) {
            yield {
              type: 'tool-call',
              call: {
                id: 'native-child-call',
                name: 'fixture_tool',
                input: {},
              },
            }
          } else {
            yield { type: 'text-delta', delta: 'NATIVE_AGENT_DONE' }
          }
          yield {
            type: 'usage',
            usage: { inputTokens: 2, outputTokens: 1 },
          }
        },
      },
      baseTools: tools,
      permissions: { resolve: () => ({ behavior: 'allow' }) },
    })
    const registry = executor.registry(
      sessionId,
      0,
      () => 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    )
    const result = await registry.execute(
      await registry.prepare(
        {
          id: 'call_native_agent_tools',
          name: 'Agent',
          input: {
            description: 'Exercise native tools',
            prompt: 'Use the fixture tool',
            subagent_type: 'general-purpose',
            run_in_background: false,
          },
        },
        { cwd },
      ),
      { cwd },
    )

    expect(result.content).toContain('NATIVE_AGENT_DONE')
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain(
      'NATIVE_TOOL_FOLLOW_UP',
    )
    const agentId = String(result.nativeToolUseResult?.agentId)
    const paths = resolveDataPlanePaths({
      dataPlane: 'native',
      root: configRoot,
      cwd,
      sessionId,
    })
    const source = await readFile(
      join(paths.projectRoot, sessionId, 'subagents', `agent-${agentId}.jsonl`),
      'utf8',
    )
    const events = source
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line).event)
    expect(events.map((event) => event.kind)).toEqual([
      'messages',
      'messages',
      'tool-execution-started',
      'messages',
      'messages',
    ])
    expect(events[2]).toMatchObject({
      kind: 'tool-execution-started',
      callId: 'native-child-call',
    })
    expect(events[3]?.messages).toEqual([
      {
        role: 'tool',
        toolCallId: 'native-child-call',
        content: 'NATIVE_TOOL_RESULT',
        isError: false,
      },
      { role: 'user', content: 'NATIVE_TOOL_FOLLOW_UP' },
    ])
    expect(source).not.toContain('isSidechain')
    await executor.close()
  })

  it('runs a canonical native main session and Agent sidechain end to end', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-native-agent-session-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const service = new ClaudeSessionService({
      configRoot,
      dataPlane: 'native',
      experimentalNativeTranscriptWrites: true,
      cwd,
      claudeVersion: '2.1.208',
      autoCompact: false,
      enableSubagents: true,
      subagentToolNames: ['Agent'],
      provider: {
        model: 'native-session-agent-model',
        capabilities: { streaming: true, usage: true, tools: true },
        async *complete(request) {
          const source = JSON.stringify(request.messages)
          if (source.includes('general-purpose subagent')) {
            yield { type: 'text-delta', delta: 'NATIVE_SESSION_CHILD' }
          } else if (source.includes('NATIVE_SESSION_CHILD')) {
            yield { type: 'text-delta', delta: 'NATIVE_SESSION_MAIN' }
          } else {
            yield {
              type: 'tool-call',
              call: {
                id: 'native-session-agent-call',
                name: 'Agent',
                input: {
                  description: 'Run canonical child',
                  prompt: 'Return the child marker',
                  subagent_type: 'general-purpose',
                  run_in_background: false,
                },
              },
            }
          }
          yield {
            type: 'usage',
            usage: { inputTokens: 2, outputTokens: 1 },
          }
        },
      },
      tools: emptyTools,
      permissions: { resolve: () => ({ behavior: 'allow' }) },
    })

    const result = await service.run('Delegate canonically.')

    expect(result.text).toBe('NATIVE_SESSION_MAIN')
    const paths = resolveDataPlanePaths({
      dataPlane: 'native',
      root: configRoot,
      cwd,
      sessionId: result.sessionId,
    })
    const mainSource = await readFile(paths.sessionFile, 'utf8')
    expect(mainSource).toContain('"schema":"praxis.transcript"')
    expect(mainSource).not.toContain('"type":"assistant"')
    const sidechainDirectory = join(
      paths.projectRoot,
      result.sessionId,
      'subagents',
    )
    const sidechainFile = (await readdir(sidechainDirectory)).find((name) =>
      name.endsWith('.jsonl'),
    )
    if (!sidechainFile) throw new Error('Native Agent sidechain is missing')
    const sidechainSource = await readFile(
      join(sidechainDirectory, sidechainFile),
      'utf8',
    )
    expect(sidechainSource).toContain('"schema":"praxis.transcript"')
    expect(sidechainSource).toContain('NATIVE_SESSION_CHILD')
    expect(sidechainSource).not.toContain('isSidechain')
    await service.close()
  })

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
      dataPlane: 'native',
      cwd,
      sessionPersistence: true,
      experimentalNativeTranscriptWrites: true,
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
    const paths = resolveDataPlanePaths({
      dataPlane: 'native',
      root: configRoot,
      cwd,
      sessionId: result.sessionId,
    })
    const mainEntries = entries(await readFile(paths.sessionFile, 'utf8'))
    const source = JSON.stringify(mainEntries)
    expect(source).toContain('call_agent')
    expect(source).toContain('CHILD_RESULT')
    const agentIdMatch = source.match(/agentId: (a[0-9a-f]{16})/u)
    if (!agentIdMatch) throw new Error('Native Agent result is missing agentId')
    const agentId = agentIdMatch[1]
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
      schema: 'praxis.transcript',
      event: {
        kind: 'messages',
        parentId: null,
        messages: [{ role: 'user', content: 'Return CHILD_RESULT' }],
      },
    })
    expect(sidechainEntries[1]).toMatchObject({
      schema: 'praxis.transcript',
      event: { kind: 'messages' },
    })
    expect(
      JSON.parse(
        await readFile(
          join(subagentDirectory, `agent-${agentId}.meta.json`),
          'utf8',
        ),
      ),
    ).toMatchObject({
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
      dataPlane: 'native',
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
      dataPlane: 'native',
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
        dataPlane: 'native',
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
    const paths = resolveDataPlanePaths({
      dataPlane: 'native',
      root: join(root, 'config'),
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

  it('terminalizes and releases a persisted Agent when background admission fails', async () => {
    const { configRoot, cwd } = await gitRepository(
      'praxis-agent-admission-failure-',
    )
    const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    let providerCalls = 0
    const executor = new ClaudeSubagentExecutor({
      configRoot,
      dataPlane: 'native',
      cwd,
      claudeVersion: '2.1.208',
      provider: {
        capabilities: { streaming: true, usage: true, tools: true },
        async *complete() {
          providerCalls += 1
          yield { type: 'text-delta', delta: 'UNREACHABLE' }
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
    const call = await registry.prepare(
      {
        id: 'call_rejected_background_agent',
        name: 'Agent',
        input: {
          description: 'Rejected background Agent',
          prompt: 'Do not start',
          subagent_type: 'general-purpose',
          isolation: 'worktree',
          run_in_background: true,
        },
      },
      { cwd },
    )
    await executor.close()

    await expect(registry.execute(call, { cwd })).rejects.toThrow(
      'Background agent manager is closed',
    )
    expect(providerCalls).toBe(0)

    const paths = resolveDataPlanePaths({
      dataPlane: 'native',
      root: configRoot,
      cwd,
      sessionId,
    })
    const lifecycleDirectory = join(
      paths.praxisRoot,
      'subagent-lifecycle',
      sessionId,
    )
    const lifecycleFiles = (await readdir(lifecycleDirectory)).filter((file) =>
      file.endsWith('.json'),
    )
    expect(lifecycleFiles).toHaveLength(1)
    const lifecyclePath = join(lifecycleDirectory, lifecycleFiles[0] ?? '')
    expect(JSON.parse(await readFile(lifecyclePath, 'utf8'))).toMatchObject({
      version: 2,
      lifecycle: { state: 'failed', revision: 1 },
      detail: 'Background agent launch was rejected before execution started',
    })
    await expect(stat(`${lifecyclePath}.owner.lock`)).rejects.toMatchObject({
      code: 'ENOENT',
    })

    const subagentDirectory = join(paths.projectRoot, sessionId, 'subagents')
    const metadataFile = (await readdir(subagentDirectory)).find((file) =>
      file.endsWith('.meta.json'),
    )
    expect(metadataFile).toEqual(expect.any(String))
    const metadata = JSON.parse(
      await readFile(join(subagentDirectory, metadataFile ?? ''), 'utf8'),
    ) as { worktreePath?: string }
    expect(metadata.worktreePath).toEqual(expect.any(String))
    await expect(stat(metadata.worktreePath ?? '')).resolves.toBeDefined()
    await expect(
      readFile(
        join(
          subagentDirectory,
          (metadataFile ?? '').replace(/\.meta\.json$/u, '.jsonl'),
        ),
        'utf8',
      ),
    ).resolves.toContain('Do not start')
  })

  it('preserves the primary failure and recovers after unfinished release diagnostics', async () => {
    const { configRoot, cwd } = await gitRepository(
      'praxis-agent-unfinished-release-',
    )
    const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const promptId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const events: RuntimeEvent[] = []
    let initialProviderCalls = 0
    const interrupted = new ClaudeSubagentExecutor({
      configRoot,
      dataPlane: 'native',
      cwd,
      claudeVersion: '2.1.208',
      provider: {
        capabilities: { streaming: true, usage: true, tools: true },
        async *complete() {
          initialProviderCalls += 1
          yield { type: 'text-delta', delta: 'UNREACHABLE' }
        },
      },
      baseTools: emptyTools,
      permissions: { resolve: () => ({ behavior: 'allow' }) },
      eventSink: (event) => events.push(event),
    })
    const registry = interrupted.registry(sessionId, 0, () => promptId)
    const originalRelease = SubagentExecution.prototype.release
    const runningSpy = vi
      .spyOn(SubagentExecution.prototype, 'running')
      .mockRejectedValueOnce(new Error('primary lifecycle setup failure'))
    const releaseSpy = vi
      .spyOn(SubagentExecution.prototype, 'release')
      .mockImplementationOnce(async function (this: SubagentExecution) {
        await originalRelease.call(this)
        throw new Error('injected release diagnostic')
      })
    let agentId = ''
    try {
      const launched = await registry.execute(
        await registry.prepare(
          {
            id: 'call_unfinished_release',
            name: 'Agent',
            input: {
              description: 'Recover unfinished release',
              prompt: 'Start once',
              subagent_type: 'general-purpose',
              run_in_background: true,
            },
          },
          { cwd },
        ),
        { cwd },
      )
      agentId = String(launched.nativeToolUseResult?.agentId)
      const failed = await registry.execute(
        await registry.prepare(
          {
            id: 'call_unfinished_output',
            name: 'TaskOutput',
            input: { task_id: agentId, block: true, timeout: 30_000 },
          },
          { cwd },
        ),
        { cwd },
      )
      expect(failed.content).toContain('<status>interrupted</status>')
      expect(failed.content).toContain('primary lifecycle setup failure')
      expect(failed.content).not.toContain('injected release diagnostic')
      expect(initialProviderCalls).toBe(0)
      expect(events).toContainEqual({
        type: 'warning',
        message: expect.stringContaining(
          'durable owner reconciliation is required: injected release diagnostic',
        ),
      })
    } finally {
      runningSpy.mockRestore()
      releaseSpy.mockRestore()
    }

    const paths = resolveDataPlanePaths({
      dataPlane: 'native',
      root: configRoot,
      cwd,
      sessionId,
    })
    const lifecycleStore = new SubagentLifecycleStore(
      paths.praxisRoot,
      sessionId,
      agentId,
    )
    await expect(lifecycleStore.read()).resolves.toMatchObject({
      lifecycle: { generation: 1, state: 'orphaned' },
    })

    let recoveryProviderCalls = 0
    const recovered = new ClaudeSubagentExecutor({
      configRoot,
      dataPlane: 'native',
      cwd,
      claudeVersion: '2.1.208',
      provider: {
        capabilities: { streaming: true, usage: true, tools: true },
        async *complete() {
          recoveryProviderCalls += 1
          yield { type: 'text-delta', delta: 'RECOVERED_RESULT' }
        },
      },
      baseTools: emptyTools,
      permissions: { resolve: () => ({ behavior: 'allow' }) },
    })
    const recoveredRegistry = recovered.registry(sessionId, 0, () => promptId)
    const sent = await recoveredRegistry.execute(
      await recoveredRegistry.prepare(
        {
          id: 'call_recover_unfinished',
          name: 'SendMessage',
          input: {
            to: agentId,
            message: 'Recover with a fresh owner',
          },
        },
        { cwd },
      ),
      { cwd },
    )
    expect(sent.content).toContain('"success":true')
    const output = await recoveredRegistry.execute(
      await recoveredRegistry.prepare(
        {
          id: 'call_recovered_output',
          name: 'TaskOutput',
          input: { task_id: agentId, block: true, timeout: 30_000 },
        },
        { cwd },
      ),
      { cwd },
    )
    expect(output.content).toContain('RECOVERED_RESULT')
    expect(recoveryProviderCalls).toBe(1)
    await expect(lifecycleStore.read()).resolves.toMatchObject({
      lifecycle: { generation: 2, state: 'completed' },
      result: { text: 'RECOVERED_RESULT' },
    })
  })

  it('retains a real worktree when native sidechain setup fails', async () => {
    const { configRoot, cwd } = await gitRepository(
      'praxis-agent-setup-failure-retention-',
    )
    const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const promptId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    let providerCalls = 0
    const paths = resolveDataPlanePaths({
      dataPlane: 'native',
      root: configRoot,
      cwd,
      sessionId,
    })
    const hookCalls: Record<string, unknown>[] = []
    const hooks = new ClaudeHookRunner({
      settings: [
        {
          path: '/project.json',
          scope: 'project',
          value: {
            hooks: {
              WorktreeCreate: [
                {
                  matcher: 'agent',
                  hooks: [{ type: 'command', command: 'agent-create' }],
                },
              ],
            },
          },
        },
      ],
      cwd,
      executeCommand: async (command, input) => {
        hookCalls.push({ command, ...input })
        if (command === 'agent-create') {
          const owner = parseAgentWorktreeOwner(String(input.owner_id))
          if (!owner || typeof input.worktree_path !== 'string')
            throw new Error('invalid Agent hook input')
          const subagents = join(paths.projectRoot, sessionId, 'subagents')
          await mkdir(subagents, { recursive: true })
          await writeFile(
            join(subagents, `agent-${owner.agentId}.meta.json`),
            'occupied\n',
          )
        }
        return { stdout: '', stderr: '', exitCode: 0, durationMs: 1 }
      },
    })
    const executor = new ClaudeSubagentExecutor({
      configRoot,
      dataPlane: 'native',
      cwd,
      claudeVersion: '2.1.208',
      provider: {
        capabilities: { streaming: true, usage: true, tools: true },
        async *complete() {
          providerCalls += 1
          yield { type: 'text-delta', delta: 'UNREACHABLE' }
        },
      },
      baseTools: emptyTools,
      permissions: { resolve: () => ({ behavior: 'allow' }) },
      hooks,
    })
    const registry = executor.registry(sessionId, 0, () => promptId)
    const call = await registry.prepare(
      {
        id: 'call_setup_failure',
        name: 'Agent',
        input: {
          description: 'Setup failure',
          prompt: 'Must not run',
          subagent_type: 'general-purpose',
          isolation: 'worktree',
          run_in_background: true,
        },
      },
      { cwd },
    )
    await expect(registry.execute(call, { cwd })).rejects.toThrow(/EEXIST/u)
    expect(providerCalls).toBe(0)
    expect(hookCalls).toHaveLength(1)
    expect(hookCalls[0]).toMatchObject({
      worktree_kind: 'agent',
      hook_event_name: 'WorktreeCreate',
    })

    const lifecycleDirectory = join(
      paths.praxisRoot,
      'subagent-lifecycle',
      sessionId,
    )
    const lifecycleFiles = (await readdir(lifecycleDirectory)).filter((file) =>
      file.endsWith('.json'),
    )
    expect(lifecycleFiles).toHaveLength(1)
    const lifecyclePath = join(lifecycleDirectory, lifecycleFiles[0] ?? '')
    const lifecycleRecord = JSON.parse(await readFile(lifecyclePath, 'utf8'))
    expect(lifecycleRecord).toMatchObject({
      version: 2,
      lifecycle: { state: 'failed', revision: 1 },
      detail: expect.stringContaining('EEXIST'),
      result: {
        text: expect.stringContaining('EEXIST'),
      },
    })
    const registryDirectory = join(
      paths.praxisRoot,
      'managed-worktrees',
      sanitizeProjectPath(await realpath(cwd)),
    )
    const records = (await readdir(registryDirectory)).filter((file) =>
      file.endsWith('.json'),
    )
    expect(records).toHaveLength(1)
    const record = JSON.parse(
      await readFile(join(registryDirectory, records[0] ?? ''), 'utf8'),
    ) as { state: string; worktreePath: string }
    expect(record.state).toBe('retained')
    await expect(stat(record.worktreePath)).resolves.toBeDefined()
    const reconciliation = await reconcileManagedWorktrees({
      cwd,
      stateRoot: paths.praxisRoot,
    })
    expect(reconciliation.entries).toContainEqual(
      expect.objectContaining({ disposition: 'retained' }),
    )
    await executor.close()
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

  it('retains project agent memory under .praxis', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-agent-memory-compat-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const memoryDirectory = join(cwd, '.praxis', 'agent-memory', 'rememberer')
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
      'native',
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
      dataPlane: 'native',
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
      dataPlane: 'native',
      sessionPersistence: true,
      experimentalNativeTranscriptWrites: true,
      claudeVersion: '2.1.208',
      provider,
      tools: emptyTools,
      permissions: { resolve: () => ({ behavior: 'allow' }) },
      enableSubagents: true,
    })

    const result = await service.run('Try background.')

    expect(result.text).toBe('BACKGROUND_MAIN_DONE')
    const paths = resolveDataPlanePaths({
      dataPlane: 'native',
      root: configRoot,
      cwd,
      sessionId: result.sessionId,
    })
    const mainEntries = entries(await readFile(paths.sessionFile, 'utf8'))
    const source = JSON.stringify(mainEntries)
    expect(source).toContain('call_background')
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

  it('exposes ApplyPatch to background general-purpose agents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-background-agent-tools-'))
    roots.push(root)
    const requests: ModelRequest[] = []
    let launched = false
    const provider: ModelProvider = {
      capabilities: { streaming: true, usage: true, tools: true },
      async *complete(request) {
        requests.push(request)
        const source = JSON.stringify(request.messages)
        const child = source.includes('general-purpose subagent')
        if (child) {
          yield { type: 'text-delta', delta: 'BACKGROUND_TOOLS_DONE' }
        } else if (!launched) {
          launched = true
          yield {
            type: 'tool-call',
            call: {
              id: 'call_background_tools',
              name: 'Agent',
              input: {
                description: 'Inspect tools',
                prompt: 'Inspect tools',
                subagent_type: 'general-purpose',
                run_in_background: true,
              },
            },
          }
        } else {
          yield { type: 'text-delta', delta: 'BACKGROUND_TOOLS_MAIN_DONE' }
        }
      },
    }
    const tools: ToolRegistry = {
      definitions: () =>
        ['Read', 'ApplyPatch', 'Bash'].map((name) => ({
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
      enableSubagents: true,
    })

    expect((await service.run('Launch a background tools check.')).text).toBe(
      'BACKGROUND_TOOLS_MAIN_DONE',
    )
    const childRequest = requests.find((request) =>
      JSON.stringify(request.messages).includes('general-purpose subagent'),
    )
    const childTools = childRequest?.tools?.map(({ name }) => name) ?? []
    expect(childTools).toContain('ApplyPatch')
    expect(childTools).not.toContain('Agent')
  })

  it('keeps explicit custom-agent tool restrictions in background runs', async () => {
    const root = await mkdtemp(
      join(tmpdir(), 'praxis-background-custom-tools-'),
    )
    roots.push(root)
    const requests: ModelRequest[] = []
    let launched = false
    const provider: ModelProvider = {
      capabilities: { streaming: true, usage: true, tools: true },
      async *complete(request) {
        requests.push(request)
        const source = JSON.stringify(request.messages)
        const child = source.includes('CUSTOM_BACKGROUND_POLICY')
        if (child) {
          yield { type: 'text-delta', delta: 'CUSTOM_BACKGROUND_DONE' }
        } else if (!launched) {
          launched = true
          yield {
            type: 'tool-call',
            call: {
              id: 'call_custom_background',
              name: 'Agent',
              input: {
                description: 'Restricted tools',
                prompt: 'Inspect tools',
                subagent_type: 'restricted-background',
                run_in_background: true,
              },
            },
          }
        } else {
          yield { type: 'text-delta', delta: 'CUSTOM_BACKGROUND_MAIN_DONE' }
        }
      },
    }
    const tools: ToolRegistry = {
      definitions: () =>
        ['Read', 'ApplyPatch', 'Bash'].map((name) => ({
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
    const extensions = new ClaudeExtensionCatalog({
      commands: [],
      skills: [],
      agents: [
        {
          path: join(root, 'config', 'agents', 'restricted-background.md'),
          scope: 'user',
          content:
            '---\nname: restricted-background\ndescription: Restricted background agent.\ntools: [Read]\n---\nCUSTOM_BACKGROUND_POLICY',
        },
      ],
    })
    const service = new ClaudeSessionService({
      configRoot: join(root, 'config'),
      cwd: join(root, 'project'),
      claudeVersion: '2.1.208',
      provider,
      tools,
      permissions: { resolve: () => ({ behavior: 'allow' }) },
      extensions,
      enableSubagents: true,
    })

    expect(
      (await service.run('Launch a restricted background check.')).text,
    ).toBe('CUSTOM_BACKGROUND_MAIN_DONE')
    const childRequest = requests.find((request) =>
      JSON.stringify(request.messages).includes('CUSTOM_BACKGROUND_POLICY'),
    )
    const childTools = childRequest?.tools?.map(({ name }) => name) ?? []
    expect(childTools).toContain('Read')
    expect(childTools).not.toContain('ApplyPatch')
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
      dataPlane: 'native',
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
    const paths = resolveDataPlanePaths({
      dataPlane: 'native',
      root: configRoot,
      cwd,
      sessionId,
    })
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
      dataPlane: 'native',
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
      dataPlane: 'native',
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
    expect(sidechain.match(/"toolCallId":"call_once"/gu) ?? []).toHaveLength(1)
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
      dataPlane: 'native',
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
      dataPlane: 'native',
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
    const messages = await collect()
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
      dataPlane: 'native',
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
    const paths = resolveDataPlanePaths({
      dataPlane: 'native',
      root: configRoot,
      cwd,
      sessionId,
    })
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
      dataPlane: 'native',
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
    const paths = resolveDataPlanePaths({
      dataPlane: 'native',
      root: configRoot,
      cwd,
      sessionId,
    })
    for (const agentId of agentIds) {
      await expect(
        new SubagentLifecycleStore(paths.praxisRoot, sessionId, agentId).read(),
      ).resolves.toMatchObject({ status: 'killed' })
    }
  })

  it('observes an immediate cancellation transition rejection while provider work is pending', async () => {
    const { configRoot, cwd } = await gitRepository(
      'praxis-agent-cancellation-rejection-',
    )
    const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    let started!: () => void
    const providerStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    let observedAbort!: () => void
    const abortObserved = new Promise<void>((resolve) => {
      observedAbort = resolve
    })
    let releaseProvider!: () => void
    const providerRelease = new Promise<void>((resolve) => {
      releaseProvider = resolve
    })
    const executor = new ClaudeSubagentExecutor({
      configRoot,
      dataPlane: 'native',
      cwd,
      claudeVersion: '2.1.208',
      provider: {
        capabilities: { streaming: true, usage: true, tools: false },
        async *complete(request) {
          yield* []
          started()
          request.signal?.addEventListener('abort', observedAbort, {
            once: true,
          })
          await providerRelease
          yield { type: 'text-delta', delta: 'UNREACHABLE' }
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
    await registry.execute(
      await registry.prepare(
        {
          id: 'call_rejecting_cancel',
          name: 'Agent',
          input: {
            description: 'Reject cancellation transition',
            prompt: 'WAIT_CANCEL_REJECTION',
            run_in_background: true,
          },
        },
        { cwd },
      ),
      { cwd },
    )
    await providerStarted
    const agentId = executor.backgroundSnapshots()[0]?.agentId
    if (!agentId) throw new Error('Expected background agent')
    const beginCancellation = vi
      .spyOn(SubagentExecution.prototype, 'beginCancellation')
      .mockRejectedValueOnce(new Error('injected cancellation transition'))
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)
    try {
      expect(executor.stopAllBackgroundTasks()).toEqual([agentId])
      await abortObserved
      expect(beginCancellation).toHaveBeenCalledOnce()
      await Promise.resolve()
      expect(unhandled).toEqual([])
      releaseProvider()
      await expect(
        executor.outputBackgroundTask(agentId, {
          block: true,
          timeout: 30_000,
        }),
      ).resolves.toContain('<status>interrupted</status>')
    } finally {
      process.off('unhandledRejection', onUnhandled)
      beginCancellation.mockRestore()
      await executor.close()
    }
  })

  it('retains and restores a real orphaned managed Agent checkout before continuation', async () => {
    const { configRoot, cwd } = await gitRepository(
      'praxis-agent-managed-crash-restore-',
    )
    const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const agentId = 'a0123456789abcdef'
    const paths = resolveDataPlanePaths({
      dataPlane: 'native',
      root: configRoot,
      cwd,
      sessionId,
    })
    const transcriptPath = join(
      paths.projectRoot,
      sessionId,
      'subagents',
      `agent-${agentId}.jsonl`,
    )
    const lifecycleStore = new SubagentLifecycleStore(
      paths.praxisRoot,
      sessionId,
      agentId,
      transcriptPath,
    )
    const execution = await lifecycleStore.start()
    await execution.running()
    const worktree = await createAgentWorktree({
      cwd,
      stateRoot: paths.praxisRoot,
      sessionId,
      agentId,
      executionToken: execution.token,
    })
    await seedIncompleteIsolatedSidechain({
      configRoot,
      cwd,
      sessionId,
      agentId,
      worktreePath: worktree.cwd,
      name: 'managed-crash-agent',
    })
    await execution.release()

    const registryDirectory = join(
      paths.praxisRoot,
      'managed-worktrees',
      sanitizeProjectPath(await realpath(cwd)),
    )
    const recordFile = (await readdir(registryDirectory)).find((file) =>
      file.endsWith('.json'),
    )
    if (!recordFile) throw new Error('Managed Agent record is missing')
    const record = JSON.parse(
      await readFile(join(registryDirectory, recordFile), 'utf8'),
    ) as { worktreeId: string }
    const managedStore = new ManagedWorktreeStore(
      paths.praxisRoot,
      await realpath(cwd),
      record.worktreeId,
    )
    await rm(managedStore.lockPath, { force: true })

    const reconciliation = await reconcileManagedWorktrees({
      cwd,
      stateRoot: paths.praxisRoot,
    })
    expect(reconciliation.entries).toContainEqual(
      expect.objectContaining({
        worktreeId: record.worktreeId,
        disposition: 'retained',
      }),
    )
    await expect(stat(worktree.cwd)).resolves.toBeDefined()
    expect(
      (
        await JSON.parse(
          await readFile(join(registryDirectory, recordFile), 'utf8'),
        )
      ).state,
    ).toBe('retained')

    const registeredBeforeContinuation = (
      await execFileAsync('git', ['-C', cwd, 'worktree', 'list', '--porcelain'])
    ).stdout
    expect(
      registeredBeforeContinuation
        .split('\n')
        .filter((line) => line === `worktree ${worktree.cwd}`),
    ).toHaveLength(1)

    const observedCwds: string[] = []
    const resumed = new ClaudeSubagentExecutor({
      configRoot,
      dataPlane: 'native',
      cwd,
      claudeVersion: '2.1.208',
      provider: {
        capabilities: { streaming: true, usage: true, tools: false },
        async *complete() {
          yield { type: 'text-delta', delta: 'MANAGED_CRASH_RESTORED' }
        },
      },
      baseTools: emptyTools,
      permissions: { resolve: () => ({ behavior: 'allow' }) },
      contextAssembler: {
        async assemble(options) {
          observedCwds.push(options?.cwd ?? '')
          return contextSnapshot()
        },
      },
    })
    try {
      await resumed.hydratePersistedTasks(sessionId, cwd)
      const registry = resumed.registry(
        sessionId,
        0,
        () => 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      )
      await registry.execute(
        await registry.prepare(
          {
            id: 'call_managed_crash_send',
            name: 'SendMessage',
            input: { to: agentId, message: 'Continue managed crash recovery' },
          },
          { cwd },
        ),
        { cwd },
      )
      const output = await registry.execute(
        await registry.prepare(
          {
            id: 'call_managed_crash_output',
            name: 'TaskOutput',
            input: { task_id: agentId, block: true, timeout: 30_000 },
          },
          { cwd },
        ),
        { cwd },
      )
      expect(output.content).toContain('MANAGED_CRASH_RESTORED')
      expect(observedCwds).toEqual([worktree.cwd])
      await expect(stat(worktree.cwd)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(
        (
          await JSON.parse(
            await readFile(join(registryDirectory, recordFile), 'utf8'),
          )
        ).state,
      ).toBe('released')
    } finally {
      await resumed.close()
      await worktree.cleanup()
    }
  })

  it('recovers an orphaned lifecycle over a completed sidechain without replay', async () => {
    const { configRoot, cwd } = await gitRepository(
      'praxis-background-resume-test-',
    )
    const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const providerRequests: string[] = []
    const provider = (text: string): ModelProvider => ({
      model: 'fixture-model',
      capabilities: { streaming: true, usage: true, tools: true },
      async *complete() {
        providerRequests.push(text)
        yield { type: 'text-delta', delta: text }
        yield {
          type: 'usage',
          usage: { inputTokens: 2, outputTokens: 1 },
        }
      },
    })
    const options = {
      configRoot,
      dataPlane: 'native' as const,
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
    expect(providerRequests).toEqual(['FIRST_RESULT'])

    const crashPaths = resolveDataPlanePaths({
      dataPlane: 'native',
      root: configRoot,
      cwd,
      sessionId,
    })
    const crashLifecycleStore = new SubagentLifecycleStore(
      crashPaths.praxisRoot,
      sessionId,
      agentId,
      join(
        crashPaths.projectRoot,
        sessionId,
        'subagents',
        `agent-${agentId}.jsonl`,
      ),
    )
    const abandoned = await crashLifecycleStore.continue()
    await abandoned.running()
    const crashTranscriptPath = join(
      crashPaths.projectRoot,
      sessionId,
      'subagents',
      `agent-${agentId}.jsonl`,
    )
    const crashTranscript = await readFile(crashTranscriptPath, 'utf8')
    const crashEntries = entries(crashTranscript)
    const previous = crashEntries.at(-1)
    if (!previous) throw new Error('Expected completed sidechain entry')
    const previousEvent = previous.event
    if (!previousEvent || typeof previousEvent !== 'object')
      throw new Error('Expected native sidechain event')
    const previousEventRecord = previousEvent as Record<string, unknown>
    const crashWindowEntry = {
      schema: 'praxis.transcript',
      version: 1,
      event: {
        ...previousEventRecord,
        id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        parentId: previousEventRecord.id,
        messages: [
          {
            role: 'assistant',
            content: 'CRASH_WINDOW_RESULT',
          },
        ],
      },
    }
    await writeFile(
      crashTranscriptPath,
      `${crashTranscript}${JSON.stringify(crashWindowEntry)}\n`,
    )
    await abandoned.release()
    await expect(crashLifecycleStore.read()).resolves.toMatchObject({
      lifecycle: { generation: 2, state: 'orphaned' },
    })
    const orphanedAfterCrashWindow = await crashLifecycleStore.read()
    if (!orphanedAfterCrashWindow)
      throw new Error('Expected orphaned lifecycle after crash window')
    await expect(
      crashLifecycleStore.matchesTranscript(orphanedAfterCrashWindow),
    ).resolves.toBe(false)

    const recoveryEvents: RuntimeEvent[] = []
    const resumed = new ClaudeSubagentExecutor({
      ...options,
      provider: provider('SECOND_RESULT'),
      eventSink: (event) => recoveryEvents.push(event),
    })
    const resumedRegistry = resumed.registry(sessionId, 0, () => promptId)
    expect(providerRequests).toEqual(['FIRST_RESULT'])
    const interruptedOutput = await resumedRegistry.execute(
      await resumedRegistry.prepare(
        {
          id: 'call_output_during_crash_window',
          name: 'TaskOutput',
          input: { task_id: agentId, block: false, timeout: 0 },
        },
        { cwd },
      ),
      { cwd },
    )
    expect(interruptedOutput.content).toContain('<status>interrupted</status>')
    expect(interruptedOutput.content).toContain('CRASH_WINDOW_RESULT')
    expect(providerRequests).toEqual(['FIRST_RESULT'])
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
    expect(providerRequests).toEqual(['FIRST_RESULT', 'SECOND_RESULT'])
    const recoveredLifecycle = await crashLifecycleStore.read()
    expect(recoveredLifecycle).toMatchObject({
      lifecycle: { generation: 3, state: 'completed' },
    })
    const recoveredTranscript = await readFile(crashTranscriptPath, 'utf8')
    expect(recoveredTranscript.match(/FIRST_RESULT/gu)).toHaveLength(1)
    expect(recoveredTranscript.match(/CRASH_WINDOW_RESULT/gu)).toHaveLength(1)
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

    const paths = resolveDataPlanePaths({
      dataPlane: 'native',
      root: configRoot,
      cwd,
      sessionId,
    })
    const lifecycleStore = new SubagentLifecycleStore(
      paths.praxisRoot,
      sessionId,
      agentId,
      join(paths.projectRoot, sessionId, 'subagents', `agent-${agentId}.jsonl`),
    )
    const deliveredId = '99999999-9999-4999-8999-999999999999'
    await persistTerminal(
      lifecycleStore,
      'completed',
      undefined,
      {
        text: 'SECOND_RESULT',
        usage: { inputTokens: 2, outputTokens: 1 },
        toolUseCount: 0,
        durationMs: 1,
      },
      {
        id: deliveredId,
        status: 'completed',
        toolUseId: 'call_already_appended',
        error: null,
      },
    )
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
    await persistTerminal(
      lifecycleStore,
      'completed',
      undefined,
      {
        text: 'SECOND_RESULT',
        usage: { inputTokens: 2, outputTokens: 1 },
        toolUseCount: 0,
        durationMs: 1,
      },
      {
        id: pendingId,
        status: 'completed',
        toolUseId: 'call_pending_after_restart',
        error: null,
      },
    )
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
    expect(source.match(/FIRST_RESULT/gu)).toHaveLength(1)
    const nativeEntries = entries(source)
    expect(
      nativeEntries.every((entry) => entry.schema === 'praxis.transcript'),
    ).toBe(true)
    expect(
      new Set(
        nativeEntries.map((entry) =>
          String((entry.event as Record<string, unknown>).id),
        ),
      ).size,
    ).toBe(nativeEntries.length)
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
      dataPlane: 'native' as const,
      cwd: configuredCwd,
      cwdProvider: () => liveCwd,
      claudeVersion: '2.1.237',
      baseTools: emptyTools,
      permissions: { resolve: () => ({ behavior: 'allow' as const }) },
      contextAssembler: {
        async assemble(context?: { cwd?: string }) {
          observedCwds.push(context?.cwd ?? '')
          return contextSnapshot()
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
    const paths = resolveDataPlanePaths({
      dataPlane: 'native',
      root: configRoot,
      cwd: spawnCwd,
      sessionId,
    })
    const sidechainPath = join(
      paths.projectRoot,
      sessionId,
      'subagents',
      `agent-${agentId}.jsonl`,
    )
    expect(
      JSON.parse(
        await readFile(
          join(dirname(sidechainPath), `agent-${agentId}.meta.json`),
          'utf8',
        ),
      ).cwd,
    ).toBe(spawnCwd)

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
    const agentId = 'a0123456789abcdef'
    const promptId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const paths = resolveDataPlanePaths({
      dataPlane: 'native',
      root: configRoot,
      cwd,
      sessionId,
    })
    const directory = join(paths.projectRoot, sessionId, 'subagents')
    await mkdir(directory, { recursive: true })
    const nativeSidechain = new NativeSidechainTranscript({
      sessionId,
      agentId,
      directory,
      transcriptFile: join(directory, `agent-${agentId}.jsonl`),
      metadataFile: join(directory, `agent-${agentId}.meta.json`),
      lockFile: join(paths.praxisRoot, 'locks', `${sessionId}-${agentId}.lock`),
    })
    await nativeSidechain.create('INTERRUPTED_ROOT', {
      agentType: 'general-purpose',
      description: 'Interrupted fixture',
      toolUseId: 'call_origin',
      spawnDepth: 1,
      cwd,
      promptId,
      name: 'interrupted-reviewer',
    })
    await nativeSidechain.withLease(async (lease) => {
      await lease.appendMessages({
        messages: [
          {
            role: 'assistant',
            content: '',
            toolCalls: [
              { id: 'call_complete', name: 'Read', input: {} },
              { id: 'call_dangling', name: 'Read', input: {} },
            ],
          },
        ],
      })
      await lease.beginToolExecution('call_complete')
      await lease.appendToolCompletion({
        callId: 'call_complete',
        result: { content: 'ORIGINAL_RESULT', isError: false },
      })
    })
    const requests: ModelRequest[] = []
    const executor = new ClaudeSubagentExecutor({
      configRoot,
      dataPlane: 'native',
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

  it('hydrates and continues an incomplete canonical native sidechain without replaying dangling tools', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-native-agent-resume-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    await mkdir(cwd, { recursive: true })
    const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const agentId = 'a0123456789abcdef'
    const promptId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const paths = resolveDataPlanePaths({
      dataPlane: 'native',
      root: configRoot,
      cwd,
      sessionId,
    })
    const directory = join(paths.projectRoot, sessionId, 'subagents')
    const transcriptFile = join(directory, `agent-${agentId}.jsonl`)
    const nativeSidechain = new NativeSidechainTranscript({
      sessionId,
      agentId,
      directory,
      transcriptFile,
      metadataFile: join(directory, `agent-${agentId}.meta.json`),
      lockFile: join(paths.praxisRoot, 'locks', `${sessionId}-${agentId}.lock`),
    })
    await nativeSidechain.create('NATIVE_INTERRUPTED_ROOT', {
      agentType: 'general-purpose',
      description: 'Native interrupted fixture',
      toolUseId: 'call_native_origin',
      spawnDepth: 1,
      cwd,
      promptId,
      name: 'native-interrupted-reviewer',
    })
    await nativeSidechain.withLease(async (lease) => {
      await lease.appendMessages({
        messages: [
          {
            role: 'assistant',
            content: '',
            toolCalls: [
              { id: 'native-complete', name: 'Read', input: {} },
              { id: 'native-dangling', name: 'Read', input: {} },
            ],
          },
        ],
      })
      await lease.beginToolExecution('native-complete')
      await lease.appendToolCompletion({
        callId: 'native-complete',
        result: { content: 'NATIVE_COMPLETED_RESULT', isError: false },
      })
    })
    const requests: ModelRequest[] = []
    const executor = new ClaudeSubagentExecutor({
      configRoot,
      dataPlane: 'native',
      cwd,
      claudeVersion: '2.1.208',
      persistence: 'disk',
      experimentalNativeTranscriptWrites: true,
      provider: {
        model: 'native-resume-model',
        capabilities: { streaming: true, usage: true, tools: true },
        async *complete(request) {
          requests.push(request)
          yield { type: 'text-delta', delta: 'NATIVE_RESUMED_RESULT' }
          yield {
            type: 'usage',
            usage: { inputTokens: 2, outputTokens: 1 },
          }
        },
      },
      baseTools: emptyTools,
      permissions: { resolve: () => ({ behavior: 'allow' }) },
    })
    const registry = executor.registry(sessionId, 0, () => promptId)

    const interrupted = await registry.execute(
      await registry.prepare(
        {
          id: 'native_interrupted_output',
          name: 'TaskOutput',
          input: { task_id: agentId, block: false, timeout: 0 },
        },
        { cwd },
      ),
      { cwd },
    )
    expect(interrupted.content).toContain('<status>interrupted</status>')
    expect(requests).toHaveLength(0)
    await registry.execute(
      await registry.prepare(
        {
          id: 'native_interrupted_message',
          name: 'SendMessage',
          input: {
            to: 'native-interrupted-reviewer',
            summary: 'resume native interrupted fixture',
            message: 'NATIVE_CONTINUE_ONCE',
          },
        },
        { cwd },
      ),
      { cwd },
    )
    const output = await registry.execute(
      await registry.prepare(
        {
          id: 'native_interrupted_done',
          name: 'TaskOutput',
          input: { task_id: agentId, block: true, timeout: 30_000 },
        },
        { cwd },
      ),
      { cwd },
    )
    expect(output.content).toContain('NATIVE_RESUMED_RESULT')
    expect(requests).toHaveLength(1)
    const resumedContext = JSON.stringify(requests[0]?.messages)
    expect(resumedContext).toContain('RECONSTRUCTED_RESULT')
    expect(resumedContext).toContain('NATIVE_CONTINUE_ONCE')
    expect(resumedContext).not.toContain('native-dangling')
    expect(resumedContext.match(/NATIVE_CONTINUE_ONCE/gu) ?? []).toHaveLength(1)
    const source = await readFile(transcriptFile, 'utf8')
    expect(source).toContain('"schema":"praxis.transcript"')
    expect(source.match(/NATIVE_CONTINUE_ONCE/gu)).toHaveLength(1)
    await executor.close()
  })

  it('fails closed without mutation for a legacy Claude-shaped sidechain under the native root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-native-agent-legacy-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const agentId = 'a0123456789abcdef'
    const promptId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const paths = resolveDataPlanePaths({
      dataPlane: 'native',
      root: configRoot,
      cwd,
      sessionId,
    })
    const directory = join(paths.projectRoot, sessionId, 'subagents')
    await mkdir(directory, { recursive: true })
    const transcriptFile = join(directory, `agent-${agentId}.jsonl`)
    const metadataFile = join(directory, `agent-${agentId}.meta.json`)
    const legacySource = `${JSON.stringify({
      type: 'user',
      isSidechain: true,
      agentId,
      sessionId,
      promptId,
      parentUuid: null,
      uuid: '11111111-1111-4111-8111-111111111111',
      timestamp: '2026-08-24T00:00:00.000Z',
      cwd,
      version: '2.1.208',
      message: { role: 'user', content: 'LEGACY_NATIVE_ROOT' },
    })}\n`
    const metadataSource = `${JSON.stringify({
      agentType: 'general-purpose',
      description: 'Legacy native-root fixture',
      toolUseId: 'call_legacy_native',
      spawnDepth: 1,
      cwd,
      promptId,
      name: 'legacy-native-reviewer',
    })}\n`
    await Promise.all([
      writeFile(transcriptFile, legacySource),
      writeFile(metadataFile, metadataSource),
    ])
    const executor = new ClaudeSubagentExecutor({
      configRoot,
      dataPlane: 'native',
      cwd,
      claudeVersion: '2.1.208',
      persistence: 'disk',
      experimentalNativeTranscriptWrites: true,
      provider: {
        capabilities: { streaming: true, usage: true, tools: false },
        async *complete() {
          yield { type: 'text-delta', delta: 'must not run' }
        },
      },
      baseTools: emptyTools,
      permissions: { resolve: () => ({ behavior: 'allow' }) },
    })
    const registry = executor.registry(sessionId, 0, () => promptId)

    await expect(
      registry.execute(
        await registry.prepare(
          {
            id: 'legacy_native_output',
            name: 'TaskOutput',
            input: { task_id: agentId, block: false, timeout: 0 },
          },
          { cwd },
        ),
        { cwd },
      ),
    ).rejects.toThrow(/Invalid native sidechain transcript/)
    await expect(readFile(transcriptFile, 'utf8')).resolves.toBe(legacySource)
    await expect(readFile(metadataFile, 'utf8')).resolves.toBe(metadataSource)
    await executor.close()
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
        persistedStatus === 'failed' ? 'a1111111111111111' : 'a2222222222222222'
      const promptId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
      const paths = resolveDataPlanePaths({
        dataPlane: 'native',
        root: configRoot,
        cwd,
        sessionId,
      })
      const directory = join(paths.projectRoot, sessionId, 'subagents')
      await mkdir(directory, { recursive: true })
      await writeFile(
        join(directory, `agent-${agentId}.jsonl`),
        nativeEnvelope(
          sessionId,
          '11111111-1111-4111-8111-111111111111',
          null,
          [{ role: 'user', content: 'TERMINAL_ROOT' }],
          '2026-08-23T00:00:00.000Z',
        ),
      )
      await writeFile(
        join(directory, `agent-${agentId}.meta.json`),
        `${JSON.stringify({
          agentType: 'general-purpose',
          description: `${persistedStatus} fixture`,
          toolUseId: `call_${persistedStatus}_origin`,
          spawnDepth: 1,
          cwd,
          promptId,
          model: 'recovery-model',
          name: `${persistedStatus}-reviewer`,
        })}\n`,
      )
      const persistedStore = new SubagentLifecycleStore(
        paths.praxisRoot,
        sessionId,
        agentId,
      )
      await persistTerminal(
        persistedStore,
        persistedStatus === 'killed' ? 'cancelled' : 'failed',
        `${persistedStatus} before restart`,
      )
      let requests = 0
      const providerModels: (string | undefined)[] = []
      const executor = new ClaudeSubagentExecutor({
        configRoot,
        dataPlane: 'native',
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
        providerForTurn: vi.fn((model?: string): ModelProvider => {
          providerModels.push(model)
          return {
            model: model ?? 'fixture-model',
            capabilities: { streaming: true, usage: true, tools: true },
            async *complete() {
              requests += 1
              yield { type: 'text-delta', delta: 'TERMINAL_RESUMED' }
              yield {
                type: 'usage',
                usage: { inputTokens: 2, outputTokens: 1 },
              }
            },
          }
        }),
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
      expect(providerModels).toEqual([])

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
      await registry.execute(
        await registry.prepare(
          {
            id: `call_${persistedStatus}_message_2`,
            name: 'SendMessage',
            input: {
              to: `${persistedStatus}-reviewer`,
              summary: `resume again ${persistedStatus}`,
              message: 'EXPLICIT_TERMINAL_CONTINUATION_AGAIN',
            },
          },
          { cwd },
        ),
        { cwd },
      )
      await registry.execute(
        await registry.prepare(
          {
            id: `call_${persistedStatus}_done_2`,
            name: 'TaskOutput',
            input: { task_id: agentId, block: true, timeout: 30_000 },
          },
          { cwd },
        ),
        { cwd },
      )
      expect(requests).toBe(2)
      expect(providerModels).toEqual(['recovery-model', 'recovery-model'])
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
    const agentId = 'a3333333333333333'
    const promptId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const paths = resolveDataPlanePaths({
      dataPlane: 'native',
      root: configRoot,
      cwd,
      sessionId,
    })
    const directory = join(paths.projectRoot, sessionId, 'subagents')
    await mkdir(directory, { recursive: true })
    const sidechainPath = join(directory, `agent-${agentId}.jsonl`)
    const sidechainSource = nativeEnvelope(
      sessionId,
      '11111111-1111-4111-8111-111111111111',
      null,
      [{ role: 'user', content: 'CORRUPT_STATE_ROOT' }],
      '2026-08-23T00:00:00.000Z',
    )
    await writeFile(sidechainPath, sidechainSource)
    await writeFile(
      join(directory, `agent-${agentId}.meta.json`),
      JSON.stringify({
        agentType: 'general-purpose',
        description: 'Corrupt lifecycle fixture',
        toolUseId: 'call_corrupt_origin',
        spawnDepth: 1,
        cwd,
        promptId,
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
      dataPlane: 'native',
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
    const agentId = 'a4444444444444444'
    const runId = 'wf_fixture_run'
    const name = 'nested-fixture'
    const paths = resolveDataPlanePaths({
      dataPlane: 'native',
      root: configRoot,
      cwd,
      sessionId,
    })
    const nestedDirectory = join(
      paths.projectRoot,
      sessionId,
      'subagents',
      'workflows',
      runId,
    )
    await mkdir(nestedDirectory, { recursive: true })
    await writeFile(
      join(nestedDirectory, `agent-${agentId}.jsonl`),
      nativeEnvelope(
        sessionId,
        '11111111-1111-4111-8111-111111111111',
        null,
        [{ role: 'user', content: 'NESTED_FIXTURE_PROMPT' }],
        '2026-08-20T00:00:00.000Z',
      ) +
        nativeEnvelope(
          sessionId,
          '22222222-2222-4222-8222-222222222222',
          '11111111-1111-4111-8111-111111111111',
          [{ role: 'assistant', content: 'NESTED_FIXTURE_DONE' }],
          '2026-08-20T00:00:01.000Z',
        ),
    )
    await writeFile(
      join(nestedDirectory, `agent-${agentId}.meta.json`),
      JSON.stringify({
        agentType: 'general-purpose',
        description: 'Nested workflow fixture',
        toolUseId: 'call_nested_fixture',
        spawnDepth: 1,
        cwd,
        promptId,
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
      dataPlane: 'native' as const,
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
    const agentId = 'a5555555555555555'
    const paths = resolveDataPlanePaths({
      dataPlane: 'native',
      root: configRoot,
      cwd,
      sessionId,
    })
    const nestedDirectory = join(
      paths.projectRoot,
      sessionId,
      'subagents',
      'legacy',
    )
    await mkdir(nestedDirectory, { recursive: true })
    await writeFile(
      join(nestedDirectory, `agent-${agentId}.jsonl`),
      nativeEnvelope(
        sessionId,
        '11111111-1111-4111-8111-111111111111',
        null,
        [{ role: 'user', content: 'LEGACY_FIXTURE_PROMPT' }],
        '2026-08-20T00:00:00.000Z',
      ) +
        nativeEnvelope(
          sessionId,
          '22222222-2222-4222-8222-222222222222',
          '11111111-1111-4111-8111-111111111111',
          [{ role: 'assistant', content: 'LEGACY_FIXTURE_DONE' }],
          '2026-08-20T00:00:01.000Z',
        ),
    )
    const executor = new ClaudeSubagentExecutor({
      configRoot,
      dataPlane: 'native',
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
      dataPlane: 'native',
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
      dataPlane: 'native',
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

  it('keeps a parent ask ceiling when the child mode would allow execution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-agent-ceiling-test-'))
    roots.push(root)
    const cwd = join(root, 'project')
    let writeExecutions = 0
    const approvals: string[] = []
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
        if (request.messages.some((message) => message.role === 'tool')) {
          yield { type: 'text-delta', delta: 'PARENT_CEILING_DONE' }
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
    const executor = new ClaudeSubagentExecutor({
      configRoot: join(root, 'config'),
      dataPlane: 'native',
      cwd,
      claudeVersion: '2.1.208',
      provider,
      baseTools: tools,
      permissions: {
        resolve: () => ({
          behavior: 'ask',
          reason: 'Parent approval is required',
        }),
      },
      permissionResolverForMode: () => ({
        resolve: () => ({ behavior: 'allow' }),
      }),
      approveTool: (call, _originalCall, decision) => {
        approvals.push(`${call.id}:${decision?.behavior}`)
        return { behavior: 'deny', message: 'Parent denied the write' }
      },
    })
    const registry = executor.registry(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      0,
      () => 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    )
    const call = await registry.prepare(
      {
        id: 'call_child_allow',
        name: 'Agent',
        input: {
          description: 'Respect parent ceiling',
          prompt: 'Try to write',
          mode: 'acceptEdits',
          run_in_background: false,
        },
      },
      { cwd },
    )

    const result = await registry.execute(call, { cwd })

    expect(result.content).toContain('PARENT_CEILING_DONE')
    expect(approvals).toEqual(['call_write:ask'])
    expect(writeExecutions).toBe(0)
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
        dataPlane: 'native',
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
    const requests: ModelRequest[] = []
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
        requests.push(request)
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
      dataPlane: 'native',
      cwd,
      claudeVersion: '2.1.208',
      provider,
      baseTools: tools,
      permissions: { resolve: () => ({ behavior: 'allow' }) },
      contextAssembler: {
        async assemble(options) {
          const contextCwd = options?.cwd ?? ''
          contextCwds.push(contextCwd)
          return contextSnapshot([`CONTEXT_CWD:${contextCwd}`])
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
    const expectedWorktreePath = join(
      await realpath(cwd),
      '.praxis',
      'worktrees',
      'agent',
      `${sessionId}-${String(result.nativeToolUseResult?.agentId)}`,
    )
    expect(worktreePath).toBe(expectedWorktreePath)
    expect(toolCwds).toEqual([worktreePath])
    expect(contextCwds).toEqual([worktreePath, worktreePath])
    expect(requests).toHaveLength(2)
    expect(
      requests.every((request) =>
        JSON.stringify(request.messages).includes(
          `CONTEXT_CWD:${worktreePath}`,
        ),
      ),
    ).toBe(true)
    expect(
      requests.every((request) => request.stableSystemMessageCount === 1),
    ).toBe(true)
    expect(result.nativeToolUseResult).toMatchObject({
      worktreePath,
      worktreeRetained: false,
    })
    const paths = resolveDataPlanePaths({
      dataPlane: 'native',
      root: configRoot,
      cwd,
      sessionId,
    })
    const agentId = String(result.nativeToolUseResult?.agentId)
    const metadata = JSON.parse(
      await readFile(
        join(
          paths.projectRoot,
          sessionId,
          'subagents',
          `agent-${agentId}.meta.json`,
        ),
        'utf8',
      ),
    ) as { cwd?: string; worktreePath?: string }
    expect(metadata.cwd).toBe(worktreePath)
    expect(metadata.worktreePath).toBe(worktreePath)
    const registryDirectory = join(
      paths.praxisRoot,
      'managed-worktrees',
      sanitizeProjectPath(await realpath(cwd)),
    )
    const records = await readdir(registryDirectory)
    expect(records.filter((name) => name.endsWith('.json'))).toHaveLength(1)
    const record = JSON.parse(
      await readFile(join(registryDirectory, records[0] ?? ''), 'utf8'),
    ) as { state?: string; worktreePath?: string }
    expect(record).toMatchObject({
      state: 'released',
      worktreePath,
    })
    const transcript = await readFile(
      join(paths.projectRoot, sessionId, 'subagents', `agent-${agentId}.jsonl`),
      'utf8',
    )
    expect(transcript).not.toMatch(/ownerId|worktreeId|PRAXIS_WORKTREE/u)
    await expect(stat(worktreePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('runs Agent lifecycle hooks with agent matcher fields outside the transcript', async () => {
    const { configRoot, cwd } = await gitRepository('praxis-agent-hooks-')
    const hookCalls: Record<string, unknown>[] = []
    const hooks = new ClaudeHookRunner({
      settings: [
        {
          path: '/project.json',
          scope: 'project',
          value: {
            hooks: {
              WorktreeCreate: [
                {
                  matcher: 'agent',
                  hooks: [{ type: 'command', command: 'agent-create' }],
                },
              ],
              WorktreeRemove: [
                {
                  matcher: 'agent',
                  hooks: [{ type: 'command', command: 'agent-remove' }],
                },
              ],
            },
          },
        },
      ],
      cwd,
      executeCommand: async (command, input) => {
        hookCalls.push({ command, ...input })
        return { stdout: '', stderr: '', exitCode: 0, durationMs: 1 }
      },
    })
    const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const executor = new ClaudeSubagentExecutor({
      configRoot,
      dataPlane: 'native',
      cwd,
      claudeVersion: '2.1.208',
      provider: {
        capabilities: { streaming: true, usage: true, tools: false },
        async *complete() {
          yield { type: 'text-delta', delta: 'AGENT_HOOKED' }
        },
      },
      baseTools: emptyTools,
      permissions: { resolve: () => ({ behavior: 'allow' }) },
      hooks,
    })
    const registry = executor.registry(
      sessionId,
      0,
      () => 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    )
    const result = await registry.execute(
      await registry.prepare(
        {
          id: 'call_agent_hooks',
          name: 'Agent',
          input: {
            description: 'Agent hooks',
            prompt: 'Run with hooks',
            isolation: 'worktree',
            run_in_background: false,
          },
        },
        { cwd },
      ),
      { cwd },
    )
    const agentId = String(result.nativeToolUseResult?.agentId)
    expect(hookCalls).toHaveLength(2)
    expect(hookCalls.map((input) => input.command)).toEqual([
      'agent-create',
      'agent-remove',
    ])
    expect(hookCalls[0]).toMatchObject({
      session_id: sessionId,
      permission_mode: 'default',
      hook_event_name: 'WorktreeCreate',
      transcript_path: expect.any(String),
      worktree_kind: 'agent',
      worktree_id: expect.any(String),
      owner_id: expect.any(String),
      base_commit: expect.any(String),
      cwd: result.nativeToolUseResult?.worktreePath,
      worktree_path: result.nativeToolUseResult?.worktreePath,
    })
    expect(hookCalls[1]).toMatchObject({
      session_id: sessionId,
      permission_mode: 'default',
      worktree_kind: 'agent',
      transcript_path: hookCalls[0]?.transcript_path,
      worktree_id: hookCalls[0]?.worktree_id,
      owner_id: hookCalls[0]?.owner_id,
      base_commit: hookCalls[0]?.base_commit,
      cwd: result.nativeToolUseResult?.worktreePath,
      worktree_path: result.nativeToolUseResult?.worktreePath,
      hook_event_name: 'WorktreeRemove',
      reason: 'normal',
    })
    expect(String(hookCalls[0]?.owner_id)).toContain(
      `agent:${sessionId}:${agentId}:`,
    )
    const paths = resolveDataPlanePaths({
      dataPlane: 'native',
      root: configRoot,
      cwd,
      sessionId,
    })
    const transcript = await readFile(
      join(paths.projectRoot, sessionId, 'subagents', `agent-${agentId}.jsonl`),
      'utf8',
    )
    expect(transcript).not.toMatch(
      /agent-create|agent-remove|owner_id|worktree_id/u,
    )
    await executor.close()
  })

  it('rejects an oversized subagent context before provider transport', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-agent-budget-test-'))
    roots.push(root)
    const cwd = join(root, 'project')
    let providerCalls = 0
    const executor = new ClaudeSubagentExecutor({
      configRoot: join(root, 'config'),
      dataPlane: 'native',
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
          return contextSnapshot(['OVERSIZED_CONTEXT '.repeat(500)])
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
      dataPlane: 'native',
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
    const expectedWorktreePath = join(
      await realpath(cwd),
      '.praxis',
      'worktrees',
      'agent',
      `${sessionId}-${String(result.nativeToolUseResult?.agentId)}`,
    )
    expect(worktreePath).toBe(expectedWorktreePath)
    expect(result.nativeToolUseResult).toMatchObject({
      worktreePath,
      worktreeRetained: true,
      worktreeWarning: expect.stringContaining(worktreePath),
    })
    expect(result.content).toContain(worktreePath)
    expect(await readFile(join(worktreePath, 'agent-change.txt'), 'utf8')).toBe(
      'changed\n',
    )
    const paths = resolveDataPlanePaths({
      dataPlane: 'native',
      root: configRoot,
      cwd,
      sessionId,
    })
    await expect(
      stat(join(paths.praxisRoot, 'agent-worktrees')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      readFile(join(cwd, 'agent-change.txt'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' })

    const resumedCwds: string[] = []
    const resumed = new ClaudeSubagentExecutor({
      configRoot,
      dataPlane: 'native',
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
          return contextSnapshot()
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

  async function runIsolatedRetentionCase(
    mode: 'failure' | 'cancellation',
  ): Promise<{
    result: NonNullable<BackgroundAgentRunError['result']>
    lifecycleState: 'failed' | 'cancelled'
  }> {
    const { configRoot, cwd } = await gitRepository(
      `praxis-agent-worktree-${mode}-retention-`,
    )
    const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    let started!: () => void
    const providerStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    const executor = new ClaudeSubagentExecutor({
      configRoot,
      dataPlane: 'native',
      cwd,
      claudeVersion: '2.1.208',
      provider: {
        capabilities: { streaming: true, usage: true, tools: false },
        async *complete(request) {
          if (mode === 'failure') {
            yield* []
            throw new Error('provider failed')
          }
          yield* []
          started()
          await new Promise<void>((resolve) => {
            request.signal?.addEventListener('abort', () => resolve(), {
              once: true,
            })
          })
          throw new DOMException('Aborted', 'AbortError')
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
    const call = await registry.prepare(
      {
        id: `call_${mode}_retention`,
        name: 'Agent',
        input: {
          description: `${mode} retention`,
          prompt: `${mode} in isolation`,
          isolation: 'worktree',
          run_in_background: false,
        },
      },
      { cwd },
    )
    const controller = new AbortController()
    const operation = registry.execute(
      call,
      mode === 'cancellation' ? { cwd, signal: controller.signal } : { cwd },
    )
    if (mode === 'cancellation') {
      await providerStarted
      controller.abort()
    }
    let thrown: unknown
    try {
      await operation
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(BackgroundAgentRunError)
    const result = (thrown as BackgroundAgentRunError).result
    if (!result) throw new Error('Expected Agent failure result')
    const paths = resolveDataPlanePaths({
      dataPlane: 'native',
      root: configRoot,
      cwd,
      sessionId,
    })
    const lifecycleDirectory = join(
      paths.praxisRoot,
      'subagent-lifecycle',
      sessionId,
    )
    const lifecycleFiles = (await readdir(lifecycleDirectory)).filter((file) =>
      file.endsWith('.json'),
    )
    expect(lifecycleFiles).toHaveLength(1)
    const lifecycle = JSON.parse(
      await readFile(join(lifecycleDirectory, lifecycleFiles[0] ?? ''), 'utf8'),
    ) as { lifecycle: { state: 'failed' | 'cancelled' } }
    await executor.close()
    return { result, lifecycleState: lifecycle.lifecycle.state }
  }

  it.each(['failure', 'cancellation'] as const)(
    'retains a clean isolated Agent worktree after %s',
    async (mode) => {
      const { result, lifecycleState } = await runIsolatedRetentionCase(mode)
      const worktreePath = result.isolationPath
      if (!worktreePath) throw new Error('Expected retained worktree path')
      expect(result).toMatchObject({
        isolationRetained: true,
        isolationWarning: expect.stringContaining(worktreePath),
      })
      await expect(stat(worktreePath)).resolves.toBeDefined()
      expect(lifecycleState).toBe(mode === 'failure' ? 'failed' : 'cancelled')
    },
  )

  it('recreates one deterministic managed path for a clean Agent continuation', async () => {
    const { configRoot, cwd } = await gitRepository(
      'praxis-agent-worktree-continuation-',
    )
    let turn = 0
    const executor = new ClaudeSubagentExecutor({
      configRoot,
      dataPlane: 'native',
      cwd,
      claudeVersion: '2.1.208',
      provider: {
        capabilities: { streaming: true, usage: true, tools: false },
        async *complete() {
          yield {
            type: 'text-delta',
            delta: turn++ === 0 ? 'FIRST_CLEAN_DONE' : 'SECOND_CLEAN_DONE',
          }
        },
      },
      baseTools: emptyTools,
      permissions: { resolve: () => ({ behavior: 'allow' }) },
    })
    const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const registry = executor.registry(
      sessionId,
      0,
      () => 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    )
    const launched = await registry.execute(
      await registry.prepare(
        {
          id: 'call_clean_continuation',
          name: 'Agent',
          input: {
            description: 'Clean continuation',
            prompt: 'Finish cleanly',
            isolation: 'worktree',
            run_in_background: true,
          },
        },
        { cwd },
      ),
      { cwd },
    )
    const agentId = String(launched.nativeToolUseResult?.agentId)
    expect(launched.nativeToolUseResult).toMatchObject({
      agentId,
      description: 'Clean continuation',
      worktreePath: join(
        await realpath(cwd),
        '.praxis',
        'worktrees',
        'agent',
        `${sessionId}-${agentId}`,
      ),
    })
    const first = await registry.execute(
      await registry.prepare(
        {
          id: 'call_clean_continuation_output_1',
          name: 'TaskOutput',
          input: { task_id: agentId, block: true, timeout: 30_000 },
        },
        { cwd },
      ),
      { cwd },
    )
    expect(first.content).toContain('FIRST_CLEAN_DONE')
    const path = join(
      await realpath(cwd),
      '.praxis',
      'worktrees',
      'agent',
      `${sessionId}-${agentId}`,
    )
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
    const sent = await registry.execute(
      await registry.prepare(
        {
          id: 'call_clean_continuation_send',
          name: 'SendMessage',
          input: { to: agentId, message: 'Continue once' },
        },
        { cwd },
      ),
      { cwd },
    )
    expect(sent.content).toContain('resumedAgentId')
    const second = await registry.execute(
      await registry.prepare(
        {
          id: 'call_clean_continuation_output_2',
          name: 'TaskOutput',
          input: { task_id: agentId, block: true, timeout: 30_000 },
        },
        { cwd },
      ),
      { cwd },
    )
    expect(second.content).toContain('SECOND_CLEAN_DONE')
    const paths = resolveDataPlanePaths({
      dataPlane: 'native',
      root: configRoot,
      cwd,
      sessionId,
    })
    const registryDirectory = join(
      paths.praxisRoot,
      'managed-worktrees',
      sanitizeProjectPath(await realpath(cwd)),
    )
    const records = (await readdir(registryDirectory)).filter((name) =>
      name.endsWith('.json'),
    )
    expect(records).toHaveLength(2)
    const pathsInRecords = await Promise.all(
      records.map(
        async (record) =>
          (
            JSON.parse(
              await readFile(join(registryDirectory, record), 'utf8'),
            ) as {
              worktreePath: string
            }
          ).worktreePath,
      ),
    )
    expect(pathsInRecords).toEqual([path, path])
    await executor.close()
  })

  it('retains a committed isolated Agent checkout at the managed path', async () => {
    const { configRoot, cwd } = await gitRepository(
      'praxis-agent-worktree-committed-',
    )
    let turn = 0
    const tools: ToolRegistry = {
      definitions: () => [
        {
          name: 'CommitChange',
          description: 'Commit a change in the current checkout',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
      prepare: async (call) => call,
      execute: async (_call, context) => {
        await writeFile(join(context.cwd, 'agent-commit.txt'), 'committed\n')
        await execFileAsync('git', [
          '-C',
          context.cwd,
          'add',
          'agent-commit.txt',
        ])
        await execFileAsync('git', [
          '-C',
          context.cwd,
          '-c',
          'user.name=Praxis Test',
          '-c',
          'user.email=praxis@example.invalid',
          'commit',
          '-m',
          'Agent committed change',
        ])
        return { content: 'COMMITTED', isError: false }
      },
    }
    const executor = new ClaudeSubagentExecutor({
      configRoot,
      dataPlane: 'native',
      cwd,
      claudeVersion: '2.1.208',
      provider: {
        capabilities: { streaming: true, usage: true, tools: true },
        async *complete() {
          if (turn++ === 0) {
            yield {
              type: 'tool-call',
              call: { id: 'call_committed', name: 'CommitChange', input: {} },
            }
          } else {
            yield { type: 'text-delta', delta: 'COMMITTED_DONE' }
          }
        },
      },
      baseTools: tools,
      permissions: { resolve: () => ({ behavior: 'allow' }) },
    })
    const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const registry = executor.registry(
      sessionId,
      0,
      () => 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    )
    const result = await registry.execute(
      await registry.prepare(
        {
          id: 'call_committed_agent',
          name: 'Agent',
          input: {
            description: 'Committed isolation',
            prompt: 'Commit a change',
            isolation: 'worktree',
            run_in_background: false,
          },
        },
        { cwd },
      ),
      { cwd },
    )
    const path = String(result.nativeToolUseResult?.worktreePath)
    expect(path).toBe(
      join(
        await realpath(cwd),
        '.praxis',
        'worktrees',
        'agent',
        `${sessionId}-${String(result.nativeToolUseResult?.agentId)}`,
      ),
    )
    expect(result.nativeToolUseResult).toMatchObject({
      worktreePath: path,
      worktreeRetained: true,
    })
    await expect(
      readFile(join(path, 'agent-commit.txt'), 'utf8'),
    ).resolves.toBe('committed\n')
    await executor.close()
  })

  it('releases an owned restore lease when a hydrated Agent is closed before continuation', async () => {
    const { configRoot, cwd } = await gitRepository(
      'praxis-agent-worktree-close-restore-',
    )
    const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    let turn = 0
    const first = new ClaudeSubagentExecutor({
      configRoot,
      dataPlane: 'native',
      cwd,
      claudeVersion: '2.1.208',
      provider: {
        capabilities: { streaming: true, usage: true, tools: true },
        async *complete() {
          if (turn++ === 0) {
            yield {
              type: 'tool-call',
              call: {
                id: 'call_close_restore_write',
                name: 'Write',
                input: { file_path: 'retained.txt', content: 'retained\n' },
              },
            }
          } else {
            yield { type: 'text-delta', delta: 'RETAINED_BACKGROUND_DONE' }
          }
        },
      },
      baseTools: new LocalToolRegistry({ cwd }),
      permissions: { resolve: () => ({ behavior: 'allow' }) },
    })
    const registry = first.registry(
      sessionId,
      0,
      () => 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    )
    const launched = await registry.execute(
      await registry.prepare(
        {
          id: 'call_close_restore',
          name: 'Agent',
          input: {
            description: 'Retain background checkout',
            prompt: 'Retain this work',
            isolation: 'worktree',
            run_in_background: true,
          },
        },
        { cwd },
      ),
      { cwd },
    )
    const agentId = String(launched.nativeToolUseResult?.agentId)
    await first.outputBackgroundTask(agentId, { block: true, timeout: 30_000 })

    const second = new ClaudeSubagentExecutor({
      configRoot,
      dataPlane: 'native',
      cwd,
      claudeVersion: '2.1.208',
      provider: {
        capabilities: { streaming: true, usage: true, tools: false },
        async *complete() {
          yield { type: 'text-delta', delta: 'SHOULD_NOT_RUN' }
        },
      },
      baseTools: emptyTools,
      permissions: { resolve: () => ({ behavior: 'allow' }) },
    })
    await second.hydratePersistedTasks(sessionId, cwd)
    expect(second.backgroundSnapshots()).toHaveLength(1)
    await Promise.all([second.close(), second.close()])
    await second.close()

    const third = new ClaudeSubagentExecutor({
      configRoot,
      dataPlane: 'native',
      cwd,
      claudeVersion: '2.1.208',
      provider: {
        capabilities: { streaming: true, usage: true, tools: false },
        async *complete() {
          yield { type: 'text-delta', delta: 'SHOULD_NOT_RUN' }
        },
      },
      baseTools: emptyTools,
      permissions: { resolve: () => ({ behavior: 'allow' }) },
    })
    await third.hydratePersistedTasks(sessionId, cwd)
    expect(third.backgroundSnapshots()).toHaveLength(1)
    await third.close()
    await first.close()
  })

  it('attempts every hydrated Agent disposer and caches close failures', async () => {
    const { configRoot, cwd } = await gitRepository(
      'praxis-agent-close-aggregate-',
    )
    const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const agentIds = ['a0123456789abcdef', 'a1123456789abcdef']
    const paths = resolveDataPlanePaths({
      dataPlane: 'native',
      root: configRoot,
      cwd,
      sessionId,
    })
    for (const [index, agentId] of agentIds.entries()) {
      const transcriptPath = join(
        paths.projectRoot,
        sessionId,
        'subagents',
        `agent-${agentId}.jsonl`,
      )
      const lifecycleStore = new SubagentLifecycleStore(
        paths.praxisRoot,
        sessionId,
        agentId,
        transcriptPath,
      )
      const execution = await lifecycleStore.start()
      await execution.running()
      const worktree = await createAgentWorktree({
        cwd,
        stateRoot: paths.praxisRoot,
        sessionId,
        agentId,
        executionToken: execution.token,
      })
      await seedIncompleteIsolatedSidechain({
        configRoot,
        cwd,
        sessionId,
        agentId,
        worktreePath: worktree.cwd,
        name: `close-aggregate-${index}`,
      })
      await execution.finish(
        'failed',
        {
          text: `failed-${index}`,
          usage: { inputTokens: 0, outputTokens: 0 },
          toolUseCount: 0,
          durationMs: 0,
        },
        `failed-${index}`,
        {
          id: `${index + 1}1111111-1111-4111-8111-111111111111`,
          status: 'failed',
          toolUseId: `close-aggregate-${index}`,
          error: `failed-${index}`,
        },
      )
      await execution.release()
      await worktree.retain(`initial failure ${index}`)
    }

    const executor = new ClaudeSubagentExecutor({
      configRoot,
      dataPlane: 'native',
      cwd,
      claudeVersion: '2.1.208',
      provider: {
        capabilities: { streaming: true, usage: true, tools: false },
        async *complete() {
          yield { type: 'text-delta', delta: 'SHOULD_NOT_RUN' }
        },
      },
      baseTools: emptyTools,
      permissions: { resolve: () => ({ behavior: 'allow' }) },
    })
    await executor.hydratePersistedTasks(sessionId, cwd)
    expect(executor.backgroundSnapshots()).toHaveLength(2)
    const registryDirectory = join(
      paths.praxisRoot,
      'managed-worktrees',
      sanitizeProjectPath(await realpath(cwd)),
    )
    const recordFiles = (await readdir(registryDirectory)).filter((file) =>
      file.endsWith('.json'),
    )
    expect(recordFiles).toHaveLength(2)
    const records = await Promise.all(
      recordFiles.map(async (file) => ({
        file,
        value: JSON.parse(
          await readFile(join(registryDirectory, file), 'utf8'),
        ) as { worktreeId: string; retentionReason?: string },
      })),
    )
    for (const { value } of records) {
      const managedStore = new ManagedWorktreeStore(
        paths.praxisRoot,
        await realpath(cwd),
        value.worktreeId,
      )
      await rm(managedStore.lockPath, { force: true })
      await mkdir(managedStore.lockPath)
    }

    let thrown: unknown
    try {
      await executor.close()
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AggregateError)
    expect((thrown as AggregateError).errors).toHaveLength(2)
    const afterFirstClose = await Promise.all(
      records.map(({ file }) =>
        readFile(join(registryDirectory, file), 'utf8'),
      ),
    )
    expect(
      afterFirstClose.every((source) => source.includes('launch was rejected')),
    ).toBe(true)
    await expect(executor.close()).rejects.toBe(thrown)
    const afterRepeatedClose = await Promise.all(
      records.map(({ file }) =>
        readFile(join(registryDirectory, file), 'utf8'),
      ),
    )
    expect(afterRepeatedClose).toEqual(afterFirstClose)
  })

  it('restores the exact legacy global Agent path without managed adoption', async () => {
    const { configRoot, cwd } = await gitRepository(
      'praxis-agent-worktree-legacy-restore-',
    )
    const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const agentId = 'a0123456789abcdef'
    const paths = resolveDataPlanePaths({
      dataPlane: 'native',
      root: configRoot,
      cwd,
      sessionId,
    })
    const legacyPath = join(
      paths.praxisRoot,
      'agent-worktrees',
      `${sessionId}-${agentId}`,
    )
    await mkdir(join(paths.praxisRoot, 'agent-worktrees'), { recursive: true })
    await execFileAsync('git', [
      '-C',
      cwd,
      'worktree',
      'add',
      '--detach',
      legacyPath,
      'HEAD',
    ])
    await writeFile(join(legacyPath, 'legacy-change.txt'), 'legacy\n')
    await seedIncompleteIsolatedSidechain({
      configRoot,
      cwd,
      sessionId,
      agentId,
      worktreePath: legacyPath,
      name: 'legacy-restored-agent',
    })
    const observedCwds: string[] = []
    const warnings: RuntimeEvent[] = []
    const executor = new ClaudeSubagentExecutor({
      configRoot,
      dataPlane: 'native',
      cwd,
      claudeVersion: '2.1.208',
      provider: {
        capabilities: { streaming: true, usage: true, tools: false },
        async *complete() {
          yield { type: 'text-delta', delta: 'LEGACY_RESTORED_DONE' }
        },
      },
      baseTools: emptyTools,
      permissions: { resolve: () => ({ behavior: 'allow' }) },
      eventSink: (event) => warnings.push(event),
      contextAssembler: {
        async assemble(options) {
          observedCwds.push(options?.cwd ?? '')
          return contextSnapshot()
        },
      },
    })
    const registry = executor.registry(
      sessionId,
      0,
      () => 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    )
    const sent = await registry.execute(
      await registry.prepare(
        {
          id: 'call_legacy_restore_send',
          name: 'SendMessage',
          input: { to: 'legacy-restored-agent', message: 'Continue legacy' },
        },
        { cwd },
      ),
      { cwd },
    )
    expect(sent.content).toContain('resumedAgentId')
    const output = await registry.execute(
      await registry.prepare(
        {
          id: 'call_legacy_restore_output',
          name: 'TaskOutput',
          input: { task_id: agentId, block: true, timeout: 30_000 },
        },
        { cwd },
      ),
      { cwd },
    )
    expect(output.content).toContain('LEGACY_RESTORED_DONE')
    expect(warnings.filter(({ type }) => type === 'warning')).toEqual([])
    expect(output.content).toContain(
      `<worktree_path>${legacyPath}</worktree_path>`,
    )
    expect(output.content).toContain(
      '<worktree_retained>true</worktree_retained>',
    )
    expect(observedCwds).toEqual([legacyPath])
    await expect(
      readFile(join(legacyPath, 'legacy-change.txt'), 'utf8'),
    ).resolves.toBe('legacy\n')
    await expect(
      stat(join(paths.praxisRoot, 'managed-worktrees')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await executor.close()
  })

  it('rejects an arbitrary registered retained path and falls back without deletion', async () => {
    const { configRoot, cwd, fixtureRoot } = await gitRepository(
      'praxis-agent-worktree-invalid-retained-',
    )
    const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const agentId = 'a0123456789abcdef'
    const unrelatedPath = join(fixtureRoot, 'registered-but-not-agent-owned')
    await execFileAsync('git', [
      '-C',
      cwd,
      'worktree',
      'add',
      '--detach',
      unrelatedPath,
      'HEAD',
    ])
    await writeFile(join(unrelatedPath, 'preserve.txt'), 'preserve\n')
    await seedIncompleteIsolatedSidechain({
      configRoot,
      cwd,
      sessionId,
      agentId,
      worktreePath: unrelatedPath,
      name: 'invalid-retained-agent',
    })
    const observedCwds: string[] = []
    const warnings: RuntimeEvent[] = []
    const executor = new ClaudeSubagentExecutor({
      configRoot,
      dataPlane: 'native',
      cwd,
      claudeVersion: '2.1.208',
      provider: {
        capabilities: { streaming: true, usage: true, tools: false },
        async *complete() {
          yield { type: 'text-delta', delta: 'FALLBACK_DONE' }
        },
      },
      baseTools: emptyTools,
      permissions: { resolve: () => ({ behavior: 'allow' }) },
      eventSink: (event) => warnings.push(event),
      contextAssembler: {
        async assemble(options) {
          observedCwds.push(options?.cwd ?? '')
          return contextSnapshot()
        },
      },
    })
    const registry = executor.registry(
      sessionId,
      0,
      () => 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    )
    await registry.execute(
      await registry.prepare(
        {
          id: 'call_invalid_retained_send',
          name: 'SendMessage',
          input: { to: 'invalid-retained-agent', message: 'Continue safely' },
        },
        { cwd },
      ),
      { cwd },
    )
    await registry.execute(
      await registry.prepare(
        {
          id: 'call_invalid_retained_output',
          name: 'TaskOutput',
          input: { task_id: agentId, block: true, timeout: 30_000 },
        },
        { cwd },
      ),
      { cwd },
    )
    expect(observedCwds).toEqual([cwd])
    expect(warnings).toContainEqual({
      type: 'warning',
      message: expect.stringContaining(
        'could not restore its retained worktree; falling back to parent cwd',
      ),
    })
    await expect(
      readFile(join(unrelatedPath, 'preserve.txt'), 'utf8'),
    ).resolves.toBe('preserve\n')
    await executor.close()
  })

  it('enforces the session Agent call budget before creating another sidechain', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-agent-budget-test-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const executor = new ClaudeSubagentExecutor({
      configRoot,
      dataPlane: 'native',
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

    const paths = resolveDataPlanePaths({
      dataPlane: 'native',
      root: configRoot,
      cwd,
      sessionId,
    })
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
    const paths = resolveDataPlanePaths({
      dataPlane: 'native',
      root: configRoot,
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
      dataPlane: 'native',
      sessionPersistence: true,
      experimentalNativeTranscriptWrites: true,
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
    const projectRoot = resolveDataPlanePaths({
      dataPlane: 'native',
      root: configRoot,
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
      '"toolCallId":"call_cancel_agent"',
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
      dataPlane: 'native',
      experimentalNativeTranscriptWrites: true,
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
    const projectRoot = resolveDataPlanePaths({
      dataPlane: 'native',
      root: configRoot,
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
    expect(interruptedSource).toContain('call_recover_agent')
    await writeFile(
      mainPath,
      interruptedSource
        .split('\n')
        .filter((line) => !line.includes('"id":"call_recover_agent"'))
        .join('\n'),
    )
    const approvals: string[] = []
    const recovered = new ClaudeSessionService({
      configRoot,
      cwd,
      dataPlane: 'native',
      experimentalNativeTranscriptWrites: true,
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
    expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 3 })
    expect(approvals).toEqual([])
    const source = await readFile(join(projectRoot, mainFile), 'utf8')
    expect(source).toContain('RECOVERED_MAIN')
    await expect(
      readdir(join(projectRoot, sessionId, 'subagents')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
