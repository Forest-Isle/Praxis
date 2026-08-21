import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, sep } from 'node:path'

import { strToU8, zipSync, type Zippable } from 'fflate'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ExclusiveFileLease } from '../platform/exclusive-file-lease.js'
import { loadClaudePluginMcpb } from './claude-plugin-mcpb.js'

const roots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

function manifest(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    manifest_version: '0.1',
    name: 'fixture-mcp',
    version: '1.0.0',
    description: 'fixture bundle',
    author: { name: 'Fixture' },
    server: {
      type: 'node',
      entry_point: 'server/index.js',
      mcp_config: {
        command: '${RUNTIME_BIN:-node}',
        args: [
          '${__dirname}/server/index.js',
          '${user_config.TOKEN}',
          '${user_config.PATHS}',
          '${pathSeparator}',
          '${HOME}',
          '${CLAUDE_PLUGIN_DATA}',
        ],
        env: {
          ROOT: '${MCPB_ROOT}',
          DATA: '${CLAUDE_PLUGIN_DATA}',
          HOME_COPY: '${env:HOME}',
          CLAUDE_PLUGIN_DATA: 'bundle-data-override',
        },
      },
    },
    user_config: {
      TOKEN: {
        type: 'string',
        title: 'Token',
        description: 'secret token',
        required: true,
        sensitive: true,
        default: 'must-not-satisfy-required',
      },
      PATHS: {
        type: 'string',
        title: 'Paths',
        description: 'path list',
        multiple: true,
        default: ['one', 'two'],
      },
    },
    ...overrides,
  }
}

function bundle(
  manifestValue: Record<string, unknown> = manifest(),
  extra: Zippable = {},
): Uint8Array {
  return zipSync({
    'manifest.json': strToU8(JSON.stringify(manifestValue)),
    'server/index.js': [
      strToU8('#!/usr/bin/env node\n'),
      { os: 3, attrs: (0o100755 << 16) >>> 0 },
    ],
    ...extra,
  })
}

function withCentralSize(
  archive: Uint8Array,
  entryName: string,
  size: number,
): Uint8Array {
  const patched = archive.slice()
  const decoder = new TextDecoder()
  for (let offset = 0; offset + 46 <= patched.byteLength; offset += 1) {
    if (
      patched[offset] !== 0x50 ||
      patched[offset + 1] !== 0x4b ||
      patched[offset + 2] !== 0x01 ||
      patched[offset + 3] !== 0x02
    )
      continue
    const nameLength =
      (patched[offset + 28] ?? 0) | ((patched[offset + 29] ?? 0) << 8)
    const name = decoder.decode(
      patched.subarray(offset + 46, offset + 46 + nameLength),
    )
    if (name !== entryName) continue
    patched[offset + 24] = size & 0xff
    patched[offset + 25] = (size >>> 8) & 0xff
    patched[offset + 26] = (size >>> 16) & 0xff
    patched[offset + 27] = (size >>> 24) & 0xff
    return patched
  }
  throw new Error(`Central ZIP entry not found: ${entryName}`)
}

async function fixture(bytes = bundle()): Promise<{
  root: string
  pluginRoot: string
  source: string
  pluginData: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'praxis-mcpb-'))
  roots.push(root)
  const pluginRoot = join(root, 'plugin')
  const source = join(pluginRoot, 'fixture.mcpb')
  const pluginData = join(root, 'data')
  vi.stubEnv('CLAUDE_CONFIG_DIR', join(root, 'config'))
  vi.stubEnv('PRAXIS_HOME', join(root, 'native-config'))
  await mkdir(pluginRoot, { recursive: true })
  await writeFile(source, bytes)
  return { root, pluginRoot, source, pluginData }
}

describe('Claude MCPB/DXT loader', () => {
  it('keeps native recovery leases out of the Claude compatibility root', async () => {
    const { root, pluginRoot, pluginData } = await fixture()
    let releaseDownload = (): void => undefined
    const downloadBlocked = new Promise<void>((resolveDownload) => {
      releaseDownload = resolveDownload
    })
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
      await downloadBlocked
      return new Response(bundle(), { status: 200 })
    })
    const loading = loadClaudePluginMcpb({
      pluginRoot,
      pluginData,
      source: 'https://example.test/native-recovery.dxt',
      fetch: fetcher,
      userConfig: { TOKEN: 'secret' },
    })
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))

    expect(
      await readdir(join(root, 'native-config', 'state', 'locks', 'mcpb')),
    ).toEqual([])
    await expect(
      access(join(root, 'config', 'praxis', 'locks', 'mcpb')),
    ).rejects.toMatchObject({ code: 'ENOENT' })

    releaseDownload()
    await expect(loading).resolves.toMatchObject({ name: 'fixture-mcp' })
  })

  it('loads local bundles, expands root/data/env/config, and preserves executable mode', async () => {
    const { pluginRoot, pluginData } = await fixture()
    const loaded = await loadClaudePluginMcpb({
      pluginRoot,
      pluginData,
      source: 'fixture.mcpb',
      environment: { RUNTIME_BIN: 'custom-node', HOME: '/safe/home' },
      userConfig: { TOKEN: 'top-secret' },
    })

    const canonicalPluginRoot = await realpath(pluginRoot)
    expect(loaded.name).toBe('fixture-mcp')
    expect(loaded.config).toEqual({
      command: 'custom-node',
      args: [
        join(loaded.extractedPath, 'server/index.js'),
        'top-secret',
        'one',
        'two',
        sep,
        homedir(),
        pluginData,
      ],
      env: {
        CLAUDE_PLUGIN_ROOT: canonicalPluginRoot,
        CLAUDE_PLUGIN_DATA: 'bundle-data-override',
        ROOT: loaded.extractedPath,
        DATA: pluginData,
        HOME_COPY: '/safe/home',
      },
    })
    expect(loaded.sensitiveValues).toEqual(['top-secret'])
    expect(
      (await stat(join(loaded.extractedPath, 'server/index.js'))).mode & 0o777,
    ).toBe(0o755)
    await expect(
      access(join(pluginRoot, '.mcpb-cache')),
    ).resolves.toBeUndefined()
  })

  it('recovers a corrupt cache and rolls back a failed local refresh', async () => {
    const good = bundle()
    const { pluginRoot, source, pluginData } = await fixture(good)
    const first = await loadClaudePluginMcpb({
      pluginRoot,
      pluginData,
      source: 'fixture.mcpb',
      userConfig: { TOKEN: 'secret' },
    })
    await writeFile(join(first.extractedPath, 'manifest.json'), '{broken')

    const recovered = await loadClaudePluginMcpb({
      pluginRoot,
      pluginData,
      source: 'fixture.mcpb',
      userConfig: { TOKEN: 'secret' },
    })
    expect(recovered.manifest.version).toBe('1.0.0')
    await writeFile(
      source,
      bundle(
        manifest({
          version: '2.0.0',
          surprise: true,
        }),
      ),
    )
    await expect(
      loadClaudePluginMcpb({
        pluginRoot,
        pluginData,
        source: 'fixture.mcpb',
        userConfig: { TOKEN: 'secret' },
      }),
    ).rejects.toThrow('Unable to load MCPB bundle')
    expect(
      JSON.parse(
        await readFile(join(recovered.extractedPath, 'manifest.json'), 'utf8'),
      ),
    ).toMatchObject({ version: '1.0.0' })

    await writeFile(source, good)
    const rolledBack = await loadClaudePluginMcpb({
      pluginRoot,
      pluginData,
      source: 'fixture.mcpb',
      userConfig: { TOKEN: 'secret' },
    })
    expect(rolledBack.manifest.version).toBe('1.0.0')
  })

  it('keeps URL caches sticky, refreshes explicitly, and redacts URL secrets', async () => {
    const { pluginRoot, pluginData } = await fixture()
    const bytes = bundle()
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(bytes, { status: 200, headers: { etag: '"v1"' } }),
      )
      .mockResolvedValueOnce(new Response('no', { status: 500 }))
    const source = 'https://user:password@example.test/bundle.mcpb'

    const first = await loadClaudePluginMcpb({
      pluginRoot,
      pluginData,
      source,
      fetch: fetcher,
      userConfig: { TOKEN: 'secret' },
    })
    const second = await loadClaudePluginMcpb({
      pluginRoot,
      pluginData,
      source,
      fetch: fetcher,
      userConfig: { TOKEN: 'secret' },
    })
    expect(second.extractedPath).toBe(first.extractedPath)
    expect(fetcher).toHaveBeenCalledTimes(1)

    await expect(
      loadClaudePluginMcpb({
        pluginRoot,
        pluginData,
        source,
        fetch: fetcher,
        refresh: true,
        userConfig: { TOKEN: 'secret' },
      }),
    ).rejects.toThrow('https://example.test/bundle.mcpb')
    await expect(
      loadClaudePluginMcpb({
        pluginRoot,
        pluginData,
        source,
        fetch: vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response('no', { status: 500 })),
        refresh: true,
        userConfig: { TOKEN: 'secret' },
      }),
    ).rejects.not.toThrow(/password|secret/u)
  })

  it('follows at most five HTTP redirects and rejects non-exact bundle suffixes', async () => {
    const { pluginRoot, pluginData } = await fixture()
    const bytes = bundle()
    const redirected = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: '/final.dxt' },
        }),
      )
      .mockResolvedValueOnce(new Response(bytes, { status: 200 }))
    await expect(
      loadClaudePluginMcpb({
        pluginRoot,
        pluginData,
        source: 'http://example.test/start.dxt',
        fetch: redirected,
        userConfig: { TOKEN: 'secret' },
      }),
    ).resolves.toMatchObject({ name: 'fixture-mcp' })
    expect(redirected).toHaveBeenNthCalledWith(
      2,
      'http://example.test/final.dxt',
      expect.objectContaining({ redirect: 'manual' }),
    )

    const looping = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: '/again.dxt' },
      }),
    )
    await expect(
      loadClaudePluginMcpb({
        pluginRoot,
        pluginData,
        source: 'https://example.test/loop.dxt',
        fetch: looping,
        refresh: true,
        userConfig: { TOKEN: 'secret' },
      }),
    ).rejects.toThrow('exceeded 5 redirects')
    expect(looping).toHaveBeenCalledTimes(6)

    for (const source of [
      'https://example.test/bundle.dxt?version=1',
      'https://example.test/bundle.MCPB',
    ]) {
      await expect(
        loadClaudePluginMcpb({
          pluginRoot,
          pluginData,
          source,
          fetch: vi.fn<typeof fetch>(),
          userConfig: { TOKEN: 'secret' },
        }),
      ).rejects.toThrow('must end in .mcpb or .dxt')
    }
  })

  it('rejects traversal, symlink, count, and expanded-size attacks without residue', async () => {
    const attacks: Array<
      [string, Uint8Array, Record<string, number> | undefined, RegExp]
    > = [
      [
        'traversal',
        bundle(manifest(), { '../outside': strToU8('bad') }),
        undefined,
        /stay inside bundle root/u,
      ],
      [
        'symlink',
        bundle(manifest(), {
          'server/link': [
            strToU8('index.js'),
            { os: 3, attrs: (0o120777 << 16) >>> 0 },
          ],
        }),
        undefined,
        /symlink/u,
      ],
      [
        'count',
        bundle(manifest(), { one: strToU8('1'), two: strToU8('2') }),
        { files: 2 },
        /exceeds 2 files/u,
      ],
      [
        'size',
        bundle(manifest(), { large: strToU8('123456789') }),
        { extractedBytes: 8 },
        /exceeds 8 extracted bytes/u,
      ],
      [
        'ratio',
        bundle(manifest(), { compressed: strToU8('x'.repeat(100_000)) }),
        undefined,
        /compression ratio exceeds 50/u,
      ],
    ]
    for (const [name, bytes, limits, expected] of attacks) {
      const { pluginRoot, pluginData } = await fixture(bytes)
      await expect(
        loadClaudePluginMcpb({
          pluginRoot,
          pluginData,
          source: 'fixture.mcpb',
          userConfig: { TOKEN: 'secret' },
          ...(limits === undefined ? {} : { limits }),
        }),
      ).rejects.toThrow(expected)
      const cacheNames = await readFile(join(pluginRoot, 'fixture.mcpb')).then(
        () => stat(join(pluginRoot, '.mcpb-cache')).catch(() => undefined),
      )
      if (cacheNames) {
        expect(
          (await readdir(join(pluginRoot, '.mcpb-cache'))).filter(
            (entry) => entry.endsWith('.tmp') || entry.includes('.tmp-'),
          ),
        ).toEqual([])
      }
      expect(name).toBeTruthy()
    }
  })

  it('enforces declared bounds while streaming and removes partial output', async () => {
    const bytes = withCentralSize(
      bundle(manifest(), {
        'server/payload.txt': strToU8('abcdefgh'.repeat(8_000)),
      }),
      'server/payload.txt',
      16,
    )
    const { pluginRoot, pluginData } = await fixture(bytes)
    await expect(
      loadClaudePluginMcpb({
        pluginRoot,
        pluginData,
        source: 'fixture.mcpb',
        userConfig: { TOKEN: 'secret' },
      }),
    ).rejects.toThrow('Unable to load MCPB bundle')
    expect(
      (await readdir(join(pluginRoot, '.mcpb-cache'))).filter(
        (entry) => entry.includes('.tmp-') || entry.endsWith('.bak'),
      ),
    ).toEqual([])
  })

  it('rejects a symlinked cache root before writing outside the plugin', async () => {
    const { root, pluginRoot, pluginData } = await fixture()
    const externalCache = join(root, 'external-cache')
    await mkdir(externalCache)
    await symlink(externalCache, join(pluginRoot, '.mcpb-cache'), 'dir')
    await expect(
      loadClaudePluginMcpb({
        pluginRoot,
        pluginData,
        source: 'fixture.mcpb',
        userConfig: { TOKEN: 'secret' },
      }),
    ).rejects.toThrow('cache root must be a real directory')
    expect(await readdir(externalCache)).toEqual([])
  })

  it('rebuilds preseeded symlinked cache entries, extracted directories, and metadata', async () => {
    for (const target of ['cache-entry', 'extracted', 'metadata'] as const) {
      const { root, pluginRoot, pluginData } = await fixture()
      const first = await loadClaudePluginMcpb({
        pluginRoot,
        pluginData,
        source: 'fixture.mcpb',
        userConfig: { TOKEN: 'secret' },
      })
      const cacheEntry = join(first.extractedPath, '..')
      const external = join(root, `external-${target}`)
      if (target === 'cache-entry') {
        await rename(cacheEntry, external)
        await symlink(external, cacheEntry, 'dir')
      } else if (target === 'extracted') {
        await rename(first.extractedPath, external)
        await symlink(external, first.extractedPath, 'dir')
      } else {
        const metadataPath = join(cacheEntry, 'metadata.json')
        await rename(metadataPath, external)
        await symlink(external, metadataPath, 'file')
      }

      const sentinel =
        target === 'metadata' ? external : join(external, 'sentinel')
      if (target !== 'metadata') await writeFile(sentinel, 'outside')
      const outsideBefore = await readFile(sentinel, 'utf8')
      const recovered = await loadClaudePluginMcpb({
        pluginRoot,
        pluginData,
        source: 'fixture.mcpb',
        userConfig: { TOKEN: 'secret' },
      })

      expect(recovered.manifest.version).toBe('1.0.0')
      expect((await lstat(cacheEntry)).isDirectory()).toBe(true)
      expect((await lstat(cacheEntry)).isSymbolicLink()).toBe(false)
      expect((await lstat(recovered.extractedPath)).isDirectory()).toBe(true)
      expect((await lstat(recovered.extractedPath)).isSymbolicLink()).toBe(
        false,
      )
      expect((await lstat(join(cacheEntry, 'metadata.json'))).isFile()).toBe(
        true,
      )
      expect(
        (await lstat(join(cacheEntry, 'metadata.json'))).isSymbolicLink(),
      ).toBe(false)
      expect(await readFile(sentinel, 'utf8')).toBe(outsideBefore)
    }
  })

  it('discards a backup whose extracted directory is a symlink', async () => {
    const { root, pluginRoot, pluginData } = await fixture()
    const first = await loadClaudePluginMcpb({
      pluginRoot,
      pluginData,
      source: 'fixture.mcpb',
      userConfig: { TOKEN: 'secret' },
    })
    const cacheEntry = join(first.extractedPath, '..')
    const backup = `${cacheEntry}.999999.deadbeef.bak`
    const externalExtracted = join(root, 'external-backup-extracted')
    await rename(cacheEntry, backup)
    await rename(join(backup, 'extracted'), externalExtracted)
    await writeFile(join(externalExtracted, 'sentinel'), 'outside')
    await symlink(externalExtracted, join(backup, 'extracted'), 'dir')

    const recovered = await loadClaudePluginMcpb({
      pluginRoot,
      pluginData,
      source: 'fixture.mcpb',
      userConfig: { TOKEN: 'secret' },
    })

    expect(recovered.manifest.version).toBe('1.0.0')
    expect((await lstat(cacheEntry)).isDirectory()).toBe(true)
    expect((await lstat(recovered.extractedPath)).isSymbolicLink()).toBe(false)
    await expect(access(backup)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(externalExtracted, 'sentinel'), 'utf8')).toBe(
      'outside',
    )
  })

  it('strictly validates manifests and required user_config values', async () => {
    const unknown = await fixture(bundle(manifest({ surprise: true })))
    await expect(
      loadClaudePluginMcpb({
        pluginRoot: unknown.pluginRoot,
        pluginData: unknown.pluginData,
        source: 'fixture.mcpb',
        userConfig: { TOKEN: 'secret' },
      }),
    ).rejects.toThrow("Unrecognized key(s) in object: 'surprise'")

    const required = await fixture()
    await expect(
      loadClaudePluginMcpb({
        pluginRoot: required.pluginRoot,
        pluginData: required.pluginData,
        source: 'fixture.mcpb',
      }),
    ).rejects.toThrow('Required MCPB user_config is missing: TOKEN')
    await expect(
      loadClaudePluginMcpb({
        pluginRoot: required.pluginRoot,
        pluginData: required.pluginData,
        source: '../fixture.mcpb',
        userConfig: { TOKEN: 'secret' },
      }),
    ).rejects.toThrow('escapes plugin root')
  })

  it('rejects missing, malformed, and rootless manifests', async () => {
    const invalidBundles = [
      zipSync({ 'server/index.js': strToU8('') }),
      zipSync({
        'manifest.json': strToU8('{broken'),
        'server/index.js': strToU8(''),
      }),
      zipSync({
        'nested/manifest.json': strToU8(JSON.stringify(manifest())),
        'nested/server/index.js': strToU8(''),
      }),
    ]
    for (const bytes of invalidBundles) {
      const { pluginRoot, pluginData } = await fixture(bytes)
      await expect(
        loadClaudePluginMcpb({
          pluginRoot,
          pluginData,
          source: 'fixture.mcpb',
          userConfig: { TOKEN: 'secret' },
        }),
      ).rejects.toThrow('Unable to load MCPB bundle')
    }
  })

  it('keeps an extracted cache while required config is unavailable', async () => {
    const { pluginRoot, pluginData } = await fixture()
    await expect(
      loadClaudePluginMcpb({
        pluginRoot,
        pluginData,
        source: 'fixture.mcpb',
      }),
    ).rejects.toThrow('Required MCPB user_config is missing: TOKEN')
    const [cacheName] = await readdir(join(pluginRoot, '.mcpb-cache'))
    expect(cacheName).toBeTruthy()
    const manifestPath = join(
      pluginRoot,
      '.mcpb-cache',
      cacheName ?? '',
      'extracted',
      'manifest.json',
    )
    const cachedAt = (await stat(manifestPath)).mtimeMs

    const loaded = await loadClaudePluginMcpb({
      pluginRoot,
      pluginData,
      source: 'fixture.mcpb',
      userConfig: { TOKEN: 'secret' },
    })
    expect(loaded.extractedPath).toBe(
      join(
        await realpath(pluginRoot),
        '.mcpb-cache',
        cacheName ?? '',
        'extracted',
      ),
    )
    expect((await stat(manifestPath)).mtimeMs).toBe(cachedAt)
  })

  it('atomically converges concurrent loads on one cache entry', async () => {
    const { pluginRoot, pluginData } = await fixture()
    const loaded = await Promise.all(
      Array.from({ length: 8 }, () =>
        loadClaudePluginMcpb({
          pluginRoot,
          pluginData,
          source: 'fixture.mcpb',
          userConfig: { TOKEN: 'secret' },
        }),
      ),
    )
    expect(new Set(loaded.map((item) => item.extractedPath)).size).toBe(1)
    expect(
      (await readdir(join(pluginRoot, '.mcpb-cache'))).filter(
        (entry) => entry.includes('.tmp-') || entry.endsWith('.bak'),
      ),
    ).toEqual([])
  })

  it('recovers a malformed cache lock without deleting a new active lease', async () => {
    const { pluginRoot, pluginData } = await fixture()
    const first = await loadClaudePluginMcpb({
      pluginRoot,
      pluginData,
      source: 'fixture.mcpb',
      userConfig: { TOKEN: 'secret' },
    })
    const cacheEntry = join(first.extractedPath, '..')
    const lockFile = `${cacheEntry}.lock`
    await writeFile(lockFile, '{malformed', { mode: 0o600 })

    const loaded = await Promise.all(
      Array.from({ length: 8 }, () =>
        loadClaudePluginMcpb({
          pluginRoot,
          pluginData,
          source: 'fixture.mcpb',
          userConfig: { TOKEN: 'secret' },
        }),
      ),
    )
    expect(new Set(loaded.map((item) => item.extractedPath))).toEqual(
      new Set([first.extractedPath]),
    )
    await expect(access(lockFile)).rejects.toMatchObject({ code: 'ENOENT' })

    await mkdir(lockFile)
    await writeFile(join(lockFile, 'partial'), 'partial')
    await expect(
      loadClaudePluginMcpb({
        pluginRoot,
        pluginData,
        source: 'fixture.mcpb',
        userConfig: { TOKEN: 'secret' },
      }),
    ).resolves.toMatchObject({ extractedPath: first.extractedPath })
    await expect(access(lockFile)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('serializes independent loader instances across canonical symlink aliases', async () => {
    const { root, pluginRoot, pluginData } = await fixture()
    const pluginAlias = join(root, 'plugin-alias')
    await symlink(pluginRoot, pluginAlias, 'dir')
    vi.resetModules()
    const firstLoader = (await import('./claude-plugin-mcpb.js'))
      .loadClaudePluginMcpb
    vi.resetModules()
    const secondLoader = (await import('./claude-plugin-mcpb.js'))
      .loadClaudePluginMcpb
    let releaseDownload = (): void => undefined
    const downloadBlocked = new Promise<void>((resolveDownload) => {
      releaseDownload = resolveDownload
    })
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
      await downloadBlocked
      return new Response(bundle(), { status: 200 })
    })
    const source = 'https://example.test/serialized.dxt'
    const first = firstLoader({
      pluginRoot,
      pluginData,
      source,
      fetch: fetcher,
      userConfig: { TOKEN: 'secret' },
    })
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
    const second = secondLoader({
      pluginRoot: pluginAlias,
      pluginData,
      source,
      fetch: fetcher,
      userConfig: { TOKEN: 'secret' },
    })
    await new Promise((resolveWait) => setTimeout(resolveWait, 25))
    expect(fetcher).toHaveBeenCalledTimes(1)
    releaseDownload()

    const [firstLoaded, secondLoaded] = await Promise.all([first, second])
    expect(firstLoaded.extractedPath).toBe(secondLoaded.extractedPath)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('restores interrupted backups and removes stale staging under its lease', async () => {
    const { pluginRoot, pluginData } = await fixture()
    const first = await loadClaudePluginMcpb({
      pluginRoot,
      pluginData,
      source: 'fixture.mcpb',
      userConfig: { TOKEN: 'secret' },
    })
    const cacheEntry = join(first.extractedPath, '..')
    const cacheRoot = join(cacheEntry, '..')
    const cacheName = cacheEntry.split(sep).at(-1) ?? ''
    const backup = `${cacheEntry}.999999.deadbeef.bak`
    const staleStaging = join(cacheRoot, `.${cacheName}.999999.tmp-orphan`)
    await rename(cacheEntry, backup)
    await mkdir(staleStaging)
    await writeFile(join(staleStaging, 'partial'), 'partial')

    const recovered = await loadClaudePluginMcpb({
      pluginRoot,
      pluginData,
      source: 'fixture.mcpb',
      userConfig: { TOKEN: 'secret' },
    })
    expect(recovered.manifest.version).toBe('1.0.0')
    await expect(access(backup)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(staleStaging)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('honors timeout and caller cancellation while waiting for the cache lease', async () => {
    const { pluginRoot, pluginData } = await fixture()
    const loaded = await loadClaudePluginMcpb({
      pluginRoot,
      pluginData,
      source: 'fixture.mcpb',
      userConfig: { TOKEN: 'secret' },
    })
    const lease = new ExclusiveFileLease(
      `${join(loaded.extractedPath, '..')}.lock`,
    )
    const held = await lease.tryAcquire()
    expect(held).not.toBeNull()
    try {
      await expect(
        loadClaudePluginMcpb({
          pluginRoot,
          pluginData,
          source: 'fixture.mcpb',
          timeoutMs: 20,
          userConfig: { TOKEN: 'secret' },
        }),
      ).rejects.toThrow(/timeout/u)

      const controller = new AbortController()
      const waiting = loadClaudePluginMcpb({
        pluginRoot,
        pluginData,
        source: 'fixture.mcpb',
        signal: controller.signal,
        userConfig: { TOKEN: 'secret' },
      })
      controller.abort(new Error('lease cancelled'))
      await expect(waiting).rejects.toThrow('lease cancelled')
    } finally {
      await held?.release()
    }
  })

  it('supports DXT versions and current-platform MCP config overrides', async () => {
    const value = await fixture(
      bundle(
        manifest({
          manifest_version: undefined,
          dxt_version: '0.3',
          $schema: 'https://example.test/mcpb.schema.json',
          server: {
            type: 'node',
            entry_point: 'server/index.js',
            mcp_config: {
              command: 'base-command',
              args: ['base'],
              env: { SOURCE: 'base' },
              platform_overrides: {
                [process.platform]: {
                  command: 'platform-command',
                  args: ['${user_config.PATHS}'],
                  env: { SOURCE: 'platform' },
                },
              },
            },
          },
        }),
      ),
    )

    const loaded = await loadClaudePluginMcpb({
      pluginRoot: value.pluginRoot,
      pluginData: value.pluginData,
      source: 'fixture.mcpb',
      userConfig: { TOKEN: 'secret', PATHS: ['alpha', 'beta'] },
    })

    expect(loaded.config).toMatchObject({
      command: 'platform-command',
      args: ['alpha', 'beta'],
      env: { SOURCE: 'platform' },
    })
  })

  it('accepts official MCPB 0.4 UV runtime manifests', async () => {
    const value = await fixture(
      bundle(
        manifest({
          manifest_version: '0.4',
          server: {
            type: 'uv',
            entry_point: 'server/index.js',
            mcp_config: { command: 'uv', args: ['run', '${__dirname}'] },
          },
        }),
      ),
    )
    await expect(
      loadClaudePluginMcpb({
        pluginRoot: value.pluginRoot,
        pluginData: value.pluginData,
        source: 'fixture.mcpb',
        userConfig: { TOKEN: 'secret' },
      }),
    ).resolves.toMatchObject({
      manifest: { manifest_version: '0.4', server: { type: 'uv' } },
      config: { command: 'uv' },
    })
  })

  it('enforces bounded downloads, timeout, and caller cancellation', async () => {
    const { pluginRoot, pluginData } = await fixture()
    const oversized = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response('x', { headers: { 'content-length': '100' } }),
      )
    await expect(
      loadClaudePluginMcpb({
        pluginRoot,
        pluginData,
        source: 'http://example.test/x.dxt',
        fetch: oversized,
        limits: { archiveBytes: 10 },
        userConfig: { TOKEN: 'secret' },
      }),
    ).rejects.toThrow('exceeds 10 bytes')

    const hanging = vi.fn<typeof fetch>().mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(init.signal?.reason),
            { once: true },
          )
        }),
    )
    await expect(
      loadClaudePluginMcpb({
        pluginRoot,
        pluginData,
        source: 'https://example.test/x.dxt',
        fetch: hanging,
        timeoutMs: 1_000,
        userConfig: { TOKEN: 'secret' },
      }),
    ).rejects.toThrow('MCPB download failed')

    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    await expect(
      loadClaudePluginMcpb({
        pluginRoot,
        pluginData,
        source: 'fixture.mcpb',
        signal: controller.signal,
        userConfig: { TOKEN: 'secret' },
      }),
    ).rejects.toThrow('cancelled')
  })
})
