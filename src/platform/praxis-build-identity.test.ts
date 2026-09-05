import { execFile } from 'node:child_process'
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  truncate,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it } from 'vitest'

import {
  loadPraxisBuildIdentity,
  validatePraxisBuildIdentity,
  writePraxisBuildIdentity,
} from './praxis-build-identity.js'

const run = promisify(execFile)
const roots: string[] = []

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

async function writeRuntime(output: string, value = 'one'): Promise<void> {
  await mkdir(join(output, 'nested'), { recursive: true })
  await Promise.all([
    writeFile(join(output, 'cli.js'), `export const value = '${value}'\n`),
    writeFile(join(output, 'nested', 'worker.js'), 'export const worker = 1\n'),
    writeFile(join(output, 'nested', 'worker.d.ts'), 'export {}\n'),
  ])
}

async function git(root: string, ...args: string[]): Promise<string> {
  return (
    await run('git', ['-C', root, ...args], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    })
  ).stdout.trim()
}

async function commit(root: string, message: string): Promise<void> {
  await git(root, 'add', '.')
  await git(
    root,
    '-c',
    'user.name=Praxis Test',
    '-c',
    'user.email=praxis@example.invalid',
    'commit',
    '--quiet',
    '-m',
    message,
  )
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe('Praxis build identity', () => {
  it('is path-independent and revalidates a non-Git emitted runtime', async () => {
    const source = await temporaryRoot('praxis-build-source-')
    const firstOutput = await temporaryRoot('praxis-build-first-')
    const secondOutput = await temporaryRoot('praxis-build-second-')
    await Promise.all([writeRuntime(firstOutput), writeRuntime(secondOutput)])

    const first = await writePraxisBuildIdentity({
      sourceRoot: source,
      outputRoot: firstOutput,
    })
    const second = await writePraxisBuildIdentity({
      sourceRoot: source,
      outputRoot: secondOutput,
    })

    expect(first).toEqual(second)
    expect(first.source_revision).toBe('unavailable')
    expect(first.source_dirty).toBeNull()
    expect(await loadPraxisBuildIdentity(firstOutput)).toEqual(first)
    const raw = await readFile(join(firstOutput, 'build-identity.json'), 'utf8')
    expect(raw).toMatch(/\n$/u)
    expect(raw).not.toContain(source)
    expect(raw).not.toContain(firstOutput)
  })

  it('captures clean revisions and distinguishes a dirty worktree', async () => {
    const source = await temporaryRoot('praxis-build-git-')
    const output = await temporaryRoot('praxis-build-output-')
    await writeRuntime(output)
    await git(source, 'init', '--quiet')
    await writeFile(join(source, 'source.txt'), 'first\n')
    await commit(source, 'first')

    const first = await writePraxisBuildIdentity({
      sourceRoot: source,
      outputRoot: output,
    })
    expect(first.source_revision).toBe(
      `git:${await git(source, 'rev-parse', 'HEAD')}`,
    )
    expect(first.source_dirty).toBe(false)

    await writeFile(join(source, 'source.txt'), 'second\n')
    await commit(source, 'second')
    const second = await writePraxisBuildIdentity({
      sourceRoot: source,
      outputRoot: output,
    })
    expect(second.source_revision).not.toBe(first.source_revision)
    expect(second.source_dirty).toBe(false)
    expect(second.artifact_sha256).toBe(first.artifact_sha256)

    await writeFile(join(source, 'source.txt'), 'dirty\n')
    const dirty = await writePraxisBuildIdentity({
      sourceRoot: source,
      outputRoot: output,
    })
    expect(dirty.source_revision).toBe(second.source_revision)
    expect(dirty.source_dirty).toBe(true)
  })

  it('changes the artifact digest when emitted JavaScript changes', async () => {
    const source = await temporaryRoot('praxis-build-source-')
    const output = await temporaryRoot('praxis-build-output-')
    await writeRuntime(output)
    const first = await writePraxisBuildIdentity({
      sourceRoot: source,
      outputRoot: output,
    })

    await writeRuntime(output, 'two')
    const second = await writePraxisBuildIdentity({
      sourceRoot: source,
      outputRoot: output,
    })
    expect(second.artifact_sha256).not.toBe(first.artifact_sha256)

    await writeFile(join(output, 'cli.js'), 'tampered\n')
    await expect(loadPraxisBuildIdentity(output)).rejects.toThrow(
      'artifact_sha256 does not match emitted JavaScript',
    )
  })

  it('rejects missing, malformed, oversized, and unknown metadata', async () => {
    const source = await temporaryRoot('praxis-build-source-')
    const output = await temporaryRoot('praxis-build-output-')
    await writeRuntime(output)
    await expect(loadPraxisBuildIdentity(output)).rejects.toThrow(
      'metadata is missing or unreadable',
    )

    const metadata = join(output, 'build-identity.json')
    await writeFile(metadata, '{')
    await expect(loadPraxisBuildIdentity(output)).rejects.toThrow(
      'metadata is not valid JSON',
    )

    const valid = await writePraxisBuildIdentity({
      sourceRoot: source,
      outputRoot: output,
    })
    await writeFile(metadata, JSON.stringify({ ...valid, unexpected: true }))
    await expect(loadPraxisBuildIdentity(output)).rejects.toThrow(
      'unexpected is not supported',
    )

    await writeFile(metadata, 'x'.repeat(64 * 1024 + 1))
    await expect(loadPraxisBuildIdentity(output)).rejects.toThrow(
      'metadata exceeds 64 KiB',
    )
  })

  it('strictly validates revision, dirty-state, and artifact fields', () => {
    const digest = `sha256:${'a'.repeat(64)}`
    expect(() =>
      validatePraxisBuildIdentity({
        schema_version: '1.0',
        source_revision: 'unavailable',
        source_dirty: false,
        artifact_sha256: digest,
      }),
    ).toThrow('source_dirty must be null')
    expect(() =>
      validatePraxisBuildIdentity({
        schema_version: '1.0',
        source_revision: 'git:not-a-revision',
        source_dirty: false,
        artifact_sha256: digest,
      }),
    ).toThrow('source_revision is invalid')
    expect(() =>
      validatePraxisBuildIdentity({
        schema_version: '1.0',
        source_revision: 'unavailable',
        source_dirty: null,
        artifact_sha256: 'sha256:invalid',
      }),
    ).toThrow('artifact_sha256 must be a sha256 digest')
  })

  it('rejects an emitted tree with no JavaScript', async () => {
    const source = await temporaryRoot('praxis-build-source-')
    const output = await temporaryRoot('praxis-build-output-')
    await writeFile(join(output, 'types.d.ts'), 'export {}\n')
    await expect(
      writePraxisBuildIdentity({ sourceRoot: source, outputRoot: output }),
    ).rejects.toThrow('contains no JavaScript files')
  })

  it('rejects an oversized JavaScript file before reading its contents', async () => {
    const source = await temporaryRoot('praxis-build-source-')
    const output = await temporaryRoot('praxis-build-output-')
    const oversized = join(output, 'oversized.js')
    await writeFile(oversized, '')
    await truncate(oversized, 512 * 1024 * 1024 + 1)
    await expect(
      writePraxisBuildIdentity({ sourceRoot: source, outputRoot: output }),
    ).rejects.toThrow('emitted runtime tree exceeds byte limit')
  })
})
