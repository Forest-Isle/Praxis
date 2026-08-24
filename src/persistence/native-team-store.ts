import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'

import {
  parseTeamId,
  parseTeamSnapshot,
  type TeamSnapshot,
} from '../core/team-ownership.js'
import { writeFileAtomically } from '../platform/atomic-write.js'
import {
  ExclusiveFileLease,
  type ExclusiveFileLeaseHandle,
} from '../platform/exclusive-file-lease.js'
import { resolveProjectIdentity } from '../platform/project-identity.js'
import { sanitizeProjectPath } from '../platform/project-path-key.js'

export interface NativeTeamStoreOptions {
  readonly nativeRoot: string
  readonly cwd: string
}

export interface NativeTeamClaim {
  readonly teamId: string
  readonly token: string
  readonly pid: number
  readonly acquiredAt: string
  read(): Promise<TeamSnapshot>
  save(expectedRevision: number, next: TeamSnapshot): Promise<TeamSnapshot>
  release(): Promise<void>
}

function assertTeamId(teamId: string): void {
  parseTeamId(teamId)
}

function assertRoot(root: string): string {
  if (typeof root !== 'string' || root.trim() === '')
    throw new Error('Invalid native Team root')
  return resolve(root)
}

export class NativeTeamStore {
  private readonly projectRoot: string
  private mutation: Promise<void> = Promise.resolve()

  private constructor(
    private readonly nativeRoot: string,
    readonly projectIdentity: string,
  ) {
    this.projectRoot = resolve(
      nativeRoot,
      'state',
      'teams',
      sanitizeProjectPath(projectIdentity),
    )
  }

  static async open(options: NativeTeamStoreOptions): Promise<NativeTeamStore> {
    const root = assertRoot(options.nativeRoot)
    const projectIdentity = await resolveProjectIdentity(options.cwd)
    return new NativeTeamStore(root, projectIdentity)
  }

  async createAndClaim(snapshot: unknown): Promise<NativeTeamClaim> {
    const parsed = parseTeamSnapshot(snapshot)
    this.assertSnapshot(parsed, parsed.teamId)
    if (parsed.revision !== 0)
      throw new Error('Native Team creation requires revision 0')
    const claim = await this.acquireClaim(parsed.teamId)
    let mutation: ExclusiveFileLeaseHandle | undefined
    try {
      mutation = await this.acquireMutation(parsed.teamId)
      if (await this.exists(this.statePath(parsed.teamId)))
        throw new Error(
          `Native Team state already exists: ${this.statePath(parsed.teamId)}`,
        )
      await writeFileAtomically(
        this.statePath(parsed.teamId),
        `${JSON.stringify(parsed)}\n`,
        { mode: 0o600 },
      )
      return claim
    } catch (error) {
      await claim.release()
      throw error
    } finally {
      await mutation?.release()
    }
  }

  async claim(teamId: string): Promise<NativeTeamClaim> {
    assertTeamId(teamId)
    const claim = await this.acquireClaim(teamId)
    try {
      const snapshot = await this.read(teamId)
      if (snapshot === null)
        throw new Error(`Missing native Team state: ${this.statePath(teamId)}`)
      return claim
    } catch (error) {
      await claim.release()
      throw error
    }
  }

  async read(teamId: string): Promise<TeamSnapshot | null> {
    assertTeamId(teamId)
    const path = this.statePath(teamId)
    let source: string
    try {
      source = await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    let value: unknown
    try {
      value = JSON.parse(source)
    } catch (error) {
      throw new Error(`Corrupt native Team state: ${path}`, { cause: error })
    }
    let snapshot: TeamSnapshot
    try {
      snapshot = parseTeamSnapshot(value)
      this.assertSnapshot(snapshot, teamId)
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith('Invalid native Team state:')
      )
        throw error
      throw new Error(`Invalid native Team state: ${path}`, { cause: error })
    }
    return snapshot
  }

  async list(): Promise<readonly TeamSnapshot[]> {
    let entries
    try {
      entries = await readdir(this.projectRoot, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const ids = entries
      .filter((entry) => {
        if (!entry.isDirectory()) return false
        try {
          parseTeamId(entry.name)
          return true
        } catch {
          return false
        }
      })
      .map((entry) => entry.name)
      .sort()
    const snapshots: TeamSnapshot[] = []
    for (const id of ids) {
      const snapshot = await this.read(id)
      if (snapshot === null)
        throw new Error(`Invalid native Team state: ${this.statePath(id)}`)
      snapshots.push(snapshot)
    }
    return Object.freeze(snapshots)
  }

  private async acquireClaim(teamId: string): Promise<NativeTeamClaimImpl> {
    assertTeamId(teamId)
    const lease = await new ExclusiveFileLease(
      `${this.statePath(teamId)}.owner.lock`,
    ).tryAcquire()
    if (!lease) throw new Error(`Team ${teamId} is already owned`)
    return new NativeTeamClaimImpl(
      teamId,
      lease,
      async () => {
        const snapshot = await this.read(teamId)
        if (snapshot === null)
          throw new Error(
            `Missing native Team state: ${this.statePath(teamId)}`,
          )
        return snapshot
      },
      (expectedRevision, next) => this.save(teamId, expectedRevision, next),
    )
  }

  private async acquireMutation(
    teamId: string,
  ): Promise<ExclusiveFileLeaseHandle> {
    const leaseFile = `${this.statePath(teamId)}.mutation.lock`
    const deadline = Date.now() + 5_000
    for (;;) {
      const lease = await new ExclusiveFileLease(leaseFile).tryAcquire()
      if (lease) return lease
      if (Date.now() >= deadline)
        throw new Error(
          `Team ${teamId} mutation is busy: ${this.statePath(teamId)}`,
        )
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 10))
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.mutation.then(operation)
    this.mutation = queued.then(
      () => undefined,
      () => undefined,
    )
    return queued
  }

  private async save(
    teamId: string,
    expectedRevision: number,
    next: TeamSnapshot,
  ): Promise<TeamSnapshot> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
      throw new Error('Invalid expected Team revision')
    return this.enqueue(async () => {
      const mutation = await this.acquireMutation(teamId)
      try {
        const current = await this.read(teamId)
        if (current === null)
          throw new Error(
            `Missing native Team state: ${this.statePath(teamId)}`,
          )
        if (current.revision !== expectedRevision)
          throw new Error(
            `Team revision conflict: expected ${expectedRevision}, found ${current.revision}`,
          )
        const parsed = parseTeamSnapshot(next)
        this.assertSnapshot(parsed, teamId)
        if (
          parsed.teamId !== current.teamId ||
          parsed.projectIdentity !== current.projectIdentity ||
          parsed.leadSessionId !== current.leadSessionId ||
          parsed.createdAt !== current.createdAt
        )
          throw new Error('Immutable native Team identity fields changed')
        if (
          JSON.stringify(parsed.policy) !== JSON.stringify(current.policy) ||
          JSON.stringify(parsed.budgets) !== JSON.stringify(current.budgets)
        )
          throw new Error('Immutable native Team policy or budgets changed')
        if (
          parsed.revision !== current.revision + 1 ||
          parsed.updatedAt < current.updatedAt
        )
          throw new Error('Invalid native Team revision or timestamp')
        await writeFileAtomically(
          this.statePath(teamId),
          `${JSON.stringify(parsed)}\n`,
          { mode: 0o600 },
        )
        return parsed
      } finally {
        await mutation.release()
      }
    })
  }

  private assertSnapshot(snapshot: TeamSnapshot, teamId: string): void {
    if (
      snapshot.projectIdentity !== this.projectIdentity ||
      snapshot.teamId !== teamId
    )
      throw new Error(`Invalid native Team state: ${this.statePath(teamId)}`)
  }

  private statePath(teamId: string): string {
    return resolve(this.projectRoot, teamId, 'team.json')
  }
  private async exists(path: string): Promise<boolean> {
    try {
      await readFile(path)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }
}

class NativeTeamClaimImpl implements NativeTeamClaim {
  private active = true
  private operations: Promise<void> = Promise.resolve()
  private releasePromise: Promise<void> | undefined
  readonly teamId: string
  readonly token: string
  readonly pid: number
  readonly acquiredAt: string
  constructor(
    teamId: string,
    private readonly lease: ExclusiveFileLeaseHandle,
    private readonly readState: () => Promise<TeamSnapshot>,
    private readonly saveState: (
      expectedRevision: number,
      next: TeamSnapshot,
    ) => Promise<TeamSnapshot>,
  ) {
    this.teamId = teamId
    this.token = lease.token
    this.pid = lease.pid
    this.acquiredAt = lease.createdAt
  }
  assertActive(): void {
    if (!this.active) throw new Error(`Team ${this.teamId} claim is released`)
  }
  read(): Promise<TeamSnapshot> {
    return this.admit(() => this.readState())
  }
  save(expectedRevision: number, next: TeamSnapshot): Promise<TeamSnapshot> {
    return this.admit(() => this.saveState(expectedRevision, next))
  }
  async release(): Promise<void> {
    if (this.releasePromise) return this.releasePromise
    this.active = false
    this.releasePromise = this.operations.then(() => this.lease.release())
    return this.releasePromise
  }
  private admit<T>(operation: () => Promise<T>): Promise<T> {
    this.assertActive()
    const admitted = this.operations.then(operation, operation)
    this.operations = admitted.then(
      () => undefined,
      () => undefined,
    )
    return admitted
  }
}
