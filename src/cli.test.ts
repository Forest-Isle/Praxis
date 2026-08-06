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
  const stdoutBytes: Buffer[] = []
  const stderr: string[] = []
  const io: CliIO = {
    stdout: (message) => {
      const bytes = Buffer.from(message)
      stdoutBytes.push(bytes)
      stdout.push(bytes.toString())
    },
    stderr: (message) => stderr.push(message),
  }
  return { io, stdout, stdoutBytes, stderr }
}

function captureStreamIO(...chunks: string[]) {
  const capture = captureIO()
  capture.io.readStdinLines = () =>
    (async function* () {
      for (const chunk of chunks) yield chunk
    })()
  return capture
}

function dependencies(
  warning?: string,
  transcript = Buffer.from('{"type":"user"}\n'),
): CliDependencies {
  return {
    async createService({ eventSink }) {
      return {
        async run(prompt, _signal, sessionId) {
          if (warning) eventSink({ type: 'warning', message: warning })
          eventSink({ type: 'text-delta', delta: `answer:${prompt}` })
          return {
            sessionId: sessionId ?? '11111111-1111-4111-8111-111111111111',
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
              status: 'ready' as const,
              issue: null,
            },
          ]
        },
        async inspect(sessionId) {
          return {
            sessionId,
            status: 'ready' as const,
            writeMode: 'read-write' as const,
            claudeVersion: '2.1.208',
            lastPrompt: 'hello',
            updatedAt: '2026-08-03T00:00:00.000Z',
            entryCount: 3,
            byteLength: 128,
            newlineTerminated: true,
            issue: null,
          }
        },
        async export() {
          return transcript
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
        PRAXIS_ANTHROPIC_WEB_SEARCH: 'true',
      }),
    ).toEqual({
      provider: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
      maxOutputTokens: 4096,
      anthropicVersion: '2023-06-01',
      webSearch: true,
    })
    expect(() =>
      parseProviderEnvironment({ PRAXIS_PROVIDER: 'unknown' }),
    ).toThrow('openai or anthropic')
    expect(() =>
      parseProviderEnvironment({ PRAXIS_MAX_OUTPUT_TOKENS: '4096' }),
    ).toThrow('requires PRAXIS_PROVIDER=anthropic')
    expect(() =>
      parseProviderEnvironment({
        PRAXIS_PROVIDER: 'anthropic',
        PRAXIS_ANTHROPIC_WEB_SEARCH: 'sometimes',
      }),
    ).toThrow('must be true or false')
    expect(() =>
      parseProviderEnvironment({ PRAXIS_ANTHROPIC_WEB_SEARCH: 'true' }),
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

  it('forwards option-only TTY invocations to the interactive runtime', async () => {
    const capture = captureIO()
    capture.io.isTTY = true
    let controls:
      Parameters<NonNullable<CliDependencies['runInteractive']>>[0] | undefined
    const interactive: CliDependencies = {
      ...dependencies(),
      async runInteractive(options) {
        controls = options
        return 0
      },
    }

    await expect(
      run(
        ['--permission-mode', 'manual', '--agent', 'reviewer'],
        capture.io,
        interactive,
      ),
    ).resolves.toBe(0)

    expect(controls).toMatchObject({
      agent: 'reviewer',
      controls: { permissionMode: 'manual' },
    })
  })

  it('runs a prompt in plain output mode', async () => {
    const capture = captureIO()

    await expect(
      run(['run', 'hello', 'world'], capture.io, dependencies()),
    ).resolves.toBe(0)
    expect(capture.stdout.join('')).toBe('answer:hello world\n')
  })

  it('launches and controls top-level background agents without creating a provider', async () => {
    const calls: string[] = []
    const managed: CliDependencies = {
      async createService() {
        throw new Error('provider must not be created')
      },
      topLevelAgents: {
        async launch(options) {
          calls.push(`launch:${options.prompt}:${options.argv.join('|')}`)
          return {
            id: 'abcd1234',
            sessionId: 'abcd1234-1111-4111-8111-111111111111',
          }
        },
        async list(options) {
          calls.push(`list:${options.all}:${options.cwd ?? ''}`)
          return [
            {
              pid: 42,
              id: 'abcd1234',
              cwd: '/workspace',
              kind: 'background',
              startedAt: 1,
              sessionId: 'abcd1234-1111-4111-8111-111111111111',
              name: 'finish task',
              status: 'idle',
              state: 'working',
            },
          ]
        },
        async logs(id) {
          calls.push(`logs:${id}`)
          return 'RESULT\n'
        },
        async stop(id) {
          calls.push(`stop:${id}`)
        },
        async attach(id, input, output) {
          calls.push(`attach:${id}`)
          for await (const chunk of input) output(String(chunk))
        },
      },
    }
    const launched = captureIO()
    await expect(
      run(
        [
          '--bg',
          '--bare',
          '--session-id',
          '11111111-1111-4111-8111-111111111111',
          'finish task',
        ],
        launched.io,
        managed,
      ),
    ).resolves.toBe(0)
    expect(launched.stdout.join('')).toContain('backgrounded · abcd1234')
    expect(launched.stderr).toEqual([
      'warning: --bg manages the session id; ignoring --session-id (use --resume <id> to continue an existing session)\n',
    ])
    expect(calls[0]).toBe('launch:finish task:--bare|finish task')

    const listed = captureIO()
    await expect(
      run(
        ['agents', '--json', '--all', '--cwd', '/workspace'],
        listed.io,
        managed,
      ),
    ).resolves.toBe(0)
    expect(JSON.parse(listed.stdout.join(''))).toEqual([
      expect.objectContaining({ id: 'abcd1234', status: 'idle' }),
    ])

    const logs = captureIO()
    await expect(run(['logs', 'abcd1234'], logs.io, managed)).resolves.toBe(0)
    expect(logs.stdout.join('')).toBe('RESULT\n')

    const stopped = captureIO()
    await expect(run(['stop', 'abcd1234'], stopped.io, managed)).resolves.toBe(
      0,
    )
    expect(stopped.stdout.join('')).toBe('stopped abcd1234\n')

    const attached = captureStreamIO('continue\n')
    await expect(
      run(['attach', 'abcd1234'], attached.io, managed),
    ).resolves.toBe(0)
    expect(attached.stdout.join('')).toBe('continue\n')
    expect(calls).toContain('attach:abcd1234')
  })

  it('rejects print-mode background sessions with Claude-compatible guidance', async () => {
    const capture = captureIO()
    await expect(
      run(['--bg', '--print', 'finish task'], capture.io, dependencies()),
    ).resolves.toBe(1)
    expect(capture.stderr.join('')).toContain('--bg and --print conflict')
  })

  it('continues and forks the latest directory session while forwarding controls', async () => {
    const capture = captureIO()
    const calls: string[] = []
    let controls: Parameters<CliDependencies['createService']>[0]['controls']
    const base = dependencies()
    const controlled: CliDependencies = {
      async createService(options) {
        controls = options.controls
        const service = await base.createService(options)
        return {
          ...service,
          async fork(sessionId, targetSessionId) {
            calls.push(`fork:${sessionId}:${targetSessionId ?? ''}`)
            return {
              sessionId:
                targetSessionId ?? (await service.fork(sessionId)).sessionId,
              parentSessionId: sessionId,
            }
          },
          async resume(sessionId, prompt, signal) {
            calls.push(`resume:${sessionId}:${prompt}`)
            return service.resume(sessionId, prompt, signal)
          },
        }
      },
    }

    await expect(
      run(
        [
          '--continue',
          '--fork-session',
          '--session-id',
          '33333333-3333-4333-8333-333333333333',
          '--permission-mode',
          'dontAsk',
          '--tools=Read',
          '--',
          'hello',
        ],
        capture.io,
        controlled,
      ),
    ).resolves.toBe(0)

    expect(calls).toEqual([
      'fork:11111111-1111-4111-8111-111111111111:33333333-3333-4333-8333-333333333333',
      'resume:33333333-3333-4333-8333-333333333333:hello',
    ])
    expect(controls).toMatchObject({
      continueSession: true,
      forkSession: true,
      permissionMode: 'dontAsk',
      tools: ['Read'],
    })
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
          async inspect() {
            throw new Error('unused')
          },
          async export() {
            throw new Error('unused')
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

  it('supports Claude-style output format names while retaining legacy --json', async () => {
    const text = captureIO()
    await expect(
      run(['run', '--output-format', 'text', 'hello'], text.io, dependencies()),
    ).resolves.toBe(0)
    expect(text.stdout.join('')).toBe('answer:hello\n')

    const json = captureIO()
    await expect(
      run(['run', '--output-format', 'json', 'hello'], json.io, dependencies()),
    ).resolves.toBe(0)
    expect(json.stdout.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'answer:hello',
        session_id: expect.any(String),
        num_turns: 1,
        usage: { input_tokens: 2, output_tokens: 3 },
      }),
    ])

    const stream = captureIO()
    await expect(
      run(
        ['run', '--output-format', 'stream-json', '--verbose', 'hello'],
        stream.io,
        dependencies(),
      ),
    ).resolves.toBe(0)
    const streamed = stream.stdout.map((line) => JSON.parse(line))
    expect(streamed.map((record) => record.type)).toEqual([
      'system',
      'assistant',
      'result',
    ])
    expect(streamed[0]).toEqual(
      expect.objectContaining({ type: 'system', subtype: 'init' }),
    )
    expect(streamed[1]).toEqual(
      expect.objectContaining({
        type: 'assistant',
        message: expect.objectContaining({
          role: 'assistant',
          content: [{ type: 'text', text: 'answer:hello' }],
        }),
      }),
    )
    expect(streamed[2]).toEqual(
      expect.objectContaining({
        type: 'result',
        subtype: 'success',
        result: 'answer:hello',
      }),
    )

    const legacy = captureIO()
    await expect(
      run(['run', '--json', 'hello'], legacy.io, dependencies()),
    ).resolves.toBe(0)
    expect(legacy.stdout.map((line) => JSON.parse(line))).toEqual([
      { type: 'text-delta', delta: 'answer:hello' },
      expect.objectContaining({ type: 'result', text: 'answer:hello' }),
    ])
  })

  it('consumes text user messages from stream-json stdin for run and resume', async () => {
    const sessionId = '11111111-1111-4111-8111-111111111111'
    const input =
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'from stdin' }],
        },
      }) + '\n'
    const runCapture = captureStreamIO(input)
    await expect(
      run(
        [
          'run',
          '--input-format',
          'stream-json',
          '--output-format',
          'stream-json',
          '--verbose',
        ],
        runCapture.io,
        dependencies(),
      ),
    ).resolves.toBe(0)
    expect(runCapture.stdout.map((line) => JSON.parse(line)).at(-1)).toEqual(
      expect.objectContaining({ result: 'answer:from stdin' }),
    )

    const resumeCapture = captureStreamIO(
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'continue from stdin' },
      }) + '\n',
    )
    await expect(
      run(
        [
          'resume',
          '--input-format',
          'stream-json',
          '--output-format',
          'stream-json',
          '--verbose',
          sessionId,
        ],
        resumeCapture.io,
        dependencies(),
      ),
    ).resolves.toBe(0)
    expect(resumeCapture.stdout.map((line) => JSON.parse(line)).at(-1)).toEqual(
      expect.objectContaining({ result: 'resumed:continue from stdin' }),
    )
  })

  it('keeps one service and session across multiple realtime stdin turns', async () => {
    const fixedSessionId = '33333333-3333-4333-8333-333333333333'
    const calls: string[] = []
    let created = 0
    let closed = 0
    const realtime: CliDependencies = {
      async createService({ eventSink }) {
        created += 1
        const complete = (text: string) => {
          eventSink({ type: 'state', state: 'awaiting-model' })
          eventSink({ type: 'text-delta', delta: text })
          eventSink({
            type: 'usage',
            usage: { inputTokens: 1, outputTokens: 1 },
          })
          eventSink({ type: 'state', state: 'completed' })
        }
        return {
          async run(prompt, _signal, sessionId) {
            calls.push(`run:${sessionId}:${prompt}`)
            complete(`answer:${prompt}`)
            return {
              sessionId: sessionId ?? fixedSessionId,
              text: `answer:${prompt}`,
              usage: { inputTokens: 1, outputTokens: 1 },
            }
          },
          async resume(sessionId, prompt) {
            calls.push(`resume:${sessionId}:${prompt}`)
            complete(`answer:${prompt}`)
            return {
              sessionId,
              text: `answer:${prompt}`,
              usage: { inputTokens: 1, outputTokens: 1 },
            }
          },
          async fork() {
            throw new Error('unused')
          },
          async sessions() {
            return []
          },
          async inspect() {
            throw new Error('unused')
          },
          async export() {
            throw new Error('unused')
          },
          async close() {
            closed += 1
          },
          runtimeInfo() {
            return {
              cwd: '/workspace',
              model: 'test-model',
              tools: [],
              mcpServers: [],
              permissionMode: 'default',
              slashCommands: [],
              agents: [],
              skills: [],
              claudeCodeVersion: '2.1.208',
            }
          },
        }
      },
    }
    const first = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'first' },
    })
    const second = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'second' },
    })
    const capture = captureStreamIO(
      first.slice(0, 17),
      `${first.slice(17)}\n${second}\n`,
    )

    await expect(
      run(
        [
          '-p',
          '--input-format',
          'stream-json',
          '--output-format',
          'stream-json',
          '--verbose',
          '--replay-user-messages',
          '--session-id',
          fixedSessionId,
        ],
        capture.io,
        realtime,
      ),
    ).resolves.toBe(0)

    expect(calls).toEqual([
      `run:${fixedSessionId}:first`,
      `resume:${fixedSessionId}:second`,
    ])
    expect(created).toBe(1)
    expect(closed).toBe(1)
    const records = capture.stdout.map((line) => JSON.parse(line))
    expect(records.filter((record) => record.subtype === 'init')).toHaveLength(
      2,
    )
    expect(records.filter((record) => record.type === 'result')).toHaveLength(2)
    expect(
      records
        .filter((record) => record.type === 'user')
        .map((record) => record.message.content),
    ).toEqual(['first', 'second'])
    expect(new Set(records.map((record) => record.session_id))).toEqual(
      new Set([fixedSessionId]),
    )
  })

  it('returns redacted terminal result envelopes for structured execution failures', async () => {
    const variable = 'PRAXIS_PROTOCOL_TEST_API_KEY'
    const secret = 'protocol-failure-secret'
    const previous = process.env[variable]
    process.env[variable] = secret
    let closed = 0
    const failing: CliDependencies = {
      async createService({ eventSink }) {
        return {
          async run() {
            eventSink({ type: 'state', state: 'awaiting-model' })
            eventSink({
              type: 'failed',
              message: `provider ${secret}`,
              retryable: false,
            })
            throw new Error(`provider ${secret}`)
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
          async inspect() {
            throw new Error('unused')
          },
          async export() {
            throw new Error('unused')
          },
          async close() {
            closed += 1
          },
        }
      },
    }

    try {
      for (const format of ['json', 'stream-json'] as const) {
        const capture = captureIO()
        const args = [
          '-p',
          '--output-format',
          format,
          ...(format === 'stream-json' ? ['--verbose'] : []),
          'fail',
        ]
        await expect(run(args, capture.io, failing)).resolves.toBe(1)
        const records = capture.stdout.map((line) => JSON.parse(line))
        expect(records.at(-1)).toEqual(
          expect.objectContaining({
            type: 'result',
            subtype: 'error_during_execution',
            is_error: true,
            result: 'provider [REDACTED]',
          }),
        )
        expect(capture.stdout.join('')).not.toContain(secret)
        expect(capture.stderr).toEqual([])
      }
      expect(closed).toBe(2)
    } finally {
      if (previous === undefined) delete process.env[variable]
      else process.env[variable] = previous
    }
  })

  it('keeps a structured result terminal when service teardown fails', async () => {
    const capture = captureIO()
    const base = dependencies()
    const teardownFailure: CliDependencies = {
      async createService(options) {
        const service = await base.createService(options)
        return {
          ...service,
          async close() {
            throw new Error('teardown failed')
          },
        }
      },
    }

    await expect(
      run(
        ['-p', '--output-format', 'stream-json', '--verbose', 'hello'],
        capture.io,
        teardownFailure,
      ),
    ).resolves.toBe(0)

    const records = capture.stdout.map((line) => JSON.parse(line))
    expect(records.at(-1)).toMatchObject({
      type: 'result',
      subtype: 'success',
      is_error: false,
    })
    expect(capture.stderr).toEqual(['Warning: teardown failed\n'])
  })

  it('accepts empty stream-json input as a no-op', async () => {
    const capture = captureStreamIO('')

    await expect(
      run(
        [
          'run',
          '--input-format',
          'stream-json',
          '--output-format',
          'stream-json',
          '--verbose',
        ],
        capture.io,
        dependencies(),
      ),
    ).resolves.toBe(0)
    expect(capture.stdout).toEqual([])
    expect(capture.stderr).toEqual([])
  })

  it('rejects malformed stream-json input', async () => {
    for (const input of [
      '{bad}\n',
      JSON.stringify({ type: 'assistant', content: 'no user' }) + '\n',
    ]) {
      const capture = captureStreamIO(input)
      await expect(
        run(
          [
            'run',
            '--input-format',
            'stream-json',
            '--output-format',
            'stream-json',
            '--verbose',
          ],
          capture.io,
          dependencies(),
        ),
      ).resolves.toBe(1)
      expect(capture.stderr.join('')).toMatch(/stream-json/)
    }
  })

  it('validates format options and incompatible legacy flags', async () => {
    for (const argv of [
      ['run', '--output-format', 'yaml', 'hello'],
      ['run', '--input-format', 'yaml', 'hello'],
      ['run', '--json', '--output-format', 'json', 'hello'],
    ]) {
      const capture = captureIO()
      await expect(run(argv, capture.io, dependencies())).resolves.toBe(1)
      expect(`${capture.stderr.join('')}${capture.stdout.join('')}`).toMatch(
        /format|combined/,
      )
    }
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
    expect(listed.stdout.join('')).toContain('\thello\tready\t\n')
    expect(forked.stdout).toEqual(['22222222-2222-4222-8222-222222222222\n'])
  })

  it('inspects and exports sessions without a provider', async () => {
    const inspected = captureIO()
    const inspectedText = captureIO()
    const exported = captureIO()
    const sessionId = '11111111-1111-4111-8111-111111111111'

    await expect(
      run(['inspect', '--json', sessionId], inspected.io, dependencies()),
    ).resolves.toBe(0)
    await expect(
      run(['export', sessionId], exported.io, dependencies()),
    ).resolves.toBe(0)
    await expect(
      run(['inspect', sessionId], inspectedText.io, dependencies()),
    ).resolves.toBe(0)

    expect(inspected.stdout.map((line) => JSON.parse(line))).toEqual([
      {
        type: 'session',
        session: expect.objectContaining({ sessionId, status: 'ready' }),
      },
    ])
    expect(inspectedText.stdout.join('')).toContain(
      `${sessionId}\tready\tread-write\t2026-08-03T00:00:00.000Z\t3\t128\ttrue\thello\t\n`,
    )
    expect(exported.stdout).toEqual(['{"type":"user"}\n'])
  })

  it('exports invalid UTF-8 losslessly in plain and JSON modes', async () => {
    const source = Buffer.from([0xff, 0x0a])
    const plain = captureIO()
    const json = captureIO()
    const sessionId = '11111111-1111-4111-8111-111111111111'

    await expect(
      run(['export', sessionId], plain.io, dependencies(undefined, source)),
    ).resolves.toBe(0)
    await expect(
      run(
        ['export', '--json', sessionId],
        json.io,
        dependencies(undefined, source),
      ),
    ).resolves.toBe(0)

    expect(Buffer.concat(plain.stdoutBytes)).toEqual(source)
    expect(JSON.parse(json.stdout.join(''))).toEqual({
      type: 'session-export',
      sessionId,
      encoding: 'base64',
      transcript: source.toString('base64'),
    })
  })

  it('reports invalid commands without throwing', async () => {
    const capture = captureIO()

    await expect(run(['resume'], capture.io, dependencies())).resolves.toBe(1)
    expect(capture.stderr).toEqual(['Session ID is required\n'])
  })

  it('rejects extra operands for provider-free session commands', async () => {
    for (const argv of [
      ['sessions', 'extra'],
      ['inspect', '11111111-1111-4111-8111-111111111111', 'extra'],
      ['export', '11111111-1111-4111-8111-111111111111', 'extra'],
    ]) {
      const capture = captureIO()
      await expect(run(argv, capture.io, dependencies())).resolves.toBe(1)
      expect(capture.stderr.join('')).toContain('Unexpected operand')
    }
  })
})
