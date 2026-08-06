import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { run, type CliIO } from './cli.js'

const roots: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  )
})

function capture() {
  const stdout: string[] = []
  const stderr: string[] = []
  const io: CliIO = {
    stdout: (value) => stdout.push(Buffer.from(value).toString()),
    stderr: (value) => stderr.push(value),
  }
  return { io, stdout, stderr }
}

describe('CLI plugin management', () => {
  it('routes init, validate, install, list, and disable commands', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-plugin-cli-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const pluginPath = join(root, 'plugin')
    vi.stubEnv('CLAUDE_CONFIG_DIR', configRoot)
    const dependencies = {
      async createService() {
        throw new Error('service must not be created')
      },
    }

    let output = capture()
    await expect(
      run(['plugin', 'init', pluginPath, 'fixture'], output.io, dependencies),
    ).resolves.toBe(0)
    expect(JSON.parse(output.stdout[0] as string)).toMatchObject({
      type: 'plugin-initialized',
    })

    output = capture()
    await expect(
      run(
        ['--json', 'plugin', 'validate', pluginPath],
        output.io,
        dependencies,
      ),
    ).resolves.toBe(0)
    expect(JSON.parse(output.stdout[0] as string)).toMatchObject({
      type: 'plugin-valid',
      plugin: { name: 'fixture' },
    })

    output = capture()
    await expect(
      run(['--json', 'plugin', 'install', pluginPath], output.io, dependencies),
    ).resolves.toBe(0)
    expect(JSON.parse(output.stdout[0] as string)).toMatchObject({
      type: 'plugin-installed',
    })

    output = capture()
    await expect(
      run(['--json', 'plugin', 'list'], output.io, dependencies),
    ).resolves.toBe(0)
    expect(JSON.parse(output.stdout[0] as string)).toMatchObject([
      { name: 'fixture', status: 'enabled', valid: true },
    ])

    output = capture()
    await expect(
      run(['plugin', 'disable', 'fixture'], output.io, dependencies),
    ).resolves.toBe(0)
    expect(JSON.parse(output.stdout[0] as string)).toMatchObject({
      type: 'plugin-disabled',
    })
    await expect(
      readFile(join(configRoot, 'plugins', 'installed.json'), 'utf8'),
    ).resolves.toContain('fixture')
  })
})
