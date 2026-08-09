import { execFile } from 'node:child_process'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))
let praxisCli = fileURLToPath(new URL('../dist/cli.js', import.meta.url))
const root = await mkdtemp(join(tmpdir(), 'praxis-plugin-maintenance-'))
const environment = { ...process.env, DISABLE_AUTOUPDATER: '1' }

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertTagOutputOrder(output, label) {
  const positions = [
    output.indexOf('Plugin:'),
    output.indexOf('Version:'),
    output.indexOf('Marketplace entry:'),
    output.indexOf('Tag:'),
  ]
  assert(
    positions.every((position, index) =>
      index === 0 ? position >= 0 : position > positions[index - 1],
    ),
    `${label} output order: ${JSON.stringify(output)}`,
  )
}

async function run(command, args, options = {}) {
  return execFileAsync(command, args, {
    env: environment,
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
    ...options,
  })
}

async function praxis(args, cwd, configRoot) {
  return run(process.execPath, [praxisCli, ...args], {
    cwd,
    env: { ...environment, CLAUDE_CONFIG_DIR: configRoot },
  })
}

async function claude(args, cwd, configRoot) {
  return run('claude', args, {
    cwd,
    env: { ...environment, CLAUDE_CONFIG_DIR: configRoot },
  })
}

async function expectFailure(operation, marker) {
  try {
    await operation()
  } catch (error) {
    const output = `${String(error.stdout ?? '')}${String(error.stderr ?? '')}`
    assert(
      output.includes(marker),
      `Missing failure marker ${marker}: ${output}`,
    )
    return
  }
  throw new Error(`Expected failure containing ${marker}`)
}

async function write(path, value) {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, value)
}

async function pruneFixture(name) {
  const fixture = join(root, name)
  const configRoot = join(fixture, 'config')
  const cwd = join(fixture, 'work')
  const marketplace = join(fixture, 'marketplace')
  await mkdir(cwd, { recursive: true })
  const plugins = []
  for (const [plugin, dependencies] of [
    ['parent', ['dep@market']],
    ['dep', []],
    ['orphan', []],
  ]) {
    const source = join(marketplace, plugin)
    await write(
      join(source, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: plugin, version: '1.0.0', dependencies }),
    )
    plugins.push({ name: plugin, version: '1.0.0', source: `./${plugin}` })
  }
  await write(
    join(marketplace, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({ name: 'market', owner: { name: 'Fixture' }, plugins }),
  )
  await claude(
    ['plugin', 'marketplace', 'add', '--scope', 'user', marketplace],
    cwd,
    configRoot,
  )
  await claude(['plugin', 'install', 'parent@market'], cwd, configRoot)
  await claude(['plugin', 'install', 'orphan@market'], cwd, configRoot)
  const registryPath = join(configRoot, 'plugins', 'installed_plugins.json')
  const registry = JSON.parse(await readFile(registryPath, 'utf8'))
  registry.plugins['orphan@market'][0].auto = true
  await writeFile(registryPath, JSON.stringify(registry))
  return { configRoot, cwd }
}

async function invalidatePruneManifests(configRoot) {
  const registry = JSON.parse(
    await readFile(
      join(configRoot, 'plugins', 'installed_plugins.json'),
      'utf8',
    ),
  )
  for (const id of ['parent@market', 'orphan@market']) {
    const installPath = registry.plugins[id][0].installPath
    const invalidManifest = JSON.stringify({
      name: id.slice(0, id.indexOf('@')),
    })
    await Promise.all([
      writeFile(
        join(installPath, '.claude-plugin', 'plugin.json'),
        invalidManifest,
      ),
      writeFile(join(installPath, 'plugin.json'), invalidManifest),
      writeFile(
        join(
          configRoot,
          '..',
          'marketplace',
          id.slice(0, id.indexOf('@')),
          '.claude-plugin',
          'plugin.json',
        ),
        invalidManifest,
      ),
    ])
  }
}

async function git(repository, args) {
  return run('git', ['-C', repository, ...args])
}

async function tagFixture(name) {
  const repository = join(root, name)
  const plugin = join(repository, 'plugins', 'fixture')
  const marketplacePath = join(plugin, '.claude-plugin', 'marketplace.json')
  await write(
    join(plugin, '.claude-plugin', 'plugin.json'),
    JSON.stringify({
      name: 'fixture',
      version: '1.2.3',
      description: 'Fixture',
      author: { name: 'Fixture' },
    }),
  )
  await write(
    marketplacePath,
    JSON.stringify({
      name: 'market',
      owner: { name: 'Fixture' },
      plugins: [{ name: 'fixture', version: '1.2.3', source: '.' }],
    }),
  )
  await git(repository, ['init', '-q'])
  await git(repository, ['config', 'user.email', 'fixture@example.test'])
  await git(repository, ['config', 'user.name', 'Fixture'])
  await git(repository, ['add', '.'])
  await git(repository, ['commit', '-qm', 'initial'])
  return {
    repository,
    plugin,
    marketplacePath,
    configRoot: join(repository, 'config'),
  }
}

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
  const version = (await run('claude', ['--version'])).stdout.trim()
  assert(
    version.startsWith('2.1.208 '),
    `Unsupported Claude version: ${version}`,
  )

  for (const command of ['prune', 'autoremove']) {
    const help = await claude(
      ['plugin', command, '--help'],
      root,
      join(root, 'help'),
    )
    assert(
      help.stdout.includes('Remove auto-installed dependencies'),
      `${command} help`,
    )
    assert(help.stdout.includes('--dry-run'), `${command} dry-run help`)
  }
  const praxisPruneHelp = await praxis(
    ['plugin', 'prune', '--help'],
    root,
    join(root, 'praxis-help'),
  )
  assert(
    praxisPruneHelp.stdout.includes('prune|autoremove'),
    'Praxis prune alias help',
  )
  const disableHelp = await praxis(
    ['plugin', 'disable', '--help'],
    root,
    join(root, 'praxis-disable-help'),
  )
  assert(disableHelp.stdout.includes('-a, --all'), 'Praxis disable-all help')
  const sparseHelp = await praxis(
    ['plugin', 'marketplace', 'add', '--help'],
    root,
    join(root, 'praxis-sparse-help'),
  )
  assert(
    sparseHelp.stdout.includes('--sparse <paths...>'),
    'Praxis sparse marketplace help',
  )

  const sparseRepository = join(root, 'sparse-repository')
  const sparseConfig = join(root, 'sparse-config')
  await write(
    join(sparseRepository, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({
      name: 'sparse-marketplace',
      owner: { name: 'Fixture' },
      plugins: [],
    }),
  )
  await write(join(sparseRepository, 'plugins', 'included', 'keep.txt'), 'keep')
  await write(join(sparseRepository, 'excluded', 'omit.txt'), 'omit')
  await git(sparseRepository, ['init', '-q'])
  await git(sparseRepository, ['config', 'user.email', 'fixture@example.test'])
  await git(sparseRepository, ['config', 'user.name', 'Fixture'])
  await git(sparseRepository, ['add', '.'])
  await git(sparseRepository, ['commit', '-qm', 'fixture'])
  await run(
    process.execPath,
    [
      praxisCli,
      'plugin',
      'marketplace',
      'add',
      'https://example.test/sparse.git',
      '--sparse',
      '.claude-plugin',
      'plugins/included',
    ],
    {
      cwd: root,
      env: {
        ...environment,
        CLAUDE_CONFIG_DIR: sparseConfig,
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: `url.file://${sparseRepository}.insteadOf`,
        GIT_CONFIG_VALUE_0: 'https://example.test/sparse.git',
      },
    },
  )
  const sparseRegistry = JSON.parse(
    await readFile(
      join(sparseConfig, 'plugins', 'known_marketplaces.json'),
      'utf8',
    ),
  )
  const sparseRecord = sparseRegistry['sparse-marketplace']
  assert(
    JSON.stringify(sparseRecord?.source?.sparsePaths) ===
      JSON.stringify(['.claude-plugin', 'plugins/included']),
    `Praxis sparse paths: ${JSON.stringify(sparseRecord)}`,
  )
  try {
    await access(join(sparseRecord.installLocation, 'excluded', 'omit.txt'))
    throw new Error('Sparse checkout retained excluded directory')
  } catch (error) {
    assert(error.code === 'ENOENT', `Sparse checkout failure: ${String(error)}`)
  }

  const claudePrune = await pruneFixture('claude-prune')
  const claudeDryRun = await claude(
    ['plugin', 'prune', '--dry-run'],
    claudePrune.cwd,
    claudePrune.configRoot,
  )
  assert(
    claudeDryRun.stdout.includes('orphan@market (1.0.0)'),
    `Claude orphan plan: ${JSON.stringify(claudeDryRun.stdout)}`,
  )
  assert(
    !claudeDryRun.stdout.includes('dep@market (1.0.0)'),
    'Claude dependency retention',
  )

  const failedPlugins = 'parent@market, orphan@market failed to load'
  const praxisFailSafe = await pruneFixture('praxis-prune-fail-safe')
  await invalidatePruneManifests(praxisFailSafe.configRoot)
  const praxisSkipped = await praxis(
    ['plugin', 'prune', '--dry-run'],
    praxisFailSafe.cwd,
    praxisFailSafe.configRoot,
  )
  assert(praxisSkipped.stdout.includes(failedPlugins), 'Praxis prune fail-safe')

  const praxisPrune = await pruneFixture('praxis-prune')
  const dryRun = await praxis(
    ['plugin', 'autoremove', '-s=user', '--dry-run'],
    praxisPrune.cwd,
    praxisPrune.configRoot,
  )
  assert(dryRun.stdout.includes('orphan@market (1.0.0)'), 'Praxis orphan plan')
  assert(
    !dryRun.stdout.includes('dep@market (1.0.0)'),
    'Praxis dependency retention',
  )
  const nonTty = await praxis(
    ['plugin', 'prune'],
    praxisPrune.cwd,
    praxisPrune.configRoot,
  )
  assert(nonTty.stdout.includes('Not a TTY'), 'Praxis non-TTY safety')
  const structuredNonTty = await praxis(
    ['--json', 'plugin', 'prune'],
    praxisPrune.cwd,
    praxisPrune.configRoot,
  )
  const structuredValue = JSON.parse(structuredNonTty.stdout)
  assert(
    structuredValue.status === 'confirmation-required' &&
      structuredValue.candidates.length === 1,
    `Praxis structured prune confirmation: ${structuredNonTty.stdout}`,
  )
  const removed = await praxis(
    ['plugin', 'prune', '--yes'],
    praxisPrune.cwd,
    praxisPrune.configRoot,
  )
  assert(
    removed.stdout.includes('Removed 1 auto-installed plugin: orphan'),
    'Praxis prune',
  )
  const registry = JSON.parse(
    await readFile(
      join(praxisPrune.configRoot, 'plugins', 'installed_plugins.json'),
      'utf8',
    ),
  )
  assert(!registry.plugins['orphan@market'], 'Praxis registry cleanup')
  assert(
    registry.plugins['dep@market'][0].auto === true,
    'Praxis native auto field',
  )

  const uninstallPrune = await pruneFixture('praxis-uninstall-prune')
  const uninstallPruned = await praxis(
    ['--json', 'plugin', 'uninstall', 'parent@market', '--prune', '--yes'],
    uninstallPrune.cwd,
    uninstallPrune.configRoot,
  )
  const uninstallLines = uninstallPruned.stdout.trim().split('\n')
  const uninstallResult = JSON.parse(uninstallLines[0])
  assert(uninstallLines.length === 1, 'Praxis uninstall --prune mixed output')
  assert(
    uninstallResult.type === 'plugin-uninstalled-and-pruned' &&
      uninstallResult.status === 'complete' &&
      uninstallResult.removed.length === 2,
    `Praxis uninstall --prune result: ${uninstallPruned.stdout}`,
  )
  const uninstallRegistry = JSON.parse(
    await readFile(
      join(uninstallPrune.configRoot, 'plugins', 'installed_plugins.json'),
      'utf8',
    ),
  )
  assert(
    !uninstallRegistry.plugins['parent@market'] &&
      !uninstallRegistry.plugins['dep@market'] &&
      !uninstallRegistry.plugins['orphan@market'],
    'Praxis uninstall --prune left target or orphan dependencies installed',
  )

  const claudeUninstallPrune = await pruneFixture('claude-uninstall-prune')
  const claudeUninstallPruned = await claude(
    ['plugin', 'uninstall', 'parent@market', '--prune', '--yes'],
    claudeUninstallPrune.cwd,
    claudeUninstallPrune.configRoot,
  )
  assert(
    claudeUninstallPruned.stdout.includes('Removed 2 auto-installed plugins'),
    `Claude uninstall --prune result: ${claudeUninstallPruned.stdout}`,
  )

  const claudeTag = await tagFixture('claude-tag')
  const claudeTagDryRun = await claude(
    ['plugin', 'tag', '--dry-run', claudeTag.plugin],
    claudeTag.repository,
    claudeTag.configRoot,
  )
  assert(
    claudeTagDryRun.stdout.includes('fixture--v1.2.3'),
    'Claude tag contract',
  )
  assert(
    claudeTagDryRun.stdout.includes('Marketplace entry: plugins[0] in ') &&
      claudeTagDryRun.stdout.includes('(version: 1.2.3)'),
    `Claude root marketplace evidence: ${JSON.stringify(claudeTagDryRun.stdout)}`,
  )
  assertTagOutputOrder(claudeTagDryRun.stdout, 'Claude tag')

  const praxisTag = await tagFixture('praxis-tag')
  const tagHelp = await praxis(
    ['plugin', 'tag', '--help'],
    praxisTag.repository,
    praxisTag.configRoot,
  )
  assert(tagHelp.stdout.includes('--remote <name>'), 'Praxis tag remote help')
  const tagDryRun = await praxis(
    ['plugin', 'tag', '--dry-run', '-m=Release %s', praxisTag.plugin],
    praxisTag.repository,
    praxisTag.configRoot,
  )
  assert(tagDryRun.stdout.includes('fixture--v1.2.3'), 'Praxis tag dry-run')
  assert(
    tagDryRun.stdout.includes('Marketplace entry: plugins[0] in ') &&
      tagDryRun.stdout.includes('(version: 1.2.3)'),
    'Praxis root marketplace evidence',
  )
  assertTagOutputOrder(tagDryRun.stdout, 'Praxis tag')
  await writeFile(
    praxisTag.marketplacePath,
    JSON.stringify({
      name: 'market',
      owner: { name: 'Fixture' },
      plugins: [{ name: 'fixture', version: '2.0.0', source: '.' }],
    }),
  )
  await expectFailure(
    () =>
      praxis(
        ['plugin', 'tag', '--force', '--dry-run', praxisTag.plugin],
        praxisTag.repository,
        praxisTag.configRoot,
      ),
    'Version mismatch: plugin.json says "1.2.3" but .claude-plugin/marketplace.json plugins[0].version says "2.0.0"',
  )
  await writeFile(
    praxisTag.marketplacePath,
    JSON.stringify({
      name: 'market',
      owner: { name: 'Fixture' },
      plugins: [{ name: 'fixture', version: '1.2.3', source: '.' }],
    }),
  )
  assert(
    (await git(praxisTag.repository, ['tag', '--list'])).stdout === '',
    'dry-run tag',
  )
  await praxis(
    ['plugin', 'tag', '-m=Release %s', praxisTag.plugin],
    praxisTag.repository,
    praxisTag.configRoot,
  )
  assert(
    (await git(praxisTag.repository, ['cat-file', '-t', 'fixture--v1.2.3']))
      .stdout === 'tag\n',
    'annotated tag',
  )
  const annotation = await git(praxisTag.repository, [
    'for-each-ref',
    'refs/tags/fixture--v1.2.3',
    '--format=%(contents)',
  ])
  assert(annotation.stdout.startsWith('Release 1.2.3'), 'tag annotation')
  await expectFailure(
    () =>
      praxis(
        ['plugin', 'tag', praxisTag.plugin],
        praxisTag.repository,
        praxisTag.configRoot,
      ),
    'already exists locally',
  )
  await writeFile(join(praxisTag.repository, 'dirty.txt'), 'dirty')
  await expectFailure(
    () =>
      praxis(
        ['plugin', 'tag', '--dry-run', praxisTag.plugin],
        praxisTag.repository,
        praxisTag.configRoot,
      ),
    'Uncommitted changes',
  )

  const remote = join(root, 'remote.git')
  await run('git', ['init', '--bare', '-q', remote])
  await git(praxisTag.repository, ['remote', 'add', 'upstream', remote])
  await praxis(
    [
      'plugin',
      'tag',
      '--force',
      '--push',
      '--remote',
      'upstream',
      praxisTag.plugin,
    ],
    praxisTag.repository,
    praxisTag.configRoot,
  )
  assert(
    (
      await run('git', [
        '--git-dir',
        remote,
        'tag',
        '--list',
        'fixture--v1.2.3',
      ])
    ).stdout.trim() === 'fixture--v1.2.3',
    'forced remote tag push',
  )

  console.log(
    'Claude 2.1.208 plugin maintenance compatibility passed: prune/autoremove native auto registry, safety, dependency retention, tag validation, annotation, force, and push',
  )
} finally {
  await rm(root, { recursive: true, force: true })
}
