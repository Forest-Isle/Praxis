import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'

import { writeFileAtomically } from '../../platform/atomic-write.js'
import {
  ExclusiveFileLease,
  type ExclusiveFileLeaseHandle,
} from '../../platform/exclusive-file-lease.js'
import {
  DEFAULT_TUI_THEME_SETTINGS,
  TUI_THEMES,
  type TuiThemeSettings,
} from './theme.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function configRootPath(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
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

function settingsFromRecord(value: Record<string, unknown>): TuiThemeSettings {
  return {
    theme: TUI_THEMES.includes(value.theme as TuiThemeSettings['theme'])
      ? (value.theme as TuiThemeSettings['theme'])
      : DEFAULT_TUI_THEME_SETTINGS.theme,
    syntaxHighlightingDisabled:
      typeof value.syntaxHighlightingDisabled === 'boolean'
        ? value.syntaxHighlightingDisabled
        : DEFAULT_TUI_THEME_SETTINGS.syntaxHighlightingDisabled,
  }
}

export async function loadTuiThemeSettings(
  configRoot = configRootPath(),
): Promise<TuiThemeSettings> {
  const { value } = await readSettings(join(configRoot, 'settings.json'))
  return settingsFromRecord(value)
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
      const next = { ...settingsFromRecord(value), ...update }
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
