import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  completeTuiWorkspaceDirectory,
  resolveTuiWorkspaceDirectory,
} from './workspace-directories.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe('TUI workspace directories', () => {
  it('resolves existing directories and rejects files or missing input', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-workspace-directory-'))
    roots.push(root)
    const nested = join(root, 'nested')
    await mkdir(nested)
    await writeFile(join(root, 'file.txt'), 'fixture')

    await expect(resolveTuiWorkspaceDirectory('./nested', root)).resolves.toBe(
      await realpath(nested),
    )
    await expect(resolveTuiWorkspaceDirectory('', root)).rejects.toThrow(
      'Enter a directory path',
    )
    await expect(
      resolveTuiWorkspaceDirectory('./file.txt', root),
    ).rejects.toThrow('Not a directory')
  })

  it('completes a unique directory and preserves ambiguous input', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-workspace-directory-'))
    roots.push(root)
    await mkdir(join(root, 'shared'))
    await mkdir(join(root, 'shell'))

    await expect(completeTuiWorkspaceDirectory('./sha', root)).resolves.toBe(
      './shared/',
    )
    await expect(completeTuiWorkspaceDirectory('./sh', root)).resolves.toBe(
      './sh',
    )
  })
})
