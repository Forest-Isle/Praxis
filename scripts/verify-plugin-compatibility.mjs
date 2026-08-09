import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
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
          {
            name: 'praxis-available-plugin',
            source: './available-plugin',
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
        userConfig: {
          enabled: {
            type: 'boolean',
            title: 'Enabled',
            description: 'Enable fixture behavior',
          },
        },
      }),
    ),
    write(
      join(marketplace, 'plugin', 'commands', 'marker.md'),
      'PLUGIN_COMPAT_MARKER_3127',
    ),
  ])
  return marketplace
}

async function detailsFixture(root) {
  const marketplace = join(root, 'details-marketplace')
  await Promise.all([
    write(
      join(marketplace, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'praxis-details-marketplace',
        owner: { name: 'Praxis Details Fixture' },
        plugins: [
          {
            name: 'praxis-details-plugin',
            source: './plugin',
            version: '1.0.0',
          },
        ],
      }),
    ),
    write(
      join(marketplace, 'plugin', '.claude-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'praxis-details-plugin',
        version: '1.0.0',
        description: 'Details fixture',
      }),
    ),
    write(
      join(marketplace, 'plugin', 'commands', 'hello.md'),
      `---\ndescription: hello command\n---\n${'hello '.repeat(67)}`,
    ),
    write(
      join(marketplace, 'plugin', 'skills', 'review', 'SKILL.md'),
      `---\ndescription: review skill\nwhen_to_use: review code\n---\n${'review '.repeat(134)}`,
    ),
    write(
      join(marketplace, 'plugin', 'agents', 'worker.md'),
      `---\ndescription: worker agent\n---\n${'worker '.repeat(200)}`,
    ),
  ])
  return marketplace
}

const root = await mkdtemp(join(tmpdir(), 'praxis-plugin-compat-'))
const praxisCli = fileURLToPath(new URL('../dist/cli.js', import.meta.url))
const claudeCli = process.env.PRAXIS_CLAUDE_BINARY ?? 'claude'
try {
  const version = await detectClaudeVersion(
    'Plugin compatibility probe',
    claudeCli,
  )
  const cwd = join(root, 'workspace')
  const marketplace = await marketplaceFixture(root)
  const detailsMarketplace = await detailsFixture(root)
  await mkdir(cwd, { recursive: true })
  const id = 'praxis-fixture-plugin@praxis-fixture-marketplace'
  const detailsId = 'praxis-details-plugin@praxis-details-marketplace'

  const claudeConfig = join(root, 'claude-config')
  await run(
    claudeCli,
    ['plugin', 'marketplace', 'add', '--scope', 'user', marketplace],
    cwd,
    claudeConfig,
  )
  await run(
    claudeCli,
    ['plugin', 'marketplace', 'add', '--scope', 'user', detailsMarketplace],
    cwd,
    claudeConfig,
  )
  await run(
    claudeCli,
    ['plugin', 'install', '--scope', 'user', id],
    cwd,
    claudeConfig,
  )
  await run(
    claudeCli,
    ['plugin', 'install', '--scope', 'user', detailsId],
    cwd,
    claudeConfig,
  )
  const nativeDetails = await run(
    claudeCli,
    ['plugin', 'details', detailsId],
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
    [praxisCli, '--json', 'plugin', 'marketplace', 'add', detailsMarketplace],
    cwd,
    praxisConfig,
  )
  await run(
    process.execPath,
    [praxisCli, '--json', 'plugin', 'install', id, '--config', 'enabled=true'],
    cwd,
    praxisConfig,
  )
  await run(
    process.execPath,
    [praxisCli, '--json', 'plugin', 'install', detailsId],
    cwd,
    praxisConfig,
  )
  const praxisDetails = await run(
    process.execPath,
    [praxisCli, 'plugin', 'details', detailsId],
    cwd,
    praxisConfig,
  )
  for (const [label, output] of [
    ['Claude', nativeDetails.stdout],
    ['Praxis', praxisDetails.stdout],
  ]) {
    assert(
      output.includes('Skills (2)  hello, review') &&
        output.includes('Agents (1)  worker') &&
        output.includes('Per-component (rounded)') &&
        /review\s+< 20\s+~\d+/u.test(output) &&
        /worker\s+< 20\s+~\d+/u.test(output) &&
        /hello\s+< 20\s+~\d+/u.test(output),
      `${label} plugin details inventory/token output was incomplete: ${output}`,
    )
  }
  const praxisSettings = JSON.parse(
    await readFile(join(praxisConfig, 'settings.json'), 'utf8'),
  )
  assert(
    praxisSettings.pluginConfigs?.[id]?.options?.enabled === true,
    'Praxis did not persist typed plugin userConfig options',
  )
  const praxisAvailable = JSON.parse(
    (
      await run(
        process.execPath,
        [praxisCli, '--json', 'plugin', 'list', '--available'],
        cwd,
        praxisConfig,
      )
    ).stdout,
  )
  assert(
    praxisAvailable.installed?.some((plugin) => plugin.name === id) &&
      praxisAvailable.available?.some(
        (plugin) =>
          plugin.pluginId ===
          'praxis-available-plugin@praxis-fixture-marketplace',
      ),
    `Praxis --available output was incomplete: ${JSON.stringify(praxisAvailable)}`,
  )
  const claudeList = JSON.parse(
    (await run(claudeCli, ['plugin', 'list', '--json'], cwd, praxisConfig))
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

  const skillsPlugin = 'praxis-native-skill'
  const skillsPluginId = `${skillsPlugin}@skills-dir`
  await run(
    process.execPath,
    [praxisCli, '--json', 'plugin', 'init', skillsPlugin, '--with', 'agents'],
    cwd,
    praxisConfig,
  )
  const claudeSkillsList = JSON.parse(
    (await run(claudeCli, ['plugin', 'list', '--json'], cwd, praxisConfig))
      .stdout,
  )
  assert(
    claudeSkillsList.some(
      (plugin) => plugin.id === skillsPluginId && plugin.enabled === true,
    ),
    `Claude did not read Praxis skills-directory plugin: ${JSON.stringify(claudeSkillsList)}`,
  )
  const skillsRuntime = await loadClaudePlugins({
    configRoot: praxisConfig,
    cwd,
  })
  assert(
    skillsRuntime.plugins.some((plugin) => plugin.source === skillsPluginId) &&
      skillsRuntime.agents.some((agent) => agent.path.includes(skillsPlugin)),
    'Praxis did not load its skills-directory plugin resources',
  )

  console.log(
    `Claude ${version} plugin compatibility passed: native marketplace and skills-directory registries, typed userConfig, available discovery, bidirectional list, details inventory/token costs, and Praxis runtime loading`,
  )
} finally {
  await rm(root, { recursive: true, force: true })
}
