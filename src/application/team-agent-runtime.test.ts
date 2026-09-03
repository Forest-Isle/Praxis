import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import {
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  ModelProvider,
  ModelToolCall,
  PermissionDecision,
  PermissionResolver,
  ToolRegistry,
} from '../core/runtime.js'
import type { TeamTask } from '../core/team-ownership.js'
import { ClaudeExtensionCatalog } from '../extensions/claude-extensions.js'
import { resolveProjectIdentity } from '../platform/project-identity.js'
import { inspectManagedWorktreeRegistry } from '../persistence/managed-worktree-store.js'
import { LocalToolRegistry } from '../tools/local-tools.js'
import { TeamMemberToolRegistry } from '../tools/team-member-tools.js'
import { LocalTeamManager } from './team-manager.js'
import { ClaudeTeamAgentRuntime } from './team-agent-runtime.js'
import { ClaudeSubagentExecutor } from './subagent-service.js'
import type { TeamMailboxEndpoint } from './team-mailbox.js'
import type { TeamLeadDecisionRequest } from './team-lead-decision-surface.js'

const tools: ToolRegistry = {
  definitions: () => [],
  prepare: async (call) => call,
  execute: async () => ({ content: '', isError: false }),
}
const permissions: PermissionResolver = {
  resolve: () => ({ behavior: 'allow' }),
}
const mailbox = {
  participant: 'worker',
  send: async () => {
    throw new Error('unexpected mailbox send')
  },
  project: async () => null,
} as unknown as TeamMailboxEndpoint
const exec = promisify(execFile)

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (
    await exec('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  ).stdout.trim()
}

async function gitRepository(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'praxis-team-runtime-repo-'))
  await git(cwd, 'init', '-q')
  await git(cwd, 'config', 'user.name', 'Praxis Test')
  await git(cwd, 'config', 'user.email', 'praxis@example.test')
  await writeFile(join(cwd, 'fixture.txt'), 'fixture\n')
  await git(cwd, 'add', 'fixture.txt')
  await git(cwd, 'commit', '-qm', 'fixture')
  return cwd
}

function scriptedProvider(
  action: 'read' | 'write' | 'rejected-write',
): ModelProvider {
  let calls = 0
  return {
    capabilities: { streaming: true, usage: true, tools: true },
    async *complete() {
      const count = calls++
      if (count === 0 && action === 'read') {
        yield {
          type: 'tool-call',
          call: {
            id: 'read-fixture',
            name: 'Read',
            input: { file_path: 'fixture.txt' },
          },
        }
        return
      }
      if (count === 0 && action === 'write') {
        yield {
          type: 'tool-call',
          call: {
            id: 'write-fixture',
            name: 'Write',
            input: { file_path: 'writer.txt', content: 'writer\n' },
          },
        }
        return
      }
      if (count === 0 && action === 'rejected-write') {
        yield {
          type: 'tool-call',
          call: {
            id: 'write-fixture',
            name: 'Write',
            input: { file_path: 'writer.txt', content: 'writer\n' },
          },
        }
        return
      }
      if (action === 'rejected-write') throw new Error('guarded write rejected')
      yield { type: 'text-delta', delta: 'done' }
    },
  }
}

const task: TeamTask = {
  id: 'task-a',
  description: 'Report the assigned checkout.',
  assignee: 'worker',
  blockedBy: [],
  claims: {
    files: ['src/app.ts'],
    publicContracts: [],
    generatedArtifacts: [],
    migrations: [],
    mergeTargets: [],
  },
  execution: null,
  usage: { generation: 0, totalTokens: 0, durationMs: 0 },
}

describe('ClaudeTeamAgentRuntime', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('allocates one turn provider per generation and retains it through tool continuation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-team-turn-providers-'))
    const cwd = await mkdtemp(join(root, 'checkout-'))
    const clients: ModelProvider[] = []
    const providerForTurn = vi.fn(() => {
      const generation = clients.length
      let calls = 0
      const client: ModelProvider = {
        model: `team-model-${generation}`,
        capabilities: { streaming: true, usage: true, tools: true },
        async *complete() {
          if (generation === 0 && calls++ === 0) {
            yield {
              type: 'tool-call',
              call: {
                id: 'team-turn-send',
                name: 'SendMessage',
                input: { to: 'lead', message: 'progress' },
              },
            }
            return
          }
          yield { type: 'text-delta', delta: `generation-${generation}` }
        },
      }
      clients.push(client)
      return client
    })
    const sent: unknown[] = []
    const endpoint = {
      participant: 'worker',
      send: async (message: unknown) => {
        sent.push(message)
        return {} as never
      },
      project: async () => null,
    } as unknown as TeamMailboxEndpoint
    const runtime = new ClaudeTeamAgentRuntime({
      nativeRoot: root,
      configRoot: root,
      claudeVersion: '2.1.208',
      provider: {
        capabilities: { streaming: true, usage: true, tools: true },
        async *complete() {
          yield { type: 'text-delta', delta: 'unused' }
        },
      },
      providerForTurn,
    })
    const run = (generation: number) =>
      runtime.run({
        teamId: 'team-turn-providers',
        task,
        member: {
          name: 'worker',
          agentType: 'general-purpose',
          access: 'read-only',
        },
        generation,
        cwd,
        branch: null,
        tools,
        permissions,
        signal: new AbortController().signal,
        mailbox: endpoint,
        reportProgress: () => undefined,
      })

    await expect(run(1)).resolves.toMatchObject({ status: 'completed' })
    await expect(run(2)).resolves.toMatchObject({ status: 'completed' })
    expect(providerForTurn).toHaveBeenCalledTimes(2)
    expect(clients).toHaveLength(2)
    expect(clients[0]).not.toBe(clients[1])
    expect(sent).toHaveLength(1)
    await rm(root, { recursive: true, force: true })
  })

  it('routes worker SendMessage through the required scoped mailbox and acks inbox after completion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-team-agent-mailbox-'))
    const cwd = await mkdtemp(join(root, 'checkout-'))
    const sent: unknown[] = []
    let acknowledged = 0
    let delivered = false
    let turns = 0
    const endpoint = {
      participant: 'worker',
      send: async (input: unknown) => {
        sent.push(input)
        return {} as never
      },
      project: async () => {
        if (delivered) return null
        delivered = true
        return {
          id: 'inbox',
          messages: ['FOLLOWUP'],
          acknowledge: async () => {
            acknowledged += 1
          },
        }
      },
    } as unknown as TeamMailboxEndpoint
    try {
      const runtime = new ClaudeTeamAgentRuntime({
        nativeRoot: root,
        configRoot: root,
        claudeVersion: '2.1.208',
        provider: {
          capabilities: { streaming: true, usage: true, tools: true },
          async *complete(request) {
            void request
            if (turns++ === 0) {
              yield {
                type: 'tool-call',
                call: {
                  id: 'send-call',
                  name: 'SendMessage',
                  input: { to: 'lead', message: 'hello', summary: 'hi' },
                },
              }
              return
            }
            yield { type: 'text-delta', delta: 'done' }
          },
        },
      })
      await runtime.run({
        teamId: 'team-a',
        task,
        member: {
          name: 'worker',
          agentType: 'general-purpose',
          access: 'read-only',
        },
        generation: 1,
        cwd,
        branch: null,
        tools,
        permissions,
        signal: new AbortController().signal,
        mailbox: endpoint,
        reportProgress: () => undefined,
      })
      expect(sent).toHaveLength(1)
      expect(sent[0]).toMatchObject({
        to: 'lead',
        payload: { kind: 'text', text: 'hello' },
      })
      expect(acknowledged).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('runs one task through the foreground Claude substrate and retains evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-team-agent-runtime-'))
    const cwd = await mkdtemp(join(root, 'checkout-'))
    try {
      const runtime = new ClaudeTeamAgentRuntime({
        nativeRoot: root,
        configRoot: root,
        claudeVersion: '2.1.208',
        provider: {
          capabilities: { streaming: true, usage: true, tools: true },
          async *complete() {
            yield { type: 'text-delta', delta: 'completed' }
          },
        },
      })
      await expect(
        runtime.run({
          teamId: 'team-a',
          task,
          member: {
            name: 'worker',
            agentType: 'general-purpose',
            access: 'read-only',
          },
          generation: 1,
          cwd,
          branch: null,
          tools,
          permissions,
          signal: new AbortController().signal,
          mailbox,
          reportProgress: () => undefined,
        }),
      ).resolves.toMatchObject({ status: 'completed' })
      const state = await readdir(join(root, 'state', 'team-executions'), {
        recursive: true,
      })
      expect(state.some((name) => name.endsWith('.jsonl'))).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('builds Team worker guidance from observable assignment outcomes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-team-agent-outcomes-'))
    const cwd = await mkdtemp(join(root, 'checkout-'))
    const assignment: TeamTask = {
      id: 'outcome-task',
      description: 'Implement the observable assignment contract.',
      assignee: 'outcome-worker',
      blockedBy: [],
      claims: {
        files: ['src/feature.ts'],
        publicContracts: ['TeamWorkerContract'],
        generatedArtifacts: ['dist/feature.js'],
        migrations: ['migrate-feature'],
        mergeTargets: ['main'],
      },
      execution: null,
      usage: { generation: 0, totalTokens: 0, durationMs: 0 },
    }
    const requests: Array<Parameters<ModelProvider['complete']>[0]> = []
    try {
      const runtime = new ClaudeTeamAgentRuntime({
        nativeRoot: root,
        configRoot: root,
        claudeVersion: '2.1.208',
        provider: {
          capabilities: { streaming: true, usage: true, tools: true },
          async *complete(request) {
            requests.push(request)
            yield { type: 'text-delta', delta: 'completed' }
            yield {
              type: 'usage',
              usage: { inputTokens: 3, outputTokens: 2 },
            }
          },
        },
      })
      await expect(
        runtime.run({
          teamId: 'team-outcomes',
          task: assignment,
          member: {
            name: 'outcome-worker',
            agentType: 'general-purpose',
            access: 'read-only',
          },
          generation: 2,
          cwd,
          branch: 'feature/outcome-contract',
          tools,
          permissions,
          signal: new AbortController().signal,
          mailbox,
          reportProgress: () => undefined,
        }),
      ).resolves.toMatchObject({ status: 'completed' })

      const assignmentMessage = requests
        .flatMap((request) => request.messages)
        .find(
          (message) =>
            message.role === 'user' &&
            JSON.stringify(message.content).includes(assignment.id),
        )
      expect(assignmentMessage).toBeDefined()
      const guidance = JSON.stringify(assignmentMessage?.content)
      for (const value of [
        assignment.id,
        assignment.description,
        assignment.assignee,
        'general-purpose',
        'read-only',
        cwd,
        'feature/outcome-contract',
        ...assignment.claims.files,
        ...assignment.claims.publicContracts,
        ...assignment.claims.generatedArtifacts,
        ...assignment.claims.migrations,
        ...assignment.claims.mergeTargets,
      ])
        expect(guidance).toContain(value)
      expect(guidance.toLowerCase()).toContain('assigned cwd')
      expect(guidance.toLowerCase()).toContain('tools provided')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fails before transcript creation without usage and reports exact metered completion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-team-agent-usage-'))
    const cwd = await mkdtemp(join(root, 'checkout-'))
    const input = {
      teamId: 'team-a',
      task,
      member: {
        name: 'worker',
        agentType: 'general-purpose',
        access: 'read-only' as const,
      },
      generation: 1,
      cwd,
      branch: null,
      tools,
      permissions,
      signal: new AbortController().signal,
      mailbox,
    }
    try {
      const unsupported = new ClaudeTeamAgentRuntime({
        nativeRoot: root,
        configRoot: root,
        claudeVersion: '2.1.208',
        provider: {
          capabilities: { streaming: true, usage: false, tools: true },
          async *complete() {
            yield { type: 'text-delta', delta: 'unreachable' }
          },
        },
      })
      await expect(
        unsupported.run({ ...input, reportProgress: () => undefined }),
      ).rejects.toThrow('Team agent runtime requires provider usage capability')
      await expect(
        stat(join(root, 'state', 'team-executions')),
      ).rejects.toMatchObject({ code: 'ENOENT' })

      const reports: Array<{
        generation: number
        totalTokens: number
        durationMs: number
      }> = []
      const now = vi.spyOn(Date, 'now').mockReturnValue(10_000)
      const metered = new ClaudeTeamAgentRuntime({
        nativeRoot: root,
        configRoot: root,
        claudeVersion: '2.1.208',
        provider: {
          capabilities: { streaming: true, usage: true, tools: true },
          async *complete() {
            now.mockReturnValue(10_037)
            yield { type: 'text-delta', delta: 'metered' }
            yield {
              type: 'usage',
              usage: { inputTokens: 11, outputTokens: 7 },
            }
          },
        },
      })
      const result = await metered.run({
        ...input,
        reportProgress: (progress) => reports.push(progress),
      })
      expect(result).toEqual({
        status: 'completed',
        totalTokens: 18,
        durationMs: 37,
      })
      expect(reports.at(-1)).toEqual({
        generation: 1,
        totalTokens: 18,
        durationMs: 37,
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('routes Team asks through the Lead approver with provenance and honors denial', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-team-agent-approval-'))
    const cwd = await mkdtemp(join(root, 'checkout-'))
    let writeExecutions = 0
    let approval:
      | {
          call: ModelToolCall
          originalCall: ModelToolCall | undefined
          decision: PermissionDecision | undefined
        }
      | undefined
    const guardedTools: ToolRegistry = {
      definitions: () => [
        {
          name: 'Write',
          description: 'Write a file',
          inputSchema: { type: 'object' },
        },
      ],
      prepare: async (call) => call,
      execute: async () => {
        writeExecutions += 1
        return { content: 'WRITTEN', isError: false }
      },
    }
    try {
      const runtime = new ClaudeTeamAgentRuntime({
        nativeRoot: root,
        configRoot: root,
        claudeVersion: '2.1.208',
        provider: {
          capabilities: { streaming: true, usage: true, tools: true },
          async *complete(request) {
            if (request.messages.some((message) => message.role === 'tool')) {
              yield { type: 'text-delta', delta: 'TEAM_PERMISSION_DONE' }
              return
            }
            yield {
              type: 'tool-call',
              call: {
                id: 'team_write',
                name: 'Write',
                input: { file_path: join(cwd, 'denied.txt') },
              },
            }
          },
        },
        decisionSurface: {
          request: (request: TeamLeadDecisionRequest) => {
            approval = {
              call: request.call,
              originalCall: request.originalCall,
              decision: request.decision,
            }
            expect(request).toMatchObject({
              teamId: 'team-a',
              member: 'worker',
              taskId: 'task-a',
              generation: 1,
              call: { id: 'team_write', name: 'Write' },
              originalCall: { id: 'team_write' },
              decision: {
                behavior: 'ask',
                metadata: { origin: 'parent' },
              },
            })
            return { behavior: 'deny', message: 'Team Lead denied the write' }
          },
        },
      })
      const result = await runtime.run({
        teamId: 'team-a',
        task,
        member: {
          name: 'worker',
          agentType: 'general-purpose',
          access: 'write',
        },
        generation: 1,
        cwd,
        branch: null,
        tools: guardedTools,
        permissions: {
          resolve: () => ({
            behavior: 'ask',
            reason: 'Lead approval required',
            metadata: { origin: 'parent' },
          }),
        },
        signal: new AbortController().signal,
        mailbox,
        reportProgress: () => undefined,
      })

      expect(result.status).toBe('completed')
      expect(approval?.call).toMatchObject({ id: 'team_write', name: 'Write' })
      expect(approval?.originalCall).toMatchObject({ id: 'team_write' })
      expect(approval?.decision).toEqual({
        behavior: 'ask',
        reason:
          'Lead approval required [team=team-a member=worker task=task-a generation=1]',
        metadata: {
          origin: 'parent',
          teamId: 'team-a',
          member: 'worker',
          taskId: 'task-a',
          generation: 1,
        },
      })
      expect(writeExecutions).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('loads a custom Team agent without connecting its offered MCP server', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-team-agent-mcp-'))
    const cwd = await mkdtemp(join(root, 'checkout-'))
    let exposedTools: string[] = []
    const extensions = new ClaudeExtensionCatalog({
      commands: [],
      skills: [],
      agents: [
        {
          path: join(root, 'agents', 'mcp-agent.md'),
          scope: 'user',
          content:
            '---\nname: mcp-agent\ndescription: Team MCP isolation fixture.\nmcpServers:\n  - agent-fixture\n---\nTEAM_MCP_AGENT_POLICY',
        },
      ],
    })
    try {
      const runtime = new ClaudeTeamAgentRuntime({
        nativeRoot: root,
        configRoot: root,
        claudeVersion: '2.1.208',
        extensions,
        provider: {
          capabilities: { streaming: true, usage: true, tools: true },
          async *complete(request) {
            expect(JSON.stringify(request.messages)).toContain(
              'TEAM_MCP_AGENT_POLICY',
            )
            exposedTools = request.tools?.map(({ name }) => name) ?? []
            yield { type: 'text-delta', delta: 'MCP_ISOLATED' }
          },
        },
      })
      await runtime.run({
        teamId: 'team-a',
        task,
        member: {
          name: 'worker',
          agentType: 'mcp-agent',
          access: 'read-only',
        },
        generation: 1,
        cwd,
        branch: null,
        tools,
        permissions,
        signal: new AbortController().signal,
        mailbox,
        reportProgress: () => undefined,
      })

      expect(exposedTools).not.toContain('mcp__agent_fixture__probe')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('propagates provider failure and abort without creating Team lifecycle state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-team-agent-runtime-'))
    const cwd = await mkdtemp(join(root, 'checkout-'))
    try {
      const failure = new Error('provider failed')
      const cleanup = new Error('cleanup failed')
      vi.spyOn(ClaudeSubagentExecutor.prototype, 'close').mockRejectedValue(
        cleanup,
      )
      const runtime = new ClaudeTeamAgentRuntime({
        nativeRoot: root,
        configRoot: root,
        claudeVersion: '2.1.208',
        provider: {
          capabilities: { streaming: true, usage: true, tools: true },
          async *complete() {
            yield { type: 'text-delta', delta: '' }
            throw failure
          },
        },
      })
      const result = runtime.run({
        teamId: 'team-a',
        task,
        member: {
          name: 'worker',
          agentType: 'general-purpose',
          access: 'read-only',
        },
        generation: 1,
        cwd,
        branch: null,
        tools,
        permissions,
        signal: new AbortController().signal,
        mailbox,
        reportProgress: () => undefined,
      })
      await expect(result).rejects.toSatisfy((error: unknown) => {
        return (
          error instanceof AggregateError &&
          error.cause === error.errors[0] &&
          error.errors.length === 2 &&
          String(error.errors[0]).includes('provider failed') &&
          (error.errors[0] as Error).cause === failure &&
          String(error.errors[1]).includes('cleanup failed')
        )
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('publishes concrete adapter completion through LocalTeamManager state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-team-agent-runtime-'))
    const cwd = await mkdtemp(join(root, 'checkout-'))
    try {
      const runtime = new ClaudeTeamAgentRuntime({
        nativeRoot: root,
        configRoot: root,
        claudeVersion: '2.1.208',
        provider: {
          capabilities: { streaming: true, usage: true, tools: true },
          async *complete() {
            yield { type: 'text-delta', delta: 'manager-completed' }
          },
        },
      })
      const guarded = new TeamMemberToolRegistry({
        base: tools,
        access: 'read-only',
        cwd,
      })
      await expect(
        runtime.run({
          teamId: 'team-direct',
          task,
          member: {
            name: 'worker',
            agentType: 'general-purpose',
            access: 'read-only',
          },
          generation: 1,
          cwd,
          branch: null,
          tools: guarded,
          permissions,
          signal: new AbortController().signal,
          mailbox,
          reportProgress: () => undefined,
        }),
      ).resolves.toMatchObject({ status: 'completed' })
      const manager = await LocalTeamManager.open({
        nativeRoot: root,
        cwd,
        maxConcurrent: 1,
        baseTools: tools,
        permissions,
        runtime,
        workspace: {
          acquire: async () => ({
            cwd,
            branch: null,
            retain: async () => undefined,
          }),
          releaseAccepted: async () => undefined,
        },
      })
      const team = await manager.create({
        teamId: 'team-runtime',
        name: 'Runtime Team',
        leadSessionId: 'lead-runtime',
        roster: [
          { name: 'worker', agentType: 'general-purpose', access: 'read-only' },
        ],
        tasks: [
          {
            ...task,
            assignee: 'worker',
          },
        ],
      })
      await expect(team.waitForIdle()).resolves.toMatchObject({
        tasks: [{ execution: { state: 'completed' } }],
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('proves guarded read-only tools and retained writer isolation through LocalTeamManager', async () => {
    const repo = await gitRepository()
    const nativeRoot = await mkdtemp(
      join(tmpdir(), 'praxis-team-runtime-native-'),
    )
    try {
      const baseTools = new LocalToolRegistry({
        cwd: repo,
        configRoot: nativeRoot,
        dataPlane: 'native',
      })
      const readerRuntime = new ClaudeTeamAgentRuntime({
        nativeRoot,
        configRoot: nativeRoot,
        claudeVersion: '2.1.208',
        provider: scriptedProvider('read'),
      })
      const manager = await LocalTeamManager.open({
        nativeRoot,
        cwd: repo,
        maxConcurrent: 1,
        baseTools,
        permissions,
        runtime: readerRuntime,
      })
      const reader = await manager.create({
        teamId: 'team-reader',
        name: 'Reader',
        leadSessionId: 'lead-reader',
        roster: [
          { name: 'reader', agentType: 'general-purpose', access: 'read-only' },
        ],
        tasks: [{ ...task, id: 'READ_TASK', assignee: 'reader' }],
      })
      await expect(reader.waitForIdle()).resolves.toMatchObject({
        tasks: [{ execution: { state: 'completed' } }],
      })
      const deniedRuntime = new ClaudeTeamAgentRuntime({
        nativeRoot,
        configRoot: nativeRoot,
        claudeVersion: '2.1.208',
        provider: scriptedProvider('rejected-write'),
      })
      const deniedManager = await LocalTeamManager.open({
        nativeRoot,
        cwd: repo,
        maxConcurrent: 1,
        baseTools,
        permissions,
        runtime: deniedRuntime,
      })
      const denied = await deniedManager.create({
        teamId: 'team-denied',
        name: 'Denied',
        leadSessionId: 'lead-denied',
        roster: [
          { name: 'reader', agentType: 'general-purpose', access: 'read-only' },
        ],
        tasks: [{ ...task, id: 'DENY_WRITE_TASK', assignee: 'reader' }],
      })
      await expect(denied.waitForIdle()).resolves.toMatchObject({
        tasks: [{ execution: { state: 'failed' } }],
      })
      expect(await readFile(join(repo, 'fixture.txt'), 'utf8')).toBe(
        'fixture\n',
      )
      await expect(stat(join(repo, 'writer.txt'))).rejects.toMatchObject({
        code: 'ENOENT',
      })

      const writerRuntime = new ClaudeTeamAgentRuntime({
        nativeRoot,
        configRoot: nativeRoot,
        claudeVersion: '2.1.208',
        provider: scriptedProvider('write'),
      })
      const writerManager = await LocalTeamManager.open({
        nativeRoot,
        cwd: repo,
        maxConcurrent: 1,
        baseTools,
        permissions,
        runtime: writerRuntime,
      })
      const writer = await writerManager.create({
        teamId: 'team-writer',
        name: 'Writer',
        leadSessionId: 'lead-writer',
        roster: [
          { name: 'writer', agentType: 'general-purpose', access: 'write' },
        ],
        tasks: [{ ...task, id: 'WRITE_TASK', assignee: 'writer' }],
      })
      await expect(writer.waitForIdle()).resolves.toMatchObject({
        tasks: [{ execution: { state: 'completed' } }],
      })
      await expect(
        readFile(join(repo, 'writer.txt'), 'utf8'),
      ).rejects.toMatchObject({ code: 'ENOENT' })
      const identity = await resolveProjectIdentity(repo)
      const repoRoot = await realpath(repo)
      const hash = createHash('sha256')
        .update(`${identity}\0team-writer\0WRITE_TASK\0${1}`)
        .digest('hex')
        .slice(0, 24)
      const worktree = join(
        repoRoot,
        '.praxis',
        'worktrees',
        'team',
        'team-writer',
        hash,
      )
      expect(await readFile(join(worktree, 'writer.txt'), 'utf8')).toBe(
        'writer\n',
      )
      expect(await git(repo, 'worktree', 'list', '--porcelain')).toContain(
        worktree,
      )
      const registry = await inspectManagedWorktreeRegistry({
        stateRoot: nativeRoot,
        repositoryRoot: identity,
        limit: 64,
      })
      const record = registry.entries.find(
        (entry) => 'record' in entry && entry.record.worktreePath === worktree,
      )
      expect(
        record && 'record' in record ? record.record : undefined,
      ).toMatchObject({
        kind: 'team',
        policy: 'durable',
        worktreePath: worktree,
        branch: `praxis/team/team-writer/${hash}`,
        ownerId: expect.stringMatching(
          new RegExp(`^team:team-writer:1:${hash}:[A-Za-z0-9_-]+$`, 'u'),
        ),
        state: 'retained',
      })
      expect(
        await readdir(join(nativeRoot, 'state'), { recursive: true }),
      ).not.toContain('subagent-lifecycle.json')
    } finally {
      await rm(repo, { recursive: true, force: true })
      await rm(nativeRoot, { recursive: true, force: true })
    }
  })

  it('lets LocalTeam stop classify an abort-aware adapter run', async () => {
    const repo = await gitRepository()
    const nativeRoot = await mkdtemp(
      join(tmpdir(), 'praxis-team-runtime-native-'),
    )
    let entered!: () => void
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve
    })
    try {
      const provider: ModelProvider = {
        capabilities: { streaming: true, usage: true, tools: false },
        async *complete(request) {
          entered()
          await new Promise<void>((resolve) => {
            if (request.signal?.aborted) resolve()
            else
              request.signal?.addEventListener('abort', () => resolve(), {
                once: true,
              })
          })
          yield { type: 'text-delta', delta: '' }
          return
        },
      }
      const baseTools = new LocalToolRegistry({
        cwd: repo,
        configRoot: nativeRoot,
        dataPlane: 'native',
      })
      const manager = await LocalTeamManager.open({
        nativeRoot,
        cwd: repo,
        maxConcurrent: 1,
        baseTools,
        permissions,
        runtime: new ClaudeTeamAgentRuntime({
          nativeRoot,
          configRoot: nativeRoot,
          claudeVersion: '2.1.208',
          provider,
        }),
      })
      const team = await manager.create({
        teamId: 'team-abort',
        name: 'Abort',
        leadSessionId: 'lead-abort',
        roster: [
          { name: 'worker', agentType: 'general-purpose', access: 'read-only' },
        ],
        tasks: [{ ...task, id: 'ABORT_TASK', assignee: 'worker' }],
      })
      await enteredPromise
      await expect(team.stop({ drainMs: 1_000 })).resolves.toMatchObject({
        tasks: [{ execution: { state: 'cancelled' } }],
      })
    } finally {
      await rm(repo, { recursive: true, force: true })
      await rm(nativeRoot, { recursive: true, force: true })
    }
  })
})
