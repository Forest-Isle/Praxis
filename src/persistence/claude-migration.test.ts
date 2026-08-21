import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { migrateClaudeData } from './claude-migration.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  )
})

describe('Claude migration', () => {
  it('copies supported data without mutating the Claude source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-migrate-'))
    roots.push(root)
    const source = join(root, 'claude')
    const destination = join(root, 'praxis')
    await mkdir(join(source, 'projects', 'project', 'memory'), {
      recursive: true,
    })
    await writeFile(
      join(source, 'projects', 'project', 'session.jsonl'),
      'source',
    )
    await writeFile(
      join(source, 'projects', 'project', 'memory', 'MEMORY.md'),
      'memory',
    )

    await expect(
      migrateClaudeData({ sourceRoot: source, destinationRoot: destination }),
    ).resolves.toEqual(['projects', 'memory'])
    await expect(
      readFile(join(source, 'projects', 'project', 'session.jsonl'), 'utf8'),
    ).resolves.toBe('source')
    await expect(
      readFile(
        join(destination, 'sessions', 'project', 'session.jsonl'),
        'utf8',
      ),
    ).resolves.toBe('source')
    await expect(
      readFile(join(destination, 'memory', 'project', 'MEMORY.md'), 'utf8'),
    ).resolves.toBe('memory')
  })

  it('preflights every destination conflict before publishing any data', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-migrate-conflict-'))
    roots.push(root)
    const source = join(root, 'claude')
    const destination = join(root, 'praxis')
    await mkdir(join(source, 'projects', 'project'), { recursive: true })
    await mkdir(join(source, 'tasks'), { recursive: true })
    await mkdir(join(destination, 'tasks'), { recursive: true })
    await writeFile(join(source, 'projects', 'project', 'session.jsonl'), '{}')
    await writeFile(join(source, 'tasks', 'task.json'), '{}')

    await expect(
      migrateClaudeData({ sourceRoot: source, destinationRoot: destination }),
    ).rejects.toThrow(
      `Praxis migration destination already exists: ${join(destination, 'tasks')}`,
    )
    await expect(access(join(destination, 'sessions'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('rejects a destination nested inside the source without changing either tree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-migrate-overlap-dest-'))
    roots.push(root)
    const source = join(root, 'claude')
    const destination = join(source, 'praxis')
    const transcript = join(source, 'projects', 'project', 'session.jsonl')
    await mkdir(join(source, 'projects', 'project'), { recursive: true })
    await writeFile(transcript, 'source')

    await expect(
      migrateClaudeData({ sourceRoot: source, destinationRoot: destination }),
    ).rejects.toThrow('Claude source and Praxis destination must not overlap')
    await expect(readFile(transcript, 'utf8')).resolves.toBe('source')
    await expect(access(destination)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a source nested inside the destination without publishing or changing the source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-migrate-overlap-source-'))
    roots.push(root)
    const destination = join(root, 'praxis')
    const source = join(destination, 'claude-source')
    const transcript = join(source, 'projects', 'project', 'session.jsonl')
    await mkdir(join(source, 'projects', 'project'), { recursive: true })
    await writeFile(transcript, 'source')

    await expect(
      migrateClaudeData({ sourceRoot: source, destinationRoot: destination }),
    ).rejects.toThrow('Claude source and Praxis destination must not overlap')
    await expect(readFile(transcript, 'utf8')).resolves.toBe('source')
    await expect(access(join(destination, 'sessions'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('rejects physical overlap through a symlinked source parent alias', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-migrate-overlap-alias-'))
    roots.push(root)
    const actual = join(root, 'actual')
    const alias = join(root, 'alias')
    const source = join(alias, 'claude')
    const destination = join(actual, 'claude', 'praxis')
    const transcript = join(
      actual,
      'claude',
      'projects',
      'project',
      'session.jsonl',
    )
    await mkdir(dirname(transcript), { recursive: true })
    await writeFile(transcript, 'source')
    await symlink(actual, alias)

    await expect(
      migrateClaudeData({ sourceRoot: source, destinationRoot: destination }),
    ).rejects.toThrow('Claude source and Praxis destination must not overlap')
    await expect(readFile(transcript, 'utf8')).resolves.toBe('source')
    await expect(access(destination)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects symbolic links anywhere in the source without publishing data', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-migrate-symlink-'))
    roots.push(root)
    const source = join(root, 'claude')
    const destination = join(root, 'praxis')
    const outside = join(root, 'outside.jsonl')
    await mkdir(join(source, 'projects', 'project'), { recursive: true })
    await writeFile(outside, 'outside')
    const linked = join(source, 'projects', 'project', 'linked.jsonl')
    await symlink(outside, linked)

    await expect(
      migrateClaudeData({ sourceRoot: source, destinationRoot: destination }),
    ).rejects.toThrow(
      `Praxis migration refuses symbolic link source: ${linked}`,
    )
    await expect(access(destination)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a symlinked destination ancestor before staging data', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-migrate-dest-parent-'))
    roots.push(root)
    const source = join(root, 'claude')
    const outside = join(root, 'outside')
    const linkedParent = join(root, 'linked-parent')
    const destination = join(linkedParent, 'praxis')
    await mkdir(join(source, 'projects', 'project'), { recursive: true })
    await mkdir(outside, { recursive: true })
    await writeFile(join(source, 'projects', 'project', 'session.jsonl'), '{}')
    await symlink(outside, linkedParent)

    await expect(
      migrateClaudeData({ sourceRoot: source, destinationRoot: destination }),
    ).rejects.toThrow(
      `Praxis migration refuses symbolic link destination: ${linkedParent}`,
    )
    await expect(access(join(outside, 'praxis'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('rejects a symlinked destination operation root before any publish', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-migrate-dest-child-'))
    roots.push(root)
    const source = join(root, 'claude')
    const destination = join(root, 'praxis')
    const outside = join(root, 'outside')
    const memoryLink = join(destination, 'memory')
    await mkdir(join(source, 'projects', 'project', 'memory'), {
      recursive: true,
    })
    await mkdir(destination, { recursive: true })
    await mkdir(outside, { recursive: true })
    await writeFile(join(source, 'projects', 'project', 'session.jsonl'), '{}')
    await writeFile(
      join(source, 'projects', 'project', 'memory', 'MEMORY.md'),
      'memory',
    )
    await symlink(outside, memoryLink)

    await expect(
      migrateClaudeData({ sourceRoot: source, destinationRoot: destination }),
    ).rejects.toThrow(
      `Praxis migration refuses symbolic link destination: ${memoryLink}`,
    )
    await expect(access(join(destination, 'sessions'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await expect(access(join(outside, 'project'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})
