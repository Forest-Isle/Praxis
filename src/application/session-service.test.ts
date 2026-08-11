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
import { resolveClaudePaths } from '../compatibility/claude/paths.js'
import { loadClaudeContextResources } from '../compatibility/claude/shared-resources.js'
import { ClaudeExtensionCatalog } from '../extensions/claude-extensions.js'
import { ClaudeHookRunner } from '../hooks/claude-hooks.js'
import { ClaudeInteractiveToolManager } from '../tools/claude-interactive-tools.js'
import { LocalToolRegistry } from '../tools/local-tools.js'
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

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  )
})

describe('ClaudeSessionService', () => {
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
        approvePlan: async () => true,
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

  it('relocates an active session and continues it from the new cwd', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-session-cd-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const originalCwd = join(root, 'original')
    const relocatedCwd = join(root, 'relocated')
    await mkdir(originalCwd)
    await mkdir(relocatedCwd)
    const canonicalRelocatedCwd = await realpath(relocatedCwd)
    const service = new ClaudeSessionService({
      configRoot,
      cwd: originalCwd,
      claudeVersion: '2.1.208',
      workspace: new WorkspaceContext(originalCwd),
      provider: queuedProvider(['before move', 'after move']),
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
    const continued = await readFile(relocated, 'utf8')
    expect(continued).toContain(`"cwd":"${canonicalRelocatedCwd}"`)
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
          '<system-reminder>\nAvailable agent types for the Agent tool:\n- general-purpose: General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks.\n- reviewer: Review work.\n</system-reminder>',
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
