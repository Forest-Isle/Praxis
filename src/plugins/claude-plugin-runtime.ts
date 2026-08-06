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
import { basename, dirname, extname, join, relative, resolve } from 'node:path'

import type {
  ClaudeJsonResource,
  ClaudeResourceScope,
  ClaudeTextResource,
} from '../compatibility/claude/shared-resources.js'
import {
  materializeClaudePluginSource,
  replaceClaudePluginDirectory,
  readClaudeInstalledPlugins,
} from './claude-plugin-marketplace.js'

interface ClaudePluginCommandDefinition {
  source?: string
  content?: string
  description?: string
}

export interface ClaudePluginManifest {
  name: string
  version?: string
  description?: string
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
}

export interface ClaudePluginRecord {
  name: string
  path: string
  source: string
  enabled: boolean
  version?: string
  description?: string
  errors: readonly string[]
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
    const skillName = base.split('/')[0] || basename(root)
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
  const skillsRoots = pathList(manifest.skills, 'skills').map((path) =>
    safePluginPath(canonical, path),
  )
  const agentsRoots = pathList(manifest.agents, 'agents').map((path) =>
    safePluginPath(canonical, path),
  )
  const [commandFiles, skillFiles, agentFiles] = await Promise.all([
    componentFiles(canonical, commandPaths, 'commands', 'commands'),
    componentFiles(canonical, manifest.skills, 'skills', 'skills'),
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

export async function validateClaudePlugin(
  path: string,
): Promise<ClaudePluginRecord> {
  return (await loadPlugin(path, 'validate', true, resolve(path), true)).record
}

export async function initClaudePlugin(
  path: string,
  name = basename(resolve(path)),
): Promise<void> {
  if (!PLUGIN_NAME.test(name))
    throw new Error(`Plugin name must match ${PLUGIN_NAME}`)
  const root = resolve(path)
  if (await isDirectory(root)) {
    const entries = await readdir(root)
    if (entries.length > 0)
      throw new Error(`Plugin directory is not empty: ${root}`)
  }
  await mkdir(join(root, '.claude-plugin'), { recursive: true })
  await mkdir(join(root, 'commands'), { recursive: true })
  await mkdir(join(root, 'skills', 'example'), { recursive: true })
  await mkdir(join(root, 'agents'), { recursive: true })
  await writeFile(
    join(root, '.claude-plugin', 'plugin.json'),
    `${JSON.stringify({ name, version: '0.1.0', description: `${name} plugin` }, null, 2)}\n`,
    { flag: 'wx' },
  )
  await writeFile(
    join(root, 'commands', 'hello.md'),
    '# Hello\n\nDescribe the current workspace.\n',
    { flag: 'wx' },
  )
  await writeFile(
    join(root, 'skills', 'example', 'SKILL.md'),
    '---\ndescription: Example plugin skill\n---\nUse this skill to inspect the workspace.\n',
    { flag: 'wx' },
  )
  await writeFile(
    join(root, 'agents', 'reviewer.md'),
    '---\ndescription: Review changes\n---\nReview the current changes.\n',
    { flag: 'wx' },
  )
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
): Promise<void> {
  const registry = await readPluginRegistry(configRoot)
  const entry = registry.find((item) => item.name === name)
  if (!entry) throw new Error(`Plugin not installed: ${name}`)
  await rm(entry.path, { recursive: true, force: true })
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
