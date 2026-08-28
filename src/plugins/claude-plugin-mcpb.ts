import { createHash, randomUUID } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { closeSync, openSync, writeSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path'

import { Ajv, type ValidateFunction } from 'ajv'
import { Unzip, UnzipInflate } from 'fflate'

import manifestSchemaV01 from './mcpb-schemas/mcpb-manifest-v0.1.schema.json' with { type: 'json' }
import manifestSchemaV02 from './mcpb-schemas/mcpb-manifest-v0.2.schema.json' with { type: 'json' }
import manifestSchemaV03 from './mcpb-schemas/mcpb-manifest-v0.3.schema.json' with { type: 'json' }
import manifestSchemaV04 from './mcpb-schemas/mcpb-manifest-v0.4.schema.json' with { type: 'json' }

import {
  ExclusiveFileLease,
  type ExclusiveFileLeaseHandle,
} from '../platform/exclusive-file-lease.js'
import {
  resolveDataPlaneRoot,
  type DataPlane,
} from '../persistence/data-plane.js'

const DEFAULT_ARCHIVE_BYTES = 512 * 1024 * 1024
export const CLAUDE_PLUGIN_MCPB_ARCHIVE_BYTES = DEFAULT_ARCHIVE_BYTES
const DEFAULT_EXTRACTED_BYTES = 1024 * 1024 * 1024
const DEFAULT_FILE_BYTES = 512 * 1024 * 1024
const DEFAULT_FILES = 100_000
const MAX_COMPRESSION_RATIO = 50
const DEFAULT_TIMEOUT_MS = 120_000
const MANIFEST_FILE = 'manifest.json'
const addFormats = createRequire(import.meta.url)('ajv-formats') as (
  ajv: Ajv,
) => Ajv
const manifestAjv = addFormats(new Ajv({ allErrors: true }))
const manifestValidators: Readonly<Record<string, ValidateFunction>> = {
  '0.1': manifestAjv.compile(manifestSchemaV01),
  '0.2': manifestAjv.compile(manifestSchemaV02),
  '0.3': manifestAjv.compile(manifestSchemaV03),
  '0.4': manifestAjv.compile(manifestSchemaV04),
}

export type ClaudePluginMcpbUserValue =
  string | number | boolean | readonly string[]

export interface ClaudePluginMcpbManifest {
  manifest_version: string
  name: string
  version: string
  description: string
  author: { name: string; email?: string; url?: string }
  server: {
    type: 'node' | 'python' | 'binary' | 'uv'
    entry_point: string
    mcp_config: {
      command: string
      args?: readonly string[]
      env?: Readonly<Record<string, string>>
      platform_overrides?: Readonly<
        Record<
          string,
          {
            command?: string
            args?: readonly string[]
            env?: Readonly<Record<string, string>>
          }
        >
      >
    }
  }
  user_config?: Readonly<Record<string, ClaudePluginMcpbUserConfig>>
  [key: string]: unknown
}

export interface ClaudePluginMcpbUserConfig {
  type: 'string' | 'number' | 'boolean' | 'directory' | 'file'
  title: string
  description: string
  required?: boolean
  default?: ClaudePluginMcpbUserValue
  multiple?: boolean
  sensitive?: boolean
  min?: number
  max?: number
}

export interface ClaudePluginMcpbServerConfig {
  command: string
  args: readonly string[]
  env: Readonly<Record<string, string>>
}

export interface ClaudePluginMcpbLimits {
  archiveBytes?: number
  extractedBytes?: number
  files?: number
}

export interface LoadClaudePluginMcpbOptions {
  pluginRoot: string
  pluginData: string
  source: string
  configRoot?: string
  dataPlane?: DataPlane
  environment?: Readonly<Record<string, string | undefined>>
  userConfig?: Readonly<Record<string, ClaudePluginMcpbUserValue>>
  resolveUserConfig?: (
    manifest: ClaudePluginMcpbManifest,
  ) => Promise<Readonly<Record<string, ClaudePluginMcpbUserValue>>>
  signal?: AbortSignal
  timeoutMs?: number
  refresh?: boolean
  requireHttps?: boolean
  limits?: ClaudePluginMcpbLimits
  fetch?: typeof fetch
}

export interface LoadedClaudePluginMcpb {
  name: string
  config: ClaudePluginMcpbServerConfig
  manifest: ClaudePluginMcpbManifest
  sensitiveValues: readonly string[]
  extractedPath: string
}

interface CacheMetadata {
  source: string
  fingerprint: string
  etag?: string
  lastModified?: string
}

interface ArchiveEntry {
  name: string
  size: number
  compressedSize: number
  mode?: number
  directory: boolean
}

interface ResolvedMcpbSource {
  pluginRoot: string
  source: string
  remote: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safeRelativePath(value: string, label: string): string {
  const normalized = value.replaceAll('\\', '/')
  if (
    normalized.length === 0 ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//u.test(normalized) ||
    normalized.includes('\0') ||
    normalized.split('/').some((segment) => segment === '..')
  ) {
    throw new Error(`${label} must stay inside bundle root`)
  }
  const stripped = normalized.replace(/^\.\//u, '')
  const segments = stripped.endsWith('/')
    ? stripped.slice(0, -1).split('/')
    : stripped.split('/')
  if (
    stripped.length === 0 ||
    segments.some((segment) => segment.length === 0 || segment === '.')
  ) {
    throw new Error(`${label} must stay inside bundle root`)
  }
  return stripped
}

function isValueForType(
  value: unknown,
  definition: ClaudePluginMcpbUserConfig,
): value is ClaudePluginMcpbUserValue {
  if (Array.isArray(value)) {
    return (
      definition.type === 'string' &&
      definition.multiple === true &&
      value.every((item) => typeof item === 'string')
    )
  }
  if (definition.type === 'boolean') return typeof value === 'boolean'
  if (definition.type === 'number')
    return typeof value === 'number' && Number.isFinite(value)
  return typeof value === 'string'
}

async function validateManifest(
  value: unknown,
): Promise<ClaudePluginMcpbManifest> {
  const version = isRecord(value)
    ? typeof value.manifest_version === 'string'
      ? value.manifest_version
      : value.dxt_version
    : undefined
  const validate =
    typeof version === 'string' ? manifestValidators[version] : undefined
  if (!validate || !validate(value)) {
    const detail = validate?.errors
      ?.map((issue) => {
        if (
          issue.keyword === 'additionalProperties' &&
          typeof issue.params.additionalProperty === 'string'
        ) {
          return `Unrecognized key(s) in object: '${issue.params.additionalProperty}'`
        }
        const path = issue.instancePath.replace(/^\//u, '').replaceAll('/', '.')
        return `${path || 'manifest'}: ${issue.message ?? 'is invalid'}`
      })
      .join('; ')
    throw new Error(`Invalid MCPB manifest: ${detail}`)
  }
  const manifest = value as unknown as ClaudePluginMcpbManifest
  const manifestVersion = manifest.manifest_version ?? manifest.dxt_version
  return {
    ...manifest,
    manifest_version: manifestVersion,
  } as unknown as ClaudePluginMcpbManifest
}

function resolveUserConfig(
  manifest: ClaudePluginMcpbManifest,
  supplied: Readonly<Record<string, ClaudePluginMcpbUserValue>>,
): { values: Record<string, ClaudePluginMcpbUserValue>; sensitive: string[] } {
  const definitions = manifest.user_config ?? {}
  const unknown = Object.keys(supplied).find(
    (key) => definitions[key] === undefined,
  )
  if (unknown !== undefined)
    throw new Error(`Unknown MCPB user_config value: ${unknown}`)
  const values: Record<string, ClaudePluginMcpbUserValue> = {}
  const sensitive: string[] = []
  for (const [key, definition] of Object.entries(definitions)) {
    const rawSupplied = supplied[key]
    const suppliedValue =
      typeof rawSupplied === 'string' && definition.multiple === true
        ? rawSupplied
            .split(',')
            .map((item) => item.trim())
            .filter((item) => item.length > 0)
        : typeof rawSupplied === 'string' && definition.type === 'boolean'
          ? rawSupplied === 'true'
            ? true
            : rawSupplied === 'false'
              ? false
              : rawSupplied
          : typeof rawSupplied === 'string' && definition.type === 'number'
            ? rawSupplied.trim().length > 0 &&
              Number.isFinite(Number(rawSupplied))
              ? Number(rawSupplied)
              : rawSupplied
            : rawSupplied
    if (
      definition.required === true &&
      (suppliedValue === undefined ||
        suppliedValue === '' ||
        (Array.isArray(suppliedValue) &&
          (suppliedValue.length === 0 ||
            suppliedValue.some((item) => item === ''))))
    ) {
      throw new Error(`Required MCPB user_config is missing: ${key}`)
    }
    const value = suppliedValue ?? definition.default
    if (value === undefined) {
      continue
    }
    if (suppliedValue !== undefined && !isValueForType(value, definition))
      throw new Error(`MCPB user_config ${key} has invalid value type`)
    if (
      suppliedValue !== undefined &&
      typeof value === 'number' &&
      ((definition.min !== undefined && value < definition.min) ||
        (definition.max !== undefined && value > definition.max))
    ) {
      throw new Error(`MCPB user_config ${key} is outside its allowed range`)
    }
    values[key] = value
    if (definition.sensitive === true) {
      const rendered = Array.isArray(value)
        ? [...value, value.join(',')]
        : [String(value)]
      sensitive.push(...rendered.filter((item) => item.length > 0))
    }
  }
  return { values, sensitive }
}

function renderUserValue(value: ClaudePluginMcpbUserValue): string {
  return Array.isArray(value) ? value.join(',') : String(value)
}

function expandString(
  value: string,
  pluginRoot: string,
  extractedPath: string,
  data: string,
  environment: Readonly<Record<string, string | undefined>>,
  userConfig: Readonly<Record<string, ClaudePluginMcpbUserValue>>,
): string {
  return value.replace(/\$\{([^}]+)\}/gu, (placeholder, expression: string) => {
    if (
      expression === '__dirname' ||
      expression === 'MCPB_ROOT' ||
      expression === 'DXT_ROOT'
    )
      return extractedPath
    if (expression === 'CLAUDE_PLUGIN_ROOT') return pluginRoot
    if (expression === 'CLAUDE_PLUGIN_DATA') return data
    if (expression === 'pathSeparator' || expression === '/') return sep
    const home = homedir()
    const systemDirectory = {
      HOME: home,
      DESKTOP: join(home, 'Desktop'),
      DOCUMENTS: join(home, 'Documents'),
      DOWNLOADS: join(home, 'Downloads'),
    }[expression]
    if (systemDirectory !== undefined) return systemDirectory
    const userMatch =
      /^(?:user_config[.:])([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?$/u.exec(
        expression,
      )
    if (userMatch) {
      const configured = userConfig[userMatch[1] ?? '']
      if (configured !== undefined) {
        return Array.isArray(configured)
          ? placeholder
          : renderUserValue(configured)
      }
      if (userMatch[2] !== undefined) return userMatch[2]
      return ''
    }
    const envMatch =
      /^(?:env[.:])?([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?$/u.exec(expression)
    if (envMatch)
      return environment[envMatch[1] ?? ''] ?? envMatch[2] ?? placeholder
    return placeholder
  })
}

async function serverConfig(
  manifest: ClaudePluginMcpbManifest,
  pluginRoot: string,
  extractedPath: string,
  data: string,
  environment: Readonly<Record<string, string | undefined>>,
  userConfig: Readonly<Record<string, ClaudePluginMcpbUserValue>>,
): Promise<ClaudePluginMcpbServerConfig> {
  const baseConfig = manifest.server?.mcp_config
  if (baseConfig === undefined || typeof baseConfig.command !== 'string') {
    throw new Error('MCPB manifest did not produce an MCP server config')
  }
  const platformConfig = baseConfig.platform_overrides?.[process.platform]
  const generated = {
    command: platformConfig?.command || baseConfig.command,
    args: platformConfig?.args || baseConfig.args || [],
    env: platformConfig?.env || baseConfig.env || {},
  }
  const command = generated.command
  const args = Array.isArray(generated.args) ? generated.args : []
  const configuredEnvironment = isRecord(generated.env) ? generated.env : {}
  const expand = (value: string): string =>
    expandString(
      value,
      pluginRoot,
      extractedPath,
      data,
      environment,
      userConfig,
    )
  return {
    command: expand(command),
    args: args.flatMap((argument) => {
      if (typeof argument !== 'string') {
        throw new Error('MCPB generated args must contain strings')
      }
      const match = /^\$\{user_config\.([A-Za-z_][A-Za-z0-9_]*)\}$/u.exec(
        argument,
      )
      const value = match ? userConfig[match[1] ?? ''] : undefined
      return Array.isArray(value) ? [...value] : [expand(argument)]
    }),
    env: {
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      CLAUDE_PLUGIN_DATA: data,
      ...Object.fromEntries(
        Object.entries(configuredEnvironment).map(([key, value]) => {
          if (typeof value !== 'string') {
            throw new Error('MCPB generated env must contain strings')
          }
          return [key, expand(value)]
        }),
      ),
    },
  }
}

function uint16(bytes: Uint8Array, offset: number): number {
  return (bytes.at(offset) ?? 0) | ((bytes.at(offset + 1) ?? 0) << 8)
}

function uint32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes.at(offset) ?? 0) |
      ((bytes.at(offset + 1) ?? 0) << 8) |
      ((bytes.at(offset + 2) ?? 0) << 16) |
      ((bytes.at(offset + 3) ?? 0) << 24)) >>>
    0
  )
}

function archiveEntries(
  bytes: Uint8Array,
  limits: Required<ClaudePluginMcpbLimits>,
): ArchiveEntry[] {
  let eocd = -1
  for (
    let offset = bytes.length - 22;
    offset >= Math.max(0, bytes.length - 65_557);
    offset -= 1
  ) {
    if (uint32(bytes, offset) === 0x06054b50) {
      eocd = offset
      break
    }
  }
  if (eocd < 0) throw new Error('Invalid MCPB archive: end record not found')
  const count = uint16(bytes, eocd + 10)
  const centralOffset = uint32(bytes, eocd + 16)
  if (count === 0xffff || centralOffset === 0xffffffff)
    throw new Error('ZIP64 MCPB archives are not supported')
  if (count > limits.files)
    throw new Error(`MCPB archive exceeds ${limits.files} files`)
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const seen = new Set<string>()
  const result: ArchiveEntry[] = []
  let extractedBytes = 0
  let offset = centralOffset
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > bytes.length || uint32(bytes, offset) !== 0x02014b50)
      throw new Error('Invalid MCPB archive central directory')
    const flags = uint16(bytes, offset + 8)
    if ((flags & 1) !== 0)
      throw new Error('Encrypted MCPB archives are not supported')
    const compressedSize = uint32(bytes, offset + 20)
    const size = uint32(bytes, offset + 24)
    const nameLength = uint16(bytes, offset + 28)
    const extraLength = uint16(bytes, offset + 30)
    const commentLength = uint16(bytes, offset + 32)
    const attrs = uint32(bytes, offset + 38)
    const nameEnd = offset + 46 + nameLength
    if (nameEnd + extraLength + commentLength > bytes.length)
      throw new Error('Invalid MCPB archive entry')
    const rawName = decoder.decode(bytes.subarray(offset + 46, nameEnd))
    const name = safeRelativePath(rawName, 'MCPB archive path')
    if (seen.has(name))
      throw new Error(`MCPB archive has duplicate path: ${name}`)
    seen.add(name)
    const mode = (attrs >>> 16) & 0xffff
    if ((mode & 0o170000) === 0o120000)
      throw new Error(`MCPB archive contains symlink: ${name}`)
    const directory =
      rawName.replaceAll('\\', '/').endsWith('/') ||
      (mode & 0o170000) === 0o040000
    if (!directory) {
      if (size > DEFAULT_FILE_BYTES) {
        throw new Error(`MCPB archive file exceeds ${DEFAULT_FILE_BYTES} bytes`)
      }
      if (
        size > 0 &&
        (compressedSize === 0 || size / compressedSize > MAX_COMPRESSION_RATIO)
      ) {
        throw new Error(
          `MCPB archive compression ratio exceeds ${MAX_COMPRESSION_RATIO}`,
        )
      }
      extractedBytes += size
      if (extractedBytes > limits.extractedBytes)
        throw new Error(
          `MCPB archive exceeds ${limits.extractedBytes} extracted bytes`,
        )
    }
    result.push({
      name,
      size,
      compressedSize,
      ...(mode === 0 ? {} : { mode }),
      directory,
    })
    offset = nameEnd + extraLength + commentLength
  }
  return result
}

async function extractArchive(
  bytes: Uint8Array,
  destination: string,
  limits: Required<ClaudePluginMcpbLimits>,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted()
  const entries = archiveEntries(bytes, limits)
  const entryByName = new Map(entries.map((entry) => [entry.name, entry]))
  await mkdir(destination, { recursive: true })
  for (const entry of entries) {
    signal.throwIfAborted()
    const target = join(destination, entry.name)
    await mkdir(entry.directory ? target : dirname(target), {
      recursive: true,
      mode: 0o755,
    })
  }

  const openFiles = new Map<string, { descriptor: number; length: number }>()
  const completed = new Set<string>()
  let totalBytes = 0
  let extractionError: Error | undefined
  const unzip = new Unzip((file) => {
    let name: string
    let entry: ArchiveEntry | undefined
    try {
      name = safeRelativePath(file.name, 'MCPB archive path')
      entry = entryByName.get(name)
      if (entry === undefined)
        throw new Error(`Invalid MCPB archive entry: ${name}`)
    } catch (error) {
      extractionError =
        error instanceof Error ? error : new Error(String(error))
      file.terminate()
      return
    }

    file.ondata = (error, chunk, final) => {
      try {
        if (extractionError !== undefined) {
          file.terminate()
          return
        }
        signal.throwIfAborted()
        if (error !== null) throw error
        if (entry.directory) {
          if (chunk.byteLength !== 0)
            throw new Error(`Invalid MCPB archive directory: ${name}`)
          if (final) completed.add(name)
          return
        }

        let state = openFiles.get(name)
        if (state === undefined) {
          state = {
            descriptor: openSync(join(destination, name), 'wx', 0o600),
            length: 0,
          }
          openFiles.set(name, state)
        }
        const nextLength = state.length + chunk.byteLength
        const ratioLimit = entry.compressedSize * MAX_COMPRESSION_RATIO
        if (
          nextLength > entry.size ||
          (nextLength > 0 &&
            (entry.compressedSize === 0 || nextLength > ratioLimit)) ||
          totalBytes + chunk.byteLength > limits.extractedBytes
        ) {
          throw new Error(
            `MCPB archive exceeds ${limits.extractedBytes} extracted bytes or compression ratio ${MAX_COMPRESSION_RATIO}`,
          )
        }
        let written = 0
        while (written < chunk.byteLength) {
          const count = writeSync(
            state.descriptor,
            chunk,
            written,
            chunk.byteLength - written,
            state.length + written,
          )
          if (count === 0)
            throw new Error(`Unable to write MCPB archive content: ${name}`)
          written += count
        }
        state.length = nextLength
        totalBytes += chunk.byteLength
        if (!final) return
        if (state.length !== entry.size)
          throw new Error(`Invalid MCPB archive content: ${name}`)
        closeSync(state.descriptor)
        openFiles.delete(name)
        completed.add(name)
      } catch (caught) {
        extractionError =
          caught instanceof Error ? caught : new Error(String(caught))
        file.terminate()
      }
    }
    file.start()
  })
  unzip.register(UnzipInflate)
  try {
    for (let offset = 0; offset < bytes.byteLength; offset += 4 * 1024) {
      signal.throwIfAborted()
      unzip.push(
        bytes.subarray(offset, Math.min(offset + 4 * 1024, bytes.byteLength)),
        offset + 4 * 1024 >= bytes.byteLength,
      )
      if (extractionError !== undefined) throw extractionError
    }
    if (extractionError !== undefined) throw extractionError
  } finally {
    for (const { descriptor } of openFiles.values()) {
      try {
        closeSync(descriptor)
      } catch {
        /* preserve extraction failure */
      }
    }
  }
  for (const entry of entries) {
    signal.throwIfAborted()
    if (!completed.has(entry.name))
      throw new Error(`Invalid MCPB archive content: ${entry.name}`)
    if (entry.directory) continue
    const target = join(destination, entry.name)
    await chmod(
      target,
      entry.mode === undefined
        ? 0o644
        : (entry.mode & 0o111) === 0
          ? 0o644
          : 0o755,
    )
  }
  signal.throwIfAborted()
}

function safeSourceLabel(source: string): string {
  try {
    const url = new URL(source)
    return `${url.origin}${url.pathname}`
  } catch {
    return basename(source)
  }
}

function redactedErrorMessage(
  error: unknown,
  source: string,
  userConfig: Readonly<Record<string, ClaudePluginMcpbUserValue>>,
): string {
  let message = error instanceof Error ? error.message : String(error)
  message = message.replaceAll(source, safeSourceLabel(source))
  for (const value of Object.values(userConfig)) {
    const rendered = Array.isArray(value)
      ? [...value, renderUserValue(value)]
      : [renderUserValue(value)]
    for (const candidate of rendered) {
      if (candidate.length >= 3)
        message = message.replaceAll(candidate, '[REDACTED]')
    }
  }
  return message
}

function mcpbLoadError(
  error: unknown,
  source: string,
  userConfig: Readonly<Record<string, ClaudePluginMcpbUserValue>>,
): Error {
  return new Error(
    `Unable to load MCPB bundle ${safeSourceLabel(source)}: ${redactedErrorMessage(error, source, userConfig)}`,
  )
}

async function configuredUserValues(
  options: LoadClaudePluginMcpbOptions,
  manifest: ClaudePluginMcpbManifest,
): Promise<Readonly<Record<string, ClaudePluginMcpbUserValue>>> {
  const resolved = await options.resolveUserConfig?.(manifest)
  return { ...(options.userConfig ?? {}), ...(resolved ?? {}) }
}

function hash(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function isWellFormedLease(value: unknown): boolean {
  if (!isRecord(value)) return false
  return (
    value.version === 1 &&
    Number.isSafeInteger(value.pid) &&
    Number(value.pid) > 0 &&
    typeof value.token === 'string' &&
    /^[A-Za-z0-9_-]{1,128}$/u.test(value.token) &&
    typeof value.createdAt === 'string'
  )
}

async function readCached(
  entry: string,
  source: string,
  cacheRoot: string,
): Promise<
  { metadata: CacheMetadata; manifest: ClaudePluginMcpbManifest } | undefined
> {
  try {
    const entryStat = await lstat(entry)
    if (!entryStat.isDirectory() || entryStat.isSymbolicLink()) return undefined
    const canonicalEntry = await realpath(entry)
    if (!pathIsWithin(cacheRoot, canonicalEntry, false)) return undefined
    const extracted = join(entry, 'extracted')
    const extractedStat = await lstat(extracted)
    if (!extractedStat.isDirectory() || extractedStat.isSymbolicLink())
      return undefined
    const canonicalExtracted = await realpath(extracted)
    if (!pathIsWithin(canonicalEntry, canonicalExtracted, false))
      return undefined
    const metadataPath = join(entry, 'metadata.json')
    const metadataStat = await lstat(metadataPath)
    if (!metadataStat.isFile() || metadataStat.isSymbolicLink())
      return undefined
    if (!pathIsWithin(canonicalEntry, await realpath(metadataPath), false))
      return undefined
    const manifestPath = join(extracted, MANIFEST_FILE)
    const manifestStat = await lstat(manifestPath)
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink())
      return undefined
    if (!pathIsWithin(canonicalExtracted, await realpath(manifestPath), false))
      return undefined
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as unknown
    if (
      !isRecord(metadata) ||
      metadata.source !== source ||
      typeof metadata.fingerprint !== 'string'
    )
      return undefined
    const manifest = await validateManifest(
      JSON.parse(await readFile(manifestPath, 'utf8')),
    )
    return { metadata: metadata as unknown as CacheMetadata, manifest }
  } catch {
    return undefined
  }
}

function pathIsWithin(
  root: string,
  candidate: string,
  allowSame: boolean,
): boolean {
  const rel = relative(root, candidate)
  return (
    (allowSame || rel.length > 0) &&
    rel !== '..' &&
    !rel.startsWith('../') &&
    !isAbsolute(rel)
  )
}

async function fetchArchive(
  source: string,
  cached: CacheMetadata | undefined,
  options: LoadClaudePluginMcpbOptions,
  signal: AbortSignal,
  archiveLimit: number,
): Promise<{ bytes?: Uint8Array; etag?: string; lastModified?: string }> {
  const headers: Record<string, string> = {}
  if (!options.refresh && cached?.etag) headers['if-none-match'] = cached.etag
  if (!options.refresh && cached?.lastModified)
    headers['if-modified-since'] = cached.lastModified
  let response: Response
  try {
    let requestUrl = source
    let redirects = 0
    for (;;) {
      response = await (options.fetch ?? fetch)(requestUrl, {
        redirect: 'manual',
        headers,
        signal,
      })
      if (![301, 302, 303, 307, 308].includes(response.status)) break
      const location = response.headers.get('location')
      if (location === null) {
        await response.body?.cancel()
        throw new Error('MCPB download redirect is missing Location')
      }
      const redirected = new URL(location, requestUrl)
      if (
        (options.requireHttps && redirected.protocol !== 'https:') ||
        (!options.requireHttps &&
          redirected.protocol !== 'http:' &&
          redirected.protocol !== 'https:')
      ) {
        await response.body?.cancel()
        throw new Error(
          options.requireHttps
            ? 'MCPB download redirect must use HTTPS'
            : 'MCPB download redirect must use HTTP or HTTPS',
        )
      }
      await response.body?.cancel()
      if (++redirects > 5) {
        throw new Error('MCPB download exceeded 5 redirects')
      }
      requestUrl = redirected.href
    }
  } catch (error) {
    throw new Error(
      `MCPB download failed: ${safeSourceLabel(source)}: ${redactedErrorMessage(error, source, {})}`,
    )
  }
  if (response.status === 304) return {}
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(
      `MCPB download failed with HTTP ${response.status}: ${safeSourceLabel(source)}`,
    )
  }
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > archiveLimit) {
    await response.body?.cancel()
    throw new Error(`MCPB download exceeds ${archiveLimit} bytes`)
  }
  if (!response.body) throw new Error('MCPB download returned no body')
  const chunks: Uint8Array[] = []
  let length = 0
  for await (const raw of response.body) {
    signal.throwIfAborted()
    const chunk = raw instanceof Uint8Array ? raw : new Uint8Array(raw)
    length += chunk.byteLength
    if (length > archiveLimit)
      throw new Error(`MCPB download exceeds ${archiveLimit} bytes`)
    chunks.push(chunk)
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  const responseEtag = response.headers.get('etag')
  const responseLastModified = response.headers.get('last-modified')
  return {
    bytes,
    ...(responseEtag === null ? {} : { etag: responseEtag }),
    ...(responseLastModified === null
      ? {}
      : { lastModified: responseLastModified }),
  }
}

async function replaceCache(staging: string, target: string): Promise<void> {
  const backup = `${target}.${process.pid}.${randomUUID()}.bak`
  let backedUp = false
  try {
    try {
      await rename(target, backup)
      backedUp = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await rename(staging, target)
    if (backedUp) await rm(backup, { recursive: true, force: true })
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    if (backedUp) {
      try {
        await rename(backup, target)
      } catch {
        /* preserve original failure */
      }
    }
    throw error
  }
}

async function resolveMcpbSource(
  options: LoadClaudePluginMcpbOptions,
  signal: AbortSignal,
): Promise<ResolvedMcpbSource> {
  signal.throwIfAborted()
  const pluginRoot = await realpath(resolve(options.pluginRoot))
  signal.throwIfAborted()
  const remote = /^https?:\/\//u.test(options.source)
  if (options.requireHttps && remote && !/^https:\/\//u.test(options.source)) {
    throw new Error('MCPB download source must use HTTPS')
  }
  if (!remote && /^[a-z][a-z0-9+.-]*:\/\//iu.test(options.source))
    throw new Error('MCPB source URL must use HTTP or HTTPS')
  if (
    !['.mcpb', '.dxt'].some((extension) => options.source.endsWith(extension))
  ) {
    throw new Error('MCPB source must end in .mcpb or .dxt')
  }
  if (remote) return { pluginRoot, source: options.source, remote: true }

  const requestedSource = resolve(pluginRoot, options.source)
  const requestedRelative = relative(pluginRoot, requestedSource)
  if (
    requestedRelative === '..' ||
    requestedRelative.startsWith('../') ||
    isAbsolute(requestedRelative)
  )
    throw new Error('Local MCPB source escapes plugin root')
  const source = await realpath(requestedSource)
  signal.throwIfAborted()
  const canonicalRelative = relative(pluginRoot, source)
  if (
    canonicalRelative === '..' ||
    canonicalRelative.startsWith('../') ||
    isAbsolute(canonicalRelative)
  )
    throw new Error('Local MCPB source escapes plugin root')
  return { pluginRoot, source, remote: false }
}

async function cacheEntryIsRealDirectory(cacheEntry: string): Promise<boolean> {
  try {
    const entryStat = await lstat(cacheEntry)
    return entryStat.isDirectory() && !entryStat.isSymbolicLink()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function canonicalCacheRoot(
  pluginRoot: string,
  signal: AbortSignal,
): Promise<string> {
  const requested = join(pluginRoot, '.mcpb-cache')
  await mkdir(requested, { recursive: true })
  signal.throwIfAborted()
  const requestedStat = await lstat(requested)
  if (!requestedStat.isDirectory() || requestedStat.isSymbolicLink())
    throw new Error('MCPB cache root must be a real directory')
  const canonical = await realpath(requested)
  const rel = relative(pluginRoot, canonical)
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel))
    throw new Error('MCPB cache root escapes plugin root')
  signal.throwIfAborted()
  return canonical
}

async function cleanupCacheArtifacts(
  cacheRoot: string,
  cacheEntry: string,
  cacheSource: string,
): Promise<void> {
  await mkdir(cacheRoot, { recursive: true })
  const cacheName = basename(cacheEntry)
  const stagingPrefix = `.${cacheName}.`
  const backupPattern = new RegExp(
    `^${cacheName}\\.[0-9]+\\.[A-Za-z0-9-]+\\.bak$`,
    'u',
  )
  const entries = await readdir(cacheRoot, { withFileTypes: true })
  const backups: Array<{ path: string; modified: number }> = []
  for (const entry of entries) {
    const artifact = join(cacheRoot, entry.name)
    if (entry.name.startsWith(stagingPrefix) && entry.name.includes('.tmp-')) {
      await rm(artifact, { recursive: true, force: true })
      continue
    }
    if (!backupPattern.test(entry.name)) continue
    let artifactStat
    try {
      artifactStat = await lstat(artifact)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    if (!artifactStat.isDirectory()) {
      await rm(artifact, { recursive: true, force: true })
      continue
    }
    backups.push({ path: artifact, modified: artifactStat.mtimeMs })
  }
  if (backups.length === 0) return
  backups.sort((left, right) => right.modified - left.modified)
  if (!(await cacheEntryIsRealDirectory(cacheEntry))) {
    await rm(cacheEntry, { recursive: true, force: true })
    for (let index = 0; index < backups.length; index += 1) {
      const candidate = backups[index]
      if (
        candidate === undefined ||
        (await readCached(candidate.path, cacheSource, cacheRoot)) === undefined
      )
        continue
      await rename(candidate.path, cacheEntry)
      backups.splice(index, 1)
      break
    }
  }
  await Promise.all(
    backups.map((backup) => rm(backup.path, { recursive: true, force: true })),
  )
}

async function waitForLeaseRetry(signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolveWait, rejectWait) => {
    const timer = setTimeout(finish, 10)
    const abort = (): void => finish(signal.reason)
    function finish(reason?: unknown): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      if (reason === undefined) resolveWait()
      else rejectWait(reason)
    }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}

async function cacheLockIsWellFormed(lockFile: string): Promise<boolean> {
  try {
    const lockStat = await lstat(lockFile)
    if (!lockStat.isFile() || lockStat.size > 4 * 1024) return false
    return isWellFormedLease(JSON.parse(await readFile(lockFile, 'utf8')))
  } catch (error) {
    if (error instanceof SyntaxError) return false
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function waitForCacheLease(
  cacheEntry: string,
  recoveryLockFile: string,
  signal: AbortSignal,
): Promise<ExclusiveFileLeaseHandle> {
  const lockFile = `${cacheEntry}.lock`
  const lease = new ExclusiveFileLease(lockFile)
  const recoveryLease = new ExclusiveFileLease(recoveryLockFile)
  for (;;) {
    signal.throwIfAborted()
    const recovery = await recoveryLease.tryAcquire()
    if (recovery === null) {
      await waitForLeaseRetry(signal)
      continue
    }
    try {
      if (!(await cacheLockIsWellFormed(lockFile))) {
        await rm(lockFile, { recursive: true, force: true })
      }
      const acquired = await lease.tryAcquire()
      if (acquired !== null) return acquired
    } finally {
      await recovery.release()
    }
    await waitForLeaseRetry(signal)
  }
}

/**
 * Loads one MCPB/DXT server referenced by a plugin manifest.
 *
 * Local sources must resolve inside `pluginRoot`; URL caches remain sticky
 * until `refresh` is set. A missing required user_config value rejects with
 * `Required MCPB user_config is missing: <key>` so callers can isolate only
 * that server. Valid cache entries persist across calls and failed refreshes.
 */
async function loadClaudePluginMcpbUnlocked(
  options: LoadClaudePluginMcpbOptions,
  resolvedSource: ResolvedMcpbSource,
  cacheRoot: string,
  signal: AbortSignal,
): Promise<LoadedClaudePluginMcpb> {
  const { pluginRoot, source, remote } = resolvedSource
  const pluginData = resolve(options.pluginData)
  const limits: Required<ClaudePluginMcpbLimits> = {
    archiveBytes: options.limits?.archiveBytes ?? DEFAULT_ARCHIVE_BYTES,
    extractedBytes: options.limits?.extractedBytes ?? DEFAULT_EXTRACTED_BYTES,
    files: options.limits?.files ?? DEFAULT_FILES,
  }
  signal.throwIfAborted()
  const cacheEntry = join(cacheRoot, hash(source))
  const cacheSource = remote ? `url:${hash(source)}` : source
  const cached = await readCached(cacheEntry, cacheSource, cacheRoot)
  let effectiveUserConfig = options.userConfig ?? {}
  let bytes: Uint8Array | undefined
  let fingerprint: string | undefined
  let etag: string | undefined
  let lastModified: string | undefined
  if (remote) {
    if (cached === undefined || options.refresh === true) {
      const downloaded = await fetchArchive(
        source,
        options.refresh === true ? cached?.metadata : undefined,
        options,
        signal,
        limits.archiveBytes,
      )
      bytes = downloaded.bytes
      etag = downloaded.etag ?? cached?.metadata.etag
      lastModified = downloaded.lastModified ?? cached?.metadata.lastModified
    }
    fingerprint =
      bytes === undefined ? cached?.metadata.fingerprint : hash(bytes)
  } else {
    const sourceStat = await stat(source, { bigint: true })
    fingerprint = `${sourceStat.size}:${sourceStat.mtimeNs}`
    if (
      options.refresh ||
      cached === undefined ||
      cached.metadata.fingerprint !== fingerprint
    ) {
      const local = await readFile(source)
      if (local.byteLength > limits.archiveBytes)
        throw new Error(`MCPB archive exceeds ${limits.archiveBytes} bytes`)
      bytes = local
    }
  }
  if (bytes === undefined && cached !== undefined) {
    try {
      effectiveUserConfig = await configuredUserValues(options, cached.manifest)
      const resolved = resolveUserConfig(cached.manifest, effectiveUserConfig)
      return {
        name: cached.manifest.name,
        config: await serverConfig(
          cached.manifest,
          pluginRoot,
          join(cacheEntry, 'extracted'),
          pluginData,
          options.environment ?? process.env,
          resolved.values,
        ),
        manifest: cached.manifest,
        sensitiveValues: resolved.sensitive,
        extractedPath: join(cacheEntry, 'extracted'),
      }
    } catch (error) {
      throw mcpbLoadError(error, source, effectiveUserConfig)
    }
  }
  if (bytes === undefined || fingerprint === undefined)
    throw new Error('MCPB cache could not be refreshed')
  let staging: string | undefined
  try {
    await mkdir(cacheRoot, { recursive: true })
    staging = await mkdtemp(
      join(cacheRoot, `.${hash(source)}.${process.pid}.tmp-`),
    )
    await writeFile(join(staging, 'bundle.mcpb'), bytes, {
      flag: 'wx',
      mode: 0o600,
    })
    await extractArchive(bytes, join(staging, 'extracted'), limits, signal)
    const manifest = await validateManifest(
      JSON.parse(
        await readFile(join(staging, 'extracted', MANIFEST_FILE), 'utf8'),
      ),
    )
    const metadata: CacheMetadata = {
      source: cacheSource,
      fingerprint,
      ...(etag === undefined ? {} : { etag }),
      ...(lastModified === undefined ? {} : { lastModified }),
    }
    await writeFile(
      join(staging, 'metadata.json'),
      `${JSON.stringify(metadata, null, 2)}\n`,
      { flag: 'wx', mode: 0o600 },
    )
    await replaceCache(staging, cacheEntry)
    effectiveUserConfig = await configuredUserValues(options, manifest)
    const resolved = resolveUserConfig(manifest, effectiveUserConfig)
    return {
      name: manifest.name,
      config: await serverConfig(
        manifest,
        pluginRoot,
        join(cacheEntry, 'extracted'),
        pluginData,
        options.environment ?? process.env,
        resolved.values,
      ),
      manifest,
      sensitiveValues: resolved.sensitive,
      extractedPath: join(cacheEntry, 'extracted'),
    }
  } catch (error) {
    if (staging !== undefined)
      await rm(staging, { recursive: true, force: true })
    throw mcpbLoadError(error, source, effectiveUserConfig)
  }
}

export async function loadClaudePluginMcpb(
  options: LoadClaudePluginMcpbOptions,
): Promise<LoadedClaudePluginMcpb> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const signal =
    options.signal === undefined
      ? timeout
      : AbortSignal.any([options.signal, timeout])
  const resolvedSource = await resolveMcpbSource(options, signal)
  const cacheRoot = await canonicalCacheRoot(resolvedSource.pluginRoot, signal)
  const cacheEntry = join(cacheRoot, hash(resolvedSource.source))
  const cacheSource = resolvedSource.remote
    ? `url:${hash(resolvedSource.source)}`
    : resolvedSource.source
  const configRoot = resolve(options.configRoot ?? resolveDataPlaneRoot())
  const recoveryLockFile = join(
    configRoot,
    'state',
    'locks',
    'mcpb',
    `${hash(cacheEntry)}.lock`,
  )
  const lease = await waitForCacheLease(cacheEntry, recoveryLockFile, signal)
  try {
    signal.throwIfAborted()
    await cleanupCacheArtifacts(cacheRoot, cacheEntry, cacheSource)
    signal.throwIfAborted()
    return await loadClaudePluginMcpbUnlocked(
      options,
      resolvedSource,
      cacheRoot,
      signal,
    )
  } finally {
    await lease.release()
  }
}
