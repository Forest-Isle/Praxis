import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { writeFileAtomically } from '../../platform/atomic-write.js'

export const TUI_THEMES = [
  'auto',
  'dark',
  'light',
  'dark-daltonized',
  'light-daltonized',
  'dark-ansi',
  'light-ansi',
] as const

export type TuiTheme = (typeof TUI_THEMES)[number]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function configRootPath(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
}

async function readSettings(path: string): Promise<{
  value: Record<string, unknown>
  source?: string
}> {
  try {
    const source = await readFile(path, 'utf8')
    const value: unknown = JSON.parse(source)
    if (!isRecord(value))
      throw new Error(`JSON root must be an object: ${path}`)
    return { value, source }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { value: {} }
    if (error instanceof SyntaxError)
      throw new Error(`Invalid JSON: ${path}`, { cause: error })
    throw error
  }
}

async function sourceUnchanged(
  path: string,
  source: string | undefined,
): Promise<boolean> {
  try {
    return (await readFile(path, 'utf8')) === source
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return source === undefined
    throw error
  }
}

export async function loadTuiTheme(
  configRoot = configRootPath(),
): Promise<TuiTheme> {
  const { value } = await readSettings(join(configRoot, 'settings.json'))
  return TUI_THEMES.includes(value.theme as TuiTheme)
    ? (value.theme as TuiTheme)
    : 'auto'
}

export async function saveTuiTheme(
  theme: TuiTheme,
  configRoot = configRootPath(),
): Promise<void> {
  const path = join(configRoot, 'settings.json')
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { value, source } = await readSettings(path)
    const committed = await writeFileAtomically(
      path,
      `${JSON.stringify({ ...value, theme }, null, 2)}\n`,
      { beforeCommit: () => sourceUnchanged(path, source) },
    )
    if (committed) return
  }
  throw new Error(`Settings changed concurrently: ${path}`)
}
