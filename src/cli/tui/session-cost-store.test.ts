import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  FileSystemTuiSessionCostStore,
  sessionCostDirectory,
} from './session-cost-store.js'
import {
  accumulateSessionCost,
  createSessionCostState,
} from './session-cost.js'

const SESSION_ID = 'bbd2f513-d9b7-4202-a632-32d33205b492'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'praxis-session-cost-'))
  roots.push(root)
  return root
}

describe('session cost store', () => {
  it('round-trips an accumulated state through the sidecar', async () => {
    const store = new FileSystemTuiSessionCostStore(await tempRoot())
    let state = createSessionCostState()
    state = accumulateSessionCost(state, {
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        cacheReadInputTokens: 2,
      },
      costUsd: 0.0002,
      durationApiMs: 150,
      wallDurationMs: 500,
      modelUsage: {
        sonnet: {
          inputTokens: 10,
          outputTokens: 4,
          cacheReadInputTokens: 2,
        },
      },
    })
    state = accumulateSessionCost(state, {
      usage: { inputTokens: 3, outputTokens: 1 },
      costUsd: 0.0001,
      modelUsage: {
        haiku: { inputTokens: 3, outputTokens: 1 },
      },
    })
    await store.save(SESSION_ID, state)
    await expect(store.load(SESSION_ID)).resolves.toEqual(state)
  })

  it('restores missing optional model cache fields as zero', async () => {
    const root = await tempRoot()
    await mkdir(sessionCostDirectory(root), { recursive: true })
    await writeFile(
      join(sessionCostDirectory(root), `${SESSION_ID}.json`),
      JSON.stringify({
        models: { sonnet: { inputTokens: 5, outputTokens: 2 } },
        knownCostUsd: 0,
        hasUnknownCost: false,
        durationApiMs: 0,
        durationWallMs: 0,
        linesAdded: 0,
        linesRemoved: 0,
      }),
    )
    const loaded = await new FileSystemTuiSessionCostStore(root).load(
      SESSION_ID,
    )
    expect(loaded.models.sonnet).toEqual({
      inputTokens: 5,
      outputTokens: 2,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    })
  })

  it('returns an empty state for a missing sidecar and for malformed JSON', async () => {
    const root = await tempRoot()
    const store = new FileSystemTuiSessionCostStore(root)
    await expect(store.load(SESSION_ID)).resolves.toEqual(
      createSessionCostState(),
    )
    await mkdir(sessionCostDirectory(root), { recursive: true })
    await writeFile(
      join(sessionCostDirectory(root), `${SESSION_ID}.json`),
      '{nope',
    )
    await expect(store.load(SESSION_ID)).resolves.toEqual(
      createSessionCostState(),
    )
  })

  it('treats negative numbers and invalid model labels as empty state', async () => {
    const root = await tempRoot()
    const store = new FileSystemTuiSessionCostStore(root)
    await mkdir(sessionCostDirectory(root), { recursive: true })
    await writeFile(
      join(sessionCostDirectory(root), `${SESSION_ID}.json`),
      JSON.stringify({
        models: { sonnet: { inputTokens: -1, outputTokens: 2 } },
        knownCostUsd: 0,
        hasUnknownCost: false,
        durationApiMs: 0,
        durationWallMs: 0,
        linesAdded: 0,
        linesRemoved: 0,
      }),
    )
    await expect(store.load(SESSION_ID)).resolves.toEqual(
      createSessionCostState(),
    )
    await mkdir(sessionCostDirectory(root), { recursive: true })
    await writeFile(
      join(sessionCostDirectory(root), `${SESSION_ID}.json`),
      JSON.stringify({
        models: { '../escape': { inputTokens: 1, outputTokens: 1 } },
        knownCostUsd: 0,
        hasUnknownCost: false,
        durationApiMs: 0,
        durationWallMs: 0,
        linesAdded: 0,
        linesRemoved: 0,
      }),
    )
    await expect(store.load(SESSION_ID)).resolves.toEqual(
      createSessionCostState(),
    )
  })

  it('rejects invalid session ids without reading or writing the sidecar directory', async () => {
    const root = await tempRoot()
    const store = new FileSystemTuiSessionCostStore(root)
    await expect(store.load('../escape')).rejects.toThrow(
      'Invalid Claude session ID',
    )
    await expect(store.load('session-1')).rejects.toThrow(
      'Invalid Claude session ID',
    )
    await expect(
      store.save('../escape', createSessionCostState()),
    ).rejects.toThrow('Invalid Claude session ID')
    await expect(
      readFile(join(sessionCostDirectory(root), '..', 'escape.json'), 'utf8'),
    ).rejects.toThrow()
  })

  it('writes only the exact session-cost fields with a restricted mode', async () => {
    const root = await tempRoot()
    const state = accumulateSessionCost(createSessionCostState(), {
      usage: { inputTokens: 10, outputTokens: 4 },
      costUsd: 0.0002,
      durationApiMs: 150,
      wallDurationMs: 500,
      modelUsage: {
        sonnet: { inputTokens: 10, outputTokens: 4 },
      },
    })
    await new FileSystemTuiSessionCostStore(root).save(SESSION_ID, state)
    const path = join(sessionCostDirectory(root), `${SESSION_ID}.json`)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      models: {
        sonnet: {
          inputTokens: 10,
          outputTokens: 4,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      },
      knownCostUsd: 0.0002,
      hasUnknownCost: false,
      durationApiMs: 150,
      durationWallMs: 500,
      linesAdded: 0,
      linesRemoved: 0,
    })
  })
})
