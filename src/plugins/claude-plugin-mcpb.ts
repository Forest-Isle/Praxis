import { createHash, randomUUID } from 'node:crypto'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
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

import { Unzip, UnzipInflate } from 'fflate'

const DEFAULT_ARCHIVE_BYTES = 512 * 1024 * 1024
const DEFAULT_EXTRACTED_BYTES = 1024 * 1024 * 1024
const DEFAULT_FILE_BYTES = 512 * 1024 * 1024
const DEFAULT_FILES = 100_000
const MAX_COMPRESSION_RATIO = 50
const DEFAULT_TIMEOUT_MS = 120_000
const MANIFEST_FILE = 'manifest.json'

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
  environment?: Readonly<Record<string, string | undefined>>
  userConfig?: Readonly<Record<string, ClaudePluginMcpbUserValue>>
  resolveUserConfig?: (
    manifest: ClaudePluginMcpbManifest,
  ) => Promise<Readonly<Record<string, ClaudePluginMcpbUserValue>>>
  signal?: AbortSignal
  timeoutMs?: number
  refresh?: boolean
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
  mode?: number
  directory: boolean
}

const mcpbLoadTails = new Map<string, Promise<void>>()

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
  const { vAny } = await import('@anthropic-ai/mcpb/schemas')
  const parsed = vAny.McpbManifestSchema.safeParse(value)
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'manifest'}: ${issue.message}`)
      .join('; ')
    throw new Error(`Invalid MCPB manifest: ${detail}`)
  }
  const manifest = parsed.data
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
  const { getMcpConfigForManifest } = await import('@anthropic-ai/mcpb')
  const home = homedir()
  const generated = await getMcpConfigForManifest({
    manifest: manifest as never,
    extensionPath: extractedPath,
    systemDirs: {
      HOME: home,
      DESKTOP: join(home, 'Desktop'),
      DOCUMENTS: join(home, 'Documents'),
      DOWNLOADS: join(home, 'Downloads'),
    },
    userConfig: userConfig as never,
    pathSeparator: sep,
  })
  if (generated === undefined || typeof generated.command !== 'string') {
    throw new Error('MCPB manifest did not produce an MCP server config')
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
  const files = new Map<string, Uint8Array>()
  let totalBytes = 0
  let extractionError: Error | undefined
  const unzip = new Unzip((file) => {
    const name = file.name.replaceAll('\\', '/')
    const entry = entryByName.get(name)
    if (entry === undefined || entry.directory) {
      file.ondata = (error) => {
        if (error !== null) extractionError = error
      }
      file.start()
      return
    }
    const chunks: Uint8Array[] = []
    let length = 0
    file.ondata = (error, chunk, final) => {
      if (extractionError !== undefined) return
      if (error !== null) {
        extractionError = error
        return
      }
      length += chunk.byteLength
      totalBytes += chunk.byteLength
      if (length > entry.size || totalBytes > limits.extractedBytes) {
        extractionError = new Error(
          `MCPB archive exceeds ${limits.extractedBytes} extracted bytes`,
        )
        file.terminate()
        return
      }
      chunks.push(chunk)
      if (!final) return
      if (length !== entry.size) {
        extractionError = new Error(`Invalid MCPB archive content: ${name}`)
        return
      }
      const content = new Uint8Array(length)
      let offset = 0
      for (const part of chunks) {
        content.set(part, offset)
        offset += part.byteLength
      }
      files.set(name, content)
    }
    file.start()
  })
  unzip.register(UnzipInflate)
  for (let offset = 0; offset < bytes.byteLength; offset += 4 * 1024) {
    signal.throwIfAborted()
    unzip.push(
      bytes.subarray(offset, Math.min(offset + 4 * 1024, bytes.byteLength)),
      offset + 4 * 1024 >= bytes.byteLength,
    )
    if (extractionError !== undefined) throw extractionError
  }
  if (extractionError !== undefined) throw extractionError
  await mkdir(destination, { recursive: true })
  for (const entry of entries) {
    signal.throwIfAborted()
    const target = join(destination, entry.name)
    if (entry.directory) {
      await mkdir(target, { recursive: true, mode: 0o755 })
      continue
    }
    const content = files.get(entry.name)
    if (content === undefined || content.byteLength !== entry.size)
      throw new Error(`Invalid MCPB archive content: ${entry.name}`)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content, { flag: 'wx', mode: 0o600 })
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

async function readCached(
  entry: string,
  source: string,
): Promise<
  { metadata: CacheMetadata; manifest: ClaudePluginMcpbManifest } | undefined
> {
  try {
    const metadata = JSON.parse(
      await readFile(join(entry, 'metadata.json'), 'utf8'),
    ) as unknown
    if (
      !isRecord(metadata) ||
      metadata.source !== source ||
      typeof metadata.fingerprint !== 'string'
    )
      return undefined
    const manifest = await validateManifest(
      JSON.parse(
        await readFile(join(entry, 'extracted', MANIFEST_FILE), 'utf8'),
      ),
    )
    return { metadata: metadata as unknown as CacheMetadata, manifest }
  } catch {
    return undefined
  }
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
      if (redirected.protocol !== 'http:' && redirected.protocol !== 'https:') {
        await response.body?.cancel()
        throw new Error('MCPB download redirect must use HTTP or HTTPS')
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
): Promise<LoadedClaudePluginMcpb> {
  const requestedPluginRoot = resolve(options.pluginRoot)
  const pluginRoot = await realpath(requestedPluginRoot)
  const pluginData = resolve(options.pluginData)
  const remote = /^https?:\/\//u.test(options.source)
  if (!remote && /^[a-z][a-z0-9+.-]*:\/\//iu.test(options.source))
    throw new Error('MCPB source URL must use HTTP or HTTPS')
  if (
    !['.mcpb', '.dxt'].some((extension) => options.source.endsWith(extension))
  ) {
    throw new Error('MCPB source must end in .mcpb or .dxt')
  }
  let source = options.source
  if (!remote) {
    const requestedSource = resolve(pluginRoot, options.source)
    const requestedRelative = relative(pluginRoot, requestedSource)
    if (
      requestedRelative === '..' ||
      requestedRelative.startsWith('../') ||
      isAbsolute(requestedRelative)
    )
      throw new Error('Local MCPB source escapes plugin root')
    source = await realpath(requestedSource)
    const rel = relative(pluginRoot, source)
    if (rel === '..' || rel.startsWith('../') || isAbsolute(rel))
      throw new Error('Local MCPB source escapes plugin root')
  }
  const limits: Required<ClaudePluginMcpbLimits> = {
    archiveBytes: options.limits?.archiveBytes ?? DEFAULT_ARCHIVE_BYTES,
    extractedBytes: options.limits?.extractedBytes ?? DEFAULT_EXTRACTED_BYTES,
    files: options.limits?.files ?? DEFAULT_FILES,
  }
  const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const signal =
    options.signal === undefined
      ? timeout
      : AbortSignal.any([options.signal, timeout])
  signal.throwIfAborted()
  const cacheRoot = join(pluginRoot, '.mcpb-cache')
  const cacheEntry = join(cacheRoot, hash(source))
  const cacheSource = remote ? `url:${hash(source)}` : source
  const cached = await readCached(cacheEntry, cacheSource)
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
  const key = `${resolve(options.pluginRoot)}\0${options.source}`
  const previous = mcpbLoadTails.get(key) ?? Promise.resolve()
  let release = (): void => undefined
  const current = new Promise<void>((resolveCurrent) => {
    release = resolveCurrent
  })
  const tail = previous.then(() => current)
  mcpbLoadTails.set(key, tail)
  await previous
  try {
    return await loadClaudePluginMcpbUnlocked(options)
  } finally {
    release()
    if (mcpbLoadTails.get(key) === tail) mcpbLoadTails.delete(key)
  }
}
