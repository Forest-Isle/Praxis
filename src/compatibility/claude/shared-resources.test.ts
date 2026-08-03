import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { sanitizeClaudeProjectPath } from './paths.js'
import { loadClaudeSharedResources } from './shared-resources.js'

const tempDirectories: string[] = []

async function writeFixture(path: string, content: string) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  )
})

describe('Claude shared resource discovery', () => {
  it('loads shared instructions, memory, extensions, settings, hooks, and MCP without copying', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-shared-resources-'))
    tempDirectories.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'workspace')
    const projectMemory = join(
      configRoot,
      'projects',
      sanitizeClaudeProjectPath(cwd),
      'memory',
      'MEMORY.md',
    )

    await Promise.all([
      writeFixture(join(configRoot, 'CLAUDE.md'), 'GLOBAL_INSTRUCTION'),
      writeFixture(join(cwd, 'CLAUDE.md'), 'PROJECT_INSTRUCTION'),
      writeFixture(join(cwd, '.claude', 'CLAUDE.md'), 'DOT_INSTRUCTION'),
      writeFixture(
        join(cwd, '.claude', 'rules', 'nested', 'fixture.md'),
        'RULE_INSTRUCTION',
      ),
      writeFixture(projectMemory, 'MEMORY_MARKER'),
      writeFixture(
        join(configRoot, 'skills', 'global-fixture', 'SKILL.md'),
        'GLOBAL_SKILL',
      ),
      writeFixture(
        join(cwd, '.claude', 'skills', 'project-fixture', 'SKILL.md'),
        'PROJECT_SKILL',
      ),
      writeFixture(
        join(configRoot, 'commands', 'global-command.md'),
        'GLOBAL_COMMAND',
      ),
      writeFixture(
        join(cwd, '.claude', 'commands', 'project-command.md'),
        'PROJECT_COMMAND',
      ),
      writeFixture(
        join(configRoot, 'agents', 'global-agent.md'),
        'GLOBAL_AGENT',
      ),
      writeFixture(
        join(cwd, '.claude', 'agents', 'project-agent.md'),
        'PROJECT_AGENT',
      ),
      writeFixture(
        join(configRoot, 'settings.json'),
        JSON.stringify({ model: 'user-model' }),
      ),
      writeFixture(
        join(cwd, '.claude', 'settings.json'),
        JSON.stringify({ permissions: { allow: ['Read'] } }),
      ),
      writeFixture(
        join(cwd, '.claude', 'settings.local.json'),
        JSON.stringify({ hooks: { UserPromptSubmit: [] } }),
      ),
      writeFixture(
        join(cwd, '.mcp.json'),
        JSON.stringify({ mcpServers: { fixture: { command: 'node' } } }),
      ),
    ])

    const resources = await loadClaudeSharedResources({ configRoot, cwd })

    expect(resources.instructions.map((item) => item.content)).toEqual([
      'GLOBAL_INSTRUCTION',
      'PROJECT_INSTRUCTION',
      'DOT_INSTRUCTION',
      'RULE_INSTRUCTION',
    ])
    expect(resources.memory?.content).toBe('MEMORY_MARKER')
    expect(resources.skills.map((item) => item.content)).toEqual([
      'GLOBAL_SKILL',
      'PROJECT_SKILL',
    ])
    expect(resources.commands.map((item) => item.content)).toEqual([
      'GLOBAL_COMMAND',
      'PROJECT_COMMAND',
    ])
    expect(resources.agents.map((item) => item.content)).toEqual([
      'GLOBAL_AGENT',
      'PROJECT_AGENT',
    ])
    expect(resources.settings.map((item) => item.value)).toEqual([
      { model: 'user-model' },
      { permissions: { allow: ['Read'] } },
      { hooks: { UserPromptSubmit: [] } },
    ])
    expect(resources.mcp?.value).toEqual({
      mcpServers: { fixture: { command: 'node' } },
    })
  })
})
