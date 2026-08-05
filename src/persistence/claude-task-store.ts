import { randomUUID } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import {
  mkdir,
  link,
  open,
  readFile,
  readdir,
  rm,
  stat,
} from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import { writeFileAtomically } from '../platform/atomic-write.js'
import { ExclusiveFileLease } from '../platform/exclusive-file-lease.js'

export type ClaudeTaskStatus = 'pending' | 'in_progress' | 'completed'

export interface ClaudeTask {
  id: string
  subject: string
  description: string
  activeForm?: string
  status: ClaudeTaskStatus
  blocks: string[]
  blockedBy: string[]
  owner?: string
  metadata?: Record<string, unknown>
}

export interface ClaudeTaskCreateInput {
  subject: string
  description: string
  activeForm?: string
  metadata?: Record<string, unknown>
}

export interface ClaudeTaskUpdateInput {
  subject?: string
  description?: string
  activeForm?: string
  status?: ClaudeTaskStatus | 'deleted'
  addBlocks?: readonly string[]
  addBlockedBy?: readonly string[]
  owner?: string
  metadata?: Record<string, unknown>
}

export interface ClaudeTaskSummary {
  id: string
  subject: string
  status: ClaudeTaskStatus
  owner?: string
  blockedBy: string[]
}

export interface ClaudeTaskUpdateResult {
  success: true
  taskId: string
  updatedFields: string[]
  statusChange?: {
    from: ClaudeTaskStatus
    to: ClaudeTaskStatus | 'deleted'
  }
}

export interface ClaudeTaskStoreOptions {
  taskRoot: string
  lockFile?: string
}

const TASK_ID_PATTERN = /^[1-9][0-9]*$/u
const LOCK_WAIT_MS = 5_000
const MAX_UPDATE_RETRIES = 16

interface TaskFingerprint {
  device: bigint
  inode: bigint
  size: bigint
  modified: bigint
  changed: bigint
}

interface TaskRecord {
  task: ClaudeTask
  fingerprint: TaskFingerprint
}

function taskOrder(left: ClaudeTask, right: ClaudeTask): number {
  return Number(left.id) - Number(right.id)
}

function assertTaskId(taskId: string): void {
  if (!TASK_ID_PATTERN.test(taskId))
    throw new Error(`Invalid task ID: ${taskId}`)
}

function uniqueTaskIds(values: readonly string[]): string[] {
  for (const value of values) assertTaskId(value)
  return [...new Set(values)]
}

function isTaskStatus(value: unknown): value is ClaudeTaskStatus {
  return value === 'pending' || value === 'in_progress' || value === 'completed'
}

function parseTask(source: string, filePath: string): ClaudeTask {
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch (error) {
    throw new Error(`Invalid Claude task JSON: ${filePath}`, { cause: error })
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid Claude task: ${filePath}`)
  }
  const task = value as Record<string, unknown>
  if (
    typeof task.id !== 'string' ||
    !TASK_ID_PATTERN.test(task.id) ||
    typeof task.subject !== 'string' ||
    typeof task.description !== 'string' ||
    !isTaskStatus(task.status) ||
    !Array.isArray(task.blocks) ||
    !task.blocks.every(
      (id) => typeof id === 'string' && TASK_ID_PATTERN.test(id),
    ) ||
    !Array.isArray(task.blockedBy) ||
    !task.blockedBy.every(
      (id) => typeof id === 'string' && TASK_ID_PATTERN.test(id),
    )
  ) {
    throw new Error(`Invalid Claude task: ${filePath}`)
  }
  if (task.activeForm !== undefined && typeof task.activeForm !== 'string') {
    throw new Error(`Invalid Claude task activeForm: ${filePath}`)
  }
  if (task.owner !== undefined && typeof task.owner !== 'string') {
    throw new Error(`Invalid Claude task owner: ${filePath}`)
  }
  if (
    task.metadata !== undefined &&
    (!task.metadata ||
      typeof task.metadata !== 'object' ||
      Array.isArray(task.metadata))
  ) {
    throw new Error(`Invalid Claude task metadata: ${filePath}`)
  }
  return task as unknown as ClaudeTask
}

function fingerprint(metadata: BigIntStats): TaskFingerprint {
  return {
    device: metadata.dev,
    inode: metadata.ino,
    size: metadata.size,
    modified: metadata.mtimeNs,
    changed: metadata.ctimeNs,
  }
}

function sameFingerprint(
  left: TaskFingerprint,
  right: TaskFingerprint,
): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.modified === right.modified &&
    left.changed === right.changed
  )
}

export class ClaudeTaskStore {
  private readonly taskRoot: string
  private readonly lockFile: string
  private readonly lease: ExclusiveFileLease

  constructor(options: ClaudeTaskStoreOptions) {
    this.taskRoot = options.taskRoot
    this.lockFile =
      options.lockFile ??
      join(
        dirname(dirname(this.taskRoot)),
        'praxis',
        'locks',
        `tasks-${basename(this.taskRoot)}.lock`,
      )
    this.lease = new ExclusiveFileLease(this.lockFile)
  }

  async create(input: ClaudeTaskCreateInput): Promise<ClaudeTask> {
    return this.withLock(async () => {
      while (true) {
        await this.ensureRoot()
        const tasks = await this.loadUnlocked()
        const highwatermark = await this.readHighwatermark()
        const highestTaskId = tasks.reduce(
          (highest, task) => Math.max(highest, Number(task.id)),
          0,
        )
        const id = String(Math.max(highwatermark, highestTaskId) + 1)
        const task: ClaudeTask = {
          id,
          subject: input.subject,
          description: input.description,
          ...(input.activeForm === undefined
            ? {}
            : { activeForm: input.activeForm }),
          status: 'pending',
          blocks: [],
          blockedBy: [],
          ...(input.metadata === undefined
            ? {}
            : { metadata: { ...input.metadata } }),
        }
        await this.atomicWrite(join(this.taskRoot, '.highwatermark'), id)
        if (!(await this.writeTaskExclusive(task))) continue
        return task
      }
    })
  }

  async get(taskId: string): Promise<ClaudeTask | null> {
    assertTaskId(taskId)
    try {
      return parseTask(
        await readFile(this.taskPath(taskId), 'utf8'),
        this.taskPath(taskId),
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  async list(): Promise<ClaudeTask[]> {
    return this.loadUnlocked()
  }

  async listSummaries(): Promise<ClaudeTaskSummary[]> {
    const tasks = (await this.list()).filter(
      ({ metadata }) => metadata?._internal !== true,
    )
    const open = new Set(
      tasks
        .filter(
          ({ status }) => status === 'pending' || status === 'in_progress',
        )
        .map(({ id }) => id),
    )
    return tasks.map((task) => ({
      id: task.id,
      subject: task.subject,
      status: task.status,
      ...(task.owner === undefined ? {} : { owner: task.owner }),
      blockedBy: task.blockedBy.filter((id) => open.has(id)),
    }))
  }

  async update(
    taskId: string,
    input: ClaudeTaskUpdateInput,
  ): Promise<ClaudeTaskUpdateResult | null> {
    assertTaskId(taskId)
    return this.withLock(async () => {
      const reportedFields = new Set<string>()
      let reportedStatusChange:
        { from: ClaudeTaskStatus; to: ClaudeTaskStatus | 'deleted' } | undefined

      for (let attempt = 0; attempt < MAX_UPDATE_RETRIES; attempt += 1) {
        const records = await this.loadTaskRecords()
        const byId = new Map(records.map((record) => [record.task.id, record]))
        const record = byId.get(taskId)
        if (!record) return null
        const task = record.task
        const previousStatus = task.status

        if (input.status === 'deleted') {
          let deletionConflict = false
          for (const otherRecord of records) {
            const other = otherRecord.task
            if (other.id === taskId) continue
            const blocks = other.blocks.filter((id) => id !== taskId)
            const blockedBy = other.blockedBy.filter((id) => id !== taskId)
            if (
              blocks.length === other.blocks.length &&
              blockedBy.length === other.blockedBy.length
            ) {
              continue
            }
            if (
              !(await this.writeTask(
                { ...other, blocks, blockedBy },
                otherRecord.fingerprint,
              ))
            ) {
              deletionConflict = true
              break
            }
          }
          if (deletionConflict) continue
          if (!(await this.removeTask(taskId, record.fingerprint))) continue
          return {
            success: true,
            taskId,
            updatedFields: ['deleted'],
            statusChange: { from: previousStatus, to: 'deleted' },
          }
        }

        const changed = new Map<string, ClaudeTask>()
        const updatedFields: string[] = []
        const markTaskChanged = () => changed.set(task.id, task)
        for (const field of ['subject', 'description', 'activeForm'] as const) {
          const value = input[field]
          if (value === undefined || task[field] === value) continue
          task[field] = value
          updatedFields.push(field)
          markTaskChanged()
        }
        if (input.status !== undefined && input.status !== task.status) {
          task.status = input.status
          updatedFields.push('status')
          markTaskChanged()
        }
        if (input.owner !== undefined) {
          if (input.owner.length === 0 && task.owner !== undefined) {
            delete task.owner
            updatedFields.push('owner')
            markTaskChanged()
          } else if (input.owner.length > 0 && input.owner !== task.owner) {
            task.owner = input.owner
            updatedFields.push('owner')
            markTaskChanged()
          }
        }
        if (input.metadata !== undefined) {
          const metadata = { ...(task.metadata ?? {}) }
          let metadataChanged = false
          for (const [key, value] of Object.entries(input.metadata)) {
            if (value === null && key in metadata) {
              delete metadata[key]
              metadataChanged = true
            } else if (value !== null && !Object.is(metadata[key], value)) {
              metadata[key] = value
              metadataChanged = true
            }
          }
          if (metadataChanged) {
            if (Object.keys(metadata).length === 0) delete task.metadata
            else task.metadata = metadata
            updatedFields.push('metadata')
            markTaskChanged()
          }
        }

        const addDependency = (
          otherId: string,
          ownField: 'blocks' | 'blockedBy',
          otherField: 'blocks' | 'blockedBy',
        ): boolean => {
          const other = byId.get(otherId)?.task
          if (!other) return false
          let dependencyChanged = false
          if (!task[ownField].includes(otherId)) {
            task[ownField].push(otherId)
            changed.set(task.id, task)
            dependencyChanged = true
          }
          if (!other[otherField].includes(task.id)) {
            other[otherField].push(task.id)
            changed.set(other.id, other)
            dependencyChanged = true
          }
          return dependencyChanged
        }
        if (input.addBlocks !== undefined) {
          let blocksChanged = false
          for (const id of uniqueTaskIds(input.addBlocks)) {
            blocksChanged =
              addDependency(id, 'blocks', 'blockedBy') || blocksChanged
          }
          if (blocksChanged) updatedFields.push('blocks')
        }
        if (input.addBlockedBy !== undefined) {
          let blockedByChanged = false
          for (const id of uniqueTaskIds(input.addBlockedBy)) {
            blockedByChanged =
              addDependency(id, 'blockedBy', 'blocks') || blockedByChanged
          }
          if (blockedByChanged) updatedFields.push('blockedBy')
        }

        for (const field of updatedFields) reportedFields.add(field)
        if (
          !reportedStatusChange &&
          input.status !== undefined &&
          input.status !== previousStatus
        ) {
          reportedStatusChange = { from: previousStatus, to: input.status }
        }
        if (changed.size === 0) {
          return {
            success: true,
            taskId,
            updatedFields: [...reportedFields],
            ...(reportedStatusChange
              ? { statusChange: reportedStatusChange }
              : {}),
          }
        }

        let conflict = false
        for (const changedTask of changed.values()) {
          const expected = byId.get(changedTask.id)?.fingerprint
          if (!expected || !(await this.writeTask(changedTask, expected))) {
            conflict = true
            break
          }
        }
        if (conflict) continue
        return {
          success: true,
          taskId,
          updatedFields: [...reportedFields],
          ...(reportedStatusChange
            ? { statusChange: reportedStatusChange }
            : {}),
        }
      }
      throw new Error(`Claude task changed too frequently: ${taskId}`)
    })
  }

  private taskPath(taskId: string): string {
    return join(this.taskRoot, `${taskId}.json`)
  }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.taskRoot, { recursive: true })
    await (await open(join(this.taskRoot, '.lock'), 'a')).close()
  }

  private async loadUnlocked(): Promise<ClaudeTask[]> {
    return (await this.loadTaskRecords()).map(({ task }) => task)
  }

  private async loadTaskRecords(): Promise<TaskRecord[]> {
    let names: string[]
    try {
      names = await readdir(this.taskRoot)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const records = await Promise.all(
      names
        .filter((name) => /^[1-9][0-9]*\.json$/u.test(name))
        .map((name) => this.readTaskRecord(name.slice(0, -'.json'.length))),
    )
    return records
      .filter((record): record is TaskRecord => record !== null)
      .sort((left, right) => taskOrder(left.task, right.task))
  }

  private async readTaskRecord(taskId: string): Promise<TaskRecord | null> {
    const filePath = this.taskPath(taskId)
    for (let attempt = 0; attempt < MAX_UPDATE_RETRIES; attempt += 1) {
      try {
        const before = fingerprint(await stat(filePath, { bigint: true }))
        const source = await readFile(filePath, 'utf8')
        const after = fingerprint(await stat(filePath, { bigint: true }))
        if (!sameFingerprint(before, after)) continue
        return { task: parseTask(source, filePath), fingerprint: after }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      }
    }
    throw new Error(`Claude task changed too frequently: ${taskId}`)
  }

  private async readHighwatermark(): Promise<number> {
    try {
      const value = Number(
        await readFile(join(this.taskRoot, '.highwatermark'), 'utf8'),
      )
      return Number.isSafeInteger(value) && value >= 0 ? value : 0
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
      throw error
    }
  }

  private writeTask(
    task: ClaudeTask,
    expected?: TaskFingerprint,
  ): Promise<boolean> {
    return this.atomicWrite(
      this.taskPath(task.id),
      JSON.stringify(task, null, 2),
      expected,
    )
  }

  private async writeTaskExclusive(task: ClaudeTask): Promise<boolean> {
    const filePath = this.taskPath(task.id)
    await mkdir(dirname(filePath), { recursive: true })
    const temporary = join(
      dirname(filePath),
      `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
    )
    try {
      const handle = await open(temporary, 'wx', 0o600)
      try {
        await handle.writeFile(JSON.stringify(task, null, 2))
        await handle.sync()
      } finally {
        await handle.close()
      }
      try {
        await link(temporary, filePath)
        return true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
        throw error
      }
    } finally {
      await rm(temporary, { force: true })
    }
  }

  private atomicWrite(
    filePath: string,
    content: string,
    expected?: TaskFingerprint,
  ): Promise<boolean> {
    return writeFileAtomically(filePath, content, {
      ...(expected
        ? { beforeCommit: () => this.matchesFingerprint(filePath, expected) }
        : {}),
    })
  }

  private async matchesFingerprint(
    filePath: string,
    expected: TaskFingerprint,
  ): Promise<boolean> {
    try {
      return sameFingerprint(
        fingerprint(await stat(filePath, { bigint: true })),
        expected,
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }

  private async removeTask(
    taskId: string,
    expected: TaskFingerprint,
  ): Promise<boolean> {
    const filePath = this.taskPath(taskId)
    if (!(await this.matchesFingerprint(filePath, expected))) return false
    await rm(filePath, { force: true })
    return true
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const started = Date.now()
    let lock = await this.lease.tryAcquire()
    while (true) {
      if (lock) break
      if (Date.now() - started >= LOCK_WAIT_MS) {
        throw new Error(`Claude task store is locked: ${this.taskRoot}`)
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
