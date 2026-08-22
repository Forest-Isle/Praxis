import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { sanitizeClaudeProjectPath } from '../compatibility/claude/paths.js'
import {
  loadNativeContextResources,
  loadNativeSharedResources,
} from './native-resources.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  )
})

describe('native resource discovery', () => {
  it('loads only Praxis user and project resources', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-native-resources-'))
    roots.push(root)
    const cwd = join(root, 'workspace')
    await mkdir(join(root, 'skills', 'review'), { recursive: true })
    await mkdir(join(cwd, '.praxis', 'commands'), { recursive: true })
    await mkdir(join(cwd, '.claude', 'commands'), { recursive: true })
    await writeFile(join(root, 'PRAXIS.md'), 'user instruction')
    await writeFile(join(cwd, '.praxis', 'PRAXIS.md'), 'project instruction')
    await writeFile(join(root, 'skills', 'review', 'SKILL.md'), 'skill')
    await writeFile(join(cwd, '.praxis', 'commands', 'check.md'), 'command')
    await writeFile(join(cwd, '.claude', 'commands', 'ignored.md'), 'ignored')
    await writeFile(join(root, 'settings.json'), '{"permissions":{}}')
    await writeFile(
      join(cwd, '.praxis', 'settings.local.json'),
      '{"permissions":{"allow":["Read(./src/**)"]}}',
    )
    await writeFile(join(cwd, '.praxis', 'mcp.json'), '{"mcpServers":{}}')

    const resources = await loadNativeSharedResources({ root, cwd })

    expect(resources.instructions.map((resource) => resource.content)).toEqual([
      'user instruction',
      'project instruction',
    ])
    expect(resources.skills).toHaveLength(1)
    expect(resources.commands.map((resource) => resource.content)).toEqual([
      'command',
    ])
    expect(resources.settings.map((resource) => resource.scope)).toEqual([
      'user',
      'local',
    ])
    expect(resources.mcp).toHaveLength(1)
  })

  it('loads one Project-memory index across linked worktrees', async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'praxis-native-resources-')),
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
    ])
    await Promise.all([
      writeFile(join(worktree, '.git'), `gitdir: ${gitDirectory}\n`),
      mkdir(gitDirectory, { recursive: true }).then(() =>
        writeFile(join(gitDirectory, 'commondir'), '../..\n'),
      ),
    ])
    const directory = join(
      configRoot,
      'memory',
      sanitizeClaudeProjectPath(mainRepository),
    )
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'MEMORY.md'), 'SHARED_NATIVE_MEMORY')

    const resources = await loadNativeSharedResources({
      root: configRoot,
      cwd: worktree,
    })

    expect(resources.memory.map((resource) => resource.content)).toEqual([
      'SHARED_NATIVE_MEMORY',
    ])
  })

  it('does not read or inject native Project memory when disabled', async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'praxis-native-resources-')),
    )
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'workspace')
    const memoryDirectory = join(
      configRoot,
      'memory',
      sanitizeClaudeProjectPath(cwd),
    )
    await Promise.all([
      mkdir(memoryDirectory, { recursive: true }),
      mkdir(cwd, { recursive: true }),
      mkdir(configRoot, { recursive: true }),
    ])
    await Promise.all([
      writeFile(join(memoryDirectory, 'MEMORY.md'), 'MUST_NOT_LOAD'),
      writeFile(
        join(configRoot, 'settings.json'),
        JSON.stringify({ autoMemoryEnabled: false }),
      ),
    ])

    const resources = await loadNativeSharedResources({
      root: configRoot,
      cwd,
    })
    const context = await loadNativeContextResources({
      root: configRoot,
      cwd,
    })

    expect(resources.memory).toEqual([])
    expect(context.memoryIndex).toBeNull()
  })
})
