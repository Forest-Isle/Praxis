import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createClaudeTranscriptCodec } from '../compatibility/claude/transcript-codec.js'
import { readNativeTranscript } from './native-transcript-reader.js'
import {
  discoverNativeTranscriptSessions,
  migrateNativeTranscript,
  rollbackNativeTranscript,
} from './native-transcript-migration.js'

const sessionId = '11111111-1111-4111-8111-111111111111'
const roots: string[] = []

async function fixture(): Promise<{
  root: string
  sourcePath: string
  source: Buffer
}> {
  const root = await mkdtemp(join(tmpdir(), 'praxis-native-migration-'))
  roots.push(root)
  const directory = join(root, 'sessions', 'project')
  await mkdir(directory, { recursive: true })
  const codec = createClaudeTranscriptCodec({
    version: '2.1.208',
    cwd: root,
    entrypoint: 'cli',
  })
  const encoded = codec.encodeLine({
    kind: 'messages',
    id: 'event-1',
    parentId: null,
    sessionId,
    timestamp: '2026-08-25T00:00:00.000Z',
    messages: [{ role: 'user', content: 'hello migration' }],
  })
  if (!encoded.ok) throw new Error(encoded.issue.message)
  const source = Buffer.from(`${encoded.line}\n`)
  const sourcePath = join(directory, `${sessionId}.jsonl`)
  await writeFile(sourcePath, source)
  return { root, sourcePath, source }
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  )
})

describe('native transcript migration', () => {
  it('keeps dry-run side-effect free and migrates idempotently', async () => {
    const { sourcePath, source } = await fixture()
    const dryRun = await migrateNativeTranscript({
      sourcePath,
      sessionId,
      dryRun: true,
    })
    expect(dryRun).toMatchObject({
      status: 'convertible',
      eventCount: 1,
      validPrefixByteLength: source.length,
    })
    expect(await readFile(sourcePath)).toEqual(source)
    expect((await readdir(join(sourcePath, '..'))).sort()).toEqual([
      `${sessionId}.jsonl`,
    ])

    const migrated = await migrateNativeTranscript({ sourcePath, sessionId })
    expect(migrated).toMatchObject({
      status: 'migrated',
      eventCount: 1,
      legacyPath: expect.any(String),
      manifestPath: `${sourcePath}.migration.json`,
    })
    if (!migrated.legacyPath) throw new Error('missing retained legacy path')
    expect(await readFile(migrated.legacyPath)).toEqual(source)
    const native = await readNativeTranscript(sourcePath)
    expect(native).toMatchObject({ format: 'native', issue: null })
    const activeBytes = await readFile(sourcePath)
    const repeat = await migrateNativeTranscript({ sourcePath, sessionId })
    expect(repeat.status).toBe('already-migrated')
    expect(await readFile(sourcePath)).toEqual(activeBytes)
  })

  it('rolls back without deleting either representation', async () => {
    const { sourcePath, source } = await fixture()
    const migrated = await migrateNativeTranscript({ sourcePath, sessionId })
    if (!migrated.nativePath || !migrated.legacyPath)
      throw new Error('migration did not return retained paths')
    const converted = await readFile(sourcePath)
    const rolledBack = await rollbackNativeTranscript({ sourcePath, sessionId })
    expect(rolledBack).toMatchObject({
      status: 'rolled-back',
    })
    expect(rolledBack.nativePath).toMatch(
      new RegExp(`${sourcePath}\\.praxis-[0-9a-f-]+$`, 'u'),
    )
    expect(await readFile(sourcePath)).toEqual(source)
    expect(await readFile(rolledBack.nativePath as string)).toEqual(converted)
    await expect(lstat(migrated.legacyPath)).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('blocks rollback when retained legacy is missing without moving active native', async () => {
    const { sourcePath } = await fixture()
    const migrated = await migrateNativeTranscript({ sourcePath, sessionId })
    if (!migrated.legacyPath) throw new Error('missing retained legacy path')
    await rm(migrated.legacyPath)
    const before = await readFile(sourcePath)
    const rolledBack = await rollbackNativeTranscript({ sourcePath, sessionId })
    expect(rolledBack).toMatchObject({ status: 'blocked' })
    expect(rolledBack.issue).toMatch(/retained legacy/i)
    expect(await readFile(sourcePath)).toEqual(before)
  })

  it('recovers a prepared manifest after publication completed before manifest update', async () => {
    const { sourcePath } = await fixture()
    const migrated = await migrateNativeTranscript({ sourcePath, sessionId })
    if (!migrated.legacyPath || !migrated.manifestPath)
      throw new Error('migration did not return manifest paths')
    const manifest = JSON.parse(await readFile(migrated.manifestPath, 'utf8'))
    manifest.status = 'prepared'
    await writeFile(migrated.manifestPath, `${JSON.stringify(manifest)}\n`)
    const recovered = await migrateNativeTranscript({ sourcePath, sessionId })
    expect(recovered.status).toBe('already-migrated')
    expect(await readNativeTranscript(sourcePath)).toMatchObject({
      format: 'native',
    })
    expect(
      JSON.parse(await readFile(migrated.manifestPath, 'utf8')).status,
    ).toBe('published')
  })

  it('blocks corrupt legacy input and retained-path collisions without debris', async () => {
    const { root, sourcePath } = await fixture()
    await writeFile(sourcePath, '{not-json\n')
    const corrupt = await migrateNativeTranscript({ sourcePath, sessionId })
    expect(corrupt.status).toBe('corrupt')
    expect(await readFile(sourcePath, 'utf8')).toBe('{not-json\n')
    await expect(lstat(`${sourcePath}.migration.json`)).rejects.toMatchObject({
      code: 'ENOENT',
    })

    const valid = await fixture()
    const migrationId = 'collision'
    const legacyPath = `${valid.sourcePath}.legacy-${migrationId}`
    await writeFile(legacyPath, 'reserved')
    await writeFile(
      `${valid.sourcePath}.migration.json`,
      `${JSON.stringify({
        version: 1,
        migrationId,
        sessionId,
        sourcePath: valid.sourcePath,
        activeNativePath: valid.sourcePath,
        retainedLegacyPath: legacyPath,
        stagePath: join(root, '.unused-stage'),
        status: 'prepared',
        createdAt: '2026-08-25T00:00:00.000Z',
        updatedAt: '2026-08-25T00:00:00.000Z',
        sourceByteHash: 'hash',
      })}\n`,
    )
    const blocked = await migrateNativeTranscript({
      sourcePath: valid.sourcePath,
      sessionId,
    })
    expect(blocked.status).toBe('blocked')
    expect(await readFile(valid.sourcePath)).not.toEqual(Buffer.alloc(0))
    expect(await readFile(legacyPath, 'utf8')).toBe('reserved')
    await expect(lstat(join(root, '.unused-stage'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('rejects symlink escapes and discovers valid native session names', async () => {
    const { root } = await fixture()
    const sessions = join(root, 'sessions')
    const outside = await mkdtemp(join(tmpdir(), 'praxis-native-outside-'))
    roots.push(outside)
    await symlink(outside, join(sessions, 'escape'))
    await expect(discoverNativeTranscriptSessions(root)).rejects.toThrow(
      /Symlink escapes native sessions root/u,
    )

    await rm(join(sessions, 'escape'))
    await writeFile(
      join(sessions, 'project', `${sessionId}.jsonl`),
      'placeholder',
    )
    const discovered = await discoverNativeTranscriptSessions(root)
    expect(discovered).toEqual([
      { sessionId, path: join(sessions, 'project', `${sessionId}.jsonl`) },
    ])
  })
})
