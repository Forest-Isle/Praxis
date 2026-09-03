import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import {
  link,
  mkdir,
  open,
  opendir,
  readFile,
  rename,
  rm,
} from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

interface LeaseMetadata {
  version: 1
  pid: number
  token: string
  createdAt: string
  processStart?: string
}

export interface ExclusiveFileLeaseOptions {
  processStart?: (pid: number) => Promise<string | null>
}

export interface ExclusiveFileLeaseHandle {
  readonly token: string
  readonly pid: number
  readonly createdAt: string
  release(): Promise<void>
}

const MAX_STALE_ARTIFACT_CLEANUP = 64

function parseLease(source: string): LeaseMetadata | null {
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  const lock = value as Record<string, unknown>
  if (
    lock.version !== 1 ||
    !Number.isSafeInteger(lock.pid) ||
    Number(lock.pid) <= 0 ||
    typeof lock.token !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/u.test(lock.token) ||
    typeof lock.createdAt !== 'string' ||
    (lock.processStart !== undefined &&
      (typeof lock.processStart !== 'string' ||
        lock.processStart.length === 0 ||
        lock.processStart.length > 256))
  ) {
    return null
  }
  return lock as unknown as LeaseMetadata
}

const processStartCache = new Map<number, Promise<string | null>>()
async function defaultProcessStart(pid: number): Promise<string | null> {
  if (pid === process.pid) {
    const cached = processStartCache.get(pid)
    if (cached) return cached
  }
  const result = (async () => {
    try {
      const output = await execFileAsync(
        'ps',
        ['-p', String(pid), '-o', 'lstart='],
        { encoding: 'utf8' },
      )
      const value = output.stdout.trim()
      return value || null
    } catch {
      return null
    }
  })()
  if (pid === process.pid) processStartCache.set(pid, result)
  return result
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export class ExclusiveFileLease {
  constructor(
    private readonly lockFile: string,
    private readonly options: ExclusiveFileLeaseOptions = {},
  ) {}

  async tryAcquire(): Promise<ExclusiveFileLeaseHandle | null> {
    await mkdir(dirname(this.lockFile), { recursive: true })
    await this.cleanupStaleArtifacts()
    const owner = await this.acquire()
    if (!owner) return null
    return {
      token: owner.token,
      pid: owner.pid,
      createdAt: owner.createdAt,
      release: () => this.releaseOwned(this.lockFile, owner.token),
    }
  }

  private async acquire(): Promise<LeaseMetadata | null> {
    const processStart = await (
      this.options.processStart ?? defaultProcessStart
    )(process.pid)
    const owner: LeaseMetadata = {
      version: 1,
      pid: process.pid,
      token: randomUUID(),
      createdAt: new Date().toISOString(),
      ...(processStart ? { processStart } : {}),
    }
    const candidate = `${this.lockFile}.${owner.token}.candidate`
    const handle = await open(candidate, 'wx', 0o600)
    try {
      try {
        await handle.writeFile(JSON.stringify(owner))
        await handle.sync()
      } finally {
        await handle.close()
      }
      try {
        await link(candidate, this.lockFile)
        return owner
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }

      let existing: LeaseMetadata | null
      try {
        existing = parseLease(await readFile(this.lockFile, 'utf8'))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        try {
          await link(candidate, this.lockFile)
          return owner
        } catch (linkError) {
          if ((linkError as NodeJS.ErrnoException).code === 'EEXIST')
            return null
          throw linkError
        }
      }
      if (!existing || (await this.ownerLive(existing))) return null
      const guard = `${this.lockFile}.${existing.token}.reclaim`
      if (!(await this.acquireReclaimGuard(candidate, guard, owner.token))) {
        return null
      }
      try {
        if (!(await this.owns(guard, owner.token))) return null
        let current: LeaseMetadata | null
        try {
          current = parseLease(await readFile(this.lockFile, 'utf8'))
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') current = null
          else throw error
        }
        if (
          current?.token !== existing.token ||
          (current && (await this.ownerLive(current)))
        ) {
          return null
        }
        await rm(this.lockFile, { force: true })
        try {
          await link(candidate, this.lockFile)
          if (!(await this.owns(guard, owner.token))) {
            await this.releaseOwned(this.lockFile, owner.token)
            return null
          }
          return owner
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null
          throw error
        }
      } finally {
        await this.releaseOwned(guard, owner.token)
      }
    } finally {
      await rm(candidate, { force: true })
    }
  }

  private async acquireReclaimGuard(
    candidate: string,
    guard: string,
    token: string,
  ): Promise<boolean> {
    try {
      await link(candidate, guard)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    let existing: LeaseMetadata | null
    try {
      existing = parseLease(await readFile(guard, 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      try {
        await link(candidate, guard)
        return true
      } catch (linkError) {
        if ((linkError as NodeJS.ErrnoException).code === 'EEXIST') return false
        throw linkError
      }
    }
    if (!existing || (await this.ownerLive(existing))) return false
    const displaced = `${guard}.${token}.stale`
    try {
      try {
        await rename(guard, displaced)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        try {
          await link(candidate, guard)
          return true
        } catch (linkError) {
          if ((linkError as NodeJS.ErrnoException).code === 'EEXIST')
            return false
          throw linkError
        }
      }
      const moved = parseLease(await readFile(displaced, 'utf8'))
      if (moved?.token !== existing.token) return false
      try {
        await link(candidate, guard)
        return true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
        throw error
      }
    } finally {
      await rm(displaced, { force: true })
    }
  }

  private async owns(filePath: string, token: string): Promise<boolean> {
    try {
      return parseLease(await readFile(filePath, 'utf8'))?.token === token
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }

  private async cleanupStaleArtifacts(): Promise<void> {
    const directory = dirname(this.lockFile)
    const prefix = `${basename(this.lockFile)}.`
    const entries = await opendir(directory)
    let inspected = 0
    for await (const entry of entries) {
      if (
        !entry.isFile() ||
        !entry.name.startsWith(prefix) ||
        !/\.(?:candidate|stale)$/u.test(entry.name)
      ) {
        continue
      }
      if (inspected >= MAX_STALE_ARTIFACT_CLEANUP) return
      inspected += 1
      if (
        entry.name.endsWith('.stale') &&
        (await this.staleArtifactHasLiveOwner(entry.name))
      ) {
        continue
      }
      const artifact = join(directory, entry.name)
      let owner: LeaseMetadata | null
      try {
        owner = parseLease(await readFile(artifact, 'utf8'))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      if (!owner || (await this.ownerLive(owner))) continue
      await this.releaseOwned(artifact, owner.token)
    }
  }

  private async staleArtifactHasLiveOwner(name: string): Promise<boolean> {
    const match = /\.reclaim\.([A-Za-z0-9_-]{1,128})\.stale$/u.exec(name)
    const token = match?.[1]
    if (!token) return true
    let owner: LeaseMetadata | null
    try {
      owner = parseLease(
        await readFile(`${this.lockFile}.${token}.candidate`, 'utf8'),
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
    return !owner || owner.token !== token || (await this.ownerLive(owner))
  }

  private async ownerLive(owner: LeaseMetadata): Promise<boolean> {
    if (!processAlive(owner.pid)) return false
    const current = await (this.options.processStart ?? defaultProcessStart)(
      owner.pid,
    )
    if (!owner.processStart || !current) return true
    return owner.processStart === current
  }

  private async releaseOwned(filePath: string, token: string): Promise<void> {
    if (await this.owns(filePath, token)) await rm(filePath, { force: true })
  }
}
