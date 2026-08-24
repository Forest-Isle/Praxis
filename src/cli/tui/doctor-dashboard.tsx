import React from 'react'

import { Box, Text } from 'ink'

import type {
  DoctorCheck,
  DoctorProgressReport,
  DoctorReport,
} from '../../maintenance/doctor.js'
import type { TuiDoctorSurfaceModel } from './doctor-surface-model.js'

export interface DoctorWarningGroup {
  heading: string
  checks: readonly DoctorCheck[]
}

const WARNING_GROUP_DEFINITIONS: readonly {
  heading: string
  ids: readonly DoctorCheck['id'][]
}[] = [
  { heading: 'MCP parsing warnings', ids: ['mcp'] },
  { heading: 'Plugin errors', ids: ['plugins'] },
  { heading: 'Unreachable permission rules', ids: ['permissions'] },
  {
    heading: 'Context and resource warnings',
    ids: ['config-root', 'resources'],
  },
  {
    heading: 'Hooks, settings, and runtime warnings',
    ids: [
      'installation',
      'node',
      'settings',
      'hooks',
      'claude-runtime',
      'provider',
    ],
  },
]

export function projectDoctorWarningGroups(
  report: DoctorReport | DoctorProgressReport,
): readonly DoctorWarningGroup[] {
  return WARNING_GROUP_DEFINITIONS.map((group) => ({
    heading: group.heading,
    checks: report.checks.filter(
      (check) => check.status !== 'pass' && group.ids.includes(check.id),
    ),
  })).filter((group) => group.checks.length > 0)
}

function checkStatusText(
  status: DoctorCheck['status'],
  screenReader: boolean,
): string {
  if (screenReader) {
    return status === 'pass' ? 'PASS' : status === 'warn' ? 'WARN' : 'FAIL'
  }
  return status === 'pass' ? '✓' : status === 'warn' ? '⚠' : '✗'
}

function checkStatusColor(status: DoctorCheck['status']): string {
  return status === 'pass' ? 'green' : status === 'warn' ? 'yellow' : 'red'
}

function formatDetailValue(value: unknown): string {
  if (value === undefined) return ''
  if (value === null) return 'null'
  if (typeof value === 'string') return value
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function checkDetails(check: DoctorCheck): React.ReactNode {
  if (!check.details) return null
  return (
    <>
      {Object.entries(check.details).map(([name, value]) => (
        <Text key={name}>{`    ${name}: ${formatDetailValue(value)}`}</Text>
      ))}
    </>
  )
}

function doctorSummary(report: DoctorReport | DoctorProgressReport): string {
  if (report.summary.failed > 0)
    return `${report.summary.failed} issue(s) found.`
  if (report.summary.warnings > 0) return 'No blocking issues found.'
  return 'No installation or configuration issues found.'
}

function WarningGroups({
  report,
  screenReader,
}: {
  report: DoctorReport | DoctorProgressReport
  screenReader: boolean
}) {
  const groups = projectDoctorWarningGroups(report)
  if (groups.length === 0) return null
  return (
    <>
      {groups.map((group) => (
        <Box key={group.heading} flexDirection="column">
          <Text bold {...(screenReader ? {} : { color: 'yellow' })}>
            {group.heading}
          </Text>
          {group.checks.map((check) => (
            <Box key={check.id} flexDirection="column">
              <Text color={checkStatusColor(check.status)}>
                {checkStatusText(check.status, screenReader)} {check.summary}
              </Text>
              {checkDetails(check)}
            </Box>
          ))}
        </Box>
      ))}
    </>
  )
}

export function DoctorDashboard({
  surface,
  width,
  screenReader,
}: {
  surface: TuiDoctorSurfaceModel
  width: number
  screenReader: boolean
}) {
  const { loading, report, error } = surface
  const footer = screenReader
    ? 'Enter to continue. Esc to cancel.'
    : 'Enter to continue · Esc to cancel'
  if (loading) {
    return (
      <Box flexDirection="column" width={Math.min(100, width)}>
        <Text bold> Doctor:</Text>
        <Text> </Text>
        <Text>Checking installation status…</Text>
      </Box>
    )
  }
  if (error !== null) {
    return (
      <Box flexDirection="column" width={Math.min(100, width)}>
        <Text bold> Doctor:</Text>
        <Text> </Text>
        <Text {...(screenReader ? {} : { color: 'red' })}>
          Diagnostics failed
        </Text>
        <Text>{error}</Text>
        <Text> </Text>
        <Text dimColor>{footer}</Text>
      </Box>
    )
  }
  if (report === null) return null
  const { diagnostic, updates } = report
  return (
    <Box flexDirection="column" width={Math.min(100, width)}>
      <Text bold> Doctor:</Text>
      <Text> </Text>
      <Text bold> Diagnostics</Text>
      <Text>{`Currently running: Praxis ${diagnostic.version} (${diagnostic.installationType})`}</Text>
      {diagnostic.packageManager !== null && (
        <Text>{`Package manager: ${diagnostic.packageManager}`}</Text>
      )}
      <Text>{`Path: ${diagnostic.installationPath}`}</Text>
      <Text>{`Invoked: ${diagnostic.invokedBinary}`}</Text>
      <Text>{`Config install method: ${diagnostic.configInstallMethod}`}</Text>
      {diagnostic.search.working ? (
        <>
          <Text>{`Search: OK (${diagnostic.search.mode})`}</Text>
          {diagnostic.search.systemPath !== null && (
            <Text>{`└ ${diagnostic.search.systemPath}`}</Text>
          )}
        </>
      ) : (
        <Text>Search: unavailable</Text>
      )}
      {diagnostic.multipleInstallations.length > 1 && (
        <>
          <Text bold>Multiple installations found</Text>
          {diagnostic.multipleInstallations.map((path) => (
            <Text key={path}>{`- ${path}`}</Text>
          ))}
        </>
      )}
      {diagnostic.recommendation !== null && (
        <Text>{`Recommendation: ${diagnostic.recommendation}`}</Text>
      )}
      {diagnostic.warnings.map((warning) => (
        <Box key={warning.issue} flexDirection="column">
          <Text>{warning.issue}</Text>
          <Text>{`└ Fix: ${warning.fix}`}</Text>
        </Box>
      ))}
      <Text> </Text>
      <Text bold> Updates</Text>
      <Text>{`Auto-updates: ${updates.autoUpdates}`}</Text>
      {updates.hasUpdatePermissions !== null && (
        <Text>{`Update permissions: ${updates.hasUpdatePermissions ? 'yes' : 'no'}`}</Text>
      )}
      <Text>{`Auto-update channel: ${updates.channel}`}</Text>
      {updates.registryStatus === 'available' ? (
        <>
          {updates.stableVersion !== null && (
            <Text>{`Stable version: ${updates.stableVersion}`}</Text>
          )}
          <Text>{`Latest version: ${updates.latestVersion ?? 'unknown'}`}</Text>
        </>
      ) : updates.registryStatus === 'loading' ? (
        <Text>Checking for updates…</Text>
      ) : (
        <Text>└ Failed to fetch versions</Text>
      )}
      <WarningGroups report={report} screenReader={screenReader} />
      <Text> </Text>
      <Text>{doctorSummary(report)}</Text>
      <Text>{`Summary: ${report.summary.passed} passed, ${report.summary.warnings} warnings, ${report.summary.failed} failed.`}</Text>
      <Text> </Text>
      <Text dimColor>{footer}</Text>
    </Box>
  )
}
