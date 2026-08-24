import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { ModelMessage } from '../core/runtime.js'
import {
  type NativeTranscriptLease,
  NativeTranscriptStore,
} from '../persistence/native-transcript-store.js'
import { NativeSessionTranscript } from './native-session-transcript.js'

const roots: string[] = []
const timestamp = '2026-08-23T00:00:00.000Z'
const user = (content: string): ModelMessage => ({ role: 'user', content })
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'praxis-native-session-test-'))
  roots.push(root)
  const store = new NativeTranscriptStore({
    transcriptFile: join(root, 'session.jsonl'),
    lockFile: join(root, 'session.lock'),
  })
  return { store, file: join(root, 'session.jsonl'), root }
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe('NativeSessionTranscript', () => {
  it('starts, appends, and reloads canonical messages', async () => {
    const { store, file } = await setup()
    const transcript = new NativeSessionTranscript({
      sessionId: 'session',
      store,
      createId: (() => {
        let n = 0
        return () => `event-${++n}`
      })(),
      now: () => timestamp,
    })
    await transcript.withLease({ kind: 'start' }, async (lease) => {
      expect(lease.activeMessages()).toEqual([])
      await lease.appendMessages({ messages: [user('hello')] })
      expect(lease.activeMessages()).toEqual([user('hello')])
    })
    const source = await readFile(file, 'utf8')
    expect(source).toContain('"schema":"praxis.transcript"')
    expect(source).not.toContain('producerVersion')
    expect((await store.load()).records).toHaveLength(1)
    await expect(
      transcript.withLease({ kind: 'start' }, async () => undefined),
    ).rejects.toThrow(/already exists/)
  })

  it('resumes at an explicit checkpoint and branches the active history', async () => {
    const first = await setup()
    const ids = ['one', 'two', 'three']
    const source = new NativeSessionTranscript({
      sessionId: 'session',
      store: first.store,
      createId: () => ids.shift() ?? 'extra',
      now: () => timestamp,
    })
    await source.withLease({ kind: 'start' }, async (lease) => {
      await lease.appendMessages({ messages: [user('one')] })
      await lease.appendMessages({ messages: [user('two')] })
      await lease.appendMessages({ messages: [user('three')] })
    })
    const branch = new NativeSessionTranscript({
      sessionId: 'session',
      store: first.store,
      createId: () => 'branch',
      now: () => timestamp,
    })
    await branch.withLease(
      { kind: 'resume', atEventId: 'one' },
      async (lease) => {
        expect(lease.activeMessages()).toEqual([user('one')])
        await lease.appendMessages({ messages: [user('branched')] })
      },
    )
    const snapshot = await first.store.load()
    expect(snapshot.records.map((record) => record.event.id)).toEqual([
      'one',
      'two',
      'three',
      'branch',
    ])
    expect(snapshot.records.at(-1)?.event.parentId).toBe('one')
  })

  it('chooses the deterministic active leaf on default resume', async () => {
    const { store } = await setup()
    const create = new NativeSessionTranscript({
      sessionId: 'session',
      store,
      createId: (() => {
        let n = 0
        return () => `id-${++n}`
      })(),
      now: () => timestamp,
    })
    await create.withLease({ kind: 'start' }, async (lease) => {
      await lease.appendMessages({ messages: [user('first')] })
    })
    const tail = (await store.load()).tail
    await store.append(tail, {
      kind: 'messages',
      id: 'other',
      parentId: 'id-1',
      sessionId: 'session',
      timestamp,
      messages: [user('other')],
    })
    const resume = new NativeSessionTranscript({
      sessionId: 'session',
      store,
      createId: () => 'leaf',
      now: () => timestamp,
    })
    await resume.withLease({ kind: 'resume' }, async (lease) => {
      expect(lease.activeMessages()).toEqual([user('first'), user('other')])
    })
  })

  it('rejects empty, unknown, corrupt, mismatched, and conflicting resumes before append', async () => {
    const empty = await setup()
    const transcript = new NativeSessionTranscript({
      sessionId: 'session',
      store: empty.store,
    })
    const reserved = await empty.store.withLease((lease) => lease.reserve())
    expect(reserved).toMatchObject({
      status: 'completed',
      value: { status: 'reserved' },
    })
    await expect(
      transcript.withLease({ kind: 'resume' }, async () => undefined),
    ).rejects.toThrow(/missing or empty/)
    const missing = await setup()
    const started = new NativeSessionTranscript({
      sessionId: 'session',
      store: missing.store,
      createId: () => 'one',
      now: () => timestamp,
    })
    await started.withLease({ kind: 'start' }, async (lease) => {
      await expect(lease.appendMessages({ messages: [] })).rejects.toThrow(
        /empty messages/,
      )
      await lease.appendMessages({ messages: [user('first')] })
    })
    await expect(
      started.withLease(
        { kind: 'resume', atEventId: 'unknown' },
        async () => undefined,
      ),
    ).rejects.toThrow(/Unknown transcript checkpoint/)
  })

  it('does not reserve a missing transcript when the native lease is locked', async () => {
    const { store, file } = await setup()
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let enteredLease!: () => void
    const entered = new Promise<void>((resolve) => {
      enteredLease = resolve
    })
    const owner = store.withLease(async () => {
      enteredLease()
      await held
    })
    await entered

    const transcript = new NativeSessionTranscript({
      sessionId: 'session',
      store,
    })
    await expect(
      transcript.withLease({ kind: 'start' }, async () => undefined),
    ).rejects.toThrow('native transcript lease conflict: locked')
    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' })

    release()
    await owner
  })

  it('atomically appends a compact boundary, summary, and optional suffix', async () => {
    const { store } = await setup()
    const transcript = new NativeSessionTranscript({
      sessionId: 'session',
      store,
      createId: (() => {
        let n = 0
        return () => `event-${++n}`
      })(),
      now: () => timestamp,
    })
    await transcript.withLease({ kind: 'start' }, async (lease) => {
      await lease.appendMessages({ messages: [user('before')] })
      await lease.appendMessages({ messages: [user('current')] })
      await lease.appendCompaction({
        summary: 'condensed',
        trigger: 'auto',
        preTokens: 20,
        postTokens: 8,
        durationMs: 2,
        preservedMessages: [user('current'), user('suffix')],
      })
      expect(lease.activeMessages()).toEqual([
        user('condensed'),
        user('current'),
        user('suffix'),
      ])
    })
    const snapshot = await store.load()
    expect(snapshot.records.map((record) => record.event.kind)).toEqual([
      'messages',
      'messages',
      'context-boundary',
      'context-summary',
      'messages',
    ])
    const checkpoint = new NativeSessionTranscript({
      sessionId: 'session',
      store,
    })
    await checkpoint.withLease(
      { kind: 'resume', atEventId: 'event-1' },
      async (lease) => {
        expect(lease.activeMessages()).toEqual([user('before')])
      },
    )
  })

  it('rejects unresolved compaction without changing transcript bytes', async () => {
    const { store, file } = await setup()
    const transcript = new NativeSessionTranscript({
      sessionId: 'session',
      store,
      createId: (() => {
        let n = 0
        return () => `unresolved-${++n}`
      })(),
      now: () => timestamp,
    })
    await transcript.withLease({ kind: 'start' }, async (lease) => {
      await lease.appendMessages({
        messages: [
          user('before'),
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'pending-call', name: 'Read', input: {} }],
          },
        ],
      })
    })
    const before = await readFile(file, 'utf8')

    await expect(
      transcript.withLease({ kind: 'resume' }, (lease) =>
        lease.appendCompaction({
          summary: 'must not persist',
          trigger: 'manual',
          preTokens: 10,
          postTokens: 3,
          durationMs: 1,
        }),
      ),
    ).rejects.toThrow(/unresolved tool calls/u)
    expect(await readFile(file, 'utf8')).toBe(before)
  })

  it('keeps its active projection unchanged when the atomic append conflicts', async () => {
    const { store } = await setup()
    const seed = new NativeSessionTranscript({
      sessionId: 'session',
      store,
      createId: () => 'seed',
      now: () => timestamp,
    })
    await seed.withLease({ kind: 'start' }, (lease) =>
      lease.appendMessages({ messages: [user('before')] }),
    )
    const snapshot = await store.load()
    const conflictingStore = {
      async withLease(
        operation: Parameters<NativeTranscriptStore['withLease']>[0],
      ) {
        const value = await operation({
          reserve: async () => ({
            status: 'conflict',
            reason: 'already-exists',
          }),
          load: async () => snapshot,
          append: async () => ({ status: 'conflict', reason: 'tail-changed' }),
          appendMany: async () => ({
            status: 'conflict',
            reason: 'tail-changed',
          }),
        })
        return { status: 'completed', value } as const
      },
    } as unknown as NativeTranscriptStore
    const transcript = new NativeSessionTranscript({
      sessionId: 'session',
      store: conflictingStore,
      createId: (() => {
        let n = 0
        return () => `conflict-${++n}`
      })(),
      now: () => timestamp,
    })

    await transcript.withLease({ kind: 'resume' }, async (lease) => {
      const before = lease.activeMessages()
      await expect(
        lease.appendCompaction({
          summary: 'must not become active',
          trigger: 'auto',
          preTokens: 10,
          postTokens: 3,
          durationMs: 1,
        }),
      ).rejects.toThrow(/append conflict: tail-changed/u)
      expect(lease.activeMessages()).toEqual(before)
    })
  })

  it('forks one selected lineage and makes ensureFork idempotent', async () => {
    const sourceSetup = await setup()
    const targetSetup = await setup()
    const source = new NativeSessionTranscript({
      sessionId: 'source',
      store: sourceSetup.store,
      createId: (() => {
        let n = 0
        return () => `source-${++n}`
      })(),
      now: () => timestamp,
    })
    const target = new NativeSessionTranscript({
      sessionId: 'target',
      store: targetSetup.store,
      createId: () => 'target-id',
      now: () => timestamp,
    })
    await source.withLease({ kind: 'start' }, async (lease) => {
      await lease.appendMessages({ messages: [user('root')] })
      await lease.appendMessages({ messages: [user('selected')] })
    })
    const sourceBytes = await readFile(sourceSetup.file, 'utf8')
    await source.forkTo(target)
    expect(await readFile(sourceSetup.file, 'utf8')).toBe(sourceBytes)
    const targetSnapshot = await targetSetup.store.load()
    expect(
      targetSnapshot.records.map((record) => record.event.sessionId),
    ).toEqual(['target', 'target'])
    await source.forkTo(target, { ensureExisting: true })
    expect(await readFile(targetSetup.file, 'utf8')).toBe(
      (await targetSetup.store.exportReadOnly()).toString(),
    )
    await expect(source.forkTo(target)).rejects.toThrow('already exists')
    const checkpointSetup = await setup()
    const checkpointTarget = new NativeSessionTranscript({
      sessionId: 'checkpoint-target',
      store: checkpointSetup.store,
    })
    await source.forkTo(checkpointTarget, { atEventId: 'source-1' })
    expect(
      (await checkpointSetup.store.load()).records.map((record) =>
        record.event.kind === 'messages' ? record.event.messages : [],
      ),
    ).toEqual([[user('root')]])
  })

  it('forks only the selected sibling lineage and preserves valid child continuation', async () => {
    const sourceSetup = await setup()
    const source = new NativeSessionTranscript({
      sessionId: 'source',
      store: sourceSetup.store,
      createId: (() => {
        const ids = ['root', 'branch-a', 'branch-z']
        return () => ids.shift() ?? 'extra'
      })(),
      now: () => timestamp,
    })
    await source.withLease({ kind: 'start' }, async (lease) => {
      await lease.appendMessages({ messages: [user('root')] })
      await lease.appendMessages({ messages: [user('old branch')] })
    })
    await source.withLease({ kind: 'resume', atEventId: 'root' }, (lease) =>
      lease.appendMessages({ messages: [user('new branch')] }),
    )
    const defaultSetup = await setup()
    const defaultTarget = new NativeSessionTranscript({
      sessionId: 'default-target',
      store: defaultSetup.store,
      createId: () => 'continuation',
      now: () => timestamp,
    })
    await source.forkTo(defaultTarget)
    await defaultTarget.withLease({ kind: 'resume' }, async (lease) => {
      expect(lease.activeMessages()).toEqual([user('root'), user('new branch')])
      await lease.appendMessages({ messages: [user('child continuation')] })
    })
    const continuedBytes = await readFile(defaultSetup.file, 'utf8')
    await source.forkTo(defaultTarget, { ensureExisting: true })
    expect(await readFile(defaultSetup.file, 'utf8')).toBe(continuedBytes)

    const oldSetup = await setup()
    const oldTarget = new NativeSessionTranscript({
      sessionId: 'old-target',
      store: oldSetup.store,
    })
    await source.forkTo(oldTarget, { atEventId: 'branch-a' })
    await oldTarget.withLease({ kind: 'resume' }, async (lease) => {
      expect(lease.activeMessages()).toEqual([user('root'), user('old branch')])
    })
  })

  it('forks pre-compact history or compacted context at the selected checkpoint', async () => {
    const sourceSetup = await setup()
    const source = new NativeSessionTranscript({
      sessionId: 'source',
      store: sourceSetup.store,
      createId: (() => {
        let n = 0
        return () => `compact-${++n}`
      })(),
      now: () => timestamp,
    })
    await source.withLease({ kind: 'start' }, async (lease) => {
      await lease.appendMessages({ messages: [user('original')] })
      await lease.appendCompaction({
        summary: 'summary',
        trigger: 'manual',
        preTokens: 10,
        postTokens: 3,
        durationMs: 1,
      })
    })

    const beforeSetup = await setup()
    const beforeTarget = new NativeSessionTranscript({
      sessionId: 'before-target',
      store: beforeSetup.store,
    })
    await source.forkTo(beforeTarget, { atEventId: 'compact-1' })
    await beforeTarget.withLease({ kind: 'resume' }, async (lease) => {
      expect(lease.activeMessages()).toEqual([user('original')])
    })

    const compactedSetup = await setup()
    const compactedTarget = new NativeSessionTranscript({
      sessionId: 'compacted-target',
      store: compactedSetup.store,
    })
    await source.forkTo(compactedTarget)
    await compactedTarget.withLease({ kind: 'resume' }, async (lease) => {
      expect(lease.activeMessages()).toEqual([user('summary')])
    })
    await expect(
      source.forkTo(
        new NativeSessionTranscript({
          sessionId: 'incomplete-target',
          store: (await setup()).store,
        }),
        { recordCount: 2 },
      ),
    ).rejects.toThrow(/incomplete context boundary/u)
  })

  it('fails closed for invalid fork identity, frozen checkpoints, and mismatched targets', async () => {
    const sourceSetup = await setup()
    const source = new NativeSessionTranscript({
      sessionId: 'source',
      store: sourceSetup.store,
      createId: (() => {
        let n = 0
        return () => `frozen-${++n}`
      })(),
      now: () => timestamp,
    })
    await source.withLease({ kind: 'start' }, async (lease) => {
      await lease.appendMessages({ messages: [user('one')] })
      await lease.appendMessages({ messages: [user('two')] })
    })
    const createTarget = async (sessionId: string) =>
      new NativeSessionTranscript({ sessionId, store: (await setup()).store })
    for (const recordCount of [0, 1.5, 3])
      await expect(
        source.forkTo(await createTarget(`count-${recordCount}`), {
          recordCount,
        }),
      ).rejects.toThrow(/recordCount/u)
    await expect(
      source.forkTo(await createTarget('outside-prefix'), {
        atEventId: 'frozen-2',
        recordCount: 1,
      }),
    ).rejects.toThrow(/Unknown transcript checkpoint/u)
    await expect(source.forkTo(source)).rejects.toThrow(/must differ/u)
    await expect(
      new NativeSessionTranscript({
        sessionId: 'wrong-source',
        store: sourceSetup.store,
      }).forkTo(await createTarget('wrong-source-target')),
    ).rejects.toThrow(/sessionId does not match/u)

    const mismatchSetup = await setup()
    const mismatch = new NativeSessionTranscript({
      sessionId: 'mismatch-target',
      store: mismatchSetup.store,
      createId: () => 'different',
      now: () => timestamp,
    })
    await mismatch.withLease({ kind: 'start' }, (lease) =>
      lease.appendMessages({ messages: [user('different')] }),
    )
    const mismatchBytes = await readFile(mismatchSetup.file, 'utf8')
    await expect(
      source.forkTo(mismatch, { ensureExisting: true }),
    ).rejects.toThrow(/not the expected native fork/u)
    expect(await readFile(mismatchSetup.file, 'utf8')).toBe(mismatchBytes)
  })

  it('surfaces source and target lock conflicts without modifying either transcript', async () => {
    const sourceSetup = await setup()
    const targetSetup = await setup()
    const source = new NativeSessionTranscript({
      sessionId: 'source',
      store: sourceSetup.store,
      createId: () => 'root',
      now: () => timestamp,
    })
    const target = new NativeSessionTranscript({
      sessionId: 'target',
      store: targetSetup.store,
    })
    await source.withLease({ kind: 'start' }, (lease) =>
      lease.appendMessages({ messages: [user('root')] }),
    )
    const sourceBytes = await readFile(sourceSetup.file, 'utf8')
    let releaseSource!: () => void
    let sourceEntered!: () => void
    const sourceHeld = new Promise<void>((resolve) => {
      releaseSource = resolve
    })
    const sourceReady = new Promise<void>((resolve) => {
      sourceEntered = resolve
    })
    const sourceOwner = sourceSetup.store.withLease(async () => {
      sourceEntered()
      await sourceHeld
    })
    await sourceReady
    await expect(source.forkTo(target)).rejects.toThrow(
      /source lease conflict: locked/u,
    )
    releaseSource()
    await sourceOwner

    let releaseTarget!: () => void
    let targetEntered!: () => void
    const targetHeld = new Promise<void>((resolve) => {
      releaseTarget = resolve
    })
    const targetReady = new Promise<void>((resolve) => {
      targetEntered = resolve
    })
    const targetOwner = targetSetup.store.withLease(async () => {
      targetEntered()
      await targetHeld
    })
    await targetReady
    await expect(source.forkTo(target)).rejects.toThrow(
      /target lease conflict: locked/u,
    )
    releaseTarget()
    await targetOwner
    expect(await readFile(sourceSetup.file, 'utf8')).toBe(sourceBytes)
    await expect(readFile(targetSetup.file)).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('classifies recoverable calls, durably claims them, and appends results atomically', async () => {
    const { store } = await setup()
    const transcript = new NativeSessionTranscript({
      sessionId: 'session',
      store,
      createId: (() => {
        let n = 0
        return () => `event-${++n}`
      })(),
      now: () => timestamp,
    })
    const call = { id: 'call-1', name: 'Read', input: {} }
    await transcript.withLease({ kind: 'start' }, async (lease) => {
      await lease.appendMessages({
        messages: [{ role: 'assistant', content: '', toolCalls: [call] }],
      })
      expect(lease.interruption()).toEqual({
        kind: 'recoverable-tools',
        calls: [call],
      })
      await lease.beginToolExecution(call.id)
      expect(lease.interruption()).toEqual({
        kind: 'indeterminate-tools',
        callIds: [call.id],
      })
      await lease.appendToolCompletion({
        callId: call.id,
        result: { content: 'done', isError: false },
        followUpUserMessages: ['follow up'],
      })
      expect(lease.activeMessages()).toEqual([
        { role: 'assistant', content: '', toolCalls: [call] },
        { role: 'tool', toolCallId: call.id, content: 'done', isError: false },
        { role: 'user', content: 'follow up' },
      ])
    })
    expect(
      (await store.load()).records.map((record) => record.event.kind),
    ).toEqual(['messages', 'tool-execution-started', 'messages'])
  })

  it('classifies only the final visible message event after the active boundary', async () => {
    const { store } = await setup()
    const transcript = new NativeSessionTranscript({
      sessionId: 'session',
      store,
      createId: (() => {
        let n = 0
        return () => `classification-${++n}`
      })(),
      now: () => timestamp,
    })
    const call = { id: 'call-tail', name: 'Read', input: {} }

    await transcript.withLease({ kind: 'start' }, async (lease) => {
      expect(lease.interruption()).toEqual({ kind: 'none' })
      await lease.appendMessages({ messages: [user('pending prompt')] })
      expect(lease.interruption()).toEqual({
        kind: 'interrupted-prompt',
        prompt: 'pending prompt',
      })
      await lease.appendMessages({
        messages: [{ role: 'assistant', content: 'finished' }],
      })
      expect(lease.interruption()).toEqual({ kind: 'complete' })
      await lease.appendMessages({
        messages: [{ role: 'assistant', content: '', toolCalls: [call] }],
      })
      await lease.beginToolExecution(call.id)
      await lease.appendToolCompletion({
        callId: call.id,
        result: { content: 'result', isError: false },
        followUpUserMessages: ['same-batch follow-up'],
      })
      expect(lease.interruption()).toEqual({ kind: 'interrupted-turn' })

      await lease.appendMessages({ messages: [user('fresh prompt')] })
      expect(lease.interruption()).toEqual({
        kind: 'interrupted-prompt',
        prompt: 'fresh prompt',
      })
      await lease.appendMessages({
        messages: [{ role: 'assistant', content: 'fresh answer' }],
      })
      await lease.appendCompaction({
        summary: 'summary only',
        trigger: 'manual',
        preTokens: 10,
        postTokens: 2,
        durationMs: 1,
      })
      expect(lease.interruption()).toEqual({ kind: 'none' })
    })
  })

  it('fails closed for mixed, duplicate, resolved, off-branch, and pre-compaction claims', async () => {
    const mixedSetup = await setup()
    const mixed = new NativeSessionTranscript({
      sessionId: 'mixed',
      store: mixedSetup.store,
      createId: (() => {
        let n = 0
        return () => `mixed-${++n}`
      })(),
      now: () => timestamp,
    })
    const first = { id: 'call-first', name: 'Read', input: {} }
    const second = { id: 'call-second', name: 'Read', input: {} }
    await mixed.withLease({ kind: 'start' }, async (lease) => {
      await lease.appendMessages({
        messages: [
          { role: 'assistant', content: '', toolCalls: [first, second] },
        ],
      })
      await expect(lease.beginToolExecution('unknown')).rejects.toThrow(
        'Unknown native tool call: unknown',
      )
      await lease.beginToolExecution(first.id)
      await expect(lease.beginToolExecution(first.id)).rejects.toThrow(
        `Native tool call already claimed: ${first.id}`,
      )
      expect(lease.interruption()).toEqual({
        kind: 'indeterminate-tools',
        callIds: [first.id],
      })
      await lease.appendToolCompletion({
        callId: first.id,
        result: { content: 'done', isError: false },
      })
      await expect(lease.beginToolExecution(first.id)).rejects.toThrow(
        `Native tool call is already resolved: ${first.id}`,
      )
    })

    const branchSetup = await setup()
    const branch = new NativeSessionTranscript({
      sessionId: 'branch',
      store: branchSetup.store,
      createId: (() => {
        const ids = ['root', 'call-branch', 'other-branch']
        return () => ids.shift() ?? 'extra'
      })(),
      now: () => timestamp,
    })
    await branch.withLease({ kind: 'start' }, async (lease) => {
      await lease.appendMessages({ messages: [user('root')] })
      await lease.appendMessages({
        messages: [
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'off-branch', name: 'Read', input: {} }],
          },
        ],
      })
    })
    await branch.withLease(
      { kind: 'resume', atEventId: 'root' },
      async (lease) => {
        await lease.appendMessages({ messages: [user('other')] })
        await expect(lease.beginToolExecution('off-branch')).rejects.toThrow(
          'Unknown native tool call: off-branch',
        )
      },
    )

    const compactSetup = await setup()
    const compact = new NativeSessionTranscript({
      sessionId: 'compact',
      store: compactSetup.store,
      createId: (() => {
        let n = 0
        return () => `compact-claim-${++n}`
      })(),
      now: () => timestamp,
    })
    await compact.withLease({ kind: 'start' }, async (lease) => {
      const old = { id: 'old-call', name: 'Read', input: {} }
      await lease.appendMessages({
        messages: [{ role: 'assistant', content: '', toolCalls: [old] }],
      })
      await lease.beginToolExecution(old.id)
      await lease.appendToolCompletion({
        callId: old.id,
        result: { content: 'old result', isError: false },
      })
      await lease.appendCompaction({
        summary: 'compacted',
        trigger: 'manual',
        preTokens: 5,
        postTokens: 1,
        durationMs: 1,
      })
      await expect(lease.beginToolExecution(old.id)).rejects.toThrow(
        `Unknown native tool call: ${old.id}`,
      )
    })
  })

  it('serializes durable mutations without losing concurrent claims or completions', async () => {
    const { store } = await setup()
    const transcript = new NativeSessionTranscript({
      sessionId: 'session',
      store,
      createId: (() => {
        let n = 0
        return () => `queued-${++n}`
      })(),
      now: () => timestamp,
    })
    const calls = [
      { id: 'parallel-a', name: 'Read', input: {} },
      { id: 'parallel-b', name: 'Read', input: {} },
    ]
    await transcript.withLease({ kind: 'start' }, async (lease) => {
      await lease.appendMessages({
        messages: [{ role: 'assistant', content: '', toolCalls: calls }],
      })
      await Promise.all(calls.map((call) => lease.beginToolExecution(call.id)))
      expect(lease.interruption()).toEqual({
        kind: 'indeterminate-tools',
        callIds: ['parallel-a', 'parallel-b'],
      })
      await Promise.all(
        calls.map((call) =>
          lease.appendToolCompletion({
            callId: call.id,
            result: { content: `${call.id} result`, isError: false },
          }),
        ),
      )
      expect(lease.interruption()).toEqual({ kind: 'interrupted-turn' })
    })
    const events = (await store.load()).records.map((record) => record.event)
    expect(events.map((event) => event.kind)).toEqual([
      'messages',
      'tool-execution-started',
      'tool-execution-started',
      'messages',
      'messages',
    ])
    expect(
      events
        .filter((event) => event.kind === 'messages')
        .flatMap((event) => event.messages)
        .filter((message) => message.role === 'tool')
        .map((message) => message.toolCallId),
    ).toEqual(['parallel-a', 'parallel-b'])
  })

  it('keeps a durable marker after completion append failure and prevents automatic retry', async () => {
    const { store } = await setup()
    let appends = 0
    const failingStore = {
      withLease<T>(operation: (lease: NativeTranscriptLease) => Promise<T>) {
        return store.withLease((lease) =>
          operation({
            ...lease,
            append: async (tail, event) => {
              appends += 1
              if (appends === 3)
                return { status: 'conflict', reason: 'tail-changed' } as const
              return lease.append(tail, event)
            },
          }),
        )
      },
    } as unknown as NativeTranscriptStore
    const transcript = new NativeSessionTranscript({
      sessionId: 'session',
      store: failingStore,
      createId: (() => {
        let n = 0
        return () => `failure-${++n}`
      })(),
      now: () => timestamp,
    })
    const call = { id: 'claimed-before-failure', name: 'Read', input: {} }
    await transcript.withLease({ kind: 'start' }, async (lease) => {
      await lease.appendMessages({
        messages: [{ role: 'assistant', content: '', toolCalls: [call] }],
      })
      await lease.beginToolExecution(call.id)
      await expect(
        lease.appendToolCompletion({
          callId: call.id,
          result: { content: 'lost result', isError: false },
        }),
      ).rejects.toThrow('native transcript append conflict: tail-changed')
      expect(lease.interruption()).toEqual({
        kind: 'indeterminate-tools',
        callIds: [call.id],
      })
    })

    const reopened = new NativeSessionTranscript({
      sessionId: 'session',
      store,
    })
    await reopened.withLease({ kind: 'resume' }, async (lease) => {
      expect(lease.interruption()).toEqual({
        kind: 'indeterminate-tools',
        callIds: [call.id],
      })
      await expect(lease.beginToolExecution(call.id)).rejects.toThrow(
        `Native tool call already claimed: ${call.id}`,
      )
    })
  })
})
