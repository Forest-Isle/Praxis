import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { ScheduledPromptManager } from '../application/scheduled-prompt-manager.js'
import { LocalToolRegistry } from './local-tools.js'
import {
  ClaudeScheduledToolRegistry,
  describeCron,
} from './claude-scheduled-tools.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

async function fixture(dynamicWakeupsEnabled = false) {
  const root = await mkdtemp(join(tmpdir(), 'praxis-cron-tools-'))
  roots.push(root)
  const cwd = join(root, 'work')
  const now = () => new Date('2026-08-05T14:00:00Z').getTime()
  const manager = new ScheduledPromptManager({
    filePath: join(cwd, '.claude', 'scheduled_tasks.json'),
    lockFile: join(root, 'config', 'praxis', 'locks', 'cron.lock'),
    now,
    processStart: async () => 'Wed Aug  5 14:16:36 2026',
    dynamicWakeupsEnabled,
  })
  return {
    cwd,
    filePath: join(cwd, '.claude', 'scheduled_tasks.json'),
    registry: new ClaudeScheduledToolRegistry({
      base: new LocalToolRegistry({ cwd }),
      manager,
      sessionId: '20202020-2020-4020-8020-202020202020',
      now,
    }),
  }
}

async function execute(
  registry: ClaudeScheduledToolRegistry,
  cwd: string,
  name: string,
  input: Record<string, unknown>,
) {
  const call = await registry.prepare(
    { id: `call_${name}`, name, input },
    { cwd },
  )
  return registry.execute(call, { cwd })
}

describe('ClaudeScheduledToolRegistry', () => {
  it('exposes Claude 2.1.208 scheduled tool schemas', async () => {
    const { registry } = await fixture()
    const definitions = registry.definitions()
    expect(definitions.slice(-4).map(({ name }) => name)).toEqual([
      'CronCreate',
      'CronDelete',
      'CronList',
      'ScheduleWakeup',
    ])
    expect(
      definitions.find(({ name }) => name === 'CronCreate')?.inputSchema,
    ).toMatchObject({
      properties: {
        cron: { type: 'string' },
        prompt: { type: 'string' },
        recurring: { type: 'boolean' },
        durable: { type: 'boolean' },
      },
      required: ['cron', 'prompt'],
      additionalProperties: false,
    })
    const wakeup = definitions.find(({ name }) => name === 'ScheduleWakeup')
    expect(wakeup?.description).toContain(
      'the user invoked /loop without an interval, asking you to self-pace iterations',
    )
    expect(wakeup?.inputSchema.properties).toMatchObject({
      delaySeconds: {
        description:
          'Seconds from now to wake up. Clamped to [60, 3600] by the runtime. Required unless `stop` is true.',
      },
      reason: {
        description:
          'One short sentence explaining the chosen delay. Goes to telemetry and is shown to the user. Be specific. Required unless `stop` is true.',
      },
      prompt: {
        description: expect.stringContaining('<<autonomous-loop-dynamic>>'),
      },
      stop: {
        description:
          'Set to true to end the dynamic loop immediately instead of scheduling another wakeup. When true, all other fields are ignored and no further wakeups fire.',
      },
    })
  })

  it('creates, lists, and deletes a Claude-shaped durable job', async () => {
    const { registry, cwd, filePath } = await fixture()
    const created = await execute(registry, cwd, 'CronCreate', {
      cron: '17 9 * * 1-5',
      prompt: 'run stage22 probe',
      recurring: true,
      durable: true,
    })
    const id = String(created.nativeToolUseResult?.id)
    expect(created).toMatchObject({
      content: `Scheduled recurring job ${id} (Weekdays at 9:17 AM). Persisted to .claude/scheduled_tasks.json. Auto-expires after 7 days. Use CronDelete to cancel sooner.`,
      nativeToolUseResult: {
        id,
        humanSchedule: 'Weekdays at 9:17 AM',
        recurring: true,
        durable: true,
      },
    })
    expect(JSON.parse(await readFile(filePath, 'utf8')).tasks[0]).toMatchObject(
      {
        id,
        cron: '17 9 * * 1-5',
        prompt: 'run stage22 probe',
        recurring: true,
      },
    )
    await expect(execute(registry, cwd, 'CronList', {})).resolves.toMatchObject(
      {
        content: `${id} — Weekdays at 9:17 AM (recurring): run stage22 probe`,
        nativeToolUseResult: {
          jobs: [
            {
              id,
              cron: '17 9 * * 1-5',
              humanSchedule: 'Weekdays at 9:17 AM',
              prompt: 'run stage22 probe',
              recurring: true,
            },
          ],
        },
      },
    )
    await expect(
      execute(registry, cwd, 'CronDelete', { id }),
    ).resolves.toMatchObject({ content: `Cancelled job ${id}.` })
  })

  it('matches the inactive dynamic-loop result and validates cron input', async () => {
    const { registry, cwd } = await fixture()
    await expect(
      execute(registry, cwd, 'ScheduleWakeup', {
        delaySeconds: 1,
        reason: 'probe clamp',
        prompt: 'continue probe',
      }),
    ).resolves.toMatchObject({
      content:
        'Wakeup not scheduled. Either the /loop dynamic runtime gate is off or the loop reached its maximum duration — the loop has ended; do not re-issue.',
      nativeToolUseResult: {
        scheduledFor: 0,
        clampedDelaySeconds: 0,
        wasClamped: false,
      },
    })
    await expect(
      execute(registry, cwd, 'ScheduleWakeup', { stop: true }),
    ).resolves.toMatchObject({
      nativeToolUseResult: {
        stopped: true,
        cancelledWakeups: 0,
      },
    })
    await expect(
      execute(registry, cwd, 'CronCreate', {
        cron: 'bad cron',
        prompt: 'probe',
      }),
    ).rejects.toThrow(
      "Invalid cron expression 'bad cron'. Expected 5 fields: M H DoM Mon DoW.",
    )
  })

  it('schedules and stops wakeups when the interactive gate is active', async () => {
    const { registry, cwd } = await fixture(true)
    const scheduledFor = new Date('2026-08-05T14:01:00Z').getTime()
    const scheduledTime = new Date(scheduledFor).toTimeString().slice(0, 8)
    await expect(
      execute(registry, cwd, 'ScheduleWakeup', {
        delaySeconds: 1,
        reason: 'keep the loop warm',
        prompt: 'continue probe',
      }),
    ).resolves.toMatchObject({
      content: `Next wakeup scheduled for ${scheduledTime} (in 60s) (clamped to 60s from your requested value). Nothing more to do this turn — the harness re-invokes you when the wakeup fires or a task-notification arrives.`,
      nativeToolUseResult: {
        scheduledFor,
        clampedDelaySeconds: 60,
        wasClamped: true,
      },
    })
    await expect(
      execute(registry, cwd, 'ScheduleWakeup', { stop: true }),
    ).resolves.toEqual({
      content:
        'Loop stopped — cancelled 1 pending wakeup(s); no further dynamic-loop wakeups scheduled. If you armed a Monitor for this loop, TaskStop it now; otherwise nothing more to do this turn.',
      isError: false,
      nativeToolUseResult: {
        scheduledFor: 0,
        clampedDelaySeconds: 0,
        wasClamped: false,
        stopped: true,
        cancelledWakeups: 1,
      },
    })
  })

  it('formats observed common schedules', () => {
    expect(describeCron('*/5 * * * *')).toBe('Every 5 minutes')
    expect(describeCron('7 * * * *')).toBe('Every hour at :07')
    expect(describeCron('17 9 * * 1-5')).toBe('Weekdays at 9:17 AM')
    expect(describeCron('30 14 5 8 *')).toBe('30 14 5 8 *')
  })
})
