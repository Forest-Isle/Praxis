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
    expect(resources.memory.map((item) => item.content)).toEqual([
      'MEMORY_MARKER',
    ])
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

  it('returns an empty view when optional shared files do not exist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-shared-empty-'))
    tempDirectories.push(root)

    const resources = await loadClaudeSharedResources({
      configRoot: join(root, 'config'),
      cwd: join(root, 'workspace'),
    })

    expect(resources).toEqual({
      instructions: [],
      memory: [],
      skills: [],
      commands: [],
      agents: [],
      settings: [],
      mcp: null,
    })
  })

  it('reports malformed JSON with its shared resource path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-shared-invalid-'))
    tempDirectories.push(root)
    const settingsPath = join(root, 'config', 'settings.json')
    await writeFixture(settingsPath, '{')

    await expect(
      loadClaudeSharedResources({
        configRoot: join(root, 'config'),
        cwd: join(root, 'workspace'),
      }),
    ).rejects.toThrow(`Invalid Claude JSON resource: ${settingsPath}`)
  })

  it('does not swallow filesystem errors other than missing resources', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-shared-io-error-'))
    tempDirectories.push(root)
    const settingsPath = join(root, 'config', 'settings.json')
    await mkdir(settingsPath, { recursive: true })

    await expect(
      loadClaudeSharedResources({
        configRoot: join(root, 'config'),
        cwd: join(root, 'workspace'),
      }),
    ).rejects.toMatchObject({ code: 'EISDIR' })
  })

  it('loads project resources from the git root through a nested cwd', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-shared-hierarchy-'))
    tempDirectories.push(root)
    const configRoot = join(root, 'config')
    const repository = join(root, 'repository')
    const packageDirectory = join(repository, 'packages', 'app')
    const cwd = join(packageDirectory, 'src')
    const memoryDirectory = join(
      configRoot,
      'projects',
      sanitizeClaudeProjectPath(repository),
      'memory',
    )

    await Promise.all([
      mkdir(join(repository, '.git'), { recursive: true }),
      writeFixture(join(root, 'CLAUDE.md'), 'OUTSIDE_INSTRUCTION'),
      writeFixture(join(repository, 'CLAUDE.md'), 'ROOT_INSTRUCTION'),
      writeFixture(
        join(packageDirectory, '.claude', 'CLAUDE.md'),
        'PACKAGE_INSTRUCTION',
      ),
      writeFixture(join(cwd, '.claude', 'rules', 'nested.md'), 'NESTED_RULE'),
      writeFixture(
        join(repository, '.claude', 'skills', 'root-skill', 'SKILL.md'),
        'ROOT_SKILL',
      ),
      writeFixture(
        join(packageDirectory, '.claude', 'commands', 'package.md'),
        'PACKAGE_COMMAND',
      ),
      writeFixture(join(cwd, '.claude', 'agents', 'nested.md'), 'NESTED_AGENT'),
      writeFixture(join(memoryDirectory, 'MEMORY.md'), 'MEMORY_INDEX'),
      writeFixture(
        join(memoryDirectory, 'topics', 'compatibility.md'),
        'MEMORY_DETAIL',
      ),
    ])

    const resources = await loadClaudeSharedResources({ configRoot, cwd })

    expect(resources.instructions.map((item) => item.content)).toEqual([
      'ROOT_INSTRUCTION',
      'PACKAGE_INSTRUCTION',
      'NESTED_RULE',
    ])
    expect(resources.memory.map((item) => item.content)).toEqual([
      'MEMORY_INDEX',
      'MEMORY_DETAIL',
    ])
    expect(resources.skills.map((item) => item.content)).toEqual(['ROOT_SKILL'])
    expect(resources.commands.map((item) => item.content)).toEqual([
      'PACKAGE_COMMAND',
    ])
    expect(resources.agents.map((item) => item.content)).toEqual([
      'NESTED_AGENT',
    ])
  })
})
