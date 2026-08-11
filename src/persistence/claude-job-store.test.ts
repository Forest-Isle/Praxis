import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  ClaudeJobStore,
  newClaudeJobIdentity,
  type ClaudeJobState,
} from './claude-job-store.js'

const roots: string[] = []

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'praxis-job-store-'))
  roots.push(path)
  return path
}

function state(id: string, sessionId: string, cwd: string): ClaudeJobState {
  const now = new Date().toISOString()
  return {
    state: 'working',
    detail: 'starting',
    tempo: 'active',
    inFlight: { tasks: 1, queued: 0, kinds: ['prompt'] },
    tokens: 0,
    output: null,
    children: null,
    template: 'bg',
    respawnFlags: ['test prompt'],
    intent: 'test prompt',
    sessionId,
    resumeSessionId: sessionId,
    daemonShort: id,
    cliVersion: '0.1.0',
    cwd,
    backend: 'daemon',
    praxisOwner: 1,
    createdAt: now,
    updatedAt: now,
    firstTerminalAt: null,
  }
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true })),
  )
})

describe('ClaudeJobStore', () => {
  it('publishes jobs exclusively and persists atomic state and timeline updates', async () => {
    const configRoot = await root()
    const store = new ClaudeJobStore(configRoot)
    const identity = newClaudeJobIdentity()
    const initial = state(identity.id, identity.sessionId, configRoot)

    await expect(
      store.create(initial, {
        version: 1,
        argv: ['test prompt'],
        resume: false,
      }),
    ).resolves.toBe(true)
    await expect(
      store.create(initial, { version: 1, argv: ['other'], resume: false }),
    ).resolves.toBe(false)

    await store.appendTimeline(identity.id, {
      at: new Date().toISOString(),
      state: 'working',
      detail: 'done',
      text: 'RESULT',
    })
    await store.appendOutput(identity.id, 'PARTIAL')
    await store.appendOutput(identity.id, '_RESULT\n')
    const updated = await store.update(identity.id, (current) => ({
      ...current,
      detail: 'done',
      tempo: 'idle',
      tokens: 3,
      updatedAt: new Date().toISOString(),
    }))

    expect(updated).toMatchObject({ detail: 'done', tempo: 'idle', tokens: 3 })
    await expect(store.timeline(identity.id)).resolves.toEqual([
      expect.objectContaining({ text: 'RESULT' }),
    ])
    await expect(store.output(identity.id)).resolves.toBe('PARTIAL_RESULT\n')
    await store.appendOutput(identity.id, '世界')
    await store.trimOutput(identity.id, 6)
    await expect(store.output(identity.id)).resolves.toBe('世界')
    await expect(store.readDispatch(identity.id)).resolves.toEqual({
      version: 1,
      argv: ['test prompt'],
      resume: false,
    })
    await expect(
      store.updateDispatch(identity.id, (dispatch) => ({
        ...dispatch,
        resume: true,
        handoffComplete: true,
      })),
    ).resolves.toEqual({
      version: 1,
      argv: ['test prompt'],
      resume: true,
      handoffComplete: true,
    })
    expect(
      await readFile(
        join(configRoot, 'jobs', identity.id, 'state.json'),
        'utf8',
      ),
    ).toMatch(/\n$/u)
  })

  it('isolates corrupt jobs and keeps valid timeline records before a torn tail', async () => {
    const configRoot = await root()
    const store = new ClaudeJobStore(configRoot)
    const identity = newClaudeJobIdentity()
    await store.create(state(identity.id, identity.sessionId, configRoot), {
      version: 1,
      argv: ['test prompt'],
      resume: false,
    })
    await store.appendTimeline(identity.id, {
      at: new Date().toISOString(),
      state: 'working',
      detail: 'done',
      text: 'VALID',
    })
    await writeFile(
      join(configRoot, 'jobs', identity.id, 'timeline.jsonl'),
      `${JSON.stringify({
        at: new Date().toISOString(),
        state: 'working',
        detail: 'done',
        text: 'VALID',
      })}\n{torn`,
    )
    await mkdir(join(configRoot, 'jobs', 'deadbeef'), { recursive: true })
    await writeFile(
      join(configRoot, 'jobs', 'deadbeef', 'state.json'),
      '{invalid',
    )

    await expect(store.list()).resolves.toHaveLength(1)
    await expect(store.timeline(identity.id)).resolves.toEqual([
      expect.objectContaining({ text: 'VALID' }),
    ])
  })
})
