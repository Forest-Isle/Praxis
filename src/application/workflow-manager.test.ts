import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { parseWorkflowScript } from './workflow-meta.js'
import { WorkflowManager } from './workflow-manager.js'

const roots: string[] = []
const sessionId = '11111111-1111-4111-8111-111111111111'

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  )
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'praxis-workflow-manager-'))
  roots.push(root)
  const cwd = join(root, 'work')
  const manager = new WorkflowManager(join(root, 'config'), cwd)
  const script = `export const meta = {
  name: 'probe',
  description: 'Run probe agent',
  phases: [{ title: 'Agent', detail: 'Run one agent' }],
}
phase('Agent')
const value = await agent(args.prompt, { label: 'Probe' })
return { value }`
  return { manager, script, parsed: parseWorkflowScript(script) }
}

describe('WorkflowManager', () => {
  it('persists a completed run and replays a foreign key by unique prompt', async () => {
    const { manager, script, parsed } = await fixture()
    const runAgent = vi.fn(async () => ({
      result: 'agent-result',
      usage: { inputTokens: 3, outputTokens: 2 },
      toolUseCount: 1,
      durationMs: 4,
      resolvedModel: 'fixture-model',
    }))
    const first = await manager.launch({
      sessionId,
      promptId: 'prompt-1',
      script,
      parsed,
      args: { prompt: 'hello' },
      defaultModel: 'fixture-model',
      runAgent,
      resolveNested: async () => {
        throw new Error('not used')
      },
    })
    const notifications = await manager.notifications(true)
    expect(notifications).toMatchObject({
      messages: [expect.stringContaining('<task-notification>')],
      usage: { inputTokens: 3, outputTokens: 2 },
    })
    const firstOutput = await manager.output(first.taskId, {
      block: true,
      timeout: 5_000,
    })
    expect(firstOutput).toContain('"status": "completed"')
    const firstDuration = (
      JSON.parse(firstOutput.slice(0, firstOutput.indexOf('\n\n'))) as {
        durationMs: number
      }
    ).durationMs
    const terminalDuration = manager.list()[0]?.durationMs
    await new Promise((resolveWait) => setTimeout(resolveWait, 10))
    expect(manager.list()[0]?.durationMs).toBe(terminalDuration)
    const repeatedOutput = await manager.output(first.taskId, {
      block: false,
      timeout: 0,
    })
    expect(
      JSON.parse(repeatedOutput.slice(0, repeatedOutput.indexOf('\n\n')))
        .durationMs,
    ).toBe(firstDuration)
    expect(notifications.messages[0]).toContain(`duration_ms: ${firstDuration}`)
    const run = JSON.parse(
      await readFile(
        join(
          first.transcriptDirectory,
          '..',
          '..',
          '..',
          'workflows',
          `${first.runId}.json`,
        ),
        'utf8',
      ),
    )
    expect(run).toMatchObject({
      runId: first.runId,
      agentCount: 1,
      result: { value: 'agent-result' },
      status: 'completed',
      totalTokens: 2,
      totalToolCalls: 1,
      workflowProgress: [
        { type: 'workflow_phase', index: 1, title: 'Agent' },
        {
          type: 'workflow_agent',
          index: 1,
          label: 'Probe',
          phaseIndex: 1,
          phaseTitle: 'Agent',
          model: 'fixture-model',
          fallbackModel: 'fixture-model',
          state: 'done',
          attempt: 1,
          promptPreview: 'hello',
          tokens: 2,
          toolCalls: 1,
          durationMs: 4,
          resultPreview: 'agent-result',
        },
      ],
    })
    expect(run.workflowProgress[1]).toMatchObject({
      agentId: expect.stringMatching(/^a[0-9a-f]{16}$/u),
      queuedAt: expect.any(Number),
      startedAt: expect.any(Number),
      lastProgressAt: expect.any(Number),
    })
    const journalFile = join(first.transcriptDirectory, 'journal.jsonl')
    const journal = (await readFile(journalFile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    for (const entry of journal) {
      entry.key =
        'v2:f046248ee62ac380b6977306fd357cbf5a9526dc71bcd077d3069f906ea2793b'
    }
    await Promise.all([
      writeFile(
        journalFile,
        `${journal.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
      ),
      writeFile(
        join(first.transcriptDirectory, `agent-${journal[0]?.agentId}.jsonl`),
        `${JSON.stringify({ message: { role: 'user', content: 'hello' } })}\n`,
      ),
      rm(join(first.transcriptDirectory, '.praxis-replay-metadata.jsonl')),
    ])

    const resumed = await manager.launch({
      sessionId,
      promptId: 'prompt-2',
      script,
      parsed,
      args: { prompt: 'hello' },
      resumeFromRunId: first.runId,
      defaultModel: 'fixture-model',
      runAgent,
      resolveNested: async () => {
        throw new Error('not used')
      },
    })
    await manager.output(resumed.taskId, { block: true, timeout: 5_000 })
    expect(runAgent).toHaveBeenCalledTimes(1)
    expect(manager.list().at(-1)).toMatchObject({
      status: 'completed',
      progress: [{ cached: true, totalTokens: 0, toolCalls: 0 }],
    })
    await manager.close()
  })

  it('replays foreign journal keys by deterministic ordered semantic replay', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-workflow-manager-'))
    roots.push(root)
    const manager = new WorkflowManager(
      join(root, 'config'),
      join(root, 'work'),
    )
    const script = `export const meta = {
  name: 'semantic-replay',
  description: 'Replay one semantic agent',
}
return agent('semantic prompt', {
  model: 'alternate-model',
  effort: 'low',
  agentType: 'general-purpose',
  schema: { type: 'object', properties: { value: { type: 'string' } } },
})`
    const parsed = parseWorkflowScript(script)
    const runAgent = vi.fn(async () => ({
      result: { value: 'cached' },
      usage: { inputTokens: 3, outputTokens: 2 },
      toolUseCount: 1,
      durationMs: 4,
      resolvedModel: 'alternate-model',
    }))
    const launch = (resumeFromRunId?: string) =>
      manager.launch({
        sessionId,
        promptId: resumeFromRunId ? 'prompt-resume' : 'prompt-first',
        script,
        parsed,
        args: null,
        ...(resumeFromRunId ? { resumeFromRunId } : {}),
        defaultModel: 'default-model',
        runAgent,
        resolveNested: async () => {
          throw new Error('not used')
        },
      })

    const first = await launch()
    await manager.output(first.taskId, { block: true, timeout: 5_000 })
    const journal = (
      await readFile(join(first.transcriptDirectory, 'journal.jsonl'), 'utf8')
    )
      .trim()
      .split('\n')
      .map((line) => ({ ...JSON.parse(line), key: 'v2:foreign' }))
    await writeFile(
      join(first.transcriptDirectory, 'journal.jsonl'),
      `${journal.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
    )
    await rm(join(first.transcriptDirectory, '.praxis-replay-metadata.jsonl'))

    const resumed = await launch(first.runId)
    await manager.output(resumed.taskId, { block: true, timeout: 5_000 })
    expect(runAgent).toHaveBeenCalledTimes(1)
    expect(manager.list().at(-1)).toMatchObject({
      progress: [{ cached: true, result: { value: 'cached' } }],
    })
    await manager.close()
  })

  it('scopes snapshots and stop ownership to the launching session', async () => {
    const { manager, script, parsed } = await fixture()
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const runAgent = vi.fn(
      async (options: { signal?: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          markStarted()
          options.signal?.addEventListener(
            'abort',
            () => reject(new Error('aborted')),
            { once: true },
          )
        }),
    )
    const launched = await manager.launch({
      sessionId,
      promptId: 'prompt-scoped',
      script,
      parsed,
      args: { prompt: 'wait' },
      defaultModel: 'fixture-model',
      runAgent,
      resolveNested: async () => {
        throw new Error('not used')
      },
    })
    await started

    expect(manager.list(sessionId)).toMatchObject([
      { task_id: launched.taskId, status: 'running' },
    ])
    expect(manager.list('other-session')).toEqual([])
    expect(manager.hasForSession(sessionId, launched.taskId)).toBe(true)
    expect(manager.hasForSession('other-session', launched.taskId)).toBe(false)
    await manager.stopAndWait(launched.taskId)
    const terminal = manager.list(sessionId)[0]
    expect(terminal).toMatchObject({ status: 'killed' })
    const duration = terminal?.durationMs
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(manager.list(sessionId)[0]?.durationMs).toBe(duration)
    await expect(manager.stopAndWait(launched.taskId)).rejects.toThrow(
      `Task ${launched.taskId} is not running (status: killed)`,
    )
    await manager.close()
  })

  it('writes Claude v2 chained keys for repeated agent calls', async () => {
    const { manager } = await fixture()
    const script = `export const meta = {
  name: 'exact-key',
  description: 'Write exact replay keys',
}
const first = await agent('P0')
const second = await agent('P0')
return { first, second }`
    const runAgent = vi.fn(async () => ({
      result: 'done',
      usage: { inputTokens: 1, outputTokens: 1 },
      toolUseCount: 0,
      durationMs: 1,
      resolvedModel: 'fixture-model',
    }))
    const launch = (resumeFromRunId?: string) =>
      manager.launch({
        sessionId,
        promptId: resumeFromRunId ? 'prompt-exact-resume' : 'prompt-exact-key',
        script,
        parsed: parseWorkflowScript(script),
        args: null,
        ...(resumeFromRunId ? { resumeFromRunId } : {}),
        defaultModel: 'fixture-model',
        runAgent,
        resolveNested: async () => {
          throw new Error('not used')
        },
      })
    const first = await launch()
    await manager.output(first.taskId, { block: true, timeout: 5_000 })
    const journalFile = join(first.transcriptDirectory, 'journal.jsonl')
    const journalSource = await readFile(journalFile, 'utf8')
    const started = journalSource
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter(({ type }) => type === 'started')
      .map(({ key }) => key)
    expect(started).toEqual([
      'v2:8cb48efd10ba515c873fbaa3762384198b6c850c61e7ce05e8c16e342e6e1799',
      'v2:7f8f9a0b8fc028cb45d5aed858181c40dd3cc583a966fa73ece75cc40df1ff80',
    ])

    const resumed = await launch(first.runId)
    await manager.output(resumed.taskId, { block: true, timeout: 5_000 })
    expect(runAgent).toHaveBeenCalledTimes(2)
    expect(await readFile(journalFile, 'utf8')).toBe(journalSource)
    await manager.close()
  })

  it('shares the Claude replay chain with nested workflow agents', async () => {
    const { manager } = await fixture()
    const script = `export const meta = {
  name: 'nested-key',
  description: 'Write a nested replay key',
}
const first = await agent('P0')
const nested = await workflow('nested-key-child', null)
return { first, nested }`
    const nestedScript = `export const meta = {
  name: 'nested-key-child',
  description: 'Write nested key',
}
return agent('P1')`
    const launch = await manager.launch({
      sessionId,
      promptId: 'prompt-nested-key',
      script,
      parsed: parseWorkflowScript(script),
      args: null,
      defaultModel: 'fixture-model',
      runAgent: async () => ({
        result: 'done',
        usage: { inputTokens: 1, outputTokens: 1 },
        toolUseCount: 0,
        durationMs: 1,
        resolvedModel: 'fixture-model',
      }),
      resolveNested: async () => ({
        script: nestedScript,
        parsed: parseWorkflowScript(nestedScript),
      }),
    })
    await manager.output(launch.taskId, { block: true, timeout: 5_000 })
    const started = (
      await readFile(join(launch.transcriptDirectory, 'journal.jsonl'), 'utf8')
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter(({ type }) => type === 'started')
      .map(({ key }) => key)
    expect(started).toEqual([
      'v2:8cb48efd10ba515c873fbaa3762384198b6c850c61e7ce05e8c16e342e6e1799',
      'v2:e79773bad244a9b1d1228d1f9e50d701f4f0779df69cf1e4fe6652ce86b4cbac',
    ])
    await manager.close()
  })

  it('rejects concurrent resume of the same running session and run ID', async () => {
    const { manager, script, parsed } = await fixture()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const launchOptions = {
      sessionId,
      promptId: 'prompt-race',
      script,
      parsed,
      args: { prompt: 'wait' },
      defaultModel: 'fixture-model',
      runAgent: async () => {
        await gate
        return {
          result: 'done',
          usage: { inputTokens: 1, outputTokens: 1 },
          toolUseCount: 0,
          durationMs: 1,
          resolvedModel: 'fixture-model',
        }
      },
      resolveNested: async () => {
        throw new Error('not used')
      },
    }
    const first = await manager.launch(launchOptions)

    await expect(
      manager.launch({
        ...launchOptions,
        promptId: 'prompt-race-resume',
        resumeFromRunId: first.runId,
      }),
    ).rejects.toThrow(`Workflow run ${first.runId} is already running`)

    release()
    await manager.output(first.taskId, { block: true, timeout: 5_000 })
    const resumed = await manager.launch({
      ...launchOptions,
      promptId: 'prompt-after-complete',
      resumeFromRunId: first.runId,
    })
    await manager.output(resumed.taskId, { block: true, timeout: 5_000 })
    await manager.close()
  })

  it('kills a running workflow and aborts its agent', async () => {
    const { manager, script, parsed } = await fixture()
    const launch = await manager.launch({
      sessionId,
      promptId: 'prompt-stop',
      script,
      parsed,
      args: { prompt: 'wait' },
      defaultModel: 'fixture-model',
      runAgent: ({ signal }) =>
        new Promise((_, reject) => {
          signal?.addEventListener(
            'abort',
            () => reject(new Error('agent aborted')),
            { once: true },
          )
        }),
      resolveNested: async () => {
        throw new Error('not used')
      },
    })
    expect(manager.stop(launch.taskId)).toContain('Successfully stopped task')
    const output = await manager.output(launch.taskId, {
      block: true,
      timeout: 5_000,
    })
    expect(output).toContain('"status": "killed"')
    await manager.close()
  })

  it('returns null for an agent failure and enforces token target before new calls', async () => {
    const { manager } = await fixture()
    const script = `export const meta = { name: 'budget', description: 'Budget probe' }
const first = await agent('first')
const second = await agent('second')
return { first, second }`
    let calls = 0
    const launch = await manager.launch({
      sessionId,
      promptId: 'prompt-budget',
      script,
      parsed: parseWorkflowScript(script),
      args: undefined,
      tokenBudget: 1,
      defaultModel: 'fixture-model',
      runAgent: async () => {
        calls += 1
        if (calls === 1) {
          return {
            result: 'first-result',
            usage: { inputTokens: 4, outputTokens: 1 },
            toolUseCount: 0,
            durationMs: 1,
            resolvedModel: 'fixture-model',
          }
        }
        throw new Error('must not run')
      },
      resolveNested: async () => {
        throw new Error('not used')
      },
    })
    const output = await manager.output(launch.taskId, {
      block: true,
      timeout: 5_000,
    })
    expect(output).toContain('"status": "failed"')
    expect(output).toContain('Workflow token budget exhausted (1)')
    expect(calls).toBe(1)
    await manager.close()
  })

  it('aggregates full cache-aware usage and raw-model attribution exactly once', async () => {
    const { manager } = await fixture()
    const script = `export const meta = {
  name: 'usage-aggregate',
  description: 'Aggregate workflow agent usage',
}
const first = await agent('first')
const second = await agent('second')
return { first, second }`
    let calls = 0
    const runAgent = vi.fn(async () => {
      calls += 1
      if (calls === 1) {
        return {
          result: 'first-result',
          usage: {
            inputTokens: 100,
            outputTokens: 50,
            cacheReadInputTokens: 10,
            cacheCreationInputTokens: 5,
            webSearchRequests: 2,
          },
          modelUsage: {
            'model-a': {
              inputTokens: 60,
              outputTokens: 30,
              cacheReadInputTokens: 6,
              cacheCreationInputTokens: 3,
              webSearchRequests: 1,
            },
            'model-b': {
              inputTokens: 30,
              outputTokens: 15,
              cacheReadInputTokens: 3,
              cacheCreationInputTokens: 1,
            },
          },
          toolUseCount: 1,
          durationMs: 4,
          resolvedModel: 'model-a',
        }
      }
      return {
        result: 'second-result',
        usage: {
          inputTokens: 200,
          outputTokens: 100,
          cacheReadInputTokens: 20,
          cacheCreationInputTokens: 10,
          webSearchRequests: 3,
        },
        modelUsage: {
          'model-a': {
            inputTokens: 120,
            outputTokens: 60,
            cacheReadInputTokens: 12,
            cacheCreationInputTokens: 6,
            webSearchRequests: 2,
          },
          'model-c': {
            inputTokens: 80,
            outputTokens: 40,
            cacheReadInputTokens: 8,
            cacheCreationInputTokens: 4,
            webSearchRequests: 1,
          },
        },
        toolUseCount: 2,
        durationMs: 4,
        resolvedModel: 'model-a',
      }
    })
    await manager.launch({
      sessionId,
      promptId: 'prompt-usage-aggregate',
      script,
      parsed: parseWorkflowScript(script),
      args: null,
      defaultModel: 'model-a',
      runAgent,
      resolveNested: async () => {
        throw new Error('not used')
      },
    })
    const firstNotification = await manager.notifications(true)
    expect(runAgent).toHaveBeenCalledTimes(2)
    expect(firstNotification.messages).toEqual([
      expect.stringContaining('<task-notification>'),
    ])
    expect(firstNotification.usage).toEqual({
      inputTokens: 300,
      outputTokens: 150,
      cacheReadInputTokens: 30,
      cacheCreationInputTokens: 15,
      webSearchRequests: 5,
    })
    expect(firstNotification.modelUsage).toEqual({
      'model-a': {
        inputTokens: 180,
        outputTokens: 90,
        cacheReadInputTokens: 18,
        cacheCreationInputTokens: 9,
        webSearchRequests: 3,
      },
      'model-b': {
        inputTokens: 30,
        outputTokens: 15,
        cacheReadInputTokens: 3,
        cacheCreationInputTokens: 1,
      },
      'model-c': {
        inputTokens: 80,
        outputTokens: 40,
        cacheReadInputTokens: 8,
        cacheCreationInputTokens: 4,
        webSearchRequests: 1,
      },
    })
    expect(Object.keys(firstNotification.modelUsage ?? {})).toEqual([
      'model-a',
      'model-b',
      'model-c',
    ])
    expect(await manager.notifications(false)).toEqual({
      messages: [],
      usage: { inputTokens: 0, outputTokens: 0 },
    })
    await manager.close()
  })
})
