import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { sanitizeClaudeProjectPath } from './paths.js'
import {
  loadClaudeContextResources,
  loadClaudeSettings,
  loadClaudeSharedResources,
  resolveClaudeProjectMemoryDirectory,
} from './shared-resources.js'

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
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'praxis-shared-resources-')),
    )
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
        join(configRoot, '.claude.json'),
        JSON.stringify({
          mcpServers: { user_fixture: { command: 'user-node' } },
          projects: {
            [cwd]: {
              mcpServers: { local_fixture: { command: 'local-node' } },
            },
          },
        }),
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
    const resolvedMemoryDirectory = await resolveClaudeProjectMemoryDirectory({
      configRoot,
      cwd,
    })

    expect(resources.instructions.map((item) => item.content)).toEqual([
      'GLOBAL_INSTRUCTION',
      'PROJECT_INSTRUCTION',
      'DOT_INSTRUCTION',
      'RULE_INSTRUCTION',
    ])
    expect(resources.memory.map((item) => item.content)).toEqual([
      'MEMORY_MARKER',
    ])
    expect(resolvedMemoryDirectory).toBe(dirname(projectMemory))
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
    expect(resources.mcp.map((item) => item.value)).toEqual([
      { mcpServers: { user_fixture: { command: 'user-node' } } },
      { mcpServers: { fixture: { command: 'node' } } },
      { mcpServers: { local_fixture: { command: 'local-node' } } },
    ])
    expect(resources.mcp.map((item) => item.scope)).toEqual([
      'user',
      'project',
      'local',
    ])
  })

  it('returns an empty view when optional shared files do not exist', async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'praxis-shared-empty-')),
    )
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
      mcp: [],
    })
  })

  it('filters all shared customization categories by selected setting sources', async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'praxis-shared-sources-')),
    )
    tempDirectories.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'workspace')
    await Promise.all([
      writeFixture(join(configRoot, 'CLAUDE.md'), 'USER_CONTEXT'),
      writeFixture(join(cwd, 'CLAUDE.md'), 'PROJECT_CONTEXT'),
      writeFixture(join(cwd, 'CLAUDE.local.md'), 'LOCAL_CONTEXT'),
      writeFixture(
        join(configRoot, 'skills', 'user-skill', 'SKILL.md'),
        'USER_SKILL',
      ),
      writeFixture(
        join(cwd, '.claude', 'skills', 'project-skill', 'SKILL.md'),
        'PROJECT_SKILL',
      ),
      writeFixture(join(configRoot, 'settings.json'), '{"user":true}'),
      writeFixture(join(cwd, '.claude', 'settings.json'), '{"project":true}'),
      writeFixture(
        join(cwd, '.claude', 'settings.local.json'),
        '{"local":true}',
      ),
    ])

    const user = await loadClaudeSharedResources({
      configRoot,
      cwd,
      settingSources: ['user'],
    })
    expect(user.instructions.map((resource) => resource.content)).toEqual([
      'USER_CONTEXT',
    ])
    expect(user.skills.map((resource) => resource.content)).toEqual([
      'USER_SKILL',
    ])
    expect(user.settings.map((resource) => resource.value)).toEqual([
      { user: true },
    ])

    const projectContext = await loadClaudeContextResources({
      configRoot,
      cwd,
      settingSources: ['project'],
    })
    expect(
      projectContext.instructions.map((resource) => resource.content),
    ).toEqual(['PROJECT_CONTEXT'])
    await expect(
      loadClaudeSettings({ configRoot, cwd, settingSources: [] }),
    ).resolves.toEqual([])
  })

  it('reports malformed JSON with its shared resource path', async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'praxis-shared-invalid-')),
    )
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

  it('loads permission settings without parsing unrelated MCP resources', async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'praxis-shared-settings-only-')),
    )
    tempDirectories.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'workspace')
    await Promise.all([
      writeFixture(
        join(configRoot, 'settings.json'),
        JSON.stringify({ permissions: { allow: ['Read'] } }),
      ),
      writeFixture(join(cwd, '.mcp.json'), '{'),
    ])

    await expect(loadClaudeSettings({ configRoot, cwd })).resolves.toEqual([
      expect.objectContaining({
        scope: 'user',
        value: { permissions: { allow: ['Read'] } },
      }),
    ])
  })

  it('loads model context without parsing unrelated settings or MCP resources', async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'praxis-shared-context-only-')),
    )
    tempDirectories.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'workspace')
    const memoryPath = join(
      configRoot,
      'projects',
      sanitizeClaudeProjectPath(cwd),
      'memory',
      'MEMORY.md',
    )
    await Promise.all([
      writeFixture(join(configRoot, 'CLAUDE.md'), 'GLOBAL_CONTEXT'),
      writeFixture(
        join(configRoot, 'rules', 'global.md'),
        'GLOBAL_RULE_CONTEXT',
      ),
      writeFixture(join(cwd, 'CLAUDE.md'), 'PROJECT_CONTEXT'),
      writeFixture(
        join(cwd, '.claude', 'rules', 'unconditional.md'),
        'PROJECT_RULE_CONTEXT',
      ),
      writeFixture(
        join(cwd, '.claude', 'rules', 'conditional.md'),
        '---\n"paths": ["src/**"]\n---\nCONDITIONAL_CONTEXT',
      ),
      writeFixture(memoryPath, 'MEMORY_CONTEXT'),
      writeFixture(join(dirname(memoryPath), 'details.md'), 'MEMORY_DETAIL'),
      writeFixture(
        join(dirname(memoryPath), 'nested', 'MEMORY.md'),
        'NESTED_MEMORY_INDEX',
      ),
      writeFixture(join(configRoot, 'settings.json'), '{'),
      writeFixture(join(cwd, '.mcp.json'), '{'),
    ])

    const resources = await loadClaudeContextResources({ configRoot, cwd })

    expect(resources.instructions.map((item) => item.content)).toEqual([
      'GLOBAL_CONTEXT',
      'GLOBAL_RULE_CONTEXT',
      'PROJECT_CONTEXT',
      'PROJECT_RULE_CONTEXT',
    ])
    expect(resources.conditionalRules).toEqual([
      {
        path: join(cwd, '.claude', 'rules', 'conditional.md'),
        scope: 'project',
        content: 'CONDITIONAL_CONTEXT',
        globs: ['src/**'],
        rawContent: '---\n"paths": ["src/**"]\n---\nCONDITIONAL_CONTEXT',
        baseDirectory: cwd,
      },
    ])
    expect(resources.memoryIndex?.content).toBe('MEMORY_CONTEXT')
  })

  it('does not swallow filesystem errors other than missing resources', async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'praxis-shared-io-error-')),
    )
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
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'praxis-shared-hierarchy-')),
    )
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
        join(repository, 'CLAUDE.local.md'),
        'ROOT_LOCAL_INSTRUCTION',
      ),
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
      writeFixture(
        join(cwd, '.claude', 'settings.json'),
        JSON.stringify({ env: { ROOT_SETTING: 'root' } }),
      ),
      writeFixture(
        join(cwd, '.claude', 'settings.local.json'),
        JSON.stringify({ env: { PACKAGE_SETTING: 'package' } }),
      ),
      writeFixture(
        join(repository, '.mcp.json'),
        JSON.stringify({ mcpServers: { root: { command: 'root' } } }),
      ),
      writeFixture(
        join(cwd, '.mcp.json'),
        JSON.stringify({ mcpServers: { nested: { command: 'nested' } } }),
      ),
      writeFixture(join(memoryDirectory, 'MEMORY.md'), 'MEMORY_INDEX'),
      writeFixture(
        join(memoryDirectory, 'topics', 'compatibility.md'),
        'MEMORY_DETAIL',
      ),
    ])

    const resources = await loadClaudeSharedResources({ configRoot, cwd })
    const resolvedMemoryDirectory = await resolveClaudeProjectMemoryDirectory({
      configRoot,
      cwd,
    })

    expect(resources.instructions.map((item) => item.content)).toEqual([
      'ROOT_INSTRUCTION',
      'ROOT_LOCAL_INSTRUCTION',
      'PACKAGE_INSTRUCTION',
      'NESTED_RULE',
    ])
    expect(resources.memory.map((item) => item.content)).toEqual([
      'MEMORY_INDEX',
      'MEMORY_DETAIL',
    ])
    expect(resolvedMemoryDirectory).toBe(memoryDirectory)
    expect(resources.skills.map((item) => item.content)).toEqual(['ROOT_SKILL'])
    expect(resources.commands.map((item) => item.content)).toEqual([
      'PACKAGE_COMMAND',
    ])
    expect(resources.agents.map((item) => item.content)).toEqual([
      'NESTED_AGENT',
    ])
    expect(resources.settings.map((item) => item.value)).toEqual([
      { env: { ROOT_SETTING: 'root' } },
      { env: { PACKAGE_SETTING: 'package' } },
    ])
    expect(
      resources.instructions.find(
        (item) => item.content === 'ROOT_LOCAL_INSTRUCTION',
      )?.scope,
    ).toBe('local')
    expect(resources.mcp.map((item) => item.value)).toEqual([
      { mcpServers: { root: { command: 'root' } } },
      { mcpServers: { nested: { command: 'nested' } } },
    ])
  })

  it('uses the canonical main repository key for worktree memory', async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'praxis-shared-worktree-')),
    )
    tempDirectories.push(root)
    const configRoot = join(root, 'config')
    const mainRepository = join(root, 'main')
    const worktree = join(root, 'worktree')
    const worktreeGitDirectory = join(
      mainRepository,
      '.git',
      'worktrees',
      'fixture-worktree',
    )
    const cwd = join(worktree, 'packages', 'app')
    const memoryDirectory = join(
      configRoot,
      'projects',
      sanitizeClaudeProjectPath(mainRepository),
      'memory',
    )

    await Promise.all([
      writeFixture(join(worktree, '.git'), `gitdir: ${worktreeGitDirectory}\n`),
      writeFixture(join(worktreeGitDirectory, 'commondir'), '../..\n'),
      writeFixture(join(worktree, 'CLAUDE.md'), 'WORKTREE_INSTRUCTION'),
      writeFixture(
        join(memoryDirectory, 'MEMORY.md'),
        'SHARED_WORKTREE_MEMORY',
      ),
    ])

    const resources = await loadClaudeSharedResources({ configRoot, cwd })
    const resolvedMemoryDirectory = await resolveClaudeProjectMemoryDirectory({
      configRoot,
      cwd,
    })

    expect(resources.instructions.map((item) => item.content)).toEqual([
      'WORKTREE_INSTRUCTION',
    ])
    expect(resources.memory.map((item) => item.content)).toEqual([
      'SHARED_WORKTREE_MEMORY',
    ])
    expect(resolvedMemoryDirectory).toBe(memoryDirectory)
  })

  it('returns a canonical memory root through a symlinked config path', async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'praxis-shared-config-link-')),
    )
    tempDirectories.push(root)
    const configRoot = join(root, 'config')
    const configLink = join(root, 'config-link')
    const cwd = join(root, 'workspace')
    await Promise.all([mkdir(configRoot), mkdir(cwd)])
    await symlink(configRoot, configLink)

    await expect(
      resolveClaudeProjectMemoryDirectory({ configRoot: configLink, cwd }),
    ).resolves.toBe(
      join(configRoot, 'projects', sanitizeClaudeProjectPath(cwd), 'memory'),
    )
  })

  it('walks from a configured home boundary through a non-git cwd', async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'praxis-shared-non-git-')),
    )
    tempDirectories.push(root)
    const configRoot = join(root, 'config')
    const homeDirectory = join(root, 'home')
    const projectDirectory = join(homeDirectory, 'projects', 'fixture')
    const cwd = join(projectDirectory, 'src')

    await Promise.all([
      writeFixture(join(root, 'CLAUDE.md'), 'OUTSIDE_HOME'),
      writeFixture(join(configRoot, 'CLAUDE.md'), 'ACTIVE_GLOBAL'),
      writeFixture(join(homeDirectory, 'CLAUDE.md'), 'HOME_INSTRUCTION'),
      writeFixture(
        join(homeDirectory, '.claude', 'CLAUDE.md'),
        'INACTIVE_DEFAULT_GLOBAL',
      ),
      writeFixture(
        join(configRoot, 'skills', 'active', 'SKILL.md'),
        'ACTIVE_GLOBAL_SKILL',
      ),
      writeFixture(
        join(homeDirectory, '.claude', 'skills', 'inactive', 'SKILL.md'),
        'INACTIVE_DEFAULT_SKILL',
      ),
      writeFixture(join(projectDirectory, 'CLAUDE.md'), 'PROJECT_INSTRUCTION'),
      writeFixture(
        join(projectDirectory, 'CLAUDE.local.md'),
        'PROJECT_LOCAL_INSTRUCTION',
      ),
      writeFixture(
        join(projectDirectory, '.claude', 'skills', 'project', 'SKILL.md'),
        'PROJECT_SKILL',
      ),
      writeFixture(join(cwd, 'CLAUDE.md'), 'CWD_INSTRUCTION'),
    ])

    const resources = await loadClaudeSharedResources({
      configRoot,
      cwd,
      homeDirectory,
    })

    expect(resources.instructions.map((item) => item.content)).toEqual([
      'ACTIVE_GLOBAL',
      'HOME_INSTRUCTION',
      'PROJECT_INSTRUCTION',
      'PROJECT_LOCAL_INSTRUCTION',
      'CWD_INSTRUCTION',
    ])
    expect(resources.skills.map((item) => item.content)).toEqual([
      'ACTIVE_GLOBAL_SKILL',
      'PROJECT_SKILL',
    ])
  })
})
