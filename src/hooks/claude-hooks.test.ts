import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

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

async function waitForProcessExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
      throw error
    }
    await delay(25)
  }
  throw new Error(`Process ${pid} survived hook termination`)
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
                      command: `node -e ${JSON.stringify(script)} & printf '%s' "$!" > ${JSON.stringify(pidFile)}; wait`,
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
      const childPid = Number(await readFile(pidFile, 'utf8'))
      expect(Number.isInteger(childPid)).toBe(true)
      await waitForProcessExit(childPid)
    } finally {
      await rm(root, { recursive: true })
    }
  })

  it('isolates ambient credentials and preserves the project environment', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-hook-environment-'))
    const variable = 'PRAXIS_TEST_API_KEY'
    const previous = process.env[variable]
    process.env[variable] = 'hook-environment-secret-canary'
    const script =
      "process.stdout.write(JSON.stringify({ secret: process.env.PRAXIS_TEST_API_KEY ?? 'missing', project: process.env.CLAUDE_PROJECT_DIR, path: typeof process.env.PATH }))"
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
                      command: `node -e ${JSON.stringify(script)}`,
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
      const outcome = await runner.run({
        ...input,
        cwd: root,
        hook_event_name: 'UserPromptSubmit',
      })
      expect(JSON.parse(outcome.executions[0]?.stdout ?? '')).toEqual({
        secret: 'missing',
        project: root,
        path: 'string',
      })
    } finally {
      if (previous === undefined) delete process.env[variable]
      else process.env[variable] = previous
      await rm(root, { recursive: true })
    }
  })

  it('does not reload credentials from user shell startup files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-hook-startup-'))
    const variable = 'PRAXIS_TEST_API_KEY'
    const startupFile =
      process.platform === 'darwin'
        ? join(root, '.zshenv')
        : join(root, 'bash-environment')
    await writeFile(startupFile, `export ${variable}=startup-secret-canary\n`)
    const previous = {
      secret: process.env[variable],
      HOME: process.env.HOME,
      ZDOTDIR: process.env.ZDOTDIR,
      BASH_ENV: process.env.BASH_ENV,
    }
    delete process.env[variable]
    process.env.HOME = root
    process.env.ZDOTDIR = root
    process.env.BASH_ENV = startupFile
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
                      command: `node -e "process.stdout.write(process.env.${variable} ?? 'missing')"`,
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
      const outcome = await runner.run({
        ...input,
        cwd: root,
        hook_event_name: 'UserPromptSubmit',
      })
      expect(outcome.executions[0]?.stdout).toBe('missing')
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        const environmentName = name === 'secret' ? variable : name
        if (value === undefined) delete process.env[environmentName]
        else process.env[environmentName] = value
      }
      await rm(root, { recursive: true })
    }
  })

  it('redacts hook diagnostics after applying raw JSON semantics', async () => {
    const secret = 'hook-output-secret-canary'
    const variable = 'PRAXIS_TEST_API_KEY'
    const previous = process.env[variable]
    process.env[variable] = secret
    const runner = new ClaudeHookRunner({
      settings: [
        settings(
          {
            hooks: {
              PreToolUse: [
                {
                  matcher: 'Bash',
                  hooks: [{ type: 'command', command: `echo ${secret}` }],
                },
              ],
            },
          },
          'user',
        ),
      ],
      cwd: '/workspace',
      executeCommand: async () => ({
        stdout: JSON.stringify({
          hookSpecificOutput: {
            updatedInput: { command: `printf ${secret}` },
            additionalContext: `context ${secret}`,
            permissionDecision: 'ask',
            permissionDecisionReason: `reason ${secret}`,
          },
        }),
        stderr: `stderr ${secret}`,
        exitCode: 0,
        durationMs: 1,
      }),
    })

    try {
      const outcome = await runner.run(input, 'Bash')
      expect(outcome.updatedInput).toEqual({ command: `printf ${secret}` })
      expect(outcome.additionalContext).toEqual(['context [REDACTED]'])
      expect(outcome.permissionDecisionReason).toBe('reason [REDACTED]')
      expect(JSON.stringify(outcome.executions)).not.toContain(secret)
      expect(outcome.executions[0]).toMatchObject({
        command: 'echo [REDACTED]',
        stderr: 'stderr [REDACTED]',
      })

      const blockingRunner = new ClaudeHookRunner({
        settings: [
          settings(
            {
              hooks: {
                PreToolUse: [
                  {
                    matcher: 'Bash',
                    hooks: [{ type: 'command', command: 'deny' }],
                  },
                ],
              },
            },
            'user',
          ),
        ],
        cwd: '/workspace',
        executeCommand: async () => ({
          stdout: '',
          stderr: `blocked ${secret}`,
          exitCode: 2,
          durationMs: 1,
        }),
      })
      await expect(blockingRunner.run(input, 'Bash')).resolves.toMatchObject({
        blockedReason: 'blocked [REDACTED]',
      })
    } finally {
      if (previous === undefined) delete process.env[variable]
      else process.env[variable] = previous
    }
  })

  it('enforces hook output bounds after credential redaction', async () => {
    const secret = 'tiny'
    const variable = 'PRAXIS_TEST_API_KEY'
    const previous = process.env[variable]
    process.env[variable] = secret
    const runner = new ClaudeHookRunner({
      settings: [
        settings(
          {
            hooks: {
              UserPromptSubmit: [
                { hooks: [{ type: 'command', command: 'emit-secret' }] },
              ],
            },
          },
          'user',
        ),
      ],
      cwd: '/workspace',
      maxOutputBytes: 8,
      executeCommand: async () => ({
        stdout: secret,
        stderr: '',
        exitCode: 0,
        durationMs: 1,
      }),
    })

    try {
      await expect(
        runner.run({ ...input, hook_event_name: 'UserPromptSubmit' }),
      ).rejects.toThrow('Hook output exceeded byte limit')
    } finally {
      if (previous === undefined) delete process.env[variable]
      else process.env[variable] = previous
    }
  })
})
