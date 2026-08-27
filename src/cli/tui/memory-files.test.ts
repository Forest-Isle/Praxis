import { mkdtemp, mkdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { loadTuiMemoryFiles, openTuiMemoryFolder } from './memory-files.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe('TUI memory files', () => {
  it('uses the canonical native worktree root and its native disable environment', async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'praxis-tui-memory-')),
    )
    roots.push(root)
    const configRoot = join(root, 'config')
    const mainRepository = join(root, 'main')
    const worktree = join(root, 'worktree')
    const gitDirectory = join(
      mainRepository,
      '.git',
      'worktrees',
      'native-memory',
    )
    await Promise.all([
      mkdir(join(mainRepository, '.git'), { recursive: true }),
      mkdir(worktree, { recursive: true }),
      mkdir(gitDirectory, { recursive: true }),
    ])
    await Promise.all([
      writeFile(join(worktree, '.git'), `gitdir: ${gitDirectory}\n`),
      writeFile(join(gitDirectory, 'commondir'), '../..\n'),
    ])

    const enabled = await loadTuiMemoryFiles({
      configRoot,
      cwd: worktree,
      environment: {},
    })
    const disabled = await loadTuiMemoryFiles({
      configRoot,
      cwd: worktree,
      environment: { PRAXIS_DISABLE_AUTO_MEMORY: '1' },
    })

    expect(enabled.entries.at(-1)).toMatchObject({
      kind: 'folder',
      path: join(configRoot, 'memory', mainRepository.replaceAll('/', '-')),
    })
    expect(disabled.autoMemoryEnabled).toBe(false)
    expect(disabled.entries.some((entry) => entry.kind === 'folder')).toBe(
      false,
    )
  })

  it('creates the canonical folder and propagates launcher failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-tui-memory-'))
    roots.push(root)
    const path = join(root, 'project-memory')
    const launcher = vi.fn(async () => undefined)

    await openTuiMemoryFolder(path, launcher)

    expect((await stat(path)).isDirectory()).toBe(true)
    expect(launcher).toHaveBeenCalledWith(
      process.platform === 'darwin'
        ? 'open'
        : process.platform === 'win32'
          ? 'explorer.exe'
          : 'xdg-open',
      [path],
    )

    await expect(
      openTuiMemoryFolder(path, async () => {
        throw new Error('folder launch failed')
      }),
    ).rejects.toThrow('folder launch failed')
  })
})
