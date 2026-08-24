import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { NativeTeamStore } from './native-team-store.js'
import { ExclusiveFileLease } from '../platform/exclusive-file-lease.js'
import { sanitizeProjectPath } from '../platform/project-path-key.js'

const roots: string[] = []
const makeRoot = async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-team-'))
  roots.push(root)
  return root
}
const snapshot = (projectIdentity: string) => ({
  version: 1 as const,
  revision: 0,
  teamId: 'team-1',
  name: 'Team',
  projectIdentity,
  leadSessionId: 'lead',
  roster: [{ name: 'worker', agentType: 'agent', access: 'write' as const }],
  tasks: [
    {
      id: 'task-1',
      description: 'work',
      assignee: 'worker',
      blockedBy: [],
      claims: {
        files: [],
        publicContracts: [],
        generatedArtifacts: [],
        migrations: [],
        mergeTargets: [],
      },
      execution: null,
    },
  ],
  createdAt: '2026-08-24T00:00:00.000Z',
  updatedAt: '2026-08-24T00:00:00.000Z',
})
const pathFor = (root: string, store: NativeTeamStore, teamId = 'team-1') =>
  join(
    root,
    'state',
    'teams',
    sanitizeProjectPath(store.projectIdentity),
    teamId,
    'team.json',
  )

afterEach(async () => {
  for (const root of roots.splice(0))
    await import('node:fs/promises').then(({ rm }) =>
      rm(root, { recursive: true, force: true }),
    )
})

describe('native Team store', () => {
  it('opens without writes and creates, reads, saves, and retains a Team', async () => {
    const root = await makeRoot()
    const cwd = await makeRoot()
    const store = await NativeTeamStore.open({ nativeRoot: root, cwd })
    expect(await store.list()).toEqual([])
    const claim = await store.createAndClaim(snapshot(store.projectIdentity))
    const state = await claim.read()
    expect(state.teamId).toBe('team-1')
    expect(Object.isFrozen(state)).toBe(true)
    expect(Object.isFrozen(state.roster)).toBe(true)
    expect(Object.isFrozen(state.roster[0])).toBe(true)
    expect(Object.isFrozen(state.tasks)).toBe(true)
    expect(Object.isFrozen(state.tasks[0])).toBe(true)
    const task = state.tasks.at(0)
    if (!task) throw new Error('Expected parsed Team task')
    expect(Object.isFrozen(task.blockedBy)).toBe(true)
    expect(Object.isFrozen(task.claims)).toBe(true)
    expect(Object.isFrozen(task.claims.files)).toBe(true)
    const next = {
      ...state,
      revision: 1,
      updatedAt: '2026-08-24T00:00:01.000Z',
    }
    const saved = await claim.save(0, next)
    expect(saved.revision).toBe(1)
    await claim.release()
    expect(() => claim.read()).toThrow(/released/u)
    const readBack = await store.read('team-1')
    expect(readBack?.revision).toBe(1)
    expect(Object.isFrozen(readBack)).toBe(true)
    expect(Object.isFrozen(readBack?.roster)).toBe(true)
    const listed = await store.list()
    expect(listed.map((item) => item.teamId)).toEqual(['team-1'])
    expect(Object.isFrozen(listed)).toBe(true)
    expect(Object.isFrozen(listed[0])).toBe(true)
    const listedTask = listed.at(0)?.tasks.at(0)
    if (!listedTask) throw new Error('Expected listed Team task')
    expect(Object.isFrozen(listedTask.claims)).toBe(true)
  })

  it('excludes competing owners and publishes newline mode-0600 state', async () => {
    const root = await makeRoot()
    const cwd = await makeRoot()
    const store = await NativeTeamStore.open({ nativeRoot: root, cwd })
    const claim = await store.createAndClaim(snapshot(store.projectIdentity))
    await expect(store.claim('team-1')).rejects.toThrow(/already owned/u)
    await claim.release()
    await expect(
      store.createAndClaim(snapshot(store.projectIdentity)),
    ).rejects.toThrow(/state already exists/u)
    const reclaimed = await store.claim('team-1')
    await reclaimed.release()
    const path = pathFor(root, store)
    expect((await readFile(path, 'utf8')).endsWith('\n')).toBe(true)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  it('keeps absent reads and lists write-free and rejects unsafe IDs', async () => {
    const root = await makeRoot()
    const cwd = await makeRoot()
    const store = await NativeTeamStore.open({ nativeRoot: root, cwd })
    expect(await store.read('team-1')).toBeNull()
    expect(await store.list()).toEqual([])
    await expect(access(join(root, 'state', 'teams'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    for (const id of ['', '.', '..', 'a/b', 'a\\b', 'a b', 'a\0b', '/absolute'])
      await expect(store.read(id)).rejects.toThrow(/Invalid Team ID/u)
    await expect(
      NativeTeamStore.open({ nativeRoot: ' ', cwd }),
    ).rejects.toThrow(/Invalid native Team root/u)
  })

  it('fails closed for corrupt, mismatched, and incomplete matching state', async () => {
    const root = await makeRoot()
    const cwd = await makeRoot()
    const store = await NativeTeamStore.open({ nativeRoot: root, cwd })
    const path = pathFor(root, store)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, '{broken')
    await expect(store.read('team-1')).rejects.toThrow(
      /Corrupt native Team state/u,
    )
    await writeFile(
      path,
      JSON.stringify({ ...snapshot(store.projectIdentity), teamId: 'other' }),
    )
    await expect(store.read('team-1')).rejects.toThrow(
      /Invalid native Team state/u,
    )
    await writeFile(
      path,
      JSON.stringify({
        ...snapshot(store.projectIdentity),
        projectIdentity: 'other',
      }),
    )
    await expect(store.read('team-1')).rejects.toThrow(
      /Invalid native Team state/u,
    )
    await writeFile(path, JSON.stringify(snapshot(store.projectIdentity)))
    await expect(store.list()).resolves.toHaveLength(1)
    await import('node:fs/promises').then(({ rm }) => rm(path, { force: true }))
    await expect(store.list()).rejects.toThrow(/Invalid native Team state/u)
  })

  it('enforces create conflicts, CAS, timestamps, and immutable fields', async () => {
    const root = await makeRoot()
    const cwd = await makeRoot()
    const store = await NativeTeamStore.open({ nativeRoot: root, cwd })
    const claim = await store.createAndClaim(snapshot(store.projectIdentity))
    const current = await claim.read()
    const bytes = await readFile(pathFor(root, store))
    await expect(claim.save(1, { ...current, revision: 2 })).rejects.toThrow()
    for (const changes of [
      { revision: 1, updatedAt: '2026-08-24T00:00:01.000Z', teamId: 'other' },
      {
        revision: 1,
        updatedAt: '2026-08-24T00:00:01.000Z',
        projectIdentity: 'other',
      },
      {
        revision: 1,
        updatedAt: '2026-08-24T00:00:01.000Z',
        leadSessionId: 'other',
      },
      {
        revision: 1,
        updatedAt: '2026-08-24T00:00:01.000Z',
        createdAt: '2026-08-25T00:00:00.000Z',
      },
      { revision: 2, updatedAt: '2026-08-24T00:00:01.000Z' },
      { revision: 1, updatedAt: '2026-08-23T00:00:01.000Z' },
    ])
      await expect(claim.save(0, { ...current, ...changes })).rejects.toThrow()
    expect(await readFile(pathFor(root, store))).toEqual(bytes)
    await claim.release()
  })

  it('serializes same-claim stale revisions with one success and one conflict', async () => {
    const root = await makeRoot()
    const cwd = await makeRoot()
    const store = await NativeTeamStore.open({ nativeRoot: root, cwd })
    const claim = await store.createAndClaim(snapshot(store.projectIdentity))
    const current = await claim.read()
    const next = {
      ...current,
      revision: 1,
      updatedAt: '2026-08-24T00:00:01.000Z',
    }
    const results = await Promise.allSettled([
      claim.save(0, next),
      claim.save(0, next),
    ])
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1)
    const rejected = results.find((result) => result.status === 'rejected')
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: new Error('Team revision conflict: expected 0, found 1'),
    })
    const persisted = JSON.parse(await readFile(pathFor(root, store), 'utf8'))
    expect(persisted.revision).toBe(1)
    expect(persisted.teamId).toBe('team-1')
    await claim.release()
  })

  it('keeps ownership through an admitted save blocked by the mutation lease', async () => {
    const root = await makeRoot()
    const cwd = await makeRoot()
    const store = await NativeTeamStore.open({ nativeRoot: root, cwd })
    const claim = await store.createAndClaim(snapshot(store.projectIdentity))
    const current = await claim.read()
    const mutationLease = await new ExclusiveFileLease(
      `${pathFor(root, store)}.mutation.lock`,
    ).tryAcquire()
    expect(mutationLease).not.toBeNull()
    const save = claim.save(0, {
      ...current,
      revision: 1,
      updatedAt: '2026-08-24T00:00:01.000Z',
    })
    const release = claim.release()
    await expect(store.claim('team-1')).rejects.toThrow(/already owned/u)
    await mutationLease?.release()
    await save
    await release
    const reclaimed = await store.claim('team-1')
    await reclaimed.release()
    expect((await store.read('team-1'))?.revision).toBe(1)
  })

  it('makes repeated concurrent release safe and rejects later operations', async () => {
    const root = await makeRoot()
    const cwd = await makeRoot()
    const store = await NativeTeamStore.open({ nativeRoot: root, cwd })
    const claim = await store.createAndClaim(snapshot(store.projectIdentity))
    await Promise.all([claim.release(), claim.release(), claim.release()])
    expect(() => claim.read()).toThrow(/released/u)
    expect(() => claim.save(0, snapshot(store.projectIdentity))).toThrow(
      /released/u,
    )
  })

  it('sorts valid IDs and ignores unrelated entries', async () => {
    const root = await makeRoot()
    const cwd = await makeRoot()
    const store = await NativeTeamStore.open({ nativeRoot: root, cwd })
    for (const id of ['z-team', 'a-team']) {
      const claim = await store.createAndClaim({
        ...snapshot(store.projectIdentity),
        teamId: id,
      })
      await claim.release()
    }
    const projectRoot = join(
      root,
      'state',
      'teams',
      sanitizeProjectPath(store.projectIdentity),
    )
    await mkdir(join(projectRoot, 'not a team'), { recursive: true })
    expect((await store.list()).map((item) => item.teamId)).toEqual([
      'a-team',
      'z-team',
    ])
  })
})
