import { execFile } from 'node:child_process'
import { access, chmod, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp } from 'node:fs/promises'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { run } from '../cli.js'
import { createOwnedManagedWorktree } from '../application/managed-worktree.js'
import { inspectManagedWorktreeRegistry } from '../persistence/managed-worktree-store.js'
import { ProviderCredentialVault } from '../persistence/provider-credential-vault.js'
import { loadNativeSharedResources } from '../persistence/native-resources.js'
import { sanitizeProjectPath } from '../platform/project-path-key.js'
import {
  assessWorkspaceTrust,
  persistWorkspaceTrust,
  workspaceTrustInventory,
} from '../security/workspace-trust.js'
import {
  pluginRegistryPath,
  writePluginRegistry,
} from '../plugins/claude-plugin-runtime.js'
import {
  formatDoctorReport,
  runDoctor,
  type DoctorProgressReport,
} from './doctor.js'

const roots: string[] = []
const execFileAsync = promisify(execFile)

async function fixture(): Promise<{
  root: string
  configRoot: string
  projectRoot: string
  executablePath: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'praxis-doctor-'))
  roots.push(root)
  const configRoot = join(root, 'config')
  const projectRoot = join(root, 'project')
  const executablePath = join(root, 'praxis')
  await mkdir(join(projectRoot, '.praxis'), { recursive: true })
  await mkdir(configRoot, { recursive: true })
  await writeFile(executablePath, '#!/bin/sh\n')
  await chmod(executablePath, 0o755)
  await writeFile(
    join(configRoot, 'settings.json'),
    JSON.stringify({ permissions: { allow: ['Read'] } }),
  )
  await writeFile(
    join(projectRoot, '.praxis', 'settings.local.json'),
    JSON.stringify({
      autoMode: {
        allow: ['$defaults', 'local builds'],
        soft_deny: [],
        hard_deny: [],
        environment: ['single user'],
        classifyAllShell: true,
      },
    }),
  )
  await writeFile(
    join(projectRoot, '.praxis', 'mcp.json'),
    JSON.stringify({
      mcpServers: {
        docs: { type: 'http', url: 'https://example.test/mcp' },
      },
    }),
  )
  return { root, configRoot, projectRoot, executablePath }
}

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

function deterministicDistTags(): {
  autoUpdateChannel: 'stable'
  loadDistTags: () => Promise<{ stable: string; latest: string }>
} {
  return {
    autoUpdateChannel: 'stable',
    loadDistTags: async () => ({ stable: '1.0.0', latest: '1.1.0' }),
  }
}

describe('Praxis doctor', () => {
  async function doctorFor(
    value: Awaited<ReturnType<typeof fixture>>,
    environment: NodeJS.ProcessEnv,
  ) {
    return runDoctor({
      version: '0.1.0',
      executablePath: value.executablePath,
      nodeExecutablePath: process.execPath,
      nodeVersion: 'v24.1.0',
      configRoot: value.configRoot,
      claudeStatePath: join(value.configRoot, 'state.json'),
      cwd: value.projectRoot,
      environment,
      detectClaudeVersion: async () => '2.1.208',
      ...deterministicDistTags(),
    })
  }

  async function initializeGitProject(projectRoot: string): Promise<void> {
    await execFileAsync('git', ['-C', projectRoot, 'init', '-q'])
    await execFileAsync('git', [
      '-C',
      projectRoot,
      'config',
      'user.email',
      'praxis@example.test',
    ])
    await execFileAsync('git', [
      '-C',
      projectRoot,
      'config',
      'user.name',
      'Praxis Test',
    ])
    await writeFile(join(projectRoot, 'tracked.txt'), 'base\n')
    await execFileAsync('git', ['-C', projectRoot, 'add', 'tracked.txt'])
    await execFileAsync('git', ['-C', projectRoot, 'commit', '-qm', 'seed'])
  }

  it('uses only an exact trusted project provider selection', async () => {
    const value = await fixture()
    const environment: NodeJS.ProcessEnv = {
      NAMED_DOCTOR_KEY: 'doctor-secret',
      PRAXIS_PROVIDER_CREDENTIAL_STORE: 'file',
    }
    await writeFile(
      join(value.configRoot, 'settings.json'),
      JSON.stringify({
        provider: 'fallback',
        providerProfile: 'user',
        model: 'user-model',
        providers: {
          fallback: {
            protocol: 'openai-compatible',
            profiles: {
              user: {
                baseUrl: 'https://user.example/v1',
                credential: { source: 'env', name: 'NAMED_DOCTOR_KEY' },
              },
              project: {
                baseUrl: 'https://project.example/v1',
                credential: { source: 'env', name: 'NAMED_DOCTOR_KEY' },
              },
            },
          },
        },
      }),
    )
    await writeFile(
      join(value.projectRoot, '.praxis', 'settings.json'),
      JSON.stringify({
        provider: 'fallback',
        providerProfile: 'project',
        model: 'project-model',
      }),
    )
    const first = await doctorFor(value, environment)
    expect(
      first.checks.find((check) => check.id === 'provider')?.details,
    ).toMatchObject({
      profile: 'user',
      model: 'user-model',
      baseUrl: 'https://user.example/v1',
    })
    const shared = await loadNativeSharedResources({
      root: value.configRoot,
      cwd: value.projectRoot,
      environment,
      includeProjectMemory: false,
    })
    const assessment = await assessWorkspaceTrust(
      await workspaceTrustInventory({
        cwd: value.projectRoot,
        settings: shared.settings,
        mcp: shared.mcp,
      }),
      join(value.configRoot, 'state.json'),
    )
    await persistWorkspaceTrust(
      assessment,
      join(value.configRoot, 'state.json'),
    )
    const trusted = await doctorFor(value, environment)
    expect(
      trusted.checks.find((check) => check.id === 'provider')?.details,
    ).toMatchObject({
      profile: 'project',
      model: 'project-model',
      baseUrl: 'https://project.example/v1',
    })
    await writeFile(
      join(value.projectRoot, '.praxis', 'settings.json'),
      JSON.stringify({
        provider: 'fallback',
        providerProfile: 'project',
        model: 'changed-model',
      }),
    )
    const stale = await doctorFor(value, environment)
    expect(
      stale.checks.find((check) => check.id === 'provider')?.details,
    ).toMatchObject({
      profile: 'user',
      model: 'user-model',
    })
    expect(JSON.stringify(stale)).not.toContain('doctor-secret')
  })

  it('diagnoses native custom providers and named environment credentials safely', async () => {
    const value = await fixture()
    await writeFile(
      join(value.configRoot, 'settings.json'),
      JSON.stringify({
        providers: {
          vendor: {
            protocol: 'openai-compatible',
            profiles: {
              named: {
                baseUrl: 'https://vendor.example/v1?secret=query#hash',
                credential: { source: 'env', name: 'VENDOR_KEY' },
              },
            },
          },
        },
      }),
    )
    const report = await doctorFor(value, {
      PRAXIS_PROVIDER: 'vendor',
      PRAXIS_PROVIDER_PROFILE: 'named',
      PRAXIS_MODEL: 'vendor-model',
      VENDOR_KEY: 'vendor-secret',
    })
    const provider = report.checks.find((check) => check.id === 'provider')
    if (!provider) throw new Error('provider check missing')
    expect(provider).toMatchObject({
      status: 'warn',
      details: {
        provider: 'vendor',
        profile: 'named',
        model: 'vendor-model',
        credential: { source: 'env', name: 'VENDOR_KEY' },
      },
    })
    expect(JSON.stringify(report)).not.toContain('vendor-secret')
    expect(JSON.stringify(report)).not.toContain('secret=query')
    expect(JSON.stringify(report)).not.toContain('#hash')
    expect(formatDoctorReport(report)).not.toContain('secret=query')
  })

  it('diagnoses file-backed Vault API keys without exposing vault data', async () => {
    const value = await fixture()
    await writeFile(
      join(value.configRoot, 'settings.json'),
      JSON.stringify({
        providers: {
          vendor: {
            protocol: 'openai-compatible',
            profiles: {
              vaulty: {
                baseUrl: 'https://vendor.example/v1',
                credential: { source: 'vault' },
              },
            },
          },
        },
      }),
    )
    const vault = new ProviderCredentialVault({
      configRoot: value.configRoot,
      useKeychain: false,
    })
    await vault.modify({ providerId: 'vendor', profileId: 'vaulty' }, () => ({
      type: 'api-key',
      secret: 'vault-secret',
    }))
    const report = await doctorFor(value, {
      PRAXIS_PROVIDER: 'vendor',
      PRAXIS_PROVIDER_PROFILE: 'vaulty',
      PRAXIS_MODEL: 'gpt-4o-mini',
      PRAXIS_PROVIDER_CREDENTIAL_STORE: 'file',
    })
    const serialized = JSON.stringify(report)
    expect(
      report.checks.find((check) => check.id === 'provider'),
    ).toMatchObject({ status: 'pass' })
    expect(serialized).not.toContain('vault-secret')
    expect(serialized).not.toContain('revision')
    expect(serialized).not.toContain('provider-credentials.json')
    expect(serialized).not.toContain('service')
  })

  it('diagnoses Codex OAuth without pricing parsing or network calls', async () => {
    const value = await fixture()
    await writeFile(
      join(value.configRoot, 'settings.json'),
      JSON.stringify({ experimental: { codexSubscription: true } }),
    )
    const vault = new ProviderCredentialVault({
      configRoot: value.configRoot,
      useKeychain: false,
    })
    await vault.modify(
      { providerId: 'openai-codex', profileId: 'named' },
      () => ({
        type: 'oauth',
        accessToken: 'access-secret',
        refreshToken: 'refresh-secret',
        expiresAt: Date.now() + 86_400_000,
        accountId: 'account-secret',
      }),
    )
    const fetch = vi.fn(() => {
      throw new Error('network must not run')
    })
    vi.stubGlobal('fetch', fetch)
    const report = await doctorFor(value, {
      PRAXIS_PROVIDER: 'openai-codex',
      PRAXIS_PROVIDER_PROFILE: 'named',
      PRAXIS_MODEL: 'codex-model',
      PRAXIS_PRICING_JSON: '{malformed',
      PRAXIS_PROVIDER_CREDENTIAL_STORE: 'file',
    })
    const provider = report.checks.find((check) => check.id === 'provider')
    if (!provider) throw new Error('provider check missing')
    expect(provider.status).toBe('pass')
    expect(provider.details).not.toHaveProperty('pricing')
    expect(provider.summary).not.toContain('pricing')
    expect(fetch).not.toHaveBeenCalled()
    const serialized = JSON.stringify(report)
    for (const secret of [
      'access-secret',
      'refresh-secret',
      'account-secret',
      'revision',
    ])
      expect(serialized).not.toContain(secret)
  })

  it('skips command helpers and reports effective source precedence', async () => {
    const value = await fixture()
    const marker = join(value.root, 'helper-marker')
    const command = [
      'node',
      '-e',
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
    ] as const
    await writeFile(
      join(value.configRoot, 'settings.json'),
      JSON.stringify({
        providers: {
          helper: {
            protocol: 'openai-compatible',
            profiles: {
              named: {
                baseUrl: 'https://helper.example/v1',
                credential: { source: 'command', command },
              },
            },
          },
        },
      }),
    )
    const report = await doctorFor(value, {
      PRAXIS_PROVIDER: 'helper',
      PRAXIS_PROVIDER_PROFILE: 'named',
      PRAXIS_MODEL: 'helper-model',
    })
    const provider = report.checks.find((check) => check.id === 'provider')
    if (!provider) throw new Error('provider check missing')
    expect(provider.status).toBe('warn')
    expect(provider.summary).toContain(
      'helper execution was intentionally skipped',
    )
    expect(provider.summary).not.toContain(marker)
    expect(JSON.stringify(report)).not.toContain(marker)
    expect(JSON.stringify(report)).not.toContain(
      '__praxis_doctor_credential_placeholder__',
    )
    expect(formatDoctorReport(report)).not.toContain(command[2])
    await expect(access(marker)).rejects.toThrow()

    const legacy = await doctorFor(value, {
      PRAXIS_PROVIDER: 'helper',
      PRAXIS_PROVIDER_PROFILE: 'named',
      PRAXIS_MODEL: 'gpt-4o-mini',
      PRAXIS_API_KEY: 'legacy-secret',
    })
    const legacyProvider = legacy.checks.find(
      (check) => check.id === 'provider',
    )
    if (!legacyProvider) throw new Error('provider check missing')
    expect(legacyProvider.summary).not.toContain('helper execution')
    expect(JSON.stringify(legacy)).not.toContain('legacy-secret')
  })

  it('reports missing, wrong-type, and forbidden credentials safely', async () => {
    const missing = await fixture()
    await writeFile(
      join(missing.configRoot, 'settings.json'),
      JSON.stringify({
        providers: {
          vendor: {
            protocol: 'openai-compatible',
            profiles: {
              named: {
                baseUrl: 'https://vendor.example/v1',
                credential: { source: 'env', name: 'MISSING_KEY' },
              },
            },
          },
        },
      }),
    )
    const missingReport = await doctorFor(missing, {
      PRAXIS_PROVIDER: 'vendor',
      PRAXIS_PROVIDER_PROFILE: 'named',
      PRAXIS_MODEL: 'gpt-4o-mini',
    })
    expect(
      missingReport.checks.find((check) => check.id === 'provider'),
    ).toMatchObject({
      status: 'fail',
      summary: expect.stringContaining('MISSING_KEY'),
    })

    const wrong = await fixture()
    await writeFile(
      join(wrong.configRoot, 'settings.json'),
      JSON.stringify({
        providers: {
          vendor: {
            protocol: 'openai-compatible',
            profiles: {
              named: {
                baseUrl: 'https://vendor.example/v1',
                credential: { source: 'vault' },
              },
            },
          },
        },
      }),
    )
    const wrongVault = new ProviderCredentialVault({
      configRoot: wrong.configRoot,
      useKeychain: false,
    })
    await wrongVault.modify(
      { providerId: 'vendor', profileId: 'named' },
      () => ({
        type: 'oauth',
        accessToken: 'access',
        refreshToken: 'refresh',
        expiresAt: Date.now() + 100000,
      }),
    )
    const wrongReport = await doctorFor(wrong, {
      PRAXIS_PROVIDER: 'vendor',
      PRAXIS_PROVIDER_PROFILE: 'named',
      PRAXIS_MODEL: 'gpt-4o-mini',
      PRAXIS_PROVIDER_CREDENTIAL_STORE: 'file',
    })
    expect(
      wrongReport.checks.find((check) => check.id === 'provider'),
    ).toMatchObject({
      status: 'fail',
      summary: expect.stringContaining('vault API key'),
    })

    const codex = await fixture()
    await writeFile(
      join(codex.configRoot, 'settings.json'),
      JSON.stringify({ experimental: { codexSubscription: true } }),
    )
    const codexReport = await doctorFor(codex, {
      PRAXIS_PROVIDER: 'openai-codex',
      PRAXIS_MODEL: 'codex-model',
      PRAXIS_API_KEY: 'secret',
    })
    expect(
      codexReport.checks.find((check) => check.id === 'provider'),
    ).toMatchObject({
      status: 'fail',
      summary: expect.stringContaining('does not accept API keys'),
    })
    expect(JSON.stringify(codexReport)).not.toContain('secret')
  })

  it('uses native resources without reading project Claude configuration', async () => {
    const value = await fixture()
    await mkdir(join(value.projectRoot, '.praxis'), { recursive: true })
    await writeFile(
      join(value.projectRoot, '.praxis', 'settings.json'),
      JSON.stringify({ permissions: { allow: ['Read'] } }),
    )
    await mkdir(join(value.projectRoot, '.claude'), { recursive: true })
    await writeFile(
      join(value.projectRoot, '.claude', 'settings.local.json'),
      '{ invalid claude settings',
    )

    const report = await runDoctor({
      dataPlane: 'native',
      version: '0.1.0',
      executablePath: value.executablePath,
      nodeExecutablePath: process.execPath,
      nodeVersion: 'v24.1.0',
      configRoot: value.configRoot,
      claudeStatePath: join(value.configRoot, 'state.json'),
      cwd: value.projectRoot,
      environment: {
        PRAXIS_PROVIDER: 'anthropic',
        PRAXIS_API_KEY: 'fixture-key',
        PRAXIS_MODEL: 'claude-sonnet-4-20250514',
      },
      detectClaudeVersion: async () => {
        throw new Error('native doctor must not inspect Claude Code')
      },
      ...deterministicDistTags(),
    })

    expect(
      report.checks.find((check) => check.id === 'settings'),
    ).toMatchObject({ status: 'pass' })
    expect(
      report.checks.find((check) => check.id === 'resources'),
    ).toMatchObject({ status: 'pass' })
    expect(
      report.checks.find((check) => check.id === 'claude-runtime'),
    ).toMatchObject({
      status: 'pass',
      summary: 'Claude Code runtime is not required in native mode',
    })
  })

  it('diagnoses unknown model pricing without weakening fail-closed policy', async () => {
    const value = await fixture()
    const report = await runDoctor({
      version: '0.1.0',
      executablePath: value.executablePath,
      nodeExecutablePath: process.execPath,
      nodeVersion: 'v24.1.0',
      configRoot: value.configRoot,
      claudeStatePath: join(value.configRoot, 'state.json'),
      cwd: value.projectRoot,
      environment: {
        PRAXIS_PROVIDER: 'anthropic',
        PRAXIS_API_KEY: 'secret-not-for-output',
        PRAXIS_MODEL: 'private-provider-model',
      },
      detectClaudeVersion: async () => '2.1.208',
      ...deterministicDistTags(),
    })
    const provider = report.checks.find(({ id }) => id === 'provider')
    expect(report.ok).toBe(true)
    expect(provider).toMatchObject({
      status: 'warn',
      details: {
        pricing: {
          model: 'private-provider-model',
          source: 'unknown',
          policy: 'fail-closed',
          budgetBehavior: 'reject-before-provider',
        },
      },
    })
    expect(JSON.stringify(report)).not.toContain('secret-not-for-output')
  })

  it('validates installation, runtime, provider, settings, plugins, and MCP', async () => {
    const value = await fixture()
    const pluginRoot = join(value.root, 'plugin')
    await mkdir(join(pluginRoot, '.claude-plugin'), { recursive: true })
    await writeFile(
      join(pluginRoot, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'fixture', version: '1.0.0' }),
    )
    await writePluginRegistry(value.configRoot, [
      {
        name: 'fixture',
        path: pluginRoot,
        source: pluginRoot,
        enabled: true,
        version: '1.0.0',
      },
    ])

    const report = await runDoctor({
      version: '0.1.0',
      executablePath: value.executablePath,
      nodeExecutablePath: process.execPath,
      nodeVersion: 'v24.1.0',
      configRoot: value.configRoot,
      claudeStatePath: join(value.configRoot, 'state.json'),
      cwd: value.projectRoot,
      environment: {
        PRAXIS_PROVIDER: 'anthropic',
        PRAXIS_API_KEY: 'secret-not-for-output',
        PRAXIS_MODEL: 'gpt-4o-mini',
        PRAXIS_MAX_OUTPUT_TOKENS: '2048',
      },
      detectClaudeVersion: async () => '2.1.208',
      ...deterministicDistTags(),
    })

    expect(report.ok).toBe(true)
    expect(report.checks).toHaveLength(12)
    expect(
      report.checks.find((check) => check.id === 'worktrees'),
    ).toMatchObject({
      status: 'pass',
      summary: 'No managed worktree records found',
    })
    expect(report.checks.every((check) => check.status !== 'fail')).toBe(true)
    const output = formatDoctorReport(report)
    expect(output).toContain('No installation or configuration issues found.')
    expect(output).not.toContain('secret-not-for-output')
    expect(output).not.toMatch(/subscription|keychain|organization/i)
  })

  it('fails the headless worktree check for corrupt bounded registry evidence', async () => {
    const value = await fixture()
    const identity = await realpath(value.projectRoot)
    const registry = join(
      value.configRoot,
      'state',
      'managed-worktrees',
      sanitizeProjectPath(identity),
    )
    await mkdir(registry, { recursive: true })
    await writeFile(
      join(registry, 'corrupt.json'),
      JSON.stringify({ version: `secret-not-for-output${'x'.repeat(512)}` }),
    )
    const report = await doctorFor(value, {
      PRAXIS_PROVIDER: 'anthropic',
      PRAXIS_API_KEY: 'fixture-key',
      PRAXIS_MODEL: 'claude-sonnet-4-20250514',
    })
    const check = report.checks.find((entry) => entry.id === 'worktrees')
    expect(report.ok).toBe(false)
    expect(check).toMatchObject({
      status: 'fail',
      details: {
        counts: { unsafe: 1 },
        truncated: false,
        entries: [expect.objectContaining({ status: 'unsafe' })],
      },
    })
    expect(formatDoctorReport(report)).toContain('[FAIL] worktrees:')
    expect(JSON.stringify(report)).not.toContain('secret-not-for-output')
    expect(formatDoctorReport(report)).not.toContain('secret-not-for-output')
  })

  it('keeps the doctor worktree details bounded and marks truncation', async () => {
    const value = await fixture()
    const identity = await realpath(value.projectRoot)
    const registry = join(
      value.configRoot,
      'state',
      'managed-worktrees',
      sanitizeProjectPath(identity),
    )
    await mkdir(registry, { recursive: true })
    await Promise.all(
      Array.from({ length: 65 }, (_, index) =>
        writeFile(
          join(registry, `${String(index).padStart(2, '0')}.json`),
          '{invalid',
        ),
      ),
    )
    const report = await doctorFor(value, {
      PRAXIS_PROVIDER: 'anthropic',
      PRAXIS_API_KEY: 'fixture-key',
      PRAXIS_MODEL: 'claude-sonnet-4-20250514',
    })
    const check = report.checks.find((entry) => entry.id === 'worktrees')
    expect(check).toMatchObject({
      status: 'fail',
      details: {
        counts: { unsafe: 64 },
        truncated: true,
        entries: expect.any(Array),
      },
    })
    expect((check?.details?.entries as unknown[]).length).toBe(64)
  })

  it.each([
    ['active', 'pass', 'active'],
    ['retained', 'warn', 'retained'],
    ['safely-releasable', 'warn', 'safelyReleasable'],
    ['released', 'pass', 'released'],
  ] as const)(
    'maps %s managed worktree evidence to a %s doctor check',
    async (lifecycle, expectedStatus, countKey) => {
      const value = await fixture()
      await initializeGitProject(value.projectRoot)
      const stateRoot = join(value.configRoot, 'state')
      const worktree = await createOwnedManagedWorktree({
        cwd: value.projectRoot,
        stateRoot,
        directoryName: `doctor-${lifecycle}`,
        ownerId: `workflow:wf_doctor-${lifecycle}:a0000000000000000`,
        label: 'Workflow',
        kind: 'workflow',
        policy: 'ephemeral',
      })
      try {
        if (lifecycle === 'retained') {
          await worktree.retain('doctor retained evidence')
        } else if (lifecycle === 'released') {
          await worktree.release()
        } else if (lifecycle === 'safely-releasable') {
          await worktree.retain('release fixture lease')
          const identity = await realpath(value.projectRoot)
          const registry = await inspectManagedWorktreeRegistry({
            stateRoot,
            repositoryRoot: identity,
            limit: 64,
          })
          const entry = registry.entries.find((item) => 'record' in item)
          if (!entry || !('record' in entry))
            throw new Error('expected managed worktree record')
          const active = { ...entry.record, state: 'active' as const }
          delete active.retentionReason
          await writeFile(entry.path, `${JSON.stringify(active)}\n`)
        }
        const report = await doctorFor(value, {
          PRAXIS_PROVIDER: 'anthropic',
          PRAXIS_API_KEY: 'fixture-key',
          PRAXIS_MODEL: 'claude-sonnet-4-20250514',
        })
        const check = report.checks.find((entry) => entry.id === 'worktrees')
        expect(check).toMatchObject({
          status: expectedStatus,
          details: { counts: { [countKey]: 1 } },
        })
      } finally {
        if (lifecycle === 'active')
          await worktree.retain('release active test lease')
      }
    },
  )

  it('aggregates independent configuration failures without exposing secrets', async () => {
    const value = await fixture()
    await writeFile(join(value.configRoot, 'settings.json'), '[]')
    await mkdir(join(value.configRoot, 'plugins'), { recursive: true })
    await writeFile(pluginRegistryPath(value.configRoot), '{invalid')
    await writeFile(
      join(value.projectRoot, '.praxis', 'mcp.json'),
      JSON.stringify({
        mcpServers: { broken: { type: 'http', url: 'file:///secret' } },
      }),
    )

    const report = await runDoctor({
      version: '0.1.0',
      executablePath: value.executablePath,
      nodeExecutablePath: process.execPath,
      nodeVersion: 'v22.0.0',
      configRoot: value.configRoot,
      claudeStatePath: join(value.configRoot, 'state.json'),
      cwd: value.projectRoot,
      environment: {
        PRAXIS_PROVIDER: 'unknown',
        PRAXIS_API_KEY: 'secret-not-for-output',
        PRAXIS_MODEL: 'gpt-4o-mini',
      },
      detectClaudeVersion: async () => '2.1.208',
      ...deterministicDistTags(),
    })

    expect(report.ok).toBe(false)
    expect(
      report.checks
        .filter((check) => check.status === 'fail')
        .map((check) => check.id),
    ).toEqual([
      'node',
      'provider',
      'settings',
      'plugins',
      'mcp',
      'resources',
      'permissions',
      'hooks',
    ])
    expect(JSON.stringify(report)).not.toContain('secret-not-for-output')
  })

  it('wires JSON output and failure exit status through the CLI', async () => {
    const value = await fixture()
    vi.stubEnv('PRAXIS_HOME', value.configRoot)
    vi.stubEnv('PRAXIS_DATA_PLANE', 'native')
    vi.stubEnv('PRAXIS_PROVIDER', 'openai')
    vi.stubEnv('PRAXIS_API_KEY', '')
    vi.stubEnv('PRAXIS_MODEL', 'fixture-model')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false })),
    )
    let stdout = ''
    let stderr = ''

    const code = await run(['doctor', '--json'], {
      stdout: (message) => {
        stdout += message.toString()
      },
      stderr: (message) => {
        stderr += message
      },
    })

    expect(code).toBe(1)
    expect(stderr).toBe('')
    const report = JSON.parse(stdout) as Record<string, unknown>
    expect(report).toMatchObject({
      type: 'doctor',
      ok: false,
      diagnostic: {
        version: expect.any(String),
        installationPath: expect.any(String),
        invokedBinary: expect.any(String),
      },
      updates: {
        channel: 'latest',
        registryStatus: 'unavailable',
        stableVersion: null,
        latestVersion: null,
      },
    })
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'worktrees',
          status: 'pass',
          details: expect.objectContaining({
            counts: {
              active: 0,
              retained: 0,
              safelyReleasable: 0,
              released: 0,
              unsafe: 0,
            },
            truncated: false,
            entries: [],
          }),
        }),
      ]),
    )
    expect(stdout).not.toContain('not checked')
  })

  it('reports the exact trusted project provider through the JSON CLI', async () => {
    const value = await fixture()
    await writeFile(
      join(value.configRoot, 'settings.json'),
      JSON.stringify({
        provider: 'fallback',
        providerProfile: 'user',
        model: 'user-model',
        providers: {
          fallback: {
            protocol: 'openai-compatible',
            profiles: {
              user: {
                baseUrl: 'https://user.example/v1',
                credential: { source: 'env', name: 'NAMED_DOCTOR_KEY' },
              },
              project: {
                baseUrl: 'https://project.example/v1',
                credential: { source: 'env', name: 'NAMED_DOCTOR_KEY' },
              },
            },
          },
        },
      }),
    )
    await writeFile(
      join(value.projectRoot, '.praxis', 'settings.json'),
      JSON.stringify({
        provider: 'fallback',
        providerProfile: 'project',
        model: 'project-model',
      }),
    )

    const environmentKeys = [
      'PRAXIS_HOME',
      'PRAXIS_DATA_PLANE',
      'PRAXIS_PROVIDER',
      'PRAXIS_PROVIDER_PROFILE',
      'PRAXIS_MODEL',
      'PRAXIS_BASE_URL',
      'PRAXIS_API_KEY',
      'PRAXIS_SIMPLE',
      'PRAXIS_PROVIDER_CREDENTIAL_STORE',
      'NAMED_DOCTOR_KEY',
    ] as const
    const previousEnvironment = new Map(
      environmentKeys.map((key) => [key, process.env[key]]),
    )
    const previousCwd = process.cwd()
    let stdout = ''
    let stderr = ''
    try {
      for (const key of environmentKeys) delete process.env[key]
      process.env.PRAXIS_HOME = value.configRoot
      process.env.PRAXIS_DATA_PLANE = 'native'
      process.env.PRAXIS_PROVIDER_CREDENTIAL_STORE = 'file'
      process.env.NAMED_DOCTOR_KEY = 'doctor-cli-secret'
      process.chdir(value.projectRoot)

      const shared = await loadNativeSharedResources({
        root: value.configRoot,
        cwd: value.projectRoot,
        environment: process.env,
        includeProjectMemory: false,
      })
      const assessment = await assessWorkspaceTrust(
        await workspaceTrustInventory({
          cwd: value.projectRoot,
          settings: shared.settings,
          mcp: shared.mcp,
        }),
        join(value.configRoot, 'state.json'),
      )
      await persistWorkspaceTrust(
        assessment,
        join(value.configRoot, 'state.json'),
      )
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({ ok: false })),
      )

      await run(['doctor', '--json'], {
        stdout: (message) => {
          stdout += message.toString()
        },
        stderr: (message) => {
          stderr += message
        },
      })
    } finally {
      process.chdir(previousCwd)
      for (const key of environmentKeys) {
        const previous = previousEnvironment.get(key)
        if (previous === undefined) delete process.env[key]
        else process.env[key] = previous
      }
    }

    expect(stderr).toBe('')
    const report = JSON.parse(stdout) as {
      checks: Array<{ id: string; details?: Record<string, unknown> }>
    }
    expect(
      report.checks.find((check) => check.id === 'provider')?.details,
    ).toMatchObject({
      provider: 'fallback',
      profile: 'project',
      model: 'project-model',
      baseUrl: 'https://project.example/v1',
    })
    expect(stdout).not.toContain('user-model')
    expect(stdout).not.toContain('doctor-cli-secret')
  })

  it('validates hook matchers, permission rules, and MCP stdio prerequisites without execution', async () => {
    const value = await fixture()
    await writeFile(
      join(value.projectRoot, '.praxis', 'settings.json'),
      JSON.stringify({
        permissions: { allow: ['Bash('] },
        hooks: {
          PreToolUse: [
            {
              matcher: '[',
              hooks: [
                { type: 'command', command: 'echo never-run', timeout: 1 },
              ],
            },
          ],
        },
      }),
    )
    await writeFile(
      join(value.projectRoot, '.praxis', 'mcp.json'),
      JSON.stringify({
        mcpServers: { broken: { command: 'praxis-command-does-not-exist' } },
      }),
    )
    const report = await runDoctor({
      version: '0.1.0',
      executablePath: value.executablePath,
      nodeExecutablePath: process.execPath,
      nodeVersion: 'v24.1.0',
      configRoot: value.configRoot,
      claudeStatePath: join(value.configRoot, 'state.json'),
      cwd: value.projectRoot,
      environment: {
        PRAXIS_PROVIDER: 'openai',
        PRAXIS_API_KEY: 'secret-not-for-output',
        PRAXIS_MODEL: 'gpt-4o-mini',
      },
      detectClaudeVersion: async () => '2.1.208',
      ...deterministicDistTags(),
    })

    expect(report.checks.find((check) => check.id === 'mcp')?.status).toBe(
      'fail',
    )
    expect(
      report.checks.find((check) => check.id === 'permissions')?.status,
    ).toBe('fail')
    expect(report.checks.find((check) => check.id === 'hooks')?.status).toBe(
      'fail',
    )
    expect(JSON.stringify(report)).not.toContain('never-run')
  })

  it('reports ignored MCP entries as non-blocking warnings', async () => {
    const value = await fixture()
    await writeFile(
      join(value.projectRoot, '.praxis', 'mcp.json'),
      JSON.stringify({ mcpServers: [] }),
    )
    const report = await runDoctor({
      version: '0.1.0',
      executablePath: value.executablePath,
      nodeExecutablePath: process.execPath,
      nodeVersion: 'v24.1.0',
      configRoot: value.configRoot,
      claudeStatePath: join(value.configRoot, 'state.json'),
      cwd: value.projectRoot,
      environment: {
        PRAXIS_PROVIDER: 'openai',
        PRAXIS_API_KEY: 'secret-not-for-output',
        PRAXIS_MODEL: 'gpt-4o-mini',
      },
      detectClaudeVersion: async () => '2.1.208',
      ...deterministicDistTags(),
    })

    expect(report.ok).toBe(true)
    expect(report.checks.find((check) => check.id === 'mcp')?.status).toBe(
      'warn',
    )
  })

  it('provides command-specific help without requiring configuration', async () => {
    let stdout = ''
    const code = await run(['doctor', '--help'], {
      stdout: (message) => {
        stdout += message.toString()
      },
      stderr: () => undefined,
    })

    expect(code).toBe(0)
    expect(stdout).toContain('Usage: praxis doctor [options]')
  })

  it('includes deterministic diagnostic and update data in every report', async () => {
    const value = await fixture()
    const report = await runDoctor({
      version: '0.1.0',
      executablePath: value.executablePath,
      nodeExecutablePath: process.execPath,
      nodeVersion: 'v24.1.0',
      configRoot: value.configRoot,
      claudeStatePath: join(value.configRoot, 'state.json'),
      cwd: value.projectRoot,
      environment: {
        PRAXIS_PROVIDER: 'openai',
        PRAXIS_API_KEY: 'secret-not-for-output',
        PRAXIS_MODEL: 'gpt-4o-mini',
      },
      detectClaudeVersion: async () => '2.1.208',
      ...deterministicDistTags(),
    })

    const { diagnostic, updates } = report
    expect(diagnostic).toMatchObject({
      installationType: 'source',
      packageManager: null,
      version: '0.1.0',
    })
    expect(diagnostic.multipleInstallations).toContain(
      diagnostic.installationPath,
    )
    expect(updates).toMatchObject({
      autoUpdates: 'Managed by source checkout',
      hasUpdatePermissions: true,
      channel: 'stable',
      stableVersion: '1.0.0',
      latestVersion: '1.1.0',
      registryStatus: 'available',
    })
    const output = formatDoctorReport(report)
    expect(output).toContain('Diagnostics')
    expect(output).toContain('Currently running: Praxis 0.1.0 (source)')
    expect(output).not.toContain('Config install method')
    expect(output).toContain('Updates')
    expect(output).toContain('Auto-updates: Managed by source checkout')
    expect(output).toContain('Update channel: stable')
    expect(output).toContain('Stable version: 1.0.0')
    expect(output).toContain('Latest version: 1.1.0')
    expect(output).not.toContain('not checked')
  })

  it('emits one complete pending progress report before resolving a single final report', async () => {
    const value = await fixture()
    let resolveTags!: (tags: { stable: string; latest: string }) => void
    let loaderCalls = 0
    let progressCalls = 0
    let progressReport: DoctorProgressReport | undefined
    let resolveProgressSeen!: () => void
    const progressSeen = new Promise<void>((resolve) => {
      resolveProgressSeen = resolve
    })
    const reportPromise = runDoctor({
      version: '0.1.0',
      executablePath: value.executablePath,
      nodeExecutablePath: process.execPath,
      nodeVersion: 'v24.1.0',
      configRoot: value.configRoot,
      claudeStatePath: join(value.configRoot, 'state.json'),
      cwd: value.projectRoot,
      environment: {
        PRAXIS_PROVIDER: 'openai',
        PRAXIS_API_KEY: 'secret-not-for-output',
        PRAXIS_MODEL: 'gpt-4o-mini',
      },
      detectClaudeVersion: async () => '2.1.208',
      autoUpdateChannel: 'stable',
      loadDistTags: () => {
        loaderCalls += 1
        return new Promise<{ stable: string; latest: string }>((resolve) => {
          resolveTags = resolve
        })
      },
      onProgress: (report) => {
        progressCalls += 1
        progressReport = report
        resolveProgressSeen()
      },
    })

    await progressSeen
    expect(progressReport).toBeDefined()
    expect(progressReport?.updates).toEqual({
      autoUpdates: 'Managed by source checkout',
      hasUpdatePermissions: true,
      channel: 'stable',
      stableVersion: null,
      latestVersion: null,
      registryStatus: 'loading',
    })
    expect(progressReport?.checks).toHaveLength(12)
    expect(progressReport?.summary).toEqual({
      passed: expect.any(Number),
      warnings: expect.any(Number),
      failed: expect.any(Number),
    })
    expect(loaderCalls).toBe(1)

    resolveTags({ stable: '1.0.0', latest: '1.1.0' })
    const report = await reportPromise
    expect(loaderCalls).toBe(1)
    expect(progressCalls).toBe(1)
    expect(report.updates).toMatchObject({
      channel: 'stable',
      registryStatus: 'available',
      stableVersion: '1.0.0',
      latestVersion: '1.1.0',
    })
    expect(report.updates.error).toBeUndefined()
    expect(JSON.stringify(report)).not.toContain('"registryStatus":"loading"')
    expect(report.checks).toHaveLength(12)
  })

  it('reports unavailable registry state without altering ok or the check summary', async () => {
    const value = await fixture()
    const secretValue = 'super-secret-api-key'
    const report = await runDoctor({
      version: '0.1.0',
      executablePath: value.executablePath,
      nodeExecutablePath: process.execPath,
      nodeVersion: 'v24.1.0',
      configRoot: value.configRoot,
      claudeStatePath: join(value.configRoot, 'state.json'),
      cwd: value.projectRoot,
      environment: {
        PRAXIS_PROVIDER: 'openai',
        PRAXIS_API_KEY: secretValue,
        PRAXIS_MODEL: 'gpt-4o-mini',
      },
      detectClaudeVersion: async () => '2.1.208',
      autoUpdateChannel: 'latest',
      loadDistTags: async () => {
        throw new Error(`registry lookup failed: ${secretValue}`)
      },
    })

    expect(report.ok).toBe(true)
    expect(report.checks).toHaveLength(12)
    expect(report.summary.failed).toBe(0)
    const updates = report.updates
    expect(updates).toMatchObject({
      channel: 'latest',
      registryStatus: 'unavailable',
      stableVersion: null,
      latestVersion: null,
    })
    expect(updates.error).toContain('registry lookup failed')
    expect(JSON.stringify(report)).not.toContain(secretValue)
    expect(formatDoctorReport(report)).toContain('└ Failed to fetch versions')
  })
})
