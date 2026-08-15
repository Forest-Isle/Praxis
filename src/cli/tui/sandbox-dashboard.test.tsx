import { cleanup, render } from 'ink-testing-library'
import { afterEach, describe, expect, it } from 'vitest'

import type { TuiSandboxSnapshot } from './sandbox-settings.js'
import { SandboxDashboard } from './sandbox-dashboard.js'

afterEach(() => cleanup())

function snapshot(
  overrides: Partial<TuiSandboxSnapshot> = {},
): TuiSandboxSnapshot {
  return {
    settings: {
      enabled: true,
      failIfUnavailable: false,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: true,
      excludedCommands: [],
      runtimeConfig: {
        network: { allowedDomains: [], deniedDomains: [] },
        filesystem: {
          allowWrite: ['.'],
          denyWrite: [],
          denyRead: [],
          allowRead: [],
        },
      },
    },
    dependencies: { errors: [], warnings: [] },
    supported: true,
    platform: 'macos',
    ...overrides,
  }
}

describe('SandboxDashboard', () => {
  it('renders macOS and Linux dependency names without crossing platforms', () => {
    const mac = render(
      <SandboxDashboard
        snapshot={snapshot()}
        tab="dependencies"
        selectedIndex={0}
        width={100}
        screenReader={false}
      />,
    ).lastFrame()
    expect(mac).toContain('seatbelt: built-in (macOS)')
    expect(mac).not.toContain('bubblewrap')

    const linux = render(
      <SandboxDashboard
        snapshot={snapshot({
          platform: 'linux',
          dependencies: {
            errors: ['missing bwrap', 'missing socat'],
            warnings: ['seccomp unavailable'],
          },
        })}
        tab="dependencies"
        selectedIndex={0}
        width={100}
        screenReader={false}
      />,
    ).lastFrame()
    expect(linux).toContain('bubblewrap (bwrap): not installed')
    expect(linux).toContain('socat: not installed')
    expect(linux).toContain('seccomp filter: not installed')
    expect(linux).not.toContain('seatbelt')
  })

  it('shows Linux glob compatibility warnings in the config tab', () => {
    const frame = render(
      <SandboxDashboard
        snapshot={snapshot({
          platform: 'linux',
          globPatternWarnings: ['Read(/secrets/*.json)'],
        })}
        tab="config"
        selectedIndex={0}
        width={100}
        screenReader={false}
      />,
    ).lastFrame()
    expect(frame).toContain('Glob patterns not fully supported on Linux')
    expect(frame).toContain('Read(/secrets/*.json)')
  })
})
