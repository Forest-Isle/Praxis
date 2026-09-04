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
    const execution = await store.start()
    await execution.running()
    await execution.finish('failed', undefined, 'provider unavailable')
    await execution.release()
    const record = await store.read()
    if (!record) throw new Error('Expected persisted lifecycle record')
    expect(record).toMatchObject({
      version: 2,
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

  it('reads v1 without rewriting and upgrades only on a legitimate mutation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-subagent-lifecycle-v1-'))
    const path = join(root, 'subagent-lifecycle', sessionId, `${agentId}.json`)
    await mkdir(dirname(path), { recursive: true })
    const legacy = {
      version: 1,
      sessionId,
      agentId,
      status: 'running',
      updatedAt: '2026-08-24T00:00:00.000Z',
    }
    await writeFile(path, `${JSON.stringify(legacy)}\n`)
    const store = new SubagentLifecycleStore(root, sessionId, agentId)
    await expect(store.read()).resolves.toMatchObject({
      version: 2,
      lifecycle: { state: 'orphaned', generation: 1, previousOwnerToken: null },
    })
    await expect(readFile(path, 'utf8')).resolves.toBe(
      `${JSON.stringify(legacy)}\n`,
    )
    const execution = await store.recover()
    await execution.running()
    await execution.finish('completed', {
      text: 'recovered',
      usage: { inputTokens: 0, outputTokens: 0 },
      toolUseCount: 0,
      durationMs: 0,
    })
    await execution.release()
    const raw = await readFile(path, 'utf8')
    expect(JSON.parse(raw)).toMatchObject({
      version: 2,
      lifecycle: { state: 'completed' },
    })
    expect(JSON.parse(raw)).not.toHaveProperty('status')
  })

  it('refuses a second live owner and rotates ownership after orphan recovery', async () => {
    const root = await mkdtemp(
      join(tmpdir(), 'praxis-subagent-lifecycle-owner-'),
    )
    const firstStore = new SubagentLifecycleStore(root, sessionId, agentId)
    const secondStore = new SubagentLifecycleStore(root, sessionId, agentId)
    const first = await firstStore.start()
    await expect(secondStore.start()).rejects.toThrow('already owned')
    await first.release()
    const recovered = await secondStore.recover()
    expect(recovered.token).not.toBe(first.token)
    expect(recovered.generation).toBe(first.generation + 1)
    await expect(first.finish('failed')).rejects.toThrow(
      'Lifecycle execution has been released',
    )
    await recovered.running()
    await recovered.finish('completed', {
      text: 'new generation only',
      usage: { inputTokens: 0, outputTokens: 0 },
      toolUseCount: 0,
      durationMs: 0,
    })
    await recovered.release()
    await expect(secondStore.read()).resolves.toMatchObject({
      lifecycle: { generation: first.generation + 1, state: 'completed' },
      result: { text: 'new generation only' },
    })
  })

  it('does not hide terminal durable state behind its still-held cleanup lease', async () => {
    const root = await mkdtemp(
      join(tmpdir(), 'praxis-subagent-terminal-lease-'),
    )
    const firstStore = new SubagentLifecycleStore(root, sessionId, agentId)
    const secondStore = new SubagentLifecycleStore(root, sessionId, agentId)
    const execution = await firstStore.start()
    await execution.running()
    await execution.finish('completed', {
      text: 'done',
      usage: { inputTokens: 0, outputTokens: 0 },
      toolUseCount: 0,
      durationMs: 0,
    })
    const reconciliation = await secondStore.reconcileOwnerLoss()
    expect(reconciliation).toMatchObject({
      owned: false,
      snapshot: { state: 'completed' },
    })
    await execution.release()
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
      usage: {
        inputTokens: 4,
        outputTokens: 2,
        cacheCreationInputTokens: 5,
        cacheCreationInputTokens1h: 3,
      },
      modelUsage: {
        fixture: {
          inputTokens: 4,
          outputTokens: 2,
          cacheCreationInputTokens: 5,
          cacheCreationInputTokens1h: 3,
          contextWindow: 100_000,
        },
      },
      durationApiMs: 1.5,
      durationApiWithoutRetriesMs: 1.25,
      toolUseCount: 1,
      durationMs: 5,
    }
    const execution = await store.start()
    await execution.running()
    await execution.finish('completed', result, undefined, {
      id,
      status: 'completed',
      toolUseId: 'call_agent',
      error: null,
    })
    await execution.release()
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

    const lifecyclePath = join(
      root,
      'subagent-lifecycle',
      sessionId,
      `${agentId}.json`,
    )
    const corrupted = JSON.parse(await readFile(lifecyclePath, 'utf8')) as {
      result: { usage: { cacheCreationInputTokens1h: number } }
    }
    corrupted.result.usage.cacheCreationInputTokens1h = 6
    await writeFile(lifecyclePath, `${JSON.stringify(corrupted)}\n`)
    await expect(store.read()).rejects.toThrow(
      'Invalid subagent lifecycle state',
    )
  })
})
