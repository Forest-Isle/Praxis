import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type {
  ModelProvider,
  ModelRequest,
  RuntimeEvent,
  ToolRegistry,
} from '../core/runtime.js'
import { ContextBudget } from '../core/context-budget.js'
import { AgentRunCancelledError, ModelProviderError } from '../core/runtime.js'
import {
  ClaudeConditionalRuleResolver,
  ClaudeContextAssembler,
} from '../compatibility/claude/context.js'
import { loadClaudeContextResources } from '../compatibility/claude/shared-resources.js'
import { ClaudeExtensionCatalog } from '../extensions/claude-extensions.js'
import { ClaudeHookRunner } from '../hooks/claude-hooks.js'
import { ClaudeSessionService } from './session-service.js'

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

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  )
})

describe('ClaudeSessionService', () => {
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
            usage: { inputTokens: 50, outputTokens: 5 },
          }
          return
        }
        yield { type: 'text-delta', delta: 'final answer' }
        yield {
          type: 'usage',
          usage: { inputTokens: 20, outputTokens: 3 },
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
    })

    const result = await service.resume(first.sessionId, 'Continue the task.')

    expect(result).toMatchObject({
      text: 'final answer',
      usage: { inputTokens: 70, outputTokens: 8 },
    })
    expect(requests).toHaveLength(2)
    expect(JSON.stringify(requests[0]?.messages)).toContain('old-context')
    expect(JSON.stringify(requests[1]?.messages)).toContain(
      'COMPACTED_CURRENT_TASK',
    )
    expect(JSON.stringify(requests[1]?.messages)).not.toContain('old-context')
    expect(events).toContainEqual({ type: 'state', state: 'compacting' })

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
  })

  it('compacts a large completed tool result before the next model turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-runtime-tool-compact-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const requests: ModelRequest[] = []
    let mainTurns = 0
    const provider: ModelProvider = {
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
  })

  it('assembles fresh system context for run and resume without persisting it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-runtime-context-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const requests: ModelRequest[] = []
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
        async assemble() {
          contextVersion += 1
          return [
            {
              role: 'system',
              content: `SYSTEM_CONTEXT_${contextVersion}`,
            },
          ]
        },
      },
    })

    const first = await service.run('first prompt')
    await service.resume(first.sessionId, 'second prompt')

    expect(requests[0]?.messages[0]).toEqual({
      role: 'system',
      content: 'SYSTEM_CONTEXT_1',
    })
    expect(requests[1]?.messages[0]).toEqual({
      role: 'system',
      content: 'SYSTEM_CONTEXT_2',
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
        content: '# Agent definition: reviewer\n\nAGENT_MARKER',
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
      content: '# Agent definition: reviewer\n\nAGENT_MARKER',
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
    const { configRoot, cwd } = await createService()
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '9.0.0',
      provider: queuedProvider(['unused']),
    })

    await expect(service.run('hello')).rejects.toThrow('read-only')
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
                additionalContext: 'PRE_HOOK_CONTEXT',
              },
            }),
            stderr: '',
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

    const result = await service.run('run hook fixture')
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
    expect(JSON.stringify(requests[1]?.messages)).toContain('PRE_HOOK_CONTEXT')
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
        return { content: 'recovered output', isError: false }
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
      provider: queuedProvider(['must not run']),
      tools: recoveryTools,
      permissions: { resolve: () => ({ behavior: 'ask' }) },
      hooks: recoveryHooks,
      approveRecovery: (call) => {
        recoveryApprovals += 1
        expect(call.input.command).toBe('prepared:hook recovery command')
        return true
      },
    })

    await expect(
      resumed.resume(summary.sessionId, 'continue'),
    ).resolves.toMatchObject({ text: 'must not run' })
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
})
