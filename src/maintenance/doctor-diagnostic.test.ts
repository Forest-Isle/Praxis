import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  collectDoctorDiagnostics,
  loadPraxisDistTags,
  type DoctorDiagnosticOptions,
} from './doctor-diagnostic.js'

const roots: string[] = []

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'praxis-doctor-diagnostic-'))
  roots.push(root)
  return root
}

async function makeExecutable(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, '#!/bin/sh\n')
  await chmod(path, 0o755)
}

function options(
  executablePath: string,
  environment: NodeJS.ProcessEnv = {},
  extra: Partial<DoctorDiagnosticOptions> = {},
): DoctorDiagnosticOptions {
  return {
    version: '0.1.0',
    executablePath,
    configRoot: '/tmp/config',
    environment,
    autoUpdateChannel: 'stable',
    loadDistTags: async () => ({ stable: '1.0.0', latest: '1.1.0' }),
    ...extra,
  }
}

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe('collectDoctorDiagnostics', () => {
  it('collects npm installation diagnostics with available registry state', async () => {
    const root = await fixture()
    const executablePath = join(
      root,
      'lib',
      'node_modules',
      'praxis-agent',
      'bin',
      'praxis',
    )
    await makeExecutable(executablePath)
    const result = await collectDoctorDiagnostics(
      options(executablePath, { CLAUDE_CONFIG_DIR: join(root, 'config') }),
    )
    expect(result.diagnostic.installationType).toBe('npm')
    expect(result.diagnostic.packageManager).toBe('npm')
    expect(result.diagnostic.version).toBe('0.1.0')
    expect(result.diagnostic.installationPath).toBe(
      await realpath(executablePath),
    )
    expect(result.diagnostic.invokedBinary).toBe(resolve(executablePath))
    expect(result.diagnostic.configInstallMethod).toBe('CLAUDE_CONFIG_DIR')
    expect(result.diagnostic.search).toEqual({
      working: false,
      mode: 'system',
      systemPath: null,
    })
    expect(result.diagnostic.multipleInstallations).toEqual([
      await realpath(executablePath),
    ])
    expect(result.diagnostic.recommendation).toBeNull()
    expect(result.diagnostic.warnings).toHaveLength(1)
    expect(result.diagnostic.warnings[0]).toMatchObject({
      issue: expect.stringContaining('rg'),
      fix: expect.stringMatching(/install/iu),
    })
    expect(result.updates.autoUpdates).toBe('Manual (praxis update)')
    expect(result.updates.hasUpdatePermissions).toBe(true)
    expect(result.updates.channel).toBe('stable')
    expect(result.updates.registryStatus).toBe('available')
    expect(result.updates.stableVersion).toBe('1.0.0')
    expect(result.updates.latestVersion).toBe('1.1.0')
    expect(result.updates.error).toBeUndefined()
  })

  it('collects source installation diagnostics without a package manager', async () => {
    const root = await fixture()
    const executablePath = join(root, 'bin', 'praxis')
    await makeExecutable(executablePath)
    const result = await collectDoctorDiagnostics(options(executablePath, {}))
    expect(result.diagnostic.installationType).toBe('source')
    expect(result.diagnostic.packageManager).toBeNull()
    expect(result.diagnostic.configInstallMethod).toBe('default (~/.claude)')
    expect(result.updates.autoUpdates).toBe('Managed by source checkout')
  })

  it('reports a working ripgrep search from PATH without warnings', async () => {
    const root = await fixture()
    const rgPath = join(root, 'bin', 'rg')
    const executablePath = join(root, 'bin', 'praxis')
    await makeExecutable(rgPath)
    await makeExecutable(executablePath)
    const result = await collectDoctorDiagnostics(
      options(executablePath, { PATH: join(root, 'bin') }),
    )
    expect(result.diagnostic.search).toEqual({
      working: true,
      mode: 'system',
      systemPath: await realpath(rgPath),
    })
    expect(result.diagnostic.warnings).toEqual([])
  })

  it('reports a missing search with a concrete install fix', async () => {
    const root = await fixture()
    const executablePath = join(root, 'bin', 'praxis')
    await makeExecutable(executablePath)
    const result = await collectDoctorDiagnostics(
      options(executablePath, { PATH: join(root, 'empty') }),
    )
    expect(result.diagnostic.search.working).toBe(false)
    expect(result.diagnostic.search.systemPath).toBeNull()
    expect(result.diagnostic.warnings).toHaveLength(1)
    expect(result.diagnostic.warnings[0]?.issue).toContain('rg')
    expect(result.diagnostic.warnings[0]?.fix).toMatch(/install/iu)
  })

  it('does not treat a readable non-executable PATH entry as ripgrep', async () => {
    const root = await fixture()
    const rgPath = join(root, 'bin', 'rg')
    const executablePath = join(root, 'bin', 'praxis')
    await makeExecutable(executablePath)
    await writeFile(rgPath, '#!/bin/sh\n')
    await chmod(rgPath, 0o644)
    const result = await collectDoctorDiagnostics(
      options(executablePath, { PATH: join(root, 'bin') }),
    )
    expect(result.diagnostic.search).toEqual({
      working: false,
      mode: 'system',
      systemPath: null,
    })
  })

  it('detects duplicate installations and recommends removing stale copies', async () => {
    const root = await fixture()
    const first = join(root, 'one', 'praxis')
    const second = join(root, 'two', 'praxis')
    const executablePath = join(root, 'three', 'praxis')
    await makeExecutable(first)
    await makeExecutable(second)
    await makeExecutable(executablePath)
    const environment = {
      PATH: [join(root, 'one'), join(root, 'two'), join(root, 'three')].join(
        delimiter,
      ),
    }
    const result = await collectDoctorDiagnostics(
      options(executablePath, environment),
    )
    const expected = (
      await Promise.all([
        realpath(first),
        realpath(second),
        realpath(executablePath),
      ])
    ).sort()
    expect(result.diagnostic.multipleInstallations).toEqual(expected)
    expect(result.diagnostic.recommendation).toMatch(/stale duplicate/iu)
  })

  it('deduplicates identical canonical installations on PATH', async () => {
    const root = await fixture()
    const bin = join(root, 'bin')
    const executablePath = join(bin, 'praxis')
    await makeExecutable(executablePath)
    const result = await collectDoctorDiagnostics(
      options(executablePath, {
        PATH: [bin, bin, join(root, 'empty')].join(delimiter),
      }),
    )
    expect(result.diagnostic.multipleInstallations).toEqual([
      await realpath(executablePath),
    ])
    expect(result.diagnostic.recommendation).toBeNull()
  })

  it('keeps the unresolved invocation path distinct from the canonical path', async () => {
    const root = await fixture()
    const executablePath = join(
      root,
      'lib',
      'node_modules',
      'praxis-agent',
      'bin',
      'praxis',
    )
    const invokedBinaryPath = join(root, 'bin', 'praxis')
    await makeExecutable(executablePath)
    await makeExecutable(invokedBinaryPath)
    const result = await collectDoctorDiagnostics(
      options(executablePath, {}, { invokedBinaryPath }),
    )
    expect(result.diagnostic.invokedBinary).toBe(resolve(invokedBinaryPath))
    expect(result.diagnostic.installationPath).toBe(
      await realpath(executablePath),
    )
  })

  it('marks the registry unavailable when latest is missing', async () => {
    const root = await fixture()
    const executablePath = join(root, 'bin', 'praxis')
    await makeExecutable(executablePath)
    const result = await collectDoctorDiagnostics(
      options(
        executablePath,
        {},
        { loadDistTags: async () => ({ stable: '1.0.0' }) },
      ),
    )
    expect(result.updates.registryStatus).toBe('unavailable')
    expect(result.updates.stableVersion).toBeNull()
    expect(result.updates.latestVersion).toBeNull()
    expect(result.updates.error).toMatch(/Failed to fetch version/iu)
  })

  it('never throws when the dist-tag loader fails', async () => {
    const root = await fixture()
    const executablePath = join(root, 'bin', 'praxis')
    await makeExecutable(executablePath)
    const result = await collectDoctorDiagnostics(
      options(
        executablePath,
        {},
        {
          loadDistTags: async () => {
            throw new Error('registry boom')
          },
        },
      ),
    )
    expect(result.updates.registryStatus).toBe('unavailable')
    expect(result.updates.latestVersion).toBeNull()
    expect(result.updates.error).toContain('registry boom')
  })

  it('honors the persisted auto-update channel', async () => {
    const root = await fixture()
    const executablePath = join(root, 'bin', 'praxis')
    await makeExecutable(executablePath)
    const result = await collectDoctorDiagnostics(
      options(executablePath, {}, { autoUpdateChannel: 'latest' }),
    )
    expect(result.updates.channel).toBe('latest')
  })

  it('reports update permissions as null for an unclassifiable filesystem error', async () => {
    const root = await fixture()
    const executablePath = join(root, 'bin', 'praxis')
    await makeExecutable(executablePath)
    const result = await collectDoctorDiagnostics(
      options(
        executablePath,
        {},
        {
          invokedBinaryPath: join(root, 'does-not-exist', 'praxis'),
        },
      ),
    )
    expect(result.updates.hasUpdatePermissions).toBeNull()
  })

  it('reports denied update permissions as false', async () => {
    const root = await fixture()
    const executablePath = join(root, 'bin', 'praxis')
    await makeExecutable(executablePath)
    const checkedDirectories: string[] = []
    const result = await collectDoctorDiagnostics(
      options(
        executablePath,
        {},
        {
          checkUpdatePermissions: async (directory) => {
            checkedDirectories.push(directory)
            return false
          },
        },
      ),
    )
    expect(result.updates.hasUpdatePermissions).toBe(false)
    expect(checkedDirectories).toEqual([dirname(resolve(executablePath))])
  })
})

describe('loadPraxisDistTags', () => {
  it('returns non-empty stable and latest tags from an OK response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ stable: '1.0.0', latest: '1.1.0' }),
      })),
    )
    await expect(loadPraxisDistTags()).resolves.toEqual({
      stable: '1.0.0',
      latest: '1.1.0',
    })
  })

  it('requests the fixed npm dist-tags endpoint without user input', async () => {
    let requestedUrl: string | URL | Request | undefined
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      requestedUrl = url
      return { ok: true, json: async () => ({ latest: '1.1.0' }) }
    })
    vi.stubGlobal('fetch', fetchMock)
    await loadPraxisDistTags()
    expect(String(requestedUrl)).toBe(
      'https://registry.npmjs.org/-/package/praxis-agent/dist-tags',
    )
  })

  it('returns an empty object for a non-OK response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false })),
    )
    await expect(loadPraxisDistTags()).resolves.toEqual({})
  })

  it('ignores non-object dist-tag payloads', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => 'not-object' })),
    )
    await expect(loadPraxisDistTags()).resolves.toEqual({})
  })

  it('drops empty or non-string tag values', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          stable: '  1.0.0  ',
          latest: '',
          other: 'ignored',
        }),
      })),
    )
    await expect(loadPraxisDistTags()).resolves.toEqual({ stable: '1.0.0' })
  })

  it('yields an empty object when fetch rejects', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down')
      }),
    )
    await expect(loadPraxisDistTags()).resolves.toEqual({})
  })
})
