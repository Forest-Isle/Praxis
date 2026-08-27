import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
} from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import type { NativeTranscriptEntry } from './schema.js'

const BACKUP_NAME = /^[0-9a-f]{16}@v[1-9]\d*$/u
const MAX_REWIND_FILE_BYTES = 10 * 1024 * 1024
const MAX_REWIND_TOTAL_BYTES = 100 * 1024 * 1024

interface FileBackup {
  backupFileName: string | null
  version: number
  backupTime: string
}

interface PreparedBackup {
  backup: FileBackup
  createdPath?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isUserMessage(entry: NativeTranscriptEntry): boolean {
  if (
    entry.type !== 'user' ||
    typeof entry.uuid !== 'string' ||
    !isRecord(entry.message) ||
    entry.message.role !== 'user'
  ) {
    return false
  }
  const content = entry.message.content
  if (typeof content === 'string') return true
  return (
    Array.isArray(content) &&
    content.length > 0 &&
    content.every(
      (block) =>
        isRecord(block) &&
        (block.type === 'text' ||
          block.type === 'image' ||
          block.type === 'document'),
    )
  )
}

function within(root: string, path: string): boolean {
  const child = relative(root, path)
  return (
    child === '' ||
    (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))
  )
}

async function nearestExisting(path: string): Promise<string> {
  let candidate = path
  for (;;) {
    try {
      return await realpath(candidate)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(candidate)
      if (parent === candidate) throw error
      candidate = parent
    }
  }
}

async function assertAllowedPath(
  path: string,
  roots: readonly string[],
): Promise<string> {
  const absolute = isAbsolute(path)
    ? resolve(path)
    : resolve(roots[0] ?? '', path)
  const ancestor = await nearestExisting(dirname(absolute))
  const allowedRoots = await Promise.all(
    roots.map(async (root) => {
      try {
        return await realpath(root)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        return resolve(root)
      }
    }),
  )
  if (!allowedRoots.some((root) => within(root, ancestor))) {
    throw new Error(
      `Claude file history path is outside allowed roots: ${path}`,
    )
  }
  try {
    const metadata = await lstat(absolute)
    if (metadata.isSymbolicLink()) {
      throw new Error(`Claude file history path is a symbolic link: ${path}`)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return absolute
}

function parseBackup(value: unknown): FileBackup {
  if (
    !isRecord(value) ||
    (value.backupFileName !== null &&
      (typeof value.backupFileName !== 'string' ||
        !BACKUP_NAME.test(value.backupFileName))) ||
    typeof value.version !== 'number' ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1 ||
    typeof value.backupTime !== 'string' ||
    value.backupTime.length === 0
  ) {
    throw new Error('Claude file history has invalid backup metadata')
  }
  return {
    backupFileName: value.backupFileName,
    version: value.version,
    backupTime: value.backupTime,
  }
}

function snapshots(entries: readonly NativeTranscriptEntry[]) {
  return entries.filter(
    (entry) =>
      entry.type === 'file-history-snapshot' &&
      typeof entry.messageId === 'string' &&
      isRecord(entry.snapshot),
  )
}

function trackedPaths(entries: readonly NativeTranscriptEntry[]): Set<string> {
  const paths = new Set<string>()
  for (const entry of entries) {
    if (entry.type === 'file-history-delta') {
      if (typeof entry.trackingPath === 'string') paths.add(entry.trackingPath)
      continue
    }
    if (entry.type !== 'file-history-snapshot' || !isRecord(entry.snapshot)) {
      continue
    }
    const tracked = entry.snapshot.trackedFileBackups
    if (!isRecord(tracked)) continue
    for (const path of Object.keys(tracked)) paths.add(path)
  }
  return paths
}

function normalizeTrackedPath(path: string, root: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(root, path)
}

function nextVersion(
  entries: readonly NativeTranscriptEntry[],
  path: string,
  root: string,
): number {
  let version = 0
  for (const entry of entries) {
    if (
      entry.type === 'file-history-delta' &&
      typeof entry.trackingPath === 'string'
    ) {
      const tracked = normalizeTrackedPath(entry.trackingPath, root)
      if (tracked === path) {
        version = Math.max(version, parseBackup(entry.backup).version)
      }
      continue
    }
    if (entry.type !== 'file-history-snapshot' || !isRecord(entry.snapshot)) {
      continue
    }
    const tracked = entry.snapshot.trackedFileBackups
    if (!isRecord(tracked)) continue
    for (const [trackedPath, backup] of Object.entries(tracked)) {
      const absolute = normalizeTrackedPath(trackedPath, root)
      if (absolute === path) {
        version = Math.max(version, parseBackup(backup).version)
      }
    }
  }
  return version + 1
}

export class ClaudeFileHistory {
  private readonly backupDirectory: string
  private readonly roots: readonly string[]

  constructor(configRoot: string, sessionId: string, roots: readonly string[]) {
    this.backupDirectory = join(configRoot, 'file-history', sessionId)
    this.roots = roots.map((root) => resolve(root))
  }

  private async backup(
    entries: readonly NativeTranscriptEntry[],
    path: string,
  ): Promise<PreparedBackup> {
    const absolute = await assertAllowedPath(path, this.roots)
    let version = nextVersion(entries, absolute, this.roots[0] ?? '')
    const backupTime = new Date().toISOString()
    try {
      const metadata = await lstat(absolute)
      if (!metadata.isFile()) {
        throw new Error(`Claude file history path is not a file: ${absolute}`)
      }
      if (metadata.size > MAX_REWIND_FILE_BYTES) {
        throw new Error(
          `Claude file history file exceeds size limit: ${absolute}`,
        )
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {
          backup: { backupFileName: null, version, backupTime },
        }
      }
      throw error
    }
    const hash = createHash('sha256')
      .update(absolute)
      .digest('hex')
      .slice(0, 16)
    try {
      for (const name of await readdir(this.backupDirectory)) {
        const match = new RegExp(`^${hash}@v(\\d+)$`, 'u').exec(name)
        if (match) version = Math.max(version, Number(match[1]) + 1)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const backupFileName = `${hash}@v${version}`
    const backupPath = join(this.backupDirectory, backupFileName)
    await mkdir(this.backupDirectory, { recursive: true })
    await copyFile(absolute, backupPath, constants.COPYFILE_EXCL)
    return {
      backup: { backupFileName, version, backupTime },
      createdPath: backupPath,
    }
  }

  async snapshot(
    entries: readonly NativeTranscriptEntry[],
    messageId: string,
  ): Promise<NativeTranscriptEntry> {
    const trackedFileBackups: Record<string, FileBackup> = {}
    for (const path of [...trackedPaths(entries)].sort()) {
      const prepared = await this.backup(entries, path)
      trackedFileBackups[path] = prepared.backup
    }
    return {
      type: 'file-history-snapshot',
      messageId,
      snapshot: {
        messageId,
        trackedFileBackups,
        timestamp: new Date().toISOString(),
      },
      isSnapshotUpdate: false,
    }
  }

  async prepareMutation(
    entries: readonly NativeTranscriptEntry[],
    snapshotMessageId: string,
    path: string,
  ): Promise<{
    commit(messageId: string): NativeTranscriptEntry | null
    rollback(): Promise<void>
  }> {
    const snapshot = snapshots(entries).findLast(
      (entry) => entry.messageId === snapshotMessageId,
    )
    if (!snapshot || !isRecord(snapshot.snapshot)) {
      throw new Error('Claude file history snapshot is missing')
    }
    const absolute = await assertAllowedPath(path, this.roots)
    const root = this.roots[0] ?? ''
    const tracked = snapshot.snapshot.trackedFileBackups
    const alreadyTracked =
      (isRecord(tracked) &&
        Object.keys(tracked).some(
          (trackedPath) => normalizeTrackedPath(trackedPath, root) === absolute,
        )) ||
      entries.some(
        (entry) =>
          entry.type === 'file-history-delta' &&
          entry.snapshotMessageId === snapshotMessageId &&
          typeof entry.trackingPath === 'string' &&
          normalizeTrackedPath(entry.trackingPath, root) === absolute,
      )
    if (alreadyTracked) {
      return { commit: () => null, rollback: async () => undefined }
    }
    const prepared = await this.backup(entries, absolute)
    return {
      commit: (messageId) => ({
        type: 'file-history-delta',
        messageId,
        snapshotMessageId,
        trackingPath: absolute,
        backup: prepared.backup,
        timestamp: new Date().toISOString(),
      }),
      rollback: async () => {
        if (prepared.createdPath)
          await rm(prepared.createdPath, { force: true })
      },
    }
  }

  async rewind(
    entries: readonly NativeTranscriptEntry[],
    userMessageId: string,
  ): Promise<void> {
    if (
      !entries.some(
        (entry) => entry.uuid === userMessageId && isUserMessage(entry),
      )
    ) {
      throw new Error(
        `--rewind-files requires a user message UUID, but ${userMessageId} is not a user message in this session`,
      )
    }
    const target = snapshots(entries).findLast(
      (entry) => entry.messageId === userMessageId,
    )
    if (!target || !isRecord(target.snapshot)) {
      throw new Error('File rewinding is not enabled.')
    }
    const desired = new Map<string, FileBackup>()
    const tracked = target.snapshot.trackedFileBackups
    if (!isRecord(tracked)) {
      throw new Error('Claude file history snapshot is invalid')
    }
    const root = this.roots[0] ?? ''
    for (const [path, backup] of Object.entries(tracked)) {
      desired.set(normalizeTrackedPath(path, root), parseBackup(backup))
    }
    for (const entry of entries) {
      if (
        entry.type !== 'file-history-delta' ||
        entry.snapshotMessageId !== userMessageId ||
        typeof entry.trackingPath !== 'string'
      ) {
        continue
      }
      const path = normalizeTrackedPath(entry.trackingPath, root)
      if (desired.has(path)) continue
      desired.set(path, parseBackup(entry.backup))
    }

    const operations: {
      path: string
      content?: Buffer
    }[] = []
    let totalBytes = 0
    for (const [path, backup] of desired) {
      const absolute = await assertAllowedPath(path, this.roots)
      if (backup.backupFileName === null) {
        operations.push({ path: absolute })
        continue
      }
      const backupPath = join(this.backupDirectory, backup.backupFileName)
      const handle = await open(
        backupPath,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      )
      try {
        const metadata = await handle.stat()
        if (!metadata.isFile() || metadata.size > MAX_REWIND_FILE_BYTES) {
          throw new Error(
            `Claude file history backup is invalid: ${backup.backupFileName}`,
          )
        }
        totalBytes += metadata.size
        if (totalBytes > MAX_REWIND_TOTAL_BYTES) {
          throw new Error('Claude file history rewind exceeds total size limit')
        }
        operations.push({ path: absolute, content: await handle.readFile() })
      } finally {
        await handle.close()
      }
    }

    for (const operation of operations) {
      if (operation.content === undefined) {
        try {
          const metadata = await lstat(operation.path)
          if (metadata.isDirectory()) {
            throw new Error(
              `Claude file history cannot remove a directory: ${operation.path}`,
            )
          }
          await unlink(operation.path)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        continue
      }
      await mkdir(dirname(operation.path), { recursive: true })
      const temporary = join(
        dirname(operation.path),
        `.${randomUUID()}.praxis-rewind`,
      )
      const handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600,
      )
      try {
        await handle.writeFile(operation.content)
        await handle.sync()
      } finally {
        await handle.close()
      }
      try {
        await rename(temporary, operation.path)
      } catch (error) {
        await rm(temporary, { force: true })
        throw error
      }
    }
  }
}
