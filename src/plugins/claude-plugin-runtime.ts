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
import { countTokens } from '@anthropic-ai/tokenizer'

import type {
  ClaudeJsonResource,
  ClaudeResourceScope,
  ClaudeTextResource,
} from '../compatibility/claude/shared-resources.js'
import {
  claudePluginDataPath,
  materializeClaudePluginSource,
  readClaudePluginOptions,
  readClaudePluginMcpServerOptions,
  readClaudeSkillsDirectoryPlugins,
  replaceClaudePluginDirectory,
  readClaudeInstalledPlugins,
  validateClaudePluginUserConfig,
} from './claude-plugin-marketplace.js'
import { loadClaudePluginMcpb } from './claude-plugin-mcpb.js'

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
  lspServers?:
    | string
    | Record<string, unknown>
    | readonly (string | Record<string, unknown>)[]
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
  lsp: ClaudePluginLspServer[]
}

export interface ClaudePluginLspServer {
  name: string
  pluginName: string
  pluginRoot: string
  command: string
  args: readonly string[]
  env: Readonly<Record<string, string>>
  extensionToLanguage: Readonly<Record<string, string>>
  initializationOptions?: unknown
  settings?: unknown
  workspaceFolder?: string
  startupTimeout?: number
  maxRestarts?: number
  sensitiveValues?: readonly string[]
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
  if (
    value.lspServers !== undefined &&
    !(
      typeof value.lspServers === 'string' ||
      isRecord(value.lspServers) ||
      (Array.isArray(value.lspServers) &&
        value.lspServers.every(
          (item) => typeof item === 'string' || isRecord(item),
        ))
    )
  ) {
    throw new Error(
      `Plugin lspServers must be a path, object, or array: ${manifestPath}`,
    )
  }
  validateClaudePluginUserConfig(value.userConfig, manifestPath)
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
  pluginData: string,
  userConfig?: Readonly<Record<string, string | number | boolean | string[]>>,
  userConfigSchema?: Readonly<Record<string, unknown>>,
): Promise<ClaudeTextResource[]> {
  return Promise.all(
    files.map(async (file) => ({
      path: namespacedPath(pluginPath, roots, file, name, kind),
      scope,
      content: expandPluginContent(
        await readFile(file, 'utf8'),
        pluginPath,
        pluginData,
        userConfig,
        userConfigSchema,
        kind === 'skills' ? dirname(file) : undefined,
      ),
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

function expandLspString(
  value: string,
  pluginRoot: string,
  pluginData: string,
  environment: Readonly<Record<string, string | undefined>>,
  userConfig?: Readonly<Record<string, string | number | boolean | string[]>>,
  expandEnvironment = true,
): string {
  let resolved = value
    .replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginRoot)
    .replaceAll('${CLAUDE_PLUGIN_DATA}', pluginData)
  if (userConfig !== undefined) {
    resolved = resolved.replace(
      /\$\{user_config\.([^}]+)\}/gu,
      (_source, key: string) => {
        const configured = userConfig[key]
        if (configured === undefined) {
          throw new Error(`Missing required user configuration value: ${key}`)
        }
        return String(configured)
      },
    )
  }
  if (!expandEnvironment) return resolved
  return resolved.replace(/\$\{([^}]+)\}/gu, (source, expression: string) => {
    const [name, fallback] = expression.split(':-', 2)
    return environment[name ?? ''] ?? fallback ?? source
  })
}

function expandRuntimeValue(
  value: unknown,
  pluginRoot: string,
  pluginData: string,
  environment: Readonly<Record<string, string | undefined>>,
  userConfig?: Readonly<Record<string, string | number | boolean | string[]>>,
  expandEnvironment = true,
): unknown {
  if (typeof value === 'string') {
    return expandLspString(
      value,
      pluginRoot,
      pluginData,
      environment,
      userConfig,
      expandEnvironment,
    )
  }
  if (Array.isArray(value)) {
    return value.map((item) =>
      expandRuntimeValue(
        item,
        pluginRoot,
        pluginData,
        environment,
        userConfig,
        expandEnvironment,
      ),
    )
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        expandRuntimeValue(
          item,
          pluginRoot,
          pluginData,
          environment,
          userConfig,
          expandEnvironment,
        ),
      ]),
    )
  }
  return value
}

function expandPluginContent(
  content: string,
  pluginRoot: string,
  pluginData: string,
  userConfig?: Readonly<Record<string, string | number | boolean | string[]>>,
  userConfigSchema?: Readonly<Record<string, unknown>>,
  skillDirectory?: string,
): string {
  let resolved = content
    .replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginRoot)
    .replaceAll('${CLAUDE_PLUGIN_DATA}', pluginData)
  if (skillDirectory !== undefined) {
    resolved = resolved.replaceAll('${CLAUDE_SKILL_DIR}', skillDirectory)
  }
  if (userConfigSchema === undefined) return resolved
  return resolved.replace(
    /\$\{user_config\.([^}]+)\}/gu,
    (source, key: string) => {
      const definition = userConfigSchema[key]
      if (isRecord(definition) && definition.sensitive === true) {
        return `[sensitive option '${key}' not available in skill content]`
      }
      const configured = userConfig?.[key]
      return configured === undefined ? source : String(configured)
    },
  )
}

function pluginOptionEnvironment(
  pluginRoot: string,
  pluginData: string,
  userConfig?: Readonly<Record<string, string | number | boolean | string[]>>,
): Record<string, string> {
  const result: Record<string, string> = {
    CLAUDE_PLUGIN_ROOT: pluginRoot,
    CLAUDE_PLUGIN_DATA: pluginData,
  }
  for (const [key, value] of Object.entries(userConfig ?? {})) {
    const envKey = key.replace(/[^A-Za-z0-9_]/gu, '_').toUpperCase()
    result[`CLAUDE_PLUGIN_OPTION_${envKey}`] = String(value)
  }
  return result
}

function expandPluginMcpResource(
  value: unknown,
  pluginName: string,
  pluginRoot: string,
  pluginData: string,
  environment: Readonly<Record<string, string | undefined>>,
  userConfig?: Readonly<Record<string, string | number | boolean | string[]>>,
): unknown {
  const expanded = expandRuntimeValue(
    value,
    pluginRoot,
    pluginData,
    environment,
    userConfig,
  )
  if (!isRecord(expanded) || !isRecord(expanded.mcpServers)) return expanded
  return {
    ...expanded,
    mcpServers: Object.fromEntries(
      Object.entries(expanded.mcpServers).map(([name, config]) => {
        const scopedName = `plugin:${pluginName}:${name}`
        if (
          !isRecord(config) ||
          config.type === 'http' ||
          config.type === 'sse' ||
          config.url !== undefined
        ) {
          return [scopedName, config]
        }
        const configuredEnv = isRecord(config.env) ? config.env : {}
        return [
          scopedName,
          {
            ...config,
            env: {
              CLAUDE_PLUGIN_ROOT: pluginRoot,
              CLAUDE_PLUGIN_DATA: pluginData,
              ...configuredEnv,
            },
          },
        ]
      }),
    ),
  }
}

function isMcpbReference(value: string): boolean {
  return value.endsWith('.mcpb') || value.endsWith('.dxt')
}

function isUrlReference(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//iu.test(value)
}

function lspServerDefinition(
  name: string,
  value: unknown,
  pluginName: string,
  pluginRoot: string,
  pluginSource: string,
  configRoot: string | undefined,
  environment: Readonly<Record<string, string | undefined>>,
  userConfig?: Readonly<Record<string, string | number | boolean | string[]>>,
  sensitiveValues: readonly string[] = [],
): ClaudePluginLspServer {
  if (!isRecord(value)) throw new Error(`LSP server ${name} must be an object`)
  const pluginData = claudePluginDataPath(
    configRoot ?? pluginRoot,
    pluginSource,
  )
  const command = expandLspString(
    nonEmptyString(value.command, `LSP server ${name} command`),
    pluginRoot,
    pluginData,
    environment,
    userConfig,
  )
  const args = value.args ?? []
  if (!Array.isArray(args) || !args.every((item) => typeof item === 'string')) {
    throw new Error(`LSP server ${name} args must be an array of strings`)
  }
  const env = value.env ?? {}
  if (
    !isRecord(env) ||
    !Object.values(env).every((item) => typeof item === 'string')
  ) {
    throw new Error(`LSP server ${name} env must contain string values`)
  }
  const extensionToLanguage = value.extensionToLanguage
  if (
    !isRecord(extensionToLanguage) ||
    Object.keys(extensionToLanguage).length === 0 ||
    !Object.entries(extensionToLanguage).every(
      ([extension, language]) =>
        extension.startsWith('.') &&
        extension.length > 1 &&
        typeof language === 'string' &&
        language.trim().length > 0,
    )
  ) {
    throw new Error(
      `LSP server ${name} extensionToLanguage must map extensions to language IDs`,
    )
  }
  if (
    value.transport !== undefined &&
    value.transport !== 'stdio' &&
    value.transport !== 'socket'
  ) {
    throw new Error(`LSP server ${name} transport must be stdio or socket`)
  }
  const workspaceFolder =
    value.workspaceFolder === undefined
      ? undefined
      : nonEmptyString(
          value.workspaceFolder,
          `LSP server ${name} workspaceFolder`,
        )
  const positiveInteger = (field: 'startupTimeout' | 'shutdownTimeout') => {
    const candidate = value[field]
    if (
      candidate !== undefined &&
      (!Number.isSafeInteger(candidate) || Number(candidate) <= 0)
    ) {
      throw new Error(`LSP server ${name} ${field} must be a positive integer`)
    }
    return candidate as number | undefined
  }
  const startupTimeout = positiveInteger('startupTimeout')
  positiveInteger('shutdownTimeout')
  if (value.shutdownTimeout !== undefined) {
    throw new Error(
      `LSP server '${name}': shutdownTimeout is not yet implemented. Remove this field from the configuration.`,
    )
  }
  if (value.restartOnCrash !== undefined) {
    if (typeof value.restartOnCrash !== 'boolean') {
      throw new Error(`LSP server ${name} restartOnCrash must be a boolean`)
    }
    throw new Error(
      `LSP server '${name}': restartOnCrash is not yet implemented. Remove this field from the configuration.`,
    )
  }
  if (
    value.maxRestarts !== undefined &&
    (!Number.isSafeInteger(value.maxRestarts) || Number(value.maxRestarts) < 0)
  ) {
    throw new Error(
      `LSP server ${name} maxRestarts must be a non-negative integer`,
    )
  }
  return {
    name,
    pluginName,
    pluginRoot,
    command,
    args: args.map((arg) =>
      expandLspString(arg, pluginRoot, pluginData, environment, userConfig),
    ),
    env: {
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      CLAUDE_PLUGIN_DATA: pluginData,
      ...Object.fromEntries(
        Object.entries(env).map(([key, item]) => [
          key,
          expandLspString(
            item as string,
            pluginRoot,
            pluginData,
            environment,
            userConfig,
          ),
        ]),
      ),
    },
    extensionToLanguage: extensionToLanguage as Record<string, string>,
    ...(value.initializationOptions === undefined
      ? {}
      : { initializationOptions: value.initializationOptions }),
    ...(value.settings === undefined ? {} : { settings: value.settings }),
    ...(workspaceFolder === undefined
      ? {}
      : {
          workspaceFolder: expandLspString(
            workspaceFolder,
            pluginRoot,
            pluginData,
            environment,
            userConfig,
          ),
        }),
    ...(startupTimeout === undefined ? {} : { startupTimeout }),
    ...(value.maxRestarts === undefined
      ? {}
      : { maxRestarts: Number(value.maxRestarts) }),
    ...(sensitiveValues.length === 0 ? {} : { sensitiveValues }),
  }
}

async function loadLspServers(
  root: string,
  manifest: ClaudePluginManifest,
  source: string,
  configRoot: string | undefined,
  environment: Readonly<Record<string, string | undefined>>,
  userConfig?: Readonly<Record<string, string | number | boolean | string[]>>,
  sensitiveValues: readonly string[] = [],
): Promise<ClaudePluginLspServer[]> {
  const definitions = new Map<string, ClaudePluginLspServer>()
  const add = async (
    value: string | Record<string, unknown>,
    required: boolean,
  ): Promise<void> => {
    try {
      const parsed = expandPluginRoot(
        typeof value === 'string'
          ? JSON.parse(await readFile(safePluginPath(root, value), 'utf8'))
          : value,
        root,
      )
      if (!isRecord(parsed)) throw new Error('LSP config must be an object')
      const servers = isRecord(parsed.lspServers) ? parsed.lspServers : parsed
      for (const [name, server] of Object.entries(servers)) {
        if (configRoot) {
          await mkdir(claudePluginDataPath(configRoot, source), {
            recursive: true,
          })
        }
        definitions.set(
          name,
          lspServerDefinition(
            name,
            server,
            manifest.name,
            root,
            source,
            configRoot,
            environment,
            userConfig,
            sensitiveValues,
          ),
        )
      }
    } catch (error) {
      if (required || (error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`Invalid plugin LSP config in ${root}`, {
          cause: error,
        })
      }
    }
  }
  await add('.lsp.json', false)
  if (manifest.lspServers !== undefined) {
    const values = Array.isArray(manifest.lspServers)
      ? manifest.lspServers
      : [manifest.lspServers]
    for (const value of values) await add(value, true)
  }
  return [...definitions.values()]
}

async function loadPlugin(
  pluginPath: string,
  source: string,
  enabled: boolean,
  cwd: string,
  requireManifest = false,
  resourceScope?: ClaudeResourceScope,
  configRoot?: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  configId?: string,
  readOnlyHooks = false,
): Promise<{
  record: ClaudePluginRecord
  resources: Omit<ClaudePluginResources, 'plugins'>
}> {
  const canonical = await realpath(pluginPath)
  if (!(await isDirectory(canonical)))
    throw new Error(`Plugin path is not a directory: ${pluginPath}`)
  const manifest = await readManifest(canonical, requireManifest)
  const userConfig =
    configRoot !== undefined &&
    configId !== undefined &&
    manifest.userConfig !== undefined
      ? await readClaudePluginOptions(
          configRoot,
          cwd,
          configId,
          manifest.userConfig as unknown as Record<
            string,
            Record<string, unknown>
          >,
        )
      : undefined
  const sensitiveValues = Object.entries(manifest.userConfig ?? {})
    .flatMap(([key, definition]) =>
      isRecord(definition) &&
      definition.sensitive === true &&
      userConfig?.[key] !== undefined
        ? [String(userConfig[key])]
        : [],
    )
    .filter((value) => value.length > 0)
  const pluginData = claudePluginDataPath(configRoot ?? canonical, source)
  if (configRoot !== undefined && !readOnlyHooks) {
    await mkdir(pluginData, { recursive: true })
  }
  const pluginEnvironment = pluginOptionEnvironment(
    canonical,
    pluginData,
    userConfig,
  )
  const pluginResourceMetadata = {
    plugin: true as const,
    pluginName: manifest.name,
    pluginSource: source,
    environment: pluginEnvironment,
    ...(sensitiveValues.length === 0 ? {} : { sensitiveValues }),
  }
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
  const [commands, skills, agents, lsp] = readOnlyHooks
    ? [[], [], [], []]
    : await (async () => {
        const [commandFiles, skillFiles, agentFiles, loadedLsp] =
          await Promise.all([
            componentFiles(canonical, commandPaths, 'commands', 'commands'),
            skillsDirectoryLayout
              ? skillsDirectoryFiles(canonical)
              : componentFiles(canonical, manifest.skills, 'skills', 'skills'),
            componentFiles(canonical, manifest.agents, 'agents', 'agents'),
            loadLspServers(
              canonical,
              manifest,
              source,
              configRoot,
              environment,
              manifest.userConfig === undefined ? undefined : userConfig,
              sensitiveValues,
            ),
          ])
        const loadedText = await Promise.all([
          loadTextResources(
            commandFiles,
            canonical,
            commandsRoots,
            manifest.name,
            scope,
            'commands',
            pluginData,
            userConfig,
            manifest.userConfig,
          ),
          loadTextResources(
            skillFiles,
            canonical,
            skillsRoots,
            manifest.name,
            scope,
            'skills',
            pluginData,
            userConfig,
            manifest.userConfig,
          ),
          loadTextResources(
            agentFiles,
            canonical,
            agentsRoots,
            manifest.name,
            scope,
            'agents',
            pluginData,
            userConfig,
            manifest.userConfig,
          ),
        ])
        return [...loadedText, loadedLsp] as const
      })()
  if (commandDefinitions && !readOnlyHooks) {
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
          content: expandPluginContent(
            definition.content,
            canonical,
            pluginData,
            userConfig,
            manifest.userConfig,
          ),
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
        content: expandPluginContent(
          await readFile(sourcePath, 'utf8'),
          canonical,
          pluginData,
          userConfig,
          manifest.userConfig,
        ),
      })
    }
  }
  const settings: ClaudeJsonResource[] = []
  const loadedHookPaths = new Set<string>()
  const normalizeHooks = (value: unknown): unknown =>
    isRecord(value) && 'hooks' in value ? value : { hooks: value }
  const addHooksFile = async (
    hooksPath: string,
    required = false,
  ): Promise<void> => {
    if (loadedHookPaths.has(hooksPath)) return
    try {
      const value = JSON.parse(await readFile(hooksPath, 'utf8'))
      loadedHookPaths.add(hooksPath)
      settings.push({
        path: hooksPath,
        scope,
        value: expandRuntimeValue(
          normalizeHooks(value),
          canonical,
          pluginData,
          environment,
          userConfig,
          false,
        ),
        ...pluginResourceMetadata,
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
      value: expandRuntimeValue(
        normalizeHooks(manifest.hooks),
        canonical,
        pluginData,
        environment,
        userConfig,
        false,
      ),
      ...pluginResourceMetadata,
    })
  } else if (Array.isArray(manifest.hooks)) {
    for (const [index, hook] of manifest.hooks.entries()) {
      if (typeof hook === 'string') {
        await addHooksFile(safePluginPath(canonical, hook), true)
      } else {
        settings.push({
          path: join(canonical, '.claude-plugin', `plugin-hooks-${index}.json`),
          scope,
          value: expandRuntimeValue(
            normalizeHooks(hook),
            canonical,
            pluginData,
            environment,
            userConfig,
            false,
          ),
          ...pluginResourceMetadata,
        })
      }
    }
  }
  if (readOnlyHooks) {
    return {
      record: {
        name: manifest.name,
        path: canonical,
        source,
        enabled,
        ...(manifest.version === undefined
          ? {}
          : { version: manifest.version }),
        ...(manifest.description === undefined
          ? {}
          : { description: manifest.description }),
        errors: [],
      },
      resources: { commands, skills, agents, settings, mcp: [], lsp },
    }
  }
  const mcpPath = join(canonical, '.mcp.json')
  let mcpValue: unknown
  const mcpErrors: string[] = []
  try {
    mcpValue = JSON.parse(await readFile(mcpPath, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      mcpErrors.push(`Invalid plugin MCP config: ${mcpPath}`)
    }
  }
  const mcp: ClaudeJsonResource[] = []
  if (mcpValue !== undefined) {
    try {
      mcp.push({
        path: mcpPath,
        scope,
        value: expandPluginMcpResource(
          mcpValue,
          manifest.name,
          canonical,
          pluginData,
          environment,
          userConfig,
        ),
        ...pluginResourceMetadata,
      })
    } catch {
      mcpErrors.push(`Invalid plugin MCP config: ${mcpPath}`)
    }
  }
  if (manifest.mcpServers !== undefined) {
    const specs = Array.isArray(manifest.mcpServers)
      ? manifest.mcpServers
      : [manifest.mcpServers]
    for (const [index, spec] of specs.entries()) {
      if (typeof spec === 'string') {
        const urlReference = isUrlReference(spec)
        if (
          (urlReference &&
            (!/^https?:\/\//u.test(spec) || !isMcpbReference(spec))) ||
          (!urlReference && isMcpbReference(spec) && !spec.startsWith('./'))
        ) {
          mcpErrors.push(
            `Invalid plugin MCPB reference at index ${index}: expected ./file.mcpb, ./file.dxt, or an exact-suffix HTTP(S) URL`,
          )
          continue
        }
        if (isMcpbReference(spec)) {
          try {
            const loaded = await loadClaudePluginMcpb({
              pluginRoot: canonical,
              pluginData,
              source: spec,
              environment,
              resolveUserConfig: async (bundleManifest) =>
                configRoot !== undefined && configId !== undefined
                  ? readClaudePluginMcpServerOptions(
                      configRoot,
                      cwd,
                      configId,
                      bundleManifest.name,
                      bundleManifest.user_config as unknown as Record<
                        string,
                        Record<string, unknown>
                      >,
                    )
                  : {},
            })
            mcp.push({
              path: join(
                canonical,
                '.claude-plugin',
                `plugin-mcpb-${index}.json`,
              ),
              scope,
              plugin: true,
              value: {
                mcpServers: {
                  [`plugin:${manifest.name}:${loaded.name}`]: loaded.config,
                },
              },
              environment: pluginEnvironment,
              sensitiveValues: [...sensitiveValues, ...loaded.sensitiveValues],
            })
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error)
            if (!message.includes('Required MCPB user_config is missing:')) {
              mcpErrors.push(message)
            }
          }
          continue
        }
        try {
          const specPath = safePluginPath(canonical, spec)
          const value: unknown = JSON.parse(await readFile(specPath, 'utf8'))
          mcp.push({
            path: specPath,
            scope,
            value: expandPluginMcpResource(
              value,
              manifest.name,
              canonical,
              pluginData,
              environment,
              userConfig,
            ),
            ...pluginResourceMetadata,
          })
        } catch {
          mcpErrors.push(
            `Invalid plugin MCP config ${basename(spec)} at index ${index}`,
          )
        }
      } else if (isRecord(spec)) {
        mcp.push({
          path: join(canonical, '.claude-plugin', `plugin-mcp-${index}.json`),
          scope,
          value: expandPluginMcpResource(
            { mcpServers: spec },
            manifest.name,
            canonical,
            pluginData,
            environment,
            userConfig,
          ),
          ...pluginResourceMetadata,
        })
      } else {
        mcpErrors.push(`Invalid plugin MCP config in ${canonical}`)
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
      errors: mcpErrors,
    },
    resources: { commands, skills, agents, settings, mcp, lsp },
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
  readOnlyHooks?: boolean
  environment?: Readonly<Record<string, string | undefined>>
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
    configId?: string
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
    configId?: string
  }> = [
    ...nativeRegistry
      .filter((entry) => entry.enabled)
      .map((entry) => ({
        path: entry.installPath,
        source: entry.id,
        enabled: entry.enabled,
        resourceScope: entry.scope as ClaudeResourceScope,
        configId: entry.id,
      })),
    ...skillsDirectoryRegistry
      .filter((entry) => entry.enabled)
      .map((entry) => ({
        path: entry.installPath,
        source: entry.id,
        enabled: entry.enabled,
        resourceScope: 'user' as ClaudeResourceScope,
        configId: entry.id,
      })),
    ...registry
      .filter((entry) => entry.enabled)
      .map((entry) => ({
        path: entry.path,
        source: entry.source,
        enabled: true,
        configId: entry.name,
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
            options.configRoot,
            options.environment ?? process.env,
            candidate.configId,
            options.readOnlyHooks,
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
              lsp: [],
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
          lsp: [...result.lsp, ...current.resources.lsp],
        }),
        {
          plugins: [],
          commands: [],
          skills: [],
          agents: [],
          settings: [],
          mcp: [],
          lsp: [],
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
  const body = lines
    .slice(closingIndex + 1)
    .join('\n')
    .trim()
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
): ClaudePluginComponentCost & {
  alwaysOnText: string
  onInvokeText: string
} {
  const parts = detailPromptParts(content)
  const metadataName = kind === 'agent' ? name : `${pluginName}:${name}`
  const alwaysOnText = [metadataName, parts.description, parts.whenToUse]
    .filter(Boolean)
    .join(' ')
  return {
    kind,
    name,
    alwaysOn: 0,
    onInvoke: 0,
    alwaysOnText,
    onInvokeText: parts.body,
  }
}

function scaledTokenCount(
  chars: number,
  totalChars: number,
  totalTokens: number,
): number {
  return totalChars === 0 ? 0 : Math.round((chars / totalChars) * totalTokens)
}

const CLAUDE_PLUGIN_DETAILS_TOKEN_ENVELOPE = 79

function pluginDetailBucketTokenCount(content: string): number {
  if (!content.trim()) return 0
  // Claude's count-tokens request contributes a stable envelope cost in the
  // 2.1.208 plugin-details contract, in addition to the assembled text.
  return countTokens(content) + CLAUDE_PLUGIN_DETAILS_TOKEN_ENVELOPE
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
  const [loaded, manifest] = await Promise.all([
    loadPlugin(root, source, true, root, true),
    readManifest(root, true),
  ])
  const lspServers = new Set<string>()
  const addLspServers = async (
    value: string | Record<string, unknown>,
    required: boolean,
  ): Promise<void> => {
    try {
      const parsed: unknown =
        typeof value === 'string'
          ? JSON.parse(await readFile(safePluginPath(root, value), 'utf8'))
          : value
      if (!isRecord(parsed)) throw new Error('LSP config must be an object')
      const definitions = isRecord(parsed.lspServers)
        ? parsed.lspServers
        : parsed
      for (const name of Object.keys(definitions)) lspServers.add(name)
    } catch (error) {
      if (required || (error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`Invalid plugin LSP config in ${root}`, {
          cause: error,
        })
      }
    }
  }
  await addLspServers('.lsp.json', false)
  if (manifest.lspServers !== undefined) {
    const values = Array.isArray(manifest.lspServers)
      ? manifest.lspServers
      : [manifest.lspServers]
    for (const value of values) await addLspServers(value, true)
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
  const rawComponentCosts = [
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
  const alwaysOnText = rawComponentCosts
    .map((component) => component.alwaysOnText)
    .join('\n')
  const onInvokeText = rawComponentCosts
    .map((component) => component.onInvokeText)
    .join('\n\n')
  const tokenEstimate = {
    alwaysOn: pluginDetailBucketTokenCount(alwaysOnText),
    onInvoke: pluginDetailBucketTokenCount(onInvokeText),
  }
  // Claude counts each assembled bucket once, then allocates that total by the
  // component character share so rounded rows remain additive.
  const alwaysOnChars = rawComponentCosts.reduce(
    (total, component) => total + component.alwaysOnText.length,
    0,
  )
  const onInvokeChars = rawComponentCosts.reduce(
    (total, component) => total + component.onInvokeText.length,
    0,
  )
  const componentCosts: ClaudePluginComponentCost[] = rawComponentCosts.map(
    ({ alwaysOnText: componentAlwaysOn, onInvokeText, ...component }) => ({
      ...component,
      alwaysOn: scaledTokenCount(
        componentAlwaysOn.length,
        alwaysOnChars,
        tokenEstimate.alwaysOn,
      ),
      onInvoke: scaledTokenCount(
        onInvokeText.length,
        onInvokeChars,
        tokenEstimate.onInvoke,
      ),
    }),
  )
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
      mcpServers: keysFromJsonResources(
        loaded.resources.mcp.filter(
          (resource) =>
            !(
              dirname(resource.path) ===
                join(loaded.record.path, '.claude-plugin') &&
              /^plugin-mcpb-\d+\.json$/u.test(basename(resource.path))
            ),
        ),
        'mcpServers',
      ).map((name) => name.replace(`plugin:${loaded.record.name}:`, '')),
      lspServers: [...lspServers].sort(),
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
