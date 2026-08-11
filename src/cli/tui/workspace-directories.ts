import { readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'

function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith(`~${sep}`)) return join(homedir(), path.slice(2))
  return path
}

export async function resolveTuiWorkspaceDirectory(
  input: string,
  cwd: string,
): Promise<string> {
  const value = input.trim()
  if (!value) throw new Error('Enter a directory path or press Esc.')
  const path = await realpath(resolve(cwd, expandHome(value)))
  if (!(await stat(path)).isDirectory())
    throw new Error(`Not a directory: ${path}`)
  return path
}

function commonPrefix(values: readonly string[]): string {
  if (values.length === 0) return ''
  let prefix = values[0] ?? ''
  for (const value of values.slice(1)) {
    while (!value.startsWith(prefix)) prefix = prefix.slice(0, -1)
  }
  return prefix
}

export async function completeTuiWorkspaceDirectory(
  input: string,
  cwd: string,
): Promise<string> {
  const expanded = expandHome(input)
  const slash = Math.max(expanded.lastIndexOf('/'), expanded.lastIndexOf(sep))
  const typedParent = slash === -1 ? '' : expanded.slice(0, slash + 1)
  const typedName = slash === -1 ? expanded : expanded.slice(slash + 1)
  const parent = resolve(cwd, typedParent || '.')
  let entries
  try {
    entries = (await readdir(parent, { withFileTypes: true }))
      .filter(
        (entry) => entry.isDirectory() && entry.name.startsWith(typedName),
      )
      .map((entry) => entry.name)
      .sort()
  } catch {
    return input
  }
  const prefix = commonPrefix(entries)
  if (!prefix || (prefix === typedName && entries.length !== 1)) return input
  const completed = `${typedParent}${prefix}${entries.length === 1 ? sep : ''}`
  if (input.startsWith('~') && completed.startsWith(homedir())) {
    return `~${completed.slice(homedir().length)}`
  }
  return completed
}
