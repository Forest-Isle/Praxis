import { cleanup, render } from 'ink-testing-library'
import { afterEach, describe, expect, it } from 'vitest'

import {
  ConfigDashboard,
  projectConfigRows,
  projectContextUsage,
} from './config-dashboard.js'

afterEach(() => cleanup())

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
        tab="config"
        snapshot={snapshot}
        selectedIndex={2}
        searchFocused={false}
        width={100}
        screenReader={false}
        maxRows={8}
      />,
    )
    const frame = app.lastFrame() ?? ''
    expect(frame).toMatch(/Settings\s+Status\s+Config\s+Usage\s+Stats/u)
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
        tab="config"
        snapshot={snapshot}
        query="permission"
        searchFocused
        width={40}
        screenReader
        maxRows={4}
      />,
    )
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('Default permission mode')
    expect(frame).toContain('Type to filter')
    expect(frame).toContain('Selected tab: Config')
    expect(frame).not.toContain('────')
    expect(frame).not.toContain('╭')
  })

  it('stacks labels and values without exceeding a narrow terminal', () => {
    const app = render(
      <ConfigDashboard
        tab="config"
        snapshot={snapshot}
        selectedIndex={1}
        searchFocused={false}
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

  it('renders measured status, usage, and provider-free empty stats', () => {
    const status = render(
      <ConfigDashboard
        tab="status"
        snapshot={snapshot}
        status={{
          version: '0.7.0',
          sessionId: 'session-fixture',
          cwd: '/work',
          authSource: 'PRAXIS_API_KEY',
          baseUrl: 'https://provider.test',
          model: 'fixture-model',
          settingSources: ['user', 'project'],
        }}
        width={100}
        screenReader={false}
      />,
    )
    expect(status.lastFrame()).toContain('Session ID:')
    expect(status.lastFrame()).toContain('session-fixture')
    expect(status.lastFrame()).toContain('user, project')

    const usage = render(
      <ConfigDashboard
        tab="usage"
        snapshot={snapshot}
        usage={{
          costUsd: 0.125,
          apiDurationMs: 1_500,
          wallDurationMs: 3_200,
          linesAdded: 4,
          linesRemoved: 2,
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            cacheReadInputTokens: 3,
            cacheCreationInputTokens: 2,
          },
        }}
        width={100}
        screenReader={false}
      />,
    )
    expect(usage.lastFrame()).toContain('Total cost: $0.1250')
    expect(usage.lastFrame()).toContain('4 lines added, 2 lines removed')
    expect(usage.lastFrame()).toContain(
      '10 input, 5 output, 3 cache read, 2 cache write',
    )

    const stats = render(
      <ConfigDashboard
        tab="stats"
        snapshot={snapshot}
        stats={[]}
        width={100}
        screenReader={false}
      />,
    )
    expect(stats.lastFrame()).toContain(
      'No stats available yet. Start using Praxis Code!',
    )

    const populatedStats = render(
      <ConfigDashboard
        tab="stats"
        snapshot={snapshot}
        stats={[{ label: 'Sessions', value: '4' }]}
        width={100}
        screenReader={false}
      />,
    )
    expect(populatedStats.lastFrame()).toContain('Sessions:')
    expect(populatedStats.lastFrame()).toContain('4')
  })

  it('renders all five tabs explicitly and rejects missing measured data', async () => {
    const fixture = JSON.parse(
      await readFile(
        new URL(
          '../../../test/fixtures/claude-code/2.1.208/config-dashboard.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ) as {
      tabs: string[]
      statusLabels: string[]
      usageLabels: string[]
      emptyStats: string
    }
    const settings = render(
      <ConfigDashboard
        tab="settings"
        snapshot={snapshot}
        settings={[{ label: 'Thinking mode', value: 'provider controlled' }]}
        width={100}
        screenReader={false}
      />,
    )
    expect(settings.lastFrame()).toContain('Thinking mode:')

    const status = render(
      <ConfigDashboard
        tab="status"
        snapshot={snapshot}
        status={{
          version: '0.7.0',
          sessionName: 'fixture',
          sessionId: 'session-fixture',
          cwd: '/work',
          authSource: 'PRAXIS_API_KEY',
          baseUrl: 'https://provider.test',
          model: 'fixture-model',
          settingSources: ['user'],
        }}
        width={100}
        screenReader={false}
      />,
    )
    for (const label of fixture.statusLabels)
      expect(status.lastFrame()).toContain(`${label}:`)

    const usage = render(
      <ConfigDashboard
        tab="usage"
        snapshot={snapshot}
        usage={{
          costUsd: 0,
          apiDurationMs: 0,
          wallDurationMs: 0,
          linesAdded: 0,
          linesRemoved: 0,
          usage: { inputTokens: 0, outputTokens: 0 },
        }}
        width={100}
        screenReader={false}
      />,
    )
    for (const label of fixture.usageLabels)
      expect(usage.lastFrame()).toContain(`${label}:`)

    const stats = render(
      <ConfigDashboard
        tab="stats"
        snapshot={snapshot}
        stats={[]}
        width={100}
        screenReader={false}
      />,
    )
    expect(stats.lastFrame()).toContain(fixture.emptyStats)
    expect(fixture.tabs).toEqual([
      'Settings',
      'Status',
      'Config',
      'Usage',
      'Stats',
    ])

    expect(() =>
      ConfigDashboard({
        tab: 'settings',
        snapshot,
        width: 100,
        screenReader: false,
      }),
    ).toThrow('requires measured settings data')
    expect(() =>
      ConfigDashboard({
        tab: 'status',
        snapshot,
        width: 100,
        screenReader: false,
      }),
    ).toThrow('requires measured status data')
    expect(() =>
      ConfigDashboard({
        tab: 'usage',
        snapshot,
        width: 100,
        screenReader: false,
      }),
    ).toThrow('requires measured usage data')
    expect(() =>
      ConfigDashboard({
        tab: 'stats',
        snapshot,
        width: 100,
        screenReader: false,
      }),
    ).toThrow('requires measured stats data')
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
import { readFile } from 'node:fs/promises'
