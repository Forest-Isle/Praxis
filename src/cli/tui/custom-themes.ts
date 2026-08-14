import { constants } from 'node:fs'
import { mkdir, open, readdir, readFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'

import { writeFileAtomically } from '../../platform/atomic-write.js'
import {
  ExclusiveFileLease,
  type ExclusiveFileLeaseHandle,
} from '../../platform/exclusive-file-lease.js'
import { TUI_THEMES, type TuiTheme } from './theme.js'

export const CUSTOM_THEME_TOKENS = [
  'autoAccept',
  'autoAcceptShimmer',
  'background',
  'bashBorder',
  'bashMessageBackgroundColor',
  'blue_FOR_SUBAGENTS_ONLY',
  'briefLabelClaude',
  'briefLabelYou',
  'chromeYellow',
  'claude',
  'claudeBlueShimmer_FOR_SYSTEM_SPINNER',
  'claudeBlue_FOR_SYSTEM_SPINNER',
  'claudeShimmer',
  'clawd_background',
  'clawd_body',
  'cyan_FOR_SUBAGENTS_ONLY',
  'diffAdded',
  'diffAddedDimmed',
  'diffAddedWord',
  'diffRemoved',
  'diffRemovedDimmed',
  'diffRemovedWord',
  'error',
  'fastMode',
  'fastModeShimmer',
  'green_FOR_SUBAGENTS_ONLY',
  'ide',
  'inactive',
  'inactiveShimmer',
  'inverseText',
  'memoryBackgroundColor',
  'merged',
  'messageActionsBackground',
  'orange_FOR_SUBAGENTS_ONLY',
  'pink_FOR_SUBAGENTS_ONLY',
  'planMode',
  'professionalBlue',
  'promptBorder',
  'promptBorderShimmer',
  'purple_FOR_SUBAGENTS_ONLY',
  'rainbow_blue',
  'rainbow_blue_shimmer',
  'rainbow_green',
  'rainbow_green_shimmer',
  'rainbow_indigo',
  'rainbow_indigo_shimmer',
  'rainbow_orange',
  'rainbow_orange_shimmer',
  'rainbow_red',
  'rainbow_red_shimmer',
  'rainbow_violet',
  'rainbow_violet_shimmer',
  'rainbow_yellow',
  'rainbow_yellow_shimmer',
  'rate_limit_empty',
  'rate_limit_fill',
  'red_FOR_SUBAGENTS_ONLY',
  'remember',
  'selectionBg',
  'success',
  'subtle',
  'suggestion',
  'text',
  'userMessageBackground',
  'userMessageBackgroundHover',
  'warning',
  'warningShimmer',
  'yellow_FOR_SUBAGENTS_ONLY',
] as const

export type CustomThemeToken = (typeof CUSTOM_THEME_TOKENS)[number]
export type CustomThemeBase = Exclude<TuiTheme, 'auto'>

export interface TuiCustomTheme {
  name: string
  slug: string
  base: CustomThemeBase
  overrides: Readonly<Partial<Record<CustomThemeToken, string>>>
}

const MAX_THEME_FILE_BYTES = 256 * 1024
const CUSTOM_NAME = /^[A-Za-z][A-Za-z0-9 _-]{0,63}$/u
const CUSTOM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const HEX = /^#[0-9a-f]{6}$/iu
const RGB =
  /^rgb\(\s*(?:\d|[1-9]\d|1\d\d|2[0-4]\d|25[0-5])\s*,\s*(?:\d|[1-9]\d|1\d\d|2[0-4]\d|25[0-5])\s*,\s*(?:\d|[1-9]\d|1\d\d|2[0-4]\d|25[0-5])\s*\)$/iu
const ANSI256 = /^ansi256\((?:[0-9]|[1-9]\d|1\d\d|2[0-4]\d)\)$/u
const ANSI = /^ansi:[A-Za-z][A-Za-z0-9]*$/u

function configRootPath(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
}

export function customThemeDirectory(configRoot = configRootPath()): string {
  return join(configRoot, 'themes')
}

function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
}

export function validateCustomThemeName(name: string): string {
  const normalized = name.trim()
  if (!CUSTOM_NAME.test(normalized)) {
    throw new Error(
      'Theme name must start with a letter and contain only letters, numbers, spaces, hyphens, or underscores (1–64 characters).',
    )
  }
  const slug = slugify(normalized)
  if (!CUSTOM_SLUG.test(slug))
    throw new Error(
      'Theme name must contain at least one ASCII letter or number.',
    )
  return slug
}

function validateColor(value: string): string {
  const normalized = value.trim()
  if (
    !HEX.test(normalized) &&
    !RGB.test(normalized) &&
    !ANSI256.test(normalized) &&
    !ANSI.test(normalized)
  ) {
    throw new Error(
      `Invalid theme color ${JSON.stringify(value)}. Use rgb(r,g,b), #rrggbb, ansi256(n), or ansi:name.`,
    )
  }
  return normalized
}

function parseTheme(value: unknown, slug: string): TuiCustomTheme {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(`Invalid custom theme file: ${slug}.json`)
  const record = value as Record<string, unknown>
  if (typeof record.name !== 'string' || !CUSTOM_NAME.test(record.name))
    throw new Error(`Invalid custom theme name: ${slug}.json`)
  if (
    !TUI_THEMES.includes(record.base as (typeof TUI_THEMES)[number]) ||
    record.base === 'auto'
  )
    throw new Error(`Invalid custom theme base: ${slug}.json`)
  if (
    typeof record.overrides !== 'object' ||
    record.overrides === null ||
    Array.isArray(record.overrides)
  )
    throw new Error(`Invalid custom theme overrides: ${slug}.json`)
  const overrides: Partial<Record<CustomThemeToken, string>> = {}
  for (const [token, color] of Object.entries(record.overrides)) {
    if (!(CUSTOM_THEME_TOKENS as readonly string[]).includes(token))
      throw new Error(`Unknown custom theme token ${JSON.stringify(token)}.`)
    if (typeof color !== 'string')
      throw new Error(`Theme token ${token} must be a color string.`)
    overrides[token as CustomThemeToken] = validateColor(color)
  }
  const expectedSlug = slugify(record.name)
  if (expectedSlug !== slug)
    throw new Error(`Custom theme filename must match its name: ${slug}.json`)
  return {
    name: record.name,
    slug,
    base: record.base as CustomThemeBase,
    overrides,
  }
}

async function readThemeFile(
  path: string,
  slug: string,
): Promise<TuiCustomTheme> {
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  )
  try {
    const info = await handle.stat()
    if (info.size > MAX_THEME_FILE_BYTES)
      throw new Error(
        `Custom theme exceeds ${MAX_THEME_FILE_BYTES} bytes: ${path}`,
      )
    return parseTheme(
      JSON.parse(await handle.readFile('utf8')) as unknown,
      slug,
    )
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new Error(`Invalid JSON: ${path}`, { cause: error })
    throw error
  } finally {
    await handle.close()
  }
}

async function acquireThemeLease(
  directory: string,
): Promise<ExclusiveFileLeaseHandle> {
  const lease = new ExclusiveFileLease(join(directory, '.praxis-themes.lock'))
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const handle = await lease.tryAcquire()
    if (handle) return handle
    await setTimeout(5)
  }
  throw new Error(`Custom theme write lock timed out: ${directory}`)
}

export async function loadTuiCustomThemes(
  configRoot = configRootPath(),
): Promise<readonly TuiCustomTheme[]> {
  const directory = customThemeDirectory(configRoot)
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const themes: TuiCustomTheme[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const slug = entry.name.slice(0, -'.json'.length)
    if (!CUSTOM_SLUG.test(slug))
      throw new Error(`Invalid custom theme filename: ${entry.name}`)
    themes.push(await readThemeFile(join(directory, entry.name), slug))
  }
  return themes.sort((left, right) => left.name.localeCompare(right.name))
}

function serializedTheme(theme: TuiCustomTheme): string {
  return `${JSON.stringify(
    { name: theme.name, base: theme.base, overrides: theme.overrides },
    null,
    2,
  )}\n`
}

export async function createTuiCustomTheme({
  name,
  base,
  configRoot = configRootPath(),
}: {
  name: string
  base: CustomThemeBase
  configRoot?: string
}): Promise<TuiCustomTheme> {
  const slug = validateCustomThemeName(name)
  if (
    !(TUI_THEMES as readonly string[]).includes(base) ||
    (base as string) === 'auto'
  )
    throw new Error(`Invalid custom theme base: ${base}`)
  const directory = customThemeDirectory(configRoot)
  await mkdir(directory, { recursive: true })
  const handle = await acquireThemeLease(directory)
  try {
    const path = join(directory, `${slug}.json`)
    try {
      await readFile(path, 'utf8')
      throw new Error(
        `A custom theme named ${JSON.stringify(name.trim())} already exists.`,
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const theme: TuiCustomTheme = {
      name: name.trim(),
      slug,
      base,
      overrides: {},
    }
    const committed = await writeFileAtomically(path, serializedTheme(theme), {
      mode: 0o600,
      beforeCommit: async () => {
        try {
          await readFile(path, 'utf8')
          return false
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
          throw error
        }
      },
    })
    if (!committed)
      throw new Error(
        `A custom theme named ${JSON.stringify(name.trim())} already exists.`,
      )
    return theme
  } finally {
    await handle.release()
  }
}

export async function updateTuiCustomTheme(
  theme: TuiCustomTheme,
  token: CustomThemeToken,
  value: string | undefined,
  configRoot = configRootPath(),
): Promise<TuiCustomTheme> {
  const color = value === undefined ? undefined : validateColor(value)
  const directory = customThemeDirectory(configRoot)
  await mkdir(directory, { recursive: true })
  const handle = await acquireThemeLease(directory)
  try {
    const path = join(directory, `${theme.slug}.json`)
    const current = await readThemeFile(path, theme.slug)
    const overrides = { ...current.overrides }
    if (color === undefined) delete overrides[token]
    else overrides[token] = color
    const next = { ...current, overrides }
    if (!(await writeFileAtomically(path, serializedTheme(next))))
      throw new Error(`Unable to update custom theme: ${path}`)
    return next
  } finally {
    await handle.release()
  }
}

export async function deleteTuiCustomTheme(
  theme: TuiCustomTheme,
  configRoot = configRootPath(),
): Promise<void> {
  const directory = customThemeDirectory(configRoot)
  const handle = await acquireThemeLease(directory)
  try {
    await rm(join(directory, `${theme.slug}.json`), { force: false })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  } finally {
    await handle.release()
  }
}
