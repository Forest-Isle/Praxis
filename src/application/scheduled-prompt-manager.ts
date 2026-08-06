import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { promisify } from 'node:util'

import { CronExpressionParser } from 'cron-parser'

import {
  ClaudeScheduledTaskStore,
  type ClaudeScheduledTask,
} from '../persistence/claude-scheduled-task-store.js'

const execFileAsync = promisify(execFile)
const RECURRING_LIFETIME_MS = 7 * 24 * 60 * 60 * 1_000
const MAX_TIMER_MS = 2_147_000_000
const DURABLE_REFRESH_MS = 5_000

export interface ScheduledPromptManagerOptions {
  filePath: string
  lockFile: string
  dynamicWakeupsEnabled?: boolean
  now?: () => number
  processStart?: (pid: number) => Promise<string | null>
}

export interface CreateScheduledPromptInput {
  cron: string
  prompt: string
  recurring: boolean
  durable: boolean
  sessionId: string
}

export interface ScheduledPrompt {
  id: string
  prompt: string
}

export interface ListedScheduledPrompt extends ClaudeScheduledTask {
  durable: boolean
}

export interface DynamicWakeupResult {
  scheduledFor: number
  clampedDelaySeconds: number
  wasClamped: boolean
}

function nextOccurrence(cron: string, after: number): number {
  return CronExpressionParser.parse(cron, {
    currentDate: new Date(after),
  })
    .next()
    .toDate()
    .getTime()
}

function processAlive(pid: number): boolean {
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function scheduledTime(task: ClaudeScheduledTask, after: number): number {
  const base = nextOccurrence(task.cron, after)
  const fraction = Number.parseInt(task.id, 16) / 0xffffffff
  if (!task.recurring) {
    const minute = new Date(base).getMinutes()
    if (minute !== 0 && minute !== 30) return base
    return Math.max(task.createdAt, base - Math.floor(90_000 * fraction))
  }
  const following = nextOccurrence(task.cron, base + 1_000)
  const period = following - base
  const jitter = Math.floor(Math.min(period * 0.1, 15 * 60 * 1_000) * fraction)
  return Math.min(base + jitter, task.createdAt + RECURRING_LIFETIME_MS)
}

export function assertCronExpression(cron: string): void {
  if (cron.trim().split(/\s+/u).length !== 5) {
    throw new Error(
      `Invalid cron expression '${cron}'. Expected 5 fields: M H DoM Mon DoW.`,
    )
  }
  try {
    nextOccurrence(cron, Date.now())
  } catch (error) {
    throw new Error(
      `Invalid cron expression '${cron}': ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
}

async function processStart(pid: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('ps', [
      '-p',
      String(pid),
      '-o',
      'lstart=',
    ])
    const value = stdout.trim()
    if (value) return value
  } catch {
    // A live PID remains conservatively owned if its start time is unavailable.
  }
  return null
}

export class ScheduledPromptManager {
  private readonly store: ClaudeScheduledTaskStore
  private readonly sessionTasks = new Map<string, ClaudeScheduledTask>()
  private readonly dueAt = new Map<string, number>()
  private readonly dueQueue: ScheduledPrompt[] = []
  private readonly dynamicWakeups = new Map<string, ScheduledPrompt>()
  private readonly durableIds = new Set<string>()
  private readonly changeWaiters = new Set<() => void>()
  private readonly now: () => number
  private readonly dynamicWakeupsEnabled: boolean
  private readonly readProcessStart: (pid: number) => Promise<string | null>
  private readonly ownProcessStart: Promise<string>
  private initialization: Promise<void> | undefined
  private closed = false

  constructor(options: ScheduledPromptManagerOptions) {
    this.store = new ClaudeScheduledTaskStore({
      filePath: options.filePath,
      lockFile: options.lockFile,
    })
    this.now = options.now ?? Date.now
    this.dynamicWakeupsEnabled = options.dynamicWakeupsEnabled === true
    this.readProcessStart = options.processStart ?? processStart
    this.ownProcessStart = this.readProcessStart(process.pid).then(
      (value) => value ?? new Date(this.now()).toString(),
    )
  }

  async create(
    input: CreateScheduledPromptInput,
  ): Promise<ListedScheduledPrompt> {
    await this.initialize()
    assertCronExpression(input.cron)
    if (!input.prompt) throw new Error('prompt must be a non-empty string')
    const createdAt = this.now()
    const base = {
      cron: input.cron,
      prompt: input.prompt,
      createdAt,
      recurring: input.recurring,
      createdBySessionId: input.sessionId,
      createdByPid: process.pid,
      createdByProcStart: await this.ownProcessStart,
    }
    let task: ClaudeScheduledTask
    if (input.durable) {
      task = await this.store.create(base)
    } else {
      const occupied = new Set((await this.list()).map(({ id }) => id))
      let id = randomBytes(4).toString('hex')
      while (occupied.has(id)) id = randomBytes(4).toString('hex')
      task = { id, ...base }
      this.sessionTasks.set(id, task)
    }
    this.dueAt.set(task.id, scheduledTime(task, createdAt))
    if (input.durable) this.durableIds.add(task.id)
    this.notifyChange()
    return { ...task, durable: input.durable }
  }

  async list(): Promise<ListedScheduledPrompt[]> {
    await this.initialize()
    const durable = (await this.store.list()).map((task) => ({
      ...task,
      durable: true,
    }))
    return [
      ...durable,
      ...[...this.sessionTasks.values()].map((task) => ({
        ...task,
        durable: false,
      })),
    ]
  }

  async delete(id: string): Promise<boolean> {
    await this.initialize()
    const removed = await this.removeTask(id)
    if (removed) {
      this.dueAt.delete(id)
      this.notifyChange()
    }
    return removed
  }

  scheduleWakeup(input: {
    delaySeconds: number
    prompt: string
  }): DynamicWakeupResult | null {
    if (!this.dynamicWakeupsEnabled || this.closed) return null
    const clampedDelaySeconds = Math.min(
      3_600,
      Math.max(60, input.delaySeconds),
    )
    const id = `wakeup-${randomBytes(8).toString('hex')}`
    const scheduledFor = this.now() + clampedDelaySeconds * 1_000
    this.dynamicWakeups.set(id, { id, prompt: input.prompt })
    this.dueAt.set(id, scheduledFor)
    this.notifyChange()
    return {
      scheduledFor,
      clampedDelaySeconds,
      wasClamped: clampedDelaySeconds !== input.delaySeconds,
    }
  }

  stopWakeups(): number {
    const ids = new Set(this.dynamicWakeups.keys())
    for (const id of ids) this.dueAt.delete(id)
    this.dynamicWakeups.clear()
    let cancelled = ids.size
    for (let index = this.dueQueue.length - 1; index >= 0; index -= 1) {
      const queued = this.dueQueue[index]
      if (!queued?.id.startsWith('wakeup-')) continue
      this.dueQueue.splice(index, 1)
      cancelled += 1
    }
    if (cancelled > 0) this.notifyChange()
    return cancelled
  }

  async drainDue(): Promise<ScheduledPrompt[]> {
    await this.initialize()
    if (this.closed) return []
    await this.refreshDurable(this.now())
    if (this.closed) return []
    await this.fireDue(this.now())
    if (this.closed) return []
    return this.dueQueue.splice(0)
  }

  async next(signal?: AbortSignal): Promise<ScheduledPrompt | null> {
    await this.initialize()
    while (!this.closed && !signal?.aborted) {
      await this.refreshDurable(this.now())
      if (this.closed || signal?.aborted) break
      await this.fireDue(this.now())
      if (this.closed || signal?.aborted) break
      const queued = this.dueQueue.shift()
      if (queued) return queued
      const next = Math.min(...this.dueAt.values())
      await this.waitForChange(
        Number.isFinite(next)
          ? Math.min(
              DURABLE_REFRESH_MS,
              MAX_TIMER_MS,
              Math.max(0, next - this.now()),
            )
          : DURABLE_REFRESH_MS,
        signal,
      )
    }
    return null
  }

  close(): void {
    this.closed = true
    this.dynamicWakeups.clear()
    this.sessionTasks.clear()
    this.dueAt.clear()
    this.durableIds.clear()
    this.dueQueue.length = 0
    this.notifyChange()
  }

  private async initialize(): Promise<void> {
    this.initialization ??= this.refreshDurable(this.now()).catch((error) => {
      this.initialization = undefined
      throw error
    })
    await this.initialization
  }

  private async refreshDurable(now: number): Promise<void> {
    const tasks = await this.store.list()
    if (this.closed) return
    const currentIds = new Set(tasks.map(({ id }) => id))
    for (const id of this.durableIds) {
      if (!currentIds.has(id) && !this.sessionTasks.has(id)) {
        this.dueAt.delete(id)
      }
    }
    this.durableIds.clear()
    for (const task of tasks) {
      this.durableIds.add(task.id)
      if (await this.hasLiveOwner(task)) {
        this.dueAt.delete(task.id)
        continue
      }
      if (this.dueAt.has(task.id)) continue
      const due = scheduledTime(task, task.recurring ? now : task.createdAt)
      if (due > now) {
        this.dueAt.set(task.id, due)
        continue
      }
      if (await this.store.delete(task.id)) {
        if (this.closed) return
        this.durableIds.delete(task.id)
        this.dueQueue.push({ id: task.id, prompt: task.prompt })
      }
    }
  }

  private async fireDue(now: number): Promise<void> {
    const dueIds = [...this.dueAt]
      .filter(([, due]) => due <= now)
      .sort((left, right) => left[1] - right[1])
      .map(([id]) => id)
    if (dueIds.length === 0) return
    for (const id of dueIds) this.dueAt.delete(id)
    for (const id of dueIds) {
      const wakeup = this.dynamicWakeups.get(id)
      if (!wakeup) continue
      this.dynamicWakeups.delete(id)
      this.dueQueue.push(wakeup)
    }
    const tasks = await this.list()
    if (this.closed) return
    const byId = new Map(tasks.map((task) => [task.id, task]))
    for (const id of dueIds) {
      if (id.startsWith('wakeup-')) continue
      const task = byId.get(id)
      if (!task) continue
      const expired =
        task.recurring && now - task.createdAt >= RECURRING_LIFETIME_MS
      if (!task.recurring || expired) {
        if (!(await this.removeTask(id))) continue
      } else {
        this.dueAt.set(id, scheduledTime(task, now))
      }
      if (this.closed) return
      this.dueQueue.push({ id, prompt: task.prompt })
    }
  }

  private async removeTask(id: string): Promise<boolean> {
    const removedSession = this.sessionTasks.delete(id)
    const removedDurable = removedSession ? false : await this.store.delete(id)
    if (removedDurable) this.durableIds.delete(id)
    return removedSession || removedDurable
  }

  private async hasLiveOwner(task: ClaudeScheduledTask): Promise<boolean> {
    if (task.createdByPid === process.pid) return false
    if (!processAlive(task.createdByPid)) return false
    const started = await this.readProcessStart(task.createdByPid)
    return started === null || started === task.createdByProcStart
  }

  private waitForChange(timeout: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer)
        this.changeWaiters.delete(done)
        signal?.removeEventListener('abort', done)
        resolve()
      }
      const timer = setTimeout(done, timeout)
      timer.unref()
      this.changeWaiters.add(done)
      signal?.addEventListener('abort', done, { once: true })
      if (signal?.aborted) done()
    })
  }

  private notifyChange(): void {
    for (const resolve of [...this.changeWaiters]) resolve()
  }
}
