import { constants } from 'node:fs'
import { lstat, mkdir, open, opendir } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { writeFileAtomically } from '../platform/atomic-write.js'
import {
  ExclusiveFileLease,
  type ExclusiveFileLeaseHandle,
} from '../platform/exclusive-file-lease.js'
import { sanitizeProjectPath } from '../platform/project-path-key.js'

type ManagedWorktreeKind = 'workflow' | 'agent' | 'team'
type ManagedWorktreePolicy = 'ephemeral' | 'durable'
type ManagedWorktreeState =
  'creating' | 'active' | 'releasing' | 'retained' | 'released'

export interface ManagedWorktreeRecord {
  version: 1
  worktreeId: string
  kind: ManagedWorktreeKind
  policy: ManagedWorktreePolicy
  ownerId: string
  repositoryRoot: string
  worktreePath: string
  branch: string | null
  baseCommit: string
  state: ManagedWorktreeState
  createdAt: string
  updatedAt: string
  retentionReason?: string
}

const RECORD_FIELDS = new Set([
  'version',
  'worktreeId',
  'kind',
  'policy',
  'ownerId',
  'repositoryRoot',
  'worktreePath',
  'branch',
  'baseCommit',
  'state',
  'createdAt',
  'updatedAt',
  'retentionReason',
])
const REQUIRED_FIELDS = [...RECORD_FIELDS].filter(
  (field) => field !== 'retentionReason',
)
const ID_PATTERN = /^[a-f0-9]{32,64}$/u
const COMMIT_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u
const PROJECT_LEASE_ATTEMPTS = 400
const PROJECT_LEASE_DELAY_MS = 5

const ALLOWED_TRANSITIONS: Readonly<
  Record<ManagedWorktreeState, ReadonlySet<ManagedWorktreeState>>
> = {
  creating: new Set(['active', 'retained', 'released']),
  active: new Set(['releasing', 'retained']),
  releasing: new Set(['releasing', 'retained', 'released']),
  retained: new Set(['releasing', 'retained']),
  released: new Set(['released']),
}

function invalidRecord(detail?: string): Error {
  return new Error(
    detail
      ? `Invalid managed worktree record: ${detail}`
      : 'Invalid managed worktree record',
  )
}

function exactIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const milliseconds = Date.parse(value)
  return (
    !Number.isNaN(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  )
}

function validText(
  value: unknown,
  maximumLength: number,
  allowedControls: ReadonlySet<number> = new Set(),
): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximumLength
  ) {
    return false
  }
  return !Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0
    return (code <= 0x1f || code === 0x7f) && !allowedControls.has(code)
  })
}

function isPathWithin(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate))
  return (
    path !== '' &&
    path !== '..' &&
    !path.startsWith(`..${sep}`) &&
    !isAbsolute(path)
  )
}

function validateRecord(value: unknown): ManagedWorktreeRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidRecord()
  }
  const record = value as Record<string, unknown>
  if (
    Object.keys(record).some((key) => !RECORD_FIELDS.has(key)) ||
    REQUIRED_FIELDS.some((key) => !(key in record))
  ) {
    throw invalidRecord('unexpected or missing field')
  }
  if (
    record.version !== 1 ||
    typeof record.worktreeId !== 'string' ||
    !ID_PATTERN.test(record.worktreeId) ||
    (record.kind !== 'workflow' &&
      record.kind !== 'agent' &&
      record.kind !== 'team') ||
    (record.policy !== 'ephemeral' && record.policy !== 'durable') ||
    !validText(record.ownerId, 256) ||
    typeof record.repositoryRoot !== 'string' ||
    !isAbsolute(record.repositoryRoot) ||
    resolve(record.repositoryRoot) !== record.repositoryRoot ||
    typeof record.worktreePath !== 'string' ||
    !isAbsolute(record.worktreePath) ||
    resolve(record.worktreePath) !== record.worktreePath ||
    (record.branch !== null && !validText(record.branch, 256)) ||
    typeof record.baseCommit !== 'string' ||
    !COMMIT_PATTERN.test(record.baseCommit) ||
    !['creating', 'active', 'releasing', 'retained', 'released'].includes(
      String(record.state),
    ) ||
    !exactIsoTimestamp(record.createdAt) ||
    !exactIsoTimestamp(record.updatedAt) ||
    Date.parse(record.updatedAt) < Date.parse(record.createdAt) ||
    (record.retentionReason !== undefined &&
      !validText(record.retentionReason, 2048, new Set([0x09, 0x0a, 0x0d]))) ||
    (record.state === 'retained' && record.retentionReason === undefined) ||
    (record.state !== 'retained' && record.retentionReason !== undefined)
  ) {
    throw invalidRecord()
  }
  const kindRoot = join(
    record.repositoryRoot,
    '.praxis',
    'worktrees',
    record.kind,
  )
  if (!isPathWithin(kindRoot, record.worktreePath)) {
    throw invalidRecord('worktree path is outside its kind root')
  }
  return record as unknown as ManagedWorktreeRecord
}

async function assertDirectoryChain(path: string, root: string): Promise<void> {
  const chain: string[] = []
  let current = resolve(path)
  const boundary = resolve(root)
  for (;;) {
    chain.unshift(current)
    if (current === boundary) break
    const parent = resolve(current, '..')
    if (parent === current) {
      throw new Error('Managed worktree state path escapes its root')
    }
    current = parent
  }
  for (const candidate of chain) {
    try {
      const entry = await lstat(candidate)
      if (entry.isSymbolicLink()) {
        throw new Error(
          `Managed worktree state path must not contain a symlink: ${candidate}`,
        )
      }
      if (!entry.isDirectory()) {
        throw new Error(
          `Managed worktree state path must contain only directories: ${candidate}`,
        )
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}

async function prepareDirectory(path: string, root: string): Promise<void> {
  await assertDirectoryChain(path, root)
  await mkdir(path, { recursive: true, mode: 0o700 })
  await assertDirectoryChain(path, root)
}

async function readRegularFile(
  path: string,
  description: string,
): Promise<string> {
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`${description} is missing`)
    }
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new Error(`${description} must be a regular file`)
    }
    throw error
  }
  try {
    if (!(await handle.stat()).isFile()) {
      throw new Error(`${description} must be a regular file`)
    }
    return await handle.readFile({ encoding: 'utf8' })
  } finally {
    await handle.close()
  }
}

async function readRecord(path: string): Promise<ManagedWorktreeRecord> {
  let value: unknown
  try {
    value = JSON.parse(await readRegularFile(path, 'Managed worktree record'))
  } catch (error) {
    throw invalidRecord(error instanceof Error ? error.message : String(error))
  }
  return validateRecord(value)
}

function managedWorktreeRecordPath(
  stateRoot: string,
  repositoryRoot: string,
  worktreeId: string,
): string {
  if (typeof stateRoot !== 'string' || stateRoot.trim() === '') {
    throw invalidRecord('state root must be non-empty')
  }
  if (
    !isAbsolute(repositoryRoot) ||
    resolve(repositoryRoot) !== repositoryRoot ||
    !ID_PATTERN.test(worktreeId)
  ) {
    throw invalidRecord()
  }
  return resolve(
    stateRoot,
    'managed-worktrees',
    sanitizeProjectPath(repositoryRoot),
    `${worktreeId}.json`,
  )
}

export class ManagedWorktreeStore {
  readonly path: string
  readonly lockPath: string
  readonly projectLockPath: string
  private readonly directory: string
  private readonly stateRoot: string
  private readonly repositoryRoot: string
  private readonly worktreeId: string
  private readonly worktreeLease: ExclusiveFileLease
  private readonly projectLease: ExclusiveFileLease

  constructor(stateRoot: string, repositoryRoot: string, worktreeId: string) {
    this.stateRoot = resolve(stateRoot)
    this.repositoryRoot = repositoryRoot
    this.worktreeId = worktreeId
    this.path = managedWorktreeRecordPath(stateRoot, repositoryRoot, worktreeId)
    this.directory = resolve(this.path, '..')
    this.lockPath = join(this.directory, `${worktreeId}.lock`)
    this.projectLockPath = join(this.directory, '.registry.lock')
    this.worktreeLease = new ExclusiveFileLease(this.lockPath)
    this.projectLease = new ExclusiveFileLease(this.projectLockPath)
  }

  async acquireLease(): Promise<ExclusiveFileLeaseHandle | null> {
    await prepareDirectory(this.directory, this.stateRoot)
    return this.worktreeLease.tryAcquire()
  }

  async read(): Promise<ManagedWorktreeRecord> {
    const record = await readRecord(this.path)
    this.assertStoreIdentity(record)
    return record
  }

  async create(record: ManagedWorktreeRecord): Promise<void> {
    this.assertStoreIdentity(validateRecord(record))
    if (record.state !== 'creating') {
      throw invalidRecord('new records must start in creating state')
    }
    await this.withProjectLease(async () => {
      try {
        await lstat(this.path)
        throw new Error('Managed worktree record already exists')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      await this.assertUnreservedPath(record.worktreePath)
      const committed = await writeFileAtomically(
        this.path,
        `${JSON.stringify(record)}\n`,
        {
          mode: 0o600,
          beforeCommit: async () => {
            try {
              await lstat(this.path)
              return false
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return true
              }
              throw error
            }
          },
        },
      )
      if (!committed) throw new Error('Could not write managed worktree record')
    })
  }

  async update(record: ManagedWorktreeRecord): Promise<void> {
    this.assertStoreIdentity(validateRecord(record))
    await this.withProjectLease(async () => {
      const current = await readRecord(this.path)
      this.assertStoreIdentity(current)
      this.assertSameIdentity(current, record)
      if (!ALLOWED_TRANSITIONS[current.state].has(record.state)) {
        throw new Error(
          `Invalid managed worktree transition: ${current.state} -> ${record.state}`,
        )
      }
      if (Date.parse(record.updatedAt) < Date.parse(current.updatedAt)) {
        throw invalidRecord('updatedAt must not move backwards')
      }
      const committed = await writeFileAtomically(
        this.path,
        `${JSON.stringify(record)}\n`,
        {
          mode: 0o600,
          beforeCommit: async () => {
            try {
              const entry = await lstat(this.path)
              return entry.isFile() && !entry.isSymbolicLink()
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return false
              }
              throw error
            }
          },
        },
      )
      if (!committed) throw new Error('Could not write managed worktree record')
    })
  }

  private async withProjectLease<T>(operation: () => Promise<T>): Promise<T> {
    await prepareDirectory(this.directory, this.stateRoot)
    let lease: ExclusiveFileLeaseHandle | null = null
    for (let attempt = 0; attempt < PROJECT_LEASE_ATTEMPTS; attempt += 1) {
      lease = await this.projectLease.tryAcquire()
      if (lease) break
      await sleep(PROJECT_LEASE_DELAY_MS)
    }
    if (!lease) {
      throw new Error(
        `Timed out acquiring managed worktree registry lock: ${this.projectLockPath}`,
      )
    }
    try {
      return await operation()
    } finally {
      await lease.release()
    }
  }

  private async assertUnreservedPath(worktreePath: string): Promise<void> {
    const directory = await opendir(this.directory)
    for await (const entry of directory) {
      if (!entry.name.endsWith('.json')) continue
      const candidate = await readRecord(join(this.directory, entry.name))
      if (candidate.repositoryRoot !== this.repositoryRoot) {
        throw new Error('Managed worktree registry project-key collision')
      }
      if (
        candidate.worktreePath === worktreePath &&
        candidate.state !== 'released'
      ) {
        throw new Error(
          `Managed worktree path is already owned: ${worktreePath}`,
        )
      }
    }
  }

  private assertStoreIdentity(record: ManagedWorktreeRecord): void {
    if (
      record.repositoryRoot !== this.repositoryRoot ||
      record.worktreeId !== this.worktreeId
    ) {
      throw invalidRecord('record identity does not match its store')
    }
  }

  private assertSameIdentity(
    current: ManagedWorktreeRecord,
    next: ManagedWorktreeRecord,
  ): void {
    for (const field of [
      'version',
      'worktreeId',
      'kind',
      'policy',
      'ownerId',
      'repositoryRoot',
      'worktreePath',
      'branch',
      'baseCommit',
      'createdAt',
    ] as const) {
      if (current[field] !== next[field]) {
        throw invalidRecord(`immutable field changed: ${field}`)
      }
    }
  }
}
