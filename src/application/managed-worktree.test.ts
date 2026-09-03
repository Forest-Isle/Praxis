import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { ManagedWorktreeStore } from '../persistence/managed-worktree-store.js'
import { resolveProjectIdentity } from '../platform/project-identity.js'
import { sanitizeProjectPath } from '../platform/project-path-key.js'
import {
  createOwnedManagedWorktree,
  type OwnedManagedWorktreeOptions,
} from './managed-worktree.js'

const execFileAsync = promisify(execFile)
const roots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  )
})

async function repository() {
  const root = await mkdtemp(join(tmpdir(), 'praxis-managed-git-'))
  roots.push(root)
  const repositoryRoot = join(root, 'repo')
  const stateRoot = join(root, 'state')
  await execFileAsync('git', ['init', repositoryRoot])
  await writeFile(join(repositoryRoot, 'tracked.txt'), 'base\n')
  await execFileAsync('git', ['-C', repositoryRoot, 'add', 'tracked.txt'])
  await execFileAsync('git', [
    '-C',
    repositoryRoot,
    '-c',
    'user.name=Praxis Test',
    '-c',
    'user.email=praxis@example.invalid',
    'commit',
    '-m',
    'fixture',
  ])
  return { root, repositoryRoot, stateRoot }
}

function ownedOptions(
  fixture: Awaited<ReturnType<typeof repository>>,
  overrides: Partial<OwnedManagedWorktreeOptions> = {},
): OwnedManagedWorktreeOptions {
  return {
    cwd: fixture.repositoryRoot,
    stateRoot: fixture.stateRoot,
    directoryName: 'run-1-agent-1',
    ownerId: 'workflow:run-1:agent-1',
    label: 'Workflow',
    kind: 'workflow',
    policy: 'ephemeral',
    ...overrides,
  }
}

async function recordPath(
  fixture: Awaited<ReturnType<typeof repository>>,
  ownerId: string,
  kind: OwnedManagedWorktreeOptions['kind'] = 'workflow',
) {
  const identity = await resolveProjectIdentity(fixture.repositoryRoot)
  const worktreeId = createHash('sha256')
    .update(`${identity}\0${kind}\0${ownerId}`)
    .digest('hex')
  return {
    identity,
    worktreeId,
    path: join(
      fixture.stateRoot,
      'managed-worktrees',
      sanitizeProjectPath(identity),
      `${worktreeId}.json`,
    ),
  }
}

async function gitDirectory(worktreePath: string) {
  const value = (
    await execFileAsync('git', ['-C', worktreePath, 'rev-parse', '--git-dir'])
  ).stdout.trim()
  return isAbsolute(value) ? value : resolve(worktreePath, value)
}

describe('createOwnedManagedWorktree', () => {
  it('publishes matching ownership, marker, and local ignore before returning', async () => {
    const fixture = await repository()
    const options = ownedOptions(fixture)
    const worktree = await createOwnedManagedWorktree(options)
    const owned = await recordPath(fixture, options.ownerId, options.kind)

    expect(worktree.cwd).toBe(
      join(
        owned.identity,
        '.praxis',
        'worktrees',
        'workflow',
        options.directoryName,
      ),
    )
    const record = JSON.parse(await readFile(owned.path, 'utf8')) as Record<
      string,
      unknown
    >
    expect(record).toMatchObject({
      version: 1,
      worktreeId: owned.worktreeId,
      ownerId: options.ownerId,
      repositoryRoot: owned.identity,
      worktreePath: worktree.cwd,
      state: 'active',
    })
    expect((await lstat(owned.path)).mode & 0o777).toBe(0o600)
    expect(
      JSON.parse(
        await readFile(
          join(await gitDirectory(worktree.cwd), 'PRAXIS_WORKTREE'),
          'utf8',
        ),
      ),
    ).toEqual({
      version: 1,
      worktreeId: owned.worktreeId,
      repositoryRoot: owned.identity,
    })
    expect(
      (
        await execFileAsync('git', [
          '-C',
          fixture.repositoryRoot,
          'status',
          '--porcelain',
          '--untracked-files=all',
        ])
      ).stdout,
    ).toBe('')

    await expect(
      Promise.all([worktree.cleanup(), worktree.cleanup()]),
    ).resolves.toEqual([{ retained: false }, { retained: false }])
    expect(await worktree.cleanup()).toEqual({ retained: false })
    expect((await JSON.parse(await readFile(owned.path, 'utf8'))).state).toBe(
      'released',
    )
  })

  it('keeps the ignore entry idempotent across managed checkouts', async () => {
    const fixture = await repository()
    const first = await createOwnedManagedWorktree(ownedOptions(fixture))
    const second = await createOwnedManagedWorktree(
      ownedOptions(fixture, {
        directoryName: 'run-2-agent-2',
        ownerId: 'workflow:run-2:agent-2',
      }),
    )
    const excludeValue = (
      await execFileAsync('git', [
        '-C',
        fixture.repositoryRoot,
        'rev-parse',
        '--git-path',
        'info/exclude',
      ])
    ).stdout.trim()
    const excludePath = isAbsolute(excludeValue)
      ? excludeValue
      : resolve(fixture.repositoryRoot, excludeValue)
    const matches = (await readFile(excludePath, 'utf8'))
      .split(/\r?\n/u)
      .filter((line) => line === '/.praxis/worktrees/')

    expect(matches).toHaveLength(1)
    await first.cleanup()
    await second.cleanup()
  })

  it('fails closed on marker, record, and registration mismatches', async () => {
    const cases = ['marker', 'record', 'registration'] as const
    for (const mismatch of cases) {
      const fixture = await repository()
      const options = ownedOptions(fixture, {
        directoryName: `run-${mismatch}`,
        ownerId: `workflow:run-${mismatch}:agent`,
      })
      const worktree = await createOwnedManagedWorktree(options)
      const owned = await recordPath(fixture, options.ownerId)
      if (mismatch === 'marker') {
        await writeFile(
          join(await gitDirectory(worktree.cwd), 'PRAXIS_WORKTREE'),
          `${JSON.stringify({ version: 1, worktreeId: owned.worktreeId, repositoryRoot: '/different/repository' })}\n`,
        )
      } else if (mismatch === 'record') {
        const record = JSON.parse(await readFile(owned.path, 'utf8')) as Record<
          string,
          unknown
        >
        await writeFile(
          owned.path,
          `${JSON.stringify({ ...record, ownerId: 'workflow:different:owner' })}\n`,
        )
      } else {
        await execFileAsync('git', [
          '-C',
          fixture.repositoryRoot,
          'worktree',
          'remove',
          worktree.cwd,
        ])
        await mkdir(worktree.cwd, { recursive: true })
        await writeFile(join(worktree.cwd, 'external.txt'), 'preserve\n')
      }

      const result = await worktree.cleanup()

      expect(result.retained).toBe(true)
      expect(result.reason).toMatch(
        mismatch === 'record'
          ? /ownership record does not match/u
          : mismatch === 'marker'
            ? /marker/u
            : /not registered|registered worktree root does not match/u,
      )
      await expect(stat(worktree.cwd)).resolves.toBeDefined()
      if (mismatch === 'registration') {
        expect(await readFile(join(worktree.cwd, 'external.txt'), 'utf8')).toBe(
          'preserve\n',
        )
      }
    }
  })

  it('retains a corrupt record without removing its checkout', async () => {
    const fixture = await repository()
    const options = ownedOptions(fixture)
    const worktree = await createOwnedManagedWorktree(options)
    const owned = await recordPath(fixture, options.ownerId)
    await writeFile(owned.path, '{not-json\n')

    const result = await worktree.cleanup()

    expect(result).toMatchObject({ retained: true })
    expect(result.reason).toContain('record')
    expect(await readFile(join(worktree.cwd, 'tracked.txt'), 'utf8')).toBe(
      'base\n',
    )
  })

  it('retries cleanup from retained and interrupted releasing records', async () => {
    for (const state of ['retained', 'releasing'] as const) {
      const fixture = await repository()
      const options = ownedOptions(fixture, {
        directoryName: `run-${state}`,
        ownerId: `workflow:run-${state}:agent`,
      })
      const worktree = await createOwnedManagedWorktree(options)
      const owned = await recordPath(fixture, options.ownerId)
      const record = JSON.parse(await readFile(owned.path, 'utf8')) as Record<
        string,
        unknown
      >
      await writeFile(
        owned.path,
        `${JSON.stringify({
          ...record,
          state,
          updatedAt: new Date().toISOString(),
          ...(state === 'retained' ? { retentionReason: 'retry' } : {}),
        })}\n`,
      )

      await expect(worktree.cleanup()).resolves.toEqual({ retained: false })
      expect((await JSON.parse(await readFile(owned.path, 'utf8'))).state).toBe(
        'released',
      )
    }
  })

  it('never removes an existing symlink target after partial creation fails', async () => {
    const fixture = await repository()
    const options = ownedOptions(fixture)
    const external = join(fixture.root, 'external')
    const target = join(
      fixture.repositoryRoot,
      '.praxis',
      'worktrees',
      'workflow',
      options.directoryName,
    )
    await mkdir(external)
    await writeFile(join(external, 'sentinel.txt'), 'preserve\n')
    await mkdir(resolve(target, '..'), { recursive: true })
    await symlink(external, target, 'dir')

    await expect(createOwnedManagedWorktree(options)).rejects.toThrow(
      /symlink/u,
    )

    expect((await lstat(target)).isSymbolicLink()).toBe(true)
    expect(await readFile(join(external, 'sentinel.txt'), 'utf8')).toBe(
      'preserve\n',
    )
    const owned = await recordPath(fixture, options.ownerId)
    expect((await JSON.parse(await readFile(owned.path, 'utf8'))).state).toBe(
      'retained',
    )
  })

  it('rolls back only a marker-proven checkout when activation persistence fails', async () => {
    const fixture = await repository()
    const options = ownedOptions(fixture)
    vi.spyOn(ManagedWorktreeStore.prototype, 'update').mockRejectedValueOnce(
      new Error('simulated activation failure'),
    )
    const owned = await recordPath(fixture, options.ownerId)
    const target = join(
      owned.identity,
      '.praxis',
      'worktrees',
      'workflow',
      options.directoryName,
    )

    await expect(createOwnedManagedWorktree(options)).rejects.toThrow(
      'simulated activation failure',
    )

    await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await JSON.parse(await readFile(owned.path, 'utf8'))).state).toBe(
      'released',
    )
    expect(
      (
        await execFileAsync('git', [
          '-C',
          fixture.repositoryRoot,
          'worktree',
          'list',
          '--porcelain',
        ])
      ).stdout,
    ).not.toContain(target)
  })

  it('rejects symlinked managed parents and Git exclude files without following them', async () => {
    const parentFixture = await repository()
    const externalParent = join(parentFixture.root, 'external-praxis')
    await mkdir(externalParent)
    await symlink(
      externalParent,
      join(parentFixture.repositoryRoot, '.praxis'),
      'dir',
    )
    await expect(
      createOwnedManagedWorktree(ownedOptions(parentFixture)),
    ).rejects.toThrow(/symlink/u)

    const excludeFixture = await repository()
    const excludeValue = (
      await execFileAsync('git', [
        '-C',
        excludeFixture.repositoryRoot,
        'rev-parse',
        '--git-path',
        'info/exclude',
      ])
    ).stdout.trim()
    const excludePath = isAbsolute(excludeValue)
      ? excludeValue
      : resolve(excludeFixture.repositoryRoot, excludeValue)
    const externalExclude = join(excludeFixture.root, 'external-exclude')
    await writeFile(externalExclude, '/.praxis/worktrees/\n')
    await rm(excludePath)
    await symlink(externalExclude, excludePath)

    await expect(
      createOwnedManagedWorktree(ownedOptions(excludeFixture)),
    ).rejects.toThrow(/exclude must be a regular file/u)
    expect(await readFile(externalExclude, 'utf8')).toBe(
      '/.praxis/worktrees/\n',
    )
  })

  it('serializes different owners racing for the same checkout path', async () => {
    const fixture = await repository()
    const results = await Promise.allSettled([
      createOwnedManagedWorktree(ownedOptions(fixture)),
      createOwnedManagedWorktree(
        ownedOptions(fixture, { ownerId: 'workflow:other:agent' }),
      ),
    ])
    const fulfilled = results.filter((result) => result.status === 'fulfilled')
    const rejected = results.filter((result) => result.status === 'rejected')

    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(String(rejected[0]?.reason)).toContain('already owned')
    const winner = fulfilled[0]
    if (winner?.status === 'fulfilled') {
      await expect(stat(winner.value.cwd)).resolves.toBeDefined()
      await winner.value.cleanup()
    }
  })

  it('retains durable-policy worktrees on ordinary cleanup', async () => {
    const fixture = await repository()
    const options = ownedOptions(fixture, {
      directoryName: 'team-generation',
      ownerId: 'team:one:generation',
      label: 'Team',
      kind: 'team',
      policy: 'durable',
    })
    const worktree = await createOwnedManagedWorktree(options)

    const result = await worktree.cleanup()

    expect(result).toMatchObject({
      retained: true,
      reason: expect.stringContaining('durable retention policy'),
    })
    await expect(stat(worktree.cwd)).resolves.toBeDefined()
    const owned = await recordPath(fixture, options.ownerId, 'team')
    expect((await JSON.parse(await readFile(owned.path, 'utf8'))).state).toBe(
      'retained',
    )
  })

  it("uses a linked caller's exact HEAD while storing under the canonical repository", async () => {
    const fixture = await repository()
    const firstHead = (
      await execFileAsync('git', [
        '-C',
        fixture.repositoryRoot,
        'rev-parse',
        'HEAD',
      ])
    ).stdout.trim()
    await writeFile(join(fixture.repositoryRoot, 'tracked.txt'), 'main-head\n')
    await execFileAsync('git', [
      '-C',
      fixture.repositoryRoot,
      '-c',
      'user.name=Praxis Test',
      '-c',
      'user.email=praxis@example.invalid',
      'commit',
      '-am',
      'main head',
    ])
    const linked = join(fixture.root, 'linked')
    await execFileAsync('git', [
      '-C',
      fixture.repositoryRoot,
      'worktree',
      'add',
      '--detach',
      linked,
      firstHead,
    ])

    const worktree = await createOwnedManagedWorktree(
      ownedOptions(fixture, {
        cwd: linked,
        directoryName: 'linked-head',
        ownerId: 'workflow:linked:agent',
      }),
    )

    const identity = await resolveProjectIdentity(linked)
    expect(worktree.cwd.startsWith(`${identity}/.praxis/`)).toBe(true)
    expect(await readFile(join(worktree.cwd, 'tracked.txt'), 'utf8')).toBe(
      'base\n',
    )
    expect(
      (
        await execFileAsync('git', ['-C', worktree.cwd, 'rev-parse', 'HEAD'])
      ).stdout.trim(),
    ).toBe(firstHead)
    await worktree.cleanup()
  })
})
