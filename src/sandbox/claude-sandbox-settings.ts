import { dirname, isAbsolute, resolve, sep } from 'node:path'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'

import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'

import type { ClaudeJsonResource } from '../compatibility/claude/shared-resources.js'
import { permissionRuleValueFromString } from '../permissions/permission-updates.js'
import type { DataPlane } from '../persistence/data-plane.js'

export interface ClaudeSandboxSettings {
  enabled: boolean
  failIfUnavailable: boolean
  autoAllowBashIfSandboxed: boolean
  allowUnsandboxedCommands: boolean
  enabledPlatforms?: readonly ('macos' | 'linux' | 'windows' | 'wsl')[]
  excludedCommands: readonly string[]
  bareGitRepoScrubPaths?: readonly string[]
  runtimeConfig: SandboxRuntimeConfig
}

export function claudeSandboxTempDirectory(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const base =
    environment.CLAUDE_CODE_TMPDIR || (platform === 'win32' ? tmpdir() : '/tmp')
  let canonicalBase = base
  try {
    canonicalBase = realpathSync(base)
  } catch {
    // Preserve the configured path when it does not exist yet.
  }
  const name =
    platform === 'win32' ? 'claude' : `claude-${process.getuid?.() ?? 0}`
  return resolve(canonicalBase, name)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function booleanField(
  value: Record<string, unknown>,
  key: string,
  fallback: boolean,
  path: string,
): boolean {
  const field = value[key]
  if (field === undefined) return fallback
  if (typeof field !== 'boolean')
    throw new Error(`sandbox.${key} must be a boolean: ${path}`)
  return field
}

function stringArray(
  value: Record<string, unknown>,
  key: string,
  path: string,
): string[] {
  const field = value[key]
  if (field === undefined) return []
  if (!Array.isArray(field) || field.some((item) => typeof item !== 'string'))
    throw new Error(`sandbox.${key} must be an array of strings: ${path}`)
  return field
}

function appendUnique(target: string[], values: readonly string[]): void {
  for (const value of values) if (!target.includes(value)) target.push(value)
}

function resourceRoot(resource: ClaudeJsonResource): string {
  return resource.scope === 'user'
    ? dirname(resource.path)
    : resolve(dirname(resource.path), '..')
}

function permissionPath(pattern: string, resource: ClaudeJsonResource): string {
  if (pattern.startsWith('//')) return pattern.slice(1)
  if (pattern.startsWith('/') && !pattern.startsWith('//')) {
    return resolve(resourceRoot(resource), pattern.slice(1))
  }
  return pattern
}

function filesystemPath(
  pattern: string,
  resource: ClaudeJsonResource,
  homeDirectory: string,
): string {
  if (pattern.startsWith('//')) return pattern.slice(1)
  if (pattern === '~' || pattern.startsWith('~/')) {
    return resolve(homeDirectory, pattern.slice(2))
  }
  return isAbsolute(pattern)
    ? resolve(pattern)
    : resolve(resourceRoot(resource), pattern)
}

function additionalDirectoryPath(
  path: string,
  cwd: string,
  homeDirectory: string,
): string {
  if (path === '~' || path.startsWith('~/'))
    return resolve(homeDirectory, path.slice(2))
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path)
}

function nestedRecord(
  value: Record<string, unknown>,
  key: string,
  path: string,
): Record<string, unknown> | undefined {
  const field = value[key]
  if (field === undefined) return undefined
  if (!isRecord(field))
    throw new Error(`sandbox.${key} must be an object: ${path}`)
  return field
}

function worktreeMainRepository(cwd: string): string | undefined {
  try {
    const match = /^gitdir:\s*(.+)$/mu.exec(
      readFileSync(resolve(cwd, '.git'), 'utf8'),
    )
    if (!match?.[1]) return undefined
    const gitDirectory = resolve(cwd, match[1].trim())
    const marker = `${sep}.git${sep}worktrees${sep}`
    const markerIndex = gitDirectory.lastIndexOf(marker)
    return markerIndex > 0 ? gitDirectory.slice(0, markerIndex) : undefined
  } catch {
    return undefined
  }
}

export function loadClaudeSandboxSettings({
  resources,
  cwd,
  originalCwd = cwd,
  configRoot,
  dataPlane,
  homeDirectory,
  additionalDirectories = [],
  tempDirectory,
}: {
  resources: readonly ClaudeJsonResource[]
  cwd: string
  originalCwd?: string
  configRoot: string
  dataPlane: DataPlane
  homeDirectory: string
  additionalDirectories?: readonly string[]
  tempDirectory: string
}): ClaudeSandboxSettings {
  let enabled = false
  let failIfUnavailable = false
  let autoAllowBashIfSandboxed = true
  let allowUnsandboxedCommands = true
  let enabledPlatforms:
    readonly ('macos' | 'linux' | 'windows' | 'wsl')[] | undefined
  const excludedCommands: string[] = []
  const allowedDomains: string[] = []
  const deniedDomains: string[] = []
  const allowWrite = ['.', tempDirectory, ...additionalDirectories]
  const protectedDirectories = [
    ...new Set([resolve(originalCwd), resolve(cwd)]),
  ]
  const projectConfigDirectory = dataPlane === 'native' ? '.praxis' : '.claude'
  const denyWrite = [
    resolve(configRoot, 'settings.json'),
    resolve(configRoot, 'commands'),
    resolve(configRoot, 'agents'),
    resolve(configRoot, 'skills'),
  ]
  for (const directory of protectedDirectories) {
    denyWrite.push(
      resolve(directory, projectConfigDirectory, 'settings.json'),
      resolve(directory, projectConfigDirectory, 'settings.local.json'),
      resolve(directory, projectConfigDirectory, 'commands'),
      resolve(directory, projectConfigDirectory, 'agents'),
      resolve(directory, projectConfigDirectory, 'skills'),
    )
  }
  const denyRead: string[] = []
  const allowRead: string[] = []
  let allowUnixSockets: string[] | undefined
  let allowAllUnixSockets: boolean | undefined
  let allowLocalBinding: boolean | undefined
  let httpProxyPort: number | undefined
  let socksProxyPort: number | undefined
  let ignoreViolations: Record<string, string[]> | undefined
  let enableWeakerNestedSandbox: boolean | undefined
  let enableWeakerNetworkIsolation: boolean | undefined
  let ripgrep: { command: string; args?: string[] } | undefined
  const bareGitRepoScrubPaths: string[] = []

  const worktreeRepository = worktreeMainRepository(cwd)
  if (worktreeRepository && worktreeRepository !== resolve(cwd)) {
    appendUnique(allowWrite, [worktreeRepository])
  }
  for (const directory of protectedDirectories) {
    for (const name of ['HEAD', 'objects', 'refs', 'hooks', 'config']) {
      const path = resolve(directory, name)
      try {
        statSync(path)
        appendUnique(denyWrite, [path])
      } catch {
        bareGitRepoScrubPaths.push(path)
      }
    }
  }

  for (const resource of resources) {
    if (!isRecord(resource.value)) continue
    const permissions = isRecord(resource.value.permissions)
      ? resource.value.permissions
      : undefined
    if (permissions?.additionalDirectories !== undefined) {
      if (
        !Array.isArray(permissions.additionalDirectories) ||
        permissions.additionalDirectories.some(
          (directory) => typeof directory !== 'string',
        )
      ) {
        throw new Error(
          `permissions.additionalDirectories must be an array of strings: ${resource.path}`,
        )
      }
      appendUnique(
        allowWrite,
        (permissions.additionalDirectories as string[]).map((directory) =>
          additionalDirectoryPath(directory, cwd, homeDirectory),
        ),
      )
    }
    for (const behavior of ['allow', 'deny'] as const) {
      const rawRules = permissions?.[behavior]
      if (rawRules === undefined) continue
      if (
        !Array.isArray(rawRules) ||
        rawRules.some((rule) => typeof rule !== 'string')
      ) {
        throw new Error(
          `permissions.${behavior} must be an array of strings: ${resource.path}`,
        )
      }
      for (const rawRule of rawRules as string[]) {
        const rule = permissionRuleValueFromString(rawRule)
        if (
          rule.toolName === 'WebFetch' &&
          rule.ruleContent?.startsWith('domain:')
        ) {
          appendUnique(behavior === 'allow' ? allowedDomains : deniedDomains, [
            rule.ruleContent.slice('domain:'.length),
          ])
        }
        if (rule.toolName === 'Edit' && rule.ruleContent) {
          appendUnique(behavior === 'allow' ? allowWrite : denyWrite, [
            permissionPath(rule.ruleContent, resource),
          ])
        }
        if (
          behavior === 'deny' &&
          rule.toolName === 'Read' &&
          rule.ruleContent
        ) {
          appendUnique(denyRead, [permissionPath(rule.ruleContent, resource)])
        }
      }
    }

    const sandbox = resource.value.sandbox
    if (sandbox === undefined) continue
    if (!isRecord(sandbox))
      throw new Error(`sandbox must be an object: ${resource.path}`)
    enabled = booleanField(sandbox, 'enabled', enabled, resource.path)
    failIfUnavailable = booleanField(
      sandbox,
      'failIfUnavailable',
      failIfUnavailable,
      resource.path,
    )
    autoAllowBashIfSandboxed = booleanField(
      sandbox,
      'autoAllowBashIfSandboxed',
      autoAllowBashIfSandboxed,
      resource.path,
    )
    allowUnsandboxedCommands = booleanField(
      sandbox,
      'allowUnsandboxedCommands',
      allowUnsandboxedCommands,
      resource.path,
    )
    appendUnique(
      excludedCommands,
      stringArray(sandbox, 'excludedCommands', resource.path),
    )
    const platforms = sandbox.enabledPlatforms
    if (platforms !== undefined) {
      if (
        !Array.isArray(platforms) ||
        platforms.some(
          (platform) =>
            !['macos', 'linux', 'windows', 'wsl'].includes(String(platform)),
        )
      ) {
        throw new Error(
          `sandbox.enabledPlatforms contains an unsupported platform: ${resource.path}`,
        )
      }
      enabledPlatforms = platforms as ('macos' | 'linux' | 'windows' | 'wsl')[]
    }

    const network = nestedRecord(sandbox, 'network', resource.path)
    if (network) {
      appendUnique(
        allowedDomains,
        stringArray(network, 'allowedDomains', resource.path),
      )
      const unixSockets = stringArray(
        network,
        'allowUnixSockets',
        resource.path,
      )
      if (unixSockets.length > 0) {
        allowUnixSockets ??= []
        appendUnique(allowUnixSockets, unixSockets)
      }
      allowAllUnixSockets = booleanField(
        network,
        'allowAllUnixSockets',
        allowAllUnixSockets ?? false,
        resource.path,
      )
      allowLocalBinding = booleanField(
        network,
        'allowLocalBinding',
        allowLocalBinding ?? false,
        resource.path,
      )
      for (const key of ['httpProxyPort', 'socksProxyPort'] as const) {
        const value = network[key]
        if (value !== undefined && (typeof value !== 'number' || value <= 0)) {
          throw new Error(
            `sandbox.network.${key} must be a positive number: ${resource.path}`,
          )
        }
      }
      if (typeof network.httpProxyPort === 'number')
        httpProxyPort = network.httpProxyPort
      if (typeof network.socksProxyPort === 'number')
        socksProxyPort = network.socksProxyPort
    }

    const filesystem = nestedRecord(sandbox, 'filesystem', resource.path)
    if (filesystem) {
      for (const [key, target] of [
        ['allowWrite', allowWrite],
        ['denyWrite', denyWrite],
        ['denyRead', denyRead],
        ['allowRead', allowRead],
      ] as const) {
        appendUnique(
          target,
          stringArray(filesystem, key, resource.path).map((path) =>
            filesystemPath(path, resource, homeDirectory),
          ),
        )
      }
    }

    const ignored = sandbox.ignoreViolations
    if (ignored !== undefined) {
      if (!isRecord(ignored))
        throw new Error(
          `sandbox.ignoreViolations must be an object: ${resource.path}`,
        )
      ignoreViolations = { ...(ignoreViolations ?? {}) }
      for (const [command, values] of Object.entries(ignored)) {
        if (
          !Array.isArray(values) ||
          values.some((value) => typeof value !== 'string')
        ) {
          throw new Error(
            `sandbox.ignoreViolations.${command} must be an array of strings: ${resource.path}`,
          )
        }
        ignoreViolations[command] = [
          ...new Set([...(ignoreViolations[command] ?? []), ...values]),
        ]
      }
    }
    enableWeakerNestedSandbox = booleanField(
      sandbox,
      'enableWeakerNestedSandbox',
      enableWeakerNestedSandbox ?? false,
      resource.path,
    )
    enableWeakerNetworkIsolation = booleanField(
      sandbox,
      'enableWeakerNetworkIsolation',
      enableWeakerNetworkIsolation ?? false,
      resource.path,
    )
    const configuredRipgrep = nestedRecord(sandbox, 'ripgrep', resource.path)
    if (configuredRipgrep) {
      if (typeof configuredRipgrep.command !== 'string') {
        throw new Error(
          `sandbox.ripgrep.command must be a string: ${resource.path}`,
        )
      }
      const args = stringArray(configuredRipgrep, 'args', resource.path)
      ripgrep = {
        command: configuredRipgrep.command,
        ...(args.length > 0 ? { args } : {}),
      }
    }
  }

  return {
    enabled,
    failIfUnavailable,
    autoAllowBashIfSandboxed,
    allowUnsandboxedCommands,
    ...(enabledPlatforms ? { enabledPlatforms } : {}),
    excludedCommands,
    bareGitRepoScrubPaths,
    runtimeConfig: {
      network: {
        allowedDomains,
        deniedDomains,
        ...(allowUnixSockets ? { allowUnixSockets } : {}),
        ...(allowAllUnixSockets === undefined ? {} : { allowAllUnixSockets }),
        ...(allowLocalBinding === undefined ? {} : { allowLocalBinding }),
        ...(httpProxyPort === undefined ? {} : { httpProxyPort }),
        ...(socksProxyPort === undefined ? {} : { socksProxyPort }),
      },
      filesystem: { allowWrite, denyWrite, denyRead, allowRead },
      ...(ignoreViolations ? { ignoreViolations } : {}),
      ...(enableWeakerNestedSandbox === undefined
        ? {}
        : { enableWeakerNestedSandbox }),
      ...(enableWeakerNetworkIsolation === undefined
        ? {}
        : { enableWeakerNetworkIsolation }),
      ...(ripgrep ? { ripgrep } : {}),
    },
  }
}
