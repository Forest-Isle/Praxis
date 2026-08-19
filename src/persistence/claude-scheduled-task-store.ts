import { randomBytes } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { writeFileAtomically } from '../platform/atomic-write.js'
import { ExclusiveFileLease } from '../platform/exclusive-file-lease.js'

export interface ClaudeScheduledTask {
  id: string
  cron: string
  prompt: string
  createdAt: number
  recurring: boolean
  createdBySessionId: string
  createdByPid: number
  createdByProcStart: string
  [key: string]: unknown
}

interface ScheduledTaskDocument {
  tasks: ClaudeScheduledTask[]
  [key: string]: unknown
}

export interface ClaudeScheduledTaskStoreOptions {
  filePath: string
  lockFile?: string
}

export type ClaudeScheduledTaskCreateInput = Pick<
  ClaudeScheduledTask,
  | 'cron'
  | 'prompt'
  | 'createdAt'
  | 'recurring'
  | 'createdBySessionId'
  | 'createdByPid'
  | 'createdByProcStart'
>

export interface ClaudeScheduledTaskCreateOptions {
  maxJobs?: number
}

export class ClaudeScheduledTaskLimitError extends Error {
  constructor(readonly maxJobs: number) {
    super(
      `Scheduled job limit reached: at most ${maxJobs} active scheduled jobs. Delete or wait for an existing job before scheduling another.`,
    )
    this.name = 'ClaudeScheduledTaskLimitError'
  }
}

const JOB_ID_PATTERN = /^[0-9a-f]{8}$/u
const LOCK_WAIT_MS = 5_000
const MAX_MUTATION_RETRIES = 16

interface FileFingerprint {
  device: bigint
  inode: bigint
  size: bigint
  modified: bigint
  changed: bigint
}

function fingerprint(metadata: BigIntStats): FileFingerprint {
  return {
    device: metadata.dev,
    inode: metadata.ino,
    size: metadata.size,
    modified: metadata.mtimeNs,
    changed: metadata.ctimeNs,
  }
}

function sameFingerprint(
  left: FileFingerprint,
  right: FileFingerprint,
): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.modified === right.modified &&
    left.changed === right.changed
  )
}

function parseTask(value: unknown): ClaudeScheduledTask {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid Claude scheduled task')
  }
  const task = value as Record<string, unknown>
  if (
    typeof task.id !== 'string' ||
    !JOB_ID_PATTERN.test(task.id) ||
    typeof task.cron !== 'string' ||
    typeof task.prompt !== 'string' ||
    !Number.isSafeInteger(task.createdAt) ||
    Number(task.createdAt) < 0 ||
    typeof task.recurring !== 'boolean' ||
    typeof task.createdBySessionId !== 'string' ||
    !Number.isSafeInteger(task.createdByPid) ||
    Number(task.createdByPid) <= 0 ||
    typeof task.createdByProcStart !== 'string'
  ) {
    throw new Error('Invalid Claude scheduled task')
  }
  return { ...task } as ClaudeScheduledTask
}

function parseDocument(
  source: string,
  filePath: string,
): ScheduledTaskDocument {
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch (error) {
    throw new Error(`Invalid Claude scheduled task JSON: ${filePath}`, {
      cause: error,
    })
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid Claude scheduled task document: ${filePath}`)
  }
  const document = value as Record<string, unknown>
  if (!Array.isArray(document.tasks)) {
    throw new Error(`Invalid Claude scheduled task document: ${filePath}`)
  }
  const tasks = document.tasks.map(parseTask)
  if (new Set(tasks.map(({ id }) => id)).size !== tasks.length) {
    throw new Error(`Duplicate Claude scheduled task ID: ${filePath}`)
  }
  return { ...document, tasks }
}

export class ClaudeScheduledTaskStore {
  private readonly filePath: string
  private readonly lease: ExclusiveFileLease

  constructor(options: ClaudeScheduledTaskStoreOptions) {
    this.filePath = options.filePath
    this.lease = new ExclusiveFileLease(
      options.lockFile ??
        join(dirname(dirname(this.filePath)), 'praxis', 'locks', 'cron.lock'),
    )
  }

  async list(): Promise<ClaudeScheduledTask[]> {
    return (await this.readRecord()).document.tasks.map((task) => ({ ...task }))
  }

  async create(
    input: ClaudeScheduledTaskCreateInput,
    options: ClaudeScheduledTaskCreateOptions = {},
  ): Promise<ClaudeScheduledTask> {
    return this.withLock(async () => {
      for (let attempt = 0; attempt < MAX_MUTATION_RETRIES; attempt += 1) {
        const { document, fingerprint: expected } = await this.readRecord()
        if (
          options.maxJobs !== undefined &&
          document.tasks.length >= options.maxJobs
        ) {
          throw new ClaudeScheduledTaskLimitError(options.maxJobs)
        }
        const ids = new Set(document.tasks.map(({ id }) => id))
        let id = randomBytes(4).toString('hex')
        while (ids.has(id)) id = randomBytes(4).toString('hex')
        const task: ClaudeScheduledTask = { id, ...input }
        if (
          await this.writeDocument(
            { ...document, tasks: [...document.tasks, task] },
            expected,
          )
        ) {
          return { ...task }
        }
      }
      throw new Error(`Claude scheduled task file changed too frequently`)
    })
  }

  async delete(id: string): Promise<boolean> {
    if (!JOB_ID_PATTERN.test(id)) return false
    return this.withLock(async () => {
      for (let attempt = 0; attempt < MAX_MUTATION_RETRIES; attempt += 1) {
        const { document, fingerprint: expected } = await this.readRecord()
        const tasks = document.tasks.filter((task) => task.id !== id)
        if (tasks.length === document.tasks.length) return false
        if (await this.writeDocument({ ...document, tasks }, expected)) {
          return true
        }
      }
      throw new Error(`Claude scheduled task file changed too frequently`)
    })
  }

  private async readRecord(): Promise<{
    document: ScheduledTaskDocument
    fingerprint: FileFingerprint | null
  }> {
    try {
      const before = fingerprint(await stat(this.filePath, { bigint: true }))
      const source = await readFile(this.filePath, 'utf8')
      const after = fingerprint(await stat(this.filePath, { bigint: true }))
      if (!sameFingerprint(before, after)) return this.readRecord()
      return {
        document: parseDocument(source, this.filePath),
        fingerprint: after,
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { document: { tasks: [] }, fingerprint: null }
      }
      throw error
    }
  }

  private writeDocument(
    document: ScheduledTaskDocument,
    expected: FileFingerprint | null,
  ): Promise<boolean> {
    return writeFileAtomically(
      this.filePath,
      `${JSON.stringify(document, null, 2)}\n`,
      { beforeCommit: () => this.matchesFingerprint(expected) },
    )
  }

  private async matchesFingerprint(
    expected: FileFingerprint | null,
  ): Promise<boolean> {
    try {
      const current = fingerprint(await stat(this.filePath, { bigint: true }))
      return expected !== null && sameFingerprint(current, expected)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return expected === null
      }
      throw error
    }
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const started = Date.now()
    let lock = await this.lease.tryAcquire()
    while (!lock) {
      if (Date.now() - started >= LOCK_WAIT_MS) {
        throw new Error(
          `Claude scheduled task store is locked: ${this.filePath}`,
        )
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
      lock = await this.lease.tryAcquire()
    }
    try {
      return await operation()
    } finally {
      await lock.release()
    }
  }
}
