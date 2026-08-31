import type { FsWriteRestrictionConfig } from '@anthropic-ai/sandbox-runtime'
import { describe, expect, it, vi } from 'vitest'

import {
  ClaudeSandboxRuntime,
  type SandboxBackend,
} from './claude-sandbox-runtime.js'
import type { ClaudeSandboxSettings } from './claude-sandbox-settings.js'

function settings(
  overrides: Partial<ClaudeSandboxSettings> = {},
): ClaudeSandboxSettings {
  return {
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
    ...overrides,
  }
}

function backend(overrides: Partial<SandboxBackend> = {}) {
  const fsWrite: FsWriteRestrictionConfig = {
    allowOnly: ['/workspace'],
    denyWithinAllow: ['/workspace/.claude'],
  }
  return {
    initialize: vi.fn(async () => undefined),
    isSupportedPlatform: vi.fn(() => true),
    checkDependencies: vi.fn(() => ({ warnings: [], errors: [] })),
    wrapWithSandbox: vi.fn(async (command: string) => `sandbox:${command}`),
    getFsWriteConfig: vi.fn(() => fsWrite),
    updateConfig: vi.fn(),
    cleanupAfterCommand: vi.fn(),
    annotateStderrWithSandboxFailures: vi.fn(
      (_commandId: string, stderr: string) => stderr,
    ),
    reset: vi.fn(async () => undefined),
    ...overrides,
  } satisfies SandboxBackend
}

describe('ClaudeSandboxRuntime', () => {
  it('initializes the official runtime only when settings and platform allow it', async () => {
    const base = backend()
    const runtime = new ClaudeSandboxRuntime(base, () => 'macos')
    await runtime.initialize(settings({ enabledPlatforms: ['macos'] }))

    expect(runtime.isActive()).toBe(true)
    expect(runtime.platformName()).toBe('macos')
    expect(base.initialize).toHaveBeenCalledOnce()
    await expect(
      runtime.wrapCommand(
        { command: 'npm test', executionCommand: 'instrumented npm test' },
        { shell: '/bin/zsh', commandId: 'tool-1' },
      ),
    ).resolves.toBe('sandbox:instrumented npm test')
    expect(base.wrapWithSandbox).toHaveBeenCalledWith(
      'instrumented npm test',
      '/bin/zsh',
      undefined,
      undefined,
      { commandId: 'tool-1', commandText: 'npm test' },
    )
    expect(runtime.getFsWriteConfig()).toEqual({
      allowOnly: ['/workspace'],
      denyWithinAllow: ['/workspace/.claude'],
    })
  })

  it('stays inactive when disabled or excluded by enabledPlatforms', async () => {
    const base = backend()
    const runtime = new ClaudeSandboxRuntime(base, () => 'linux')
    await runtime.initialize(
      settings({ enabledPlatforms: ['macos'], failIfUnavailable: false }),
    )

    expect(runtime.isActive()).toBe(false)
    expect(runtime.unavailableReason()).toContain(
      'linux is not in sandbox.enabledPlatforms',
    )
    expect(base.initialize).not.toHaveBeenCalled()
    expect(runtime.getFsWriteConfig()).toBeUndefined()
  })

  it('fails closed when sandbox is required but unavailable', async () => {
    const runtime = new ClaudeSandboxRuntime(
      backend({
        checkDependencies: vi.fn(() => ({
          warnings: [],
          errors: ['missing bubblewrap'],
        })),
      }),
      () => 'linux',
    )

    await expect(
      runtime.initialize(settings({ failIfUnavailable: true })),
    ).rejects.toThrow('dependencies are missing: missing bubblewrap')
  })

  it('surfaces a non-fatal runtime initialization failure', async () => {
    const runtime = new ClaudeSandboxRuntime(
      backend({
        initialize: vi.fn(async () => {
          throw new Error('seatbelt startup failed')
        }),
      }),
      () => 'macos',
    )

    await runtime.initialize(settings())
    expect(runtime.isActive()).toBe(false)
    expect(runtime.unavailableReason()).toContain(
      'initialization failed: seatbelt startup failed',
    )
  })

  it('honors explicit overrides only when unsandboxed commands are allowed', async () => {
    const runtime = new ClaudeSandboxRuntime(backend(), () => 'macos')
    await runtime.initialize(settings({ allowUnsandboxedCommands: true }))
    expect(
      runtime.shouldUseSandbox({
        command: 'npm test',
        dangerouslyDisableSandbox: true,
      }),
    ).toBe(false)

    await runtime.initialize(settings({ allowUnsandboxedCommands: false }))
    expect(
      runtime.shouldUseSandbox({
        command: 'npm test',
        dangerouslyDisableSandbox: true,
      }),
    ).toBe(true)
  })

  it('matches excluded commands across compound commands, env, and wrappers', async () => {
    const runtime = new ClaudeSandboxRuntime(backend(), () => 'macos')
    await runtime.initialize(
      settings({ excludedCommands: ['bazel:*', 'docker ps'] }),
    )

    expect(
      runtime.shouldUseSandbox({ command: 'echo ready && FOO=bar bazel test' }),
    ).toBe(false)
    expect(runtime.shouldUseSandbox({ command: 'timeout 30 docker ps' })).toBe(
      false,
    )
    expect(runtime.shouldUseSandbox({ command: 'npm test' })).toBe(true)
  })

  it('annotates violations, cleans up, and resets runtime state', async () => {
    const base = backend({
      annotateStderrWithSandboxFailures: vi.fn(
        (commandId, stderr) => `${stderr}\nviolation:${commandId}`,
      ),
    })
    const runtime = new ClaudeSandboxRuntime(base, () => 'macos')
    await runtime.initialize(settings())

    expect(runtime.annotateStderr('tool-2', 'denied')).toBe(
      'denied\nviolation:tool-2',
    )
    runtime.cleanupAfterCommand()
    expect(base.cleanupAfterCommand).toHaveBeenCalledOnce()
    await runtime.reset()
    expect(runtime.isActive()).toBe(false)
    expect(base.reset).toHaveBeenCalledOnce()
  })
})
