import { execFile } from 'node:child_process'
import { lstat, mkdir, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { isAbsolute, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

import { resolveProjectIdentity } from '../platform/project-identity.js'
import { sanitizeProjectPath } from '../platform/project-path-key.js'
import { parseTeamId } from '../core/team-ownership.js'

const execFileAsync = promisify(execFile)

export interface TeamWorkspace {
  readonly cwd: string
  readonly branch: string | null
}

export interface TeamWorkspaceInput {
  readonly teamId: string
  readonly taskId: string
  readonly generation: number
  readonly access: 'read-only' | 'write'
}

export interface TeamWorkspaceProvider {
  acquire(input: TeamWorkspaceInput): Promise<TeamWorkspace>
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  return (
    await execFileAsync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  ).stdout.trim()
}

async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return resolve(path)
    throw error
  }
}

function assertInput(input: TeamWorkspaceInput): void {
  parseTeamId(input.teamId)
  if (typeof input.taskId !== 'string' || input.taskId.trim() === '')
    throw new Error('Invalid Team task ID')
  if (!Number.isSafeInteger(input.generation) || input.generation <= 0)
    throw new Error('Invalid Team generation')
  if (input.access !== 'read-only' && input.access !== 'write')
    throw new Error('Invalid Team workspace access')
}

async function registeredWorktrees(root: string): Promise<Map<string, string>> {
  const output = await git(root, ['worktree', 'list', '--porcelain'])
  const result = new Map<string, string>()
  let path: string | undefined
  for (const line of output.split('\n')) {
    if (line.startsWith('worktree '))
      path = resolve(line.slice('worktree '.length))
    else if (line.startsWith('branch ') && path) {
      result.set(await canonical(path), line.slice('branch '.length))
      path = undefined
    }
  }
  if (path) result.set(await canonical(path), '')
  return result
}

export class NativeTeamWorkspaceProvider implements TeamWorkspaceProvider {
  private constructor(
    private readonly nativeRoot: string,
    private readonly cwd: string,
    private readonly projectIdentity: string,
    private readonly gitRoot: string | null,
    private readonly initialHead: string | null,
  ) {}

  static async open(options: {
    nativeRoot: string
    cwd: string
    projectIdentity: string
  }): Promise<NativeTeamWorkspaceProvider> {
    if (
      typeof options.nativeRoot !== 'string' ||
      options.nativeRoot.trim() === ''
    )
      throw new Error('Invalid native Team root')
    const canonicalCwd = await canonical(options.cwd)
    const identity = await resolveProjectIdentity(canonicalCwd)
    if (identity !== options.projectIdentity)
      throw new Error('Team workspace project identity mismatch')
    let gitRoot: string | null = null
    let initialHead: string | null = null
    try {
      gitRoot = await canonical(
        await git(canonicalCwd, ['rev-parse', '--show-toplevel']),
      )
      initialHead = await git(gitRoot, ['rev-parse', 'HEAD'])
    } catch {
      // A read-only member can safely use a non-Git project root.
    }
    return new NativeTeamWorkspaceProvider(
      await canonical(options.nativeRoot),
      canonicalCwd,
      options.projectIdentity,
      gitRoot,
      initialHead,
    )
  }

  async acquire(input: TeamWorkspaceInput): Promise<TeamWorkspace> {
    assertInput(input)
    if (input.access === 'read-only') {
      return { cwd: this.cwd, branch: null }
    }
    if (this.gitRoot === null || this.initialHead === null)
      throw new Error('Team write workspace requires a Git repository')

    const hash = createHash('sha256')
      .update(
        `${this.projectIdentity}\0${input.teamId}\0${input.taskId}\0${input.generation}`,
      )
      .digest('hex')
      .slice(0, 24)
    const branch = `praxis/team/${input.teamId}/${hash}`
    const path = resolve(
      this.nativeRoot,
      'state',
      'team-worktrees',
      sanitizeProjectPath(this.projectIdentity),
      input.teamId,
      hash,
    )
    if (
      !isAbsolute(path) ||
      !isAbsolute(this.nativeRoot) ||
      !isPathWithin(this.nativeRoot, path)
    )
      throw new Error('Invalid Team workspace path')
    await assertSafeParents(this.nativeRoot, path)

    let pathExists = false
    try {
      const entry = await lstat(path)
      if (entry.isSymbolicLink())
        throw new Error('Team worktree path must not be a symlink')
      if (!entry.isDirectory())
        throw new Error(`Team worktree path is not a directory: ${path}`)
      pathExists = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const currentHead = await git(this.gitRoot, ['rev-parse', 'HEAD'])
    const registered = await registeredWorktrees(this.gitRoot)
    const registeredBranch = registered.get(path)
    const branchExists = await this.hasBranch(branch)
    if (!pathExists && !branchExists) {
      await mkdir(resolve(path, '..'), { recursive: true })
      try {
        await git(this.gitRoot, [
          'worktree',
          'add',
          '-b',
          branch,
          path,
          currentHead,
        ])
      } catch (error) {
        throw new Error(
          `Could not create Team worktree: ${(error as Error).message}`,
        )
      }
      return { cwd: path, branch }
    }
    if (!pathExists || !branchExists)
      throw new Error(`Team workspace collision at ${path}`)
    if (registeredBranch !== `refs/heads/${branch}`)
      throw new Error(`Team worktree registration mismatch at ${path}`)
    if ((await canonical(path)) !== path)
      throw new Error(`Team worktree path must be canonical: ${path}`)
    const worktreeRoot = await canonical(
      await git(path, ['rev-parse', '--show-toplevel']),
    )
    if (
      worktreeRoot !== path ||
      (await resolveProjectIdentity(path)) !== this.projectIdentity
    )
      throw new Error(`Team worktree repository mismatch at ${path}`)
    const currentBranch = await git(path, [
      'symbolic-ref',
      '--quiet',
      '--short',
      'HEAD',
    ])
    if (currentBranch !== branch)
      throw new Error(`Team worktree branch mismatch at ${path}`)
    return { cwd: path, branch }
  }

  private async hasBranch(branch: string): Promise<boolean> {
    try {
      await git(this.gitRoot as string, [
        'show-ref',
        '--verify',
        '--quiet',
        `refs/heads/${branch}`,
      ])
      return true
    } catch (error) {
      const code = (error as { code?: number }).code
      if (code === 1) return false
      throw error
    }
  }
}

function isPathWithin(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate))
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

async function assertSafeParents(root: string, path: string): Promise<void> {
  let current = resolve(path, '..')
  const nativeRoot = resolve(root)
  for (;;) {
    try {
      const entry = await lstat(current)
      if (entry.isSymbolicLink())
        throw new Error(
          `Team worktree parent must not be a symlink: ${current}`,
        )
      if (!entry.isDirectory())
        throw new Error(`Team worktree parent is not a directory: ${current}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (current === nativeRoot || !isPathWithin(nativeRoot, current)) return
    const parent = resolve(current, '..')
    if (parent === current) return
    current = parent
  }
}
