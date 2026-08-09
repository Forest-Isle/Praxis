import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { ClaudeExtensionCatalog } from '../extensions/claude-extensions.js'
import {
  describeClaudePlugin,
  initClaudePlugin,
  installClaudePlugin,
  loadClaudePlugins,
  readPluginRegistry,
  setClaudePluginEnabled,
  uninstallClaudePlugin,
  updateClaudePlugin,
  validateClaudePlugin,
} from './claude-plugin-runtime.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  )
})

async function pluginFixture(): Promise<{ root: string; configRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), 'praxis-plugin-'))
  const configRoot = join(root, 'config')
  roots.push(root)
  await mkdir(join(root, 'plugin', '.claude-plugin'), { recursive: true })
  await mkdir(join(root, 'plugin', 'commands'))
  await mkdir(join(root, 'plugin', 'skills', 'review'), { recursive: true })
  await mkdir(join(root, 'plugin', 'agents'))
  await mkdir(join(root, 'plugin', 'hooks'))
  await writeFile(
    join(root, 'plugin', '.claude-plugin', 'plugin.json'),
    JSON.stringify({
      name: 'fixture',
      version: '1.2.3',
      commands: 'commands',
      skills: 'skills',
      agents: 'agents',
      hooks: {
        SessionStart: [
          {
            hooks: [
              { type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/start.sh' },
            ],
          },
        ],
      },
      mcpServers: { inline: { command: 'fixture-mcp' } },
      lspServers: { inlineLsp: { command: 'fixture-lsp' } },
    }),
  )
  await writeFile(join(root, 'plugin', 'commands', 'hello.md'), 'hello')
  await writeFile(
    join(root, 'plugin', 'skills', 'review', 'SKILL.md'),
    '---\ndescription: review\n---\nreview body',
  )
  await writeFile(join(root, 'plugin', 'agents', 'reviewer.md'), 'reviewer')
  await writeFile(
    join(root, 'plugin', '.mcp.json'),
    JSON.stringify({ mcpServers: { file: { command: 'file-mcp' } } }),
  )
  await writeFile(
    join(root, 'plugin', '.lsp.json'),
    JSON.stringify({ fileLsp: { command: 'file-lsp' } }),
  )
  await writeFile(
    join(root, 'plugin', 'hooks', 'hooks.json'),
    JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'stop' }] }] },
    }),
  )
  return { root, configRoot }
}

describe('Claude plugin runtime', () => {
  it('reports per-component metadata and invocation token estimates', async () => {
    const { root } = await pluginFixture()
    const details = await describeClaudePlugin(join(root, 'plugin'))

    expect(details.componentCosts).toEqual([
      { kind: 'skill', name: 'review', alwaysOn: 4, onInvoke: 3 },
      { kind: 'agent', name: 'reviewer', alwaysOn: 4, onInvoke: 2 },
      { kind: 'command', name: 'hello', alwaysOn: 4, onInvoke: 1 },
    ])
    expect(details.tokenEstimate).toEqual({ alwaysOn: 12, onInvoke: 6 })
    expect(details.components).toMatchObject({
      hooks: ['SessionStart', 'Stop'],
      mcpServers: ['file', 'inline'],
      lspServers: ['fileLsp', 'inlineLsp'],
    })
  })

  it('loads namespaced components, hooks, and MCP resources', async () => {
    const { root } = await pluginFixture()
    const resources = await loadClaudePlugins({
      configRoot: join(root, 'empty-config'),
      cwd: root,
      pluginDirectories: [join(root, 'plugin')],
      strictPluginDirectories: true,
    })

    expect(resources.plugins[0]).toMatchObject({
      name: 'fixture',
      version: '1.2.3',
      enabled: true,
      errors: [],
    })
    const extensions = new ClaudeExtensionCatalog(resources)
    expect(extensions.skill('fixture:hello')).not.toBeNull()
    expect(extensions.skill('fixture:review')).not.toBeNull()
    expect(extensions.agent('fixture:reviewer')).not.toBeNull()
    expect(resources.settings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          value: expect.objectContaining({ hooks: expect.any(Object) }),
        }),
      ]),
    )
    expect(resources.settings.map((item) => item.path)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('/plugin/hooks/hooks.json'),
      ]),
    )
    expect(resources.mcp).toHaveLength(2)
    expect(resources.mcp.map((item) => item.value)).toEqual(
      expect.arrayContaining([
        { mcpServers: { file: { command: 'file-mcp' } } },
        { mcpServers: { inline: { command: 'fixture-mcp' } } },
      ]),
    )
  })

  it('supports manifest command definitions with inline content and source files', async () => {
    const { root } = await pluginFixture()
    await writeFile(join(root, 'plugin', 'extra.md'), 'source command')
    await writeFile(
      join(root, 'plugin', '.claude-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'fixture',
        commands: {
          about: { content: 'inline command' },
          source: { source: 'extra.md' },
        },
      }),
    )
    const resources = await loadClaudePlugins({
      configRoot: join(root, 'empty-config'),
      cwd: root,
      pluginDirectories: [join(root, 'plugin')],
      strictPluginDirectories: true,
    })
    const extensions = new ClaudeExtensionCatalog(resources)
    expect(extensions.skill('fixture:about')?.body).toBe('inline command')
    expect(extensions.skill('fixture:source')?.body).toBe('source command')
  })

  it('persists install, enable, update, and uninstall atomically', async () => {
    const { root, configRoot } = await pluginFixture()
    const source = join(root, 'plugin')
    const installed = await installClaudePlugin(configRoot, source)
    expect(await readPluginRegistry(configRoot)).toEqual([installed])
    await setClaudePluginEnabled(configRoot, 'fixture', false)
    expect((await readPluginRegistry(configRoot))[0]?.enabled).toBe(false)
    await setClaudePluginEnabled(configRoot, 'fixture', true)
    await writeFile(
      join(source, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'fixture', version: '2.0.0' }),
    )
    expect((await updateClaudePlugin(configRoot, 'fixture')).version).toBe(
      '2.0.0',
    )
    expect((await readPluginRegistry(configRoot))[0]?.version).toBe('2.0.0')
    await uninstallClaudePlugin(configRoot, 'fixture')
    expect(await readPluginRegistry(configRoot)).toEqual([])
  })

  it('initializes and validates a plugin, and rejects path escapes', async () => {
    const { root } = await pluginFixture()
    const fresh = join(root, 'fresh')
    await initClaudePlugin(fresh, 'fresh-plugin')
    expect((await validateClaudePlugin(fresh)).name).toBe('fresh-plugin')
    const manifest = join(root, 'plugin', '.claude-plugin', 'plugin.json')
    await writeFile(
      manifest,
      JSON.stringify({ name: 'fixture', commands: '../outside' }),
    )
    await expect(validateClaudePlugin(join(root, 'plugin'))).rejects.toThrow(
      'escapes plugin root',
    )
    await expect(
      loadClaudePlugins({
        configRoot: join(root, 'config'),
        cwd: root,
        pluginDirectories: [join(root, 'missing')],
        strictPluginDirectories: true,
      }),
    ).rejects.toThrow('Failed to load plugin')
    await expect(
      readFile(join(fresh, 'commands', 'hello.md'), 'utf8'),
    ).resolves.toContain('Hello')
  })

  it('loads native skills-directory plugins without treating agents and styles as skills', async () => {
    const { root } = await pluginFixture()
    const configRoot = join(root, 'config')
    const skillDirectory = join(configRoot, 'skills', 'fixture-skill')
    await initClaudePlugin(skillDirectory, 'fixture-skill', {
      nativeLayout: true,
      with: ['skills', 'agents', 'output-style'],
    })

    const resources = await loadClaudePlugins({ configRoot, cwd: root })
    expect(resources.plugins).toMatchObject([
      { name: 'fixture-skill', source: 'fixture-skill@skills-dir' },
    ])
    expect(resources.skills.map((skill) => skill.path)).toEqual([
      expect.stringContaining('fixture-skill:fixture-skill'),
      expect.stringContaining('fixture-skill:example'),
    ])
    expect(resources.agents.map((agent) => agent.path)).toEqual([
      expect.stringContaining('fixture-skill:example'),
    ])
  })

  it('returns validation warnings and makes them strict failures on request', async () => {
    const { root } = await pluginFixture()
    const manifest = join(root, 'plugin', '.claude-plugin', 'plugin.json')
    await writeFile(
      manifest,
      JSON.stringify({ name: 'fixture', unknown: true }),
    )

    await expect(
      validateClaudePlugin(join(root, 'plugin')),
    ).resolves.toMatchObject({
      warnings: expect.arrayContaining([
        "Unknown field 'unknown'",
        'No version specified',
        'No description provided',
        'No author information provided',
      ]),
    })
    await expect(
      validateClaudePlugin(join(root, 'plugin'), { strict: true }),
    ).rejects.toThrow('--strict treats warnings as errors')
  })
})
