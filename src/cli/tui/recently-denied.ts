import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { setTimeout } from 'node:timers/promises'

import { writeFileAtomically } from '../../platform/atomic-write.js'
import {
  ExclusiveFileLease,
  type ExclusiveFileLeaseHandle,
} from '../../platform/exclusive-file-lease.js'

const MAX_ENTRIES = 20
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000

export interface RecentlyDeniedEntry {
  key: string
  display: string
  deniedAt: number
}

export interface RecentlyDeniedStore {
  load(): Promise<readonly string[]>
  record(display: string): Promise<readonly string[]>
  remove(display: string): Promise<readonly string[]>
  clear(): Promise<void>
}

function configRootPath(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
}

export function recentlyDeniedPath(configRoot = configRootPath()): string {
  return join(configRoot, 'praxis', 'permissions', 'recently-denied.json')
}

function keyFor(display: string): string {
  return createHash('sha256').update(display).digest('hex')
}

function parseEntries(value: unknown): RecentlyDeniedEntry[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (typeof entry === 'string' && entry.trim()) {
      return [{ key: keyFor(entry), display: entry, deniedAt: 0 }]
    }
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry))
      return []
    const candidate = entry as Record<string, unknown>
    if (
      typeof candidate.key !== 'string' ||
      typeof candidate.display !== 'string' ||
      !candidate.display.trim() ||
      typeof candidate.deniedAt !== 'number' ||
      !Number.isFinite(candidate.deniedAt)
    )
      return []
    return [
      {
        key: candidate.key,
        display: candidate.display,
        deniedAt: candidate.deniedAt,
      },
    ]
  })
}

async function readEntries(path: string): Promise<RecentlyDeniedEntry[]> {
  try {
    const source = await readFile(path, 'utf8')
    return parseEntries(JSON.parse(source))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    if (error instanceof SyntaxError) return []
    throw error
  }
}

function activeEntries(
  entries: readonly RecentlyDeniedEntry[],
  now = Date.now(),
): RecentlyDeniedEntry[] {
  const seen = new Set<string>()
  return entries
    .filter(
      (entry) => entry.deniedAt === 0 || now - entry.deniedAt <= MAX_AGE_MS,
    )
    .filter((entry) => {
      if (seen.has(entry.key)) return false
      seen.add(entry.key)
      return true
    })
    .sort((left, right) => right.deniedAt - left.deniedAt)
    .slice(0, MAX_ENTRIES)
}

async function writeEntries(
  path: string,
  entries: readonly RecentlyDeniedEntry[],
): Promise<void> {
  await writeFileAtomically(path, `${JSON.stringify(entries, null, 2)}\n`)
}

async function withLease<T>(
  path: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lease = new ExclusiveFileLease(
    join(dirname(path), '.recently-denied.lock'),
  )
  let handle: ExclusiveFileLeaseHandle | null = null
  for (let attempt = 0; attempt < 400; attempt += 1) {
    handle = await lease.tryAcquire()
    if (handle) break
    await setTimeout(5)
  }
  if (!handle) throw new Error('Recently denied write lock timed out')
  try {
    return await operation()
  } finally {
    await handle.release()
  }
}

export function createRecentlyDeniedStore(
  configRoot = configRootPath(),
): RecentlyDeniedStore {
  const path = recentlyDeniedPath(configRoot)
  return {
    async load() {
      return withLease(path, async () => {
        const entries = activeEntries(await readEntries(path))
        await writeEntries(path, entries)
        return entries.map((entry) => entry.display)
      })
    },
    async record(display) {
      const normalized = display.trim()
      if (!normalized) return this.load()
      return withLease(path, async () => {
        const now = Date.now()
        const next = activeEntries(await readEntries(path)).filter(
          (entry) => entry.key !== keyFor(normalized),
        )
        next.unshift({
          key: keyFor(normalized),
          display: normalized,
          deniedAt: now,
        })
        const bounded = next.slice(0, MAX_ENTRIES)
        await writeEntries(path, bounded)
        return bounded.map((entry) => entry.display)
      })
    },
    async remove(display) {
      return withLease(path, async () => {
        const key = keyFor(display)
        const next = activeEntries(await readEntries(path)).filter(
          (entry) => entry.key !== key,
        )
        await writeEntries(path, next)
        return next.map((entry) => entry.display)
      })
    },
    async clear() {
      await withLease(path, () => writeEntries(path, []).then(() => undefined))
    },
  }
}
