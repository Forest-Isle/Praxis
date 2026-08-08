import { setImmediate } from 'node:timers/promises'

import { cleanup, render } from 'ink-testing-library'
import { afterEach, describe, expect, it } from 'vitest'

import type { TopLevelAgentSummary } from '../application/top-level-agent-manager.js'
import {
  AgentsDashboardApp,
  type AgentsDashboardManager,
} from './agents-dashboard.js'

afterEach(() => cleanup())

const flush = async () => {
  await setImmediate()
  await setImmediate()
}

const activeAgent: TopLevelAgentSummary = {
  id: 'abcd1234',
  cwd: '/workspace',
  kind: 'background',
  startedAt: 1,
  sessionId: 'abcd1234-1111-4111-8111-111111111111',
  name: 'review release',
  status: 'idle',
  state: 'working',
}

describe('AgentsDashboardApp', () => {
  it('refreshes the full list for its cwd', async () => {
    let agents = [activeAgent]
    const requests: unknown[] = []
    const manager: AgentsDashboardManager = {
      async launch() {
        throw new Error('unused')
      },
      async list(options) {
        requests.push(options)
        return agents
      },
      async stop() {
        throw new Error('unused')
      },
      async attach() {
        throw new Error('unused')
      },
    }
    const app = render(
      <AgentsDashboardApp
        manager={manager}
        defaults={{ argv: [], cwd: '/workspace' }}
        refreshIntervalMs={60_000}
      />,
    )

    await flush()
    expect(app.lastFrame()).toContain('review release')
    expect(requests).toContainEqual({ all: true, cwd: '/workspace' })

    agents = [
      {
        ...activeAgent,
        id: 'efgh5678',
        name: 'inspect release notes',
      },
    ]
    app.stdin.write('\u0012')
    await flush()
    expect(app.lastFrame()).toContain('inspect release notes')
  })

  it('dispatches defaults, attaches a selected agent, and stops it', async () => {
    const launches: unknown[] = []
    const prompts: string[] = []
    const stopped: string[] = []
    const manager: AgentsDashboardManager = {
      async launch(options) {
        launches.push(options)
        return {
          id: 'efgh5678',
          sessionId: 'efgh5678-1111-4111-8111-111111111111',
        }
      },
      async list() {
        return [activeAgent]
      },
      async stop(id) {
        stopped.push(id)
      },
      async attach(_id, input, output) {
        output('INITIAL RESULT\n')
        for await (const chunk of input) {
          const prompt = String(chunk)
          prompts.push(prompt)
          output(`CONTINUED ${prompt}`)
        }
      },
    }
    const app = render(
      <AgentsDashboardApp
        manager={manager}
        defaults={{
          argv: ['--model', 'fixture-model', '--agent', 'reviewer'],
          cwd: '/workspace',
        }}
        refreshIntervalMs={60_000}
      />,
    )

    await flush()
    app.stdin.write('write release notes')
    await flush()
    app.stdin.write('\r')
    await flush()
    expect(launches).toEqual([
      {
        prompt: 'write release notes',
        argv: [
          '--model',
          'fixture-model',
          '--agent',
          'reviewer',
          '--',
          'write release notes',
        ],
        cwd: '/workspace',
      },
    ])

    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('Attached to abcd1234')
    expect(app.lastFrame()).toContain('INITIAL RESULT')
    app.stdin.write('continue review')
    await flush()
    app.stdin.write('\r')
    await flush()
    expect(prompts).toEqual(['continue review\n'])
    expect(app.lastFrame()).toContain('CONTINUED continue review')

    app.stdin.write('\u0018')
    await flush()
    expect(stopped).toEqual(['abcd1234'])
  })

  it('cancels the dashboard with Ctrl+C', async () => {
    let cancelled = false
    const manager: AgentsDashboardManager = {
      async launch() {
        throw new Error('unused')
      },
      async list() {
        return []
      },
      async stop() {
        throw new Error('unused')
      },
      async attach() {
        throw new Error('unused')
      },
    }
    const app = render(
      <AgentsDashboardApp
        manager={manager}
        defaults={{ argv: [] }}
        refreshIntervalMs={60_000}
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
})
