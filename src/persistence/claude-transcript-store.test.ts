import {
  appendFile,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { selectClaudeSchemaAdapter } from '../compatibility/claude/schema.js'
import { ClaudeTranscriptStore } from './claude-transcript-store.js'

const fixtureUrl = new URL(
  '../../test/fixtures/claude-code/2.1.208/basic-session.jsonl',
  import.meta.url,
)
const tempDirectories: string[] = []

async function createStore() {
  const root = await mkdtemp(join(tmpdir(), 'praxis-transcript-test-'))
  tempDirectories.push(root)
  const sessionFile = join(root, 'projects', 'fixture', 'session.jsonl')
  const lockFile = join(root, 'praxis', 'locks', 'session.lock')
  await mkdir(join(root, 'projects', 'fixture'), { recursive: true })
  await copyFile(fixtureUrl, sessionFile)

  return {
    root,
    sessionFile,
    lockFile,
    store: new ClaudeTranscriptStore({
      sessionFile,
      lockFile,
      schema: selectClaudeSchemaAdapter('2.1.208'),
    }),
  }
}

function firstEntry(
  snapshot: Awaited<ReturnType<ClaudeTranscriptStore['load']>>,
) {
  const entry = snapshot.entries[0]
  if (!entry) throw new Error('Fixture has no entries')
  return entry
}

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  )
})

describe('ClaudeTranscriptStore', () => {
  it('loads native entries and identifies the append parent', async () => {
    const { store } = await createStore()

    const snapshot = await store.load()

    expect(snapshot.entries).toHaveLength(3)
    expect(snapshot.tail.lastUuid).toBe('33333333-3333-4333-8333-333333333333')
    expect(snapshot.tail.byteLength).toBeGreaterThan(0)
    expect(snapshot.tail.lastLineHash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('appends one complete native JSONL entry without rewriting history', async () => {
    const { sessionFile, store } = await createStore()
    const before = await readFile(sessionFile, 'utf8')
    const snapshot = await store.load()
    const entry = {
      ...firstEntry(snapshot),
      uuid: '55555555-5555-4555-8555-555555555555',
      parentUuid: snapshot.tail.lastUuid,
      timestamp: '2026-08-03T08:00:02.000Z',
      message: { role: 'user', content: 'continue' },
    }

    const result = await store.append(snapshot.tail, entry)
    const after = await readFile(sessionFile, 'utf8')

    expect(result.status).toBe('appended')
    expect(after.startsWith(before)).toBe(true)
    expect(after.slice(before.length)).toBe(`${JSON.stringify(entry)}\n`)
  })

  it('refuses to append when an uncooperative writer advanced the tail', async () => {
    const { sessionFile, store } = await createStore()
    const snapshot = await store.load()
    const externalLine =
      '{"type":"assistant","uuid":"66666666-6666-4666-8666-666666666666"}\n'
    await appendFile(sessionFile, externalLine)
    const afterExternalWrite = await readFile(sessionFile, 'utf8')

    const result = await store.append(snapshot.tail, {
      ...firstEntry(snapshot),
      uuid: '55555555-5555-4555-8555-555555555555',
      parentUuid: snapshot.tail.lastUuid,
    })

    expect(result).toMatchObject({ status: 'conflict', reason: 'tail-changed' })
    expect(await readFile(sessionFile, 'utf8')).toBe(afterExternalWrite)
  })

  it('refuses a stale parent even when the expected tail fingerprint is current', async () => {
    const { store } = await createStore()
    const snapshot = await store.load()

    await expect(
      store.append(snapshot.tail, {
        ...firstEntry(snapshot),
        uuid: '55555555-5555-4555-8555-555555555555',
        parentUuid: null,
      }),
    ).rejects.toThrow('parentUuid does not match transcript tail')
  })

  it('refuses a tool result without its matching assistant tool call', async () => {
    const { store } = await createStore()
    const snapshot = await store.load()

    await expect(
      store.append(snapshot.tail, {
        ...firstEntry(snapshot),
        uuid: '55555555-5555-4555-8555-555555555555',
        parentUuid: snapshot.tail.lastUuid,
        sourceToolAssistantUUID: snapshot.tail.lastUuid,
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call_missing',
              content: 'unexpected',
              is_error: false,
            },
          ],
        },
      }),
    ).rejects.toThrow('no matching assistant tool_use')
  })

  it('honors a Praxis advisory lock', async () => {
    const { lockFile, store } = await createStore()
    const snapshot = await store.load()
    await mkdir(dirname(lockFile), { recursive: true })
    await writeFile(lockFile, 'other-writer')

    const result = await store.append(snapshot.tail, {
      ...firstEntry(snapshot),
      uuid: '55555555-5555-4555-8555-555555555555',
      parentUuid: snapshot.tail.lastUuid,
    })

    expect(result).toEqual({ status: 'conflict', reason: 'locked' })
  })

  it('reports corrupt JSONL position and exposes read-only recovery', async () => {
    const { sessionFile, store } = await createStore()
    const firstLine = (await readFile(fixtureUrl, 'utf8')).split('\n')[0]
    if (!firstLine) throw new Error('Fixture has no first line')
    await writeFile(sessionFile, `${firstLine}\n{\n`)

    await expect(store.load()).rejects.toMatchObject({
      name: 'ClaudeTranscriptParseError',
      lineNumber: 2,
      byteOffset: Buffer.byteLength(`${firstLine}\n`),
    })

    const recovery = await store.loadReadOnly()
    expect(recovery.entries).toHaveLength(1)
    expect(recovery.issue).toMatchObject({
      lineNumber: 2,
      byteOffset: Buffer.byteLength(`${firstLine}\n`),
    })
  })
})
