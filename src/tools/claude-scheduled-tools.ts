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

const SCHEDULE_WAKEUP_DESCRIPTION = `Schedule when to resume work in /loop dynamic mode. Do not use short wakeups to poll harness-tracked background work; completion notifications already resume the agent. Use a long fallback of at least 1200 seconds for that case. For external CI, deploy, or queue state, choose a delay matching how quickly it changes.

Pass the same /loop prompt on each turn. Autonomous dynamic loops use the literal <<autonomous-loop-dynamic>> sentinel. To end the loop, pass stop: true and omit other fields.

The runtime clamps delaySeconds to [60, 3600]. Prefer 60-270 seconds when keeping a five-minute prompt cache warm, and 1200-1800 seconds for idle fallback. Avoid exactly 300 seconds. The reason must briefly state what is being watched and why the delay fits.`

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
          description: 'Seconds from now to wake up, clamped to [60, 3600].',
          type: 'number',
        },
        reason: {
          description: 'One short sentence explaining the chosen delay.',
          type: 'string',
        },
        prompt: {
          description: 'The /loop input to fire on wake-up.',
          type: 'string',
        },
        stop: {
          description: 'Set true to end the dynamic loop immediately.',
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

  constructor(private readonly options: ClaudeScheduledToolRegistryOptions) {
    this.enabled = options.enabledTools ? new Set(options.enabledTools) : null
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
          return {
            content:
              'Loop stopped — any dynamic loop in this session is ended; there was no pending wakeup to cancel. If you are running a fixed-interval /loop (a recurring cron), it is NOT stopped by this call — cancel it with CronDelete. If you armed a Monitor for this loop, TaskStop it now; otherwise nothing more to do this turn.',
            isError: false,
            nativeToolUseResult: {
              scheduledFor: 0,
              clampedDelaySeconds: 0,
              wasClamped: false,
              stopped: true,
              cancelledWakeups: 0,
            },
          }
        }
        return {
          content:
            'Wakeup not scheduled. Either the /loop dynamic runtime gate is off or the loop reached its maximum duration — the loop has ended; do not re-issue.',
          isError: false,
          nativeToolUseResult: {
            scheduledFor: 0,
            clampedDelaySeconds: 0,
            wasClamped: false,
          },
        }
      default:
        return this.options.base.execute(call, context)
    }
  }
}
