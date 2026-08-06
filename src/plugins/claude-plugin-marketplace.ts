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
    ...(isRecord(value.owner) ? { owner: value.owner } : {}),
    ...(isRecord(value.metadata) ? { metadata: value.metadata } : {}),
    plugins: value.plugins.map(validateMarketplacePlugin),
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
): Promise<{ path: string; source: ClaudeMarketplaceSource }> {
  const resolved = resolve(source)
  try {
    const metadata = await stat(resolved)
    if (metadata.isDirectory()) {
      return {
        path: await realpath(resolved),
        source: { source: 'directory', path: await realpath(resolved) },
      }
    }
    if (metadata.isFile() && extname(resolved).toLowerCase() === '.zip') {
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
  if (
    /^https:\/\/github\.com\//u.test(normalizedRemote) &&
    !/\.(?:zip|json)(?:[?#].*)?$/iu.test(normalizedRemote)
  ) {
    await mkdir(destinationRoot, { recursive: true })
    const checkout = join(destinationRoot, 'checkout')
    await execFileAsync(
      'git',
      ['clone', '--depth', '1', normalizedRemote, checkout],
      { timeout: 120_000, maxBuffer: 2 * 1024 * 1024 },
    )
    return {
      path: await findManifestRoot(checkout, manifest),
      source: { source: 'git', url: normalizedRemote },
    }
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
    installLocation = await realpath(sourcePath)
    source = { source: 'directory', path: installLocation }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const materialized = await materializeSource(
      sourceInput,
      destination,
      MARKETPLACE_MANIFEST,
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
  cwd: string,
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
  return {
    name: nonEmptyString(value.name, 'Plugin name'),
    version: nonEmptyString(value.version ?? '0.0.0', 'Plugin version'),
  }
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

export async function setNativePluginEnabled(
  configRoot: string,
  cwd: string,
  id: string,
  enabled: boolean,
  requestedScope?: ClaudePluginScope,
): Promise<ClaudeInstalledPlugin> {
  const installed = await readClaudeInstalledPlugins(configRoot, cwd)
  const target = installed.find(
    (entry) =>
      entry.id === id &&
      (requestedScope === undefined || entry.scope === requestedScope),
  )
  if (!target) throw new Error(`Plugin not installed: ${id}`)
  await setClaudePluginEnabledNative(configRoot, cwd, id, target.scope, enabled)
  return { ...target, enabled }
}

export async function updateNativePlugin(
  configRoot: string,
  cwd: string,
  id: string,
  requestedScope?: ClaudePluginScope,
): Promise<ClaudeInstalledPlugin> {
  const installed = await readClaudeInstalledPlugins(configRoot, cwd)
  const target = installed.find(
    (entry) =>
      entry.id === id &&
      (requestedScope === undefined || entry.scope === requestedScope),
  )
  if (!target) throw new Error(`Plugin not installed: ${id}`)
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
): Promise<ClaudeInstalledPlugin> {
  const installed = await readClaudeInstalledPlugins(configRoot, cwd)
  const target = installed.find(
    (entry) =>
      entry.id === id &&
      (requestedScope === undefined || entry.scope === requestedScope),
  )
  if (!target) throw new Error(`Plugin not installed: ${id}`)
  return removeClaudeInstalledPlugin(configRoot, id, target.scope, cwd)
}

export async function listNativePluginRecords(
  configRoot: string,
  cwd: string,
): Promise<ClaudePluginRecord[]> {
  const installed = await readClaudeInstalledPlugins(configRoot, cwd)
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
