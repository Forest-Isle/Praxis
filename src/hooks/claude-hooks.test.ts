import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import type { ClaudeJsonResource } from '../compatibility/claude/shared-resources.js'
import { ClaudeHookRunner, type ClaudeHookInput } from './claude-hooks.js'

const input: ClaudeHookInput = {
  session_id: 'session',
  transcript_path: '/tmp/session.jsonl',
  cwd: '/workspace',
  permission_mode: 'default',
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'printf original' },
  tool_use_id: 'call_1',
}

function settings(value: unknown, scope: 'user' | 'project' | 'local') {
  return { path: `/${scope}.json`, scope, value } satisfies ClaudeJsonResource
}

describe('ClaudeHookRunner', () => {
  it('runs layered matching command hooks and merges native JSON output', async () => {
    const resources = [
      settings(
        {
          hooks: {
            PreToolUse: [
              {
                matcher: 'Bash|Write',
                hooks: [{ type: 'command', command: 'user', timeout: 2 }],
              },
            ],
          },
        },
        'user',
      ),
      settings(
        {
          hooks: {
            PreToolUse: [
              {
                matcher: '*',
                hooks: [{ type: 'command', command: 'project' }],
              },
            ],
          },
        },
        'project',
      ),
    ]
    const executeCommand = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            updatedInput: { command: 'printf updated' },
            additionalContext: 'USER_CONTEXT',
          },
        }),
        stderr: '',
        exitCode: 0,
        durationMs: 4,
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
            permissionDecisionReason: 'fixture',
            additionalContext: 'PROJECT_CONTEXT',
          },
        }),
        stderr: '',
        exitCode: 0,
        durationMs: 5,
      })
    const runner = new ClaudeHookRunner({
      settings: resources,
      cwd: '/workspace',
      executeCommand,
    })

    await expect(runner.run(input, 'Bash')).resolves.toMatchObject({
      additionalContext: ['USER_CONTEXT', 'PROJECT_CONTEXT'],
      updatedInput: { command: 'printf updated' },
      permissionDecision: 'allow',
      permissionDecisionReason: 'fixture',
      executions: [
        { command: 'user', hookName: 'PreToolUse:Bash' },
        { command: 'project', hookName: 'PreToolUse:Bash' },
      ],
    })
    expect(executeCommand.mock.calls.map((call) => call[2])).toEqual([
      2_000, 600_000,
    ])
  })

  it('uses plain stdout as prompt context and exit two as a blocker', async () => {
    const resource = settings(
      {
        hooks: {
          UserPromptSubmit: [
            { hooks: [{ type: 'command', command: 'context' }] },
          ],
          PreToolUse: [
            { matcher: 'Bash', hooks: [{ type: 'command', command: 'deny' }] },
          ],
        },
      },
      'local',
    )
    const executeCommand = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: 'PROMPT_CONTEXT\n',
        stderr: '',
        exitCode: 0,
        durationMs: 1,
      })
      .mockResolvedValueOnce({
        stdout: '',
        stderr: 'blocked by fixture\n',
        exitCode: 2,
        durationMs: 2,
      })
    const runner = new ClaudeHookRunner({
      settings: [resource],
      cwd: '/workspace',
      executeCommand,
    })

    await expect(
      runner.run({ ...input, hook_event_name: 'UserPromptSubmit' }),
    ).resolves.toMatchObject({
      additionalContext: [],
      executions: [{ stdout: 'PROMPT_CONTEXT\n' }],
    })
    await expect(runner.run(input, 'Bash')).resolves.toMatchObject({
      blockedReason: 'blocked by fixture',
    })
  })

  it('rejects malformed hook settings and skips non-command hooks', async () => {
    const runner = new ClaudeHookRunner({
      settings: [
        settings(
          {
            hooks: {
              PreToolUse: [
                {
                  matcher: '[',
                  hooks: [{ type: 'prompt', prompt: 'ignored' }],
                },
              ],
            },
          },
          'user',
        ),
      ],
      cwd: '/workspace',
    })

    await expect(runner.run(input, 'Bash')).rejects.toThrow(
      'Invalid Claude PreToolUse matcher: /user.json',
    )
  })

  it('kills the hook process group before rejecting on timeout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-hook-timeout-'))
    const pidFile = join(root, 'child.pid')
    const script = [
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ pid: process.pid, projectDir: process.env.CLAUDE_PROJECT_DIR }))`,
      "process.on('SIGTERM', () => undefined)",
      'setInterval(() => undefined, 1_000)',
    ].join(';')
    const runner = new ClaudeHookRunner({
      settings: [
        settings(
          {
            hooks: {
              UserPromptSubmit: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: `node -e ${JSON.stringify(script)} & wait`,
                      timeout: 0.3,
                    },
                  ],
                },
              ],
            },
          },
          'user',
        ),
      ],
      cwd: root,
    })

    try {
      await expect(
        runner.run({
          ...input,
          cwd: root,
          hook_event_name: 'UserPromptSubmit',
        }),
      ).rejects.toThrow('Hook timed out after 300ms')
      const child = JSON.parse(await readFile(pidFile, 'utf8'))
      expect(child.projectDir).toBe(root)
      expect(() => process.kill(child.pid, 0)).toThrow()
    } finally {
      await rm(root, { recursive: true })
    }
  })
})
