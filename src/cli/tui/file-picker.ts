import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface TuiFileEntry {
  path: string
  directory: boolean
}

export interface TuiAgentEntry {
  name: string
  description: string
}

export type TuiMentionEntry =
  ({ kind: 'file' } & TuiFileEntry) | ({ kind: 'agent' } & TuiAgentEntry)

export async function loadTuiFileEntries(
  cwd: string,
  options: { respectGitignore?: boolean } = {},
): Promise<readonly TuiFileEntry[]> {
  let stdout: string
  try {
    const result = await execFileAsync(
      'rg',
      [
        '--files',
        '--hidden',
        ...(options.respectGitignore === false ? ['--no-ignore'] : []),
        '--glob',
        '!.git/**',
      ],
      {
        cwd,
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
        timeout: 5_000,
      },
    )
    stdout = result.stdout
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 1
    ) {
      return []
    }
    throw error
  }
  const files = stdout
    .split(/\r?\n/u)
    .map((path) => path.replace(/^\.\//u, ''))
    .filter(Boolean)
    .slice(0, 5_000)
  const directories = new Set<string>()
  for (const path of files) {
    const parts = path.split('/')
    for (let index = 1; index < parts.length; index += 1) {
      directories.add(`${parts.slice(0, index).join('/')}/`)
    }
  }
  return [
    ...files.map((path) => ({ path, directory: false })),
    ...[...directories].map((path) => ({ path, directory: true })),
  ].sort((left, right) => left.path.localeCompare(right.path))
}

export function filterTuiFileEntries(
  entries: readonly TuiFileEntry[],
  query: string,
): readonly TuiFileEntry[] {
  const normalized = query.toLowerCase()
  return [...entries]
    .filter(
      (entry) => !normalized || entry.path.toLowerCase().includes(normalized),
    )
    .sort((left, right) => {
      const leftPrefix = left.path.toLowerCase().startsWith(normalized)
      const rightPrefix = right.path.toLowerCase().startsWith(normalized)
      if (leftPrefix !== rightPrefix) return leftPrefix ? -1 : 1
      return left.path.localeCompare(right.path)
    })
}

export function filterTuiMentionEntries(
  files: readonly TuiFileEntry[],
  agents: readonly TuiAgentEntry[],
  query: string,
): readonly TuiMentionEntry[] {
  const normalized = query.toLowerCase()
  const matchingAgents = [...agents]
    .filter(
      (agent) =>
        !normalized ||
        agent.name.toLowerCase().includes(normalized) ||
        agent.description.toLowerCase().includes(normalized),
    )
    .sort((left, right) => {
      const leftPrefix = left.name.toLowerCase().startsWith(normalized)
      const rightPrefix = right.name.toLowerCase().startsWith(normalized)
      if (leftPrefix !== rightPrefix) return leftPrefix ? -1 : 1
      return left.name.localeCompare(right.name)
    })
    .map((agent) => ({ kind: 'agent' as const, ...agent }))
  const matchingFiles = filterTuiFileEntries(files, query).map((file) => ({
    kind: 'file' as const,
    ...file,
  }))
  if (normalized) return [...matchingFiles, ...matchingAgents]
  return [
    ...matchingFiles.filter((entry) => entry.directory),
    ...matchingAgents,
    ...matchingFiles.filter((entry) => !entry.directory),
  ]
}

export function fileReferenceAtCursor(
  input: string,
  cursor: number,
): { start: number; query: string } | null {
  const characters = Array.from(input)
  const boundedCursor = Math.max(0, Math.min(cursor, characters.length))
  let start = boundedCursor
  while (start > 0 && !/\s/u.test(characters[start - 1] ?? '')) start -= 1
  if (characters[start] !== '@') return null
  return {
    start,
    query: characters.slice(start + 1, boundedCursor).join(''),
  }
}

export function applyFileReference(
  input: string,
  cursor: number,
  reference: { start: number },
  path: string,
): { text: string; cursor: number } {
  const characters = Array.from(input)
  const replacement = Array.from(`@${path}`)
  const text = [
    ...characters.slice(0, reference.start),
    ...replacement,
    ...characters.slice(cursor),
  ].join('')
  return { text, cursor: reference.start + replacement.length }
}

export function applyMentionReference(
  input: string,
  cursor: number,
  reference: { start: number },
  entry: TuiMentionEntry,
): { text: string; cursor: number } {
  if (entry.kind === 'file') {
    return applyFileReference(input, cursor, reference, entry.path)
  }
  const characters = Array.from(input)
  const replacement = Array.from(`@"${entry.name} (agent)"`)
  return {
    text: [
      ...characters.slice(0, reference.start),
      ...replacement,
      ...characters.slice(cursor),
    ].join(''),
    cursor: reference.start + replacement.length,
  }
}
