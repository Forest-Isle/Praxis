import { describe, expect, it, vi } from 'vitest'

import type {
  ModelToolCall,
  PermissionResolver,
  ToolRegistry,
} from '../core/runtime.js'
import { ClaudeHookToolCoordinator } from './claude-hook-tools.js'
import {
  ClaudeHookRunner,
  type ClaudeHookCommandExecutor,
} from './claude-hooks.js'

const call: ModelToolCall = {
  id: 'call_1',
  name: 'Bash',
  input: { command: 'printf original' },
}

const session = {
  session_id: 'session',
  transcript_path: '/tmp/session.jsonl',
  cwd: '/workspace',
  permission_mode: 'default',
}

function fixture(
  executeCommand: ReturnType<typeof vi.fn<ClaudeHookCommandExecutor>>,
  tools: ToolRegistry,
  permissions: PermissionResolver = { resolve: () => ({ behavior: 'ask' }) },
  warn?: (message: string) => void,
) {
  const outcomes = vi.fn(async () => undefined)
  const hooks = new ClaudeHookRunner({
    settings: [
      {
        path: '/settings.json',
        scope: 'user',
        value: {
          hooks: {
            PreToolUse: [
              { matcher: 'Bash', hooks: [{ type: 'command', command: 'pre' }] },
            ],
            PermissionRequest: [
              {
                matcher: 'Bash',
                hooks: [{ type: 'command', command: 'permission' }],
              },
            ],
            PermissionDenied: [
              {
                matcher: 'Bash',
                hooks: [{ type: 'command', command: 'denied' }],
              },
            ],
            PostToolUse: [
              {
                matcher: 'Bash',
                hooks: [{ type: 'command', command: 'post' }],
              },
            ],
            PostToolUseFailure: [
              {
                matcher: 'Bash',
                hooks: [{ type: 'command', command: 'failure' }],
              },
            ],
          },
        },
      },
    ],
    cwd: '/workspace',
    executeCommand,
  })
  return {
    outcomes,
    coordinator: new ClaudeHookToolCoordinator({
      tools,
      permissions,
      hooks,
      session,
      recordOutcome: outcomes,
      ...(warn ? { warn } : {}),
    }),
  }
}

describe('ClaudeHookToolCoordinator', () => {
  it('applies updated input and permission before execution, then adds post context', async () => {
    let executionContext: ToolExecutionContext | undefined
    const tools: ToolRegistry = {
      definitions: () => [],
      prepare: vi.fn(async (value) => value),
      execute: vi.fn(async (_call, context) => {
        executionContext = context
        return { content: 'RESULT', isError: false }
      }),
    }
    const executeCommand = vi
      .fn<ClaudeHookCommandExecutor>()
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            updatedInput: { command: 'printf updated' },
            permissionDecision: 'allow',
          },
        }),
        stderr: '',
        exitCode: 0,
        durationMs: 1,
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PostToolUse',
            additionalContext: 'POST_CONTEXT',
          },
        }),
        stderr: '',
        exitCode: 0,
        durationMs: 1,
      })
    const { coordinator, outcomes } = fixture(executeCommand, tools)
    expect(coordinator.schedulingPolicy()).toEqual({
      concurrency: 'exclusive',
      startAfterAssistant: true,
    })

    const prepared = await coordinator.prepare(call, { cwd: '/workspace' })
    expect(prepared.input).toEqual({ command: 'printf updated' })
    expect(await coordinator.resolve(prepared)).toEqual({
      behavior: 'allow',
    })
    await expect(
      coordinator.execute(prepared, { cwd: '/workspace' }),
    ).resolves.toEqual({ content: 'RESULT', isError: false })
    expect(executionContext?.preToolUseAllowed).toBe(true)
    expect(outcomes).toHaveBeenCalledTimes(2)
  })

  it('blocks before execution on exit two', async () => {
    const tools: ToolRegistry = {
      definitions: () => [],
      prepare: vi.fn(async (value) => value),
      execute: vi.fn(async () => ({ content: 'unexpected', isError: false })),
    }
    const { coordinator } = fixture(
      vi.fn(async () => ({
        stdout: '',
        stderr: 'blocked',
        exitCode: 2,
        durationMs: 1,
      })),
      tools,
    )

    await expect(
      coordinator.prepare(call, { cwd: '/workspace' }),
    ).rejects.toThrow('PreToolUse:Bash hook error: blocked')
    expect(tools.execute).not.toHaveBeenCalled()
  })

  it('lets PermissionRequest hooks answer an ask decision', async () => {
    const tools: ToolRegistry = {
      definitions: () => [],
      prepare: vi.fn(async (value) => value),
      execute: vi.fn(async () => ({ content: 'result', isError: false })),
    }
    const executeCommand = vi
      .fn<ClaudeHookCommandExecutor>()
      .mockResolvedValueOnce({
        stdout: '',
        stderr: '',
        exitCode: 0,
        durationMs: 1,
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PermissionRequest',
            permissionDecision: 'allow',
          },
        }),
        stderr: '',
        exitCode: 0,
        durationMs: 1,
      })
    const { coordinator, outcomes } = fixture(executeCommand, tools)
    const controller = new AbortController()
    const prepared = await coordinator.prepare(call, {
      cwd: '/workspace',
      signal: controller.signal,
    })

    await expect(coordinator.resolve(prepared)).resolves.toEqual({
      behavior: 'allow',
    })
    expect(executeCommand.mock.calls.map((item) => item[0])).toEqual([
      'pre',
      'permission',
    ])
    expect(executeCommand.mock.calls[1]?.[3]).toBe(controller.signal)
    expect(outcomes).toHaveBeenCalledTimes(2)
  })

  it('runs PermissionDenied only after an auto-classifier denial and returns retry context', async () => {
    const tools: ToolRegistry = {
      definitions: () => [],
      prepare: vi.fn(async (value) => value),
      execute: vi.fn(async () => ({ content: 'result', isError: false })),
    }
    const executeCommand = vi
      .fn<ClaudeHookCommandExecutor>()
      .mockResolvedValueOnce({
        stdout: '',
        stderr: '',
        exitCode: 0,
        durationMs: 1,
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PermissionDenied',
            retry: true,
          },
        }),
        stderr: '',
        exitCode: 0,
        durationMs: 1,
      })
    const { coordinator, outcomes } = fixture(executeCommand, tools, {
      resolve: () => ({
        behavior: 'deny',
        reason: 'classifier denied',
        source: 'auto-classifier',
      }),
    })
    const prepared = await coordinator.prepare(call, { cwd: '/workspace' })

    await expect(coordinator.resolve(prepared)).resolves.toEqual({
      behavior: 'deny',
      reason: 'classifier denied',
      source: 'auto-classifier',
      followUpUserMessages: [
        'The PermissionDenied hook indicated this command is now approved. You may retry it if you would like.',
      ],
    })
    expect(executeCommand.mock.calls.map((item) => item[0])).toEqual([
      'pre',
      'denied',
    ])
    expect(executeCommand.mock.calls[1]?.[1]).toMatchObject({
      hook_event_name: 'PermissionDenied',
      tool_name: 'Bash',
      tool_use_id: 'call_1',
      reason: 'classifier denied',
    })
    expect(outcomes).toHaveBeenCalledTimes(2)
  })

  it('does not run PermissionDenied for an ordinary rule denial', async () => {
    const tools: ToolRegistry = {
      definitions: () => [],
      prepare: vi.fn(async (value) => value),
      execute: vi.fn(async () => ({ content: 'result', isError: false })),
    }
    const executeCommand = vi
      .fn<ClaudeHookCommandExecutor>()
      .mockResolvedValue({
        stdout: '',
        stderr: '',
        exitCode: 0,
        durationMs: 1,
      })
    const { coordinator, outcomes } = fixture(executeCommand, tools, {
      resolve: () => ({
        behavior: 'deny',
        reason: 'rule denied',
        source: 'rule',
      }),
    })
    const prepared = await coordinator.prepare(call, { cwd: '/workspace' })

    await expect(coordinator.resolve(prepared)).resolves.toEqual({
      behavior: 'deny',
      reason: 'rule denied',
      source: 'rule',
    })
    expect(executeCommand.mock.calls.map((item) => item[0])).toEqual(['pre'])
    expect(outcomes).toHaveBeenCalledTimes(1)
  })

  it('preserves the final deny decision when its audit hook fails', async () => {
    const tools: ToolRegistry = {
      definitions: () => [],
      prepare: vi.fn(async (value) => value),
      execute: vi.fn(async () => ({ content: 'result', isError: false })),
    }
    const warnings: string[] = []
    const executeCommand = vi
      .fn<ClaudeHookCommandExecutor>()
      .mockResolvedValueOnce({
        stdout: '',
        stderr: '',
        exitCode: 0,
        durationMs: 1,
      })
      .mockRejectedValueOnce(new Error('audit unavailable'))
    const { coordinator } = fixture(
      executeCommand,
      tools,
      {
        resolve: () => ({
          behavior: 'deny',
          reason: 'classifier denied',
          source: 'auto-classifier',
        }),
      },
      (message) => warnings.push(message),
    )
    const prepared = await coordinator.prepare(call, { cwd: '/workspace' })

    await expect(coordinator.resolve(prepared)).resolves.toEqual({
      behavior: 'deny',
      reason: 'classifier denied',
      source: 'auto-classifier',
    })
    expect(warnings).toEqual([
      'PermissionDenied:Bash hook failed: audit unavailable',
    ])
  })

  it('runs failure hooks and returns their context', async () => {
    const tools: ToolRegistry = {
      definitions: () => [],
      prepare: vi.fn(async (value) => value),
      execute: vi.fn(async () => {
        throw new Error('tool failed')
      }),
    }
    const executeCommand = vi
      .fn<ClaudeHookCommandExecutor>()
      .mockResolvedValueOnce({
        stdout: '',
        stderr: '',
        exitCode: 0,
        durationMs: 1,
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PostToolUseFailure',
            additionalContext: 'FAILURE_CONTEXT',
          },
        }),
        stderr: '',
        exitCode: 0,
        durationMs: 1,
      })
    const { coordinator } = fixture(executeCommand, tools)
    const prepared = await coordinator.prepare(call, { cwd: '/workspace' })

    await expect(
      coordinator.execute(prepared, { cwd: '/workspace' }),
    ).resolves.toEqual({ content: 'tool failed', isError: true })
  })
})
