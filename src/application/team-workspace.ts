import { execFile } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { isAbsolute, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

import { resolveProjectIdentity } from '../platform/project-identity.js'
import { sanitizeProjectPath } from '../platform/project-path-key.js'
import { parseTeamId } from '../core/team-ownership.js'
import {
  createOwnedManagedWorktree,
  restoreOwnedManagedWorktree,
} from './managed-worktree.js'
import type {
  ManagedWorktree,
  ManagedWorktreeHooks,
} from './managed-worktree.js'

const execFileAsync = promisify(execFile)

export interface TeamWorkspace {
  readonly cwd: string
  readonly branch: string | null
  retain(reason: string): Promise<void>
}

export interface TeamWorkspaceInput {
  readonly teamId: string
  readonly taskId: string
  readonly generation: number
  readonly access: 'read-only' | 'write'
  readonly leadSessionId: string
  readonly executionToken: string
}

export interface TeamWorkspaceProvider {
  acquire(input: TeamWorkspaceInput): Promise<TeamWorkspace>
  releaseAccepted(input: TeamWorkspaceInput): Promise<void>
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
  if (
    typeof input.leadSessionId !== 'string' ||
    input.leadSessionId.trim() === ''
  )
    throw new Error('Invalid Team lead session ID')
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(input.executionToken))
    throw new Error('Invalid Team execution token')
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
  private readonly inFlight = new Map<string, Promise<TeamWorkspace>>()
  private readonly workspaceCache = new Map<string, TeamWorkspace>()
  private readonly managedHandles = new Map<string, ManagedWorktree>()
  private constructor(
    private readonly nativeRoot: string,
    private readonly cwd: string,
    private readonly projectIdentity: string,
    private readonly gitRoot: string | null,
    private readonly initialHead: string | null,
    private readonly hooksFactory?: (
      leadSessionId: string,
    ) => ManagedWorktreeHooks,
  ) {}

  static async open(options: {
    nativeRoot: string
    cwd: string
    projectIdentity: string
    hooksFactory?: (leadSessionId: string) => ManagedWorktreeHooks
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
      options.hooksFactory,
    )
  }

  async acquire(input: TeamWorkspaceInput): Promise<TeamWorkspace> {
    assertInput(input)
    if (input.access === 'write') {
      const key = this.ownerKey(input)
      const cached = this.workspaceCache.get(key)
      if (cached) return cached
      const existing = this.inFlight.get(key)
      if (existing) return existing
      const pending = this.acquireWrite(input, key)
      this.inFlight.set(key, pending)
      void pending.then(
        (workspace) => {
          if (this.inFlight.get(key) === pending) this.inFlight.delete(key)
          this.workspaceCache.set(key, workspace)
        },
        () => {
          if (this.inFlight.get(key) === pending) this.inFlight.delete(key)
        },
      )
      return pending
    }
    return this.acquireReadOnly()
  }

  private async acquireReadOnly(): Promise<TeamWorkspace> {
    return {
      cwd: this.cwd,
      branch: null,
      retain: async () => undefined,
    }
  }

  private async acquireWrite(
    input: TeamWorkspaceInput,
    key: string,
  ): Promise<TeamWorkspace> {
    if (this.gitRoot === null || this.initialHead === null)
      throw new Error('Team write workspace requires a Git repository')

    const { hash, branch, managedPath, legacyPath } = this.paths(input)
    await assertSafeParents(this.projectIdentity, managedPath)
    await assertSafeParents(this.nativeRoot, legacyPath)
    const managedExists = await inspectDirectory(managedPath)
    const legacyExists = await inspectDirectory(legacyPath)
    if (managedExists && legacyExists)
      throw new Error(`Ambiguous Team worktree paths for ${hash}`)
    if (legacyExists) {
      await this.validateLegacy(legacyPath, branch)
      const workspace = {
        cwd: legacyPath,
        branch,
        retain: async () => undefined,
      }
      this.workspaceCache.set(key, workspace)
      return workspace
    }
    const ownerId = `team:${input.teamId}:${input.generation}:${hash}:${input.executionToken}`
    let managed: ManagedWorktree
    const hook = this.hooksFactory?.(input.leadSessionId)
    if (managedExists) {
      managed = await restoreOwnedManagedWorktree({
        cwd: this.cwd,
        stateRoot: resolve(this.nativeRoot, 'state'),
        path: managedPath,
        parentDirectoryName: input.teamId,
        directoryName: hash,
        ownerPrefix: `team:${input.teamId}:`,
        ownerId,
        branch,
        label: 'Team',
        kind: 'team',
        policy: 'durable',
        ...(hook ? { hooks: hook } : {}),
      })
    } else {
      managed = await createOwnedManagedWorktree({
        cwd: this.cwd,
        stateRoot: resolve(this.nativeRoot, 'state'),
        parentDirectoryName: input.teamId,
        directoryName: hash,
        branch,
        ownerId,
        label: 'Team',
        kind: 'team',
        policy: 'durable',
        ...(hook ? { hooks: hook } : {}),
      })
    }
    this.managedHandles.set(key, managed)
    return this.wrapManaged(input, managed, key)
  }

  async releaseAccepted(input: TeamWorkspaceInput): Promise<void> {
    assertInput(input)
    if (input.access === 'read-only') return
    const key = this.ownerKey(input)
    const { hash, branch, managedPath, legacyPath } = this.paths(input)
    await assertSafeParents(this.projectIdentity, managedPath)
    await assertSafeParents(this.nativeRoot, legacyPath)
    const managedExists = await inspectDirectory(managedPath)
    const legacyExists = await inspectDirectory(legacyPath)
    if (managedExists && legacyExists)
      throw new Error(`Ambiguous Team worktree paths for ${hash}`)
    if (!managedExists && !legacyExists) {
      this.managedHandles.delete(key)
      this.workspaceCache.delete(key)
      return
    }
    if (managedExists) {
      const live = this.managedHandles.get(key)
      const ownerId = `team:${input.teamId}:${input.generation}:${hash}:${input.executionToken}`
      const managed =
        live ??
        (await restoreOwnedManagedWorktree({
          cwd: this.cwd,
          stateRoot: resolve(this.nativeRoot, 'state'),
          path: managedPath,
          parentDirectoryName: input.teamId,
          directoryName: hash,
          ownerPrefix: `team:${input.teamId}:`,
          ownerId,
          branch,
          label: 'Team',
          kind: 'team',
          policy: 'durable',
          ...(this.hooksFactory
            ? { hooks: this.hooksFactory(input.leadSessionId) }
            : {}),
        }))
      let result
      try {
        result = await managed.release()
      } finally {
        this.managedHandles.delete(key)
        this.workspaceCache.delete(key)
      }
      if (result.retained || result.reason !== undefined)
        throw new Error(
          `Accepted Team release warning: ${result.reason ?? 'retained evidence'}`,
        )
      return
    }
    await this.validateLegacy(legacyPath, branch)
    const head = await git(legacyPath, ['rev-parse', 'HEAD'])
    await git(this.gitRoot as string, [
      'worktree',
      'remove',
      '--force',
      legacyPath,
    ])
    this.workspaceCache.delete(key)
    try {
      await git(this.gitRoot as string, [
        'update-ref',
        '-d',
        `refs/heads/${branch}`,
        head,
      ])
    } catch (error) {
      throw new Error(
        `Legacy Team branch deletion warning: ${(error as Error).message}`,
      )
    }
  }

  private paths(input: TeamWorkspaceInput): {
    hash: string
    branch: string
    managedPath: string
    legacyPath: string
  } {
    const hash = this.hash(input)
    return {
      hash,
      branch: `praxis/team/${input.teamId}/${hash}`,
      managedPath: resolve(
        this.projectIdentity,
        '.praxis',
        'worktrees',
        'team',
        input.teamId,
        hash,
      ),
      legacyPath: resolve(
        this.nativeRoot,
        'state',
        'team-worktrees',
        sanitizeProjectPath(this.projectIdentity),
        input.teamId,
        hash,
      ),
    }
  }

  private hash(input: TeamWorkspaceInput): string {
    return createHash('sha256')
      .update(
        `${this.projectIdentity}\0${input.teamId}\0${input.taskId}\0${input.generation}`,
      )
      .digest('hex')
      .slice(0, 24)
  }

  private ownerKey(input: TeamWorkspaceInput): string {
    return `${input.teamId}\0${input.taskId}\0${input.generation}\0${input.executionToken}`
  }

  private async wrapManaged(
    input: TeamWorkspaceInput,
    managed: ManagedWorktree,
    key: string,
  ): Promise<TeamWorkspace> {
    return {
      cwd: managed.cwd,
      branch: `praxis/team/${input.teamId}/${this.hash(input)}`,
      retain: async (reason) => {
        let result
        try {
          result = await managed.retain(reason)
        } finally {
          this.managedHandles.delete(key)
          this.workspaceCache.delete(key)
        }
        if (!result.retained || result.reason !== reason)
          throw new Error(
            `Team worktree retention failed: ${result.reason ?? 'unknown reason'}`,
          )
      },
    }
  }

  private async validateLegacy(path: string, branch: string): Promise<void> {
    if (this.gitRoot === null)
      throw new Error('Team write workspace requires a Git repository')
    const registered = await registeredWorktrees(this.gitRoot)
    if (registered.get(await canonical(path)) !== `refs/heads/${branch}`)
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
    if (
      (await git(path, ['symbolic-ref', '--quiet', '--short', 'HEAD'])) !==
      branch
    )
      throw new Error(`Team worktree branch mismatch at ${path}`)
  }
}

async function inspectDirectory(path: string): Promise<boolean> {
  try {
    const entry = await lstat(path)
    if (entry.isSymbolicLink())
      throw new Error(`Team worktree path must not be a symlink: ${path}`)
    if (!entry.isDirectory())
      throw new Error(`Team worktree path is not a directory: ${path}`)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
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
