import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp } from 'node:fs/promises'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { run } from '../cli.js'
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
  await mkdir(join(projectRoot, '.claude'), { recursive: true })
  await mkdir(configRoot, { recursive: true })
  await writeFile(executablePath, '#!/bin/sh\n')
  await chmod(executablePath, 0o755)
  await writeFile(
    join(configRoot, 'settings.json'),
    JSON.stringify({ permissions: { allow: ['Read'] } }),
  )
  await writeFile(
    join(projectRoot, '.claude', 'settings.local.json'),
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
    join(projectRoot, '.mcp.json'),
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
  it('diagnoses unknown model pricing without weakening fail-closed policy', async () => {
    const value = await fixture()
    const report = await runDoctor({
      version: '0.1.0',
      executablePath: value.executablePath,
      nodeExecutablePath: process.execPath,
      nodeVersion: 'v24.1.0',
      configRoot: value.configRoot,
      claudeStatePath: join(value.configRoot, '.claude.json'),
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
      claudeStatePath: join(value.configRoot, '.claude.json'),
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
    expect(report.checks).toHaveLength(11)
    expect(report.checks.every((check) => check.status !== 'fail')).toBe(true)
    const output = formatDoctorReport(report)
    expect(output).toContain('No installation or configuration issues found.')
    expect(output).not.toContain('secret-not-for-output')
    expect(output).not.toMatch(/subscription|keychain|organization/i)
  })

  it('aggregates independent configuration failures without exposing secrets', async () => {
    const value = await fixture()
    await writeFile(join(value.configRoot, 'settings.json'), '[]')
    await mkdir(join(value.configRoot, 'plugins'), { recursive: true })
    await writeFile(pluginRegistryPath(value.configRoot), '{invalid')
    await writeFile(
      join(value.projectRoot, '.mcp.json'),
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
      claudeStatePath: join(value.configRoot, '.claude.json'),
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
    ).toEqual(['node', 'provider', 'settings', 'plugins', 'mcp'])
    expect(JSON.stringify(report)).not.toContain('secret-not-for-output')
  })

  it('wires JSON output and failure exit status through the CLI', async () => {
    const value = await fixture()
    vi.stubEnv('CLAUDE_CONFIG_DIR', value.configRoot)
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
        configInstallMethod: 'CLAUDE_CONFIG_DIR',
      },
      updates: {
        channel: 'latest',
        registryStatus: 'unavailable',
        stableVersion: null,
        latestVersion: null,
      },
    })
    expect(stdout).not.toContain('not checked')
  })

  it('validates hook matchers, permission rules, and MCP stdio prerequisites without execution', async () => {
    const value = await fixture()
    await writeFile(
      join(value.projectRoot, '.claude', 'settings.local.json'),
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
      join(value.projectRoot, '.mcp.json'),
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
      claudeStatePath: join(value.configRoot, '.claude.json'),
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
      join(value.projectRoot, '.mcp.json'),
      JSON.stringify({ mcpServers: [] }),
    )
    const report = await runDoctor({
      version: '0.1.0',
      executablePath: value.executablePath,
      nodeExecutablePath: process.execPath,
      nodeVersion: 'v24.1.0',
      configRoot: value.configRoot,
      claudeStatePath: join(value.configRoot, '.claude.json'),
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
      claudeStatePath: join(value.configRoot, '.claude.json'),
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
      configInstallMethod: 'default (~/.claude)',
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
    expect(output).toContain('Config install method: default (~/.claude)')
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
      claudeStatePath: join(value.configRoot, '.claude.json'),
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
    expect(progressReport?.checks).toHaveLength(11)
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
    expect(report.checks).toHaveLength(11)
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
      claudeStatePath: join(value.configRoot, '.claude.json'),
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
    expect(report.checks).toHaveLength(11)
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
