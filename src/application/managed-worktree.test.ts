import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  lstat,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  ManagedWorktreeStore,
  type ManagedWorktreeRecord,
} from '../persistence/managed-worktree-store.js'
import { resolveProjectIdentity } from '../platform/project-identity.js'
import { sanitizeProjectPath } from '../platform/project-path-key.js'
import {
  createOwnedManagedWorktree,
  reconcileManagedWorktrees,
  type ManagedWorktreeHookOutcome,
  type ManagedWorktreeHooks,
  type ManagedWorktreeRemoveHookInput,
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

function reconcileHooks(
  beforeRemove: ManagedWorktreeHooks['beforeRemove'],
): ManagedWorktreeHooks {
  return { afterCreate: async () => ({}), beforeRemove }
}

function requiredBranch(record: ManagedWorktreeRecord): string {
  if (record.branch === null) throw new Error('expected branch-backed fixture')
  return record.branch
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

async function abandonedRecord(
  fixture: Awaited<ReturnType<typeof repository>>,
  overrides: Partial<ManagedWorktreeRecord> = {},
  checkout: 'detached' | 'branch' | 'none' = 'detached',
) {
  const ownerId = overrides.ownerId ?? 'workflow:abandoned:agent'
  const kind = overrides.kind ?? 'workflow'
  const owned = await recordPath(fixture, ownerId, kind)
  const baseCommit = (
    await execFileAsync('git', [
      '-C',
      fixture.repositoryRoot,
      'rev-parse',
      'HEAD',
    ])
  ).stdout.trim()
  const worktreePath =
    overrides.worktreePath ??
    join(
      owned.identity,
      '.praxis',
      'worktrees',
      kind,
      `abandoned-${ownerId.replaceAll(/[^a-z0-9-]/giu, '-')}`,
    )
  const record: ManagedWorktreeRecord = {
    version: 1,
    worktreeId: owned.worktreeId,
    kind,
    policy: 'ephemeral',
    ownerId,
    repositoryRoot: owned.identity,
    worktreePath,
    branch:
      checkout === 'branch' ? `praxis-${owned.worktreeId.slice(0, 12)}` : null,
    baseCommit,
    state: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  }
  const store = new ManagedWorktreeStore(
    fixture.stateRoot,
    owned.identity,
    owned.worktreeId,
  )
  const recordForCreate = { ...record }
  delete recordForCreate.retentionReason
  await store.create({ ...recordForCreate, state: 'creating' })
  if (checkout !== 'none') {
    const args =
      checkout === 'branch'
        ? [
            '-C',
            fixture.repositoryRoot,
            'worktree',
            'add',
            '-b',
            requiredBranch(record),
            worktreePath,
            baseCommit,
          ]
        : [
            '-C',
            fixture.repositoryRoot,
            'worktree',
            'add',
            '--detach',
            worktreePath,
            baseCommit,
          ]
    await execFileAsync('git', args)
    await writeFile(
      join(await gitDirectory(worktreePath), 'PRAXIS_WORKTREE'),
      `${JSON.stringify({ version: 1, worktreeId: owned.worktreeId, repositoryRoot: owned.identity })}\n`,
    )
  }
  if (record.state !== 'creating') {
    if (record.state === 'retained') {
      await store.update({ ...record, state: 'retained' })
    } else {
      await store.update({ ...record, state: 'active' })
    }
    if (record.state === 'releasing') {
      await store.update({ ...record, state: 'releasing' })
    } else if (record.state === 'released') {
      await store.update({ ...record, state: 'releasing' })
      await store.update({ ...record, state: 'released' })
    }
  }
  return { ...owned, baseCommit, record, store, worktreePath }
}

describe('createOwnedManagedWorktree', () => {
  it('runs lifecycle hooks around activation and removal with ownership identity', async () => {
    const fixture = await repository()
    const options = ownedOptions(fixture)
    const owned = await recordPath(fixture, options.ownerId)
    const events: string[] = []
    const hookIdentity: Record<string, unknown> = {}
    const hooks = {
      afterCreate: async (input: {
        worktreePath: string
        worktreeKind: string
        worktreeId: string
        ownerId: string
        baseCommit: string
      }) => {
        events.push('create')
        Object.assign(hookIdentity, input)
        expect(
          (JSON.parse(await readFile(owned.path, 'utf8')) as { state: string })
            .state,
        ).toBe('creating')
        return {}
      },
      beforeRemove: async (input: {
        worktreePath: string
        worktreeKind: string
        worktreeId: string
        ownerId: string
        baseCommit: string
        reason: string
      }) => {
        events.push('remove')
        expect(input).toMatchObject({
          ...hookIdentity,
          reason: 'normal',
        })
        expect(
          (JSON.parse(await readFile(owned.path, 'utf8')) as { state: string })
            .state,
        ).toBe('releasing')
        return {}
      },
    }
    const worktree = await createOwnedManagedWorktree({ ...options, hooks })

    expect(events).toEqual(['create'])
    expect(await worktree.cleanup()).toEqual({ retained: false })
    expect(events).toEqual(['create', 'remove'])
  })

  it('safely rolls back a blocked create hook and retains hook mutations', async () => {
    const fixture = await repository()
    const options = ownedOptions(fixture)
    const expectedPath = join(
      await realpath(fixture.repositoryRoot),
      '.praxis',
      'worktrees',
      options.kind,
      options.directoryName,
    )
    await expect(
      createOwnedManagedWorktree({
        ...options,
        hooks: {
          afterCreate: async () => ({ blockedReason: 'denied by policy' }),
          beforeRemove: async () => ({}),
        },
      }),
    ).rejects.toThrow('WorktreeCreate hook blocked: denied by policy')
    await expect(stat(expectedPath)).rejects.toMatchObject({ code: 'ENOENT' })
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
    ).not.toContain(expectedPath)
    const owned = await recordPath(fixture, options.ownerId)
    expect((await JSON.parse(await readFile(owned.path, 'utf8'))).state).toBe(
      'released',
    )

    const dirtyOptions = ownedOptions(fixture, {
      directoryName: 'run-dirty-hook',
      ownerId: 'workflow:run-dirty-hook:agent',
      hooks: {
        afterCreate: async (input) => {
          await writeFile(join(input.worktreePath, 'hook.txt'), 'hook\n')
          throw new Error('hook failed after mutation')
        },
        beforeRemove: async () => ({}),
      },
    })
    await expect(createOwnedManagedWorktree(dirtyOptions)).rejects.toThrow(
      'WorktreeCreate hook failed: hook failed after mutation',
    )
    const dirtyOwned = await recordPath(fixture, dirtyOptions.ownerId)
    expect(
      (await JSON.parse(await readFile(dirtyOwned.path, 'utf8'))).state,
    ).toBe('retained')
    const dirtyPath = join(
      await realpath(fixture.repositoryRoot),
      '.praxis',
      'worktrees',
      dirtyOptions.kind,
      dirtyOptions.directoryName,
    )
    await expect(stat(dirtyPath)).resolves.toBeDefined()
    expect(await readFile(join(dirtyPath, 'hook.txt'), 'utf8')).toBe('hook\n')
  })

  it('retains a checkout when removal hooks block, fail, or mutate it', async () => {
    for (const mode of ['block', 'throw', 'dirty', 'commit'] as const) {
      const fixture = await repository()
      const options = ownedOptions(fixture, {
        directoryName: `run-remove-${mode}`,
        ownerId: `workflow:run-remove-${mode}:agent`,
      })
      const worktree = await createOwnedManagedWorktree({
        ...options,
        hooks: {
          afterCreate: async () => ({}),
          beforeRemove: async (input) => {
            if (mode === 'block') return { blockedReason: 'no' }
            if (mode === 'throw') throw new Error('failed')
            if (mode === 'dirty') {
              await writeFile(join(input.worktreePath, 'hook.txt'), 'dirty\n')
            } else {
              await writeFile(join(input.worktreePath, 'hook.txt'), 'commit\n')
              await execFileAsync('git', [
                '-C',
                input.worktreePath,
                'add',
                'hook.txt',
              ])
              await execFileAsync('git', [
                '-C',
                input.worktreePath,
                '-c',
                'user.name=Praxis Test',
                '-c',
                'user.email=praxis@example.invalid',
                'commit',
                '-m',
                'hook change',
              ])
            }
            return {}
          },
        },
      })
      const result = await worktree.cleanup()
      expect(result).toMatchObject({
        retained: true,
        reason: expect.stringContaining('WorktreeRemove hook'),
      })
      await expect(stat(worktree.cwd)).resolves.toBeDefined()
    }
  })

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

describe('reconcileManagedWorktrees', () => {
  it('removes clean active crash residue and persists released', async () => {
    const fixture = await repository()
    const abandoned = await abandonedRecord(fixture)
    const result = await reconcileManagedWorktrees({
      cwd: fixture.repositoryRoot,
      stateRoot: fixture.stateRoot,
    })

    expect(result.entries).toContainEqual(
      expect.objectContaining({
        disposition: 'released',
        worktreeId: abandoned.worktreeId,
      }),
    )
    expect((await abandoned.store.read()).state).toBe('released')
    await expect(stat(abandoned.worktreePath)).rejects.toMatchObject({
      code: 'ENOENT',
    })
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
    ).not.toContain(abandoned.worktreePath)
  })

  it('retains dirty and newly committed crash candidates with precise reasons', async () => {
    for (const mode of ['dirty', 'commit'] as const) {
      const fixture = await repository()
      const abandoned = await abandonedRecord(fixture, {
        ownerId: `workflow:abandoned-${mode}:agent`,
      })
      if (mode === 'dirty') {
        await writeFile(join(abandoned.worktreePath, 'dirty.txt'), 'dirty\n')
      } else {
        await writeFile(join(abandoned.worktreePath, 'commit.txt'), 'commit\n')
        await execFileAsync('git', [
          '-C',
          abandoned.worktreePath,
          'add',
          'commit.txt',
        ])
        await execFileAsync('git', [
          '-C',
          abandoned.worktreePath,
          '-c',
          'user.name=Praxis Test',
          '-c',
          'user.email=praxis@example.invalid',
          'commit',
          '-m',
          'abandoned commit',
        ])
      }
      const head = (
        await execFileAsync('git', [
          '-C',
          abandoned.worktreePath,
          'rev-parse',
          'HEAD',
        ])
      ).stdout.trim()
      const result = await reconcileManagedWorktrees({
        cwd: fixture.repositoryRoot,
        stateRoot: fixture.stateRoot,
      })
      const entry = result.entries.find(
        (item) => item.worktreeId === abandoned.worktreeId,
      )
      expect(entry?.disposition).toBe('retained')
      expect(entry?.reason).toMatch(
        mode === 'dirty' ? /dirty|change/u : /commit|advanced|base/u,
      )
      expect((await abandoned.store.read()).state).toBe('retained')
      await expect(stat(abandoned.worktreePath)).resolves.toBeDefined()
      expect(
        (
          await execFileAsync('git', [
            '-C',
            abandoned.worktreePath,
            'rev-parse',
            'HEAD',
          ])
        ).stdout.trim(),
      ).toBe(head)
      expect(
        (
          await execFileAsync('git', [
            '-C',
            abandoned.worktreePath,
            'status',
            '--porcelain',
          ])
        ).stdout,
      ).toBe(mode === 'dirty' ? '?? dirty.txt\n' : '')
    }
  })

  it('fails closed for marker, registration, and symlink ownership mismatches', async () => {
    const markerFixture = await repository()
    const marker = await abandonedRecord(markerFixture, {
      ownerId: 'workflow:m-marker:agent',
    })
    await writeFile(
      join(await gitDirectory(marker.worktreePath), 'PRAXIS_WORKTREE'),
      `${JSON.stringify({ version: 1, worktreeId: marker.worktreeId, repositoryRoot: '/wrong' })}\n`,
    )
    const markerResult = await reconcileManagedWorktrees({
      cwd: markerFixture.repositoryRoot,
      stateRoot: markerFixture.stateRoot,
    })
    expect(
      markerResult.entries.find(
        (item) => item.worktreeId === marker.worktreeId,
      ),
    ).toMatchObject({ disposition: 'retained' })
    expect(await readFile(marker.worktreePath + '/tracked.txt', 'utf8')).toBe(
      'base\n',
    )

    const registrationFixture = await repository()
    const registration = await abandonedRecord(registrationFixture, {
      ownerId: 'workflow:m-registration:agent',
    })
    await execFileAsync('git', [
      '-C',
      registrationFixture.repositoryRoot,
      'worktree',
      'remove',
      registration.worktreePath,
    ])
    await mkdir(registration.worktreePath, { recursive: true })
    await writeFile(
      join(registration.worktreePath, 'sentinel.txt'),
      'preserve\n',
    )
    const registrationResult = await reconcileManagedWorktrees({
      cwd: registrationFixture.repositoryRoot,
      stateRoot: registrationFixture.stateRoot,
    })
    expect(
      registrationResult.entries.find(
        (item) => item.worktreeId === registration.worktreeId,
      ),
    ).toMatchObject({ disposition: 'retained' })
    expect(
      await readFile(join(registration.worktreePath, 'sentinel.txt'), 'utf8'),
    ).toBe('preserve\n')

    const symlinkFixture = await repository()
    const external = join(symlinkFixture.root, 'external')
    await mkdir(external)
    await writeFile(join(external, 'sentinel.txt'), 'preserve\n')
    const symlinked = await abandonedRecord(
      symlinkFixture,
      { ownerId: 'workflow:m-symlink:agent' },
      'none',
    )
    await mkdir(resolve(symlinked.worktreePath, '..'), { recursive: true })
    await symlink(external, symlinked.worktreePath, 'dir')
    const symlinkResult = await reconcileManagedWorktrees({
      cwd: symlinkFixture.repositoryRoot,
      stateRoot: symlinkFixture.stateRoot,
    })
    expect(
      symlinkResult.entries.find(
        (item) => item.worktreeId === symlinked.worktreeId,
      ),
    ).toMatchObject({ disposition: 'retained' })
    expect(await readFile(join(external, 'sentinel.txt'), 'utf8')).toBe(
      'preserve\n',
    )
  })

  it('reconciles missing checkouts and validates branch evidence conservatively', async () => {
    const absentFixture = await repository()
    const absent = await abandonedRecord(
      absentFixture,
      { ownerId: 'workflow:missing:agent' },
      'none',
    )
    const absentResult = await reconcileManagedWorktrees({
      cwd: absentFixture.repositoryRoot,
      stateRoot: absentFixture.stateRoot,
    })
    expect(
      absentResult.entries.find(
        (item) => item.worktreeId === absent.worktreeId,
      ),
    ).toMatchObject({ disposition: 'released' })

    const registeredFixture = await repository()
    const registered = await abandonedRecord(registeredFixture, {
      ownerId: 'workflow:registered-missing:agent',
    })
    await rm(registered.worktreePath, { recursive: true })
    const registeredResult = await reconcileManagedWorktrees({
      cwd: registeredFixture.repositoryRoot,
      stateRoot: registeredFixture.stateRoot,
    })
    expect(
      registeredResult.entries.find(
        (item) => item.worktreeId === registered.worktreeId,
      ),
    ).toMatchObject({ disposition: 'retained' })
    expect((await registered.store.read()).state).toBe('retained')

    const branchFixture = await repository()
    const branch = await abandonedRecord(
      branchFixture,
      { ownerId: 'workflow:branch:agent' },
      'branch',
    )
    await rm(branch.worktreePath, { recursive: true })
    await execFileAsync('git', [
      '-C',
      branchFixture.repositoryRoot,
      'worktree',
      'prune',
    ])
    const branchResult = await reconcileManagedWorktrees({
      cwd: branchFixture.repositoryRoot,
      stateRoot: branchFixture.stateRoot,
    })
    expect(
      branchResult.entries.find(
        (item) => item.worktreeId === branch.worktreeId,
      ),
    ).toMatchObject({ disposition: 'released' })
    await expect(
      execFileAsync('git', [
        '-C',
        branchFixture.repositoryRoot,
        'show-ref',
        '--verify',
        `refs/heads/${branch.record.branch}`,
      ]),
    ).rejects.toThrow()

    const movedFixture = await repository()
    const moved = await abandonedRecord(
      movedFixture,
      { ownerId: 'workflow:moved-branch:agent' },
      'branch',
    )
    await execFileAsync('git', [
      '-C',
      movedFixture.repositoryRoot,
      'worktree',
      'remove',
      moved.worktreePath,
    ])
    await writeFile(join(movedFixture.repositoryRoot, 'moved.txt'), 'moved\n')
    await execFileAsync('git', [
      '-C',
      movedFixture.repositoryRoot,
      'add',
      'moved.txt',
    ])
    await execFileAsync('git', [
      '-C',
      movedFixture.repositoryRoot,
      '-c',
      'user.name=Praxis Test',
      '-c',
      'user.email=praxis@example.invalid',
      'commit',
      '-m',
      'move recorded branch',
    ])
    await execFileAsync('git', [
      '-C',
      movedFixture.repositoryRoot,
      'branch',
      '-f',
      requiredBranch(moved.record),
      'HEAD',
    ])
    const movedResult = await reconcileManagedWorktrees({
      cwd: movedFixture.repositoryRoot,
      stateRoot: movedFixture.stateRoot,
    })
    expect(
      movedResult.entries.find((item) => item.worktreeId === moved.worktreeId),
    ).toMatchObject({ disposition: 'retained' })
    expect(
      (
        await execFileAsync('git', [
          '-C',
          movedFixture.repositoryRoot,
          'show-ref',
          '--verify',
          `refs/heads/${requiredBranch(moved.record)}`,
        ])
      ).stdout,
    ).toContain(requiredBranch(moved.record))

    const raceFixture = await repository()
    const race = await abandonedRecord(
      raceFixture,
      { ownerId: 'workflow:post-remove-race:agent' },
      'branch',
    )
    await writeFile(join(raceFixture.repositoryRoot, 'race.txt'), 'race\n')
    await execFileAsync('git', [
      '-C',
      raceFixture.repositoryRoot,
      'add',
      'race.txt',
    ])
    await execFileAsync('git', [
      '-C',
      raceFixture.repositoryRoot,
      '-c',
      'user.name=Praxis Test',
      '-c',
      'user.email=praxis@example.invalid',
      'commit',
      '-m',
      'post-remove race target',
    ])
    const movedCommit = (
      await execFileAsync('git', [
        '-C',
        raceFixture.repositoryRoot,
        'rev-parse',
        'HEAD',
      ])
    ).stdout.trim()
    const realGit = (await execFileAsync('which', ['git'])).stdout.trim()
    const shimDir = await mkdtemp(join(tmpdir(), 'praxis-git-shim-'))
    roots.push(shimDir)
    const shimPath = join(shimDir, 'git')
    await writeFile(
      shimPath,
      `#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
const args = process.argv.slice(2)
if ((args[0] === 'update-ref' && args[1] === '-d' && args[2] === ${JSON.stringify(`refs/heads/${requiredBranch(race.record)}`)} && args[3] === ${JSON.stringify(race.baseCommit)}) || (args[0] === '-C' && args[2] === 'update-ref' && args[3] === '-d' && args[4] === ${JSON.stringify(`refs/heads/${requiredBranch(race.record)}`)} && args[5] === ${JSON.stringify(race.baseCommit)})) {
  const moved = spawnSync(${JSON.stringify(realGit)}, ['-C', ${JSON.stringify(raceFixture.repositoryRoot)}, 'branch', '-f', ${JSON.stringify(requiredBranch(race.record))}, ${JSON.stringify(movedCommit)}], { stdio: 'inherit' })
  if (moved.status !== 0) process.exit(moved.status ?? 1)
}
const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' })
if (result.status !== 0) process.exit(result.status ?? 1)
process.exit(0)
`,
    )
    await chmod(shimPath, 0o755)
    const originalPath = process.env.PATH
    try {
      process.env.PATH = `${shimDir}:${originalPath ?? ''}`
      const raceResult = await reconcileManagedWorktrees({
        cwd: raceFixture.repositoryRoot,
        stateRoot: raceFixture.stateRoot,
      })
      expect(
        raceResult.entries.find((item) => item.worktreeId === race.worktreeId),
      ).toMatchObject({
        disposition: 'retained',
        reason: expect.stringContaining('checkout removed'),
      })
      expect((await race.store.read()).state).toBe('retained')
      await expect(stat(race.worktreePath)).rejects.toMatchObject({
        code: 'ENOENT',
      })
      expect(
        (
          await execFileAsync('git', [
            '-C',
            raceFixture.repositoryRoot,
            'rev-parse',
            `refs/heads/${requiredBranch(race.record)}`,
          ])
        ).stdout.trim(),
      ).toBe(movedCommit)
    } finally {
      if (originalPath === undefined) delete process.env.PATH
      else process.env.PATH = originalPath
    }

    const invalidFixture = await repository()
    const invalid = await abandonedRecord(invalidFixture, {
      ownerId: 'workflow:invalid-branch:agent',
      branch: 'bad..branch',
    })
    await rm(invalid.worktreePath, { recursive: true })
    await execFileAsync('git', [
      '-C',
      invalidFixture.repositoryRoot,
      'worktree',
      'prune',
    ])
    const invalidResult = await reconcileManagedWorktrees({
      cwd: invalidFixture.repositoryRoot,
      stateRoot: invalidFixture.stateRoot,
    })
    expect(
      invalidResult.entries.find(
        (item) => item.worktreeId === invalid.worktreeId,
      ),
    ).toMatchObject({ disposition: 'retained' })

    const fatalFixture = await repository()
    const fatal = await abandonedRecord(
      fatalFixture,
      { ownerId: 'workflow:fatal-branch-ref:agent' },
      'branch',
    )
    const fatalRealGit = (await execFileAsync('which', ['git'])).stdout.trim()
    const fatalShimDir = await mkdtemp(join(tmpdir(), 'praxis-fatal-git-'))
    roots.push(fatalShimDir)
    const fatalShim = join(fatalShimDir, 'git')
    await writeFile(
      fatalShim,
      `#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
const args = process.argv.slice(2)
if (args.includes('rev-parse') && args.includes('--verify') && args.includes('--quiet') && args.includes(${JSON.stringify(`refs/heads/${requiredBranch(fatal.record)}`)})) process.exit(128)
const result = spawnSync(${JSON.stringify(fatalRealGit)}, args, { stdio: 'inherit' })
process.exit(result.status ?? 1)
`,
    )
    await chmod(fatalShim, 0o755)
    const fatalOriginalPath = process.env.PATH
    try {
      process.env.PATH = `${fatalShimDir}:${fatalOriginalPath ?? ''}`
      const fatalResult = await reconcileManagedWorktrees({
        cwd: fatalFixture.repositoryRoot,
        stateRoot: fatalFixture.stateRoot,
      })
      expect(
        fatalResult.entries.find(
          (item) => item.worktreeId === fatal.worktreeId,
        ),
      ).toMatchObject({ disposition: 'retained' })
      expect((await fatal.store.read()).state).toBe('retained')
      await expect(stat(fatal.worktreePath)).resolves.toBeDefined()
    } finally {
      if (fatalOriginalPath === undefined) delete process.env.PATH
      else process.env.PATH = fatalOriginalPath
    }
    expect(
      (
        await execFileAsync('git', [
          '-C',
          fatalFixture.repositoryRoot,
          'rev-parse',
          `refs/heads/${requiredBranch(fatal.record)}`,
        ])
      ).stdout.trim(),
    ).toBe(fatal.baseCommit)
  })

  it('retains durable, team, retained, and unknown-owner records', async () => {
    for (const [name, overrides] of [
      ['durable', { policy: 'durable' as const }],
      ['team', { kind: 'team' as const, policy: 'durable' as const }],
      ['retained', { state: 'retained' as const, retentionReason: 'orphaned' }],
      ['unknown', { ownerId: 'external:unknown:owner' }],
    ] as const) {
      const fixture = await repository()
      const abandoned = await abandonedRecord(fixture, {
        ownerId: name === 'team' ? 'team:one:agent' : `workflow:${name}:agent`,
        ...overrides,
      })
      const before = await readFile(
        abandoned.worktreePath + '/tracked.txt',
        'utf8',
      )
      const result = await reconcileManagedWorktrees({
        cwd: fixture.repositoryRoot,
        stateRoot: fixture.stateRoot,
      })
      expect(
        result.entries.find((item) => item.worktreeId === abandoned.worktreeId),
      ).toMatchObject({ disposition: 'retained' })
      expect((await abandoned.store.read()).state).toBe('retained')
      expect(
        await readFile(abandoned.worktreePath + '/tracked.txt', 'utf8'),
      ).toBe(before)
    }
  })

  it('reports an overwritten registry identity as invalid without changing bytes', async () => {
    const fixture = await repository()
    const abandoned = await abandonedRecord(
      fixture,
      { ownerId: 'workflow:invalid-registry:agent' },
      'none',
    )
    const original = await readFile(abandoned.path)
    const record = JSON.parse(original.toString()) as ManagedWorktreeRecord
    await writeFile(
      abandoned.path,
      `${JSON.stringify({ ...record, repositoryRoot: '/different/repository' })}\n`,
    )
    const overwritten = await readFile(abandoned.path)
    const result = await reconcileManagedWorktrees({
      cwd: fixture.repositoryRoot,
      stateRoot: fixture.stateRoot,
    })
    expect(
      result.entries.find((item) => item.recordPath === abandoned.path),
    ).toMatchObject({ disposition: 'invalid' })
    expect(await readFile(abandoned.path)).toEqual(overwritten)
  })

  it('releases an absent checkout when its owned branch is already absent', async () => {
    const fixture = await repository()
    const ownerId = 'workflow:crashed:agent'
    const owned = await recordPath(fixture, ownerId)
    const baseCommit = (
      await execFileAsync('git', [
        '-C',
        fixture.repositoryRoot,
        'rev-parse',
        'HEAD',
      ])
    ).stdout.trim()
    const record: ManagedWorktreeRecord = {
      version: 1,
      worktreeId: owned.worktreeId,
      kind: 'workflow',
      policy: 'ephemeral',
      ownerId,
      repositoryRoot: owned.identity,
      worktreePath: join(
        owned.identity,
        '.praxis',
        'worktrees',
        'workflow',
        'gone',
      ),
      branch: 'praxis-crashed-branch',
      baseCommit,
      state: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    const store = new ManagedWorktreeStore(
      fixture.stateRoot,
      owned.identity,
      owned.worktreeId,
    )
    await store.create({ ...record, state: 'creating' })
    await store.update(record)
    const result = await reconcileManagedWorktrees({
      cwd: fixture.repositoryRoot,
      stateRoot: fixture.stateRoot,
    })
    expect(result.entries).toContainEqual(
      expect.objectContaining({
        disposition: 'released',
        worktreeId: owned.worktreeId,
      }),
    )
    expect((await store.read()).state).toBe('released')
  })

  it('skips a live lease and reconciles it after release', async () => {
    const fixture = await repository()
    const abandoned = await abandonedRecord(fixture, {
      ownerId: 'workflow:live-lease:agent',
    })
    const lease = await abandoned.store.acquireLease()
    expect(lease).not.toBeNull()
    if (!lease) throw new Error('expected lease')
    const hooks = reconcileHooks(vi.fn(async () => ({})))
    const held = await reconcileManagedWorktrees({
      cwd: fixture.repositoryRoot,
      stateRoot: fixture.stateRoot,
      hooks,
    })
    expect(held.entries).toContainEqual(
      expect.objectContaining({
        worktreeId: abandoned.worktreeId,
        disposition: 'skipped',
      }),
    )
    expect((await abandoned.store.read()).state).toBe('active')
    expect(hooks.beforeRemove).not.toHaveBeenCalled()
    await expect(stat(abandoned.worktreePath)).resolves.toBeDefined()
    await lease.release()
    const released = await reconcileManagedWorktrees({
      cwd: fixture.repositoryRoot,
      stateRoot: fixture.stateRoot,
    })
    expect(released.entries).toContainEqual(
      expect.objectContaining({
        worktreeId: abandoned.worktreeId,
        disposition: 'released',
      }),
    )
  })

  it('removes valid interrupted states and skips terminal records', async () => {
    for (const state of ['creating', 'active', 'releasing'] as const) {
      const fixture = await repository()
      const abandoned = await abandonedRecord(fixture, {
        ownerId: `workflow:interrupted-${state}:agent`,
        state,
      })
      const result = await reconcileManagedWorktrees({
        cwd: fixture.repositoryRoot,
        stateRoot: fixture.stateRoot,
      })
      expect(result.entries).toContainEqual(
        expect.objectContaining({
          worktreeId: abandoned.worktreeId,
          disposition: 'released',
        }),
      )
      expect((await abandoned.store.read()).state).toBe('released')
    }
    const fixture = await repository()
    const released = await abandonedRecord(
      fixture,
      { ownerId: 'workflow:already-released:agent', state: 'released' },
      'none',
    )
    const before = await readFile(released.path)
    const result = await reconcileManagedWorktrees({
      cwd: fixture.repositoryRoot,
      stateRoot: fixture.stateRoot,
    })
    expect(result.entries).toContainEqual(
      expect.objectContaining({
        worktreeId: released.worktreeId,
        disposition: 'skipped',
      }),
    )
    expect(await readFile(released.path)).toEqual(before)
  })

  it('passes exact reconcile hook input and preserves hook output privacy', async () => {
    const fixture = await repository()
    const abandoned = await abandonedRecord(fixture, {
      ownerId: 'workflow:hook-success:agent',
    })
    let input: ManagedWorktreeRemoveHookInput | undefined
    const result = await reconcileManagedWorktrees({
      cwd: fixture.repositoryRoot,
      stateRoot: fixture.stateRoot,
      hooks: reconcileHooks(async (value) => {
        input = value
        return { testOnlyMarker: 'private' } as ManagedWorktreeHookOutcome & {
          testOnlyMarker: string
        }
      }),
    })
    expect(input).toEqual({
      worktreePath: abandoned.worktreePath,
      worktreeKind: abandoned.record.kind,
      worktreeId: abandoned.worktreeId,
      ownerId: abandoned.record.ownerId,
      baseCommit: abandoned.baseCommit,
      reason: 'reconcile',
    })
    expect(result.entries).toContainEqual(
      expect.objectContaining({ disposition: 'released' }),
    )
    expect(JSON.stringify(await abandoned.store.read())).not.toContain(
      'testOnlyMarker',
    )
    expect(
      JSON.stringify(await readFile(abandoned.path, 'utf8')),
    ).not.toContain('testOnlyMarker')
  })

  it('retains every unsafe reconcile hook outcome with one hook call', async () => {
    for (const mode of ['block', 'throw', 'dirty', 'commit'] as const) {
      const fixture = await repository()
      const abandoned = await abandonedRecord(fixture, {
        ownerId: `workflow:reconcile-${mode}:agent`,
      })
      const hook = vi.fn(
        async (
          input: ManagedWorktreeRemoveHookInput,
        ): Promise<ManagedWorktreeHookOutcome> => {
          if (mode === 'block') return { blockedReason: 'policy' }
          if (mode === 'throw') throw new Error('failure')
          await writeFile(join(input.worktreePath, `${mode}.txt`), `${mode}\n`)
          if (mode === 'commit') {
            await execFileAsync('git', [
              '-C',
              input.worktreePath,
              'add',
              `${mode}.txt`,
            ])
            await execFileAsync('git', [
              '-C',
              input.worktreePath,
              '-c',
              'user.name=Praxis Test',
              '-c',
              'user.email=praxis@example.invalid',
              'commit',
              '-m',
              'unsafe reconcile hook',
            ])
          }
          return {}
        },
      )
      const result = await reconcileManagedWorktrees({
        cwd: fixture.repositoryRoot,
        stateRoot: fixture.stateRoot,
        hooks: reconcileHooks(hook),
      })
      const entry = result.entries.find(
        (item) => item.worktreeId === abandoned.worktreeId,
      )
      expect(entry?.disposition).toBe('retained')
      expect(entry?.reason).toMatch(
        mode === 'block'
          ? /blocked/u
          : mode === 'throw'
            ? /failed/u
            : /dirty|commit|unsafe|change/u,
      )
      expect(hook).toHaveBeenCalledTimes(1)
      expect((await abandoned.store.read()).state).toBe('retained')
      await expect(stat(abandoned.worktreePath)).resolves.toBeDefined()
    }
  })

  it('is idempotent and safe when reconciled concurrently', async () => {
    const fixture = await repository()
    const abandoned = await abandonedRecord(fixture, {
      ownerId: 'workflow:concurrent-reconcile:agent',
    })
    const hook = vi.fn<ManagedWorktreeHooks['beforeRemove']>(
      async (): Promise<ManagedWorktreeHookOutcome> => ({}),
    )
    const [first, second] = await Promise.all([
      reconcileManagedWorktrees({
        cwd: fixture.repositoryRoot,
        stateRoot: fixture.stateRoot,
        hooks: reconcileHooks(hook),
      }),
      reconcileManagedWorktrees({
        cwd: fixture.repositoryRoot,
        stateRoot: fixture.stateRoot,
        hooks: reconcileHooks(hook),
      }),
    ])
    expect(hook).toHaveBeenCalledTimes(1)
    expect((await abandoned.store.read()).state).toBe('released')
    expect(
      first.entries
        .concat(second.entries)
        .some((entry) => entry.worktreeId === abandoned.worktreeId),
    ).toBe(true)
    expect(
      first.entries
        .concat(second.entries)
        .every(
          (entry) =>
            entry.disposition === 'released' || entry.disposition === 'skipped',
        ),
    ).toBe(true)
    const repeated = await reconcileManagedWorktrees({
      cwd: fixture.repositoryRoot,
      stateRoot: fixture.stateRoot,
      hooks: reconcileHooks(hook),
    })
    expect(repeated.entries).toContainEqual(
      expect.objectContaining({
        worktreeId: abandoned.worktreeId,
        disposition: 'skipped',
      }),
    )
    expect(hook).toHaveBeenCalledTimes(1)
  })

  it('automatically reconciles once per project before the first create', async () => {
    const fixture = await repository()
    const candidate = await abandonedRecord(fixture, {
      ownerId: 'workflow:auto-reconcile-a:agent',
    })
    const hook = vi.fn<ManagedWorktreeHooks['beforeRemove']>(
      async (): Promise<ManagedWorktreeHookOutcome> => ({}),
    )
    const first = await createOwnedManagedWorktree({
      ...ownedOptions(fixture, {
        ownerId: 'workflow:auto-reconcile-first:agent',
        directoryName: 'auto-reconcile-first',
      }),
      hooks: reconcileHooks(hook),
    })
    expect(hook).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'reconcile' }),
    )
    expect((await candidate.store.read()).state).toBe('released')
    await first.cleanup()

    const secondStateRoot = join(fixture.root, 'second-state')
    const secondFixture = { ...fixture, stateRoot: secondStateRoot }
    const secondCandidate = await abandonedRecord(secondFixture, {
      ownerId: 'workflow:auto-reconcile-b:agent',
    })
    const second = await createOwnedManagedWorktree({
      ...ownedOptions(fixture, {
        ownerId: 'workflow:auto-reconcile-second:agent',
        directoryName: 'auto-reconcile-second',
        stateRoot: secondStateRoot,
      }),
      hooks: reconcileHooks(hook),
    })
    expect((await secondCandidate.store.read()).state).toBe('active')
    expect(
      hook.mock.calls.filter(([value]) => value.reason === 'reconcile'),
    ).toHaveLength(1)
    await second.cleanup()
    await reconcileManagedWorktrees({
      cwd: fixture.repositoryRoot,
      stateRoot: fixture.stateRoot,
    })
  })
})
