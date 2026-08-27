import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  MAX_JOBS,
  ScheduledJobLimitError,
  ScheduledPromptManager,
  assertCronExpression,
} from './scheduled-prompt-manager.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

async function fixture(
  now: () => number,
  dynamicWakeupsEnabled = false,
  dynamicLoopMaxAgeMs?: number,
  dynamicCacheLeadMs?: number,
) {
  const root = await mkdtemp(join(tmpdir(), 'praxis-cron-manager-'))
  roots.push(root)
  const filePath = join(root, 'work', '.praxis', 'scheduled', 'project.json')
  return {
    filePath,
    manager: new ScheduledPromptManager({
      filePath,
      lockFile: join(root, 'config', 'praxis', 'locks', 'cron.lock'),
      now,
      dynamicWakeupsEnabled,
      ...(dynamicLoopMaxAgeMs === undefined ? {} : { dynamicLoopMaxAgeMs }),
      ...(dynamicCacheLeadMs === undefined ? {} : { dynamicCacheLeadMs }),
      processStart: async () => 'Wed Aug  5 14:16:36 2026',
    }),
  }
}

const sessionId = '20202020-2020-4020-8020-202020202020'

describe('ScheduledPromptManager', () => {
  it('keeps session tasks in memory and durable tasks in native state', async () => {
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

  it('surfaces a missed durable one-shot as a pending confirmation instead of an auto-due prompt', async () => {
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
    await expect(manager.drainDue()).resolves.toEqual([])
    await expect(manager.pendingScheduledPrompts()).toEqual([
      { id: 'abc12345', prompt: 'missed prompt' },
    ])
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({ tasks: [] })
  })

  it('runs a pending missed one-shot exactly once after explicit approval', async () => {
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
    await expect(manager.drainDue()).resolves.toEqual([])
    expect(manager.approveScheduledPrompt('abc12345')).toBe(true)
    await expect(manager.drainDue()).resolves.toEqual([
      { id: 'abc12345', prompt: 'missed prompt' },
    ])
    await expect(manager.drainDue()).resolves.toEqual([])
    await expect(manager.pendingScheduledPrompts()).toEqual([])
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({ tasks: [] })
  })

  it('drops a pending missed one-shot on decline and keeps the durable task deleted', async () => {
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
    await expect(manager.drainDue()).resolves.toEqual([])
    expect(manager.declineScheduledPrompt('abc12345')).toBe(true)
    await expect(manager.drainDue()).resolves.toEqual([])
    await expect(manager.pendingScheduledPrompts()).toEqual([])
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
    await expect(manager.drainDue()).resolves.toEqual([])
    await expect(manager.pendingScheduledPrompts()).toEqual([
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

    await expect(manager.drainDue()).resolves.toEqual([])
    await expect(manager.pendingScheduledPrompts()).toEqual([
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

  it('clamps, delivers, and cancels interactive dynamic wakeups', async () => {
    let now = new Date(2026, 0, 1, 0, 0).getTime()
    const { manager } = await fixture(() => now, true)
    expect(
      manager.scheduleWakeup({ delaySeconds: 1, prompt: 'continue loop' }),
    ).toEqual({
      scheduledFor: now + 60_000,
      clampedDelaySeconds: 60,
      wasClamped: true,
    })
    expect(manager.stopWakeups()).toBe(1)
    await expect(manager.drainDue()).resolves.toEqual([])

    expect(
      manager.scheduleWakeup({ delaySeconds: 4_000, prompt: 'upper clamp' }),
    ).toEqual({
      scheduledFor: now + 3_600_000,
      clampedDelaySeconds: 3_600,
      wasClamped: true,
    })
    expect(manager.stopWakeups()).toBe(1)

    manager.scheduleWakeup({ delaySeconds: 60, prompt: 'continue loop' })
    now += 60_000
    await expect(manager.drainDue()).resolves.toEqual([
      expect.objectContaining({ prompt: 'continue loop' }),
    ])
    expect(manager.stopWakeups()).toBe(0)
  })

  it('rounds delays and aligns active wakeups to the next minute', async () => {
    const now = new Date(2026, 0, 1, 0, 0, 10).getTime()
    const { manager } = await fixture(() => now, true)

    expect(
      manager.scheduleWakeup({
        delaySeconds: 60.4,
        prompt: 'minute aligned loop',
      }),
    ).toEqual({
      scheduledFor: new Date(2026, 0, 1, 0, 2).getTime(),
      clampedDelaySeconds: 60,
      wasClamped: false,
    })
  })

  it('keeps short wakeups inside the native cache window when minute alignment overshoots', async () => {
    const now = new Date(2026, 0, 1, 0, 0, 10).getTime()
    const { manager } = await fixture(() => now, true)

    expect(
      manager.scheduleWakeup({ delaySeconds: 270, prompt: 'cache warm loop' }),
    ).toMatchObject({
      scheduledFor: new Date(2026, 0, 1, 0, 4).getTime(),
      clampedDelaySeconds: 270,
      wasClamped: false,
    })
  })

  it('does not apply cache lead at or beyond the five-minute TTL', async () => {
    const now = new Date(2026, 0, 1, 0, 0, 10).getTime()
    const { manager } = await fixture(() => now, true)

    expect(
      manager.scheduleWakeup({ delaySeconds: 301, prompt: 'long fallback' }),
    ).toMatchObject({
      scheduledFor: new Date(2026, 0, 1, 0, 6).getTime(),
      clampedDelaySeconds: 301,
    })
  })

  it('supports disabling cache lead and never schedules before the sixty-second floor', async () => {
    const now = new Date(2026, 0, 1, 0, 0, 10).getTime()
    const { manager: noLead } = await fixture(() => now, true, undefined, 0)
    expect(
      noLead.scheduleWakeup({ delaySeconds: 270, prompt: 'no cache lead' }),
    ).toMatchObject({
      scheduledFor: new Date(2026, 0, 1, 0, 5).getTime(),
    })

    const { manager: largeLead } = await fixture(
      () => now,
      true,
      undefined,
      300_000,
    )
    const wakeup = largeLead.scheduleWakeup({
      delaySeconds: 60,
      prompt: 'floor loop',
    })
    if (!wakeup) throw new Error('expected active wakeup')
    expect(wakeup.scheduledFor).toBeGreaterThanOrEqual(now + 60_000)
  })

  it('keeps dynamic wakeups inactive outside the interactive runtime', async () => {
    const now = () => new Date(2026, 0, 1, 0, 0).getTime()
    const { manager } = await fixture(now)
    expect(
      manager.scheduleWakeup({ delaySeconds: 60, prompt: 'do not queue' }),
    ).toBeNull()
  })

  it('supersedes an existing dynamic wakeup and clears state on close', async () => {
    let now = new Date(2026, 0, 1, 0, 0).getTime()
    const { manager } = await fixture(() => now, true)
    manager.scheduleWakeup({ delaySeconds: 60, prompt: 'first wakeup' })
    manager.scheduleWakeup({ delaySeconds: 120, prompt: 'second wakeup' })

    now += 120_000
    const delivered = (
      await Promise.all([manager.drainDue(), manager.drainDue()])
    ).flat()
    expect(delivered.map(({ prompt }) => prompt)).toEqual(['second wakeup'])
    await expect(manager.drainDue()).resolves.toEqual([])

    manager.scheduleWakeup({ delaySeconds: 60, prompt: 'closed wakeup' })
    manager.close()
    now += 60_000
    await expect(manager.drainDue()).resolves.toEqual([])
    expect(manager.stopWakeups()).toBe(0)
  })

  it('ends a continuously rearmed dynamic loop at its maximum age', async () => {
    let now = new Date(2026, 0, 1, 0, 0).getTime()
    const { manager } = await fixture(() => now, true, 120_000)
    const prompt = 'bounded loop'

    expect(manager.scheduleWakeup({ delaySeconds: 60, prompt })).not.toBeNull()
    now += 60_000
    await manager.drainDue()
    expect(manager.scheduleWakeup({ delaySeconds: 60, prompt })).not.toBeNull()
    now += 60_000
    await manager.drainDue()
    expect(manager.scheduleWakeup({ delaySeconds: 60, prompt })).toBeNull()
  })

  it('clears loop age when stop follows a consumed wakeup', async () => {
    let now = new Date(2026, 0, 1, 0, 0).getTime()
    const { manager } = await fixture(() => now, true, 120_000)
    const prompt = 'stopped loop'

    manager.scheduleWakeup({ delaySeconds: 60, prompt })
    now += 60_000
    await manager.drainDue()
    expect(manager.stopWakeups()).toBe(0)
    now += 60_000
    expect(manager.scheduleWakeup({ delaySeconds: 60, prompt })).not.toBeNull()
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

  it('validates the five-field native cron contract', () => {
    expect(() => assertCronExpression('bad cron')).toThrow(
      "Invalid cron expression 'bad cron'. Expected 5 fields: M H DoM Mon DoW.",
    )
    expect(() => assertCronExpression('17 9 * * 1-5')).not.toThrow()
  })

  it('enforces the durable job cap atomically across managers', async () => {
    const now = () => new Date('2026-08-05T14:00:00Z').getTime()
    const root = await mkdtemp(join(tmpdir(), 'praxis-cron-manager-'))
    roots.push(root)
    const filePath = join(root, 'work', '.praxis', 'scheduled', 'project.json')
    const options = {
      filePath,
      lockFile: join(root, 'config', 'praxis', 'locks', 'cron.lock'),
      now,
      processStart: async () => 'Wed Aug  5 14:16:36 2026',
    }
    const first = new ScheduledPromptManager(options)
    const second = new ScheduledPromptManager(options)
    for (let index = 0; index < MAX_JOBS - 1; index += 1) {
      await first.create({
        cron: `${(index % 59) + 1} 9 * * 1-5`,
        prompt: `preloaded job ${index}`,
        recurring: true,
        durable: true,
        sessionId,
      })
    }
    const results = await Promise.allSettled([
      first.create({
        cron: '18 9 * * 1-5',
        prompt: 'race winner',
        recurring: true,
        durable: true,
        sessionId,
      }),
      second.create({
        cron: '19 9 * * 1-5',
        prompt: 'race loser',
        recurring: true,
        durable: true,
        sessionId,
      }),
    ])
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1)
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )
    expect(rejected).toHaveLength(1)
    expect(rejected[0]?.reason).toBeInstanceOf(ScheduledJobLimitError)
    expect(rejected[0]?.reason).toMatchObject({ maxJobs: MAX_JOBS })
    expect(JSON.parse(await readFile(filePath, 'utf8')).tasks).toHaveLength(
      MAX_JOBS,
    )
    first.close()
    second.close()
  })
})
