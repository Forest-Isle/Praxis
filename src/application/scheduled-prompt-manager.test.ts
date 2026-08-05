import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  ScheduledPromptManager,
  assertCronExpression,
} from './scheduled-prompt-manager.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

async function fixture(now: () => number) {
  const root = await mkdtemp(join(tmpdir(), 'praxis-cron-manager-'))
  roots.push(root)
  const filePath = join(root, 'work', '.claude', 'scheduled_tasks.json')
  return {
    filePath,
    manager: new ScheduledPromptManager({
      filePath,
      lockFile: join(root, 'config', 'praxis', 'locks', 'cron.lock'),
      now,
      processStart: async () => 'Wed Aug  5 14:16:36 2026',
    }),
  }
}

const sessionId = '20202020-2020-4020-8020-202020202020'

describe('ScheduledPromptManager', () => {
  it('keeps session tasks in memory and durable tasks in Claude state', async () => {
    const now = () => new Date('2026-08-05T14:00:00Z').getTime()
    const { filePath, manager } = await fixture(now)
    const session = await manager.create({
      cron: '17 9 * * 1-5',
      prompt: 'session prompt',
      recurring: true,
      durable: false,
      sessionId,
    })
    const durable = await manager.create({
      cron: '18 9 * * 1-5',
      prompt: 'durable prompt',
      recurring: true,
      durable: true,
      sessionId,
    })
    expect(await manager.list()).toEqual([
      expect.objectContaining({ id: durable.id, durable: true }),
      expect.objectContaining({ id: session.id, durable: false }),
    ])
    const document = JSON.parse(await readFile(filePath, 'utf8'))
    expect(document.tasks).toHaveLength(1)
    expect(document.tasks[0]).toMatchObject({
      id: durable.id,
      createdBySessionId: sessionId,
      createdByProcStart: 'Wed Aug  5 14:16:36 2026',
    })
    manager.close()
  })

  it('catches up missed durable one-shot prompts and auto-deletes them', async () => {
    const now = new Date(2026, 0, 1, 0, 2).getTime()
    const { filePath, manager } = await fixture(() => now)
    await mkdir(join(filePath, '..'), { recursive: true })
    await writeFile(
      filePath,
      JSON.stringify({
        tasks: [
          {
            id: 'abc12345',
            cron: '1 0 1 1 *',
            prompt: 'missed prompt',
            createdAt: new Date(2025, 11, 31, 23, 59).getTime(),
            recurring: false,
            createdBySessionId: sessionId,
            createdByPid: 123,
            createdByProcStart: 'start',
          },
        ],
      }),
    )
    await expect(manager.drainDue()).resolves.toEqual([
      { id: 'abc12345', prompt: 'missed prompt' },
    ])
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({ tasks: [] })
  })

  it('fires a final recurring prompt and deletes jobs after seven days', async () => {
    let now = new Date('2026-01-01T00:00:01Z').getTime()
    const fixtureValue = await fixture(() => now)
    const task = await fixtureValue.manager.create({
      cron: '* * * * *',
      prompt: 'weekly-bound prompt',
      recurring: true,
      durable: true,
      sessionId,
    })
    now += 8 * 24 * 60 * 60 * 1_000
    await expect(fixtureValue.manager.drainDue()).resolves.toEqual([
      { id: task.id, prompt: 'weekly-bound prompt' },
    ])
    await expect(fixtureValue.manager.list()).resolves.toEqual([])
  })

  it('discovers external durable tasks and avoids live foreign owners', async () => {
    let now = new Date(2026, 0, 1, 0, 2).getTime()
    const { filePath, manager } = await fixture(() => now)
    await expect(manager.list()).resolves.toEqual([])
    await mkdir(join(filePath, '..'), { recursive: true })
    const task = {
      id: 'def12345',
      cron: '1 0 1 1 *',
      prompt: 'external prompt',
      createdAt: new Date(2025, 11, 31, 23, 59).getTime(),
      recurring: false,
      createdBySessionId: sessionId,
      createdByPid: 999_999_999,
      createdByProcStart: 'start',
    }
    await writeFile(filePath, JSON.stringify({ tasks: [task] }))
    await expect(manager.drainDue()).resolves.toEqual([
      { id: task.id, prompt: task.prompt },
    ])

    now += 60_000
    await writeFile(
      filePath,
      JSON.stringify({
        tasks: [
          {
            ...task,
            id: 'fed12345',
            createdByPid: process.ppid,
            createdByProcStart: 'Wed Aug  5 14:16:36 2026',
          },
        ],
      }),
    )
    await expect(manager.drainDue()).resolves.toEqual([])
    expect(JSON.parse(await readFile(filePath, 'utf8')).tasks).toHaveLength(1)
  })

  it('takes over a stale task when its PID has been reused', async () => {
    const now = new Date(2026, 0, 1, 0, 2).getTime()
    const { filePath, manager } = await fixture(() => now)
    await mkdir(join(filePath, '..'), { recursive: true })
    await writeFile(
      filePath,
      JSON.stringify({
        tasks: [
          {
            id: 'fed12345',
            cron: '1 0 1 1 *',
            prompt: 'stale-owner prompt',
            createdAt: new Date(2025, 11, 31, 23, 59).getTime(),
            recurring: false,
            createdBySessionId: sessionId,
            createdByPid: process.ppid,
            createdByProcStart: 'different process start',
          },
        ],
      }),
    )

    await expect(manager.drainDue()).resolves.toEqual([
      { id: 'fed12345', prompt: 'stale-owner prompt' },
    ])
  })

  it('delivers a due prompt only once across concurrent drains', async () => {
    let now = new Date(2026, 0, 1, 0, 0, 1).getTime()
    const { manager } = await fixture(() => now)
    const task = await manager.create({
      cron: '1 0 1 1 *',
      prompt: 'single delivery',
      recurring: false,
      durable: false,
      sessionId,
    })
    now = new Date(2026, 0, 1, 0, 2).getTime()

    const delivered = (
      await Promise.all([manager.drainDue(), manager.drainDue()])
    ).flat()
    expect(delivered).toEqual([{ id: task.id, prompt: 'single delivery' }])
  })

  it('does not repopulate timers when closed during initialization', async () => {
    const now = new Date(2026, 0, 1, 0, 0, 1).getTime()
    const { manager } = await fixture(() => now)
    const internal = manager as unknown as {
      dueAt: Map<string, number>
      store: { list(): Promise<unknown[]> }
    }
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    internal.store.list = async () => {
      await blocked
      return [
        {
          id: 'abc12345',
          cron: '1 0 1 1 *',
          prompt: 'future prompt',
          createdAt: now,
          recurring: false,
          createdBySessionId: sessionId,
          createdByPid: 999_999_999,
          createdByProcStart: 'start',
        },
      ]
    }

    const pending = manager.next()
    manager.close()
    release()
    await expect(pending).resolves.toBeNull()
    expect(internal.dueAt.size).toBe(0)
  })

  it('returns promptly when next receives an already-aborted signal', async () => {
    const now = () => new Date(2026, 0, 1, 0, 0, 1).getTime()
    const { manager } = await fixture(now)
    const controller = new AbortController()
    controller.abort()
    await expect(manager.next(controller.signal)).resolves.toBeNull()
  })

  it('validates the five-field Claude cron contract', () => {
    expect(() => assertCronExpression('bad cron')).toThrow(
      "Invalid cron expression 'bad cron'. Expected 5 fields: M H DoM Mon DoW.",
    )
    expect(() => assertCronExpression('17 9 * * 1-5')).not.toThrow()
  })
})
