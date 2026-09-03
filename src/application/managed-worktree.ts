import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'

import {
  ManagedWorktreeStore,
  inspectManagedWorktreeRegistry,
  type ManagedWorktreeRecord,
} from '../persistence/managed-worktree-store.js'
import { resolveProjectIdentity } from '../platform/project-identity.js'
import { sanitizeProjectPath } from '../platform/project-path-key.js'
import { writeFileAtomically } from '../platform/atomic-write.js'
import {
  ExclusiveFileLease,
  type ExclusiveFileLeaseHandle,
} from '../platform/exclusive-file-lease.js'
import { isTerminalLifecycleState } from '../core/agent-orchestration.js'
import { SubagentLifecycleStore } from '../persistence/subagent-lifecycle-store.js'
import { parseAgentWorktreeOwner } from './agent-worktree-owner.js'
import { isWorkflowAgentId, isWorkflowRunId } from '../native/workflow.js'
import { parseTeamId } from '../core/team-ownership.js'

const execFileAsync = promisify(execFile)

export interface ManagedWorktreeCleanup {
  retained: boolean
  reason?: string
}

export interface ManagedWorktree {
  cwd: string
  cleanup(): Promise<ManagedWorktreeCleanup>
  retain(reason: string): Promise<ManagedWorktreeCleanup>
  release(): Promise<ManagedWorktreeCleanup>
}

export interface ManagedWorktreeHookInput {
  readonly worktreePath: string
  readonly worktreeKind: 'workflow' | 'agent' | 'team'
  readonly worktreeId: string
  readonly ownerId: string
  readonly baseCommit: string
}

export interface ManagedWorktreeRemoveHookInput extends ManagedWorktreeHookInput {
  readonly reason: 'normal' | 'reconcile'
}

export interface ManagedWorktreeHookOutcome {
  blockedReason?: string
}

export interface ManagedWorktreeHooks {
  afterCreate(
    input: ManagedWorktreeHookInput,
  ): Promise<ManagedWorktreeHookOutcome>
  beforeRemove(
    input: ManagedWorktreeRemoveHookInput,
  ): Promise<ManagedWorktreeHookOutcome>
}

export interface OwnedManagedWorktreeOptions {
  cwd: string
  stateRoot: string
  parentDirectoryName?: string
  directoryName: string
  branch?: string
  ownerId: string
  label: 'Agent' | 'Workflow' | 'Team'
  kind: 'workflow' | 'agent' | 'team'
  policy: 'ephemeral' | 'durable'
  hooks?: ManagedWorktreeHooks
}

export type ManagedWorktreeReconciliationDisposition =
  'released' | 'retained' | 'skipped' | 'invalid'
export interface ManagedWorktreeReconciliationEntry {
  recordPath: string
  worktreeId?: string
  disposition: ManagedWorktreeReconciliationDisposition
  reason: string
}
export interface ManagedWorktreeReconciliationResult {
  repositoryRoot: string
  inspected: number
  truncated: boolean
  entries: readonly ManagedWorktreeReconciliationEntry[]
}

export type ManagedWorktreeHealthStatus =
  'active' | 'retained' | 'safely-releasable' | 'released' | 'unsafe'

export interface ManagedWorktreeHealthEntry {
  recordPath: string
  worktreeId: string | null
  kind: ManagedWorktreeRecord['kind'] | null
  policy: ManagedWorktreeRecord['policy'] | null
  recordState: ManagedWorktreeRecord['state'] | null
  worktreePath: string | null
  branch: string | null
  present: boolean | null
  status: ManagedWorktreeHealthStatus
  reason: string
}

export interface ManagedWorktreeHealthReport {
  repositoryRoot: string
  inspected: number
  truncated: boolean
  counts: {
    active: number
    retained: number
    safelyReleasable: number
    released: number
    unsafe: number
  }
  entries: readonly ManagedWorktreeHealthEntry[]
}

const reconciliationCache = new Map<
  string,
  Promise<ManagedWorktreeReconciliationResult>
>()

async function gitRaw(cwd: string, args: readonly string[]): Promise<string> {
  return (
    await execFileAsync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  ).stdout
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  return (await gitRaw(cwd, args)).trim()
}

async function gitOptional(
  cwd: string,
  args: readonly string[],
): Promise<string | null> {
  try {
    return await git(cwd, args)
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) return null
    throw error
  }
}

async function ownedBranchRef(
  repositoryRoot: string,
  branch: string,
  baseCommit: string,
): Promise<'absent' | 'match' | 'ambiguous'> {
  try {
    const checked = await git(repositoryRoot, [
      'check-ref-format',
      '--branch',
      branch,
    ])
    if (checked !== branch) return 'ambiguous'
  } catch {
    return 'ambiguous'
  }
  try {
    const value = await git(repositoryRoot, [
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/heads/${branch}`,
    ])
    return value === baseCommit ? 'match' : 'ambiguous'
  } catch (error) {
    return Number((error as { code?: unknown }).code) === 1
      ? 'absent'
      : 'ambiguous'
  }
}

async function removeOwnedBranch(
  repositoryRoot: string,
  branch: string,
  baseCommit: string,
): Promise<void> {
  const ref = await ownedBranchRef(repositoryRoot, branch, baseCommit)
  if (ref === 'absent') return
  if (ref === 'ambiguous') throw new Error('owned branch moved or is ambiguous')
  try {
    await git(repositoryRoot, [
      'update-ref',
      '-d',
      `refs/heads/${branch}`,
      baseCommit,
    ])
  } catch (error) {
    throw new Error(
      `could not safely remove owned branch: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

async function registeredWorktrees(root: string): Promise<Set<string>> {
  const output = await gitRaw(root, ['worktree', 'list', '--porcelain', '-z'])
  return new Set(
    output
      .split('\0')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => resolve(root, line.slice('worktree '.length))),
  )
}

const COMPONENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/u
const MARKER_FIELDS = new Set(['version', 'worktreeId', 'repositoryRoot'])
const LOCAL_EXCLUDE_PATTERN = '/.praxis/worktrees/'

function managedWorktreeId(
  repositoryRoot: string,
  kind: OwnedManagedWorktreeOptions['kind'],
  ownerId: string,
): string {
  return createHash('sha256')
    .update(`${repositoryRoot}\0${kind}\0${ownerId}`)
    .digest('hex')
}

function validOwnerId(ownerId: string): boolean {
  return (
    ownerId.length > 0 &&
    ownerId.length <= 256 &&
    !Array.from(ownerId).some((character) => {
      const code = character.codePointAt(0) ?? 0
      return code <= 0x1f || code === 0x7f
    })
  )
}

function validRetentionReason(reason: string): boolean {
  return (
    typeof reason === 'string' &&
    reason.trim().length > 0 &&
    reason.length <= 1024 &&
    !Array.from(reason).some((character) => {
      const code = character.codePointAt(0) ?? 0
      return code <= 0x1f || code === 0x7f
    })
  )
}

function assertRetentionReason(reason: string): void {
  if (!validRetentionReason(reason))
    throw new Error('Managed worktree retention reason is invalid')
}

function worktreeError(
  options: { label: 'Agent' | 'Workflow' | 'Team' },
  message: string,
): Error {
  return new Error(`${options.label} worktree ${message}`)
}

async function assertRealDirectory(
  path: string,
  description: string,
): Promise<void> {
  let current = resolve(path)
  const parts: string[] = []
  while (true) {
    parts.unshift(current)
    const parent = resolve(current, '..')
    if (parent === current) break
    current = parent
  }
  for (const part of parts) {
    try {
      const entry = await lstat(part)
      if (entry.isSymbolicLink())
        throw new Error(`${description} must not be a symlink`)
      if (!entry.isDirectory())
        throw new Error(`${description} must be a directory`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
  }
}

async function acquireLease(
  lease: ExclusiveFileLease,
  description: string,
): Promise<ExclusiveFileLeaseHandle> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const handle = await lease.tryAcquire()
    if (handle) return handle
    await sleep(5)
  }
  throw new Error(`Timed out acquiring ${description}`)
}

async function readRegularFile(
  path: string,
  description: string,
): Promise<string> {
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
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

async function ensureManagedRootIgnored(repositoryRoot: string): Promise<void> {
  const commonValue = await git(repositoryRoot, [
    'rev-parse',
    '--git-common-dir',
  ])
  const commonDirectory = await realpath(
    isAbsolute(commonValue)
      ? commonValue
      : resolve(repositoryRoot, commonValue),
  )
  const infoDirectory = join(commonDirectory, 'info')
  await assertRealDirectory(commonDirectory, 'Git common directory')
  await assertRealDirectory(infoDirectory, 'Git info directory')
  await mkdir(infoDirectory, { recursive: true, mode: 0o700 })
  await assertRealDirectory(infoDirectory, 'Git info directory')
  const excludePath = join(infoDirectory, 'exclude')
  const lease = await acquireLease(
    new ExclusiveFileLease(`${excludePath}.praxis.lock`),
    'managed worktree ignore lock',
  )
  try {
    let source = ''
    try {
      source = await readRegularFile(excludePath, 'Git info exclude')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const lines = source.split(/\r?\n/u)
    if (lines.includes(LOCAL_EXCLUDE_PATTERN)) return
    const prefix = source.length > 0 && !source.endsWith('\n') ? '\n' : ''
    const next = `${source}${prefix}${LOCAL_EXCLUDE_PATTERN}\n`
    const committed = await writeFileAtomically(excludePath, next, {
      mode: 0o600,
      beforeCommit: async () => {
        try {
          return (
            (await readRegularFile(excludePath, 'Git info exclude')) === source
          )
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === 'ENOENT' && !source
        }
      },
    })
    if (!committed) {
      throw new Error('Git info exclude changed during managed worktree setup')
    }
  } finally {
    await lease.release()
  }
}

async function linkedGitDirectory(worktreePath: string): Promise<string> {
  const value = await git(worktreePath, ['rev-parse', '--git-dir'])
  return realpath(isAbsolute(value) ? value : resolve(worktreePath, value))
}

async function writeMarker(
  path: string,
  record: ManagedWorktreeRecord,
): Promise<void> {
  const gitDirectory = await linkedGitDirectory(path)
  const marker = join(gitDirectory, 'PRAXIS_WORKTREE')
  try {
    await lstat(marker)
    throw new Error('Managed worktree marker already exists')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const committed = await writeFileAtomically(
    marker,
    `${JSON.stringify({ version: 1, worktreeId: record.worktreeId, repositoryRoot: record.repositoryRoot })}\n`,
    {
      mode: 0o600,
      beforeCommit: async () => {
        try {
          await lstat(marker)
          return false
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === 'ENOENT'
        }
      },
    },
  )
  if (!committed) throw new Error('Managed worktree marker already exists')
}

async function readMarker(
  worktreePath: string,
  record: ManagedWorktreeRecord,
): Promise<void> {
  const marker = await readMarkerIdentity(worktreePath)
  if (
    marker.worktreeId !== record.worktreeId ||
    marker.repositoryRoot !== record.repositoryRoot
  ) {
    throw new Error('worktree marker does not match ownership record')
  }
}

async function readMarkerIdentity(
  worktreePath: string,
): Promise<{ worktreeId: string; repositoryRoot: string }> {
  const markerPath = join(
    await linkedGitDirectory(worktreePath),
    'PRAXIS_WORKTREE',
  )
  let marker: unknown
  try {
    marker = JSON.parse(await readRegularFile(markerPath, 'worktree marker'))
  } catch {
    throw new Error('worktree marker is invalid')
  }
  if (
    typeof marker !== 'object' ||
    marker === null ||
    Array.isArray(marker) ||
    Object.keys(marker).length !== MARKER_FIELDS.size ||
    Object.keys(marker).some((key) => !MARKER_FIELDS.has(key)) ||
    (marker as Record<string, unknown>).version !== 1 ||
    typeof (marker as Record<string, unknown>).worktreeId !== 'string' ||
    typeof (marker as Record<string, unknown>).repositoryRoot !== 'string'
  ) {
    throw new Error('worktree marker is invalid')
  }
  const fields = marker as Record<string, unknown>
  if (
    !/^[a-f0-9]{32,64}$/u.test(String(fields.worktreeId)) ||
    !isAbsolute(String(fields.repositoryRoot)) ||
    resolve(String(fields.repositoryRoot)) !== String(fields.repositoryRoot)
  ) {
    throw new Error('worktree marker is invalid')
  }
  return {
    worktreeId: fields.worktreeId as string,
    repositoryRoot: fields.repositoryRoot as string,
  }
}

async function inspectOwnedCheckout(
  record: ManagedWorktreeRecord,
  registered?: Set<string>,
): Promise<{ status: string; head: string }> {
  const registrations =
    registered ?? (await registeredWorktrees(record.repositoryRoot))
  const pathEntry = await lstat(record.worktreePath)
  if (pathEntry.isSymbolicLink() || !pathEntry.isDirectory()) {
    throw new Error('worktree path is not a real directory')
  }
  await assertRealDirectory(record.worktreePath, 'managed worktree path')
  if ((await realpath(record.worktreePath)) !== resolve(record.worktreePath)) {
    throw new Error('worktree path is not canonical')
  }
  if (!registrations.has(resolve(record.worktreePath))) {
    throw new Error('worktree is not registered')
  }
  const [status, head, topLevel] = await Promise.all([
    git(record.worktreePath, ['status', '--porcelain']),
    git(record.worktreePath, ['rev-parse', 'HEAD']),
    git(record.worktreePath, ['rev-parse', '--show-toplevel']),
  ])
  const worktreeRoot = await realpath(resolve(record.worktreePath, topLevel))
  if (worktreeRoot !== resolve(record.worktreePath)) {
    throw new Error('registered worktree root does not match')
  }
  const root = await resolveProjectIdentity(record.worktreePath)
  if (root !== record.repositoryRoot) {
    throw new Error('repository identity does not match')
  }
  await readMarker(record.worktreePath, record)
  const branch = await gitOptional(record.worktreePath, [
    'symbolic-ref',
    '--quiet',
    '--short',
    'HEAD',
  ])
  if (record.branch === null) {
    if (branch) throw new Error('worktree is not detached')
  } else if (branch !== record.branch) {
    throw new Error('worktree branch does not match ownership record')
  }
  return { status, head }
}

function sameOwnership(
  left: ManagedWorktreeRecord,
  right: ManagedWorktreeRecord,
): boolean {
  return (
    left.worktreeId === right.worktreeId &&
    left.kind === right.kind &&
    left.policy === right.policy &&
    left.ownerId === right.ownerId &&
    left.repositoryRoot === right.repositoryRoot &&
    left.worktreePath === right.worktreePath &&
    left.branch === right.branch &&
    left.baseCommit === right.baseCommit &&
    left.createdAt === right.createdAt
  )
}

function nextRecord(
  record: ManagedWorktreeRecord,
  state: ManagedWorktreeRecord['state'],
  retentionReason?: string,
): ManagedWorktreeRecord {
  const base = { ...record }
  delete base.retentionReason
  return {
    ...base,
    state,
    updatedAt: new Date().toISOString(),
    ...(retentionReason === undefined ? {} : { retentionReason }),
  }
}

async function retain(
  store: ManagedWorktreeStore,
  record: ManagedWorktreeRecord,
  reason: string,
): Promise<ManagedWorktreeCleanup> {
  try {
    await store.update(nextRecord(record, 'retained', reason))
    return { retained: true, reason }
  } catch (error) {
    return {
      retained: true,
      reason: `${reason}; could not persist retention state: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

async function reconciliationRetain(
  store: ManagedWorktreeStore,
  record: ManagedWorktreeRecord,
  base: { recordPath: string; worktreeId: string },
  reason: string,
): Promise<ManagedWorktreeReconciliationEntry> {
  const result = await retain(store, record, reason)
  return {
    ...base,
    disposition: 'retained',
    reason: result.reason ?? reason,
  }
}

async function reconcileAgentLifecycle(
  stateRoot: string,
  record: ManagedWorktreeRecord,
): Promise<{ safe: true } | { safe: false; reason: string }> {
  const owner = parseAgentWorktreeOwner(record.ownerId)
  if (!owner) return { safe: false, reason: 'Agent owner ID is malformed' }
  try {
    const lifecycleStore = new SubagentLifecycleStore(
      stateRoot,
      owner.sessionId,
      owner.agentId,
    )
    const ownership = await lifecycleStore.reconcileOwnerLoss()
    if (ownership.owned)
      return { safe: false, reason: 'Agent lifecycle owner is live' }
    const lifecycle = await lifecycleStore.read()
    const classification = classifyAgentLifecycle(lifecycle, owner)
    return classification.status === 'safely-releasable'
      ? { safe: true }
      : { safe: false, reason: classification.reason }
  } catch (error) {
    return {
      safe: false,
      reason: `Agent lifecycle state is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

function classifyAgentLifecycle(
  lifecycle: Awaited<ReturnType<SubagentLifecycleStore['read']>>,
  owner: NonNullable<ReturnType<typeof parseAgentWorktreeOwner>>,
): {
  status: 'retained' | 'safely-releasable' | 'unsafe'
  reason: string
} {
  if (!lifecycle)
    return { status: 'unsafe', reason: 'Agent lifecycle state is missing' }
  const snapshot = lifecycle.lifecycle
  const matchingToken = isTerminalLifecycleState(snapshot.state)
    ? snapshot.previousOwnerToken === owner.executionToken
    : snapshot.owner?.token === owner.executionToken
  if (!matchingToken)
    return {
      status: 'unsafe',
      reason: 'Agent lifecycle owner token does not match worktree owner',
    }
  if (snapshot.state === 'failed' || snapshot.state === 'cancelled')
    return {
      status: 'retained',
      reason: `Agent lifecycle is ${snapshot.state}; evidence was retained`,
    }
  if (snapshot.state === 'orphaned')
    return {
      status: 'retained',
      reason: 'Agent lifecycle is orphaned; evidence was retained',
    }
  if (!isTerminalLifecycleState(snapshot.state))
    return {
      status: 'unsafe',
      reason: `Agent lifecycle remains ${snapshot.state}; owner state is unavailable`,
    }
  if (snapshot.state !== 'completed')
    return { status: 'unsafe', reason: `Agent lifecycle is ${snapshot.state}` }
  return {
    status: 'safely-releasable',
    reason: 'ownership and Git state are clean',
  }
}

async function inspectAgentLifecycle(
  stateRoot: string,
  record: ManagedWorktreeRecord,
): Promise<{
  status: 'retained' | 'safely-releasable' | 'unsafe'
  reason: string
}> {
  const owner = parseAgentWorktreeOwner(record.ownerId)
  if (!owner) return { status: 'unsafe', reason: 'Agent owner ID is malformed' }
  let lifecycle
  try {
    lifecycle = await new SubagentLifecycleStore(
      stateRoot,
      owner.sessionId,
      owner.agentId,
    ).read()
  } catch {
    return {
      status: 'unsafe',
      reason: 'Agent lifecycle state is unavailable',
    }
  }
  return classifyAgentLifecycle(lifecycle, owner)
}

function healthEntry(
  recordPath: string,
  record: ManagedWorktreeRecord,
  present: boolean | null,
  status: ManagedWorktreeHealthStatus,
  reason: string,
): ManagedWorktreeHealthEntry {
  return {
    recordPath,
    worktreeId: record.worktreeId,
    kind: record.kind,
    policy: record.policy,
    recordState: record.state,
    worktreePath: record.worktreePath,
    branch: record.branch,
    present,
    status,
    reason: boundedHealthReason(reason),
  }
}

const HEALTH_STABLE_REASONS = new Set([
  'managed worktree path must not be a symlink',
  'managed worktree path must be a directory',
  'worktree path is not a real directory',
  'worktree path is not canonical',
  'worktree is not registered',
  'registered worktree root does not match',
  'repository identity does not match',
  'worktree marker does not match ownership record',
  'worktree marker is invalid',
  'worktree is not detached',
  'worktree branch does not match ownership record',
])

function boundedHealthReason(reason: string): string {
  const codePoints = Array.from(reason)
  return codePoints.length <= 256 ? reason : codePoints.slice(0, 256).join('')
}

function healthErrorReason(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : ''
  return HEALTH_STABLE_REASONS.has(message) ? message : fallback
}

function validHealthOwner(record: ManagedWorktreeRecord): boolean {
  const parts = record.ownerId.split(':')
  if (record.kind === 'workflow')
    return (
      parts.length === 3 &&
      parts[0] === 'workflow' &&
      isWorkflowRunId(parts[1] ?? '') &&
      isWorkflowAgentId(parts[2] ?? '')
    )
  if (record.kind === 'agent')
    return parseAgentWorktreeOwner(record.ownerId) !== null
  if (parts.length !== 5 || parts[0] !== 'team') return false
  try {
    parseTeamId(parts[1])
  } catch {
    return false
  }
  return (
    /^[1-9]\d*$/u.test(parts[2] ?? '') &&
    Number.isSafeInteger(Number(parts[2])) &&
    Number(parts[2]) > 0 &&
    /^[a-f0-9]{24}$/u.test(parts[3] ?? '') &&
    /^[A-Za-z0-9_-]{1,128}$/u.test(parts[4] ?? '')
  )
}

async function preflightHealthPath(
  record: ManagedWorktreeRecord,
): Promise<boolean> {
  let entry
  try {
    entry = await lstat(record.worktreePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await assertRealDirectory(record.worktreePath, 'managed worktree path')
    return false
  }
  if (entry.isSymbolicLink() || !entry.isDirectory())
    throw new Error('worktree path is not a real directory')
  await assertRealDirectory(record.worktreePath, 'managed worktree path')
  if ((await realpath(record.worktreePath)) !== resolve(record.worktreePath))
    throw new Error('worktree path is not canonical')
  return true
}

function classifyCleanHealthRecord(
  record: ManagedWorktreeRecord,
  absent: boolean,
  agentLifecycle: Awaited<ReturnType<typeof inspectAgentLifecycle>> | null,
): { status: ManagedWorktreeHealthStatus; reason: string } {
  if (record.state === 'retained')
    return {
      status: 'retained',
      reason: record.retentionReason ?? 'record is retained',
    }
  if (record.policy === 'durable' || record.kind === 'team')
    return {
      status: 'retained',
      reason:
        record.policy === 'durable'
          ? 'durable retention policy'
          : 'team worktree is retained',
    }
  if (record.kind === 'agent')
    return (
      agentLifecycle ?? {
        status: 'unsafe' as const,
        reason: 'Agent lifecycle state is missing',
      }
    )
  return {
    status: 'safely-releasable',
    reason: absent
      ? 'checkout is absent and remaining ownership evidence is releasable'
      : 'ownership and Git state are clean',
  }
}

export async function inspectManagedWorktreeHealth(options: {
  cwd: string
  stateRoot: string
  limit?: number
}): Promise<ManagedWorktreeHealthReport> {
  const limit = options.limit ?? 64
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64)
    throw new Error(
      'Managed worktree health limit must be an integer from 1 to 64',
    )
  const repositoryRoot = await resolveProjectIdentity(options.cwd)
  const registryDirectory = resolve(
    options.stateRoot,
    'managed-worktrees',
    sanitizeProjectPath(repositoryRoot),
  )
  const stateRoot = resolve(options.stateRoot)
  const managedRoot = resolve(stateRoot, 'managed-worktrees')
  for (const [path, description] of [
    [stateRoot, 'managed worktree state root'],
    [managedRoot, 'managed worktree registry root'],
  ] as const) {
    try {
      const info = await lstat(path)
      if (info.isSymbolicLink())
        throw new Error(`${description} must not be a symlink`)
      if (!info.isDirectory())
        throw new Error(`${description} must be a directory`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  try {
    const info = await lstat(registryDirectory)
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new Error('managed worktree registry must be a real directory')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return {
      repositoryRoot,
      inspected: 0,
      truncated: false,
      counts: {
        active: 0,
        retained: 0,
        safelyReleasable: 0,
        released: 0,
        unsafe: 0,
      },
      entries: [],
    }
  }
  const snapshot = await inspectManagedWorktreeRegistry({
    stateRoot: options.stateRoot,
    repositoryRoot,
    limit,
  })
  const entries: ManagedWorktreeHealthEntry[] = []
  for (const item of snapshot.entries) {
    if ('error' in item) {
      entries.push({
        recordPath: item.path,
        worktreeId: null,
        kind: null,
        policy: null,
        recordState: null,
        worktreePath: null,
        branch: null,
        present: null,
        status: 'unsafe',
        reason: 'managed worktree record is invalid',
      })
      continue
    }
    const original = item.record
    if (!validHealthOwner(original)) {
      entries.push(
        healthEntry(
          item.path,
          original,
          null,
          'unsafe',
          `${original.kind[0]?.toUpperCase() ?? ''}${original.kind.slice(1)} owner ID is malformed`,
        ),
      )
      continue
    }
    let preflightPresent: boolean
    try {
      preflightPresent = await preflightHealthPath(original)
    } catch (error) {
      entries.push(
        healthEntry(
          item.path,
          original,
          true,
          'unsafe',
          healthErrorReason(
            error,
            'worktree path could not be inspected safely',
          ),
        ),
      )
      continue
    }
    const base = new ManagedWorktreeStore(
      options.stateRoot,
      repositoryRoot,
      original.worktreeId,
    )
    const lease = await base.acquireLease()
    if (!lease) {
      const unavailableStatus: ManagedWorktreeHealthStatus =
        original.state === 'released'
          ? 'unsafe'
          : ['creating', 'active', 'releasing'].includes(original.state)
            ? 'active'
            : 'retained'
      entries.push(
        healthEntry(
          item.path,
          original,
          preflightPresent,
          unavailableStatus,
          original.state === 'released'
            ? 'released record has a live or unavailable lease'
            : unavailableStatus === 'active'
              ? 'worktree lease is live or unavailable'
              : (original.retentionReason ?? 'record is retained'),
        ),
      )
      continue
    }
    try {
      let record: ManagedWorktreeRecord
      try {
        record = await base.read()
      } catch {
        entries.push(
          healthEntry(
            item.path,
            original,
            null,
            'unsafe',
            'managed worktree record could not be reread safely',
          ),
        )
        continue
      }
      if (!sameOwnership(record, original)) {
        entries.push(
          healthEntry(
            item.path,
            record,
            null,
            'unsafe',
            'ownership record changed during inspection',
          ),
        )
        continue
      }
      const registered = await registeredWorktrees(record.repositoryRoot).catch(
        () => null,
      )
      if (!registered) {
        entries.push(
          healthEntry(
            item.path,
            record,
            null,
            'unsafe',
            'could not inspect registered worktrees',
          ),
        )
        continue
      }
      let present = false
      try {
        const info = await lstat(record.worktreePath)
        present = true
        if (info.isSymbolicLink() || !info.isDirectory())
          throw new Error('worktree path is not a real directory')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          entries.push(
            healthEntry(
              item.path,
              record,
              true,
              'unsafe',
              healthErrorReason(
                error,
                'worktree ownership and Git state could not be validated',
              ),
            ),
          )
          continue
        }
      }
      const registeredPath = registered.has(resolve(record.worktreePath))
      if (record.state === 'released') {
        let branchEvidence: 'absent' | 'match' | 'ambiguous' = 'absent'
        if (record.branch !== null)
          branchEvidence = await ownedBranchRef(
            record.repositoryRoot,
            record.branch,
            record.baseCommit,
          )
        if (present || registeredPath || branchEvidence !== 'absent') {
          entries.push(
            healthEntry(
              item.path,
              record,
              present,
              'unsafe',
              'released record has contradictory checkout or branch evidence',
            ),
          )
        } else {
          entries.push(
            healthEntry(
              item.path,
              record,
              false,
              'released',
              'record is released',
            ),
          )
        }
        continue
      }
      if (!present) {
        if (registeredPath) {
          entries.push(
            healthEntry(
              item.path,
              record,
              false,
              'unsafe',
              'worktree is missing but remains registered',
            ),
          )
          continue
        }
        if (record.branch !== null) {
          const branchEvidence = await ownedBranchRef(
            record.repositoryRoot,
            record.branch,
            record.baseCommit,
          )
          if (branchEvidence === 'ambiguous') {
            entries.push(
              healthEntry(
                item.path,
                record,
                false,
                'unsafe',
                'owned branch is missing or moved',
              ),
            )
            continue
          }
        }
        const agentLifecycle =
          record.kind === 'agent'
            ? await inspectAgentLifecycle(options.stateRoot, record)
            : null
        if (agentLifecycle?.status === 'unsafe') {
          entries.push(
            healthEntry(
              item.path,
              record,
              false,
              'unsafe',
              agentLifecycle.reason,
            ),
          )
          continue
        }
        const clean = classifyCleanHealthRecord(record, true, agentLifecycle)
        entries.push(
          healthEntry(item.path, record, false, clean.status, clean.reason),
        )
        continue
      }
      let inspection: { status: string; head: string }
      try {
        inspection = await inspectOwnedCheckout(record, registered)
      } catch (error) {
        entries.push(
          healthEntry(
            item.path,
            record,
            true,
            'unsafe',
            healthErrorReason(
              error,
              'worktree ownership and Git state could not be validated',
            ),
          ),
        )
        continue
      }
      const agentLifecycle =
        record.kind === 'agent'
          ? await inspectAgentLifecycle(options.stateRoot, record)
          : null
      if (agentLifecycle?.status === 'unsafe') {
        entries.push(
          healthEntry(item.path, record, true, 'unsafe', agentLifecycle.reason),
        )
        continue
      }
      if (agentLifecycle?.status === 'retained') {
        entries.push(
          healthEntry(
            item.path,
            record,
            true,
            'retained',
            agentLifecycle.reason,
          ),
        )
        continue
      }
      if (inspection.status) {
        entries.push(
          healthEntry(
            item.path,
            record,
            true,
            'retained',
            'worktree has uncommitted changes',
          ),
        )
        continue
      }
      if (inspection.head !== record.baseCommit) {
        entries.push(
          healthEntry(
            item.path,
            record,
            true,
            'retained',
            'worktree HEAD does not match base commit',
          ),
        )
        continue
      }
      const clean = classifyCleanHealthRecord(record, false, agentLifecycle)
      entries.push(
        healthEntry(item.path, record, true, clean.status, clean.reason),
      )
    } finally {
      await lease.release()
    }
  }
  const counts = {
    active: entries.filter((entry) => entry.status === 'active').length,
    retained: entries.filter((entry) => entry.status === 'retained').length,
    safelyReleasable: entries.filter(
      (entry) => entry.status === 'safely-releasable',
    ).length,
    released: entries.filter((entry) => entry.status === 'released').length,
    unsafe: entries.filter((entry) => entry.status === 'unsafe').length,
  }
  return {
    repositoryRoot,
    inspected: snapshot.entries.length,
    truncated: snapshot.truncated,
    counts,
    entries,
  }
}

export async function reconcileManagedWorktrees(options: {
  cwd: string
  stateRoot: string
  hooks?: ManagedWorktreeHooks
}): Promise<ManagedWorktreeReconciliationResult> {
  const repositoryRoot = await resolveProjectIdentity(options.cwd)
  const snapshot = await inspectManagedWorktreeRegistry({
    stateRoot: options.stateRoot,
    repositoryRoot,
    limit: 64,
  })
  const entries: ManagedWorktreeReconciliationEntry[] = []
  for (const item of snapshot.entries) {
    if ('error' in item) {
      entries.push({
        recordPath: item.path,
        disposition: 'invalid',
        reason: item.error,
      })
      continue
    }
    const original = item.record
    const baseEntry = { recordPath: item.path, worktreeId: original.worktreeId }
    const store = new ManagedWorktreeStore(
      options.stateRoot,
      repositoryRoot,
      original.worktreeId,
    )
    const lease = await store.acquireLease()
    if (!lease) {
      entries.push({
        ...baseEntry,
        disposition: 'skipped',
        reason: 'worktree lease is live or unavailable',
      })
      continue
    }
    try {
      let record: ManagedWorktreeRecord
      try {
        record = await store.read()
      } catch (error) {
        entries.push({
          ...baseEntry,
          disposition: 'invalid',
          reason: `record could not be reread: ${error instanceof Error ? error.message : String(error)}`,
        })
        continue
      }
      if (!sameOwnership(record, original)) {
        entries.push({
          ...baseEntry,
          disposition: 'retained',
          reason: 'ownership record changed during reconciliation',
        })
        continue
      }
      if (record.state === 'released') {
        entries.push({
          ...baseEntry,
          disposition: 'skipped',
          reason: 'already released',
        })
        continue
      }
      if (record.state === 'retained') {
        entries.push({
          ...baseEntry,
          disposition: 'retained',
          reason: record.retentionReason ?? 'record is retained',
        })
        continue
      }
      if (record.policy === 'durable' || record.kind === 'team') {
        entries.push(
          await reconciliationRetain(
            store,
            record,
            baseEntry,
            record.policy === 'durable'
              ? 'durable retention policy'
              : 'team worktree is retained',
          ),
        )
        continue
      }
      if (
        !['workflow', 'agent'].includes(record.kind) ||
        !record.ownerId.startsWith(`${record.kind}:`) ||
        !['creating', 'active', 'releasing'].includes(record.state)
      ) {
        entries.push(
          await reconciliationRetain(
            store,
            record,
            baseEntry,
            'record is not an interrupted ephemeral owner',
          ),
        )
        continue
      }
      if (record.kind === 'agent') {
        const lifecycle = await reconcileAgentLifecycle(
          options.stateRoot,
          record,
        )
        if (!lifecycle.safe) {
          entries.push(
            await reconciliationRetain(
              store,
              record,
              baseEntry,
              lifecycle.reason,
            ),
          )
          continue
        }
      }
      const releasing =
        record.state === 'creating' ? record : nextRecord(record, 'releasing')
      if (record.state !== 'creating') {
        try {
          await store.update(releasing)
        } catch (error) {
          entries.push({
            ...baseEntry,
            disposition: 'retained',
            reason: `could not mark releasing: ${error instanceof Error ? error.message : String(error)}`,
          })
          continue
        }
      }
      const registered = await registeredWorktrees(repositoryRoot).catch(
        () => null,
      )
      if (!registered) {
        entries.push(
          await reconciliationRetain(
            store,
            releasing,
            baseEntry,
            'could not inspect registered worktrees',
          ),
        )
        continue
      }
      let exists = false
      try {
        const info = await lstat(record.worktreePath)
        exists = true
        if (info.isSymbolicLink()) throw new Error('worktree path is a symlink')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          entries.push(
            await reconciliationRetain(
              store,
              releasing,
              baseEntry,
              (error as Error).message,
            ),
          )
          continue
        }
      }
      if (!exists) {
        if (registered.has(resolve(record.worktreePath))) {
          entries.push(
            await reconciliationRetain(
              store,
              releasing,
              baseEntry,
              'worktree is missing but remains registered',
            ),
          )
          continue
        }
        if (record.branch !== null) {
          const ref = await ownedBranchRef(
            repositoryRoot,
            record.branch,
            record.baseCommit,
          )
          if (ref === 'ambiguous') {
            entries.push(
              await reconciliationRetain(
                store,
                releasing,
                baseEntry,
                'owned branch is missing or moved',
              ),
            )
            continue
          }
          try {
            if (ref === 'match')
              await removeOwnedBranch(
                repositoryRoot,
                record.branch,
                record.baseCommit,
              )
          } catch (error) {
            entries.push(
              await reconciliationRetain(
                store,
                releasing,
                baseEntry,
                `could not remove owned branch: ${(error as Error).message}`,
              ),
            )
            continue
          }
        }
        try {
          await store.update(nextRecord(releasing, 'released'))
        } catch (error) {
          entries.push({
            ...baseEntry,
            disposition: 'released',
            reason: `released; state finalization warning: ${(error as Error).message}`,
          })
          continue
        }
        entries.push({
          ...baseEntry,
          disposition: 'released',
          reason: 'checkout already absent',
        })
        continue
      }
      let inspection: { status: string; head: string }
      try {
        inspection = await inspectOwnedCheckout(record, registered)
      } catch (error) {
        entries.push(
          await reconciliationRetain(
            store,
            releasing,
            baseEntry,
            (error as Error).message,
          ),
        )
        continue
      }
      if (inspection.status || inspection.head !== record.baseCommit) {
        const reason = inspection.status
          ? 'worktree has uncommitted changes'
          : 'worktree HEAD does not match base commit'
        entries.push(
          await reconciliationRetain(store, releasing, baseEntry, reason),
        )
        continue
      }
      if (options.hooks) {
        try {
          const outcome = await options.hooks.beforeRemove({
            worktreePath: record.worktreePath,
            worktreeKind: record.kind,
            worktreeId: record.worktreeId,
            ownerId: record.ownerId,
            baseCommit: record.baseCommit,
            reason: 'reconcile',
          })
          if (outcome.blockedReason)
            throw new Error(`hook blocked: ${outcome.blockedReason}`)
        } catch (error) {
          const reason = `WorktreeRemove hook failed: ${error instanceof Error ? error.message : String(error)}`
          entries.push(
            await reconciliationRetain(store, releasing, baseEntry, reason),
          )
          continue
        }
        try {
          const post = await inspectOwnedCheckout(record)
          if (post.status || post.head !== record.baseCommit)
            throw new Error('hook left worktree unsafe')
        } catch (error) {
          const reason = (error as Error).message
          entries.push(
            await reconciliationRetain(store, releasing, baseEntry, reason),
          )
          continue
        }
      }
      try {
        if (
          record.branch !== null &&
          (await ownedBranchRef(
            repositoryRoot,
            record.branch,
            record.baseCommit,
          )) === 'ambiguous'
        )
          throw new Error('owned branch moved')
        await git(repositoryRoot, ['worktree', 'remove', record.worktreePath])
      } catch (error) {
        const reason = (error as Error).message
        entries.push(
          await reconciliationRetain(store, releasing, baseEntry, reason),
        )
        continue
      }
      try {
        if (record.branch !== null)
          await removeOwnedBranch(
            repositoryRoot,
            record.branch,
            record.baseCommit,
          )
      } catch (error) {
        const reason = `checkout removed but owned branch was preserved: ${(error as Error).message}`
        entries.push(
          await reconciliationRetain(store, releasing, baseEntry, reason),
        )
        continue
      }
      try {
        await store.update(nextRecord(releasing, 'released'))
        entries.push({
          ...baseEntry,
          disposition: 'released',
          reason: 'reconciled abandoned worktree',
        })
      } catch (error) {
        entries.push({
          ...baseEntry,
          disposition: 'released',
          reason: `released; state finalization warning: ${(error as Error).message}`,
        })
      }
    } finally {
      await lease.release()
    }
  }
  return {
    repositoryRoot,
    inspected: snapshot.entries.length,
    truncated: snapshot.truncated,
    entries,
  }
}

export async function createOwnedManagedWorktree(
  options: OwnedManagedWorktreeOptions,
): Promise<ManagedWorktree> {
  if (
    options.parentDirectoryName !== undefined &&
    !COMPONENT_PATTERN.test(options.parentDirectoryName)
  ) {
    throw worktreeError(options, 'parent name is invalid')
  }
  if (!COMPONENT_PATTERN.test(options.directoryName)) {
    throw worktreeError(options, 'name is invalid')
  }
  if (!validOwnerId(options.ownerId)) {
    throw worktreeError(options, 'owner ID is invalid')
  }
  if (!['workflow', 'agent', 'team'].includes(options.kind)) {
    throw worktreeError(options, 'kind is invalid')
  }
  let repositoryRoot: string
  let baseCommit: string
  try {
    ;[repositoryRoot, baseCommit] = await Promise.all([
      resolveProjectIdentity(options.cwd),
      git(options.cwd, ['rev-parse', 'HEAD']),
    ])
  } catch {
    throw worktreeError(options, 'isolation requires a Git repository')
  }
  if (options.branch !== undefined) {
    try {
      const checked = await git(repositoryRoot, [
        'check-ref-format',
        '--branch',
        options.branch,
      ])
      if (checked !== options.branch) throw new Error('branch was normalized')
    } catch {
      throw worktreeError(options, 'branch name is invalid')
    }
  }
  const reconciliationKey = repositoryRoot
  let reconciliation = reconciliationCache.get(reconciliationKey)
  if (!reconciliation) {
    reconciliation = reconcileManagedWorktrees({
      cwd: repositoryRoot,
      stateRoot: options.stateRoot,
      ...(options.hooks ? { hooks: options.hooks } : {}),
    })
    reconciliationCache.set(reconciliationKey, reconciliation)
  }
  await reconciliation
  const kindRoot = join(repositoryRoot, '.praxis', 'worktrees', options.kind)
  const worktreeParent = options.parentDirectoryName
    ? join(kindRoot, options.parentDirectoryName)
    : kindRoot
  const worktreePath = join(worktreeParent, options.directoryName)
  const rootRelative = relative(kindRoot, worktreePath)
  if (
    !rootRelative ||
    rootRelative === '..' ||
    rootRelative.startsWith(`..${sep}`) ||
    isAbsolute(rootRelative)
  ) {
    throw worktreeError(options, 'path escapes its kind root')
  }
  await assertRealDirectory(
    join(repositoryRoot, '.praxis'),
    'managed worktree parent',
  )
  await assertRealDirectory(
    join(repositoryRoot, '.praxis', 'worktrees'),
    'managed worktree parent',
  )
  await assertRealDirectory(kindRoot, 'managed worktree kind root')
  if (options.parentDirectoryName)
    await assertRealDirectory(worktreeParent, 'managed worktree parent')
  await ensureManagedRootIgnored(repositoryRoot)
  const worktreeId = managedWorktreeId(
    repositoryRoot,
    options.kind,
    options.ownerId,
  )
  const store = new ManagedWorktreeStore(
    options.stateRoot,
    repositoryRoot,
    worktreeId,
  )
  const lease = await store.acquireLease()
  if (!lease) throw worktreeError(options, `is already owned: ${worktreePath}`)
  const now = new Date().toISOString()
  const record: ManagedWorktreeRecord = {
    version: 1,
    worktreeId,
    kind: options.kind,
    policy: options.policy,
    ownerId: options.ownerId,
    repositoryRoot,
    worktreePath,
    branch: options.branch ?? null,
    baseCommit,
    state: 'creating',
    createdAt: now,
    updatedAt: now,
  }
  let recordCreated = false
  let gitCreated = false
  let markerCreated = false
  let branchBeforeAttempt: string | null | undefined
  let created = false
  try {
    await store.create(record)
    recordCreated = true
    try {
      const entry = await lstat(worktreePath)
      if (entry.isSymbolicLink()) {
        throw worktreeError(options, 'path must not be a symlink')
      }
      throw worktreeError(options, `path already exists: ${worktreePath}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await mkdir(worktreeParent, { recursive: true })
    await assertRealDirectory(worktreeParent, 'managed worktree parent')
    if (options.branch !== undefined) {
      branchBeforeAttempt = await gitOptional(repositoryRoot, [
        'rev-parse',
        '--verify',
        '--quiet',
        `refs/heads/${options.branch}`,
      ])
    }
    await git(
      repositoryRoot,
      options.branch === undefined
        ? ['worktree', 'add', '--detach', worktreePath, baseCommit]
        : ['worktree', 'add', '-b', options.branch, worktreePath, baseCommit],
    )
    gitCreated = true
    await writeMarker(worktreePath, record)
    markerCreated = true
    if (options.hooks) {
      let outcome: ManagedWorktreeHookOutcome
      try {
        outcome = await options.hooks.afterCreate({
          worktreePath,
          worktreeKind: record.kind,
          worktreeId: record.worktreeId,
          ownerId: record.ownerId,
          baseCommit: record.baseCommit,
        })
      } catch (error) {
        throw new Error(
          `WorktreeCreate hook failed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        )
      }
      if (outcome.blockedReason) {
        throw new Error(`WorktreeCreate hook blocked: ${outcome.blockedReason}`)
      }
    }
    await store.update(nextRecord(record, 'active'))
    created = true
  } catch (error) {
    let rollbackError: Error | undefined
    let uncertainArtifact = false
    if (gitCreated) {
      try {
        if (!markerCreated) {
          throw new Error('ownership marker was not published')
        }
        const inspection = await inspectOwnedCheckout(record)
        if (inspection.status.length > 0) {
          throw new Error('created worktree is no longer clean')
        }
        if (inspection.head !== record.baseCommit) {
          throw new Error('created worktree HEAD no longer matches its base')
        }
        await git(repositoryRoot, ['worktree', 'remove', worktreePath])
        if (record.branch !== null) {
          await removeOwnedBranch(
            repositoryRoot,
            record.branch,
            record.baseCommit,
          )
        }
      } catch (removeError) {
        rollbackError = removeError as Error
      }
    } else {
      try {
        const registered = await registeredWorktrees(repositoryRoot)
        const pathExists = await lstat(worktreePath)
          .then(() => true)
          .catch((pathError: unknown) => {
            if ((pathError as NodeJS.ErrnoException).code === 'ENOENT') {
              return false
            }
            throw pathError
          })
        uncertainArtifact = pathExists || registered.has(resolve(worktreePath))
        if (record.branch !== null) {
          const branchAfterAttempt = await gitOptional(repositoryRoot, [
            'rev-parse',
            '--verify',
            '--quiet',
            `refs/heads/${record.branch}`,
          ])
          if (
            branchBeforeAttempt === undefined ||
            (branchBeforeAttempt === null
              ? branchAfterAttempt !== null
              : branchAfterAttempt !== branchBeforeAttempt)
          ) {
            uncertainArtifact = true
          }
        }
      } catch {
        uncertainArtifact = true
      }
    }
    if (recordCreated) {
      try {
        const retentionReason = rollbackError
          ? `Could not roll back ${worktreePath}: ${rollbackError.message}`
          : uncertainArtifact
            ? `Creation failed with an unverified artifact at ${worktreePath}`
            : undefined
        const failed = retentionReason
          ? nextRecord(record, 'retained', retentionReason)
          : nextRecord(record, 'released')
        await store.update(failed)
      } catch (stateError) {
        rollbackError ??= stateError as Error
      }
    }
    const primary = error instanceof Error ? error.message : String(error)
    throw worktreeError(
      options,
      `could not be created: ${primary}${rollbackError ? `; cleanup warning: ${rollbackError.message}` : ''}`,
    )
  } finally {
    if (!created) await lease.release()
  }
  return createManagedWorktreeHandle(store, options, record, lease)
}

async function settleOwnedManagedWorktree(
  store: ManagedWorktreeStore,
  options: Pick<
    OwnedManagedWorktreeOptions,
    'label' | 'kind' | 'policy' | 'hooks'
  >,
  original: ManagedWorktreeRecord,
  mode: 'cleanup' | 'release',
  heldLease?: ExclusiveFileLeaseHandle,
): Promise<ManagedWorktreeCleanup> {
  const lease = heldLease ?? (await store.acquireLease())
  if (!lease)
    return {
      retained: true,
      reason: `${options.label} worktree ${mode === 'release' ? 'release' : 'cleanup'} is already in progress`,
    }
  try {
    let record: ManagedWorktreeRecord
    try {
      record = await store.read()
    } catch (error) {
      return {
        retained: true,
        reason: `Could not inspect ${options.label.toLowerCase()} worktree record: ${(error as Error).message}`,
      }
    }
    if (!sameOwnership(record, original)) {
      return {
        retained: true,
        reason: `${options.label} worktree ownership record does not match`,
      }
    }
    if (record.state === 'released') return { retained: false }
    if (
      record.state !== 'active' &&
      record.state !== 'retained' &&
      record.state !== 'releasing'
    ) {
      return {
        retained: true,
        reason: `${options.label} worktree is not releasable`,
      }
    }
    const explicitDurableRelease =
      mode === 'release' && record.policy === 'durable'
    if (mode === 'cleanup' && record.policy === 'durable') {
      return retain(
        store,
        record,
        `${options.label} worktree uses durable retention policy`,
      )
    }
    const releasing = nextRecord(record, 'releasing')
    try {
      await store.update(releasing)
    } catch (error) {
      return {
        retained: true,
        reason: `Could not update ${options.label.toLowerCase()} worktree record: ${(error as Error).message}`,
      }
    }
    const registered = await registeredWorktrees(record.repositoryRoot).catch(
      () => null,
    )
    if (!registered) {
      return retain(
        store,
        releasing,
        `Could not inspect registered ${options.label.toLowerCase()} worktrees`,
      )
    }
    try {
      await lstat(record.worktreePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        return retain(
          store,
          releasing,
          `Could not inspect ${options.label.toLowerCase()} worktree path: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      if (registered.has(resolve(record.worktreePath))) {
        return retain(
          store,
          releasing,
          `${options.label} worktree is missing but remains registered at ${record.worktreePath}`,
        )
      }
      if (record.branch !== null) {
        const ref = await ownedBranchRef(
          record.repositoryRoot,
          record.branch,
          record.baseCommit,
        )
        if (ref === 'ambiguous')
          return retain(
            store,
            releasing,
            `${options.label} worktree owned branch moved or is ambiguous`,
          )
        try {
          if (ref === 'match')
            await removeOwnedBranch(
              record.repositoryRoot,
              record.branch,
              record.baseCommit,
            )
        } catch (error) {
          return retain(
            store,
            releasing,
            `${options.label} worktree owned branch could not be removed: ${(error as Error).message}`,
          )
        }
      }
      try {
        await store.update(nextRecord(releasing, 'released'))
        return { retained: false }
      } catch (stateError) {
        return {
          retained: false,
          reason: `${options.label} worktree is already absent but release state could not be persisted: ${stateError instanceof Error ? stateError.message : String(stateError)}`,
        }
      }
    }
    let inspection: { status: string; head: string }
    try {
      inspection = await inspectOwnedCheckout(record, registered)
    } catch (error) {
      const reason = `Could not verify ${options.label.toLowerCase()} worktree ${record.worktreePath}: ${(error as Error).message}`
      return retain(store, releasing, reason)
    }
    if (!explicitDurableRelease && inspection.status.length > 0) {
      const reason = `${options.label} worktree has uncommitted changes and was retained at ${record.worktreePath}`
      return retain(store, releasing, reason)
    }
    if (!explicitDurableRelease && inspection.head !== record.baseCommit) {
      const reason = `${options.label} worktree has commits and was retained at ${record.worktreePath}`
      return retain(store, releasing, reason)
    }
    if (options.hooks) {
      let outcome: ManagedWorktreeHookOutcome
      try {
        outcome = await options.hooks.beforeRemove({
          worktreePath: record.worktreePath,
          worktreeKind: record.kind,
          worktreeId: record.worktreeId,
          ownerId: record.ownerId,
          baseCommit: record.baseCommit,
          reason: 'normal',
        })
      } catch (error) {
        return retain(
          store,
          releasing,
          `WorktreeRemove hook failed for ${record.worktreePath}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      if (outcome.blockedReason) {
        return retain(
          store,
          releasing,
          `WorktreeRemove hook blocked for ${record.worktreePath}: ${outcome.blockedReason}`,
        )
      }
      try {
        const postHookRegistered = await registeredWorktrees(
          record.repositoryRoot,
        )
        const postHookInspection = await inspectOwnedCheckout(
          record,
          postHookRegistered,
        )
        inspection = postHookInspection
        if (!explicitDurableRelease && postHookInspection.status.length > 0) {
          return retain(
            store,
            releasing,
            `WorktreeRemove hook left uncommitted changes in ${record.worktreePath}; worktree was retained at ${record.worktreePath}`,
          )
        }
        if (
          !explicitDurableRelease &&
          postHookInspection.head !== record.baseCommit
        ) {
          return retain(
            store,
            releasing,
            `WorktreeRemove hook created commits in ${record.worktreePath}; worktree was retained at ${record.worktreePath}`,
          )
        }
      } catch (error) {
        return retain(
          store,
          releasing,
          `WorktreeRemove hook left worktree unsafe at ${record.worktreePath}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    try {
      if (
        record.branch !== null &&
        (await ownedBranchRef(
          record.repositoryRoot,
          record.branch,
          explicitDurableRelease ? inspection.head : record.baseCommit,
        )) === 'ambiguous'
      ) {
        return retain(
          store,
          releasing,
          `${options.label} worktree owned branch moved or is ambiguous`,
        )
      }
      await git(
        record.repositoryRoot,
        explicitDurableRelease
          ? ['worktree', 'remove', '--force', record.worktreePath]
          : ['worktree', 'remove', record.worktreePath],
      )
    } catch (error) {
      const reason = `Could not remove ${options.label.toLowerCase()} worktree ${record.worktreePath}: ${(error as Error).message}`
      return retain(store, releasing, reason)
    }
    if (record.branch !== null) {
      try {
        await removeOwnedBranch(
          record.repositoryRoot,
          record.branch,
          explicitDurableRelease ? inspection.head : record.baseCommit,
        )
      } catch (error) {
        let stateWarning = ''
        try {
          await store.update(nextRecord(releasing, 'released'))
        } catch (stateError) {
          stateWarning = `; could not finalize release state: ${stateError instanceof Error ? stateError.message : String(stateError)}`
        }
        return {
          retained: false,
          reason: `checkout removed but owned branch was preserved: ${(error as Error).message}${stateWarning}`,
        }
      }
    }
    try {
      await store.update(nextRecord(releasing, 'released'))
    } catch (error) {
      return {
        retained: false,
        reason: `Could not update ${options.label.toLowerCase()} worktree record after removal: ${(error as Error).message}`,
      }
    }
    return { retained: false }
  } finally {
    await lease.release()
  }
}

async function cleanupOwnedManagedWorktree(
  store: ManagedWorktreeStore,
  options: Pick<
    OwnedManagedWorktreeOptions,
    'label' | 'kind' | 'policy' | 'hooks'
  >,
  original: ManagedWorktreeRecord,
  heldLease?: ExclusiveFileLeaseHandle,
): Promise<ManagedWorktreeCleanup> {
  return settleOwnedManagedWorktree(
    store,
    options,
    original,
    'cleanup',
    heldLease,
  )
}

async function releaseOwnedManagedWorktree(
  store: ManagedWorktreeStore,
  options: Pick<
    OwnedManagedWorktreeOptions,
    'label' | 'kind' | 'policy' | 'hooks'
  >,
  original: ManagedWorktreeRecord,
  heldLease?: ExclusiveFileLeaseHandle,
): Promise<ManagedWorktreeCleanup> {
  return settleOwnedManagedWorktree(
    store,
    options,
    original,
    'release',
    heldLease,
  )
}

async function retainOwnedManagedWorktree(
  store: ManagedWorktreeStore,
  options: Pick<OwnedManagedWorktreeOptions, 'label'>,
  original: ManagedWorktreeRecord,
  reason: string,
  heldLease?: ExclusiveFileLeaseHandle,
): Promise<ManagedWorktreeCleanup> {
  assertRetentionReason(reason)
  const lease = heldLease ?? (await store.acquireLease())
  if (!lease)
    return {
      retained: true,
      reason: `${options.label} worktree retention is already in progress`,
    }
  try {
    let record: ManagedWorktreeRecord
    try {
      record = await store.read()
    } catch (error) {
      return {
        retained: true,
        reason: `Could not inspect ${options.label.toLowerCase()} worktree record: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
    if (!sameOwnership(record, original))
      return {
        retained: true,
        reason: `${options.label} worktree ownership record does not match`,
      }
    if (record.state === 'released') return { retained: false }
    try {
      await store.update(nextRecord(record, 'retained', reason))
    } catch (error) {
      return {
        retained: true,
        reason: `${reason}; could not persist retention state: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
    return { retained: true, reason }
  } finally {
    await lease.release()
  }
}

function createManagedWorktreeSettlement(
  initialLease?: ExclusiveFileLeaseHandle,
): (
  operation: (
    heldLease: ExclusiveFileLeaseHandle | undefined,
  ) => Promise<ManagedWorktreeCleanup>,
) => Promise<ManagedWorktreeCleanup> {
  let executionLease = initialLease
  let removedResult: ManagedWorktreeCleanup | undefined
  let operationInFlight: Promise<ManagedWorktreeCleanup> | undefined
  return (operation) => {
    if (removedResult) return Promise.resolve(removedResult)
    if (operationInFlight) return operationInFlight
    const heldLease = executionLease
    executionLease = undefined
    operationInFlight = operation(heldLease)
    return operationInFlight
      .then((result) => {
        if (!result.retained) removedResult = result
        return result
      })
      .finally(() => {
        operationInFlight = undefined
      })
  }
}

function createManagedWorktreeHandle(
  store: ManagedWorktreeStore,
  options: Pick<
    OwnedManagedWorktreeOptions,
    'label' | 'kind' | 'policy' | 'hooks'
  >,
  record: ManagedWorktreeRecord,
  lease: ExclusiveFileLeaseHandle,
): ManagedWorktree {
  const settle = createManagedWorktreeSettlement(lease)
  return {
    cwd: record.worktreePath,
    cleanup: () =>
      settle((heldLease) =>
        cleanupOwnedManagedWorktree(store, options, record, heldLease),
      ),
    retain: async (reason) => {
      assertRetentionReason(reason)
      return settle((heldLease) =>
        retainOwnedManagedWorktree(store, options, record, reason, heldLease),
      )
    },
    release: () =>
      settle((heldLease) =>
        releaseOwnedManagedWorktree(store, options, record, heldLease),
      ),
  }
}

export interface OwnedManagedWorktreeRestoreOptions {
  cwd: string
  stateRoot: string
  path: string
  parentDirectoryName?: string
  directoryName: string
  ownerPrefix: string
  ownerId?: string
  branch?: string
  label: 'Agent' | 'Workflow' | 'Team'
  kind: 'workflow' | 'agent' | 'team'
  policy: 'ephemeral' | 'durable'
  hooks?: ManagedWorktreeHooks
}

/** Restore a checkout only when its complete managed ownership proof matches. */
export async function restoreOwnedManagedWorktree(
  options: OwnedManagedWorktreeRestoreOptions,
): Promise<ManagedWorktree> {
  if (
    options.parentDirectoryName !== undefined &&
    !COMPONENT_PATTERN.test(options.parentDirectoryName)
  ) {
    throw worktreeError(options, 'parent name is invalid')
  }
  if (!COMPONENT_PATTERN.test(options.directoryName)) {
    throw worktreeError(options, 'name is invalid')
  }
  if (
    !options.path ||
    !isAbsolute(options.path) ||
    options.path.includes('\0')
  ) {
    throw worktreeError(options, 'path is invalid')
  }
  if (!options.ownerPrefix || !validOwnerId(options.ownerPrefix)) {
    throw worktreeError(options, 'owner prefix is invalid')
  }
  if (options.ownerId !== undefined && !validOwnerId(options.ownerId)) {
    throw worktreeError(options, 'owner ID is invalid')
  }
  let repositoryRoot: string
  try {
    repositoryRoot = await resolveProjectIdentity(options.cwd)
  } catch {
    throw worktreeError(options, 'restore requires a Git repository')
  }
  if (options.branch !== undefined) {
    try {
      const checked = await git(repositoryRoot, [
        'check-ref-format',
        '--branch',
        options.branch,
      ])
      if (checked !== options.branch) throw new Error('branch was normalized')
    } catch {
      throw worktreeError(options, 'branch name is invalid')
    }
  }
  const kindRoot = join(repositoryRoot, '.praxis', 'worktrees', options.kind)
  const expectedParent = options.parentDirectoryName
    ? join(kindRoot, options.parentDirectoryName)
    : kindRoot
  const expectedPath = join(expectedParent, options.directoryName)
  const path = resolve(options.path)
  if (path !== expectedPath) {
    throw worktreeError(options, 'path does not match its managed checkout')
  }
  try {
    const entry = await lstat(path)
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error('worktree path is not a real directory')
    }
    if ((await realpath(path)) !== path) {
      throw new Error('worktree path is not canonical')
    }
  } catch (error) {
    throw worktreeError(
      options,
      `could not inspect checkout: ${(error as Error).message}`,
    )
  }
  const marker = await readMarkerIdentity(path)
  if (marker.repositoryRoot !== repositoryRoot) {
    throw worktreeError(options, 'marker repository identity does not match')
  }
  const store = new ManagedWorktreeStore(
    options.stateRoot,
    repositoryRoot,
    marker.worktreeId,
  )
  const lease = await store.acquireLease()
  if (!lease) throw worktreeError(options, 'restore is already owned')
  let accepted = false
  try {
    const record = await store.read()
    if (
      record.repositoryRoot !== repositoryRoot ||
      record.worktreeId !== marker.worktreeId ||
      record.worktreePath !== expectedPath ||
      record.kind !== options.kind ||
      record.policy !== options.policy ||
      !['active', 'retained', 'releasing'].includes(record.state) ||
      !record.ownerId.startsWith(options.ownerPrefix) ||
      (options.ownerId !== undefined && record.ownerId !== options.ownerId) ||
      (options.branch !== undefined && record.branch !== options.branch)
    ) {
      throw worktreeError(options, 'ownership evidence does not match')
    }
    await inspectOwnedCheckout(record)
    accepted = true
    return createManagedWorktreeHandle(store, options, record, lease)
  } finally {
    if (!accepted) await lease.release()
  }
}

export async function createManagedWorktree(options: {
  cwd: string
  parentDirectory: string
  directoryName: string
  label: 'Agent' | 'Workflow'
}): Promise<ManagedWorktree> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/u.test(options.directoryName)) {
    throw new Error(`Invalid ${options.label.toLowerCase()} worktree name`)
  }
  let root: string
  let initialHead: string
  try {
    ;[root, initialHead] = await Promise.all([
      git(options.cwd, ['rev-parse', '--show-toplevel']),
      git(options.cwd, ['rev-parse', 'HEAD']),
    ])
  } catch {
    throw new Error(
      `${options.label} worktree isolation requires a Git repository`,
    )
  }
  const parent = resolve(options.parentDirectory)
  const path = join(parent, options.directoryName)
  await mkdir(parent, { recursive: true })
  let exists = false
  try {
    const entry = await lstat(path)
    if (entry.isSymbolicLink()) {
      throw new Error(`${options.label} worktree path must not be a symlink`)
    }
    exists = true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (exists) {
    let registered: Set<string>
    try {
      registered = await registeredWorktrees(root)
    } catch (error) {
      throw new Error(
        `Could not inspect ${options.label.toLowerCase()} worktrees: ${(error as Error).message}`,
      )
    }
    if (!registered.has(resolve(path))) {
      throw new Error(
        `${options.label} worktree path already exists and is not registered: ${path}`,
      )
    }
  } else {
    try {
      await git(root, ['worktree', 'add', '--detach', path, initialHead])
    } catch (error) {
      throw new Error(
        `Could not create ${options.label.toLowerCase()} worktree: ${(error as Error).message}`,
      )
    }
  }

  const settle = createManagedWorktreeSettlement()
  const cleanup = () =>
    settle(async () => {
      let status: string
      let head: string
      try {
        ;[status, head] = await Promise.all([
          git(path, ['status', '--porcelain']),
          git(path, ['rev-parse', 'HEAD']),
        ])
      } catch (error) {
        return {
          retained: true,
          reason: `Could not inspect ${options.label.toLowerCase()} worktree ${path}: ${(error as Error).message}`,
        }
      }
      if (status.length > 0) {
        return {
          retained: true,
          reason: `${options.label} worktree has uncommitted changes and was retained at ${path}`,
        }
      }
      if (head !== initialHead) {
        return {
          retained: true,
          reason: `${options.label} worktree has commits and was retained at ${path}`,
        }
      }
      try {
        await git(root, ['worktree', 'remove', path])
        return { retained: false }
      } catch (error) {
        return {
          retained: true,
          reason: `Could not remove ${options.label.toLowerCase()} worktree ${path}: ${(error as Error).message}`,
        }
      }
    })
  return {
    cwd: path,
    cleanup,
    release: cleanup,
    retain: async (reason) => {
      assertRetentionReason(reason)
      return settle(async () => ({
        retained: true,
        reason,
      }))
    },
  }
}

/** Reattaches only to a real, registered Git worktree. Persisted metadata is
 * untrusted input, so an arbitrary directory can never become an execution
 * cwd merely because it exists. Restored worktrees are retained for audit. */
export async function restoreManagedWorktree(options: {
  cwd: string
  path: string
  label: 'Agent' | 'Workflow'
}): Promise<ManagedWorktree> {
  if (!isAbsolute(options.path) || options.path.includes('\0')) {
    throw new Error(
      `Invalid retained ${options.label.toLowerCase()} worktree path`,
    )
  }
  const path = resolve(options.path)
  let entry
  try {
    entry = await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `Retained ${options.label.toLowerCase()} worktree is missing: ${path}`,
      )
    }
    throw error
  }
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error(
      `Retained ${options.label.toLowerCase()} worktree must be a real directory: ${path}`,
    )
  }
  let root: string
  let registered: Set<string>
  let canonicalPath: string
  try {
    ;[root, canonicalPath] = await Promise.all([
      git(options.cwd, ['rev-parse', '--show-toplevel']),
      realpath(path),
    ])
    registered = await registeredWorktrees(root)
  } catch (error) {
    throw new Error(
      `Could not inspect retained ${options.label.toLowerCase()} worktree ${path}: ${(error as Error).message}`,
    )
  }
  if (!registered.has(path) && !registered.has(canonicalPath)) {
    throw new Error(
      `Retained ${options.label.toLowerCase()} worktree is not registered: ${path}`,
    )
  }
  const worktreeRoot = await realpath(
    resolve(await git(path, ['rev-parse', '--show-toplevel'])),
  )
  if (worktreeRoot !== canonicalPath) {
    throw new Error(
      `Retained ${options.label.toLowerCase()} worktree path is not its root: ${path}`,
    )
  }
  return {
    cwd: path,
    async cleanup() {
      return {
        retained: true,
        reason: `${options.label} worktree was restored and retained at ${path}`,
      }
    },
    async release() {
      return {
        retained: true,
        reason: `${options.label} worktree was restored and retained at ${path}`,
      }
    },
    async retain(reason) {
      assertRetentionReason(reason)
      return { retained: true, reason }
    },
  }
}
