import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadClaudePlugins } from '../dist/plugins/claude-plugin-runtime.js'
import {
  detectClaudeVersion,
  execFileAsync,
  writeFixture as write,
} from './lib/claude-probe.mjs'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function run(executable, args, cwd, configRoot) {
  return execFileAsync(executable, args, {
    cwd,
    env: { ...process.env, CLAUDE_CONFIG_DIR: configRoot },
    maxBuffer: 4 * 1024 * 1024,
    timeout: 120_000,
  })
}

async function marketplaceFixture(root) {
  const marketplace = join(root, 'marketplace')
  await Promise.all([
    write(
      join(marketplace, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'praxis-fixture-marketplace',
        owner: { name: 'Praxis Fixture' },
        plugins: [
          {
            name: 'praxis-fixture-plugin',
            source: './plugin',
            version: '1.0.0',
          },
        ],
      }),
    ),
    write(
      join(marketplace, 'plugin', '.claude-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'praxis-fixture-plugin',
        version: '1.0.0',
      }),
    ),
    write(
      join(marketplace, 'plugin', 'commands', 'marker.md'),
      'PLUGIN_COMPAT_MARKER_3127',
    ),
  ])
  return marketplace
}

const root = await mkdtemp(join(tmpdir(), 'praxis-plugin-compat-'))
const praxisCli = fileURLToPath(new URL('../dist/cli.js', import.meta.url))
try {
  const version = await detectClaudeVersion('Plugin compatibility probe')
  const cwd = join(root, 'workspace')
  const marketplace = await marketplaceFixture(root)
  await mkdir(cwd, { recursive: true })
  const id = 'praxis-fixture-plugin@praxis-fixture-marketplace'

  const claudeConfig = join(root, 'claude-config')
  await run(
    'claude',
    ['plugin', 'marketplace', 'add', '--scope', 'user', marketplace],
    cwd,
    claudeConfig,
  )
  await run(
    'claude',
    ['plugin', 'install', '--scope', 'user', id],
    cwd,
    claudeConfig,
  )
  const praxisList = JSON.parse(
    (
      await run(
        process.execPath,
        [praxisCli, '--json', 'plugin', 'list'],
        cwd,
        claudeConfig,
      )
    ).stdout,
  )
  assert(
    praxisList.some((plugin) => plugin.name === id && plugin.valid),
    `Praxis did not read Claude plugin installation: ${JSON.stringify(praxisList)}`,
  )
  const loaded = await loadClaudePlugins({ configRoot: claudeConfig, cwd })
  assert(
    loaded.commands.some((command) =>
      command.content.includes('PLUGIN_COMPAT_MARKER_3127'),
    ),
    'Praxis did not load Claude-installed plugin commands',
  )

  const praxisConfig = join(root, 'praxis-config')
  await run(
    process.execPath,
    [praxisCli, '--json', 'plugin', 'marketplace', 'add', marketplace],
    cwd,
    praxisConfig,
  )
  await run(
    process.execPath,
    [praxisCli, '--json', 'plugin', 'install', id],
    cwd,
    praxisConfig,
  )
  const claudeList = JSON.parse(
    (await run('claude', ['plugin', 'list', '--json'], cwd, praxisConfig))
      .stdout,
  )
  assert(
    claudeList.some(
      (plugin) =>
        plugin.id === id &&
        plugin.enabled === true &&
        plugin.version === '1.0.0',
    ),
    `Claude did not read Praxis plugin installation: ${JSON.stringify(claudeList)}`,
  )

  console.log(
    `Claude ${version} plugin compatibility passed: native marketplace and installed registries, settings enablement, bidirectional list, and Praxis runtime loading`,
  )
} finally {
  await rm(root, { recursive: true, force: true })
}
