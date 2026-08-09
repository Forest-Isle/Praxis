import {
  cp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

import { parse as parseYaml } from 'yaml'

import type {
  ClaudeJsonResource,
  ClaudeResourceScope,
  ClaudeTextResource,
} from '../compatibility/claude/shared-resources.js'
import {
  claudePluginDataPath,
  materializeClaudePluginSource,
  readClaudeSkillsDirectoryPlugins,
  replaceClaudePluginDirectory,
  readClaudeInstalledPlugins,
} from './claude-plugin-marketplace.js'

const execFileAsync = promisify(execFile)

interface ClaudePluginCommandDefinition {
  source?: string
  content?: string
  description?: string
}

export interface ClaudePluginManifest {
  name: string
  version?: string
  description?: string
  author?: string | { name?: string; email?: string }
  commands?:
    string | readonly string[] | Record<string, ClaudePluginCommandDefinition>
  skills?: string | readonly string[]
  agents?: string | readonly string[]
  hooks?:
    | string
    | Record<string, unknown>
    | readonly (string | Record<string, unknown>)[]
  mcpServers?:
    | string
    | Record<string, unknown>
    | readonly (string | Record<string, unknown>)[]
  lspServers?: string | Record<string, unknown>
  userConfig?: Record<string, unknown>
  channels?: readonly Record<string, unknown>[]
}

export interface ClaudePluginRecord {
  name: string
  path: string
  source: string
  enabled: boolean
  version?: string
  description?: string
  errors: readonly string[]
  warnings?: readonly string[]
}

export interface ClaudePluginResources {
  plugins: readonly ClaudePluginRecord[]
  commands: ClaudeTextResource[]
  skills: ClaudeTextResource[]
  agents: ClaudeTextResource[]
  settings: ClaudeJsonResource[]
  mcp: ClaudeJsonResource[]
}

export interface ClaudePluginRegistryEntry {
  name: string
  path: string
  source: string
  enabled: boolean
  version?: string
}

const PLUGIN_MANIFEST = join('.claude-plugin', 'plugin.json')
const LEGACY_MANIFEST = 'plugin.json'
const MAX_PLUGIN_FILES = 2_000
const PLUGIN_NAME = /^[a-z0-9][a-z0-9._-]*$/
const INIT_COMPONENTS = [
  'skills',
  'agents',
  'hooks',
  'mcp',
  'lsp',
  'output-style',
  'channel',
] as const

export type ClaudePluginInitComponent = (typeof INIT_COMPONENTS)[number]

export interface ClaudePluginInitOptions {
  author?: string
  authorEmail?: string
  description?: string
  force?: boolean
  with?: readonly ClaudePluginInitComponent[]
  nativeLayout?: boolean
}

export interface ClaudePluginDetails {
  plugin: ClaudePluginRecord
  components: {
    commands: readonly string[]
    skills: readonly string[]
    agents: readonly string[]
    hooks: readonly string[]
    mcpServers: readonly string[]
    lspServers: readonly string[]
  }
  componentCosts: readonly ClaudePluginComponentCost[]
  tokenEstimate: {
    alwaysOn: number
    onInvoke: number
  }
}

export type ClaudePluginComponentKind = 'command' | 'skill' | 'agent'

export interface ClaudePluginComponentCost {
  kind: ClaudePluginComponentKind
  name: string
  alwaysOn: number
  onInvoke: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`)
  }
  return value
}

function scopeForPath(path: string, cwd: string): ClaudeResourceScope {
  return path === cwd || path.startsWith(`${cwd}/`) ? 'project' : 'user'
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function readManifest(
  pluginPath: string,
  required: boolean,
): Promise<ClaudePluginManifest> {
  let manifestPath = join(pluginPath, PLUGIN_MANIFEST)
  try {
    await stat(manifestPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    manifestPath = join(pluginPath, LEGACY_MANIFEST)
  }
  let value: unknown
  try {
    value = JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch (error) {
    if (!required && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { name: basename(pluginPath) }
    }
    throw new Error(`Invalid plugin manifest: ${manifestPath}`, {
      cause: error,
    })
  }
  if (!isRecord(value))
    throw new Error(`Plugin manifest must be an object: ${manifestPath}`)
  const name = nonEmptyString(value.name, `Plugin name in ${manifestPath}`)
  if (!PLUGIN_NAME.test(name)) {
    throw new Error(`Plugin name must match ${PLUGIN_NAME}: ${manifestPath}`)
  }
  if (value.version !== undefined)
    nonEmptyString(value.version, 'Plugin version')
  if (
    value.description !== undefined &&
    typeof value.description !== 'string'
  ) {
    throw new Error(`Plugin description must be a string: ${manifestPath}`)
  }
  const pathFields = ['commands', 'skills', 'agents'] as const
  for (const field of pathFields) {
    const paths = value[field]
    if (
      paths !== undefined &&
      !(
        typeof paths === 'string' ||
        (Array.isArray(paths) &&
          paths.every((item) => typeof item === 'string')) ||
        (field === 'commands' &&
          isRecord(paths) &&
          Object.entries(paths).every(([name, definition]) => {
            if (!PLUGIN_NAME.test(name) || !isRecord(definition)) return false
            const source = definition.source
            const content = definition.content
            return (
              (typeof source === 'string') !== (typeof content === 'string') &&
              (source === undefined ||
                (typeof source === 'string' && source.length > 0)) &&
              (content === undefined ||
                (typeof content === 'string' && content.length > 0))
            )
          }))
      )
    ) {
      throw new Error(
        `Plugin ${field} must be a path or path array: ${manifestPath}`,
      )
    }
  }
  if (
    value.hooks !== undefined &&
    !(
      typeof value.hooks === 'string' ||
      isRecord(value.hooks) ||
      (Array.isArray(value.hooks) &&
        value.hooks.every((item) => typeof item === 'string' || isRecord(item)))
    )
  ) {
    throw new Error(
      `Plugin hooks must be a path, object, or array: ${manifestPath}`,
    )
  }
  if (
    value.mcpServers !== undefined &&
    !(
      typeof value.mcpServers === 'string' ||
      isRecord(value.mcpServers) ||
      (Array.isArray(value.mcpServers) &&
        value.mcpServers.every(
          (item) => typeof item === 'string' || isRecord(item),
        ))
    )
  ) {
    throw new Error(
      `Plugin mcpServers must be a path, object, or array: ${manifestPath}`,
    )
  }
  if (value.userConfig !== undefined) {
    if (!isRecord(value.userConfig)) {
      throw new Error(`Plugin userConfig must be an object: ${manifestPath}`)
    }
    for (const [key, definition] of Object.entries(value.userConfig)) {
      if (!isRecord(definition)) {
        throw new Error(
          `Plugin userConfig ${key} must be an object: ${manifestPath}`,
        )
      }
      nonEmptyString(definition.type, `Plugin userConfig ${key} type`)
      nonEmptyString(definition.title, `Plugin userConfig ${key} title`)
      nonEmptyString(
        definition.description,
        `Plugin userConfig ${key} description`,
      )
    }
  }
  return value as unknown as ClaudePluginManifest
}

function pathList(
  value: string | readonly string[] | undefined,
  fallback: string,
): string[] {
  if (value === undefined) return [fallback]
  return typeof value === 'string' ? [value] : [...value]
}

function safePluginPath(pluginPath: string, candidate: string): string {
  if (candidate.startsWith('/') || candidate.startsWith('\\')) {
    throw new Error(`Plugin path must be relative: ${candidate}`)
  }
  const resolved = resolve(pluginPath, candidate)
  const root = resolve(pluginPath)
  if (resolved !== root && !resolved.startsWith(`${root}/`)) {
    throw new Error(`Plugin path escapes plugin root: ${candidate}`)
  }
  return resolved
}

async function assertPluginPath(
  pluginPath: string,
  candidate: string,
): Promise<void> {
  let resolved: string
  try {
    resolved = await realpath(candidate)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  const root = await realpath(pluginPath)
  if (resolved !== root && !resolved.startsWith(`${root}/`)) {
    throw new Error(`Plugin path escapes plugin root: ${candidate}`)
  }
}

async function markdownFiles(path: string): Promise<string[]> {
  if (!(await isDirectory(path))) return []
  const entries = await readdir(path, { withFileTypes: true })
  const files = await Promise.all(
    entries
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(async (entry) => {
        const child = join(path, entry.name)
        if (entry.isDirectory()) return markdownFiles(child)
        return entry.isFile() && extname(entry.name) === '.md' ? [child] : []
      }),
  )
  return files.flat()
}

async function componentFiles(
  pluginPath: string,
  values: string | readonly string[] | undefined,
  fallback: string,
  kind: 'commands' | 'skills' | 'agents',
): Promise<string[]> {
  const roots = pathList(values, fallback).map((path) =>
    safePluginPath(pluginPath, path),
  )
  const files = (
    await Promise.all(
      roots.map(async (root) => {
        await assertPluginPath(pluginPath, root)
        try {
          const info = await stat(root)
          if (info.isFile()) {
            if (extname(root) !== '.md')
              throw new Error(`Plugin ${kind} file must be Markdown: ${root}`)
            return [root]
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          if (values !== undefined) {
            throw new Error(`Plugin ${kind} path not found: ${root}`)
          }
        }
        return markdownFiles(root)
      }),
    )
  ).flat()
  if (files.length > MAX_PLUGIN_FILES) {
    throw new Error(
      `Plugin ${kind} exceeds ${MAX_PLUGIN_FILES} files: ${pluginPath}`,
    )
  }
  return files
}

async function skillsDirectoryFiles(pluginPath: string): Promise<string[]> {
  const rootSkill = join(pluginPath, 'SKILL.md')
  const files: string[] = []
  try {
    if ((await stat(rootSkill)).isFile()) files.push(rootSkill)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const nestedSkills = join(pluginPath, 'skills')
  await assertPluginPath(pluginPath, nestedSkills)
  return [...files, ...(await markdownFiles(nestedSkills))]
}

function namespacedPath(
  pluginPath: string,
  roots: readonly string[],
  file: string,
  name: string,
  kind: 'commands' | 'skills' | 'agents',
): string {
  const root =
    roots.find(
      (candidate) => file === candidate || file.startsWith(`${candidate}/`),
    ) ?? pluginPath
  const rel = relative(root, file).replaceAll('\\', '/')
  const base = rel.replace(/\.md$/u, '')
  if (kind === 'skills') {
    const skillName =
      root === pluginPath && basename(file) === 'SKILL.md'
        ? name
        : base.split('/')[0] || basename(root)
    return join(pluginPath, 'skills', `${name}:${skillName}`, 'SKILL.md')
  }
  return join(pluginPath, kind, `${name}:${base}.md`)
}

async function loadTextResources(
  files: readonly string[],
  pluginPath: string,
  roots: readonly string[],
  name: string,
  scope: ClaudeResourceScope,
  kind: 'commands' | 'skills' | 'agents',
): Promise<ClaudeTextResource[]> {
  return Promise.all(
    files.map(async (file) => ({
      path: namespacedPath(pluginPath, roots, file, name, kind),
      scope,
      content: await readFile(file, 'utf8'),
    })),
  )
}

function expandPluginRoot(value: unknown, pluginPath: string): unknown {
  if (typeof value === 'string')
    return value.replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginPath)
  if (Array.isArray(value))
    return value.map((item) => expandPluginRoot(item, pluginPath))
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        expandPluginRoot(item, pluginPath),
      ]),
    )
  }
  return value
}

async function loadPlugin(
  pluginPath: string,
  source: string,
  enabled: boolean,
  cwd: string,
  requireManifest = false,
  resourceScope?: ClaudeResourceScope,
): Promise<{
  record: ClaudePluginRecord
  resources: Omit<ClaudePluginResources, 'plugins'>
}> {
  const canonical = await realpath(pluginPath)
  if (!(await isDirectory(canonical)))
    throw new Error(`Plugin path is not a directory: ${pluginPath}`)
  const manifest = await readManifest(canonical, requireManifest)
  const scope = resourceScope ?? scopeForPath(canonical, cwd)
  const commandDefinitions = isRecord(manifest.commands)
    ? (manifest.commands as Record<string, ClaudePluginCommandDefinition>)
    : undefined
  const commandPaths: string | readonly string[] | undefined =
    commandDefinitions
      ? undefined
      : (manifest.commands as string | readonly string[] | undefined)
  const commandsRoots = pathList(commandPaths, 'commands').map((path) =>
    safePluginPath(canonical, path),
  )
  const isSkillsDirectoryPlugin = source.endsWith('@skills-dir')
  const skillsDirectoryLayout =
    isSkillsDirectoryPlugin &&
    pathList(manifest.skills, 'skills').some((path) => path === './')
  const skillsRoots = skillsDirectoryLayout
    ? [join(canonical, 'skills'), canonical]
    : pathList(manifest.skills, 'skills').map((path) =>
        safePluginPath(canonical, path),
      )
  const agentsRoots = pathList(manifest.agents, 'agents').map((path) =>
    safePluginPath(canonical, path),
  )
  const [commandFiles, skillFiles, agentFiles] = await Promise.all([
    componentFiles(canonical, commandPaths, 'commands', 'commands'),
    skillsDirectoryLayout
      ? skillsDirectoryFiles(canonical)
      : componentFiles(canonical, manifest.skills, 'skills', 'skills'),
    componentFiles(canonical, manifest.agents, 'agents', 'agents'),
  ])
  const [commands, skills, agents] = await Promise.all([
    loadTextResources(
      commandFiles,
      canonical,
      commandsRoots,
      manifest.name,
      scope,
      'commands',
    ),
    loadTextResources(
      skillFiles,
      canonical,
      skillsRoots,
      manifest.name,
      scope,
      'skills',
    ),
    loadTextResources(
      agentFiles,
      canonical,
      agentsRoots,
      manifest.name,
      scope,
      'agents',
    ),
  ])
  if (commandDefinitions) {
    for (const [commandName, definition] of Object.entries(
      commandDefinitions,
    )) {
      if (definition.content !== undefined) {
        commands.push({
          path: join(
            canonical,
            'commands',
            `${manifest.name}:${commandName}.md`,
          ),
          scope,
          content: definition.content,
        })
        continue
      }
      const source = definition.source
      if (source === undefined) continue
      const sourcePath = safePluginPath(canonical, source)
      await assertPluginPath(canonical, sourcePath)
      const info = await stat(sourcePath)
      if (!info.isFile() || extname(sourcePath) !== '.md') {
        throw new Error(`Plugin command source must be Markdown: ${sourcePath}`)
      }
      commands.push({
        path: join(canonical, 'commands', `${manifest.name}:${commandName}.md`),
        scope,
        content: await readFile(sourcePath, 'utf8'),
      })
    }
  }
  const settings: ClaudeJsonResource[] = []
  const normalizeHooks = (value: unknown): unknown =>
    isRecord(value) && 'hooks' in value ? value : { hooks: value }
  const addHooksFile = async (
    hooksPath: string,
    required = false,
  ): Promise<void> => {
    try {
      settings.push({
        path: hooksPath,
        scope,
        value: expandPluginRoot(
          normalizeHooks(JSON.parse(await readFile(hooksPath, 'utf8'))),
          canonical,
        ),
      })
    } catch (error) {
      if (required || (error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error(`Invalid plugin hooks: ${hooksPath}`, { cause: error })
    }
  }
  await addHooksFile(join(canonical, 'hooks', 'hooks.json'))
  if (typeof manifest.hooks === 'string') {
    await addHooksFile(safePluginPath(canonical, manifest.hooks), true)
  } else if (isRecord(manifest.hooks)) {
    settings.push({
      path: join(canonical, '.claude-plugin', 'plugin.json'),
      scope,
      value: expandPluginRoot(normalizeHooks(manifest.hooks), canonical),
    })
  } else if (Array.isArray(manifest.hooks)) {
    for (const [index, hook] of manifest.hooks.entries()) {
      if (typeof hook === 'string') {
        await addHooksFile(safePluginPath(canonical, hook), true)
      } else {
        settings.push({
          path: join(canonical, '.claude-plugin', `plugin-hooks-${index}.json`),
          scope,
          value: expandPluginRoot(normalizeHooks(hook), canonical),
        })
      }
    }
  }
  const mcpPath = join(canonical, '.mcp.json')
  let mcpValue: unknown
  try {
    mcpValue = JSON.parse(await readFile(mcpPath, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new Error(`Invalid plugin MCP config: ${mcpPath}`, { cause: error })
  }
  const mcp: ClaudeJsonResource[] =
    mcpValue === undefined
      ? []
      : [{ path: mcpPath, scope, value: expandPluginRoot(mcpValue, canonical) }]
  if (manifest.mcpServers !== undefined) {
    const specs = Array.isArray(manifest.mcpServers)
      ? manifest.mcpServers
      : [manifest.mcpServers]
    for (const [index, spec] of specs.entries()) {
      if (typeof spec === 'string') {
        const specPath = safePluginPath(canonical, spec)
        let value: unknown
        try {
          value = JSON.parse(await readFile(specPath, 'utf8'))
        } catch (error) {
          throw new Error(`Invalid plugin MCP config: ${specPath}`, {
            cause: error,
          })
        }
        mcp.push({
          path: specPath,
          scope,
          value: expandPluginRoot(value, canonical),
        })
      } else if (isRecord(spec)) {
        mcp.push({
          path: join(canonical, '.claude-plugin', `plugin-mcp-${index}.json`),
          scope,
          value: expandPluginRoot({ mcpServers: spec }, canonical),
        })
      } else {
        throw new Error(`Invalid plugin MCP config in ${canonical}`)
      }
    }
  }
  return {
    record: {
      name: manifest.name,
      path: canonical,
      source,
      enabled,
      ...(manifest.version === undefined ? {} : { version: manifest.version }),
      ...(manifest.description === undefined
        ? {}
        : { description: manifest.description }),
      errors: [],
    },
    resources: { commands, skills, agents, settings, mcp },
  }
}

export function pluginRegistryPath(configRoot: string): string {
  return join(configRoot, 'plugins', 'installed.json')
}

export async function readPluginRegistry(
  configRoot: string,
): Promise<ClaudePluginRegistryEntry[]> {
  try {
    const value = JSON.parse(
      await readFile(pluginRegistryPath(configRoot), 'utf8'),
    )
    if (
      !isRecord(value) ||
      value.version !== 1 ||
      !Array.isArray(value.plugins)
    )
      throw new Error('invalid registry')
    return value.plugins.map((entry) => {
      if (!isRecord(entry)) throw new Error('invalid plugin registry entry')
      if (typeof entry.enabled !== 'boolean') {
        throw new Error('Plugin registry enabled must be a boolean')
      }
      return {
        name: nonEmptyString(entry.name, 'Plugin registry name'),
        path: nonEmptyString(entry.path, 'Plugin registry path'),
        source: nonEmptyString(entry.source, 'Plugin registry source'),
        enabled: entry.enabled,
        ...(entry.version === undefined
          ? {}
          : {
              version: nonEmptyString(entry.version, 'Plugin registry version'),
            }),
      }
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new Error(
      `Invalid plugin registry: ${pluginRegistryPath(configRoot)}`,
      { cause: error },
    )
  }
}

export async function writePluginRegistry(
  configRoot: string,
  plugins: readonly ClaudePluginRegistryEntry[],
): Promise<void> {
  const path = pluginRegistryPath(configRoot)
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(
    temp,
    `${JSON.stringify({ version: 1, plugins }, null, 2)}\n`,
    { flag: 'wx' },
  )
  await rename(temp, path)
}

export async function loadClaudePlugins(options: {
  configRoot: string
  cwd: string
  pluginDirectories?: readonly string[]
  strictPluginDirectories?: boolean
  pluginUrls?: readonly string[]
  loadInstalled?: boolean
}): Promise<ClaudePluginResources> {
  const registry =
    options.loadInstalled === false
      ? []
      : await readPluginRegistry(options.configRoot)
  const nativeRegistry =
    options.loadInstalled === false
      ? []
      : await readClaudeInstalledPlugins(options.configRoot, options.cwd)
  const skillsDirectoryRegistry =
    options.loadInstalled === false
      ? []
      : await readClaudeSkillsDirectoryPlugins(options.configRoot, options.cwd)
  const temporarySources: Array<() => Promise<void>> = []
  const inlineSources = [
    ...(options.pluginDirectories ?? []),
    ...(options.pluginUrls ?? []),
  ]
  const inlineCandidates: Array<{
    path: string
    source: string
    enabled: boolean
    resourceScope?: ClaudeResourceScope
  }> = []
  for (const source of inlineSources) {
    let materialized
    try {
      materialized = await materializeClaudePluginSource(source)
    } catch (error) {
      throw new Error(`Failed to load plugin ${source}`, { cause: error })
    }
    temporarySources.push(materialized.cleanup)
    inlineCandidates.push({
      path: materialized.path,
      source: 'inline',
      enabled: true,
    })
  }
  const candidates: Array<{
    path: string
    source: string
    enabled: boolean
    resourceScope?: ClaudeResourceScope
  }> = [
    ...nativeRegistry
      .filter((entry) => entry.enabled)
      .map((entry) => ({
        path: entry.installPath,
        source: entry.id,
        enabled: entry.enabled,
        resourceScope: entry.scope as ClaudeResourceScope,
      })),
    ...skillsDirectoryRegistry
      .filter((entry) => entry.enabled)
      .map((entry) => ({
        path: entry.installPath,
        source: entry.id,
        enabled: entry.enabled,
        resourceScope: 'user' as ClaudeResourceScope,
      })),
    ...registry
      .filter((entry) => entry.enabled)
      .map((entry) => ({
        path: entry.path,
        source: entry.source,
        enabled: true,
      })),
    ...inlineCandidates,
  ]
  const seen = new Set<string>()
  try {
    const loaded = await Promise.all(
      candidates.map(async (candidate) => {
        try {
          const canonical = await realpath(candidate.path)
          if (seen.has(canonical)) return null
          seen.add(canonical)
          return await loadPlugin(
            canonical,
            candidate.source,
            candidate.enabled,
            options.cwd,
            false,
            candidate.resourceScope,
          )
        } catch (error) {
          if (
            options.strictPluginDirectories &&
            candidate.source === 'inline'
          ) {
            throw new Error(`Failed to load plugin ${candidate.path}`, {
              cause: error,
            })
          }
          const path = resolve(candidate.path)
          return {
            record: {
              name: basename(path),
              path,
              source: candidate.source,
              enabled: candidate.enabled,
              errors: [error instanceof Error ? error.message : String(error)],
            },
            resources: {
              commands: [],
              skills: [],
              agents: [],
              settings: [],
              mcp: [],
            },
          }
        }
      }),
    )
    return loaded
      .filter((value): value is NonNullable<typeof value> => value !== null)
      .reduce<ClaudePluginResources>(
        (result, current) => ({
          plugins: [...result.plugins, current.record],
          commands: [...result.commands, ...current.resources.commands],
          skills: [...result.skills, ...current.resources.skills],
          agents: [...result.agents, ...current.resources.agents],
          settings: [...result.settings, ...current.resources.settings],
          mcp: [...result.mcp, ...current.resources.mcp],
        }),
        {
          plugins: [],
          commands: [],
          skills: [],
          agents: [],
          settings: [],
          mcp: [],
        },
      )
  } finally {
    await Promise.all(temporarySources.map((cleanup) => cleanup()))
  }
}

const KNOWN_MANIFEST_FIELDS = new Set([
  '$schema',
  'name',
  'version',
  'description',
  'author',
  'commands',
  'skills',
  'agents',
  'hooks',
  'mcpServers',
  'lspServers',
  'userConfig',
  'channels',
  'dependencies',
  'outputStyles',
  'keywords',
  'license',
  'homepage',
  'repository',
])

function pluginValidationWarnings(manifest: ClaudePluginManifest): string[] {
  const raw = manifest as unknown as Record<string, unknown>
  const warnings: string[] = []
  for (const key of Object.keys(raw)) {
    if (!KNOWN_MANIFEST_FIELDS.has(key)) warnings.push(`Unknown field '${key}'`)
  }
  if (manifest.version === undefined) warnings.push('No version specified')
  if (
    manifest.description === undefined ||
    manifest.description.trim() === ''
  ) {
    warnings.push('No description provided')
  }
  const author = manifest.author
  const hasAuthor =
    (typeof author === 'string' && author.trim().length > 0) ||
    (isRecord(author) &&
      typeof author.name === 'string' &&
      author.name.trim().length > 0)
  if (!hasAuthor) warnings.push('No author information provided')
  return warnings
}

export async function validateClaudePlugin(
  path: string,
  options: { strict?: boolean } = {},
): Promise<ClaudePluginRecord> {
  const root = resolve(path)
  const [loaded, manifest] = await Promise.all([
    loadPlugin(root, 'validate', true, root, true),
    readManifest(root, true),
  ])
  const warnings = pluginValidationWarnings(manifest)
  if (options.strict && warnings.length > 0) {
    throw new Error(
      `Plugin validation failed (--strict treats warnings as errors): ${warnings.join('; ')}`,
    )
  }
  return {
    ...loaded.record,
    ...(warnings.length === 0 ? {} : { warnings }),
  }
}

async function gitConfig(key: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['config', '--get', key])
    const value = String(stdout).trim()
    return value.length > 0 ? value : undefined
  } catch {
    return undefined
  }
}

async function writeScaffoldFile(
  path: string,
  content: string,
  force: boolean,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, { flag: force ? 'w' : 'wx' })
}

async function writeScaffoldComponent(
  path: string,
  content: string,
  preserveExisting: boolean,
): Promise<void> {
  try {
    await writeScaffoldFile(path, content, false)
  } catch (error) {
    if (
      preserveExisting &&
      (error as NodeJS.ErrnoException).code === 'EEXIST'
    ) {
      return
    }
    throw error
  }
}

export async function initClaudePlugin(
  path: string,
  name = basename(resolve(path)),
  options: ClaudePluginInitOptions = {},
): Promise<ClaudePluginRecord> {
  if (!PLUGIN_NAME.test(name))
    throw new Error(`Plugin name must match ${PLUGIN_NAME}`)
  const root = resolve(path)
  const nativeLayout = options.nativeLayout === true
  const manifestDirectory = join(root, '.claude-plugin')
  if (await isDirectory(manifestDirectory)) {
    if (!options.force) {
      throw new Error(
        `${manifestDirectory} already exists. Use --force to overwrite.`,
      )
    }
    await rm(manifestDirectory, { recursive: true, force: true })
  } else if (!nativeLayout && (await isDirectory(root))) {
    const entries = await readdir(root)
    if (entries.length > 0)
      throw new Error(`Plugin directory is not empty: ${root}`)
  }

  const components = new Set<ClaudePluginInitComponent>(
    nativeLayout ? (options.with ?? []) : ['skills', 'agents'],
  )
  for (const component of components) {
    if (!INIT_COMPONENTS.includes(component)) {
      throw new Error(
        `Unknown --with component ${component}. Valid: ${INIT_COMPONENTS.join(', ')}`,
      )
    }
  }
  const [defaultAuthor, defaultAuthorEmail] = nativeLayout
    ? await Promise.all([gitConfig('user.name'), gitConfig('user.email')])
    : [undefined, undefined]
  const author = options.author ?? defaultAuthor
  const authorEmail = options.authorEmail ?? defaultAuthorEmail
  const manifest: Record<string, unknown> = nativeLayout
    ? {
        $schema: 'https://anthropic.com/claude-code/plugin.schema.json',
        name,
        version: '0.1.0',
        description:
          options.description ?? 'TODO: describe what this plugin provides',
        ...(author === undefined && authorEmail === undefined
          ? {}
          : {
              author: {
                ...(author === undefined ? {} : { name: author }),
                ...(authorEmail === undefined ? {} : { email: authorEmail }),
              },
            }),
        skills: ['./'],
        ...(components.has('channel')
          ? { channels: [{ server: name, displayName: name }] }
          : {}),
      }
    : {
        name,
        version: '0.1.0',
        description: options.description ?? `${name} plugin`,
      }
  await writeScaffoldFile(
    join(manifestDirectory, 'plugin.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    options.force === true,
  )

  if (nativeLayout) {
    await writeScaffoldComponent(
      join(root, 'SKILL.md'),
      `---\nname: ${name}\ndescription: TODO — describe when Claude should use this plugin.\n---\n\n# ${name}\n\nTODO: what this plugin does.\n`,
      options.force === true,
    )
  } else {
    await writeScaffoldComponent(
      join(root, 'commands', 'hello.md'),
      '# Hello\n\nDescribe the current workspace.\n',
      options.force === true,
    )
  }
  if (components.has('skills')) {
    await writeScaffoldComponent(
      join(root, 'skills', 'example', 'SKILL.md'),
      '---\nname: example\ndescription: Example plugin skill\n---\n\nUse this skill to inspect the workspace.\n',
      options.force === true,
    )
  }
  if (components.has('agents')) {
    await writeScaffoldComponent(
      join(root, 'agents', nativeLayout ? 'example.md' : 'reviewer.md'),
      '---\nname: example\ndescription: Review changes\n---\n\nReview the current changes.\n',
      options.force === true,
    )
  }
  if (components.has('hooks')) {
    await writeScaffoldComponent(
      join(root, 'hooks', 'hooks.json'),
      '{\n  "hooks": {\n    "SessionStart": []\n  }\n}\n',
      options.force === true,
    )
  }
  if (components.has('mcp') || components.has('channel')) {
    await writeScaffoldComponent(
      join(root, '.mcp.json'),
      `${JSON.stringify(
        {
          mcpServers: {
            [components.has('channel') ? name : 'example']: {
              command: 'npx',
              args: ['<your-mcp-server-package>'],
            },
          },
        },
        null,
        2,
      )}\n`,
      options.force === true,
    )
  }
  if (components.has('lsp')) {
    await writeScaffoldComponent(
      join(root, '.lsp.json'),
      '{\n  "example": {\n    "command": "example-language-server",\n    "args": ["--stdio"]\n  }\n}\n',
      options.force === true,
    )
  }
  if (components.has('output-style')) {
    await writeScaffoldComponent(
      join(root, 'output-styles', `${name}.md`),
      `---\nname: ${name}\ndescription: TODO — output style description\nforce-for-plugin: true\n---\n\nTODO: style instructions.\n`,
      options.force === true,
    )
  }
  if (components.has('channel')) {
    await writeScaffoldComponent(
      join(root, 'server.ts'),
      '// TODO: implement channel server.\n',
      options.force === true,
    )
    await writeScaffoldComponent(
      join(root, 'package.json'),
      `${JSON.stringify(
        {
          name: `claude-channel-${name}`,
          version: '0.1.0',
          type: 'module',
        },
        null,
        2,
      )}\n`,
      options.force === true,
    )
  }
  return validateClaudePlugin(root)
}

function detailComponentName(path: string): string {
  const file = basename(path).replace(/\.md$/u, '')
  const value = file === 'SKILL' ? basename(dirname(path)) : file
  return value.includes(':') ? (value.split(':').at(-1) ?? value) : value
}

function detailPromptParts(content: string): {
  description: string
  whenToUse?: string
  body: string
} {
  const lines = content.split(/\r?\n/u)
  if (lines[0]?.trim() !== '---') {
    const first = lines.find((line) => line.trim().length > 0)?.trim() ?? ''
    const description = first.replace(/^#+\s+/u, '').slice(0, 100)
    return { description, body: content.trim() }
  }
  const closingIndex = lines.findIndex(
    (line, index) => index > 0 && line.trim() === '---',
  )
  if (closingIndex < 0) return { description: '', body: content.trim() }
  let metadata: Record<string, unknown> = {}
  try {
    const parsed: unknown = parseYaml(lines.slice(1, closingIndex).join('\n'))
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed)
    ) {
      metadata = parsed as Record<string, unknown>
    }
  } catch {
    // Invalid frontmatter is reported by plugin validation; keep details usable.
  }
  const body = lines.slice(closingIndex + 1).join('\n').trim()
  const fallback = body
    .split(/\r?\n/u)
    .find((line) => line.trim().length > 0)
    ?.trim()
    .replace(/^#+\s+/u, '')
    .slice(0, 100)
  const description =
    typeof metadata.description === 'string' && metadata.description.trim()
      ? metadata.description.trim()
      : (fallback ?? '')
  const rawWhen = metadata.when_to_use ?? metadata.whenToUse
  return {
    description,
    ...(rawWhen === undefined || rawWhen === null
      ? {}
      : { whenToUse: String(rawWhen) }),
    body,
  }
}

function detailComponentCost(
  kind: ClaudePluginComponentKind,
  name: string,
  content: string,
  pluginName: string,
): ClaudePluginComponentCost {
  const parts = detailPromptParts(content)
  const metadataName = kind === 'agent' ? name : `${pluginName}:${name}`
  const alwaysOnText = [metadataName, parts.description, parts.whenToUse]
    .filter(Boolean)
    .join(' ')
  return {
    kind,
    name,
    alwaysOn: Math.round(alwaysOnText.length / 4),
    onInvoke: Math.round(parts.body.length / 4),
  }
}

function keysFromJsonResources(
  resources: readonly ClaudeJsonResource[],
  property: 'hooks' | 'mcpServers',
): string[] {
  return [
    ...new Set(
      resources.flatMap((resource) => {
        if (!isRecord(resource.value) || !isRecord(resource.value[property])) {
          return []
        }
        return Object.keys(resource.value[property])
      }),
    ),
  ].sort((left, right) => left.localeCompare(right))
}

export async function describeClaudePlugin(
  path: string,
  source = 'details',
): Promise<ClaudePluginDetails> {
  const root = resolve(path)
  const loaded = await loadPlugin(root, source, true, root, true)
  let lspServers: string[] = []
  try {
    const value: unknown = JSON.parse(
      await readFile(join(root, '.lsp.json'), 'utf8'),
    )
    if (isRecord(value)) lspServers = Object.keys(value).sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const rootSkillPath = join(
    root,
    'skills',
    `${loaded.record.name}:${loaded.record.name}`,
    'SKILL.md',
  )
  const skills = loaded.resources.skills.filter(
    (resource) =>
      !source.endsWith('@skills-dir') || resource.path !== rootSkillPath,
  )
  const componentCosts = [
    ...skills.map((resource) =>
      detailComponentCost(
        'skill',
        detailComponentName(resource.path),
        resource.content,
        loaded.record.name,
      ),
    ),
    ...loaded.resources.agents.map((resource) =>
      detailComponentCost(
        'agent',
        detailComponentName(resource.path),
        resource.content,
        loaded.record.name,
      ),
    ),
    ...loaded.resources.commands.map((resource) =>
      detailComponentCost(
        'command',
        detailComponentName(resource.path),
        resource.content,
        loaded.record.name,
      ),
    ),
  ]
  const tokenEstimate = {
    alwaysOn: componentCosts.reduce(
      (total, component) => total + component.alwaysOn,
      0,
    ),
    onInvoke: componentCosts.reduce(
      (total, component) => total + component.onInvoke,
      0,
    ),
  }
  return {
    plugin: loaded.record,
    components: {
      commands: loaded.resources.commands
        .map((resource) => detailComponentName(resource.path))
        .sort(),
      skills: skills
        .map((resource) => detailComponentName(resource.path))
        .sort(),
      agents: loaded.resources.agents
        .map((resource) => detailComponentName(resource.path))
        .sort(),
      hooks: keysFromJsonResources(loaded.resources.settings, 'hooks'),
      mcpServers: keysFromJsonResources(loaded.resources.mcp, 'mcpServers'),
      lspServers,
    },
    componentCosts,
    tokenEstimate,
  }
}

export async function installClaudePlugin(
  configRoot: string,
  source: string,
  enabled = true,
): Promise<ClaudePluginRegistryEntry> {
  const materialized = await materializeClaudePluginSource(source)
  try {
    const sourcePath = await realpath(materialized.path)
    const record = await validateClaudePlugin(sourcePath)
    const target = join(configRoot, 'plugins', 'installed', record.name)
    await mkdir(dirname(target), { recursive: true })
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
    await cp(sourcePath, temporary, { recursive: true, errorOnExist: true })
    await replaceClaudePluginDirectory(temporary, target)
    const sourceReference = /^https:\/\//u.test(source)
      ? source
      : resolve(source)
    const entry: ClaudePluginRegistryEntry = {
      name: record.name,
      path: target,
      source: sourceReference,
      enabled,
      ...(record.version === undefined ? {} : { version: record.version }),
    }
    const registry = (await readPluginRegistry(configRoot)).filter(
      (item) => item.name !== record.name,
    )
    await writePluginRegistry(configRoot, [...registry, entry])
    return entry
  } finally {
    await materialized.cleanup()
  }
}

export async function setClaudePluginEnabled(
  configRoot: string,
  name: string,
  enabled: boolean,
): Promise<ClaudePluginRegistryEntry> {
  const registry = await readPluginRegistry(configRoot)
  const entry = registry.find((item) => item.name === name)
  if (!entry) throw new Error(`Plugin not installed: ${name}`)
  const updated = { ...entry, enabled }
  await writePluginRegistry(
    configRoot,
    registry.map((item) => (item.name === name ? updated : item)),
  )
  return updated
}

export async function uninstallClaudePlugin(
  configRoot: string,
  name: string,
  deleteData = true,
): Promise<void> {
  const registry = await readPluginRegistry(configRoot)
  const entry = registry.find((item) => item.name === name)
  if (!entry) throw new Error(`Plugin not installed: ${name}`)
  await rm(entry.path, { recursive: true, force: true })
  if (deleteData) {
    await rm(claudePluginDataPath(configRoot, name), {
      recursive: true,
      force: true,
    })
  }
  await writePluginRegistry(
    configRoot,
    registry.filter((item) => item.name !== name),
  )
}

export async function updateClaudePlugin(
  configRoot: string,
  name: string,
): Promise<ClaudePluginRegistryEntry> {
  const registry = await readPluginRegistry(configRoot)
  const entry = registry.find((item) => item.name === name)
  if (!entry) throw new Error(`Plugin not installed: ${name}`)
  return installClaudePlugin(configRoot, entry.source, entry.enabled)
}
