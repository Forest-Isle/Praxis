import { createHash, randomUUID } from 'node:crypto'
import { lstat, readFile, readdir, realpath, rename } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'

import type { TranscriptDocumentResult } from '../core/transcript-codec.js'
import { isSessionId } from '../core/session.js'
import { readNativeTranscript } from './native-transcript-reader.js'
import { createNativeTranscriptCodec } from './native-transcript-codec.js'
import { NativeTranscriptStore } from './native-transcript-store.js'
import { writeFileAtomically } from '../platform/atomic-write.js'
import { ExclusiveFileLease } from '../platform/exclusive-file-lease.js'

export interface NativeTranscriptMigrationReport {
  sessionId: string
  sourcePath: string
  status:
    | 'convertible'
    | 'corrupt'
    | 'blocked'
    | 'already-migrated'
    | 'migrated'
    | 'rolled-back'
  eventCount: number
  validPrefixByteLength: number
  issue?: string
  manifestPath?: string
  legacyPath?: string
  nativePath?: string
}
interface Manifest {
  version: 1
  migrationId: string
  sessionId: string
  sourcePath: string
  activeNativePath: string
  retainedLegacyPath: string
  stagePath: string
  status: 'prepared' | 'published' | 'rolled-back'
  createdAt: string
  updatedAt: string
  sourceByteHash: string
}
const manifestFor = (sourcePath: string) => `${sourcePath}.migration.json`
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const exists = async (path: string) => {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
const regular = async (path: string) => {
  try {
    return (await lstat(path)).isFile()
  } catch {
    return false
  }
}

export type NativeTranscriptLegacyDecoder = (
  source: string,
) => TranscriptDocumentResult

function decodeLegacy(
  source: string,
  decoder: NativeTranscriptLegacyDecoder,
): TranscriptDocumentResult {
  return decoder(source)
}

function reportBase(
  sourcePath: string,
  sessionId: string,
  extra: Partial<NativeTranscriptMigrationReport> = {},
): NativeTranscriptMigrationReport {
  return {
    sourcePath,
    sessionId,
    status: 'blocked',
    eventCount: 0,
    validPrefixByteLength: 0,
    ...extra,
  }
}

async function inspect(
  sourcePath: string,
  sessionId: string,
  legacyDecoder: NativeTranscriptLegacyDecoder,
) {
  const read = await readNativeTranscript(sourcePath)
  if (read.format === 'native')
    return reportBase(sourcePath, sessionId, {
      status: 'already-migrated',
      eventCount: read.records.length,
      validPrefixByteLength: read.validPrefixByteLength,
      nativePath: sourcePath,
    })
  const decoded = decodeLegacy(read.raw.toString('utf8'), legacyDecoder)
  if (decoded.issue)
    return reportBase(sourcePath, sessionId, {
      status: decoded.issue.kind === 'corrupt-line' ? 'corrupt' : 'blocked',
      eventCount: decoded.records.length,
      validPrefixByteLength: decoded.validPrefixByteLength,
      issue: decoded.issue.message,
    })
  const native = createNativeTranscriptCodec()
  for (const record of decoded.records) {
    const encoded = native.encodeLine(record.event)
    if (!encoded.ok)
      return reportBase(sourcePath, sessionId, {
        status: 'blocked',
        eventCount: decoded.records.length,
        validPrefixByteLength: decoded.validPrefixByteLength,
        issue: encoded.issue.message,
      })
  }
  return reportBase(sourcePath, sessionId, {
    status: 'convertible',
    eventCount: decoded.records.length,
    validPrefixByteLength: decoded.validPrefixByteLength,
  })
}

export async function inspectNativeTranscriptMigration(options: {
  sourcePath: string
  sessionId: string
  legacyDecoder: NativeTranscriptLegacyDecoder
}): Promise<NativeTranscriptMigrationReport> {
  return inspect(options.sourcePath, options.sessionId, options.legacyDecoder)
}

function isManifest(value: unknown): value is Manifest {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false
  const source = value as Record<string, unknown>
  return (
    source.version === 1 &&
    typeof source.migrationId === 'string' &&
    source.migrationId.length > 0 &&
    typeof source.sessionId === 'string' &&
    isSessionId(source.sessionId) &&
    typeof source.sourcePath === 'string' &&
    typeof source.activeNativePath === 'string' &&
    typeof source.retainedLegacyPath === 'string' &&
    typeof source.stagePath === 'string' &&
    (source.status === 'prepared' ||
      source.status === 'published' ||
      source.status === 'rolled-back') &&
    typeof source.createdAt === 'string' &&
    typeof source.updatedAt === 'string' &&
    typeof source.sourceByteHash === 'string' &&
    /^[0-9a-f]{64}$/u.test(source.sourceByteHash)
  )
}

async function readManifest(path: string): Promise<Manifest | null> {
  if (!(await regular(path))) return null
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as Manifest
    return isManifest(value) ? value : null
  } catch {
    return null
  }
}
function manifestBytes(manifest: Manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`
}

export async function migrateNativeTranscript(options: {
  sourcePath: string
  sessionId: string
  legacyDecoder: NativeTranscriptLegacyDecoder
  dryRun?: boolean
}): Promise<NativeTranscriptMigrationReport> {
  const lockPath = `${manifestFor(options.sourcePath)}.lock`
  const lease = await new ExclusiveFileLease(lockPath).tryAcquire()
  if (!lease)
    return reportBase(options.sourcePath, options.sessionId, {
      status: 'blocked',
      manifestPath: manifestFor(options.sourcePath),
      issue: 'Another migration for this source is already in progress',
    })
  try {
    return await migrateNativeTranscriptUnlocked(options)
  } finally {
    await lease.release()
  }
}

async function migrateNativeTranscriptUnlocked(options: {
  sourcePath: string
  sessionId: string
  legacyDecoder: NativeTranscriptLegacyDecoder
  dryRun?: boolean
}): Promise<NativeTranscriptMigrationReport> {
  const manifestPath = manifestFor(options.sourcePath)
  const manifestPresent = await regular(manifestPath)
  const existing = await readManifest(manifestPath)
  if (manifestPresent && !existing)
    return reportBase(options.sourcePath, options.sessionId, {
      status: 'blocked',
      manifestPath,
      issue: 'Migration manifest is malformed or incomplete',
    })
  if (
    existing &&
    (existing.sessionId !== options.sessionId ||
      existing.sourcePath !== options.sourcePath ||
      existing.activeNativePath !== options.sourcePath)
  )
    return reportBase(options.sourcePath, options.sessionId, {
      status: 'blocked',
      manifestPath,
      issue: 'Migration manifest does not match the requested source session',
    })
  if (existing?.status === 'published')
    return reportBase(options.sourcePath, options.sessionId, {
      status: 'already-migrated',
      manifestPath,
      nativePath: existing.activeNativePath,
      legacyPath: existing.retainedLegacyPath,
      eventCount: 0,
      validPrefixByteLength: 0,
    })
  if (existing?.status === 'prepared') {
    const sourcePresent = await exists(options.sourcePath)
    const legacyPresent = await regular(existing.retainedLegacyPath)
    const stagePresent = await regular(existing.stagePath)
    if (!sourcePresent && legacyPresent && stagePresent) {
      const stageRead = await readNativeTranscript(existing.stagePath)
      if (stageRead.format !== 'native')
        return reportBase(options.sourcePath, options.sessionId, {
          status: 'blocked',
          issue: 'Prepared migration stage is not native',
          manifestPath,
        })
      await new NativeTranscriptStore({
        transcriptFile: existing.stagePath,
        lockFile: `${existing.stagePath}.lock`,
      }).load()
      await rename(existing.stagePath, options.sourcePath)
      existing.status = 'published'
      existing.updatedAt = new Date().toISOString()
      await writeFileAtomically(manifestPath, manifestBytes(existing))
      return reportBase(options.sourcePath, options.sessionId, {
        status: 'migrated',
        manifestPath,
        legacyPath: existing.retainedLegacyPath,
        nativePath: options.sourcePath,
        eventCount: stageRead.records.length,
        validPrefixByteLength: stageRead.validPrefixByteLength,
      })
    }
    if (sourcePresent && legacyPresent && !stagePresent) {
      const activeRead = await readNativeTranscript(options.sourcePath)
      const legacyBytes = await readFile(existing.retainedLegacyPath)
      if (
        activeRead.format === 'native' &&
        hash(legacyBytes) === existing.sourceByteHash
      ) {
        existing.status = 'published'
        existing.updatedAt = new Date().toISOString()
        await writeFileAtomically(manifestPath, manifestBytes(existing))
        return reportBase(options.sourcePath, options.sessionId, {
          status: 'already-migrated',
          manifestPath,
          nativePath: options.sourcePath,
          legacyPath: existing.retainedLegacyPath,
          eventCount: activeRead.records.length,
          validPrefixByteLength: activeRead.validPrefixByteLength,
        })
      }
    }
    if (!sourcePresent && !legacyPresent && stagePresent)
      return reportBase(options.sourcePath, options.sessionId, {
        status: 'blocked',
        issue:
          'Prepared migration is missing both source and retained legacy; refusing recovery',
        manifestPath,
      })
    if (!sourcePresent || !legacyPresent || stagePresent)
      return reportBase(options.sourcePath, options.sessionId, {
        status: 'blocked',
        issue: 'Prepared migration has inconsistent paths; refusing recovery',
        manifestPath,
      })
  }
  const inspected = await inspect(
    options.sourcePath,
    options.sessionId,
    options.legacyDecoder,
  )
  if (options.dryRun || inspected.status !== 'convertible')
    return { ...inspected, manifestPath }
  const source = await readFile(options.sourcePath)
  const decoded = decodeLegacy(source.toString('utf8'), options.legacyDecoder)
  if (decoded.issue)
    return {
      ...inspected,
      status: decoded.issue.kind === 'corrupt-line' ? 'corrupt' : 'blocked',
      issue: decoded.issue.message,
      manifestPath,
    }
  const native = createNativeTranscriptCodec()
  const bytes = Buffer.from(
    decoded.records
      .map((record) => {
        const encoded = native.encodeLine(record.event)
        if (!encoded.ok) throw new Error(encoded.issue.message)
        return `${encoded.line}\n`
      })
      .join(''),
  )
  const migrationId = existing?.migrationId ?? randomUUID()
  const stagePath =
    existing?.stagePath ??
    join(
      dirname(options.sourcePath),
      `.${options.sessionId}.migration-${migrationId}.stage`,
    )
  const legacyPath =
    existing?.retainedLegacyPath ??
    `${options.sourcePath}.legacy-${migrationId}`
  const manifest: Manifest = {
    version: 1,
    migrationId,
    sessionId: options.sessionId,
    sourcePath: options.sourcePath,
    activeNativePath: options.sourcePath,
    retainedLegacyPath: legacyPath,
    stagePath,
    status: 'prepared',
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sourceByteHash: hash(source),
  }
  if (await exists(legacyPath))
    return {
      ...inspected,
      status: 'blocked',
      issue: `Refusing to overwrite retained legacy file: ${legacyPath}`,
      manifestPath,
      legacyPath,
    }
  await writeFileAtomically(stagePath, bytes.toString('utf8'))
  await new NativeTranscriptStore({
    transcriptFile: stagePath,
    lockFile: `${stagePath}.lock`,
  }).load()
  await writeFileAtomically(manifestPath, manifestBytes(manifest))
  await rename(options.sourcePath, legacyPath)
  await rename(stagePath, options.sourcePath)
  manifest.status = 'published'
  manifest.updatedAt = new Date().toISOString()
  await writeFileAtomically(manifestPath, manifestBytes(manifest))
  return {
    ...inspected,
    status: 'migrated',
    manifestPath,
    legacyPath,
    nativePath: options.sourcePath,
  }
}

export async function rollbackNativeTranscript(options: {
  sourcePath: string
  sessionId: string
}): Promise<NativeTranscriptMigrationReport> {
  const manifestPath = manifestFor(options.sourcePath)
  const manifest = await readManifest(manifestPath)
  if (!manifest || manifest.status !== 'published')
    return reportBase(options.sourcePath, options.sessionId, {
      status: 'blocked',
      manifestPath,
      issue: 'No published migration to roll back',
    })
  const convertedPath = `${options.sourcePath}.praxis-${manifest.migrationId}`
  if (!(await regular(manifest.retainedLegacyPath)))
    return reportBase(options.sourcePath, options.sessionId, {
      status: 'blocked',
      manifestPath,
      issue:
        'Retained legacy file is missing or not a regular file; active native was left untouched',
    })
  const legacyBytes = await readFile(manifest.retainedLegacyPath)
  if (hash(legacyBytes) !== manifest.sourceByteHash)
    return reportBase(options.sourcePath, options.sessionId, {
      status: 'blocked',
      manifestPath,
      issue:
        'Retained legacy file hash does not match migration manifest; active native was left untouched',
    })
  if (await exists(convertedPath))
    return reportBase(options.sourcePath, options.sessionId, {
      status: 'blocked',
      manifestPath,
      issue: `Refusing to overwrite retained native file: ${convertedPath}`,
    })
  await rename(options.sourcePath, convertedPath)
  try {
    await rename(manifest.retainedLegacyPath, options.sourcePath)
  } catch (error) {
    if (!(await exists(options.sourcePath)) && (await regular(convertedPath)))
      await rename(convertedPath, options.sourcePath)
    throw error
  }
  manifest.status = 'rolled-back'
  manifest.updatedAt = new Date().toISOString()
  await writeFileAtomically(manifestPath, manifestBytes(manifest))
  const legacy = await readFile(options.sourcePath)
  return {
    sourcePath: options.sourcePath,
    sessionId: options.sessionId,
    status: 'rolled-back',
    eventCount: 0,
    validPrefixByteLength: legacy.length,
    manifestPath,
    legacyPath: options.sourcePath,
    nativePath: convertedPath,
  }
}

export async function discoverNativeTranscriptSessions(
  nativeRoot: string,
): Promise<readonly { sessionId: string; path: string }[]> {
  const root = resolve(nativeRoot)
  const sessions = join(root, 'sessions')
  let sessionsRoot: string
  try {
    sessionsRoot = await realpath(sessions)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const result: { sessionId: string; path: string }[] = []
  async function walk(dir: string): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        const target = await realpath(path)
        if (
          target !== sessionsRoot &&
          !target.startsWith(`${sessionsRoot}${sep}`)
        )
          throw new Error(`Symlink escapes native sessions root: ${path}`)
        continue
      }
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        const sessionId = entry.name.slice(0, -6)
        if (isSessionId(sessionId)) result.push({ sessionId, path })
      }
    }
  }
  await walk(sessions)
  return result.sort((a, b) => a.path.localeCompare(b.path))
}
