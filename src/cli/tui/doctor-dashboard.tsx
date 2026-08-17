import React from 'react'

import { Box, Text } from 'ink'

import type { DoctorCheck, DoctorReport } from '../../maintenance/doctor.js'

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
  report: DoctorReport,
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

function doctorSummary(report: DoctorReport): string {
  if (report.summary.failed > 0)
    return `${report.summary.failed} issue(s) found.`
  if (report.summary.warnings > 0) return 'No blocking issues found.'
  return 'No installation or configuration issues found.'
}

function WarningGroups({
  report,
  screenReader,
}: {
  report: DoctorReport
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
  loading,
  report,
  error,
  width,
  screenReader,
}: {
  loading: boolean
  report: DoctorReport | null
  error: string | null
  width: number
  screenReader: boolean
}) {
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
  return (
    <Box flexDirection="column" width={Math.min(100, width)}>
      <Text bold> Doctor:</Text>
      <Text> </Text>
      <Text bold> Diagnostics</Text>
      {report.checks.map((check) => (
        <Box key={check.id} flexDirection="column">
          <Text color={checkStatusColor(check.status)}>
            {checkStatusText(check.status, screenReader)} {check.id}:{' '}
            {check.summary}
          </Text>
          {checkDetails(check)}
        </Box>
      ))}
      <Text> </Text>
      <Text bold> Updates</Text>
      <Text>{`Current version: Praxis ${report.praxisVersion}`}</Text>
      <Text>Auto-update: not checked</Text>
      <Text>Update channel: not checked</Text>
      <Text>Latest version: not checked</Text>
      <Text>Update permissions: not checked</Text>
      <WarningGroups report={report} screenReader={screenReader} />
      <Text> </Text>
      <Text>{doctorSummary(report)}</Text>
      <Text>{`Summary: ${report.summary.passed} passed, ${report.summary.warnings} warnings, ${report.summary.failed} failed.`}</Text>
      <Text> </Text>
      <Text dimColor>{footer}</Text>
    </Box>
  )
}
