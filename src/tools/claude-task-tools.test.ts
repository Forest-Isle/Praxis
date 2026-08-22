import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { resolveClaudePaths } from '../compatibility/claude/paths.js'
import { LocalToolRegistry } from './local-tools.js'
import { ClaudeTaskToolRegistry } from './claude-task-tools.js'
import type { ModelProvider, PermissionResolver } from '../core/runtime.js'
import { ClaudeSessionService } from '../application/session-service.js'
import { ClaudeSubagentExecutor } from '../application/subagent-service.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

async function createRegistry() {
  const root = await mkdtemp(join(tmpdir(), 'praxis-task-tools-'))
  roots.push(root)
  const cwd = join(root, 'work')
  await mkdir(cwd)
  const configRoot = join(root, 'config')
  const sessionId = '20202020-2020-4020-8020-202020202020'
  const paths = resolveClaudePaths({ configDir: configRoot, cwd, sessionId })
  return {
    root,
    cwd,
    configRoot,
    sessionId,
    registry: new ClaudeTaskToolRegistry({
      base: new LocalToolRegistry({ cwd }),
      cwd,
      praxisRoot: paths.praxisRoot,
      sessionId,
      taskRoot: paths.taskRoot,
    }),
  }
}

async function execute(
  registry: ClaudeTaskToolRegistry,
  cwd: string,
  name: string,
  input: Record<string, unknown>,
) {
  const call = await registry.prepare(
    { id: `call_${name}`, name, input },
    { cwd },
  )
  return registry.execute(call, { cwd })
}

describe('ClaudeTaskToolRegistry', () => {
  it('exposes Claude task schemas and augments Bash once', async () => {
    const { registry } = await createRegistry()
    const definitions = registry.definitions()
    expect(definitions.map(({ name }) => name)).toEqual([
      'Read',
      'Write',
      'Edit',
      'NotebookEdit',
      'Glob',
      'Grep',
      'Bash',
      'TaskCreate',
      'TaskGet',
      'TaskList',
      'TaskOutput',
      'TaskStop',
      'TaskUpdate',
    ])
    const bash = definitions.find(({ name }) => name === 'Bash')
    expect(bash?.inputSchema).toMatchObject({
      properties: {
        command: { type: 'string' },
        timeout: { type: 'number' },
        description: { type: 'string' },
        run_in_background: { type: 'boolean' },
      },
      required: ['command'],
      additionalProperties: false,
    })
    expect(
      definitions.find(({ name }) => name === 'TaskCreate')?.inputSchema,
    ).toMatchObject({ required: ['subject', 'description'] })
    expect(
      registry.schedulingPolicy({
        id: 'task',
        name: 'TaskCreate',
        input: {},
      }),
    ).toMatchObject({ concurrency: 'exclusive' })
    expect(
      registry.schedulingPolicy({
        id: 'bash-read',
        name: 'Bash',
        input: { command: 'pwd' },
      }),
    ).toMatchObject({ concurrency: 'concurrent' })
  })

  it('creates, updates, lists, gets, and deletes durable tasks', async () => {
    const { registry, cwd, configRoot, sessionId } = await createRegistry()
    const created = await execute(registry, cwd, 'TaskCreate', {
      subject: 'First task',
      description: 'Complete first',
      metadata: { priority: 'high' },
    })
    expect(created).toMatchObject({
      content: 'Task #1 created successfully: First task',
      nativeToolUseResult: { task: { id: '1', subject: 'First task' } },
    })
    await execute(registry, cwd, 'TaskCreate', {
      subject: 'Second task',
      description: 'Complete second',
    })
    const updated = await execute(registry, cwd, 'TaskUpdate', {
      taskId: '2',
      owner: 'worker-a',
      addBlockedBy: ['1'],
      metadata: { note: 'waiting' },
    })
    expect(updated).toMatchObject({
      content: 'Updated task #2 owner, metadata, blockedBy',
      nativeToolUseResult: {
        success: true,
        taskId: '2',
        updatedFields: ['owner', 'metadata', 'blockedBy'],
      },
    })
    await expect(
      execute(registry, cwd, 'TaskUpdate', {
        taskId: '2',
        owner: 'worker-a',
        addBlockedBy: ['1'],
      }),
    ).resolves.toMatchObject({
      nativeToolUseResult: { success: true, updatedFields: [] },
    })
    await expect(
      execute(registry, cwd, 'TaskUpdate', {
        taskId: '999',
        status: 'completed',
      }),
    ).resolves.toMatchObject({
      nativeToolUseResult: {
        success: false,
        taskId: '999',
        updatedFields: [],
        error: 'Task 999 not found',
      },
    })
    const listed = await execute(registry, cwd, 'TaskList', {})
    expect(listed.content).toBe(
      '#1 [pending] First task\n#2 [pending] Second task (worker-a) [blocked by #1]',
    )
    const fetched = await execute(registry, cwd, 'TaskGet', { taskId: '2' })
    expect(fetched.content).toContain('Blocked by: #1')
    expect(fetched.nativeToolUseResult).toEqual({
      task: {
        id: '2',
        subject: 'Second task',
        description: 'Complete second',
        status: 'pending',
        blocks: [],
        blockedBy: ['1'],
      },
    })
    await execute(registry, cwd, 'TaskUpdate', {
      taskId: '1',
      status: 'completed',
    })
    expect((await execute(registry, cwd, 'TaskList', {})).content).toContain(
      '#2 [pending] Second task (worker-a)',
    )
    await execute(registry, cwd, 'TaskUpdate', {
      taskId: '2',
      status: 'deleted',
    })
    await expect(
      readFile(join(configRoot, 'tasks', sessionId, '.highwatermark'), 'utf8'),
    ).resolves.toBe('2')
  })

  it('runs blocking task lifecycle hooks at create and completion boundaries', async () => {
    const fixture = await createRegistry()
    const paths = resolveClaudePaths({
      configDir: fixture.configRoot,
      cwd: fixture.cwd,
      sessionId: fixture.sessionId,
    })
    const events: string[] = []
    let blockCompletion = true
    const registry = new ClaudeTaskToolRegistry({
      base: new LocalToolRegistry({ cwd: fixture.cwd }),
      cwd: fixture.cwd,
      praxisRoot: paths.praxisRoot,
      sessionId: fixture.sessionId,
      taskRoot: paths.taskRoot,
      taskHooks: {
        async created(task) {
          events.push(`created:${task.id}:${task.subject}`)
          if (task.subject === 'Blocked task') throw new Error('blocked create')
        },
        async completed(task) {
          events.push(`completed:${task.id}:${task.subject}`)
          if (blockCompletion) throw new Error('blocked completion')
        },
      },
    })

    await expect(
      execute(registry, fixture.cwd, 'TaskCreate', {
        subject: 'Blocked task',
        description: 'Must roll back',
      }),
    ).rejects.toThrow('blocked create')
    expect((await execute(registry, fixture.cwd, 'TaskList', {})).content).toBe(
      'No tasks found',
    )
    const created = await execute(registry, fixture.cwd, 'TaskCreate', {
      subject: 'Allowed task',
      description: 'Complete later',
    })
    expect(created.nativeToolUseResult).toMatchObject({
      task: { id: '2', subject: 'Allowed task' },
    })
    await expect(
      execute(registry, fixture.cwd, 'TaskUpdate', {
        taskId: '2',
        status: 'completed',
      }),
    ).rejects.toThrow('blocked completion')
    expect(
      (await execute(registry, fixture.cwd, 'TaskGet', { taskId: '2' }))
        .nativeToolUseResult,
    ).toMatchObject({ task: { status: 'pending' } })
    blockCompletion = false
    await execute(registry, fixture.cwd, 'TaskUpdate', {
      taskId: '2',
      status: 'completed',
    })
    expect(events).toEqual([
      'created:1:Blocked task',
      'created:2:Allowed task',
      'completed:2:Allowed task',
      'completed:2:Allowed task',
    ])
  })

  it('runs Bash in background and routes output and stop by b-prefixed ID', async () => {
    const { registry, cwd } = await createRegistry()
    const launched = await execute(registry, cwd, 'Bash', {
      command: "printf 'READY\\n'; sleep 0.05; printf 'DONE\\n'",
      description: 'Emit output',
      run_in_background: true,
    })
    const taskId = String(launched.nativeToolUseResult?.backgroundTaskId)
    expect(taskId).toMatch(/^b[a-z0-9]{8}$/u)
    const output = await execute(registry, cwd, 'TaskOutput', {
      task_id: taskId,
      block: true,
      timeout: 30_000,
    })
    expect(output.content).toContain('<status>completed</status>')
    expect(output.nativeToolUseResult).toMatchObject({
      retrieval_status: 'success',
    })
  })

  it('wires durable task tools into a persisted session', async () => {
    const { cwd, configRoot, sessionId } = await createRegistry()
    const local = new LocalToolRegistry({ cwd })
    const provider: ModelProvider = {
      model: 'fixture-model',
      capabilities: { streaming: true, usage: true, tools: true },
      async *complete(request) {
        if (!JSON.stringify(request.messages).includes('Task #1 created')) {
          yield {
            type: 'tool-call',
            call: {
              id: 'create_task',
              name: 'TaskCreate',
              input: { subject: 'Session task', description: 'Persist it' },
            },
          }
        } else {
          yield { type: 'text-delta', delta: 'SESSION_DONE' }
        }
      },
    }
    const permissions: PermissionResolver = {
      resolve: () => ({ behavior: 'allow' }),
    }
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider,
      tools: local,
      permissions,
      taskToolNames: [
        'TaskCreate',
        'TaskGet',
        'TaskList',
        'TaskOutput',
        'TaskStop',
        'TaskUpdate',
      ],
    })

    await expect(
      service.run('create task', undefined, sessionId),
    ).resolves.toMatchObject({ text: 'SESSION_DONE' })
    await expect(
      readFile(join(configRoot, 'tasks', sessionId, '1.json'), 'utf8'),
    ).resolves.toContain('Session task')
  })

  it('augments Bash when no structured task tools are enabled', async () => {
    const { cwd, configRoot, sessionId } = await createRegistry()
    let sawBackgroundBash = false
    const provider: ModelProvider = {
      capabilities: { streaming: true, usage: true, tools: true },
      async *complete(request) {
        const bash = request.tools?.find(({ name }) => name === 'Bash')
        const properties = bash?.inputSchema.properties as
          Record<string, unknown> | undefined
        sawBackgroundBash = properties?.run_in_background !== undefined
        yield { type: 'text-delta', delta: 'BASH_ONLY_DONE' }
      },
    }
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider,
      tools: new LocalToolRegistry({ cwd }),
      permissions: { resolve: () => ({ behavior: 'allow' }) },
      taskToolNames: ['Bash'],
    })

    await expect(
      service.run('inspect Bash', undefined, sessionId),
    ).resolves.toMatchObject({ text: 'BASH_ONLY_DONE' })
    expect(sawBackgroundBash).toBe(true)
  })

  it('deduplicates task management definitions and preserves b-task routing', async () => {
    const {
      registry: tasks,
      cwd,
      configRoot,
      sessionId,
    } = await createRegistry()
    const provider: ModelProvider = {
      model: 'fixture-model',
      capabilities: { streaming: true, usage: true, tools: true },
      async *complete() {
        yield { type: 'text-delta', delta: 'unused' }
      },
    }
    const executor = new ClaudeSubagentExecutor({
      configRoot,
      dataPlane: 'claude',
      cwd,
      claudeVersion: '2.1.208',
      provider,
      baseTools: tasks,
      permissions: { resolve: () => ({ behavior: 'allow' }) },
    })
    const registry = executor.registry(sessionId, 0, () => 'prompt-id')
    expect(
      registry.definitions().filter(({ name }) => name === 'TaskOutput'),
    ).toHaveLength(1)

    const launched = await execute(tasks, cwd, 'Bash', {
      command: 'printf routed',
      run_in_background: true,
    })
    const id = String(launched.nativeToolUseResult?.backgroundTaskId)
    const call = await registry.prepare(
      {
        id: 'task_output',
        name: 'TaskOutput',
        input: { task_id: id, block: true, timeout: 30_000 },
      },
      { cwd },
    )
    await expect(registry.execute(call, { cwd })).resolves.toMatchObject({
      nativeToolUseResult: { retrieval_status: 'success' },
    })
  })
})
