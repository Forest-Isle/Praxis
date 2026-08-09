import { execFile } from 'node:child_process'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it } from 'vitest'

import {
  executeClaudePluginPrune,
  planClaudePluginPrune,
  tagClaudePlugin,
} from './claude-plugin-maintenance.js'
import { removeClaudeInstalledPlugin } from './claude-plugin-marketplace.js'

const execFileAsync = promisify(execFile)
const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

async function pluginGraph(): Promise<{
  root: string
  configRoot: string
  cwd: string
  paths: Record<string, string>
}> {
  const root = await mkdtemp(join(tmpdir(), 'praxis-plugin-prune-'))
  roots.push(root)
  const configRoot = join(root, 'config')
  const cwd = join(root, 'work')
  const paths: Record<string, string> = {}
  await mkdir(cwd, { recursive: true })
  for (const [name, dependencies] of [
    ['parent', ['dep@market']],
    ['dep', ['leaf@market']],
    ['leaf', []],
    ['orphan', []],
  ] as const) {
    const path = join(configRoot, 'plugins', 'cache', 'market', name, '1.0.0')
    paths[name] = path
    await mkdir(join(path, '.claude-plugin'), { recursive: true })
    await writeFile(
      join(path, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name, version: '1.0.0', dependencies }),
    )
  }
  const entry = (name: string, auto = false) => ({
    scope: 'user',
    installPath: paths[name],
    version: '1.0.0',
    installedAt: '2026-08-08T00:00:00.000Z',
    lastUpdated: '2026-08-08T00:00:00.000Z',
    ...(auto ? { auto: true } : {}),
  })
  await mkdir(join(configRoot, 'plugins'), { recursive: true })
  await writeFile(
    join(configRoot, 'plugins', 'installed_plugins.json'),
    JSON.stringify({
      version: 2,
      plugins: {
        'parent@market': [entry('parent')],
        'dep@market': [entry('dep', true)],
        'leaf@market': [entry('leaf', true)],
        'orphan@market': [entry('orphan', true)],
      },
    }),
  )
  await writeFile(
    join(configRoot, 'settings.json'),
    JSON.stringify({
      enabledPlugins: {
        'parent@market': true,
        'dep@market': true,
        'leaf@market': true,
        'orphan@market': true,
      },
    }),
  )
  return { root, configRoot, cwd, paths }
}

describe('Claude plugin prune', () => {
  it('removes only unreachable automatic dependencies and keeps transitive ones', async () => {
    const value = await pluginGraph()
    let plan = await planClaudePluginPrune(value.configRoot, value.cwd, 'user')
    expect(plan).toMatchObject({ autoCount: 3 })
    expect(plan.candidates.map((plugin) => plugin.id)).toEqual([
      'orphan@market',
    ])

    await executeClaudePluginPrune(value.configRoot, value.cwd, plan)
    await expect(access(value.paths.orphan as string)).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(
      JSON.parse(
        await readFile(
          join(value.configRoot, 'plugins', 'installed_plugins.json'),
          'utf8',
        ),
      ).plugins,
    ).not.toHaveProperty('orphan@market')
    expect(
      JSON.parse(
        await readFile(join(value.configRoot, 'settings.json'), 'utf8'),
      ).enabledPlugins,
    ).not.toHaveProperty('orphan@market')

    await removeClaudeInstalledPlugin(
      value.configRoot,
      'parent@market',
      'user',
      value.cwd,
    )
    plan = await planClaudePluginPrune(value.configRoot, value.cwd, 'user')
    expect(plan.candidates.map((plugin) => plugin.id)).toEqual([
      'dep@market',
      'leaf@market',
    ])
  })

  it('fails safe and reports every installed manifest that cannot be loaded', async () => {
    const value = await pluginGraph()
    await rm(join(value.paths.dep as string, '.claude-plugin', 'plugin.json'))
    await rm(
      join(value.paths.orphan as string, '.claude-plugin', 'plugin.json'),
    )
    await expect(
      planClaudePluginPrune(value.configRoot, value.cwd, 'user'),
    ).resolves.toMatchObject({
      candidates: [],
      failedPluginIds: ['dep@market', 'orphan@market'],
    })
  })
})

async function git(repository: string, args: readonly string[]) {
  return execFileAsync('git', ['-C', repository, ...args])
}

async function pluginRepository(): Promise<{
  root: string
  plugin: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'praxis-plugin-tag-'))
  roots.push(root)
  const plugin = join(root, 'plugins', 'fixture')
  await mkdir(join(plugin, '.claude-plugin'), { recursive: true })
  await writeFile(
    join(plugin, '.claude-plugin', 'plugin.json'),
    JSON.stringify({
      name: 'fixture',
      version: '1.2.3',
      description: 'fixture',
      author: { name: 'Fixture' },
    }),
  )
  await mkdir(join(root, '.claude-plugin'), { recursive: true })
  await writeFile(
    join(root, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({
      name: 'market',
      plugins: [
        { name: 'fixture', version: '1.2.3', source: './plugins/fixture' },
      ],
    }),
  )
  await git(root, ['init', '-q'])
  await git(root, ['config', 'user.email', 'fixture@example.test'])
  await git(root, ['config', 'user.name', 'Fixture'])
  await git(root, ['add', '.'])
  await git(root, ['commit', '-qm', 'initial'])
  return { root, plugin }
}

describe('Claude plugin tag', () => {
  it('dry-runs, creates annotated tags, validates duplicates, and force-moves', async () => {
    const value = await pluginRepository()
    const dryRun = await tagClaudePlugin({
      path: value.plugin,
      dryRun: true,
      message: 'Release %s',
    })
    expect(dryRun).toMatchObject({
      tag: 'fixture--v1.2.3',
      message: 'Release 1.2.3',
      dryRun: true,
    })
    expect((await git(value.root, ['tag', '--list'])).stdout).toBe('')

    await tagClaudePlugin({ path: value.plugin, message: 'Release %s' })
    expect(
      (await git(value.root, ['cat-file', '-t', 'fixture--v1.2.3'])).stdout,
    ).toBe('tag\n')
    expect(
      (
        await git(value.root, [
          'for-each-ref',
          'refs/tags/fixture--v1.2.3',
          '--format=%(contents)',
        ])
      ).stdout,
    ).toBe('Release 1.2.3\n\n')
    await expect(tagClaudePlugin({ path: value.plugin })).rejects.toThrow(
      'already exists locally',
    )
    await writeFile(join(value.plugin, 'dirty.txt'), 'dirty')
    await expect(
      tagClaudePlugin({ path: value.plugin, dryRun: true }),
    ).rejects.toThrow('Uncommitted changes')
    await expect(
      tagClaudePlugin({ path: value.plugin, force: true }),
    ).resolves.toMatchObject({ force: true })
  })

  it('validates enclosing marketplace identity and pushes to a selected remote', async () => {
    const value = await pluginRepository()
    const remote = join(value.root, '..', `remote-${Date.now()}.git`)
    roots.push(remote)
    await execFileAsync('git', ['init', '--bare', '-q', remote])
    await git(value.root, ['remote', 'add', 'upstream', remote])
    await expect(
      tagClaudePlugin({
        path: value.plugin,
        push: true,
        remote: 'upstream',
      }),
    ).resolves.toMatchObject({ pushed: true, remote: 'upstream' })
    expect(
      (
        await execFileAsync('git', [
          '--git-dir',
          remote,
          'tag',
          '--list',
          'fixture--v1.2.3',
        ])
      ).stdout,
    ).toBe('fixture--v1.2.3\n')

    await writeFile(
      join(value.root, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'market',
        plugins: [
          {
            name: 'fixture',
            version: '2.0.0',
            source: { source: 'directory', path: './plugins/fixture' },
          },
        ],
      }),
    )
    await expect(
      tagClaudePlugin({ path: value.plugin, force: true, dryRun: true }),
    ).rejects.toThrow('Version mismatch')

    await writeFile(
      join(value.root, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({ name: 'market', plugins: {} }),
    )
    await expect(
      tagClaudePlugin({ path: value.plugin, force: true, dryRun: true }),
    ).rejects.toThrow('Marketplace plugins must be an array')

    await writeFile(
      join(value.root, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'market',
        plugins: [{ name: 'fixture', source: {} }],
      }),
    )
    await expect(
      tagClaudePlugin({ path: value.plugin, force: true, dryRun: true }),
    ).rejects.toThrow('Invalid marketplace plugin source')
  })

  it('validates a marketplace entry colocated with the plugin root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-plugin-root-market-'))
    roots.push(root)
    await mkdir(join(root, '.claude-plugin'), { recursive: true })
    await writeFile(
      join(root, '.claude-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'fixture',
        version: '1.2.3',
        description: 'fixture',
        author: { name: 'Fixture' },
      }),
    )
    const marketplacePath = join(root, '.claude-plugin', 'marketplace.json')
    await writeFile(
      marketplacePath,
      JSON.stringify({
        name: 'market',
        plugins: [{ name: 'fixture', version: '1.2.3', source: '.' }],
      }),
    )
    await git(root, ['init', '-q'])
    await git(root, ['config', 'user.email', 'fixture@example.test'])
    await git(root, ['config', 'user.name', 'Fixture'])
    await git(root, ['add', '.'])
    await git(root, ['commit', '-qm', 'initial'])

    await expect(
      tagClaudePlugin({ path: root, dryRun: true }),
    ).resolves.toMatchObject({
      marketplaceEntry: {
        path: join(await realpath(root), '.claude-plugin', 'marketplace.json'),
        index: 0,
        version: '1.2.3',
      },
    })

    await writeFile(
      marketplacePath,
      JSON.stringify({
        name: 'market',
        plugins: [{ name: 'fixture', version: '2.0.0', source: '.' }],
      }),
    )
    await expect(
      tagClaudePlugin({ path: root, force: true, dryRun: true }),
    ).rejects.toThrow(
      'Version mismatch: plugin.json says "1.2.3" but .claude-plugin/marketplace.json plugins[0].version says "2.0.0"',
    )
  })

  it('validates every matching enclosing entry and canonicalizes symlinks', async () => {
    const value = await pluginRepository()
    const outerMarketplace = join(
      value.root,
      '.claude-plugin',
      'marketplace.json',
    )
    await writeFile(
      join(value.plugin, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'inner',
        plugins: [{ name: 'fixture', version: '1.2.3', source: '.' }],
      }),
    )
    await writeFile(
      outerMarketplace,
      JSON.stringify({
        name: 'outer',
        plugins: [
          { name: 'fixture', version: '1.2.3', source: './plugins/fixture' },
          { name: 'fixture', version: '2.0.0', source: './plugins/fixture' },
        ],
      }),
    )
    await expect(
      tagClaudePlugin({ path: value.plugin, force: true, dryRun: true }),
    ).rejects.toThrow('Version mismatch')

    const linkedPlugin = join(value.root, 'linked-fixture')
    await symlink(value.plugin, linkedPlugin)
    await writeFile(
      outerMarketplace,
      JSON.stringify({
        name: 'outer',
        plugins: [
          { name: 'fixture', version: '2.0.0', source: './linked-fixture' },
        ],
      }),
    )
    await expect(
      tagClaudePlugin({ path: value.plugin, force: true, dryRun: true }),
    ).rejects.toThrow('Version mismatch')
  })

  it('rejects leading-zero numeric prereleases and accepts valid prereleases', async () => {
    const value = await pluginRepository()
    const manifestPath = join(value.plugin, '.claude-plugin', 'plugin.json')
    const manifest = (version: string) =>
      JSON.stringify({
        name: 'fixture',
        version,
        description: 'fixture',
        author: { name: 'Fixture' },
      })

    await writeFile(manifestPath, manifest('1.2.3-01'))
    await expect(tagClaudePlugin({ path: value.plugin })).rejects.toThrow(
      'not valid semver',
    )
    await writeFile(manifestPath, manifest('1.2.3-alpha.01'))
    await expect(tagClaudePlugin({ path: value.plugin })).rejects.toThrow(
      'not valid semver',
    )

    await writeFile(manifestPath, manifest('1.2.3-alpha.1'))
    await writeFile(
      join(value.root, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'market',
        plugins: [
          {
            name: 'fixture',
            version: '1.2.3-alpha.1',
            source: './plugins/fixture',
          },
        ],
      }),
    )
    await git(value.root, ['add', '.'])
    await git(value.root, ['commit', '-qm', 'valid prerelease'])
    await expect(
      tagClaudePlugin({ path: value.plugin, dryRun: true }),
    ).resolves.toMatchObject({ tag: 'fixture--v1.2.3-alpha.1' })
  })

  it('rejects plugins that fail normal manifest validation', async () => {
    const value = await pluginRepository()
    await writeFile(
      join(value.plugin, '.claude-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'fixture',
        version: '1.2.3',
        commands: '../outside',
      }),
    )
    await expect(
      tagClaudePlugin({ path: value.plugin, force: true, dryRun: true }),
    ).rejects.toThrow('escapes plugin root')
  })
})
