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
  it('uses the shared Claude instruction and canonical auto-memory data plane', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-tui-memory-'))
    roots.push(root)
    const homeDirectory = join(root, 'home')
    const configRoot = join(homeDirectory, '.claude')
    const cwd = join(root, 'project')
    await Promise.all([
      mkdir(configRoot, { recursive: true }),
      mkdir(join(cwd, '.claude'), { recursive: true }),
    ])
    await Promise.all([
      writeFile(
        join(configRoot, 'CLAUDE.md'),
        '# User\n\n@user-details.md\n\n```md\n@ignored-user.md\n```\n',
      ),
      writeFile(join(configRoot, 'user-details.md'), '# User details\n'),
      writeFile(join(configRoot, 'ignored-user.md'), '# Not imported\n'),
      writeFile(
        join(cwd, 'CLAUDE.md'),
        '# Project\n\n@.claude/project-details.md\n\n    @.claude/ignored-project.md\n',
      ),
      writeFile(
        join(cwd, '.claude', 'project-details.md'),
        '# Project details\n',
      ),
      writeFile(join(cwd, '.claude', 'ignored-project.md'), '# Not imported\n'),
    ])

    const result = await loadTuiMemoryFiles({
      configRoot,
      cwd,
      homeDirectory,
    })

    expect(result.autoMemoryEnabled).toBe(true)
    expect(result.entries.map((entry) => entry.label)).toEqual([
      'User memory',
      '└ ~/.claude/user-details.md',
      'Project memory',
      '└ ./.claude/project-details.md',
      'Open auto-memory folder',
    ])
    expect(result.entries[1]).toMatchObject({
      annotation: 'Saved in ~/.claude/CLAUDE.md',
      imported: true,
      scope: 'user',
    })
    expect(result.entries[3]).toMatchObject({
      annotation: '@-imported',
      imported: true,
      scope: 'project',
    })
    expect(result.entries.at(-1)?.path).toBe(
      join(
        await realpath(configRoot),
        'projects',
        (await realpath(cwd)).replaceAll('/', '-'),
        'memory',
      ),
    )
  })

  it('keeps editable user and project rows when files are absent and hides disabled auto-memory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-tui-memory-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    await Promise.all([
      mkdir(configRoot, { recursive: true }),
      mkdir(cwd, { recursive: true }),
    ])
    await writeFile(
      join(configRoot, 'settings.json'),
      '{"autoMemoryEnabled":false}\n',
    )
    await writeFile(join(cwd, 'CLAUDE.local.md'), '# Local instructions\n')

    const result = await loadTuiMemoryFiles({
      configRoot,
      cwd,
      homeDirectory: join(root, 'home'),
    })

    expect(result.autoMemoryEnabled).toBe(false)
    expect(result.entries).toEqual([
      expect.objectContaining({ label: 'User memory', kind: 'file' }),
      expect.objectContaining({ label: 'Project memory', kind: 'file' }),
      expect.objectContaining({ label: './CLAUDE.local.md', kind: 'file' }),
    ])
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
