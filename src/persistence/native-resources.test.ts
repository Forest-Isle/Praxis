import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { loadNativeSharedResources } from './native-resources.js'

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
})
