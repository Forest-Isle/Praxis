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

function detailsCosts(output) {
  const alwaysOn = /Always-on:\s+((?:<\s*)?\d+|~\d+)\s+tok/u.exec(output)?.[1]
  const components = Object.fromEntries(
    ['review', 'worker', 'hello'].map((name) => {
      const match = new RegExp(
        `^\\s*${name}\\s+(<\\s*20|~\\d+)\\s+(<\\s*20|~\\d+)\\s*$`,
        'mu',
      ).exec(output)
      return [name, match?.slice(1)]
    }),
  )
  return { alwaysOn, components }
}

async function run(executable, args, cwd, configRoot) {
  return execFileAsync(executable, args, {
    cwd,
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: configRoot,
      DISABLE_AUTOUPDATER: '1',
      PRAXIS_MCP_OAUTH_STORE: 'file',
    },
    maxBuffer: 4 * 1024 * 1024,
    timeout: 120_000,
  })
}

async function runFailure(executable, args, cwd, configRoot) {
  try {
    await run(executable, args, cwd, configRoot)
  } catch (error) {
    return `${error.stdout ?? ''}${error.stderr ?? ''}`
  }
  throw new Error(`${executable} ${args.join(' ')} unexpectedly succeeded`)
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
          level: {
            type: 'number',
            title: 'Level',
            description: 'Fixture level',
          },
          token: {
            type: 'string',
            title: 'Token',
            description: 'Fixture token',
            sensitive: true,
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
    write(
      join(marketplace, 'plugin', 'hooks', 'hooks.json'),
      JSON.stringify({ hooks: { SessionStart: [] } }),
    ),
    write(
      join(marketplace, 'plugin', '.mcp.json'),
      JSON.stringify({
        mcpServers: { fixtureMcp: { command: 'fixture-mcp' } },
      }),
    ),
    write(
      join(marketplace, 'plugin', '.lsp.json'),
      JSON.stringify({
        fixtureLsp: {
          command: 'fixture-lsp',
          args: ['--stdio'],
          extensionToLanguage: { '.fixture': 'fixture' },
        },
      }),
    ),
  ])
  return marketplace
}

const root = await mkdtemp(join(tmpdir(), 'praxis-plugin-compat-'))
const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))
let praxisCli = fileURLToPath(new URL('../dist/cli.js', import.meta.url))
const claudeCli = process.env.PRAXIS_CLAUDE_BINARY ?? 'claude'
try {
  const installRoot = join(root, 'packed-install')
  await mkdir(installRoot, { recursive: true })
  const packed = JSON.parse(
    (
      await execFileAsync(
        'npm',
        ['pack', '--json', '--pack-destination', root],
        {
          cwd: repositoryRoot,
          timeout: 120_000,
        },
      )
    ).stdout,
  )
  const filename = packed[0]?.filename
  assert(typeof filename === 'string', 'npm pack did not return a filename')
  await execFileAsync(
    'npm',
    [
      'install',
      '--prefix',
      installRoot,
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      join(root, filename),
    ],
    { cwd: repositoryRoot, timeout: 120_000 },
  )
  praxisCli = join(
    installRoot,
    'node_modules',
    'praxis-agent',
    'dist',
    'cli.js',
  )
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
  const [claudeStrict, praxisStrict] = await Promise.all([
    runFailure(
      claudeCli,
      ['plugin', 'validate', '--strict', marketplace],
      cwd,
      claudeConfig,
    ),
    runFailure(
      process.execPath,
      [praxisCli, 'plugin', 'validate', '--strict', marketplace],
      cwd,
      join(root, 'praxis-validation-config'),
    ),
  ])
  assert(
    claudeStrict.includes('strict treats warnings as errors') &&
      praxisStrict.includes('strict treats warnings as errors'),
    'Claude/Praxis marketplace strict validation did not fail on warnings',
  )
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
    [
      praxisCli,
      '--json',
      'plugin',
      'install',
      id,
      '--config',
      'enabled=true',
      '--config',
      'token=plugin-secret-canary',
    ],
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
        output.includes('Hooks (1)  SessionStart') &&
        output.includes('MCP servers (1)  fixtureMcp') &&
        output.includes('LSP servers (1)  fixtureLsp') &&
        output.includes('Per-component (rounded)') &&
        /review\s+< 20\s+~\d+/u.test(output) &&
        /worker\s+< 20\s+~\d+/u.test(output) &&
        /hello\s+< 20\s+~\d+/u.test(output),
      `${label} plugin details inventory/token output was incomplete: ${output}`,
    )
  }
  const claudeCosts = detailsCosts(nativeDetails.stdout)
  const praxisCosts = detailsCosts(praxisDetails.stdout)
  assert(
    JSON.stringify(praxisCosts) === JSON.stringify(claudeCosts),
    `Praxis plugin details token projection differed from Claude:\nClaude: ${nativeDetails.stdout}\nPraxis: ${praxisDetails.stdout}`,
  )
  const praxisSettings = JSON.parse(
    await readFile(join(praxisConfig, 'settings.json'), 'utf8'),
  )
  assert(
    praxisSettings.pluginConfigs?.[id]?.options?.enabled === true,
    'Praxis did not persist typed plugin userConfig options',
  )
  assert(
    !JSON.stringify(praxisSettings).includes('plugin-secret-canary'),
    'Praxis persisted sensitive plugin userConfig in shared settings',
  )
  const praxisCredentials = JSON.parse(
    await readFile(join(praxisConfig, '.credentials.json'), 'utf8'),
  )
  assert(
    praxisCredentials.pluginSecrets?.[id]?.token === 'plugin-secret-canary',
    'Praxis did not persist sensitive plugin userConfig in protected storage',
  )
  await run(
    process.execPath,
    [
      praxisCli,
      '--json',
      'plugin',
      'install',
      id,
      '--config',
      'level=2',
      '--config',
      'unknown=value',
    ],
    cwd,
    praxisConfig,
  )
  const atomicSettings = JSON.parse(
    await readFile(join(praxisConfig, 'settings.json'), 'utf8'),
  )
  assert(
    atomicSettings.pluginConfigs?.[id]?.options?.level === undefined,
    'Praxis persisted part of a mixed valid/unknown --config assignment',
  )
  await run(
    process.execPath,
    [
      praxisCli,
      '--json',
      'plugin',
      'install',
      id,
      '--scope',
      'project',
      '--config',
      'level=3',
    ],
    cwd,
    praxisConfig,
  )
  const projectSettings = JSON.parse(
    await readFile(join(cwd, '.claude', 'settings.json'), 'utf8'),
  )
  assert(
    projectSettings.pluginConfigs?.[id]?.options?.level === 3 &&
      atomicSettings.pluginConfigs?.[id]?.options?.level === undefined,
    'Praxis did not persist plugin config at the installation scope',
  )
  await run(
    process.execPath,
    [
      praxisCli,
      '--json',
      'plugin',
      'install',
      id,
      '--scope',
      'local',
      '--config',
      'level=4',
    ],
    cwd,
    praxisConfig,
  )
  const localSettings = JSON.parse(
    await readFile(join(cwd, '.claude', 'settings.local.json'), 'utf8'),
  )
  assert(
    localSettings.pluginConfigs?.[id]?.options?.level === 4,
    'Praxis did not persist local-scope plugin config',
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
