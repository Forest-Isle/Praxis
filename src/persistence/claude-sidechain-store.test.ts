import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { selectClaudeSchemaAdapter } from '../compatibility/claude/schema.js'
import {
  createClaudeSidechainRoot,
  resolveClaudeSidechainPaths,
} from '../compatibility/claude/sidechain.js'
import { ClaudeSidechainStore } from './claude-sidechain-store.js'

const SESSION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER_SESSION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const AGENT_ID = '0123456789abcdef'
const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  )
})

async function createStore() {
  const rootDirectory = await mkdtemp(join(tmpdir(), 'praxis-sidechain-store-'))
  roots.push(rootDirectory)
  const paths = resolveClaudeSidechainPaths(
    join(rootDirectory, 'projects'),
    SESSION_ID,
    AGENT_ID,
  )
  const store = new ClaudeSidechainStore(
    paths,
    join(rootDirectory, 'locks', 'sidechain.lock'),
    selectClaudeSchemaAdapter('2.1.208'),
  )
  const root = createClaudeSidechainRoot({
    sessionId: SESSION_ID,
    promptId: '11111111-1111-4111-8111-111111111111',
    prompt: 'Inspect this.',
    agentId: AGENT_ID,
    cwd: '/tmp/praxis-sidechain',
    claudeVersion: '2.1.208',
    gitBranch: null,
    uuid: '22222222-2222-4222-8222-222222222222',
    timestamp: '2026-08-04T00:00:00.000Z',
  })
  const metadata = {
    agentType: 'general-purpose',
    description: 'Inspect',
    toolUseId: 'call_agent',
    spawnDepth: 1,
  }
  return { paths, root, metadata, store }
}

describe('ClaudeSidechainStore', () => {
  it('rejects invalid session and agent IDs before resolving paths', () => {
    expect(() =>
      resolveClaudeSidechainPaths('/tmp/project', '../escape', AGENT_ID),
    ).toThrow('Invalid Claude session ID')
    expect(() =>
      resolveClaudeSidechainPaths('/tmp/project', SESSION_ID, '../escape'),
    ).toThrow('Invalid Claude agent ID')
  })

  it('rejects roots whose identity does not match the physical paths', async () => {
    const { paths, root, metadata, store } = await createStore()

    await expect(
      store.create({ ...root, agentId: 'fedcba9876543210' }, metadata),
    ).rejects.toThrow('Claude sidechain root identity does not match paths')

    await expect(readFile(paths.metadataFile, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await expect(readFile(paths.transcriptFile, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('rejects appended entries with a different sidechain identity', async () => {
    const { root, metadata, store } = await createStore()
    await store.create(root, metadata)

    await expect(
      store.withLease(async (lease) => {
        const snapshot = await lease.load()
        return lease.append(snapshot.tail, {
          ...root,
          parentUuid: root.uuid,
          uuid: '33333333-3333-4333-8333-333333333333',
          sessionId: OTHER_SESSION_ID,
          message: { role: 'user', content: 'Wrong session.' },
        })
      }),
    ).rejects.toThrow('Sidechain entry identity does not match history')
  })

  it('rejects appended entries whose parent does not match the tail', async () => {
    const { root, metadata, store } = await createStore()
    await store.create(root, metadata)

    await expect(
      store.withLease(async (lease) => {
        const snapshot = await lease.load()
        return lease.append(snapshot.tail, {
          ...root,
          parentUuid: null,
          uuid: '33333333-3333-4333-8333-333333333333',
          message: { role: 'user', content: 'Stale parent.' },
        })
      }),
    ).rejects.toThrow('Sidechain entry parentUuid does not match tail')
  })

  it('rejects roots for unsupported Claude versions', async () => {
    const { paths, root, metadata, store } = await createStore()

    await expect(
      store.create({ ...root, version: '2.1.209' }, metadata),
    ).rejects.toThrow('Claude sidechain append must target Claude Code 2.1.208')
    await expect(readFile(paths.metadataFile, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await expect(readFile(paths.transcriptFile, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('preserves existing metadata when creation collides', async () => {
    const { paths, root, metadata, store } = await createStore()
    await mkdir(paths.directory, { recursive: true })
    const existing = '{"owner":"existing"}\n'
    await writeFile(paths.metadataFile, existing)

    await expect(store.create(root, metadata)).rejects.toMatchObject({
      code: 'EEXIST',
    })

    expect(await readFile(paths.metadataFile, 'utf8')).toBe(existing)
    await expect(readFile(paths.transcriptFile, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})
