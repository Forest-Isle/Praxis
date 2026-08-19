import type {
  ModelToolCall,
  ModelToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolRegistry,
} from '../core/runtime.js'
import type {
  ScheduledPromptManager,
  ListedScheduledPrompt,
} from '../application/scheduled-prompt-manager.js'

const SCHEMA = 'https://json-schema.org/draft/2020-12/schema'

const CRON_CREATE_DESCRIPTION = `Schedule a prompt to be enqueued at a future time. Use for both recurring schedules and one-shot reminders.

Uses standard 5-field cron in the user's local timezone: minute hour day-of-month month day-of-week. "0 9 * * *" means 9am local.

For one-shot requests, set recurring to false and pin minute, hour, day-of-month, and month. One-shot tasks fire once and auto-delete. Recurring defaults to true and fires on every match until deleted or auto-expired after 7 days.

Avoid :00 and :30 when the requested time is approximate. Use exact round times only when the user explicitly asks for them. The scheduler adds bounded deterministic jitter: recurring jobs fire up to 10% of their period late, capped at 15 minutes; one-shot jobs on :00 or :30 may fire up to 90 seconds early.

By default durable is false: the job exists only in this Praxis process and disappears on exit. Set durable to true only when the user explicitly asks for persistence. Durable jobs use .claude/scheduled_tasks.json, resume on the next launch, and missed one-shot jobs are surfaced for catch-up.

Jobs fire only while the interactive runtime is idle. Returns an ID accepted by CronDelete.`

const SCHEDULE_WAKEUP_DESCRIPTION = `Schedule when to resume work in /loop dynamic mode — the user invoked /loop without an interval, asking you to self-pace iterations of a specific task.

Do NOT schedule a short-interval wakeup to poll for background work you started — when harness-tracked work finishes, you are re-invoked automatically, so polling is wasted. Instead schedule a long fallback (1200s+) so the loop survives if the work hangs or never notifies. The exception is external work the harness cannot track (a CI run, a deploy, a remote queue) — there, pick a delay matched to how fast that state actually changes.

Pass the same /loop prompt back via \`prompt\` each turn so the next firing repeats the task. For an autonomous /loop (no user prompt), pass the literal sentinel \`<<autonomous-loop-dynamic>>\` as \`prompt\` instead — the runtime resolves it back to the autonomous-loop instructions at fire time. (There is a similar \`<<autonomous-loop>>\` sentinel for CronCreate-based autonomous loops; do not confuse the two — ScheduleWakeup always uses the \`-dynamic\` variant.) To end the loop, call this tool with \`stop: true\` (omit every other field) — the loop ends immediately and no further wakeups fire.

## Picking delaySeconds

This session's requests use the default 5-minute Anthropic prompt-cache TTL. Sleeping past 300 seconds means the next wake-up reads your full conversation context uncached — slower and more expensive. So the natural breakpoints:

- **Under 5 minutes (60s–270s)**: cache stays warm. Right for actively polling external state the harness can't notify you about — a CI run, a deploy, a remote queue.
- **5 minutes to 1 hour (300s–3600s)**: pay the cache miss. Right when there's no point checking sooner — waiting on something that takes minutes to change, genuinely idle, or as the long fallback heartbeat when something else is the primary wake signal.

**Don't pick 300s.** It's the worst-of-both: you pay the cache miss without amortizing it. If you're tempted to "wait 5 minutes," either drop to 270s (stay in cache) or commit to 1200s+ (one cache miss buys a much longer wait). Don't think in round-number minutes — think in cache windows.

For idle ticks with no specific signal to watch, default to **1200s–1800s** (20–30 min). The loop checks back, you don't burn cache 12× per hour for nothing, and the user can always interrupt if they need you sooner.

Think about what you're actually waiting for, not just "how long should I sleep." If you're polling a CI run that takes ~8 minutes, sleeping 60s burns the cache 8 times before it finishes — sleep ~270s twice instead.

The runtime clamps to [60, 3600], so you don't need to clamp yourself.

## The reason field

One short sentence on what you chose and why. Goes to telemetry and is shown back to the user. "watching CI run" beats "waiting." The user reads this to understand what you're doing without having to predict your cadence in advance — make it specific.
`

const DEFINITIONS: readonly ModelToolDefinition[] = [
  {
    name: 'CronCreate',
    description: CRON_CREATE_DESCRIPTION,
    inputSchema: {
      $schema: SCHEMA,
      type: 'object',
      properties: {
        cron: {
          description:
            'Standard 5-field cron expression in local time: M H DoM Mon DoW.',
          type: 'string',
        },
        prompt: {
          description: 'The prompt to enqueue at each fire time.',
          type: 'string',
        },
        recurring: {
          description:
            'true (default) fires repeatedly; false fires once and auto-deletes.',
          type: 'boolean',
        },
        durable: {
          description:
            'true persists to .claude/scheduled_tasks.json; false is session-only.',
          type: 'boolean',
        },
      },
      required: ['cron', 'prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'CronDelete',
    description: 'Cancel a cron job previously scheduled with CronCreate.',
    inputSchema: {
      $schema: SCHEMA,
      type: 'object',
      properties: {
        id: { description: 'Job ID returned by CronCreate.', type: 'string' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'CronList',
    description:
      'List all cron jobs scheduled via CronCreate, both durable and session-only.',
    inputSchema: {
      $schema: SCHEMA,
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'ScheduleWakeup',
    description: SCHEDULE_WAKEUP_DESCRIPTION,
    inputSchema: {
      $schema: SCHEMA,
      type: 'object',
      properties: {
        delaySeconds: {
          description:
            'Seconds from now to wake up. Clamped to [60, 3600] by the runtime. Required unless `stop` is true.',
          type: 'number',
        },
        reason: {
          description:
            'One short sentence explaining the chosen delay. Goes to telemetry and is shown to the user. Be specific. Required unless `stop` is true.',
          type: 'string',
        },
        prompt: {
          description:
            'The /loop input to fire on wake-up. Pass the same /loop input verbatim each turn so the next firing re-enters the skill and continues the loop. For autonomous /loop (no user prompt), pass the literal sentinel `<<autonomous-loop-dynamic>>` instead (the dynamic-pacing variant, not the CronCreate-mode `<<autonomous-loop>>`). Required unless `stop` is true.',
          type: 'string',
        },
        stop: {
          description:
            'Set to true to end the dynamic loop immediately instead of scheduling another wakeup. When true, all other fields are ignored and no further wakeups fire.',
          type: 'boolean',
        },
      },
      additionalProperties: false,
    },
  },
]

export interface ClaudeScheduledToolRegistryOptions {
  base: ToolRegistry
  manager: ScheduledPromptManager
  sessionId: string
  enabledTools?: readonly string[]
  now?: () => number
}

function nonEmptyString(input: Record<string, unknown>, name: string): string {
  const value = input[name]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`)
  }
  return value
}

function timeLabel(hour: number, minute: number): string {
  const suffix = hour >= 12 ? 'PM' : 'AM'
  const clockHour = hour % 12 || 12
  return `${clockHour}:${String(minute).padStart(2, '0')} ${suffix}`
}

export function describeCron(cron: string): string {
  const [minute, hour, day, month, weekday] = cron.trim().split(/\s+/u)
  if (
    minute?.startsWith('*/') &&
    hour === '*' &&
    day === '*' &&
    month === '*'
  ) {
    return `Every ${minute.slice(2)} minutes`
  }
  if (/^\d+$/u.test(minute ?? '') && hour === '*' && day === '*') {
    return `Every hour at :${String(Number(minute)).padStart(2, '0')}`
  }
  if (/^\d+$/u.test(minute ?? '') && /^\d+$/u.test(hour ?? '')) {
    const label = timeLabel(Number(hour), Number(minute))
    if (day === '*' && month === '*' && weekday === '1-5') {
      return `Weekdays at ${label}`
    }
    if (day === '*' && month === '*' && weekday === '*') {
      return `Daily at ${label}`
    }
  }
  return cron
}

function listedResult(task: ListedScheduledPrompt) {
  return {
    id: task.id,
    cron: task.cron,
    humanSchedule: describeCron(task.cron),
    prompt: task.prompt,
    ...(task.recurring ? { recurring: true } : {}),
    ...(task.durable ? {} : { durable: false }),
  }
}

export class ClaudeScheduledToolRegistry implements ToolRegistry {
  private readonly enabled: ReadonlySet<string> | null
  private readonly now: () => number

  constructor(private readonly options: ClaudeScheduledToolRegistryOptions) {
    this.enabled = options.enabledTools ? new Set(options.enabledTools) : null
    this.now = options.now ?? Date.now
  }

  definitions(): readonly ModelToolDefinition[] {
    const base = this.options.base.definitions()
    const existing = new Set(base.map(({ name }) => name))
    return [
      ...base,
      ...DEFINITIONS.filter(
        ({ name }) => (this.enabled?.has(name) ?? true) && !existing.has(name),
      ),
    ]
  }

  async prepare(
    call: ModelToolCall,
    context: ToolExecutionContext,
  ): Promise<ModelToolCall> {
    if (!DEFINITIONS.some(({ name }) => name === call.name)) {
      return this.options.base.prepare(call, context)
    }
    if (!(this.enabled?.has(call.name) ?? true)) {
      throw new Error(`Tool ${call.name} is unavailable`)
    }
    switch (call.name) {
      case 'CronCreate': {
        const recurring = call.input.recurring ?? true
        const durable = call.input.durable ?? false
        if (typeof recurring !== 'boolean') {
          throw new Error('recurring must be a boolean')
        }
        if (typeof durable !== 'boolean') {
          throw new Error('durable must be a boolean')
        }
        return {
          ...call,
          input: {
            cron: nonEmptyString(call.input, 'cron'),
            prompt: nonEmptyString(call.input, 'prompt'),
            recurring,
            durable,
          },
        }
      }
      case 'CronDelete':
        return {
          ...call,
          input: { id: nonEmptyString(call.input, 'id') },
        }
      case 'CronList':
        if (Object.keys(call.input).length > 0) {
          throw new Error('CronList does not accept input fields')
        }
        return { ...call, input: {} }
      case 'ScheduleWakeup':
        if (call.input.stop === true) return { ...call, input: { stop: true } }
        if (call.input.stop !== undefined && call.input.stop !== false) {
          throw new Error('stop must be a boolean')
        }
        if (
          typeof call.input.delaySeconds !== 'number' ||
          !Number.isFinite(call.input.delaySeconds)
        ) {
          throw new Error('delaySeconds must be a number')
        }
        return {
          ...call,
          input: {
            delaySeconds: call.input.delaySeconds,
            reason: nonEmptyString(call.input, 'reason'),
            prompt: nonEmptyString(call.input, 'prompt'),
          },
        }
      default:
        throw new Error(`Unknown scheduled tool ${call.name}`)
    }
  }

  async execute(
    call: ModelToolCall,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    switch (call.name) {
      case 'CronCreate': {
        const task = await this.options.manager.create({
          cron: String(call.input.cron),
          prompt: String(call.input.prompt),
          recurring: Boolean(call.input.recurring),
          durable: Boolean(call.input.durable),
          sessionId: this.options.sessionId,
        })
        const schedule = describeCron(task.cron)
        const persistence = task.durable
          ? 'Persisted to .claude/scheduled_tasks.json.'
          : 'Session-only (not written to disk, dies when Praxis exits).'
        const content = task.recurring
          ? `Scheduled recurring job ${task.id} (${schedule}). ${persistence} Auto-expires after 7 days. Use CronDelete to cancel sooner.`
          : `Scheduled one-shot task ${task.id} (${schedule}). ${persistence} It will fire once then auto-delete.`
        return {
          content,
          isError: false,
          nativeToolUseResult: {
            id: task.id,
            humanSchedule: schedule,
            recurring: task.recurring,
            durable: task.durable,
          },
        }
      }
      case 'CronList': {
        const jobs = (await this.options.manager.list()).map(listedResult)
        return {
          content:
            jobs.length === 0
              ? 'No scheduled jobs.'
              : jobs
                  .map(
                    (job) =>
                      `${job.id} — ${job.humanSchedule} (${job.recurring ? 'recurring' : 'one-shot'})${job.durable === false ? ' [session-only]' : ''}: ${job.prompt}`,
                  )
                  .join('\n'),
          isError: false,
          nativeToolUseResult: { jobs },
        }
      }
      case 'CronDelete': {
        const id = String(call.input.id)
        const deleted = await this.options.manager.delete(id)
        if (!deleted) throw new Error(`No scheduled job with id '${id}'`)
        return {
          content: `Cancelled job ${id}.`,
          isError: false,
          nativeToolUseResult: { id },
        }
      }
      case 'ScheduleWakeup':
        if (call.input.stop === true) {
          const cancelledWakeups = this.options.manager.stopWakeups()
          return {
            content:
              cancelledWakeups === 0
                ? 'Loop stopped — any dynamic loop in this session is ended; there was no pending wakeup to cancel. If you are running a fixed-interval /loop (a recurring cron), it is NOT stopped by this call — cancel it with CronDelete. If you armed a Monitor for this loop, TaskStop it now; otherwise nothing more to do this turn.'
                : `Loop stopped — cancelled ${cancelledWakeups} pending wakeup(s); no further dynamic-loop wakeups scheduled. If you armed a Monitor for this loop, TaskStop it now; otherwise nothing more to do this turn.`,
            isError: false,
            nativeToolUseResult: {
              stopped: true,
              nextWakeupMs: 0,
              delaySeconds: 0,
              reason: '',
            },
          }
        }
        {
          const wakeup = this.options.manager.scheduleWakeup({
            delaySeconds: Number(call.input.delaySeconds),
            prompt: String(call.input.prompt),
          })
          if (wakeup) {
            const scheduledTime = new Date(wakeup.scheduledFor)
              .toTimeString()
              .slice(0, 8)
            const secondsUntilWakeup = Math.max(
              0,
              Math.round((wakeup.scheduledFor - this.now()) / 1_000),
            )
            const clampNotice = wakeup.wasClamped
              ? ` (clamped to ${wakeup.clampedDelaySeconds}s from your requested value)`
              : ''
            return {
              content: `Next wakeup scheduled for ${scheduledTime} (in ${secondsUntilWakeup}s)${clampNotice}. Nothing more to do this turn — the harness re-invokes you when the wakeup fires or a task-notification arrives.`,
              isError: false,
              nativeToolUseResult: {
                stopped: false,
                nextWakeupMs: wakeup.scheduledFor,
                delaySeconds: wakeup.clampedDelaySeconds,
                reason: String(call.input.reason),
              },
            }
          }
        }
        return {
          content:
            'Wakeup not scheduled. Either the /loop dynamic runtime gate is off or the loop reached its maximum duration — the loop has ended; do not re-issue.',
          isError: false,
          nativeToolUseResult: {
            stopped: false,
            nextWakeupMs: 0,
            delaySeconds: 0,
            reason: String(call.input.reason),
          },
        }
      default:
        return this.options.base.execute(call, context)
    }
  }
}
