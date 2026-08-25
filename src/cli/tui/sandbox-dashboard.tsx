import { Box, Text } from 'ink'

import type { TuiSandboxSurfaceModel } from './sandbox-surface-model.js'
import type { TuiSandboxSnapshot, TuiSandboxTab } from './sandbox-settings.js'

const TABS: Readonly<Record<TuiSandboxTab, string>> = {
  mode: 'Mode',
  dependencies: 'Dependencies',
  overrides: 'Overrides',
  config: 'Config',
}

export function tuiSandboxTabs(
  snapshot: TuiSandboxSnapshot,
): readonly TuiSandboxTab[] {
  if (snapshot.dependencies.errors.length > 0) return ['dependencies']
  return [
    'mode',
    ...(snapshot.dependencies.warnings.length > 0
      ? (['dependencies'] as const)
      : []),
    'overrides',
    'config',
  ]
}

function prefix(selected: boolean, screenReader: boolean): string {
  if (screenReader) return selected ? 'Selected: ' : ''
  return selected ? '❯ ' : '  '
}

export function SandboxDashboard({
  surface,
  width,
  screenReader,
}: {
  surface: TuiSandboxSurfaceModel
  width: number
  screenReader: boolean
}) {
  const { snapshot, tab, selectedIndex } = surface
  const tabs = tuiSandboxTabs(snapshot)
  const mode = !snapshot.settings.enabled
    ? 'disabled'
    : snapshot.settings.autoAllowBashIfSandboxed
      ? 'auto-allow'
      : 'regular'
  const modeRows = [
    {
      value: 'auto-allow',
      label: 'Sandbox BashTool, with auto-allow',
    },
    {
      value: 'regular',
      label: 'Sandbox BashTool, with regular permissions',
    },
    { value: 'disabled', label: 'No Sandbox' },
  ] as const
  const overrideRows = [
    {
      value: true,
      label: 'Allow unsandboxed fallback',
    },
    {
      value: false,
      label: 'Strict sandbox mode',
    },
  ] as const
  const filesystem = snapshot.settings.runtimeConfig.filesystem
  const network = snapshot.settings.runtimeConfig.network

  return (
    <Box flexDirection="column" width={Math.min(100, width)}>
      {!screenReader ? (
        <Text dimColor>{'─'.repeat(Math.min(100, width))}</Text>
      ) : null}
      <Text bold> Sandbox:</Text>
      <Text>
        {'  '}
        {tabs.map((candidate) => (
          <Text key={candidate} inverse={!screenReader && candidate === tab}>
            {screenReader && candidate === tab ? 'Current tab: ' : ' '}
            {TABS[candidate]}{' '}
          </Text>
        ))}
      </Text>
      <Text> </Text>
      {tab === 'mode' ? (
        <>
          <Text bold> Configure Mode:</Text>
          <Text> </Text>
          {modeRows.map((row, index) => (
            <Text
              key={row.value}
              inverse={!screenReader && selectedIndex === index}
            >
              {prefix(selectedIndex === index, screenReader)}
              {index + 1}. {row.label}
              {row.value === mode ? ' (current)' : ''}
            </Text>
          ))}
          <Text> </Text>
          <Text dimColor>
            Auto-allow mode runs Bash in the sandbox automatically. Explicit ask
            and deny rules are always respected.
          </Text>
        </>
      ) : tab === 'dependencies' ? (
        <Box flexDirection="column">
          {snapshot.platform === 'macos' ? (
            <Text>
              seatbelt: <Text color="green">built-in (macOS)</Text>
            </Text>
          ) : (
            <>
              <Text>
                bubblewrap (bwrap):{' '}
                <Text
                  color={
                    snapshot.dependencies.errors.some((error) =>
                      error.includes('bwrap'),
                    )
                      ? 'red'
                      : 'green'
                  }
                >
                  {snapshot.dependencies.errors.some((error) =>
                    error.includes('bwrap'),
                  )
                    ? 'not installed'
                    : 'installed'}
                </Text>
              </Text>
              <Text>
                socat:{' '}
                <Text
                  color={
                    snapshot.dependencies.errors.some((error) =>
                      error.includes('socat'),
                    )
                      ? 'red'
                      : 'green'
                  }
                >
                  {snapshot.dependencies.errors.some((error) =>
                    error.includes('socat'),
                  )
                    ? 'not installed'
                    : 'installed'}
                </Text>
              </Text>
              <Text>
                seccomp filter:{' '}
                <Text
                  color={
                    snapshot.dependencies.warnings.length > 0
                      ? 'yellow'
                      : 'green'
                  }
                >
                  {snapshot.dependencies.warnings.length > 0
                    ? 'not installed'
                    : 'installed'}
                </Text>
              </Text>
            </>
          )}
          <Text>
            ripgrep (rg):{' '}
            <Text
              color={
                snapshot.dependencies.errors.some((error) =>
                  error.includes('ripgrep'),
                )
                  ? 'red'
                  : 'green'
              }
            >
              {snapshot.dependencies.errors.some((error) =>
                error.includes('ripgrep'),
              )
                ? 'not found'
                : 'found'}
            </Text>
          </Text>
          {snapshot.dependencies.errors.map((error) => (
            <Text key={error} color="red">
              {error}
            </Text>
          ))}
          {snapshot.dependencies.warnings.map((warning) => (
            <Text key={warning} color="yellow">
              {warning}
            </Text>
          ))}
          {snapshot.unavailableReason ? (
            <Text color="red">{snapshot.unavailableReason}</Text>
          ) : null}
        </Box>
      ) : tab === 'overrides' ? (
        <>
          {!snapshot.settings.enabled ? (
            <Text dimColor>Sandbox is not enabled</Text>
          ) : (
            overrideRows.map((row, index) => (
              <Text
                key={String(row.value)}
                inverse={!screenReader && selectedIndex === index}
              >
                {prefix(selectedIndex === index, screenReader)}
                {index + 1}. {row.label}
                {row.value === snapshot.settings.allowUnsandboxedCommands
                  ? ' (current)'
                  : ''}
              </Text>
            ))
          )}
          <Text> </Text>
          <Text dimColor>
            Closed mode ignores dangerouslyDisableSandbox and requires commands
            to remain sandboxed.
          </Text>
        </>
      ) : !snapshot.settings.enabled ? (
        <Text dimColor>Sandbox is not enabled</Text>
      ) : (
        <Box flexDirection="column">
          <Text bold>Excluded Commands:</Text>
          <Text dimColor>
            {snapshot.settings.excludedCommands.join(', ') || 'None'}
          </Text>
          <Text bold>Filesystem Read Restrictions:</Text>
          <Text dimColor>
            Denied: {filesystem?.denyRead?.join(', ') || 'None'}
          </Text>
          <Text dimColor>
            Allowed within denied: {filesystem?.allowRead?.join(', ') || 'None'}
          </Text>
          <Text bold>Filesystem Write Restrictions:</Text>
          <Text dimColor>
            Allowed: {filesystem?.allowWrite?.join(', ') || 'None'}
          </Text>
          <Text dimColor>
            Denied within allowed: {filesystem?.denyWrite?.join(', ') || 'None'}
          </Text>
          <Text bold>Network Restrictions:</Text>
          <Text dimColor>
            Allowed: {network?.allowedDomains?.join(', ') || 'None'}
          </Text>
          <Text dimColor>
            Denied: {network?.deniedDomains?.join(', ') || 'None'}
          </Text>
          <Text bold>Allowed Unix Sockets:</Text>
          <Text dimColor>
            {network?.allowUnixSockets?.join(', ') || 'None'}
          </Text>
          {(snapshot.globPatternWarnings?.length ?? 0) > 0 ? (
            <>
              <Text bold color="yellow">
                ⚠ Warning: Glob patterns not fully supported on Linux
              </Text>
              <Text dimColor>
                {snapshot.globPatternWarnings?.slice(0, 3).join(', ')}
              </Text>
            </>
          ) : null}
        </Box>
      )}
      <Text> </Text>
      <Text dimColor>
        {tab === 'mode' || (tab === 'overrides' && snapshot.settings.enabled)
          ? '↑/↓ navigate · Enter to select · ←/→ switch tabs · Esc to cancel'
          : '←/→ switch tabs · Esc to cancel'}
      </Text>
    </Box>
  )
}
