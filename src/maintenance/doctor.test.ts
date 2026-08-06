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
import { formatDoctorReport, runDoctor } from './doctor.js'

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
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe('Praxis doctor', () => {
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
    expect(JSON.parse(stdout)).toMatchObject({ type: 'doctor', ok: false })
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
})
