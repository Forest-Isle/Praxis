import { execFile } from 'node:child_process'
import { lstat, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
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

  let cleanupResult: ManagedWorktreeCleanup | undefined
  return {
    cwd: path,
    cleanup: async () => {
      if (cleanupResult) return cleanupResult
      let status: string
      let head: string
      try {
        ;[status, head] = await Promise.all([
          git(path, ['status', '--porcelain']),
          git(path, ['rev-parse', 'HEAD']),
        ])
      } catch (error) {
        cleanupResult = {
          retained: true,
          reason: `Could not inspect ${options.label.toLowerCase()} worktree ${path}: ${(error as Error).message}`,
        }
        return cleanupResult
      }
      if (status.length > 0) {
        cleanupResult = {
          retained: true,
          reason: `${options.label} worktree has uncommitted changes and was retained at ${path}`,
        }
        return cleanupResult
      }
      if (head !== initialHead) {
        cleanupResult = {
          retained: true,
          reason: `${options.label} worktree has commits and was retained at ${path}`,
        }
        return cleanupResult
      }
      try {
        await git(root, ['worktree', 'remove', path])
        cleanupResult = { retained: false }
      } catch (error) {
        cleanupResult = {
          retained: true,
          reason: `Could not remove ${options.label.toLowerCase()} worktree ${path}: ${(error as Error).message}`,
        }
      }
      return cleanupResult
    },
  }
}
