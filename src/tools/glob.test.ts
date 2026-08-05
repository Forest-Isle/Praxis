import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { globFiles } from './glob.js'

const roots: string[] = []

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'praxis-glob-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe('globFiles', () => {
  it('matches hidden and ignored files recursively and sorts oldest first', async () => {
    const root = await fixtureRoot()
    await mkdir(join(root, 'src', '.hidden'), { recursive: true })
    await Promise.all([
      writeFile(join(root, '.gitignore'), 'ignored.ts\n'),
      writeFile(join(root, 'ignored.ts'), ''),
      writeFile(join(root, 'src', 'old.ts'), ''),
      writeFile(join(root, 'src', 'new.ts'), ''),
      writeFile(join(root, 'src', '.hidden', 'secret.ts'), ''),
    ])
    await Promise.all([
      utimes(join(root, 'src', 'old.ts'), 1_000, 1_000),
      utimes(join(root, 'src', '.hidden', 'secret.ts'), 2_000, 2_000),
      utimes(join(root, 'src', 'new.ts'), 3_000, 3_000),
      utimes(join(root, 'ignored.ts'), 4_000, 4_000),
    ])
    await symlink(join(root, 'src', 'old.ts'), join(root, 'linked.ts'))

    await expect(
      globFiles({
        root,
        displayRoot: '.',
        absoluteRoot: root,
        pattern: '*.ts',
      }),
    ).resolves.toBe('src/old.ts\nsrc/.hidden/secret.ts\nsrc/new.ts\nignored.ts')
    await expect(
      globFiles({
        root,
        displayRoot: '.',
        absoluteRoot: root,
        pattern: 'src/{old,new}.ts',
      }),
    ).resolves.toBe('src/old.ts\nsrc/new.ts')
    await expect(
      globFiles({
        root,
        displayRoot: '.',
        absoluteRoot: root,
        pattern: 'src/@(old|new).ts',
      }),
    ).resolves.toBe('No files found')
  })

  it('supports absolute patterns and empty patterns', async () => {
    const root = await fixtureRoot()
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'src', 'index.ts'), '')

    await expect(
      globFiles({
        root,
        displayRoot: '.',
        absoluteRoot: root,
        pattern: `${root}/**/*.ts`,
      }),
    ).resolves.toBe(`${root}/src/index.ts`)
    await expect(
      globFiles({
        root,
        displayRoot: '.',
        absoluteRoot: root,
        pattern: '',
      }),
    ).resolves.toBe('src/index.ts')
  })

  it('caps results at 100 with the Claude-compatible count suffix', async () => {
    const root = await fixtureRoot()
    await mkdir(join(root, 'many'))
    await Promise.all(
      Array.from({ length: 102 }, async (_, index) => {
        const path = join(root, 'many', `${String(index).padStart(3, '0')}.txt`)
        await writeFile(path, '')
        await utimes(path, 1_000 + index, 1_000 + index)
      }),
    )

    const result = await globFiles({
      root,
      displayRoot: '.',
      absoluteRoot: root,
      pattern: 'many/*.txt',
    })
    const lines = result.split('\n')
    expect(lines).toHaveLength(101)
    expect(lines[0]).toBe('many/000.txt')
    expect(lines[99]).toBe('many/099.txt')
    expect(lines[100]).toBe(
      '(Showing 100 of 102 matching files; 2 more are not listed. Narrow the pattern or path to see the rest.)',
    )
  })

  it('returns the no-match result and observes cancellation', async () => {
    const root = await fixtureRoot()
    await expect(
      globFiles({
        root,
        displayRoot: '.',
        absoluteRoot: root,
        pattern: '*.ts',
      }),
    ).resolves.toBe('No files found')

    const controller = new AbortController()
    controller.abort()
    await expect(
      globFiles({
        root,
        displayRoot: '.',
        absoluteRoot: root,
        pattern: '',
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })
})
