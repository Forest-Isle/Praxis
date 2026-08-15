import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const CLAUDE_CHANGELOG_URL =
  'https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md'
const CLAUDE_RAW_CHANGELOG_URL =
  'https://raw.githubusercontent.com/anthropics/claude-code/refs/heads/main/CHANGELOG.md'

export interface ReleaseNotesOptions {
  configRoot: string
  fetcher?: typeof fetch
  timeoutMs?: number
}

export function parseClaudeChangelog(
  content: string,
): readonly [version: string, notes: readonly string[]][] {
  const releases: Array<[string, string[]]> = []
  for (const section of content.split(/^## /gmu).slice(1)) {
    const [heading, ...lines] = section.trim().split(/\r?\n/u)
    const version = heading?.split(' - ')[0]?.trim()
    if (!version) continue
    const notes = lines
      .map((line) => line.trim())
      .filter((line) => line.startsWith('- '))
      .map((line) => line.slice(2).trim())
      .filter(Boolean)
    if (notes.length > 0) releases.push([version, notes])
  }
  return releases.sort(([left], [right]) =>
    left.localeCompare(right, undefined, { numeric: true }),
  )
}

export function formatClaudeReleaseNotes(content: string): string | null {
  const releases = parseClaudeChangelog(content)
  if (releases.length === 0) return null
  return releases
    .map(
      ([version, notes]) =>
        `Version ${version}:\n${notes.map((note) => `· ${note}`).join('\n')}`,
    )
    .join('\n\n')
}

async function cachedChangelog(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

export async function loadClaudeReleaseNotes({
  configRoot,
  fetcher = fetch,
  timeoutMs = 500,
}: ReleaseNotesOptions): Promise<string> {
  const cachePath = join(configRoot, 'cache', 'changelog.md')
  let fresh = ''
  try {
    const response = await fetcher(CLAUDE_RAW_CHANGELOG_URL, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (response.ok) {
      fresh = await response.text()
      await mkdir(dirname(cachePath), { recursive: true })
      await writeFile(cachePath, fresh, 'utf8')
    }
  } catch {
    // A release-notes lookup is best-effort; the shared cache is authoritative
    // whenever the network is unavailable or slower than the UI budget.
  }
  const formatted = formatClaudeReleaseNotes(
    fresh || (await cachedChangelog(cachePath)),
  )
  return formatted ?? `See the full changelog at: ${CLAUDE_CHANGELOG_URL}`
}
