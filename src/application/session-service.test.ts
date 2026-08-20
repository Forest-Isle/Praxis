import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  ModelProvider,
  ModelRequest,
  RuntimeEvent,
  ToolRegistry,
} from '../core/runtime.js'
import { ContextBudget } from '../core/context-budget.js'
import { AgentRunCancelledError, ModelProviderError } from '../core/runtime.js'
import { ModelPricingRegistry } from '../core/usage.js'
import {
  ClaudeConditionalRuleResolver,
  ClaudeContextAssembler,
} from '../compatibility/claude/context.js'
import {
  resolveClaudePaths,
  sanitizeClaudeProjectPath,
} from '../compatibility/claude/paths.js'
import { loadClaudeContextResources } from '../compatibility/claude/shared-resources.js'
import { ClaudeExtensionCatalog } from '../extensions/claude-extensions.js'
import { ClaudeHookRunner } from '../hooks/claude-hooks.js'
import {
  ClaudeInteractiveToolManager,
  type ClaudeQuestion,
  type ClaudeQuestionResult,
} from '../tools/claude-interactive-tools.js'
import { LocalToolRegistry } from '../tools/local-tools.js'
import type { ClaudeSessionCostState } from '../persistence/claude-cost-state-store.js'
import { ClaudeSessionService } from './session-service.js'
import { WorkspaceContext } from './session-worktree.js'

const roots: string[] = []

function queuedProvider(responses: string[]): ModelProvider {
  return {
    capabilities: { streaming: true, usage: true, tools: false },
    async *complete() {
      const response = responses.shift()
      if (!response) throw new Error('Provider response fixture exhausted')
      yield { type: 'text-delta', delta: response }
      yield {
        type: 'usage',
        usage: { inputTokens: 3, outputTokens: 2 },
      }
    },
  }
}

async function createService() {
  const root = await mkdtemp(join(tmpdir(), 'praxis-runtime-test-'))
  roots.push(root)
  const cwd = join(root, 'project')
  const configRoot = join(root, 'config')
  const provider = queuedProvider(['first answer', 'second answer'])
  return {
    configRoot,
    cwd,
    service: new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider,
    }),
  }
}

function trackedTotals(snapshot: {
  totalCostUsd: number
  apiDurationMs: number
  apiDurationWithoutRetriesMs: number
  toolDurationMs: number
  linesAdded: number
  linesRemoved: number
  hasUnknownModelCost: boolean
  modelUsage: Record<string, unknown>
}) {
  return {
    totalCostUsd: snapshot.totalCostUsd,
    apiDurationMs: snapshot.apiDurationMs,
    apiDurationWithoutRetriesMs: snapshot.apiDurationWithoutRetriesMs,
    toolDurationMs: snapshot.toolDurationMs,
    linesAdded: snapshot.linesAdded,
    linesRemoved: snapshot.linesRemoved,
    hasUnknownModelCost: snapshot.hasUnknownModelCost,
    modelUsage: snapshot.modelUsage,
  }
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  )
})

describe('ClaudeSessionService', () => {
  it('approves a recently denied action without invoking the provider', async () => {
    const { configRoot, cwd, service } = await createService()
    const run = await service.run('start')

    await service.approveRecentlyDenied(run.sessionId, 'Delete target')

    const entries = (
      await readFile(
        resolveClaudePaths({
          configDir: configRoot,
          cwd,
          sessionId: run.sessionId,
        }).sessionFile,
        'utf8',
      )
    )
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    const tail = entries.slice(-4)
    expect(tail.map((entry) => entry.type)).toEqual([
      'user',
      'user',
      'user',
      'user',
    ])
    expect((tail[0]?.message as { content: string }).content).toContain(
      '<local-command-caveat>',
    )
    expect((tail[1]?.message as { content: string }).content).toContain(
      '<command-name>/permissions</command-name>',
    )
    expect((tail[2]?.message as { content: string }).content).toBe(
      '<local-command-stdout>Approved Delete target</local-command-stdout>',
    )
    expect(tail[3]).toMatchObject({
      isMeta: true,
      message: {
        content:
          'Permission granted for: Delete target. You may now retry this command if you would like.',
      },
    })
  })

  it('retries through permission_retry without appending a normal prompt', async () => {
    const requests: ModelRequest[] = []
    const root = await mkdtemp(join(tmpdir(), 'praxis-permission-retry-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    let turn = 0
    const provider: ModelProvider = {
      capabilities: { streaming: true, usage: true, tools: false },
      async *complete(request) {
        requests.push(request)
        yield {
          type: 'text-delta',
          delta: turn++ === 0 ? 'first answer' : 'retried answer',
        }
        yield {
          type: 'usage',
          usage: { inputTokens: 3, outputTokens: 2 },
        }
      },
    }
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider,
    })
    const run = await service.run('start')

    await expect(
      service.retryRecentlyDenied(run.sessionId, 'Delete target'),
    ).resolves.toMatchObject({ text: 'retried answer' })
    expect(requests).toHaveLength(2)
    expect(requests[1]?.messages.slice(-3)).toEqual([
      {
        role: 'user',
        content:
          '<command-name>/permissions</command-name>\n            <command-message>permissions</command-message>\n            <command-args></command-args>',
      },
      {
        role: 'user',
        content: '<local-command-stdout>(no content)</local-command-stdout>',
      },
      {
        role: 'user',
        content:
          'Permission granted for: Delete target. You may now retry this command if you would like.',
      },
    ])
    const entries = (
      await readFile(
        resolveClaudePaths({
          configDir: configRoot,
          cwd,
          sessionId: run.sessionId,
        }).sessionFile,
        'utf8',
      )
    )
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(entries).toContainEqual(
      expect.objectContaining({
        type: 'system',
        subtype: 'permission_retry',
        content: 'Allowed Delete target',
        commands: ['Delete target'],
      }),
    )
    expect(
      entries.some(
        (entry) =>
          entry.type === 'last-prompt' && entry.lastPrompt === '/permissions',
      ),
    ).toBe(false)
  })

  it('exposes the typed MCP runtime management API', async () => {
    const inspect = vi.fn(async () => [
      { name: 'fixture', status: 'connected' as const, toolCount: 1 },
    ])
    const reconnect = vi.fn(async () => undefined)
    const authenticate = vi.fn(async () => undefined)
    const reload = vi.fn(async () => undefined)
    const tools = vi.fn(async () => [
      { name: 'marker', fullName: 'mcp__fixture__marker' },
    ])
    const service = new ClaudeSessionService({
      configRoot: '/tmp/config',
      cwd: '/tmp/project',
      claudeVersion: '2.1.208',
      mcp: { inspect, reconnect, authenticate, reload, tools },
    })

    await expect(service.mcpInspect()).resolves.toEqual([
      { name: 'fixture', status: 'connected', toolCount: 1 },
    ])
    await service.mcpReconnect('fixture')
    await service.mcpAuthenticate('fixture')
    await service.mcpReload()
    await expect(service.mcpTools('fixture')).resolves.toEqual([
      { name: 'marker', fullName: 'mcp__fixture__marker' },
    ])
    expect(reconnect).toHaveBeenCalledWith('fixture')
    expect(authenticate).toHaveBeenCalledWith('fixture')
    expect(reload).toHaveBeenCalledOnce()
  })

  it('closes the MCP runtime when the owning session service closes', async () => {
    const close = vi.fn(async () => undefined)
    const service = new ClaudeSessionService({
      configRoot: '/tmp/config',
      cwd: '/tmp/project',
      claudeVersion: '2.1.208',
      mcp: {
        inspect: async () => [],
        reconnect: async () => undefined,
        authenticate: async () => undefined,
        reload: async () => undefined,
        tools: async () => [],
        close,
      },
    })

    await service.close()
    await service.close()
    expect(close).toHaveBeenCalledOnce()
  })

  it('switches cost trackers with target-load-before-current-save and idempotent close persistence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-cost-tracker-lifecycle-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const sessionA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const sessionB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const sessionC = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    const storedForB: ClaudeSessionCostState = {
      sessionId: sessionB,
      totalCostUsd: 12.5,
      apiDurationMs: 1000,
      apiDurationWithoutRetriesMs: 900,
      toolDurationMs: 500,
      wallDurationMs: 60000,
      linesAdded: 10,
      linesRemoved: 2,
      modelUsage: {
        'anthropic/claude-fixture': {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadInputTokens: 10,
          cacheCreationInputTokens: 5,
          webSearchRequests: 1,
          costUsd: 12.5,
        },
      },
    }
    const operations: string[] = []
    const load = vi.fn(async (sessionId: string) => {
      operations.push(`load:${sessionId}`)
      return sessionId === sessionB ? storedForB : null
    })
    const save = vi.fn(async (state: ClaudeSessionCostState) => {
      operations.push(`save:${state.sessionId}`)
    })
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: queuedProvider(['first answer', 'second answer']),
      costStateStore: { load, save },
    })

    const runA = await service.run('first', undefined, sessionA)
    expect(runA.text).toBe('first answer')
    expect(operations).toEqual([`load:${sessionA}`])

    const runB = await service.run('second', undefined, sessionB)
    expect(runB.text).toBe('second answer')
    expect(operations).toEqual([
      `load:${sessionA}`,
      `load:${sessionB}`,
      `save:${sessionA}`,
    ])

    const snapshotB = await service.costSnapshot(sessionB)
    expect(snapshotB.sessionId).toBe(sessionB)
    expect(snapshotB.totalCostUsd).toBe(12.5)
    // The resumed turn records its own global API duration on top of the
    // restored totals even though the model-less provider has no usage row.
    expect(snapshotB.apiDurationMs).toBeGreaterThanOrEqual(1000)
    expect(snapshotB.apiDurationWithoutRetriesMs).toBeGreaterThanOrEqual(900)
    expect(snapshotB.toolDurationMs).toBe(500)
    expect(snapshotB.linesAdded).toBe(10)
    expect(snapshotB.linesRemoved).toBe(2)
    expect(snapshotB.hasUnknownModelCost).toBe(false)
    expect(snapshotB.modelUsage['anthropic/claude-fixture']).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 10,
      cacheCreationInputTokens: 5,
      webSearchRequests: 1,
      costUsd: 12.5,
    })

    const snapshotC = await service.costSnapshot(sessionC)
    expect(snapshotC.sessionId).toBe(sessionC)
    expect(operations).toEqual([
      `load:${sessionA}`,
      `load:${sessionB}`,
      `save:${sessionA}`,
      `load:${sessionC}`,
    ])

    await service.close()
    await service.close()
    expect(save).toHaveBeenCalledTimes(2)
    expect(operations).toEqual([
      `load:${sessionA}`,
      `load:${sessionB}`,
      `save:${sessionA}`,
      `load:${sessionC}`,
      `save:${sessionB}`,
    ])
  })

  it('runs and resumes native shell turns through tool hooks before the provider', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-shell-turn-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    await mkdir(cwd, { recursive: true })
    const requests: ModelRequest[] = []
    const events: RuntimeEvent[] = []
    const hookEvents: string[] = []
    const postToolResponses: unknown[] = []
    const provider: ModelProvider = {
      model: 'fixture-model',
      capabilities: { streaming: true, usage: true, tools: true },
      async *complete(request) {
        requests.push(request)
        yield { type: 'text-delta', delta: `answer-${requests.length}` }
        yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1 } }
      },
    }
    const hooks = new ClaudeHookRunner({
      cwd,
      settings: [
        {
          path: join(configRoot, 'settings.json'),
          scope: 'user',
          value: {
            hooks: {
              PreToolUse: [
                {
                  matcher: 'Bash',
                  hooks: [{ type: 'command', command: 'pre' }],
                },
              ],
              PostToolUse: [
                {
                  matcher: 'Bash',
                  hooks: [{ type: 'command', command: 'post' }],
                },
              ],
            },
          },
        },
      ],
      executeCommand: async (_command, input) => {
        hookEvents.push(input.hook_event_name)
        if (input.hook_event_name === 'PostToolUse') {
          postToolResponses.push(input.tool_response)
        }
        return input.hook_event_name === 'PreToolUse'
          ? {
              stdout: JSON.stringify({
                hookSpecificOutput: {
                  hookEventName: 'PreToolUse',
                  updatedInput: { command: 'printf hook-output' },
                  permissionDecision: 'allow',
                },
              }),
              stderr: '',
              exitCode: 0,
              durationMs: 1,
            }
          : { stdout: '', stderr: '', exitCode: 0, durationMs: 1 }
      },
    })
    const sessionId = '91919191-9191-4191-8191-919191919191'
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider,
      tools: new LocalToolRegistry({ cwd }),
      permissions: { resolve: () => ({ behavior: 'ask' }) },
      hooks,
      eventSink: (event) => events.push(event),
    })

    await expect(
      service.runShell('printf original', undefined, sessionId),
    ).resolves.toMatchObject({ text: 'answer-1', sessionId })
    await expect(
      service.resumeShell(sessionId, 'printf second'),
    ).resolves.toMatchObject({ text: 'answer-2', sessionId })

    expect(hookEvents).toEqual([
      'PreToolUse',
      'PostToolUse',
      'PreToolUse',
      'PostToolUse',
    ])
    expect(postToolResponses).toEqual([
      expect.objectContaining({ stdout: 'hook-output', stderr: '' }),
      expect.objectContaining({ stdout: 'hook-output', stderr: '' }),
    ])
    expect(events.filter((event) => event.type === 'tool-call')).toEqual([])
    expect(events.filter((event) => event.type === 'tool-result')).toEqual([])
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'shell-result',
        stdout: 'hook-output',
        stderr: '',
        isError: false,
      }),
    )
    expect(JSON.stringify(requests[0]?.messages)).toContain(
      '<bash-input>printf original</bash-input>',
    )
    expect(JSON.stringify(requests[0]?.messages)).toContain(
      '<bash-stdout>hook-output</bash-stdout><bash-stderr></bash-stderr>',
    )
    expect(JSON.stringify(requests[1]?.messages)).toContain(
      '<bash-input>printf second</bash-input>',
    )

    const entries = (
      await readFile(
        resolveClaudePaths({ configDir: configRoot, cwd, sessionId })
          .sessionFile,
        'utf8',
      )
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    const bashMessages = entries.filter(
      (entry) =>
        entry.type === 'user' &&
        typeof entry.message?.content === 'string' &&
        entry.message.content.startsWith('<bash-'),
    )
    expect(bashMessages.map((entry) => entry.message.content)).toEqual([
      '<bash-input>printf original</bash-input>',
      '<bash-stdout>hook-output</bash-stdout><bash-stderr></bash-stderr>',
      '<bash-input>printf second</bash-input>',
      '<bash-stdout>hook-output</bash-stdout><bash-stderr></bash-stderr>',
    ])
    expect(
      entries.some((entry) =>
        (JSON.stringify(entry.message?.content) ?? '').includes('shell_'),
      ),
    ).toBe(false)
    expect(entries.at(-1)).toMatchObject({
      type: 'last-prompt',
      lastPrompt: '! printf second',
    })
  })

  it('continues a denied shell turn without executing the command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-shell-denied-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    await mkdir(cwd, { recursive: true })
    let executed = false
    const requests: ModelRequest[] = []
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: {
        capabilities: { streaming: true, usage: true, tools: true },
        async *complete(request) {
          requests.push(request)
          yield { type: 'text-delta', delta: 'denied safely' }
        },
      },
      tools: {
        definitions: () => [],
        async prepare(call) {
          return call
        },
        async execute() {
          executed = true
          return { content: 'unexpected', isError: false }
        },
      },
      permissions: { resolve: () => ({ behavior: 'ask' }) },
      approveTool: () => ({ behavior: 'deny', message: 'User denied shell' }),
    })

    await expect(service.runShell('touch denied')).resolves.toMatchObject({
      text: 'denied safely',
    })
    expect(executed).toBe(false)
    expect(JSON.stringify(requests[0]?.messages)).toContain(
      '<bash-stderr>User denied shell</bash-stderr>',
    )
  })

  it('cancels a running shell command without persisting a partial shell turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-shell-cancel-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    await mkdir(cwd, { recursive: true })
    const events: RuntimeEvent[] = []
    let markCommandStarted: (() => void) | undefined
    const commandStarted = new Promise<void>((resolve) => {
      markCommandStarted = resolve
    })
    let providerCalled = false
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: {
        capabilities: { streaming: true, usage: true, tools: true },
        async *complete() {
          providerCalled = true
          yield { type: 'text-delta', delta: 'unexpected' }
        },
      },
      tools: new LocalToolRegistry({ cwd }),
      permissions: { resolve: () => ({ behavior: 'allow' }) },
      eventSink: (event) => {
        events.push(event)
        if (event.type === 'shell-command') markCommandStarted?.()
      },
    })
    const sessionId = '92929292-9292-4292-8292-929292929292'
    const controller = new AbortController()
    const turn = service.runShell('sleep 30', controller.signal, sessionId)
    await commandStarted
    controller.abort()

    await expect(turn).rejects.toBeInstanceOf(AgentRunCancelledError)
    expect(providerCalled).toBe(false)
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'shell-command' }),
    )
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'shell-cancelled' }),
    )
    expect(events.some((event) => event.type === 'shell-result')).toBe(false)
    const transcript = await readFile(
      resolveClaudePaths({ configDir: configRoot, cwd, sessionId }).sessionFile,
      'utf8',
    )
    expect(transcript).not.toContain('<bash-input>')
    expect(transcript).not.toContain('<bash-stdout>')
  })

  it('persists and restores interactive plan-mode transitions without duplicate tools', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-interactive-plan-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const sessionId = '85858585-8585-4585-8585-858585858585'
    await mkdir(cwd, { recursive: true })
    const planPath = join(configRoot, 'plans', `praxis-${sessionId}.md`)
    const requests: ModelRequest[] = []
    let providerTurn = 0
    const provider: ModelProvider = {
      capabilities: { streaming: true, usage: true, tools: true },
      async *complete(request) {
        requests.push(request)
        providerTurn += 1
        if (providerTurn === 1) {
          yield {
            type: 'tool-call',
            call: { id: 'enter-plan', name: 'EnterPlanMode', input: {} },
          }
        } else if (providerTurn === 3) {
          yield {
            type: 'tool-call',
            call: {
              id: 'write-plan',
              name: 'Write',
              input: {
                file_path: planPath,
                content: '# Plan\n\n1. Implement it.\n',
              },
            },
          }
        } else if (providerTurn === 4) {
          yield {
            type: 'tool-call',
            call: { id: 'exit-plan', name: 'ExitPlanMode', input: {} },
          }
        } else {
          yield {
            type: 'text-delta',
            delta: providerTurn === 6 ? 'implemented' : 'complete',
          }
        }
        yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
      },
    }
    const allow = { resolve: () => ({ behavior: 'allow' as const }) }
    const interactiveTools = new ClaudeInteractiveToolManager({
      configRoot,
      initialMode: 'default',
      enabledTools: ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode'],
      callbacks: {
        askUser: async () => null,
        approvePlan: async () => ({
          behavior: 'allow',
          permissionMode: 'default',
        }),
      },
      permissionResolverForMode: (mode) =>
        mode === 'plan'
          ? {
              resolve: (call) =>
                call.name === 'Write' || call.name === 'Edit'
                  ? { behavior: 'deny', reason: 'plan mode' }
                  : { behavior: 'allow' },
            }
          : allow,
    })
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider,
      tools: new LocalToolRegistry({
        cwd,
        additionalDirectories: [join(configRoot, 'plans')],
      }),
      permissions: allow,
      interactiveTools,
    })

    await service.run('plan it', undefined, sessionId)
    await service.resume(sessionId, 'finish the plan')
    await service.resume(sessionId, 'implement it')

    const interactiveNames = [
      'AskUserQuestion',
      'EnterPlanMode',
      'ExitPlanMode',
    ]
    for (const request of requests) {
      for (const name of interactiveNames) {
        expect(
          request.tools?.filter((tool) => tool.name === name),
        ).toHaveLength(1)
      }
    }
    expect(JSON.stringify(requests[2]?.messages)).toContain('# Plan mode')
    expect(JSON.stringify(requests[2]?.messages)).toContain(planPath)
    await expect(readFile(planPath, 'utf8')).resolves.toBe(
      '# Plan\n\n1. Implement it.\n',
    )
    expect(JSON.stringify(requests[5]?.messages)).not.toContain('# Plan mode')

    const transcript = await readFile(
      resolveClaudePaths({ configDir: configRoot, cwd, sessionId }).sessionFile,
      'utf8',
    )
    const modes = transcript
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.type === 'permission-mode')
      .map((entry) => entry.permissionMode)
    expect(modes).toEqual(['plan', 'default'])
  })

  it('appends an explicit Claude permission mode for an existing session', async () => {
    const { configRoot, cwd, service } = await createService()
    const sessionId = '87878787-8787-4787-8787-878787878787'

    await service.run('start', undefined, sessionId)
    await service.setPermissionMode(sessionId, 'acceptEdits')

    const transcript = await readFile(
      resolveClaudePaths({ configDir: configRoot, cwd, sessionId }).sessionFile,
      'utf8',
    )
    const modes = transcript
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.type === 'permission-mode')
    expect(modes).toEqual([
      {
        type: 'permission-mode',
        permissionMode: 'acceptEdits',
        sessionId,
      },
    ])
  })

  it('persists native file checkpoints and rewinds without a provider call', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-session-rewind-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    await mkdir(cwd)
    const filePath = join(cwd, 'created.txt')
    let providerTurn = 0
    const provider: ModelProvider = {
      capabilities: { streaming: true, usage: true, tools: true },
      async *complete() {
        providerTurn += 1
        if (providerTurn === 1) {
          yield {
            type: 'tool-call',
            call: {
              id: 'write-checkpoint',
              name: 'Write',
              input: { file_path: filePath, content: 'created' },
            },
          }
        } else {
          yield { type: 'text-delta', delta: 'done' }
        }
        yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
      },
    }
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider,
      tools: new LocalToolRegistry({ cwd }),
      permissions: { resolve: () => ({ behavior: 'allow' }) },
      fileCheckpointing: true,
    })

    const result = await service.run('create it')
    await expect(readFile(filePath, 'utf8')).resolves.toBe('created')
    const { resolveClaudePaths } =
      await import('../compatibility/claude/paths.js')
    const source = await readFile(
      resolveClaudePaths({
        configDir: configRoot,
        cwd,
        sessionId: result.sessionId,
      }).sessionFile,
      'utf8',
    )
    const entries = source
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    const user = entries.find(
      (entry) =>
        entry.type === 'user' && typeof entry.message?.content === 'string',
    )
    expect(entries.map((entry) => entry.type)).toEqual(
      expect.arrayContaining(['file-history-snapshot', 'file-history-delta']),
    )
    expect(await service.rewindPoints(result.sessionId)).toEqual([
      expect.objectContaining({
        messageId: user.uuid,
        prompt: 'create it',
        fileChanges: [expect.stringMatching(/created\.txt$/u)],
        fileRestoreAvailable: true,
      }),
    ])
    await service.rewindFiles(result.sessionId, user.uuid)
    await expect(readFile(filePath, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(providerTurn).toBe(2)
  })

  it('manually compacts an existing session into native summary records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-manual-compact-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const events: RuntimeEvent[] = []
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: {
        capabilities: {
          streaming: true,
          usage: true,
          tools: false,
          contextWindowTokens: 100_000,
        },
        async *complete() {
          yield { type: 'text-delta', delta: 'original answer' }
        },
      },
      compactor: {
        async compact(request) {
          expect(JSON.stringify(request.messages)).toContain('original answer')
          return {
            summary: 'durable manual summary',
            usage: { inputTokens: 12, outputTokens: 4 },
            durationMs: 25,
            model: 'manual-compact-model',
          }
        },
      },
      eventSink: (event) => events.push(event),
    })

    const run = await service.run('remember this task')
    const compacted = await service.compact(run.sessionId)

    expect(compacted).toMatchObject({
      summary: 'durable manual summary',
      usage: { inputTokens: 12, outputTokens: 4 },
      preTokens: expect.any(Number),
    })
    expect(events).toContainEqual({ type: 'state', state: 'compacting' })
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'compact-boundary',
        trigger: 'manual',
      }),
    )
    expect(await service.transcript(run.sessionId)).toEqual([
      { kind: 'compact', summary: 'durable manual summary' },
    ])

    const transcript = await readFile(
      resolveClaudePaths({
        configDir: configRoot,
        cwd,
        sessionId: run.sessionId,
      }).sessionFile,
      'utf8',
    )
    expect(transcript).toContain('"trigger":"manual"')
    expect(transcript).toContain('"isCompactSummary":true')
    expect(transcript).toContain('durable manual summary')
  })

  it('attributes manual compact usage, web search, cost, and API duration to the session cost tracker', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-manual-compact-cost-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: {
        ...queuedProvider(['original answer']),
        model: 'run-model',
      },
      compactor: {
        async compact() {
          return {
            summary: 'costed manual summary',
            usage: {
              inputTokens: 1000,
              outputTokens: 200,
              cacheReadInputTokens: 300,
              cacheCreationInputTokens: 50,
              webSearchRequests: 2,
            },
            durationMs: 42,
            model: 'compact-model',
          }
        },
      },
      pricing: new ModelPricingRegistry({
        'run-model': { inputPerMillionUsd: 1, outputPerMillionUsd: 1 },
        'compact-model': {
          inputPerMillionUsd: 3,
          outputPerMillionUsd: 15,
          cacheReadInputPerMillionUsd: 0.3,
          cacheCreationInputPerMillionUsd: 3.75,
        },
      }),
    })

    const run = await service.run('start')
    await service.compact(run.sessionId)
    const snapshot = await service.costSnapshot(run.sessionId)

    const compactCost =
      ((1000 - 300 - 50) * 3 + 200 * 15 + 300 * 0.3 + 50 * 3.75) / 1_000_000
    expect(snapshot.modelUsage['compact-model']).toEqual({
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadInputTokens: 300,
      cacheCreationInputTokens: 50,
      webSearchRequests: 2,
      costUsd: compactCost,
    })
    expect(snapshot.totalCostUsd).toBe(5 / 1_000_000 + compactCost)
    expect(snapshot.apiDurationMs).toBe(42)
    expect(snapshot.apiDurationWithoutRetriesMs).toBe(42)
    expect(snapshot.toolDurationMs).toBe(0)
    expect(snapshot.hasUnknownModelCost).toBe(false)
  })

  it('records the exact retry-free API duration in the main cost row snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-retry-free-duration-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: {
        model: 'retry-free-model',
        capabilities: { streaming: true, usage: true, tools: false },
        async *complete() {
          yield { type: 'api-attempt-duration', durationMs: 0 }
          await new Promise((resolve) => setTimeout(resolve, 5))
          yield { type: 'text-delta', delta: 'measured' }
          yield {
            type: 'usage',
            usage: { inputTokens: 3, outputTokens: 2 },
          }
        },
      },
      pricing: new ModelPricingRegistry({
        'retry-free-model': { inputPerMillionUsd: 1, outputPerMillionUsd: 1 },
      }),
      costStateStore: { load: async () => null, save: async () => undefined },
    })

    const run = await service.run('start')
    const snapshot = await service.costSnapshot(run.sessionId)

    expect(snapshot.modelUsage['retry-free-model']).toMatchObject({
      inputTokens: 3,
      outputTokens: 2,
    })
    expect(snapshot.apiDurationMs).toBeGreaterThan(0)
    expect(snapshot.apiDurationWithoutRetriesMs).toBe(0)
  })

  it('records tool duration in the cost snapshot with zero provider usage and no model row', async () => {
    const root = await mkdtemp(
      join(tmpdir(), 'praxis-tool-duration-zero-usage-'),
    )
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    let turn = 0
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: {
        capabilities: { streaming: true, usage: true, tools: true },
        async *complete() {
          if (turn++ === 0) {
            yield {
              type: 'tool-call',
              call: { id: 'call_read', name: 'Read', input: {} },
            }
            return
          }
          yield { type: 'text-delta', delta: 'final' }
          yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } }
        },
      },
      tools: {
        definitions: () => [],
        prepare: async (call) => call,
        execute: async () => ({ content: 'read', isError: false }),
      },
      permissions: { resolve: () => ({ behavior: 'allow' }) },
    })

    const now = vi
      .spyOn(performance, 'now')
      .mockReturnValueOnce(0) // completeToolCall startedAt
      .mockReturnValueOnce(100) // execute start
      .mockReturnValueOnce(250) // execute end
      .mockReturnValue(0)
    try {
      const run = await service.run('read it')
      const snapshot = await service.costSnapshot(run.sessionId)
      expect(run.text).toBe('final')
      expect(snapshot.modelUsage).toEqual({})
      expect(snapshot.hasUnknownModelCost).toBe(false)
      expect(snapshot.apiDurationMs).toBe(0)
      expect(snapshot.apiDurationWithoutRetriesMs).toBe(0)
      expect(snapshot.toolDurationMs).toBe(150)
    } finally {
      now.mockRestore()
    }
  })

  it('records manual compact total and retry-free duration separately', async () => {
    const root = await mkdtemp(
      join(tmpdir(), 'praxis-manual-compact-retryfree-'),
    )
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: queuedProvider(['original answer']),
      compactor: {
        async compact() {
          return {
            summary: 'retry-free summary',
            usage: { inputTokens: 5, outputTokens: 3 },
            durationMs: 50,
            durationWithoutRetriesMs: 33,
            model: 'compact-model',
          }
        },
      },
    })

    const run = await service.run('start')
    await service.compact(run.sessionId)
    const snapshot = await service.costSnapshot(run.sessionId)

    expect(snapshot.apiDurationMs).toBe(50)
    expect(snapshot.apiDurationWithoutRetriesMs).toBe(33)
  })

  it('accumulates retry-free auto-compaction and main-turn durations in the snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-auto-retryfree-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const origin = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: {
        capabilities: { streaming: true, usage: true, tools: false },
        async *complete() {
          yield {
            type: 'text-delta',
            delta: `old-context ${'discarded '.repeat(600)}`,
          }
        },
      },
    })
    const first = await origin.run('CURRENT_TASK')

    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: {
        model: 'retry-free-model',
        capabilities: {
          streaming: true,
          usage: true,
          tools: false,
          contextWindowTokens: 2_500,
        },
        async *complete() {
          yield { type: 'api-attempt-duration', durationMs: 20 }
          yield { type: 'text-delta', delta: 'final answer' }
          yield {
            type: 'usage',
            usage: { inputTokens: 10, outputTokens: 5 },
          }
        },
      },
      compactor: {
        async compact() {
          return {
            summary: 'COMPACTED_RETRY_FREE',
            usage: { inputTokens: 6, outputTokens: 4 },
            durationMs: 70,
            durationWithoutRetriesMs: 55,
            model: 'retry-free-model',
          }
        },
      },
      contextReserveTokens: 1_500,
      pricing: new ModelPricingRegistry({
        'retry-free-model': { inputPerMillionUsd: 1, outputPerMillionUsd: 1 },
      }),
      costStateStore: { load: async () => null, save: async () => undefined },
    })

    const result = await service.resume(first.sessionId, 'Continue the task.')
    const snapshot = await service.costSnapshot(result.sessionId)

    expect(result.text).toBe('final answer')
    expect(snapshot.modelUsage['retry-free-model']).toMatchObject({
      inputTokens: 16,
      outputTokens: 9,
    })
    expect(snapshot.apiDurationMs).toBeGreaterThanOrEqual(70)
    expect(snapshot.apiDurationWithoutRetriesMs).toBe(55 + 20)
  })

  it('reactively retries a prompt-too-long failure once after auto-compacting', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-reactive-retry-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    let completions = 0
    const provider: ModelProvider = {
      model: 'reactive-model',
      capabilities: {
        streaming: true,
        usage: true,
        tools: false,
        contextWindowTokens: 200_000,
      },
      async *complete() {
        completions += 1
        if (completions === 1) {
          throw new ModelProviderError('prompt is too long for the context', {
            retryable: true,
          })
        }
        yield { type: 'text-delta', delta: 'recovered answer' }
        yield { type: 'usage', usage: { inputTokens: 4, outputTokens: 2 } }
      },
    }
    const events: RuntimeEvent[] = []
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider,
      eventSink: (event) => events.push(event),
      compactor: {
        async compact() {
          return {
            summary: 'REACTIVE_RETRY_SUMMARY',
            usage: { inputTokens: 0, outputTokens: 0 },
            durationMs: 1,
            model: 'reactive-model',
          }
        },
      },
    })

    const result = await service.run('start')

    expect(result.text).toBe('recovered answer')
    // One reactive compaction retry, then a clean second attempt.
    expect(completions).toBe(2)
    expect(events).toContainEqual({ type: 'state', state: 'compacting' })
    expect(
      events.some(
        (event) =>
          event.type === 'compact-boundary' && event.trigger === 'auto',
      ),
    ).toBe(true)
  })

  it('fails deterministically after the single reactive prompt-too-long retry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-reactive-retry-blocked-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    let completions = 0
    const provider: ModelProvider = {
      model: 'reactive-model',
      capabilities: {
        streaming: true,
        usage: true,
        tools: false,
        contextWindowTokens: 200_000,
      },
      async *complete() {
        completions += 1
        throw new ModelProviderError('prompt is too long for the context', {
          retryable: true,
        })
      },
    }
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider,
      compactor: {
        async compact() {
          return {
            summary: 'REACTIVE_RETRY_SUMMARY',
            usage: { inputTokens: 0, outputTokens: 0 },
            durationMs: 1,
            model: 'reactive-model',
          }
        },
      },
    })

    await expect(service.run('start')).rejects.toThrow(
      'prompt is too long for the context',
    )
    // The retry is attempted exactly once before the original error surfaces.
    expect(completions).toBe(2)
  })

  it('records manual compact usage without cost and diagnoses an unknown model price', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-manual-compact-unknown-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: {
        ...queuedProvider(['original answer']),
        model: 'priced-run-model',
      },
      compactor: {
        async compact() {
          return {
            summary: 'unpriced manual summary',
            usage: { inputTokens: 5, outputTokens: 3 },
            durationMs: 11,
            model: 'unpriced-compact-model',
          }
        },
      },
      pricing: new ModelPricingRegistry({
        'priced-run-model': { inputPerMillionUsd: 1, outputPerMillionUsd: 1 },
      }),
    })

    const run = await service.run('start')
    await service.compact(run.sessionId)
    const snapshot = await service.costSnapshot(run.sessionId)

    expect(snapshot.hasUnknownModelCost).toBe(true)
    expect(snapshot.modelUsage['unpriced-compact-model']).toEqual({
      inputTokens: 5,
      outputTokens: 3,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUsd: 0,
    })
    expect(snapshot.apiDurationMs).toBe(11)
  })

  it('loads restored cost state in a fresh service and persists the combined snapshot once on a direct compact close', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-manual-compact-restore-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const restored: ClaudeSessionCostState = {
      sessionId,
      totalCostUsd: 12.5,
      apiDurationMs: 1000,
      apiDurationWithoutRetriesMs: 900,
      toolDurationMs: 500,
      wallDurationMs: 60000,
      linesAdded: 10,
      linesRemoved: 2,
      modelUsage: {
        'restored-model': {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadInputTokens: 10,
          cacheCreationInputTokens: 5,
          webSearchRequests: 1,
          costUsd: 12.5,
        },
      },
    }

    const seedService = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: queuedProvider(['existing answer']),
    })
    await seedService.run('seed transcript', undefined, sessionId)
    await seedService.close()

    const loads: string[] = []
    const saves: ClaudeSessionCostState[] = []
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: {
        ...queuedProvider(['existing answer']),
        model: 'run-model',
      },
      compactor: {
        async compact() {
          return {
            summary: 'restored manual summary',
            usage: {
              inputTokens: 20,
              outputTokens: 10,
              webSearchRequests: 1,
            },
            durationMs: 33,
            model: 'compact-model',
          }
        },
      },
      pricing: new ModelPricingRegistry({
        'run-model': { inputPerMillionUsd: 1, outputPerMillionUsd: 1 },
        'compact-model': { inputPerMillionUsd: 1, outputPerMillionUsd: 1 },
      }),
      costStateStore: {
        load: async (id) => {
          loads.push(id)
          return id === sessionId ? restored : null
        },
        save: async (state) => {
          saves.push(state)
        },
      },
    })

    const compacted = await service.compact(sessionId)

    expect(compacted.summary).toBe('restored manual summary')
    expect(loads).toEqual([sessionId])

    const after = await service.costSnapshot(sessionId)
    expect(after.totalCostUsd).toBeCloseTo(12.5 + 30 / 1_000_000)
    expect(after.apiDurationMs).toBe(1000 + 33)
    expect(after.apiDurationWithoutRetriesMs).toBe(900 + 33)
    expect(after.toolDurationMs).toBe(500)
    expect(after.linesAdded).toBe(10)
    expect(after.linesRemoved).toBe(2)
    expect(after.modelUsage['restored-model']).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 10,
      cacheCreationInputTokens: 5,
      webSearchRequests: 1,
      costUsd: 12.5,
    })
    expect(after.modelUsage['compact-model']).toEqual({
      inputTokens: 20,
      outputTokens: 10,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 1,
      costUsd: 30 / 1_000_000,
    })
    expect(after.hasUnknownModelCost).toBe(false)

    await service.close()
    expect(saves).toHaveLength(1)
    const saved = saves[0]
    if (!saved) throw new Error('expected one persisted cost snapshot')
    expect(saved).toMatchObject({
      sessionId,
      apiDurationMs: after.apiDurationMs,
      apiDurationWithoutRetriesMs: after.apiDurationWithoutRetriesMs,
      toolDurationMs: after.toolDurationMs,
      linesAdded: 10,
      linesRemoved: 2,
    })
    expect(saved.totalCostUsd).toBeCloseTo(12.5 + 30 / 1_000_000)
    expect(saved.modelUsage['compact-model']).toEqual({
      inputTokens: 20,
      outputTokens: 10,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 1,
      costUsd: 30 / 1_000_000,
    })
  })

  it('rejects before append when restored manual compact input overflows a safe-integer total', async () => {
    const root = await mkdtemp(
      join(tmpdir(), 'praxis-manual-compact-overflow-'),
    )
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const sessionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    const restored: ClaudeSessionCostState = {
      sessionId,
      totalCostUsd: 12.5,
      apiDurationMs: 1000,
      apiDurationWithoutRetriesMs: 900,
      toolDurationMs: 500,
      wallDurationMs: 60000,
      linesAdded: 10,
      linesRemoved: 2,
      modelUsage: {
        'compact-model': {
          inputTokens: Number.MAX_SAFE_INTEGER,
          outputTokens: 50,
          cacheReadInputTokens: 10,
          cacheCreationInputTokens: 5,
          webSearchRequests: 1,
          costUsd: 12.5,
        },
      },
    }

    const seedService = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: queuedProvider(['existing answer']),
    })
    await seedService.run('seed transcript', undefined, sessionId)
    await seedService.close()

    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: queuedProvider(['existing answer']),
      compactor: {
        async compact() {
          return {
            summary: 'overflowing manual summary',
            usage: { inputTokens: 1, outputTokens: 1 },
            durationMs: 5,
            model: 'compact-model',
          }
        },
      },
      pricing: new ModelPricingRegistry({
        'compact-model': { inputPerMillionUsd: 1, outputPerMillionUsd: 1 },
      }),
      costStateStore: {
        load: async (id) => (id === sessionId ? restored : null),
        save: async () => undefined,
      },
    })

    const before = await service.costSnapshot(sessionId)
    await expect(service.compact(sessionId)).rejects.toThrow(
      'inputTokens total must be a safe integer',
    )
    const after = await service.costSnapshot(sessionId)
    expect(trackedTotals(after)).toEqual(trackedTotals(before))

    const transcript = await readFile(
      resolveClaudePaths({
        configDir: configRoot,
        cwd,
        sessionId,
      }).sessionFile,
      'utf8',
    )
    expect(transcript).not.toContain('compact_boundary')
  })

  it('meters a selected manual compact once and avoids duplicate accounting on a later normal turn', async () => {
    const root = await mkdtemp(
      join(tmpdir(), 'praxis-manual-compact-selected-'),
    )
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: {
        ...queuedProvider(['first answer', 'second answer', 'third answer']),
        model: 'shared-model',
      },
      compactor: {
        async compact() {
          return {
            summary: 'selected summary',
            usage: { inputTokens: 7, outputTokens: 4 },
            durationMs: 9,
            model: 'shared-model',
          }
        },
      },
      pricing: new ModelPricingRegistry({
        'shared-model': { inputPerMillionUsd: 1, outputPerMillionUsd: 1 },
      }),
    })

    const run = await service.run('first prompt')
    await service.resume(run.sessionId, 'second prompt')
    const second = (await service.rewindPoints(run.sessionId)).find(
      (point) => point.prompt === 'second prompt',
    )
    if (!second) throw new Error('second rewind point missing')

    await service.compact(run.sessionId, undefined, {
      messageId: second.messageId,
      direction: 'to',
    })
    const afterCompact = await service.costSnapshot(run.sessionId)
    expect(afterCompact.modelUsage['shared-model']).toMatchObject({
      inputTokens: 13,
      outputTokens: 8,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
    })
    expect(afterCompact.modelUsage['shared-model']?.costUsd).toBeCloseTo(
      21 / 1_000_000,
    )
    expect(afterCompact.apiDurationMs).toBe(9)

    await service.resume(run.sessionId, 'third prompt')
    const afterTurn = await service.costSnapshot(run.sessionId)
    expect(afterTurn.modelUsage['shared-model']).toMatchObject({
      inputTokens: 16,
      outputTokens: 10,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
    })
    expect(afterTurn.modelUsage['shared-model']?.costUsd).toBeCloseTo(
      26 / 1_000_000,
    )
    expect(afterTurn.apiDurationMs).toBe(9)
  })

  it('does not mutate transcript or tracker totals when the manual compactor fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-manual-compact-fail-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: queuedProvider(['original answer']),
      compactor: {
        async compact() {
          throw new Error('manual summary provider failed')
        },
      },
    })

    const run = await service.run('start')
    const before = await service.costSnapshot(run.sessionId)
    await expect(service.compact(run.sessionId)).rejects.toThrow(
      'manual summary provider failed',
    )
    const after = await service.costSnapshot(run.sessionId)
    expect(trackedTotals(after)).toEqual(trackedTotals(before))

    const transcript = await readFile(
      resolveClaudePaths({
        configDir: configRoot,
        cwd,
        sessionId: run.sessionId,
      }).sessionFile,
      'utf8',
    )
    expect(transcript).not.toContain('compact_boundary')
  })

  it('does not append or record tracker totals for an invalid manual compact duration', async () => {
    const root = await mkdtemp(
      join(tmpdir(), 'praxis-manual-compact-duration-'),
    )
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: queuedProvider(['original answer']),
      compactor: {
        async compact() {
          return {
            summary: 'invalid duration summary',
            usage: { inputTokens: 1, outputTokens: 1 },
            durationMs: -5,
            model: 'compact-model',
          }
        },
      },
    })

    const run = await service.run('start')
    const before = await service.costSnapshot(run.sessionId)
    await expect(service.compact(run.sessionId)).rejects.toThrow(
      'compaction durationMs must be a finite nonnegative number',
    )
    const after = await service.costSnapshot(run.sessionId)
    expect(trackedTotals(after)).toEqual(trackedTotals(before))

    const transcript = await readFile(
      resolveClaudePaths({
        configDir: configRoot,
        cwd,
        sessionId: run.sessionId,
      }).sessionFile,
      'utf8',
    )
    expect(transcript).not.toContain('compact_boundary')
  })

  it('fails before append when manual compact usage lacks a model identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-manual-compact-model-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: queuedProvider(['original answer']),
      compactor: {
        async compact() {
          return {
            summary: 'unattributed summary',
            usage: { inputTokens: 1, outputTokens: 1 },
            durationMs: 5,
          }
        },
      },
    })

    const run = await service.run('start')
    const before = await service.costSnapshot(run.sessionId)
    await expect(service.compact(run.sessionId)).rejects.toThrow(
      'Manual compact usage requires a nonblank model identity',
    )
    const after = await service.costSnapshot(run.sessionId)
    expect(trackedTotals(after)).toEqual(trackedTotals(before))

    const transcript = await readFile(
      resolveClaudePaths({
        configDir: configRoot,
        cwd,
        sessionId: run.sessionId,
      }).sessionFile,
      'utf8',
    )
    expect(transcript).not.toContain('compact_boundary')
  })

  it.each([
    ['inputTokens', 'usage.inputTokens', -1],
    ['outputTokens', 'usage.outputTokens', 1.5],
    ['cacheReadInputTokens', 'usage.cacheReadInputTokens', Number.NaN],
    [
      'cacheCreationInputTokens',
      'usage.cacheCreationInputTokens',
      Number.POSITIVE_INFINITY,
    ],
    ['webSearchRequests', 'usage.webSearchRequests', -7],
  ])(
    'does not append or record tracker totals for an invalid manual compact %s',
    async (field, errorField, invalidValue) => {
      const root = await mkdtemp(join(tmpdir(), 'praxis-manual-compact-usage-'))
      roots.push(root)
      const configRoot = join(root, 'config')
      const cwd = join(root, 'project')
      const service = new ClaudeSessionService({
        configRoot,
        cwd,
        claudeVersion: '2.1.208',
        provider: queuedProvider(['original answer']),
        compactor: {
          async compact() {
            return {
              summary: 'invalid usage summary',
              usage: { inputTokens: 1, outputTokens: 1, [field]: invalidValue },
              durationMs: 5,
              model: 'compact-model',
            }
          },
        },
      })

      const run = await service.run('start')
      const before = await service.costSnapshot(run.sessionId)
      await expect(service.compact(run.sessionId)).rejects.toThrow(
        `${errorField} must be a nonnegative safe integer`,
      )
      const after = await service.costSnapshot(run.sessionId)
      expect(trackedTotals(after)).toEqual(trackedTotals(before))

      const transcript = await readFile(
        resolveClaudePaths({
          configDir: configRoot,
          cwd,
          sessionId: run.sessionId,
        }).sessionFile,
        'utf8',
      )
      expect(transcript).not.toContain('compact_boundary')
    },
  )

  it('does not touch cost state when compacting a nonexistent session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-manual-compact-missing-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const missingId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const load = vi.fn(async () => null)
    const save = vi.fn(async () => undefined)
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: queuedProvider([]),
      costStateStore: { load, save },
    })

    await expect(service.compact(missingId)).rejects.toThrow(
      `Claude session not found: ${missingId}`,
    )
    expect(load).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
  })

  it('fails before append when a zero-usage compact has positive duration but no model identity', async () => {
    const root = await mkdtemp(
      join(tmpdir(), 'praxis-manual-compact-duration-model-'),
    )
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: queuedProvider(['original answer']),
      compactor: {
        async compact() {
          return {
            summary: 'timed unmodeled summary',
            usage: { inputTokens: 0, outputTokens: 0 },
            durationMs: 7,
          }
        },
      },
    })

    const run = await service.run('start')
    const before = await service.costSnapshot(run.sessionId)
    await expect(service.compact(run.sessionId)).rejects.toThrow(
      'Manual compact usage requires a nonblank model identity',
    )
    const after = await service.costSnapshot(run.sessionId)
    expect(trackedTotals(after)).toEqual(trackedTotals(before))

    const transcript = await readFile(
      resolveClaudePaths({
        configDir: configRoot,
        cwd,
        sessionId: run.sessionId,
      }).sessionFile,
      'utf8',
    )
    expect(transcript).not.toContain('compact_boundary')
  })

  it('does not record a zero model row for an all-zero valid manual compact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-manual-compact-zero-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: queuedProvider(['original answer']),
      compactor: {
        async compact() {
          return {
            summary: 'zero summary',
            usage: { inputTokens: 0, outputTokens: 0 },
            durationMs: 0,
            model: 'zero-model',
          }
        },
      },
      pricing: new ModelPricingRegistry({
        'zero-model': { inputPerMillionUsd: 1, outputPerMillionUsd: 1 },
      }),
    })

    const run = await service.run('start')
    const result = await service.compact(run.sessionId)
    expect(result.summary).toBe('zero summary')
    const snapshot = await service.costSnapshot(run.sessionId)
    expect(snapshot.modelUsage['zero-model']).toBeUndefined()
    expect(snapshot.apiDurationMs).toBe(0)

    const transcript = await readFile(
      resolveClaudePaths({
        configDir: configRoot,
        cwd,
        sessionId: run.sessionId,
      }).sessionFile,
      'utf8',
    )
    expect(transcript).toContain('compact_boundary')
  })

  it('does not append or record tracker totals when a manual compact is cancelled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-manual-compact-cancel-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    let releaseCompactor: (() => void) | undefined
    const compactorGate = new Promise<void>((resolve) => {
      releaseCompactor = resolve
    })
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: queuedProvider(['original answer']),
      compactor: {
        async compact() {
          await compactorGate
          return {
            summary: 'late summary',
            usage: { inputTokens: 1, outputTokens: 1 },
            durationMs: 5,
            model: 'compact-model',
          }
        },
      },
    })

    const run = await service.run('start')
    const before = await service.costSnapshot(run.sessionId)
    const controller = new AbortController()
    const compactPromise = service.compact(run.sessionId, controller.signal)
    controller.abort()
    releaseCompactor?.()
    await expect(compactPromise).rejects.toThrow('Agent run cancelled')
    const after = await service.costSnapshot(run.sessionId)
    expect(trackedTotals(after)).toEqual(trackedTotals(before))

    const transcript = await readFile(
      resolveClaudePaths({
        configDir: configRoot,
        cwd,
        sessionId: run.sessionId,
      }).sessionFile,
      'utf8',
    )
    expect(transcript).not.toContain('compact_boundary')
  })

  it('does not record tracker totals for an empty manual compact summary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-manual-compact-empty-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: queuedProvider(['original answer']),
      compactor: {
        async compact() {
          return {
            summary: '',
            usage: { inputTokens: 1, outputTokens: 1 },
            durationMs: 5,
            model: 'compact-model',
          }
        },
      },
    })

    const run = await service.run('start')
    const result = await service.compact(run.sessionId)
    expect(result.summary).toBe('')
    const snapshot = await service.costSnapshot(run.sessionId)
    expect(snapshot.modelUsage['compact-model']).toBeUndefined()
    expect(snapshot.apiDurationMs).toBe(0)
    expect(snapshot.totalCostUsd).toBe(0)
  })

  it('does not record tracker totals when the manual compact lease conflicts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-manual-compact-lock-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const sessionId = '66666666-6666-4666-8666-666666666666'
    let announceStarted: (() => void) | undefined
    let releaseProvider: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      announceStarted = resolve
    })
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve
    })
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: {
        capabilities: { streaming: true, usage: true, tools: false },
        async *complete() {
          announceStarted?.()
          await providerGate
          yield { type: 'text-delta', delta: 'finished' }
        },
      },
      compactor: {
        async compact() {
          throw new Error('compactor must not run on a conflicting lease')
        },
      },
      sessionPersistence: false,
    })

    const activeTurn = service.run('first writer', undefined, sessionId)
    await started
    try {
      await expect(service.compact(sessionId)).rejects.toThrow(
        'Claude transcript compact conflict',
      )
    } finally {
      releaseProvider?.()
    }
    await expect(activeTurn).resolves.toMatchObject({ text: 'finished' })
    const snapshot = await service.costSnapshot(sessionId)
    expect(snapshot.totalCostUsd).toBe(0)
    expect(snapshot.apiDurationMs).toBe(0)
    expect(snapshot.modelUsage).toEqual({})
  })

  it('relocates an active session and continues it from the new cwd', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-session-cd-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const originalCwd = join(root, 'original')
    const relocatedCwd = join(root, 'relocated')
    await mkdir(originalCwd)
    await mkdir(relocatedCwd)
    const canonicalRelocatedCwd = await realpath(relocatedCwd)
    const serviceWorkspace = new WorkspaceContext(originalCwd)
    const service = new ClaudeSessionService({
      configRoot,
      cwd: originalCwd,
      claudeVersion: '2.1.208',
      workspace: serviceWorkspace,
      provider: queuedProvider(['before move', 'after move', 'after shell']),
      tools: new LocalToolRegistry({
        cwd: originalCwd,
        cwdProvider: () => serviceWorkspace.cwd(),
      }),
      permissions: { resolve: () => ({ behavior: 'allow' }) },
    })
    const run = await service.run('start here')
    const original = resolveClaudePaths({
      configDir: configRoot,
      cwd: originalCwd,
      sessionId: run.sessionId,
    }).sessionFile
    const relocated = resolveClaudePaths({
      configDir: configRoot,
      cwd: canonicalRelocatedCwd,
      sessionId: run.sessionId,
    }).sessionFile

    await expect(service.changeCwd(run.sessionId, relocatedCwd)).resolves.toBe(
      canonicalRelocatedCwd,
    )
    await expect(readFile(original)).rejects.toMatchObject({ code: 'ENOENT' })
    const moved = await readFile(relocated, 'utf8')
    expect(moved).toContain(
      `"type":"relocated","sessionId":"${run.sessionId}","relocatedCwd":"${canonicalRelocatedCwd}"`,
    )
    expect(moved).toContain('<command-name>/cd</command-name>')
    expect(moved).toContain(
      `<command-args>${canonicalRelocatedCwd}</command-args>`,
    )
    expect(moved).toContain(
      `<local-command-stdout>Moved to ${canonicalRelocatedCwd}</local-command-stdout>`,
    )
    expect(moved).toContain(
      `The session's working directory has changed to ${canonicalRelocatedCwd} (via /cd).`,
    )

    await service.resume(run.sessionId, 'continue here')
    await service.resumeShell(run.sessionId, 'pwd')
    const continued = await readFile(relocated, 'utf8')
    expect(continued).toContain(`"cwd":"${canonicalRelocatedCwd}"`)
    expect(continued).toContain(
      `<bash-stdout>${canonicalRelocatedCwd}\\n</bash-stdout>`,
    )
    expect(continued).toContain('<bash-input>pwd</bash-input>')
    expect(await service.sessions()).toEqual([
      expect.objectContaining({ sessionId: run.sessionId }),
    ])
  })

  it('changes cwd without a session and resolves relative symlink paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-session-cd-empty-'))
    roots.push(root)
    const originalCwd = join(root, 'original')
    const targetCwd = join(root, 'target')
    const targetLink = join(originalCwd, 'next')
    await mkdir(originalCwd)
    await mkdir(targetCwd)
    await symlink(targetCwd, targetLink)
    const canonicalTarget = await realpath(targetCwd)
    const service = new ClaudeSessionService({
      configRoot: join(root, 'config'),
      cwd: originalCwd,
      claudeVersion: '2.1.208',
      provider: queuedProvider(['created after move']),
    })

    await expect(service.changeCwd(undefined, 'next')).resolves.toBe(
      canonicalTarget,
    )
    const run = await service.run('start in target')
    const targetSession = resolveClaudePaths({
      configDir: join(root, 'config'),
      cwd: canonicalTarget,
      sessionId: run.sessionId,
    }).sessionFile
    await expect(readFile(targetSession, 'utf8')).resolves.toContain(
      `"cwd":"${canonicalTarget}"`,
    )
  })

  it('fails closed when the relocation target transcript already exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-session-cd-conflict-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const originalCwd = join(root, 'original')
    const targetCwd = join(root, 'target')
    await mkdir(originalCwd)
    await mkdir(targetCwd)
    const service = new ClaudeSessionService({
      configRoot,
      cwd: originalCwd,
      claudeVersion: '2.1.208',
      workspace: new WorkspaceContext(originalCwd),
      provider: queuedProvider(['before move']),
    })
    const run = await service.run('start here')
    const source = resolveClaudePaths({
      configDir: configRoot,
      cwd: originalCwd,
      sessionId: run.sessionId,
    }).sessionFile
    const target = resolveClaudePaths({
      configDir: configRoot,
      cwd: await realpath(targetCwd),
      sessionId: run.sessionId,
    }).sessionFile
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, 'existing target\n')
    const sourceBefore = await readFile(source, 'utf8')

    await expect(service.changeCwd(run.sessionId, targetCwd)).rejects.toThrow(
      'already exists at relocation target',
    )
    await expect(readFile(source, 'utf8')).resolves.toBe(sourceBefore)
    await expect(readFile(target, 'utf8')).resolves.toBe('existing target\n')
  })

  it('leaves the source unchanged when publishing a staged relocation fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-session-cd-rollback-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const originalCwd = join(root, 'original')
    const targetCwd = join(root, 'target')
    await mkdir(originalCwd)
    await mkdir(targetCwd)
    const service = new ClaudeSessionService({
      configRoot,
      cwd: originalCwd,
      claudeVersion: '2.1.208',
      workspace: new WorkspaceContext(originalCwd),
      provider: queuedProvider(['before move']),
    })
    const run = await service.run('start here')
    const sourcePaths = resolveClaudePaths({
      configDir: configRoot,
      cwd: originalCwd,
      sessionId: run.sessionId,
    })
    const targetPaths = resolveClaudePaths({
      configDir: configRoot,
      cwd: await realpath(targetCwd),
      sessionId: run.sessionId,
    })
    const sourceBefore = await readFile(sourcePaths.sessionFile, 'utf8')

    await chmod(sourcePaths.projectRoot, 0o555)
    try {
      await expect(
        service.changeCwd(run.sessionId, targetCwd),
      ).rejects.toThrow()
    } finally {
      await chmod(sourcePaths.projectRoot, 0o755)
    }
    await expect(readFile(sourcePaths.sessionFile, 'utf8')).resolves.toBe(
      sourceBefore,
    )
    await expect(readFile(targetPaths.sessionFile)).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await expect(readdir(targetPaths.projectRoot)).resolves.toEqual([])
  })

  it('records native /cd usage output without changing cwd', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-session-cd-usage-'))
    roots.push(root)
    const service = new ClaudeSessionService({
      configRoot: join(root, 'config'),
      cwd: root,
      claudeVersion: '2.1.208',
      provider: queuedProvider(['before usage']),
    })
    const run = await service.run('start here')

    await service.recordCdUsage(run.sessionId)

    const transcript = await readFile(
      resolveClaudePaths({
        configDir: join(root, 'config'),
        cwd: root,
        sessionId: run.sessionId,
      }).sessionFile,
      'utf8',
    )
    expect(transcript).toContain('<command-args></command-args>')
    expect(transcript).toContain(
      '<local-command-stdout>Usage: /cd <path></local-command-stdout>',
    )
  })

  it('answers a side question from session context without changing JSONL', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-session-btw-'))
    roots.push(root)
    const requests: ModelRequest[] = []
    const responses = ['main context answer', 'side answer']
    const provider: ModelProvider = {
      capabilities: { streaming: true, usage: true, tools: true },
      async *complete(request) {
        requests.push(request)
        const response = responses.shift()
        if (!response) throw new Error('Provider response fixture exhausted')
        yield { type: 'text-delta', delta: response.slice(0, 4) }
        yield { type: 'text-delta', delta: response.slice(4) }
        yield {
          type: 'usage',
          usage: { inputTokens: 7, outputTokens: 3 },
        }
      },
    }
    const service = new ClaudeSessionService({
      configRoot: join(root, 'config'),
      cwd: root,
      claudeVersion: '2.1.208',
      provider,
    })
    const run = await service.run('remember main context')
    const sessionFile = resolveClaudePaths({
      configDir: join(root, 'config'),
      cwd: root,
      sessionId: run.sessionId,
    }).sessionFile
    const before = await readFile(sessionFile, 'utf8')
    const deltas: string[] = []

    const sideResult = await service.answerSideQuestion(
      run.sessionId,
      'what was the answer?',
      undefined,
      (delta) => deltas.push(delta),
    )
    expect(sideResult).toMatchObject({
      sessionId: run.sessionId,
      text: 'side answer',
      usage: { inputTokens: 7, outputTokens: 3 },
      modelUsage: { 'praxis/provider': { inputTokens: 7, outputTokens: 3 } },
    })
    expect(sideResult.durationApiMs).toBeGreaterThanOrEqual(0)
    expect(sideResult.durationApiWithoutRetriesMs).toBe(
      sideResult.durationApiMs,
    )

    expect(deltas).toEqual(['side', ' answer'])
    expect(requests[1]?.tools).toBeUndefined()
    expect(requests[1]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          content: 'main context answer',
        }),
        { role: 'user', content: 'what was the answer?' },
      ]),
    )
    await expect(readFile(sessionFile, 'utf8')).resolves.toBe(before)
    const inputHistory = JSON.parse(
      await readFile(join(root, 'config', 'history.jsonl'), 'utf8'),
    ) as Record<string, unknown>
    expect(inputHistory).toMatchObject({
      display: '/btw what was the answer?',
      pastedContents: {},
      project: root,
      sessionId: run.sessionId,
    })
  })

  it('records native bare /btw usage without a provider call', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-session-btw-usage-'))
    roots.push(root)
    const service = new ClaudeSessionService({
      configRoot: join(root, 'config'),
      cwd: root,
      claudeVersion: '2.1.208',
      provider: queuedProvider(['main answer']),
    })
    const run = await service.run('start here')

    await service.recordBtwUsage(run.sessionId)

    const transcript = await readFile(
      resolveClaudePaths({
        configDir: join(root, 'config'),
        cwd: root,
        sessionId: run.sessionId,
      }).sessionFile,
      'utf8',
    )
    expect(transcript).toContain('<command-name>/btw</command-name>')
    expect(transcript).toContain(
      '<local-command-stdout>Usage: /btw <your question></local-command-stdout>',
    )
    await expect(
      readFile(join(root, 'config', 'history.jsonl'), 'utf8'),
    ).resolves.toContain(`"display":"/btw"`)
  })

  it('creates a reusable native session for fresh /btw usage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-session-btw-fresh-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const service = new ClaudeSessionService({
      configRoot,
      cwd: root,
      claudeVersion: '2.1.208',
      provider: queuedProvider(['main answer']),
    })

    const sessionId = await service.recordBtwUsage(
      undefined,
      'bypassPermissions',
    )
    const paths = resolveClaudePaths({
      configDir: configRoot,
      cwd: root,
      sessionId,
    })
    const transcript = (await readFile(paths.sessionFile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)

    expect(transcript.slice(0, 2)).toEqual([
      { type: 'mode', mode: 'normal', sessionId },
      {
        type: 'permission-mode',
        permissionMode: 'bypassPermissions',
        sessionId,
      },
    ])
    expect(transcript.at(-1)).toMatchObject({
      type: 'last-prompt',
      sessionId,
      leafUuid: transcript.at(-2)?.uuid,
    })
    await expect(
      readFile(join(configRoot, 'history.jsonl'), 'utf8'),
    ).resolves.toContain(`"sessionId":"${sessionId}"`)
    await expect(service.resume(sessionId, 'continue')).resolves.toMatchObject({
      sessionId,
      text: 'main answer',
    })
  })

  it('records a native /color command before any provider turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-color-fresh-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const service = new ClaudeSessionService({
      configRoot,
      cwd: root,
      claudeVersion: '2.1.208',
      provider: queuedProvider(['must not run']),
    })

    const sessionId = await service.recordColorUsage(
      undefined,
      { kind: 'color', color: 'purple' },
      '/color purple',
      'bypassPermissions',
    )
    const transcript = (
      await readFile(
        resolveClaudePaths({ configDir: configRoot, cwd: root, sessionId })
          .sessionFile,
        'utf8',
      )
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)

    expect(transcript.slice(0, 3)).toEqual([
      { type: 'agent-color', agentColor: 'purple', sessionId },
      { type: 'mode', mode: 'normal', sessionId },
      {
        type: 'permission-mode',
        permissionMode: 'bypassPermissions',
        sessionId,
      },
    ])
    const command = transcript.slice(3)
    expect(command.map((entry) => entry.type)).toEqual(['system', 'system'])
    expect(command[0]).toMatchObject({
      subtype: 'local_command',
      content:
        '<command-name>/color</command-name>\n            <command-message>color</command-message>\n            <command-args>purple</command-args>',
    })
    expect(command[1]).toMatchObject({
      subtype: 'local_command',
      content:
        '<local-command-stdout>Session color set to: purple</local-command-stdout>',
      parentUuid: command[0]?.uuid,
    })
    await expect(
      readFile(join(configRoot, 'history.jsonl'), 'utf8'),
    ).resolves.toContain('"display":"/color purple"')
    await expect(service.readEffectiveAgentColor(sessionId)).resolves.toBe(
      'purple',
    )
  })

  it('appends agent-color before the local command pair of an existing session', async () => {
    const { configRoot, cwd, service } = await createService()
    const run = await service.run('start here')

    await service.recordColorUsage(
      run.sessionId,
      { kind: 'color', color: 'cyan' },
      '/color cyan',
    )
    await service.recordColorUsage(
      run.sessionId,
      { kind: 'color', color: 'yellow' },
      '/color yellow',
    )
    await service.recordColorUsage(
      run.sessionId,
      { kind: 'reset' },
      '/color reset',
    )

    const transcript = (
      await readFile(
        resolveClaudePaths({
          configDir: configRoot,
          cwd,
          sessionId: run.sessionId,
        }).sessionFile,
        'utf8',
      )
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    const colorEntries = transcript.filter(
      (entry) => entry.type === 'agent-color',
    )
    expect(colorEntries).toEqual([
      { type: 'agent-color', agentColor: 'cyan', sessionId: run.sessionId },
      { type: 'agent-color', agentColor: 'yellow', sessionId: run.sessionId },
      { type: 'agent-color', agentColor: 'default', sessionId: run.sessionId },
    ])
    const resetOutput = transcript.find(
      (entry) =>
        entry.type === 'system' &&
        String(entry.content).includes('Session color reset to default'),
    )
    expect(resetOutput).toBeDefined()
    await expect(service.readEffectiveAgentColor(run.sessionId)).resolves.toBe(
      undefined,
    )
  })

  it('records invalid colors without writing an agent-color entry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-color-invalid-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const service = new ClaudeSessionService({
      configRoot,
      cwd: root,
      claudeVersion: '2.1.208',
      provider: queuedProvider(['must not run']),
    })

    const sessionId = await service.recordColorUsage(
      undefined,
      { kind: 'invalid', input: 'bogus' },
      '/color bogus',
    )
    const transcript = (
      await readFile(
        resolveClaudePaths({ configDir: configRoot, cwd: root, sessionId })
          .sessionFile,
        'utf8',
      )
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(transcript.some((entry) => entry.type === 'agent-color')).toBe(false)
    expect(transcript.at(-1)).toMatchObject({
      subtype: 'local_command',
      content:
        '<local-command-stdout>Invalid color "bogus". Available colors: red, blue, green, yellow, purple, orange, pink, cyan, default</local-command-stdout>',
    })
    await expect(service.readEffectiveAgentColor(sessionId)).resolves.toBe(
      undefined,
    )
    await expect(
      readFile(join(configRoot, 'history.jsonl'), 'utf8'),
    ).resolves.toContain('"display":"/color bogus"')
  })

  it('reads the effective agent color from a session transcript', async () => {
    const { configRoot, cwd, service } = await createService()
    const run = await service.run('start here')
    await expect(service.readEffectiveAgentColor(run.sessionId)).resolves.toBe(
      undefined,
    )
    await service.recordColorUsage(
      run.sessionId,
      { kind: 'color', color: 'orange' },
      '/color orange',
    )
    await expect(service.readEffectiveAgentColor(run.sessionId)).resolves.toBe(
      'orange',
    )
    await service.recordColorUsage(
      run.sessionId,
      { kind: 'reset' },
      '/color reset',
    )
    await expect(service.readEffectiveAgentColor(run.sessionId)).resolves.toBe(
      undefined,
    )
    await expect(
      readFile(join(configRoot, 'history.jsonl'), 'utf8'),
    ).resolves.toContain('"display":"/color orange"')
    await expect(
      readFile(join(configRoot, 'history.jsonl'), 'utf8'),
    ).resolves.toContain('"display":"/color reset"')
    void cwd
  })

  it('creates a fresh local session at an explicit headless session id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-color-explicit-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: queuedProvider(['must not run']),
    })
    const sessionId = '12121212-1212-4212-8212-121212121212'

    const active = await service.recordColorUsage(
      sessionId,
      { kind: 'color', color: 'purple' },
      '/color purple',
      'bypassPermissions',
      { createSession: true },
    )
    expect(active).toBe(sessionId)
    const transcript = (
      await readFile(
        resolveClaudePaths({ configDir: configRoot, cwd, sessionId })
          .sessionFile,
        'utf8',
      )
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(transcript.slice(0, 3)).toEqual([
      { type: 'agent-color', agentColor: 'purple', sessionId },
      { type: 'mode', mode: 'normal', sessionId },
      {
        type: 'permission-mode',
        permissionMode: 'bypassPermissions',
        sessionId,
      },
    ])
    await expect(
      readFile(join(configRoot, 'history.jsonl'), 'utf8'),
    ).resolves.toContain('"display":"/color purple"')

    await service.recordColorUsage(
      active,
      { kind: 'color', color: 'cyan' },
      '/color cyan',
    )
    const afterSecond = (
      await readFile(
        resolveClaudePaths({ configDir: configRoot, cwd, sessionId })
          .sessionFile,
        'utf8',
      )
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(afterSecond.filter((entry) => entry.type === 'agent-color')).toEqual(
      [
        { type: 'agent-color', agentColor: 'purple', sessionId },
        { type: 'agent-color', agentColor: 'cyan', sessionId },
      ],
    )
  })

  it('creates an explicit local session for an invalid color without an agent-color entry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-color-explicit-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const service = new ClaudeSessionService({
      configRoot,
      cwd: root,
      claudeVersion: '2.1.208',
      provider: queuedProvider(['must not run']),
    })
    const sessionId = '13131313-1313-4313-8313-131313131313'

    await expect(
      service.recordColorUsage(
        sessionId,
        { kind: 'invalid', input: 'bogus' },
        '/color bogus',
        'bypassPermissions',
        { createSession: true },
      ),
    ).resolves.toBe(sessionId)
    const transcript = (
      await readFile(
        resolveClaudePaths({ configDir: configRoot, cwd: root, sessionId })
          .sessionFile,
        'utf8',
      )
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(transcript.some((entry) => entry.type === 'agent-color')).toBe(false)
    expect(transcript.slice(0, 2)).toEqual([
      { type: 'mode', mode: 'normal', sessionId },
      {
        type: 'permission-mode',
        permissionMode: 'bypassPermissions',
        sessionId,
      },
    ])
  })

  it('rejects appending to a missing session without createSession', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-color-explicit-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const service = new ClaudeSessionService({
      configRoot,
      cwd: root,
      claudeVersion: '2.1.208',
      provider: queuedProvider(['must not run']),
    })
    const missingId = '14141414-1414-4414-8414-141414141414'

    await expect(
      service.recordColorUsage(
        missingId,
        { kind: 'color', color: 'red' },
        '/color red',
      ),
    ).rejects.toThrow(`Claude session not found: ${missingId}`)
    await expect(
      readFile(
        resolveClaudePaths({
          configDir: configRoot,
          cwd: root,
          sessionId: missingId,
        }).sessionFile,
        'utf8',
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects creating an explicit local session that is already in use', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-color-explicit-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const service = new ClaudeSessionService({
      configRoot,
      cwd: root,
      claudeVersion: '2.1.208',
      provider: queuedProvider(['must not run']),
    })
    const sessionId = '15151515-1515-4515-8515-151515151515'
    await service.recordColorUsage(
      sessionId,
      { kind: 'color', color: 'red' },
      '/color red',
      'bypassPermissions',
      { createSession: true },
    )

    await expect(
      service.recordColorUsage(
        sessionId,
        { kind: 'color', color: 'blue' },
        '/color blue',
        'bypassPermissions',
        { createSession: true },
      ),
    ).rejects.toThrow(`Session ID ${sessionId} is already in use`)
  })

  it('keeps local color sessions entirely in memory without persistence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-color-ephemeral-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: queuedProvider(['must not run']),
      sessionPersistence: false,
    })

    const sessionId = await service.recordColorUsage(
      undefined,
      { kind: 'color', color: 'cyan' },
      '/color cyan',
      'bypassPermissions',
      { createSession: true },
    )
    expect(sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    )
    await expect(
      service.recordColorUsage(sessionId, { kind: 'reset' }, '/color reset'),
    ).resolves.toBe(sessionId)
    await expect(service.readEffectiveAgentColor(sessionId)).rejects.toThrow(
      'Session persistence is disabled',
    )
    const paths = resolveClaudePaths({ configDir: configRoot, cwd, sessionId })
    await expect(readFile(paths.sessionFile, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await expect(
      readFile(join(configRoot, 'history.jsonl'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readdir(paths.projectRoot)).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('records native empty /background usage without a provider turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-background-usage-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const service = new ClaudeSessionService({
      configRoot,
      cwd: root,
      claudeVersion: '2.1.208',
      provider: queuedProvider(['must not run']),
    })

    const sessionId = await service.recordBackgroundUsage(
      undefined,
      'bypassPermissions',
    )
    const transcript = (
      await readFile(
        resolveClaudePaths({ configDir: configRoot, cwd: root, sessionId })
          .sessionFile,
        'utf8',
      )
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    const commandEntries = transcript.filter(
      (entry) =>
        entry.type === 'user' &&
        typeof (entry.message as Record<string, unknown> | undefined)
          ?.content === 'string',
    )

    expect(transcript.slice(0, 2)).toEqual([
      { type: 'mode', mode: 'normal', sessionId },
      {
        type: 'permission-mode',
        permissionMode: 'bypassPermissions',
        sessionId,
      },
    ])
    expect(commandEntries).toHaveLength(3)
    expect(
      commandEntries.map(
        (entry) => (entry.message as { content: string }).content,
      ),
    ).toEqual([
      '<local-command-caveat>Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages or otherwise consider them in your response unless the user explicitly asks you to.</local-command-caveat>',
      '<command-name>/background</command-name>\n            <command-message>background</command-message>\n            <command-args></command-args>',
      '<local-command-stdout>Nothing to background yet — send a message first.</local-command-stdout>',
    ])
    expect(commandEntries[0]).toMatchObject({ isMeta: true })
    expect(commandEntries[1]?.parentUuid).toBe(commandEntries[0]?.uuid)
    expect(commandEntries[2]?.parentUuid).toBe(commandEntries[1]?.uuid)
    expect(new Set(commandEntries.map((entry) => entry.promptId)).size).toBe(1)
    expect(new Set(commandEntries.map((entry) => entry.timestamp)).size).toBe(1)
    await expect(
      readFile(join(configRoot, 'history.jsonl'), 'utf8'),
    ).resolves.toContain(`"display":"/background"`)
  })

  it('records successful /background only in shared input history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-background-launch-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const service = new ClaudeSessionService({
      configRoot,
      cwd: root,
      claudeVersion: '2.1.208',
      provider: queuedProvider(['main answer']),
    })
    const run = await service.run('source prompt')
    const sessionFile = resolveClaudePaths({
      configDir: configRoot,
      cwd: root,
      sessionId: run.sessionId,
    }).sessionFile
    const before = await readFile(sessionFile, 'utf8')

    await expect(
      service.recordBackgroundLaunch(run.sessionId),
    ).resolves.toMatchObject({
      resumeSessionAt: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      entryCount: expect.any(Number),
    })

    await expect(readFile(sessionFile, 'utf8')).resolves.toBe(before)
    await expect(
      readFile(join(configRoot, 'history.jsonl'), 'utf8'),
    ).resolves.toContain(`"display":"/background"`)
  })

  it('returns provider cost for a fresh side question', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-session-btw-cost-'))
    roots.push(root)
    const queued = queuedProvider(['side answer'])
    const provider: ModelProvider = {
      ...queued,
      model: 'fixture-side-model',
    }
    const service = new ClaudeSessionService({
      configRoot: join(root, 'config'),
      cwd: root,
      claudeVersion: '2.1.208',
      provider,
      pricing: new ModelPricingRegistry({
        'fixture-side-model': {
          inputPerMillionUsd: 2,
          outputPerMillionUsd: 4,
        },
      }),
    })

    const result = await service.answerSideQuestion(undefined, 'question')

    expect(result.sessionId).toMatch(/^[0-9a-f-]{36}$/u)
    expect(result.costUsd).toBe(0.000014)
    await expect(
      readFile(join(root, 'config', 'history.jsonl'), 'utf8'),
    ).resolves.toContain(`"sessionId":"${result.sessionId}"`)
  })

  it('meters a side question into the session cost snapshot exactly once without touching the transcript', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-session-btw-metered-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = root
    const requests: ModelRequest[] = []
    const responses = [
      {
        text: 'main context answer',
        usage: { inputTokens: 3, outputTokens: 2 },
      },
      { text: 'side answer', usage: { inputTokens: 7, outputTokens: 3 } },
    ]
    const provider: ModelProvider = {
      model: 'fixture-side-model',
      capabilities: { streaming: true, usage: true, tools: false },
      async *complete(request) {
        requests.push(request)
        const response = responses.shift()
        if (!response) throw new Error('Provider response fixture exhausted')
        yield { type: 'text-delta', delta: response.text }
        yield { type: 'usage', usage: response.usage }
      },
    }
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider,
      pricing: new ModelPricingRegistry({
        'fixture-side-model': { inputPerMillionUsd: 2, outputPerMillionUsd: 4 },
      }),
    })
    const run = await service.run('remember main context')
    const sessionFile = resolveClaudePaths({
      configDir: configRoot,
      cwd,
      sessionId: run.sessionId,
    }).sessionFile
    const before = await readFile(sessionFile, 'utf8')
    const mainSnapshot = await service.costSnapshot(run.sessionId)
    expect(mainSnapshot.modelUsage['fixture-side-model']).toMatchObject({
      inputTokens: 3,
      outputTokens: 2,
      costUsd: 0.000014,
    })

    const sideResult = await service.answerSideQuestion(
      run.sessionId,
      'what was the answer?',
    )
    expect(sideResult).toMatchObject({
      text: 'side answer',
      usage: { inputTokens: 7, outputTokens: 3 },
      costUsd: 0.000026,
      modelUsage: { 'fixture-side-model': { inputTokens: 7, outputTokens: 3 } },
    })
    expect(sideResult.durationApiMs).toBeGreaterThanOrEqual(0)
    expect(sideResult.durationApiWithoutRetriesMs).toBe(
      sideResult.durationApiMs,
    )

    const snapshot = await service.costSnapshot(run.sessionId)
    expect(snapshot.modelUsage['fixture-side-model']).toMatchObject({
      inputTokens: 10,
      outputTokens: 5,
      costUsd: expect.closeTo(0.00004),
    })
    expect(snapshot.hasUnknownModelCost).toBe(false)
    expect(snapshot.apiDurationMs).toBeGreaterThanOrEqual(
      mainSnapshot.apiDurationMs,
    )
    expect(snapshot.apiDurationWithoutRetriesMs).toBeGreaterThanOrEqual(
      mainSnapshot.apiDurationWithoutRetriesMs,
    )
    await expect(readFile(sessionFile, 'utf8')).resolves.toBe(before)
    expect(requests).toHaveLength(2)
  })

  it('forks a /btw question into a native background Agent sidechain', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-session-btw-fork-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    await mkdir(cwd, { recursive: true })
    let calls = 0
    const events: RuntimeEvent[] = []
    const provider: ModelProvider = {
      capabilities: { streaming: true, usage: true, tools: true },
      async *complete() {
        calls += 1
        yield {
          type: 'text-delta',
          delta: calls === 1 ? 'main answer' : 'THIRD',
        }
        yield {
          type: 'usage',
          usage: { inputTokens: 3, outputTokens: 1 },
        }
      },
    }
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider,
      tools: new LocalToolRegistry({ cwd }),
      permissions: { resolve: () => ({ behavior: 'allow' }) },
      enableSubagents: true,
      subagentToolNames: ['Agent', 'TaskOutput'],
      sessionPersistence: true,
      eventSink: (event) => events.push(event),
    })
    const run = await service.run('start here')

    const result = await service.forkSideQuestion(
      run.sessionId,
      'Reply with THIRD only.',
    )

    expect(result.name).toBe('reply-with-third')
    expect(result.agentId).toMatch(/^a[0-9a-f]+$/u)
    const paths = resolveClaudePaths({
      configDir: configRoot,
      cwd,
      sessionId: run.sessionId,
    })
    const transcript = await readFile(paths.sessionFile, 'utf8')
    expect(transcript).toContain('<command-name>/btw</command-name>')
    expect(transcript).toContain(
      '<command-args>Reply with THIRD only.</command-args>',
    )
    expect(transcript).toContain(
      `⑂ forked reply-with-third (${result.agentId.slice(-4)})`,
    )
    await expect(
      readdir(join(paths.projectRoot, run.sessionId, 'subagents')),
    ).resolves.toEqual(
      expect.arrayContaining([
        `agent-${result.agentId}.jsonl`,
        `agent-${result.agentId}.meta.json`,
      ]),
    )
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(events.filter((event) => event.type === 'warning')).toEqual([])
    await expect
      .poll(() => readFile(paths.sessionFile, 'utf8'))
      .toContain('"type":"queue-operation","operation":"enqueue"')
    await expect
      .poll(() => readFile(paths.sessionFile, 'utf8'))
      .toContain(`<task-id>${result.agentId}</task-id>`)
    await service.close()
  })

  it('retries the /btw Agent handoff while a foreground turn owns the lease', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-session-btw-lease-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    await mkdir(cwd, { recursive: true })
    let calls = 0
    let releaseForeground!: () => void
    const foregroundGate = new Promise<void>((resolve) => {
      releaseForeground = resolve
    })
    const warnings: RuntimeEvent[] = []
    const provider: ModelProvider = {
      capabilities: { streaming: true, usage: true, tools: true },
      async *complete() {
        calls += 1
        const call = calls
        if (call === 2) await foregroundGate
        yield { type: 'text-delta', delta: `answer-${call}` }
        yield {
          type: 'usage',
          usage: { inputTokens: 2, outputTokens: 1 },
        }
      },
    }
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider,
      tools: new LocalToolRegistry({ cwd }),
      permissions: { resolve: () => ({ behavior: 'allow' }) },
      enableSubagents: true,
      subagentToolNames: ['Agent', 'TaskOutput'],
      sessionPersistence: true,
      eventSink: (event) => {
        if (event.type === 'warning') warnings.push(event)
      },
    })
    const run = await service.run('start here')
    const foreground = service.resume(run.sessionId, 'hold the lease')
    await expect.poll(() => calls).toBe(2)

    const fork = service.forkSideQuestion(run.sessionId, 'Background task')
    await new Promise((resolve) => setTimeout(resolve, 50))
    releaseForeground()

    await expect(foreground).resolves.toMatchObject({ text: 'answer-2' })
    const forked = await fork
    const sessionFile = resolveClaudePaths({
      configDir: configRoot,
      cwd,
      sessionId: run.sessionId,
    }).sessionFile
    await expect
      .poll(() => readFile(sessionFile, 'utf8'))
      .toContain(`<command-args>Background task</command-args>`)
    await expect
      .poll(() => readFile(sessionFile, 'utf8'))
      .toContain(`<task-id>${forked.agentId}</task-id>`)
    expect(warnings).toEqual([])
    await service.close()
  })

  it('serializes concurrently completing /btw Agent notifications', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-session-btw-queue-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    await mkdir(cwd, { recursive: true })
    let calls = 0
    let backgroundStarted = 0
    let releaseBackground!: () => void
    const backgroundGate = new Promise<void>((resolve) => {
      releaseBackground = resolve
    })
    const warnings: RuntimeEvent[] = []
    const provider: ModelProvider = {
      capabilities: { streaming: true, usage: true, tools: true },
      async *complete() {
        calls += 1
        if (calls > 1) {
          backgroundStarted += 1
          await backgroundGate
        }
        yield { type: 'text-delta', delta: `answer-${calls}` }
        yield {
          type: 'usage',
          usage: { inputTokens: 2, outputTokens: 1 },
        }
      },
    }
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider,
      tools: new LocalToolRegistry({ cwd }),
      permissions: { resolve: () => ({ behavior: 'allow' }) },
      enableSubagents: true,
      subagentToolNames: ['Agent', 'TaskOutput'],
      sessionPersistence: true,
      eventSink: (event) => {
        if (event.type === 'warning') warnings.push(event)
      },
    })
    const run = await service.run('start here')
    const first = await service.forkSideQuestion(run.sessionId, 'First task')
    const second = await service.forkSideQuestion(run.sessionId, 'Second task')
    await expect.poll(() => backgroundStarted).toBe(2)

    releaseBackground()
    const sessionFile = resolveClaudePaths({
      configDir: configRoot,
      cwd,
      sessionId: run.sessionId,
    }).sessionFile
    await expect
      .poll(async () => {
        const transcript = await readFile(sessionFile, 'utf8')
        return transcript.match(/"operation":"enqueue"/gu)?.length ?? 0
      })
      .toBe(2)
    const transcript = await readFile(sessionFile, 'utf8')
    expect(transcript).toContain(`<task-id>${first.agentId}</task-id>`)
    expect(transcript).toContain(`<task-id>${second.agentId}</task-id>`)
    expect(warnings).toEqual([])
    await service.close()
  })

  it('attributes main and background child usage to the session cost tracker without double counting', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-cost-raw-attribution-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    await mkdir(cwd, { recursive: true })
    let mainCalls = 0
    let childCalls = 0
    const mainProvider: ModelProvider = {
      capabilities: { streaming: true, usage: true, tools: true },
      model: 'main-fixture-model',
      async *complete() {
        mainCalls += 1
        if (mainCalls === 1) {
          yield {
            type: 'tool-call',
            call: {
              id: 'main-spawn',
              name: 'Agent',
              input: {
                description: 'Write a child file',
                prompt: 'Write child.txt',
                subagent_type: 'general-purpose',
                run_in_background: true,
                name: 'writer-child',
                model: 'child-fixture-model',
              },
            },
          }
          return
        }
        if (mainCalls === 2) {
          yield { type: 'text-delta', delta: 'main answer' }
          yield {
            type: 'usage',
            usage: {
              inputTokens: 10,
              outputTokens: 4,
              webSearchRequests: 3,
            },
          }
          return
        }
        yield { type: 'text-delta', delta: 'final answer' }
        yield {
          type: 'usage',
          usage: {
            inputTokens: 3,
            outputTokens: 1,
            webSearchRequests: 1,
          },
        }
      },
    }
    const childProvider: ModelProvider = {
      capabilities: { streaming: true, usage: true, tools: true },
      model: 'child-fixture-model',
      async *complete() {
        childCalls += 1
        if (childCalls === 1) {
          yield {
            type: 'tool-call',
            call: {
              id: 'child-write',
              name: 'Write',
              input: {
                file_path: 'child.txt',
                content: 'line one\nline two\nline three',
              },
            },
          }
          return
        }
        yield { type: 'text-delta', delta: 'child done' }
        yield {
          type: 'usage',
          usage: {
            inputTokens: 20,
            outputTokens: 5,
            cacheReadInputTokens: 8,
            cacheCreationInputTokens: 2,
            webSearchRequests: 2,
          },
        }
      },
    }
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: mainProvider,
      providerForModel: (model) =>
        model === 'child-fixture-model' ? childProvider : mainProvider,
      tools: new LocalToolRegistry({ cwd }),
      permissions: { resolve: () => ({ behavior: 'allow' }) },
      enableSubagents: true,
      subagentToolNames: ['Agent', 'TaskOutput'],
      sessionPersistence: true,
      pricing: new ModelPricingRegistry({
        'main-fixture-model': {
          inputPerMillionUsd: 1,
          outputPerMillionUsd: 1,
          cacheReadInputPerMillionUsd: 0.5,
          cacheCreationInputPerMillionUsd: 0.5,
        },
        'child-fixture-model': {
          inputPerMillionUsd: 1,
          outputPerMillionUsd: 1,
          cacheReadInputPerMillionUsd: 0.5,
          cacheCreationInputPerMillionUsd: 0.5,
        },
      }),
      costStateStore: { load: async () => null, save: async () => undefined },
    })

    const run = await service.run('start here')

    expect(run.text).toBe('final answer')
    expect(run.usage).toEqual({
      inputTokens: 33,
      outputTokens: 10,
      cacheReadInputTokens: 8,
      cacheCreationInputTokens: 2,
      webSearchRequests: 6,
    })
    expect(run.modelUsage).toEqual({
      'main-fixture-model': {
        inputTokens: 13,
        outputTokens: 5,
        webSearchRequests: 4,
      },
      'child-fixture-model': {
        inputTokens: 20,
        outputTokens: 5,
        cacheReadInputTokens: 8,
        cacheCreationInputTokens: 2,
        webSearchRequests: 2,
      },
    })
    expect(run.costUsd).toBe(18 / 1_000_000 + 20 / 1_000_000)
    await expect(readFile(join(cwd, 'child.txt'), 'utf8')).resolves.toBe(
      'line one\nline two\nline three',
    )

    const mainCallsAfterRun = mainCalls
    const childCallsAfterRun = childCalls
    const snapshot = await service.costSnapshot(run.sessionId)
    expect(Object.keys(snapshot.modelUsage)).toEqual([
      'main-fixture-model',
      'child-fixture-model',
    ])
    expect(snapshot.modelUsage['main-fixture-model']).toEqual({
      inputTokens: 13,
      outputTokens: 5,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 4,
      costUsd: 18 / 1_000_000,
    })
    expect(snapshot.modelUsage['child-fixture-model']).toEqual({
      inputTokens: 20,
      outputTokens: 5,
      cacheReadInputTokens: 8,
      cacheCreationInputTokens: 2,
      webSearchRequests: 2,
      costUsd: 20 / 1_000_000,
    })
    expect(snapshot.totalCostUsd).toBe(18 / 1_000_000 + 20 / 1_000_000)
    expect(snapshot.linesAdded).toBe(3)
    expect(snapshot.linesRemoved).toBe(0)
    expect(snapshot.hasUnknownModelCost).toBe(false)
    expect(mainCalls).toBe(mainCallsAfterRun)
    expect(childCalls).toBe(childCallsAfterRun)

    await service.close()
  })

  it('rejects a non-directory cwd without changing the active workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-session-cd-file-'))
    roots.push(root)
    const file = join(root, 'not-a-directory')
    await writeFile(file, 'file')
    const service = new ClaudeSessionService({
      configRoot: join(root, 'config'),
      cwd: root,
      claudeVersion: '2.1.208',
      workspace: new WorkspaceContext(root),
      provider: queuedProvider(['still original']),
    })

    await expect(service.changeCwd(undefined, file)).rejects.toThrow(
      `Not a directory: ${file}`,
    )
    const run = await service.run('start here')
    const originalSession = resolveClaudePaths({
      configDir: join(root, 'config'),
      cwd: root,
      sessionId: run.sessionId,
    }).sessionFile
    await expect(readFile(originalSession, 'utf8')).resolves.toContain(
      `"cwd":"${root}"`,
    )
  })

  it('selectively summarizes from a rewind point with native metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-selective-compact-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const summarizedRequests: string[] = []
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: queuedProvider([
        'first answer',
        'second answer',
        'third answer',
      ]),
      compactor: {
        async compact(request) {
          summarizedRequests.push(JSON.stringify(request.messages))
          return {
            summary: 'selected range summary',
            usage: { inputTokens: 8, outputTokens: 3 },
            durationMs: 10,
            model: 'manual-compact-model',
          }
        },
      },
    })
    const first = await service.run('first prompt')
    await service.resume(first.sessionId, 'second prompt')
    const points = await service.rewindPoints(first.sessionId)
    const second = points.find((point) => point.prompt === 'second prompt')
    if (!second) throw new Error('second rewind point missing')

    const result = await service.compact(first.sessionId, undefined, {
      messageId: second.messageId,
      direction: 'from',
      context: 'focus on the second task',
    })

    expect(result.messagesSummarized).toBeGreaterThan(0)
    expect(summarizedRequests[0]).toContain('second prompt')
    expect(summarizedRequests[0]).not.toContain('first prompt')
    expect(summarizedRequests[0]).toContain('focus on the second task')
    const transcript = await readFile(
      resolveClaudePaths({
        configDir: configRoot,
        cwd,
        sessionId: first.sessionId,
      }).sessionFile,
      'utf8',
    )
    expect(transcript).toContain('"trigger":"manual"')
    expect(transcript).toContain('"direction":"from"')
    expect(transcript).toContain('"messagesSummarized"')
    expect(await service.transcript(first.sessionId)).toEqual([
      { kind: 'user', text: 'first prompt' },
      { kind: 'assistant', text: 'first answer' },
      { kind: 'compact', summary: 'selected range summary' },
    ])
    await service.resume(first.sessionId, 'third prompt')
    expect(await service.transcript(first.sessionId)).toEqual([
      { kind: 'user', text: 'first prompt' },
      { kind: 'assistant', text: 'first answer' },
      { kind: 'compact', summary: 'selected range summary' },
      { kind: 'user', text: 'third prompt' },
      { kind: 'assistant', text: 'third answer' },
    ])
  })

  it('selectively summarizes up to a rewind point and natively replays later messages', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-selective-up-to-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const summarizedRequests: string[] = []
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: queuedProvider([
        'first answer',
        'second answer',
        'third answer',
        'fourth answer',
      ]),
      compactor: {
        async compact(request) {
          summarizedRequests.push(JSON.stringify(request.messages))
          return {
            summary: 'earlier range summary',
            usage: { inputTokens: 8, outputTokens: 3 },
            durationMs: 10,
            model: 'manual-compact-model',
          }
        },
      },
    })
    const first = await service.run('first prompt')
    await service.resume(first.sessionId, 'second prompt')
    const second = (await service.rewindPoints(first.sessionId)).find(
      (point) => point.prompt === 'second prompt',
    )
    if (!second) throw new Error('second rewind point missing')

    await service.compact(first.sessionId, undefined, {
      messageId: second.messageId,
      direction: 'to',
    })

    expect(summarizedRequests[0]).toContain('first prompt')
    expect(summarizedRequests[0]).not.toContain('second prompt')
    expect(await service.transcript(first.sessionId)).toEqual([
      { kind: 'compact', summary: 'earlier range summary' },
      { kind: 'user', text: 'second prompt' },
      { kind: 'assistant', text: 'second answer' },
    ])
    const transcript = await readFile(
      resolveClaudePaths({
        configDir: configRoot,
        cwd,
        sessionId: first.sessionId,
      }).sessionFile,
      'utf8',
    )
    expect(transcript).toContain('"direction":"up_to"')
    expect(transcript).not.toContain('preserved verbatim as model messages')

    const fork = await service.fork(first.sessionId)
    expect(await service.transcript(fork.sessionId)).toEqual([
      { kind: 'compact', summary: 'earlier range summary' },
      { kind: 'user', text: 'second prompt' },
      { kind: 'assistant', text: 'second answer' },
    ])

    await service.resume(first.sessionId, 'third prompt')
    await service.resume(first.sessionId, 'fourth prompt')
    expect(await service.transcript(first.sessionId)).toEqual([
      { kind: 'compact', summary: 'earlier range summary' },
      { kind: 'user', text: 'second prompt' },
      { kind: 'assistant', text: 'second answer' },
      { kind: 'user', text: 'third prompt' },
      { kind: 'assistant', text: 'third answer' },
      { kind: 'user', text: 'fourth prompt' },
      { kind: 'assistant', text: 'fourth answer' },
    ])
  })

  it('summarizes from the first rewind point without requiring an earlier parent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-selective-first-'))
    roots.push(root)
    const service = new ClaudeSessionService({
      configRoot: join(root, 'config'),
      cwd: join(root, 'project'),
      claudeVersion: '2.1.208',
      provider: queuedProvider(['only answer']),
      compactor: {
        async compact() {
          return {
            summary: 'whole conversation summary',
            usage: { inputTokens: 4, outputTokens: 2 },
            durationMs: 5,
            model: 'manual-compact-model',
          }
        },
      },
    })
    const run = await service.run('first prompt')
    const [first] = await service.rewindPoints(run.sessionId)
    if (!first) throw new Error('first rewind point missing')

    await expect(
      service.compact(run.sessionId, undefined, {
        messageId: first.messageId,
        direction: 'from',
      }),
    ).resolves.toMatchObject({ summary: 'whole conversation summary' })
    expect(await service.transcript(run.sessionId)).toEqual([
      { kind: 'compact', summary: 'whole conversation summary' },
    ])
  })

  it('downloads startup files before the first provider turn once per session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-session-files-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const sessionId = '11111111-1111-4111-8111-111111111111'
    let downloads = 0
    const provider: ModelProvider = {
      capabilities: { streaming: true, usage: true, tools: false },
      async *complete() {
        await expect(
          readFile(join(cwd, sessionId, 'uploads/input.txt'), 'utf8'),
        ).resolves.toBe('startup file')
        yield { type: 'text-delta', delta: 'read' }
        yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
      },
    }
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider,
      fileResources: [{ fileId: 'file_a', relativePath: 'input.txt' }],
      fileResourceConfig: {
        cwd,
        apiKey: 'secret',
        baseUrl: 'https://files.example.test/v1',
        fetchImpl: async () => {
          downloads += 1
          return new Response('startup file')
        },
      },
    })

    await service.run('read the file', undefined, sessionId)
    await service.resume(sessionId, 'read it again')

    expect(downloads).toBe(1)
  })

  it('builds a hosted registry with durable task and schedule tools', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-hosted-registry-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const sessionId = '11111111-1111-4111-8111-111111111111'
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: queuedProvider(['hosted response']),
      tools: new LocalToolRegistry({ cwd }),
      permissions: { resolve: () => ({ behavior: 'allow' }) },
      taskToolNames: [
        'TaskCreate',
        'TaskGet',
        'TaskList',
        'TaskOutput',
        'TaskStop',
        'TaskUpdate',
      ],
      scheduledToolNames: [
        'CronCreate',
        'CronDelete',
        'CronList',
        'ScheduleWakeup',
      ],
      enableSubagents: true,
      subagentToolNames: ['Agent', 'SendMessage'],
      enableWorkflows: true,
      sessionPersistence: true,
    })

    try {
      const registry = service.createHostedToolRegistry(sessionId)
      expect(registry.definitions().map(({ name }) => name)).toEqual(
        expect.arrayContaining([
          'Agent',
          'SendMessage',
          'TaskCreate',
          'TaskGet',
          'TaskList',
          'TaskOutput',
          'TaskStop',
          'TaskUpdate',
          'CronCreate',
          'CronDelete',
          'CronList',
          'ScheduleWakeup',
          'Workflow',
        ]),
      )
      const create = await registry.prepare(
        {
          id: 'create',
          name: 'TaskCreate',
          input: { subject: 'Build', description: 'Build it' },
        },
        { cwd },
      )
      const created = await registry.execute(create, { cwd })
      expect(created.content).toContain('Task #1 created successfully')
      const list = await registry.prepare(
        { id: 'list', name: 'TaskList', input: {} },
        { cwd },
      )
      await expect(registry.execute(list, { cwd })).resolves.toMatchObject({
        content: expect.stringContaining('#1 [pending] Build'),
        isError: false,
      })
    } finally {
      await service.close()
    }
  })

  it('filters hosted tool exposure by role capabilities before prepare or execution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-capability-registry-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const sessionId = '11111111-1111-4111-8111-111111111111'
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: queuedProvider(['hosted response']),
      tools: new LocalToolRegistry({ cwd }),
      permissions: { resolve: () => ({ behavior: 'allow' }) },
      taskToolNames: ['TaskCreate', 'TaskOutput', 'TaskStop'],
      enableSubagents: true,
      subagentToolNames: ['Agent'],
      toolRole: 'worker',
      sessionPersistence: true,
    })

    try {
      const registry = service.createHostedToolRegistry(sessionId)
      const names = registry.definitions().map(({ name }) => name)
      expect(names).toContain('TaskCreate')
      expect(names).not.toEqual(
        expect.arrayContaining(['Agent', 'TaskOutput', 'TaskStop']),
      )
      await expect(
        registry.prepare({ id: 'agent', name: 'Agent', input: {} }, { cwd }),
      ).rejects.toThrow('unavailable')
      await expect(
        registry.execute(
          { id: 'output', name: 'TaskOutput', input: {} },
          { cwd },
        ),
      ).rejects.toThrow('unavailable')
    } finally {
      await service.close()
    }
  })

  it('wires provider-backed tool-use summaries through the session event sink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-summary-session-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const events: RuntimeEvent[] = []
    let mainCalls = 0
    let summaryCalls = 0
    const provider: ModelProvider = {
      capabilities: { streaming: true, usage: true, tools: true },
      async *complete(request) {
        if (
          request.messages.some(
            (message) =>
              message.role === 'user' &&
              message.content.includes('Tools completed:'),
          )
        ) {
          summaryCalls += 1
          yield { type: 'text-delta', delta: 'Read fixture' }
          return
        }
        if (mainCalls++ === 0) {
          yield {
            type: 'tool-call',
            call: {
              id: 'summary-call',
              name: 'Read',
              input: { file_path: 'a' },
            },
          }
          return
        }
        yield { type: 'text-delta', delta: 'done' }
      },
    }
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider,
      eventSink: (event) => events.push(event),
      emitToolUseSummaries: true,
      tools: {
        definitions: () => [],
        async prepare(call) {
          return call
        },
        async execute() {
          return { content: 'fixture contents', isError: false }
        },
      },
      permissions: { resolve: () => ({ behavior: 'allow' }) },
    })

    await service.run('inspect')
    expect(summaryCalls).toBe(1)
    expect(events).toContainEqual({
      type: 'tool-use-summary',
      summary: 'Read fixture',
      precedingToolUseIds: ['summary-call'],
    })
    await service.close()
  })

  it('records main and tool-summary usage, cost, and retry-free API durations exactly once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-summary-metering-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    let mainCalls = 0
    let summaryCalls = 0
    const provider: ModelProvider = {
      model: 'summary-metered-model',
      capabilities: { streaming: true, usage: true, tools: true },
      async *complete(request) {
        if (
          request.messages.some(
            (message) =>
              message.role === 'user' &&
              message.content.includes('Tools completed:'),
          )
        ) {
          summaryCalls += 1
          yield { type: 'api-attempt-duration', durationMs: 9 }
          yield { type: 'text-delta', delta: 'Read fixture' }
          yield {
            type: 'usage',
            usage: { inputTokens: 4, outputTokens: 2 },
          }
          return
        }
        if (mainCalls++ === 0) {
          yield {
            type: 'tool-call',
            call: {
              id: 'summary-metered-call',
              name: 'Read',
              input: { file_path: 'a' },
            },
          }
          yield { type: 'api-attempt-duration', durationMs: 1 }
          return
        }
        yield { type: 'api-attempt-duration', durationMs: 3 }
        yield { type: 'text-delta', delta: 'done' }
        yield {
          type: 'usage',
          usage: { inputTokens: 10, outputTokens: 5 },
        }
      },
    }
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider,
      emitToolUseSummaries: true,
      pricing: new ModelPricingRegistry({
        'summary-metered-model': {
          inputPerMillionUsd: 1,
          outputPerMillionUsd: 1,
        },
      }),
      costStateStore: { load: async () => null, save: async () => undefined },
      tools: {
        definitions: () => [],
        async prepare(call) {
          return call
        },
        async execute() {
          return { content: 'fixture contents', isError: false }
        },
      },
      permissions: { resolve: () => ({ behavior: 'allow' }) },
    })

    const run = await service.run('inspect')
    expect(summaryCalls).toBe(1)
    // Public result is inclusive of the summary row and API durations.
    expect(run.usage).toEqual({ inputTokens: 14, outputTokens: 7 })
    expect(run.modelUsage?.['summary-metered-model']).toMatchObject({
      inputTokens: 14,
      outputTokens: 7,
    })
    expect(run.durationApiMs).toBeGreaterThan(0)
    expect(run.costUsd).toBeCloseTo((14 + 7) / 1_000_000)

    const snapshot = await service.costSnapshot(run.sessionId)
    // The summary row was committed through the callback and the main rows
    // through the final tracker mutation: exactly once, no duplicate row.
    expect(snapshot.modelUsage['summary-metered-model']).toMatchObject({
      inputTokens: 14,
      outputTokens: 7,
    })
    expect(snapshot.hasUnknownModelCost).toBe(false)
    expect(snapshot.totalCostUsd).toBeCloseTo((14 + 7) / 1_000_000)
    expect(snapshot.apiDurationWithoutRetriesMs).toBe(9 + 1 + 3)
    expect(snapshot.apiDurationMs).toBeGreaterThan(0)
    await service.close()
  })

  it('records summary provider failure duration immediately without failing the main turn or creating a model row', async () => {
    const root = await mkdtemp(
      join(tmpdir(), 'praxis-summary-failure-metering-'),
    )
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    let mainCalls = 0
    let summaryCalls = 0
    const provider: ModelProvider = {
      model: 'summary-fail-model',
      capabilities: { streaming: true, usage: true, tools: true },
      async *complete(request) {
        if (
          request.messages.some(
            (message) =>
              message.role === 'user' &&
              message.content.includes('Tools completed:'),
          )
        ) {
          summaryCalls += 1
          yield { type: 'api-attempt-duration', durationMs: 6 }
          throw new Error('summary provider exploded')
        }
        if (mainCalls++ === 0) {
          yield {
            type: 'tool-call',
            call: {
              id: 'summary-fail-call',
              name: 'Read',
              input: { file_path: 'a' },
            },
          }
          yield { type: 'api-attempt-duration', durationMs: 1 }
          return
        }
        yield { type: 'api-attempt-duration', durationMs: 2 }
        yield { type: 'text-delta', delta: 'done' }
        yield {
          type: 'usage',
          usage: { inputTokens: 3, outputTokens: 1 },
        }
      },
    }
    const events: RuntimeEvent[] = []
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider,
      eventSink: (event) => events.push(event),
      emitToolUseSummaries: true,
      pricing: new ModelPricingRegistry({
        'summary-fail-model': {
          inputPerMillionUsd: 1,
          outputPerMillionUsd: 1,
        },
      }),
      costStateStore: { load: async () => null, save: async () => undefined },
      tools: {
        definitions: () => [],
        async prepare(call) {
          return call
        },
        async execute() {
          return { content: 'fixture contents', isError: false }
        },
      },
      permissions: { resolve: () => ({ behavior: 'allow' }) },
    })

    const run = await service.run('inspect')
    expect(run.text).toBe('done')
    expect(summaryCalls).toBe(1)
    // A failed summary emits no summary event.
    expect(events.some((event) => event.type === 'tool-use-summary')).toBe(
      false,
    )
    const snapshot = await service.costSnapshot(run.sessionId)
    // Zero-usage summary failure records only its API duration: no model row
    // and no unknown-cost flag, and the auxiliary failure did not fail the run.
    expect(snapshot.modelUsage['summary-fail-model']).toMatchObject({
      inputTokens: 3,
      outputTokens: 1,
    })
    expect(snapshot.hasUnknownModelCost).toBe(false)
    expect(snapshot.apiDurationWithoutRetriesMs).toBe(6 + 1 + 2)
    expect(snapshot.apiDurationMs).toBeGreaterThan(0)
    await service.close()
  })

  it('keeps externally committed summary metrics after a later main-turn cancellation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-summary-cancel-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const controller = new AbortController()
    let mainCalls = 0
    let summaryCalls = 0
    const provider: ModelProvider = {
      model: 'summary-cancel-model',
      capabilities: { streaming: true, usage: true, tools: true },
      async *complete(request) {
        if (
          request.messages.some(
            (message) =>
              message.role === 'user' &&
              message.content.includes('Tools completed:'),
          )
        ) {
          summaryCalls += 1
          yield { type: 'api-attempt-duration', durationMs: 9 }
          yield { type: 'text-delta', delta: 'Read fixture' }
          yield {
            type: 'usage',
            usage: { inputTokens: 4, outputTokens: 2 },
          }
          return
        }
        if (mainCalls++ === 0) {
          yield {
            type: 'tool-call',
            call: {
              id: 'summary-cancel-call',
              name: 'Read',
              input: { file_path: 'a' },
            },
          }
          return
        }
        yield { type: 'api-attempt-duration', durationMs: 3 }
        controller.abort()
        yield { type: 'text-delta', delta: 'ignored' }
      },
    }
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider,
      emitToolUseSummaries: true,
      pricing: new ModelPricingRegistry({
        'summary-cancel-model': {
          inputPerMillionUsd: 1,
          outputPerMillionUsd: 1,
        },
      }),
      costStateStore: { load: async () => null, save: async () => undefined },
      tools: {
        definitions: () => [],
        async prepare(call) {
          return call
        },
        async execute() {
          return { content: 'fixture contents', isError: false }
        },
      },
      permissions: { resolve: () => ({ behavior: 'allow' }) },
    })

    const sessionId = '33333333-3333-4333-8333-333333333333'
    await expect(
      service.run('inspect', controller.signal, sessionId),
    ).rejects.toBeInstanceOf(AgentRunCancelledError)
    expect(summaryCalls).toBe(1)
    // The summary was committed through the callback before the main turn was
    // cancelled, so the snapshot still owns its usage/cost/API durations.
    const snapshot = await service.costSnapshot(sessionId)
    expect(snapshot.modelUsage['summary-cancel-model']).toMatchObject({
      inputTokens: 4,
      outputTokens: 2,
    })
    expect(snapshot.hasUnknownModelCost).toBe(false)
    expect(snapshot.totalCostUsd).toBeCloseTo((4 + 2) / 1_000_000)
    expect(snapshot.apiDurationWithoutRetriesMs).toBe(9)
    expect(snapshot.apiDurationMs).toBeGreaterThan(0)
    await service.close()
  })

  it('closes background hosted Agents when the session service closes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-hosted-close-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    let aborted = false
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const provider: ModelProvider = {
      capabilities: { streaming: true, usage: true, tools: true },
      async *complete(request) {
        markStarted()
        await new Promise<void>((resolve) => {
          request.signal?.addEventListener(
            'abort',
            () => {
              aborted = true
              resolve()
            },
            { once: true },
          )
        })
        yield* []
      },
    }
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider,
      tools: new LocalToolRegistry({ cwd }),
      permissions: { resolve: () => ({ behavior: 'allow' }) },
      enableSubagents: true,
      subagentToolNames: ['Agent', 'TaskOutput'],
      sessionPersistence: true,
    })
    const registry = service.createHostedToolRegistry(
      '22222222-2222-4222-8222-222222222222',
    )
    const call = await registry.prepare(
      {
        id: 'background-agent',
        name: 'Agent',
        input: {
          description: 'Hanging agent',
          prompt: 'hang',
          run_in_background: true,
        },
      },
      { cwd },
    )
    await registry.execute(call, { cwd })
    await started
    await service.close()
    expect(aborted).toBe(true)
  })

  it('exposes live Agent snapshots and routes stop through the owning runtime', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-hosted-tasks-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const sessionId = '33333333-3333-4333-8333-333333333333'
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const provider: ModelProvider = {
      capabilities: { streaming: true, usage: true, tools: true },
      async *complete(request) {
        markStarted()
        await new Promise<void>((resolve) =>
          request.signal?.addEventListener('abort', () => resolve(), {
            once: true,
          }),
        )
        yield { type: 'text-delta' as const, delta: '' }
      },
    }
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider,
      tools: new LocalToolRegistry({ cwd }),
      permissions: { resolve: () => ({ behavior: 'allow' }) },
      enableSubagents: true,
      subagentToolNames: ['Agent', 'TaskStop'],
      sessionPersistence: true,
    })
    const registry = service.createHostedToolRegistry(sessionId)
    const call = await registry.prepare(
      {
        id: 'runtime-agent',
        name: 'Agent',
        input: {
          description: 'Runtime agent',
          prompt: 'wait',
          run_in_background: true,
        },
      },
      { cwd },
    )
    const launched = await registry.execute(call, { cwd })
    const taskId = String(launched.nativeToolUseResult?.agentId)
    await started

    await expect(service.taskSnapshots(sessionId)).resolves.toMatchObject({
      shells: [],
      agents: [{ agentId: taskId, status: 'running' }],
      workflows: [],
    })
    await service.stopTask(sessionId, taskId)
    await vi.waitFor(async () => {
      await expect(service.taskSnapshots(sessionId)).resolves.toMatchObject({
        agents: [{ agentId: taskId, status: 'stopped' }],
      })
    })
    await expect(service.stopTask('other-session', taskId)).rejects.toThrow(
      `No task found with ID: ${taskId}`,
    )
    await service.close()
  })

  it('exposes live Bash output and reaches a fixed stopped duration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-hosted-shell-tasks-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const sessionId = '44444444-4444-4444-8444-444444444444'
    await mkdir(cwd, { recursive: true })
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: queuedProvider(['unused']),
      tools: new LocalToolRegistry({ cwd }),
      permissions: { resolve: () => ({ behavior: 'allow' }) },
      taskToolNames: ['TaskOutput', 'TaskStop'],
      sessionPersistence: true,
    })
    const registry = service.createHostedToolRegistry(sessionId)
    const call = await registry.prepare(
      {
        id: 'runtime-shell',
        name: 'Bash',
        input: {
          command: "printf 'started\\n'; sleep 30",
          description: 'Runtime shell',
          run_in_background: true,
        },
      },
      { cwd },
    )
    const launched = await registry.execute(call, { cwd })
    const taskId = String(launched.nativeToolUseResult?.backgroundTaskId)
    await vi.waitFor(async () => {
      await expect(service.taskSnapshots(sessionId)).resolves.toMatchObject({
        shells: [
          {
            taskId,
            status: 'running',
            output: expect.stringContaining('started'),
            durationMs: null,
          },
        ],
      })
    })

    await service.stopTask(sessionId, taskId)
    const stopped = await service.taskSnapshots(sessionId)
    expect(stopped.shells).toMatchObject([
      { taskId, status: 'stopped', durationMs: expect.any(Number) },
    ])
    const duration = stopped.shells[0]?.durationMs
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect((await service.taskSnapshots(sessionId)).shells[0]?.durationMs).toBe(
      duration,
    )
    await service.close()
  })

  it('persists and projects user image and document attachments', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-runtime-attachment-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const requests: ModelRequest[] = []
    const provider: ModelProvider = {
      capabilities: {
        streaming: true,
        usage: true,
        tools: false,
        images: true,
        documents: true,
      },
      async *complete(request) {
        requests.push(request)
        yield { type: 'text-delta', delta: 'done' }
      },
    }
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider,
    })
    const result = await service.run(
      'inspect',
      undefined,
      undefined,
      undefined,
      [{ type: 'image', mediaType: 'image/png', data: 'aGVsbG8=' }],
      [{ type: 'document', mediaType: 'application/pdf', data: 'JVBERg==' }],
    )
    expect(requests[0]?.messages.at(-1)).toEqual({
      role: 'user',
      content: 'inspect',
      images: [{ type: 'image', mediaType: 'image/png', data: 'aGVsbG8=' }],
      documents: [
        { type: 'document', mediaType: 'application/pdf', data: 'JVBERg==' },
      ],
    })
    const { resolveClaudePaths } =
      await import('../compatibility/claude/paths.js')
    const transcript = await readFile(
      resolveClaudePaths({
        configDir: configRoot,
        cwd,
        sessionId: result.sessionId,
      }).sessionFile,
      'utf8',
    )
    expect(transcript).toContain('"type":"image"')
    expect(transcript).toContain('"type":"document"')
  })

  it('generates prompt suggestions without mutating transcript or main usage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-runtime-suggestion-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const requests: ModelRequest[] = []
    const provider: ModelProvider = {
      capabilities: { streaming: true, usage: true, tools: false },
      model: 'suggestion-model',
      async *complete(request) {
        requests.push(request)
        yield {
          type: 'text-delta',
          delta:
            requests.length === 1
              ? 'main answer'
              : 'continue the implementation',
        }
        yield { type: 'usage', usage: { inputTokens: 4, outputTokens: 2 } }
      },
    }
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider,
    })
    const result = await service.run('implement the feature')
    const { resolveClaudePaths } =
      await import('../compatibility/claude/paths.js')
    const sessionFile = resolveClaudePaths({
      configDir: configRoot,
      cwd,
      sessionId: result.sessionId,
    }).sessionFile
    const before = await readFile(sessionFile)
    await expect(service.promptSuggestion(result.sessionId)).resolves.toBe(
      'continue the implementation',
    )
    const after = await readFile(sessionFile)
    expect(after).toEqual(before)
    expect(result.usage).toEqual({ inputTokens: 4, outputTokens: 2 })
    expect(requests).toHaveLength(2)
    expect(requests[1]?.messages.at(-1)).toEqual({
      role: 'user',
      content: expect.stringContaining('[SUGGESTION MODE:'),
    })
  })

  it('meters a prompt suggestion into the session cost snapshot exactly once without mutating the transcript', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-suggestion-metered-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const requests: ModelRequest[] = []
    const provider: ModelProvider = {
      model: 'suggestion-model',
      capabilities: { streaming: true, usage: true, tools: false },
      async *complete(request) {
        requests.push(request)
        yield {
          type: 'text-delta',
          delta:
            requests.length === 1
              ? 'main answer'
              : 'continue the implementation',
        }
        yield { type: 'usage', usage: { inputTokens: 4, outputTokens: 2 } }
      },
    }
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider,
      pricing: new ModelPricingRegistry({
        'suggestion-model': { inputPerMillionUsd: 2, outputPerMillionUsd: 4 },
      }),
    })
    const result = await service.run('implement the feature')
    const sessionFile = resolveClaudePaths({
      configDir: configRoot,
      cwd,
      sessionId: result.sessionId,
    }).sessionFile
    const before = await readFile(sessionFile, 'utf8')

    await expect(service.promptSuggestion(result.sessionId)).resolves.toBe(
      'continue the implementation',
    )

    const snapshot = await service.costSnapshot(result.sessionId)
    expect(snapshot.modelUsage['suggestion-model']).toMatchObject({
      inputTokens: 8,
      outputTokens: 4,
      costUsd: 0.000032,
    })
    expect(snapshot.hasUnknownModelCost).toBe(false)
    expect(snapshot.apiDurationMs).toBeGreaterThanOrEqual(0)
    expect(snapshot.apiDurationWithoutRetriesMs).toBe(snapshot.apiDurationMs)
    await expect(readFile(sessionFile, 'utf8')).resolves.toBe(before)
    expect(requests).toHaveLength(2)
  })

  it('returns null for a tool-call prompt suggestion while still recording API duration without a new model row', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-suggestion-toolcall-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    let turns = 0
    const provider: ModelProvider = {
      model: 'toolcall-model',
      capabilities: { streaming: true, usage: true, tools: true },
      async *complete() {
        turns += 1
        if (turns === 1) {
          yield { type: 'text-delta', delta: 'main answer' }
          yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1 } }
          return
        }
        yield {
          type: 'tool-call',
          call: {
            id: 'call_suggest',
            name: 'Read',
            input: { file_path: 'README.md' },
          },
        }
      },
    }
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider,
      pricing: new ModelPricingRegistry({
        'toolcall-model': { inputPerMillionUsd: 1, outputPerMillionUsd: 1 },
      }),
    })
    const run = await service.run('implement')
    const beforeSnapshot = await service.costSnapshot(run.sessionId)

    await expect(service.promptSuggestion(run.sessionId)).resolves.toBeNull()

    const afterSnapshot = await service.costSnapshot(run.sessionId)
    expect(afterSnapshot.modelUsage).toEqual(beforeSnapshot.modelUsage)
    expect(afterSnapshot.hasUnknownModelCost).toBe(false)
    expect(afterSnapshot.apiDurationMs).toBeGreaterThanOrEqual(
      beforeSnapshot.apiDurationMs,
    )
    expect(afterSnapshot.apiDurationWithoutRetriesMs).toBeGreaterThanOrEqual(
      beforeSnapshot.apiDurationWithoutRetriesMs,
    )
  })

  it('records API duration without a model row when a prompt suggestion provider fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-suggestion-failure-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    let turns = 0
    const provider: ModelProvider = {
      model: 'failure-model',
      capabilities: { streaming: true, usage: true, tools: false },
      async *complete() {
        turns += 1
        if (turns === 1) {
          yield { type: 'text-delta', delta: 'main answer' }
          yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1 } }
          return
        }
        throw new Error('suggestion provider failed')
      },
    }
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider,
      pricing: new ModelPricingRegistry({
        'failure-model': { inputPerMillionUsd: 1, outputPerMillionUsd: 1 },
      }),
    })
    const run = await service.run('implement')
    const beforeSnapshot = await service.costSnapshot(run.sessionId)

    await expect(service.promptSuggestion(run.sessionId)).rejects.toThrow(
      'suggestion provider failed',
    )

    const afterSnapshot = await service.costSnapshot(run.sessionId)
    expect(afterSnapshot.modelUsage).toEqual(beforeSnapshot.modelUsage)
    expect(afterSnapshot.hasUnknownModelCost).toBe(false)
    expect(afterSnapshot.apiDurationMs).toBeGreaterThanOrEqual(
      beforeSnapshot.apiDurationMs,
    )
    expect(afterSnapshot.apiDurationWithoutRetriesMs).toBeGreaterThanOrEqual(
      beforeSnapshot.apiDurationWithoutRetriesMs,
    )
  })

  it('records nothing for a pre-aborted prompt suggestion without calling the provider', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-suggestion-abort-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    let calls = 0
    const provider: ModelProvider = {
      capabilities: { streaming: true, usage: true, tools: false },
      async *complete() {
        calls += 1
        yield { type: 'text-delta', delta: 'unexpected' }
      },
    }
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider,
    })
    const run = await service.run('start')
    const beforeSnapshot = await service.costSnapshot(run.sessionId)
    const controller = new AbortController()
    controller.abort()

    await expect(
      service.promptSuggestion(run.sessionId, controller.signal),
    ).rejects.toBeInstanceOf(AgentRunCancelledError)

    const afterSnapshot = await service.costSnapshot(run.sessionId)
    expect(trackedTotals(afterSnapshot)).toEqual(trackedTotals(beforeSnapshot))
    expect(calls).toBe(1)
  })

  it('marks background user and assistant transcript entries with native session metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-runtime-bg-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const sessionId = 'abababab-1111-4111-8111-111111111111'
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: queuedProvider(['background answer']),
      sessionKind: 'bg',
    })

    await service.run('background prompt', undefined, sessionId)
    const { resolveClaudePaths } =
      await import('../compatibility/claude/paths.js')
    const source = await readFile(
      resolveClaudePaths({ configDir: configRoot, cwd, sessionId }).sessionFile,
      'utf8',
    )
    const messages = source
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.type === 'user' || entry.type === 'assistant')

    expect(messages).toHaveLength(2)
    expect(messages).toEqual([
      expect.objectContaining({
        type: 'user',
        sessionKind: 'bg',
        userType: 'external',
        entrypoint: 'cli',
      }),
      expect.objectContaining({
        type: 'assistant',
        sessionKind: 'bg',
        userType: 'external',
        entrypoint: 'cli',
      }),
    ])
  })

  it('allows foreground subagents when session persistence is disabled', () => {
    const root = join(tmpdir(), 'praxis-runtime-ephemeral-construction')
    expect(
      () =>
        new ClaudeSessionService({
          configRoot: join(root, 'config'),
          cwd: join(root, 'project'),
          claudeVersion: '2.1.208',
          provider: queuedProvider(['unused']),
          enableSubagents: true,
          sessionPersistence: false,
        }),
    ).not.toThrow()
  })

  it('rejects an invalid non-persistent session ID without reserving it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-runtime-ephemeral-'))
    roots.push(root)
    const service = new ClaudeSessionService({
      configRoot: join(root, 'config'),
      cwd: join(root, 'project'),
      claudeVersion: '2.1.208',
      provider: queuedProvider(['unused']),
      sessionPersistence: false,
    })

    await expect(
      service.run('invalid identity', undefined, 'not-a-uuid'),
    ).rejects.toThrow('Invalid Claude session ID: not-a-uuid')
    await expect(
      service.run('still invalid', undefined, 'not-a-uuid'),
    ).rejects.toThrow('Invalid Claude session ID: not-a-uuid')
  })

  it('reports an empty persisted transcript as missing during ephemeral resume', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-runtime-ephemeral-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const sessionId = '15151515-1515-4515-8515-151515151515'
    const { resolveClaudePaths } =
      await import('../compatibility/claude/paths.js')
    const paths = resolveClaudePaths({ configDir: configRoot, cwd, sessionId })
    await mkdir(paths.projectRoot, { recursive: true })
    await writeFile(paths.sessionFile, '')
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: queuedProvider(['unused']),
      sessionPersistence: false,
    })

    await expect(service.resume(sessionId, 'must not run')).rejects.toThrow(
      `Claude session not found: ${sessionId}`,
    )
  })

  it('runs and resumes a non-persistent session entirely in memory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-runtime-ephemeral-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const sessionId = '22222222-2222-4222-8222-222222222222'
    const requests: ModelRequest[] = []
    const hookTranscriptPaths: string[] = []
    const provider: ModelProvider = {
      capabilities: { streaming: true, usage: true, tools: false },
      async *complete(request) {
        requests.push(request)
        yield {
          type: 'text-delta',
          delta: requests.length === 1 ? 'first answer' : 'second answer',
        }
      },
    }
    const hooks = new ClaudeHookRunner({
      cwd,
      settings: [
        {
          path: join(configRoot, 'settings.json'),
          scope: 'user',
          value: {
            hooks: {
              SessionStart: [
                { hooks: [{ type: 'command', command: 'capture-path' }] },
              ],
            },
          },
        },
      ],
      executeCommand: async (_command, input) => {
        hookTranscriptPaths.push(input.transcript_path)
        return {
          stdout: '',
          stderr: '',
          exitCode: 0,
          durationMs: 1,
        }
      },
    })
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider,
      hooks,
      sessionPersistence: false,
    })

    await expect(
      service.run('first prompt', undefined, sessionId, 'Ephemeral session'),
    ).resolves.toMatchObject({ sessionId, text: 'first answer' })
    await expect(
      service.resume(
        sessionId,
        'second prompt',
        undefined,
        'Ephemeral session',
      ),
    ).resolves.toMatchObject({ sessionId, text: 'second answer' })

    expect(requests).toHaveLength(2)
    expect(requests[0]?.messages).toEqual([
      { role: 'user', content: 'first prompt' },
    ])
    expect(requests[1]?.messages).toEqual([
      { role: 'user', content: 'first prompt' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'second prompt' },
    ])
    await expect(
      service.run('cannot reuse name', undefined, sessionId, 'Other name'),
    ).rejects.toThrow(`Session ID ${sessionId} is already in use`)
    const { resolveClaudePaths } =
      await import('../compatibility/claude/paths.js')
    const paths = resolveClaudePaths({
      configDir: configRoot,
      cwd,
      sessionId,
    })
    expect(hookTranscriptPaths).toEqual([paths.sessionFile, paths.sessionFile])
    await expect(readFile(paths.sessionFile)).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await expect(
      readFile(join(paths.praxisRoot, 'locks', `${sessionId}.lock`)),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readdir(configRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(service.sessions()).resolves.toEqual([])
    await expect(service.inspect(sessionId)).rejects.toThrow(
      'Session persistence is disabled',
    )
    await expect(service.export(sessionId)).rejects.toThrow(
      'Session persistence is disabled',
    )
    await expect(service.fork(sessionId)).rejects.toThrow(
      'Session persistence is disabled',
    )
  })

  it('imports a persisted session for an ephemeral resume without mutating disk', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-runtime-ephemeral-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const sessionId = '14141414-1414-4414-8414-141414141414'
    const persisted = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: queuedProvider(['persisted answer']),
    })
    await persisted.run('persisted prompt', undefined, sessionId)

    const { resolveClaudePaths } =
      await import('../compatibility/claude/paths.js')
    const paths = resolveClaudePaths({ configDir: configRoot, cwd, sessionId })
    const sourceBefore = await readFile(paths.sessionFile)
    const lockDirectory = join(paths.praxisRoot, 'locks')
    const locksBefore = await readdir(lockDirectory)
    const requests: ModelRequest[] = []
    const ephemeral = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: {
        capabilities: { streaming: true, usage: true, tools: false },
        async *complete(request) {
          requests.push(request)
          yield {
            type: 'text-delta',
            delta: requests.length === 1 ? 'ephemeral answer' : 'second answer',
          }
        },
      },
      sessionPersistence: false,
    })

    await expect(ephemeral.sessions()).resolves.toEqual([
      expect.objectContaining({ sessionId, status: 'ready' }),
    ])
    await ephemeral.resume(
      sessionId,
      'ephemeral prompt',
      undefined,
      'Ephemeral name',
    )
    await ephemeral.resume(
      sessionId,
      'second prompt',
      undefined,
      'Ephemeral name',
    )

    expect(requests[0]?.messages).toEqual([
      { role: 'user', content: 'persisted prompt' },
      { role: 'assistant', content: 'persisted answer' },
      { role: 'user', content: 'ephemeral prompt' },
    ])
    expect(requests[1]?.messages).toEqual([
      { role: 'user', content: 'persisted prompt' },
      { role: 'assistant', content: 'persisted answer' },
      { role: 'user', content: 'ephemeral prompt' },
      { role: 'assistant', content: 'ephemeral answer' },
      { role: 'user', content: 'second prompt' },
    ])
    expect(await readFile(paths.sessionFile)).toEqual(sourceBefore)
    expect(await readdir(lockDirectory)).toEqual(locksBefore)
  })

  it('rejects an empty session name without creating persistence artifacts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-runtime-name-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const service = new ClaudeSessionService({
      configRoot,
      cwd: join(root, 'project'),
      claudeVersion: '2.1.208',
      provider: queuedProvider(['unused']),
    })

    await expect(
      service.run(
        'must not persist',
        undefined,
        '13131313-1313-4313-8313-131313131313',
        '',
      ),
    ).rejects.toThrow('Session name must not be empty')
    await expect(readdir(configRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps a failed non-persistent turn off disk', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-runtime-ephemeral-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const sessionId = '44444444-4444-4444-8444-444444444444'
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: {
        capabilities: { streaming: true, usage: true, tools: false },
        async *complete() {
          yield* []
          throw new ModelProviderError('ephemeral provider failure', {
            retryable: true,
          })
        },
      },
      sessionPersistence: false,
    })

    await expect(
      service.run('never persist this', undefined, sessionId),
    ).rejects.toThrow('ephemeral provider failure')
    await expect(
      service.run('cannot reclaim failed ID', undefined, sessionId),
    ).rejects.toThrow(`Session ID ${sessionId} is already in use`)

    const { resolveClaudePaths } =
      await import('../compatibility/claude/paths.js')
    const paths = resolveClaudePaths({
      configDir: configRoot,
      cwd,
      sessionId,
    })
    await expect(readFile(paths.sessionFile)).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await expect(
      readFile(join(paths.praxisRoot, 'locks', `${sessionId}.lock`)),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readdir(configRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('retains native tool history in a non-persistent session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-runtime-ephemeral-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const requests: ModelRequest[] = []
    let providerTurn = 0
    const provider: ModelProvider = {
      capabilities: { streaming: true, usage: true, tools: true },
      async *complete(request) {
        requests.push(request)
        providerTurn += 1
        if (providerTurn === 1) {
          yield {
            type: 'tool-call',
            call: {
              id: 'call_ephemeral',
              name: 'Read',
              input: { file_path: '/tmp/fixture' },
            },
          }
          return
        }
        yield {
          type: 'text-delta',
          delta: providerTurn === 2 ? 'tool answer' : 'resume answer',
        }
      },
    }
    const tools: ToolRegistry = {
      definitions: () => [
        { name: 'Read', description: 'Read', inputSchema: { type: 'object' } },
      ],
      async prepare(call) {
        return call
      },
      async execute() {
        return { content: 'EPHEMERAL_TOOL_RESULT', isError: false }
      },
    }
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider,
      tools,
      permissions: { resolve: () => ({ behavior: 'allow' }) },
      sessionPersistence: false,
    })

    const first = await service.run('use the tool')
    await service.resume(first.sessionId, 'continue')

    expect(requests).toHaveLength(3)
    expect(JSON.stringify(requests[1]?.messages)).toContain('call_ephemeral')
    expect(JSON.stringify(requests[1]?.messages)).toContain(
      'EPHEMERAL_TOOL_RESULT',
    )
    expect(JSON.stringify(requests[2]?.messages)).toContain('call_ephemeral')
    expect(JSON.stringify(requests[2]?.messages)).toContain(
      'EPHEMERAL_TOOL_RESULT',
    )
    expect(JSON.stringify(requests[2]?.messages)).toContain('tool answer')
    expect(JSON.stringify(requests[2]?.messages)).toContain('continue')
    await expect(readdir(configRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('holds an in-memory session lease for the complete model turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-runtime-ephemeral-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const sessionId = '66666666-6666-4666-8666-666666666666'
    let announceStarted: (() => void) | undefined
    let releaseProvider: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      announceStarted = resolve
    })
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve
    })
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: {
        capabilities: { streaming: true, usage: true, tools: false },
        async *complete() {
          announceStarted?.()
          await providerGate
          yield { type: 'text-delta', delta: 'finished' }
        },
      },
      sessionPersistence: false,
    })

    const activeTurn = service.run('first writer', undefined, sessionId)
    await started
    try {
      await expect(service.resume(sessionId, 'second writer')).rejects.toThrow(
        'conflict: locked',
      )
    } finally {
      releaseProvider?.()
    }
    await expect(activeTurn).resolves.toMatchObject({ text: 'finished' })
    await expect(readdir(configRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('starts a session with an explicit caller-provided UUID', async () => {
    const { service, configRoot, cwd } = await createService()
    const sessionId = '33333333-3333-4333-8333-333333333333'

    const result = await service.run('fixed identity', undefined, sessionId)

    expect(result).toMatchObject({ sessionId, text: 'first answer' })
    const { resolveClaudePaths } =
      await import('../compatibility/claude/paths.js')
    await expect(
      readFile(
        resolveClaudePaths({ configDir: configRoot, cwd, sessionId })
          .sessionFile,
        'utf8',
      ),
    ).resolves.toContain(`"sessionId":"${sessionId}"`)
    await expect(
      service.run('must not append', undefined, sessionId),
    ).rejects.toThrow(`Session ID ${sessionId} is already in use`)

    const emptySessionId = '77777777-7777-4777-8777-777777777777'
    const emptyPaths = resolveClaudePaths({
      configDir: configRoot,
      cwd,
      sessionId: emptySessionId,
    })
    await mkdir(emptyPaths.projectRoot, { recursive: true })
    await writeFile(emptyPaths.sessionFile, '')
    await expect(
      service.run('must not claim empty file', undefined, emptySessionId),
    ).rejects.toThrow(`Session ID ${emptySessionId} is already in use`)
  })

  it('creates native session name records and preserves them across fork', async () => {
    const { service, configRoot, cwd } = await createService()
    const sessionId = '12121212-1212-4212-8212-121212121212'

    await service.run('named prompt', undefined, sessionId, 'Named session')

    await expect(service.sessions()).resolves.toEqual([
      expect.objectContaining({ sessionId, name: 'Named session' }),
    ])

    const { resolveClaudePaths } =
      await import('../compatibility/claude/paths.js')
    const paths = resolveClaudePaths({
      configDir: configRoot,
      cwd,
      sessionId,
    })
    const sourceEntries = (await readFile(paths.sessionFile, 'utf8'))
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(sourceEntries.slice(0, 3)).toEqual([
      { type: 'custom-title', customTitle: 'Named session', sessionId },
      { type: 'agent-name', agentName: 'Named session', sessionId },
      expect.objectContaining({ type: 'user', sessionId }),
    ])

    const forkSessionId = '34343434-3434-4434-8434-343434343434'
    const fork = await service.fork(sessionId, forkSessionId)
    expect(fork).toEqual({
      sessionId: forkSessionId,
      parentSessionId: sessionId,
    })
    const forkEntries = (
      await readFile(
        resolveClaudePaths({
          configDir: configRoot,
          cwd,
          sessionId: fork.sessionId,
        }).sessionFile,
        'utf8',
      )
    )
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(forkEntries.slice(0, 2)).toEqual([
      {
        type: 'custom-title',
        customTitle: 'Named session',
        sessionId: fork.sessionId,
      },
      {
        type: 'agent-name',
        agentName: 'Named session',
        sessionId: fork.sessionId,
      },
    ])
  })

  it('names a resumed session before the prompt without duplicating the same name', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-runtime-name-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: queuedProvider(['first', 'second', 'third']),
    })
    const first = await service.run('original prompt')

    await service.resume(
      first.sessionId,
      'first named prompt',
      undefined,
      'Resume name',
    )
    await service.resume(
      first.sessionId,
      'same named prompt',
      undefined,
      'Resume name',
    )

    const { resolveClaudePaths } =
      await import('../compatibility/claude/paths.js')
    const entries = (
      await readFile(
        resolveClaudePaths({
          configDir: configRoot,
          cwd,
          sessionId: first.sessionId,
        }).sessionFile,
        'utf8',
      )
    )
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line))
    const namingEntries = entries.filter(
      (entry) => entry.type === 'custom-title' || entry.type === 'agent-name',
    )
    expect(namingEntries).toEqual([
      {
        type: 'custom-title',
        customTitle: 'Resume name',
        sessionId: first.sessionId,
      },
      {
        type: 'agent-name',
        agentName: 'Resume name',
        sessionId: first.sessionId,
      },
    ])
    const firstNamedPromptIndex = entries.findIndex(
      (entry) => entry.message?.content === 'first named prompt',
    )
    expect(entries.indexOf(namingEntries[1])).toBeLessThan(
      firstNamedPromptIndex,
    )

    const fork = await service.fork(first.sessionId)
    const forkEntries = (
      await readFile(
        resolveClaudePaths({
          configDir: configRoot,
          cwd,
          sessionId: fork.sessionId,
        }).sessionFile,
        'utf8',
      )
    )
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(
      forkEntries.filter(
        (entry) => entry.type === 'custom-title' || entry.type === 'agent-name',
      ),
    ).toEqual([
      {
        type: 'custom-title',
        customTitle: 'Resume name',
        sessionId: fork.sessionId,
      },
      {
        type: 'agent-name',
        agentName: 'Resume name',
        sessionId: fork.sessionId,
      },
    ])
  })

  it('keeps a caller-provided session ID reserved after startup fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-runtime-reserve-test-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const sessionId = '88888888-8888-4888-8888-888888888888'
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
    })

    await expect(
      service.run('claim identity', undefined, sessionId),
    ).rejects.toThrow('A model provider is required for run and resume')
    const { resolveClaudePaths } =
      await import('../compatibility/claude/paths.js')
    await expect(
      readFile(
        resolveClaudePaths({ configDir: configRoot, cwd, sessionId })
          .sessionFile,
        'utf8',
      ),
    ).resolves.toBe('')
    await expect(
      service.run('must not reclaim identity', undefined, sessionId),
    ).rejects.toThrow(`Session ID ${sessionId} is already in use`)
  })

  it('compacts over-budget context before the model turn and preserves append-only history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-runtime-compaction-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const origin = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: {
        capabilities: { streaming: true, usage: true, tools: false },
        async *complete() {
          yield {
            type: 'text-delta',
            delta: `old-context ${'discarded '.repeat(600)}`,
          }
        },
      },
    })
    const first = await origin.run('CURRENT_TASK')

    const requests: ModelRequest[] = []
    const events: RuntimeEvent[] = []
    const provider: ModelProvider = {
      model: 'compaction-fixture-model',
      capabilities: {
        streaming: true,
        usage: true,
        tools: false,
        contextWindowTokens: 2_500,
      },
      async *complete(request) {
        requests.push(request)
        if (requests.length === 1) {
          yield { type: 'text-delta', delta: 'COMPACTED_CURRENT_TASK' }
          yield {
            type: 'usage',
            usage: {
              inputTokens: 50,
              outputTokens: 5,
              cacheReadInputTokens: 10,
              cacheCreationInputTokens: 4,
              webSearchRequests: 3,
            },
          }
          return
        }
        yield { type: 'text-delta', delta: 'final answer' }
        yield {
          type: 'usage',
          usage: {
            inputTokens: 20,
            outputTokens: 3,
            webSearchRequests: 2,
          },
        }
      },
    }
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider,
      contextReserveTokens: 1_500,
      eventSink: (event) => events.push(event),
      pricing: new ModelPricingRegistry({
        'compaction-fixture-model': {
          inputPerMillionUsd: 1,
          outputPerMillionUsd: 1,
          cacheReadInputPerMillionUsd: 0.5,
          cacheCreationInputPerMillionUsd: 0.5,
        },
      }),
      costStateStore: { load: async () => null, save: async () => undefined },
    })

    const result = await service.resume(first.sessionId, 'Continue the task.')

    expect(result).toMatchObject({
      text: 'final answer',
      usage: {
        inputTokens: 70,
        outputTokens: 8,
        cacheReadInputTokens: 10,
        cacheCreationInputTokens: 4,
        webSearchRequests: 5,
      },
    })
    expect(result.modelUsage).toEqual({
      'compaction-fixture-model': {
        inputTokens: 70,
        outputTokens: 8,
        cacheReadInputTokens: 10,
        cacheCreationInputTokens: 4,
        webSearchRequests: 5,
        contextWindow: 2_500,
      },
    })
    expect(result.costUsd).toBe(71 / 1_000_000)
    expect(requests).toHaveLength(2)
    expect(JSON.stringify(requests[0]?.messages)).toContain('old-context')
    expect(JSON.stringify(requests[1]?.messages)).toContain(
      'COMPACTED_CURRENT_TASK',
    )
    expect(JSON.stringify(requests[1]?.messages)).not.toContain('old-context')
    expect(events).toContainEqual({ type: 'state', state: 'compacting' })
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'compact-boundary',
        trigger: 'auto',
        preTokens: expect.any(Number),
        uuid: expect.any(String),
      }),
    )

    const { resolveClaudePaths } =
      await import('../compatibility/claude/paths.js')
    const transcript = await readFile(
      resolveClaudePaths({
        configDir: configRoot,
        cwd,
        sessionId: result.sessionId,
      }).sessionFile,
      'utf8',
    )
    expect(transcript).toContain('old-context')
    expect(transcript).toContain('"subtype":"compact_boundary"')
    expect(transcript).toContain('"isCompactSummary":true')

    const snapshot = await service.costSnapshot(result.sessionId)
    expect(snapshot.modelUsage).toEqual({
      'compaction-fixture-model': {
        inputTokens: 70,
        outputTokens: 8,
        cacheReadInputTokens: 10,
        cacheCreationInputTokens: 4,
        webSearchRequests: 5,
        costUsd: 71 / 1_000_000,
      },
    })
    expect(snapshot.totalCostUsd).toBe(71 / 1_000_000)
    expect(snapshot.apiDurationMs).toBe(result.durationApiMs)
    expect(snapshot.hasUnknownModelCost).toBe(false)
  })

  it('carries provider capability metadata through turn aggregation without polluting aggregate or cost state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-metadata-turn-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const provider: ModelProvider = {
      model: 'metadata-fixture-model',
      capabilities: {
        streaming: true,
        usage: true,
        tools: true,
        contextWindowTokens: 200_000,
        maxOutputTokens: 32_000,
      },
      async *complete() {
        yield { type: 'text-delta', delta: 'answer' }
        yield {
          type: 'usage',
          usage: {
            inputTokens: 7,
            outputTokens: 4,
            cacheReadInputTokens: 3,
            webSearchRequests: 1,
          },
        }
      },
    }
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider,
      costStateStore: { load: async () => null, save: async () => undefined },
    })

    const run = await service.run('start')

    // The per-model row carries the provider's known capability metadata after
    // the turn aggregation boundary.
    expect(run.modelUsage).toEqual({
      'metadata-fixture-model': {
        inputTokens: 7,
        outputTokens: 4,
        cacheReadInputTokens: 3,
        webSearchRequests: 1,
        contextWindow: 200_000,
        maxOutputTokens: 32_000,
      },
    })
    // The aggregate total stays counter-only.
    expect(run.usage).toEqual({
      inputTokens: 7,
      outputTokens: 4,
      cacheReadInputTokens: 3,
      webSearchRequests: 1,
    })
    // The persisted cost snapshot strips capability metadata.
    const snapshot = await service.costSnapshot(run.sessionId)
    expect(snapshot.modelUsage['metadata-fixture-model']).toMatchObject({
      inputTokens: 7,
      outputTokens: 4,
      cacheReadInputTokens: 3,
      cacheCreationInputTokens: 0,
      webSearchRequests: 1,
    })
    expect(snapshot.modelUsage['metadata-fixture-model']).not.toHaveProperty(
      'contextWindow',
    )
    expect(snapshot.modelUsage['metadata-fixture-model']).not.toHaveProperty(
      'maxOutputTokens',
    )
  })

  it('rejects a shell tool breakdown conflicting with the main provider capability metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-metadata-shell-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const provider: ModelProvider = {
      model: 'shell-fixture-model',
      capabilities: {
        streaming: true,
        usage: true,
        tools: true,
        contextWindowTokens: 200_000,
        maxOutputTokens: 32_000,
      },
      async *complete() {
        yield { type: 'text-delta', delta: 'answer' }
        yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1 } }
      },
    }
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider,
      tools: {
        definitions: () => [
          {
            name: 'Bash',
            description: 'Run a shell command',
            inputSchema: {
              type: 'object',
              properties: { command: { type: 'string' } },
              required: ['command'],
            },
          },
        ],
        prepare: async (call) => call,
        execute: async () => ({
          content: 'shell output',
          isError: false,
          usage: { inputTokens: 1, outputTokens: 1 },
          modelUsage: {
            'shell-fixture-model': {
              inputTokens: 2,
              outputTokens: 1,
              contextWindow: 100_000,
              maxOutputTokens: 16_000,
            },
          },
        }),
      },
      permissions: { resolve: () => ({ behavior: 'allow' }) },
    })

    await expect(
      service.runShell(
        'printf hi',
        undefined,
        '91919191-9191-4191-8191-919191919191',
      ),
    ).rejects.toThrow(
      'Model usage for "shell-fixture-model" has conflicting contextWindow values: 100000 vs 200000',
    )
  })

  it('honors the shared auto-compact setting without disabling manual compaction', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-runtime-no-compact-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const origin = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: queuedProvider([`old-context ${'discarded '.repeat(600)}`]),
    })
    const first = await origin.run('CURRENT_TASK')
    let compactCalls = 0
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: queuedProvider(['unreachable']),
      contextBudget: new ContextBudget({
        contextWindowTokens: 400,
        reserveTokens: 50,
      }),
      autoCompact: false,
      compactor: {
        async compact() {
          compactCalls += 1
          return {
            summary: 'manual summary',
            usage: { inputTokens: 1, outputTokens: 1 },
            durationMs: 1,
            model: 'manual-compact-model',
          }
        },
      },
    })

    await expect(service.resume(first.sessionId, 'Continue.')).rejects.toThrow(
      'Context exceeds provider budget',
    )
    expect(compactCalls).toBe(0)
    await expect(service.compact(first.sessionId)).resolves.toMatchObject({
      summary: 'manual summary',
    })
    expect(compactCalls).toBe(1)
  })

  it('compacts a large completed tool result before the next model turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-runtime-tool-compact-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const requests: ModelRequest[] = []
    let mainTurns = 0
    const provider: ModelProvider = {
      model: 'tool-compact-model',
      capabilities: {
        streaming: true,
        usage: true,
        tools: true,
        contextWindowTokens: 2_000,
      },
      async *complete(request) {
        requests.push(request)
        if (
          JSON.stringify(request.messages).includes(
            'You are compacting an agent conversation',
          )
        ) {
          yield { type: 'text-delta', delta: 'TOOL_RESULT_SUMMARY' }
          yield {
            type: 'usage',
            usage: { inputTokens: 30, outputTokens: 4 },
          }
          return
        }
        if (mainTurns++ === 0) {
          yield {
            type: 'tool-call',
            call: { id: 'call_large', name: 'Read', input: {} },
          }
          return
        }
        yield { type: 'text-delta', delta: 'tool compacted' }
      },
    }
    const tools: ToolRegistry = {
      definitions: () => [
        { name: 'Read', description: 'Read', inputSchema: { type: 'object' } },
      ],
      async prepare(call) {
        return call
      },
      async execute() {
        return {
          content: `LARGE_TOOL_RESULT ${'contents '.repeat(500)}`,
          isError: false,
          followUpUserMessages: ['EXACT_TOOL_FOLLOW_UP'],
        }
      },
    }
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider,
      tools,
      permissions: { resolve: () => ({ behavior: 'allow' }) },
      contextReserveTokens: 1_000,
    })

    const result = await service.run('Read the large result.')

    expect(result.text).toBe('tool compacted')
    expect(requests).toHaveLength(3)
    expect(JSON.stringify(requests[1]?.messages)).toContain('LARGE_TOOL_RESULT')
    expect(JSON.stringify(requests[2]?.messages)).toContain(
      'TOOL_RESULT_SUMMARY',
    )
    expect(JSON.stringify(requests[2]?.messages)).toContain(
      'Read the large result.',
    )
    expect(JSON.stringify(requests[2]?.messages)).toContain(
      'EXACT_TOOL_FOLLOW_UP',
    )
    expect(JSON.stringify(requests[2]?.messages)).not.toContain(
      'LARGE_TOOL_RESULT',
    )
    const { resolveClaudePaths } =
      await import('../compatibility/claude/paths.js')
    const entries = (
      await readFile(
        resolveClaudePaths({
          configDir: configRoot,
          cwd,
          sessionId: result.sessionId,
        }).sessionFile,
        'utf8',
      )
    )
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line))
    const originalPrompt = entries.find(
      (entry) =>
        entry.type === 'user' &&
        entry.message?.content === 'Read the large result.',
    )
    const toolResult = entries.find(
      (entry) => entry.type === 'user' && entry.sourceToolAssistantUUID,
    )
    const boundary = entries.find(
      (entry) => entry.subtype === 'compact_boundary',
    )
    expect(boundary?.logicalParentUuid).toBe(originalPrompt?.uuid)
    expect(boundary?.logicalParentUuid).not.toBe(toolResult?.uuid)
  })

  it('rejects an auto-compaction duration overflow before appending the failing boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-auto-compact-overflow-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const origin = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: {
        capabilities: { streaming: true, usage: true, tools: false },
        async *complete() {
          yield {
            type: 'text-delta',
            delta: `old-context ${'discarded '.repeat(600)}`,
          }
        },
      },
    })
    const first = await origin.run('CURRENT_TASK')

    let compactCalls = 0
    const provider: ModelProvider = {
      model: 'overflow-model',
      capabilities: {
        streaming: true,
        usage: true,
        tools: true,
        contextWindowTokens: 2_500,
      },
      async *complete() {
        yield {
          type: 'tool-call',
          call: { id: 'call_large', name: 'Read', input: {} },
        }
      },
    }
    const tools: ToolRegistry = {
      definitions: () => [
        { name: 'Read', description: 'Read', inputSchema: { type: 'object' } },
      ],
      async prepare(call) {
        return call
      },
      async execute() {
        return {
          content: `LARGE_RESULT ${'contents '.repeat(600)}`,
          isError: false,
        }
      },
    }
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider,
      tools,
      permissions: { resolve: () => ({ behavior: 'allow' }) },
      contextReserveTokens: 1_500,
      compactor: {
        async compact() {
          compactCalls += 1
          return {
            summary: `overflow summary ${compactCalls}`,
            usage: { inputTokens: 2, outputTokens: 1 },
            durationMs: Number.MAX_VALUE,
            model: 'overflow-model',
          }
        },
      },
    })

    await expect(
      service.resume(first.sessionId, 'Read the large result.'),
    ).rejects.toThrow('compaction durationMs total overflow')
    expect(compactCalls).toBe(2)

    const transcript = await readFile(
      resolveClaudePaths({
        configDir: configRoot,
        cwd,
        sessionId: first.sessionId,
      }).sessionFile,
      'utf8',
    )
    expect(transcript.match(/"subtype":"compact_boundary"/g)).toHaveLength(1)
    expect(transcript).toContain('overflow summary 1')
    expect(transcript).not.toContain('overflow summary 2')
  })

  it('meters a committed auto-compact boundary even when the following main provider fails', async () => {
    const root = await mkdtemp(
      join(tmpdir(), 'praxis-auto-compact-metered-fail-'),
    )
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const origin = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: {
        capabilities: { streaming: true, usage: true, tools: false },
        async *complete() {
          yield {
            type: 'text-delta',
            delta: `old-context ${'discarded '.repeat(600)}`,
          }
        },
      },
    })
    const first = await origin.run('CURRENT_TASK')

    let mainCalls = 0
    const provider: ModelProvider = {
      model: 'main-run-model',
      capabilities: {
        streaming: true,
        usage: true,
        tools: false,
        contextWindowTokens: 2_500,
      },
      async *complete() {
        if (mainCalls++ === 0) {
          throw new ModelProviderError(
            'main provider failed after boundary commit',
            { retryable: true },
          )
        }
        yield { type: 'text-delta', delta: 'resumed answer' }
        yield {
          type: 'usage',
          usage: { inputTokens: 9, outputTokens: 4 },
        }
      },
    }
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider,
      contextReserveTokens: 1_500,
      compactor: {
        async compact() {
          return {
            summary: 'COMPACTED_DISTINCT_MODEL',
            usage: {
              inputTokens: 12,
              outputTokens: 6,
              webSearchRequests: 1,
            },
            durationMs: 40,
            durationWithoutRetriesMs: 25,
            model: 'distinct-compactor-model',
          }
        },
      },
      pricing: new ModelPricingRegistry({
        'main-run-model': { inputPerMillionUsd: 1, outputPerMillionUsd: 1 },
        'distinct-compactor-model': {
          inputPerMillionUsd: 2,
          outputPerMillionUsd: 3,
        },
      }),
      costStateStore: { load: async () => null, save: async () => undefined },
    })

    const compactCost = (12 * 2 + 6 * 3) / 1_000_000
    await expect(
      service.resume(first.sessionId, 'Continue the task.'),
    ).rejects.toThrow('main provider failed after boundary commit')

    const snapshot = await service.costSnapshot(first.sessionId)
    expect(snapshot.modelUsage).toEqual({
      'distinct-compactor-model': {
        inputTokens: 12,
        outputTokens: 6,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        webSearchRequests: 1,
        costUsd: compactCost,
      },
    })
    expect(snapshot.totalCostUsd).toBe(compactCost)
    expect(snapshot.apiDurationMs).toBe(40)
    expect(snapshot.apiDurationWithoutRetriesMs).toBe(25)
    expect(snapshot.toolDurationMs).toBe(0)
    expect(snapshot.hasUnknownModelCost).toBe(false)

    const { resolveClaudePaths } =
      await import('../compatibility/claude/paths.js')
    const transcript = await readFile(
      resolveClaudePaths({
        configDir: configRoot,
        cwd,
        sessionId: first.sessionId,
      }).sessionFile,
      'utf8',
    )
    expect(transcript.match(/"subtype":"compact_boundary"/g)).toHaveLength(1)
    expect(transcript).toContain('COMPACTED_DISTINCT_MODEL')

    const resumed = await service.resume(first.sessionId, 'Continue again.')
    expect(resumed.text).toBe('resumed answer')
    expect(resumed.durationApiMs).toBeDefined()
    const resumedDurationApiMs = resumed.durationApiMs as number

    const after = await service.costSnapshot(first.sessionId)
    expect(after.modelUsage['distinct-compactor-model']).toEqual({
      inputTokens: 12,
      outputTokens: 6,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 1,
      costUsd: compactCost,
    })
    expect(after.modelUsage['main-run-model']).toMatchObject({
      inputTokens: 9,
      outputTokens: 4,
    })
    expect(after.totalCostUsd).toBeCloseTo(compactCost + 13 / 1_000_000)
    expect(after.apiDurationMs).toBe(40 + resumedDurationApiMs)
    expect(after.apiDurationWithoutRetriesMs).toBe(25 + resumedDurationApiMs)
    expect(
      (
        await readFile(
          resolveClaudePaths({
            configDir: configRoot,
            cwd,
            sessionId: first.sessionId,
          }).sessionFile,
          'utf8',
        )
      ).match(/"subtype":"compact_boundary"/g),
    ).toHaveLength(1)
  })

  it('fails before append when auto-compact usage lacks a model identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-auto-compact-model-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const origin = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: {
        capabilities: { streaming: true, usage: true, tools: false },
        async *complete() {
          yield {
            type: 'text-delta',
            delta: `old-context ${'discarded '.repeat(600)}`,
          }
        },
      },
    })
    const first = await origin.run('CURRENT_TASK')

    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: {
        capabilities: {
          streaming: true,
          usage: true,
          tools: false,
          contextWindowTokens: 2_500,
        },
        async *complete() {
          yield { type: 'text-delta', delta: 'unreachable answer' }
          yield {
            type: 'usage',
            usage: { inputTokens: 1, outputTokens: 1 },
          }
        },
      },
      contextReserveTokens: 1_500,
      compactor: {
        async compact() {
          return {
            summary: 'unattributed compact summary',
            usage: { inputTokens: 3, outputTokens: 2 },
            durationMs: 5,
          }
        },
      },
      costStateStore: { load: async () => null, save: async () => undefined },
    })

    const before = await service.costSnapshot(first.sessionId)
    await expect(
      service.resume(first.sessionId, 'Continue the task.'),
    ).rejects.toThrow('Auto compact usage requires a nonblank model identity')
    const after = await service.costSnapshot(first.sessionId)
    expect(trackedTotals(after)).toEqual(trackedTotals(before))

    const { resolveClaudePaths } =
      await import('../compatibility/claude/paths.js')
    const transcript = await readFile(
      resolveClaudePaths({
        configDir: configRoot,
        cwd,
        sessionId: first.sessionId,
      }).sessionFile,
      'utf8',
    )
    expect(transcript).not.toContain('compact_boundary')
  })

  it('supports repeated compaction with cumulative dropped-token metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-runtime-recompact-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const origin = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: queuedProvider(['old-history '.repeat(500)]),
    })
    const first = await origin.run('Initial task.')
    let compactCount = 0
    let mainCount = 0
    const provider: ModelProvider = {
      capabilities: {
        streaming: true,
        usage: true,
        tools: false,
        contextWindowTokens: 2_500,
      },
      async *complete(request) {
        const compacting = JSON.stringify(request.messages).includes(
          'You are compacting an agent conversation',
        )
        if (compacting) {
          compactCount += 1
          yield {
            type: 'text-delta',
            delta: `COMPACT_SUMMARY_${compactCount}`,
          }
          return
        }
        mainCount += 1
        yield {
          type: 'text-delta',
          delta:
            mainCount === 1
              ? `intermediate ${'new-history '.repeat(500)}`
              : 'recompact done',
        }
      },
    }
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider,
      contextReserveTokens: 1_500,
    })

    await service.resume(first.sessionId, 'First continuation.')
    const result = await service.resume(first.sessionId, 'Second continuation.')

    expect(result.text).toBe('recompact done')
    expect(compactCount).toBe(2)
    const { resolveClaudePaths } =
      await import('../compatibility/claude/paths.js')
    const entries = (
      await readFile(
        resolveClaudePaths({
          configDir: configRoot,
          cwd,
          sessionId: first.sessionId,
        }).sessionFile,
        'utf8',
      )
    )
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line))
    const boundaries = entries.filter(
      (entry) => entry.subtype === 'compact_boundary',
    )
    expect(boundaries).toHaveLength(2)
    expect(
      boundaries[1]?.compactMetadata.cumulativeDroppedTokens,
    ).toBeGreaterThan(boundaries[0]?.compactMetadata.cumulativeDroppedTokens)
  })

  it('does not write partial compact records when summarization fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-runtime-compact-fail-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const origin = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: {
        capabilities: { streaming: true, usage: true, tools: false },
        async *complete() {
          yield { type: 'text-delta', delta: 'history '.repeat(600) }
        },
      },
    })
    const first = await origin.run('Build the feature.')
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: {
        capabilities: {
          streaming: true,
          usage: true,
          tools: false,
          contextWindowTokens: 400,
        },
        async *complete() {
          yield { type: 'text-delta', delta: 'unexpected' }
        },
      },
      contextReserveTokens: 50,
      compactor: {
        async compact() {
          throw new Error('summary provider failed')
        },
      },
    })

    await expect(service.resume(first.sessionId, 'Continue.')).rejects.toThrow(
      'summary provider failed',
    )

    const { resolveClaudePaths } =
      await import('../compatibility/claude/paths.js')
    const transcript = await readFile(
      resolveClaudePaths({
        configDir: configRoot,
        cwd,
        sessionId: first.sessionId,
      }).sessionFile,
      'utf8',
    )
    expect(transcript).not.toContain('compact_boundary')
    expect(transcript).not.toContain('Continue.')
  })

  it('fails with token diagnostics before writing a summary that still cannot fit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-runtime-compact-size-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const origin = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: queuedProvider(['history '.repeat(200)]),
    })
    const first = await origin.run('Build the feature.')
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: queuedProvider(['unexpected']),
      contextBudget: new ContextBudget({
        contextWindowTokens: 100,
        reserveTokens: 20,
      }),
      compactor: {
        async compact() {
          return {
            summary: 'SMALL_SUMMARY',
            usage: { inputTokens: 1, outputTokens: 1 },
            durationMs: 1,
          }
        },
      },
    })

    await expect(service.resume(first.sessionId, 'Continue.')).rejects.toThrow(
      /estimated=.*window=100.*reserve=20.*available=80/,
    )

    const { resolveClaudePaths } =
      await import('../compatibility/claude/paths.js')
    const transcript = await readFile(
      resolveClaudePaths({
        configDir: configRoot,
        cwd,
        sessionId: first.sessionId,
      }).sessionFile,
      'utf8',
    )
    expect(transcript).not.toContain('compact_boundary')
  })

  it('retries compaction after prompt hook context pushes the turn over budget', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-runtime-hook-compact-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const origin = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: queuedProvider(['history '.repeat(200)]),
    })
    const first = await origin.run('Initial task.')
    const requests: ModelRequest[] = []
    const provider: ModelProvider = {
      capabilities: {
        streaming: true,
        usage: true,
        tools: false,
        contextWindowTokens: 2_500,
      },
      async *complete(request) {
        requests.push(request)
        const compacting = JSON.stringify(request.messages).includes(
          'You are compacting an agent conversation',
        )
        yield {
          type: 'text-delta',
          delta: compacting ? 'HOOK_CONTEXT_SUMMARY' : 'hook compacted',
        }
      },
    }
    const hooks = new ClaudeHookRunner({
      cwd,
      settings: [
        {
          path: join(configRoot, 'settings.json'),
          scope: 'user',
          value: {
            hooks: {
              UserPromptSubmit: [
                { hooks: [{ type: 'command', command: 'prompt-hook' }] },
              ],
            },
          },
        },
      ],
      executeCommand: async () => ({
        stdout: `HOOK_CONTEXT ${'hook-data '.repeat(350)}`,
        stderr: '',
        exitCode: 0,
        durationMs: 1,
      }),
    })
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider,
      hooks,
      contextReserveTokens: 1_500,
    })

    const result = await service.resume(first.sessionId, 'Exact prompt text.')

    expect(result.text).toBe('hook compacted')
    expect(requests).toHaveLength(2)
    expect(JSON.stringify(requests[0]?.messages)).toContain('HOOK_CONTEXT')
    expect(JSON.stringify(requests[1]?.messages)).toContain(
      'HOOK_CONTEXT_SUMMARY',
    )
    expect(JSON.stringify(requests[1]?.messages)).toContain(
      'Exact prompt text.',
    )
  })

  it('rejects an irreducible replay prompt before calling the compactor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-runtime-replay-limit-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const origin = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: queuedProvider(['short history']),
    })
    const first = await origin.run('Initial task.')
    let compactorCalled = false
    const hooks = new ClaudeHookRunner({
      cwd,
      settings: [
        {
          path: join(configRoot, 'settings.json'),
          scope: 'user',
          value: {
            hooks: {
              UserPromptSubmit: [
                { hooks: [{ type: 'command', command: 'prompt-hook' }] },
              ],
            },
          },
        },
      ],
      executeCommand: async () => ({
        stdout: `HOOK_CONTEXT ${'x'.repeat(2_000)}`,
        stderr: '',
        exitCode: 0,
        durationMs: 1,
      }),
    })
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: queuedProvider(['unexpected']),
      hooks,
      contextBudget: new ContextBudget({
        contextWindowTokens: 400,
        reserveTokens: 100,
      }),
      compactor: {
        async compact() {
          compactorCalled = true
          return {
            summary: 'summary',
            usage: { inputTokens: 1, outputTokens: 1 },
            durationMs: 1,
          }
        },
      },
    })

    await expect(
      service.resume(first.sessionId, 'p'.repeat(950)),
    ).rejects.toThrow(/estimated=.*window=400.*reserve=100/)
    expect(compactorCalled).toBe(false)
  })

  it('deducts replay messages and compact envelope from the summary target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-runtime-target-limit-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const origin = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: queuedProvider(['history '.repeat(300)]),
    })
    const first = await origin.run('Initial task.')
    let targetTokens = 0
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: queuedProvider(['done']),
      contextBudget: new ContextBudget({
        contextWindowTokens: 1_000,
        reserveTokens: 400,
      }),
      compactor: {
        async compact(request) {
          targetTokens = request.targetTokens
          return {
            summary: 'summary',
            usage: { inputTokens: 1, outputTokens: 1 },
            durationMs: 1,
            model: 'summary-target-model',
          }
        },
      },
    })

    await service.resume(first.sessionId, 'p'.repeat(1_600))

    expect(targetTokens).toBeGreaterThan(0)
    expect(targetTokens).toBeLessThan(150)
  })

  it('replays a Stop hook continuation after mid-turn compaction', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-runtime-stop-compact-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const requests: ModelRequest[] = []
    let mainTurn = 0
    const provider: ModelProvider = {
      capabilities: {
        streaming: true,
        usage: true,
        tools: false,
        contextWindowTokens: 2_500,
      },
      async *complete(request) {
        requests.push(request)
        if (
          JSON.stringify(request.messages).includes(
            'You are compacting an agent conversation',
          )
        ) {
          yield { type: 'text-delta', delta: 'STOP_CONTEXT_SUMMARY' }
          return
        }
        yield {
          type: 'text-delta',
          delta:
            mainTurn++ === 0
              ? `draft ${'large-response '.repeat(400)}`
              : 'revised',
        }
      },
    }
    let stopCalls = 0
    const hooks = new ClaudeHookRunner({
      cwd,
      settings: [
        {
          path: join(configRoot, 'settings.json'),
          scope: 'user',
          value: {
            hooks: {
              Stop: [{ hooks: [{ type: 'command', command: 'stop-hook' }] }],
            },
          },
        },
      ],
      executeCommand: async () =>
        stopCalls++ === 0
          ? {
              stdout: '',
              stderr: 'EXACT_STOP_CONTINUATION',
              exitCode: 2,
              durationMs: 1,
            }
          : { stdout: '', stderr: '', exitCode: 0, durationMs: 1 },
    })
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider,
      hooks,
      contextReserveTokens: 1_500,
      contextAssembler: {
        async assemble() {
          return {
            systemMessages: [],
            firstUserMessageContext: 'DYNAMIC_COMPACTION_CONTEXT',
          }
        },
      },
    })

    const result = await service.run('Improve the draft.')

    expect(result.text).toBe('revised')
    expect(requests).toHaveLength(3)
    expect(JSON.stringify(requests[2]?.messages)).toContain(
      'Stop hook error: EXACT_STOP_CONTINUATION',
    )
    expect(JSON.stringify(requests[2]?.messages)).toContain(
      'Improve the draft.',
    )
    expect(JSON.stringify(requests[2]?.messages)).toContain(
      'DYNAMIC_COMPACTION_CONTEXT',
    )
    const transcript = await readFile(
      resolveClaudePaths({
        configDir: configRoot,
        cwd,
        sessionId: result.sessionId,
      }).sessionFile,
      'utf8',
    )
    expect(transcript).not.toContain('DYNAMIC_COMPACTION_CONTEXT')
  })

  it('checks cancellation again before committing compact records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-runtime-compact-abort-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const origin = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: queuedProvider(['history '.repeat(500)]),
    })
    const first = await origin.run('Initial task.')
    const controller = new AbortController()
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: queuedProvider(['unexpected']),
      contextBudget: new ContextBudget({
        contextWindowTokens: 500,
        reserveTokens: 100,
      }),
      compactor: {
        async compact() {
          controller.abort()
          return {
            summary: 'CANCELLED_SUMMARY',
            usage: { inputTokens: 1, outputTokens: 1 },
            durationMs: 1,
          }
        },
      },
    })

    await expect(
      service.resume(first.sessionId, 'Do not persist.', controller.signal),
    ).rejects.toBeInstanceOf(AgentRunCancelledError)

    const { resolveClaudePaths } =
      await import('../compatibility/claude/paths.js')
    const transcript = await readFile(
      resolveClaudePaths({
        configDir: configRoot,
        cwd,
        sessionId: first.sessionId,
      }).sessionFile,
      'utf8',
    )
    expect(transcript).not.toContain('compact_boundary')
    expect(transcript).not.toContain('Do not persist.')
  })

  it('runs, persists, resumes, lists, and forks a text session', async () => {
    const { configRoot, cwd, service } = await createService()

    const first = await service.run('first prompt')
    expect(first.text).toBe('first answer')

    const resumed = await service.resume(first.sessionId, 'second prompt')
    expect(resumed.text).toBe('second answer')
    expect(resumed.sessionId).toBe(first.sessionId)

    const sessions = await service.sessions()
    expect(sessions).toEqual([
      expect.objectContaining({
        sessionId: first.sessionId,
        lastPrompt: 'second prompt',
      }),
    ])

    await service.rename(first.sessionId, 'renamed-session')
    await expect(service.sessions()).resolves.toEqual([
      expect.objectContaining({
        sessionId: first.sessionId,
        name: 'renamed-session',
      }),
    ])

    const forked = await service.fork(first.sessionId)
    expect(forked.sessionId).not.toBe(first.sessionId)
    expect(forked.parentSessionId).toBe(first.sessionId)

    const projectDirectories = await import('../compatibility/claude/paths.js')
    const forkPaths = projectDirectories.resolveClaudePaths({
      configDir: configRoot,
      cwd,
      sessionId: forked.sessionId,
    })
    const source = await readFile(forkPaths.sessionFile, 'utf8')
    expect(source).toContain(`"sessionId":"${forked.sessionId}"`)
    expect(source).not.toContain(`"sessionId":"${first.sessionId}"`)
    expect(source).toContain('"customTitle":"renamed-session"')
  })

  it('idempotently ensures the expected native fork for a background handoff', async () => {
    const { configRoot, cwd, service } = await createService()
    const source = await service.run('handoff source')
    const targetSessionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
    const sourceCheckpoint = await service.recordBackgroundLaunch(
      source.sessionId,
    )

    await expect(
      service.ensureFork(source.sessionId, targetSessionId, sourceCheckpoint),
    ).resolves.toEqual({
      parentSessionId: source.sessionId,
      sessionId: targetSessionId,
    })
    const targetFile = resolveClaudePaths({
      configDir: configRoot,
      cwd,
      sessionId: targetSessionId,
    }).sessionFile
    const before = await readFile(targetFile, 'utf8')
    const sourceEntries = (
      await readFile(
        resolveClaudePaths({
          configDir: configRoot,
          cwd,
          sessionId: source.sessionId,
        }).sessionFile,
        'utf8',
      )
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    const branchPoint = sourceEntries.find(
      (entry) => entry.type === 'user' && typeof entry.uuid === 'string',
    )
    expect(branchPoint?.uuid).toEqual(expect.any(String))
    await service.resume(
      source.sessionId,
      'source branched elsewhere',
      undefined,
      undefined,
      undefined,
      undefined,
      String(branchPoint?.uuid),
    )

    await expect(
      service.ensureFork(source.sessionId, targetSessionId, sourceCheckpoint),
    ).resolves.toEqual({
      parentSessionId: source.sessionId,
      sessionId: targetSessionId,
    })
    await expect(readFile(targetFile, 'utf8')).resolves.toBe(before)
  })

  it('generates a provider-backed kebab-case session name without transcript mutation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-session-name-test-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const provider = queuedProvider(['first answer', 'review-auth-flow'])
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider,
    })
    const result = await service.run('review authentication')
    const paths = resolveClaudePaths({
      configDir: configRoot,
      cwd,
      sessionId: result.sessionId,
    })
    const before = await readFile(paths.sessionFile, 'utf8')

    await expect(service.sessionNameSuggestion(result.sessionId)).resolves.toBe(
      'review-auth-flow',
    )
    expect(await readFile(paths.sessionFile, 'utf8')).toBe(before)
  })

  it('meters a session-name suggestion into the session cost snapshot exactly once without transcript mutation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-session-name-metered-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const requests: ModelRequest[] = []
    const provider: ModelProvider = {
      model: 'name-model',
      capabilities: { streaming: true, usage: true, tools: false },
      async *complete(request) {
        requests.push(request)
        yield {
          type: 'text-delta',
          delta: requests.length === 1 ? 'main answer' : 'review-auth-flow',
        }
        yield { type: 'usage', usage: { inputTokens: 4, outputTokens: 2 } }
      },
    }
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider,
      pricing: new ModelPricingRegistry({
        'name-model': { inputPerMillionUsd: 2, outputPerMillionUsd: 4 },
      }),
    })
    const result = await service.run('review authentication')
    const paths = resolveClaudePaths({
      configDir: configRoot,
      cwd,
      sessionId: result.sessionId,
    })
    const before = await readFile(paths.sessionFile, 'utf8')

    await expect(service.sessionNameSuggestion(result.sessionId)).resolves.toBe(
      'review-auth-flow',
    )

    const snapshot = await service.costSnapshot(result.sessionId)
    expect(snapshot.modelUsage['name-model']).toMatchObject({
      inputTokens: 8,
      outputTokens: 4,
      costUsd: 0.000032,
    })
    expect(snapshot.hasUnknownModelCost).toBe(false)
    expect(snapshot.apiDurationMs).toBeGreaterThanOrEqual(0)
    expect(snapshot.apiDurationWithoutRetriesMs).toBe(snapshot.apiDurationMs)
    expect(await readFile(paths.sessionFile, 'utf8')).toBe(before)
    expect(requests).toHaveLength(2)
  })

  it('resumes and forks at an active user message using native transcript branches', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-runtime-resume-at-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const requests: ModelRequest[] = []
    let turn = 0
    const provider: ModelProvider = {
      capabilities: { streaming: true, usage: true, tools: false },
      async *complete(request) {
        requests.push(request)
        turn += 1
        yield { type: 'text-delta', delta: `answer ${turn}` }
      },
    }
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider,
    })
    const first = await service.run('first prompt')
    await service.resume(first.sessionId, 'second prompt')
    await service.resume(first.sessionId, 'abandoned third prompt')

    const { resolveClaudePaths } =
      await import('../compatibility/claude/paths.js')
    const paths = resolveClaudePaths({
      configDir: configRoot,
      cwd,
      sessionId: first.sessionId,
    })
    const before = (await readFile(paths.sessionFile, 'utf8'))
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line))
    const target = before.find(
      (entry) =>
        entry.type === 'user' && entry.message?.content === 'second prompt',
    )
    const abandoned = before.find(
      (entry) =>
        entry.type === 'user' &&
        entry.message?.content === 'abandoned third prompt',
    )
    const targetAnswer = before.find(
      (entry) =>
        entry.parentUuid === target?.uuid && entry.type === 'assistant',
    )
    if (
      typeof target?.uuid !== 'string' ||
      typeof abandoned?.uuid !== 'string' ||
      typeof targetAnswer?.uuid !== 'string'
    ) {
      throw new Error('Could not locate resume-at transcript fixtures')
    }

    const targetedHistory = await service.transcript(
      first.sessionId,
      target.uuid,
    )
    expect(targetedHistory).toContainEqual({
      kind: 'user',
      text: 'second prompt',
    })
    expect(targetedHistory).not.toContainEqual({
      kind: 'user',
      text: 'abandoned third prompt',
    })

    await service.resume(
      first.sessionId,
      'branch prompt',
      undefined,
      undefined,
      undefined,
      undefined,
      target.uuid,
    )
    const branchRequest = JSON.stringify(requests[3]?.messages)
    expect(branchRequest).toContain('first prompt')
    expect(branchRequest).toContain('answer 1')
    expect(branchRequest).toContain('second prompt')
    expect(branchRequest).toContain('branch prompt')
    expect(branchRequest).not.toContain('answer 2')
    expect(branchRequest).not.toContain('abandoned third prompt')
    expect(branchRequest).not.toContain('answer 3')

    await service.resume(first.sessionId, 'continue branch')
    const continuedRequest = JSON.stringify(requests[4]?.messages)
    expect(continuedRequest).toContain('branch prompt')
    expect(continuedRequest).toContain('answer 4')
    expect(continuedRequest).not.toContain('abandoned third prompt')

    await expect(
      service.resume(
        first.sessionId,
        'invalid assistant target',
        undefined,
        undefined,
        undefined,
        undefined,
        targetAnswer.uuid,
      ),
    ).rejects.toThrow(
      `No message found with message.uuid of: ${targetAnswer.uuid}`,
    )
    await expect(
      service.resume(
        first.sessionId,
        'invalid abandoned target',
        undefined,
        undefined,
        undefined,
        undefined,
        abandoned.uuid,
      ),
    ).rejects.toThrow(
      `No message found with message.uuid of: ${abandoned.uuid}`,
    )

    const forkSessionId = '56565656-5656-4656-8656-565656565656'
    await service.fork(first.sessionId, forkSessionId, target.uuid)
    const forkSource = await readFile(
      resolveClaudePaths({
        configDir: configRoot,
        cwd,
        sessionId: forkSessionId,
      }).sessionFile,
      'utf8',
    )
    expect(forkSource).toContain('second prompt')
    expect(forkSource).not.toContain('answer 2')
    expect(forkSource).not.toContain('abandoned third prompt')
    expect(forkSource).not.toContain('branch prompt')
    await expect(
      service.fork(first.sessionId, undefined, abandoned.uuid),
    ).rejects.toThrow(
      `No message found with message.uuid of: ${abandoned.uuid}`,
    )

    const after = (await readFile(paths.sessionFile, 'utf8'))
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line))
    const branch = after.find(
      (entry) =>
        entry.type === 'user' && entry.message?.content === 'branch prompt',
    )
    expect(branch.parentUuid).toBe(target.uuid)
    expect(after.find((entry) => entry.uuid === abandoned.uuid)).toBeDefined()
  })

  it('does not recover unresolved tool calls abandoned after the resume target', async () => {
    const { configRoot, cwd, service } = await createService()
    const first = await service.run('target prompt')
    const { resolveClaudePaths } =
      await import('../compatibility/claude/paths.js')
    const sessionFile = resolveClaudePaths({
      configDir: configRoot,
      cwd,
      sessionId: first.sessionId,
    }).sessionFile
    const initial = (await readFile(sessionFile, 'utf8'))
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line))
    const target = initial.find((entry) => entry.type === 'user')
    const answer = initial.find((entry) => entry.type === 'assistant')
    if (typeof target?.uuid !== 'string' || typeof answer?.uuid !== 'string') {
      throw new Error('Could not locate unresolved-tool fixture messages')
    }
    await appendFile(
      sessionFile,
      `${JSON.stringify({
        ...answer,
        uuid: '69696969-6969-4969-8969-696969696969',
        parentUuid: answer.uuid,
        message: {
          ...answer.message,
          id: 'msg_abandoned_tool',
          content: [
            {
              type: 'tool_use',
              id: 'call_abandoned',
              name: 'Read',
              input: { file_path: 'README.md' },
            },
          ],
          stop_reason: 'tool_use',
        },
      })}\n`,
    )

    await expect(
      service.resume(first.sessionId, 'normal resume'),
    ).rejects.toThrow('requires explicit recovery approval')
    await expect(
      service.resume(
        first.sessionId,
        'branch without recovery',
        undefined,
        undefined,
        undefined,
        undefined,
        target.uuid,
      ),
    ).resolves.toMatchObject({ text: 'second answer' })
  })

  it('inspects and exports a session without rewriting its transcript', async () => {
    const { configRoot, cwd, service } = await createService()
    const first = await service.run('inspect me')
    const { resolveClaudePaths } =
      await import('../compatibility/claude/paths.js')
    const sessionFile = resolveClaudePaths({
      configDir: configRoot,
      cwd,
      sessionId: first.sessionId,
    }).sessionFile
    const source = await readFile(sessionFile, 'utf8')

    await expect(service.inspect(first.sessionId)).resolves.toMatchObject({
      sessionId: first.sessionId,
      status: 'ready',
      writeMode: 'read-write',
      entryCount: 3,
      byteLength: Buffer.byteLength(source),
      lastPrompt: 'inspect me',
      issue: null,
    })
    await expect(service.export(first.sessionId)).resolves.toEqual(
      Buffer.from(source),
    )
    await expect(service.transcript(first.sessionId)).resolves.toEqual([
      { kind: 'user', text: 'inspect me' },
      { kind: 'assistant', text: 'first answer' },
    ])
    expect(await readFile(sessionFile, 'utf8')).toBe(source)
  })

  it('lists, inspects, and resumes a transcript in an alternate long-path project root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-runtime-alternate-root-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd =
      '/private/tmp/praxis-claude-long-probe.ZwF0h0/' +
      [1, 2, 3, 4, 5, 6]
        .map(
          (index) => `segment-segment-segment-segment-segment-segment-${index}`,
        )
        .join('/')
    const sessionId = '12121212-1212-4212-8212-121212121212'
    const sanitized = sanitizeClaudeProjectPath(cwd)
    expect(sanitized.length).toBeGreaterThan(200)
    const prefix = sanitized.slice(0, 200)
    const alternateRoot = join(
      configRoot,
      'projects',
      `${prefix}-alternate-hash`,
    )
    const sessionFile = join(alternateRoot, `${sessionId}.jsonl`)
    await mkdir(alternateRoot, { recursive: true })
    await writeFile(
      sessionFile,
      `${JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'inspect me' },
        uuid: '13131313-1313-4313-8313-131313131313',
        sessionId,
        timestamp: '2026-01-01T00:00:00.000Z',
        cwd,
        version: '2.1.208',
        gitBranch: null,
      })}\n`,
    )
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: queuedProvider(['resumed answer']),
    })

    await expect(service.sessions()).resolves.toEqual([
      expect.objectContaining({
        sessionId,
        lastPrompt: null,
        status: 'ready',
        issue: null,
      }),
    ])
    await expect(service.inspect(sessionId)).resolves.toMatchObject({
      sessionId,
      status: 'ready',
      writeMode: 'read-write',
      lastPrompt: null,
      issue: null,
    })
    await expect(
      service.resume(sessionId, 'continue here'),
    ).resolves.toMatchObject({ sessionId, text: 'resumed answer' })
    expect(await readFile(sessionFile, 'utf8')).toContain(
      '"type":"last-prompt"',
    )

    // A long-path prefix with two candidate project directories is never
    // silently assigned to either candidate by a fresh service.
    const secondRoot = join(configRoot, 'projects', `${prefix}-second-hash`)
    const secondSessionId = '14141414-1414-4414-8414-141414141414'
    await mkdir(secondRoot, { recursive: true })
    await writeFile(
      join(secondRoot, `${secondSessionId}.jsonl`),
      `${JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'other session' },
        uuid: '15151515-1515-4515-8515-151515151515',
        sessionId: secondSessionId,
        timestamp: '2026-01-01T00:00:00.000Z',
        cwd,
        version: '2.1.208',
        gitBranch: null,
      })}\n`,
    )
    const ambiguousService = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: queuedProvider(['unused']),
    })
    await expect(ambiguousService.sessions()).resolves.toEqual([])
  })

  it('projects native PR links into summaries and preserves them across forks', async () => {
    const { configRoot, cwd, service } = await createService()
    const first = await service.run('linked session')
    const { resolveClaudePaths } =
      await import('../compatibility/claude/paths.js')
    const paths = resolveClaudePaths({
      configDir: configRoot,
      cwd,
      sessionId: first.sessionId,
    })
    const prLink = {
      type: 'pr-link',
      sessionId: first.sessionId,
      prNumber: 42,
      prUrl: 'https://github.com/owner/repo/pull/42',
      prRepository: 'owner/repo',
      timestamp: '2026-08-08T00:00:00.000Z',
    }
    await appendFile(paths.sessionFile, `${JSON.stringify(prLink)}\n`)

    await expect(service.sessions()).resolves.toEqual([
      expect.objectContaining({
        sessionId: first.sessionId,
        prNumber: 42,
        prUrl: prLink.prUrl,
        prRepository: 'owner/repo',
      }),
    ])
    await expect(service.inspect(first.sessionId)).resolves.toMatchObject({
      prNumber: 42,
      prUrl: prLink.prUrl,
      prRepository: 'owner/repo',
    })

    const fork = await service.fork(first.sessionId)
    const forkSource = await readFile(
      resolveClaudePaths({
        configDir: configRoot,
        cwd,
        sessionId: fork.sessionId,
      }).sessionFile,
      'utf8',
    )
    expect(forkSource).toContain(
      JSON.stringify({ ...prLink, sessionId: fork.sessionId }),
    )
  })

  it('lists corrupt sessions without hiding healthy sessions', async () => {
    const { configRoot, cwd, service } = await createService()
    const healthy = await service.run('healthy')
    const { resolveClaudePaths } =
      await import('../compatibility/claude/paths.js')
    const corruptId = '99999999-9999-4999-8999-999999999999'
    const corruptFile = resolveClaudePaths({
      configDir: configRoot,
      cwd,
      sessionId: corruptId,
    }).sessionFile
    await mkdir(join(corruptFile, '..'), { recursive: true })
    const corruptSource = '{"type":"last-prompt"}\n{\n'
    await writeFile(corruptFile, corruptSource)
    await writeFile(join(corruptFile, '..', 'notes.jsonl'), '{}\n')
    await mkdir(
      join(corruptFile, '..', '88888888-8888-4888-8888-888888888888.jsonl'),
    )
    await symlink(
      'missing-session.jsonl',
      join(corruptFile, '..', '77777777-7777-4777-8777-777777777777.jsonl'),
    )

    const sessions = await service.sessions()

    expect(sessions).toHaveLength(2)
    expect(sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: healthy.sessionId,
          status: 'ready',
          issue: null,
        }),
        expect.objectContaining({
          sessionId: corruptId,
          status: 'corrupt',
          issue: expect.objectContaining({ lineNumber: 2 }),
        }),
      ]),
    )
    await expect(service.inspect(corruptId)).resolves.toMatchObject({
      status: 'corrupt',
      issue: expect.objectContaining({ lineNumber: 2 }),
    })
    await expect(service.export(corruptId)).resolves.toEqual(
      Buffer.from(corruptSource),
    )
  })

  it('assembles fresh system context for run and resume without persisting it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-runtime-context-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const requests: ModelRequest[] = []
    const contextCwds: string[] = []
    let contextVersion = 0
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: {
        capabilities: { streaming: true, usage: true, tools: false },
        async *complete(request) {
          requests.push(request)
          yield { type: 'text-delta', delta: `answer-${requests.length}` }
        },
      },
      contextAssembler: {
        async assemble(options) {
          contextCwds.push(options?.cwd ?? '')
          contextVersion += 1
          return {
            systemMessages: [
              {
                role: 'system' as const,
                content: `SYSTEM_CONTEXT_${contextVersion}`,
              },
            ],
            firstUserMessageContext: `DYNAMIC_CONTEXT_${contextVersion}`,
          }
        },
      },
    })

    const first = await service.run('first prompt')
    await service.resume(first.sessionId, 'second prompt')

    expect(contextCwds).toEqual([cwd, cwd])

    expect(requests[0]?.messages[0]).toEqual({
      role: 'system',
      content: 'SYSTEM_CONTEXT_1',
    })
    expect(requests[1]?.messages[0]).toEqual({
      role: 'system',
      content: 'SYSTEM_CONTEXT_2',
    })
    expect(requests[0]?.messages[1]).toEqual({
      role: 'user',
      content: 'DYNAMIC_CONTEXT_1\n\nfirst prompt',
    })
    expect(requests[1]?.messages[1]).toEqual({
      role: 'user',
      content: 'DYNAMIC_CONTEXT_2\n\nfirst prompt',
    })
    expect(requests[1]?.messages.at(-1)).toEqual({
      role: 'user',
      content: 'second prompt',
    })
    const { resolveClaudePaths } =
      await import('../compatibility/claude/paths.js')
    const paths = resolveClaudePaths({
      configDir: configRoot,
      cwd,
      sessionId: first.sessionId,
    })
    const transcript = await readFile(paths.sessionFile, 'utf8')
    expect(transcript).not.toContain('SYSTEM_CONTEXT')
    expect(transcript).not.toContain('DYNAMIC_CONTEXT')
  })

  it('reloads imported shared instructions in the next provider request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-runtime-import-reload-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const importedPath = join(configRoot, 'details.md')
    await Promise.all([
      mkdir(configRoot, { recursive: true }),
      mkdir(cwd, { recursive: true }),
    ])
    await Promise.all([
      writeFile(join(configRoot, 'CLAUDE.md'), 'Shared import: @details.md\n'),
      writeFile(importedPath, 'IMPORTED_CONTEXT_BEFORE'),
    ])
    const requests: ModelRequest[] = []
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: {
        capabilities: { streaming: true, usage: true, tools: false },
        async *complete(request) {
          requests.push(request)
          yield { type: 'text-delta', delta: `answer-${requests.length}` }
        },
      },
      contextAssembler: new ClaudeContextAssembler({
        loadResources: () => loadClaudeContextResources({ configRoot, cwd }),
      }),
    })

    const first = await service.run('first prompt')
    await writeFile(importedPath, 'IMPORTED_CONTEXT_AFTER')
    await service.resume(first.sessionId, 'second prompt')

    expect(JSON.stringify(requests[0]?.messages)).toContain(
      'IMPORTED_CONTEXT_BEFORE',
    )
    expect(JSON.stringify(requests[0]?.messages)).not.toContain(
      'IMPORTED_CONTEXT_AFTER',
    )
    expect(JSON.stringify(requests[1]?.messages)).toContain(
      'IMPORTED_CONTEXT_AFTER',
    )
    expect(JSON.stringify(requests[1]?.messages)).not.toContain(
      'IMPORTED_CONTEXT_BEFORE',
    )
  })

  it('counts relocated first-user context against the context budget', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-runtime-context-budget-'))
    roots.push(root)
    let providerCalls = 0
    const service = new ClaudeSessionService({
      configRoot: join(root, 'config'),
      cwd: join(root, 'project'),
      claudeVersion: '2.1.208',
      provider: {
        capabilities: {
          streaming: true,
          usage: true,
          tools: false,
          contextWindowTokens: 100,
        },
        async *complete() {
          providerCalls += 1
          yield { type: 'text-delta', delta: 'unexpected' }
        },
      },
      contextReserveTokens: 20,
      contextAssembler: {
        async assemble() {
          return {
            systemMessages: [],
            firstUserMessageContext: 'DYNAMIC_CONTEXT '.repeat(500),
          }
        },
      },
    })

    await expect(service.run('prompt')).rejects.toThrow(
      /estimated=.*window=100.*reserve=20.*available=80/,
    )
    expect(providerCalls).toBe(0)
  })

  it('persists slash expansion and resumes the selected Claude agent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-runtime-extensions-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const requests: ModelRequest[] = []
    const extensions = new ClaudeExtensionCatalog({
      skills: [],
      commands: [
        {
          path: join(configRoot, 'commands', 'probe.md'),
          scope: 'user',
          content:
            '---\ndescription: Probe command.\n---\nCOMMAND [$ARGUMENTS] ZERO=[$0]',
        },
      ],
      agents: [
        {
          path: join(configRoot, 'agents', 'reviewer.md'),
          scope: 'user',
          content:
            '---\nname: reviewer\ndescription: Review work.\n---\nAGENT_MARKER',
        },
      ],
    })
    const provider: ModelProvider = {
      capabilities: { streaming: true, usage: true, tools: false },
      async *complete(request) {
        requests.push(request)
        yield { type: 'text-delta', delta: 'done' }
      },
    }
    const selected = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider,
      extensions,
      agent: 'reviewer',
    })

    const result = await selected.run('/probe alpha beta')
    const resumed = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider,
      extensions,
    })
    await resumed.resume(result.sessionId, 'continue')

    expect(requests[0]?.messages).toEqual([
      {
        role: 'system',
        content: 'AGENT_MARKER',
      },
      {
        role: 'user',
        content:
          '<command-message>probe</command-message>\n<command-name>/probe</command-name>\n<command-args>alpha beta</command-args>',
      },
      { role: 'user', content: 'COMMAND [alpha beta] ZERO=[alpha]' },
    ])
    expect(requests[1]?.messages[0]).toEqual({
      role: 'system',
      content: 'AGENT_MARKER',
    })

    const { resolveClaudePaths } =
      await import('../compatibility/claude/paths.js')
    const paths = resolveClaudePaths({
      configDir: configRoot,
      cwd,
      sessionId: result.sessionId,
    })
    const entries = (await readFile(paths.sessionFile, 'utf8'))
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(entries.slice(0, 3).map((entry) => entry.type)).toEqual([
      'agent-setting',
      'user',
      'user',
    ])
    expect(entries[0]).toEqual({
      type: 'agent-setting',
      agentSetting: 'reviewer',
      sessionId: result.sessionId,
    })
    expect(entries[2]?.message.content).toEqual([
      { type: 'text', text: 'COMMAND [alpha beta] ZERO=[alpha]' },
    ])
  })

  it('applies top-level agent prompt, model, initial prompt, and tool controls', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-runtime-main-agent-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const memoryDirectory = join(
      cwd,
      '.claude',
      'agent-memory-local',
      'reviewer',
    )
    await mkdir(memoryDirectory, { recursive: true })
    await writeFile(join(memoryDirectory, 'MEMORY.md'), 'DURABLE_MEMORY')
    const requests: Array<{ model: string; request: ModelRequest }> = []
    const provider = (model: string): ModelProvider => ({
      model,
      capabilities: { streaming: true, usage: true, tools: true },
      async *complete(request) {
        requests.push({ model, request })
        yield { type: 'text-delta', delta: 'done' }
      },
    })
    const tools: ToolRegistry = {
      definitions: () =>
        ['Read', 'Write', 'Bash'].map((name) => ({
          name,
          description: name,
          inputSchema: { type: 'object' as const },
        })),
      prepare: async (call) => call,
      execute: async () => ({ content: 'done', isError: false }),
    }
    const extensions = new ClaudeExtensionCatalog({
      commands: [],
      skills: [],
      agents: [
        {
          path: join(configRoot, 'agents', 'reviewer.md'),
          scope: 'user',
          content:
            '---\nname: reviewer\ndescription: Review work.\nmodel: agent-model\neffort: low\ntools: [Read, Write]\ndisallowedTools: [Write]\ninitialPrompt: INITIAL_MARKER\nmemory: local\n---\nAGENT_MARKER',
        },
      ],
    })
    const selected = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: provider('base-model'),
      providerForModel: provider,
      tools,
      extensions,
      agent: 'reviewer',
      effort: 'high',
    })
    expect(selected.model()).toBe('agent-model')

    const result = await selected.run('USER_MARKER')
    const resumed = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: provider('base-model'),
      providerForModel: provider,
      tools,
      extensions,
      effort: 'high',
    })
    await resumed.resume(result.sessionId, 'RESUME_MARKER')

    expect(requests.map(({ model }) => model)).toEqual([
      'agent-model',
      'agent-model',
    ])
    expect(requests[0]?.request.messages[0]).toMatchObject({ role: 'system' })
    expect(String(requests[0]?.request.messages[0]?.content)).toContain(
      'AGENT_MARKER',
    )
    expect(String(requests[0]?.request.messages[0]?.content)).toContain(
      'DURABLE_MEMORY',
    )
    expect(requests[0]?.request.messages[1]).toEqual({
      role: 'user',
      content: 'INITIAL_MARKER\n\nUSER_MARKER',
    })
    expect(requests[1]?.request.messages).toContainEqual({
      role: 'user',
      content: 'RESUME_MARKER',
    })
    expect(
      requests[1]?.request.messages.filter(
        (message) =>
          message.role === 'user' &&
          String(message.content).includes('INITIAL_MARKER'),
      ),
    ).toHaveLength(1)
    expect(requests[0]?.request.tools?.map(({ name }) => name)).toEqual([
      'Read',
    ])
    expect(requests[0]?.request.effort).toBe('high')

    const explicitRequests: ModelRequest[] = []
    const explicitProvider: ModelProvider = {
      model: 'explicit-model',
      capabilities: { streaming: true, usage: true, tools: true },
      async *complete(request) {
        explicitRequests.push(request)
        yield { type: 'text-delta', delta: 'done' }
      },
    }
    const explicit = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: explicitProvider,
      providerForModel: provider,
      explicitModel: true,
      explicitSystemPrompt: true,
      contextAssembler: {
        assemble: async () => ({
          systemMessages: [
            { role: 'system', content: 'EXPLICIT_SYSTEM_MARKER' },
          ],
        }),
      },
      tools,
      extensions,
      agent: 'reviewer',
    })
    await explicit.run('EXPLICIT_USER')

    expect(explicit.model()).toBe('explicit-model')
    expect(explicitRequests[0]?.messages[0]).toEqual({
      role: 'system',
      content: 'EXPLICIT_SYSTEM_MARKER',
    })
    expect(JSON.stringify(explicitRequests[0]?.messages)).not.toContain(
      'AGENT_MARKER',
    )
    expect(JSON.stringify(explicitRequests[0]?.messages)).toContain(
      'INITIAL_MARKER\\n\\nEXPLICIT_USER',
    )

    const interactiveRequests: ModelRequest[] = []
    const interactive = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: {
        model: 'interactive-model',
        capabilities: { streaming: true, usage: true, tools: true },
        async *complete(request) {
          interactiveRequests.push(request)
          yield { type: 'text-delta', delta: 'done' }
        },
      },
      explicitModel: true,
      explicitSystemPrompt: true,
      agentInitialPromptHandledExternally: true,
      agentSystemPromptOverridesExplicit: true,
      contextAssembler: {
        assemble: async () => ({
          systemMessages: [
            { role: 'system', content: 'EXPLICIT_SYSTEM_MARKER' },
          ],
        }),
      },
      tools,
      extensions,
      agent: 'reviewer',
    })
    await interactive.run('INTERACTIVE_USER')

    expect(String(interactiveRequests[0]?.messages[0]?.content)).toContain(
      'AGENT_MARKER',
    )
    expect(JSON.stringify(interactiveRequests[0]?.messages)).not.toContain(
      'EXPLICIT_SYSTEM_MARKER',
    )
    expect(interactiveRequests[0]?.messages).toContainEqual({
      role: 'user',
      content: 'INTERACTIVE_USER',
    })
    expect(JSON.stringify(interactiveRequests[0]?.messages)).not.toContain(
      'INITIAL_MARKER\\n\\nINTERACTIVE_USER',
    )
  })

  it('uses default behavior without persisting a missing top-level agent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-runtime-missing-agent-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const requests: ModelRequest[] = []
    const provider: ModelProvider = {
      model: 'base-model',
      capabilities: { streaming: true, usage: true, tools: false },
      async *complete(request) {
        requests.push(request)
        yield { type: 'text-delta', delta: 'done' }
      },
    }
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider,
      extensions: new ClaudeExtensionCatalog({
        agents: [],
        commands: [],
        skills: [],
      }),
      agent: 'removed-agent',
    })

    const result = await service.run('first')
    await service.resume(result.sessionId, 'second')

    expect(requests[0]?.messages).toEqual([{ role: 'user', content: 'first' }])
    expect(
      await readFile(
        resolveClaudePaths({
          configDir: configRoot,
          cwd,
          sessionId: result.sessionId,
        }).sessionFile,
        'utf8',
      ),
    ).not.toContain('agent-setting')
  })

  it('sends and persists the built-in init analysis prompt as two Claude user messages', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-runtime-init-command-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const requests: ModelRequest[] = []
    const provider: ModelProvider = {
      capabilities: { streaming: true, usage: true, tools: false },
      async *complete(request) {
        requests.push(request)
        yield { type: 'text-delta', delta: 'initialized' }
      },
    }
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider,
      extensions: new ClaudeExtensionCatalog({
        agents: [],
        commands: [],
        skills: [],
      }),
    })

    const result = await service.run('/init')

    expect(requests[0]?.messages).toHaveLength(2)
    expect(requests[0]?.messages[0]).toEqual({
      role: 'user',
      content:
        '<command-message>init</command-message>\n<command-name>/init</command-name>',
    })
    expect(requests[0]?.messages[1]).toMatchObject({ role: 'user' })
    expect(String(requests[0]?.messages[1]?.content)).toContain(
      'Analyze this repository',
    )

    const entries = (
      await readFile(
        resolveClaudePaths({
          configDir: configRoot,
          cwd,
          sessionId: result.sessionId,
        }).sessionFile,
        'utf8',
      )
    )
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(entries.filter((entry) => entry.type === 'user')).toHaveLength(2)
    expect(JSON.stringify(entries)).toContain(
      'This file provides guidance to Claude Code',
    )
  })

  it('injects selected @ agent reminders without persisting them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-runtime-agent-mention-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const requests: ModelRequest[] = []
    const extensions = new ClaudeExtensionCatalog({
      commands: [],
      skills: [],
      agents: [
        {
          path: join(configRoot, 'agents', 'reviewer.md'),
          scope: 'user',
          content:
            '---\nname: reviewer\ndescription: Review work.\n---\nAGENT_BODY',
        },
      ],
    })
    let turn = 0
    const provider: ModelProvider = {
      capabilities: { streaming: true, usage: true, tools: true },
      async *complete(request) {
        requests.push(request)
        if (turn++ === 0) {
          yield {
            type: 'tool-call',
            call: {
              id: 'call_read_mention',
              name: 'Read',
              input: { file_path: 'README.md' },
            },
          }
          return
        }
        yield { type: 'text-delta', delta: 'done' }
      },
    }
    const tools: ToolRegistry = {
      definitions: () => [
        {
          name: 'Read',
          description: 'Read a file',
          inputSchema: { type: 'object' },
        },
      ],
      async prepare(call) {
        return call
      },
      async execute() {
        return { content: '# Fixture', isError: false }
      },
    }
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider,
      extensions,
      tools,
      permissions: { resolve: () => ({ behavior: 'allow' }) },
    })

    const result = await service.run('@"reviewer (agent)" inspect this')

    expect(requests[0]?.messages).toEqual([
      {
        role: 'user',
        content:
          '<system-reminder>\nThe user has expressed a desire to invoke the agent "reviewer". Please invoke the agent appropriately, passing in the required context to it.\n</system-reminder>',
      },
      {
        role: 'user',
        content:
          "<system-reminder>\nAvailable agent types for the Agent tool:\n- general-purpose: General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks.\n- reviewer: Review work.\n- statusline-setup: Configure the user's Claude Code status line setting.\n</system-reminder>",
      },
      { role: 'user', content: '@"reviewer (agent)" inspect this' },
    ])
    expect(requests[1]?.messages.slice(0, 3)).toEqual(requests[0]?.messages)
    expect(requests[1]?.messages.at(-1)).toEqual({
      role: 'tool',
      toolCallId: 'call_read_mention',
      content: '# Fixture',
      isError: false,
    })
    const { resolveClaudePaths } =
      await import('../compatibility/claude/paths.js')
    const transcript = await readFile(
      resolveClaudePaths({
        configDir: configRoot,
        cwd,
        sessionId: result.sessionId,
      }).sessionFile,
      'utf8',
    )
    expect(transcript).toContain('@\\"reviewer (agent)\\" inspect this')
    expect(transcript).not.toContain('expressed a desire to invoke')
    expect(transcript).not.toContain('Available agent types')
  })

  it('routes MCP prompt rich content and user attachments through the expanded message', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-runtime-mcp-prompt-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const requests: ModelRequest[] = []
    let promptToolResultDirectory: string | undefined
    const extensions = new ClaudeExtensionCatalog({
      agents: [],
      commands: [],
      skills: [],
    })
    extensions.setMcpPrompts([
      {
        name: 'mcp__fixture__probe',
        userFacingName: 'fixture:probe (MCP)',
        description: '',
        argumentNames: [],
        invoke: async (_argumentsText, options) => {
          promptToolResultDirectory = options?.toolResultDirectory
          return {
            text: 'MCP_TEXT',
            contentBlocks: [
              { type: 'text', text: 'MCP_TEXT' },
              { type: 'image', mediaType: 'image/png', data: 'bWNw' },
            ],
            images: [{ type: 'image', mediaType: 'image/png', data: 'bWNw' }],
          }
        },
      },
    ])
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      extensions,
      provider: {
        capabilities: {
          streaming: true,
          usage: true,
          tools: false,
          images: true,
          documents: true,
        },
        async *complete(request) {
          requests.push(request)
          yield { type: 'text-delta', delta: 'done' }
        },
      },
    })

    const result = await service.run(
      '/fixture:probe (MCP)',
      undefined,
      undefined,
      undefined,
      [{ type: 'image', mediaType: 'image/jpeg', data: 'dXNlcg==' }],
    )
    expect(requests[0]?.messages).toEqual([
      {
        role: 'user',
        content:
          '<command-message>mcp__fixture__probe</command-message>\n<command-name>/mcp__fixture__probe</command-name>',
      },
      {
        role: 'user',
        content: 'MCP_TEXT',
        images: [
          { type: 'image', mediaType: 'image/jpeg', data: 'dXNlcg==' },
          { type: 'image', mediaType: 'image/png', data: 'bWNw' },
        ],
      },
    ])
    const paths = resolveClaudePaths({
      configDir: configRoot,
      cwd,
      sessionId: result.sessionId,
    })
    expect(promptToolResultDirectory).toBe(
      join(paths.projectRoot, result.sessionId, 'tool-results'),
    )
    const entries = (await readFile(paths.sessionFile, 'utf8'))
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(entries[1]?.message.content).toEqual([
      { type: 'text', text: 'MCP_TEXT' },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: 'dXNlcg==' },
      },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'bWNw' },
      },
    ])
  })

  it('persists tool-provided skill context before the next model turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-runtime-skill-tool-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const requests: ModelRequest[] = []
    let turn = 0
    const service = new ClaudeSessionService({
      configRoot,
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
                id: 'call_skill',
                name: 'Skill',
                input: { skill: 'probe', args: 'alpha' },
              },
            }
            yield {
              type: 'tool-call',
              call: {
                id: 'call_read_after_skill',
                name: 'Read',
                input: { file_path: 'README.md' },
              },
            }
            return
          }
          yield { type: 'text-delta', delta: 'done' }
        },
      },
      tools: {
        definitions: () => [],
        async prepare(call) {
          return call
        },
        async execute(call) {
          if (call.name === 'Read') {
            return { content: '# Praxis', isError: false }
          }
          return {
            content: 'Launching skill: probe',
            isError: false,
            followUpUserMessages: ['Base directory: /probe\n\nSKILL'],
          }
        },
      },
      permissions: { resolve: () => ({ behavior: 'allow' }) },
    })

    const result = await service.run('Use probe')

    expect(requests[1]?.messages.slice(-3)).toEqual([
      {
        role: 'tool',
        toolCallId: 'call_skill',
        content: 'Launching skill: probe',
        isError: false,
      },
      {
        role: 'tool',
        toolCallId: 'call_read_after_skill',
        content: '# Praxis',
        isError: false,
      },
      { role: 'user', content: 'Base directory: /probe\n\nSKILL' },
    ])
    const { resolveClaudePaths } =
      await import('../compatibility/claude/paths.js')
    const paths = resolveClaudePaths({
      configDir: configRoot,
      cwd,
      sessionId: result.sessionId,
    })
    const entries = (await readFile(paths.sessionFile, 'utf8'))
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(entries.map((entry) => entry.type)).toEqual([
      'user',
      'assistant',
      'user',
      'user',
      'user',
      'assistant',
      'last-prompt',
    ])
    expect(entries[4]?.message.content).toEqual([
      { type: 'text', text: 'Base directory: /probe\n\nSKILL' },
    ])
  })

  it('activates a matching path rule after Read and preserves it across resume', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-runtime-rules-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const sourcePath = join(cwd, 'src', 'app.ts')
    const rulePath = join(cwd, '.claude', 'rules', 'typescript.md')
    const marker = 'CONDITIONAL_RULE_ACTIVE_4731'
    await Promise.all([
      mkdir(join(cwd, 'src'), { recursive: true }),
      mkdir(join(cwd, '.claude', 'rules'), { recursive: true }),
    ])
    await Promise.all([
      writeFile(sourcePath, 'export const value = 1\n'),
      writeFile(
        rulePath,
        `---\npaths:\n  - "src/**/*.ts"\n---\nUse ${marker}.\n`,
      ),
    ])

    const requests: ModelRequest[] = []
    let turn = 0
    const provider: ModelProvider = {
      model: 'fixture-model',
      capabilities: { streaming: true, usage: true, tools: true },
      async *complete(request) {
        requests.push(request)
        if (turn++ === 0) {
          yield {
            type: 'tool-call',
            call: {
              id: 'call_read_rule_path',
              name: 'Read',
              input: { file_path: 'src/app.ts' },
            },
          }
          return
        }
        yield { type: 'text-delta', delta: `answer-${turn}` }
      },
    }
    const loadResources = () => loadClaudeContextResources({ configRoot, cwd })
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider,
      tools: {
        definitions: () => [
          {
            name: 'Read',
            description: 'Read a file',
            inputSchema: { type: 'object' },
          },
        ],
        async prepare(call) {
          return call
        },
        async execute() {
          return {
            content: 'export const value = 1',
            isError: false,
            accessedPaths: [await realpath(sourcePath)],
          }
        },
      },
      permissions: { resolve: () => ({ behavior: 'allow' }) },
      contextAssembler: new ClaudeContextAssembler({ loadResources }),
      conditionalRuleResolver: new ClaudeConditionalRuleResolver({
        loadResources,
      }),
    })

    const first = await service.run('Read src/app.ts')
    await service.resume(first.sessionId, 'Continue without tools')

    expect(JSON.stringify(requests[0]?.messages)).not.toContain(marker)
    expect(JSON.stringify(requests[1]?.messages)).toContain(marker)
    expect(JSON.stringify(requests[2]?.messages)).toContain(marker)

    const { resolveClaudePaths } =
      await import('../compatibility/claude/paths.js')
    const paths = resolveClaudePaths({
      configDir: configRoot,
      cwd,
      sessionId: first.sessionId,
    })
    const entries = (await readFile(paths.sessionFile, 'utf8'))
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line))
    const attachments = entries.filter((entry) => entry.type === 'attachment')
    expect(attachments).toHaveLength(1)
    expect(attachments[0]?.attachment).toMatchObject({
      type: 'nested_memory',
      path: await realpath(rulePath),
      content: {
        content: `Use ${marker}.\n`,
        globs: ['src/**/*.ts'],
      },
    })
  })

  it('does not activate path rules from non-Read tool metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-runtime-rule-gate-'))
    roots.push(root)
    let turn = 0
    const service = new ClaudeSessionService({
      configRoot: join(root, 'config'),
      cwd: join(root, 'project'),
      claudeVersion: '2.1.208',
      provider: {
        capabilities: { streaming: true, usage: true, tools: true },
        async *complete() {
          if (turn++ === 0) {
            yield {
              type: 'tool-call',
              call: {
                id: 'call_grep_metadata',
                name: 'Grep',
                input: { pattern: 'value' },
              },
            }
            return
          }
          yield { type: 'text-delta', delta: 'done' }
        },
      },
      tools: {
        definitions: () => [],
        async prepare(call) {
          return call
        },
        async execute() {
          return {
            content: 'src/app.ts:1:value',
            isError: false,
            accessedPaths: [join(root, 'project', 'src', 'app.ts')],
          }
        },
      },
      permissions: { resolve: () => ({ behavior: 'allow' }) },
      conditionalRuleResolver: {
        async resolve() {
          throw new Error('non-Read tool attempted rule activation')
        },
      },
    })

    await expect(service.run('Search for value')).resolves.toMatchObject({
      text: 'done',
    })
  })

  it('fails closed for unsupported Claude write versions', async () => {
    const { configRoot, cwd, service: writable } = await createService()
    const existing = await writable.run('read this')
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '9.0.0',
      provider: queuedProvider(['unused']),
    })

    await expect(service.run('hello')).rejects.toThrow('read-only')
    await expect(service.inspect(existing.sessionId)).resolves.toMatchObject({
      status: 'read-only',
      writeMode: 'read-only',
      lastPrompt: 'read this',
    })
    expect((await service.export(existing.sessionId)).toString()).toContain(
      'read this',
    )
  })

  it('keeps a completed user entry when the provider fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-runtime-test-'))
    roots.push(root)
    const service = new ClaudeSessionService({
      configRoot: join(root, 'config'),
      cwd: join(root, 'project'),
      claudeVersion: '2.1.208',
      provider: {
        capabilities: { streaming: true, usage: true, tools: false },
        async *complete() {
          yield* []
          throw new ModelProviderError('temporary failure', {
            retryable: true,
          })
        },
      },
    })

    await expect(service.run('durable prompt')).rejects.toThrow(
      'temporary failure',
    )
    await expect(service.sessions()).resolves.toEqual([
      expect.objectContaining({ lastPrompt: null }),
    ])
  })

  it('holds one session lease for the complete model turn', async () => {
    const { configRoot, cwd, service } = await createService()
    const origin = await service.run('origin')
    let announceStarted: (() => void) | undefined
    let releaseProvider: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      announceStarted = resolve
    })
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve
    })
    const firstWriter = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: {
        capabilities: { streaming: true, usage: true, tools: false },
        async *complete() {
          announceStarted?.()
          await providerGate
          yield { type: 'text-delta', delta: 'finished' }
        },
      },
    })
    const competingWriter = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: queuedProvider(['must not run']),
    })

    const activeTurn = firstWriter.resume(origin.sessionId, 'first writer')
    await started
    await expect(
      competingWriter.resume(origin.sessionId, 'second writer'),
    ).rejects.toThrow('conflict: locked')
    releaseProvider?.()
    await expect(activeTurn).resolves.toMatchObject({ text: 'finished' })
  })

  it('persists a complete native tool round trip before the final answer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-runtime-tools-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const requests: ModelRequest[] = []
    let turn = 0
    const provider: ModelProvider = {
      model: 'fixture-model',
      capabilities: { streaming: true, usage: true, tools: true },
      async *complete(request) {
        requests.push(request)
        if (turn++ === 0) {
          yield {
            type: 'thinking-start',
            block: { type: 'thinking', thinking: '' },
          }
          yield { type: 'thinking-delta', delta: 'inspect first' }
          yield { type: 'thinking-signature-delta', delta: 'signed' }
          yield {
            type: 'thinking-stop',
            block: {
              type: 'thinking',
              thinking: 'inspect first',
              signature: 'signed',
            },
          }
          yield {
            type: 'tool-call',
            call: {
              id: 'call_read',
              name: 'Read',
              input: { file_path: 'README.md' },
            },
          }
          return
        }
        yield { type: 'text-delta', delta: 'The project is Praxis.' }
      },
    }
    const tools: ToolRegistry = {
      definitions: () => [
        {
          name: 'Read',
          description: 'Read a file',
          inputSchema: { type: 'object' },
        },
      ],
      async prepare(call) {
        return call
      },
      async execute() {
        return { content: '# Praxis', isError: false }
      },
    }
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider,
      tools,
      permissions: { resolve: () => ({ behavior: 'allow' }) },
    })

    const result = await service.run('What is this project?')

    expect(result.text).toBe('The project is Praxis.')
    expect(requests[1]?.messages.at(-1)).toEqual({
      role: 'tool',
      toolCallId: 'call_read',
      content: '# Praxis',
      isError: false,
    })
    expect(requests[1]?.messages.at(-2)).toEqual({
      role: 'assistant',
      content: '',
      thinkingBlocks: [
        {
          type: 'thinking',
          thinking: 'inspect first',
          signature: 'signed',
        },
      ],
      toolCalls: [
        {
          id: 'call_read',
          name: 'Read',
          input: { file_path: 'README.md' },
        },
      ],
    })
    const { resolveClaudePaths } =
      await import('../compatibility/claude/paths.js')
    const paths = resolveClaudePaths({
      configDir: configRoot,
      cwd,
      sessionId: result.sessionId,
    })
    const entries = (await readFile(paths.sessionFile, 'utf8'))
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(entries.map((entry) => entry.type)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
      'last-prompt',
    ])
    expect(entries[1]?.message.content).toEqual([
      {
        type: 'thinking',
        thinking: 'inspect first',
        signature: 'signed',
      },
      {
        type: 'tool_use',
        id: 'call_read',
        name: 'Read',
        input: { file_path: 'README.md' },
      },
    ])
    expect(entries[2]?.message.content).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'call_read',
        content: '# Praxis',
        is_error: false,
      },
    ])
    expect(entries[2]?.sourceToolAssistantUUID).toBe(entries[1]?.uuid)
    expect(entries[4]?.leafUuid).toBe(entries[3]?.uuid)
  })

  it('executes lifecycle and tool hooks with resumable native context', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-runtime-hooks-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const requests: ModelRequest[] = []
    const secret = 'persisted-hook-secret-canary'
    const secretVariable = 'PRAXIS_TEST_API_KEY'
    const previousSecret = process.env[secretVariable]
    process.env[secretVariable] = secret
    let providerTurn = 0
    const provider: ModelProvider = {
      model: 'fixture-model',
      capabilities: { streaming: true, usage: true, tools: true },
      async *complete(request) {
        requests.push(request)
        if (providerTurn++ === 0) {
          yield {
            type: 'tool-call',
            call: {
              id: 'call_hook',
              name: 'Bash',
              input: { command: 'printf original' },
            },
          }
          return
        }
        yield {
          type: 'text-delta',
          delta: providerTurn === 2 ? 'first answer' : 'revised answer',
        }
      },
    }
    let stopCalls = 0
    const hookEvents: string[] = []
    const hooks = new ClaudeHookRunner({
      cwd,
      settings: [
        {
          path: join(configRoot, 'settings.json'),
          scope: 'user',
          value: {
            hooks: Object.fromEntries(
              [
                'SessionStart',
                'UserPromptSubmit',
                'PreToolUse',
                'PostToolUse',
                'Stop',
                'SessionEnd',
              ].map((event) => [
                event,
                [
                  {
                    ...(event.includes('Tool') ? { matcher: 'Bash' } : {}),
                    hooks: [{ type: 'command', command: event }],
                  },
                ],
              ]),
            ),
          },
        },
      ],
      executeCommand: async (_command, input) => {
        hookEvents.push(input.hook_event_name)
        if (input.hook_event_name === 'SessionStart') {
          return {
            stdout: 'SESSION_HOOK_CONTEXT\n',
            stderr: '',
            exitCode: 0,
            durationMs: 1,
          }
        }
        if (input.hook_event_name === 'UserPromptSubmit') {
          return {
            stdout: 'PROMPT_HOOK_CONTEXT\n',
            stderr: '',
            exitCode: 0,
            durationMs: 1,
          }
        }
        if (input.hook_event_name === 'PreToolUse') {
          return {
            stdout: JSON.stringify({
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                updatedInput: { command: 'printf updated' },
                permissionDecision: 'allow',
                additionalContext: `PRE_HOOK_CONTEXT ${secret}`,
              },
            }),
            stderr: `diagnostic ${secret}`,
            exitCode: 0,
            durationMs: 1,
          }
        }
        if (input.hook_event_name === 'PostToolUse') {
          return {
            stdout: JSON.stringify({
              hookSpecificOutput: {
                hookEventName: 'PostToolUse',
                additionalContext: 'POST_HOOK_CONTEXT',
              },
            }),
            stderr: '',
            exitCode: 0,
            durationMs: 1,
          }
        }
        if (input.hook_event_name === 'SessionEnd') {
          return {
            stdout: 'SESSION_END_UNPERSISTED\n',
            stderr: '',
            exitCode: 0,
            durationMs: 1,
          }
        }
        stopCalls += 1
        return stopCalls === 1
          ? {
              stdout: '',
              stderr: 'REVISE_RESPONSE',
              exitCode: 2,
              durationMs: 1,
            }
          : { stdout: '', stderr: '', exitCode: 0, durationMs: 1 }
      },
    })
    const tools: ToolRegistry = {
      definitions: () => [
        {
          name: 'Bash',
          description: 'Run a command',
          inputSchema: { type: 'object' },
        },
      ],
      async prepare(call) {
        return call
      },
      async execute(call) {
        return {
          content: `ran:${String(call.input.command)}`,
          isError: false,
        }
      },
    }
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider,
      tools,
      permissions: { resolve: () => ({ behavior: 'ask' }) },
      hooks,
    })

    const result = await service.run('run hook fixture').finally(() => {
      if (previousSecret === undefined) delete process.env[secretVariable]
      else process.env[secretVariable] = previousSecret
    })
    expect(result.text).toBe('revised answer')
    expect(hookEvents).toEqual([
      'SessionStart',
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'Stop',
      'Stop',
      'SessionEnd',
    ])
    expect(requests).toHaveLength(3)
    expect(JSON.stringify(requests[0]?.messages)).toContain(
      'SESSION_HOOK_CONTEXT',
    )
    expect(JSON.stringify(requests[0]?.messages)).toContain(
      'PROMPT_HOOK_CONTEXT',
    )
    expect(JSON.stringify(requests[1]?.messages)).toContain(
      'PRE_HOOK_CONTEXT [REDACTED]',
    )
    expect(JSON.stringify(requests[1]?.messages)).toContain('POST_HOOK_CONTEXT')
    expect(JSON.stringify(requests[1]?.messages)).toContain(
      'ran:printf updated',
    )
    expect(requests[2]?.messages.at(-1)).toEqual({
      role: 'user',
      content: 'Stop hook error: REVISE_RESPONSE',
    })

    const { resolveClaudePaths } =
      await import('../compatibility/claude/paths.js')
    const paths = resolveClaudePaths({
      configDir: configRoot,
      cwd,
      sessionId: result.sessionId,
    })
    const entries = (await readFile(paths.sessionFile, 'utf8'))
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(
      entries
        .filter((entry) => entry.type === 'attachment')
        .map((entry) => entry.attachment.type),
    ).toEqual([
      'hook_success',
      'hook_success',
      'hook_success',
      'hook_additional_context',
      'hook_success',
      'hook_additional_context',
      'hook_error',
    ])
    expect(entries.at(-1)).toMatchObject({
      type: 'last-prompt',
      leafUuid: expect.any(String),
    })
    expect(JSON.stringify(entries)).not.toContain('SESSION_END_UNPERSISTED')
    expect(JSON.stringify(entries)).not.toContain(secret)
    expect(
      entries.find(
        (entry) =>
          entry.type === 'assistant' &&
          entry.message?.content?.some?.(
            (block: { text?: string }) => block.text === 'revised answer',
          ),
      )?.uuid,
    ).toBe(entries.at(-1)?.leafUuid)
  })

  it('reports SessionEnd failure without replacing a completed result', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-session-end-failure-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const runtimeEvents: RuntimeEvent[] = []
    const hooks = new ClaudeHookRunner({
      cwd,
      settings: [
        {
          path: join(configRoot, 'settings.json'),
          scope: 'user',
          value: {
            hooks: {
              SessionEnd: [
                {
                  hooks: [
                    { type: 'command', command: 'session-end-failure' },
                    { type: 'command', command: 'session-end-block' },
                  ],
                },
              ],
            },
          },
        },
      ],
      executeCommand: async (command) =>
        command === 'session-end-failure'
          ? {
              stdout: '',
              stderr: 'session end fixture failed',
              exitCode: 1,
              durationMs: 1,
            }
          : {
              stdout: JSON.stringify({
                continue: false,
                stopReason: 'session end fixture blocked',
              }),
              stderr: '',
              exitCode: 0,
              durationMs: 1,
            },
    })
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: queuedProvider(['completed answer']),
      hooks,
      eventSink: (event) => runtimeEvents.push(event),
    })

    await expect(service.run('finish')).resolves.toMatchObject({
      text: 'completed answer',
    })
    expect(runtimeEvents.slice(-2)).toEqual([
      {
        type: 'warning',
        message: 'SessionEnd hook failed: session end fixture failed',
      },
      {
        type: 'warning',
        message: 'SessionEnd hook failed: session end fixture blocked',
      },
    ])
  })

  it('recovers an interrupted tool call before resuming the model', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-runtime-recovery-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const controller = new AbortController()
    const runtimeEvents: RuntimeEvent[] = []
    const sessionEndSignals: (AbortSignal | undefined)[] = []
    const hooks = new ClaudeHookRunner({
      cwd,
      settings: [
        {
          path: join(configRoot, 'settings.json'),
          scope: 'user',
          value: {
            hooks: {
              SessionEnd: [
                { hooks: [{ type: 'command', command: 'session-end' }] },
              ],
            },
          },
        },
      ],
      executeCommand: async (_command, _input, _timeout, signal) => {
        sessionEndSignals.push(signal)
        throw new Error('session end fixture failed')
      },
    })
    const tools: ToolRegistry = {
      definitions: () => [
        {
          name: 'Bash',
          description: 'Run a command',
          inputSchema: { type: 'object' },
        },
      ],
      async prepare(call) {
        return call
      },
      async execute() {
        controller.abort()
        throw new DOMException('cancelled', 'AbortError')
      },
    }
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
              id: 'call_interrupted',
              name: 'Bash',
              input: { command: 'sleep 10' },
            },
          }
        },
      },
      tools,
      permissions: { resolve: () => ({ behavior: 'allow' }) },
      hooks,
      eventSink: (event) => runtimeEvents.push(event),
    })

    await expect(
      interrupted.run('run it', controller.signal),
    ).rejects.toBeInstanceOf(AgentRunCancelledError)
    expect(sessionEndSignals).toEqual([undefined])
    expect(runtimeEvents.at(-1)).toEqual({
      type: 'warning',
      message: 'SessionEnd hook failed: session end fixture failed',
    })
    const [summary] = await interrupted.sessions()
    if (!summary) throw new Error('Interrupted session was not persisted')
    const recoveryTools: ToolRegistry = {
      ...tools,
      async prepare(call) {
        return {
          ...call,
          input: { command: `prepared:${String(call.input.command)}` },
        }
      },
      async execute(call) {
        expect(call.input.command).toBe('prepared:hook recovery command')
        return {
          content: 'recovered output',
          isError: false,
          usage: {
            inputTokens: 11,
            outputTokens: 7,
            cacheReadInputTokens: 5,
            cacheCreationInputTokens: 3,
          },
          modelUsage: {
            'recovery-model': {
              inputTokens: 11,
              outputTokens: 7,
              cacheReadInputTokens: 5,
              cacheCreationInputTokens: 3,
            },
          },
          linesAdded: 4,
          linesRemoved: 2,
        }
      },
    }
    const recoveryHookEvents: string[] = []
    const recoveryHooks = new ClaudeHookRunner({
      cwd,
      settings: [
        {
          path: join(configRoot, 'recovery-settings.json'),
          scope: 'user',
          value: {
            hooks: {
              SessionStart: [
                { hooks: [{ type: 'command', command: 'session-start' }] },
              ],
              PreToolUse: [
                {
                  matcher: 'Bash',
                  hooks: [{ type: 'command', command: 'pre-tool-use' }],
                },
              ],
            },
          },
        },
      ],
      executeCommand: async (_command, input) => {
        recoveryHookEvents.push(input.hook_event_name)
        return input.hook_event_name === 'PreToolUse'
          ? {
              stdout: JSON.stringify({
                hookSpecificOutput: {
                  hookEventName: 'PreToolUse',
                  updatedInput: { command: 'hook recovery command' },
                  additionalContext: 'RECOVERY_PRE_HOOK_CONTEXT',
                },
              }),
              stderr: '',
              exitCode: 0,
              durationMs: 1,
            }
          : {
              stdout: 'RECOVERY_SESSION_HOOK_CONTEXT\n',
              stderr: '',
              exitCode: 0,
              durationMs: 1,
            }
      },
    })
    const { resolveClaudePaths } =
      await import('../compatibility/claude/paths.js')
    const paths = resolveClaudePaths({
      configDir: configRoot,
      cwd,
      sessionId: summary.sessionId,
    })
    const beforeMissingApproval = await readFile(paths.sessionFile, 'utf8')
    const requiresApproval = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: queuedProvider(['must not run']),
      tools: recoveryTools,
      permissions: { resolve: () => ({ behavior: 'allow' }) },
      hooks: recoveryHooks,
    })
    await expect(
      requiresApproval.resume(summary.sessionId, 'continue'),
    ).rejects.toThrow('requires explicit recovery approval')
    expect(await readFile(paths.sessionFile, 'utf8')).toBe(
      beforeMissingApproval,
    )
    const beforeDecline = await readFile(paths.sessionFile, 'utf8')
    const declined = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: queuedProvider(['must not run']),
      tools: recoveryTools,
      permissions: { resolve: () => ({ behavior: 'allow' }) },
      hooks: recoveryHooks,
      approveRecovery: () => false,
    })
    await expect(
      declined.resume(summary.sessionId, 'continue'),
    ).rejects.toThrow('recovery was declined')
    expect(await readFile(paths.sessionFile, 'utf8')).toBe(beforeDecline)
    const recoveryController = new AbortController()
    const cancelled = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: queuedProvider(['must not run']),
      tools: recoveryTools,
      permissions: { resolve: () => ({ behavior: 'allow' }) },
      hooks: recoveryHooks,
      approveRecovery: () => {
        recoveryController.abort()
        return true
      },
    })
    await expect(
      cancelled.resume(
        summary.sessionId,
        'continue',
        recoveryController.signal,
      ),
    ).rejects.toBeInstanceOf(AgentRunCancelledError)
    expect(await readFile(paths.sessionFile, 'utf8')).toBe(beforeDecline)
    let recoveryApprovals = 0
    const resumed = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: {
        model: 'main-model',
        ...queuedProvider(['must not run']),
      },
      tools: recoveryTools,
      permissions: { resolve: () => ({ behavior: 'ask' }) },
      hooks: recoveryHooks,
      pricing: new ModelPricingRegistry({
        'recovery-model': {
          inputPerMillionUsd: 2,
          outputPerMillionUsd: 4,
          cacheReadInputPerMillionUsd: 1,
          cacheCreationInputPerMillionUsd: 3,
        },
        'main-model': {
          inputPerMillionUsd: 2,
          outputPerMillionUsd: 4,
        },
      }),
      costStateStore: { load: async () => null, save: async () => undefined },
      approveRecovery: (call) => {
        recoveryApprovals += 1
        expect(call.input.command).toBe('prepared:hook recovery command')
        return true
      },
    })

    const resumedResult = await resumed.resume(summary.sessionId, 'continue')
    expect(resumedResult.text).toBe('must not run')
    expect(resumedResult.usage).toEqual({
      inputTokens: 14,
      outputTokens: 9,
      cacheReadInputTokens: 5,
      cacheCreationInputTokens: 3,
    })
    expect(resumedResult.costUsd).toBe(0.000062)
    expect(resumedResult.modelUsage).toEqual({
      'recovery-model': {
        inputTokens: 11,
        outputTokens: 7,
        cacheReadInputTokens: 5,
        cacheCreationInputTokens: 3,
      },
      'main-model': { inputTokens: 3, outputTokens: 2 },
    })
    const costSnapshot = await resumed.costSnapshot(summary.sessionId)
    expect(costSnapshot).toMatchObject({
      totalCostUsd: 0.000062,
      linesAdded: 4,
      linesRemoved: 2,
      modelUsage: {
        'recovery-model': {
          inputTokens: 11,
          outputTokens: 7,
          cacheReadInputTokens: 5,
          cacheCreationInputTokens: 3,
          webSearchRequests: 0,
          costUsd: 0.000048,
        },
        'main-model': {
          inputTokens: 3,
          outputTokens: 2,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          webSearchRequests: 0,
          costUsd: 0.000014,
        },
      },
    })
    expect(Object.keys(costSnapshot.modelUsage)).toEqual([
      'recovery-model',
      'main-model',
    ])
    expect(recoveryApprovals).toBe(1)
    expect(recoveryHookEvents).toEqual([
      'SessionStart',
      'SessionStart',
      'PreToolUse',
      'SessionStart',
      'PreToolUse',
      'SessionStart',
      'PreToolUse',
    ])
    const entries = (await readFile(paths.sessionFile, 'utf8'))
      .trimEnd()
      .split('\n')
      .map((entry) => JSON.parse(entry))
    const recoveryEntries = entries.slice(
      beforeDecline.trimEnd().split('\n').length,
    )
    expect(
      recoveryEntries
        .filter((entry) => entry.type === 'attachment')
        .map((entry) => entry.attachment.hookEvent),
    ).toEqual(['SessionStart', 'PreToolUse', 'PreToolUse'])
    expect(recoveryEntries[3]?.message.content).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'call_interrupted',
        content: 'recovered output',
        is_error: false,
      },
    ])
  })

  it('meters recovered tool execution duration while denied recovery contributes none', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-recovery-duration-'))
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
            call: { id: 'call_interrupted', name: 'Bash', input: {} },
          }
        },
      },
      tools: {
        definitions: () => [],
        prepare: async (call) => call,
        async execute() {
          controller.abort()
          throw new DOMException('cancelled', 'AbortError')
        },
      },
      permissions: { resolve: () => ({ behavior: 'allow' }) },
    })
    await expect(
      interrupted.run('run', controller.signal),
    ).rejects.toBeInstanceOf(AgentRunCancelledError)
    const [summary] = await interrupted.sessions()
    if (!summary) throw new Error('Interrupted session was not persisted')

    const denied = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: queuedProvider(['must not run']),
      tools: {
        definitions: () => [],
        prepare: async (call) => call,
        execute: async () => ({ content: 'unexpected', isError: false }),
      },
      permissions: { resolve: () => ({ behavior: 'allow' }) },
      approveRecovery: () => false,
    })
    await expect(denied.resume(summary.sessionId, 'continue')).rejects.toThrow(
      'recovery was declined',
    )

    const now = vi
      .spyOn(performance, 'now')
      .mockReturnValueOnce(0) // completeToolCall startedAt
      .mockReturnValueOnce(100) // execute start
      .mockReturnValueOnce(300) // execute end
      .mockReturnValue(0)
    try {
      const resumed = new ClaudeSessionService({
        configRoot,
        cwd,
        claudeVersion: '2.1.208',
        provider: queuedProvider(['final']),
        tools: {
          definitions: () => [],
          prepare: async (call) => call,
          execute: async () => ({ content: 'recovered', isError: false }),
        },
        permissions: { resolve: () => ({ behavior: 'allow' }) },
        approveRecovery: () => true,
      })
      const result = await resumed.resume(summary.sessionId, 'continue')
      expect(result.text).toBe('final')
      const snapshot = await resumed.costSnapshot(summary.sessionId)
      expect(snapshot.toolDurationMs).toBe(200)
    } finally {
      now.mockRestore()
    }
  })

  it('confirms missed scheduled one-shots before returning them and honors approval or decline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-scheduled-confirm-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    await mkdir(join(cwd, '.claude'), { recursive: true })
    await writeFile(
      join(cwd, '.claude', 'scheduled_tasks.json'),
      JSON.stringify({
        tasks: [
          {
            id: 'abc12345',
            cron: '1 0 1 1 *',
            prompt: 'missed approval prompt',
            createdAt: new Date(2020, 11, 31, 23, 59).getTime(),
            recurring: false,
            createdBySessionId: '20202020-2020-4020-8020-202020202020',
            createdByPid: 999_999_999,
            createdByProcStart: 'start',
          },
          {
            id: 'def12345',
            cron: '2 0 1 1 *',
            prompt: 'missed decline prompt',
            createdAt: new Date(2020, 11, 31, 23, 59).getTime(),
            recurring: false,
            createdBySessionId: '20202020-2020-4020-8020-202020202020',
            createdByPid: 999_999_999,
            createdByProcStart: 'start',
          },
        ],
      }),
    )

    const asked: string[] = []
    let resolveApproval!: (result: ClaudeQuestionResult | null) => void
    const askUser = async (
      questions: readonly ClaudeQuestion[],
    ): Promise<ClaudeQuestionResult | null> => {
      const question = questions[0]
      if (!question) return null
      asked.push(question.question)
      if (asked.length === 1) {
        return new Promise<ClaudeQuestionResult | null>((resolve) => {
          resolveApproval = resolve
        })
      }
      return { answers: { [question.question]: 'Skip' } }
    }

    const interactiveTools = new ClaudeInteractiveToolManager({
      configRoot,
      initialMode: 'default',
      enabledTools: ['AskUserQuestion'],
      callbacks: {
        askUser,
        approvePlan: async () => ({
          behavior: 'allow',
          permissionMode: 'default',
        }),
      },
      permissionResolverForMode: () => ({
        resolve: () => ({ behavior: 'allow' }),
      }),
    })

    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: queuedProvider(['unused']),
      tools: new LocalToolRegistry({ cwd }),
      permissions: { resolve: () => ({ behavior: 'allow' }) },
      scheduledToolNames: ['CronCreate'],
      interactiveTools,
    })

    try {
      // A pending missed one-shot is presented for confirmation and is not
      // returned before the user approves it.
      const first = service.nextScheduledPrompt()
      await vi.waitFor(() => expect(asked).toHaveLength(1))
      expect(asked[0]).toBe('missed approval prompt')
      let firstSettled: 'pending' | 'resolved' | 'rejected' = 'pending'
      void first.then(
        () => {
          firstSettled = 'resolved'
        },
        () => {
          firstSettled = 'rejected'
        },
      )
      expect(firstSettled).toBe('pending')
      resolveApproval({
        answers: { 'missed approval prompt': 'Run now' },
      })
      await expect(first).resolves.toEqual({
        id: 'abc12345',
        prompt: 'missed approval prompt',
      })

      // The next pending missed one-shot is declined and returns no prompt.
      const second = service.nextScheduledPrompt()
      await vi.waitFor(() => expect(asked).toHaveLength(2))
      expect(asked[1]).toBe('missed decline prompt')
      await expect(second).resolves.toBeNull()

      // Nothing remains pending after approval/decline are resolved.
      const aborted = new AbortController()
      aborted.abort()
      await expect(
        service.nextScheduledPrompt(aborted.signal),
      ).resolves.toBeNull()
      expect(asked).toHaveLength(2)
    } finally {
      await service.close()
    }
  })
})
