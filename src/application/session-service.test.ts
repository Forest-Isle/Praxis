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
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  ModelMessage,
  ModelProvider,
  ModelRequest,
  ModelToolCall,
  RuntimeEvent,
  ToolRegistry,
} from '../core/runtime.js'
import { ContextBudget } from '../core/context-budget.js'
import type {
  ContextAssemblyOptions,
  ContextSnapshot,
} from '../core/context.js'
import { assembleContextSnapshot } from '../core/prompt-composer.js'
import { AgentRunCancelledError, ModelProviderError } from '../core/runtime.js'
import { ModelPricingRegistry } from '../core/usage.js'
import {
  ClaudeConditionalRuleResolver,
  ClaudeContextAssembler,
} from '../native/context.js'
import { resolveNativePaths } from '../native/paths.js'
import { resolveDataPlanePaths } from '../persistence/data-plane.js'
import { SubagentLifecycleStore } from '../persistence/subagent-lifecycle-store.js'
import { loadNativeContextResources } from '../persistence/native-resources.js'
import { ClaudeExtensionCatalog } from '../extensions/claude-extensions.js'
import {
  ClaudeHookRunner,
  type ClaudeHookInput,
} from '../hooks/claude-hooks.js'
import { ClaudeInteractiveToolManager } from '../tools/claude-interactive-tools.js'
import { LocalToolRegistry } from '../tools/local-tools.js'
import { CLAUDE_CODE_DISABLE_CRON } from '../tools/claude-capabilities.js'
import { CLAUDE_INTERRUPTED_TURN_CONTINUATION } from '../native/interruption.js'
import type { ClaudeSessionCostState } from '../persistence/claude-cost-state-store.js'
import {
  ClaudeSessionService,
  memoryPreservedSuffixStart,
} from './session-service.js'
import {
  SessionMemoryStore,
  type SessionMemoryState,
} from './session-memory.js'
import {
  ProjectMemoryExtractionController,
  type ProjectMemoryExtractorInput,
} from './project-memory.js'
import { WorkspaceContext } from './session-worktree.js'
import type { TeamLeadOperations } from './team-lead-operations.js'

const roots: string[] = []

function nativeTranscriptLine(
  event: Readonly<Record<string, unknown>>,
  version: string | number = 1,
): string {
  return `${JSON.stringify({ schema: 'praxis.transcript', version, event })}\n`
}

function nativeMessageEvent(options: {
  sessionId: string
  id: string
  parentId: string | null
  role: 'user' | 'assistant'
  content: string
  timestamp?: string
}): Record<string, unknown> {
  return {
    kind: 'messages',
    id: options.id,
    parentId: options.parentId,
    sessionId: options.sessionId,
    timestamp: options.timestamp ?? '2026-08-23T00:00:00.000Z',
    messages: [{ role: options.role, content: options.content }],
  }
}

async function readNativeEvents(
  sessionFile: string,
): Promise<Array<Record<string, unknown>>> {
  const source = await readFile(sessionFile, 'utf8')
  if (!source.trim()) return []
  return source
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line).event as Record<string, unknown>)
}

function nativeSessionFile(
  configDir: string,
  cwd: string,
  sessionId: string,
): string {
  return resolveDataPlanePaths({
    dataPlane: 'native',
    root: configDir,
    cwd,
    sessionId,
  }).sessionFile
}

function nativeMessages(events: readonly Record<string, unknown>[]) {
  return events.flatMap((event) =>
    Array.isArray(event.messages) ? event.messages : [],
  ) as Array<Record<string, unknown>>
}

function contextSnapshot({
  system = [],
  firstUser,
}: {
  system?: readonly string[]
  firstUser?: string
} = {}): ContextSnapshot {
  return {
    sections: [
      ...system.map((content, index) => ({
        id: `test-system-${index}`,
        content,
        placement: 'system' as const,
        stability: 'session' as const,
      })),
      ...(firstUser === undefined
        ? []
        : [
            {
              id: 'test-first-user',
              content: firstUser,
              placement: 'first-user' as const,
              stability: 'session' as const,
            },
          ]),
    ],
  }
}

function queuedProvider(responses: string[]): ModelProvider {
  return {
    model: 'test-model',
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

it('uses the injected Team registry factory for hosted and foreground registries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-team-registry-factory-'))
  const sessionId = '11111111-1111-4111-8111-111111111111'
  const operations = {
    close: async () => undefined,
    projectInbox: async () => undefined,
  } as unknown as TeamLeadOperations
  const calls: Array<{
    base: ToolRegistry
    operations: TeamLeadOperations
    sessionId: string
    names: readonly string[]
  }> = []
  const provider = queuedProvider(['foreground response'])
  const service = new ClaudeSessionService({
    configRoot: join(root, 'config'),
    cwd: join(root, 'project'),
    claudeVersion: '2.1.208',
    provider,
    tools: new LocalToolRegistry({ cwd: join(root, 'project') }),
    teamLeadOperations: operations,
    teamToolNames: ['TeamList'],
    toolCapabilityEnvironment: { PRAXIS_ENABLE_TEAMS: 'true' },
    teamLeadToolRegistryFactory: (
      base,
      receivedOperations,
      receivedSessionId,
      names,
    ) => {
      calls.push({
        base,
        operations: receivedOperations,
        sessionId: receivedSessionId,
        names,
      })
      return base
    },
  })
  try {
    service.createHostedToolRegistry(sessionId)
    await service.run('hello', undefined, sessionId)
    expect(calls).toHaveLength(2)
    expect(calls.map(({ operations: received }) => received)).toEqual([
      operations,
      operations,
    ])
    expect(calls.map(({ sessionId: received }) => received)).toEqual([
      sessionId,
      sessionId,
    ])
    expect(calls.map(({ names }) => [...names])).toEqual([
      ['TeamList'],
      ['TeamList'],
    ])
  } finally {
    await service.close()
    await rm(root, { recursive: true, force: true })
  }
})

/** Waits on the observable sidecar commit instead of reaching into the
 * service's private controller lifecycle. */
async function waitForSessionMemoryCommit(
  configRoot: string,
  planeRoot: string,
  sessionId: string,
  predicate: (state: SessionMemoryState) => boolean = (state) =>
    state.initialized &&
    state.lastSummarizedMessageId !== null &&
    state.extractionStartedAt === null &&
    state.extractionCompletedAt !== null,
): Promise<SessionMemoryState> {
  const resolvedPlaneRoot = planeRoot === 'praxis' ? 'state' : planeRoot
  const store = new SessionMemoryStore({
    configRoot,
    sessionId,
    sidecarRoot: join(configRoot, resolvedPlaneRoot),
  })
  let state: SessionMemoryState | undefined
  await vi.waitFor(async () => {
    state = await store.load()
    expect(predicate(state), JSON.stringify(state)).toBe(true)
  })
  if (!state) throw new Error('Session memory state was not committed')
  return state
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
  vi.restoreAllMocks()
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  )
})

describe('ClaudeSessionService', () => {
  it('registers active turns before await and appends steering only on delivery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-active-steering-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const sessionId = '92929292-5555-4555-8555-929292929292'
    let releaseProvider!: () => void
    let markProviderStarted!: () => void
    const providerStarted = new Promise<void>((resolve) => {
      markProviderStarted = resolve
    })
    const providerReleased = new Promise<void>((resolve) => {
      releaseProvider = resolve
    })
    let calls = 0
    const events: RuntimeEvent[] = []
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      eventSink: (event) => events.push(event),
      provider: {
        capabilities: { streaming: true, usage: true, tools: false },
        async *complete() {
          calls += 1
          if (calls === 1) {
            markProviderStarted()
            await providerReleased
          }
          yield { type: 'text-delta', delta: calls === 1 ? 'first' : 'done' }
        },
      },
    })
    const run = service.run('prompt', undefined, sessionId)
    await providerStarted
    const accepted = service.steer(sessionId, 'steer me')
    expect(accepted.kind).toBe('accepted')
    const beforeDelivery = await readNativeEvents(
      nativeSessionFile(configRoot, cwd, sessionId),
    )
    expect(nativeMessages(beforeDelivery)).not.toContainEqual({
      role: 'user',
      content: 'steer me',
    })
    await expect(service.resume(sessionId, 'duplicate')).rejects.toThrow(
      'already has an active turn',
    )
    releaseProvider()
    await run
    expect(events).toContainEqual({
      type: 'user-input-delivered',
      id: expect.any(String),
      content: 'steer me',
    })
    const transcript = await readNativeEvents(
      nativeSessionFile(configRoot, cwd, sessionId),
    )
    expect(nativeMessages(transcript)).toContainEqual({
      role: 'user',
      content: 'steer me',
    })
    expect(service.steer(sessionId, 'after')).toEqual({
      kind: 'no-active-turn',
    })
  })

  it('reports shell turns as explicitly non-steerable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-shell-steering-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const sessionId = '92929292-6666-4666-8666-929292929292'
    let release!: () => void
    const started = new Promise<void>((resolve) => {
      release = resolve
    })
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: {
        capabilities: { streaming: true, usage: true, tools: false },
        async *complete() {
          await started
          yield { type: 'text-delta', delta: 'done' }
        },
      },
    })
    const run = service.runShell('printf hi', undefined, sessionId)
    await Promise.resolve()
    expect(service.steer(sessionId, 'not shell')).toEqual({
      kind: 'not-steerable',
    })
    release()
    await run
  })

  it('appends Team inbox follow-ups as ordinary user text before acknowledging', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-session-team-inbox-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    let delivered = false
    let acknowledged = 0
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: queuedProvider(['first', 'second']),
      teamLeadOperations: {
        async projectInbox() {
          if (delivered) return null
          delivered = true
          return {
            id: 'team-inbox',
            messages: [
              '<team-mailbox-message>worker message</team-mailbox-message>',
            ],
            acknowledge: async () => {
              acknowledged += 1
            },
          }
        },
      } as never,
    })
    const sessionId = '92929292-3333-4333-8333-929292929292'
    await service.run('prompt', undefined, sessionId)
    const paths = resolveDataPlanePaths({
      dataPlane: 'native',
      root: configRoot,
      cwd,
      sessionId,
    })
    const source = await readFile(paths.sessionFile, 'utf8')
    const events = source
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line).event as Record<string, unknown>)
    expect(events.flatMap((event) => event.messages ?? [])).toContainEqual(
      expect.objectContaining({
        role: 'user',
        content: '<team-mailbox-message>worker message</team-mailbox-message>',
      }),
    )
    expect(source).not.toContain('teamMailbox')
    expect(acknowledged).toBe(1)
  })

  it('does not acknowledge a Team inbox when transcript follow-up append fails', async () => {
    const root = await mkdtemp(
      join(tmpdir(), 'praxis-session-team-inbox-failure-'),
    )
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const sessionId = '92929292-4444-4444-8444-929292929292'
    let acknowledged = 0
    let projected = false
    const paths = resolveDataPlanePaths({
      dataPlane: 'native',
      root: configRoot,
      cwd,
      sessionId,
    })
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: queuedProvider(['first', 'second']),
      teamLeadOperations: {
        async projectInbox() {
          if (projected) return null
          projected = true
          await appendFile(paths.sessionFile, '{"corrupt":true}\n')
          return {
            id: 'team-inbox-failure',
            messages: [
              '<team-mailbox-message>unpersisted worker message</team-mailbox-message>',
            ],
            acknowledge: async () => {
              acknowledged += 1
            },
          }
        },
      } as never,
    })

    await expect(service.run('prompt', undefined, sessionId)).rejects.toThrow()
    expect(acknowledged).toBe(0)
  })

  it('validates experimental native activation before setup', () => {
    const base = {
      configRoot: '/tmp/praxis-native-activation-config',
      cwd: '/tmp/praxis-native-activation-cwd',
      claudeVersion: '2.1.208',
      dataPlane: 'native' as const,
      experimentalNativeTranscriptWrites: true,
      autoCompact: false,
    }
    const cases = [
      ['hooks', { hooks: {} as never }],
      ['conditionalRuleResolver', { conditionalRuleResolver: {} as never }],
      ['extensions', { extensions: {} as never }],
      ['agent', { agent: 'agent' }],
      ['fileCheckpointing', { fileCheckpointing: true }],
      ['fileRewindRoots', { fileRewindRoots: ['/tmp'] }],
      ['interactiveTools', { interactiveTools: {} as never }],
      ['mcp', { mcp: {} as never }],
      ['taskToolNames', { taskToolNames: ['Task'] }],
      ['scheduledToolNames', { scheduledToolNames: ['Schedule'] }],
      ['enableDynamicWakeups', { enableDynamicWakeups: true }],
      ['enableSessionMemory', { enableSessionMemory: true }],
      [
        'sessionMemoryProviderFactory',
        { sessionMemoryProviderFactory: () => ({}) as never },
      ],
      ['projectMemoryDirectory', { projectMemoryDirectory: '/tmp/memory' }],
      ['projectMemoryRecall', { projectMemoryRecall: {} as never }],
      ['projectMemoryExtraction', { projectMemoryExtraction: {} as never }],
      ['sessionKind', { sessionKind: 'bg' as const }],
      ['workspace', { workspace: {} as never }],
      ['initialWorktree', { initialWorktree: true }],
      ['initialWorktreeName', { initialWorktreeName: 'worktree' }],
      ['enableWorktrees', { enableWorktrees: true }],
      ['worktreeToolNames', { worktreeToolNames: ['EnterWorktree'] as const }],
      ['worktreeBaseRef', { worktreeBaseRef: 'head' as const }],
    ] as const
    for (const [option, extra] of cases) {
      expect(() => new ClaudeSessionService({ ...base, ...extra })).toThrow(
        new RegExp(`option ${option}`),
      )
    }
    expect(
      () =>
        new ClaudeSessionService({
          ...base,
          sessionPersistence: false,
        }),
    ).toThrow(/sessionPersistence/)
  })

  it('allows inactive and runtime-only experimental native options', async () => {
    const service = new ClaudeSessionService({
      configRoot: '/tmp/praxis-native-allowed-config',
      cwd: '/tmp/praxis-native-allowed-cwd',
      claudeVersion: '2.1.208',
      dataPlane: 'native',
      experimentalNativeTranscriptWrites: true,
      autoCompact: false,
      resumeInterruptedTurn: false,
      fileCheckpointing: false,
      fileRewindRoots: [],
      enableSubagents: false,
      subagentToolNames: [],
      taskToolNames: [],
      scheduledToolNames: [],
      enableDynamicWakeups: false,
      enableWorkflows: false,
      enableSessionMemory: false,
      initialWorktree: false,
      enableWorktrees: false,
      worktreeToolNames: [],
      provider: queuedProvider(['allowed']),
      maxModelTurns: 2,
      betas: ['runtime-beta'],
      eventSink: () => undefined,
    })

    await service.close()
  })

  it('reports healthy canonical native sessions ready only when enabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-native-status-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const sessionId = '90909090-9090-4090-8090-909090909090'
    const paths = resolveDataPlanePaths({
      dataPlane: 'native',
      root: configRoot,
      cwd,
      sessionId,
    })
    await mkdir(paths.projectRoot, { recursive: true })
    await writeFile(
      paths.sessionFile,
      nativeTranscriptLine(
        nativeMessageEvent({
          sessionId,
          id: '91919191-9191-4191-8191-919191919191',
          parentId: null,
          role: 'user',
          content: 'native status',
        }),
      ),
    )
    const disabled = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      dataPlane: 'native',
    })
    const enabled = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      dataPlane: 'native',
      experimentalNativeTranscriptWrites: true,
      autoCompact: false,
    })

    await expect(disabled.inspect(sessionId)).resolves.toMatchObject({
      status: 'ready',
      issue: null,
    })
    await expect(enabled.inspect(sessionId)).resolves.toMatchObject({
      status: 'ready',
      issue: null,
    })
    await Promise.all([disabled.close(), enabled.close()])
  })

  it('fails closed for unsupported experimental native operations', async () => {
    const service = new ClaudeSessionService({
      configRoot: '/tmp/praxis-native-activation-config',
      cwd: '/tmp/praxis-native-activation-cwd',
      claudeVersion: '2.1.208',
      dataPlane: 'native',
      experimentalNativeTranscriptWrites: true,
      autoCompact: false,
    })
    await expect(service.compact('session')).rejects.toThrow(
      'A model provider is required for run and resume',
    )
    await expect(service.fork('parent')).rejects.toThrow('Invalid session ID')
    await expect(service.ensureFork('parent', 'child')).rejects.toThrow(
      'Invalid session ID',
    )
    await expect(service.tag('session', 'tag')).rejects.toThrow(
      'Invalid session ID',
    )
  })

  it('executes native turns from canonical history without Claude metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-native-turn-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const sessionId = '92929292-9292-4292-8292-929292929292'
    const requests: ModelRequest[] = []
    const responses = [
      'native answer 1',
      'native answer 2',
      'native branch answer',
    ]
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      dataPlane: 'native',
      experimentalNativeTranscriptWrites: true,
      autoCompact: false,
      provider: {
        capabilities: { streaming: true, usage: true, tools: false },
        async *complete(request) {
          requests.push(request)
          yield { type: 'text-delta', delta: responses.shift() ?? 'missing' }
          yield {
            type: 'usage',
            usage: { inputTokens: 1, outputTokens: 1 },
          }
        },
      },
    })

    await service.run('native prompt 1', undefined, sessionId)
    await service.resume(sessionId, 'native prompt 2')

    const sessionFile = resolveDataPlanePaths({
      dataPlane: 'native',
      root: configRoot,
      cwd,
      sessionId,
    }).sessionFile
    let events = (await readFile(sessionFile, 'utf8'))
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line).event)
    expect(events.flatMap((event) => event.messages)).toEqual([
      { role: 'user', content: 'native prompt 1' },
      { role: 'assistant', content: 'native answer 1' },
      { role: 'user', content: 'native prompt 2' },
      { role: 'assistant', content: 'native answer 2' },
    ])
    expect(events.every((event) => event.type === undefined)).toBe(true)
    expect(JSON.stringify(requests[1]?.messages)).toContain('native answer 1')
    const firstAssistantId = events.find(
      (event) => event.messages?.[0]?.content === 'native answer 1',
    )?.id
    expect(firstAssistantId).toEqual(expect.any(String))

    await service.resume(
      sessionId,
      'native branch prompt',
      undefined,
      undefined,
      undefined,
      undefined,
      firstAssistantId,
    )

    const branchRequest = JSON.stringify(requests[2]?.messages)
    expect(branchRequest).toContain('native answer 1')
    expect(branchRequest).toContain('native branch prompt')
    expect(branchRequest).not.toContain('native prompt 2')
    expect(branchRequest).not.toContain('native answer 2')
    events = (await readFile(sessionFile, 'utf8'))
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line).event)
    expect(events.at(-2)?.parentId).toBe(firstAssistantId)
    expect(await readFile(sessionFile, 'utf8')).not.toContain('last-prompt')
    await expect(service.interruption(sessionId)).resolves.toEqual({
      kind: 'complete',
    })
    await service.close()
  })

  it('manually compacts the native active branch into canonical events', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-native-compact-test-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const sessionId = '93939393-9393-4393-8393-939393939393'
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      dataPlane: 'native',
      experimentalNativeTranscriptWrites: true,
      autoCompact: false,
      provider: {
        model: 'fixture-model',
        capabilities: { streaming: true, usage: true, tools: false },
        async *complete() {
          yield { type: 'text-delta', delta: 'answer' }
          yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
        },
      },
      compactor: {
        async compact() {
          return {
            summary: 'native summary',
            usage: { inputTokens: 0, outputTokens: 0 },
            durationMs: 0,
          }
        },
      },
    })
    await service.run('native prompt', undefined, sessionId)
    await expect(service.compact(sessionId)).resolves.toMatchObject({
      summary: 'native summary',
    })
    const sessionFile = resolveDataPlanePaths({
      dataPlane: 'native',
      root: configRoot,
      cwd,
      sessionId,
    }).sessionFile
    const events = (await readFile(sessionFile, 'utf8'))
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line).event)
    expect(events.slice(-2).map((event) => event.kind)).toEqual([
      'context-boundary',
      'context-summary',
    ])
    expect(events.slice(-2).every((event) => !('claudeVersion' in event))).toBe(
      true,
    )
    await service.close()
  })

  it('forks and ensures native sessions without Claude conversion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-native-fork-test-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const sourceId = 'a3939393-9393-4393-8393-939393939393'
    const targetId = 'b3939393-9393-4393-8393-939393939393'
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      dataPlane: 'native',
      experimentalNativeTranscriptWrites: true,
      autoCompact: false,
      provider: {
        capabilities: { streaming: true, usage: true, tools: false },
        async *complete() {
          yield { type: 'text-delta', delta: 'answer' }
          yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
        },
      },
    })
    await service.run('source prompt', undefined, sourceId)
    const sourceFile = resolveDataPlanePaths({
      dataPlane: 'native',
      root: configRoot,
      cwd,
      sessionId: sourceId,
    }).sessionFile
    const before = await readFile(sourceFile, 'utf8')
    await expect(service.fork(sourceId, targetId)).resolves.toEqual({
      sessionId: targetId,
      parentSessionId: sourceId,
    })
    expect(await readFile(sourceFile, 'utf8')).toBe(before)
    const targetFile = resolveDataPlanePaths({
      dataPlane: 'native',
      root: configRoot,
      cwd,
      sessionId: targetId,
    }).sessionFile
    const targetEvents = (await readFile(targetFile, 'utf8'))
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line).event)
    expect(targetEvents.every((event) => event.sessionId === targetId)).toBe(
      true,
    )
    await service.resume(targetId, 'child continuation')
    const continued = await readFile(targetFile, 'utf8')
    await expect(service.ensureFork(sourceId, targetId)).resolves.toEqual({
      sessionId: targetId,
      parentSessionId: sourceId,
    })
    expect(await readFile(targetFile, 'utf8')).toBe(continued)
    await service.close()
  })

  it('automatically compacts native history while preserving the complete current-turn suffix and metering', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-native-auto-compact-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const sessionId = '92929292-1111-4111-8111-929292929292'
    const requests: ModelRequest[] = []
    const compactInputs: ModelMessage[][] = []
    let mainTurn = 0
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      dataPlane: 'native',
      experimentalNativeTranscriptWrites: true,
      contextBudget: new ContextBudget({
        contextWindowTokens: 900,
        reserveTokens: 200,
      }),
      provider: {
        model: 'native-main-model',
        capabilities: {
          streaming: true,
          usage: true,
          tools: true,
          contextWindowTokens: 900,
        },
        async *complete(request) {
          requests.push(request)
          mainTurn += 1
          if (mainTurn === 1) {
            yield {
              type: 'text-delta',
              delta: `PRIOR_NATIVE_HISTORY ${'prior '.repeat(120)}`,
            }
          } else if (mainTurn === 2) {
            yield {
              type: 'tool-call',
              call: {
                id: 'native-large-call',
                name: 'fixture_tool',
                input: {},
              },
            }
          } else {
            yield { type: 'text-delta', delta: 'native compacted answer' }
          }
          yield {
            type: 'usage',
            usage: { inputTokens: 10, outputTokens: 2 },
          }
        },
      },
      tools: {
        definitions: () => [
          {
            name: 'fixture_tool',
            description: 'large result fixture',
            inputSchema: { type: 'object' },
          },
        ],
        prepare: async (call) => call,
        execute: async () => ({
          content: `CURRENT_TURN_TOOL_RESULT ${'large '.repeat(500)}`,
          isError: false,
          followUpUserMessages: ['CURRENT_TURN_FOLLOW_UP'],
        }),
      },
      permissions: { resolve: () => ({ behavior: 'allow' }) },
      compactor: {
        async compact(request) {
          compactInputs.push([...request.messages])
          return {
            summary: 'NATIVE_AUTO_SUMMARY',
            usage: { inputTokens: 7, outputTokens: 3 },
            durationMs: 4,
            model: 'native-compact-model',
          }
        },
      },
      pricing: new ModelPricingRegistry({
        'native-main-model': {
          inputPerMillionUsd: 1,
          outputPerMillionUsd: 1,
        },
        'native-compact-model': {
          inputPerMillionUsd: 2,
          outputPerMillionUsd: 4,
        },
      }),
    })

    await service.run('seed native history', undefined, sessionId)
    const result = await service.resume(sessionId, 'CURRENT_TURN_PROMPT')

    expect(result.text).toBe('native compacted answer')
    expect(compactInputs).toHaveLength(1)
    const compactInput = JSON.stringify(compactInputs[0])
    expect(compactInput).toContain('PRIOR_NATIVE_HISTORY')
    expect(compactInput).not.toContain('CURRENT_TURN_PROMPT')
    expect(compactInput).toContain('CURRENT_TURN_TOOL_RESULT')
    const finalRequest = JSON.stringify(requests.at(-1)?.messages)
    for (const marker of [
      'NATIVE_AUTO_SUMMARY',
      'CURRENT_TURN_PROMPT',
      'CURRENT_TURN_TOOL_RESULT',
      'CURRENT_TURN_FOLLOW_UP',
    ])
      expect(finalRequest).toContain(marker)
    expect(finalRequest).not.toContain('PRIOR_NATIVE_HISTORY')
    const finalMessages = requests.at(-1)?.messages ?? []
    const replayedCall = finalMessages
      .filter((message) => message.role === 'assistant')
      .flatMap((message) => message.toolCalls ?? [])
      .find((call) => call.name === 'fixture_tool')
    const replayedResult = finalMessages.find(
      (message) => message.role === 'tool',
    )
    expect(replayedCall?.id).toEqual(expect.any(String))
    expect(replayedCall?.id).not.toBe('native-large-call')
    expect(replayedResult).toMatchObject({
      role: 'tool',
      toolCallId: replayedCall?.id,
      content: expect.stringContaining('CURRENT_TURN_TOOL_RESULT'),
    })

    const sessionFile = resolveDataPlanePaths({
      dataPlane: 'native',
      root: configRoot,
      cwd,
      sessionId,
    }).sessionFile
    const events = (await readFile(sessionFile, 'utf8'))
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line).event)
    expect(
      events.filter((event) => event.kind === 'context-boundary'),
    ).toHaveLength(1)
    expect(
      events.filter((event) => event.kind === 'context-summary'),
    ).toHaveLength(1)
    expect(JSON.stringify(events)).not.toContain('claudeVersion')
    const snapshot = await service.costSnapshot(sessionId)
    expect(snapshot.modelUsage['native-compact-model']).toMatchObject({
      inputTokens: 7,
      outputTokens: 3,
      costUsd: 26 / 1_000_000,
    })
    expect(snapshot.apiDurationMs).toBeGreaterThanOrEqual(4)
    await service.close()
  })

  it('keeps native transcript bytes unchanged across manual compaction preflight failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-native-compact-fail-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const sessionId = '92929292-2222-4222-8222-929292929292'
    const base = {
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      dataPlane: 'native' as const,
      experimentalNativeTranscriptWrites: true,
      autoCompact: false,
      provider: {
        model: 'native-main-model',
        capabilities: { streaming: true, usage: true, tools: false },
        async *complete() {
          yield { type: 'text-delta' as const, delta: 'native answer' }
        },
      },
    }
    const service = new ClaudeSessionService({
      ...base,
      compactor: {
        async compact() {
          return {
            summary: 'must not persist',
            usage: { inputTokens: 1, outputTokens: 1 },
            durationMs: 1,
            model: 'native-main-model',
          }
        },
      },
    })
    await service.run('native prompt', undefined, sessionId)
    const sessionFile = resolveDataPlanePaths({
      dataPlane: 'native',
      root: configRoot,
      cwd,
      sessionId,
    }).sessionFile
    const before = await readFile(sessionFile, 'utf8')

    await expect(
      service.compact(sessionId, undefined, {} as never),
    ).rejects.toThrow(/No native rewind point found/u)
    const aborted = new AbortController()
    aborted.abort()
    await expect(
      service.compact(sessionId, aborted.signal),
    ).rejects.toBeInstanceOf(AgentRunCancelledError)
    expect(await readFile(sessionFile, 'utf8')).toBe(before)

    const thrown = new ClaudeSessionService({
      ...base,
      compactor: {
        async compact() {
          throw new Error('native compactor failed')
        },
      },
    })
    await expect(thrown.compact(sessionId)).rejects.toThrow(
      'native compactor failed',
    )
    expect(await readFile(sessionFile, 'utf8')).toBe(before)
    await Promise.all([service.close(), thrown.close()])
  })

  it('persists native tool calls, results, and follow-up messages exactly once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-native-tool-turn-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const sessionId = '93939393-9393-4393-8393-939393939393'
    const requests: ModelRequest[] = []
    let providerCalls = 0
    let toolExecutions = 0
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      dataPlane: 'native',
      experimentalNativeTranscriptWrites: true,
      autoCompact: false,
      provider: {
        capabilities: { streaming: true, usage: true, tools: true },
        async *complete(request) {
          requests.push(request)
          providerCalls += 1
          if (providerCalls === 1) {
            yield {
              type: 'tool-call',
              call: { id: 'native-call', name: 'fixture_tool', input: {} },
            }
          } else {
            yield { type: 'text-delta', delta: 'native tool answer' }
          }
          yield {
            type: 'usage',
            usage: { inputTokens: 1, outputTokens: 1 },
          }
        },
      },
      tools: {
        definitions: () => [
          {
            name: 'fixture_tool',
            description: 'fixture',
            inputSchema: { type: 'object' },
          },
        ],
        prepare: async (call) => call,
        execute: async () => {
          toolExecutions += 1
          return {
            content: 'native tool result',
            isError: false,
            followUpUserMessages: ['native follow-up'],
          }
        },
      },
      permissions: { resolve: () => ({ behavior: 'allow' }) },
    })

    await expect(
      service.run('use the tool', undefined, sessionId),
    ).resolves.toMatchObject({
      text: 'native tool answer',
      sessionId,
    })

    const sessionFile = resolveDataPlanePaths({
      dataPlane: 'native',
      root: configRoot,
      cwd,
      sessionId,
    }).sessionFile
    const messages = (await readFile(sessionFile, 'utf8'))
      .trimEnd()
      .split('\n')
      .flatMap((line) => JSON.parse(line).event.messages ?? [])
    expect(toolExecutions).toBe(1)
    expect(messages.filter((message) => message.role === 'tool')).toEqual([
      {
        role: 'tool',
        toolCallId: 'native-call',
        content: 'native tool result',
        isError: false,
      },
    ])
    expect(
      messages.filter(
        (message) =>
          message.role === 'user' && message.content === 'native follow-up',
      ),
    ).toHaveLength(1)
    expect(JSON.stringify(requests[1]?.messages)).toContain(
      'native tool result',
    )
    expect(JSON.stringify(requests[1]?.messages)).toContain('native follow-up')
    await service.close()
  })

  it('recovers an approved native tool exactly once before provider continuation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-native-recovery-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const sessionId = 'a5a5a5a5-a5a5-45a5-85a5-a5a5a5a5a5a5'
    const sessionFile = resolveDataPlanePaths({
      dataPlane: 'native',
      root: configRoot,
      cwd,
      sessionId,
    }).sessionFile
    await mkdir(join(sessionFile, '..'), { recursive: true })
    const call = { id: 'native-recovery-call', name: 'fixture_tool', input: {} }
    await writeFile(
      sessionFile,
      [
        nativeTranscriptLine(
          nativeMessageEvent({
            sessionId,
            id: 'a6a6a6a6-a6a6-46a6-86a6-a6a6a6a6a6a6',
            parentId: null,
            role: 'user',
            content: 'start recovery',
          }),
        ),
        nativeTranscriptLine({
          kind: 'messages',
          id: 'a7a7a7a7-a7a7-47a7-87a7-a7a7a7a7a7a7',
          parentId: 'a6a6a6a6-a6a6-46a6-86a6-a6a6a6a6a6a6',
          sessionId,
          timestamp: '2026-08-23T00:00:01.000Z',
          messages: [{ role: 'assistant', content: '', toolCalls: [call] }],
        }),
      ].join(''),
    )
    let approvals = 0
    let executions = 0
    let providerCalls = 0
    const requests: ModelRequest[] = []
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      dataPlane: 'native',
      experimentalNativeTranscriptWrites: true,
      autoCompact: false,
      approveRecovery(recovered) {
        approvals += 1
        expect(recovered).toEqual(call)
        return true
      },
      provider: {
        capabilities: { streaming: true, usage: true, tools: true },
        async *complete(request) {
          providerCalls += 1
          requests.push(request)
          const durable = await readFile(sessionFile, 'utf8')
          expect(durable).toContain('"kind":"tool-execution-started"')
          expect(durable).toContain('native recovered result')
          expect(durable).toContain('native recovery follow-up')
          yield { type: 'text-delta', delta: 'continued after recovery' }
        },
      },
      tools: {
        definitions: () => [],
        prepare: async (prepared) => prepared,
        execute: async () => {
          executions += 1
          return {
            content: 'native recovered result',
            isError: false,
            followUpUserMessages: ['native recovery follow-up'],
          }
        },
      },
      permissions: { resolve: () => ({ behavior: 'allow' }) },
    })

    await expect(
      service.resume(sessionId, 'continue exactly once'),
    ).resolves.toMatchObject({ text: 'continued after recovery' })
    expect(approvals).toBe(1)
    expect(executions).toBe(1)
    expect(providerCalls).toBe(1)
    const events = (await readFile(sessionFile, 'utf8'))
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line).event)
    expect(
      events.filter((event) => event.kind === 'tool-execution-started'),
    ).toHaveLength(1)
    const messages = events.flatMap((event) => event.messages ?? [])
    expect(
      messages.filter(
        (message) =>
          message.role === 'tool' &&
          message.toolCallId === call.id &&
          message.content === 'native recovered result',
      ),
    ).toHaveLength(1)
    expect(
      messages.filter(
        (message) =>
          message.role === 'user' &&
          message.content === 'native recovery follow-up',
      ),
    ).toHaveLength(1)
    expect(
      messages.filter(
        (message) =>
          message.role === 'user' &&
          message.content === 'continue exactly once',
      ),
    ).toHaveLength(1)
    expect(JSON.stringify(requests[0]?.messages)).toContain(
      'native recovered result',
    )
    await expect(service.interruption(sessionId)).resolves.toEqual({
      kind: 'complete',
    })
    await service.close()
  })

  it('leaves native bytes unchanged for declined, aborted, and indeterminate recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-native-recovery-fail-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const sessionId = 'b5b5b5b5-b5b5-45b5-85b5-b5b5b5b5b5b5'
    const sessionFile = resolveDataPlanePaths({
      dataPlane: 'native',
      root: configRoot,
      cwd,
      sessionId,
    }).sessionFile
    await mkdir(join(sessionFile, '..'), { recursive: true })
    const calls = [
      { id: 'claimed-call', name: 'fixture_tool', input: {} },
      { id: 'unclaimed-call', name: 'fixture_tool', input: {} },
    ]
    const recoverableSource = [
      nativeTranscriptLine(
        nativeMessageEvent({
          sessionId,
          id: 'b6b6b6b6-b6b6-46b6-86b6-b6b6b6b6b6b6',
          parentId: null,
          role: 'user',
          content: 'recover safely',
        }),
      ),
      nativeTranscriptLine({
        kind: 'messages',
        id: 'b7b7b7b7-b7b7-47b7-87b7-b7b7b7b7b7b7',
        parentId: 'b6b6b6b6-b6b6-46b6-86b6-b6b6b6b6b6b6',
        sessionId,
        timestamp: '2026-08-23T00:00:01.000Z',
        messages: [{ role: 'assistant', content: '', toolCalls: calls }],
      }),
    ].join('')
    await writeFile(sessionFile, recoverableSource)
    let providerCalls = 0
    let executions = 0
    const base = {
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      dataPlane: 'native' as const,
      experimentalNativeTranscriptWrites: true,
      autoCompact: false,
      provider: {
        capabilities: { streaming: true, usage: true, tools: true },
        async *complete() {
          providerCalls += 1
          yield { type: 'text-delta' as const, delta: 'must not run' }
        },
      },
      tools: {
        definitions: () => [],
        prepare: async (call: ModelToolCall) => call,
        execute: async () => {
          executions += 1
          return { content: 'must not execute', isError: false }
        },
      },
      permissions: { resolve: () => ({ behavior: 'allow' as const }) },
    }
    const declined = new ClaudeSessionService({
      ...base,
      approveRecovery: () => false,
    })
    await expect(declined.resume(sessionId, 'declined')).rejects.toThrow(
      'recovery was declined',
    )
    expect(await readFile(sessionFile, 'utf8')).toBe(recoverableSource)
    await declined.close()

    const controller = new AbortController()
    const aborted = new ClaudeSessionService({
      ...base,
      approveRecovery: () => {
        controller.abort()
        return true
      },
    })
    await expect(
      aborted.resume(sessionId, 'aborted', controller.signal),
    ).rejects.toBeInstanceOf(AgentRunCancelledError)
    expect(await readFile(sessionFile, 'utf8')).toBe(recoverableSource)
    await aborted.close()

    const indeterminateSource = `${recoverableSource}${nativeTranscriptLine({
      kind: 'tool-execution-started',
      id: 'b8b8b8b8-b8b8-48b8-88b8-b8b8b8b8b8b8',
      parentId: 'b7b7b7b7-b7b7-47b7-87b7-b7b7b7b7b7b7',
      sessionId,
      timestamp: '2026-08-23T00:00:02.000Z',
      callId: calls[0]?.id,
    })}`
    await writeFile(sessionFile, indeterminateSource)
    let indeterminateApprovals = 0
    const indeterminate = new ClaudeSessionService({
      ...base,
      approveRecovery: () => {
        indeterminateApprovals += 1
        return true
      },
    })
    await expect(
      indeterminate.resume(sessionId, 'must remain unchanged'),
    ).rejects.toThrow('Native tool execution is indeterminate: claimed-call')
    expect(await readFile(sessionFile, 'utf8')).toBe(indeterminateSource)
    expect(indeterminateApprovals).toBe(0)
    expect(providerCalls).toBe(0)
    expect(executions).toBe(0)
    await expect(indeterminate.interruption(sessionId)).resolves.toEqual({
      kind: 'interrupted-turn',
    })
    await indeterminate.close()
  })

  it('publishes native shell input/output and rejects unresolved history before execution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-native-shell-turn-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    await mkdir(cwd, { recursive: true })
    const shellSessionId = '94949494-9494-4494-8494-949494949494'
    let providerCalls = 0
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      dataPlane: 'native',
      experimentalNativeTranscriptWrites: true,
      autoCompact: false,
      provider: {
        capabilities: { streaming: true, usage: true, tools: true },
        async *complete() {
          providerCalls += 1
          yield { type: 'text-delta', delta: 'native shell answer' }
          yield {
            type: 'usage',
            usage: { inputTokens: 1, outputTokens: 1 },
          }
        },
      },
      tools: new LocalToolRegistry({ cwd }),
      permissions: { resolve: () => ({ behavior: 'allow' }) },
    })

    await expect(
      service.runShell('printf native-shell', undefined, shellSessionId),
    ).resolves.toMatchObject({ sessionId: shellSessionId, text: '' })
    expect(providerCalls).toBe(0)
    const shellFile = resolveDataPlanePaths({
      dataPlane: 'native',
      root: configRoot,
      cwd,
      sessionId: shellSessionId,
    }).sessionFile
    const shellMessages = (await readFile(shellFile, 'utf8'))
      .trimEnd()
      .split('\n')
      .flatMap((line) => JSON.parse(line).event.messages ?? [])
    expect(shellMessages).toEqual([
      { role: 'user', content: '<bash-input>printf native-shell</bash-input>' },
      {
        role: 'user',
        content:
          '<bash-stdout>native-shell</bash-stdout><bash-stderr></bash-stderr>',
      },
    ])

    const unresolvedSessionId = '95959595-9595-4595-8595-959595959595'
    const unresolvedFile = resolveDataPlanePaths({
      dataPlane: 'native',
      root: configRoot,
      cwd,
      sessionId: unresolvedSessionId,
    }).sessionFile
    await mkdir(join(unresolvedFile, '..'), { recursive: true })
    const unresolvedSource = [
      nativeTranscriptLine(
        nativeMessageEvent({
          sessionId: unresolvedSessionId,
          id: '96969696-9696-4696-8696-969696969696',
          parentId: null,
          role: 'user',
          content: 'before unresolved call',
        }),
      ),
      nativeTranscriptLine({
        kind: 'messages',
        id: '97979797-9797-4797-8797-979797979797',
        parentId: '96969696-9696-4696-8696-969696969696',
        sessionId: unresolvedSessionId,
        timestamp: '2026-08-23T00:00:01.000Z',
        messages: [
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'unresolved-call', name: 'Read', input: {} }],
          },
        ],
      }),
    ].join('')
    await writeFile(unresolvedFile, unresolvedSource)

    await expect(
      service.resume(unresolvedSessionId, 'must not execute'),
    ).rejects.toThrow(/requires explicit recovery approval/u)
    expect(providerCalls).toBe(0)
    expect(await readFile(unresolvedFile, 'utf8')).toBe(unresolvedSource)

    const invalidFixtures = [
      {
        sessionId: '98989898-9898-4898-8898-989898989898',
        source: nativeTranscriptLine(
          nativeMessageEvent({
            sessionId: '98989898-9898-4898-8898-989898989898',
            id: '99999999-9999-4999-8999-999999999999',
            parentId: 'missing-parent',
            role: 'user',
            content: 'dangling',
          }),
        ),
        error: /parentId must reference an earlier event/u,
      },
      {
        sessionId: 'a0a0a0a0-a0a0-40a0-80a0-a0a0a0a0a0a0',
        source: nativeTranscriptLine(
          nativeMessageEvent({
            sessionId: 'a0a0a0a0-a0a0-40a0-80a0-a0a0a0a0a0a0',
            id: 'a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1',
            parentId: null,
            role: 'user',
            content: 'future version',
          }),
          999,
        ),
        error: /unsupported native transcript version|unsupported version/iu,
      },
      {
        sessionId: 'a2a2a2a2-a2a2-42a2-82a2-a2a2a2a2a2a2',
        source: nativeTranscriptLine(
          nativeMessageEvent({
            sessionId: 'a3a3a3a3-a3a3-43a3-83a3-a3a3a3a3a3a3',
            id: 'a4a4a4a4-a4a4-44a4-84a4-a4a4a4a4a4a4',
            parentId: null,
            role: 'user',
            content: 'mismatched session',
          }),
        ),
        error: /sessionId does not match/u,
      },
    ]
    for (const fixture of invalidFixtures) {
      const file = resolveDataPlanePaths({
        dataPlane: 'native',
        root: configRoot,
        cwd,
        sessionId: fixture.sessionId,
      }).sessionFile
      await mkdir(join(file, '..'), { recursive: true })
      await writeFile(file, fixture.source)
      await expect(service.resume(fixture.sessionId, 'reject')).rejects.toThrow(
        fixture.error,
      )
      expect(await readFile(file, 'utf8')).toBe(fixture.source)
    }
    expect(providerCalls).toBe(0)
    await service.close()
  })

  it('runs native shell without pricing when max budget is configured', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-shell-max-budget-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    await mkdir(cwd, { recursive: true })
    let providerCalls = 0
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      maxBudgetUsd: 1,
      provider: {
        model: 'unpriced-shell-model',
        capabilities: { streaming: true, usage: true, tools: true },
        async *complete() {
          providerCalls += 1
          yield { type: 'text-delta', delta: 'unexpected' }
        },
      },
      tools: new LocalToolRegistry({ cwd }),
      permissions: { resolve: () => ({ behavior: 'allow' }) },
    })

    await expect(service.runShell('printf max-budget')).resolves.toMatchObject({
      text: '',
    })
    expect(providerCalls).toBe(0)
    await service.close()
  })

  it('prefetches Project memory without blocking and consumes it only after tools', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-project-memory-test-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const memoryDirectory = join(configRoot, 'memory', 'project')
    const memoryPath = join(memoryDirectory, 'topic.md')
    let recallConsumed = false
    const recall = {
      prefetch: vi.fn(() => ({
        consumeIfSettled: () => {
          if (recallConsumed) return null
          recallConsumed = true
          return {
            attachmentCount: 1,
            content: `<system-reminder>\n<project-memory path=${JSON.stringify(memoryPath)}>\nPROJECT_MEMORY_DETAIL\n</project-memory>\n</system-reminder>`,
          }
        },
      })),
      recordRead: vi.fn(),
      recordCompact: vi.fn(),
    }
    const extraction = {
      observe: vi.fn(),
      close: vi.fn(async () => undefined),
    }
    const requests: ModelRequest[] = []
    const provider: ModelProvider = {
      capabilities: { streaming: true, usage: true, tools: true },
      async *complete(request) {
        requests.push(request)
        if (requests.length === 1) {
          expect(JSON.stringify(request.messages)).not.toContain(
            'PROJECT_MEMORY_DETAIL',
          )
          yield {
            type: 'tool-call',
            call: { id: 'read-1', name: 'Read', input: { file_path: 'a.ts' } },
          }
          return
        }
        yield { type: 'text-delta', delta: 'done' }
      },
    }
    const tools: ToolRegistry = {
      definitions: () => [
        { name: 'Read', description: 'Read', inputSchema: { type: 'object' } },
      ],
      prepare: async (call) => call,
      execute: async () => ({ content: 'file', isError: false }),
    }
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.237',
      provider,
      tools,
      permissions: { resolve: () => ({ behavior: 'allow' }) },
      projectMemoryDirectory: memoryDirectory,
      projectMemoryRecall: recall,
      projectMemoryExtraction: extraction,
    })

    const result = await service.run('Use the durable project context')

    expect(result.text).toBe('done')
    expect(recall.prefetch).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(requests[1]?.messages)).toContain(
      'PROJECT_MEMORY_DETAIL',
    )
    expect(extraction.observe).toHaveBeenCalledTimes(1)
    expect(extraction.observe.mock.calls[0]?.[0]).toMatchObject({
      sessionId: result.sessionId,
      directMaintenance: false,
      messages: [
        expect.objectContaining({ role: 'user' }),
        expect.objectContaining({ role: 'assistant' }),
      ],
    })
    await service.close()
    expect(extraction.close).toHaveBeenCalledTimes(1)
  })

  it('emits terminal state after Project-memory observation and for pre-runtime failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-turn-terminal-test-'))
    roots.push(root)
    const events: RuntimeEvent[] = []
    const order: string[] = []
    let providerCalls = 0
    const service = new ClaudeSessionService({
      configRoot: join(root, 'config'),
      cwd: join(root, 'project'),
      claudeVersion: '2.1.237',
      eventSink: (event) => {
        events.push(event)
        if (event.type === 'state' && event.state === 'completed') {
          order.push('completed')
        }
      },
      provider: {
        capabilities: { streaming: true, usage: true, tools: true },
        async *complete() {
          providerCalls += 1
          yield { type: 'text-delta', delta: 'ok' }
        },
      },
      projectMemoryExtraction: {
        observe: vi.fn(() => order.push('memory')),
        close: vi.fn(async () => undefined),
      },
    })

    await service.run('hello')
    expect(order).toEqual(['memory', 'completed'])
    const callsBeforeFailure = providerCalls
    await expect(service.run('')).rejects.toThrow('Prompt must not be empty')
    expect(providerCalls).toBe(callsBeforeFailure)
    expect(
      events.filter(
        (event) => event.type === 'state' && event.state === 'failed',
      ),
    ).toHaveLength(1)
    await service.close()
  })

  it('marks successful direct Project-memory maintenance so extraction skips that range', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-project-memory-test-'))
    roots.push(root)
    const memoryDirectory = join(root, 'memory')
    const memoryPath = join(memoryDirectory, 'topic.md')
    let request = 0
    const extraction = {
      observe: vi.fn(),
      close: vi.fn(async () => undefined),
    }
    const service = new ClaudeSessionService({
      configRoot: join(root, 'config'),
      cwd: join(root, 'project'),
      claudeVersion: '2.1.237',
      provider: {
        capabilities: { streaming: true, usage: true, tools: true },
        async *complete() {
          request += 1
          if (request === 1) {
            yield {
              type: 'tool-call',
              call: {
                id: 'write-memory',
                name: 'Write',
                input: { file_path: memoryPath, content: 'durable' },
              },
            }
            return
          }
          yield { type: 'text-delta', delta: 'maintained' }
        },
      },
      tools: {
        definitions: () => [
          {
            name: 'Write',
            description: 'Write',
            inputSchema: { type: 'object' },
          },
        ],
        prepare: async (call) => call,
        execute: async () => ({ content: 'written', isError: false }),
      },
      permissions: { resolve: () => ({ behavior: 'allow' }) },
      projectMemoryDirectory: memoryDirectory,
      projectMemoryExtraction: extraction,
    })

    await service.run('Remember this for the project')

    expect(extraction.observe).toHaveBeenCalledWith(
      expect.objectContaining({ directMaintenance: true }),
    )
  })

  it('returns the main result before extraction and drains it during close', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-project-memory-test-'))
    roots.push(root)
    let release!: () => void
    let started!: (input: ProjectMemoryExtractorInput) => void
    const extractionStarted = new Promise<ProjectMemoryExtractorInput>(
      (resolveStarted) => {
        started = resolveStarted
      },
    )
    const extractionRelease = new Promise<void>((resolveRelease) => {
      release = resolveRelease
    })
    const extraction = new ProjectMemoryExtractionController({
      directory: join(root, 'memory'),
      cursorPath: join(root, 'state', 'cursor.json'),
      extractor: {
        extract: async (input) => {
          started(input)
          await extractionRelease
        },
      },
    })
    const service = new ClaudeSessionService({
      configRoot: join(root, 'config'),
      cwd: join(root, 'project'),
      claudeVersion: '2.1.237',
      provider: queuedProvider(['response delivered']),
      projectMemoryExtraction: extraction,
    })

    await expect(
      service.run('remember durable context'),
    ).resolves.toMatchObject({ text: 'response delivered' })
    await expect(extractionStarted).resolves.toMatchObject({
      messages: [
        expect.objectContaining({ role: 'user' }),
        expect.objectContaining({ role: 'assistant' }),
      ],
    })
    let closed = false
    const closing = service.close().then(() => {
      closed = true
    })
    await Promise.resolve()
    expect(closed).toBe(false)
    release()
    await closing
    expect(closed).toBe(true)
  })

  it('runs the main session beyond the former implicit model turn limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-unbounded-turns-test-'))
    roots.push(root)
    const configRoot = join(root, 'config')
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
    const service = new ClaudeSessionService({
      configRoot,
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
          yield { type: 'text-delta', delta: 'MAIN_DONE' }
        },
      },
      tools,
      permissions: { resolve: () => ({ behavior: 'allow' }) },
    })

    await expect(service.run('Keep reading until done')).resolves.toMatchObject(
      { text: 'MAIN_DONE' },
    )
    expect(requests).toBe(18)
  })

  it('does not restore an implicit model turn limit on resume', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-resume-turns-test-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    let initial = true
    let resumeRequests = 0
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
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: {
        capabilities: { streaming: true, usage: true, tools: true },
        async *complete() {
          if (initial) {
            initial = false
            yield { type: 'text-delta', delta: 'INITIAL_DONE' }
            return
          }
          resumeRequests += 1
          if (resumeRequests <= 17) {
            yield {
              type: 'tool-call',
              call: {
                id: `resume_read_${resumeRequests}`,
                name: 'Read',
                input: {},
              },
            }
            return
          }
          yield { type: 'text-delta', delta: 'RESUME_DONE' }
        },
      },
      tools,
      permissions: { resolve: () => ({ behavior: 'allow' }) },
    })

    const created = await service.run('Create the session')
    await expect(
      service.resume(created.sessionId, 'Keep reading until done'),
    ).resolves.toMatchObject({ text: 'RESUME_DONE' })
    expect(resumeRequests).toBe(18)
  })

  it('keeps consecutive assistant records from one provider response together at the suffix boundary', () => {
    const responseId = 'msg_split_response'
    const entries = [
      { type: 'user', message: { role: 'user', content: 'older' } },
      {
        type: 'assistant',
        message: {
          id: responseId,
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'reason', signature: 'signed' },
          ],
        },
      },
      {
        type: 'assistant',
        message: {
          id: responseId,
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'call-split', name: 'Read', input: {} },
          ],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call-split',
              content: 'result',
            },
          ],
        },
      },
      { type: 'user', message: { role: 'user', content: 'x'.repeat(20_000) } },
      {
        type: 'assistant',
        message: {
          id: 'msg_tail',
          role: 'assistant',
          content: [{ type: 'text', text: 'tail' }],
        },
      },
      { type: 'user', message: { role: 'user', content: 'x'.repeat(20_000) } },
    ]

    expect(memoryPreservedSuffixStart(entries)).toBe(1)
  })

  it.each([
    {
      dataPlane: 'native' as const,
      selectedRoot: 'state',
      unselectedRoot: 'praxis',
    },
  ])(
    'stores $dataPlane session memory only in the selected data plane',
    async ({ dataPlane, selectedRoot, unselectedRoot }) => {
      const root = await mkdtemp(join(tmpdir(), 'praxis-session-memory-plane-'))
      roots.push(root)
      const configRoot = join(root, 'config')
      const cwd = join(root, 'project')
      const provider: ModelProvider = {
        capabilities: {
          streaming: true,
          usage: true,
          tools: false,
          contextWindowTokens: 200_000,
        },
        async *complete() {
          yield { type: 'text-delta', delta: 'foreground answer' }
          yield {
            type: 'usage',
            usage: { inputTokens: 12_000, outputTokens: 50 },
          }
        },
      }
      const memoryProvider: ModelProvider = {
        capabilities: { streaming: true, usage: true, tools: false },
        async *complete() {
          yield { type: 'text-delta', delta: 'durable memory' }
          yield {
            type: 'usage',
            usage: { inputTokens: 10, outputTokens: 20 },
          }
        },
      }
      const service = new ClaudeSessionService({
        configRoot,
        dataPlane,
        cwd,
        claudeVersion: '2.1.208',
        provider,
        sessionMemoryProviderFactory: () => memoryProvider,
      })

      const run = await service.run('remember this')
      const summaryMirrorPath = (planeRoot: string) =>
        join(
          configRoot,
          planeRoot,
          'session-memory',
          run.sessionId,
          'summary.md',
        )

      // Normal turns schedule extraction without awaiting it, so wait for the
      // durable pointer commit before reading through the store. summary.md is
      // only a best-effort readable mirror and may lag that atomic commit.
      await waitForSessionMemoryCommit(configRoot, selectedRoot, run.sessionId)
      await service.close()
      await rm(summaryMirrorPath(selectedRoot), { force: true })
      await expect(
        readFile(summaryMirrorPath(selectedRoot), 'utf8'),
      ).rejects.toMatchObject({ code: 'ENOENT' })
      const selectedStore = new SessionMemoryStore({
        configRoot,
        sessionId: run.sessionId,
        sidecarRoot: join(configRoot, selectedRoot),
      })
      await expect(selectedStore.loadSummary()).resolves.toBe('durable memory')
      await expect(
        readFile(summaryMirrorPath(unselectedRoot), 'utf8'),
      ).rejects.toMatchObject({ code: 'ENOENT' })
    },
  )

  it('cancels asynchronous session memory extraction during service close', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-session-memory-close-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    let extractionStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      extractionStarted = resolve
    })
    let extractionAborted = false
    const provider: ModelProvider = {
      model: 'session-memory-close-model',
      capabilities: {
        streaming: true,
        usage: true,
        tools: false,
        contextWindowTokens: 200_000,
      },
      async *complete() {
        yield { type: 'text-delta', delta: 'foreground answer' }
        yield {
          type: 'usage',
          usage: { inputTokens: 12_000, outputTokens: 50 },
        }
      },
    }
    const memoryProvider: ModelProvider = {
      model: 'session-memory-close-model',
      capabilities: { streaming: true, usage: true, tools: false },
      complete(request) {
        const iterator = {
          async next() {
            extractionStarted?.()
            await new Promise<void>((resolve) => {
              request.signal?.addEventListener(
                'abort',
                () => {
                  extractionAborted = true
                  resolve()
                },
                { once: true },
              )
            })
            throw new AgentRunCancelledError()
          },
          [Symbol.asyncIterator]() {
            return iterator
          },
        }
        return iterator
      },
    }
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider,
      sessionMemoryProviderFactory: () => memoryProvider,
    })

    const run = await service.run('remember this')
    expect(run.usage).toEqual({ inputTokens: 12_000, outputTokens: 50 })
    await started
    await service.close()

    expect(extractionAborted).toBe(true)
    const state = JSON.parse(
      await readFile(
        join(
          configRoot,
          'state',
          'session-memory',
          run.sessionId,
          'state.json',
        ),
        'utf8',
      ),
    ) as {
      lastObservedTokens: number
      lastSummarizedMessageId: string | null
      extractionError: string | null
    }
    expect(state.lastObservedTokens).toBe(0)
    expect(state.lastSummarizedMessageId).toBeNull()
    expect(state.extractionError).toContain('Agent run cancelled')

    const transcript = await readFile(
      nativeSessionFile(configRoot, cwd, run.sessionId),
      'utf8',
    )
    expect(transcript).toContain('foreground answer')
    expect(transcript).not.toContain('# Session Memory')
  })

  it('uses current ContextEngine occupancy instead of accumulating provider input usage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-session-memory-context-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const observedInputs = [6_000, 6_000, 11_000]
    let foregroundCalls = 0
    let memoryCalls = 0
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: {
        model: 'foreground-model',
        capabilities: {
          streaming: true,
          usage: true,
          tools: false,
          contextWindowTokens: 200_000,
        },
        async *complete() {
          const inputTokens = observedInputs[foregroundCalls++]
          if (inputTokens === undefined) throw new Error('fixture exhausted')
          yield { type: 'text-delta', delta: `answer ${foregroundCalls}` }
          yield {
            type: 'usage',
            usage: { inputTokens, outputTokens: 1 },
          }
        },
      },
      sessionMemoryProviderFactory: () => ({
        model: 'memory-model',
        capabilities: { streaming: true, usage: true, tools: false },
        async *complete() {
          memoryCalls += 1
          yield { type: 'text-delta', delta: 'isolated memory' }
          yield {
            type: 'usage',
            usage: { inputTokens: 50_000, outputTokens: 500 },
          }
        },
      }),
      collectMetrics: true,
    })

    const run = await service.run('first')
    await service.resume(run.sessionId, 'second')
    expect(memoryCalls).toBe(0)
    await service.resume(run.sessionId, 'third')
    const state = await waitForSessionMemoryCommit(
      configRoot,
      'state',
      run.sessionId,
    )

    expect(foregroundCalls).toBe(3)
    expect(memoryCalls).toBe(1)
    expect(state.lastObservedTokens).toBeGreaterThanOrEqual(11_000)
    expect(state.lastObservedTokens).toBeLessThan(12_000)
    const cost = await service.costSnapshot(run.sessionId)
    expect(cost.modelUsage['memory-model']).toBeUndefined()
    expect(cost.modelUsage['foreground-model']?.inputTokens).toBe(23_000)
    await service.close()
  })

  it('anchors multi-round occupancy to the matching final provider request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-context-multi-round-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    let providerCalls = 0
    let memoryCalls = 0
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: {
        model: 'foreground-model',
        capabilities: {
          streaming: true,
          usage: true,
          tools: true,
          contextWindowTokens: 200_000,
        },
        async *complete() {
          providerCalls += 1
          if (providerCalls === 1) {
            yield {
              type: 'tool-call',
              call: { id: 'call-1', name: 'test_tool', input: {} },
            }
            yield {
              type: 'usage',
              usage: { inputTokens: 6_000, outputTokens: 10 },
            }
            return
          }
          yield { type: 'text-delta', delta: 'done' }
          yield {
            type: 'usage',
            usage: { inputTokens: 11_000, outputTokens: 20 },
          }
        },
      },
      sessionMemoryProviderFactory: () => ({
        capabilities: { streaming: true, usage: true, tools: false },
        async *complete() {
          memoryCalls += 1
          yield { type: 'text-delta', delta: 'memory' }
          yield {
            type: 'usage',
            usage: { inputTokens: 10, outputTokens: 5 },
          }
        },
      }),
      tools: {
        definitions: () => [
          {
            name: 'test_tool',
            description: 'Test tool',
            inputSchema: { type: 'object' },
          },
        ],
        async prepare(call) {
          return call
        },
        async execute() {
          return { content: 'tool result', isError: false }
        },
      },
      permissions: { resolve: () => ({ behavior: 'allow' as const }) },
    })

    const run = await service.run('inspect')
    try {
      const state = await waitForSessionMemoryCommit(
        configRoot,
        'praxis',
        run.sessionId,
      )
      expect(providerCalls).toBe(2)
      expect(run.usage.inputTokens).toBe(17_000)
      expect(state.lastObservedTokens).toBeGreaterThanOrEqual(11_000)
      expect(state.lastObservedTokens).toBeLessThan(12_000)
      expect(memoryCalls).toBe(1)
    } finally {
      await service.close()
    }
  })

  it('constructs the isolated memory provider lazily at extraction time', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-session-memory-lazy-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    let providerSelections = 0
    let foregroundCalls = 0
    const observedInputs = [6_000, 6_000, 11_000]
    const service = new ClaudeSessionService({
      configRoot,
      cwd: join(root, 'project'),
      claudeVersion: '2.1.208',
      provider: {
        model: 'foreground-model',
        capabilities: {
          streaming: true,
          usage: true,
          tools: false,
          contextWindowTokens: 200_000,
        },
        async *complete() {
          const inputTokens = observedInputs[foregroundCalls++]
          if (inputTokens === undefined) throw new Error('fixture exhausted')
          yield { type: 'text-delta', delta: 'small answer' }
          yield {
            type: 'usage',
            usage: { inputTokens, outputTokens: 2 },
          }
        },
      },
      providerForMainModel: () => {
        providerSelections += 1
        return queuedProvider(['memory'])
      },
      collectMetrics: true,
    })

    const run = await service.run('small prompt')
    expect(providerSelections).toBe(0)
    await service.resume(run.sessionId, 'still below threshold')
    expect(providerSelections).toBe(0)
    await service.resume(run.sessionId, 'cross threshold')
    await waitForSessionMemoryCommit(configRoot, 'praxis', run.sessionId)
    expect(providerSelections).toBe(1)
    await service.close()
  })

  it('includes a complete oversized latest message before advancing its watermark', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-session-memory-tail-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const memoryRequests: ModelRequest[] = []
    let writerCalls = 0
    const writer = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      enableSessionMemory: false,
      autoCompact: false,
      provider: {
        capabilities: {
          streaming: true,
          usage: true,
          tools: false,
          contextWindowTokens: 200_000,
        },
        async *complete() {
          const call = writerCalls++
          yield {
            type: 'text-delta',
            delta:
              call === 0
                ? 'older answer'
                : `LATEST_MEMORY_PREFIX ${'x'.repeat(34_000)} LATEST_MEMORY_TAIL`,
          }
          yield {
            type: 'usage',
            usage: { inputTokens: 100, outputTokens: 2 },
          }
        },
      },
    })
    const run = await writer.run('first')
    await writer.resume(run.sessionId, 'second')
    await writer.close()

    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: {
        model: 'foreground-model',
        capabilities: {
          streaming: true,
          usage: true,
          tools: false,
          contextWindowTokens: 200_000,
        },
        async *complete() {
          yield { type: 'text-delta', delta: 'final answer' }
          yield {
            type: 'usage',
            usage: { inputTokens: 11_000, outputTokens: 2 },
          }
        },
      },
      sessionMemoryProviderFactory: () => ({
        model: 'memory-model',
        capabilities: { streaming: true, usage: true, tools: false },
        async *complete(request) {
          memoryRequests.push(request)
          yield { type: 'text-delta', delta: 'bounded memory' }
          yield {
            type: 'usage',
            usage: { inputTokens: 10, outputTokens: 2 },
          }
        },
      }),
      collectMetrics: true,
    })

    await service.resume(run.sessionId, 'third')
    const state = await waitForSessionMemoryCommit(
      configRoot,
      'state',
      run.sessionId,
    )
    const extractionInput = JSON.stringify(memoryRequests[0]?.messages)
    expect(extractionInput).toContain('LATEST_MEMORY_PREFIX')
    expect(extractionInput).toContain('LATEST_MEMORY_TAIL')
    const transcriptEntries = await readNativeEvents(
      nativeSessionFile(configRoot, cwd, run.sessionId),
    )
    expect(state.lastSummarizedMessageId).toEqual(expect.any(String))
    expect(
      transcriptEntries.some(
        (event) => event.id === state.lastSummarizedMessageId,
      ),
    ).toBe(true)
    await service.close()
  })

  it('does not run Session memory on background session threads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-session-memory-bg-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    let memoryCalls = 0
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      sessionKind: 'bg',
      provider: {
        model: 'foreground-model',
        capabilities: {
          streaming: true,
          usage: true,
          tools: false,
          contextWindowTokens: 200_000,
        },
        async *complete() {
          yield { type: 'text-delta', delta: 'background answer' }
          yield {
            type: 'usage',
            usage: { inputTokens: 12_000, outputTokens: 10 },
          }
        },
      },
      sessionMemoryProviderFactory: () => ({
        capabilities: { streaming: true, usage: true, tools: false },
        async *complete() {
          memoryCalls += 1
          yield { type: 'text-delta', delta: 'must not run' }
        },
      }),
      collectMetrics: true,
    })

    const run = await service.run('background task')
    expect(memoryCalls).toBe(0)
    await expect(
      readFile(
        join(
          configRoot,
          'praxis',
          'session-memory',
          run.sessionId,
          'state.json',
        ),
        'utf8',
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await service.close()
  })

  it('stores a native session outside the Claude project layout', async () => {
    const { configRoot, cwd, service } = await createService()
    const native = new ClaudeSessionService({
      configRoot,
      dataPlane: 'native',
      cwd,
      claudeVersion: '2.1.208',
      provider: queuedProvider(['native answer']),
    })

    const run = await native.run('start')
    const paths = resolveDataPlanePaths({
      dataPlane: 'native',
      root: configRoot,
      cwd,
      sessionId: run.sessionId,
    })
    const source = await readFile(paths.sessionFile, 'utf8')
    const records = source
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          schema: 'praxis.transcript',
          version: 1,
          event: expect.objectContaining({
            kind: 'messages',
            messages: expect.arrayContaining([
              { role: 'assistant', content: 'native answer' },
            ]),
          }),
        }),
      ]),
    )
    expect(paths.sessionFile).not.toContain('/.claude/')
    await service.close()
  })

  it('approves a recently denied action without invoking the provider', async () => {
    const { configRoot, cwd, service } = await createService()
    const run = await service.run('start')

    await service.approveRecentlyDenied(run.sessionId, 'Delete target')

    const sessionFile = resolveDataPlanePaths({
      dataPlane: 'native',
      root: configRoot,
      cwd,
      sessionId: run.sessionId,
    }).sessionFile
    const messages = nativeMessages(await readNativeEvents(sessionFile))
    expect(messages.slice(-3)).toEqual([
      { role: 'user', content: 'start' },
      {
        role: 'assistant',
        content: 'first answer',
      },
      {
        role: 'user',
        content: 'Permission granted for: Delete target',
      },
    ])
  })

  it('retries through permission_retry without appending a normal prompt', async () => {
    const requests: ModelRequest[] = []
    const root = await mkdtemp(join(tmpdir(), 'praxis-permission-retry-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    let turn = 0
    const provider: ModelProvider = {
      capabilities: {
        streaming: true,
        usage: true,
        tools: false,
        contextWindowTokens: 200_000,
      },
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
      { role: 'user', content: 'start' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'Permission retry approved for: Delete target' },
    ])
    const messages = nativeMessages(
      await readNativeEvents(
        resolveDataPlanePaths({
          dataPlane: 'native',
          root: configRoot,
          cwd,
          sessionId: run.sessionId,
        }).sessionFile,
      ),
    )
    expect(messages).toContainEqual({
      role: 'user',
      content: 'Permission retry approved for: Delete target',
    })
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
    expect(snapshotB.hasUnknownModelCost).toBe(true)
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
    const projectMemoryExtraction = {
      observe: vi.fn(),
      close: vi.fn(async () => undefined),
    }
    const provider: ModelProvider = {
      model: 'fixture-model',
      capabilities: { streaming: true, usage: true, tools: true },
      async *complete(request) {
        requests.push(request)
        yield { type: 'text-delta', delta: `answer-${requests.length}` }
        yield {
          type: 'usage',
          usage: { inputTokens: 2, outputTokens: 1 },
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
      projectMemoryExtraction,
      eventSink: (event) => events.push(event),
    })

    await expect(
      service.runShell('printf original', undefined, sessionId),
    ).resolves.toMatchObject({ text: '', sessionId })
    await expect(
      service.resumeShell(sessionId, 'printf second'),
    ).resolves.toMatchObject({ text: '', sessionId })
    expect(requests).toHaveLength(0)
    expect(projectMemoryExtraction.observe).toHaveBeenCalledTimes(0)
    await expect(
      service.resume(sessionId, 'ordinary prompt'),
    ).resolves.toMatchObject({
      text: 'answer-1',
      sessionId,
    })
    expect(projectMemoryExtraction.observe).toHaveBeenCalledTimes(1)

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
    expect(JSON.stringify(requests[0]?.messages)).toContain(
      '<bash-input>printf second</bash-input>',
    )

    const sessionFile = resolveDataPlanePaths({
      dataPlane: 'native',
      root: configRoot,
      cwd,
      sessionId,
    }).sessionFile
    const messages = nativeMessages(await readNativeEvents(sessionFile))
    const bashMessages = messages.filter(
      (message) =>
        message.role === 'user' &&
        typeof message.content === 'string' &&
        message.content.startsWith('<bash-'),
    )
    expect(bashMessages.map((message) => message.content)).toEqual([
      '<bash-input>printf original</bash-input>',
      '<bash-stdout>hook-output</bash-stdout><bash-stderr></bash-stderr>',
      '<bash-input>printf second</bash-input>',
      '<bash-stdout>hook-output</bash-stdout><bash-stderr></bash-stderr>',
    ])
    expect(JSON.stringify(messages)).not.toContain('shell_')
    expect(messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: 'answer-1',
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

    const result = await service.runShell('touch denied')
    expect(result.text).toBe('')
    expect(executed).toBe(false)
    expect(requests).toHaveLength(0)
    const sessionFile = resolveNativePaths({
      configDir: configRoot,
      cwd,
      sessionId: result.sessionId,
    }).sessionFile
    expect(await readFile(sessionFile, 'utf8')).toContain(
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
      resolveNativePaths({ configDir: configRoot, cwd, sessionId }).sessionFile,
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
    const planRequest = requests.find((request) =>
      JSON.stringify(request.messages).includes('# Plan mode'),
    )
    expect(planRequest).toBeDefined()
    expect(JSON.stringify(planRequest?.messages)).toContain(planPath)
    await expect(readFile(planPath, 'utf8')).resolves.toBe(
      '# Plan\n\n1. Implement it.\n',
    )
    expect(JSON.stringify(requests.at(-1)?.messages)).not.toContain(
      '# Plan mode',
    )

    const sessionFile = resolveDataPlanePaths({
      dataPlane: 'native',
      root: configRoot,
      cwd,
      sessionId,
    }).sessionFile
    const modes = nativeMessages(await readNativeEvents(sessionFile))
      .filter(
        (message) =>
          message.role === 'user' &&
          typeof message.content === 'string' &&
          message.content.startsWith('/permission-mode '),
      )
      .map((message) =>
        (message.content as string).slice('/permission-mode '.length),
      )
    expect(modes).toContain('plan')
  })

  it('appends an explicit Claude permission mode for an existing session', async () => {
    const { configRoot, cwd, service } = await createService()
    const sessionId = '87878787-8787-4787-8787-878787878787'

    await service.run('start', undefined, sessionId)
    await service.setPermissionMode(sessionId, 'acceptEdits')

    const sessionFile = resolveDataPlanePaths({
      dataPlane: 'native',
      root: configRoot,
      cwd,
      sessionId,
    }).sessionFile
    const modes = nativeMessages(await readNativeEvents(sessionFile)).filter(
      (message) =>
        message.role === 'user' &&
        typeof message.content === 'string' &&
        message.content.startsWith('/permission-mode '),
    )
    expect(modes).toEqual([
      { role: 'user', content: '/permission-mode acceptEdits' },
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
    const events = await readNativeEvents(
      resolveDataPlanePaths({
        dataPlane: 'native',
        root: configRoot,
        cwd,
        sessionId: result.sessionId,
      }).sessionFile,
    )
    const user = events.find(
      (event) =>
        event.kind === 'messages' &&
        nativeMessages([event]).some(
          (message) =>
            message.role === 'user' && message.content === 'create it',
        ),
    )
    expect(
      nativeMessages(events).some(
        (message) => message.role === 'user' && message.content === 'create it',
      ),
    ).toBe(true)
    expect(await service.rewindPoints(result.sessionId)).toEqual([
      expect.objectContaining({
        messageId: user?.id,
        prompt: 'create it',
        fileChanges: [expect.stringMatching(/created\.txt$/u)],
        fileRestoreAvailable: true,
      }),
    ])
    await service.rewindFiles(
      result.sessionId,
      typeof user?.id === 'string' ? user.id : '',
    )
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
    const compactHookInputs: ClaudeHookInput[] = []
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
          expect(JSON.stringify(request.messages)).toContain(
            'MANUAL_COMPACT_FOCUS',
          )
          return {
            summary: 'durable manual summary',
            usage: { inputTokens: 12, outputTokens: 4 },
            durationMs: 25,
            model: 'manual-compact-model',
          }
        },
      },
      hooks: new ClaudeHookRunner({
        cwd,
        settings: [
          {
            path: join(configRoot, 'settings.json'),
            scope: 'user',
            value: {
              hooks: Object.fromEntries(
                ['PreCompact', 'PostCompact'].map((event) => [
                  event,
                  [
                    {
                      matcher: 'manual',
                      hooks: [{ type: 'command', command: event }],
                    },
                  ],
                ]),
              ),
            },
          },
        ],
        executeCommand: async (_command, input) => {
          compactHookInputs.push(input)
          return {
            stdout:
              input.hook_event_name === 'PreCompact'
                ? 'MANUAL_COMPACT_FOCUS'
                : 'MANUAL_COMPACT_DONE',
            stderr: '',
            exitCode: 0,
            durationMs: 1,
          }
        },
      }),
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
    expect(compactHookInputs).toEqual([
      expect.objectContaining({
        hook_event_name: 'PreCompact',
        trigger: 'manual',
        custom_instructions: null,
      }),
      expect.objectContaining({
        hook_event_name: 'PostCompact',
        trigger: 'manual',
        compact_summary: 'durable manual summary',
      }),
    ])

    const transcript = await readFile(
      resolveNativePaths({
        configDir: configRoot,
        cwd,
        sessionId: run.sessionId,
      }).sessionFile,
      'utf8',
    )
    expect(transcript).not.toContain('MANUAL_COMPACT')
    expect(transcript).toContain('"trigger":"manual"')
    const nativeEvents = await readNativeEvents(
      nativeSessionFile(configRoot, cwd, run.sessionId),
    )
    expect(nativeEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'context-boundary',
          trigger: 'manual',
        }),
        expect.objectContaining({
          kind: 'context-summary',
          summary: 'durable manual summary',
        }),
      ]),
    )
    expect(transcript).toContain('durable manual summary')
  })

  it('anchors manual compact on the session memory watermark and preserves a recent suffix', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-memory-compact-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const summarizedRequests: string[] = []
    let calls = 0
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: {
        capabilities: {
          streaming: true,
          usage: true,
          tools: false,
          contextWindowTokens: 200_000,
        },
        async *complete() {
          const call = calls++
          if (call === 0) {
            yield { type: 'text-delta', delta: 'first answer' }
            yield {
              type: 'usage',
              usage: { inputTokens: 12_000, outputTokens: 50 },
            }
            return
          }
          if (call === 1) {
            yield {
              type: 'text-delta',
              delta: `second answer ${'x'.repeat(16_000)}`,
            }
          } else if (call === 2) {
            yield {
              type: 'text-delta',
              delta: `third answer ${'x'.repeat(16_000)}`,
            }
          } else if (call === 3) {
            yield {
              type: 'text-delta',
              delta: `fourth answer ${'x'.repeat(16_000)}`,
            }
          } else if (call === 4) {
            yield {
              type: 'text-delta',
              delta: `fifth answer ${'x'.repeat(16_000)}`,
            }
          } else {
            yield {
              type: 'text-delta',
              delta: `sixth answer ${'x'.repeat(16_000)}`,
            }
          }
          yield {
            type: 'usage',
            usage: { inputTokens: 200, outputTokens: 20 },
          }
        },
      },
      sessionMemoryProviderFactory: () => ({
        capabilities: { streaming: true, usage: true, tools: false },
        async *complete() {
          yield { type: 'text-delta', delta: 'DURABLE_MEMORY_ARTIFACT' }
          yield {
            type: 'usage',
            usage: { inputTokens: 10, outputTokens: 5 },
          }
        },
      }),
      compactor: {
        async compact(request) {
          summarizedRequests.push(JSON.stringify(request.messages))
          return {
            summary: 'MEMORY_COMPACT_SUMMARY',
            usage: { inputTokens: 5, outputTokens: 3 },
            durationMs: 7,
            model: 'memory-compact-model',
          }
        },
      },
    })

    const run = await service.run('first task')
    await waitForSessionMemoryCommit(configRoot, 'praxis', run.sessionId)
    await service.resume(run.sessionId, 'second task')
    await service.resume(run.sessionId, 'third task')
    await service.resume(run.sessionId, 'fourth task')
    await service.resume(run.sessionId, 'fifth task')
    await service.resume(run.sessionId, 'sixth task')

    await service.compact(run.sessionId)

    // The compactor input leads with the durable memory artifact and folds the
    // post-watermark branch up to the preserved suffix; it never reaches back
    // before the watermark or into the retained suffix.
    const input = summarizedRequests[0]
    expect(input).toContain('DURABLE_MEMORY_ARTIFACT')
    expect(input).toContain('second task')
    expect(input).toContain('third task')
    expect(input).toContain('fourth task')
    expect(input).not.toContain('first task')
    expect(input).not.toContain('fifth task')

    // The recent suffix stays visible verbatim after the compact boundary.
    const display = await service.transcript(run.sessionId)
    expect(display).toEqual(
      expect.arrayContaining([
        { kind: 'compact', summary: 'MEMORY_COMPACT_SUMMARY' },
        { kind: 'user', text: 'fifth task' },
        { kind: 'user', text: 'sixth task' },
      ]),
    )
    expect(JSON.stringify(display)).not.toContain('first task')
    expect(JSON.stringify(display)).not.toContain('second task')

    // The boundary records the preserved suffix so the active transcript can
    // expand it back on the next selection.
    const events = await readNativeEvents(
      nativeSessionFile(configRoot, cwd, run.sessionId),
    )
    const boundary = events.find((event) => event.kind === 'context-boundary')
    expect(boundary).toEqual(expect.objectContaining({ trigger: 'manual' }))
    expect(boundary?.logicalParentId).toEqual(expect.any(String))
  })

  it('uses the memory watermark and preserves a recent suffix during automatic compact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-memory-auto-compact-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    let turn = 0
    const writer = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      enableSessionMemory: false,
      autoCompact: false,
      provider: {
        capabilities: {
          streaming: true,
          usage: true,
          tools: false,
          contextWindowTokens: 200_000,
        },
        async *complete() {
          turn += 1
          yield {
            type: 'text-delta',
            delta: `answer ${turn} ${'x'.repeat(16_000)}`,
          }
          yield {
            type: 'usage',
            usage: { inputTokens: 100, outputTokens: 10 },
          }
        },
      },
    })
    const run = await writer.run('first task')
    for (const prompt of [
      'second task',
      'third task',
      'fourth task',
      'fifth task',
      'sixth task',
    ]) {
      await writer.resume(run.sessionId, prompt)
    }
    await writer.close()

    const sessionFile = nativeSessionFile(configRoot, cwd, run.sessionId)
    const transcriptEntries = await readNativeEvents(sessionFile)
    const watermark = transcriptEntries
      .filter((entry) => entry.kind === 'messages')
      .at(-1)?.id as string | undefined
    if (!watermark) throw new Error('fixture assistant watermark missing')
    const memoryDir = join(configRoot, 'state', 'session-memory', run.sessionId)
    await mkdir(memoryDir, { recursive: true })
    await writeFile(
      join(memoryDir, 'state.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        initialized: true,
        lastObservedTokens: 12_000,
        lastObservedToolCalls: 0,
        lastSummarizedMessageId: watermark,
        extractionStartedAt: null,
        extractionCompletedAt: 1,
        extractionError: null,
      })}\n`,
    )
    await writeFile(join(memoryDir, 'summary.md'), 'AUTO_MEMORY_MARKER')

    const compactInputs: string[] = []
    const reader = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      contextReserveTokens: 2_000,
      provider: {
        model: 'foreground-model',
        capabilities: {
          streaming: true,
          usage: true,
          tools: false,
          contextWindowTokens: 18_000,
        },
        async *complete() {
          yield { type: 'text-delta', delta: 'seventh answer' }
          yield {
            type: 'usage',
            usage: { inputTokens: 100, outputTokens: 10 },
          }
        },
      },
      sessionMemoryProviderFactory: () => queuedProvider(['updated memory']),
      compactor: {
        async compact(request) {
          compactInputs.push(JSON.stringify(request.messages))
          return {
            summary: 'AUTO_MEMORY_COMPACT_SUMMARY',
            usage: { inputTokens: 5, outputTokens: 3 },
            durationMs: 1,
            model: 'compact-model',
          }
        },
      },
    })

    await reader.resume(run.sessionId, 'seventh task')
    expect(compactInputs).toHaveLength(1)
    expect(compactInputs[0]).toContain('AUTO_MEMORY_MARKER')
    expect(compactInputs[0]).toContain('second task')
    expect(compactInputs[0]).not.toContain('first task')
    expect(compactInputs[0]).not.toContain('sixth task')
    expect(await reader.transcript(run.sessionId)).toEqual(
      expect.arrayContaining([
        { kind: 'compact', summary: 'AUTO_MEMORY_COMPACT_SUMMARY' },
        { kind: 'user', text: 'sixth task' },
        { kind: 'user', text: 'seventh task' },
      ]),
    )
    await reader.close()
  })

  it('falls back to full manual compaction when the memory watermark is stale', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-memory-stale-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const sessionId = '66666666-6666-4666-8666-666666666666'
    // Pre-seed a stale watermark before the controller loads state so the
    // sidecar is authoritative when the session memory controller first reads.
    const memoryDir = join(configRoot, 'state', 'session-memory', sessionId)
    await mkdir(memoryDir, { recursive: true })
    await writeFile(
      join(memoryDir, 'state.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          initialized: true,
          lastObservedTokens: 0,
          lastObservedToolCalls: 0,
          lastSummarizedMessageId: 'stale-message-uuid',
          extractionStartedAt: null,
          extractionCompletedAt: 1_234_567,
          extractionError: null,
        },
        null,
        2,
      )}\n`,
    )
    await writeFile(join(memoryDir, 'summary.md'), 'STALE_MEMORY_ARTIFACT')
    const summarizedRequests: string[] = []
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: {
        capabilities: {
          streaming: true,
          usage: true,
          tools: false,
          contextWindowTokens: 200_000,
        },
        async *complete() {
          yield { type: 'text-delta', delta: 'plain answer' }
          yield {
            type: 'usage',
            usage: { inputTokens: 10, outputTokens: 5 },
          }
        },
      },
      sessionMemoryProviderFactory: () => queuedProvider([]),
      compactor: {
        async compact(request) {
          summarizedRequests.push(JSON.stringify(request.messages))
          return {
            summary: 'FULL_COMPACT_SUMMARY',
            usage: { inputTokens: 6, outputTokens: 4 },
            durationMs: 8,
            model: 'memory-compact-model',
          }
        },
      },
    })

    const run = await service.run('first task', undefined, sessionId)
    await service.resume(run.sessionId, 'second task')
    await service.resume(run.sessionId, 'third task')

    await service.compact(run.sessionId)

    // No watermark matches any active entry, so compaction keeps the existing
    // full-transcript behavior: every message folds in and nothing leads with
    // the stale memory artifact.
    expect(summarizedRequests[0]).toContain('first task')
    expect(summarizedRequests[0]).toContain('second task')
    expect(summarizedRequests[0]).not.toContain('STALE_MEMORY_ARTIFACT')
    expect(await service.transcript(run.sessionId)).toEqual([
      { kind: 'compact', summary: 'FULL_COMPACT_SUMMARY' },
    ])
  })

  it('falls back to full compact when the complete memory projection exceeds 40K tokens', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-memory-oversized-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    let turns = 0
    const writer = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      enableSessionMemory: false,
      provider: {
        capabilities: { streaming: true, usage: true, tools: false },
        async *complete() {
          turns += 1
          yield {
            type: 'text-delta',
            delta: `answer ${turns} ${'x'.repeat(60_000)}`,
          }
          yield {
            type: 'usage',
            usage: { inputTokens: 100, outputTokens: 10 },
          }
        },
      },
    })
    const run = await writer.run('first task')
    for (const prompt of [
      'second task',
      'third task',
      'fourth task',
      'fifth task',
      'sixth task',
    ]) {
      await writer.resume(run.sessionId, prompt)
    }
    await writer.close()

    const sessionFile = nativeSessionFile(configRoot, cwd, run.sessionId)
    const entries = await readNativeEvents(sessionFile)
    const watermark = entries
      .filter((entry) => entry.kind === 'messages')
      .at(-1)?.id as string | undefined
    if (!watermark) throw new Error('fixture assistant watermark missing')
    const memoryDir = join(configRoot, 'state', 'session-memory', run.sessionId)
    await mkdir(memoryDir, { recursive: true })
    await writeFile(
      join(memoryDir, 'state.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        initialized: true,
        lastObservedTokens: 12_000,
        lastObservedToolCalls: 0,
        lastSummarizedMessageId: watermark,
        extractionStartedAt: null,
        extractionCompletedAt: 1,
        extractionError: null,
      })}\n`,
    )
    await writeFile(join(memoryDir, 'summary.md'), 'MEMORY_ONLY_MARKER')

    const compactInputs: string[] = []
    const reader = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: queuedProvider([]),
      sessionMemoryProviderFactory: () => queuedProvider([]),
      compactor: {
        async compact(request) {
          compactInputs.push(JSON.stringify(request.messages))
          return {
            summary: 'FULL_OVERSIZED_SUMMARY',
            usage: { inputTokens: 1, outputTokens: 1 },
            durationMs: 1,
            model: 'compact-model',
          }
        },
      },
    })

    await reader.compact(run.sessionId)
    expect(compactInputs[0]).toContain('first task')
    expect(compactInputs[0]).not.toContain('MEMORY_ONLY_MARKER')
    await reader.close()
  })

  it('does not reach behind the latest prior compact boundary during memory selection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-memory-prior-compact-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    let turn = 0
    const writer = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      enableSessionMemory: false,
      provider: {
        capabilities: { streaming: true, usage: true, tools: false },
        async *complete() {
          turn += 1
          yield {
            type: 'text-delta',
            delta:
              turn <= 2
                ? `pre-compact answer ${turn}`
                : `post-compact answer ${turn} ${'x'.repeat(16_000)}`,
          }
          yield {
            type: 'usage',
            usage: { inputTokens: 100, outputTokens: 10 },
          }
        },
      },
      compactor: {
        async compact() {
          return {
            summary: 'PRIOR_COMPACT_MARKER',
            usage: { inputTokens: 1, outputTokens: 1 },
            durationMs: 1,
            model: 'compact-model',
          }
        },
      },
    })
    const run = await writer.run('first task')
    await writer.resume(run.sessionId, 'second task')
    const sessionFile = nativeSessionFile(configRoot, cwd, run.sessionId)
    await writer.compact(run.sessionId)
    const compactEntries = await readNativeEvents(sessionFile)
    const compactWatermark = compactEntries.find(
      (entry) => entry.kind === 'context-summary',
    )?.id as string | undefined
    if (!compactWatermark) throw new Error('fixture compact watermark missing')
    for (const prompt of [
      'third task',
      'fourth task',
      'fifth task',
      'sixth task',
    ]) {
      await writer.resume(run.sessionId, prompt)
    }
    await writer.close()

    const memoryDir = join(configRoot, 'state', 'session-memory', run.sessionId)
    await mkdir(memoryDir, { recursive: true })
    await writeFile(
      join(memoryDir, 'state.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        initialized: true,
        lastObservedTokens: 12_000,
        lastObservedToolCalls: 0,
        lastSummarizedMessageId: compactWatermark,
        extractionStartedAt: null,
        extractionCompletedAt: 1,
        extractionError: null,
      })}\n`,
    )
    await writeFile(join(memoryDir, 'summary.md'), 'MEMORY_BEFORE_COMPACT')

    const compactInputs: string[] = []
    const reader = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: queuedProvider([]),
      sessionMemoryProviderFactory: () => queuedProvider([]),
      compactor: {
        async compact(request) {
          compactInputs.push(JSON.stringify(request.messages))
          return {
            summary: 'SECOND_COMPACT',
            usage: { inputTokens: 1, outputTokens: 1 },
            durationMs: 1,
            model: 'compact-model',
          }
        },
      },
    })

    await reader.compact(run.sessionId)
    expect(compactInputs[0]).toContain('MEMORY_BEFORE_COMPACT')
    expect(compactInputs[0]).not.toContain('PRIOR_COMPACT_MARKER')
    expect(compactInputs[0]).not.toContain('first task')
    expect(compactInputs[0]).not.toContain('pre-compact answer')
    await reader.close()
  })

  it('keeps a preserved tool_use/tool_result pair adjacent at the memory-compact boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-memory-tool-pair-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const summarizedRequests: string[] = []
    let calls = 0
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: {
        capabilities: {
          streaming: true,
          usage: true,
          tools: true,
          contextWindowTokens: 200_000,
        },
        async *complete() {
          const call = calls++
          if (call === 0) {
            yield { type: 'text-delta', delta: 'first answer' }
            yield {
              type: 'usage',
              usage: { inputTokens: 12_000, outputTokens: 50 },
            }
            return
          }
          if (call === 1) {
            yield {
              type: 'thinking-start',
              block: { type: 'thinking', thinking: '' },
            }
            yield { type: 'thinking-delta', delta: 'PAIR_THINKING_MARKER' }
            yield { type: 'thinking-signature-delta', delta: 'signed-pair' }
            yield {
              type: 'thinking-stop',
              block: {
                type: 'thinking',
                thinking: 'PAIR_THINKING_MARKER',
                signature: 'signed-pair',
              },
            }
            yield {
              type: 'tool-call',
              call: { id: 'call_test_tool', name: 'test_tool', input: {} },
            }
            return
          }
          if (call === 2) {
            yield { type: 'text-delta', delta: 'tool call answer' }
            yield {
              type: 'usage',
              usage: { inputTokens: 100, outputTokens: 20 },
            }
            return
          }
          if (call === 3) {
            yield {
              type: 'text-delta',
              delta: `third answer ${'x'.repeat(7_532)}`,
            }
          } else if (call === 4) {
            yield {
              type: 'text-delta',
              delta: `fourth answer ${'x'.repeat(10_000)}`,
            }
          } else if (call === 5) {
            yield {
              type: 'text-delta',
              delta: `fifth answer ${'x'.repeat(10_000)}`,
            }
          } else {
            yield {
              type: 'text-delta',
              delta: `sixth answer ${'x'.repeat(12_000)}`,
            }
          }
          yield {
            type: 'usage',
            usage: { inputTokens: 100, outputTokens: 20 },
          }
        },
      },
      sessionMemoryProviderFactory: () => ({
        capabilities: { streaming: true, usage: true, tools: false },
        async *complete() {
          yield { type: 'text-delta', delta: 'DURABLE_MEMORY_ARTIFACT' }
          yield {
            type: 'usage',
            usage: { inputTokens: 10, outputTokens: 5 },
          }
        },
      }),
      tools: {
        definitions: () => [
          {
            name: 'test_tool',
            description: 'Test tool',
            inputSchema: { type: 'object' },
          },
        ],
        async prepare(call) {
          return call
        },
        async execute() {
          return { content: 'tool result text', isError: false }
        },
      },
      permissions: { resolve: () => ({ behavior: 'allow' as const }) },
      compactor: {
        async compact(request) {
          summarizedRequests.push(JSON.stringify(request.messages))
          return {
            summary: 'MEMORY_COMPACT_SUMMARY',
            usage: { inputTokens: 5, outputTokens: 3 },
            durationMs: 7,
            model: 'memory-compact-model',
          }
        },
      },
    })

    const run = await service.run('first task')
    await waitForSessionMemoryCommit(configRoot, 'praxis', run.sessionId)
    await service.resume(run.sessionId, 'second task')
    await service.resume(run.sessionId, 'third task')
    await service.resume(run.sessionId, 'fourth task')
    await service.resume(run.sessionId, 'fifth task')
    await service.resume(run.sessionId, 'sixth task')

    await service.compact(run.sessionId)

    // The suffix boundary walked back onto the tool_result user entry, so the
    // boundary extends to the matching tool_use assistant instead of leaving an
    // orphaned pair: neither half reaches the compactor input.
    const input = summarizedRequests[0]
    expect(input).toContain('DURABLE_MEMORY_ARTIFACT')
    expect(input).toContain('second task')
    expect(input).not.toContain('first task')
    expect(input).not.toContain('call_test_tool')
    expect(input).not.toContain('tool result text')
    expect(input).not.toContain('PAIR_THINKING_MARKER')

    const debugEvents = await readNativeEvents(
      nativeSessionFile(configRoot, cwd, run.sessionId),
    )
    const messageEvents = debugEvents.flatMap((event) => {
      if (event.kind !== 'messages' || !Array.isArray(event.messages)) return []
      return [
        {
          event,
          messages: event.messages as ModelMessage[],
        },
      ]
    })
    const toolEventIndex = messageEvents.findIndex(({ messages }) =>
      messages.some(
        (message) =>
          message.role === 'assistant' &&
          message.toolCalls?.some((call) => call.name === 'test_tool'),
      ),
    )
    expect(toolEventIndex).toBeGreaterThanOrEqual(0)
    const toolEvent = messageEvents[toolEventIndex]
    expect(toolEvent).toBeDefined()
    if (!toolEvent) throw new Error('expected tool event')
    const assistant = toolEvent.messages.find(
      (message) => message.role === 'assistant',
    )
    if (assistant?.role !== 'assistant') throw new Error('expected assistant')
    expect(
      assistant.thinkingBlocks?.find((block) => block.type === 'thinking')
        ?.thinking,
    ).toBe('PAIR_THINKING_MARKER')
    const toolCall = assistant.toolCalls?.find(
      (call) => call.name === 'test_tool',
    )
    expect(toolCall).toBeDefined()
    if (!toolCall) throw new Error('expected tool call')
    const resultEvent = messageEvents.find(({ messages }) =>
      messages.some(
        (message) =>
          message.role === 'tool' && message.content === 'tool result text',
      ),
    )
    expect(resultEvent).toBeDefined()
    if (!resultEvent) throw new Error('expected result event')
    expect(resultEvent.messages).toContainEqual({
      role: 'tool',
      toolCallId: toolCall.id,
      content: 'tool result text',
      isError: false,
    })
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
    const events: RuntimeEvent[] = []
    const requests: ModelRequest[] = []
    const provider: ModelProvider = {
      model: 'reactive-model',
      capabilities: {
        streaming: true,
        usage: true,
        tools: false,
        terminalReasons: true,
        contextWindowTokens: 200_000,
      },
      async *complete(request) {
        requests.push(request)
        completions += 1
        if (completions === 1) {
          yield {
            type: 'text-delta',
            delta: `old context ${'discarded '.repeat(600)}`,
          }
          yield { type: 'terminal', reason: 'end_turn' }
          return
        }
        if (completions === 2) {
          yield { type: 'text-delta', delta: 'discarded partial answer' }
          yield {
            type: 'usage',
            usage: { inputTokens: 90, outputTokens: 9 },
          }
          yield { type: 'terminal', reason: 'prompt_too_long' }
          return
        }
        yield { type: 'text-delta', delta: 'recovered answer' }
        yield { type: 'usage', usage: { inputTokens: 4, outputTokens: 2 } }
        yield { type: 'terminal', reason: 'end_turn' }
      },
    }
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

    const first = await service.run('seed old context')
    const result = await service.resume(first.sessionId, 'continue')

    expect(result.text).toBe('recovered answer')
    expect(result.usage).toEqual({ inputTokens: 4, outputTokens: 2 })
    expect(
      (await service.costSnapshot(result.sessionId)).modelUsage[
        'reactive-model'
      ],
    ).toMatchObject({ inputTokens: 4, outputTokens: 2 })
    expect(
      (await service.export(result.sessionId))
        .toString('utf8')
        .match(/recovered answer/gu),
    ).toHaveLength(1)
    // One reactive compaction retry, then a clean second attempt.
    expect(completions).toBe(3)
    expect(JSON.stringify(requests[2])).not.toContain('old context')
    expect(events.filter((event) => event.type === 'failed')).toEqual([])
    const discardedIndex = events.findIndex(
      (event) => event.type === 'model-attempt-discarded',
    )
    expect(discardedIndex).toBeGreaterThan(
      events.findIndex(
        (event) =>
          event.type === 'text-delta' &&
          event.delta === 'discarded partial answer',
      ),
    )
    expect(discardedIndex).toBeGreaterThan(
      events.findIndex(
        (event) =>
          event.type === 'terminal' && event.reason === 'prompt_too_long',
      ),
    )
    expect(
      events.findIndex(
        (event) =>
          event.type === 'text-delta' && event.delta === 'recovered answer',
      ),
    ).toBeGreaterThan(discardedIndex)
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
    const events: RuntimeEvent[] = []
    const provider: ModelProvider = {
      model: 'reactive-model',
      capabilities: {
        streaming: true,
        usage: true,
        tools: false,
        terminalReasons: true,
        contextWindowTokens: 200_000,
      },
      async *complete() {
        completions += 1
        if (completions === 1) {
          yield {
            type: 'text-delta',
            delta: `old context ${'discarded '.repeat(600)}`,
          }
          yield { type: 'terminal', reason: 'end_turn' }
          return
        }
        yield { type: 'terminal', reason: 'prompt_too_long' }
      },
    }
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

    const first = await service.run('seed old context')
    await expect(service.resume(first.sessionId, 'continue')).rejects.toThrow(
      'active prompt exceeds its context window',
    )
    // The retry is attempted exactly once before the original error surfaces.
    expect(completions).toBe(3)
    expect(events.filter((event) => event.type === 'failed')).toEqual([
      expect.objectContaining({
        type: 'failed',
        message: expect.stringContaining('active prompt exceeds'),
      }),
    ])
  })

  it('keeps retry provider failures private and surfaces the original prompt-too-long once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-reactive-retry-error-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    let completions = 0
    const events: RuntimeEvent[] = []
    const provider: ModelProvider = {
      model: 'reactive-model',
      capabilities: {
        streaming: true,
        usage: true,
        tools: false,
        terminalReasons: true,
        contextWindowTokens: 200_000,
      },
      async *complete() {
        completions += 1
        if (completions === 1) {
          yield {
            type: 'text-delta',
            delta: `old context ${'discarded '.repeat(600)}`,
          }
          yield { type: 'terminal', reason: 'end_turn' }
          return
        }
        if (completions === 2) {
          yield { type: 'terminal', reason: 'prompt_too_long' }
          return
        }
        yield { type: 'text-delta', delta: 'discarded retry partial' }
        yield { type: 'usage', usage: { inputTokens: 70, outputTokens: 7 } }
        throw new ModelProviderError('retry provider overloaded', {
          kind: 'overloaded',
          retryable: true,
        })
      },
    }
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

    const first = await service.run('seed old context')
    await expect(service.resume(first.sessionId, 'continue')).rejects.toThrow(
      'active prompt exceeds its context window',
    )
    expect(completions).toBe(3)
    expect(events).toContainEqual({
      type: 'model-attempt-discarded',
      reason: 'overloaded',
    })
    expect(events.filter((event) => event.type === 'failed')).toEqual([
      expect.objectContaining({
        type: 'failed',
        message: expect.stringContaining('active prompt exceeds'),
      }),
    ])
  })

  it('does not retry when reactive compaction makes no occupancy progress', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-reactive-no-progress-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    let completions = 0
    const events: RuntimeEvent[] = []
    const provider: ModelProvider = {
      model: 'reactive-model',
      capabilities: {
        streaming: true,
        usage: true,
        tools: false,
        terminalReasons: true,
        contextWindowTokens: 200_000,
      },
      async *complete() {
        completions += 1
        if (completions === 1) {
          yield {
            type: 'text-delta',
            delta: `old context ${'discarded '.repeat(100)}`,
          }
          yield { type: 'terminal', reason: 'end_turn' }
          return
        }
        yield { type: 'terminal', reason: 'prompt_too_long' }
      },
    }
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider,
      eventSink: (event) => events.push(event),
      compactor: {
        async compact() {
          return {
            summary: `no progress ${'expanded '.repeat(1_000)}`,
            usage: { inputTokens: 0, outputTokens: 0 },
            durationMs: 1,
            model: 'reactive-model',
          }
        },
      },
    })

    const first = await service.run('seed old context')
    await expect(service.resume(first.sessionId, 'continue')).rejects.toThrow(
      'active prompt exceeds its context window',
    )
    expect(completions).toBe(2)
    const exported = (await service.export(first.sessionId)).toString('utf8')
    expect(exported).not.toContain('no progress')
    expect(exported.toString()).not.toContain('"kind":"context-boundary"')
    expect(events.filter((event) => event.type === 'failed')).toEqual([
      expect.objectContaining({
        type: 'failed',
        message: expect.stringContaining('active prompt exceeds'),
      }),
    ])
  })

  it.each(['compaction', 'retry'] as const)(
    'surfaces cancellation during reactive %s without further work',
    async (cancelStage) => {
      const root = await mkdtemp(join(tmpdir(), 'praxis-reactive-cancel-'))
      roots.push(root)
      const configRoot = join(root, 'config')
      const cwd = join(root, 'project')
      const controller = new AbortController()
      let completions = 0
      const events: RuntimeEvent[] = []
      const provider: ModelProvider = {
        model: 'reactive-model',
        capabilities: {
          streaming: true,
          usage: true,
          tools: false,
          terminalReasons: true,
          contextWindowTokens: 200_000,
        },
        async *complete() {
          completions += 1
          if (completions === 1) {
            yield {
              type: 'text-delta',
              delta: `old context ${'discarded '.repeat(600)}`,
            }
            yield { type: 'terminal', reason: 'end_turn' }
            return
          }
          if (completions === 2) {
            yield { type: 'terminal', reason: 'prompt_too_long' }
            return
          }
          controller.abort()
          throw new AgentRunCancelledError()
        },
      }
      const service = new ClaudeSessionService({
        configRoot,
        cwd,
        claudeVersion: '2.1.208',
        provider,
        eventSink: (event) => events.push(event),
        compactor: {
          async compact() {
            if (cancelStage === 'compaction') controller.abort()
            return {
              summary: 'CANCELLED_REACTIVE_SUMMARY',
              usage: { inputTokens: 0, outputTokens: 0 },
              durationMs: 1,
              model: 'reactive-model',
            }
          },
        },
      })

      const first = await service.run('seed old context')
      await expect(
        service.resume(first.sessionId, 'continue', controller.signal),
      ).rejects.toBeInstanceOf(AgentRunCancelledError)
      expect(completions).toBe(cancelStage === 'compaction' ? 2 : 3)
      expect(events.filter((event) => event.type === 'failed')).toEqual([])
    },
  )

  it('injects the last committed session memory artifact on resume', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-session-memory-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const requests: ModelRequest[] = []
    let calls = 0
    const provider: ModelProvider = {
      model: 'foreground-model',
      capabilities: {
        streaming: true,
        usage: true,
        tools: false,
        contextWindowTokens: 200_000,
      },
      async *complete(request) {
        requests.push(request)
        const call = calls++
        if (call === 0) {
          // Initial foreground turn before the committed sidecar is present.
          yield {
            type: 'text-delta',
            delta: 'initial answer',
          }
          yield {
            type: 'usage',
            usage: { inputTokens: 100, outputTokens: 50 },
          }
          return
        }
        // Resume after reopening the service with committed memory.
        yield { type: 'text-delta', delta: 'resumed answer' }
        yield {
          type: 'usage',
          usage: { inputTokens: 100, outputTokens: 1 },
        }
      },
    }
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider,
      sessionMemoryProviderFactory: () => queuedProvider([]),
      collectMetrics: true,
    })

    const run = await service.run('first task')
    expect(run.text.startsWith('initial')).toBe(true)
    const transcriptPath = nativeSessionFile(configRoot, cwd, run.sessionId)
    const transcript = await readFile(transcriptPath, 'utf8')
    expect(transcript).not.toContain('# Session Memory')
    const watermark = (await readNativeEvents(transcriptPath))
      .filter((entry) => entry.kind === 'messages')
      .at(-1)?.id as string | undefined
    if (!watermark) throw new Error('fixture assistant watermark missing')
    const store = new SessionMemoryStore({
      configRoot,
      sessionId: run.sessionId,
      sidecarRoot: join(configRoot, 'state'),
    })
    await store.commitExtraction(
      {
        schemaVersion: 1,
        initialized: true,
        lastObservedTokens: 100,
        lastObservedToolCalls: 0,
        lastSummarizedMessageId: watermark,
        extractionStartedAt: null,
        extractionCompletedAt: 1,
        extractionError: null,
      },
      'Durable intent: initial task.',
    )
    await service.close()
    const reader = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider,
      sessionMemoryProviderFactory: () => queuedProvider([]),
      collectMetrics: true,
    })

    const resumed = await reader.resume(run.sessionId, 'Continue the task.')
    expect(resumed.text).toBe('resumed answer')

    const resumedRequest = requests[1]
    const memorySystemMessage = resumedRequest?.messages.find(
      (message): message is { role: 'system'; content: string } =>
        message.role === 'system' &&
        typeof message.content === 'string' &&
        message.content.includes('# Session Memory'),
    )
    expect(memorySystemMessage?.content).toContain(
      'Durable intent: initial task.',
    )

    await reader.close()

    // A failed extraction leaves the foreground turn successful and records a
    // retryable sidecar error for the next observation.
    const failureRoot = await mkdtemp(
      join(tmpdir(), 'praxis-session-memory-failure-'),
    )
    roots.push(failureRoot)
    const failureConfigRoot = join(failureRoot, 'config')
    const failureCwd = join(failureRoot, 'project')
    const failureEvents: RuntimeEvent[] = []
    const failingProvider: ModelProvider = {
      capabilities: {
        streaming: true,
        usage: true,
        tools: false,
        contextWindowTokens: 200_000,
      },
      async *complete() {
        yield { type: 'text-delta', delta: 'failing turn answer' }
        yield {
          type: 'usage',
          usage: { inputTokens: 12_000, outputTokens: 50 },
        }
      },
    }
    const failureService = new ClaudeSessionService({
      configRoot: failureConfigRoot,
      cwd: failureCwd,
      claudeVersion: '2.1.208',
      provider: failingProvider,
      sessionMemoryProviderFactory: () => ({
        capabilities: { streaming: true, usage: true, tools: false },
        complete() {
          const iterator = {
            async next() {
              throw new ModelProviderError('session-memory provider failed', {
                retryable: true,
              })
            },
            [Symbol.asyncIterator]() {
              return iterator
            },
          }
          return iterator
        },
      }),
      eventSink: (event) => failureEvents.push(event),
    })
    const failedRun = await failureService.run('failing task')
    expect(failedRun.text).toBe('failing turn answer')
    await failureService.resume(failedRun.sessionId, 'second failing task')
    await failureService.resume(failedRun.sessionId, 'third failing task')
    // The extraction failure is surfaced asynchronously through its warning
    // callback and retryable sidecar state.
    await waitForSessionMemoryCommit(
      failureConfigRoot,
      'praxis',
      failedRun.sessionId,
      (state) => state.extractionError !== null,
    )
    expect(
      failureEvents.some(
        (event) =>
          event.type === 'warning' &&
          String(event.message).includes('Session memory'),
      ),
    ).toBe(true)
    const failureState = JSON.parse(
      await readFile(
        join(
          failureConfigRoot,
          'state',
          'session-memory',
          failedRun.sessionId,
          'state.json',
        ),
        'utf8',
      ),
    ) as { extractionError: string | null }
    expect(failureState.extractionError).toContain(
      'session-memory provider failed',
    )
    await failureService.close()
  })

  it('reruns SessionStart with compact source and refreshes runtime context after an automatic compact boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-compact-hook-context-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const requests: ModelRequest[] = []
    let calls = 0
    const provider: ModelProvider = {
      model: 'compact-hook-model',
      capabilities: {
        streaming: true,
        usage: true,
        tools: false,
        contextWindowTokens: 2_500,
      },
      async *complete(request) {
        requests.push(request)
        const call = calls++
        if (call === 0) {
          yield {
            type: 'text-delta',
            delta: `initial ${'discarded '.repeat(600)}`,
          }
          yield {
            type: 'usage',
            usage: { inputTokens: 12_000, outputTokens: 50 },
          }
          return
        }
        // Resume turn after the automatic compact boundary.
        yield { type: 'text-delta', delta: 'final answer' }
        yield {
          type: 'usage',
          usage: { inputTokens: 2, outputTokens: 1 },
        }
      },
    }
    let contextVersion = 0
    const contextInvalidations: string[] = []
    let compactHookCalls = 0
    const hookEvents: string[] = []
    const compactHookInputs: Array<Record<string, unknown>> = []
    let compactorMessages: readonly ModelMessage[] = []
    const hooks = new ClaudeHookRunner({
      cwd,
      settings: [
        {
          path: join(configRoot, 'settings.json'),
          scope: 'user',
          value: {
            hooks: {
              SessionStart: [
                {
                  hooks: [{ type: 'command', command: 'SessionStart' }],
                },
              ],
              PreCompact: [
                {
                  matcher: 'auto',
                  hooks: [{ type: 'command', command: 'PreCompact' }],
                },
              ],
              PostCompact: [
                {
                  matcher: 'auto',
                  hooks: [{ type: 'command', command: 'PostCompact' }],
                },
              ],
            },
          },
        },
      ],
      executeCommand: async (_command, input) => {
        hookEvents.push(input.hook_event_name)
        if (
          input.hook_event_name === 'PreCompact' ||
          input.hook_event_name === 'PostCompact'
        ) {
          compactHookInputs.push(input)
          return {
            stdout:
              input.hook_event_name === 'PreCompact'
                ? 'PRE_COMPACT_FOCUS\n'
                : 'POST_COMPACT_DISPLAY\n',
            stderr: '',
            exitCode: 0,
            durationMs: 1,
          }
        }
        if (input.source === 'compact') {
          compactHookCalls += 1
          return {
            stdout: 'COMPACT_HOOK_CONTEXT\n',
            stderr: '',
            exitCode: 0,
            durationMs: 1,
          }
        }
        return {
          stdout:
            input.source === 'resume'
              ? 'RESUME_HOOK_CONTEXT\n'
              : 'STARTUP_HOOK_CONTEXT\n',
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
      sessionMemoryProviderFactory: () => ({
        model: 'compact-hook-model',
        capabilities: { streaming: true, usage: true, tools: false },
        async *complete() {
          yield { type: 'text-delta', delta: 'Durable intent: initial task.' }
          yield {
            type: 'usage',
            usage: { inputTokens: 10, outputTokens: 20 },
          }
        },
      }),
      hooks,
      contextReserveTokens: 1_500,
      contextAssembler: {
        async assemble(options) {
          contextVersion += 1
          const snapshot = contextSnapshot({
            system: [`SYSTEM_CONTEXT_${contextVersion}`],
            firstUser: `DYNAMIC_CONTEXT_${contextVersion}`,
          })
          const turnSnapshot = await assembleContextSnapshot(undefined, {
            ...(options?.turn === undefined ? {} : { turn: options.turn }),
          })
          return {
            sections: [...snapshot.sections, ...turnSnapshot.sections],
          }
        },
        invalidate({ reason }) {
          contextInvalidations.push(reason)
        },
      },
      compactor: {
        async compact(request) {
          compactorMessages = request.messages
          return {
            summary: 'COMPACTED_SUMMARY',
            usage: { inputTokens: 3, outputTokens: 2 },
            durationMs: 1,
            model: 'compact-hook-model',
          }
        },
      },
    })

    const run = await service.run('first task')
    expect(run.text.startsWith('initial')).toBe(true)

    // The oversized first turn triggers durable session memory extraction;
    // normal turns do not await it, so wait for the controller to drain
    // before reading the sidecar.
    await waitForSessionMemoryCommit(configRoot, 'praxis', run.sessionId)
    const summary = await new SessionMemoryStore({
      configRoot,
      sessionId: run.sessionId,
      sidecarRoot: join(configRoot, 'state'),
    }).loadSummary()
    expect(summary).toContain('Durable intent: initial task.')

    const resumed = await service.resume(run.sessionId, 'Continue the task.')
    expect(resumed.text).toBe('final answer')

    // One successful automatic compact produces exactly one compact-source
    // SessionStart invocation after the single session startup.
    expect(compactHookCalls).toBe(1)
    expect(hookEvents).toEqual([
      'SessionStart',
      'PreCompact',
      'PostCompact',
      'SessionStart',
    ])
    expect(JSON.stringify(compactorMessages)).toContain('PRE_COMPACT_FOCUS')
    expect(compactHookInputs).toEqual([
      expect.objectContaining({
        hook_event_name: 'PreCompact',
        trigger: 'auto',
        custom_instructions: null,
      }),
      expect.objectContaining({
        hook_event_name: 'PostCompact',
        trigger: 'auto',
        compact_summary: 'COMPACTED_SUMMARY',
      }),
    ])

    // The context assembler runs once for the startup turn, once for the
    // resume, and once more after the compact boundary refresh.
    expect(contextVersion).toBe(3)
    expect(contextInvalidations).toEqual(['compact'])
    const postCompactRequest = requests[1]
    expect(
      postCompactRequest?.messages.find(
        (message) =>
          message.role === 'system' &&
          typeof message.content === 'string' &&
          message.content.includes('SYSTEM_CONTEXT_3'),
      ),
    ).toBeDefined()
    expect(JSON.stringify(postCompactRequest?.messages)).toContain(
      'DYNAMIC_CONTEXT_3',
    )
    // The compact-source hook output reaches the post-compact request while
    // the pre-compact runtime context and pre-boundary hook output do not
    // reappear (pre-boundary attachments are compacted away with history).
    expect(JSON.stringify(postCompactRequest?.messages)).toContain(
      'COMPACT_HOOK_CONTEXT',
    )
    expect(JSON.stringify(postCompactRequest?.messages)).not.toContain(
      'RESUME_HOOK_CONTEXT',
    )
    expect(JSON.stringify(postCompactRequest?.messages)).not.toContain(
      'STARTUP_HOOK_CONTEXT',
    )
    expect(JSON.stringify(postCompactRequest?.messages)).not.toContain(
      'SYSTEM_CONTEXT_2',
    )
    expect(
      postCompactRequest?.messages.find(
        (message) =>
          message.role === 'system' &&
          typeof message.content === 'string' &&
          message.content.includes('# Session Memory'),
      )?.content,
    ).toContain('Durable intent: initial task.')

    // Only the existing Claude hook attachment representation is persisted;
    // refreshed runtime-only session memory never becomes a JSONL entry.
    const transcript = await readFile(
      nativeSessionFile(configRoot, cwd, run.sessionId),
      'utf8',
    )
    expect(transcript).toContain('COMPACT_HOOK_CONTEXT')
    expect(transcript).toContain('STARTUP_HOOK_CONTEXT')
    expect(transcript).not.toContain('PRE_COMPACT_FOCUS')
    expect(transcript).not.toContain('POST_COMPACT_DISPLAY')
    expect(transcript).not.toContain('# Session Memory')
    expect(transcript).not.toContain('SYSTEM_CONTEXT')
    expect(transcript).not.toContain('DYNAMIC_CONTEXT')
    const entries = await readNativeEvents(
      nativeSessionFile(configRoot, cwd, run.sessionId),
    )
    expect(nativeMessages(entries).map((message) => message.content)).toEqual(
      expect.arrayContaining(['STARTUP_HOOK_CONTEXT', 'COMPACT_HOOK_CONTEXT']),
    )
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

    await expect(service.compact(sessionId)).rejects.toThrow(
      'inputTokens total must be a safe integer',
    )
    const after = await service.costSnapshot(sessionId)
    expect(after.apiDurationMs).toBe(1000)

    const transcript = await readNativeEvents(
      nativeSessionFile(configRoot, cwd, sessionId),
    )
    expect(transcript.some((event) => event.kind === 'context-boundary')).toBe(
      false,
    )
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
    await expect(service.compact(run.sessionId)).rejects.toThrow(
      'manual summary provider failed',
    )
    const after = await service.costSnapshot(run.sessionId)
    expect(after.apiDurationMs).toBe(0)

    const transcript = await readNativeEvents(
      nativeSessionFile(configRoot, cwd, run.sessionId),
    )
    expect(transcript.some((event) => event.kind === 'context-boundary')).toBe(
      false,
    )
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
    await expect(service.compact(run.sessionId)).rejects.toThrow(
      'compaction durationMs must be a finite nonnegative number',
    )
    const after = await service.costSnapshot(run.sessionId)
    expect(after.apiDurationMs).toBe(0)
    expect(after.apiDurationWithoutRetriesMs).toBe(0)

    const transcript = await readNativeEvents(
      nativeSessionFile(configRoot, cwd, run.sessionId),
    )
    expect(transcript.some((event) => event.kind === 'context-boundary')).toBe(
      false,
    )
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
    await expect(service.compact(run.sessionId)).resolves.toMatchObject({
      summary: 'unattributed summary',
    })
    const after = await service.costSnapshot(run.sessionId)
    expect(after.apiDurationMs).toBe(5)
    expect(after.apiDurationWithoutRetriesMs).toBe(5)

    const transcript = await readNativeEvents(
      nativeSessionFile(configRoot, cwd, run.sessionId),
    )
    expect(transcript.some((event) => event.kind === 'context-boundary')).toBe(
      true,
    )
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

      const transcript = await readNativeEvents(
        nativeSessionFile(configRoot, cwd, run.sessionId),
      )
      expect(
        transcript.some((event) => event.kind === 'context-boundary'),
      ).toBe(false)
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
      'native transcript session is missing or empty',
    )
    load.mockClear()
    save.mockClear()
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
    await expect(service.compact(run.sessionId)).resolves.toMatchObject({
      summary: 'timed unmodeled summary',
    })
    const after = await service.costSnapshot(run.sessionId)
    expect(after.apiDurationMs).toBe(7)
    expect(after.apiDurationWithoutRetriesMs).toBe(7)

    const transcript = await readNativeEvents(
      nativeSessionFile(configRoot, cwd, run.sessionId),
    )
    expect(transcript.some((event) => event.kind === 'context-boundary')).toBe(
      true,
    )
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

    const transcript = await readNativeEvents(
      nativeSessionFile(configRoot, cwd, run.sessionId),
    )
    expect(transcript.some((event) => event.kind === 'context-boundary')).toBe(
      true,
    )
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

    const transcript = await readNativeEvents(
      nativeSessionFile(configRoot, cwd, run.sessionId),
    )
    expect(transcript.some((event) => event.kind === 'context-boundary')).toBe(
      false,
    )
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
    await expect(service.compact(run.sessionId)).rejects.toThrow(
      'Native compact summary must not be blank',
    )
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
      experimentalNativeTranscriptWrites: true,
    })

    const activeTurn = service.run('first writer', undefined, sessionId)
    await started
    try {
      await expect(service.compact(sessionId)).rejects.toThrow(
        'native transcript lease conflict',
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
    const targetSession = resolveNativePaths({
      configDir: join(root, 'config'),
      cwd: canonicalTarget,
      sessionId: run.sessionId,
    }).sessionFile
    await expect(readFile(targetSession, 'utf8')).resolves.toContain(
      '"content":"start in target"',
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
    const source = resolveNativePaths({
      configDir: configRoot,
      cwd: originalCwd,
      sessionId: run.sessionId,
    }).sessionFile
    const target = resolveNativePaths({
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
    const sourcePaths = resolveNativePaths({
      configDir: configRoot,
      cwd: originalCwd,
      sessionId: run.sessionId,
    })
    const targetPaths = resolveNativePaths({
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
      dataPlane: 'native',
      experimentalNativeTranscriptWrites: true,
      provider: queuedProvider(['before usage']),
    })
    const run = await service.run('start here')

    await service.recordCdUsage(run.sessionId)

    const transcript = await readFile(
      resolveDataPlanePaths({
        dataPlane: 'native',
        root: join(root, 'config'),
        cwd: root,
        sessionId: run.sessionId,
      }).sessionFile,
      'utf8',
    )
    const envelopes = transcript
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(
      envelopes.every(
        (entry) => entry.schema === 'praxis.transcript' && entry.version === 1,
      ),
    ).toBe(true)
    expect(envelopes.at(-1)).toMatchObject({
      event: {
        kind: 'messages',
        messages: [
          {
            role: 'user',
            content: expect.stringContaining(
              '<command-name>/cd</command-name>',
            ),
          },
        ],
      },
    })
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
    const sessionFile = resolveNativePaths({
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
    expect(requests[1]?.stableSystemMessageCount).toBe(0)
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
      dataPlane: 'native',
      experimentalNativeTranscriptWrites: true,
      provider: queuedProvider(['main answer']),
    })
    const run = await service.run('start here')

    await service.recordBtwUsage(run.sessionId)

    const transcript = await readFile(
      resolveDataPlanePaths({
        dataPlane: 'native',
        root: join(root, 'config'),
        cwd: root,
        sessionId: run.sessionId,
      }).sessionFile,
      'utf8',
    )
    const envelopes = transcript
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(
      envelopes.every(
        (entry) => entry.schema === 'praxis.transcript' && entry.version === 1,
      ),
    ).toBe(true)
    expect(envelopes.at(-1)).toMatchObject({
      event: {
        kind: 'messages',
        messages: [{ role: 'user', content: '/btw' }],
      },
    })
  })

  it('creates a reusable native session for fresh /btw usage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-session-btw-fresh-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const service = new ClaudeSessionService({
      configRoot,
      cwd: root,
      claudeVersion: '2.1.208',
      dataPlane: 'native',
      experimentalNativeTranscriptWrites: true,
      provider: queuedProvider(['main answer']),
    })

    const sessionId = await service.recordBtwUsage(
      undefined,
      'bypassPermissions',
    )
    const paths = resolveDataPlanePaths({
      dataPlane: 'native',
      root: configRoot,
      cwd: root,
      sessionId,
    })
    const transcript = (await readFile(paths.sessionFile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)

    expect(
      transcript.every(
        (entry) => entry.schema === 'praxis.transcript' && entry.version === 1,
      ),
    ).toBe(true)
    expect(transcript.at(-1)).toMatchObject({
      event: {
        kind: 'messages',
        messages: [{ role: 'user', content: '/btw' }],
      },
    })
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
      dataPlane: 'native',
      experimentalNativeTranscriptWrites: true,
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
        resolveDataPlanePaths({
          dataPlane: 'native',
          root: configRoot,
          cwd: root,
          sessionId,
        }).sessionFile,
        'utf8',
      )
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)

    expect(
      transcript.every(
        (entry) => entry.schema === 'praxis.transcript' && entry.version === 1,
      ),
    ).toBe(true)
    expect(transcript.at(-1)).toMatchObject({
      event: {
        kind: 'messages',
        messages: [
          { role: 'user', content: '/color purple' },
          {
            role: 'user',
            content: '<praxis-agent-color>purple</praxis-agent-color>',
          },
        ],
      },
    })
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

    const transcript = await readNativeEvents(
      nativeSessionFile(configRoot, cwd, run.sessionId),
    )
    const colorMessages = nativeMessages(transcript)
      .map((message) => message.content)
      .filter((content): content is string => typeof content === 'string')
      .filter((content) => content.startsWith('<praxis-agent-color>'))
    expect(colorMessages).toEqual([
      '<praxis-agent-color>cyan</praxis-agent-color>',
      '<praxis-agent-color>yellow</praxis-agent-color>',
      '<praxis-agent-color>default</praxis-agent-color>',
    ])
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
    const transcript = await readNativeEvents(
      nativeSessionFile(configRoot, root, sessionId),
    )
    expect(
      nativeMessages(transcript).some((message) =>
        String(message.content).startsWith('<praxis-agent-color>'),
      ),
    ).toBe(false)
    expect(nativeMessages(transcript).at(-1)).toMatchObject({
      role: 'user',
      content: '/color bogus',
    })
    await expect(service.readEffectiveAgentColor(sessionId)).resolves.toBe(
      undefined,
    )
    await expect(
      readFile(join(configRoot, 'history.jsonl'), 'utf8'),
    ).rejects.toMatchObject({
      code: 'ENOENT',
    })
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
    ).rejects.toMatchObject({
      code: 'ENOENT',
    })
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
    const transcript = await readNativeEvents(
      nativeSessionFile(configRoot, cwd, sessionId),
    )
    expect(nativeMessages(transcript).slice(0, 3)).toEqual([
      { role: 'user', content: 'session color: purple' },
      { role: 'user', content: '/color purple' },
      {
        role: 'user',
        content: '<praxis-agent-color>purple</praxis-agent-color>',
      },
    ])
    await expect(
      readFile(join(configRoot, 'history.jsonl'), 'utf8'),
    ).rejects.toMatchObject({
      code: 'ENOENT',
    })

    await service.recordColorUsage(
      active,
      { kind: 'color', color: 'cyan' },
      '/color cyan',
    )
    const afterSecond = await readNativeEvents(
      nativeSessionFile(configRoot, cwd, sessionId),
    )
    expect(
      nativeMessages(afterSecond)
        .filter((message) =>
          String(message.content).startsWith('<praxis-agent-color>'),
        )
        .map((message) => message.content),
    ).toEqual([
      '<praxis-agent-color>purple</praxis-agent-color>',
      '<praxis-agent-color>cyan</praxis-agent-color>',
    ])
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
    const transcript = await readNativeEvents(
      nativeSessionFile(configRoot, root, sessionId),
    )
    expect(
      nativeMessages(transcript).some((message) =>
        String(message.content).startsWith('<praxis-agent-color>'),
      ),
    ).toBe(false)
    expect(nativeMessages(transcript).at(-1)).toMatchObject({
      role: 'user',
      content: '/color bogus',
    })
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
    ).rejects.toThrow('native transcript session is missing or empty')
    await expect(
      readFile(nativeSessionFile(configRoot, root, missingId), 'utf8'),
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
    ).rejects.toThrow('native transcript session already exists')
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
    const paths = resolveDataPlanePaths({
      dataPlane: 'native',
      root: configRoot,
      cwd,
      sessionId,
    })
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
    const transcript = await readNativeEvents(
      nativeSessionFile(configRoot, root, sessionId),
    )
    expect(transcript.every((event) => event.kind === 'messages')).toBe(true)
    expect(nativeMessages(transcript).at(-1)).toMatchObject({
      role: 'user',
      content: '/background',
    })
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
    const sessionFile = nativeSessionFile(configRoot, root, run.sessionId)

    await expect(
      service.recordBackgroundLaunch(run.sessionId),
    ).resolves.toMatchObject({
      resumeSessionAt: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      entryCount: expect.any(Number),
    })

    await expect(readFile(sessionFile, 'utf8')).resolves.toContain(
      '"content":"/background"',
    )
    await expect(
      readFile(join(configRoot, 'history.jsonl'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' })
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
    const sessionFile = resolveDataPlanePaths({
      dataPlane: 'native',
      root: configRoot,
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
    let targetName = ''
    let persistedCost: ClaudeSessionCostState | null = null
    const costStateStore = {
      load: vi.fn(async (id: string) =>
        persistedCost?.sessionId === id ? persistedCost : null,
      ),
      save: vi.fn(async (state: ClaudeSessionCostState) => {
        persistedCost = structuredClone(state)
      }),
    }
    const events: RuntimeEvent[] = []
    let signalContinuationChildStarted!: () => void
    const continuationChildStarted = new Promise<void>((resolve) => {
      signalContinuationChildStarted = resolve
    })
    let releaseContinuationChild!: () => void
    const continuationChildRelease = new Promise<void>((resolve) => {
      releaseContinuationChild = resolve
    })
    const provider: ModelProvider = {
      model: 'btw-model',
      capabilities: { streaming: true, usage: true, tools: true },
      async *complete(request) {
        const source = JSON.stringify(request.messages)
        const isChild = request.messages.some(
          (message) =>
            message.role === 'system' &&
            message.content.includes('You are a general-purpose subagent'),
        )
        if (isChild) {
          const continuation = source.includes('CONTINUE_BTW_AGENT')
          if (continuation) {
            signalContinuationChildStarted()
            await continuationChildRelease
          }
          yield {
            type: 'text-delta',
            delta: continuation ? 'THIRD_AGAIN' : 'THIRD',
          }
          yield {
            type: 'usage',
            usage: continuation
              ? { inputTokens: 7, outputTokens: 2 }
              : { inputTokens: 3, outputTokens: 1 },
          }
          return
        }
        if (source.includes('RESUME_BTW_AGENT')) {
          if (
            source.includes('<tool-use-id>call_resume_btw_agent</tool-use-id>')
          ) {
            yield {
              type: 'text-delta',
              delta: 'BTW_CONTINUATION_NOTIFICATION_OBSERVED',
            }
          } else if (source.includes('resumedAgentId')) {
            yield { type: 'text-delta', delta: 'BTW_MESSAGE_SENT' }
          } else {
            yield {
              type: 'tool-call',
              call: {
                id: 'call_resume_btw_agent',
                name: 'SendMessage',
                input: {
                  to: targetName,
                  message: 'CONTINUE_BTW_AGENT',
                },
              },
            }
            return
          }
          yield {
            type: 'usage',
            usage: { inputTokens: 2, outputTokens: 1 },
          }
          return
        }
        yield {
          type: 'text-delta',
          delta: 'main answer',
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
      dataPlane: 'native',
      experimentalNativeTranscriptWrites: true,
      claudeVersion: '2.1.208',
      provider,
      tools: new LocalToolRegistry({ cwd }),
      permissions: { resolve: () => ({ behavior: 'allow' }) },
      enableSubagents: true,
      subagentToolNames: ['Agent', 'TaskOutput', 'SendMessage'],
      sessionPersistence: true,
      eventSink: (event) => events.push(event),
      costStateStore,
    })
    const run = await service.run('start here')

    const confirmNotificationDetached =
      SubagentLifecycleStore.prototype.confirmNotificationDetached
    let failFirstConfirmation = true
    vi.spyOn(
      SubagentLifecycleStore.prototype,
      'confirmNotificationDetached',
    ).mockImplementation(function (
      this: SubagentLifecycleStore,
      notificationId,
    ) {
      if (failFirstConfirmation) {
        failFirstConfirmation = false
        return Promise.reject(
          new Error('injected detached accounting confirmation failure'),
        )
      }
      return confirmNotificationDetached.call(this, notificationId)
    })

    const result = await service.forkSideQuestion(
      run.sessionId,
      'Reply with THIRD only.',
    )

    expect(result.name).toBe('reply-with-third')
    targetName = result.name
    expect(result.agentId).toMatch(/^a[0-9a-f]+$/u)
    const paths = resolveDataPlanePaths({
      dataPlane: 'native',
      root: configRoot,
      cwd,
      sessionId: run.sessionId,
    })
    const transcript = await readFile(paths.sessionFile, 'utf8')
    expect(transcript).toContain(
      '<local-command-btw>Reply with THIRD only.</local-command-btw>',
    )
    expect(transcript).toContain('⑂ forked reply-with-third')
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
    await expect
      .poll(() => events.filter((event) => event.type === 'warning'))
      .toEqual([
        expect.objectContaining({
          message: 'injected detached accounting confirmation failure',
        }),
      ])
    await expect
      .poll(() => readFile(paths.sessionFile, 'utf8'))
      .toContain('praxis.transcript')
    await expect
      .poll(() => readFile(paths.sessionFile, 'utf8'))
      .toContain(`<task-id>${result.agentId}</task-id>`)
    await expect
      .poll(async () => {
        const lifecycle = await new SubagentLifecycleStore(
          paths.praxisRoot,
          run.sessionId,
          result.agentId,
        ).read()
        return lifecycle?.notifications?.[0]
      })
      .toMatchObject({
        consumed: false,
        accounting: {
          kind: 'detached',
          model: 'btw-model',
          delivered: false,
        },
      })
    await expect(service.costSnapshot(run.sessionId)).resolves.toMatchObject({
      modelUsage: {
        'btw-model': { inputTokens: 3, outputTokens: 1 },
      },
    })

    const resumedPromise = service.resume(run.sessionId, 'RESUME_BTW_AGENT')
    try {
      await continuationChildStarted
      const resumed = await resumedPromise
      expect(resumed).toMatchObject({
        text: 'BTW_MESSAGE_SENT',
        usage: { inputTokens: 2, outputTokens: 1 },
      })
    } finally {
      releaseContinuationChild()
    }
    await expect
      .poll(() => readFile(paths.sessionFile, 'utf8'))
      .toSatisfy(
        (contents) =>
          contents.split(`<task-id>${result.agentId}</task-id>`).length === 2,
      )
    const lifecycleStore = new SubagentLifecycleStore(
      paths.praxisRoot,
      run.sessionId,
      result.agentId,
    )
    await expect
      .poll(async () => {
        const state = await lifecycleStore.read()
        return {
          status: state?.status,
          usage: state?.result?.usage,
          notificationCount: state?.notifications?.length,
          consumed: state?.notifications?.every(
            (notification) => notification.consumed,
          ),
          accountingDelivered: state?.notifications?.every(
            (notification) => notification.accounting?.delivered === true,
          ),
        }
      })
      .toEqual({
        status: 'completed',
        usage: { inputTokens: 7, outputTokens: 2 },
        notificationCount: 2,
        consumed: false,
        accountingDelivered: false,
      })
    const lifecycle = await lifecycleStore.read()
    expect(lifecycle).toMatchObject({
      result: { usage: { inputTokens: 7, outputTokens: 2 } },
    })
    expect(lifecycle?.notifications).toHaveLength(2)
    expect(
      lifecycle?.notifications?.every((notification) => notification.consumed),
    ).toBe(false)
    const accounted = await service.costSnapshot(run.sessionId)
    expect(accounted.modelUsage['btw-model']).toMatchObject({
      inputTokens: 8,
      outputTokens: 3,
    })
    await expect(service.costSnapshot(run.sessionId)).resolves.toMatchObject({
      modelUsage: accounted.modelUsage,
      apiDurationMs: accounted.apiDurationMs,
      apiDurationWithoutRetriesMs: accounted.apiDurationWithoutRetriesMs,
    })
    const completedTranscript = await readFile(paths.sessionFile, 'utf8')
    expect(completedTranscript).toContain('call_resume_btw_agent')
    await service.close()

    const reopened = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider,
      tools: new LocalToolRegistry({ cwd }),
      permissions: { resolve: () => ({ behavior: 'allow' }) },
      sessionPersistence: true,
      costStateStore,
    })
    const reopenedCost = await reopened.costSnapshot(run.sessionId)
    expect(reopenedCost.modelUsage['btw-model']).toMatchObject({
      inputTokens: 8,
      outputTokens: 3,
    })
    await reopened.close()
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
    const sessionFile = resolveNativePaths({
      configDir: configRoot,
      cwd,
      sessionId: run.sessionId,
    }).sessionFile
    await expect
      .poll(() => readFile(sessionFile, 'utf8'))
      .toContain(`<local-command-btw>Background task</local-command-btw>`)
    await expect
      .poll(() => readFile(sessionFile, 'utf8'))
      .toContain(`<task-id>${forked.agentId}</task-id>`)
    expect(warnings).toEqual([])
    await service.close()
  })

  it('boundedly closes a background notification write blocked on the session lease', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-notification-close-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.237',
      provider: queuedProvider(['SESSION_READY']),
      sessionPersistence: true,
    })
    const { sessionId } = await service.run('start')
    let releaseLease!: () => void
    const leaseGate = new Promise<void>((resolve) => {
      releaseLease = resolve
    })
    let leaseAcquired!: () => void
    const acquired = new Promise<void>((resolve) => {
      leaseAcquired = resolve
    })
    const internal = service as unknown as {
      store(id: string): {
        withLease<T>(operation: () => Promise<T>): Promise<unknown>
      }
      enqueueBackgroundNotifications(
        id: string,
        messages: readonly string[],
      ): Promise<boolean>
    }
    const held = internal.store(sessionId).withLease(async () => {
      leaseAcquired()
      await leaseGate
    })
    await acquired
    const queued = internal.enqueueBackgroundNotifications(sessionId, [
      '<task-notification>BLOCKED_WRITE</task-notification>',
    ])
    await new Promise((resolve) => setTimeout(resolve, 30))
    const queuedResult = queued.then((result) => {
      releaseLease()
      return result
    })
    const closed = service.close()
    await expect(
      Promise.race([
        closed.then(() => true),
        new Promise<boolean>((resolve) =>
          setTimeout(() => resolve(false), 1_000),
        ),
      ]),
    ).resolves.toBe(true)
    await expect(queuedResult).resolves.toBe(false)
    await held
  })

  it('acknowledges each background notification immediately after its append', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-notification-batch-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.237',
      provider: queuedProvider(['SESSION_READY']),
      sessionPersistence: true,
    })
    const { sessionId } = await service.run('start')
    const internal = service as unknown as {
      appendBackgroundNotification(
        id: string,
        message: string,
      ): Promise<boolean>
      enqueueBackgroundNotifications(
        id: string,
        messages: readonly string[],
        onAppended?: (message: string) => Promise<void>,
      ): Promise<boolean>
    }
    const append = internal.appendBackgroundNotification.bind(service)
    const first = '<task-notification>FIRST_BATCH_ITEM</task-notification>'
    const second = '<task-notification>SECOND_BATCH_ITEM</task-notification>'
    let rejectSecond = true
    internal.appendBackgroundNotification = async (id, message) => {
      if (message === second && rejectSecond) {
        rejectSecond = false
        throw new Error('injected second append failure')
      }
      return append(id, message)
    }
    const acknowledged: string[] = []
    await expect(
      internal.enqueueBackgroundNotifications(
        sessionId,
        [first, second],
        async (message) => {
          acknowledged.push(message)
        },
      ),
    ).rejects.toThrow('injected second append failure')
    expect(acknowledged).toEqual([first])

    internal.appendBackgroundNotification = append
    await Promise.resolve()
    await expect(
      internal.enqueueBackgroundNotifications(
        sessionId,
        [second],
        async (message) => {
          acknowledged.push(message)
        },
      ),
    ).resolves.toBe(true)
    expect(acknowledged).toEqual([first, second])

    const delivered = nativeMessages(
      await readNativeEvents(nativeSessionFile(configRoot, cwd, sessionId)),
    )
      .filter((entry) => entry.role === 'user')
      .map((entry) => entry.content)
    expect(delivered.filter((content) => content === first)).toHaveLength(1)
    expect(delivered.filter((content) => content === second)).toHaveLength(1)
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
    await service.forkSideQuestion(run.sessionId, 'First task')
    await service.forkSideQuestion(run.sessionId, 'Second task')
    await expect.poll(() => backgroundStarted).toBe(2)

    releaseBackground()
    const sessionFile = nativeSessionFile(configRoot, cwd, run.sessionId)
    const transcript = JSON.stringify(await readNativeEvents(sessionFile))
    expect(transcript).toContain('First task')
    expect(transcript).toContain('Second task')
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
    const originalSession = nativeSessionFile(
      join(root, 'config'),
      root,
      run.sessionId,
    )
    await expect(readFile(originalSession, 'utf8')).resolves.toContain(
      `"content":"start here"`,
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
      resolveNativePaths({
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
      resolveNativePaths({
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

  it('persists prepare-time Workflow validation errors without native claim warnings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-workflow-invalid-meta-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const sessionId = '11111111-1111-4111-8111-111111111111'
    const events: RuntimeEvent[] = []
    let providerTurn = 0
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      dataPlane: 'native',
      experimentalNativeTranscriptWrites: true,
      autoCompact: false,
      enableWorkflows: true,
      provider: {
        capabilities: { streaming: true, usage: true, tools: true },
        async *complete() {
          if (providerTurn++ === 0) {
            yield {
              type: 'tool-call' as const,
              call: {
                id: 'workflow-invalid-meta',
                name: 'Workflow',
                input: {
                  script: `export const meta = {
  name: 'demo',
  description: 'Demonstrate workflows',
  phases: ['Research', 'Synthesis'],
}
return 'done'`,
                },
              },
            }
            return
          }
          yield { type: 'text-delta' as const, delta: 'handled' }
        },
      },
      tools: new LocalToolRegistry({ cwd }),
      permissions: { resolve: () => ({ behavior: 'allow' }) },
      eventSink: (event) => events.push(event),
    })

    try {
      await expect(
        service.run('演示 workflows', undefined, sessionId),
      ).resolves.toMatchObject({ text: 'handled' })
      const toolErrors = events.filter(
        (event): event is Extract<RuntimeEvent, { type: 'tool-result' }> =>
          event.type === 'tool-result' &&
          event.callId === 'workflow-invalid-meta' &&
          event.isError,
      )
      expect(toolErrors).toHaveLength(1)
      expect(toolErrors[0]?.content).toContain(
        'meta.phases[0] must be an object',
      )
      expect(events.filter((event) => event.type === 'warning')).toHaveLength(0)

      const nativeEvents = await readNativeEvents(
        nativeSessionFile(configRoot, cwd, sessionId),
      )
      const claimIndex = nativeEvents.findIndex(
        (event) =>
          event.kind === 'tool-execution-started' &&
          event.callId === 'workflow-invalid-meta',
      )
      expect(
        nativeEvents.filter(
          (event) =>
            event.kind === 'tool-execution-started' &&
            event.callId === 'workflow-invalid-meta',
        ),
      ).toHaveLength(1)
      const toolMessages = nativeMessages(nativeEvents)
      const completionIndex = nativeEvents.findIndex(
        (event) =>
          event.kind === 'messages' &&
          Array.isArray(event.messages) &&
          event.messages.some(
            (message) =>
              typeof message === 'object' &&
              message !== null &&
              'role' in message &&
              message.role === 'tool' &&
              'toolCallId' in message &&
              message.toolCallId === 'workflow-invalid-meta',
          ),
      )
      expect(
        toolMessages.filter(
          (message) =>
            message.role === 'tool' &&
            message.toolCallId === 'workflow-invalid-meta',
        ),
      ).toHaveLength(1)
      expect(claimIndex).toBeGreaterThanOrEqual(0)
      expect(completionIndex).toBeGreaterThan(claimIndex)
    } finally {
      await service.close()
    }
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
      expect(
        registry.definitions().find(({ name }) => name === 'Workflow')
          ?.description,
      ).toContain(
        '`phases` is optional and must be an array of objects shaped `{ title: string, detail?: string, model?: string }`, never an array of strings.',
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

  it('suppresses scheduled tools when toolCapabilityEnvironment disables cron', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-cron-disable-'))
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
      scheduledToolNames: [
        'CronCreate',
        'CronDelete',
        'CronList',
        'ScheduleWakeup',
      ],
      sessionPersistence: true,
      toolCapabilityEnvironment: { [CLAUDE_CODE_DISABLE_CRON]: 'true' },
    })

    try {
      const registry = service.createHostedToolRegistry(sessionId)
      expect(registry.definitions().map(({ name }) => name)).not.toEqual(
        expect.arrayContaining([
          'CronCreate',
          'CronDelete',
          'CronList',
          'ScheduleWakeup',
        ]),
      )
      await expect(
        registry.prepare(
          { id: 'create', name: 'CronCreate', input: {} },
          { cwd },
        ),
      ).rejects.toThrow('unavailable')
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

  it('routes a later-turn TaskStop to the surviving background Agent owner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-cross-turn-agent-stop-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const sessionId = '23232323-2323-4323-8323-232323232323'
    await mkdir(cwd, { recursive: true })
    await writeFile(join(cwd, 'fixture.txt'), 'fixture')
    let childStarted!: () => void
    const childRunning = new Promise<void>((resolve) => {
      childStarted = resolve
    })
    let stoppedAgentId = ''
    let childTurns = 0
    let outputTurns = 0
    let messageTurns = 0
    let stopTurns = 0
    const provider: ModelProvider = {
      capabilities: { streaming: true, usage: true, tools: true },
      async *complete(request) {
        const source = JSON.stringify(request.messages)
        const isChild = request.messages.some(
          (message) =>
            message.role === 'system' &&
            message.content.includes('You are a general-purpose subagent'),
        )
        if (isChild) {
          if (childTurns++ === 0) {
            yield {
              type: 'tool-call',
              call: {
                id: 'call_child_before_stop',
                name: 'Read',
                input: { file_path: join(cwd, 'fixture.txt') },
              },
            }
            yield {
              type: 'usage',
              usage: { inputTokens: 5, outputTokens: 2 },
            }
            return
          }
          childStarted()
          await new Promise<void>((resolve) => {
            if (request.signal?.aborted) resolve()
            else
              request.signal?.addEventListener('abort', () => resolve(), {
                once: true,
              })
          })
          throw new AgentRunCancelledError()
        }
        if (
          source.includes('CHECK_SURVIVING_AGENT') &&
          !source.includes('MESSAGE_SURVIVING_AGENT') &&
          !source.includes('STOP_SURVIVING_AGENT')
        ) {
          if (outputTurns++ === 0) {
            yield {
              type: 'tool-call',
              call: {
                id: 'call_output_surviving_agent',
                name: 'TaskOutput',
                input: {
                  task_id: stoppedAgentId,
                  block: false,
                  timeout: 0,
                },
              },
            }
            return
          }
          yield { type: 'text-delta', delta: 'OUTPUT_ROUTED_TO_OWNER' }
          return
        }
        if (
          source.includes('MESSAGE_SURVIVING_AGENT') &&
          !source.includes('STOP_SURVIVING_AGENT')
        ) {
          if (messageTurns++ === 0) {
            yield {
              type: 'tool-call',
              call: {
                id: 'call_message_surviving_agent',
                name: 'SendMessage',
                input: {
                  to: 'survivor',
                  summary: 'queued before stop',
                  message: 'QUEUED_OWNER_MESSAGE',
                },
              },
            }
            return
          }
          yield { type: 'text-delta', delta: 'MESSAGE_ROUTED_TO_OWNER' }
          return
        }
        if (source.includes('STOP_SURVIVING_AGENT')) {
          if (stopTurns++ === 0) {
            yield {
              type: 'tool-call',
              call: {
                id: 'call_stop_surviving_agent',
                name: 'TaskStop',
                input: { task_id: stoppedAgentId },
              },
            }
            return
          }
          yield { type: 'text-delta', delta: 'STOP_ROUTED_TO_OWNER' }
          return
        }
        if (!source.includes('Async agent launched successfully')) {
          yield {
            type: 'tool-call',
            call: {
              id: 'call_launch_surviving_agent',
              name: 'Agent',
              input: {
                description: 'Survive parent cancellation',
                prompt: 'LONG_RUNNING_CHILD',
                run_in_background: true,
                name: 'survivor',
              },
            },
          }
          return
        }
        await new Promise<void>((resolve) => {
          if (request.signal?.aborted) resolve()
          else
            request.signal?.addEventListener('abort', () => resolve(), {
              once: true,
            })
        })
        throw new AgentRunCancelledError()
      },
    }
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.237',
      provider,
      tools: new LocalToolRegistry({ cwd }),
      permissions: { resolve: () => ({ behavior: 'allow' }) },
      enableSubagents: true,
      taskToolNames: ['TaskOutput', 'TaskStop'],
      subagentToolNames: ['Agent', 'TaskOutput', 'TaskStop', 'SendMessage'],
      sessionPersistence: true,
    })
    const parent = new AbortController()
    const firstTurn = service.run(
      'LAUNCH_SURVIVING_AGENT',
      parent.signal,
      sessionId,
    )
    await childRunning
    const running = await service.taskSnapshots(sessionId)
    stoppedAgentId = String(running.agents[0]?.agentId)
    expect(running.agents).toMatchObject([
      { agentId: stoppedAgentId, status: 'running' },
    ])
    parent.abort()
    await expect(firstTurn).rejects.toBeInstanceOf(AgentRunCancelledError)

    await expect(
      service.resume(sessionId, 'CHECK_SURVIVING_AGENT'),
    ).resolves.toMatchObject({ text: 'OUTPUT_ROUTED_TO_OWNER' })
    await expect(
      service.resume(sessionId, 'MESSAGE_SURVIVING_AGENT'),
    ).resolves.toMatchObject({ text: 'MESSAGE_ROUTED_TO_OWNER' })
    await expect(
      service.resume(sessionId, 'STOP_SURVIVING_AGENT'),
    ).resolves.toMatchObject({ text: 'STOP_ROUTED_TO_OWNER' })
    const paths = resolveNativePaths({ configDir: configRoot, cwd, sessionId })
    const transcript = await readFile(paths.sessionFile, 'utf8')
    expect(transcript).toContain('stopped successfully')
    expect(
      transcript.split(`<task-id>${stoppedAgentId}</task-id>`),
    ).toHaveLength(3)
    expect(transcript).toContain('<status>killed</status>')
    await vi.waitFor(async () => {
      await expect(
        new SubagentLifecycleStore(
          join(configRoot, 'state'),
          sessionId,
          stoppedAgentId,
        ).read(),
      ).resolves.toMatchObject({ status: 'killed' })
    })
    const lifecycle = await new SubagentLifecycleStore(
      join(configRoot, 'state'),
      sessionId,
      stoppedAgentId,
    ).read()
    expect(lifecycle).toMatchObject({
      result: {
        usage: { inputTokens: 5, outputTokens: 2 },
        toolUseCount: 1,
      },
    })
    expect(lifecycle?.notifications).toHaveLength(1)
    expect(lifecycle?.notifications?.[0]?.consumed).toBe(true)
    expect((await service.taskSnapshots(sessionId)).agents).toContainEqual(
      expect.objectContaining({
        agentId: stoppedAgentId,
        status: 'cancelled',
      }),
    )
    await service.close()
  })

  it('delivers a prior-turn completion notification exactly once after parent cancellation', async () => {
    const root = await mkdtemp(
      join(tmpdir(), 'praxis-cross-turn-agent-completion-'),
    )
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const sessionId = '24242424-2424-4424-8424-242424242424'
    await mkdir(cwd, { recursive: true })
    let markChildStarted!: () => void
    const childStarted = new Promise<void>((resolve) => {
      markChildStarted = resolve
    })
    let releaseChild!: () => void
    const childGate = new Promise<void>((resolve) => {
      releaseChild = resolve
    })
    const provider: ModelProvider = {
      capabilities: { streaming: true, usage: true, tools: true },
      async *complete(request) {
        const source = JSON.stringify(request.messages)
        const isChild = request.messages.some(
          (message) =>
            message.role === 'system' &&
            message.content.includes('You are a general-purpose subagent'),
        )
        if (isChild) {
          markChildStarted()
          await childGate
          yield { type: 'text-delta', delta: 'CHILD_COMPLETED' }
          yield {
            type: 'usage',
            usage: { inputTokens: 7, outputTokens: 3 },
          }
          return
        }
        if (source.includes('RESUME_AFTER_CHILD_COMPLETION')) {
          yield {
            type: 'text-delta',
            delta: source.includes('<task-notification>')
              ? 'COMPLETION_NOTIFICATION_OBSERVED'
              : 'RESUMED_PARENT',
          }
          return
        }
        if (!source.includes('Async agent launched successfully')) {
          yield {
            type: 'tool-call',
            call: {
              id: 'call_launch_completing_agent',
              name: 'Agent',
              input: {
                description: 'Complete after parent cancellation',
                prompt: 'WAIT_THEN_COMPLETE',
                run_in_background: true,
                name: 'finisher',
              },
            },
          }
          return
        }
        await new Promise<void>((resolve) => {
          if (request.signal?.aborted) resolve()
          else
            request.signal?.addEventListener('abort', () => resolve(), {
              once: true,
            })
        })
        throw new AgentRunCancelledError()
      },
    }
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      dataPlane: 'native',
      experimentalNativeTranscriptWrites: true,
      claudeVersion: '2.1.237',
      provider,
      tools: new LocalToolRegistry({ cwd }),
      permissions: { resolve: () => ({ behavior: 'allow' }) },
      enableSubagents: true,
      subagentToolNames: ['Agent', 'TaskOutput', 'TaskStop', 'SendMessage'],
      sessionPersistence: true,
    })
    const parent = new AbortController()
    const firstTurn = service.run(
      'LAUNCH_COMPLETING_AGENT',
      parent.signal,
      sessionId,
    )
    await childStarted
    const running = await service.taskSnapshots(sessionId)
    const agentId = String(running.agents[0]?.agentId)
    parent.abort()
    await expect(firstTurn).rejects.toBeInstanceOf(AgentRunCancelledError)

    releaseChild()
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
    await vi.waitFor(async () => {
      await expect(lifecycleStore.read()).resolves.toMatchObject({
        status: 'completed',
        result: {
          text: 'CHILD_COMPLETED',
          usage: { inputTokens: 7, outputTokens: 3 },
        },
      })
    })
    await expect(
      service.resume(sessionId, 'RESUME_AFTER_CHILD_COMPLETION'),
    ).resolves.toMatchObject({ text: 'COMPLETION_NOTIFICATION_OBSERVED' })

    const transcript = await readFile(paths.sessionFile, 'utf8')
    expect(transcript.split(`<task-id>${agentId}</task-id>`)).toHaveLength(3)
    expect(transcript).toContain('<status>completed</status>')
    const lifecycle = await lifecycleStore.read()
    expect(lifecycle?.notifications).toHaveLength(1)
    expect(lifecycle?.notifications?.[0]?.consumed).toBe(true)
    await service.close()
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
        agents: [{ agentId: taskId, status: 'cancelled' }],
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
    const transcript = await readFile(
      resolveNativePaths({
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
    const { resolveNativePaths } = await import('../native/paths.js')
    const sessionFile = resolveNativePaths({
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
    expect(requests[1]?.stableSystemMessageCount).toBe(0)
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
    const sessionFile = resolveNativePaths({
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
    const events = await readNativeEvents(
      nativeSessionFile(configRoot, cwd, sessionId),
    )
    const messages = nativeMessages(events).filter(
      (entry) => entry.role === 'user' || entry.role === 'assistant',
    )

    expect(messages).toHaveLength(2)
    expect(messages).toEqual([
      expect.objectContaining({
        role: 'user',
        content: 'background prompt',
      }),
      expect.objectContaining({
        role: 'assistant',
        content: 'background answer',
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
    ).rejects.toThrow('Invalid session ID: not-a-uuid')
    await expect(
      service.run('still invalid', undefined, 'not-a-uuid'),
    ).rejects.toThrow('Invalid session ID: not-a-uuid')
  })

  it('reports an empty persisted transcript as missing during ephemeral resume', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-runtime-ephemeral-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const sessionId = '15151515-1515-4515-8515-151515151515'
    const { resolveNativePaths } = await import('../native/paths.js')
    const paths = resolveNativePaths({ configDir: configRoot, cwd, sessionId })
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
      'native transcript session is missing or empty',
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
    ).rejects.toThrow('native transcript session already exists')
    const { resolveNativePaths } = await import('../native/paths.js')
    const paths = resolveNativePaths({
      configDir: configRoot,
      cwd,
      sessionId,
    })
    expect(hookTranscriptPaths).toEqual([paths.sessionFile])
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
    ).rejects.toThrow('native transcript session already exists')

    const { resolveNativePaths } = await import('../native/paths.js')
    const paths = resolveNativePaths({
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
    const { resolveNativePaths } = await import('../native/paths.js')
    await expect(
      readFile(
        resolveNativePaths({ configDir: configRoot, cwd, sessionId })
          .sessionFile,
        'utf8',
      ),
    ).resolves.toContain(`"sessionId":"${sessionId}"`)
    await expect(
      service.run('must not append', undefined, sessionId),
    ).rejects.toThrow('native transcript session already exists')

    const emptySessionId = '77777777-7777-4777-8777-777777777777'
    const emptyPaths = resolveNativePaths({
      configDir: configRoot,
      cwd,
      sessionId: emptySessionId,
    })
    await mkdir(emptyPaths.projectRoot, { recursive: true })
    await writeFile(emptyPaths.sessionFile, '')
    await expect(
      service.run('must not claim empty file', undefined, emptySessionId),
    ).rejects.toThrow('native transcript session already exists')
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

    const entries = await readNativeEvents(
      nativeSessionFile(configRoot, cwd, first.sessionId),
    )
    const namingMessages = nativeMessages(entries).filter(
      (message) =>
        message.role === 'user' &&
        message.content ===
          '<praxis-session-name>Resume name</praxis-session-name>',
    )
    expect(namingMessages).toHaveLength(1)
    const firstNamedPromptIndex = nativeMessages(entries).findIndex(
      (message) => message.content === 'first named prompt',
    )
    expect(
      nativeMessages(entries).findIndex(
        (message) =>
          message.content ===
          '<praxis-session-name>Resume name</praxis-session-name>',
      ),
    ).toBeLessThan(firstNamedPromptIndex)

    const fork = await service.fork(first.sessionId)
    const forkEntries = await readNativeEvents(
      nativeSessionFile(configRoot, cwd, fork.sessionId),
    )
    expect(
      nativeMessages(forkEntries).filter(
        (message) =>
          message.content ===
          '<praxis-session-name>Resume name</praxis-session-name>',
      ),
    ).toHaveLength(1)
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
    const { resolveNativePaths } = await import('../native/paths.js')
    await expect(
      readFile(
        resolveNativePaths({ configDir: configRoot, cwd, sessionId })
          .sessionFile,
        'utf8',
      ),
    ).resolves.toBe('')
    await expect(
      service.run('must not reclaim identity', undefined, sessionId),
    ).rejects.toThrow('native transcript session already exists')
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

    const nativeEvents = await readNativeEvents(
      nativeSessionFile(configRoot, cwd, result.sessionId),
    )
    const boundary = nativeEvents.find(
      (event) => event.kind === 'context-boundary',
    )
    expect(boundary).toEqual(
      expect.objectContaining({
        kind: 'context-boundary',
        trigger: 'auto',
        preTokens: expect.any(Number),
        postTokens: expect.any(Number),
      }),
    )
    expect(nativeEvents).toContainEqual(
      expect.objectContaining({
        kind: 'context-summary',
        summary: 'COMPACTED_CURRENT_TASK',
      }),
    )
    expect(JSON.stringify(nativeEvents)).toContain('old-context')

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

  it('preserves native shell model usage capability metadata without a provider turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-metadata-shell-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    let providerCalls = 0
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
        providerCalls += 1
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

    const result = await service.runShell(
      'printf hi',
      undefined,
      '91919191-9191-4191-8191-919191919191',
    )
    expect(result.text).toBe('')
    expect(result.usage).toMatchObject({ inputTokens: 1, outputTokens: 1 })
    expect(result.modelUsage?.['shell-fixture-model']).toMatchObject({
      inputTokens: 2,
      outputTokens: 1,
      contextWindow: 100_000,
      maxOutputTokens: 16_000,
    })
    expect(providerCalls).toBe(0)
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
    const entries = await readNativeEvents(
      nativeSessionFile(configRoot, cwd, result.sessionId),
    )
    const originalPrompt = entries.find(
      (entry) =>
        entry.kind === 'messages' &&
        JSON.stringify(entry.messages).includes('Read the large result.'),
    )
    const toolResult = entries.find(
      (entry) =>
        entry.kind === 'messages' &&
        JSON.stringify(entry.messages).includes('LARGE_TOOL_RESULT'),
    )
    const boundary = entries.find((entry) => entry.kind === 'context-boundary')
    expect(boundary?.logicalParentId).toBe(originalPrompt?.id)
    expect(boundary?.logicalParentId).not.toBe(toolResult?.id)
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

    const events = await readNativeEvents(
      nativeSessionFile(configRoot, cwd, first.sessionId),
    )
    expect(
      events.filter((event) => event.kind === 'context-boundary'),
    ).toHaveLength(1)
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'context-summary',
        summary: 'overflow summary 1',
      }),
    )
    expect(JSON.stringify(events)).not.toContain('overflow summary 2')
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

    const events = await readNativeEvents(
      nativeSessionFile(configRoot, cwd, first.sessionId),
    )
    expect(
      events.filter((event) => event.kind === 'context-boundary'),
    ).toHaveLength(1)
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'context-summary',
        summary: 'COMPACTED_DISTINCT_MODEL',
      }),
    )

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
        await readNativeEvents(
          nativeSessionFile(configRoot, cwd, first.sessionId),
        )
      ).filter((event) => event.kind === 'context-boundary'),
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

    const events = await readNativeEvents(
      nativeSessionFile(configRoot, cwd, first.sessionId),
    )
    expect(events.some((event) => event.kind === 'context-boundary')).toBe(
      false,
    )
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
    const entries = await readNativeEvents(
      nativeSessionFile(configRoot, cwd, first.sessionId),
    )
    const boundaries = entries.filter(
      (entry) => entry.kind === 'context-boundary',
    )
    expect(boundaries).toHaveLength(2)
    expect(boundaries[1]?.preTokens).toEqual(expect.any(Number))
    expect(boundaries[1]?.postTokens).toEqual(expect.any(Number))
    expect(
      entries.filter((entry) => entry.kind === 'context-summary'),
    ).toHaveLength(2)
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

    const events = await readNativeEvents(
      nativeSessionFile(configRoot, cwd, first.sessionId),
    )
    expect(events.some((event) => event.kind === 'context-boundary')).toBe(
      false,
    )
    expect(JSON.stringify(events)).not.toContain('Continue.')
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
    const tinyProvider = queuedProvider(['unexpected'])
    tinyProvider.capabilities.contextWindowTokens = 100
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: tinyProvider,
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

    const events = await readNativeEvents(
      nativeSessionFile(configRoot, cwd, first.sessionId),
    )
    expect(events.some((event) => event.kind === 'context-boundary')).toBe(
      false,
    )
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
    expect(JSON.stringify(requests[1]?.messages)).toContain('HOOK_CONTEXT')
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
          return contextSnapshot({
            firstUser: 'DYNAMIC_COMPACTION_CONTEXT',
          })
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
      resolveNativePaths({
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

    const events = await readNativeEvents(
      nativeSessionFile(configRoot, cwd, first.sessionId),
    )
    expect(events.some((event) => event.kind === 'context-boundary')).toBe(
      false,
    )
    expect(JSON.stringify(events)).not.toContain('Do not persist.')
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
    const targetFile = nativeSessionFile(configRoot, cwd, targetSessionId)
    const before = await readFile(targetFile, 'utf8')
    const sourceEntries = await readNativeEvents(
      nativeSessionFile(configRoot, cwd, source.sessionId),
    )
    const branchPoint = sourceEntries.find(
      (entry) =>
        entry.kind === 'messages' &&
        Array.isArray(entry.messages) &&
        (entry.messages as Array<Record<string, unknown>>).some(
          (message) => message.role === 'user',
        ),
    )
    expect(branchPoint?.id).toEqual(expect.any(String))
    await service.resume(
      source.sessionId,
      'source branched elsewhere',
      undefined,
      undefined,
      undefined,
      undefined,
      String(branchPoint?.id),
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
    const paths = resolveNativePaths({
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
    const paths = resolveNativePaths({
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

    const sessionFile = nativeSessionFile(configRoot, cwd, first.sessionId)
    const before = await readNativeEvents(sessionFile)
    const target = before.find(
      (entry) =>
        entry.kind === 'messages' &&
        JSON.stringify(entry.messages).includes('second prompt'),
    )
    const abandoned = before.find(
      (entry) =>
        entry.kind === 'messages' &&
        JSON.stringify(entry.messages).includes('abandoned third prompt'),
    )
    const targetAnswer = before.find(
      (entry) =>
        entry.kind === 'messages' &&
        entry.parentId === target?.id &&
        JSON.stringify(entry.messages).includes('answer 2'),
    )
    if (
      typeof target?.id !== 'string' ||
      typeof abandoned?.id !== 'string' ||
      typeof targetAnswer?.id !== 'string'
    ) {
      throw new Error('Could not locate resume-at transcript fixtures')
    }

    const targetedHistory = await service.transcript(first.sessionId, target.id)
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
      target.id,
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
        targetAnswer.id,
      ),
    ).resolves.toMatchObject({ text: 'answer 6' })
    await expect(
      service.resume(
        first.sessionId,
        'invalid abandoned target',
        undefined,
        undefined,
        undefined,
        undefined,
        abandoned.id,
      ),
    ).resolves.toMatchObject({ text: 'answer 7' })

    const forkSessionId = '56565656-5656-4656-8656-565656565656'
    await service.fork(first.sessionId, forkSessionId, target.id)
    const forkSource = JSON.stringify(
      await readNativeEvents(nativeSessionFile(configRoot, cwd, forkSessionId)),
    )
    expect(forkSource).toContain('second prompt')
    expect(forkSource).not.toContain('answer 2')
    expect(forkSource).not.toContain('abandoned third prompt')
    expect(forkSource).not.toContain('branch prompt')
    await expect(
      service.fork(first.sessionId, undefined, abandoned.id),
    ).resolves.toMatchObject({ parentSessionId: first.sessionId })

    const after = await readNativeEvents(sessionFile)
    const branch = after.find(
      (entry) =>
        entry.kind === 'messages' &&
        JSON.stringify(entry.messages).includes('branch prompt'),
    )
    expect(branch?.parentId).toBe(target.id)
    expect(after.find((entry) => entry.id === abandoned.id)).toBeDefined()
  })

  it('does not recover unresolved tool calls abandoned after the resume target', async () => {
    const { configRoot, cwd, service } = await createService()
    const first = await service.run('target prompt')
    const sessionFile = nativeSessionFile(configRoot, cwd, first.sessionId)
    const initial = await readNativeEvents(sessionFile)
    const target = initial.find(
      (entry) =>
        entry.kind === 'messages' &&
        nativeMessages([entry]).some((message) => message.role === 'user'),
    )
    const answer = initial.find(
      (entry) =>
        entry.kind === 'messages' &&
        nativeMessages([entry]).some((message) => message.role === 'assistant'),
    )
    if (typeof target?.id !== 'string' || typeof answer?.id !== 'string') {
      throw new Error('Could not locate unresolved-tool fixture messages')
    }
    await appendFile(
      sessionFile,
      `${JSON.stringify({
        schema: 'praxis.transcript',
        version: 1,
        event: {
          kind: 'messages',
          id: '69696969-6969-4969-8969-696969696969',
          parentId: answer.id,
          sessionId: first.sessionId,
          timestamp: new Date().toISOString(),
          messages: [
            {
              role: 'assistant',
              content: '',
              toolCalls: [
                {
                  id: 'call_abandoned',
                  name: 'Read',
                  input: { file_path: 'README.md' },
                },
              ],
            },
          ],
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
        target.id,
      ),
    ).resolves.toMatchObject({ text: 'second answer' })
  })

  it('registers only safe explicit native resume paths and fails closed for writes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-native-path-reads-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const externalRoot = join(root, 'external')
    await mkdir(externalRoot, { recursive: true })
    const cleanId = '50505050-5050-4050-8050-505050505050'
    const corruptId = '60606060-6060-4060-8060-606060606060'
    const unknownId = '70707070-7070-4070-8070-707070707070'
    const mismatchedId = '80808080-8080-4080-8080-808080808080'
    const cleanPath = join(externalRoot, `${cleanId}.jsonl`)
    const corruptPath = join(externalRoot, `${corruptId}.jsonl`)
    const unknownPath = join(externalRoot, `${unknownId}.jsonl`)
    const mismatchedPath = join(externalRoot, `${mismatchedId}.jsonl`)
    const cleanSource = Buffer.from(
      nativeTranscriptLine(
        nativeMessageEvent({
          sessionId: cleanId,
          id: '51515151-5151-4151-8151-515151515151',
          parentId: null,
          role: 'user',
          content: 'external native prompt',
        }),
      ),
    )
    await Promise.all([
      writeFile(cleanPath, cleanSource),
      writeFile(
        corruptPath,
        Buffer.concat([cleanSource, Buffer.from('{bad\n')]),
      ),
      writeFile(
        unknownPath,
        nativeTranscriptLine(
          nativeMessageEvent({
            sessionId: unknownId,
            id: '71717171-7171-4171-8171-717171717171',
            parentId: null,
            role: 'user',
            content: 'future',
          }),
          2,
        ),
      ),
      writeFile(
        mismatchedPath,
        nativeTranscriptLine(
          nativeMessageEvent({
            sessionId: cleanId,
            id: '81818181-8181-4181-8181-818181818181',
            parentId: null,
            role: 'user',
            content: 'wrong identity',
          }),
        ),
      ),
    ])
    const service = new ClaudeSessionService({
      configRoot,
      dataPlane: 'native',
      cwd,
      claudeVersion: 'not-a-version',
    })

    await expect(service.registerResumePath(cleanPath)).resolves.toMatchObject({
      sessionId: cleanId,
      status: 'read-only',
      lastPrompt: 'external native prompt',
    })
    await expect(service.inspect(cleanId)).resolves.toMatchObject({
      status: 'ready',
      writeMode: 'read-only',
    })
    await expect(service.export(cleanId)).resolves.toEqual(cleanSource)
    await expect(service.sessions()).resolves.toEqual([
      expect.objectContaining({ sessionId: cleanId, status: 'ready' }),
    ])
    await expect(service.resume(cleanId, 'no write')).rejects.toThrow(
      'A model provider is required for run and resume',
    )
    await expect(service.registerResumePath(corruptPath)).rejects.toThrow(
      'complete non-empty newline-terminated file',
    )
    await expect(service.registerResumePath(unknownPath)).rejects.toThrow(
      'version is unsupported',
    )
    await expect(service.registerResumePath(mismatchedPath)).rejects.toThrow(
      'contains a different sessionId',
    )
    await expect(readFile(cleanPath)).resolves.toEqual(cleanSource)
  })

  it('lists 500 native sessions with bounded valid-prefix recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-native-session-scale-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const sessionIds = Array.from(
      { length: 500 },
      (_, index) =>
        `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    )
    const projectRoot = resolveDataPlanePaths({
      dataPlane: 'native',
      root: configRoot,
      cwd,
      sessionId: sessionIds[0] as string,
    }).projectRoot
    await mkdir(projectRoot, { recursive: true })
    for (const [index, sessionId] of sessionIds.entries()) {
      const source = nativeTranscriptLine(
        nativeMessageEvent({
          sessionId,
          id: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
          parentId: null,
          role: 'user',
          content: `native session ${index}`,
        }),
      )
      await writeFile(
        join(projectRoot, `${sessionId}.jsonl`),
        index === 499
          ? `${source}{bad\n`
          : index === 498
            ? `${source}{`
            : source,
      )
    }
    const service = new ClaudeSessionService({
      configRoot,
      dataPlane: 'native',
      cwd,
      claudeVersion: 'not-a-version',
    })

    const sessions = await service.sessions()

    expect(sessions).toHaveLength(500)
    expect(
      sessions.find((session) => session.sessionId === sessionIds[498]),
    ).toMatchObject({ status: 'ready', issue: null })
    expect(
      sessions.find((session) => session.sessionId === sessionIds[499]),
    ).toMatchObject({
      status: 'corrupt',
      issue: expect.objectContaining({ kind: 'corrupt-line' }),
    })
  })

  it('invalidates the target prompt lifecycle when creating a fork', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-fork-context-'))
    roots.push(root)
    const invalidations: Array<{ lifecycleId?: string; reason: string }> = []
    const service = new ClaudeSessionService({
      configRoot: join(root, 'config'),
      cwd: join(root, 'project'),
      claudeVersion: '2.1.208',
      provider: queuedProvider(['answer']),
      contextAssembler: {
        assemble: async () => contextSnapshot(),
        invalidate: (options) => invalidations.push(options),
      },
    })
    const source = await service.run('source')
    const targetSessionId = '12121212-1212-4121-8121-121212121212'

    await service.fork(source.sessionId, targetSessionId)

    expect(invalidations).toEqual([
      { lifecycleId: targetSessionId, reason: 'fork' },
    ])
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
          return contextSnapshot({
            system: [`SYSTEM_CONTEXT_${contextVersion}`],
            firstUser: `DYNAMIC_CONTEXT_${contextVersion}`,
          })
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
    const { resolveNativePaths } = await import('../native/paths.js')
    const paths = resolveNativePaths({
      configDir: configRoot,
      cwd,
      sessionId: first.sessionId,
    })
    const transcript = await readFile(paths.sessionFile, 'utf8')
    expect(transcript).not.toContain('SYSTEM_CONTEXT')
    expect(transcript).not.toContain('DYNAMIC_CONTEXT')
  })

  it('delegates brief and structured-output section policy to canonical context assembly', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-turn-context-policy-'))
    roots.push(root)
    const snapshots: ContextSnapshot[] = []
    const assemblyOptions: ContextAssemblyOptions[] = []
    const service = new ClaudeSessionService({
      configRoot: join(root, 'config'),
      cwd: join(root, 'project'),
      claudeVersion: '2.1.208',
      brief: true,
      structuredOutputSchema: {
        type: 'object',
        properties: { answer: { type: 'string' } },
        required: ['answer'],
        additionalProperties: false,
      },
      provider: {
        capabilities: { streaming: true, usage: true, tools: true },
        async *complete() {
          yield { type: 'text-delta', delta: 'done' }
        },
      },
      contextAssembler: {
        async assemble(options) {
          assemblyOptions.push(options ?? {})
          const snapshot = await assembleContextSnapshot(undefined, options)
          snapshots.push(snapshot)
          return snapshot
        },
      },
    })

    await expect(service.run('return structured output')).rejects.toThrow(
      'StructuredOutput must be called exactly once',
    )
    expect(assemblyOptions[0]?.turn).toMatchObject({
      briefOutput: true,
      structuredOutput: true,
    })
    expect(snapshots[0]?.sections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'brief-output',
          placement: 'system',
          stability: 'volatile',
        }),
        expect.objectContaining({
          id: 'structured-output',
          placement: 'system',
          stability: 'volatile',
        }),
      ]),
    )
  })

  it('keeps imported instructions stable until an explicit resource reload', async () => {
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
      writeFile(join(configRoot, 'PRAXIS.md'), 'IMPORTED_CONTEXT_BEFORE'),
      writeFile(importedPath, 'IMPORTED_CONTEXT_BEFORE'),
    ])
    const requests: ModelRequest[] = []
    const contextAssembler = new ClaudeContextAssembler({
      loadResources: () =>
        loadNativeContextResources({ root: configRoot, cwd }),
    })
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
      contextAssembler,
    })

    const first = await service.run('first prompt')
    await writeFile(join(configRoot, 'PRAXIS.md'), 'IMPORTED_CONTEXT_AFTER')
    await service.resume(first.sessionId, 'second prompt')
    service.reloadContextResources(first.sessionId)
    await service.resume(first.sessionId, 'third prompt')

    expect(JSON.stringify(requests[0]?.messages)).toContain(
      'IMPORTED_CONTEXT_BEFORE',
    )
    expect(JSON.stringify(requests[0]?.messages)).not.toContain(
      'IMPORTED_CONTEXT_AFTER',
    )
    expect(JSON.stringify(requests[1]?.messages)).toContain(
      'IMPORTED_CONTEXT_BEFORE',
    )
    expect(JSON.stringify(requests[1]?.messages)).not.toContain(
      'IMPORTED_CONTEXT_AFTER',
    )
    expect(
      requests[1]?.messages.filter((message) => message.role === 'system'),
    ).toEqual(
      requests[0]?.messages.filter((message) => message.role === 'system'),
    )
    expect(requests[1]?.stableSystemMessageCount).toBe(
      requests[0]?.stableSystemMessageCount,
    )
    expect(requests[0]?.stableSystemMessageCount).toBeGreaterThan(0)
    expect(JSON.stringify(requests[2]?.messages)).toContain(
      'IMPORTED_CONTEXT_AFTER',
    )
    expect(JSON.stringify(requests[2]?.messages)).not.toContain(
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
          return contextSnapshot({
            firstUser: 'DYNAMIC_CONTEXT '.repeat(500),
          })
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

    const entries = await readNativeEvents(
      nativeSessionFile(configRoot, cwd, result.sessionId),
    )
    const messages = nativeMessages(entries)
    expect(messages.slice(0, 3).map((entry) => entry.role)).toEqual([
      'user',
      'user',
      'user',
    ])
    expect(messages[2]?.content).toContain('COMMAND [alpha beta] ZERO=[alpha]')
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
      'Persistent Agent Memory',
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
        assemble: async (options) =>
          contextSnapshot({
            system: [options?.baseSystemPrompt ?? 'EXPLICIT_SYSTEM_MARKER'],
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
        assemble: async (options) =>
          contextSnapshot({
            system: [options?.baseSystemPrompt ?? 'EXPLICIT_SYSTEM_MARKER'],
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
        resolveNativePaths({
          configDir: configRoot,
          cwd,
          sessionId: result.sessionId,
        }).sessionFile,
        'utf8',
      ),
    ).not.toContain('agent-setting')
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
    const paths = resolveNativePaths({
      configDir: configRoot,
      cwd,
      sessionId: result.sessionId,
    })
    expect(promptToolResultDirectory).toBe(
      join(paths.projectRoot, result.sessionId, 'tool-results'),
    )
    const events = await readNativeEvents(
      nativeSessionFile(configRoot, cwd, result.sessionId),
    )
    const messages = nativeMessages(events)
    expect(messages).toContainEqual({
      role: 'user',
      content: 'MCP_TEXT',
      images: [
        { type: 'image', mediaType: 'image/jpeg', data: 'dXNlcg==' },
        { type: 'image', mediaType: 'image/png', data: 'bWNw' },
      ],
    })
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
    const events = await readNativeEvents(
      nativeSessionFile(configRoot, cwd, result.sessionId),
    )
    expect(nativeMessages(events)).toContainEqual({
      role: 'user',
      content: 'Base directory: /probe\n\nSKILL',
    })
  })

  it('activates a matching path rule after Read and preserves it across resume', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-runtime-rules-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const sourcePath = join(cwd, 'src', 'app.ts')
    const rulePath = join(cwd, '.praxis', 'rules', 'typescript.md')
    const marker = 'CONDITIONAL_RULE_ACTIVE_4731'
    await Promise.all([
      mkdir(join(cwd, 'src'), { recursive: true }),
      mkdir(join(cwd, '.praxis', 'rules'), { recursive: true }),
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
    const loadResources = () =>
      loadNativeContextResources({ root: configRoot, cwd })
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

    const events = await readNativeEvents(
      nativeSessionFile(configRoot, cwd, first.sessionId),
    )
    expect(JSON.stringify(nativeMessages(events))).toContain(marker)
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

  it('preserves a structurally supported Claude version across auto compaction', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-version-auto-compact-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const origin = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '9.0.0',
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
      claudeVersion: '9.0.0',
      provider: {
        model: 'version-regression-model',
        capabilities: {
          streaming: true,
          usage: true,
          tools: false,
          contextWindowTokens: 2_500,
        },
        async *complete() {
          yield { type: 'text-delta', delta: 'final answer' }
          yield { type: 'usage', usage: { inputTokens: 4, outputTokens: 2 } }
        },
      },
      compactor: {
        async compact() {
          return {
            summary: 'VERSIONED_COMPACT_SUMMARY',
            usage: { inputTokens: 6, outputTokens: 4 },
            durationMs: 40,
            durationWithoutRetriesMs: 25,
            model: 'version-regression-model',
          }
        },
      },
      contextReserveTokens: 1_500,
    })

    const result = await service.resume(first.sessionId, 'Continue the task.')
    expect(result.text).toBe('final answer')

    const entries = await readNativeEvents(
      nativeSessionFile(configRoot, cwd, first.sessionId),
    )
    const compactBoundaries = entries.filter(
      (entry) => entry.kind === 'context-boundary',
    )
    const compactSummaries = entries.filter(
      (entry) => entry.kind === 'context-summary',
    )
    expect(compactBoundaries).toHaveLength(1)
    expect(compactSummaries).toHaveLength(1)
    expect(compactBoundaries[0]).toEqual(
      expect.objectContaining({
        kind: 'context-boundary',
        trigger: 'auto',
        preTokens: expect.any(Number),
        postTokens: expect.any(Number),
      }),
    )
    expect(compactSummaries[0]).toEqual(
      expect.objectContaining({
        kind: 'context-summary',
        summary: 'VERSIONED_COMPACT_SUMMARY',
      }),
    )
  })

  it('does not fire StopFailure for a provider cancellation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-runtime-test-'))
    roots.push(root)
    const hookInputs: ClaudeHookInput[] = []
    const service = new ClaudeSessionService({
      configRoot: join(root, 'config'),
      cwd: join(root, 'project'),
      claudeVersion: '2.1.208',
      provider: {
        capabilities: { streaming: true, usage: true, tools: false },
        async *complete() {
          yield* []
          throw new ModelProviderError('cancelled', {
            retryable: false,
            kind: 'cancelled',
          })
        },
      },
      hooks: new ClaudeHookRunner({
        cwd: join(root, 'project'),
        settings: [
          {
            path: join(root, 'config', 'settings.json'),
            scope: 'user',
            value: {
              hooks: {
                StopFailure: [
                  {
                    hooks: [{ type: 'command', command: 'stop-failure' }],
                  },
                ],
              },
            },
          },
        ],
        executeCommand: async (_command, input) => {
          hookInputs.push(input)
          return { stdout: '', stderr: '', exitCode: 0, durationMs: 1 }
        },
      }),
    })

    await expect(service.run('cancelled prompt')).rejects.toThrow('cancelled')
    expect(hookInputs).toEqual([])
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
    const paths = resolveDataPlanePaths({
      dataPlane: 'native',
      root: configRoot,
      cwd,
      sessionId: result.sessionId,
    })
    const records = (await readFile(paths.sessionFile, 'utf8'))
      .trimEnd()
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as {
            schema?: unknown
            event?: { messages?: readonly ModelMessage[] }
          },
      )
    expect(
      records.every((record) => record.schema === 'praxis.transcript'),
    ).toBe(true)
    const events = records.flatMap((record) =>
      record.event === undefined ? [] : [record.event],
    )
    const messages = events.flatMap((event) => event.messages ?? [])
    expect(messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ])
    expect(messages[1]?.role).toBe('assistant')
    expect(
      messages[1]?.role === 'assistant' ? messages[1].toolCalls : undefined,
    ).toEqual([
      {
        id: 'call_read',
        name: 'Read',
        input: { file_path: 'README.md' },
      },
    ])
    expect(messages[2]).toMatchObject({
      role: 'tool',
      toolCallId: 'call_read',
      content: '# Praxis',
    })
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
    await service.close()
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

    const entries = await readNativeEvents(
      nativeSessionFile(configRoot, cwd, result.sessionId),
    )
    expect(entries.length).toBeGreaterThan(0)
    expect(entries.every((entry) => typeof entry.id === 'string')).toBe(true)
    expect(JSON.stringify(entries)).toContain('revised answer')
    expect(JSON.stringify(entries)).not.toContain('SESSION_END_UNPERSISTED')
    expect(JSON.stringify(entries)).not.toContain(secret)
  })

  it('runs session hooks once across multiple prompts and closes idempotently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-hook-lifecycle-'))
    roots.push(root)
    const hookEvents: Array<{
      event: string
      source?: unknown
      reason?: unknown
    }> = []
    const contextInvalidations: string[] = []
    const service = new ClaudeSessionService({
      configRoot: join(root, 'config'),
      cwd: join(root, 'project'),
      claudeVersion: '2.1.208',
      provider: queuedProvider([
        'first answer',
        'second answer',
        'third answer',
        'fourth answer',
      ]),
      contextAssembler: {
        assemble: async () => contextSnapshot(),
        invalidate: ({ reason }) => contextInvalidations.push(reason),
      },
      hooks: new ClaudeHookRunner({
        cwd: join(root, 'project'),
        settings: [
          {
            path: join(root, 'config', 'settings.json'),
            scope: 'user',
            value: {
              hooks: Object.fromEntries(
                [
                  'SessionStart',
                  'UserPromptSubmit',
                  'Notification',
                  'Stop',
                  'SessionEnd',
                ].map((event) => [
                  event,
                  [{ hooks: [{ type: 'command', command: event }] }],
                ]),
              ),
            },
          },
        ],
        executeCommand: async (_command, input) => {
          hookEvents.push({
            event: input.hook_event_name,
            ...(input.source === undefined ? {} : { source: input.source }),
            ...(input.reason === undefined ? {} : { reason: input.reason }),
          })
          return { stdout: '', stderr: '', exitCode: 0, durationMs: 1 }
        },
      }),
    })

    const first = await service.run('first prompt')
    await service.notify(
      first.sessionId,
      'Turn complete',
      'permission_prompt',
      'Praxis',
    )
    await service.resume(first.sessionId, 'second prompt')
    await service.transitionHookSession(first.sessionId, 'resume')
    await service.transitionHookSession(first.sessionId, 'resume')
    await service.resume(first.sessionId, 'third prompt')
    await service.transitionHookSession(first.sessionId, 'clear')
    const clearedSessionId = '33333333-3333-4333-8333-333333333333'
    await service.run('fourth prompt', undefined, clearedSessionId)
    await service.close()
    await service.close()
    expect(hookEvents).toEqual([
      { event: 'SessionStart', source: 'startup' },
      { event: 'UserPromptSubmit' },
      { event: 'Stop' },
      { event: 'Notification' },
      { event: 'UserPromptSubmit' },
      { event: 'Stop' },
      { event: 'SessionEnd', reason: 'resume' },
      { event: 'SessionStart', source: 'resume' },
      { event: 'UserPromptSubmit' },
      { event: 'Stop' },
      { event: 'SessionEnd', reason: 'clear' },
      { event: 'SessionStart', source: 'clear' },
      { event: 'UserPromptSubmit' },
      { event: 'Stop' },
      { event: 'SessionEnd', reason: 'other' },
    ])
    expect(contextInvalidations).toEqual(['restore', 'restore', 'clear'])
  })

  it('tracks detached Notification hooks until service shutdown', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-notification-close-'))
    roots.push(root)
    let release!: () => void
    const completion = new Promise<void>((resolve) => {
      release = resolve
    })
    let notificationSignal: AbortSignal | undefined
    const service = new ClaudeSessionService({
      configRoot: join(root, 'config'),
      cwd: join(root, 'project'),
      claudeVersion: '2.1.208',
      provider: queuedProvider(['done']),
      hooks: new ClaudeHookRunner({
        cwd: join(root, 'project'),
        settings: [
          {
            path: join(root, 'config', 'settings.json'),
            scope: 'user',
            value: {
              hooks: {
                Notification: [
                  { hooks: [{ type: 'command', command: 'notification' }] },
                ],
              },
            },
          },
        ],
        executeCommand: async (_command, _input, _timeout, signal) => {
          notificationSignal = signal
          await completion
          return { stdout: '', stderr: '', exitCode: 0, durationMs: 1 }
        },
      }),
    })
    const result = await service.run('start')
    service.notifyDetached(
      result.sessionId,
      'Approval required',
      'permission_prompt',
      'Praxis',
    )
    let closed = false
    const closing = service.close().then(() => {
      closed = true
    })
    await Promise.resolve()

    expect(closed).toBe(false)
    expect(notificationSignal?.aborted).toBe(false)
    release()
    await closing
    expect(closed).toBe(true)
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
    await service.close()
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

  it('keeps SessionStart blocking output as context instead of failing startup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-session-start-block-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: queuedProvider(['completed answer']),
      hooks: new ClaudeHookRunner({
        cwd,
        settings: [
          {
            path: join(configRoot, 'settings.json'),
            scope: 'user',
            value: {
              hooks: {
                SessionStart: [
                  { hooks: [{ type: 'command', command: 'session-start' }] },
                ],
              },
            },
          },
        ],
        executeCommand: async () => ({
          stdout: JSON.stringify({
            continue: false,
            stopReason: 'START_CONTEXT_ONLY',
          }),
          stderr: '',
          exitCode: 0,
          durationMs: 1,
        }),
      }),
    })

    const result = await service.run('finish')
    expect(result.text).toBe('completed answer')
    const transcript = await readFile(
      resolveNativePaths({
        configDir: configRoot,
        cwd,
        sessionId: result.sessionId,
      }).sessionFile,
      'utf8',
    )
    expect(transcript).toContain('START_CONTEXT_ONLY')
    await service.close()
  })

  it('bounds SessionEnd teardown when a hook executor stalls', async () => {
    vi.useFakeTimers()
    try {
      const root = await mkdtemp(join(tmpdir(), 'praxis-session-end-stall-'))
      roots.push(root)
      const configRoot = join(root, 'config')
      const cwd = join(root, 'project')
      const runtimeEvents: RuntimeEvent[] = []
      const service = new ClaudeSessionService({
        configRoot,
        cwd,
        claudeVersion: '2.1.208',
        provider: queuedProvider(['completed answer']),
        hooks: new ClaudeHookRunner({
          cwd,
          settings: [
            {
              path: join(configRoot, 'settings.json'),
              scope: 'user',
              value: {
                hooks: {
                  SessionEnd: [
                    { hooks: [{ type: 'command', command: 'stall' }] },
                  ],
                },
              },
            },
          ],
          executeCommand: () => new Promise(() => undefined),
        }),
        eventSink: (event) => runtimeEvents.push(event),
      })

      await service.run('finish')
      const closing = service.close()
      await vi.advanceTimersByTimeAsync(15_000)
      await expect(closing).resolves.toBeUndefined()
      expect(runtimeEvents.at(-1)).toEqual({
        type: 'warning',
        message: 'SessionEnd hook failed: timed out after 15000ms',
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('resumes an explicit regular JSONL path from its newest non-sidechain leaf and appends in place', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-path-resume-'))
    roots.push(root)
    const configRoot = join(root, 'native')
    const cwd = join(root, 'project')
    const externalRoot = join(root, 'external-project')
    const sessionId = '12121212-1212-4212-8212-121212121212'
    const sessionFile = join(externalRoot, `${sessionId}.jsonl`)
    await mkdir(externalRoot, { recursive: true })
    const entries = [
      {
        type: 'user',
        uuid: '11111111-1111-4111-8111-111111111111',
        parentUuid: null,
        sessionId,
        message: { role: 'user', content: 'root prompt' },
      },
      {
        type: 'assistant',
        uuid: '22222222-2222-4222-8222-222222222222',
        parentUuid: '11111111-1111-4111-8111-111111111111',
        sessionId,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'abandoned answer' }],
        },
      },
      {
        type: 'last-prompt',
        lastPrompt: 'root prompt',
        leafUuid: '22222222-2222-4222-8222-222222222222',
        sessionId,
      },
      {
        type: 'user',
        uuid: '33333333-3333-4333-8333-333333333333',
        parentUuid: '11111111-1111-4111-8111-111111111111',
        sessionId,
        message: { role: 'user', content: 'newest branch prompt' },
      },
      {
        type: 'assistant',
        uuid: '44444444-4444-4444-8444-444444444444',
        parentUuid: '33333333-3333-4333-8333-333333333333',
        sessionId,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'newest branch answer' }],
        },
      },
    ]
    await writeFile(
      sessionFile,
      `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
    )
    const requests: ModelRequest[] = []
    const service = new ClaudeSessionService({
      configRoot,
      dataPlane: 'native',
      cwd,
      claudeVersion: '2.1.208',
      provider: {
        capabilities: { streaming: true, usage: true, tools: false },
        async *complete(request) {
          requests.push(request)
          yield { type: 'text-delta', delta: 'continued externally' }
        },
      },
    })

    await expect(service.registerResumePath(sessionFile)).rejects.toThrow(
      'Native resume transcript must use the Praxis transcript format',
    )
    expect(requests).toHaveLength(0)
    expect(await readFile(sessionFile, 'utf8')).not.toContain(
      'continued externally',
    )
    const nativeFile = resolveDataPlanePaths({
      dataPlane: 'native',
      root: configRoot,
      cwd,
      sessionId,
    }).sessionFile
    await expect(readFile(nativeFile, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })

    const linkPath = join(
      externalRoot,
      '13131313-1313-4313-8313-131313131313.jsonl',
    )
    await symlink(sessionFile, linkPath)
    await expect(service.registerResumePath(linkPath)).rejects.toThrow(
      'regular JSONL file',
    )
  })

  it('does not reappend worktree lifecycle metadata during graceful close', async () => {
    const { configRoot, cwd, service } = await createService()
    const run = await service.run('worktree metadata prompt')
    const sessionFile = nativeSessionFile(configRoot, cwd, run.sessionId)
    const priorEvents = await readNativeEvents(sessionFile)
    await appendFile(
      sessionFile,
      nativeTranscriptLine(
        nativeMessageEvent({
          sessionId: run.sessionId,
          id: '31313131-3131-4313-8313-313131313131',
          parentId: String(priorEvents.at(-1)?.id ?? ''),
          role: 'user',
          content: 'worktree metadata prompt',
        }),
      ),
    )
    await service.rename(run.sessionId, 'durable title')

    await service.close()

    const persisted = await readNativeEvents(sessionFile)
    expect(persisted.every((entry) => typeof entry.id === 'string')).toBe(true)
    expect(JSON.stringify(persisted)).toContain('worktree metadata prompt')
    expect(JSON.stringify(persisted)).toContain('durable title')
  })

  it('advances the close snapshot through a local command after an oversized assistant line', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-large-leaf-close-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: queuedProvider(['A'.repeat(140 * 1024)]),
    })
    const run = await service.run('create an oversized answer')
    const sessionFile = nativeSessionFile(configRoot, cwd, run.sessionId)
    const persisted = await readNativeEvents(sessionFile)
    const assistant = persisted.find(
      (entry) =>
        entry.kind === 'messages' &&
        JSON.stringify(entry.messages).includes('A'.repeat(100)),
    )
    expect(assistant?.id).toEqual(expect.any(String))
    await appendFile(
      sessionFile,
      `${nativeTranscriptLine(nativeMessageEvent({ sessionId: run.sessionId, id: '23232323-2323-4323-8323-232323232323', parentId: String(assistant?.id), role: 'user', content: '/cd' }))}${nativeTranscriptLine(nativeMessageEvent({ sessionId: run.sessionId, id: '24242424-2424-4424-8424-242424242424', parentId: '23232323-2323-4323-8323-232323232323', role: 'assistant', content: 'moved' }))}`,
    )

    await service.close()

    const after = await readNativeEvents(sessionFile)
    expect(
      after.find(
        (entry) => entry.id === '24242424-2424-4424-8424-242424242424',
      ),
    ).toBeDefined()
  })

  it('does not advance the close snapshot through a local command on an abandoned branch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-abandoned-leaf-close-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: queuedProvider(['A'.repeat(140 * 1024)]),
    })
    const run = await service.run('create an oversized committed answer')
    const sessionFile = nativeSessionFile(configRoot, cwd, run.sessionId)
    const persisted = await readNativeEvents(sessionFile)
    const assistant = persisted.find(
      (entry) =>
        entry.kind === 'messages' &&
        JSON.stringify(entry.messages).includes('A'.repeat(100)),
    )
    expect(assistant?.id).toEqual(expect.any(String))
    const failedUserUuid = '25252525-2525-4525-8525-252525252525'
    const failedAssistantUuid = '26262626-2626-4626-8626-262626262626'
    const commandUuid = '27272727-2727-4727-8727-272727272727'
    const stdoutUuid = '28282828-2828-4828-8828-282828282828'
    await appendFile(
      sessionFile,
      [
        nativeMessageEvent({
          sessionId: run.sessionId,
          id: failedUserUuid,
          parentId: String(assistant?.id),
          role: 'user',
          content: 'abandoned retry',
        }),
        nativeMessageEvent({
          sessionId: run.sessionId,
          id: failedAssistantUuid,
          parentId: failedUserUuid,
          role: 'assistant',
          content: '',
        }),
        nativeMessageEvent({
          sessionId: run.sessionId,
          id: commandUuid,
          parentId: failedAssistantUuid,
          role: 'user',
          content: '/cd',
        }),
        nativeMessageEvent({
          sessionId: run.sessionId,
          id: stdoutUuid,
          parentId: commandUuid,
          role: 'assistant',
          content: 'moved',
        }),
      ]
        .map((entry) => nativeTranscriptLine(entry))
        .join(''),
    )

    await service.close()

    const after = await readNativeEvents(sessionFile)
    expect(after.find((entry) => entry.id === failedUserUuid)).toBeDefined()
    expect(after.find((entry) => entry.id === stdoutUuid)?.parentId).toBe(
      commandUuid,
    )
  })

  it('does not promote an abandoned assistant during graceful-close metadata reappend', async () => {
    const { configRoot, cwd, service } = await createService()
    const run = await service.run('committed prompt')
    const sessionFile = nativeSessionFile(configRoot, cwd, run.sessionId)
    const committed = await readNativeEvents(sessionFile)
    const committedAssistant = committed.find(
      (entry) =>
        entry.kind === 'messages' &&
        JSON.stringify(entry.messages).includes('committed prompt'),
    )
    await appendFile(
      sessionFile,
      `${nativeTranscriptLine(nativeMessageEvent({ sessionId: run.sessionId, id: '21212121-2121-4121-8121-212121212121', parentId: String(committedAssistant?.id), role: 'user', content: 'abandoned retry' }))}${nativeTranscriptLine(nativeMessageEvent({ sessionId: run.sessionId, id: '22222222-2222-4222-8222-222222222222', parentId: '21212121-2121-4121-8121-212121212121', role: 'assistant', content: '' }))}`,
    )

    await service.close()

    const after = await readNativeEvents(sessionFile)
    expect(
      after.find((entry) => entry.id === committedAssistant?.id),
    ).toBeDefined()
    expect(
      after.find((entry) => entry.id === '22222222-2222-4222-8222-222222222222')
        ?.parentId,
    ).toBe('21212121-2121-4121-8121-212121212121')
  })

  it('replays an interrupted prompt exactly once only with explicit opt-in', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-prompt-replay-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const sessionId = '14141414-1414-4414-8414-141414141414'
    const interrupted = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: {
        capabilities: { streaming: true, usage: true, tools: false },
        async *complete() {
          if (process.pid < 0) {
            yield { type: 'text-delta' as const, delta: '' }
          }
          throw new Error('connection lost')
        },
      },
    })
    await expect(
      interrupted.run('replay this prompt', undefined, sessionId),
    ).rejects.toThrow('connection lost')
    await expect(interrupted.interruption(sessionId)).resolves.toMatchObject({
      kind: 'interrupted-prompt',
      prompt: 'replay this prompt',
    })

    const requests: ModelRequest[] = []
    const optedIn = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      resumeInterruptedTurn: true,
      provider: {
        capabilities: { streaming: true, usage: true, tools: false },
        async *complete(request) {
          requests.push(request)
          yield {
            type: 'text-delta',
            delta: requests.length === 1 ? 'replayed' : 'next answer',
          }
        },
      },
    })
    await optedIn.resume(sessionId, 'sentinel must not be sent')
    const first = JSON.stringify(requests[0]?.messages)
    expect(first.match(/replay this prompt/gu)).toHaveLength(1)
    expect(first).not.toContain('sentinel must not be sent')

    await optedIn.resume(sessionId, 'next explicit prompt')
    const second = JSON.stringify(requests[1]?.messages)
    expect(second).toContain('next explicit prompt')
    expect(second.match(/replay this prompt/gu)).toHaveLength(1)
    await expect(optedIn.interruption(sessionId)).resolves.toEqual({
      kind: 'complete',
    })
  })

  it.each(['tool-result', 'context-attachment'] as const)(
    'retains an interrupted %s and enqueues one clean continuation',
    async (kind) => {
      const root = await mkdtemp(join(tmpdir(), `praxis-${kind}-replay-`))
      roots.push(root)
      const configRoot = join(root, 'config')
      const cwd = join(root, 'project')
      const sessionId =
        kind === 'tool-result'
          ? '23232323-2323-4323-8323-232323232323'
          : '24242424-2424-4424-8424-242424242424'
      const sessionFile = nativeSessionFile(configRoot, cwd, sessionId)
      await mkdir(dirname(sessionFile), { recursive: true })
      const prompt = nativeMessageEvent({
        sessionId,
        id: '25252525-2525-4525-8525-252525252525',
        parentId: null,
        role: 'user',
        content: 'perform one operation',
      })
      const tail =
        kind === 'tool-result'
          ? [
              {
                kind: 'messages',
                id: '26262626-2626-4626-8626-262626262626',
                parentId: prompt.id,
                sessionId,
                timestamp: '2026-08-23T00:00:00.000Z',
                messages: [
                  {
                    role: 'assistant',
                    content: '',
                    toolCalls: [
                      {
                        id: 'call_completed',
                        name: 'Read',
                        input: { file_path: 'README.md' },
                      },
                    ],
                  },
                ],
              },
              {
                kind: 'messages',
                id: '27272727-2727-4727-8727-272727272727',
                parentId: '26262626-2626-4626-8626-262626262626',
                sessionId,
                timestamp: '2026-08-23T00:00:00.000Z',
                messages: [
                  {
                    role: 'tool',
                    toolCallId: 'call_completed',
                    content: 'COMPLETED_TOOL_OUTPUT',
                    isError: false,
                  },
                ],
              },
            ]
          : [
              {
                kind: 'messages',
                id: '28282828-2828-4828-8828-282828282828',
                parentId: prompt.id,
                sessionId,
                timestamp: '2026-08-23T00:00:00.000Z',
                messages: [{ role: 'user', content: 'RECOVERED_CONTEXT' }],
              },
            ]
      await writeFile(
        sessionFile,
        `${[prompt, ...tail].map((event) => nativeTranscriptLine(event)).join('')}`,
      )
      const requests: ModelRequest[] = []
      const service = new ClaudeSessionService({
        configRoot,
        cwd,
        claudeVersion: '2.1.208',
        resumeInterruptedTurn: true,
        provider: {
          capabilities: { streaming: true, usage: true, tools: false },
          async *complete(request) {
            requests.push(request)
            yield { type: 'text-delta', delta: 'continued safely' }
          },
        },
      })

      await service.resume(sessionId, 'discarded restart sentinel')

      const request = JSON.stringify(requests[0]?.messages)
      expect(request.match(/perform one operation/gu)).toHaveLength(1)
      expect(request).not.toContain('discarded restart sentinel')
      expect(request).toContain(
        kind === 'tool-result' ? 'COMPLETED_TOOL_OUTPUT' : 'RECOVERED_CONTEXT',
      )
      const persisted = await readNativeEvents(sessionFile)
      expect(nativeMessages(persisted)).not.toContainEqual(
        expect.objectContaining({
          role: 'user',
          content: CLAUDE_INTERRUPTED_TURN_CONTINUATION,
        }),
      )
      expect(persisted).toContainEqual(
        expect.objectContaining({ id: tail.at(-1)?.id }),
      )
    },
  )
})
