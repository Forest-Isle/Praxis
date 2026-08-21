import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'

import { writeFileAtomically } from '../../platform/atomic-write.js'
import { resolveDataPlaneRoot } from '../../persistence/data-plane.js'
import {
  ExclusiveFileLease,
  type ExclusiveFileLeaseHandle,
} from '../../platform/exclusive-file-lease.js'
import {
  DEFAULT_TUI_THEME_SETTINGS,
  TUI_THEMES,
  type TuiThemeSettings,
} from './theme.js'
import { loadTuiCustomThemes, type TuiCustomTheme } from './custom-themes.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function configRootPath(): string {
  return resolveDataPlaneRoot()
}

async function readSettings(path: string): Promise<{
  value: Record<string, unknown>
  fingerprint: string
}> {
  try {
    const source = await readFile(path, 'utf8')
    const value: unknown = JSON.parse(source)
    if (!isRecord(value))
      throw new Error(`JSON root must be an object: ${path}`)
    return { value, fingerprint: fingerprint(source) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { value: {}, fingerprint: fingerprint() }
    if (error instanceof SyntaxError)
      throw new Error(`Invalid JSON: ${path}`, { cause: error })
    throw error
  }
}

function fingerprint(source?: string): string {
  return source === undefined
    ? 'missing'
    : createHash('sha256').update(source).digest('hex')
}

async function fingerprintUnchanged(
  path: string,
  expected: string,
): Promise<boolean> {
  try {
    return fingerprint(await readFile(path, 'utf8')) === expected
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return expected === fingerprint()
    throw error
  }
}

function settingsFromRecord(
  value: Record<string, unknown>,
  customTheme?: TuiCustomTheme,
): TuiThemeSettings {
  const configuredTheme = value.theme
  const theme = TUI_THEMES.includes(
    configuredTheme as (typeof TUI_THEMES)[number],
  )
    ? (configuredTheme as (typeof TUI_THEMES)[number])
    : typeof configuredTheme === 'string' &&
        /^custom:[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(configuredTheme) &&
        customTheme?.slug === configuredTheme.slice('custom:'.length)
      ? (configuredTheme as `custom:${string}`)
      : DEFAULT_TUI_THEME_SETTINGS.theme
  return {
    theme,
    syntaxHighlightingDisabled:
      typeof value.syntaxHighlightingDisabled === 'boolean'
        ? value.syntaxHighlightingDisabled
        : DEFAULT_TUI_THEME_SETTINGS.syntaxHighlightingDisabled,
    ...(customTheme === undefined ? {} : { customTheme }),
  }
}

export function themeSettingsWithCustomTheme(
  settings: TuiThemeSettings,
  customThemes: readonly TuiCustomTheme[],
): TuiThemeSettings {
  if (!settings.theme.startsWith('custom:')) return settings
  const customTheme = customThemes.find(
    (theme) => `custom:${theme.slug}` === settings.theme,
  )
  return customTheme === undefined ? settings : { ...settings, customTheme }
}

export async function loadTuiThemeSettings(
  configRoot = configRootPath(),
): Promise<TuiThemeSettings> {
  const { value } = await readSettings(join(configRoot, 'settings.json'))
  const configured = value.theme
  const customSlug =
    typeof configured === 'string' && configured.startsWith('custom:')
      ? configured.slice('custom:'.length)
      : undefined
  const customTheme = customSlug
    ? (await loadTuiCustomThemes(configRoot)).find(
        (theme) => theme.slug === customSlug,
      )
    : undefined
  return settingsFromRecord(value, customTheme)
}

export async function saveTuiThemeSettings(
  update: Partial<TuiThemeSettings>,
  configRoot = configRootPath(),
  hooks: { afterValidation?: () => Promise<void> } = {},
): Promise<TuiThemeSettings> {
  const path = join(configRoot, 'settings.json')
  const lease = new ExclusiveFileLease(
    join(configRoot, '.praxis-settings.lock'),
  )
  let handle: ExclusiveFileLeaseHandle | null = null
  for (let attempt = 0; attempt < 400; attempt += 1) {
    handle = await lease.tryAcquire()
    if (handle) break
    await setTimeout(5)
  }
  if (!handle) throw new Error(`Settings write lock timed out: ${path}`)
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { value, fingerprint: expectedFingerprint } =
        await readSettings(path)
      const selectedTheme = update.theme ?? value.theme
      const customTheme =
        typeof selectedTheme === 'string' && selectedTheme.startsWith('custom:')
          ? (await loadTuiCustomThemes(configRoot)).find(
              (theme) => theme.slug === selectedTheme.slice('custom:'.length),
            )
          : undefined
      if (
        typeof selectedTheme === 'string' &&
        selectedTheme.startsWith('custom:') &&
        customTheme === undefined
      ) {
        throw new Error(`Custom theme is not available: ${selectedTheme}`)
      }
      const next = {
        ...settingsFromRecord(value, customTheme),
        ...update,
        ...(customTheme === undefined ? {} : { customTheme }),
      }
      const persisted = { ...value }
      if (update.theme !== undefined) persisted.theme = update.theme
      if (update.syntaxHighlightingDisabled !== undefined)
        persisted.syntaxHighlightingDisabled = update.syntaxHighlightingDisabled
      const committed = await writeFileAtomically(
        path,
        `${JSON.stringify(persisted, null, 2)}\n`,
        {
          beforeCommit: async () => {
            if (!(await fingerprintUnchanged(path, expectedFingerprint)))
              return false
            await hooks.afterValidation?.()
            return fingerprintUnchanged(path, expectedFingerprint)
          },
        },
      )
      if (committed) return next
    }
    throw new Error(`Settings changed concurrently: ${path}`)
  } finally {
    await handle.release()
  }
}
