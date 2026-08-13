import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

import { randomUUID } from 'node:crypto'

const execFileAsync = promisify(execFile)

export interface WorktreeSessionState {
  originalCwd: string
  preEnterOriginalCwd: string
  worktreePath: string
  worktreeName: string
  worktreeBranch: string | null
  originalBranch: string | null
  originalHeadCommit: string
  sessionId: string
}

export interface WorktreeTransition {
  callId: string
  state: WorktreeSessionState | null
}

export class WorkspaceContext {
  readonly originalCwd: string
  private activeCwd: string

  constructor(cwd: string) {
    this.originalCwd = resolve(cwd)
    this.activeCwd = this.originalCwd
  }

  cwd(): string {
    return this.activeCwd
  }

  setCwd(cwd: string): void {
    this.activeCwd = resolve(cwd)
  }
}

function invalidName(name: string): boolean {
  if (name.length === 0 || name.length > 64) return true
  return name
    .split('/')
    .some(
      (segment) =>
        segment.length === 0 ||
        segment === '.' ||
        segment === '..' ||
        !/^[A-Za-z0-9._-]+$/u.test(segment),
    )
}

function nameFromPath(path: string): string {
  return path.split('/').filter(Boolean).join('-')
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
  })
  return result.stdout.trim()
}

function parseWorktrees(
  output: string,
): { path: string; branch: string | null }[] {
  const records = output.split(/\n\n+/u).filter(Boolean)
  return records.map((record) => {
    const path = /^worktree (.+)$/mu.exec(record)?.[1]
    if (!path) throw new Error('Invalid git worktree list output')
    const branch = /^branch refs\/heads\/(.+)$/mu.exec(record)?.[1] ?? null
    return { path: resolve(path), branch }
  })
}

function displayChanges(status: string, ahead: number): string {
  const files = status
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  return `${files.length} dirty file(s), ${ahead} unmerged commit(s)`
}

export class SessionWorktreeManager {
  private active: WorktreeSessionState | null = null
  private createdBySession = false
  private transition: WorktreeTransition | null = null
  private busy = false

  constructor(
    private readonly options: {
      workspace: WorkspaceContext
      sessionId: string
      baseRef?: 'fresh' | 'head'
    },
  ) {}

  bindSession(sessionId: string): void {
    if (this.active && this.active.sessionId !== sessionId) {
      throw new Error(
        `Cannot switch to session ${sessionId} while worktree session ${this.active.sessionId} is active`,
      )
    }
    this.options.sessionId = sessionId
  }

  current(): WorktreeSessionState | null {
    return this.active
  }

  async ensureInitial(name?: string): Promise<void> {
    if (this.active) return
    await this.enter(name === undefined ? {} : { name }, '__initial__')
  }

  restore(state: WorktreeSessionState | null): void {
    if (!state) return
    if (this.active) return
    if (state.sessionId !== this.options.sessionId) return
    const worktreePath = resolve(state.worktreePath)
    const allowedRoot = resolve(state.originalCwd, '.claude', 'worktrees')
    if (!isWithin(allowedRoot, worktreePath)) return
    // A crashed session can leave the directory behind after Git has
    // deregistered the worktree. Only restore directories that still carry
    // Git's worktree marker.
    if (!existsSync(worktreePath) || !existsSync(join(worktreePath, '.git'))) {
      return
    }
    this.active = { ...state, worktreePath }
    this.createdBySession = false
    this.options.workspace.setCwd(worktreePath)
  }

  consumeTransition(callId: string): WorktreeTransition | null {
    if (this.transition?.callId !== callId) return null
    const value = this.transition
    this.transition = null
    return value
  }

  async enter(
    input: { name?: string; path?: string },
    callId: string,
  ): Promise<{
    content: string
    nativeToolUseResult: Record<string, unknown>
  }> {
    return this.withTransition(async () => {
      if (this.active) throw new Error('Already in a worktree session')
      if (input.name !== undefined && input.path !== undefined) {
        throw new Error('EnterWorktree name and path are mutually exclusive')
      }
      const originalCwd = this.options.workspace.cwd()
      const root = await this.repositoryRoot(originalCwd)
      const originalBranch = await gitOptional(root, [
        'symbolic-ref',
        '--short',
        'HEAD',
      ])
      const originalHeadCommit = await git(root, ['rev-parse', 'HEAD'])
      if (input.path !== undefined) {
        const entered = await this.enterExisting(
          root,
          originalCwd,
          originalBranch,
          originalHeadCommit,
          input.path,
        )
        this.active = entered
        this.createdBySession = false
        this.options.workspace.setCwd(entered.worktreePath)
        const message = `Entered existing worktree at ${entered.worktreePath}. The session is now working in the worktree.`
        this.transition = { callId, state: entered }
        return {
          content: message,
          nativeToolUseResult: {
            worktreePath: entered.worktreePath,
            worktreeBranch: entered.worktreeBranch,
            message,
          },
        }
      }

      const name =
        input.name ?? `praxis-${randomUUID().replaceAll('-', '').slice(0, 12)}`
      if (invalidName(name)) {
        throw new Error(
          'Worktree name must use slash-separated letters, digits, dots, underscores, or dashes and be at most 64 characters',
        )
      }
      const worktreePath = join(root, '.claude', 'worktrees', name)
      const branch = `worktree-${nameFromPath(name)}`
      const baseCommit =
        this.options.baseRef === 'head'
          ? originalHeadCommit
          : ((await gitOptional(root, ['merge-base', 'HEAD', '@{upstream}'])) ??
            originalHeadCommit)
      await mkdir(join(root, '.claude', 'worktrees'), { recursive: true })
      try {
        await git(root, [
          'worktree',
          'add',
          '-b',
          branch,
          worktreePath,
          baseCommit,
        ])
        const gitDirectory = await git(worktreePath, ['rev-parse', '--git-dir'])
        const absoluteGitDirectory = isAbsolute(gitDirectory)
          ? gitDirectory
          : resolve(worktreePath, gitDirectory)
        await writeFile(
          join(absoluteGitDirectory, 'CLAUDE_BASE'),
          `${baseCommit}\n`,
        )
      } catch (error) {
        await execFileAsync(
          'git',
          ['-C', root, 'worktree', 'remove', '--force', worktreePath],
          {
            encoding: 'utf8',
          },
        ).catch(() => undefined)
        await execFileAsync('git', ['-C', root, 'branch', '-D', branch], {
          encoding: 'utf8',
        }).catch(() => undefined)
        throw new Error(
          `Could not create worktree: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      const state: WorktreeSessionState = {
        originalCwd,
        preEnterOriginalCwd: originalCwd,
        worktreePath,
        worktreeName: name,
        worktreeBranch: branch,
        originalBranch,
        originalHeadCommit,
        sessionId: this.options.sessionId,
      }
      this.active = state
      this.createdBySession = true
      this.options.workspace.setCwd(worktreePath)
      const message = `Created worktree at ${worktreePath} on branch ${branch}. The session is now working in the worktree. Use ExitWorktree to leave mid-session, or exit the session to be prompted.`
      this.transition = { callId, state }
      return {
        content: message,
        nativeToolUseResult: {
          worktreePath,
          worktreeBranch: branch,
          message,
        },
      }
    })
  }

  async exit(
    input: { action: 'keep' | 'remove'; discard_changes?: boolean },
    callId: string,
  ): Promise<{
    content: string
    nativeToolUseResult: Record<string, unknown>
  }> {
    return this.withTransition(async () => {
      if (!this.active) {
        const message = 'No active worktree session.'
        this.transition = { callId, state: null }
        return { content: message, nativeToolUseResult: { message } }
      }
      const state = this.active
      if (input.action === 'remove' && !this.createdBySession) {
        throw new Error(
          'This worktree was entered by path and cannot be removed; use action: keep',
        )
      }
      let discardedFiles = 0
      let discardedCommits = 0
      let cleanupWarning: string | undefined
      if (input.action === 'remove') {
        if (!state.worktreeBranch) {
          throw new Error(
            'This worktree was entered by path and cannot be removed; use action: keep',
          )
        }
        const status = await git(state.worktreePath, ['status', '--porcelain'])
        const base = state.originalHeadCommit
        const ahead = Number(
          await git(state.worktreePath, [
            'rev-list',
            '--count',
            `${base}..HEAD`,
          ]),
        )
        if ((status.trim() || ahead > 0) && input.discard_changes !== true) {
          throw new Error(
            `Worktree has changes; use discard_changes: true to remove (${displayChanges(status, ahead)})`,
          )
        }
        discardedFiles = status.split('\n').filter((line) => line.trim()).length
        discardedCommits = ahead
        const repositoryRoot = await this.repositoryRoot(state.originalCwd)
        await git(repositoryRoot, [
          'worktree',
          'remove',
          '--force',
          state.worktreePath,
        ])
        await execFileAsync(
          'git',
          ['-C', repositoryRoot, 'branch', '-D', state.worktreeBranch],
          {
            encoding: 'utf8',
          },
        ).catch((error: unknown) => {
          cleanupWarning = `Worktree removed but branch cleanup failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        })
      }
      this.options.workspace.setCwd(state.originalCwd)
      this.active = null
      this.createdBySession = false
      const message =
        input.action === 'remove'
          ? `Exited and removed worktree at ${state.worktreePath}. Session is now back in ${state.originalCwd}.${cleanupWarning ? ` ${cleanupWarning}` : ''}`
          : `Exited worktree at ${state.worktreePath}. Session is now back in ${state.originalCwd}.`
      this.transition = { callId, state: null }
      return {
        content: message,
        nativeToolUseResult: {
          action: input.action,
          originalCwd: state.originalCwd,
          worktreePath: state.worktreePath,
          worktreeBranch: state.worktreeBranch,
          discardedFiles,
          discardedCommits,
          ...(cleanupWarning ? { cleanupWarning } : {}),
          message,
        },
      }
    })
  }

  private async withTransition<T>(operation: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error('Worktree transition already in progress')
    this.busy = true
    try {
      return await operation()
    } finally {
      this.busy = false
    }
  }

  private async repositoryRoot(cwd: string): Promise<string> {
    try {
      return await git(cwd, ['rev-parse', '--show-toplevel'])
    } catch {
      throw new Error('Worktree isolation requires a Git repository')
    }
  }

  private async enterExisting(
    root: string,
    originalCwd: string,
    originalBranch: string | null,
    originalHeadCommit: string,
    requestedPath: string,
  ): Promise<WorktreeSessionState> {
    const worktreePath = await realpath(resolve(originalCwd, requestedPath))
    const allowedRoot = resolve(root, '.claude', 'worktrees')
    if (!isWithin(allowedRoot, worktreePath)) {
      throw new Error('Worktree path must be inside .claude/worktrees')
    }
    const worktrees = parseWorktrees(
      await git(root, ['worktree', 'list', '--porcelain']),
    )
    const entry = worktrees.find((candidate) => candidate.path === worktreePath)
    if (!entry)
      throw new Error(
        'Worktree path is not registered with the current repository',
      )
    const name = worktreePath.slice(allowedRoot.length + 1)
    if (invalidName(name)) throw new Error('Worktree path has an invalid name')
    return {
      originalCwd,
      preEnterOriginalCwd: originalCwd,
      worktreePath,
      worktreeName: name,
      worktreeBranch: entry.branch,
      originalBranch,
      originalHeadCommit,
      sessionId: this.options.sessionId,
    }
  }
}

function isWithin(root: string, path: string): boolean {
  const relativePath = relative(root, path)
  return (
    relativePath === '' ||
    (!relativePath.startsWith('..') && !isAbsolute(relativePath))
  )
}

async function gitOptional(
  cwd: string,
  args: readonly string[],
): Promise<string | null> {
  try {
    return await git(cwd, args)
  } catch {
    return null
  }
}
