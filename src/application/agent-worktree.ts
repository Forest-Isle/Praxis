import { execFile } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'

import {
  createOwnedManagedWorktree,
  restoreManagedWorktree,
  restoreOwnedManagedWorktree,
  type ManagedWorktree,
} from './managed-worktree.js'
import {
  createManagedWorktreeHooks,
  type ManagedWorktreeHookContext,
} from './managed-worktree-hooks.js'
import { resolveProjectIdentity } from '../platform/project-identity.js'

const execFileAsync = promisify(execFile)

function agentWorktreeDirectoryName(
  sessionId: string,
  agentId: string,
): string {
  return `${sessionId}-${agentId}`
}

export async function createAgentWorktree(options: {
  cwd: string
  stateRoot: string
  sessionId: string
  agentId: string
  executionToken: string
  hookContext?: ManagedWorktreeHookContext
}): Promise<ManagedWorktree> {
  return createOwnedManagedWorktree({
    cwd: options.cwd,
    stateRoot: options.stateRoot,
    directoryName: agentWorktreeDirectoryName(
      options.sessionId,
      options.agentId,
    ),
    ownerId: `agent:${options.sessionId}:${options.agentId}:${options.executionToken}`,
    label: 'Agent',
    kind: 'agent',
    policy: 'ephemeral',
    ...(options.hookContext
      ? { hooks: createManagedWorktreeHooks(options.hookContext) }
      : {}),
  })
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  return (
    await execFileAsync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  ).stdout.trim()
}

async function assertLegacyPath(options: {
  cwd: string
  path: string
  expectedPath: string
}): Promise<void> {
  if (
    !isAbsolute(options.path) ||
    options.path.includes('\0') ||
    resolve(options.path) !== options.expectedPath
  ) {
    throw new Error('retained Agent worktree path is not the legacy path')
  }
  const entry = await lstat(options.path)
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error('retained Agent worktree must be a real directory')
  }
  const canonicalPath = await realpath(options.path)
  const repositoryRoot = await resolveProjectIdentity(options.cwd)
  if (repositoryRoot !== (await resolveProjectIdentity(options.path))) {
    throw new Error(
      'retained Agent worktree repository identity does not match',
    )
  }
  const registrations = await git(options.cwd, [
    'worktree',
    'list',
    '--porcelain',
    '-z',
  ])
  const registered = registrations
    .split('\0')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => resolve(repositoryRoot, line.slice('worktree '.length)))
  if (
    !registered.includes(options.path) &&
    !registered.includes(canonicalPath)
  ) {
    throw new Error('retained Agent worktree is not registered')
  }
}

export async function restoreAgentWorktree(options: {
  cwd: string
  stateRoot: string
  sessionId: string
  agentId: string
  path: string
  hookContext?: ManagedWorktreeHookContext
}): Promise<ManagedWorktree> {
  if (!isAbsolute(options.path) || options.path.includes('\0')) {
    throw new Error('retained Agent worktree path is invalid')
  }
  const managedPath = join(
    await resolveProjectIdentity(options.cwd),
    '.praxis',
    'worktrees',
    'agent',
    agentWorktreeDirectoryName(options.sessionId, options.agentId),
  )
  const path = resolve(options.path)
  if (path === managedPath) {
    return restoreOwnedManagedWorktree({
      cwd: options.cwd,
      stateRoot: options.stateRoot,
      path,
      directoryName: agentWorktreeDirectoryName(
        options.sessionId,
        options.agentId,
      ),
      ownerPrefix: `agent:${options.sessionId}:${options.agentId}:`,
      label: 'Agent',
      kind: 'agent',
      policy: 'ephemeral',
      ...(options.hookContext
        ? { hooks: createManagedWorktreeHooks(options.hookContext) }
        : {}),
    })
  }
  const legacyPath = join(
    resolve(options.stateRoot),
    'agent-worktrees',
    agentWorktreeDirectoryName(options.sessionId, options.agentId),
  )
  if (path !== legacyPath) {
    throw new Error('retained Agent worktree path is not an accepted path')
  }
  await assertLegacyPath({
    cwd: options.cwd,
    path,
    expectedPath: legacyPath,
  })
  return restoreManagedWorktree({ cwd: options.cwd, path, label: 'Agent' })
}
