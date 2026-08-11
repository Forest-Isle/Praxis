import React from 'react'
import { Box, Text } from 'ink'

import type { ModelUsage } from '../../core/runtime.js'
import {
  CLAUDE_2_1_208_CONFIG_SETTINGS,
  configSettingValue,
  type ConfigSettingDefinition,
  type ConfigSettingsSnapshot,
  type ConfigValue,
} from './config-settings.js'

export type ConfigDashboardTab =
  'settings' | 'status' | 'config' | 'usage' | 'stats'

export interface ConfigStatusData {
  version: string
  sessionName?: string
  sessionId: string
  cwd: string
  authSource?: string
  baseUrl?: string
  model: string
  settingSources: readonly string[]
}

export interface ConfigUsageData {
  costUsd: number
  apiDurationMs: number
  wallDurationMs: number
  linesAdded: number
  linesRemoved: number
  usage: ModelUsage
}

export interface ContextCategory {
  label: string
  tokens: number
}

export interface ConfigContextData {
  contextWindowTokens: number
  categories: readonly ContextCategory[]
}

export interface ConfigDashboardValueRow {
  label: string
  value: string
}

export interface ConfigRow {
  definition: ConfigSettingDefinition
  value: ConfigValue
  displayValue: string
}

export type ConfigEffectiveValues = Readonly<
  Partial<Record<string, ConfigValue>>
>

const tabs: readonly { id: ConfigDashboardTab; label: string }[] = [
  { id: 'settings', label: 'Settings' },
  { id: 'status', label: 'Status' },
  { id: 'config', label: 'Config' },
  { id: 'usage', label: 'Usage' },
  { id: 'stats', label: 'Stats' },
]

function displayValue(definition: ConfigSettingDefinition, value: ConfigValue) {
  if (definition.id === 'permissionMode') {
    return (
      (
        {
          default: 'Manual',
          plan: 'Plan',
          acceptEdits: 'Accept edits',
          auto: 'Auto',
          dontAsk: "Don't ask",
        } as Record<string, string>
      )[String(value)] ?? String(value)
    )
  }
  if (definition.id === 'theme') {
    return (
      (
        {
          auto: 'Auto',
          dark: 'Dark mode',
          light: 'Light mode',
          'light-daltonized': 'Light mode (colorblind-friendly)',
          'dark-daltonized': 'Dark mode (colorblind-friendly)',
          'light-ansi': 'Light mode (ANSI colors only)',
          'dark-ansi': 'Dark mode (ANSI colors only)',
        } as Record<string, string>
      )[String(value)] ?? String(value)
    )
  }
  if (definition.id === 'notifChannel') {
    return (
      (
        {
          auto: 'Auto',
          iterm2: 'iTerm2 (OSC 9)',
          terminal_bell: 'Terminal bell',
          iterm2_with_bell: 'iTerm2 and terminal bell',
          kitty: 'Kitty',
          ghostty: 'Ghostty',
          notifications_disabled: 'Disabled',
        } as Record<string, string>
      )[String(value)] ?? String(value)
    )
  }
  if (definition.id === 'language' && value === 'default')
    return 'Default (English)'
  return String(value)
}

export function projectConfigRows(
  snapshot: ConfigSettingsSnapshot,
  query = '',
  effectiveValues: ConfigEffectiveValues = {},
): ConfigRow[] {
  const normalized = query.trim().toLowerCase()
  return CLAUDE_2_1_208_CONFIG_SETTINGS.map((definition) => {
    const value =
      effectiveValues[definition.id] ?? configSettingValue(snapshot, definition)
    return { definition, value, displayValue: displayValue(definition, value) }
  }).filter(
    (row) =>
      !normalized ||
      row.definition.label.toLowerCase().includes(normalized) ||
      row.definition.nativeKey.toLowerCase().includes(normalized) ||
      row.displayValue.toLowerCase().includes(normalized),
  )
}

export function projectContextUsage(data: ConfigContextData) {
  if (
    !Number.isSafeInteger(data.contextWindowTokens) ||
    data.contextWindowTokens <= 0
  )
    throw new Error('Context window must be a positive integer')
  const categories = data.categories.map((category) => {
    if (!Number.isSafeInteger(category.tokens) || category.tokens < 0)
      throw new Error(`Invalid context category tokens: ${category.label}`)
    return category
  })
  const usedTokens = categories.reduce(
    (total, category) => total + category.tokens,
    0,
  )
  if (usedTokens > data.contextWindowTokens)
    throw new Error('Measured context categories exceed the context window')
  return {
    categories,
    usedTokens,
    freeTokens: data.contextWindowTokens - usedTokens,
    contextWindowTokens: data.contextWindowTokens,
  }
}

function DashboardTabs({
  active,
  screenReader,
}: {
  active: ConfigDashboardTab
  screenReader: boolean
}) {
  if (screenReader) {
    return (
      <Box flexDirection="column">
        {tabs.map((tab) => (
          <Text key={tab.id}>
            {tab.id === active ? 'Selected tab: ' : ''}
            {tab.label}
          </Text>
        ))}
      </Box>
    )
  }
  return (
    <Text>
      {'  '}
      {tabs.map((tab) => (
        <Text key={tab.id} inverse={tab.id === active}>
          {' '}
          {tab.label}{' '}
        </Text>
      ))}
    </Text>
  )
}

function ConfigRows({
  rows,
  query,
  selectedIndex,
  searchFocused,
  maxRows,
  screenReader,
  width,
}: {
  rows: readonly ConfigRow[]
  query: string
  selectedIndex: number
  searchFocused: boolean
  maxRows: number
  screenReader: boolean
  width: number
}) {
  const bounded = Math.max(1, maxRows)
  const start = Math.max(
    0,
    Math.min(selectedIndex - bounded + 1, rows.length - bounded),
  )
  const visible = rows.slice(start, start + bounded)
  return (
    <>
      <Box borderStyle={screenReader ? undefined : 'round'} paddingX={1}>
        <Text inverse={searchFocused}>⌕ {query || 'Search settings…'}</Text>
      </Box>
      <Text> </Text>
      {start > 0 ? <Text> ↑ {start} more above</Text> : null}
      {visible.map((row, offset) => {
        const index = start + offset
        const selected = index === selectedIndex && !searchFocused
        const stacked = width < 60
        return (
          <Box
            key={row.definition.id}
            flexDirection={stacked ? 'column' : 'row'}
          >
            <Box width={stacked ? undefined : Math.min(46, width - 12)}>
              <Text inverse={!screenReader && selected}>
                {screenReader && selected
                  ? 'Selected: '
                  : selected
                    ? '❯ '
                    : '  '}
                {row.definition.label}
              </Text>
            </Box>
            <Text>{stacked ? `  ${row.displayValue}` : row.displayValue}</Text>
          </Box>
        )
      })}
      {start + visible.length < rows.length ? (
        <Text> ↓ {rows.length - start - visible.length} more below</Text>
      ) : null}
      <Text> </Text>
      <Text dimColor>
        {searchFocused
          ? 'Type to filter · Enter/↓ to select · ↑ to tabs · Esc to clear'
          : 'Enter/Space to change · / to search · Esc to close'}
      </Text>
    </>
  )
}

function StatusRows({ status }: { status: ConfigStatusData }) {
  const rows = [
    ['Version', status.version],
    ['Session name', status.sessionName ?? '/rename to add a name'],
    ['Session ID', status.sessionId],
    ['cwd', status.cwd],
    ...(status.authSource ? [['Auth token', status.authSource]] : []),
    ...(status.baseUrl ? [['Provider base URL', status.baseUrl]] : []),
    ['Model', status.model],
    ['Setting sources', status.settingSources.join(', ')],
  ]
  return (
    <>
      {rows.map(([label, value]) => (
        <Box key={label}>
          <Box width={22}>
            <Text>{label}:</Text>
          </Box>
          <Text>{value}</Text>
        </Box>
      ))}
      <Text> </Text>
      <Text dimColor>Esc to cancel</Text>
    </>
  )
}

function UsageRows({ usage }: { usage: ConfigUsageData }) {
  const seconds = (milliseconds: number) =>
    `${Math.round(milliseconds / 1_000)}s`
  return (
    <>
      <Text bold>Session</Text>
      <Text> </Text>
      <Text>Total cost: ${usage.costUsd.toFixed(4)}</Text>
      <Text>Total duration (API): {seconds(usage.apiDurationMs)}</Text>
      <Text>Total duration (wall): {seconds(usage.wallDurationMs)}</Text>
      <Text>
        Total code changes: {usage.linesAdded} lines added, {usage.linesRemoved}{' '}
        lines removed
      </Text>
      <Text>
        Usage: {usage.usage.inputTokens} input, {usage.usage.outputTokens}{' '}
        output, {usage.usage.cacheReadInputTokens ?? 0} cache read,{' '}
        {usage.usage.cacheCreationInputTokens ?? 0} cache write
      </Text>
      <Text> </Text>
      <Text dimColor>Esc to cancel</Text>
    </>
  )
}

function ValueRows({ rows }: { rows: readonly ConfigDashboardValueRow[] }) {
  return rows.map((row) => (
    <Box key={row.label}>
      <Box width={28}>
        <Text>{row.label}:</Text>
      </Box>
      <Text>{row.value}</Text>
    </Box>
  ))
}

export function ConfigDashboard({
  tab,
  snapshot,
  query = '',
  selectedIndex = 0,
  searchFocused = true,
  status,
  usage,
  settings,
  stats,
  effectiveValues,
  width,
  screenReader,
  maxRows = 18,
}: {
  tab: ConfigDashboardTab
  snapshot: ConfigSettingsSnapshot
  query?: string
  selectedIndex?: number
  searchFocused?: boolean
  status?: ConfigStatusData
  usage?: ConfigUsageData
  settings?: readonly ConfigDashboardValueRow[]
  stats?: readonly ConfigDashboardValueRow[]
  effectiveValues?: ConfigEffectiveValues
  width: number
  screenReader: boolean
  maxRows?: number
}) {
  const rows = projectConfigRows(snapshot, query, effectiveValues)
  let content: React.ReactNode
  switch (tab) {
    case 'settings':
      if (settings === undefined)
        throw new Error('Settings tab requires measured settings data')
      content = <ValueRows rows={settings} />
      break
    case 'status':
      if (status === undefined)
        throw new Error('Status tab requires measured status data')
      content = <StatusRows status={status} />
      break
    case 'config':
      content = (
        <ConfigRows
          rows={rows}
          query={query}
          selectedIndex={Math.max(0, Math.min(selectedIndex, rows.length - 1))}
          searchFocused={searchFocused}
          maxRows={maxRows}
          screenReader={screenReader}
          width={width}
        />
      )
      break
    case 'usage':
      if (usage === undefined)
        throw new Error('Usage tab requires measured usage data')
      content = <UsageRows usage={usage} />
      break
    case 'stats':
      if (stats === undefined)
        throw new Error('Stats tab requires measured stats data')
      content =
        stats.length === 0 ? (
          <Text>No stats available yet. Start using Praxis Code!</Text>
        ) : (
          <ValueRows rows={stats} />
        )
      break
  }
  return (
    <Box flexDirection="column" width={Math.min(100, width)}>
      {!screenReader ? <Text>{'─'.repeat(Math.min(100, width))}</Text> : null}
      <DashboardTabs active={tab} screenReader={screenReader} />
      <Text> </Text>
      {content}
    </Box>
  )
}
