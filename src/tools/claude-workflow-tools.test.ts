import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { WorkflowManager } from '../application/workflow-manager.js'
import type { ClaudeSubagentExecutor } from '../application/subagent-service.js'
import type {
  ModelToolCall,
  ToolExecutionContext,
  ToolRegistry,
} from '../core/runtime.js'
import { ClaudeWorkflowToolRegistry } from './claude-workflow-tools.js'

const roots: string[] = []
const sessionId = '22222222-2222-4222-8222-222222222222'
const context: ToolExecutionContext = { cwd: '/work' }

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  )
})

function base(): ToolRegistry {
  return {
    definitions: () => [],
    schedulingPolicy: () => ({ concurrency: 'concurrent' }),
    prepare: async (call) => call,
    execute: async () => ({ content: 'base', isError: false }),
  }
}

async function fixture(dataPlane: 'native' | 'claude' = 'claude') {
  const root = await mkdtemp(join(tmpdir(), 'praxis-workflow-tools-'))
  roots.push(root)
  const cwd = join(root, 'work')
  const configRoot = join(root, 'config')
  await mkdir(cwd, { recursive: true })
  const runWorkflowAgent = vi.fn(async () => ({
    result: 'agent result',
    usage: { inputTokens: 1, outputTokens: 1 },
    toolUseCount: 0,
    durationMs: 1,
    resolvedModel: 'fixture-model',
  }))
  const registry = new ClaudeWorkflowToolRegistry({
    base: base(),
    manager: new WorkflowManager(configRoot, cwd),
    executor: { runWorkflowAgent } as unknown as ClaudeSubagentExecutor,
    cwd,
    configRoot,
    sessionId,
    promptIdForCall: () => 'prompt-id',
    defaultModel: 'fixture-model',
    enabled: true,
    dataPlane,
  })
  return { root, cwd, registry, runWorkflowAgent }
}

function call(input: Record<string, unknown>): ModelToolCall {
  return { id: 'workflow-call', name: 'Workflow', input }
}

const script = `export const meta = {
  name: 'tool-probe',
  description: 'Probe workflow tool',
}
return { marker: args.marker }`

describe('ClaudeWorkflowToolRegistry', () => {
  it('publishes the optional Claude schema without a required array', async () => {
    const { registry } = await fixture()
    const workflow = registry
      .definitions()
      .find(({ name }) => name === 'Workflow')
    expect(workflow?.inputSchema).toMatchObject({
      type: 'object',
      properties: {
        script: { type: 'string', maxLength: 524_288 },
        args: {},
        resumeFromRunId: { pattern: '^wf_[a-z0-9-]{6,}$' },
      },
      additionalProperties: false,
    })
    expect(workflow?.inputSchema).not.toHaveProperty('required')
    expect(workflow?.description).toContain('explicitly requested')
    expect(workflow?.description).toContain('pipeline(items, ...stages)')
    expect(workflow?.description).toContain('resumeFromRunId')
    expect(registry.schedulingPolicy(call({}))).toMatchObject({
      concurrency: 'exclusive',
    })
    expect(
      registry.schedulingPolicy({ id: 'read', name: 'Read', input: {} }),
    ).toEqual({ concurrency: 'concurrent' })
  })

  it('validates before launch, preserves public input, and routes task output', async () => {
    const { registry } = await fixture()
    await expect(registry.prepare(call({}), context)).rejects.toThrow(
      'Must provide script, name, or scriptPath',
    )
    const prepared = await registry.prepare(
      call({ script, args: { marker: 'ok' } }),
      context,
    )
    expect(prepared.input).toEqual({ script, args: { marker: 'ok' } })
    const launched = await registry.execute(prepared, context)
    const taskId = /Task ID: (w[a-z0-9]{8})/u.exec(launched.content)?.[1]
    expect(taskId).toBeTruthy()
    const outputCall = await registry.prepare(
      {
        id: 'output-call',
        name: 'TaskOutput',
        input: { task_id: taskId, block: true, timeout: 5_000 },
      },
      context,
    )
    const output = await registry.execute(outputCall, context)
    expect(output.content).toContain('"marker": "ok"')
  })

  it('uses scriptPath ahead of script and resolves project saved workflows', async () => {
    const { cwd, registry } = await fixture()
    await expect(
      registry.prepare(call({ scriptPath: 'missing.js', script }), context),
    ).rejects.toThrow(
      `Workflow script file not found: ${join(cwd, 'missing.js')}`,
    )
    const directory = join(cwd, '.claude', 'workflows')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'saved.js'), script)
    const prepared = await registry.prepare(call({ name: 'saved' }), context)
    expect(prepared.input).toEqual({ name: 'saved' })
  })

  it('describes and resolves only the native project workflow directory', async () => {
    const { cwd, registry } = await fixture('native')
    expect(
      registry.definitions().find(({ name }) => name === 'Workflow')
        ?.description,
    ).toContain('`.praxis/workflows`')
    const directory = join(cwd, '.praxis', 'workflows')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'saved.js'), script)

    await expect(
      registry.prepare(call({ name: 'saved' }), context),
    ).resolves.toMatchObject({ input: { name: 'saved' } })
  })
})
