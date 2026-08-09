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
import { tmpdir } from 'node:os'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

import { unzipSync } from 'fflate'

import { writeFileAtomically } from '../platform/atomic-write.js'
import type { ClaudePluginRecord } from './claude-plugin-runtime.js'

const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
const MAX_EXTRACTED_BYTES = 256 * 1024 * 1024
const MAX_ARCHIVE_FILES = 4_000
const MARKETPLACE_MANIFEST = join('.claude-plugin', 'marketplace.json')
const PLUGIN_MANIFEST = join('.claude-plugin', 'plugin.json')
const execFileAsync = promisify(execFile)

export type ClaudePluginScope = 'user' | 'project' | 'local'

export interface ClaudeMarketplaceSource {
  source: 'directory' | 'url' | 'git'
  path?: string
  url?: string
  sparsePaths?: readonly string[]
}

export interface ClaudeMarketplacePlugin {
  name: string
  source: string | Record<string, unknown>
  description?: string
  version?: string
  [key: string]: unknown
}

export interface ClaudeMarketplaceManifest {
  name: string
  description?: string
  owner?: Record<string, unknown>
  metadata?: Record<string, unknown>
  plugins: readonly ClaudeMarketplacePlugin[]
}

export interface ClaudeKnownMarketplace {
  name: string
  source: ClaudeMarketplaceSource
  installLocation: string
  lastUpdated?: string
}

export interface ClaudeInstalledPlugin {
  id: string
  scope: ClaudePluginScope
  projectPath?: string
  installPath: string
  version: string
  installedAt: string
  lastUpdated: string
  enabled: boolean
  auto?: boolean
}

export interface ClaudeSkillsDirectoryPlugin {
  id: string
  scope: 'user'
  installPath: string
  version: string
  enabled: boolean
}

export type ClaudePluginTarget =
  ClaudeInstalledPlugin | ClaudeSkillsDirectoryPlugin

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`)
  }
  return value
}

function safePathSegment(value: string, label: string): string {
  if (
    value.length === 0 ||
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('\0')
  ) {
    throw new Error(`${label} must be a single safe path segment`)
  }
  return value
}

function sparsePath(value: string): string {
  const normalized = value.replaceAll('\\', '/')
  if (
    normalized.length === 0 ||
    normalized.startsWith('/') ||
    normalized.startsWith('-') ||
    normalized.includes('\0') ||
    normalized.split('/').some((segment) => segment === '..')
  ) {
    throw new Error(`Invalid sparse checkout path: ${value}`)
  }
  const relativePath = normalized.replace(/^\.\//u, '')
  if (relativePath.length === 0) {
    throw new Error(`Invalid sparse checkout path: ${value}`)
  }
  return relativePath
}

function settingsPath(
  configRoot: string,
  cwd: string,
  scope: ClaudePluginScope,
): string {
  if (scope === 'user') return join(configRoot, 'settings.json')
  return join(
    cwd,
    '.claude',
    scope === 'local' ? 'settings.local.json' : 'settings.json',
  )
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (!isRecord(value))
      throw new Error(`JSON root must be an object: ${path}`)
    return value
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON: ${path}`, { cause: error })
    }
    throw error
  }
}

async function writeJson(
  path: string,
  value: Record<string, unknown>,
): Promise<void> {
  const committed = await writeFileAtomically(
    path,
    `${JSON.stringify(value, null, 2)}\n`,
  )
  if (!committed) throw new Error(`Atomic JSON write was interrupted: ${path}`)
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

export async function replaceClaudePluginDirectory(
  temporary: string,
  target: string,
): Promise<void> {
  const backup = `${target}.${process.pid}.${Date.now()}.bak`
  let movedExisting = false
  let installedReplacement = false
  try {
    if (await pathExists(target)) {
      await rename(target, backup)
      movedExisting = true
    }
    await rename(temporary, target)
    installedReplacement = true
    if (movedExisting) await rm(backup, { recursive: true, force: true })
  } catch (error) {
    if (installedReplacement) {
      await rm(target, { recursive: true, force: true })
    }
    if (movedExisting) {
      try {
        await rename(backup, target)
      } catch {
        // Preserve original failure; backup cleanup is best effort.
      }
    }
    await rm(temporary, { recursive: true, force: true })
    throw error
  }
}

function installedPath(configRoot: string): string {
  return join(configRoot, 'plugins', 'installed_plugins.json')
}

export function claudePluginDataPath(configRoot: string, id: string): string {
  return join(
    resolve(configRoot),
    'plugins',
    'data',
    id.replace(/[^a-zA-Z0-9_-]/gu, '-'),
  )
}

function knownPath(configRoot: string): string {
  return join(configRoot, 'plugins', 'known_marketplaces.json')
}

function validateScope(value: unknown): ClaudePluginScope {
  if (value !== 'user' && value !== 'project' && value !== 'local') {
    throw new Error(`Invalid plugin scope: ${String(value)}`)
  }
  return value
}

function pluginId(value: unknown): string {
  return nonEmptyString(value, 'Plugin id')
}

function validateInstalledEntry(
  id: string,
  value: unknown,
): Omit<ClaudeInstalledPlugin, 'id' | 'enabled'> {
  if (!isRecord(value)) throw new Error(`Invalid installed plugin entry: ${id}`)
  const entry = {
    scope: validateScope(value.scope),
    ...(value.projectPath === undefined
      ? {}
      : {
          projectPath: nonEmptyString(value.projectPath, 'Plugin projectPath'),
        }),
    installPath: nonEmptyString(value.installPath, 'Plugin installPath'),
    version: nonEmptyString(value.version, 'Plugin version'),
    installedAt: nonEmptyString(value.installedAt, 'Plugin installedAt'),
    lastUpdated: nonEmptyString(value.lastUpdated, 'Plugin lastUpdated'),
    ...(value.auto === undefined
      ? {}
      : typeof value.auto === 'boolean'
        ? { auto: value.auto }
        : (() => {
            throw new Error(`Plugin auto must be a boolean: ${id}`)
          })()),
  }
  return entry
}

export async function readClaudeInstalledPlugins(
  configRoot: string,
  cwd: string,
): Promise<ClaudeInstalledPlugin[]> {
  const root = await readJson(installedPath(resolve(configRoot)))
  if (root.version !== undefined && root.version !== 2) {
    throw new Error(
      `Unsupported installed plugin registry version: ${String(root.version)}`,
    )
  }
  const plugins = root.plugins
  if (plugins === undefined) return []
  if (!isRecord(plugins))
    throw new Error('Installed plugin registry plugins must be an object')
  const enabled = await readEffectiveEnabledPlugins(configRoot, cwd)
  const result: ClaudeInstalledPlugin[] = []
  for (const [idValue, entries] of Object.entries(plugins)) {
    const id = pluginId(idValue)
    if (!Array.isArray(entries))
      throw new Error(`Installed plugin entries must be an array: ${id}`)
    for (const entryValue of entries) {
      const entry = validateInstalledEntry(id, entryValue)
      if (entry.scope !== 'user' && entry.projectPath !== resolve(cwd)) continue
      result.push({ id, ...entry, enabled: enabled[id] ?? true })
    }
  }
  return result.sort((left, right) => left.id.localeCompare(right.id))
}

export async function readClaudeSkillsDirectoryPlugins(
  configRoot: string,
  cwd: string,
): Promise<ClaudeSkillsDirectoryPlugin[]> {
  const root = join(resolve(configRoot), 'skills')
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const enabled = await readEffectiveEnabledPlugins(configRoot, cwd)
  const plugins = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(async (entry) => {
        const installPath = join(root, entry.name)
        try {
          const identity = await readPluginIdentity(installPath)
          const id = `${identity.name}@skills-dir`
          return {
            id,
            scope: 'user' as const,
            installPath,
            version: identity.version,
            enabled: enabled[id] ?? true,
          }
        } catch {
          return null
        }
      }),
  )
  return plugins.filter(
    (plugin): plugin is ClaudeSkillsDirectoryPlugin => plugin !== null,
  )
}

async function readEffectiveEnabledPlugins(
  configRoot: string,
  cwd: string,
): Promise<Record<string, boolean>> {
  const result: Record<string, boolean> = {}
  for (const scope of ['user', 'project', 'local'] as const) {
    const settings = await readJson(settingsPath(configRoot, cwd, scope))
    if (!isRecord(settings.enabledPlugins)) continue
    for (const [id, enabled] of Object.entries(settings.enabledPlugins)) {
      if (typeof enabled === 'boolean') result[id] = enabled
    }
  }
  return result
}

export async function writeClaudeInstalledPlugin(
  configRoot: string,
  plugin: ClaudeInstalledPlugin,
): Promise<void> {
  const path = installedPath(resolve(configRoot))
  const root = await readJson(path)
  const plugins = isRecord(root.plugins) ? root.plugins : {}
  const storedEntries = plugins[plugin.id]
  const entries = Array.isArray(storedEntries) ? [...storedEntries] : []
  const serialized = {
    scope: plugin.scope,
    ...(plugin.projectPath === undefined
      ? {}
      : { projectPath: plugin.projectPath }),
    installPath: plugin.installPath,
    version: plugin.version,
    installedAt: plugin.installedAt,
    lastUpdated: plugin.lastUpdated,
    ...(plugin.auto === undefined ? {} : { auto: plugin.auto }),
  }
  const index = entries.findIndex(
    (entry) =>
      isRecord(entry) &&
      entry.scope === plugin.scope &&
      (plugin.scope === 'user' || entry.projectPath === plugin.projectPath),
  )
  if (index >= 0) entries[index] = serialized
  else entries.push(serialized)
  plugins[plugin.id] = entries
  root.version = 2
  root.plugins = plugins
  await writeJson(path, root)
}

export async function removeClaudeInstalledPlugin(
  configRoot: string,
  id: string,
  scope: ClaudePluginScope,
  cwd: string,
  deleteData = true,
): Promise<ClaudeInstalledPlugin> {
  const installed = await readClaudeInstalledPlugins(configRoot, cwd)
  const target = installed.find(
    (item) => item.id === id && item.scope === scope,
  )
  if (!target) throw new Error(`Plugin not installed: ${id}`)
  const path = installedPath(resolve(configRoot))
  const root = await readJson(path)
  const plugins = isRecord(root.plugins) ? root.plugins : {}
  const entries = Array.isArray(plugins[id]) ? [...plugins[id]] : []
  const remaining = entries.filter(
    (entry) =>
      !isRecord(entry) ||
      entry.scope !== scope ||
      (scope !== 'user' && entry.projectPath !== resolve(cwd)),
  )
  if (remaining.length === 0) delete plugins[id]
  else plugins[id] = remaining
  const isLastInstallation =
    !Array.isArray(plugins[id]) || plugins[id].length === 0
  root.plugins = plugins
  await writeJson(path, root)
  const remainingPaths = Object.values(plugins).flatMap((value) =>
    Array.isArray(value)
      ? value.flatMap((entry) =>
          isRecord(entry) && typeof entry.installPath === 'string'
            ? [entry.installPath]
            : [],
        )
      : [],
  )
  if (!remainingPaths.includes(target.installPath)) {
    await rm(target.installPath, { recursive: true, force: true })
  }
  if (isLastInstallation && deleteData) {
    await rm(claudePluginDataPath(configRoot, id), {
      recursive: true,
      force: true,
    })
  }
  await setClaudePluginEnabledNative(configRoot, cwd, id, scope, undefined)
  return target
}

export async function setClaudePluginEnabledNative(
  configRoot: string,
  cwd: string,
  id: string,
  scope: ClaudePluginScope,
  enabled: boolean | undefined,
): Promise<boolean | undefined> {
  const path = settingsPath(configRoot, cwd, scope)
  if (enabled === undefined && !(await pathExists(path))) return enabled
  const root = await readJson(path)
  const values = isRecord(root.enabledPlugins) ? { ...root.enabledPlugins } : {}
  if (enabled === undefined) delete values[id]
  else values[id] = enabled
  if (Object.keys(values).length === 0) delete root.enabledPlugins
  else root.enabledPlugins = values
  await writeJson(path, root)
  return enabled
}

function validateMarketplacePlugin(
  value: unknown,
  index: number,
): ClaudeMarketplacePlugin {
  if (!isRecord(value))
    throw new Error(`Marketplace plugin ${index} must be an object`)
  const name = nonEmptyString(value.name, `Marketplace plugin ${index} name`)
  const source = value.source
  if (!(typeof source === 'string' || isRecord(source))) {
    throw new Error(
      `Marketplace plugin ${name} source must be a string or object`,
    )
  }
  return {
    ...value,
    name,
    source,
    ...(value.description === undefined
      ? {}
      : {
          description: nonEmptyString(
            value.description,
            'Marketplace plugin description',
          ),
        }),
    ...(value.version === undefined
      ? {}
      : {
          version: nonEmptyString(value.version, 'Marketplace plugin version'),
        }),
  }
}

export async function readClaudeMarketplaceManifest(
  directory: string,
): Promise<ClaudeMarketplaceManifest> {
  const path = join(await realpath(directory), MARKETPLACE_MANIFEST)
  const value: unknown = JSON.parse(await readFile(path, 'utf8'))
  if (!isRecord(value))
    throw new Error(`Marketplace manifest must be an object: ${path}`)
  const name = nonEmptyString(value.name, 'Marketplace name')
  if (!Array.isArray(value.plugins))
    throw new Error(`Marketplace plugins must be an array: ${path}`)
  return {
    name,
    ...(value.description === undefined
      ? {}
      : {
          description: nonEmptyString(
            value.description,
            'Marketplace description',
          ),
        }),
    ...(isRecord(value.owner) ? { owner: value.owner } : {}),
    ...(isRecord(value.metadata) ? { metadata: value.metadata } : {}),
    plugins: value.plugins.map(validateMarketplacePlugin),
  }
}

export async function validateClaudeMarketplace(
  directory: string,
  options: { strict?: boolean } = {},
): Promise<ClaudeMarketplaceManifest & { warnings?: readonly string[] }> {
  const manifest = await readClaudeMarketplaceManifest(directory)
  const warnings: string[] = []
  if (manifest.plugins.length === 0) {
    warnings.push('Marketplace has no plugins defined')
  }
  if (manifest.description === undefined) {
    warnings.push(
      'No marketplace description provided. Adding a description helps users understand what this marketplace offers',
    )
  }
  if (options.strict && warnings.length > 0) {
    throw new Error(
      `Marketplace validation failed (--strict treats warnings as errors): ${warnings.join('; ')}`,
    )
  }
  return {
    ...manifest,
    ...(warnings.length === 0 ? {} : { warnings }),
  }
}

export async function readClaudeKnownMarketplaces(
  configRoot: string,
): Promise<ClaudeKnownMarketplace[]> {
  const root = await readJson(knownPath(resolve(configRoot)))
  const result: ClaudeKnownMarketplace[] = []
  for (const [name, value] of Object.entries(root)) {
    if (!isRecord(value) || !isRecord(value.source)) continue
    const source = value.source
    if (
      source.source !== 'directory' &&
      source.source !== 'url' &&
      source.source !== 'git'
    )
      continue
    const installLocation = nonEmptyString(
      value.installLocation,
      `Marketplace ${name} installLocation`,
    )
    result.push({
      name,
      source: {
        source: source.source,
        ...(source.path === undefined
          ? {}
          : { path: nonEmptyString(source.path, 'Marketplace source path') }),
        ...(source.url === undefined
          ? {}
          : { url: nonEmptyString(source.url, 'Marketplace source URL') }),
        ...(source.sparsePaths === undefined
          ? {}
          : Array.isArray(source.sparsePaths)
            ? { sparsePaths: source.sparsePaths.map(sparsePath) }
            : (() => {
                throw new Error(
                  `Marketplace ${name} sparsePaths must be an array`,
                )
              })()),
      },
      installLocation,
      ...(value.lastUpdated === undefined
        ? {}
        : {
            lastUpdated: nonEmptyString(
              value.lastUpdated,
              'Marketplace lastUpdated',
            ),
          }),
    })
  }
  return result.sort((left, right) => left.name.localeCompare(right.name))
}

async function writeKnownMarketplaces(
  configRoot: string,
  marketplaces: readonly ClaudeKnownMarketplace[],
): Promise<void> {
  const root: Record<string, unknown> = {}
  for (const marketplace of marketplaces) {
    root[marketplace.name] = {
      source: marketplace.source,
      installLocation: marketplace.installLocation,
      ...(marketplace.lastUpdated === undefined
        ? {}
        : { lastUpdated: marketplace.lastUpdated }),
    }
  }
  await writeJson(knownPath(resolve(configRoot)), root)
}

function safeArchivePath(root: string, name: string): string {
  const normalized = name.replaceAll('\\', '/')
  if (!normalized || normalized.startsWith('/') || normalized.includes('\0')) {
    throw new Error(`Unsafe archive path: ${name}`)
  }
  const output = resolve(root, normalized)
  const relativePath = relative(resolve(root), output)
  if (
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    relativePath.includes('\0')
  ) {
    throw new Error(`Archive path escapes destination: ${name}`)
  }
  return output
}

async function findManifestRoot(
  destination: string,
  manifest: string,
): Promise<string> {
  const direct = join(destination, manifest)
  try {
    await stat(direct)
    return destination
  } catch {
    const entries = await readdir(destination, { withFileTypes: true })
    const candidates = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(destination, entry.name))
    for (const candidate of candidates) {
      try {
        await stat(join(candidate, manifest))
        return candidate
      } catch {
        // Continue searching one archive root deep.
      }
    }
  }
  throw new Error(`Archive does not contain ${manifest}`)
}

async function extractZip(
  buffer: Uint8Array,
  destination: string,
  manifest: string,
): Promise<string> {
  if (buffer.byteLength > MAX_ARCHIVE_BYTES)
    throw new Error('Plugin archive exceeds 64 MiB')
  const files = unzipSync(buffer)
  const names = Object.keys(files)
  if (names.length > MAX_ARCHIVE_FILES)
    throw new Error('Plugin archive contains too many files')
  let extractedBytes = 0
  for (const name of names) {
    const output = safeArchivePath(destination, name)
    const data = files[name]
    if (!data || name.endsWith('/')) {
      await mkdir(output, { recursive: true })
      continue
    }
    extractedBytes += data.byteLength
    if (extractedBytes > MAX_EXTRACTED_BYTES)
      throw new Error('Plugin archive expands beyond 256 MiB')
    await mkdir(dirname(output), { recursive: true })
    await writeFile(output, data, { flag: 'wx' })
  }
  return findManifestRoot(destination, manifest)
}

async function materializeSource(
  source: string,
  destinationRoot: string,
  manifest = PLUGIN_MANIFEST,
  sparsePaths: readonly string[] = [],
): Promise<{ path: string; source: ClaudeMarketplaceSource }> {
  const normalizedSparsePaths = sparsePaths.map(sparsePath)
  const resolved = resolve(source)
  try {
    const metadata = await stat(resolved)
    if (metadata.isDirectory()) {
      if (normalizedSparsePaths.length > 0) {
        throw new Error(
          '--sparse is only supported for git marketplace sources',
        )
      }
      return {
        path: await realpath(resolved),
        source: { source: 'directory', path: await realpath(resolved) },
      }
    }
    if (metadata.isFile() && extname(resolved).toLowerCase() === '.zip') {
      if (normalizedSparsePaths.length > 0) {
        throw new Error(
          '--sparse is only supported for git marketplace sources',
        )
      }
      return {
        path: await extractZip(
          new Uint8Array(await readFile(resolved)),
          destinationRoot,
          manifest,
        ),
        source: { source: 'directory', path: destinationRoot },
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const normalizedRemote = /^[^/\s]+\/[^/\s]+$/u.test(source)
    ? `https://github.com/${source}.git`
    : source
  if (!/^https:\/\//u.test(normalizedRemote))
    throw new Error(
      `Plugin source is not a directory, zip, or HTTPS URL: ${source}`,
    )
  const isGitRemote =
    (/^https:\/\/github\.com\//u.test(normalizedRemote) &&
      !/\.(?:zip|json)(?:[?#].*)?$/iu.test(normalizedRemote)) ||
    /\.git(?:[?#].*)?$/iu.test(normalizedRemote)
  if (isGitRemote) {
    await mkdir(destinationRoot, { recursive: true })
    const checkout = join(destinationRoot, 'checkout')
    const cloneArgs = ['clone', '--depth', '1']
    if (normalizedSparsePaths.length > 0) {
      cloneArgs.push('--filter=blob:none', '--sparse')
    }
    cloneArgs.push(normalizedRemote, checkout)
    await execFileAsync('git', cloneArgs, {
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
    })
    if (normalizedSparsePaths.length > 0) {
      await execFileAsync(
        'git',
        [
          '-C',
          checkout,
          'sparse-checkout',
          'set',
          '--',
          ...normalizedSparsePaths,
        ],
        { timeout: 120_000, maxBuffer: 2 * 1024 * 1024 },
      )
    }
    return {
      path: await findManifestRoot(checkout, manifest),
      source: {
        source: 'git',
        url: normalizedRemote,
        ...(normalizedSparsePaths.length === 0
          ? {}
          : { sparsePaths: normalizedSparsePaths }),
      },
    }
  }
  if (normalizedSparsePaths.length > 0) {
    throw new Error('--sparse is only supported for git marketplace sources')
  }
  const response = await fetch(normalizedRemote, {
    redirect: 'follow',
    signal: AbortSignal.timeout(120_000),
  })
  if (!response.ok)
    throw new Error(`Plugin download failed with HTTP ${response.status}`)
  const contentLength = response.headers.get('content-length')
  if (contentLength !== null && Number(contentLength) > MAX_ARCHIVE_BYTES)
    throw new Error('Plugin download exceeds 64 MiB')
  const chunks: Uint8Array[] = []
  let downloadedBytes = 0
  if (!response.body) throw new Error('Plugin download returned no body')
  for await (const chunk of response.body) {
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)
    downloadedBytes += bytes.byteLength
    if (downloadedBytes > MAX_ARCHIVE_BYTES)
      throw new Error('Plugin download exceeds 64 MiB')
    chunks.push(bytes)
  }
  const bytes = new Uint8Array(downloadedBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return {
    path: await extractZip(bytes, destinationRoot, manifest),
    source: { source: 'url', url: normalizedRemote },
  }
}

export async function addClaudeMarketplace(
  configRoot: string,
  cwd: string,
  sourceInput: string,
  scope: ClaudePluginScope = 'user',
  sparsePaths: readonly string[] = [],
): Promise<ClaudeKnownMarketplace> {
  const destination = join(
    resolve(configRoot),
    'plugins',
    'marketplaces',
    `${process.pid}-${Date.now()}`,
  )
  const sourcePath = resolve(sourceInput)
  let source: ClaudeMarketplaceSource
  let installLocation: string
  try {
    const metadata = await stat(sourcePath)
    if (!metadata.isDirectory())
      throw new Error('Marketplace source must be a directory')
    if (sparsePaths.length > 0) {
      throw new Error('--sparse is only supported for git marketplace sources')
    }
    installLocation = await realpath(sourcePath)
    source = { source: 'directory', path: installLocation }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const materialized = await materializeSource(
      sourceInput,
      destination,
      MARKETPLACE_MANIFEST,
      sparsePaths,
    )
    installLocation = materialized.path
    source = materialized.source
  }
  const manifest = await readClaudeMarketplaceManifest(installLocation)
  const marketplace: ClaudeKnownMarketplace = {
    name: manifest.name,
    source,
    installLocation,
    lastUpdated: new Date().toISOString(),
  }
  const existing = (await readClaudeKnownMarketplaces(configRoot)).filter(
    (item) => item.name !== marketplace.name,
  )
  await writeKnownMarketplaces(configRoot, [...existing, marketplace])
  await updateMarketplaceSettings(
    configRoot,
    cwd,
    scope,
    marketplace.name,
    source,
  )
  return marketplace
}

export async function updateClaudeMarketplace(
  configRoot: string,
  name?: string,
): Promise<ClaudeKnownMarketplace[]> {
  const current = await readClaudeKnownMarketplaces(configRoot)
  const selected =
    name === undefined ? current : current.filter((item) => item.name === name)
  if (name !== undefined && selected.length === 0)
    throw new Error(`Marketplace not configured: ${name}`)
  const updated: ClaudeKnownMarketplace[] = []
  for (const marketplace of selected) {
    if (marketplace.source.source === 'directory') {
      await readClaudeMarketplaceManifest(marketplace.installLocation)
      updated.push({ ...marketplace, lastUpdated: new Date().toISOString() })
      continue
    }
    const materialized = await materializeSource(
      marketplace.source.url ?? marketplace.installLocation,
      join(
        resolve(configRoot),
        'plugins',
        'marketplaces',
        `${process.pid}-${Date.now()}`,
      ),
      MARKETPLACE_MANIFEST,
      marketplace.source.sparsePaths,
    )
    const manifest = await readClaudeMarketplaceManifest(materialized.path)
    updated.push({
      ...marketplace,
      name: manifest.name,
      installLocation: materialized.path,
      lastUpdated: new Date().toISOString(),
    })
  }
  const selectedNames = new Set(selected.map((item) => item.name))
  await writeKnownMarketplaces(configRoot, [
    ...current.filter((item) => !selectedNames.has(item.name)),
    ...updated,
  ])
  return updated
}

export async function removeClaudeMarketplace(
  configRoot: string,
  cwd: string,
  name: string,
  scope?: ClaudePluginScope,
): Promise<void> {
  const current = await readClaudeKnownMarketplaces(configRoot)
  if (!current.some((item) => item.name === name))
    throw new Error(`Marketplace not configured: ${name}`)
  await writeKnownMarketplaces(
    configRoot,
    current.filter((item) => item.name !== name),
  )
  for (const candidate of scope
    ? [scope]
    : (['user', 'project', 'local'] as ClaudePluginScope[])) {
    const path = settingsPath(configRoot, cwd, candidate)
    if (!(await pathExists(path))) continue
    const root = await readJson(path)
    const marketplaces = isRecord(root.extraKnownMarketplaces)
      ? { ...root.extraKnownMarketplaces }
      : {}
    delete marketplaces[name]
    if (Object.keys(marketplaces).length === 0)
      delete root.extraKnownMarketplaces
    else root.extraKnownMarketplaces = marketplaces
    await writeJson(path, root)
  }
}

async function updateMarketplaceSettings(
  configRoot: string,
  cwd: string,
  scope: ClaudePluginScope,
  name: string,
  source: ClaudeMarketplaceSource,
): Promise<void> {
  const path = settingsPath(configRoot, cwd, scope)
  const root = await readJson(path)
  const marketplaces = isRecord(root.extraKnownMarketplaces)
    ? { ...root.extraKnownMarketplaces }
    : {}
  marketplaces[name] = { source }
  root.extraKnownMarketplaces = marketplaces
  await writeJson(path, root)
}

export async function resolveClaudeMarketplacePlugin(
  configRoot: string,
  id: string,
): Promise<{
  marketplace: ClaudeKnownMarketplace
  plugin: ClaudeMarketplacePlugin
}> {
  const separator = id.lastIndexOf('@')
  if (separator <= 0 || separator === id.length - 1)
    throw new Error('Marketplace plugin must use plugin@marketplace')
  const pluginName = id.slice(0, separator)
  const marketplaceName = id.slice(separator + 1)
  const marketplace = (await readClaudeKnownMarketplaces(configRoot)).find(
    (item) => item.name === marketplaceName,
  )
  if (!marketplace)
    throw new Error(`Marketplace not configured: ${marketplaceName}`)
  const manifest = await readClaudeMarketplaceManifest(
    marketplace.installLocation,
  )
  const plugin = manifest.plugins.find(
    (candidate) => candidate.name === pluginName,
  )
  if (!plugin) throw new Error(`Plugin not found in marketplace: ${id}`)
  return { marketplace, plugin }
}

async function readPluginIdentity(
  path: string,
): Promise<{ name: string; version: string }> {
  const manifestPath = join(await realpath(path), PLUGIN_MANIFEST)
  const value: unknown = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (!isRecord(value))
    throw new Error(`Plugin manifest must be an object: ${manifestPath}`)
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
  return {
    name: nonEmptyString(value.name, 'Plugin name'),
    version: nonEmptyString(value.version ?? '0.0.0', 'Plugin version'),
  }
}

type ClaudePluginConfigValue = string | number | boolean | string[]

function pluginConfigValue(
  value: string,
  definition: Record<string, unknown>,
  key: string,
): ClaudePluginConfigValue {
  const type = definition.type
  if (type === 'boolean') {
    if (value === 'true') return true
    return false
  }
  if (type === 'number') {
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) {
      throw new Error(
        `--config ${key}: ${JSON.stringify(value)} is not a number`,
      )
    }
    if (typeof definition.min === 'number' && parsed < definition.min) {
      throw new Error(`--config ${key} must be at least ${definition.min}`)
    }
    if (typeof definition.max === 'number' && parsed > definition.max) {
      throw new Error(`--config ${key} must be at most ${definition.max}`)
    }
    return parsed
  }
  if (type === 'string' || type === 'directory' || type === 'file') {
    if (definition.required === true && value.length === 0) {
      throw new Error(`--config ${key} is required`)
    }
    return definition.multiple === true
      ? value
          .split(',')
          .map((item) => item.trim())
          .filter((item) => item.length > 0)
      : value
  }
  throw new Error(`Plugin userConfig ${key} has unsupported type`)
}

export async function saveClaudePluginConfig(
  configRoot: string,
  cwd: string,
  scope: ClaudePluginScope,
  id: string,
  pluginPath: string,
  assignments: readonly string[],
): Promise<{ warnings: readonly string[] }> {
  if (assignments.length === 0) return { warnings: [] }
  const manifestPath = join(await realpath(pluginPath), PLUGIN_MANIFEST)
  const manifest: unknown = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (!isRecord(manifest) || !isRecord(manifest.userConfig)) {
    return {
      warnings: [`Plugin ${id} does not declare userConfig options`],
    }
  }
  const definitions = manifest.userConfig
  const values: Record<string, ClaudePluginConfigValue> = {}
  const warnings: string[] = []
  for (const assignment of assignments) {
    const separator = assignment.indexOf('=')
    if (separator <= 0) {
      warnings.push('--config must use key=value')
      continue
    }
    const key = assignment.slice(0, separator)
    const definition = definitions[key]
    if (!isRecord(definition)) {
      warnings.push(
        `--config key ${JSON.stringify(key)} isn't declared in this plugin's userConfig. Known keys: ${Object.keys(definitions).join(', ') || '(none)'}.`,
      )
      continue
    }
    try {
      values[key] = pluginConfigValue(
        assignment.slice(separator + 1),
        definition,
        key,
      )
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error))
    }
  }
  if (warnings.length > 0) return { warnings }
  const path = settingsPath(configRoot, cwd, scope)
  const root = await readJson(path)
  const pluginConfigs = isRecord(root.pluginConfigs)
    ? { ...root.pluginConfigs }
    : {}
  const current = isRecord(pluginConfigs[id]) ? { ...pluginConfigs[id] } : {}
  const options = isRecord(current.options) ? { ...current.options } : {}
  current.options = { ...options, ...values }
  pluginConfigs[id] = current
  root.pluginConfigs = pluginConfigs
  await writeJson(path, root)
  return { warnings: [] }
}

export async function listClaudeMarketplaceAvailablePlugins(
  configRoot: string,
  cwd: string,
): Promise<
  Array<{
    pluginId: string
    name: string
    description?: string
    marketplaceName: string
    version?: string
    source: string | Record<string, unknown>
  }>
> {
  const installed = new Set(
    (await readClaudeInstalledPlugins(configRoot, cwd)).map(
      (plugin) => plugin.id,
    ),
  )
  const available: Array<{
    pluginId: string
    name: string
    description?: string
    marketplaceName: string
    version?: string
    source: string | Record<string, unknown>
  }> = []
  for (const marketplace of await readClaudeKnownMarketplaces(configRoot)) {
    try {
      const manifest = await readClaudeMarketplaceManifest(
        marketplace.installLocation,
      )
      for (const plugin of manifest.plugins) {
        const pluginId = `${plugin.name}@${marketplace.name}`
        if (installed.has(pluginId)) continue
        available.push({
          pluginId,
          name: plugin.name,
          ...(plugin.description === undefined
            ? {}
            : { description: plugin.description }),
          marketplaceName: marketplace.name,
          ...(plugin.version === undefined ? {} : { version: plugin.version }),
          source: plugin.source,
        })
      }
    } catch {
      // Match Claude's list behavior: one unreadable marketplace does not hide others.
    }
  }
  return available.sort((left, right) =>
    left.pluginId.localeCompare(right.pluginId),
  )
}

function pluginSourcePath(
  marketplace: ClaudeKnownMarketplace,
  source: string | Record<string, unknown>,
): string {
  if (typeof source === 'string') {
    if (/^https:\/\//u.test(source)) return source
    const candidate = resolve(marketplace.installLocation, source)
    const root = resolve(marketplace.installLocation)
    if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
      throw new Error(
        `Marketplace plugin source escapes marketplace root: ${source}`,
      )
    }
    return candidate
  }
  const sourceType = source.source
  if (sourceType === 'directory' && typeof source.path === 'string') {
    return pluginSourcePath(marketplace, source.path)
  }
  if (sourceType === 'github' && typeof source.repo === 'string') {
    return source.repo
  }
  if (
    (sourceType === 'url' || sourceType === 'git') &&
    typeof source.url === 'string'
  ) {
    return source.url
  }
  throw new Error(
    'Marketplace plugin source must be a relative path or HTTPS URL',
  )
}

export async function installClaudeMarketplacePlugin(
  configRoot: string,
  cwd: string,
  id: string,
  scope: ClaudePluginScope = 'user',
): Promise<ClaudeInstalledPlugin> {
  const { marketplace, plugin } = await resolveClaudeMarketplacePlugin(
    configRoot,
    id,
  )
  const source = pluginSourcePath(marketplace, plugin.source)
  const materialized = await materializeClaudePluginSource(
    source,
    join(tmpdir(), `praxis-marketplace-plugin-${process.pid}-${Date.now()}`),
  )
  try {
    const identity = await readPluginIdentity(materialized.path)
    if (identity.name !== plugin.name) {
      throw new Error(
        `Plugin manifest name ${identity.name} does not match marketplace entry ${plugin.name}`,
      )
    }
    const version = plugin.version ?? identity.version
    const target = join(
      resolve(configRoot),
      'plugins',
      'cache',
      safePathSegment(marketplace.name, 'Marketplace name'),
      safePathSegment(identity.name, 'Plugin name'),
      safePathSegment(version, 'Plugin version'),
    )
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
    await mkdir(dirname(target), { recursive: true })
    await cp(materialized.path, temporary, {
      recursive: true,
      errorOnExist: true,
    })
    await replaceClaudePluginDirectory(temporary, target)
    const now = new Date().toISOString()
    const existing = (await readClaudeInstalledPlugins(configRoot, cwd)).find(
      (entry) => entry.id === id && entry.scope === scope,
    )
    const installed: ClaudeInstalledPlugin = {
      id,
      scope,
      ...(scope === 'user' ? {} : { projectPath: resolve(cwd) }),
      installPath: target,
      version,
      installedAt: existing?.installedAt ?? now,
      lastUpdated: now,
      enabled: true,
    }
    await writeClaudeInstalledPlugin(configRoot, installed)
    await setClaudePluginEnabledNative(configRoot, cwd, id, scope, true)
    return installed
  } finally {
    await materialized.cleanup()
  }
}

async function nativePluginTargets(
  configRoot: string,
  cwd: string,
): Promise<ClaudePluginTarget[]> {
  const [installed, skills] = await Promise.all([
    readClaudeInstalledPlugins(configRoot, cwd),
    readClaudeSkillsDirectoryPlugins(configRoot, cwd),
  ])
  return [...installed, ...skills]
}

function selectNativePluginTarget(
  targets: readonly ClaudePluginTarget[],
  id: string,
  requestedScope?: ClaudePluginScope,
): ClaudePluginTarget | undefined {
  const selected = targets.filter(
    (entry) =>
      entry.id === id &&
      (requestedScope === undefined || entry.scope === requestedScope),
  )
  if (requestedScope !== undefined) return selected[0]
  const priority: Record<ClaudePluginScope, number> = {
    local: 0,
    project: 1,
    user: 2,
  }
  return selected.sort(
    (left, right) => priority[left.scope] - priority[right.scope],
  )[0]
}

export async function setNativePluginEnabled(
  configRoot: string,
  cwd: string,
  id: string,
  enabled: boolean,
  requestedScope?: ClaudePluginScope,
): Promise<ClaudePluginTarget> {
  const target = selectNativePluginTarget(
    await nativePluginTargets(configRoot, cwd),
    id,
    requestedScope,
  )
  if (!target) throw new Error(`Plugin not installed: ${id}`)
  await setClaudePluginEnabledNative(configRoot, cwd, id, target.scope, enabled)
  return { ...target, enabled }
}

export async function disableAllNativePlugins(
  configRoot: string,
  cwd: string,
): Promise<ClaudePluginTarget[]> {
  const enabled = (await nativePluginTargets(configRoot, cwd)).filter(
    (plugin) => plugin.enabled,
  )
  await Promise.all(
    enabled.map(async (plugin) =>
      setClaudePluginEnabledNative(
        configRoot,
        cwd,
        plugin.id,
        plugin.scope,
        false,
      ),
    ),
  )
  return enabled.map((plugin) => ({ ...plugin, enabled: false }))
}

export async function updateNativePlugin(
  configRoot: string,
  cwd: string,
  id: string,
  requestedScope?: ClaudePluginScope,
): Promise<ClaudeInstalledPlugin> {
  const target = selectNativePluginTarget(
    await nativePluginTargets(configRoot, cwd),
    id,
    requestedScope,
  )
  if (!target) throw new Error(`Plugin not installed: ${id}`)
  if (!('installedAt' in target)) {
    throw new Error(
      `Plugin ${id} is loaded from ${join(resolve(configRoot), 'skills')} with no marketplace backing and cannot be updated`,
    )
  }
  const updated = await installClaudeMarketplacePlugin(
    configRoot,
    cwd,
    id,
    target.scope,
  )
  if (!target.enabled)
    await setClaudePluginEnabledNative(configRoot, cwd, id, target.scope, false)
  return { ...updated, enabled: target.enabled }
}

export async function uninstallNativePlugin(
  configRoot: string,
  cwd: string,
  id: string,
  requestedScope?: ClaudePluginScope,
  deleteData = true,
): Promise<ClaudeInstalledPlugin> {
  const target = selectNativePluginTarget(
    await nativePluginTargets(configRoot, cwd),
    id,
    requestedScope,
  )
  if (!target) throw new Error(`Plugin not installed: ${id}`)
  if (!('installedAt' in target)) {
    throw new Error(
      `Plugin ${id} is loaded from ${join(resolve(configRoot), 'skills')} with no marketplace backing and cannot be uninstalled`,
    )
  }
  return removeClaudeInstalledPlugin(
    configRoot,
    id,
    target.scope,
    cwd,
    deleteData,
  )
}

export async function listNativePluginRecords(
  configRoot: string,
  cwd: string,
): Promise<ClaudePluginRecord[]> {
  const installed = await nativePluginTargets(configRoot, cwd)
  return installed.map((entry) => ({
    name: entry.id,
    path: entry.installPath,
    source: entry.id,
    enabled: entry.enabled,
    version: entry.version,
    errors: [],
  }))
}

export async function materializeClaudePluginSource(
  source: string,
  destinationRoot = join(
    tmpdir(),
    `praxis-plugin-${process.pid}-${Date.now()}`,
  ),
): Promise<{ path: string; cleanup: () => Promise<void> }> {
  await mkdir(destinationRoot, { recursive: true })
  const materialized = await materializeSource(
    source,
    destinationRoot,
    PLUGIN_MANIFEST,
  )
  return {
    path: materialized.path,
    cleanup: async () => rm(destinationRoot, { recursive: true, force: true }),
  }
}

export function nativePluginRegistryPath(configRoot: string): string {
  return installedPath(resolve(configRoot))
}

export function nativeMarketplaceRegistryPath(configRoot: string): string {
  return knownPath(resolve(configRoot))
}
