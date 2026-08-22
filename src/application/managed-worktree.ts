import { execFile } from 'node:child_process'
import { lstat, mkdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface ManagedWorktreeCleanup {
  retained: boolean
  reason?: string
}

export interface ManagedWorktree {
  cwd: string
  cleanup(): Promise<ManagedWorktreeCleanup>
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  return (
    await execFileAsync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  ).stdout.trim()
}

async function registeredWorktrees(root: string): Promise<Set<string>> {
  const output = await git(root, ['worktree', 'list', '--porcelain'])
  return new Set(
    output
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => resolve(line.slice('worktree '.length))),
  )
}

export async function createManagedWorktree(options: {
  cwd: string
  parentDirectory: string
  directoryName: string
  label: 'Agent' | 'Workflow'
}): Promise<ManagedWorktree> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/u.test(options.directoryName)) {
    throw new Error(`Invalid ${options.label.toLowerCase()} worktree name`)
  }
  let root: string
  let initialHead: string
  try {
    ;[root, initialHead] = await Promise.all([
      git(options.cwd, ['rev-parse', '--show-toplevel']),
      git(options.cwd, ['rev-parse', 'HEAD']),
    ])
  } catch {
    throw new Error(
      `${options.label} worktree isolation requires a Git repository`,
    )
  }
  const parent = resolve(options.parentDirectory)
  const path = join(parent, options.directoryName)
  await mkdir(parent, { recursive: true })
  let exists = false
  try {
    const entry = await lstat(path)
    if (entry.isSymbolicLink()) {
      throw new Error(`${options.label} worktree path must not be a symlink`)
    }
    exists = true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (exists) {
    let registered: Set<string>
    try {
      registered = await registeredWorktrees(root)
    } catch (error) {
      throw new Error(
        `Could not inspect ${options.label.toLowerCase()} worktrees: ${(error as Error).message}`,
      )
    }
    if (!registered.has(resolve(path))) {
      throw new Error(
        `${options.label} worktree path already exists and is not registered: ${path}`,
      )
    }
  } else {
    try {
      await git(root, ['worktree', 'add', '--detach', path, initialHead])
    } catch (error) {
      throw new Error(
        `Could not create ${options.label.toLowerCase()} worktree: ${(error as Error).message}`,
      )
    }
  }

  let removedResult: ManagedWorktreeCleanup | undefined
  let cleanupInFlight: Promise<ManagedWorktreeCleanup> | undefined
  return {
    cwd: path,
    cleanup: async () => {
      if (removedResult) return removedResult
      if (cleanupInFlight) return cleanupInFlight
      cleanupInFlight = (async () => {
        let status: string
        let head: string
        try {
          ;[status, head] = await Promise.all([
            git(path, ['status', '--porcelain']),
            git(path, ['rev-parse', 'HEAD']),
          ])
        } catch (error) {
          return {
            retained: true,
            reason: `Could not inspect ${options.label.toLowerCase()} worktree ${path}: ${(error as Error).message}`,
          }
        }
        if (status.length > 0) {
          return {
            retained: true,
            reason: `${options.label} worktree has uncommitted changes and was retained at ${path}`,
          }
        }
        if (head !== initialHead) {
          return {
            retained: true,
            reason: `${options.label} worktree has commits and was retained at ${path}`,
          }
        }
        try {
          await git(root, ['worktree', 'remove', path])
          return { retained: false }
        } catch (error) {
          return {
            retained: true,
            reason: `Could not remove ${options.label.toLowerCase()} worktree ${path}: ${(error as Error).message}`,
          }
        }
      })()
      try {
        const result = await cleanupInFlight
        if (!result.retained) removedResult = result
        return result
      } finally {
        cleanupInFlight = undefined
      }
    },
  }
}

/** Reattaches only to a real, registered Git worktree. Persisted metadata is
 * untrusted input, so an arbitrary directory can never become an execution
 * cwd merely because it exists. Restored worktrees are retained for audit. */
export async function restoreManagedWorktree(options: {
  cwd: string
  path: string
  label: 'Agent' | 'Workflow'
}): Promise<ManagedWorktree> {
  if (!isAbsolute(options.path) || options.path.includes('\0')) {
    throw new Error(
      `Invalid retained ${options.label.toLowerCase()} worktree path`,
    )
  }
  const path = resolve(options.path)
  let entry
  try {
    entry = await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `Retained ${options.label.toLowerCase()} worktree is missing: ${path}`,
      )
    }
    throw error
  }
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error(
      `Retained ${options.label.toLowerCase()} worktree must be a real directory: ${path}`,
    )
  }
  let root: string
  let registered: Set<string>
  let canonicalPath: string
  try {
    ;[root, canonicalPath] = await Promise.all([
      git(options.cwd, ['rev-parse', '--show-toplevel']),
      realpath(path),
    ])
    registered = await registeredWorktrees(root)
  } catch (error) {
    throw new Error(
      `Could not inspect retained ${options.label.toLowerCase()} worktree ${path}: ${(error as Error).message}`,
    )
  }
  if (!registered.has(path) && !registered.has(canonicalPath)) {
    throw new Error(
      `Retained ${options.label.toLowerCase()} worktree is not registered: ${path}`,
    )
  }
  const worktreeRoot = await realpath(
    resolve(await git(path, ['rev-parse', '--show-toplevel'])),
  )
  if (worktreeRoot !== canonicalPath) {
    throw new Error(
      `Retained ${options.label.toLowerCase()} worktree path is not its root: ${path}`,
    )
  }
  return {
    cwd: path,
    async cleanup() {
      return {
        retained: true,
        reason: `${options.label} worktree was restored and retained at ${path}`,
      }
    },
  }
}
