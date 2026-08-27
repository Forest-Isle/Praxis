import { readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

import type { SandboxDependencyCheck } from '@anthropic-ai/sandbox-runtime'

import type { JsonResource } from '../../core/resources.js'
import { writeFileAtomically } from '../../platform/atomic-write.js'
import { loadNativeSharedResources } from '../../persistence/native-resources.js'
import { claudeSandboxRuntime } from '../../sandbox/claude-sandbox-runtime.js'
import {
  nativeSandboxTempDirectory,
  loadClaudeSandboxSettings,
  type ClaudeSandboxSettings,
} from '../../sandbox/claude-sandbox-settings.js'

export type TuiSandboxMode = 'auto-allow' | 'regular' | 'disabled'
export type TuiSandboxTab = 'mode' | 'dependencies' | 'overrides' | 'config'

export interface TuiSandboxSnapshot {
  settings: ClaudeSandboxSettings
  dependencies: SandboxDependencyCheck
  supported: boolean
  platform: 'macos' | 'linux' | 'windows' | 'wsl'
  globPatternWarnings?: readonly string[]
  unavailableReason?: string
}

export interface TuiSandboxStore {
  load(): Promise<TuiSandboxSnapshot>
  setMode(mode: TuiSandboxMode): Promise<TuiSandboxSnapshot>
  setAllowUnsandboxedCommands(allow: boolean): Promise<TuiSandboxSnapshot>
  exclude(pattern: string): Promise<{
    pattern: string
    settingsPath: string
    snapshot: TuiSandboxSnapshot
  }>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readLocalSettings(
  path: string,
): Promise<Record<string, unknown>> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as unknown
    if (!isRecord(value)) throw new Error(`Settings must be an object: ${path}`)
    return value
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
}

async function updateLocalSandbox(
  path: string,
  update: (sandbox: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let source: string | undefined
    try {
      source = await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const settings = await readLocalSettings(path)
    const current = settings.sandbox
    if (current !== undefined && !isRecord(current)) {
      throw new Error(`sandbox must be an object: ${path}`)
    }
    const committed = await writeFileAtomically(
      path,
      `${JSON.stringify({ ...settings, sandbox: update(current ?? {}) }, null, 2)}\n`,
      {
        beforeCommit: async () => {
          try {
            return (await readFile(path, 'utf8')) === source
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT')
              return source === undefined
            throw error
          }
        },
      },
    )
    if (committed) return
  }
  throw new Error(`Settings changed concurrently: ${path}`)
}

export function linuxGlobPatternWarnings(
  resources: readonly JsonResource[],
  platform: 'macos' | 'linux' | 'windows' | 'wsl',
): string[] {
  if (platform !== 'linux' && platform !== 'wsl') return []
  const warnings: string[] = []
  for (const resource of resources) {
    if (!isRecord(resource.value) || !isRecord(resource.value.permissions))
      continue
    for (const behavior of ['allow', 'deny'] as const) {
      const rules = resource.value.permissions[behavior]
      if (!Array.isArray(rules)) continue
      for (const rule of rules) {
        if (typeof rule !== 'string') continue
        const match = /^(?:Edit|Read)\((.*)\)$/u.exec(rule)
        const pattern = match?.[1]?.replace(/\/\*\*$/u, '')
        if (pattern && /[*?[\]]/u.test(pattern)) warnings.push(rule)
      }
    }
  }
  return [...new Set(warnings)]
}

export function createTuiSandboxStore({
  configRoot,
  cwd,
  homeDirectory,
  additionalDirectories = [],
  environment = process.env,
}: {
  configRoot: string
  cwd: string
  homeDirectory: string
  additionalDirectories?: readonly string[]
  environment?: NodeJS.ProcessEnv
}): TuiSandboxStore {
  const localSettingsPath = join(cwd, '.praxis', 'settings.local.json')

  const load = async (): Promise<TuiSandboxSnapshot> => {
    const resources = (
      await loadNativeSharedResources({ root: configRoot, cwd })
    ).settings
    const settings = loadClaudeSandboxSettings({
      resources,
      cwd,
      configRoot,
      homeDirectory,
      additionalDirectories,
      tempDirectory: nativeSandboxTempDirectory(environment),
    })
    await claudeSandboxRuntime.initialize(settings)
    const unavailableReason = claudeSandboxRuntime.unavailableReason(settings)
    const platform = claudeSandboxRuntime.platformName()
    return {
      settings,
      dependencies: claudeSandboxRuntime.dependencyCheck(settings),
      supported: claudeSandboxRuntime.isSupportedPlatform(),
      platform,
      globPatternWarnings: linuxGlobPatternWarnings(resources, platform),
      ...(unavailableReason ? { unavailableReason } : {}),
    }
  }

  return {
    load,
    async setMode(mode) {
      await updateLocalSandbox(localSettingsPath, (sandbox) => ({
        ...sandbox,
        enabled: mode !== 'disabled',
        autoAllowBashIfSandboxed: mode === 'auto-allow',
      }))
      return load()
    },
    async setAllowUnsandboxedCommands(allow) {
      await updateLocalSandbox(localSettingsPath, (sandbox) => ({
        ...sandbox,
        allowUnsandboxedCommands: allow,
      }))
      return load()
    },
    async exclude(pattern) {
      const cleanPattern = pattern.trim().replace(/^["']|["']$/gu, '')
      if (!cleanPattern) {
        throw new Error('Please provide a command pattern to exclude')
      }
      await updateLocalSandbox(localSettingsPath, (sandbox) => {
        const excluded = sandbox.excludedCommands
        if (
          excluded !== undefined &&
          (!Array.isArray(excluded) ||
            excluded.some((value) => typeof value !== 'string'))
        ) {
          throw new Error(
            `sandbox.excludedCommands must be an array of strings: ${localSettingsPath}`,
          )
        }
        return {
          ...sandbox,
          excludedCommands: [
            ...new Set([...(excluded ?? []), cleanPattern] as string[]),
          ],
        }
      })
      return {
        pattern: cleanPattern,
        settingsPath: relative(cwd, localSettingsPath),
        snapshot: await load(),
      }
    },
  }
}
