import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { SubagentLifecycleStore } from './subagent-lifecycle-store.js'

const sessionId = '11111111-1111-4111-8111-111111111111'
const agentId = 'areviewer-0123456789abcdef'

describe('SubagentLifecycleStore', () => {
  it('atomically round-trips private terminal state for a safe labeled ID', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-subagent-lifecycle-'))
    const transcriptPath = join(root, 'agent.jsonl')
    await writeFile(transcriptPath, '{}\n')
    const store = new SubagentLifecycleStore(
      root,
      sessionId,
      agentId,
      transcriptPath,
    )

    await expect(store.read()).resolves.toBeNull()
    await store.write('failed', 'provider unavailable')
    const record = await store.read()
    if (!record) throw new Error('Expected persisted lifecycle record')
    expect(record).toMatchObject({
      version: 1,
      sessionId,
      agentId,
      status: 'failed',
      detail: 'provider unavailable',
      transcriptBytes: 3,
      updatedAt: expect.any(String),
    })
    await expect(store.matchesTranscript(record)).resolves.toBe(true)
    await appendFile(transcriptPath, '{}\n')
    await expect(store.matchesTranscript(record)).resolves.toBe(false)
    expect(
      await readFile(
        join(root, 'subagent-lifecycle', sessionId, `${agentId}.json`),
        'utf8',
      ),
    ).toMatch(/\n$/u)
  })

  it('rejects corrupt, mismatched, and path-unsafe state locally', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-subagent-lifecycle-'))
    const path = join(root, 'subagent-lifecycle', sessionId, `${agentId}.json`)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, '{bad')
    await expect(
      new SubagentLifecycleStore(root, sessionId, agentId).read(),
    ).rejects.toThrow('Corrupt subagent lifecycle state')

    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        sessionId,
        agentId: 'a1123456789abcdef',
        status: 'completed',
        updatedAt: new Date().toISOString(),
      }),
    )
    await expect(
      new SubagentLifecycleStore(root, sessionId, agentId).read(),
    ).rejects.toThrow('Invalid subagent lifecycle state')
    expect(
      () => new SubagentLifecycleStore(root, sessionId, 'a../../escape'),
    ).toThrow('Invalid subagent lifecycle agent ID')
  })

  it('durably retains terminal result and acknowledges one notification', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-subagent-lifecycle-'))
    const transcriptPath = join(root, 'agent.jsonl')
    await writeFile(transcriptPath, '{}\n')
    const store = new SubagentLifecycleStore(
      root,
      sessionId,
      agentId,
      transcriptPath,
    )
    const id = '11111111-1111-4111-8111-111111111111'
    const result = {
      text: 'DONE',
      usage: { inputTokens: 4, outputTokens: 2 },
      modelUsage: {
        fixture: { inputTokens: 4, outputTokens: 2, contextWindow: 100_000 },
      },
      durationApiMs: 1.5,
      durationApiWithoutRetriesMs: 1.25,
      toolUseCount: 1,
      durationMs: 5,
    }
    await store.write('completed', undefined, {
      result,
      notification: {
        id,
        status: 'completed',
        toolUseId: 'call_agent',
        error: null,
      },
    })
    await expect(store.read()).resolves.toMatchObject({
      status: 'completed',
      result,
      notifications: [
        {
          id,
          status: 'completed',
          toolUseId: 'call_agent',
          result,
          consumed: false,
        },
      ],
    })

    await store.prepareNotificationDetached(id, 'fixture-model')
    await store.prepareNotificationDetached(id, 'ignored-repeat-model')
    await expect(store.read()).resolves.toMatchObject({
      notifications: [
        {
          id,
          accounting: {
            kind: 'detached',
            model: 'fixture-model',
            delivered: false,
          },
        },
      ],
    })
    await store.confirmNotificationDetached(id)
    await store.confirmNotificationDetached(id)
    await appendFile(transcriptPath, '{}\n')
    await store.acknowledgeNotification(id)
    await store.acknowledgeNotification(id)
    const acknowledged = await store.read()
    expect(acknowledged).toMatchObject({
      notifications: [
        {
          id,
          consumed: true,
          accounting: {
            kind: 'detached',
            model: 'fixture-model',
            delivered: true,
          },
        },
      ],
    })
    if (!acknowledged) throw new Error('Expected acknowledged lifecycle state')
    await expect(store.matchesTranscript(acknowledged)).resolves.toBe(false)
  })
})
