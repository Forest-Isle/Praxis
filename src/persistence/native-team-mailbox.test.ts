import { chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  NativeTeamMailbox,
  type NativeTeamMailboxOptions,
} from './native-team-mailbox.js'

const payload = (text: string) => ({ kind: 'text' as const, text })

async function mailbox(
  root: string,
  options: Partial<NativeTeamMailboxOptions> = {},
) {
  return NativeTeamMailbox.open({
    nativeRoot: root,
    projectIdentity: 'project',
    teamId: 'team-a',
    participants: ['lead', 'worker', 'observer'],
    ...options,
  })
}

describe('NativeTeamMailbox', () => {
  it('serializes concurrent instances into one contiguous order', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-mailbox-order-'))
    const left = await mailbox(root)
    const right = await mailbox(root)
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        (index % 2 === 0 ? left : right).append({
          messageId: `message-${index}`,
          sender: 'lead',
          recipients: ['worker'],
          payload: payload(String(index)),
        }),
      ),
    )
    expect(new Set(results.map(({ message }) => message.sequence)).size).toBe(
      20,
    )
    expect(
      results.map(({ message }) => message.sequence).sort((a, b) => a - b),
    ).toEqual(Array.from({ length: 20 }, (_, index) => index + 1))
  })

  it('persists before append resolves and makes retained retries idempotent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-mailbox-retry-'))
    const store = await mailbox(root)
    const result = await store.append({
      messageId: 'stable',
      sender: 'lead',
      recipients: ['worker'],
      payload: payload('hello'),
    })
    expect(
      JSON.parse((await readFile(store.messagesPath, 'utf8')).trim()),
    ).toMatchObject({
      messageId: 'stable',
      sequence: result.message.sequence,
    })
    const retry = await store.append({
      messageId: 'stable',
      sender: 'lead',
      recipients: ['worker'],
      payload: payload('hello'),
    })
    expect(retry.inserted).toBe(false)
    expect(retry.message.sequence).toBe(result.message.sequence)
    await expect(
      store.append({
        messageId: 'stable',
        sender: 'lead',
        recipients: ['worker'],
        payload: payload('different'),
      }),
    ).rejects.toThrow()
  })

  it('recovers a durable log ahead of state and a valid partial tail', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-mailbox-recovery-'))
    const store = await mailbox(root)
    const first = await store.append({
      messageId: 'first',
      sender: 'lead',
      recipients: ['worker'],
      payload: payload('first'),
    })
    const laggingState = JSON.parse(
      await readFile(store.statePath, 'utf8'),
    ) as Record<string, unknown>
    laggingState.nextSequence = 1
    await writeFile(store.statePath, `${JSON.stringify(laggingState)}\n`)
    await writeFile(
      store.messagesPath,
      `${await readFile(store.messagesPath, 'utf8')}partial`,
    )
    const second = await store.append({
      messageId: 'second',
      sender: 'lead',
      recipients: ['worker'],
      payload: payload('second'),
    })
    const reopened = await mailbox(root)
    const read = await reopened.read('worker')
    expect(read.messages.map((message) => message.messageId)).toEqual([
      'first',
      'second',
    ])
    expect(second.message.sequence).toBe(first.message.sequence + 1)
    expect((await readFile(store.messagesPath, 'utf8')).endsWith('\n')).toBe(
      true,
    )
  })

  it('repairs a published prune prefix before appending within physical bounds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-mailbox-prune-'))
    const store = await mailbox(root, {
      retention: { maxRecords: 2, maxBytes: 100_000 },
    })
    await store.append({
      messageId: 'one',
      sender: 'lead',
      recipients: ['worker'],
      payload: payload('one'),
    })
    const read = await store.read('worker')
    await store.acknowledge(read.proof)
    const state = JSON.parse(await readFile(store.statePath, 'utf8')) as Record<
      string,
      unknown
    >
    state.prunedThrough = 1
    await writeFile(store.statePath, `${JSON.stringify(state)}\n`)
    await store.append({
      messageId: 'two',
      sender: 'lead',
      recipients: ['worker'],
      payload: payload('two'),
    })
    const physical = await readFile(store.messagesPath, 'utf8')
    expect(physical).not.toContain('"messageId":"one"')
    expect(Buffer.byteLength(physical, 'utf8')).toBeLessThanOrEqual(100_000)
  })

  it('recovers a later published prune prefix whose physical log no longer starts at one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-mailbox-reprune-'))
    const store = await mailbox(root, {
      retention: { maxRecords: 1, maxBytes: 100_000 },
    })
    await store.append({
      messageId: 'one',
      sender: 'lead',
      recipients: ['worker'],
      payload: payload('one'),
    })
    await store.acknowledge((await store.read('worker')).proof)
    await store.append({
      messageId: 'two',
      sender: 'lead',
      recipients: ['worker'],
      payload: payload('two'),
    })
    await store.acknowledge((await store.read('worker')).proof)
    const state = JSON.parse(await readFile(store.statePath, 'utf8')) as Record<
      string,
      unknown
    >
    state.prunedThrough = 2
    await writeFile(store.statePath, `${JSON.stringify(state)}\n`)

    await expect(
      store.append({
        messageId: 'three',
        sender: 'lead',
        recipients: ['worker'],
        payload: payload('three'),
      }),
    ).resolves.toMatchObject({ message: { sequence: 3 } })
    const physical = await readFile(store.messagesPath, 'utf8')
    expect(physical).not.toContain('"messageId":"two"')
    expect(physical).toContain('"messageId":"three"')
  })

  it('fails closed on middle corruption, duplicate IDs, and sequence gaps', async () => {
    const cases: readonly {
      readonly name: string
      mutate(lines: string[]): void
    }[] = [
      {
        name: 'middle corruption',
        mutate(lines) {
          lines[1] = '{"version":'
        },
      },
      {
        name: 'duplicate message ID',
        mutate(lines) {
          const first = JSON.parse(lines[0] ?? '') as Record<string, unknown>
          const second = JSON.parse(lines[1] ?? '') as Record<string, unknown>
          second.messageId = first.messageId
          lines[1] = JSON.stringify(second)
        },
      },
      {
        name: 'sequence gap',
        mutate(lines) {
          const second = JSON.parse(lines[1] ?? '') as Record<string, unknown>
          second.sequence = 4
          lines[1] = JSON.stringify(second)
        },
      },
    ]

    for (const corruption of cases) {
      const root = await mkdtemp(
        join(
          tmpdir(),
          `praxis-mailbox-${corruption.name.replaceAll(' ', '-')}-`,
        ),
      )
      const store = await mailbox(root)
      for (const messageId of ['one', 'two', 'three'])
        await store.append({
          messageId,
          sender: 'lead',
          recipients: ['worker'],
          payload: payload(messageId),
        })
      const lines = (await readFile(store.messagesPath, 'utf8'))
        .trimEnd()
        .split('\n')
      corruption.mutate(lines)
      await writeFile(store.messagesPath, `${lines.join('\n')}\n`)
      await expect(store.read('worker'), corruption.name).rejects.toThrow()
    }
  })

  it('keeps reads non-consuming, validates exact proofs, and redelivers after failed ack', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-mailbox-ack-'))
    const store = await mailbox(root)
    await store.append({
      messageId: 'observer-only',
      sender: 'lead',
      recipients: ['observer'],
      payload: payload('observer-only'),
    })
    await store.append({
      messageId: 'one',
      sender: 'lead',
      recipients: ['worker'],
      payload: payload('one'),
    })
    const read = await store.read('worker')
    expect(read.throughSequence).toBe(2)
    expect((await store.read('worker')).messages).toHaveLength(1)
    await expect(
      store.acknowledge({ ...read.proof, messageIds: [] }),
    ).rejects.toThrow()
    await store.acknowledge(read.proof)
    await store.acknowledge(read.proof)
    expect((await store.read('worker')).messages).toHaveLength(0)
    expect((await (await mailbox(root)).read('worker')).messages).toHaveLength(
      0,
    )
    await expect(
      store.acknowledge({ ...read.proof, throughSequence: 99 }),
    ).rejects.toThrow()
  })

  it('treats an older exact batch as idempotent after a later cursor advance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-mailbox-late-ack-'))
    const store = await mailbox(root)
    for (const messageId of ['one', 'two'])
      await store.append({
        messageId,
        sender: 'lead',
        recipients: ['worker'],
        payload: payload(messageId),
      })
    const first = await store.read('worker', { maxMessages: 1 })
    await store.acknowledge(first.proof)
    const second = await store.read('worker', { maxMessages: 1 })
    await store.acknowledge(second.proof)
    await expect(store.acknowledge(first.proof)).resolves.toBeUndefined()
    expect((await store.read('worker')).messages).toHaveLength(0)
  })

  it('returns the reconciled revision when adding a current participant cursor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-mailbox-roster-'))
    const original = await mailbox(root, {
      participants: ['lead', 'worker'],
    })
    await original.append({
      messageId: 'one',
      sender: 'lead',
      recipients: ['worker'],
      payload: payload('one'),
    })
    const before = JSON.parse(
      await readFile(original.statePath, 'utf8'),
    ) as Record<string, unknown>
    const reopened = await mailbox(root, {
      participants: ['lead', 'worker', 'observer'],
    })
    await reopened.append({
      messageId: 'two',
      sender: 'lead',
      recipients: ['observer'],
      payload: payload('two'),
    })
    const after = JSON.parse(
      await readFile(reopened.statePath, 'utf8'),
    ) as Record<string, unknown>
    expect(after.revision).toBe((before.revision as number) + 2)
    expect(after.cursors).toMatchObject({ lead: 0, worker: 0, observer: 0 })
  })

  it('preserves participant cursor keys that overlap object prototypes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-mailbox-cursor-key-'))
    const store = await mailbox(root, {
      participants: ['lead', '__proto__', 'toString'],
    })
    await store.append({
      messageId: 'prototype-recipient',
      sender: 'lead',
      recipients: ['__proto__', 'toString'],
      payload: payload('prototype-safe'),
    })

    const reopened = await mailbox(root, {
      participants: ['lead', '__proto__', 'toString'],
    })
    const prototypeRead = await reopened.read('__proto__')
    const toStringRead = await reopened.read('toString')
    expect(prototypeRead.messages).toHaveLength(1)
    expect(toStringRead.messages).toHaveLength(1)
    await reopened.acknowledge(prototypeRead.proof)
    await reopened.acknowledge(toStringRead.proof)
    expect((await reopened.read('__proto__')).messages).toHaveLength(0)
    expect((await reopened.read('toString')).messages).toHaveLength(0)
  })

  it('compacts only after every fixed target acknowledges and backpressures unread data', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-mailbox-retention-'))
    const store = await mailbox(root, {
      retention: { maxRecords: 1, maxBytes: 100_000 },
    })
    await store.append({
      messageId: 'directed',
      sender: 'lead',
      recipients: ['worker', 'observer'],
      payload: payload('x'),
    })
    const workerRead = await store.read('worker')
    await store.acknowledge(workerRead.proof)
    await expect(
      store.append({
        messageId: 'blocked',
        sender: 'lead',
        recipients: ['worker'],
        payload: payload('y'),
      }),
    ).rejects.toThrow('backpressure')
    const observerRead = await store.read('observer')
    await store.acknowledge(observerRead.proof)
    const inserted = await store.append({
      messageId: 'next',
      sender: 'lead',
      recipients: ['worker'],
      payload: payload('z'),
    })
    expect(inserted.inserted).toBe(true)
  })

  it('applies byte retention without deleting unread data', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-mailbox-byte-retention-'))
    const initial = await mailbox(root)
    await initial.append({
      messageId: 'one',
      sender: 'lead',
      recipients: ['worker'],
      payload: payload('one'),
    })
    const retainedBytes = Buffer.byteLength(
      await readFile(initial.messagesPath, 'utf8'),
      'utf8',
    )
    const bounded = await mailbox(root, {
      retention: { maxRecords: 100, maxBytes: retainedBytes },
    })
    await expect(
      bounded.append({
        messageId: 'two',
        sender: 'lead',
        recipients: ['worker'],
        payload: payload('two'),
      }),
    ).rejects.toThrow('backpressure')
    await bounded.acknowledge((await bounded.read('worker')).proof)
    await expect(
      bounded.append({
        messageId: 'two',
        sender: 'lead',
        recipients: ['worker'],
        payload: payload('two'),
      }),
    ).resolves.toMatchObject({ message: { sequence: 2 } })
  })

  it('retains same-ID identity after acknowledgement and hardens state files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-mailbox-permissions-'))
    const store = await mailbox(root, {
      retention: { maxRecords: 4, maxBytes: 100_000 },
    })
    const first = await store.append({
      messageId: 'stable',
      sender: 'lead',
      recipients: ['worker'],
      payload: payload('x'),
    })
    const read = await store.read('worker')
    await store.acknowledge(read.proof)
    const retry = await store.append({
      messageId: 'stable',
      sender: 'lead',
      recipients: ['worker'],
      payload: payload('x'),
    })
    expect(retry.message.sequence).toBe(first.message.sequence)
    await chmod(store.statePath, 0o644)
    await chmod(store.messagesPath, 0o644)
    await store.read('worker')
    expect((await stat(store.statePath)).mode & 0o777).toBe(0o600)
    expect((await stat(store.messagesPath)).mode & 0o777).toBe(0o600)
  })

  it('verifies exact older retained proofs while keeping the exact proof idempotent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-mailbox-proof-window-'))
    const store = await mailbox(root, {
      retention: { maxRecords: 2, maxBytes: 100_000 },
    })
    await store.append({
      messageId: 'one',
      sender: 'lead',
      recipients: ['worker'],
      payload: payload('one'),
    })
    const older = await store.read('worker', { maxMessages: 1 })
    await store.append({
      messageId: 'two',
      sender: 'lead',
      recipients: ['worker'],
      payload: payload('two'),
    })
    const newer = await store.read('worker')
    await store.acknowledge(newer.proof)
    await expect(store.acknowledge(older.proof)).resolves.toBeUndefined()
    await expect(
      store.acknowledge({ ...older.proof, messageIds: ['forged'] }),
    ).rejects.toThrow()
    await store.append({
      messageId: 'three',
      sender: 'lead',
      recipients: ['worker'],
      payload: payload('three'),
    })
    await expect(store.acknowledge(older.proof)).rejects.toThrow(
      'outside the retained window',
    )
  })

  it('validates proof IDs independently of unrelated long roster names', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-mailbox-proof-roster-'))
    const store = await mailbox(root, {
      participants: ['lead', 'worker', 'x'.repeat(70_000)],
    })
    await store.append({
      messageId: 'small',
      sender: 'lead',
      recipients: ['worker'],
      payload: payload('small'),
    })
    const proof = await store.read('worker')
    await expect(store.acknowledge(proof.proof)).resolves.toBeUndefined()
  })

  it('accepts long project identities and rejects exhausted sequence and revision counters before append', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-mailbox-counter-'))
    const identity = 'project'.repeat(100)
    const store = NativeTeamMailbox.open({
      nativeRoot: root,
      projectIdentity: identity,
      teamId: 'team-a',
      participants: ['lead', 'worker'],
    })
    await store.append({
      messageId: 'one',
      sender: 'lead',
      recipients: ['worker'],
      payload: payload('one'),
    })
    const state = JSON.parse(await readFile(store.statePath, 'utf8')) as Record<
      string,
      unknown
    >
    state.nextSequence = Number.MAX_SAFE_INTEGER
    state.prunedThrough = Number.MAX_SAFE_INTEGER - 1
    state.cursors = Object.fromEntries(
      Object.keys(state.cursors as Record<string, unknown>).map(
        (participant) => [participant, Number.MAX_SAFE_INTEGER - 1],
      ),
    )
    await writeFile(store.statePath, `${JSON.stringify(state)}\n`)
    await writeFile(store.messagesPath, '')
    await expect(
      store.append({
        messageId: 'overflow',
        sender: 'lead',
        recipients: ['worker'],
        payload: payload('overflow'),
      }),
    ).rejects.toThrow('Mailbox sequence exhausted')
    expect(await readFile(store.messagesPath, 'utf8')).toBe('')

    const revisionRoot = await mkdtemp(
      join(tmpdir(), 'praxis-mailbox-revision-counter-'),
    )
    const revisionStore = await mailbox(revisionRoot)
    await revisionStore.append({
      messageId: 'one',
      sender: 'lead',
      recipients: ['worker'],
      payload: payload('one'),
    })
    const revisionState = JSON.parse(
      await readFile(revisionStore.statePath, 'utf8'),
    ) as Record<string, unknown>
    revisionState.revision = Number.MAX_SAFE_INTEGER
    await writeFile(
      revisionStore.statePath,
      `${JSON.stringify(revisionState)}\n`,
    )
    const beforeRevisionAppend = await readFile(
      revisionStore.messagesPath,
      'utf8',
    )
    await expect(
      revisionStore.append({
        messageId: 'two',
        sender: 'lead',
        recipients: ['worker'],
        payload: payload('two'),
      }),
    ).rejects.toThrow('Mailbox revision exhausted')
    expect(await readFile(revisionStore.messagesPath, 'utf8')).toBe(
      beforeRevisionAppend,
    )
  })
})
