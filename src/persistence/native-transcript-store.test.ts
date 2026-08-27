import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { TranscriptEvent } from '../core/transcript-event.js'
import { InMemoryTranscriptStore } from './in-memory-transcript-store.js'
import {
  NativeTranscriptStore,
  type NativeTranscriptTail,
} from './native-transcript-store.js'

const roots: string[] = []
const timestamp = '2026-08-23T00:00:00.000Z'
function message(
  id: string,
  parentId: string | null,
  content = id,
): TranscriptEvent {
  return {
    kind: 'messages',
    id,
    parentId,
    sessionId: 'session',
    timestamp,
    messages: [{ role: 'user', content }],
  }
}
function boundary(id: string, logicalParentId: string): TranscriptEvent {
  return {
    kind: 'context-boundary',
    id,
    parentId: null,
    sessionId: 'session',
    timestamp,
    logicalParentId,
    trigger: 'manual',
    preTokens: 1,
    postTokens: 1,
    durationMs: 1,
  }
}
function summary(
  id: string,
  parentId: string,
  text = 'summary',
): TranscriptEvent {
  return {
    kind: 'context-summary',
    id,
    parentId,
    sessionId: 'session',
    timestamp,
    summary: text,
  }
}
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'praxis-native-transcript-test-'))
  roots.push(root)
  const transcriptFile = join(root, 'transcripts', 'session.jsonl')
  const lockFile = join(root, 'locks', 'session.lock')
  await mkdir(join(root, 'transcripts'), { recursive: true })
  return {
    transcriptFile,
    lockFile,
    store: new NativeTranscriptStore({ transcriptFile, lockFile }),
  }
}
async function exists(path: string) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe('NativeTranscriptStore', () => {
  it('loads missing and empty files with the exact snapshot shape', async () => {
    const { store, transcriptFile } = await setup()
    expect(await store.load()).toEqual({
      records: [],
      tail: {
        byteLength: 0,
        lastLineHash: null,
        lastEventId: null,
        newlineTerminated: true,
      },
    })
    await writeFile(transcriptFile, '')
    const loaded = await store.load()
    expect(Object.keys(loaded)).toEqual(['records', 'tail'])
    expect((await store.loadReadOnly()).issue).toBeNull()
  })

  it('creates canonical bytes, enforces mode, and reports create/reserve conflicts', async () => {
    const { store, transcriptFile } = await setup()
    const result = await store.create([message('one', null)])
    expect(result.status).toBe('created')
    const bytes = await readFile(transcriptFile)
    expect(bytes.at(-1)).toBe(0x0a)
    expect(JSON.parse(bytes.toString()).schema).toBe('praxis.transcript')
    expect(JSON.parse(bytes.toString())).not.toHaveProperty('producerVersion')
    expect((await stat(transcriptFile)).mode & 0o777).toBe(0o600)
    expect(await store.create([message('other', null)])).toEqual({
      status: 'conflict',
      reason: 'already-exists',
    })
    const reserved = await setup()
    expect(
      await reserved.store.withLease((lease) => lease.reserve()),
    ).toMatchObject({ status: 'completed', value: { status: 'reserved' } })
    expect(
      await reserved.store.withLease((lease) => lease.reserve()),
    ).toMatchObject({
      status: 'completed',
      value: { status: 'conflict', reason: 'already-exists' },
    })
  })

  it('rejects invalid batches before creation and preserves existing bytes', async () => {
    const { store, transcriptFile } = await setup()
    const invalid = { ...message('bad', null), parentId: 4 as unknown as null }
    await expect(store.create([invalid])).rejects.toThrow(/native transcript/i)
    expect(await exists(transcriptFile)).toBe(false)
    await store.create([message('one', null)])
    const before = await readFile(transcriptFile)
    await expect(
      store.append((await store.load()).tail, message('two', 'wrong')),
    ).rejects.toThrow(/parentId/)
    expect(await readFile(transcriptFile)).toEqual(before)
  })

  it('strictly rejects dangling historical parents without changing bytes', async () => {
    const { store, transcriptFile } = await setup()
    const root = message('one', null)
    const dangling = message('dangling', 'missing')
    const line = (event: TranscriptEvent) =>
      `${JSON.stringify({ schema: 'praxis.transcript', version: 1, event })}\n`
    await writeFile(transcriptFile, line(root) + line(dangling))
    const before = await readFile(transcriptFile)

    await expect(store.load()).rejects.toThrow(/parentId.*earlier/i)
    expect(await readFile(transcriptFile)).toEqual(before)
  })

  it('detects stale tails and dangling branch parents', async () => {
    const { store } = await setup()
    await store.create([message('one', null)])
    const tail = (await store.load()).tail
    const stale: NativeTranscriptTail = {
      ...tail,
      byteLength: tail.byteLength + 1,
    }
    expect(await store.append(stale, message('two', null))).toEqual({
      status: 'conflict',
      reason: 'tail-changed',
    })
    await expect(
      store.append(
        { ...tail, branchParentId: 'missing' },
        message('two', 'missing'),
      ),
    ).rejects.toThrow(/native transcript.*branchParentId/i)
  })

  it('enforces IDs, sessions, branch parents, and context boundary-summary links', async () => {
    const { store } = await setup()
    await store.create([message('one', null)])
    const tail = (await store.load()).tail
    await expect(store.append(tail, message('one', 'one'))).rejects.toThrow(
      /event IDs/,
    )
    await expect(
      store.append(tail, { ...message('two', 'one'), sessionId: 'other' }),
    ).rejects.toThrow(/sessionId/)
    const branch = await store.append(
      { ...tail, branchParentId: 'one' },
      message('branch', 'one'),
    )
    expect(branch.status).toBe('appended')
  })

  it('supports context boundary and summary as one lease batch', async () => {
    const { store } = await setup()
    await store.create([message('one', null)])
    const tail = (await store.load()).tail
    const result = await store.withLease((lease) =>
      lease.appendMany(tail, [
        boundary('boundary', 'one'),
        summary('summary', 'boundary'),
      ]),
    )
    expect(result.status).toBe('completed')
    expect(
      (await store.load()).records.map((record) => record.event.id),
    ).toEqual(['one', 'boundary', 'summary'])
  })

  it('recovers a valid prefix while strict load rejects malformed bytes', async () => {
    const { store, transcriptFile } = await setup()
    const line = JSON.stringify({
      schema: 'praxis.transcript',
      version: 1,
      event: message('one', null),
    })
    await writeFile(transcriptFile, `${line}\n{bad`)
    expect((await store.loadReadOnly()).issue?.kind).toBe('corrupt-line')
    expect((await store.loadReadOnly()).records).toHaveLength(1)
    await expect(store.load()).rejects.toThrow(/native transcript/i)
  })

  it('rejects unknown and duplicate tool results and duplicate calls', async () => {
    const { store } = await setup()
    const call = { id: 'call', name: 'tool', input: {} }
    const assistant = (id: string, parentId: string | null): TranscriptEvent =>
      ({
        ...message(id, parentId),
        messages: [{ role: 'assistant', content: '', toolCalls: [call] }],
      }) as Extract<TranscriptEvent, { kind: 'messages' }>
    const tool = (
      id: string,
      parentId: string | null,
      toolCallId = 'call',
    ): TranscriptEvent =>
      ({
        ...message(id, parentId),
        messages: [{ role: 'tool', toolCallId, content: '', isError: false }],
      }) as Extract<TranscriptEvent, { kind: 'messages' }>
    await expect(
      store.create([tool('result', null, 'unknown')]),
    ).rejects.toThrow(/unknown tool call/)
    await store.create([assistant('assistant', null)])
    const tail = (await store.load()).tail
    await store.append(tail, tool('result', 'assistant'))
    const next = await store.load()
    await expect(
      store.append(next.tail, tool('duplicate', 'result')),
    ).rejects.toThrow(/multiple results/)
    await expect(
      store.append(next.tail, assistant('duplicate-call', 'result')),
    ).rejects.toThrow(/tool-call IDs/)
  })

  it('rejects a result for a call on an abandoned sibling branch', async () => {
    const { store, transcriptFile } = await setup()
    const call = { id: 'sibling-call', name: 'tool', input: {} }
    const root = message('root', null)
    const abandoned = {
      ...message('abandoned', 'root'),
      messages: [{ role: 'assistant', content: '', toolCalls: [call] }],
    } as Extract<TranscriptEvent, { kind: 'messages' }>
    const selected = message('selected', 'root')
    await store.create([root])
    const firstTail = await store.load()
    const abandonedAppend = await store.append(
      { ...firstTail.tail, branchParentId: 'root' },
      abandoned,
    )
    if (abandonedAppend.status !== 'appended')
      throw new Error('Could not append abandoned branch fixture')
    const selectedAppend = await store.append(
      { ...abandonedAppend.tail, branchParentId: 'root' },
      selected,
    )
    expect(selectedAppend.status).toBe('appended')
    const before = await readFile(transcriptFile)
    const result = {
      ...message('result', 'selected'),
      messages: [
        { role: 'tool', toolCallId: call.id, content: '', isError: false },
      ],
    } as Extract<TranscriptEvent, { kind: 'messages' }>

    await expect(
      store.append((await store.load()).tail, result),
    ).rejects.toThrow(/active ancestry/i)
    expect(await readFile(transcriptFile)).toEqual(before)
  })

  it('returns locked when another writer owns the advisory lease', async () => {
    const first = await setup()
    const second = new NativeTranscriptStore({
      transcriptFile: first.transcriptFile,
      lockFile: first.lockFile,
    })
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let enteredLease!: () => void
    const entered = new Promise<void>((resolve) => {
      enteredLease = resolve
    })
    const owner = first.store.withLease(async () => {
      enteredLease()
      await held
    })
    await entered
    expect(await second.withLease(async () => 'unexpected')).toEqual({
      status: 'conflict',
      reason: 'locked',
    })
    release()
    await owner
  })
})

describe('InMemoryTranscriptStore', () => {
  it('exposes the same non-authoritative entry projection as the native store', async () => {
    const store = new InMemoryTranscriptStore()
    const result = await store.withLease(async (lease) => {
      const initial = await lease.load()
      await expect(lease.reserve()).resolves.toEqual({ status: 'reserved' })
      await expect(
        lease.append(initial.tail, message('one', null)),
      ).resolves.toEqual(expect.objectContaining({ status: 'appended' }))
      const loaded = await lease.load()
      expect(loaded.records.map((record) => record.event.id)).toEqual(['one'])
      expect(loaded.entries).toEqual([
        expect.objectContaining({
          type: 'user',
          uuid: 'one',
          parentUuid: null,
          message: { role: 'user', content: 'one' },
        }),
      ])
      expect(Object.keys(loaded)).toEqual(['records', 'tail'])
    })
    expect(result.status).toBe('completed')
  })
})
