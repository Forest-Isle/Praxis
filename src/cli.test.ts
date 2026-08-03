import { describe, expect, it } from 'vitest'

import { run, type CliDependencies, type CliIO } from './cli.js'

function captureIO() {
  const stdout: string[] = []
  const stderr: string[] = []
  const io: CliIO = {
    stdout: (message) => stdout.push(message),
    stderr: (message) => stderr.push(message),
  }
  return { io, stdout, stderr }
}

function dependencies(): CliDependencies {
  return {
    async createService({ eventSink }) {
      return {
        async run(prompt) {
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

  it('runs a prompt in plain output mode', async () => {
    const capture = captureIO()

    await expect(
      run(['run', 'hello', 'world'], capture.io, dependencies()),
    ).resolves.toBe(0)
    expect(capture.stdout.join('')).toBe('answer:hello world\n')
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
