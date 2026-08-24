import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import {
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

import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  ModelProvider,
  PermissionResolver,
  ToolRegistry,
} from '../core/runtime.js'
import type { TeamTask } from '../core/team-ownership.js'
import { resolveProjectIdentity } from '../platform/project-identity.js'
import { sanitizeProjectPath } from '../platform/project-path-key.js'
import { LocalToolRegistry } from '../tools/local-tools.js'
import { TeamMemberToolRegistry } from '../tools/team-member-tools.js'
import { LocalTeamManager } from './team-manager.js'
import { ClaudeTeamAgentRuntime } from './team-agent-runtime.js'
import { ClaudeSubagentExecutor } from './subagent-service.js'
import type { TeamMailboxEndpoint } from './team-mailbox.js'

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
}

describe('ClaudeTeamAgentRuntime', () => {
  afterEach(() => {
    vi.restoreAllMocks()
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
        }),
      ).resolves.toBe('completed')
      const state = await readdir(join(root, 'state', 'team-executions'), {
        recursive: true,
      })
      expect(state.some((name) => name.endsWith('.jsonl'))).toBe(true)
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
        }),
      ).resolves.toBe('completed')
      const manager = await LocalTeamManager.open({
        nativeRoot: root,
        cwd,
        maxConcurrent: 1,
        baseTools: tools,
        permissions,
        runtime,
        workspace: { acquire: async () => ({ cwd, branch: null }) },
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
      const hash = createHash('sha256')
        .update(`${identity}\0team-writer\0WRITE_TASK\0${1}`)
        .digest('hex')
        .slice(0, 24)
      const worktree = join(
        nativeRoot,
        'state',
        'team-worktrees',
        sanitizeProjectPath(identity),
        'team-writer',
        hash,
      )
      expect(await readFile(join(worktree, 'writer.txt'), 'utf8')).toBe(
        'writer\n',
      )
      expect(await git(repo, 'worktree', 'list', '--porcelain')).toContain(
        worktree,
      )
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
