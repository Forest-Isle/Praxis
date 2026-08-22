import { readFile, realpath, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return resolve(path)
    throw error
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function findGitRoot(cwd: string): Promise<string | null> {
  let current = await canonicalPath(cwd)
  while (!(await exists(join(current, '.git')))) {
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
  return current
}

async function optionalFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/**
 * Resolves the stable local identity for a project. Linked worktrees share the
 * main repository identity; non-git directories use their canonical path.
 */
export async function resolveProjectIdentity(cwd: string): Promise<string> {
  const canonicalCwd = await canonicalPath(cwd)
  const gitRoot = await findGitRoot(canonicalCwd)
  if (!gitRoot) return canonicalCwd

  const marker = join(gitRoot, '.git')
  if ((await stat(marker)).isDirectory()) return gitRoot

  const gitFile = await readFile(marker, 'utf8')
  const gitDirectoryValue = /^gitdir:\s*(.+)\s*$/mu.exec(gitFile)?.[1]
  if (!gitDirectoryValue) return gitRoot

  const gitDirectory = resolve(gitRoot, gitDirectoryValue)
  const commonDirectory = await optionalFile(join(gitDirectory, 'commondir'))
  if (!commonDirectory) return gitRoot

  return dirname(
    await canonicalPath(resolve(gitDirectory, commonDirectory.trim())),
  )
}
