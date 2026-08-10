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
    }),
  }
}

describe('ClaudeHookToolCoordinator', () => {
  it('applies updated input and permission before execution, then adds post context', async () => {
    const tools: ToolRegistry = {
      definitions: () => [],
      prepare: vi.fn(async (value) => value),
      execute: vi.fn(async () => ({ content: 'RESULT', isError: false })),
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

    const prepared = await coordinator.prepare(call, { cwd: '/workspace' })
    expect(prepared.input).toEqual({ command: 'printf updated' })
    expect(await coordinator.resolve(prepared)).toEqual({
      behavior: 'allow',
    })
    await expect(
      coordinator.execute(prepared, { cwd: '/workspace' }),
    ).resolves.toEqual({ content: 'RESULT', isError: false })
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
