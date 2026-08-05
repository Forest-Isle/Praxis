import { randomUUID } from 'node:crypto'
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

interface LeaseMetadata {
  version: 1
  pid: number
  token: string
  createdAt: string
}

export interface ExclusiveFileLeaseHandle {
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
    typeof lock.createdAt !== 'string'
  ) {
    return null
  }
  return lock as unknown as LeaseMetadata
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
  constructor(private readonly lockFile: string) {}

  async tryAcquire(): Promise<ExclusiveFileLeaseHandle | null> {
    await mkdir(dirname(this.lockFile), { recursive: true })
    await this.cleanupStaleArtifacts()
    const owner = await this.acquire()
    if (!owner) return null
    return {
      release: () => this.releaseOwned(this.lockFile, owner.token),
    }
  }

  private async acquire(): Promise<LeaseMetadata | null> {
    const owner: LeaseMetadata = {
      version: 1,
      pid: process.pid,
      token: randomUUID(),
      createdAt: new Date().toISOString(),
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
      if (!existing || processAlive(existing.pid)) return null
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
        if (current?.token !== existing.token || processAlive(current.pid)) {
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
    if (!existing || processAlive(existing.pid)) return false
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
      if (!owner || processAlive(owner.pid)) continue
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
    return !owner || owner.token !== token || processAlive(owner.pid)
  }

  private async releaseOwned(filePath: string, token: string): Promise<void> {
    if (await this.owns(filePath, token)) await rm(filePath, { force: true })
  }
}
