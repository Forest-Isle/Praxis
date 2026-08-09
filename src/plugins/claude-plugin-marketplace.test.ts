import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { strToU8, zipSync } from 'fflate'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { loadClaudePlugins } from './claude-plugin-runtime.js'
import {
  addClaudeMarketplace,
  claudePluginDataPath,
  installClaudeMarketplacePlugin,
  listNativePluginRecords,
  materializeClaudePluginSource,
  readClaudeInstalledPlugins,
  readClaudeKnownMarketplaces,
  replaceClaudePluginDirectory,
  removeClaudeMarketplace,
  setNativePluginEnabled,
  uninstallNativePlugin,
  updateClaudeMarketplace,
} from './claude-plugin-marketplace.js'

const roots: string[] = []
const execFileAsync = promisify(execFile)

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

async function fixture(): Promise<{
  root: string
  configRoot: string
  cwd: string
  marketplace: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'praxis-marketplace-'))
  const configRoot = join(root, 'config')
  const cwd = join(root, 'workspace')
  const marketplace = join(root, 'marketplace')
  roots.push(root)
  await mkdir(join(cwd, '.claude'), { recursive: true })
  await mkdir(join(marketplace, '.claude-plugin'), { recursive: true })
  await mkdir(join(marketplace, 'plugins', 'fixture', '.claude-plugin'), {
    recursive: true,
  })
  await mkdir(join(marketplace, 'plugins', 'fixture', 'commands'), {
    recursive: true,
  })
  await writeFile(
    join(marketplace, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({
      name: 'fixture-marketplace',
      plugins: [
        {
          name: 'fixture',
          source: './plugins/fixture',
          version: '1.0.0',
        },
      ],
    }),
  )
  await writeFile(
    join(marketplace, 'plugins', 'fixture', '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'fixture', version: '1.0.0' }),
  )
  await writeFile(
    join(marketplace, 'plugins', 'fixture', 'commands', 'hello.md'),
    'hello',
  )
  return { root, configRoot, cwd, marketplace }
}

describe('Claude native plugin marketplace', () => {
  it('persists native marketplace and installed plugin records', async () => {
    const value = await fixture()
    const marketplace = await addClaudeMarketplace(
      value.configRoot,
      value.cwd,
      value.marketplace,
    )
    expect(marketplace.name).toBe('fixture-marketplace')
    expect(await readClaudeKnownMarketplaces(value.configRoot)).toMatchObject([
      { name: 'fixture-marketplace', source: { source: 'directory' } },
    ])

    const installed = await installClaudeMarketplacePlugin(
      value.configRoot,
      value.cwd,
      'fixture@fixture-marketplace',
    )
    expect(installed).toMatchObject({
      id: 'fixture@fixture-marketplace',
      version: '1.0.0',
      scope: 'user',
      enabled: true,
    })
    expect(
      await readClaudeInstalledPlugins(value.configRoot, value.cwd),
    ).toEqual([installed])
    await expect(
      readFile(join(value.configRoot, 'settings.json'), 'utf8'),
    ).resolves.toContain('fixture@fixture-marketplace')

    await setNativePluginEnabled(
      value.configRoot,
      value.cwd,
      installed.id,
      false,
    )
    expect(
      (await listNativePluginRecords(value.configRoot, value.cwd))[0],
    ).toMatchObject({
      enabled: false,
    })
    expect(
      (
        await loadClaudePlugins({
          configRoot: value.configRoot,
          cwd: value.cwd,
        })
      ).plugins,
    ).toEqual([])
    await setNativePluginEnabled(
      value.configRoot,
      value.cwd,
      installed.id,
      true,
    )
    expect(
      (
        await loadClaudePlugins({
          configRoot: value.configRoot,
          cwd: value.cwd,
        })
      ).commands,
    ).toHaveLength(1)

    await updateClaudeMarketplace(value.configRoot, marketplace.name)
    await removeClaudeMarketplace(value.configRoot, value.cwd, marketplace.name)
    expect(await readClaudeKnownMarketplaces(value.configRoot)).toEqual([])
  })

  it('extracts zip plugin sources with traversal protection', async () => {
    const value = await fixture()
    const archive = join(value.root, 'fixture.zip')
    await writeFile(
      archive,
      zipSync({
        'plugin/.claude-plugin/plugin.json': strToU8(
          JSON.stringify({ name: 'zip-fixture', version: '1.0.0' }),
        ),
        'plugin/commands/hello.md': strToU8('zip hello'),
      }),
    )
    const materialized = await materializeClaudePluginSource(archive)
    try {
      expect(materialized.path).toContain('plugin')
      expect(
        await readFile(join(materialized.path, 'commands', 'hello.md'), 'utf8'),
      ).toBe('zip hello')
    } finally {
      await materialized.cleanup()
    }
    await expect(
      materializeClaudePluginSource(join(value.root, 'missing.zip')),
    ).rejects.toThrow('Plugin source')

    const traversalArchive = join(value.root, 'traversal.zip')
    await writeFile(
      traversalArchive,
      zipSync({
        '../escape.txt': strToU8('escape'),
        'plugin/.claude-plugin/plugin.json': strToU8(
          JSON.stringify({ name: 'zip-fixture', version: '1.0.0' }),
        ),
      }),
    )
    await expect(
      materializeClaudePluginSource(traversalArchive),
    ).rejects.toThrow('Archive path escapes destination')
  })

  it('replaces an existing install without leaving a backup directory', async () => {
    const value = await fixture()
    const target = join(value.root, 'target')
    const temporary = join(value.root, 'temporary')
    await mkdir(target)
    await mkdir(temporary)
    await writeFile(join(target, 'version.txt'), 'old')
    await writeFile(join(temporary, 'version.txt'), 'new')

    await replaceClaudePluginDirectory(temporary, target)

    await expect(readFile(join(target, 'version.txt'), 'utf8')).resolves.toBe(
      'new',
    )
    await expect(
      readdir(value.root).then((entries) =>
        entries.filter(
          (entry) => entry.startsWith('target.') && entry.endsWith('.bak'),
        ),
      ),
    ).resolves.toEqual([])
  })

  it('preserves or removes sanitized plugin data with native uninstalls', async () => {
    const value = await fixture()
    await addClaudeMarketplace(value.configRoot, value.cwd, value.marketplace)
    const id = 'fixture@fixture-marketplace'
    await installClaudeMarketplacePlugin(value.configRoot, value.cwd, id)
    const data = claudePluginDataPath(value.configRoot, id)
    await mkdir(data, { recursive: true })
    await writeFile(join(data, 'state.json'), '{"ok":true}')

    await uninstallNativePlugin(
      value.configRoot,
      value.cwd,
      id,
      undefined,
      false,
    )
    await expect(readFile(join(data, 'state.json'), 'utf8')).resolves.toContain(
      'true',
    )

    await installClaudeMarketplacePlugin(value.configRoot, value.cwd, id)
    await uninstallNativePlugin(value.configRoot, value.cwd, id)
    await expect(access(data)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('uses and preserves bounded sparse paths for git marketplaces', async () => {
    const value = await fixture()
    const repository = join(value.root, 'sparse-repository')
    await mkdir(join(repository, '.claude-plugin'), { recursive: true })
    await mkdir(join(repository, 'plugins', 'included'), { recursive: true })
    await mkdir(join(repository, 'excluded'), { recursive: true })
    await writeFile(
      join(repository, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({ name: 'sparse-marketplace', plugins: [] }),
    )
    await writeFile(join(repository, 'plugins', 'included', 'keep.txt'), 'keep')
    await writeFile(join(repository, 'excluded', 'omit.txt'), 'excluded')
    await execFileAsync('git', ['init', '-q'], { cwd: repository })
    await execFileAsync('git', ['add', '.'], { cwd: repository })
    await execFileAsync(
      'git',
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.test',
        'commit',
        '-qm',
        'fixture',
      ],
      { cwd: repository },
    )
    vi.stubEnv('GIT_CONFIG_COUNT', '1')
    vi.stubEnv('GIT_CONFIG_KEY_0', `url.file://${repository}.insteadOf`)
    vi.stubEnv('GIT_CONFIG_VALUE_0', 'https://example.test/sparse.git')

    const marketplace = await addClaudeMarketplace(
      value.configRoot,
      value.cwd,
      'https://example.test/sparse.git',
      'user',
      ['.claude-plugin', 'plugins/included'],
    )

    expect(marketplace.source).toEqual({
      source: 'git',
      url: 'https://example.test/sparse.git',
      sparsePaths: ['.claude-plugin', 'plugins/included'],
    })
    await expect(
      access(join(marketplace.installLocation, 'excluded', 'omit.txt')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readClaudeKnownMarketplaces(value.configRoot)).toMatchObject([
      {
        source: {
          sparsePaths: ['.claude-plugin', 'plugins/included'],
        },
      },
    ])
    await updateClaudeMarketplace(value.configRoot, marketplace.name)
    await expect(
      addClaudeMarketplace(
        value.configRoot,
        value.cwd,
        value.marketplace,
        'user',
        ['../escape'],
      ),
    ).rejects.toThrow('only supported for git marketplace sources')
    await expect(
      addClaudeMarketplace(
        value.configRoot,
        value.cwd,
        'https://example.test/invalid.git',
        'user',
        ['../escape'],
      ),
    ).rejects.toThrow('Invalid sparse checkout path')
  })
})
