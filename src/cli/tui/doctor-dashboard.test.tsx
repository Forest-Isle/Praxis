import { cleanup, render } from 'ink-testing-library'
import { afterEach, describe, expect, it } from 'vitest'

import type { DoctorReport } from '../../maintenance/doctor.js'
import {
  DoctorDashboard,
  projectDoctorWarningGroups,
} from './doctor-dashboard.js'

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
      configInstallMethod: 'default (~/.claude)',
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

describe('DoctorDashboard', () => {
  it('renders the loading screen before completion', () => {
    const frame = render(
      <DoctorDashboard
        loading
        report={null}
        error={null}
        width={100}
        screenReader={false}
      />,
    ).lastFrame()
    expect(frame).toContain('Checking installation status…')
    expect(frame).not.toContain('Diagnostics')
    expect(frame).not.toContain('Updates')
  })

  it('renders a completed report with Diagnostics, Updates, statuses, details, and footer', () => {
    const frame = render(
      <DoctorDashboard
        loading={false}
        report={report()}
        error={null}
        width={100}
        screenReader={false}
      />,
    ).lastFrame()
    expect(frame).toContain('Diagnostics')
    expect(frame).toContain('Updates')
    expect(frame).toContain(
      'installation: Praxis 1.2.3 installation is readable',
    )
    expect(frame).toContain('version: 1.2.3')
    expect(frame).toContain('executablePath: /usr/local/bin/praxis')
    expect(frame).toContain('node: Node.js v24.0.0 satisfies >=24')
    expect(frame).toContain('mcp: 2 MCP server configuration(s) are valid')
    expect(frame).toContain('plugins: plugin manifest is missing a name')
    expect(frame).toContain('Current version: Praxis 1.2.3')
    expect(frame).toContain('Auto-update: not checked')
    expect(frame).toContain('Update channel: not checked')
    expect(frame).toContain('Latest version: not checked')
    expect(frame).toContain('Update permissions: not checked')
    expect(frame).toContain('1 issue(s) found.')
    expect(frame).toContain('Summary: 2 passed, 1 warnings, 1 failed.')
    expect(frame).toContain('Enter to continue · Esc to cancel')
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
        loading={false}
        report={report()}
        error={null}
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
        loading={false}
        report={clean}
        error={null}
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
        loading={false}
        report={null}
        error="PRAXIS_API_KEY is required"
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
        loading={false}
        report={report()}
        error={null}
        width={100}
        screenReader
      />,
    ).lastFrame()
    expect(frame).toContain('PASS installation:')
    expect(frame).toContain('WARN mcp:')
    expect(frame).toContain('FAIL plugins:')
    expect(frame).toContain('Enter to continue. Esc to cancel.')
    expect(frame).not.toContain('Enter to continue · Esc to cancel')
  })
})
