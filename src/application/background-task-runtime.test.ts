import { describe, expect, it, vi } from 'vitest'

import {
  BackgroundTaskRuntime,
  type BackgroundAgentTaskSource,
  type BackgroundBashTaskSource,
  type WorkflowTaskSource,
} from './background-task-runtime.js'

const shell = {
  taskId: 'b12345678',
  status: 'running' as const,
  command: 'sleep 10',
  description: 'Sleep',
  outputFile: '/tmp/shell.output',
  output: '',
  exitCode: null,
  startedAt: 100,
  durationMs: null,
}
const agent = {
  agentId: 'a0123456789abcdef',
  status: 'completed' as const,
  outputFile: '/tmp/agent.output',
  result: {
    text: 'done',
    usage: { inputTokens: 1, outputTokens: 1 },
    toolUseCount: 0,
    durationMs: 20,
  },
  error: null,
  name: 'reviewer',
  description: 'Review',
  startedAt: 80,
  durationMs: 20,
}
const workflow = {
  task_id: 'w12345678',
  task_type: 'local_workflow' as const,
  status: 'failed' as const,
  summary: 'Run checks',
  run_id: 'run-1',
  progress: [],
  result: null,
  startTime: 40,
  durationMs: 30,
  error: 'failed',
}

describe('BackgroundTaskRuntime', () => {
  it('aggregates real task owners for one session and removes duplicate sources', async () => {
    const bash: BackgroundBashTaskSource = {
      backgroundSnapshots: vi.fn(async () => [shell]),
      stopBackgroundTask: vi.fn(async () => ({
        content: '',
        nativeToolUseResult: {},
      })),
    }
    const agents: BackgroundAgentTaskSource = {
      backgroundSnapshots: vi.fn(() => [agent]),
      outputBackgroundTask: vi.fn(async () => 'output'),
      stopBackgroundTask: vi.fn(async () => ''),
      sendBackgroundMessage: vi.fn(() => 'sent'),
      hasForegroundTask: vi.fn(() => false),
      backgroundForegroundTask: vi.fn(() => agent),
    }
    const workflows: WorkflowTaskSource = {
      list: vi.fn(() => [workflow]),
      hasForSession: vi.fn(() => false),
      stopAndWait: vi.fn(async () => undefined),
    }
    const runtime = new BackgroundTaskRuntime(workflows)
    runtime.registerBash('session-a', bash)
    runtime.registerBash('session-a', bash)
    runtime.registerAgents('session-a', agents)
    runtime.registerAgents('session-a', agents)

    await expect(runtime.snapshot('session-a')).resolves.toEqual({
      shells: [shell],
      agents: [agent],
      workflows: [workflow],
    })
    expect(bash.backgroundSnapshots).toHaveBeenCalledTimes(1)
    expect(agents.backgroundSnapshots).toHaveBeenCalledTimes(1)
    expect(workflows.list).toHaveBeenCalledWith('session-a')
  })

  it('keeps task owners isolated by session', async () => {
    const bash: BackgroundBashTaskSource = {
      backgroundSnapshots: vi.fn(async () => [shell]),
      stopBackgroundTask: vi.fn(async () => ({
        content: '',
        nativeToolUseResult: {},
      })),
    }
    const runtime = new BackgroundTaskRuntime(null)
    runtime.registerBash('session-a', bash)

    await expect(runtime.snapshot('session-b')).resolves.toEqual({
      shells: [],
      agents: [],
      workflows: [],
    })
  })

  it('routes stop to Bash, Agent, and Workflow owners and waits for terminal state', async () => {
    const bashStop = vi.fn(async () => ({
      content: '',
      nativeToolUseResult: {},
    }))
    const agentStop = vi.fn(async () => '')
    const agentOutput = vi.fn(async () => 'agent output')
    const agentSend = vi.fn(() => 'agent sent')
    const workflowStop = vi.fn(async () => undefined)
    const runtime = new BackgroundTaskRuntime({
      list: () => [workflow],
      hasForSession: (sessionId, taskId) =>
        sessionId === 'session-a' && taskId === workflow.task_id,
      stopAndWait: workflowStop,
    })
    runtime.registerBash('session-a', {
      backgroundSnapshots: async () => [shell],
      stopBackgroundTask: bashStop,
    })
    runtime.registerAgents('session-a', {
      backgroundSnapshots: () => [{ ...agent, status: 'running' }],
      outputBackgroundTask: agentOutput,
      stopBackgroundTask: agentStop,
      sendBackgroundMessage: agentSend,
      hasForegroundTask: () => false,
      backgroundForegroundTask: () => ({ ...agent, status: 'running' }),
    })

    await runtime.stop('session-a', shell.taskId)
    await expect(
      runtime.outputAgent('session-a', agent.agentId, {
        block: false,
        timeout: 0,
      }),
    ).resolves.toBe('agent output')
    expect(
      runtime.sendAgent(
        'session-a',
        agent.agentId,
        'continue',
        'summary',
        'call_send',
      ),
    ).toBe('agent sent')
    await runtime.stop('session-a', agent.agentId)
    await runtime.stop('session-a', workflow.task_id)

    expect(bashStop).toHaveBeenCalledWith(shell.taskId)
    expect(agentStop).toHaveBeenCalledWith(agent.agentId)
    expect(agentOutput).toHaveBeenCalledWith(agent.agentId, {
      block: false,
      timeout: 0,
    })
    expect(agentSend).toHaveBeenCalledWith(
      agent.agentId,
      'continue',
      'summary',
      'call_send',
    )
    expect(workflowStop).toHaveBeenCalledWith(workflow.task_id)
  })

  it('routes a named Agent to its owner across registered turn sources', () => {
    const firstSend = vi.fn(() => 'first sent')
    const secondSend = vi.fn(() => 'second sent')
    const runtime = new BackgroundTaskRuntime(null)
    runtime.registerAgents('session-a', {
      backgroundSnapshots: () => [{ ...agent, name: 'first' }],
      outputBackgroundTask: async () => '',
      stopBackgroundTask: async () => '',
      sendBackgroundMessage: firstSend,
      hasForegroundTask: () => false,
      backgroundForegroundTask: () => agent,
    })
    runtime.registerAgents('session-a', {
      backgroundSnapshots: () => [agent],
      outputBackgroundTask: async () => '',
      stopBackgroundTask: async () => '',
      sendBackgroundMessage: secondSend,
      hasForegroundTask: () => false,
      backgroundForegroundTask: () => agent,
    })

    expect(
      runtime.sendAgent(
        'session-a',
        'reviewer',
        'continue',
        undefined,
        'call_send',
      ),
    ).toBe('second sent')
    expect(firstSend).not.toHaveBeenCalled()
    expect(secondSend).toHaveBeenCalledWith(
      'reviewer',
      'continue',
      undefined,
      'call_send',
    )
  })

  it('rejects an ambiguous Agent name across turn owners', () => {
    const runtime = new BackgroundTaskRuntime(null)
    for (const agentId of ['a1111111111111111', 'a2222222222222222']) {
      runtime.registerAgents('session-a', {
        backgroundSnapshots: () => [{ ...agent, agentId, name: 'reviewer' }],
        outputBackgroundTask: async () => '',
        stopBackgroundTask: async () => '',
        sendBackgroundMessage: () => '',
        hasForegroundTask: () => false,
        backgroundForegroundTask: () => agent,
      })
    }

    expect(() =>
      runtime.sendAgent(
        'session-a',
        'reviewer',
        'continue',
        undefined,
        'call_send',
      ),
    ).toThrow("Multiple live background agents are named 'reviewer'")
  })

  it('routes foreground handoff to the current session owner', () => {
    const runtime = new BackgroundTaskRuntime(null)
    const backgroundForegroundTask = vi.fn(() => ({
      ...agent,
      status: 'running' as const,
    }))
    runtime.registerAgents('session-a', {
      backgroundSnapshots: () => [],
      outputBackgroundTask: async () => '',
      stopBackgroundTask: async () => '',
      sendBackgroundMessage: () => '',
      hasForegroundTask: () => true,
      backgroundForegroundTask,
    })

    expect(runtime.backgroundForeground('session-a')).toMatchObject({
      agentId: agent.agentId,
      status: 'running',
    })
    expect(backgroundForegroundTask).toHaveBeenCalledOnce()
    expect(() => runtime.backgroundForeground('session-b')).toThrow(
      'No foreground agent is running',
    )
  })

  it('rejects unknown task IDs without crossing session boundaries', async () => {
    const runtime = new BackgroundTaskRuntime(null)
    await expect(runtime.stop('session-a', 'missing')).rejects.toThrow(
      'No task found with ID: missing',
    )
  })
})
