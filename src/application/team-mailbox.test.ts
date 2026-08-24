import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { TeamMailboxService, teamMailboxMessageId } from './team-mailbox.js'

const text = (value: string) => ({ kind: 'text' as const, text: value })

describe('TeamMailboxService', () => {
  it('creates deterministic length-delimited operation IDs', () => {
    const first = teamMailboxMessageId('team-a', 'lead', 'operation-1')
    expect(first).toBe(teamMailboxMessageId('team-a', 'lead', 'operation-1'))
    expect(first).not.toBe(
      teamMailboxMessageId('team-a', 'lead', 'operation-2'),
    )
    expect(first).not.toBe(
      teamMailboxMessageId('team-a', 'le', 'adoperation-1'),
    )
    expect(first).toMatch(/^[a-f0-9]{64}$/u)
  })

  it('persists before metadata-only wake and warns on advisory failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-team-mailbox-'))
    const wake = vi.fn(async (metadata) => {
      expect(metadata).toEqual({
        teamId: 'team-a',
        messageId: 'message-1',
        sequence: 1,
        recipients: ['worker'],
      })
      expect((await service.store.read('worker')).messages).toHaveLength(1)
    })
    const service = new TeamMailboxService({
      nativeRoot: root,
      projectIdentity: 'project',
      teamId: 'team-a',
      participants: ['lead', 'worker'],
      wake,
    })
    const message = await service
      .endpoint('lead')
      .send({ messageId: 'message-1', to: 'worker', payload: text('hello') })
    expect(message.sequence).toBe(1)
    expect(wake).toHaveBeenCalledOnce()

    const warn = vi.fn()
    const failing = new TeamMailboxService({
      nativeRoot: root,
      projectIdentity: 'project',
      teamId: 'team-a',
      participants: ['lead', 'worker'],
      wake: async () => {
        throw new Error('wake unavailable')
      },
      warn,
    })
    const retry = await failing
      .endpoint('lead')
      .send({ messageId: 'message-1', to: 'worker', payload: text('hello') })
    expect(retry.sequence).toBe(1)
    expect(warn).toHaveBeenCalledOnce()

    const throwingWarn = new TeamMailboxService({
      nativeRoot: root,
      projectIdentity: 'project',
      teamId: 'team-a',
      participants: ['lead', 'worker'],
      wake: async () => {
        throw new Error('wake unavailable')
      },
      warn: () => {
        throw new Error('warning reporter unavailable')
      },
    })
    await expect(
      throwingWarn.endpoint('lead').send({
        messageId: 'message-2',
        to: 'worker',
        payload: text('still delivered'),
      }),
    ).resolves.toMatchObject({ sequence: 2 })
    expect((await throwingWarn.store.read('worker')).messages).toHaveLength(2)
  })

  it('rejects invalid recipients and snapshots broadcast targets at send time', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-team-mailbox-targets-'))
    const service = new TeamMailboxService({
      nativeRoot: root,
      projectIdentity: 'project',
      teamId: 'team-a',
      participants: ['lead', 'worker', 'observer'],
    })
    await expect(
      service
        .endpoint('lead')
        .send({ messageId: 'self', to: 'lead', payload: text('x') }),
    ).rejects.toThrow()
    await expect(
      service
        .endpoint('lead')
        .send({ messageId: 'empty', to: [], payload: text('x') }),
    ).rejects.toThrow()
    await expect(
      service
        .endpoint('lead')
        .send({ messageId: 'unknown', to: 'missing', payload: text('x') }),
    ).rejects.toThrow()
    const sent = await service
      .endpoint('lead')
      .send({ messageId: 'broadcast', to: 'broadcast', payload: text('x') })
    expect(sent.recipients).toEqual(['observer', 'worker'])
    const reopened = new TeamMailboxService({
      nativeRoot: root,
      projectIdentity: 'project',
      teamId: 'team-a',
      participants: ['lead', 'worker'],
    })
    expect((await reopened.store.read('worker')).messages).toHaveLength(1)
    await expect(reopened.store.read('observer')).rejects.toThrow()
  })

  it('deduplicates directed targets, projects bounded UTF-8 attachments, and acknowledges exactly', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-team-mailbox-project-'))
    const service = new TeamMailboxService({
      nativeRoot: root,
      projectIdentity: 'project',
      teamId: 'team-a',
      participants: ['lead', 'worker'],
    })
    await service.endpoint('lead').send({
      messageId: 'one',
      to: ['worker', 'worker'],
      payload: text('one'),
    })
    await service.endpoint('lead').send({
      messageId: 'two',
      to: 'worker',
      payload: {
        kind: 'task',
        phase: 'request',
        requestId: 'r',
        taskId: 't',
        text: 'do',
      },
    })
    const batch = await service
      .endpoint('worker')
      .project({ maxMessages: 1, maxBytes: 10_000 })
    expect(batch?.messages).toHaveLength(1)
    expect(batch?.messages[0]).toContain('<team-mailbox-message>')
    expect(
      (await service.endpoint('worker').project({ maxMessages: 1 }))?.messages,
    ).toHaveLength(1)
    await batch?.acknowledge()
    await batch?.acknowledge()
    expect((await service.endpoint('worker').project())?.messages[0]).toContain(
      '"requestId":"r"',
    )
    const oversized = new TeamMailboxService({
      nativeRoot: root,
      projectIdentity: 'project',
      teamId: 'team-b',
      participants: ['lead', 'worker'],
    })
    await oversized.endpoint('lead').send({
      messageId: 'large',
      to: 'worker',
      payload: text('x'.repeat(100)),
    })
    await expect(
      oversized.endpoint('worker').project({ maxBytes: 10 }),
    ).rejects.toThrow()
    expect((await oversized.store.read('worker')).expectedCursor).toBe(0)
  })
})
