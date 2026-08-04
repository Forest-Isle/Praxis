import { describe, expect, it } from 'vitest'

import type { ModelToolCall } from './core/runtime.js'
import {
  parseContextEnvironment,
  parseProviderEnvironment,
  run,
  type CliDependencies,
  type CliIO,
} from './cli.js'

function captureIO() {
  const stdout: string[] = []
  const stderr: string[] = []
  const io: CliIO = {
    stdout: (message) => stdout.push(message),
    stderr: (message) => stderr.push(message),
  }
  return { io, stdout, stderr }
}

function dependencies(warning?: string): CliDependencies {
  return {
    async createService({ eventSink }) {
      return {
        async run(prompt) {
          if (warning) eventSink({ type: 'warning', message: warning })
          eventSink({ type: 'text-delta', delta: `answer:${prompt}` })
          return {
            sessionId: '11111111-1111-4111-8111-111111111111',
            text: `answer:${prompt}`,
            usage: { inputTokens: 2, outputTokens: 3 },
          }
        },
        async resume(sessionId, prompt) {
          eventSink({ type: 'text-delta', delta: `resumed:${prompt}` })
          return {
            sessionId,
            text: `resumed:${prompt}`,
            usage: { inputTokens: 4, outputTokens: 5 },
          }
        },
        async fork(parentSessionId) {
          return {
            parentSessionId,
            sessionId: '22222222-2222-4222-8222-222222222222',
          }
        },
        async sessions() {
          return [
            {
              sessionId: '11111111-1111-4111-8111-111111111111',
              lastPrompt: 'hello',
              updatedAt: '2026-08-03T00:00:00.000Z',
            },
          ]
        },
      }
    },
  }
}

describe('Praxis CLI', () => {
  it('selects provider-specific environment defaults', () => {
    expect(parseProviderEnvironment({})).toEqual({
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
    })
    expect(
      parseProviderEnvironment({
        PRAXIS_PROVIDER: 'anthropic',
        PRAXIS_MAX_OUTPUT_TOKENS: '4096',
        PRAXIS_ANTHROPIC_VERSION: '2023-06-01',
      }),
    ).toEqual({
      provider: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
      maxOutputTokens: 4096,
      anthropicVersion: '2023-06-01',
    })
    expect(() =>
      parseProviderEnvironment({ PRAXIS_PROVIDER: 'unknown' }),
    ).toThrow('openai or anthropic')
    expect(() =>
      parseProviderEnvironment({ PRAXIS_MAX_OUTPUT_TOKENS: '4096' }),
    ).toThrow('requires PRAXIS_PROVIDER=anthropic')
  })

  it('validates explicit context budget environment', () => {
    expect(
      parseContextEnvironment({
        PRAXIS_CONTEXT_WINDOW_TOKENS: '200000',
        PRAXIS_CONTEXT_RESERVE_TOKENS: '8192',
      }),
    ).toEqual({ contextWindowTokens: 200_000, contextReserveTokens: 8192 })
    expect(() =>
      parseContextEnvironment({ PRAXIS_CONTEXT_WINDOW_TOKENS: 'unknown' }),
    ).toThrow('positive integer')
    expect(() =>
      parseContextEnvironment({ PRAXIS_CONTEXT_RESERVE_TOKENS: '8192' }),
    ).toThrow('requires PRAXIS_CONTEXT_WINDOW_TOKENS')
  })

  it('prints help and version without creating runtime dependencies', async () => {
    const capture = captureIO()
    const unavailable: CliDependencies = {
      async createService() {
        throw new Error('must not run')
      },
    }

    await expect(run([], capture.io, unavailable)).resolves.toBe(0)
    await expect(run(['--version'], capture.io, unavailable)).resolves.toBe(0)
    expect(capture.stdout.join('')).toContain('Praxis')
    expect(capture.stdout).toContain('0.1.0\n')
    expect(capture.stderr).toEqual([])
  })

  it('starts the interactive UI only for an empty TTY invocation', async () => {
    const capture = captureIO()
    capture.io.isTTY = true
    let started = false
    const interactive: CliDependencies = {
      ...dependencies(),
      async runInteractive() {
        started = true
        return 0
      },
    }

    await expect(run([], capture.io, interactive)).resolves.toBe(0)

    expect(started).toBe(true)
    expect(capture.stdout).toEqual([])
  })

  it('runs a prompt in plain output mode', async () => {
    const capture = captureIO()

    await expect(
      run(['run', 'hello', 'world'], capture.io, dependencies()),
    ).resolves.toBe(0)
    expect(capture.stdout.join('')).toBe('answer:hello world\n')
  })

  it('prints non-terminal runtime warnings to stderr', async () => {
    const capture = captureIO()

    await expect(
      run(['run', 'hello'], capture.io, dependencies('hook failed')),
    ).resolves.toBe(0)
    expect(capture.stdout.join('')).toBe('answer:hello\n')
    expect(capture.stderr).toEqual(['Warning: hook failed\n'])
  })

  it('redacts ambient credentials from warnings and structured failures', async () => {
    const secret = 'cli-diagnostic-secret-canary'
    const variable = 'PRAXIS_TEST_API_KEY'
    const previous = process.env[variable]
    process.env[variable] = secret
    const warning = captureIO()
    const failure = captureIO()
    const failed: CliDependencies = {
      async createService({ eventSink }) {
        return {
          async run() {
            eventSink({
              type: 'failed',
              message: `runtime echoed ${secret}`,
              retryable: false,
            })
            throw new Error(`provider echoed ${secret}`)
          },
          async resume() {
            throw new Error('unused')
          },
          async fork() {
            throw new Error('unused')
          },
          async sessions() {
            return []
          },
        }
      },
    }

    try {
      await expect(
        run(
          ['run', 'hello'],
          warning.io,
          dependencies(`hook echoed ${secret}`),
        ),
      ).resolves.toBe(0)
      await expect(
        run(['run', '--json', 'hello'], failure.io, failed),
      ).resolves.toBe(1)
      expect(warning.stderr).toEqual(['Warning: hook echoed [REDACTED]\n'])
      expect(failure.stdout.map((line) => JSON.parse(line))).toEqual([
        {
          type: 'failed',
          message: 'runtime echoed [REDACTED]',
          retryable: false,
        },
        { type: 'error', message: 'provider echoed [REDACTED]' },
      ])
      expect(failure.stdout.join('')).not.toContain(secret)
    } finally {
      if (previous === undefined) delete process.env[variable]
      else process.env[variable] = previous
    }
  })

  it('normalizes startup aborts to cancellation', async () => {
    const capture = captureIO()
    const controller = new AbortController()
    controller.abort()
    const aborted: CliDependencies = {
      async createService() {
        throw new DOMException('aborted', 'AbortError')
      },
    }

    await expect(
      run(['run', 'hello'], capture.io, aborted, controller.signal),
    ).resolves.toBe(130)
    expect(capture.stderr).toEqual(['Praxis run cancelled.\n'])
  })

  it('resumes with NDJSON runtime events and a result record', async () => {
    const capture = captureIO()
    const sessionId = '11111111-1111-4111-8111-111111111111'

    await expect(
      run(
        ['resume', '--json', sessionId, 'continue'],
        capture.io,
        dependencies(),
      ),
    ).resolves.toBe(0)
    const output = capture.stdout.map((line) => JSON.parse(line))
    expect(output).toEqual([
      { type: 'text-delta', delta: 'resumed:continue' },
      {
        type: 'result',
        sessionId,
        text: 'resumed:continue',
        usage: { inputTokens: 4, outputTokens: 5 },
      },
    ])
  })

  it('passes explicit interrupted-tool recovery only for resume', async () => {
    const capture = captureIO()
    let approveRecovery:
      ((call: ModelToolCall) => boolean | Promise<boolean>) | undefined
    const base = dependencies()
    const recovering: CliDependencies = {
      async createService(options) {
        approveRecovery = options.approveRecovery
        return base.createService(options)
      },
    }

    await expect(
      run(
        [
          'resume',
          '--retry-interrupted-tools',
          '11111111-1111-4111-8111-111111111111',
          'continue',
        ],
        capture.io,
        recovering,
      ),
    ).resolves.toBe(0)
    expect(
      await approveRecovery?.({ id: 'interrupted', name: 'Bash', input: {} }),
    ).toBe(true)
  })

  it('passes an explicit agent without including the option in the prompt', async () => {
    const capture = captureIO()
    let selectedAgent: string | undefined
    const base = dependencies()
    const withAgent: CliDependencies = {
      async createService(options) {
        selectedAgent = options.agent
        return base.createService(options)
      },
    }

    await expect(
      run(
        ['run', '--agent', 'reviewer', 'inspect', 'this'],
        capture.io,
        withAgent,
      ),
    ).resolves.toBe(0)
    expect(selectedAgent).toBe('reviewer')
    expect(capture.stdout.join('')).toBe('answer:inspect this\n')
  })

  it('lists and forks sessions without a provider', async () => {
    const listed = captureIO()
    const forked = captureIO()

    await expect(run(['sessions'], listed.io, dependencies())).resolves.toBe(0)
    await expect(
      run(
        ['fork', '11111111-1111-4111-8111-111111111111'],
        forked.io,
        dependencies(),
      ),
    ).resolves.toBe(0)
    expect(listed.stdout.join('')).toContain('\thello\n')
    expect(forked.stdout).toEqual(['22222222-2222-4222-8222-222222222222\n'])
  })

  it('reports invalid commands without throwing', async () => {
    const capture = captureIO()

    await expect(run(['resume'], capture.io, dependencies())).resolves.toBe(1)
    expect(capture.stderr).toEqual(['Session ID is required\n'])
  })
})
