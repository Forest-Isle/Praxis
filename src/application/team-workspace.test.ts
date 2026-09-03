import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { describe, expect, it, vi } from 'vitest'

import { resolveProjectIdentity } from '../platform/project-identity.js'
import { sanitizeProjectPath } from '../platform/project-path-key.js'
import { inspectManagedWorktreeRegistry } from '../persistence/managed-worktree-store.js'
import type { ManagedWorktreeHooks } from './managed-worktree.js'
import { NativeTeamWorkspaceProvider } from './team-workspace.js'

const exec = promisify(execFile)

async function git(cwd: string, ...args: string[]): Promise<void> {
  await exec('git', ['-C', cwd, ...args])
}

async function gitOutput(cwd: string, ...args: string[]): Promise<string> {
  return (await exec('git', ['-C', cwd, ...args])).stdout.trim()
}

function teamInput(
  overrides: Partial<{
    teamId: string
    taskId: string
    generation: number
    access: 'read-only' | 'write'
    leadSessionId: string
    executionToken: string
  }> = {},
) {
  return {
    teamId: 'team-a',
    taskId: 'task-a',
    generation: 1,
    access: 'write' as const,
    leadSessionId: 'lead',
    executionToken: 'token-a',
    ...overrides,
  }
}

function teamPaths(
  identity: string,
  nativeRoot: string,
  input: ReturnType<typeof teamInput>,
) {
  const hash = createHash('sha256')
    .update(
      `${identity}\0${input.teamId}\0${input.taskId}\0${input.generation}`,
    )
    .digest('hex')
    .slice(0, 24)
  return {
    hash,
    branch: `praxis/team/${input.teamId}/${hash}`,
    managed: join(identity, '.praxis', 'worktrees', 'team', input.teamId, hash),
    legacy: join(
      nativeRoot,
      'state',
      'team-worktrees',
      sanitizeProjectPath(identity),
      input.teamId,
      hash,
    ),
  }
}

async function repository(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'praxis-team-workspace-'))
  await git(cwd, 'init', '-q')
  await git(cwd, 'config', 'user.email', 'praxis@example.test')
  await git(cwd, 'config', 'user.name', 'Praxis Test')
  await exec('sh', ['-c', 'printf seed > "$1/seed.txt"', '--', cwd])
  await git(cwd, 'add', 'seed.txt')
  await git(cwd, 'commit', '-qm', 'seed')
  return cwd
}

describe('NativeTeamWorkspaceProvider', () => {
  it('shares read-only roots and retains deterministic write worktrees', async () => {
    const cwd = await repository()
    const nativeRoot = await mkdtemp(join(tmpdir(), 'praxis-team-native-'))
    try {
      const identity = await resolveProjectIdentity(cwd)
      const provider = await NativeTeamWorkspaceProvider.open({
        nativeRoot,
        cwd,
        projectIdentity: identity,
      })
      await expect(
        provider.acquire({
          teamId: 'team-a',
          taskId: 'read',
          generation: 1,
          access: 'read-only',
          leadSessionId: 'lead',
          executionToken: 'token',
        }),
      ).resolves.toMatchObject({ cwd: await realpath(cwd), branch: null })
      const writeInput = {
        teamId: 'team-a',
        taskId: 'write',
        generation: 1,
        access: 'write',
        leadSessionId: 'lead',
        executionToken: 'token',
      } as const
      const first = await provider.acquire(writeInput)
      expect(first.branch).toMatch(/^praxis\/team\/team-a\/[0-9a-f]{24}$/u)
      if (!first.branch) throw new Error('Expected Team write branch')
      const hash = first.branch.slice(first.branch.lastIndexOf('/') + 1)
      expect(first.cwd).toBe(
        join(identity, '.praxis', 'worktrees', 'team', 'team-a', hash),
      )
      await expect(provider.acquire(writeInput)).resolves.toEqual(first)
      await first.retain('test retention')
      const fresh = await NativeTeamWorkspaceProvider.open({
        nativeRoot,
        cwd,
        projectIdentity: identity,
      })
      await expect(fresh.acquire(writeInput)).resolves.toMatchObject({
        cwd: first.cwd,
        branch: first.branch,
      })
      await fresh.releaseAccepted(writeInput)
      await expect(lstat(first.cwd)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(cwd, { recursive: true, force: true })
      await rm(nativeRoot, { recursive: true, force: true })
    }
  })

  it('keeps a linked worktree as the read-only invocation checkout', async () => {
    const main = await repository()
    const linked = await mkdtemp(join(tmpdir(), 'praxis-team-linked-'))
    const nativeRoot = await mkdtemp(join(tmpdir(), 'praxis-team-native-'))
    await rm(linked, { recursive: true, force: true })
    try {
      await git(main, 'worktree', 'add', '-q', '-b', 'linked-fixture', linked)
      const identity = await resolveProjectIdentity(linked)
      expect(identity).toBe(await realpath(main))
      const provider = await NativeTeamWorkspaceProvider.open({
        nativeRoot,
        cwd: linked,
        projectIdentity: identity,
      })

      await expect(
        provider.acquire({
          teamId: 'team-linked',
          taskId: 'read',
          generation: 1,
          access: 'read-only',
          leadSessionId: 'lead',
          executionToken: 'token',
        }),
      ).resolves.toMatchObject({ cwd: await realpath(linked), branch: null })
    } finally {
      await rm(linked, { recursive: true, force: true })
      await rm(main, { recursive: true, force: true })
      await rm(nativeRoot, { recursive: true, force: true })
    }
  })

  it('rejects symlinked deterministic paths without cleanup', async () => {
    const cwd = await repository()
    const nativeRoot = await mkdtemp(join(tmpdir(), 'praxis-team-native-'))
    try {
      const identity = await resolveProjectIdentity(cwd)
      const provider = await NativeTeamWorkspaceProvider.open({
        nativeRoot,
        cwd,
        projectIdentity: identity,
      })
      const hash = (await import('node:crypto'))
        .createHash('sha256')
        .update(`${identity}\0team-a\0write\0${1}`)
        .digest('hex')
        .slice(0, 24)
      const path = join(
        nativeRoot,
        'state',
        'team-worktrees',
        identity.replace(/[^a-zA-Z0-9]/g, '-'),
        'team-a',
        hash,
      )
      const target = await mkdtemp(join(tmpdir(), 'praxis-team-target-'))
      await mkdir(join(path, '..'), { recursive: true })
      await symlink(target, path)
      await expect(
        provider.acquire({
          teamId: 'team-a',
          taskId: 'write',
          generation: 1,
          access: 'write',
          leadSessionId: 'lead',
          executionToken: 'token',
        }),
      ).rejects.toThrow(/symlink/u)
      await rm(target, { recursive: true, force: true })
    } finally {
      await rm(cwd, { recursive: true, force: true })
      await rm(nativeRoot, { recursive: true, force: true })
    }
  })

  it('shares identical concurrent write acquires and registers one checkout', async () => {
    const cwd = await repository()
    const nativeRoot = await mkdtemp(join(tmpdir(), 'praxis-team-native-'))
    try {
      const identity = await resolveProjectIdentity(cwd)
      const provider = await NativeTeamWorkspaceProvider.open({
        nativeRoot,
        cwd,
        projectIdentity: identity,
      })
      const input = teamInput()
      const [first, second] = await Promise.all([
        provider.acquire(input),
        provider.acquire(input),
      ])
      expect(first).toBe(second)
      expect(
        (await gitOutput(cwd, 'worktree', 'list', '--porcelain'))
          .split('\n')
          .filter((line) => line.startsWith(`worktree ${first.cwd}`)),
      ).toHaveLength(1)
      await first.retain('concurrent test retention')
    } finally {
      await rm(cwd, { recursive: true, force: true })
      await rm(nativeRoot, { recursive: true, force: true })
    }
  })

  it('derives distinct exact identities for generations', async () => {
    const cwd = await repository()
    const nativeRoot = await mkdtemp(join(tmpdir(), 'praxis-team-native-'))
    try {
      const identity = await resolveProjectIdentity(cwd)
      const provider = await NativeTeamWorkspaceProvider.open({
        nativeRoot,
        cwd,
        projectIdentity: identity,
      })
      const firstInput = teamInput({ generation: 1 })
      const secondInput = teamInput({ generation: 2 })
      const first = await provider.acquire(firstInput)
      const second = await provider.acquire(secondInput)
      const firstPaths = teamPaths(identity, nativeRoot, firstInput)
      const secondPaths = teamPaths(identity, nativeRoot, secondInput)
      expect(first).toMatchObject({
        cwd: firstPaths.managed,
        branch: firstPaths.branch,
      })
      expect(second).toMatchObject({
        cwd: secondPaths.managed,
        branch: secondPaths.branch,
      })
      expect(first.cwd).not.toBe(second.cwd)
      await first.retain('generation one retention')
      await second.retain('generation two retention')
    } finally {
      await rm(cwd, { recursive: true, force: true })
      await rm(nativeRoot, { recursive: true, force: true })
    }
  })

  it('rejects mismatched owner after retain and permits original explicit release', async () => {
    const cwd = await repository()
    const nativeRoot = await mkdtemp(join(tmpdir(), 'praxis-team-native-'))
    try {
      const identity = await resolveProjectIdentity(cwd)
      const provider = await NativeTeamWorkspaceProvider.open({
        nativeRoot,
        cwd,
        projectIdentity: identity,
      })
      const original = teamInput({ executionToken: 'original' })
      const workspace = await provider.acquire(original)
      await workspace.retain('owner mismatch retention')
      const fresh = await NativeTeamWorkspaceProvider.open({
        nativeRoot,
        cwd,
        projectIdentity: identity,
      })
      await expect(
        fresh.acquire({ ...original, executionToken: 'other' }),
      ).rejects.toThrow(/ownership evidence/u)
      await fresh.releaseAccepted(original)
      await expect(lstat(workspace.cwd)).rejects.toMatchObject({
        code: 'ENOENT',
      })
    } finally {
      await rm(cwd, { recursive: true, force: true })
      await rm(nativeRoot, { recursive: true, force: true })
    }
  })

  it('rejects managed and legacy collisions before changing either path', async () => {
    const cwd = await repository()
    const nativeRoot = await mkdtemp(join(tmpdir(), 'praxis-team-native-'))
    try {
      const identity = await resolveProjectIdentity(cwd)
      const provider = await NativeTeamWorkspaceProvider.open({
        nativeRoot,
        cwd,
        projectIdentity: identity,
      })
      const input = teamInput({ taskId: 'collision' })
      const workspace = await provider.acquire(input)
      await workspace.retain('collision retention')
      const paths = teamPaths(identity, nativeRoot, input)
      await mkdir(paths.legacy, { recursive: true })
      await expect(provider.acquire(input)).rejects.toThrow(/Ambiguous/u)
      await expect(provider.releaseAccepted(input)).rejects.toThrow(
        /Ambiguous/u,
      )
      await stat(paths.managed)
      await stat(paths.legacy)
      await rm(paths.legacy, { recursive: true, force: true })
      await provider.releaseAccepted(input)
    } finally {
      await rm(cwd, { recursive: true, force: true })
      await rm(nativeRoot, { recursive: true, force: true })
    }
  })

  it('force-removes dirty committed managed worktree and exact branch', async () => {
    const cwd = await repository()
    const nativeRoot = await mkdtemp(join(tmpdir(), 'praxis-team-native-'))
    try {
      const identity = await resolveProjectIdentity(cwd)
      const provider = await NativeTeamWorkspaceProvider.open({
        nativeRoot,
        cwd,
        projectIdentity: identity,
      })
      const input = teamInput({ taskId: 'dirty-release' })
      const workspace = await provider.acquire(input)
      await writeFile(join(workspace.cwd, 'committed.txt'), 'committed')
      await git(workspace.cwd, 'add', 'committed.txt')
      await git(workspace.cwd, 'commit', '-qm', 'committed')
      await writeFile(join(workspace.cwd, 'dirty.txt'), 'dirty')
      await provider.releaseAccepted(input)
      await expect(lstat(workspace.cwd)).rejects.toMatchObject({
        code: 'ENOENT',
      })
      await expect(
        gitOutput(
          cwd,
          'show-ref',
          '--verify',
          `refs/heads/${workspace.branch}`,
        ),
      ).rejects.toThrow()
    } finally {
      await rm(cwd, { recursive: true, force: true })
      await rm(nativeRoot, { recursive: true, force: true })
    }
  })

  it('runs managed create/remove hooks and preserves a blocked release', async () => {
    const cwd = await repository()
    const nativeRoot = await mkdtemp(join(tmpdir(), 'praxis-team-native-'))
    try {
      const events: string[] = []
      let block = true
      const hooksFactory = (): ManagedWorktreeHooks => ({
        afterCreate: async () => {
          events.push('create')
          return {}
        },
        beforeRemove: async () =>
          block ? { blockedReason: 'blocked' } : (events.push('remove'), {}),
      })
      const identity = await resolveProjectIdentity(cwd)
      const provider = await NativeTeamWorkspaceProvider.open({
        nativeRoot,
        cwd,
        projectIdentity: identity,
        hooksFactory,
      })
      const input = teamInput({ taskId: 'hooks' })
      const workspace = await provider.acquire(input)
      expect(events).toEqual(['create'])
      await workspace.retain('hook retry retention')
      await expect(provider.releaseAccepted(input)).rejects.toThrow(/blocked/u)
      await stat(workspace.cwd)
      block = false
      const retry = await NativeTeamWorkspaceProvider.open({
        nativeRoot,
        cwd,
        projectIdentity: identity,
        hooksFactory,
      })
      await retry.releaseAccepted(input)
      expect(events).toEqual(['create', 'remove'])
    } finally {
      await rm(cwd, { recursive: true, force: true })
      await rm(nativeRoot, { recursive: true, force: true })
    }
  })

  it('restores and releases an existing strict legacy worktree without hooks', async () => {
    const cwd = await repository()
    const nativeRoot = await mkdtemp(join(tmpdir(), 'praxis-team-native-'))
    try {
      const identity = await resolveProjectIdentity(cwd)
      const input = teamInput({ taskId: 'legacy' })
      const paths = teamPaths(identity, nativeRoot, input)
      await mkdir(resolve(paths.legacy, '..'), { recursive: true })
      await git(
        cwd,
        'worktree',
        'add',
        '-q',
        '-b',
        paths.branch,
        paths.legacy,
        'HEAD',
      )
      const hooksFactory = vi.fn((): ManagedWorktreeHooks => ({
        afterCreate: async () => ({}),
        beforeRemove: async () => ({}),
      }))
      const provider = await NativeTeamWorkspaceProvider.open({
        nativeRoot,
        cwd,
        projectIdentity: identity,
        hooksFactory,
      })
      const workspace = await provider.acquire(input)
      expect(workspace).toMatchObject({
        cwd: await realpath(paths.legacy),
        branch: paths.branch,
      })
      await workspace.retain('legacy no-op')
      await provider.releaseAccepted(input)
      expect(hooksFactory).not.toHaveBeenCalled()
      await expect(lstat(paths.legacy)).rejects.toMatchObject({
        code: 'ENOENT',
      })
      await expect(
        gitOutput(cwd, 'show-ref', '--verify', `refs/heads/${paths.branch}`),
      ).rejects.toThrow()
    } finally {
      await rm(cwd, { recursive: true, force: true })
      await rm(nativeRoot, { recursive: true, force: true })
    }
  })

  it('rejects a managed deterministic symlink without touching its target', async () => {
    const cwd = await repository()
    const nativeRoot = await mkdtemp(join(tmpdir(), 'praxis-team-native-'))
    try {
      const identity = await resolveProjectIdentity(cwd)
      const input = teamInput({ taskId: 'managed-link' })
      const paths = teamPaths(identity, nativeRoot, input)
      const target = await mkdtemp(join(tmpdir(), 'praxis-team-target-'))
      await mkdir(resolve(paths.managed, '..'), { recursive: true })
      await symlink(target, paths.managed)
      const provider = await NativeTeamWorkspaceProvider.open({
        nativeRoot,
        cwd,
        projectIdentity: identity,
      })
      await expect(provider.acquire(input)).rejects.toThrow(/symlink/u)
      await stat(target)
      await rm(target, { recursive: true, force: true })
    } finally {
      await rm(cwd, { recursive: true, force: true })
      await rm(nativeRoot, { recursive: true, force: true })
    }
  })

  it('persists exact retained Team ownership evidence in the managed registry', async () => {
    const cwd = await repository()
    const nativeRoot = await mkdtemp(join(tmpdir(), 'praxis-team-native-'))
    try {
      const identity = await resolveProjectIdentity(cwd)
      const provider = await NativeTeamWorkspaceProvider.open({
        nativeRoot,
        cwd,
        projectIdentity: identity,
      })
      const input = teamInput({ taskId: 'registry' })
      const workspace = await provider.acquire(input)
      await workspace.retain('registry retention')
      const paths = teamPaths(identity, nativeRoot, input)
      const registry = await inspectManagedWorktreeRegistry({
        stateRoot: nativeRoot,
        repositoryRoot: identity,
        limit: 64,
      })
      const record = registry.entries.find(
        (entry) =>
          'record' in entry && entry.record.worktreePath === paths.managed,
      )
      expect(
        record && 'record' in record ? record.record : undefined,
      ).toMatchObject({
        kind: 'team',
        policy: 'durable',
        ownerId: `team:${input.teamId}:${input.generation}:${paths.hash}:${input.executionToken}`,
        worktreePath: paths.managed,
        branch: paths.branch,
        state: 'retained',
      })
    } finally {
      await rm(cwd, { recursive: true, force: true })
      await rm(nativeRoot, { recursive: true, force: true })
    }
  })
})
