import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { ClaudeScheduledTaskStore } from './claude-scheduled-task-store.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'praxis-cron-store-'))
  roots.push(root)
  const filePath = join(root, 'work', '.claude', 'scheduled_tasks.json')
  return {
    root,
    filePath,
    store: new ClaudeScheduledTaskStore({
      filePath,
      lockFile: join(root, 'config', 'praxis', 'locks', 'cron.lock'),
    }),
  }
}

const input = {
  cron: '17 9 * * 1-5',
  prompt: 'run probe',
  createdAt: 1_785_939_398_530,
  recurring: true,
  createdBySessionId: '20202020-2020-4020-8020-202020202020',
  createdByPid: 123,
  createdByProcStart: 'Wed Aug  5 14:16:36 2026',
}

describe('ClaudeScheduledTaskStore', () => {
  it('writes the Claude scheduled_tasks.json shape and deletes by ID', async () => {
    const { filePath, store } = await fixture()
    const created = await store.create(input)
    expect(created.id).toMatch(/^[0-9a-f]{8}$/u)
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({
      tasks: [{ id: created.id, ...input }],
    })
    await expect(store.delete(created.id)).resolves.toBe(true)
    await expect(store.delete(created.id)).resolves.toBe(false)
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({ tasks: [] })
  })

  it('preserves unknown document and task fields during compatible mutation', async () => {
    const { filePath, store } = await fixture()
    await mkdir(join(filePath, '..'), { recursive: true })
    await writeFile(
      filePath,
      JSON.stringify({
        version: 9,
        tasks: [{ id: 'abcdef12', ...input, x: 1 }],
      }),
    )
    const created = await store.create({ ...input, prompt: 'second' })
    const document = JSON.parse(await readFile(filePath, 'utf8'))
    expect(document).toMatchObject({
      version: 9,
      tasks: [
        { id: 'abcdef12', x: 1 },
        { id: created.id, prompt: 'second' },
      ],
    })
  })

  it('fails closed for corrupt shared state', async () => {
    const { filePath, store } = await fixture()
    await mkdir(join(filePath, '..'), { recursive: true })
    await writeFile(filePath, '{bad')
    await expect(store.list()).rejects.toThrow(
      `Invalid Claude scheduled task JSON: ${filePath}`,
    )
    await expect(store.create(input)).rejects.toThrow('Invalid Claude')
  })

  it('retries when a Claude writer changes the file before commit', async () => {
    const { filePath, store } = await fixture()
    const internal = store as unknown as {
      matchesFingerprint(expected: unknown): Promise<boolean>
    }
    const matchesFingerprint = internal.matchesFingerprint.bind(store)
    let injected = false
    internal.matchesFingerprint = async (expected) => {
      if (!injected) {
        injected = true
        await mkdir(join(filePath, '..'), { recursive: true })
        await writeFile(
          filePath,
          JSON.stringify({
            source: 'claude',
            tasks: [{ id: 'abcdef12', ...input, prompt: 'Claude task' }],
          }),
        )
      }
      return matchesFingerprint(expected)
    }

    const created = await store.create({ ...input, prompt: 'Praxis task' })
    const document = JSON.parse(await readFile(filePath, 'utf8'))
    expect(document.source).toBe('claude')
    expect(document.tasks).toEqual([
      expect.objectContaining({ id: 'abcdef12', prompt: 'Claude task' }),
      expect.objectContaining({ id: created.id, prompt: 'Praxis task' }),
    ])
  })
})
