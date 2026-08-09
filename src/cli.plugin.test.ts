import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
  it('validates marketplace manifests and applies strict warning handling', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-marketplace-validate-'))
    roots.push(root)
    const marketplace = join(root, 'marketplace')
    await mkdir(join(marketplace, '.claude-plugin'), { recursive: true })
    await writeFile(
      join(marketplace, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({ name: 'fixture-marketplace', plugins: [] }),
    )
    const dependencies = {
      async createService() {
        throw new Error('service must not be created')
      },
    }

    let output = capture()
    await expect(
      run(
        ['--json', 'plugin', 'validate', marketplace],
        output.io,
        dependencies,
      ),
    ).resolves.toBe(0)
    expect(JSON.parse(output.stdout[0] as string)).toMatchObject({
      type: 'plugin-valid',
      marketplace: {
        name: 'fixture-marketplace',
        warnings: expect.arrayContaining([
          'Marketplace has no plugins defined',
        ]),
      },
    })

    output = capture()
    await expect(
      run(
        ['plugin', 'validate', '--strict', marketplace],
        output.io,
        dependencies,
      ),
    ).resolves.toBe(1)
    expect(output.stderr.join('')).toContain(
      '--strict treats warnings as errors',
    )
  })

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
      run(
        ['plugin', 'install', pluginPath, '--scope', 'project'],
        output.io,
        dependencies,
      ),
    ).resolves.toBe(1)
    expect(output.stderr.join('')).toContain(
      'only supported when installing plugin@marketplace',
    )

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

  it('manages Claude-native marketplaces and plugin installations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-plugin-marketplace-cli-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const marketplace = join(root, 'marketplace')
    const plugin = join(marketplace, 'plugin')
    await mkdir(join(marketplace, '.claude-plugin'), { recursive: true })
    await mkdir(join(plugin, '.claude-plugin'), { recursive: true })
    await mkdir(join(plugin, 'commands'), { recursive: true })
    await writeFile(
      join(marketplace, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'fixture-marketplace',
        plugins: [
          {
            name: 'fixture',
            source: './plugin',
            version: '1.0.0',
            description: 'fixture plugin',
          },
          {
            name: 'available',
            source: './available',
            version: '1.0.0',
          },
        ],
      }),
    )
    await writeFile(
      join(plugin, '.claude-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'fixture',
        version: '1.0.0',
        userConfig: {
          enabled: {
            type: 'boolean',
            title: 'Enabled',
            description: 'Enable fixture behavior',
          },
          retries: {
            type: 'number',
            min: 1,
            title: 'Retries',
            description: 'Retry count',
          },
          label: {
            type: 'string',
            title: 'Label',
            description: 'Fixture label',
          },
        },
      }),
    )
    await writeFile(join(plugin, 'commands', 'hello.md'), 'hello')
    vi.stubEnv('CLAUDE_CONFIG_DIR', configRoot)
    const dependencies = {
      async createService() {
        throw new Error('service must not be created')
      },
    }

    let output = capture()
    await expect(
      run(
        ['--json', 'plugin', 'marketplace', 'add', marketplace],
        output.io,
        dependencies,
      ),
    ).resolves.toBe(0)
    expect(JSON.parse(output.stdout[0] as string)).toMatchObject({
      type: 'plugin-marketplace-added',
      marketplace: { name: 'fixture-marketplace' },
    })

    output = capture()
    await expect(
      run(
        [
          '--json',
          'plugin',
          'install',
          'fixture@fixture-marketplace',
          '--config',
          'enabled=true',
          '--config',
          'retries=3',
          '--config',
          'label=fixture',
        ],
        output.io,
        dependencies,
      ),
    ).resolves.toBe(0)
    expect(JSON.parse(output.stdout[0] as string)).toMatchObject({
      type: 'plugin-installed',
      plugin: { id: 'fixture@fixture-marketplace', scope: 'user' },
    })
    await expect(
      readFile(join(configRoot, 'settings.json'), 'utf8').then(JSON.parse),
    ).resolves.toMatchObject({
      pluginConfigs: {
        'fixture@fixture-marketplace': {
          options: { enabled: true, retries: 3, label: 'fixture' },
        },
      },
    })

    output = capture()
    await expect(
      run(
        [
          '--json',
          'plugin',
          'i',
          'fixture@fixture-marketplace',
          '--config',
          'retries=4',
          '--config',
          'unknown=value',
        ],
        output.io,
        dependencies,
      ),
    ).resolves.toBe(0)
    expect(JSON.parse(output.stdout[0] as string)).toMatchObject({
      type: 'plugin-installed',
      warnings: [expect.stringContaining("isn't declared")],
    })
    await expect(
      readFile(join(configRoot, 'settings.json'), 'utf8').then(JSON.parse),
    ).resolves.toMatchObject({
      pluginConfigs: {
        'fixture@fixture-marketplace': {
          options: { enabled: true, retries: 3, label: 'fixture' },
        },
      },
    })

    output = capture()
    await expect(
      run(['--json', 'plugin', 'list'], output.io, dependencies),
    ).resolves.toBe(0)
    expect(JSON.parse(output.stdout[0] as string)).toMatchObject([
      { name: 'fixture@fixture-marketplace', status: 'enabled', valid: true },
    ])

    output = capture()
    await expect(
      run(['--json', 'plugin', 'list', '--available'], output.io, dependencies),
    ).resolves.toBe(0)
    expect(JSON.parse(output.stdout[0] as string)).toMatchObject({
      installed: [
        { name: 'fixture@fixture-marketplace', status: 'enabled', valid: true },
      ],
      available: [{ pluginId: 'available@fixture-marketplace' }],
    })

    output = capture()
    await expect(
      run(['plugin', 'list', '--available'], output.io, dependencies),
    ).resolves.toBe(0)
    expect(JSON.parse(output.stdout[0] as string)).toMatchObject({
      available: [{ pluginId: 'available@fixture-marketplace' }],
    })

    output = capture()
    await expect(
      run(
        ['--json', 'plugin', 'disable', 'fixture@fixture-marketplace'],
        output.io,
        dependencies,
      ),
    ).resolves.toBe(0)
    expect(JSON.parse(output.stdout[0] as string)).toMatchObject({
      type: 'plugin-disabled',
      plugin: { id: 'fixture@fixture-marketplace', enabled: false },
    })
    await expect(
      readFile(join(configRoot, 'settings.json'), 'utf8'),
    ).resolves.toContain('fixture@fixture-marketplace')
  })

  it('scaffolds and manages native skills-directory plugins', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-plugin-native-init-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    vi.stubEnv('CLAUDE_CONFIG_DIR', configRoot)
    const dependencies = {
      async createService() {
        throw new Error('service must not be created')
      },
    }

    let output = capture()
    await expect(
      run(
        [
          '--json',
          'plugin',
          'new',
          '--with',
          'skills',
          'agents',
          'fixture-skill',
        ],
        output.io,
        dependencies,
      ),
    ).resolves.toBe(0)
    expect(JSON.parse(output.stdout[0] as string)).toMatchObject({
      type: 'plugin-initialized',
      name: 'fixture-skill',
      path: join(configRoot, 'skills', 'fixture-skill'),
    })
    await expect(
      readFile(
        join(
          configRoot,
          'skills',
          'fixture-skill',
          '.claude-plugin',
          'plugin.json',
        ),
        'utf8',
      ),
    ).resolves.toContain('fixture-skill')

    output = capture()
    await expect(
      run(['plugin', 'details', 'fixture-skill'], output.io, dependencies),
    ).resolves.toBe(0)
    expect(output.stdout.join('')).toContain('Source: fixture-skill@skills-dir')

    output = capture()
    await expect(
      run(
        ['--json', 'plugin', 'disable', 'fixture-skill@skills-dir'],
        output.io,
        dependencies,
      ),
    ).resolves.toBe(0)
    expect(JSON.parse(output.stdout[0] as string)).toMatchObject({
      type: 'plugin-disabled',
      plugin: { id: 'fixture-skill@skills-dir', enabled: false },
    })

    const skillPath = join(configRoot, 'skills', 'fixture-skill', 'SKILL.md')
    await writeFile(skillPath, 'preserve this component')
    await expect(
      run(
        [
          'plugin',
          'init',
          'fixture-skill',
          '--force',
          '--description',
          'replacement manifest',
        ],
        capture().io,
        dependencies,
      ),
    ).resolves.toBe(0)
    await expect(readFile(skillPath, 'utf8')).resolves.toBe(
      'preserve this component',
    )
  })
})
