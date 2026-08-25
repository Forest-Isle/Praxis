import { cleanup, render } from 'ink-testing-library'
import { afterEach, describe, expect, it } from 'vitest'

import { formatCostSummary } from './cost-summary.js'
import {
  ConfigDashboard,
  projectConfigRows,
  projectContextUsage,
} from './config-dashboard.js'
import { projectTuiConfigSurface } from './config-surface-model.js'

afterEach(() => cleanup())

const surface = (input: Parameters<typeof projectTuiConfigSurface>[0]) =>
  projectTuiConfigSurface(input)

const snapshot = {
  settings: {
    autoCompactEnabled: false,
    permissions: { defaultMode: 'plan' },
    theme: 'dark-ansi',
  },
  state: { respectGitignore: false },
}

describe('Claude-style config dashboard', () => {
  it('projects native values and filters labels, keys, and values', () => {
    expect(projectConfigRows(snapshot)).toHaveLength(31)
    expect(projectConfigRows(snapshot, 'auto-compact')[0]).toMatchObject({
      value: false,
      displayValue: 'false',
    })
    expect(projectConfigRows(snapshot, 'permissionMode')[0]).toMatchObject({
      displayValue: 'Plan',
    })
    expect(projectConfigRows(snapshot, 'ansi')[0]).toMatchObject({
      displayValue: 'Dark mode (ANSI colors only)',
    })
    expect(
      projectConfigRows(snapshot, '', {
        model: 'haiku',
        theme: 'light',
      }).filter((row) => ['model', 'theme'].includes(row.definition.id)),
    ).toMatchObject([
      { definition: { id: 'theme' }, displayValue: 'Light mode' },
      { definition: { id: 'model' }, displayValue: 'haiku' },
    ])
  })

  it('renders the fixed config hierarchy, selection, overflow, and footer', () => {
    const app = render(
      <ConfigDashboard
        surface={surface({
          tab: 'config',
          snapshot,
          selectedIndex: 2,
          searchFocused: false,
        })}
        width={100}
        screenReader={false}
        maxRows={8}
      />,
    )
    const frame = app.lastFrame() ?? ''
    expect(frame).toMatch(/Settings\s+Status\s+Config\s+Usage/u)
    expect(frame.split('\n')[0]?.trimStart()).toMatch(/^Settings/u)
    expect(frame.split('\n').every((line) => !/^─+$/.test(line))).toBe(true)
    expect(frame).toContain('⌕ Search settings…')
    expect(frame).toContain('Auto-compact')
    expect(frame).toContain('❯ Show tips')
    expect(frame).toContain('↓ 23 more below')
    expect(frame).toContain(
      'Enter/Space to change · / to search · Esc to close',
    )
    expect(frame.split('\n').every((line) => line.length <= 100)).toBe(true)
  })

  it('renders the screen-reader search state without decorative borders', () => {
    const app = render(
      <ConfigDashboard
        surface={surface({
          tab: 'config',
          snapshot,
          query: 'permission',
          searchFocused: true,
        })}
        width={40}
        screenReader
        maxRows={4}
      />,
    )
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('Settings')
    expect(frame).toContain('Default permission mode')
    expect(frame).toContain('Type to filter')
    expect(frame).toContain('Selected tab: Config')
    expect(frame).not.toContain('────')
    expect(frame).not.toContain('╭')
  })

  it('stacks labels and values without exceeding a narrow terminal', () => {
    const app = render(
      <ConfigDashboard
        surface={surface({
          tab: 'config',
          snapshot,
          selectedIndex: 1,
          searchFocused: false,
        })}
        width={32}
        screenReader={false}
        maxRows={5}
      />,
    )
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('❯ Switch models when a message\nis flagged')
    expect(frame).toContain('true')
    expect(frame.split('\n').every((line) => line.length <= 32)).toBe(true)
  })

  it('renders measured status and usage', () => {
    const status = render(
      <ConfigDashboard
        surface={surface({
          tab: 'status',
          snapshot,
          status: {
            version: '0.7.0',
            sessionId: 'session-fixture',
            cwd: '/work',
            authSource: 'PRAXIS_API_KEY',
            baseUrl: 'https://provider.test',
            model: 'fixture-model',
            settingSources: ['user', 'project'],
          },
        })}
        width={100}
        screenReader={false}
      />,
    )
    expect(status.lastFrame()).toContain('Session ID:')
    expect(status.lastFrame()).toContain('session-fixture')
    expect(status.lastFrame()).toContain('user, project')

    const usageData = {
      totalCostUsd: 0.125,
      apiDurationMs: 1_500,
      wallDurationMs: 3_200,
      linesAdded: 4,
      linesRemoved: 2,
      hasUnknownModelCost: false,
      modelUsage: [
        {
          model: 'claude-sonnet-4-20250514',
          canonicalName: 'claude-sonnet-4-0',
          inputTokens: 10,
          outputTokens: 5,
          cacheReadInputTokens: 3,
          cacheCreationInputTokens: 2,
          webSearchRequests: 2,
          costUsd: 0.125,
        },
      ],
    }
    const usage = render(
      <ConfigDashboard
        surface={surface({ tab: 'usage', snapshot, usage: usageData })}
        width={100}
        screenReader={false}
      />,
    )
    const frame = usage.lastFrame() ?? ''
    expect(frame).toMatch(/Settings\s+Status\s+Config\s+Usage/u)
    expect(frame).toContain(formatCostSummary(usageData))
    expect(frame).toContain('Usage by model:')
    expect(frame).toContain('claude-sonnet-4-0')
    expect(frame).toContain('2 web search')
  })

  it('renders the three source tabs and rejects missing measured data', () => {
    const status = render(
      <ConfigDashboard
        surface={surface({
          tab: 'status',
          snapshot,
          status: {
            version: '0.7.0',
            sessionName: 'fixture',
            sessionId: 'session-fixture',
            cwd: '/work',
            authSource: 'PRAXIS_API_KEY',
            baseUrl: 'https://provider.test',
            model: 'fixture-model',
            settingSources: ['user'],
          },
        })}
        width={100}
        screenReader={false}
      />,
    )
    expect(status.lastFrame()).toMatch(/Settings\s+Status\s+Config\s+Usage/u)
    for (const label of [
      'Version',
      'Session name',
      'Session ID',
      'cwd',
      'Model',
    ])
      expect(status.lastFrame()).toContain(`${label}:`)

    const usage = render(
      <ConfigDashboard
        surface={surface({
          tab: 'usage',
          snapshot,
          usage: {
            totalCostUsd: 0,
            apiDurationMs: 0,
            wallDurationMs: 0,
            linesAdded: 0,
            linesRemoved: 0,
            hasUnknownModelCost: false,
            modelUsage: [],
          },
        })}
        width={100}
        screenReader={false}
      />,
    )
    for (const label of [
      'Total cost',
      'Total duration (API)',
      'Total duration (wall)',
      'Total code changes',
      'Usage',
    ])
      expect(usage.lastFrame()).toContain(`${label}:`)
    expect(() =>
      ConfigDashboard({
        surface: surface({ tab: 'status', snapshot }),
        width: 100,
        screenReader: false,
      }),
    ).toThrow('requires measured status data')
    expect(() =>
      ConfigDashboard({
        surface: surface({ tab: 'usage', snapshot }),
        width: 100,
        screenReader: false,
      }),
    ).toThrow('requires measured usage data')
  })

  it('requires measured context categories and never invents capacity', () => {
    expect(
      projectContextUsage({
        contextWindowTokens: 200_000,
        categories: [
          { label: 'System prompt', tokens: 10_000 },
          { label: 'Messages', tokens: 25_000 },
        ],
      }),
    ).toEqual({
      contextWindowTokens: 200_000,
      usedTokens: 35_000,
      freeTokens: 165_000,
      categories: [
        { label: 'System prompt', tokens: 10_000 },
        { label: 'Messages', tokens: 25_000 },
      ],
    })
    expect(() =>
      projectContextUsage({
        contextWindowTokens: 10,
        categories: [{ label: 'Messages', tokens: 11 }],
      }),
    ).toThrow('exceed the context window')
  })
})
