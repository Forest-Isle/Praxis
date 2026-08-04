import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { LocalToolRegistry } from './local-tools.js'

const roots: string[] = []

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'praxis-tools-'))
  roots.push(root)
  const cwd = join(root, 'workspace')
  await mkdir(cwd)
  return { root, cwd }
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  )
})

describe('LocalToolRegistry', () => {
  it('provides bounded read, write, edit, search, and shell tools', async () => {
    const { cwd } = await workspace()
    await writeFile(join(cwd, 'source.txt'), 'alpha\nbeta\nalpha\n')
    const registry = new LocalToolRegistry({ cwd, maxOutputBytes: 64 })
    const context = { cwd }

    expect(registry.definitions().map((tool) => tool.name)).toEqual([
      'Read',
      'Write',
      'Edit',
      'Grep',
      'Bash',
    ])

    const read = await registry.prepare(
      {
        id: 'read',
        name: 'Read',
        input: { file_path: 'source.txt', offset: 2, limit: 1 },
      },
      context,
    )
    expect(read.input.file_path).toBe(await realpath(join(cwd, 'source.txt')))
    await expect(registry.execute(read, context)).resolves.toEqual({
      content: 'beta',
      isError: false,
      accessedPaths: [await realpath(join(cwd, 'source.txt'))],
    })

    const write = await registry.prepare(
      {
        id: 'write',
        name: 'Write',
        input: { file_path: 'output.txt', content: 'before' },
      },
      context,
    )
    await expect(registry.execute(write, context)).resolves.toMatchObject({
      isError: false,
    })
    const edit = await registry.prepare(
      {
        id: 'edit',
        name: 'Edit',
        input: {
          file_path: 'output.txt',
          old_string: 'before',
          new_string: 'after',
        },
      },
      context,
    )
    await expect(registry.execute(edit, context)).resolves.toMatchObject({
      isError: false,
    })
    await expect(readFile(join(cwd, 'output.txt'), 'utf8')).resolves.toBe(
      'after',
    )

    const grep = await registry.prepare(
      {
        id: 'grep',
        name: 'Grep',
        input: { pattern: 'alpha', path: '.' },
      },
      context,
    )
    const grepResult = await registry.execute(grep, context)
    expect(grepResult).toMatchObject({ isError: false })
    expect(grepResult.content).toContain('source.txt:1:alpha')

    const shell = await registry.prepare(
      {
        id: 'shell',
        name: 'Bash',
        input: { command: 'printf shell-ok' },
      },
      context,
    )
    await expect(registry.execute(shell, context)).resolves.toEqual({
      content: 'shell-ok',
      isError: false,
    })
  })

  it('rejects lexical and symlink paths outside the workspace', async () => {
    const { root, cwd } = await workspace()
    const outside = join(root, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'secret.txt'), 'secret')
    await symlink(outside, join(cwd, 'escape'))
    const registry = new LocalToolRegistry({ cwd })

    await expect(
      registry.prepare(
        {
          id: 'traversal',
          name: 'Read',
          input: { file_path: '../outside/secret.txt' },
        },
        { cwd },
      ),
    ).rejects.toThrow('outside workspace')
    await expect(
      registry.prepare(
        {
          id: 'symlink',
          name: 'Read',
          input: { file_path: 'escape/secret.txt' },
        },
        { cwd },
      ),
    ).rejects.toThrow('outside workspace')

    const protectedPath = join(cwd, 'protected.txt')
    await writeFile(protectedPath, 'keep')
    const approved = await registry.prepare(
      {
        id: 'swapped',
        name: 'Write',
        input: { file_path: 'approved.txt', content: 'overwrite' },
      },
      { cwd },
    )
    await symlink(protectedPath, join(cwd, 'approved.txt'))
    await expect(registry.execute(approved, { cwd })).rejects.toThrow(
      'changed after permission approval',
    )
    await expect(readFile(protectedPath, 'utf8')).resolves.toBe('keep')
  })

  it('limits standard file tools to the workspace and configured shared roots', async () => {
    const { root, cwd } = await workspace()
    const memoryDirectory = join(root, 'config', 'projects', 'key', 'memory')
    const outside = join(root, 'outside')
    await Promise.all([
      mkdir(memoryDirectory, { recursive: true }),
      mkdir(outside),
    ])
    await Promise.all([
      writeFile(join(memoryDirectory, 'details.md'), 'shared detail'),
      writeFile(join(outside, 'secret.md'), 'secret'),
    ])
    await symlink(outside, join(memoryDirectory, 'escape'))
    const registry = new LocalToolRegistry({
      cwd,
      sharedMemoryDirectory: memoryDirectory,
    })
    const context = { cwd }

    expect(
      registry.definitions().find((tool) => tool.name === 'Read')?.description,
    ).toContain(memoryDirectory)
    const read = await registry.prepare(
      {
        id: 'memory-read',
        name: 'Read',
        input: { file_path: join(memoryDirectory, 'details.md') },
      },
      context,
    )
    await expect(registry.execute(read, context)).resolves.toMatchObject({
      content: 'shared detail',
      isError: false,
    })
    const write = await registry.prepare(
      {
        id: 'memory-write',
        name: 'Write',
        input: {
          file_path: join(memoryDirectory, 'praxis.md'),
          content: 'created by Praxis',
        },
      },
      context,
    )
    await registry.execute(write, context)
    const edit = await registry.prepare(
      {
        id: 'memory-edit',
        name: 'Edit',
        input: {
          file_path: join(memoryDirectory, 'praxis.md'),
          old_string: 'Praxis',
          new_string: 'Claude and Praxis',
        },
      },
      context,
    )
    await registry.execute(edit, context)
    await expect(
      readFile(join(memoryDirectory, 'praxis.md'), 'utf8'),
    ).resolves.toBe('created by Claude and Praxis')

    await expect(
      registry.prepare(
        {
          id: 'outside-read',
          name: 'Read',
          input: { file_path: join(outside, 'secret.md') },
        },
        context,
      ),
    ).rejects.toThrow('outside workspace')
    await expect(
      registry.prepare(
        {
          id: 'memory-symlink',
          name: 'Read',
          input: { file_path: join(memoryDirectory, 'escape', 'secret.md') },
        },
        context,
      ),
    ).rejects.toThrow('outside workspace')
    await expect(
      registry.prepare(
        {
          id: 'outside-grep',
          name: 'Grep',
          input: { pattern: 'shared', path: memoryDirectory },
        },
        context,
      ),
    ).rejects.toThrow('outside workspace')
  })

  it('bounds shell output, times out, and propagates cancellation', async () => {
    const { cwd } = await workspace()
    const registry = new LocalToolRegistry({
      cwd,
      maxOutputBytes: 16,
      maxShellTimeoutMs: 100,
    })

    const bounded = await registry.prepare(
      {
        id: 'bounded',
        name: 'Bash',
        input: { command: "printf '12345678901234567890'" },
      },
      { cwd },
    )
    const boundedResult = await registry.execute(bounded, { cwd })
    expect(boundedResult.content).toBe('1234567890123456\n[output truncated]')

    const timeout = await registry.prepare(
      {
        id: 'timeout',
        name: 'Bash',
        input: { command: 'sleep 1', timeout: 20 },
      },
      { cwd },
    )
    await expect(registry.execute(timeout, { cwd })).resolves.toEqual({
      content: 'Command timed out after 20ms',
      isError: true,
    })

    const controller = new AbortController()
    const cancelled = await registry.prepare(
      {
        id: 'cancelled',
        name: 'Bash',
        input: { command: 'sleep 1' },
      },
      { cwd, signal: controller.signal },
    )
    const execution = registry.execute(cancelled, {
      cwd,
      signal: controller.signal,
    })
    controller.abort()
    await expect(execution).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('rejects edits whose replacement output exceeds the file bound', async () => {
    const { cwd } = await workspace()
    await writeFile(join(cwd, 'expand.txt'), 'aaaa')
    const registry = new LocalToolRegistry({ cwd, maxFileBytes: 10 })
    const edit = await registry.prepare(
      {
        id: 'expand',
        name: 'Edit',
        input: {
          file_path: 'expand.txt',
          old_string: 'a',
          new_string: 'long',
          replace_all: true,
        },
      },
      { cwd },
    )

    await expect(registry.execute(edit, { cwd })).rejects.toThrow(
      'Edited content exceeds 10 bytes',
    )
  })
})
