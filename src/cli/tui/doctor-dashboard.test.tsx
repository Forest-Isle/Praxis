import { cleanup, render } from 'ink-testing-library'
import { afterEach, describe, expect, it } from 'vitest'

import type {
  DoctorProgressReport,
  DoctorReport,
} from '../../maintenance/doctor.js'
import {
  DoctorDashboard,
  projectDoctorWarningGroups,
} from './doctor-dashboard.js'
import { projectTuiDoctorSurface } from './doctor-surface-model.js'

afterEach(() => cleanup())

function report(overrides: Partial<DoctorReport> = {}): DoctorReport {
  return {
    type: 'doctor',
    ok: true,
    praxisVersion: '1.2.3',
    diagnostic: {
      installationType: 'npm',
      version: '1.2.3',
      packageManager: 'npm',
      installationPath: '/usr/local/lib/node_modules/praxis-agent/dist/cli.js',
      invokedBinary: '/usr/local/bin/praxis',
      search: {
        working: true,
        mode: 'system',
        systemPath: '/usr/local/bin/rg',
      },
      recommendation: null,
      multipleInstallations: ['/usr/local/bin/praxis'],
      warnings: [],
    },
    updates: {
      autoUpdates: 'Manual (praxis update)',
      hasUpdatePermissions: true,
      channel: 'stable',
      stableVersion: '1.2.3',
      latestVersion: '1.2.4',
      registryStatus: 'available',
    },
    checks: [
      {
        id: 'installation',
        status: 'pass',
        summary: 'Praxis 1.2.3 installation is readable',
        details: {
          version: '1.2.3',
          executablePath: '/usr/local/bin/praxis',
        },
      },
      {
        id: 'mcp',
        status: 'warn',
        summary: '2 MCP server configuration(s) are valid',
        details: {
          servers: [{ name: 'filesystem' }],
          warnings: ['server filesystem uses a deprecated transport'],
        },
      },
      {
        id: 'plugins',
        status: 'fail',
        summary: 'plugin manifest is missing a name',
      },
      {
        id: 'node',
        status: 'pass',
        summary: 'Node.js v24.0.0 satisfies >=24',
        details: { version: 'v24.0.0', executablePath: '/usr/local/bin/node' },
      },
    ],
    summary: { passed: 2, warnings: 1, failed: 1 },
    ...overrides,
  }
}

function progressReport(
  overrides: Partial<DoctorProgressReport> = {},
): DoctorProgressReport {
  return {
    ...report(),
    updates: {
      autoUpdates: 'Manual (praxis update)',
      hasUpdatePermissions: true,
      channel: 'stable',
      stableVersion: null,
      latestVersion: null,
      registryStatus: 'loading',
    },
    ...overrides,
  }
}

describe('DoctorDashboard', () => {
  it('renders the loading screen before completion', () => {
    const frame = render(
      <DoctorDashboard
        surface={projectTuiDoctorSurface({
          loading: true,
          report: null,
          error: null,
        })}
        width={100}
        screenReader={false}
      />,
    ).lastFrame()
    expect(frame).toContain('Checking installation status…')
    expect(frame).not.toContain('Diagnostics')
    expect(frame).not.toContain('Updates')
  })

  it('renders completed Diagnostics and Updates with real report fields and no placeholders', () => {
    const frame = render(
      <DoctorDashboard
        surface={projectTuiDoctorSurface({
          loading: false,
          report: report(),
          error: null,
        })}
        width={100}
        screenReader={false}
      />,
    ).lastFrame()
    expect(frame).toContain('Diagnostics')
    expect(frame).toContain('Currently running: Praxis 1.2.3 (npm)')
    expect(frame).toContain('Package manager: npm')
    expect(frame).toContain(
      'Path: /usr/local/lib/node_modules/praxis-agent/dist/cli.js',
    )
    expect(frame).toContain('Invoked: /usr/local/bin/praxis')
    expect(frame).toContain('Search: OK (system)')
    expect(frame).toContain('└ /usr/local/bin/rg')
    expect(frame).toContain('Updates')
    expect(frame).toContain('Auto-updates: Manual (praxis update)')
    expect(frame).toContain('Update permissions: yes')
    expect(frame).toContain('Auto-update channel: stable')
    expect(frame).toContain('Stable version: 1.2.3')
    expect(frame).toContain('Latest version: 1.2.4')
    expect(frame).toContain('1 issue(s) found.')
    expect(frame).toContain('Summary: 2 passed, 1 warnings, 1 failed.')
    expect(frame).toContain('Enter to continue · Esc to cancel')
    // Non-passing checks surface exactly once through the warning groups.
    expect(frame).toContain('MCP parsing warnings')
    expect(frame).toContain('server filesystem uses a deprecated transport')
    expect(frame).toContain('Plugin errors')
    expect(frame).toContain('plugin manifest is missing a name')
    // No raw pass checklist, no duplicated current-version line, no placeholders.
    expect(frame).not.toContain('not checked')
    expect(frame).not.toContain('Current version: Praxis')
    expect(frame).not.toContain(
      'installation: Praxis 1.2.3 installation is readable',
    )
    expect(frame).not.toContain('node: Node.js v24.0.0 satisfies >=24')
    expect(frame).not.toContain('mcp: 2 MCP server configuration(s) are valid')
  })

  it('renders Diagnostics and the pending checking-updates state for a progress report', () => {
    const frame = render(
      <DoctorDashboard
        surface={projectTuiDoctorSurface({
          loading: false,
          report: progressReport(),
          error: null,
        })}
        width={100}
        screenReader={false}
      />,
    ).lastFrame()
    expect(frame).toContain('Diagnostics')
    expect(frame).toContain('Currently running: Praxis 1.2.3 (npm)')
    expect(frame).toContain('Package manager: npm')
    expect(frame).toContain('Updates')
    expect(frame).toContain('Auto-updates: Manual (praxis update)')
    expect(frame).toContain('Update permissions: yes')
    expect(frame).toContain('Auto-update channel: stable')
    expect(frame).toContain('Checking for updates…')
    expect(frame).toContain('Summary: 2 passed, 1 warnings, 1 failed.')
    expect(frame).toContain('Enter to continue · Esc to cancel')
    expect(frame).not.toContain('Stable version:')
    expect(frame).not.toContain('Latest version:')
    expect(frame).not.toContain('└ Failed to fetch versions')
  })

  it('projects warning/failing checks into conditional groups and omits empty groups', () => {
    const groups = projectDoctorWarningGroups(report())
    expect(groups.map((group) => group.heading)).toEqual([
      'MCP parsing warnings',
      'Plugin errors',
    ])
    expect(groups[0]?.checks.map((check) => check.id)).toEqual(['mcp'])
    expect(groups[1]?.checks.map((check) => check.id)).toEqual(['plugins'])

    const frame = render(
      <DoctorDashboard
        surface={projectTuiDoctorSurface({
          loading: false,
          report: report(),
          error: null,
        })}
        width={100}
        screenReader={false}
      />,
    ).lastFrame()
    expect(frame).toContain('MCP parsing warnings')
    expect(frame).toContain('server filesystem uses a deprecated transport')
    expect(frame).toContain('Plugin errors')
    expect(frame).toContain('plugin manifest is missing a name')
    expect(frame).not.toContain('Unreachable permission rules')
    expect(frame).not.toContain('Context and resource warnings')
    expect(frame).not.toContain('Hooks, settings, and runtime warnings')
  })

  it('omits all conditional groups when every check passes', () => {
    const clean = report({
      ok: true,
      checks: [
        {
          id: 'installation',
          status: 'pass',
          summary: 'Praxis 1.2.3 installation is readable',
        },
        {
          id: 'node',
          status: 'pass',
          summary: 'Node.js v24.0.0 satisfies >=24',
        },
      ],
      summary: { passed: 2, warnings: 0, failed: 0 },
    })
    expect(projectDoctorWarningGroups(clean)).toEqual([])
    const frame = render(
      <DoctorDashboard
        surface={projectTuiDoctorSurface({
          loading: false,
          report: clean,
          error: null,
        })}
        width={100}
        screenReader={false}
      />,
    ).lastFrame()
    expect(frame).toContain('No installation or configuration issues found.')
    expect(frame).not.toContain('MCP parsing warnings')
    expect(frame).not.toContain('Plugin errors')
  })

  it('renders a current-generation loader failure as a sanitized error screen', () => {
    const frame = render(
      <DoctorDashboard
        surface={projectTuiDoctorSurface({
          loading: false,
          report: null,
          error: 'PRAXIS_API_KEY is required',
        })}
        width={100}
        screenReader={false}
      />,
    ).lastFrame()
    expect(frame).toContain('Diagnostics failed')
    expect(frame).toContain('PRAXIS_API_KEY is required')
    expect(frame).toContain('Enter to continue · Esc to cancel')
    expect(frame).not.toContain('Updates')
    expect(frame).not.toContain('installation:')
  })

  it('uses screen-reader text and color-free labels in axScreenReader mode', () => {
    const frame = render(
      <DoctorDashboard
        surface={projectTuiDoctorSurface({
          loading: false,
          report: report(),
          error: null,
        })}
        width={100}
        screenReader
      />,
    ).lastFrame()
    expect(frame).toContain('Currently running: Praxis 1.2.3 (npm)')
    expect(frame).toContain('WARN 2 MCP server configuration(s) are valid')
    expect(frame).toContain('FAIL plugin manifest is missing a name')
    expect(frame).not.toContain('PASS installation:')
    expect(frame).toContain('Enter to continue. Esc to cancel.')
    expect(frame).not.toContain('Enter to continue · Esc to cancel')
  })

  it('renders missing search and the diagnostic warning fix without a fake path', () => {
    const missingSearch = report({
      diagnostic: {
        ...report().diagnostic,
        search: { working: false, mode: 'system', systemPath: null },
        warnings: [
          {
            issue: 'The ripgrep (rg) command is not installed on PATH',
            fix: 'Install ripgrep and ensure it is on PATH',
          },
        ],
      },
    })
    const frame = render(
      <DoctorDashboard
        surface={projectTuiDoctorSurface({
          loading: false,
          report: missingSearch,
          error: null,
        })}
        width={100}
        screenReader={false}
      />,
    ).lastFrame()
    expect(frame).toContain('Search: unavailable')
    expect(frame).not.toContain('└ /usr/local/bin/rg')
    expect(frame).toContain('The ripgrep (rg) command is not installed on PATH')
    expect(frame).toContain('└ Fix: Install ripgrep and ensure it is on PATH')
  })

  it('renders duplicate installations with the recommendation', () => {
    const duplicates = report({
      diagnostic: {
        ...report().diagnostic,
        multipleInstallations: [
          '/usr/local/bin/praxis',
          '/usr/local/bin/praxis-old',
        ],
        recommendation: 'Remove stale duplicate Praxis installations',
      },
    })
    const frame = render(
      <DoctorDashboard
        surface={projectTuiDoctorSurface({
          loading: false,
          report: duplicates,
          error: null,
        })}
        width={100}
        screenReader={false}
      />,
    ).lastFrame()
    expect(frame).toContain('Multiple installations found')
    expect(frame).toContain('- /usr/local/bin/praxis')
    expect(frame).toContain('- /usr/local/bin/praxis-old')
    expect(frame).toContain(
      'Recommendation: Remove stale duplicate Praxis installations',
    )
  })

  it('omits the duplicate-installations heading for a single installation', () => {
    const frame = render(
      <DoctorDashboard
        surface={projectTuiDoctorSurface({
          loading: false,
          report: report(),
          error: null,
        })}
        width={100}
        screenReader={false}
      />,
    ).lastFrame()
    expect(frame).not.toContain('Multiple installations found')
  })

  it('renders the unavailable registry failure and omits version lines', () => {
    const unavailable = report({
      updates: {
        ...report().updates,
        registryStatus: 'unavailable',
        stableVersion: null,
        latestVersion: null,
        error: 'Failed to fetch version information from the npm registry',
      },
    })
    const frame = render(
      <DoctorDashboard
        surface={projectTuiDoctorSurface({
          loading: false,
          report: unavailable,
          error: null,
        })}
        width={100}
        screenReader={false}
      />,
    ).lastFrame()
    expect(frame).toContain('└ Failed to fetch versions')
    expect(frame).not.toContain('Stable version:')
    expect(frame).not.toContain('Latest version:')
  })

  it('omits the update permissions line when permission status is null', () => {
    const unknownPermissions = report({
      updates: { ...report().updates, hasUpdatePermissions: null },
    })
    const frame = render(
      <DoctorDashboard
        surface={projectTuiDoctorSurface({
          loading: false,
          report: unknownPermissions,
          error: null,
        })}
        width={100}
        screenReader={false}
      />,
    ).lastFrame()
    expect(frame).toContain('Auto-updates: Manual (praxis update)')
    expect(frame).not.toContain('Update permissions:')
  })

  it('renders a source install without a package-manager line', () => {
    const source = report({
      diagnostic: {
        ...report().diagnostic,
        installationType: 'source',
        packageManager: null,
      },
    })
    const frame = render(
      <DoctorDashboard
        surface={projectTuiDoctorSurface({
          loading: false,
          report: source,
          error: null,
        })}
        width={100}
        screenReader={false}
      />,
    ).lastFrame()
    expect(frame).toContain('Currently running: Praxis 1.2.3 (source)')
    expect(frame).not.toContain('Package manager:')
  })
})
