import { describe, expect, it } from 'vitest'

import type { ClaudeJsonResource } from '../compatibility/claude/shared-resources.js'
import {
  claudeSandboxTempDirectory,
  loadClaudeSandboxSettings,
} from './claude-sandbox-settings.js'

const cwd = '/workspace/project'
const configRoot = '/home/test/.claude'
const homeDirectory = '/home/test'
const tempDirectory = '/tmp/claude'

function resource(
  scope: ClaudeJsonResource['scope'],
  value: unknown,
): ClaudeJsonResource {
  const path =
    scope === 'user'
      ? `${configRoot}/settings.json`
      : `${cwd}/.claude/${scope === 'local' ? 'settings.local.json' : 'settings.json'}`
  return { path, scope, value }
}

function load(resources: readonly ClaudeJsonResource[]) {
  return loadClaudeSandboxSettings({
    resources,
    cwd,
    configRoot,
    dataPlane: 'claude',
    homeDirectory,
    tempDirectory,
  })
}

describe('loadClaudeSandboxSettings', () => {
  it('uses the Claude per-user temporary directory convention', () => {
    expect(
      claudeSandboxTempDirectory(
        { CLAUDE_CODE_TMPDIR: '/custom/tmp' },
        'darwin',
      ),
    ).toBe(`/custom/tmp/claude-${process.getuid?.() ?? 0}`)
  })

  it('uses local scalar priority and concatenates array settings once', () => {
    const settings = load([
      resource('user', {
        sandbox: {
          enabled: true,
          failIfUnavailable: true,
          excludedCommands: ['docker:*', 'bazel:*'],
          network: { allowedDomains: ['user.example'] },
        },
      }),
      resource('project', {
        sandbox: {
          autoAllowBashIfSandboxed: false,
          excludedCommands: ['bazel:*', 'swift:*'],
          network: { allowedDomains: ['project.example'] },
        },
      }),
      resource('local', {
        sandbox: {
          enabled: false,
          allowUnsandboxedCommands: false,
          enabledPlatforms: ['macos'],
        },
      }),
    ])

    expect(settings).toMatchObject({
      enabled: false,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: false,
      allowUnsandboxedCommands: false,
      enabledPlatforms: ['macos'],
      excludedCommands: ['docker:*', 'bazel:*', 'swift:*'],
      runtimeConfig: {
        network: {
          allowedDomains: ['user.example', 'project.example'],
        },
      },
    })
  })

  it('preserves permission-rule path semantics per settings source', () => {
    const settings = load([
      resource('user', {
        permissions: {
          allow: ['Edit(/cache/**)', 'WebFetch(domain:api.example.com)'],
          deny: [
            'Edit(//etc/locked/**)',
            'Read(/secrets/**)',
            'WebFetch(domain:blocked.example.com)',
          ],
        },
      }),
      resource('project', {
        permissions: {
          allow: ['Edit(/generated/**)'],
          deny: ['Read(//private/**)'],
        },
      }),
    ])

    expect(settings.runtimeConfig.filesystem).toMatchObject({
      allowWrite: [
        '.',
        tempDirectory,
        `${configRoot}/cache/**`,
        `${cwd}/generated/**`,
      ],
      denyWrite: expect.arrayContaining(['/etc/locked/**']),
      denyRead: [`${configRoot}/secrets/**`, '/private/**'],
    })
    expect(settings.runtimeConfig.network).toMatchObject({
      allowedDomains: ['api.example.com'],
      deniedDomains: ['blocked.example.com'],
    })
  })

  it('uses standard absolute and settings-root-relative sandbox paths', () => {
    const settings = load([
      resource('project', {
        sandbox: {
          filesystem: {
            allowWrite: ['/opt/cache', './output', '~/shared'],
            denyWrite: ['//legacy/absolute'],
            denyRead: ['relative-secret'],
            allowRead: ['/public'],
          },
        },
      }),
    ])

    expect(settings.runtimeConfig.filesystem).toMatchObject({
      allowWrite: [
        '.',
        tempDirectory,
        '/opt/cache',
        `${cwd}/output`,
        `${homeDirectory}/shared`,
      ],
      denyWrite: expect.arrayContaining(['/legacy/absolute']),
      denyRead: [`${cwd}/relative-secret`],
      allowRead: ['/public'],
    })
  })

  it('protects settings and executable Claude extension directories', () => {
    const settings = load([])
    expect(settings.runtimeConfig.filesystem.denyWrite).toEqual([
      `${configRoot}/settings.json`,
      `${configRoot}/commands`,
      `${configRoot}/agents`,
      `${configRoot}/skills`,
      `${cwd}/.claude/settings.json`,
      `${cwd}/.claude/settings.local.json`,
      `${cwd}/.claude/commands`,
      `${cwd}/.claude/agents`,
      `${cwd}/.claude/skills`,
    ])
  })

  it('protects native global and project Praxis customizations', () => {
    const nativeRoot = '/home/test/.praxis'
    const settings = loadClaudeSandboxSettings({
      resources: [],
      cwd,
      configRoot: nativeRoot,
      dataPlane: 'native',
      homeDirectory,
      tempDirectory,
    })
    expect(settings.runtimeConfig.filesystem.denyWrite).toEqual([
      `${nativeRoot}/settings.json`,
      `${nativeRoot}/commands`,
      `${nativeRoot}/agents`,
      `${nativeRoot}/skills`,
      `${cwd}/.praxis/settings.json`,
      `${cwd}/.praxis/settings.local.json`,
      `${cwd}/.praxis/commands`,
      `${cwd}/.praxis/agents`,
      `${cwd}/.praxis/skills`,
    ])
  })

  it('keeps the initial and current project control paths protected after cd', () => {
    const settings = loadClaudeSandboxSettings({
      resources: [],
      cwd: '/workspace/next',
      originalCwd: cwd,
      configRoot,
      dataPlane: 'claude',
      homeDirectory,
      tempDirectory,
    })
    expect(settings.runtimeConfig.filesystem.denyWrite).toEqual(
      expect.arrayContaining([
        `${cwd}/.claude/settings.local.json`,
        `${cwd}/.claude/skills`,
        '/workspace/next/.claude/settings.local.json',
        '/workspace/next/.claude/skills',
      ]),
    )
  })

  it('adds shared permission directories to the sandbox write roots', () => {
    const settings = load([
      resource('user', {
        permissions: {
          additionalDirectories: ['/shared', './generated'],
        },
      }),
    ])
    expect(settings.runtimeConfig.filesystem.allowWrite).toEqual(
      expect.arrayContaining(['/shared', `${cwd}/generated`]),
    )
  })

  it('rejects malformed sandbox settings instead of silently weakening them', () => {
    expect(() =>
      load([
        resource('local', {
          sandbox: { enabled: 'yes', filesystem: { denyRead: true } },
        }),
      ]),
    ).toThrow('sandbox.enabled must be a boolean')
  })
})
