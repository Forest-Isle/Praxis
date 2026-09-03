import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  ManagedWorktreeStore,
  inspectManagedWorktreeRegistry,
  type ManagedWorktreeRecord,
} from './managed-worktree-store.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  )
})

function record(
  root: string,
  overrides: Partial<ManagedWorktreeRecord> = {},
): ManagedWorktreeRecord {
  const timestamp = new Date().toISOString()
  return {
    version: 1,
    worktreeId: 'a'.repeat(64),
    kind: 'workflow',
    policy: 'ephemeral',
    ownerId: 'workflow:run:agent',
    repositoryRoot: join(root, 'repo'),
    worktreePath: join(root, 'repo', '.praxis', 'worktrees', 'workflow', 'one'),
    branch: null,
    baseCommit: 'b'.repeat(40),
    state: 'creating',
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  }
}

function storeFor(root: string, value: ManagedWorktreeRecord) {
  return new ManagedWorktreeStore(
    join(root, 'state'),
    value.repositoryRoot,
    value.worktreeId,
  )
}

describe('ManagedWorktreeStore', () => {
  it('writes strict records atomically with private file permissions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-managed-store-'))
    roots.push(root)
    const next = record(root, {
      worktreePath: join(
        root,
        'repo',
        '.praxis',
        'worktrees',
        'workflow',
        '..fixture',
      ),
    })
    const store = storeFor(root, next)

    await store.create(next)

    expect((await lstat(store.path)).mode & 0o777).toBe(0o600)
    expect(await store.read()).toEqual(next)
    await store.update({
      ...next,
      state: 'active',
      updatedAt: new Date().toISOString(),
    })
    expect((await store.read()).state).toBe('active')
  })

  it('enforces lifecycle transitions and immutable ownership fields', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-managed-store-'))
    roots.push(root)
    const creating = record(root)
    const store = storeFor(root, creating)
    await store.create(creating)
    const active = {
      ...creating,
      state: 'active' as const,
      updatedAt: new Date().toISOString(),
    }
    await store.update(active)

    await expect(
      store.update({
        ...active,
        state: 'released',
        updatedAt: new Date().toISOString(),
      }),
    ).rejects.toThrow('active -> released')
    await expect(
      store.update({
        ...active,
        ownerId: 'workflow:other:agent',
        state: 'retained',
        retentionReason: 'keep',
        updatedAt: new Date().toISOString(),
      }),
    ).rejects.toThrow('immutable field changed: ownerId')

    const retained = {
      ...active,
      state: 'retained' as const,
      retentionReason: 'dirty',
      updatedAt: new Date().toISOString(),
    }
    await store.update(retained)
    const retainedBase: ManagedWorktreeRecord = { ...retained }
    delete retainedBase.retentionReason
    await store.update({
      ...retainedBase,
      state: 'releasing',
      updatedAt: new Date().toISOString(),
    })
    expect(await store.read()).toMatchObject({ state: 'releasing' })
    expect((await store.read()).retentionReason).toBeUndefined()
  })

  it('serializes project registrations so two owners cannot reserve one path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-managed-store-'))
    roots.push(root)
    const first = record(root)
    const second = record(root, {
      worktreeId: 'c'.repeat(64),
      ownerId: 'workflow:other:agent',
    })
    const results = await Promise.allSettled([
      storeFor(root, first).create(first),
      storeFor(root, second).create(second),
    ])

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(
      1,
    )
    expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(
      1,
    )
    const projectsRoot = join(root, 'state', 'managed-worktrees')
    const registry = join(projectsRoot, (await readdir(projectsRoot))[0] ?? '')
    expect(
      (await readdir(registry)).filter((name) => name.endsWith('.json')),
    ).toHaveLength(1)
  })

  it('rejects a symlinked state root before writing through it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-managed-store-'))
    roots.push(root)
    const actualState = join(root, 'actual-state')
    const linkedState = join(root, 'linked-state')
    await mkdir(actualState)
    await symlink(actualState, linkedState, 'dir')
    const next = record(root)
    const store = new ManagedWorktreeStore(
      linkedState,
      next.repositoryRoot,
      next.worktreeId,
    )

    await expect(store.create(next)).rejects.toThrow(/symlink/u)
    expect(await readdir(actualState)).toEqual([])
  })

  it('rejects corrupt, unknown-version, and symlink records without overwriting them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-managed-store-'))
    roots.push(root)
    const next = record(root)
    const store = storeFor(root, next)
    await store.create(next)
    const original = await readFile(store.path, 'utf8')
    await writeFile(store.path, JSON.stringify({ ...next, version: 2 }))
    await expect(store.read()).rejects.toThrow()
    expect(await readFile(store.path, 'utf8')).toContain('"version":2')
    await rm(store.path)
    await symlink(join(root, 'elsewhere'), store.path)
    await expect(store.create(next)).rejects.toThrow(
      /regular file|already exists/u,
    )
    expect(await readFile(store.path, 'utf8').catch(() => original)).toBe(
      original,
    )
  })

  it('returns a deterministic bounded registry snapshot with structured invalid entries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-managed-snapshot-'))
    roots.push(root)
    const repositoryRoot = join(root, 'repo')
    for (let index = 0; index < 65; index += 1) {
      const id = index.toString(16).padStart(2, '0').repeat(32).slice(0, 64)
      const value = record(root, {
        worktreeId: id,
        worktreePath: join(
          repositoryRoot,
          '.praxis',
          'worktrees',
          'workflow',
          `w-${index}`,
        ),
      })
      await new ManagedWorktreeStore(
        join(root, 'state'),
        repositoryRoot,
        id,
      ).create(value)
    }
    const snapshot = await inspectManagedWorktreeRegistry({
      stateRoot: join(root, 'state'),
      repositoryRoot,
      limit: 64,
    })
    expect(snapshot.entries).toHaveLength(64)
    expect(snapshot.truncated).toBe(true)
    expect(snapshot.entries.every((entry) => 'record' in entry)).toBe(true)
  })

  it('returns structured errors for invalid registry candidates without following or mutating them', async () => {
    const root = await mkdtemp(
      join(tmpdir(), 'praxis-managed-snapshot-errors-'),
    )
    roots.push(root)
    const repositoryRoot = join(root, 'repo')
    const valid = record(root)
    await storeFor(root, valid).create(valid)
    const managedRoot = join(root, 'state', 'managed-worktrees')
    const registry = join(managedRoot, (await readdir(managedRoot))[0] ?? '')

    const malformedPath = join(registry, `${'0'.repeat(64)}.json`)
    const unknownPath = join(registry, `${'1'.repeat(64)}.json`)
    const mismatchedPath = join(registry, `${'2'.repeat(64)}.json`)
    const symlinkPath = join(registry, `${'4'.repeat(64)}.json`)
    const sentinelPath = join(root, 'sentinel.json')
    const malformedBytes = '{ malformed json\n'
    const unknown = JSON.stringify({
      ...valid,
      worktreeId: '1'.repeat(64),
      version: 2,
    })
    const mismatched = JSON.stringify({ ...valid, worktreeId: '3'.repeat(64) })
    const sentinelBytes = 'external sentinel\n'
    await writeFile(malformedPath, malformedBytes)
    await writeFile(unknownPath, unknown)
    await writeFile(mismatchedPath, mismatched)
    await writeFile(sentinelPath, sentinelBytes)
    await symlink(sentinelPath, symlinkPath)

    const snapshot = await inspectManagedWorktreeRegistry({
      stateRoot: join(root, 'state'),
      repositoryRoot,
      limit: 64,
    })

    expect(snapshot.entries.map((entry) => entry.path)).toEqual(
      [...snapshot.entries].map((entry) => entry.path).sort(),
    )
    expect(snapshot.entries.filter((entry) => 'record' in entry)).toHaveLength(
      1,
    )
    const errors = snapshot.entries.filter((entry) => 'error' in entry)
    expect(errors).toHaveLength(4)
    expect(errors.find((entry) => entry.path === malformedPath)?.error).toMatch(
      /JSON|json|parse|malformed|corrupt/u,
    )
    expect(errors.find((entry) => entry.path === unknownPath)?.error).toMatch(
      /version|unsupported|unknown/u,
    )
    expect(
      errors.find((entry) => entry.path === mismatchedPath)?.error,
    ).toMatch(/filename|worktree.?id|mismatch/u)
    expect(errors.find((entry) => entry.path === symlinkPath)?.error).toMatch(
      /symlink|regular file/u,
    )
    expect(await readFile(malformedPath, 'utf8')).toBe(malformedBytes)
    expect(await readFile(unknownPath, 'utf8')).toBe(unknown)
    expect(await readFile(mismatchedPath, 'utf8')).toBe(mismatched)
    expect((await lstat(symlinkPath)).isSymbolicLink()).toBe(true)
    expect(await readFile(sentinelPath, 'utf8')).toBe(sentinelBytes)
  })
})
