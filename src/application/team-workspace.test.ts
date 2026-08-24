import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

import { resolveProjectIdentity } from '../platform/project-identity.js'
import { NativeTeamWorkspaceProvider } from './team-workspace.js'

const exec = promisify(execFile)

async function git(cwd: string, ...args: string[]): Promise<void> {
  await exec('git', ['-C', cwd, ...args])
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
        }),
      ).resolves.toEqual({ cwd: await realpath(cwd), branch: null })
      const first = await provider.acquire({
        teamId: 'team-a',
        taskId: 'write',
        generation: 1,
        access: 'write',
      })
      expect(first.branch).toMatch(/^praxis\/team\/team-a\/[0-9a-f]{24}$/u)
      await expect(
        provider.acquire({
          teamId: 'team-a',
          taskId: 'write',
          generation: 1,
          access: 'write',
        }),
      ).resolves.toEqual(first)
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
        }),
      ).resolves.toEqual({ cwd: await realpath(linked), branch: null })
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
        }),
      ).rejects.toThrow(/symlink/u)
      await rm(target, { recursive: true, force: true })
    } finally {
      await rm(cwd, { recursive: true, force: true })
      await rm(nativeRoot, { recursive: true, force: true })
    }
  })
})
