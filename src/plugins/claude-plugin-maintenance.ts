import { execFile } from 'node:child_process'
import { readFile, realpath, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

import {
  readClaudeInstalledPlugins,
  removeClaudeInstalledPlugin,
  type ClaudeInstalledPlugin,
  type ClaudePluginScope,
} from './claude-plugin-marketplace.js'

const execFileAsync = promisify(execFile)
const PLUGIN_MANIFEST = join('.claude-plugin', 'plugin.json')
const MARKETPLACE_MANIFEST = join('.claude-plugin', 'marketplace.json')
const SEMVER =
  /^v?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*)|(?:\d*[A-Za-z-][0-9A-Za-z-]*))(?:\.(?:(?:0|[1-9]\d*)|(?:\d*[A-Za-z-][0-9A-Za-z-]*)))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u

export const CLAUDE_PLUGIN_PRUNE_HELP = `Usage: praxis plugin prune|autoremove [options]

Remove auto-installed dependencies that are no longer needed

Options:
  --dry-run            List what would be removed without removing
  -h, --help           Display help for command
  -s, --scope <scope>  Prune at scope: user, project, or local (default: "user")
  -y, --yes            Skip the confirmation prompt (required when stdin or
                       stdout is not a TTY)
`

export const CLAUDE_PLUGIN_TAG_HELP = `Usage: praxis plugin tag [options] [path]

Create a {name}--v{version} git tag for a plugin release, validating that
plugin.json and any enclosing marketplace entry agree

Options:
  --dry-run            Print what would be tagged without creating it
  -f, --force          Skip the dirty-working-tree and tag-already-exists checks
  -h, --help           Display help for command
  -m, --message <msg>  Tag annotation message (use %s for the version)
  --push               Push the tag to --remote after creating it
  --remote <name>      Remote to push to with --push (default: "origin")
`

interface PluginManifest {
  name: string
  version: string
  dependencies: string[]
  description?: string
  author?: unknown
}

export interface ClaudePluginPrunePlan {
  scope: ClaudePluginScope
  autoCount: number
  candidates: readonly ClaudeInstalledPlugin[]
  failedPluginIds?: readonly string[]
}

export interface ClaudePluginTagOptions {
  path: string
  dryRun?: boolean
  force?: boolean
  message?: string
  push?: boolean
  remote?: string
}

export interface ClaudePluginTagResult {
  name: string
  version: string
  tag: string
  message: string
  repository: string
  manifestPath: string
  marketplaceEntry?: {
    path: string
    index: number
    version?: string
  }
  warnings: readonly string[]
  dryRun: boolean
  pushed: boolean
  remote: string
  force: boolean
}

export interface ClaudePluginMaintenanceIO {
  isTTY?: boolean
  stdout(value: string): void
  stderr(value: string): void
  readStdinLines?: () => AsyncIterable<string | Uint8Array>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  let value: unknown
  try {
    value = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`No plugin manifest found. Expected ${path}.`)
    }
    if (error instanceof SyntaxError) throw new Error(`Invalid JSON in ${path}`)
    throw error
  }
  if (!isRecord(value)) throw new Error(`JSON root must be an object: ${path}`)
  return value
}

async function readPluginManifest(root: string): Promise<PluginManifest> {
  const path = join(root, PLUGIN_MANIFEST)
  const value = await readJsonObject(path)
  if (typeof value.name !== 'string' || value.name.trim().length === 0) {
    throw new Error(`Plugin name must be a non-empty string: ${path}`)
  }
  const version = value.version
  if (typeof version !== 'string' || version.trim().length === 0) {
    throw new Error(`No version to tag. Set "version" in ${path}.`)
  }
  if (!SEMVER.test(version)) {
    throw new Error(`Version "${version}" is not valid semver.`)
  }
  const dependencies = value.dependencies
  if (
    dependencies !== undefined &&
    (!Array.isArray(dependencies) ||
      !dependencies.every(
        (dependency) => typeof dependency === 'string' && dependency.length > 0,
      ))
  ) {
    throw new Error(`Plugin dependencies must be a string array: ${path}`)
  }
  return {
    name: value.name,
    version,
    dependencies: (dependencies as string[] | undefined) ?? [],
    ...(typeof value.description === 'string'
      ? { description: value.description }
      : {}),
    ...(value.author === undefined ? {} : { author: value.author }),
  }
}

function dependencyId(
  dependency: string,
  sourceId: string,
  installedIds: ReadonlySet<string>,
): string | undefined {
  if (installedIds.has(dependency)) return dependency
  const marketplace = sourceId.includes('@')
    ? sourceId.slice(sourceId.lastIndexOf('@') + 1)
    : undefined
  if (marketplace && installedIds.has(`${dependency}@${marketplace}`)) {
    return `${dependency}@${marketplace}`
  }
  const matches = [...installedIds].filter(
    (candidate) =>
      candidate === dependency || candidate.startsWith(`${dependency}@`),
  )
  return matches.length === 1 ? matches[0] : undefined
}

export async function planClaudePluginPrune(
  configRoot: string,
  cwd: string,
  scope: ClaudePluginScope,
): Promise<ClaudePluginPrunePlan> {
  const installed = (await readClaudeInstalledPlugins(configRoot, cwd)).filter(
    (plugin) => plugin.scope === scope,
  )
  const automatic = installed.filter((plugin) => plugin.auto === true)
  if (automatic.length === 0) {
    return { scope, autoCount: 0, candidates: [] }
  }
  const manifests = new Map<string, PluginManifest>()
  const failedPluginIds: string[] = []
  const scanOrder = [
    ...installed.filter((plugin) => plugin.auto !== true),
    ...automatic,
  ]
  for (const plugin of scanOrder) {
    try {
      manifests.set(plugin.id, await readPluginManifest(plugin.installPath))
    } catch {
      failedPluginIds.push(plugin.id)
    }
  }
  if (failedPluginIds.length > 0) {
    return {
      scope,
      autoCount: automatic.length,
      candidates: [],
      failedPluginIds,
    }
  }
  const installedIds = new Set(installed.map((plugin) => plugin.id))
  const needed = new Set<string>()
  const queue = installed
    .filter((plugin) => plugin.auto !== true)
    .map((plugin) => plugin.id)
  while (queue.length > 0) {
    const sourceId = queue.shift() as string
    for (const dependency of manifests.get(sourceId)?.dependencies ?? []) {
      const id = dependencyId(dependency, sourceId, installedIds)
      if (!id || needed.has(id)) continue
      needed.add(id)
      queue.push(id)
    }
  }
  return {
    scope,
    autoCount: automatic.length,
    candidates: automatic
      .filter((plugin) => !needed.has(plugin.id))
      .sort((left, right) => left.id.localeCompare(right.id)),
  }
}

export async function executeClaudePluginPrune(
  configRoot: string,
  cwd: string,
  plan: ClaudePluginPrunePlan,
): Promise<ClaudeInstalledPlugin[]> {
  const removed: ClaudeInstalledPlugin[] = []
  for (const plugin of plan.candidates) {
    removed.push(
      await removeClaudeInstalledPlugin(configRoot, plugin.id, plan.scope, cwd),
    )
  }
  return removed
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function resolvePluginRoot(input: string): Promise<string> {
  const path = resolve(input)
  let metadata
  try {
    metadata = await stat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Path not found: ${path}`)
    }
    throw error
  }
  const root = metadata.isDirectory()
    ? path
    : path.endsWith(PLUGIN_MANIFEST)
      ? dirname(dirname(path))
      : dirname(path)
  const manifestPath = join(root, PLUGIN_MANIFEST)
  if (!(await pathExists(manifestPath))) {
    throw new Error(`No plugin manifest found. Expected ${manifestPath}.`)
  }
  return realpath(root)
}

async function git(
  repository: string,
  args: readonly string[],
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync('git', ['-C', repository, ...args], {
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
    })
  } catch (error) {
    const stderr =
      typeof error === 'object' && error !== null && 'stderr' in error
        ? String(error.stderr).trim()
        : ''
    throw new Error(stderr || `git ${args[0] ?? ''} failed`, { cause: error })
  }
}

async function repositoryRoot(pluginRoot: string): Promise<string> {
  try {
    return (
      await git(pluginRoot, ['rev-parse', '--show-toplevel'])
    ).stdout.trim()
  } catch (error) {
    throw new Error(`Not a git repository: ${pluginRoot}`, { cause: error })
  }
}

async function validateEnclosingMarketplace(
  pluginRoot: string,
  repository: string,
  manifest: PluginManifest,
): Promise<ClaudePluginTagResult['marketplaceEntry']> {
  let directory = pluginRoot
  while (
    directory === repository ||
    directory.startsWith(`${repository}${sep}`)
  ) {
    const path = join(directory, MARKETPLACE_MANIFEST)
    if (await pathExists(path)) {
      const marketplace = await readJsonObject(path)
      if (!Array.isArray(marketplace.plugins)) return
      for (const [index, value] of marketplace.plugins.entries()) {
        if (!isRecord(value) || typeof value.source !== 'string') continue
        if (resolve(directory, value.source) !== pluginRoot) continue
        if (value.name !== manifest.name) {
          throw new Error(
            `Name mismatch: plugin.json says ${JSON.stringify(manifest.name)} but ${relative(pluginRoot, path) || MARKETPLACE_MANIFEST} plugins[${index}].name says ${JSON.stringify(value.name)}.`,
          )
        }
        if (value.version !== undefined && value.version !== manifest.version) {
          throw new Error(
            `Version mismatch: plugin.json says ${JSON.stringify(manifest.version)} but ${relative(pluginRoot, path) || MARKETPLACE_MANIFEST} plugins[${index}].version says ${JSON.stringify(value.version)}. plugin.json wins at install time, so update the marketplace entry to ${JSON.stringify(manifest.version)} (or remove it) before tagging.`,
          )
        }
        return {
          path,
          index,
          ...(typeof value.version === 'string'
            ? { version: value.version }
            : {}),
        }
      }
    }
    if (directory === repository) return
    directory = dirname(directory)
  }
}

export async function tagClaudePlugin(
  options: ClaudePluginTagOptions,
): Promise<ClaudePluginTagResult> {
  const pluginRoot = await resolvePluginRoot(options.path)
  const manifestPath = join(pluginRoot, PLUGIN_MANIFEST)
  const manifest = await readPluginManifest(pluginRoot)
  const repository = await repositoryRoot(pluginRoot)
  const marketplaceEntry = await validateEnclosingMarketplace(
    pluginRoot,
    repository,
    manifest,
  )
  const tag = `${manifest.name}--v${manifest.version}`
  const force = options.force === true
  if (!force) {
    const dirty = (await git(repository, ['status', '--porcelain'])).stdout
      .trimEnd()
      .split('\n')
      .filter(Boolean)
      .map((line) => line.slice(3))
    if (dirty.length > 0) {
      throw new Error(
        `Uncommitted changes affecting this release — commit them first (or use --force):\n${dirty.map((path) => `  ${path}`).join('\n')}`,
      )
    }
    const existing = await git(repository, ['tag', '--list', tag])
    if (existing.stdout.trim() === tag) {
      throw new Error(
        `Tag "${tag}" already exists locally. Bump the version or re-run with --force.`,
      )
    }
  }
  const message = (
    options.message ?? `${manifest.name} ${manifest.version}`
  ).replaceAll('%s', manifest.version)
  const remote = options.remote ?? 'origin'
  if (!options.dryRun) {
    await git(repository, [
      'tag',
      ...(force ? ['--force'] : []),
      '-a',
      tag,
      '-m',
      message,
    ])
    if (options.push) {
      await git(repository, [
        'push',
        ...(force ? ['--force'] : []),
        remote,
        `refs/tags/${tag}`,
      ])
    }
  }
  const relativeManifest = relative(repository, manifestPath) || PLUGIN_MANIFEST
  const warnings = [
    ...(manifest.description === undefined
      ? [`${relativeManifest}: No description provided`]
      : []),
    ...(manifest.author === undefined
      ? [`${relativeManifest}: No author information provided`]
      : []),
  ]
  return {
    name: manifest.name,
    version: manifest.version,
    tag,
    message,
    repository,
    manifestPath: relativeManifest,
    ...(marketplaceEntry === undefined ? {} : { marketplaceEntry }),
    warnings,
    dryRun: options.dryRun === true,
    pushed: options.push === true && options.dryRun !== true,
    remote,
    force,
  }
}

function pluginName(id: string): string {
  return id.includes('@') ? id.slice(0, id.lastIndexOf('@')) : id
}

async function firstAnswer(
  input: AsyncIterable<string | Uint8Array> | undefined,
): Promise<string> {
  if (!input) return ''
  const next = await input[Symbol.asyncIterator]().next()
  return typeof next.value === 'string'
    ? next.value.trim().toLowerCase()
    : next.value instanceof Uint8Array
      ? Buffer.from(next.value).toString('utf8').trim().toLowerCase()
      : ''
}

function pruneSummary(plan: ClaudePluginPrunePlan): string {
  const count = plan.candidates.length
  return `${count} auto-installed plugin${count === 1 ? '' : 's'} no longer needed at ${plan.scope} scope:\n${plan.candidates.map((plugin) => `  ${plugin.id} (${plugin.version})`).join('\n')}\n`
}

function optionArgument(
  argv: readonly string[],
  index: number,
  option: string,
): { value: string; consumed: number } {
  const current = argv[index] as string
  const prefix = `${option}=`
  if (current.startsWith(prefix)) {
    const value = current.slice(prefix.length)
    if (!value) throw new Error(`${option} argument missing`)
    return { value, consumed: 0 }
  }
  const value = argv[index + 1]
  if (!value || value.startsWith('-'))
    throw new Error(`${option} argument missing`)
  return { value, consumed: 1 }
}

export async function executeClaudePluginMaintenanceCommand(
  argv: readonly string[],
  options: {
    configRoot: string
    cwd: string
    io: ClaudePluginMaintenanceIO
  },
): Promise<number | null> {
  if (argv[0] !== 'plugin') return null
  const action = argv[1]
  if (action === 'prune' || action === 'autoremove') {
    let scope: ClaudePluginScope = 'user'
    let dryRun = false
    let yes = false
    for (let index = 2; index < argv.length; index += 1) {
      const value = argv[index] as string
      if (value === '--help' || value === '-h') {
        options.io.stdout(CLAUDE_PLUGIN_PRUNE_HELP)
        return 0
      }
      if (value === '--dry-run') dryRun = true
      else if (value === '--yes' || value === '-y') yes = true
      else if (
        value === '--scope' ||
        value === '-s' ||
        value.startsWith('--scope=') ||
        value.startsWith('-s=')
      ) {
        const selected = optionArgument(
          argv,
          index,
          value === '-s' || value.startsWith('-s=') ? '-s' : '--scope',
        )
        if (!['user', 'project', 'local'].includes(selected.value)) {
          throw new Error(
            `Invalid scope: ${selected.value}. Must be one of: user, project, local.`,
          )
        }
        scope = selected.value as ClaudePluginScope
        index += selected.consumed
      } else if (value.startsWith('-'))
        throw new Error(`Unknown option: ${value}`)
    }
    const plan = await planClaudePluginPrune(
      options.configRoot,
      options.cwd,
      scope,
    )
    if (plan.failedPluginIds) {
      options.io.stdout(
        `Skipped — cannot determine orphans: ${plan.failedPluginIds.join(', ')} failed to load. Fix or uninstall, then retry.\n`,
      )
      return 0
    }
    if (plan.candidates.length === 0) {
      options.io.stdout(
        plan.autoCount === 0
          ? `Nothing to prune (no auto-installed plugins at ${scope} scope).\n`
          : `Nothing to prune (${plan.autoCount} auto-installed plugin${plan.autoCount === 1 ? '' : 's'} at ${scope} scope, all still needed).\n`,
      )
      return 0
    }
    options.io.stdout(pruneSummary(plan))
    if (dryRun) {
      options.io.stdout('(dry run — nothing removed)\n')
      return 0
    }
    if (!yes && options.io.isTTY !== true) {
      options.io.stdout('Not a TTY — run `praxis plugin prune -y` to remove.\n')
      return 0
    }
    if (!yes) {
      options.io.stdout('Remove? [y/N] ')
      const answer = await firstAnswer(options.io.readStdinLines?.())
      if (answer !== 'y' && answer !== 'yes') {
        options.io.stdout('Cancelled.\n')
        return 0
      }
    }
    const removed = await executeClaudePluginPrune(
      options.configRoot,
      options.cwd,
      plan,
    )
    options.io.stdout(
      `Removed ${removed.length} auto-installed plugin${removed.length === 1 ? '' : 's'}: ${removed.map((plugin) => pluginName(plugin.id)).join(', ')}\n`,
    )
    return 0
  }
  if (action !== 'tag') return null
  let path = options.cwd
  let dryRun = false
  let force = false
  let message: string | undefined
  let push = false
  let remote: string | undefined
  for (let index = 2; index < argv.length; index += 1) {
    const value = argv[index] as string
    if (value === '--help' || value === '-h') {
      options.io.stdout(CLAUDE_PLUGIN_TAG_HELP)
      return 0
    }
    if (value === '--dry-run') dryRun = true
    else if (value === '--force' || value === '-f') force = true
    else if (value === '--push') push = true
    else if (
      value === '--message' ||
      value === '-m' ||
      value.startsWith('--message=') ||
      value.startsWith('-m=')
    ) {
      const selected = optionArgument(
        argv,
        index,
        value === '-m' || value.startsWith('-m=') ? '-m' : '--message',
      )
      message = selected.value
      index += selected.consumed
    } else if (value === '--remote' || value.startsWith('--remote=')) {
      const selected = optionArgument(argv, index, '--remote')
      remote = selected.value
      index += selected.consumed
    } else if (value.startsWith('-'))
      throw new Error(`Unknown option: ${value}`)
    else if (path === options.cwd) path = value
  }
  try {
    const result = await tagClaudePlugin({
      path,
      ...(dryRun ? { dryRun: true } : {}),
      ...(force ? { force: true } : {}),
      ...(message === undefined ? {} : { message }),
      ...(push ? { push: true } : {}),
      ...(remote === undefined ? {} : { remote }),
    })
    for (const warning of result.warnings) options.io.stdout(`⚠ ${warning}\n`)
    options.io.stdout(
      `Plugin:  ${result.name}\nVersion: ${result.version} (from plugin.json)\n${result.marketplaceEntry === undefined ? '' : `Marketplace entry: plugins[${result.marketplaceEntry.index}] in ${result.marketplaceEntry.path}${result.marketplaceEntry.version === undefined ? '' : ` (version: ${result.marketplaceEntry.version})`}\n`}Tag:     ${result.tag}\n\n`,
    )
    const forceFlag = result.force ? ' --force' : ''
    if (result.dryRun) {
      options.io.stdout(
        `✔ Dry run — would create tag ${result.tag} at HEAD in ${result.repository}\n  git -C ${result.repository} tag${forceFlag} -a ${result.tag} -m ${JSON.stringify(result.message)}\n  git -C ${result.repository} push${forceFlag} ${result.remote} refs/tags/${result.tag}\n`,
      )
    } else {
      options.io.stdout(`✔ Created tag ${result.tag}\n`)
      options.io.stdout(
        result.pushed
          ? `✔ Pushed to ${result.remote}\n`
          : `  Push with: git -C ${result.repository} push${forceFlag} ${result.remote} refs/tags/${result.tag}\n`,
      )
    }
    return 0
  } catch (error) {
    options.io.stdout(
      `✘ ${error instanceof Error ? error.message : String(error)}\n`,
    )
    return 1
  }
}
