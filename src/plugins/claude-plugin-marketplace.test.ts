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

import { strToU8, zipSync } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'

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

afterEach(async () => {
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

    await updateClaudeMarketplace(value.configRoot, value.cwd, marketplace.name)
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
})
