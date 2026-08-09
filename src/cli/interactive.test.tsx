import { setImmediate } from 'node:timers/promises'

import { cleanup, render } from 'ink-testing-library'
import { afterEach, describe, expect, it } from 'vitest'

import type { ModelToolCall } from '../core/runtime.js'
import {
  InteractiveApp,
  type InteractiveServiceFactory,
  runInteractive,
} from './interactive.js'

afterEach(() => cleanup())

const flush = async () => {
  await setImmediate()
  await setImmediate()
}

describe('InteractiveApp', () => {
  it('uses native session names in the session picker', async () => {
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            return {
              async run() {
                throw new Error('unused')
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
        }}
        initialSessions={[
          {
            sessionId: 'named-session',
            name: 'Release review',
            lastPrompt: 'inspect the release',
            updatedAt: '2026-08-06T00:00:00.000Z',
            status: 'ready',
            issue: null,
          },
        ]}
      />,
    )
    await flush()
    app.stdin.write('/sessions')
    await flush()
    expect(app.lastFrame()).toContain('Release review · named-session')
    app.stdin.write('\r')
    await flush()
  })

  it('omits the new-session choice for a required filtered resume', async () => {
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            throw new Error('unused')
          },
        }}
        initialSessions={[
          {
            sessionId: 'linked-session',
            lastPrompt: 'linked prompt',
            updatedAt: '2026-08-08T00:00:00.000Z',
            status: 'ready',
            issue: null,
            prNumber: 42,
            prUrl: 'https://github.com/owner/repo/pull/42',
            prRepository: 'owner/repo',
          },
        ]}
        allowNewSession={false}
      />,
    )
    await flush()
    expect(app.lastFrame()).toContain('linked prompt · linked-session')
    expect(app.lastFrame()).not.toContain('New session')
  })

  it('keeps the picker for a non-ID resume search with one result', async () => {
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            return {
              async run() {
                throw new Error('unused')
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
        }}
        initialSessions={[
          {
            sessionId: 'resolved-session',
            name: 'Release review',
            lastPrompt: 'inspect release',
            updatedAt: '2026-08-08T00:00:00.000Z',
            status: 'ready',
            issue: null,
          },
        ]}
        allowNewSession={false}
        resume={{ sessionSelector: 'release', requireSession: true }}
      />,
    )
    await flush()
    expect(app.lastFrame()).toContain('Release review · resolved-session')
    expect(app.lastFrame()).not.toContain('New session')
  })

  it('lists live workflows without sending a model prompt', async () => {
    const factory: InteractiveServiceFactory = {
      async createService() {
        return {
          async run() {
            throw new Error('unused')
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
          workflows() {
            return [
              {
                task_id: 'w12345678',
                status: 'running',
                summary: 'Review repository',
              },
            ]
          },
        }
      },
    }
    const app = render(
      <InteractiveApp factory={factory} initialSessions={[]} />,
    )
    await flush()
    app.stdin.write('/workflows')
    await flush()
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('w12345678 [running] Review repository')
  })

  it('streams a new session and then resumes it', async () => {
    const calls: string[] = []
    let closed = 0
    const factory: InteractiveServiceFactory = {
      async createService({ eventSink }) {
        return {
          async run(prompt) {
            calls.push(`run:${prompt}`)
            eventSink({ type: 'text-delta', delta: 'first answer' })
            return {
              sessionId: 'session-1',
              text: 'first answer',
              usage: { inputTokens: 1, outputTokens: 2 },
            }
          },
          async resume(sessionId, prompt) {
            calls.push(`resume:${sessionId}:${prompt}`)
            eventSink({ type: 'text-delta', delta: 'second answer' })
            return {
              sessionId,
              text: 'second answer',
              usage: { inputTokens: 2, outputTokens: 3 },
            }
          },
          async fork() {
            throw new Error('unused')
          },
          async sessions() {
            return []
          },
          async close() {
            closed += 1
          },
        }
      },
    }
    const app = render(
      <InteractiveApp factory={factory} initialSessions={[]} />,
    )

    await flush()
    app.stdin.write('first prompt')
    await flush()
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('first answer')

    app.stdin.write('continue')
    await flush()
    app.stdin.write('\r')
    await flush()

    expect(app.lastFrame()).toContain('second answer')
    expect(calls).toEqual(['run:first prompt', 'resume:session-1:continue'])
    expect(closed).toBe(2)
  })

  it('submits an initial prompt once after mounting', async () => {
    const calls: string[] = []
    const factory: InteractiveServiceFactory = {
      async createService() {
        return {
          async run(prompt) {
            calls.push(`run:${prompt}`)
            return {
              sessionId: 'initial-session',
              text: 'initial answer',
              usage: { inputTokens: 1, outputTokens: 1 },
            }
          },
          async resume(sessionId, prompt) {
            calls.push(`resume:${sessionId}:${prompt}`)
            return {
              sessionId,
              text: 'resume answer',
              usage: { inputTokens: 1, outputTokens: 1 },
            }
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
    const app = render(
      <InteractiveApp
        factory={factory}
        initialSessions={[]}
        initialPrompt="review this change"
      />,
    )

    await flush()
    await flush()

    expect(app.lastFrame()).toContain('initial answer')
    expect(calls).toEqual(['run:review this change'])
  })

  it('waits for resume selection before submitting an initial prompt once', async () => {
    const calls: string[] = []
    const factory: InteractiveServiceFactory = {
      async createService() {
        return {
          async run(prompt) {
            calls.push(`run:${prompt}`)
            return {
              sessionId: 'new-session',
              text: 'new answer',
              usage: { inputTokens: 1, outputTokens: 1 },
            }
          },
          async resume(sessionId, prompt) {
            calls.push(`resume:${sessionId}:${prompt}`)
            return {
              sessionId,
              text: 'continued answer',
              usage: { inputTokens: 1, outputTokens: 1 },
            }
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
    const app = render(
      <InteractiveApp
        factory={factory}
        initialSessions={[
          {
            sessionId: 'resume-session',
            lastPrompt: 'previous prompt',
            updatedAt: '2026-08-09T00:00:00.000Z',
            status: 'ready',
            issue: null,
          },
        ]}
        initialPrompt="continue review"
        allowNewSession={false}
        resume={{ sessionSelector: 'resume', requireSession: true }}
      />,
    )

    await flush()
    expect(calls).toEqual([])
    app.stdin.write('\r')
    await flush()
    await flush()

    expect(app.lastFrame()).toContain('continued answer')
    expect(calls).toEqual(['resume:resume-session:continue review'])
  })

  it('keeps one service alive and submits scheduled prompts while idle', async () => {
    const calls: string[] = []
    let created = 0
    let waits = 0
    const factory: InteractiveServiceFactory = {
      scheduledPrompts: true,
      async createService() {
        created += 1
        return {
          async run(prompt) {
            calls.push(`run:${prompt}`)
            return {
              sessionId: 'scheduled-session',
              text: 'scheduled answer',
              usage: { inputTokens: 1, outputTokens: 1 },
            }
          },
          async resume(sessionId, prompt) {
            calls.push(`resume:${sessionId}:${prompt}`)
            return {
              sessionId,
              text: 'manual answer',
              usage: { inputTokens: 1, outputTokens: 1 },
            }
          },
          async nextScheduledPrompt(signal) {
            waits += 1
            if (waits === 1) return { id: 'abc12345', prompt: 'cron prompt' }
            return new Promise((resolve) =>
              signal?.addEventListener('abort', () => resolve(null), {
                once: true,
              }),
            )
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
    const app = render(
      <InteractiveApp factory={factory} initialSessions={[]} />,
    )

    await flush()
    await flush()
    expect(app.lastFrame()).toContain('scheduled answer')

    app.stdin.write('manual prompt')
    await flush()
    app.stdin.write('\r')
    await flush()

    expect(calls).toEqual([
      'run:cron prompt',
      'resume:scheduled-session:manual prompt',
    ])
    expect(created).toBe(1)
  })

  it('redacts ambient credentials from interactive diagnostics', async () => {
    const secret = `interactive-diagnostic-secret-${'x'.repeat(200)}-canary`
    const variable = 'PRAXIS_TEST_API_KEY'
    const previous = process.env[variable]
    process.env[variable] = secret
    const factory: InteractiveServiceFactory = {
      async createService({ eventSink }) {
        return {
          async run() {
            eventSink({ type: 'warning', message: `warning ${secret}` })
            eventSink({
              type: 'tool-call',
              call: {
                id: 'secret-call',
                name: 'Bash',
                input: { command: `printf ${secret}` },
              },
            })
            eventSink({
              type: 'tool-result',
              callId: 'secret-call',
              content: `tool error ${secret}`,
              isError: true,
            })
            eventSink({
              type: 'failed',
              message: `runtime failure ${secret}`,
              retryable: false,
            })
            throw new Error(`provider failure ${secret}`)
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
      const app = render(
        <InteractiveApp factory={factory} initialSessions={[]} />,
      )
      await flush()
      app.stdin.write('trigger failure')
      await flush()
      app.stdin.write('\r')
      await flush()

      expect(app.lastFrame()).toContain('[REDACTED]')
      expect(app.lastFrame()).not.toContain(secret)
      expect(app.lastFrame()).not.toContain(secret.slice(0, 40))
    } finally {
      if (previous === undefined) delete process.env[variable]
      else process.env[variable] = previous
    }
  })

  it('reports close failures and leaves the prompt usable', async () => {
    const factory: InteractiveServiceFactory = {
      async createService() {
        return {
          async run() {
            return {
              sessionId: 'session-1',
              text: 'done',
              usage: { inputTokens: 1, outputTokens: 1 },
            }
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
          async close() {
            throw new Error('close failed')
          },
        }
      },
    }
    const app = render(
      <InteractiveApp factory={factory} initialSessions={[]} />,
    )

    await flush()
    app.stdin.write('run')
    await flush()
    app.stdin.write('\r')
    await flush()

    expect(app.lastFrame()).toContain('done')
    expect(app.lastFrame()).toContain('close failed')
    expect(app.lastFrame()).toContain('/new')
    expect(app.lastFrame()).not.toContain('ready…')
  })

  it('asks before an ask-permission tool and forwards the decision', async () => {
    let approval: boolean | undefined
    const call: ModelToolCall = {
      id: 'call-1',
      name: 'Bash',
      input: { command: 'npm test' },
    }
    const factory: InteractiveServiceFactory = {
      async createService({ approveTool }) {
        return {
          async run() {
            approval = await approveTool?.(call)
            return {
              sessionId: 'session-1',
              text: 'done',
              usage: { inputTokens: 1, outputTokens: 1 },
            }
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
    const app = render(
      <InteractiveApp factory={factory} initialSessions={[]} />,
    )

    await flush()
    app.stdin.write('run tests')
    await flush()
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('Allow Bash')
    expect(app.lastFrame()).toContain('npm test')

    app.stdin.write('y')
    await flush()
    expect(approval).toBe(true)
    expect(app.lastFrame()).toContain('done')
  })

  it('collects interactive model questions with numbered and custom answers', async () => {
    let result: unknown
    const factory: InteractiveServiceFactory = {
      async createService({ askUser }) {
        return {
          async run() {
            result = await askUser?.([
              {
                question: 'Which runtime?',
                header: 'Runtime',
                options: [
                  { label: 'Node', description: 'Use Node.js' },
                  { label: 'Bun', description: 'Use Bun' },
                ],
                multiSelect: false,
              },
              {
                question: 'Which checks?',
                header: 'Checks',
                options: [
                  { label: 'Tests', description: 'Run tests' },
                  { label: 'Types', description: 'Run typecheck' },
                ],
                multiSelect: true,
              },
            ])
            return {
              sessionId: 'session-1',
              text: 'done',
              usage: { inputTokens: 1, outputTokens: 1 },
            }
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
    const app = render(
      <InteractiveApp factory={factory} initialSessions={[]} />,
    )
    await flush()
    app.stdin.write('start')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('Runtime: Which runtime?')
    app.stdin.write('Bun, with npm')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('Checks: Which checks?')
    app.stdin.write('1, custom lint')
    app.stdin.write('\r')
    await flush()
    expect(result).toEqual({
      answers: {
        'Which runtime?': 'Bun, with npm',
        'Which checks?': 'Tests, custom lint',
      },
    })
  })

  it('cancels interactive questions when the tool signal aborts', async () => {
    const controller = new AbortController()
    let result: unknown = 'pending'
    const factory: InteractiveServiceFactory = {
      async createService({ askUser }) {
        return {
          async run() {
            result = await askUser?.(
              [
                {
                  question: 'Continue?',
                  header: 'Confirm',
                  options: [
                    { label: 'Yes', description: 'Continue' },
                    { label: 'No', description: 'Stop' },
                  ],
                  multiSelect: false,
                },
              ],
              controller.signal,
            )
            return {
              sessionId: 'session-1',
              text: 'done',
              usage: { inputTokens: 1, outputTokens: 1 },
            }
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
    const app = render(
      <InteractiveApp factory={factory} initialSessions={[]} />,
    )
    await flush()
    app.stdin.write('start')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('Confirm: Continue?')
    controller.abort()
    await flush()
    expect(result).toBeNull()
    expect(app.lastFrame()).toContain('done')
  })

  it('shows plan content and forwards plan approval', async () => {
    let approval: boolean | undefined
    const factory: InteractiveServiceFactory = {
      async createService({ approvePlan }) {
        return {
          async run() {
            approval = await approvePlan?.({
              action: 'exit',
              planPath: '/tmp/plan.md',
              plan: '# Plan\n\n1. Implement.',
            })
            return {
              sessionId: 'session-1',
              text: 'done',
              usage: { inputTokens: 1, outputTokens: 1 },
            }
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
    const app = render(
      <InteractiveApp factory={factory} initialSessions={[]} />,
    )
    await flush()
    app.stdin.write('start')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('Approve this plan')
    expect(app.lastFrame()).toContain('1. Implement.')
    app.stdin.write('y')
    await flush()
    expect(approval).toBe(true)
  })

  it('declines plan approval when the tool signal aborts', async () => {
    const controller = new AbortController()
    let approval: boolean | undefined
    const factory: InteractiveServiceFactory = {
      async createService({ approvePlan }) {
        return {
          async run() {
            approval = await approvePlan?.(
              { action: 'exit', planPath: '/tmp/plan.md' },
              controller.signal,
            )
            return {
              sessionId: 'session-1',
              text: 'done',
              usage: { inputTokens: 1, outputTokens: 1 },
            }
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
    const app = render(
      <InteractiveApp factory={factory} initialSessions={[]} />,
    )
    await flush()
    app.stdin.write('start')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('Approve this plan')
    controller.abort()
    await flush()
    expect(approval).toBe(false)
    expect(app.lastFrame()).toContain('done')
  })

  it('round-trips interactive MCP elicitation form data', async () => {
    let result: unknown
    const factory: InteractiveServiceFactory = {
      async createService({ onElicitation }) {
        return {
          async run() {
            result = await onElicitation?.({
              serverName: 'fixture',
              message: 'Provide a value',
              mode: 'form',
              requestedSchema: {
                type: 'object',
                properties: { code: { type: 'string' } },
              },
            })
            return {
              sessionId: 'session-1',
              text: 'done',
              usage: { inputTokens: 1, outputTokens: 1 },
            }
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
    const app = render(
      <InteractiveApp factory={factory} initialSessions={[]} />,
    )

    await flush()
    app.stdin.write('run')
    await flush()
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('MCP elicitation (fixture)')
    app.stdin.write('{"code":"ok"}')
    await flush()
    app.stdin.write('\r')
    await flush()

    expect(result).toEqual({ action: 'accept', content: { code: 'ok' } })
    expect(app.lastFrame()).toContain('done')
  })

  it('asks before retrying an interrupted tool during resume', async () => {
    let recoveryApproval: boolean | undefined
    const call: ModelToolCall = {
      id: 'call-interrupted',
      name: 'Bash',
      input: { command: 'npm test' },
    }
    const factory: InteractiveServiceFactory = {
      async createService({ approveRecovery }) {
        return {
          async run() {
            throw new Error('unused')
          },
          async resume(sessionId) {
            recoveryApproval = await approveRecovery?.(call)
            return {
              sessionId,
              text: 'recovered',
              usage: { inputTokens: 1, outputTokens: 1 },
            }
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
    const app = render(
      <InteractiveApp
        factory={factory}
        initialSessions={[
          {
            sessionId: 'session-1',
            lastPrompt: 'interrupted task',
            updatedAt: '2026-08-04T00:00:00.000Z',
            status: 'ready',
            issue: null,
          },
        ]}
      />,
    )

    app.stdin.write('\u001B[B')
    await flush()
    app.stdin.write('\r')
    await flush()
    app.stdin.write('continue')
    await flush()
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('Retry interrupted Bash')
    expect(app.lastFrame()).toContain('npm test')

    app.stdin.write('y')
    await flush()
    expect(recoveryApproval).toBe(true)
    expect(app.lastFrame()).toContain('recovered')
  })

  it('forks a required session and auto-retries recovery when requested', async () => {
    const calls: string[] = []
    let recoveryApproval: boolean | undefined
    const factory: InteractiveServiceFactory = {
      async createService({ approveRecovery }) {
        recoveryApproval = await approveRecovery?.({
          id: 'call-interrupted',
          name: 'Bash',
          input: { command: 'npm test' },
        })
        return {
          async run() {
            throw new Error('unused')
          },
          async resume(sessionId, prompt) {
            calls.push(`resume:${sessionId}:${prompt}`)
            return {
              sessionId,
              text: 'forked answer',
              usage: { inputTokens: 1, outputTokens: 1 },
            }
          },
          async fork(sessionId, targetSessionId) {
            calls.push(`fork:${sessionId}:${targetSessionId ?? ''}`)
            return {
              parentSessionId: sessionId,
              sessionId: targetSessionId ?? 'generated-fork',
            }
          },
          async sessions() {
            return []
          },
        }
      },
    }
    const app = render(
      <InteractiveApp
        factory={factory}
        initialSessions={[
          {
            sessionId: 'linked-session',
            lastPrompt: 'linked task',
            updatedAt: '2026-08-08T00:00:00.000Z',
            status: 'ready',
            issue: null,
          },
        ]}
        allowNewSession={false}
        resume={{
          forkSession: true,
          forkSessionId: 'explicit-fork',
          retryInterruptedTools: true,
        }}
      />,
    )

    app.stdin.write('\r')
    await flush()
    app.stdin.write('continue')
    await flush()
    app.stdin.write('\r')
    await flush()

    expect(recoveryApproval).toBe(true)
    expect(calls).toEqual([
      'fork:linked-session:explicit-fork',
      'resume:explicit-fork:continue',
    ])
    expect(app.lastFrame()).toContain('forked answer')
    expect(app.lastFrame()).not.toContain('Retry interrupted Bash')
  })

  it('settles a newly-created permission prompt when cancellation races render', async () => {
    const controller = new AbortController()
    let approval: boolean | undefined
    const call: ModelToolCall = {
      id: 'call-race',
      name: 'Bash',
      input: { command: 'npm test' },
    }
    const factory: InteractiveServiceFactory = {
      async createService({ approveTool }) {
        return {
          async run() {
            const pendingApproval = approveTool?.(call)
            controller.abort()
            approval = await pendingApproval
            return {
              sessionId: 'session-1',
              text: 'cancelled',
              usage: { inputTokens: 0, outputTokens: 0 },
            }
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
    const app = render(
      <InteractiveApp
        factory={factory}
        initialSessions={[]}
        signal={controller.signal}
      />,
    )

    await flush()
    app.stdin.write('run tests')
    await flush()
    app.stdin.write('\r')
    await flush()

    expect(approval).toBe(false)
  })

  it('selects an existing session before accepting a prompt', async () => {
    const resumed: string[] = []
    const factory: InteractiveServiceFactory = {
      async createService() {
        return {
          async run() {
            throw new Error('unused')
          },
          async resume(sessionId, prompt) {
            resumed.push(`${sessionId}:${prompt}`)
            return {
              sessionId,
              text: 'resumed answer',
              usage: { inputTokens: 1, outputTokens: 1 },
            }
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
    const app = render(
      <InteractiveApp
        factory={factory}
        initialSessions={[
          {
            sessionId: 'session-1',
            lastPrompt: 'previous task',
            updatedAt: '2026-08-04T00:00:00.000Z',
            status: 'ready',
            issue: null,
          },
        ]}
      />,
    )

    expect(app.lastFrame()).toContain('previous task')
    app.stdin.write('\u001B[B')
    await flush()
    app.stdin.write('\r')
    await flush()
    app.stdin.write('continue')
    await flush()
    app.stdin.write('\r')
    await flush()

    expect(resumed).toEqual(['session-1:continue'])
    expect(app.lastFrame()).toContain('resumed answer')
  })

  it('propagates Ctrl+C through the interactive cancellation seam', async () => {
    let cancelled = false
    const factory: InteractiveServiceFactory = {
      async createService() {
        throw new Error('unused')
      },
    }
    const app = render(
      <InteractiveApp
        factory={factory}
        initialSessions={[]}
        onCancel={() => {
          cancelled = true
        }}
      />,
    )

    await flush()
    app.stdin.write('\u0003')
    await flush()

    expect(cancelled).toBe(true)
  })

  it('exposes the active turn promise for shutdown coordination', async () => {
    let finishTurn: (() => void) | undefined
    let activeTurn: Promise<void> | null = null
    const factory: InteractiveServiceFactory = {
      async createService() {
        return {
          async run() {
            await new Promise<void>((resolve) => {
              finishTurn = resolve
            })
            return {
              sessionId: 'session-1',
              text: 'done',
              usage: { inputTokens: 1, outputTokens: 1 },
            }
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
    const app = render(
      <InteractiveApp
        factory={factory}
        initialSessions={[]}
        onTurnChange={(turn) => {
          activeTurn = turn
        }}
      />,
    )

    await flush()
    app.stdin.write('wait')
    await flush()
    app.stdin.write('\r')
    await flush()
    expect(activeTurn).toBeInstanceOf(Promise)

    finishTurn?.()
    await activeTurn
    await flush()
    expect(activeTurn).toBeNull()
  })
})

describe('runInteractive', () => {
  it('closes the listing service after loading sessions', async () => {
    let closed = 0
    const controller = new AbortController()
    controller.abort()
    const factory: InteractiveServiceFactory = {
      async createService() {
        return {
          async run() {
            throw new Error('unused')
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
          async close() {
            closed += 1
          },
        }
      },
    }

    await expect(
      runInteractive({ factory, signal: controller.signal }),
    ).resolves.toBe(130)
    expect(closed).toBe(1)
  })

  it('closes the listing service when loading sessions fails', async () => {
    let closed = 0
    const factory: InteractiveServiceFactory = {
      async createService() {
        return {
          async run() {
            throw new Error('unused')
          },
          async resume() {
            throw new Error('unused')
          },
          async fork() {
            throw new Error('unused')
          },
          async sessions() {
            throw new Error('listing failed')
          },
          async close() {
            closed += 1
          },
        }
      },
    }

    await expect(runInteractive({ factory })).rejects.toThrow('listing failed')
    expect(closed).toBe(1)
  })

  it('closes the listing service when a required filter has no matches', async () => {
    let closed = 0
    const factory: InteractiveServiceFactory = {
      async createService() {
        return {
          async run() {
            throw new Error('unused')
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
          async close() {
            closed += 1
          },
        }
      },
    }

    await expect(
      runInteractive({ factory, requireSession: true }),
    ).rejects.toThrow('No conversation linked')
    expect(closed).toBe(1)
  })
})
