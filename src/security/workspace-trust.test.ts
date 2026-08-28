import {
  access,
  mkdtemp,
  mkdir,
  realpath,
  readFile,
  rm,
  stat,
  symlink,
  truncate,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import type { JsonResource } from '../core/resources.js'
import {
  loadClaudePlugins,
  writePluginRegistry,
} from '../plugins/claude-plugin-runtime.js'
import {
  allowedWorkspaceHookSettings,
  allowedWorkspaceMcpResources,
  assessWorkspaceTrust,
  canonicalizeWorkspaceTrust,
  hasWorkspaceProviderSelection,
  persistWorkspaceTrust,
  workspaceTrustInventory,
  type WorkspaceTrustAssessment,
} from './workspace-trust.js'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'praxis-workspace-trust-'))
  const cwd = join(root, 'project')
  const configRoot = join(root, 'config')
  await Promise.all([mkdir(cwd), mkdir(configRoot)])
  return { root, cwd, configRoot, statePath: join(configRoot, 'state.json') }
}

function resource(
  path: string,
  scope: JsonResource['scope'],
  value: unknown,
): JsonResource {
  return { path, scope, value }
}

function hook(command: string, extra: Record<string, unknown> = {}) {
  return {
    hooks: {
      SessionStart: [
        {
          matcher: 'startup',
          hooks: [{ type: 'command', command, ...extra }],
        },
      ],
    },
  }
}

function mcp(command: string, args: readonly string[] = []) {
  return { mcpServers: { fixture: { command, args } } }
}

describe('workspace executable trust', () => {
  it('canonicalizes objects deterministically while preserving array order', () => {
    expect(canonicalizeWorkspaceTrust({ z: 1, a: { d: 2, b: 3 } })).toBe(
      canonicalizeWorkspaceTrust({ a: { b: 3, d: 2 }, z: 1 }),
    )
    expect(canonicalizeWorkspaceTrust(['a', 'b'])).not.toBe(
      canonicalizeWorkspaceTrust(['b', 'a']),
    )
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => canonicalizeWorkspaceTrust(cyclic)).toThrow(/cycle/u)
    expect(() => canonicalizeWorkspaceTrust(undefined)).toThrow(/non-JSON/u)
    expect(() => canonicalizeWorkspaceTrust(Number.NaN)).toThrow(/number/u)
  })

  it('ignores user resources and unrelated project settings', async () => {
    const { cwd } = await fixture()
    const empty = await workspaceTrustInventory({ cwd })
    const unrelated = await workspaceTrustInventory({
      cwd,
      settings: [
        resource(join(cwd, '.praxis/settings.json'), 'project', {
          permissions: { allow: ['Read'] },
        }),
        resource(join(cwd, 'user.json'), 'user', hook('user-hook')),
      ],
      mcp: [resource(join(cwd, 'user-mcp.json'), 'user', mcp('user-mcp'))],
    })
    expect(unrelated.origins).toEqual([])
    expect(unrelated.fingerprint).toBe(empty.fingerprint)
  })

  it('fingerprints provider selection without unrelated settings', async () => {
    const { root, cwd } = await fixture()
    const path = join(cwd, '.praxis/settings.json')
    const empty = await workspaceTrustInventory({ cwd })
    expect(
      hasWorkspaceProviderSelection([
        resource(join(root, 'user.json'), 'user', { model: 'user-model' }),
        resource(path, 'project', { permissions: { allow: ['Read'] } }),
      ]),
    ).toBe(false)
    const first = await workspaceTrustInventory({
      cwd,
      settings: [resource(path, 'project', { model: 'project-model' })],
    })
    expect(first.origins).toEqual([
      {
        kind: 'provider',
        scope: 'project',
        path: join(await realpath(cwd), '.praxis/settings.json'),
        label: 'provider-selection',
      },
    ])
    expect(first.fingerprint).not.toBe(empty.fingerprint)
    const reordered = await workspaceTrustInventory({
      cwd,
      settings: [
        resource(path, 'project', {
          unrelated: true,
          model: 'project-model',
        }),
      ],
    })
    expect(reordered.fingerprint).toBe(first.fingerprint)
    for (const selection of [
      { model: 'changed' },
      { provider: 'anthropic', model: 'project-model' },
      { providerProfile: 'other', model: 'project-model' },
    ]) {
      const changed = await workspaceTrustInventory({
        cwd,
        settings: [resource(path, 'project', selection)],
      })
      expect(changed.fingerprint).not.toBe(first.fingerprint)
    }
    const local = await workspaceTrustInventory({
      cwd,
      settings: [resource(path, 'local', { model: 'project-model' })],
    })
    expect(local.fingerprint).not.toBe(first.fingerprint)
  })

  it('shares provider trust across symlink workspace aliases', async () => {
    const { root, cwd } = await fixture()
    const alias = join(root, 'alias')
    await symlink(cwd, alias, 'dir')
    const direct = await workspaceTrustInventory({
      cwd,
      settings: [
        resource(join(cwd, '.praxis/settings.json'), 'project', {
          provider: 'openai',
          model: 'project-model',
        }),
      ],
    })
    const linked = await workspaceTrustInventory({
      cwd: alias,
      settings: [
        resource(join(alias, '.praxis/settings.json'), 'project', {
          provider: 'openai',
          model: 'project-model',
        }),
      ],
    })
    expect(linked.canonicalPath).toBe(direct.canonicalPath)
    expect(linked.fingerprint).toBe(direct.fingerprint)
  })

  it('is stable across object key order and sensitive to arrays, source, and scope', async () => {
    const { cwd } = await fixture()
    const path = join(cwd, '.praxis/settings.json')
    const first = await workspaceTrustInventory({
      cwd,
      settings: [
        resource(path, 'project', hook('node hook.mjs', { timeout: 10 })),
      ],
      mcp: [
        resource(
          join(cwd, '.praxis/mcp.json'),
          'local',
          mcp('node', ['a', 'b']),
        ),
      ],
    })
    const reordered = await workspaceTrustInventory({
      cwd,
      settings: [
        resource(path, 'project', {
          hooks: {
            SessionStart: [
              {
                hooks: [
                  { timeout: 10, command: 'node hook.mjs', type: 'command' },
                ],
                matcher: 'startup',
              },
            ],
          },
        }),
      ],
      mcp: [
        resource(join(cwd, '.praxis/mcp.json'), 'local', {
          mcpServers: { fixture: { args: ['a', 'b'], command: 'node' } },
        }),
      ],
    })
    expect(reordered.fingerprint).toBe(first.fingerprint)

    const changedArray = await workspaceTrustInventory({
      cwd,
      settings: [
        resource(path, 'project', hook('node hook.mjs', { timeout: 10 })),
      ],
      mcp: [
        resource(
          join(cwd, '.praxis/mcp.json'),
          'local',
          mcp('node', ['b', 'a']),
        ),
      ],
    })
    const changedSource = await workspaceTrustInventory({
      cwd,
      settings: [
        resource(
          join(cwd, '.praxis/settings.local.json'),
          'project',
          hook('node hook.mjs', { timeout: 10 }),
        ),
      ],
      mcp: [
        resource(
          join(cwd, '.praxis/mcp.json'),
          'local',
          mcp('node', ['a', 'b']),
        ),
      ],
    })
    const changedScope = await workspaceTrustInventory({
      cwd,
      settings: [
        resource(path, 'local', hook('node hook.mjs', { timeout: 10 })),
      ],
      mcp: [
        resource(
          join(cwd, '.praxis/mcp.json'),
          'local',
          mcp('node', ['a', 'b']),
        ),
      ],
    })
    expect(changedArray.fingerprint).not.toBe(first.fingerprint)
    expect(changedSource.fingerprint).not.toBe(first.fingerprint)
    expect(changedScope.fingerprint).not.toBe(first.fingerprint)

    const changedEnvironment = await workspaceTrustInventory({
      cwd,
      settings: [
        {
          ...resource(path, 'project', hook('node hook.mjs', { timeout: 10 })),
          environment: { PLUGIN_GRANT: 'changed' },
        },
      ],
      mcp: [
        resource(
          join(cwd, '.praxis/mcp.json'),
          'local',
          mcp('node', ['a', 'b']),
        ),
      ],
    })
    expect(changedEnvironment.fingerprint).not.toBe(first.fingerprint)
  })

  it('filters only executable project resources while retaining user and non-executable resources', () => {
    const userHook = resource('/user/settings.json', 'user', hook('user'))
    const projectHook = resource('/work/settings.json', 'project', {
      ...hook('project'),
      permissions: { allow: ['Read'] },
    })
    const projectSettings = resource('/work/settings.local.json', 'local', {
      permissions: { deny: ['Bash'] },
    })
    expect(
      allowedWorkspaceHookSettings(
        [userHook, projectHook, projectSettings],
        false,
      ),
    ).toEqual([userHook, projectSettings])
    expect(
      allowedWorkspaceHookSettings(
        [userHook, projectHook, projectSettings],
        true,
      ),
    ).toEqual([userHook, projectHook, projectSettings])

    const userMcp = resource('/user/mcp.json', 'user', mcp('user'))
    const projectMcp = resource('/work/mcp.json', 'project', mcp('project'))
    expect(allowedWorkspaceMcpResources([userMcp, projectMcp], false)).toEqual([
      userMcp,
    ])
  })

  it('keeps plugin hooks and MCP in read-only executable discovery', async () => {
    const { cwd, configRoot } = await fixture()
    const pluginRoot = join(cwd, 'fixture-plugin')
    await mkdir(join(pluginRoot, '.claude-plugin'), { recursive: true })
    await writeFile(
      join(pluginRoot, '.claude-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'workspace-executables',
        version: '1.0.0',
        description: 'workspace executable fixture',
        hooks: hook('node hook.mjs').hooks,
        mcpServers: { fixture: { command: 'node', args: ['server.mjs'] } },
      }),
    )
    const resources = await loadClaudePlugins({
      configRoot,
      cwd,
      pluginDirectories: [pluginRoot],
      strictPluginDirectories: true,
      loadInstalled: false,
      readOnlyExecutables: true,
      environment: {},
    })
    expect(resources.settings).toHaveLength(1)
    expect(resources.mcp).toHaveLength(1)
    const inventory = await workspaceTrustInventory({
      cwd,
      settings: resources.settings.map((resource) => ({
        ...resource,
        scope: 'project',
      })),
      mcp: resources.mcp.map((resource) => ({
        ...resource,
        scope: 'project',
      })),
    })
    expect(inventory.origins.map(({ kind }) => kind).sort()).toEqual([
      'hook',
      'mcp',
    ])
  })

  it('discovers remote plugin MCPB references without network or cache writes', async () => {
    const { cwd, configRoot } = await fixture()
    const pluginRoot = join(cwd, 'remote-mcpb-plugin')
    await mkdir(join(pluginRoot, '.claude-plugin'), { recursive: true })
    await writeFile(
      join(pluginRoot, '.claude-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'remote-mcpb',
        version: '1.0.0',
        mcpServers: 'https://example.invalid/server.mcpb',
      }),
    )
    const fetch = vi.spyOn(globalThis, 'fetch')
    try {
      const resources = await loadClaudePlugins({
        configRoot,
        cwd,
        pluginDirectories: [pluginRoot],
        strictPluginDirectories: true,
        loadInstalled: false,
        readOnlyExecutables: true,
        environment: {},
      })
      expect(fetch).not.toHaveBeenCalled()
      expect(resources.mcp).toHaveLength(1)
      expect(resources.mcp[0]?.pluginExecutableSource).toMatchObject({
        kind: 'mcpb',
        source: 'https://example.invalid/server.mcpb',
      })
      await expect(access(join(pluginRoot, '.mcpb-cache'))).rejects.toThrow()
    } finally {
      fetch.mockRestore()
    }
  })

  it('classifies registry plugins through a canonical workspace alias', async () => {
    const { root, cwd, configRoot } = await fixture()
    const alias = join(root, 'workspace-alias')
    const pluginRoot = join(cwd, 'registry-plugin')
    await Promise.all([
      symlink(cwd, alias, 'dir'),
      mkdir(join(pluginRoot, '.claude-plugin'), { recursive: true }),
    ])
    await writeFile(
      join(pluginRoot, '.claude-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'registry-plugin',
        version: '1.0.0',
        hooks: hook('node hook.mjs').hooks,
        mcpServers: 'https://example.invalid/project-server.mcpb',
      }),
    )
    await writePluginRegistry(configRoot, [
      {
        name: 'registry-plugin',
        path: pluginRoot,
        source: 'fixture',
        enabled: true,
      },
    ])
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('unexpected network'))
    try {
      const resources = await loadClaudePlugins({
        configRoot,
        cwd: alias,
        readOnlyExecutables: true,
        environment: {},
      })
      expect(resources.settings[0]?.scope).toBe('project')
      expect(resources.mcp[0]?.scope).toBe('project')
      const blocked = await loadClaudePlugins({
        configRoot,
        cwd: alias,
        allowWorkspaceMcpb: false,
        environment: {},
      })
      expect(blocked.mcp).toEqual([])
      expect(fetch).not.toHaveBeenCalled()
    } finally {
      fetch.mockRestore()
    }
  })

  it('rejects oversized local MCPB sources before read-only hashing', async () => {
    const { root, cwd, configRoot } = await fixture()
    const pluginRoot = join(cwd, 'oversized-mcpb-plugin')
    const archive = join(pluginRoot, 'oversized.mcpb')
    await mkdir(join(pluginRoot, '.claude-plugin'), { recursive: true })
    await writeFile(
      join(pluginRoot, '.claude-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'oversized-mcpb',
        version: '1.0.0',
        mcpServers: './oversized.mcpb',
      }),
    )
    await writeFile(archive, '')
    await truncate(archive, 512 * 1024 * 1024 + 1)
    await writePluginRegistry(configRoot, [
      {
        name: 'oversized-mcpb',
        path: pluginRoot,
        source: 'fixture',
        enabled: true,
      },
    ])
    try {
      const resources = await loadClaudePlugins({
        configRoot,
        cwd,
        readOnlyExecutables: true,
        environment: {},
      })
      expect(resources.mcp).toEqual([])
      expect(resources.plugins[0]?.errors.join('\n')).toContain(
        'MCPB archive exceeds',
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects non-regular local MCPB sources before read-only hashing', async () => {
    const { root, cwd, configRoot } = await fixture()
    const pluginRoot = join(cwd, 'non-regular-mcpb-plugin')
    await mkdir(join(pluginRoot, '.claude-plugin'), { recursive: true })
    await mkdir(join(pluginRoot, 'directory.mcpb'))
    await writeFile(
      join(pluginRoot, '.claude-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'non-regular-mcpb',
        version: '1.0.0',
        mcpServers: './directory.mcpb',
      }),
    )
    await writePluginRegistry(configRoot, [
      {
        name: 'non-regular-mcpb',
        path: pluginRoot,
        source: 'fixture',
        enabled: true,
      },
    ])
    try {
      const resources = await loadClaudePlugins({
        configRoot,
        cwd,
        readOnlyExecutables: true,
        environment: {},
      })
      expect(resources.mcp).toEqual([])
      expect(resources.plugins[0]?.errors.join('\n')).toContain(
        'must be a regular file',
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects local MCPB symlinks that escape the plugin root before hashing', async () => {
    const { root, cwd, configRoot } = await fixture()
    const pluginRoot = join(cwd, 'escaped-mcpb-plugin')
    const externalArchive = join(root, 'external.mcpb')
    await mkdir(join(pluginRoot, '.claude-plugin'), { recursive: true })
    await writeFile(
      join(pluginRoot, '.claude-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'escaped-mcpb',
        version: '1.0.0',
        mcpServers: './escaped.mcpb',
      }),
    )
    await writeFile(externalArchive, 'must not be hashed')
    await symlink(externalArchive, join(pluginRoot, 'escaped.mcpb'))
    await writePluginRegistry(configRoot, [
      {
        name: 'escaped-mcpb',
        path: pluginRoot,
        source: 'fixture',
        enabled: true,
      },
    ])
    try {
      const resources = await loadClaudePlugins({
        configRoot,
        cwd,
        readOnlyExecutables: true,
        environment: {},
      })
      expect(resources.mcp).toEqual([])
      expect(resources.plugins[0]?.errors.join('\n')).toContain(
        'escapes plugin root',
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('persists exact trust, preserves unknown state, and invalidates changed config', async () => {
    const { cwd, statePath } = await fixture()
    await writeFile(
      statePath,
      JSON.stringify({
        version: 7,
        unknown: { keep: true },
        projects: { [cwd]: { lastSessionId: 'keep-me' } },
      }),
    )
    const inventory = await workspaceTrustInventory({
      cwd,
      settings: [
        resource(join(cwd, '.praxis/settings.json'), 'project', hook('one')),
      ],
    })
    const assessment = await assessWorkspaceTrust(inventory, statePath)
    expect(assessment.status).toBe('untrusted')
    await persistWorkspaceTrust(assessment, statePath)
    await expect(
      assessWorkspaceTrust(inventory, statePath),
    ).resolves.toMatchObject({
      status: 'trusted',
    })
    const state = JSON.parse(await readFile(statePath, 'utf8')) as Record<
      string,
      unknown
    >
    expect(state).toMatchObject({
      version: 7,
      unknown: { keep: true },
      projects: { [cwd]: { lastSessionId: 'keep-me' } },
    })
    expect((await stat(statePath)).mode & 0o777).toBe(0o600)

    const changed = await workspaceTrustInventory({
      cwd,
      settings: [
        resource(join(cwd, '.praxis/settings.json'), 'project', hook('two')),
      ],
    })
    await expect(
      assessWorkspaceTrust(changed, statePath),
    ).resolves.toMatchObject({
      status: 'untrusted',
    })
  })

  it('uses the canonical real path as the trust identity', async () => {
    const { root, cwd } = await fixture()
    const alias = join(root, 'alias')
    await symlink(cwd, alias, 'dir')
    const direct = await workspaceTrustInventory({
      cwd,
      settings: [resource(join(cwd, 'settings.json'), 'project', hook('one'))],
    })
    const linked = await workspaceTrustInventory({
      cwd: alias,
      settings: [
        resource(join(alias, 'settings.json'), 'project', hook('one')),
      ],
    })
    expect(linked.canonicalPath).toBe(direct.canonicalPath)
    expect(linked.fingerprint).toBe(direct.fingerprint)
  })

  it('invalidates trust when a symlinked resource is retargeted', async () => {
    const { root, cwd } = await fixture()
    const firstSource = join(root, 'first-settings.json')
    const secondSource = join(root, 'second-settings.json')
    const linkedSource = join(cwd, 'settings.json')
    await Promise.all([
      writeFile(firstSource, JSON.stringify(hook('same'))),
      writeFile(secondSource, JSON.stringify(hook('same'))),
    ])
    await symlink(firstSource, linkedSource)
    const first = await workspaceTrustInventory({
      cwd,
      settings: [resource(linkedSource, 'project', hook('same'))],
    })
    await unlink(linkedSource)
    await symlink(secondSource, linkedSource)
    const second = await workspaceTrustInventory({
      cwd,
      settings: [resource(linkedSource, 'project', hook('same'))],
    })
    expect(first.origins[0]?.path).toBe(await realpath(firstSource))
    expect(second.origins[0]?.path).toBe(await realpath(secondSource))
    expect(second.fingerprint).not.toBe(first.fingerprint)
  })

  it.each([
    ['invalid JSON', '{'],
    ['non-object root', '[]'],
    ['non-object projects', '{"projects":1}'],
    ['non-object project', null],
  ])('fails closed for %s state', async (_name, source) => {
    const { cwd, statePath } = await fixture()
    const inventory = await workspaceTrustInventory({
      cwd,
      settings: [resource(join(cwd, 'settings.json'), 'project', hook('one'))],
    })
    await writeFile(
      statePath,
      source ?? JSON.stringify({ projects: { [inventory.canonicalPath]: 1 } }),
    )
    await expect(assessWorkspaceTrust(inventory, statePath)).rejects.toThrow()
  })

  it('fails closed when a sibling project state entry is malformed', async () => {
    const { cwd, statePath } = await fixture()
    const inventory = await workspaceTrustInventory({
      cwd,
      settings: [resource(join(cwd, 'settings.json'), 'project', hook('one'))],
    })
    const assessment = await assessWorkspaceTrust(inventory, statePath)
    await persistWorkspaceTrust(assessment, statePath)
    const state = JSON.parse(await readFile(statePath, 'utf8')) as {
      projects: Record<string, unknown>
    }
    state.projects['/malformed/sibling'] = false
    await writeFile(statePath, JSON.stringify(state))
    await expect(assessWorkspaceTrust(inventory, statePath)).rejects.toThrow(
      /project entry/u,
    )
  })

  it('rejects a symlink state path without replacing its target', async () => {
    const { cwd, configRoot, statePath } = await fixture()
    const target = join(configRoot, 'target.json')
    await writeFile(target, '{}')
    await symlink(target, statePath)
    const inventory = await workspaceTrustInventory({
      cwd,
      settings: [resource(join(cwd, 'settings.json'), 'project', hook('one'))],
    })
    await expect(assessWorkspaceTrust(inventory, statePath)).rejects.toThrow(
      /regular file/u,
    )
    expect(await readFile(target, 'utf8')).toBe('{}')
  })

  it('serializes concurrent grants through the shared state lock', async () => {
    const { root, statePath } = await fixture()
    const firstCwd = join(root, 'first')
    const secondCwd = join(root, 'second')
    await Promise.all([mkdir(firstCwd), mkdir(secondCwd)])
    const assessments = await Promise.all(
      [firstCwd, secondCwd].map(async (cwd) => {
        const inventory = await workspaceTrustInventory({
          cwd,
          settings: [
            resource(join(cwd, 'settings.json'), 'project', hook(cwd)),
          ],
        })
        return assessWorkspaceTrust(inventory, statePath)
      }),
    )
    await Promise.all(
      assessments.map((assessment) =>
        persistWorkspaceTrust(assessment, statePath),
      ),
    )
    const state = JSON.parse(await readFile(statePath, 'utf8')) as {
      projects: Record<string, unknown>
    }
    expect(Object.keys(state.projects).sort()).toEqual(
      assessments.map((assessment) => assessment.canonicalPath).sort(),
    )
  })

  it('refuses to persist an empty or forged assessment', async () => {
    const { cwd, statePath } = await fixture()
    const empty = await workspaceTrustInventory({ cwd })
    await expect(
      persistWorkspaceTrust({ ...empty, status: 'not-required' }, statePath),
    ).rejects.toThrow(/empty/u)
    const forged: WorkspaceTrustAssessment = {
      canonicalPath: 'relative',
      fingerprint: 'not-a-hash',
      origins: [{ kind: 'hook', scope: 'project', path: '/x', label: 'x' }],
      status: 'untrusted',
    }
    await expect(persistWorkspaceTrust(forged, statePath)).rejects.toThrow()
  })
})
