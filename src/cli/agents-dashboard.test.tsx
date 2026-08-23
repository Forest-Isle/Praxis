import { setImmediate } from 'node:timers/promises'

import { cleanup, render } from 'ink-testing-library'
import type { ReactElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import type { TopLevelAgentSummary } from '../application/top-level-agent-manager.js'
import {
  AgentsDashboardApp,
  type AgentsDashboardManager,
  runAgentsDashboard,
} from './agents-dashboard.js'
import { TuiThemeProvider } from './tui/theme.js'

afterEach(() => cleanup())

const flush = async () => {
  await setImmediate()
  await setImmediate()
}

function renderWithColor(element: ReactElement) {
  const previousNoColor = process.env.NO_COLOR
  delete process.env.NO_COLOR
  try {
    return render(element)
  } finally {
    if (previousNoColor === undefined) delete process.env.NO_COLOR
    else process.env.NO_COLOR = previousNoColor
  }
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
  it('loads persisted theme settings before the standalone dashboard renders', async () => {
    let rendered: ReactElement | undefined
    let loaded = false
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

    await expect(
      runAgentsDashboard(
        { manager, defaults: { argv: [] } },
        {
          async loadThemeSettings() {
            loaded = true
            return {
              theme: 'light-ansi',
              syntaxHighlightingDisabled: true,
            }
          },
          renderDashboard(element, options) {
            rendered = element
            expect(options).toEqual({ exitOnCtrlC: false })
            return { async waitUntilExit() {} }
          },
        },
      ),
    ).resolves.toBe(0)

    expect(loaded).toBe(true)
    expect(rendered?.type).toBe(TuiThemeProvider)
    expect(rendered?.props).toMatchObject({
      settings: {
        theme: 'light-ansi',
        syntaxHighlightingDisabled: true,
      },
    })
  })

  it('falls back to the default theme when shared settings are corrupt', async () => {
    let rendered: ReactElement | undefined
    const manager = {
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
    } satisfies AgentsDashboardManager

    await expect(
      runAgentsDashboard(
        { manager, defaults: { argv: [] } },
        {
          async loadThemeSettings() {
            throw new Error('Invalid JSON: settings.json')
          },
          renderDashboard(element) {
            rendered = element
            return { async waitUntilExit() {} }
          },
        },
      ),
    ).resolves.toBe(0)

    expect(rendered?.props).toMatchObject({
      settings: {
        theme: 'auto',
        syntaxHighlightingDisabled: false,
      },
    })
  })

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
      async review() {
        return 'REVIEW'
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

  it('applies semantic product and selected-row styles to the dashboard', async () => {
    const manager: AgentsDashboardManager = {
      async launch() {
        throw new Error('unused')
      },
      async list() {
        return [activeAgent]
      },
      async stop() {
        throw new Error('unused')
      },
      async attach() {
        throw new Error('unused')
      },
    }
    const app = renderWithColor(
      <TuiThemeProvider
        settings={{ theme: 'dark', syntaxHighlightingDisabled: false }}
      >
        <AgentsDashboardApp
          manager={manager}
          defaults={{ argv: [], cwd: '/workspace' }}
          refreshIntervalMs={60_000}
        />
      </TuiThemeProvider>,
    )

    await flush()
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('Praxis agents')
    expect(frame).toContain('› review release · idle · abcd1234')
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
      async review() {
        return 'REVIEW'
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
    app.stdin.write('continue review?')
    await flush()
    app.stdin.write('\r')
    await flush()
    expect(prompts).toEqual(['continue review?\n'])
    expect(app.lastFrame()).toContain('CONTINUED continue review?')

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
      async review() {
        return 'REVIEW'
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

  it('exits normally with Escape and navigates in displayed section order', async () => {
    let cancelled = false
    const manager: AgentsDashboardManager = {
      async launch() {
        throw new Error('unused')
      },
      async list() {
        return [
          { ...activeAgent, id: 'work0001', status: 'active' },
          {
            id: 'done0001',
            cwd: activeAgent.cwd,
            kind: activeAgent.kind,
            startedAt: activeAgent.startedAt,
            sessionId: activeAgent.sessionId,
            name: activeAgent.name,
            state: 'done',
          },
          { ...activeAgent, id: 'ready001' },
        ]
      },
      async review() {
        return 'REVIEW'
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
    expect(app.lastFrame()).toContain('Selected ready001')
    app.stdin.write('\u001b[B')
    await flush()
    expect(app.lastFrame()).toContain('Selected work0001')
    app.stdin.write('\u001b[B')
    await flush()
    expect(app.lastFrame()).toContain('Selected done0001')
    app.stdin.write('\u001b')
    await flush()
    expect(cancelled).toBe(false)
  })

  it('reviews completed sessions then resumes and attaches with original session identity', async () => {
    const completed: TopLevelAgentSummary = {
      id: 'abcd1234',
      cwd: activeAgent.cwd,
      kind: activeAgent.kind,
      startedAt: activeAgent.startedAt,
      sessionId: activeAgent.sessionId,
      name: activeAgent.name,
      state: 'stopped' as const,
    }
    const launches: unknown[] = []
    const attached: string[] = []
    const manager: AgentsDashboardManager = {
      async launch(options) {
        launches.push(options)
        return { id: 'efgh5678', sessionId: completed.sessionId }
      },
      async list() {
        return [completed]
      },
      async review() {
        return 'COMPLETED OUTPUT'
      },
      async stop() {},
      async attach(id) {
        attached.push(id)
      },
    }
    const app = render(
      <AgentsDashboardApp
        manager={manager}
        defaults={{ argv: ['--model', 'fixture'] }}
        refreshIntervalMs={60_000}
      />,
    )
    await flush()
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('COMPLETED OUTPUT')
    app.stdin.write('continue')
    app.stdin.write('\r')
    await flush()
    expect(launches).toEqual([
      {
        prompt: 'continue',
        argv: [
          '--model',
          'fixture',
          '--resume',
          completed.sessionId,
          '--',
          'continue',
        ],
        resumeSessionId: completed.sessionId,
        cwd: completed.cwd,
      },
    ])
    expect(attached).toEqual(['efgh5678'])
  })

  it('keeps the selected agent identity when a status change reorders sections', async () => {
    const resumed: TopLevelAgentSummary = {
      ...activeAgent,
      id: 'resumed1',
      name: 'resumed agent',
      status: 'active',
      state: 'working',
    }
    const native: TopLevelAgentSummary = {
      cwd: '/workspace',
      kind: 'interactive',
      startedAt: 2,
      sessionId: 'native-fixture-session',
      name: 'native fixture',
      status: 'idle',
    }
    let agents = [native, resumed]
    const stopped: string[] = []
    const manager: AgentsDashboardManager = {
      async launch() {
        throw new Error('unused')
      },
      async list() {
        return agents
      },
      async review() {
        return 'REVIEW'
      },
      async stop(id) {
        stopped.push(id)
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
    app.stdin.write('\u001b[B')
    await flush()
    expect(app.lastFrame()).toContain('Selected resumed1')

    agents = [{ ...resumed, status: 'idle' }, native]
    app.stdin.write('\u0012')
    await flush()
    expect(app.lastFrame()).toContain('Selected resumed1')

    app.stdin.write('\u0018')
    await flush()
    expect(stopped).toEqual(['resumed1'])
  })

  it('shows blocked handoffs in Needs input instead of Ready for review', async () => {
    const blocked: TopLevelAgentSummary = {
      ...activeAgent,
      tempo: 'blocked',
      needs: 'send a prompt to start',
    }
    const manager: AgentsDashboardManager = {
      async launch() {
        throw new Error('unused')
      },
      async list() {
        return [blocked]
      },
      async review() {
        return 'REVIEW'
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
    expect(app.lastFrame()).toMatch(
      /Ready for review \(0\)[\s\S]*Needs input \(1\)/u,
    )
    expect(app.lastFrame()).toContain('blocked · abcd1234')
  })

  it('reviews active native sessions without treating them as attachable', async () => {
    const native: TopLevelAgentSummary = {
      cwd: '/workspace',
      kind: 'interactive',
      startedAt: 1,
      sessionId: 'aaaaaaaa-1111-4111-8111-111111111111',
      name: 'native live',
      status: 'idle',
    }
    const manager: AgentsDashboardManager = {
      async launch() {
        throw new Error('must not launch')
      },
      async list() {
        return [native]
      },
      async review() {
        return 'NATIVE TRANSCRIPT'
      },
      async stop() {
        throw new Error('must not stop')
      },
      async attach() {
        throw new Error('must not attach')
      },
    }
    const app = render(
      <AgentsDashboardApp
        manager={manager}
        defaults={{ argv: [] }}
        refreshIntervalMs={60_000}
      />,
    )
    await flush()
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('NATIVE TRANSCRIPT')
    expect(app.lastFrame()).toContain('read-only')
  })
})
