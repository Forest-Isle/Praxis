import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

export const PRAXIS_BUILD_IDENTITY_SCHEMA_VERSION = '1.0' as const

export interface PraxisBuildIdentity {
  schema_version: typeof PRAXIS_BUILD_IDENTITY_SCHEMA_VERSION
  source_revision: `git:${string}` | 'unavailable'
  source_dirty: boolean | null
  artifact_sha256: `sha256:${string}`
}

const execFileAsync = promisify(execFile)
const DIGEST = /^sha256:[0-9a-f]{64}$/u
const REVISION = /^git:[0-9a-f]{40}$/u
const MAX_BYTES = 512 * 1024 * 1024
const MAX_FILES = 10_000
const MAX_DEPTH = 32
const MAX_METADATA_BYTES = 64 * 1024

function invalid(message: string): never {
  throw new Error(`Invalid Praxis build identity: ${message}`)
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

async function artifactEntries(
  outputRoot: string,
): Promise<Array<{ path: string; sha256: `sha256:${string}` }>> {
  const entries: Array<{ path: string; sha256: `sha256:${string}` }> = []
  let totalBytes = 0

  async function hashFile(path: string): Promise<`sha256:${string}`> {
    const handle = await fs.open(path, 'r')
    const hash = createHash('sha256')
    const buffer = Buffer.alloc(64 * 1024)
    try {
      const stat = await handle.stat()
      if (!stat.isFile())
        invalid('emitted runtime tree contains a non-regular JavaScript file')
      if (stat.size > MAX_BYTES - totalBytes)
        invalid('emitted runtime tree exceeds byte limit')
      let fileBytes = 0
      while (true) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
        if (bytesRead === 0) break
        fileBytes += bytesRead
        if (fileBytes > MAX_BYTES - totalBytes)
          invalid('emitted runtime tree exceeds byte limit')
        hash.update(buffer.subarray(0, bytesRead))
      }
      totalBytes += fileBytes
      return `sha256:${hash.digest('hex')}`
    } finally {
      await handle.close()
    }
  }

  async function visit(directory: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH) invalid('emitted runtime tree exceeds depth limit')
    const children = await fs.readdir(directory, { withFileTypes: true })
    for (const child of children) {
      const fullPath = join(directory, child.name)
      if (child.isSymbolicLink())
        invalid(`emitted runtime tree contains symlink ${child.name}`)
      if (child.isDirectory()) {
        await visit(fullPath, depth + 1)
        continue
      }
      if (!child.isFile())
        invalid(`emitted runtime tree contains unsupported entry ${child.name}`)
      if (!child.name.endsWith('.js')) continue
      entries.push({
        path: relative(outputRoot, fullPath).split(sep).join('/'),
        sha256: await hashFile(fullPath),
      })
      if (entries.length > MAX_FILES)
        invalid('emitted runtime tree exceeds file limit')
    }
  }
  await visit(outputRoot, 0)
  if (entries.length === 0)
    invalid('emitted runtime tree contains no JavaScript files')
  entries.sort((left, right) => codeUnitCompare(left.path, right.path))
  return entries
}

async function artifactDigest(outputRoot: string): Promise<`sha256:${string}`> {
  const entries = await artifactEntries(outputRoot)
  return `sha256:${createHash('sha256').update(JSON.stringify(entries), 'utf8').digest('hex')}`
}

async function sourceState(sourceRoot: string): Promise<{
  revision: PraxisBuildIdentity['source_revision']
  dirty: boolean | null
}> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', sourceRoot, 'rev-parse', '--verify', 'HEAD'],
      { encoding: 'utf8' },
    )
    const revision = stdout.trim()
    if (!/^[0-9a-f]{40}$/u.test(revision))
      return { revision: 'unavailable', dirty: null }
    let status: string
    try {
      const result = await execFileAsync(
        'git',
        ['-C', sourceRoot, 'status', '--porcelain=v1', '--untracked-files=all'],
        { encoding: 'utf8' },
      )
      status = result.stdout
    } catch (error) {
      throw new Error(
        `unable to read Git status: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    return { revision: `git:${revision}`, dirty: status.length > 0 }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith('unable to read Git status:')
    )
      throw error
    return { revision: 'unavailable', dirty: null }
  }
}

export async function writePraxisBuildIdentity({
  sourceRoot,
  outputRoot,
}: {
  sourceRoot: string
  outputRoot: string
}): Promise<PraxisBuildIdentity> {
  const state = await sourceState(resolve(sourceRoot))
  const identity: PraxisBuildIdentity = {
    schema_version: PRAXIS_BUILD_IDENTITY_SCHEMA_VERSION,
    source_revision: state.revision,
    source_dirty: state.dirty,
    artifact_sha256: await artifactDigest(resolve(outputRoot)),
  }
  const target = join(resolve(outputRoot), 'build-identity.json')
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(temporary, `${JSON.stringify(identity)}\n`, {
    encoding: 'utf8',
    mode: 0o644,
  })
  await fs.rename(temporary, target)
  return identity
}

export function validatePraxisBuildIdentity(
  value: unknown,
): PraxisBuildIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    invalid('metadata must be an object')
  const source = value as Record<string, unknown>
  const keys = [
    'schema_version',
    'source_revision',
    'source_dirty',
    'artifact_sha256',
  ]
  const unknown = Object.keys(source).find((key) => !keys.includes(key))
  if (unknown) invalid(`${unknown} is not supported`)
  if (source.schema_version !== PRAXIS_BUILD_IDENTITY_SCHEMA_VERSION)
    invalid('schema_version must be "1.0"')
  if (
    typeof source.source_revision !== 'string' ||
    (source.source_revision !== 'unavailable' &&
      !REVISION.test(source.source_revision))
  )
    invalid('source_revision is invalid')
  if (source.source_revision === 'unavailable') {
    if (source.source_dirty !== null)
      invalid('source_dirty must be null when source_revision is unavailable')
  } else if (typeof source.source_dirty !== 'boolean')
    invalid('source_dirty must be boolean for an available source revision')
  if (
    typeof source.artifact_sha256 !== 'string' ||
    !DIGEST.test(source.artifact_sha256)
  )
    invalid('artifact_sha256 must be a sha256 digest')
  return Object.freeze({
    schema_version: PRAXIS_BUILD_IDENTITY_SCHEMA_VERSION,
    source_revision:
      source.source_revision as PraxisBuildIdentity['source_revision'],
    source_dirty: source.source_dirty as boolean | null,
    artifact_sha256: source.artifact_sha256 as `sha256:${string}`,
  })
}

export async function loadPraxisBuildIdentity(
  outputRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../dist'),
): Promise<PraxisBuildIdentity> {
  const target = join(resolve(outputRoot), 'build-identity.json')
  let raw: string
  try {
    const handle = await fs.open(target, 'r')
    try {
      const stat = await handle.stat()
      if (!stat.isFile()) invalid('metadata is not a regular file')
      const buffer = Buffer.alloc(MAX_METADATA_BYTES + 1)
      let bytesRead = 0
      while (bytesRead < buffer.length) {
        const result = await handle.read(
          buffer,
          bytesRead,
          buffer.length - bytesRead,
          bytesRead,
        )
        if (result.bytesRead === 0) break
        bytesRead += result.bytesRead
      }
      if (bytesRead > MAX_METADATA_BYTES || stat.size > MAX_METADATA_BYTES)
        invalid('metadata exceeds 64 KiB')
      raw = buffer.subarray(0, bytesRead).toString('utf8')
    } finally {
      await handle.close()
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith('Invalid Praxis build identity:')
    )
      throw error
    invalid('metadata is missing or unreadable')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    invalid('metadata is not valid JSON')
  }
  const identity = validatePraxisBuildIdentity(parsed)
  const actual = await artifactDigest(resolve(outputRoot))
  if (actual !== identity.artifact_sha256)
    invalid('artifact_sha256 does not match emitted JavaScript')
  return identity
}
