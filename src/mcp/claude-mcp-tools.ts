import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, open, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'

import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  ElicitRequestSchema,
  ElicitationCompleteNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js'
import type {
  ElicitRequest,
  ElicitResult,
} from '@modelcontextprotocol/sdk/types.js'
import { Ajv2020 } from 'ajv/dist/2020.js'

import type { JsonResource } from '../core/resources.js'
import type {
  ModelToolCall,
  ModelContentBlock,
  ModelImage,
  ModelImageMediaType,
  ModelToolDefinition,
  PermissionApproval,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolRegistry,
  RuntimeEventSink,
} from '../core/runtime.js'
import { resolveToolSchedulingPolicy } from '../core/tool-scheduling-policy.js'
import {
  redactSensitiveError,
  redactSensitiveText,
  redactSensitiveValue,
  sanitizeChildEnvironment,
  sensitiveEnvironmentValues,
} from '../platform/sensitive-data.js'
import { parsePermissionUpdates } from '../permissions/permission-updates.js'
import {
  loadMcpOAuthProvider,
  mcpOAuthServerIdentity,
} from './claude-mcp-oauth.js'
import {
  McpServerSession,
  type McpServerCatalog,
  parseMcpSessionTimeouts,
} from './mcp-server-session.js'

type McpServerConfig =
  | {
      type: 'stdio'
      command: string
      args: string[]
      env: Record<string, string>
      cwd?: string
    }
  | {
      type: 'http' | 'sse'
      url: string
      headers: Record<string, string>
    }

interface ConfiguredServer {
  name: string
  value: unknown
  path: string
  plugin: boolean
  sensitiveValues?: readonly string[]
}

interface ConnectedTool {
  session: McpServerSession
  serverName: string
  toolName: string
  definition: ModelToolDefinition
  readOnly: boolean
  schedulingInputIsValid?: (input: Record<string, unknown>) => boolean
  sensitiveValues: readonly string[]
}

interface ConnectedResourceServer {
  session: McpServerSession
  resources: readonly Record<string, unknown>[]
  sensitiveValues: readonly string[]
}

interface ConnectedPrompt {
  session: McpServerSession
  serverName: string
  rawPromptName: string
  rawArgumentNames: readonly string[]
  promptName: string
  name: string
  userFacingName: string
  description: string
  argumentNames: readonly string[]
  sensitiveValues: readonly string[]
}

export interface ClaudeMcpPromptResult {
  text: string
  contentBlocks: readonly ModelContentBlock[]
  images: readonly ModelImage[]
}

export interface ClaudeMcpPromptDefinition {
  name: string
  userFacingName: string
  description: string
  argumentNames: readonly string[]
  invoke: (
    argumentsText: string,
    options?: {
      signal?: AbortSignal
      toolResultDirectory?: string
    },
  ) => Promise<ClaudeMcpPromptResult>
}

export interface ClaudeMcpServerStatus {
  name: string
  status: 'connected' | 'failed' | 'needs-authentication'
  statusDetail?: string
  authDetail?: string
  capabilities?: readonly ('tools' | 'resources' | 'prompts')[]
  toolCount?: number
}

export interface ClaudeMcpToolInspection {
  name: string
  fullName: string
  description?: string
}

export interface ClaudeMcpRuntime {
  inspect(): Promise<readonly ClaudeMcpServerStatus[]>
  reconnect(name: string): Promise<void>
  authenticate(name: string): Promise<void>
  reload(): Promise<void>
  tools(name: string): Promise<readonly ClaudeMcpToolInspection[]>
  instructions?(): readonly ClaudeMcpServerInstruction[]
  connectAgent?(options: {
    specs: readonly unknown[]
    base: ToolRegistry
    cwd: string
    signal?: AbortSignal
  }): Promise<{ tools: ToolRegistry; close(): Promise<void> } | null>
  /** Release MCP transports and child processes owned by this runtime. */
  close?(): Promise<void>
}

export interface ClaudeMcpServerInstruction {
  server: string
  instructions: string
}

export interface ClaudeMcpConfigurationStatus {
  name: string
  path: string
  transport: 'stdio' | 'http' | 'sse'
  command?: string
  cwd?: string
}

export interface ClaudeMcpConfigurationReport {
  servers: readonly ClaudeMcpConfigurationStatus[]
  warnings: readonly string[]
}

export interface ClaudeMcpToolRegistryOptions {
  base: ToolRegistry
  resources: readonly JsonResource[]
  cwd: string
  configRoot?: string
  onWarning?: (message: string) => void
  signal?: AbortSignal
  environment?: NodeJS.ProcessEnv
  eventSink?: RuntimeEventSink
  onPromptsChanged?: (prompts: readonly ClaudeMcpPromptDefinition[]) => void
  onInstructionsChanged?: (
    instructions: readonly ClaudeMcpServerInstruction[],
  ) => void
  authenticateServer?: (name: string) => Promise<void>
  reloadResources?: () => Promise<readonly JsonResource[]>
  onElicitation?: (request: {
    serverName: string
    message: ElicitRequest['params']['message']
    mode?: 'form' | 'url'
    url?: string
    elicitationId?: string
    requestedSchema?: Record<string, unknown>
  }) => Promise<{
    action: 'accept' | 'decline' | 'cancel'
    content?: Record<string, string | number | boolean | string[]>
  }>
}

function normalizeMcpName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/gu, '_')
}

function sanitizeMcpUnicode(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[\p{Cf}\p{Co}\p{Cn}]/gu, '')
    .replace(
      /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF\uE000-\uF8FF]/gu,
      '',
    )
}
const MAX_MCP_TOOL_DESCRIPTION_CODE_POINTS = 2_048

function capMcpToolDescription(value: string): string {
  return [...value].slice(0, MAX_MCP_TOOL_DESCRIPTION_CODE_POINTS).join('')
}

const MAX_RESOURCE_BYTES = 25 * 1024 * 1024
const MAX_INLINE_MCP_TEXT_RESULT_BYTES = 100_000
const NO_MCP_RESOURCES =
  'No resources found. MCP servers may still provide tools even if they have no resources.'

const MCP_RESOURCE_TOOL_DEFINITIONS: readonly ModelToolDefinition[] = [
  {
    name: 'ListMcpResourcesTool',
    description: 'list resources from connected MCP servers',
    inputSchema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        server: {
          description: 'Optional server name to filter resources by',
          type: 'string',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'ReadMcpResourceDirTool',
    description: 'list the children of an MCP directory resource',
    inputSchema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        server: { description: 'The MCP server name', type: 'string' },
        uri: {
          description: 'The directory resource URI to list',
          type: 'string',
        },
      },
      required: ['server', 'uri'],
      additionalProperties: false,
    },
  },
  {
    name: 'ReadMcpResourceTool',
    description: 'read a specific MCP resource by URI',
    inputSchema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        server: { description: 'The MCP server name', type: 'string' },
        uri: { description: 'The resource URI to read', type: 'string' },
      },
      required: ['server', 'uri'],
      additionalProperties: false,
    },
  },
]

const schedulingAjv = new Ajv2020({ strict: false, validateFormats: false })

function schedulingInputValidator(
  schema: Record<string, unknown>,
): ((input: Record<string, unknown>) => boolean) | undefined {
  try {
    const validate = schedulingAjv.compile(schema)
    return (input) => validate(input) === true
  } catch {
    return undefined
  }
}

function mcpResourceSchedulingInputIsValid(call: ModelToolCall): boolean {
  const keys = Object.keys(call.input)
  if (call.name === 'ListMcpResourcesTool') {
    return (
      keys.every((name) => name === 'server') &&
      (call.input.server === undefined || typeof call.input.server === 'string')
    )
  }
  return (
    (call.name === 'ReadMcpResourceDirTool' ||
      call.name === 'ReadMcpResourceTool') &&
    keys.every((name) => name === 'server' || name === 'uri') &&
    typeof call.input.server === 'string' &&
    typeof call.input.uri === 'string'
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringRecord(value: unknown, label: string): Record<string, string> {
  if (value === undefined) return {}
  if (
    !isRecord(value) ||
    Object.values(value).some((item) => typeof item !== 'string')
  ) {
    throw new Error(`${label} must contain only string values`)
  }
  return value as Record<string, string>
}

function parseServerConfig(
  name: string,
  value: unknown,
  path: string,
): McpServerConfig {
  if (!isRecord(value)) throw new Error(`Invalid MCP server ${name}: ${path}`)
  if (
    value.type !== undefined &&
    value.type !== 'stdio' &&
    value.type !== 'http' &&
    value.type !== 'sse'
  ) {
    throw new Error(`Unsupported MCP server transport ${name}: ${path}`)
  }
  if (
    value.type === 'http' ||
    value.type === 'sse' ||
    value.url !== undefined
  ) {
    if (
      value.type !== undefined &&
      value.type !== 'http' &&
      value.type !== 'sse'
    ) {
      throw new Error(`Unsupported MCP server transport ${name}: ${path}`)
    }
    if (typeof value.url !== 'string' || value.url.length === 0) {
      throw new Error(`Invalid MCP server URL ${name}: ${path}`)
    }
    return {
      type: value.type === 'sse' ? 'sse' : 'http',
      url: value.url,
      headers: stringRecord(value.headers, `MCP server ${name} headers`),
    }
  }
  if (typeof value.command !== 'string' || value.command.length === 0) {
    throw new Error(`Invalid MCP server command ${name}: ${path}`)
  }
  const args = value.args ?? []
  if (!Array.isArray(args) || args.some((item) => typeof item !== 'string')) {
    throw new Error(`MCP server ${name} args must contain only strings`)
  }
  if (value.cwd !== undefined && typeof value.cwd !== 'string') {
    throw new Error(`MCP server ${name} cwd must be a string`)
  }
  return {
    type: 'stdio',
    command: value.command,
    args,
    env: stringRecord(value.env, `MCP server ${name} env`),
    ...(typeof value.cwd === 'string' ? { cwd: value.cwd } : {}),
  }
}

function configuredServers(
  resources: readonly JsonResource[],
  onWarning?: (message: string) => void,
): ConfiguredServer[] {
  const servers = new Map<string, ConfiguredServer>()
  for (const resource of resources) {
    if (!isRecord(resource.value)) continue
    const value = resource.value.mcpServers
    if (value === undefined) continue
    if (!isRecord(value)) {
      onWarning?.(`Invalid Claude MCP resource: ${resource.path}`)
      continue
    }
    for (const [name, config] of Object.entries(value)) {
      if (name.length === 0) {
        onWarning?.(`Invalid empty MCP server name: ${resource.path}`)
        continue
      }
      servers.set(name, {
        name,
        value: config,
        path: resource.path,
        plugin: resource.plugin === true,
        ...(resource.sensitiveValues === undefined
          ? {}
          : { sensitiveValues: resource.sensitiveValues }),
      })
    }
  }
  const configured = [...servers.values()]
  const manualSignatures = new Set(
    configured
      .filter((server) => !server.plugin)
      .map((server) => mcpServerSignature(server.value))
      .filter((signature): signature is string => signature !== undefined),
  )
  const pluginSignatures = new Set<string>()
  return configured.filter((server) => {
    if (!server.plugin) return true
    const signature = mcpServerSignature(server.value)
    if (signature === undefined) return true
    if (manualSignatures.has(signature) || pluginSignatures.has(signature)) {
      return false
    }
    pluginSignatures.add(signature)
    return true
  })
}

function mcpServerSignature(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.url === 'string') {
    let url = value.url
    if (
      url.includes('/v2/session_ingress/shttp/mcp/') ||
      url.includes('/v2/ccr-sessions/')
    ) {
      try {
        url = new URL(url).searchParams.get('mcp_url') ?? url
      } catch {
        // Invalid URLs are validated later; preserve their literal signature.
      }
    }
    return `url:${url}`
  }
  if (typeof value.command !== 'string') return undefined
  const args = value.args ?? []
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) {
    return undefined
  }
  return `stdio:${JSON.stringify([value.command, ...args])}`
}

export function validateClaudeMcpConfiguration(
  resources: readonly JsonResource[],
): ClaudeMcpConfigurationReport {
  const warnings: string[] = []
  const servers = configuredServers(resources, (message) =>
    warnings.push(message),
  ).map((server) => {
    const config = parseServerConfig(server.name, server.value, server.path)
    if (config.type !== 'stdio') {
      let endpoint: URL
      try {
        endpoint = new URL(config.url)
      } catch (error) {
        throw new Error(
          `Invalid MCP server URL ${server.name}: ${server.path}`,
          {
            cause: error,
          },
        )
      }
      if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
        throw new Error(
          `MCP server URL must use http or https ${server.name}: ${server.path}`,
        )
      }
    }
    return {
      name: server.name,
      path: server.path,
      transport: config.type,
      ...(config.type === 'stdio'
        ? {
            command: config.command,
            ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
          }
        : {}),
    }
  })
  return { servers, warnings }
}

async function transport(
  serverName: string,
  config: McpServerConfig,
  cwd: string,
  configRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
) {
  if (config.type === 'stdio') {
    return new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: sanitizeChildEnvironment(config.env, environment),
      cwd: config.cwd ?? cwd,
      stderr: 'pipe',
    })
  }
  const requestInit = { headers: config.headers }
  const identity = mcpOAuthServerIdentity(serverName, config)
  const authProvider = await loadMcpOAuthProvider(configRoot, identity)
  return config.type === 'sse'
    ? new SSEClientTransport(new URL(config.url), {
        requestInit,
        ...(authProvider ? { authProvider } : {}),
      })
    : new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit,
        ...(authProvider ? { authProvider } : {}),
      })
}

function deriveMcpServerConfig(
  config: McpServerConfig,
  environment: NodeJS.ProcessEnv,
): McpServerConfig {
  if (config.type !== 'stdio') return config
  const env = Object.fromEntries(
    Object.entries(config.env).map(([name, value]) => [
      name,
      value.replace(
        /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/gu,
        (match, variable: string) => {
          const replacement = environment[variable]
          return Object.prototype.hasOwnProperty.call(environment, variable) &&
            typeof replacement === 'string'
            ? replacement
            : match
        },
      ),
    ]),
  )
  return { ...config, env }
}

function toolContent(
  result: Record<string, unknown>,
  sensitiveValues: readonly string[],
): string {
  if (!Array.isArray(result.content)) {
    throw new Error('MCP tool result content must be an array')
  }
  const parts = result.content.map((item) =>
    isRecord(item) && item.type === 'text' && typeof item.text === 'string'
      ? item.text
      : JSON.stringify(item),
  )
  if (result.structuredContent !== undefined) {
    parts.push(JSON.stringify(result.structuredContent))
  }
  return redactSensitiveText(parts.join('\n'), sensitiveValues)
}

const INVALID_PERMISSION_RESULT =
  "The permission prompt tool returned an invalid permission result. Expected {behavior: 'allow', updatedInput: object} or {behavior: 'deny', message: string}."

function invalidPermissionResult(): PermissionApproval {
  return { behavior: 'deny', message: INVALID_PERMISSION_RESULT }
}

function parsePermissionResult(
  source: string,
  currentInput: Record<string, unknown>,
): PermissionApproval {
  const value: unknown = JSON.parse(source)
  if (!isRecord(value)) return invalidPermissionResult()
  if (value.behavior === 'allow') {
    if (!isRecord(value.updatedInput)) return invalidPermissionResult()
    const updatedPermissions = parsePermissionUpdates(value.updatedPermissions)
    return {
      behavior: 'allow',
      updatedInput:
        Object.keys(value.updatedInput).length === 0
          ? currentInput
          : value.updatedInput,
      ...(updatedPermissions ? { updatedPermissions } : {}),
    }
  }
  if (value.behavior === 'deny' && typeof value.message === 'string') {
    return {
      behavior: 'deny',
      message: value.message,
      ...(typeof value.interrupt === 'boolean'
        ? { interrupt: value.interrupt }
        : {}),
    }
  }
  return invalidPermissionResult()
}

function configSensitiveValues(
  config: McpServerConfig,
  additional: readonly string[] = [],
  environment: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  return [
    ...new Set([
      ...sensitiveEnvironmentValues(
        environment,
        config.type === 'stdio' ? config.env : config.headers,
      ),
      ...additional,
    ]),
  ]
    .filter((value) => value.length > 0)
    .sort((left, right) => right.length - left.length)
}

function requiredString(input: Record<string, unknown>, name: string): string {
  const value = input[name]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`)
  }
  return value
}

function optionalString(
  input: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = input[name]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`)
  }
  return value
}

function resourceExtension(mimeType: unknown): string {
  switch (mimeType) {
    case 'image/png':
      return '.png'
    case 'image/jpeg':
      return '.jpg'
    case 'image/gif':
      return '.gif'
    case 'image/webp':
      return '.webp'
    case 'application/pdf':
      return '.pdf'
    case 'application/json':
      return '.json'
    case 'audio/wav':
      return '.wav'
    case 'audio/mpeg':
      return '.mp3'
    case 'audio/ogg':
      return '.ogg'
    case 'audio/flac':
      return '.flac'
    case 'text/plain':
      return '.txt'
    default:
      return '.bin'
  }
}

function decodeResourceBlob(value: string): Buffer {
  if (value.length > Math.ceil((MAX_RESOURCE_BYTES * 4) / 3) + 4) {
    throw new Error(`MCP resource exceeded ${MAX_RESOURCE_BYTES} bytes`)
  }
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    throw new Error('MCP resource blob must be valid base64')
  }
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length > MAX_RESOURCE_BYTES) {
    throw new Error(`MCP resource exceeded ${MAX_RESOURCE_BYTES} bytes`)
  }
  return bytes
}

async function writeResourceBlob(
  directory: string,
  bytes: Buffer,
  extension: string,
  index: number,
): Promise<string> {
  await mkdir(directory, { recursive: true })
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const filePath = join(
      directory,
      `mcp-resource-${Date.now()}-${index}-${randomBytes(3).toString('hex')}${extension}`,
    )
    let handle
    let created = false
    try {
      handle = await open(filePath, 'wx', 0o600)
      created = true
      await handle.writeFile(bytes)
      await handle.sync()
      await handle.close()
      return filePath
    } catch (error) {
      await handle?.close().catch(() => undefined)
      if (created) await rm(filePath, { force: true }).catch(() => undefined)
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  throw new Error('Could not reserve MCP resource output path')
}

const MCP_IMAGE_MEDIA_TYPES = new Set<ModelImageMediaType>([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
])

async function writeToolBlob(
  directory: string,
  serverName: string,
  bytes: Buffer,
  extension: string,
): Promise<string> {
  await mkdir(directory, { recursive: true })
  const safeServer = serverName.replaceAll(/[^A-Za-z0-9_-]/gu, '-')
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const filePath = join(
      directory,
      `mcp-${safeServer}-blob-${Date.now()}-${randomBytes(3).toString('hex')}${extension}`,
    )
    let handle
    let created = false
    try {
      handle = await open(filePath, 'wx', 0o600)
      created = true
      await handle.writeFile(bytes)
      await handle.sync()
      await handle.close()
      return filePath
    } catch (error) {
      await handle?.close().catch(() => undefined)
      if (created) await rm(filePath, { force: true }).catch(() => undefined)
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  throw new Error('Could not reserve MCP tool blob output path')
}

function mcpTextBlock(
  text: string,
  sensitiveValues: readonly string[],
): Extract<ModelContentBlock, { type: 'text' }> {
  return { type: 'text', text: redactSensitiveText(text, sensitiveValues) }
}

async function mcpBinaryText(
  options: {
    kind: 'Audio' | 'Resource'
    serverName: string
    uri?: string
    mimeType: string
    bytes: Buffer
    context: ToolExecutionContext
  },
  sensitiveValues: readonly string[],
  createdFiles: string[],
): Promise<ModelContentBlock> {
  if (!options.context.toolResultDirectory) {
    throw new Error('MCP binary tool result output directory is unavailable')
  }
  const filePath = await writeToolBlob(
    options.context.toolResultDirectory,
    options.serverName,
    options.bytes,
    resourceExtension(options.mimeType),
  )
  createdFiles.push(filePath)
  const origin =
    options.kind === 'Audio'
      ? `Audio from ${options.serverName}`
      : `Resource from ${options.serverName} at ${options.uri}`
  return mcpTextBlock(
    `[${origin}] Binary content (${options.mimeType}, ${options.bytes.length} bytes) saved to ${filePath}`,
    sensitiveValues,
  )
}

async function externalizeMcpTextResult(
  serverName: string,
  content: string,
  context: ToolExecutionContext,
  sensitiveValues: readonly string[],
  createdFiles: string[],
): Promise<Extract<ModelContentBlock, { type: 'text' }>> {
  if (!context.toolResultDirectory) {
    throw new Error(
      'MCP large text tool result output directory is unavailable',
    )
  }
  const bytes = Buffer.from(content, 'utf8')
  const filePath = await writeToolBlob(
    resolvePath(context.cwd, context.toolResultDirectory),
    serverName,
    bytes,
    '.txt',
  )
  createdFiles.push(filePath)
  return mcpTextBlock(
    `[MCP tool result from ${serverName}] Text content (${bytes.length} bytes) saved to ${filePath}`,
    sensitiveValues,
  )
}

async function mcpToolResultUnchecked(
  serverName: string,
  result: Record<string, unknown>,
  context: ToolExecutionContext,
  sensitiveValues: readonly string[],
  createdFiles: string[],
): Promise<ToolExecutionResult> {
  if (!Array.isArray(result.content)) {
    throw new Error('MCP tool result content must be an array')
  }
  const blocks: ModelContentBlock[] = []
  let textOnly = result.structuredContent === undefined
  let resultBytes = 0
  const consumeBytes = (bytes: number) => {
    resultBytes += bytes
    if (resultBytes > MAX_RESOURCE_BYTES) {
      throw new Error(`MCP tool result exceeded ${MAX_RESOURCE_BYTES} bytes`)
    }
  }
  const structuredContent =
    result.structuredContent === undefined
      ? undefined
      : redactSensitiveValue(result.structuredContent, sensitiveValues)
  for (const item of result.content) {
    if (!isRecord(item) || typeof item.type !== 'string') {
      throw new Error('Invalid MCP tool result content block')
    }
    if (item.type === 'text') {
      if (typeof item.text !== 'string') {
        throw new Error('MCP text result requires text')
      }
      consumeBytes(Buffer.byteLength(item.text))
      if (structuredContent === undefined) {
        blocks.push(mcpTextBlock(item.text, sensitiveValues))
      }
      continue
    }
    textOnly = false
    if (item.type === 'image') {
      if (
        typeof item.mimeType !== 'string' ||
        !MCP_IMAGE_MEDIA_TYPES.has(item.mimeType as ModelImageMediaType) ||
        typeof item.data !== 'string'
      ) {
        throw new Error('MCP image result is invalid or unsupported')
      }
      const bytes = decodeResourceBlob(item.data)
      consumeBytes(bytes.length)
      blocks.push({
        type: 'image',
        mediaType: item.mimeType as ModelImageMediaType,
        data: item.data,
      })
      continue
    }
    if (item.type === 'audio') {
      if (typeof item.mimeType !== 'string' || typeof item.data !== 'string') {
        throw new Error('MCP audio result is invalid')
      }
      const bytes = decodeResourceBlob(item.data)
      consumeBytes(bytes.length)
      blocks.push(
        await mcpBinaryText(
          {
            kind: 'Audio',
            serverName,
            mimeType: item.mimeType,
            bytes,
            context,
          },
          sensitiveValues,
          createdFiles,
        ),
      )
      continue
    }
    if (item.type === 'resource_link') {
      if (typeof item.name !== 'string' || typeof item.uri !== 'string') {
        throw new Error('MCP resource link result is invalid')
      }
      consumeBytes(
        Buffer.byteLength(item.name) +
          Buffer.byteLength(item.uri) +
          (typeof item.description === 'string'
            ? Buffer.byteLength(item.description)
            : 0),
      )
      blocks.push(
        mcpTextBlock(
          `[Resource link: ${item.name}] ${item.uri}${typeof item.description === 'string' ? ` (${item.description})` : ''}`,
          sensitiveValues,
        ),
      )
      continue
    }
    if (item.type === 'resource') {
      if (!isRecord(item.resource) || typeof item.resource.uri !== 'string') {
        throw new Error('MCP embedded resource result is invalid')
      }
      const resource = item.resource
      const resourceUri = String(resource.uri)
      if (typeof resource.text === 'string') {
        consumeBytes(
          Buffer.byteLength(resourceUri) + Buffer.byteLength(resource.text),
        )
        blocks.push(
          mcpTextBlock(
            `[Resource from ${serverName} at ${resourceUri}] ${resource.text}`,
            sensitiveValues,
          ),
        )
        continue
      }
      if (typeof resource.blob === 'string') {
        const bytes = decodeResourceBlob(resource.blob)
        consumeBytes(bytes.length)
        blocks.push(
          await mcpBinaryText(
            {
              kind: 'Resource',
              serverName,
              uri: resourceUri,
              mimeType:
                typeof resource.mimeType === 'string'
                  ? resource.mimeType
                  : 'application/octet-stream',
              bytes,
              context,
            },
            sensitiveValues,
            createdFiles,
          ),
        )
        continue
      }
      throw new Error('MCP embedded resource requires text or blob')
    }
    const serialized = JSON.stringify(
      redactSensitiveValue(item, sensitiveValues),
    )
    consumeBytes(Buffer.byteLength(serialized))
    blocks.push(mcpTextBlock(serialized, sensitiveValues))
  }
  if (structuredContent !== undefined) {
    const serialized = JSON.stringify(structuredContent)
    consumeBytes(Buffer.byteLength(serialized))
    blocks.push(mcpTextBlock(serialized, sensitiveValues))
  }
  const content = blocks
    .filter(
      (block): block is Extract<ModelContentBlock, { type: 'text' }> =>
        block.type === 'text',
    )
    .map((block) => block.text)
    .join('\n')
  if (Buffer.byteLength(content) > MAX_RESOURCE_BYTES) {
    throw new Error(`MCP tool result exceeded ${MAX_RESOURCE_BYTES} bytes`)
  }
  if (
    textOnly &&
    Buffer.byteLength(content) > MAX_INLINE_MCP_TEXT_RESULT_BYTES
  ) {
    const pointerBlock = await externalizeMcpTextResult(
      serverName,
      content,
      context,
      sensitiveValues,
      createdFiles,
    )
    return {
      content: pointerBlock.text,
      contentBlocks: [pointerBlock],
      isError: result.isError === true,
    }
  }
  const images = blocks.filter(
    (block): block is Extract<ModelContentBlock, { type: 'image' }> =>
      block.type === 'image',
  )
  return {
    content,
    contentBlocks: blocks,
    ...(images.length > 0 ? { images } : {}),
    isError: result.isError === true,
    ...(structuredContent === undefined
      ? {}
      : { nativeMcpMeta: { structuredContent } }),
  }
}

async function mcpToolResult(
  serverName: string,
  result: Record<string, unknown>,
  context: ToolExecutionContext,
  sensitiveValues: readonly string[],
): Promise<ToolExecutionResult> {
  const createdFiles: string[] = []
  try {
    return await mcpToolResultUnchecked(
      serverName,
      result,
      context,
      sensitiveValues,
      createdFiles,
    )
  } catch (error) {
    await Promise.all(
      createdFiles.map((filePath) =>
        rm(filePath, { force: true }).catch(() => undefined),
      ),
    )
    throw error
  }
}

function isMissingResourceError(error: unknown): boolean {
  return (
    isRecord(error) &&
    (error.code === -32002 || String(error.message).includes('-32002'))
  )
}

async function resourceContent(
  server: string,
  result: Record<string, unknown>,
  context: ToolExecutionContext,
  sensitiveValues: readonly string[],
): Promise<string> {
  if (!Array.isArray(result.contents)) {
    throw new Error('MCP resource result contents must be an array')
  }
  const contents = []
  const createdFiles: string[] = []
  let contentBytes = 0
  const consumeBytes = (bytes: number) => {
    contentBytes += bytes
    if (contentBytes > MAX_RESOURCE_BYTES) {
      throw new Error(
        `MCP resource result exceeded ${MAX_RESOURCE_BYTES} bytes`,
      )
    }
  }
  try {
    for (let index = 0; index < result.contents.length; index += 1) {
      const item = result.contents[index]
      if (!isRecord(item) || typeof item.uri !== 'string') {
        throw new Error('Invalid MCP resource content')
      }
      if (typeof item.text === 'string') {
        consumeBytes(Buffer.byteLength(item.text))
        contents.push({
          uri: item.uri,
          ...(typeof item.mimeType === 'string'
            ? { mimeType: item.mimeType }
            : {}),
          text: item.text,
        })
        continue
      }
      if (typeof item.blob !== 'string') {
        throw new Error('MCP resource content requires text or blob')
      }
      if (!context.toolResultDirectory) {
        throw new Error('MCP binary resource output directory is unavailable')
      }
      const bytes = decodeResourceBlob(item.blob)
      consumeBytes(bytes.length)
      const filePath = await writeResourceBlob(
        context.toolResultDirectory,
        bytes,
        resourceExtension(item.mimeType),
        index,
      )
      createdFiles.push(filePath)
      const mimeType =
        typeof item.mimeType === 'string'
          ? item.mimeType
          : 'application/octet-stream'
      contents.push({
        uri: item.uri,
        ...(typeof item.mimeType === 'string'
          ? { mimeType: item.mimeType }
          : {}),
        blobSavedTo: filePath,
        text: `[Resource from ${server} at ${item.uri}] Binary content (${mimeType}, ${bytes.length} bytes) saved to ${filePath}`,
      })
    }
    const serialized = JSON.stringify(
      redactSensitiveValue({ contents }, sensitiveValues),
    )
    if (Buffer.byteLength(serialized) > MAX_RESOURCE_BYTES) {
      throw new Error(
        `MCP resource result exceeded ${MAX_RESOURCE_BYTES} bytes`,
      )
    }
    return serialized
  } catch (error) {
    await Promise.allSettled(
      createdFiles.map((filePath) => rm(filePath, { force: true })),
    )
    throw error
  }
}

export class ClaudeMcpToolRegistry implements ToolRegistry, ClaudeMcpRuntime {
  private readonly connectedTools = new Map<string, ConnectedTool>()
  private readonly toolRoutes = new Map<string, ConnectedTool>()
  private readonly reservedTools = new Set<string>()
  private readonly resourceServers = new Map<string, ConnectedResourceServer>()
  private readonly resourceRoutes = new Map<string, ConnectedResourceServer>()
  private readonly promptServers = new Map<string, readonly ConnectedPrompt[]>()
  private readonly statuses = new Map<string, ClaudeMcpServerStatus>()
  private readonly sessions = new Map<string, McpServerSession>()
  private readonly serverSensitiveValues = new Map<string, readonly string[]>()
  private readonly serverCapabilities = new Map<
    string,
    readonly ('tools' | 'resources' | 'prompts')[]
  >()
  private readonly serverInstructions = new Map<string, string>()
  private readonly promptOperations = new Set<Promise<unknown>>()
  private promptResultDirectoryPromise: Promise<string> | undefined
  private closePromise: Promise<void> | undefined
  private generation = 0
  private closed = false

  private readonly timeouts: ReturnType<typeof parseMcpSessionTimeouts>

  private constructor(private readonly options: ClaudeMcpToolRegistryOptions) {
    this.timeouts = parseMcpSessionTimeouts(options.environment ?? process.env)
  }

  static async connect(
    options: ClaudeMcpToolRegistryOptions,
  ): Promise<ClaudeMcpToolRegistry> {
    const registry = new ClaudeMcpToolRegistry(options)
    const ambientSensitiveValues = sensitiveEnvironmentValues(process.env)
    const warn = (message: string) =>
      options.onWarning?.(redactSensitiveText(message, ambientSensitiveValues))
    try {
      await registry.configure(options.resources, warn)
    } catch (error) {
      await registry.close()
      throw error
    }
    return registry
  }

  definitions(): readonly ModelToolDefinition[] {
    return [
      ...this.options.base.definitions(),
      ...(this.resourceServers.size > 0 ? MCP_RESOURCE_TOOL_DEFINITIONS : []),
      ...[...this.connectedTools.entries()]
        .filter(([name]) => !this.reservedTools.has(name))
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([, tool]) => tool.definition),
    ]
  }

  schedulingPolicy(call: ModelToolCall) {
    if (
      MCP_RESOURCE_TOOL_DEFINITIONS.some(
        (definition) => definition.name === call.name,
      )
    ) {
      return mcpResourceSchedulingInputIsValid(call)
        ? { concurrency: 'concurrent' as const, cancelOnInterrupt: true }
        : { concurrency: 'exclusive' as const, cancelOnInterrupt: true }
    }
    const connected = this.connectedTools.get(call.name)
    if (connected) {
      return connected.readOnly &&
        connected.schedulingInputIsValid?.(call.input)
        ? { concurrency: 'concurrent' as const, cancelOnInterrupt: true }
        : { concurrency: 'exclusive' as const, cancelOnInterrupt: true }
    }
    return resolveToolSchedulingPolicy(this.options.base, call)
  }

  serverStatuses(): readonly ClaudeMcpServerStatus[] {
    return [...this.statuses.values()].map(({ name, status }) => ({
      name,
      status,
    }))
  }

  instructions(): readonly ClaudeMcpServerInstruction[] {
    return [...this.serverInstructions]
      .map(([server, instructions]) => ({ server, instructions }))
      .sort((left, right) => left.server.localeCompare(right.server))
  }

  async inspect(): Promise<readonly ClaudeMcpServerStatus[]> {
    return this.runtimeStatuses()
  }

  async reconnect(name: string): Promise<void> {
    try {
      await this.reconnectServer(name)
    } catch (error) {
      throw redactSensitiveError(
        error,
        this.serverSensitiveValues.get(name) ?? [],
      )
    }
  }

  async authenticate(name: string): Promise<void> {
    if (!this.statuses.has(name)) throw new Error(`Unknown MCP server ${name}`)
    if (!this.options.authenticateServer) {
      throw new Error('MCP authentication is not available in this runtime')
    }
    try {
      await this.options.authenticateServer(name)
      await this.reconnectServer(name)
    } catch (error) {
      throw redactSensitiveError(
        error,
        this.serverSensitiveValues.get(name) ?? [],
      )
    }
  }

  async reload(): Promise<void> {
    if (this.closed) throw new Error('MCP registry is closed')
    this.generation += 1
    const sessions = [...this.sessions.values()]
    this.sessions.clear()
    this.connectedTools.clear()
    this.toolRoutes.clear()
    this.resourceServers.clear()
    this.resourceRoutes.clear()
    this.promptServers.clear()
    this.serverCapabilities.clear()
    await Promise.allSettled(sessions.map((session) => session.close()))
    this.reservedTools.clear()
    this.statuses.clear()
    this.serverSensitiveValues.clear()
    this.serverInstructions.clear()
    const ambientSensitiveValues = sensitiveEnvironmentValues(process.env)
    const warn = (message: string) =>
      this.options.onWarning?.(
        redactSensitiveText(message, ambientSensitiveValues),
      )
    await this.configure(
      this.options.reloadResources
        ? await this.options.reloadResources()
        : this.options.resources,
      warn,
    )
  }

  async tools(name: string): Promise<readonly ClaudeMcpToolInspection[]> {
    if (!this.statuses.has(name)) throw new Error(`Unknown MCP server ${name}`)
    return [...this.connectedTools.entries()]
      .filter(([, tool]) => tool.serverName === name)
      .map(([fullName, tool]) => ({
        name: tool.toolName,
        fullName,
        ...(tool.definition.description
          ? { description: tool.definition.description }
          : {}),
      }))
      .sort((left, right) => left.name.localeCompare(right.name))
  }

  async connectAgent(options: {
    specs: readonly unknown[]
    base: ToolRegistry
    cwd: string
    signal?: AbortSignal
  }): Promise<{ tools: ToolRegistry; close(): Promise<void> } | null> {
    const resources: JsonResource[] = []
    for (const spec of options.specs) {
      if (typeof spec === 'string') {
        if (!this.statuses.has(spec)) {
          this.options.onWarning?.(`Agent MCP server not found: ${spec}`)
        }
        continue
      }
      if (!isRecord(spec)) continue
      const entries = Object.entries(spec)
      if (entries.length !== 1) {
        this.options.onWarning?.(
          'Agent MCP server definitions must contain exactly one server',
        )
        continue
      }
      const [name, config] = entries[0] as [string, unknown]
      if (this.statuses.has(name)) continue
      resources.push({
        path: `agent-mcp:${name}`,
        scope: 'local',
        value: { mcpServers: { [name]: config } },
      })
    }
    if (resources.length === 0) return null
    const tools = await ClaudeMcpToolRegistry.connect({
      base: options.base,
      resources,
      cwd: options.cwd,
      ...(this.options.configRoot
        ? { configRoot: this.options.configRoot }
        : {}),
      ...(this.options.onWarning ? { onWarning: this.options.onWarning } : {}),
      ...(this.options.eventSink ? { eventSink: this.options.eventSink } : {}),
      ...(this.options.authenticateServer
        ? { authenticateServer: this.options.authenticateServer }
        : {}),
      ...(this.options.onElicitation
        ? { onElicitation: this.options.onElicitation }
        : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(this.options.environment
        ? { environment: this.options.environment }
        : {}),
    })
    return { tools, close: () => tools.close() }
  }

  private runtimeStatuses(): readonly ClaudeMcpServerStatus[] {
    return [...this.statuses.values()].map((status) => {
      const capabilities = this.serverCapabilities.get(status.name) ?? []
      const toolCount = [...this.connectedTools.values()].filter(
        (tool) => tool.serverName === status.name,
      ).length
      return { ...status, capabilities, toolCount }
    })
  }

  private async configure(
    resources: readonly JsonResource[],
    warn: (message: string) => void,
  ): Promise<void> {
    for (const server of configuredServers(resources, warn)) {
      this.statuses.set(server.name, { name: server.name, status: 'failed' })
      let config
      try {
        config = parseServerConfig(server.name, server.value, server.path)
      } catch (error) {
        warn(
          `MCP server ${server.name} unavailable: ${error instanceof Error ? error.message : String(error)}`,
        )
        continue
      }
      await this.connectServer(server.name, config, server.sensitiveValues)
    }
    this.publishPrompts()
  }

  prompts(): readonly ClaudeMcpPromptDefinition[] {
    const prompts: ClaudeMcpPromptDefinition[] = []
    const names = new Set<string>()
    for (const serverPrompts of this.promptServers.values()) {
      for (const prompt of serverPrompts) {
        if (names.has(prompt.name)) continue
        names.add(prompt.name)
        prompts.push({
          name: prompt.name,
          userFacingName: prompt.userFacingName,
          description: prompt.description,
          argumentNames: prompt.argumentNames,
          invoke: (argumentsText, options) =>
            this.trackPromptOperation(
              this.invokePrompt(
                prompt,
                argumentsText,
                options?.signal,
                options?.toolResultDirectory,
              ),
            ),
        })
      }
    }
    return prompts
  }

  permissionPrompt(
    name: string,
  ): (
    call: ModelToolCall,
    originalCall?: ModelToolCall,
  ) => Promise<PermissionApproval> {
    if (!this.toolRoutes.has(name)) {
      const available = [...this.connectedTools.keys()].join(', ') || 'none'
      throw new Error(
        `MCP tool ${name} (from --permission-prompt-tool) not found. Available MCP tools: ${available}`,
      )
    }
    this.reservedTools.add(name)
    return async (call, originalCall = call) => {
      const tool = this.toolRoutes.get(name)
      if (!tool) return invalidPermissionResult()
      let result
      try {
        result = await tool.session.callTool(
          {
            name: tool.toolName,
            arguments: {
              tool_name: originalCall.name,
              input: originalCall.input,
              tool_use_id: originalCall.id,
            },
            _meta: { 'claudecode/toolUseId': originalCall.id },
          },
          this.options.signal,
        )
      } catch {
        return invalidPermissionResult()
      }
      if (!isRecord(result) || result.isError === true) {
        return invalidPermissionResult()
      }
      try {
        return parsePermissionResult(
          toolContent(result, tool.sensitiveValues),
          call.input,
        )
      } catch {
        return invalidPermissionResult()
      }
    }
  }

  async prepare(
    call: ModelToolCall,
    context: ToolExecutionContext,
  ): Promise<ModelToolCall> {
    const tool = this.connectedTools.get(call.name)
    if (tool?.readOnly === true) context.toolPermission = { readOnly: true }
    return tool ||
      MCP_RESOURCE_TOOL_DEFINITIONS.some(
        (definition) => definition.name === call.name,
      )
      ? call
      : this.options.base.prepare(call, context)
  }

  async execute(
    call: ModelToolCall,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    if (call.name === 'ListMcpResourcesTool') {
      return this.listResources(call.input)
    }
    if (call.name === 'ReadMcpResourceDirTool') {
      this.resourceServer(requiredString(call.input, 'server'))
      requiredString(call.input, 'uri')
      return {
        content: 'Directory listing is not enabled in this build.',
        isError: false,
      }
    }
    if (call.name === 'ReadMcpResourceTool') {
      return this.readResource(call.input, context)
    }
    const tool = this.toolRoutes.get(call.name)
    if (!tool) return this.options.base.execute(call, context)
    let result
    try {
      result = await tool.session.callTool(
        { name: tool.toolName, arguments: call.input },
        context.signal,
      )
    } catch (error) {
      throw redactSensitiveError(error, tool.sensitiveValues)
    }
    if (!isRecord(result)) throw new Error('Invalid MCP tool result')
    return mcpToolResult(tool.serverName, result, context, tool.sensitiveValues)
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closed = true
    this.generation += 1
    this.closePromise = this.finishClose()
    return this.closePromise
  }

  private async finishClose(): Promise<void> {
    await Promise.allSettled(
      [...this.sessions.values()].map((session) => session.close()),
    )
    await this.awaitPromptOperationsBounded()
    this.sessions.clear()
    this.connectedTools.clear()
    this.toolRoutes.clear()
    this.resourceServers.clear()
    this.resourceRoutes.clear()
    this.promptServers.clear()
    this.serverCapabilities.clear()
    this.serverInstructions.clear()
    const directory = await this.promptResultDirectoryPromise?.catch(
      () => undefined,
    )
    if (directory) await rm(directory, { recursive: true, force: true })
  }

  private async awaitPromptOperationsBounded(): Promise<void> {
    await new Promise<void>((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(finish, this.timeouts.connectionTimeoutMs)
      void Promise.allSettled([...this.promptOperations]).then(finish, finish)
    })
  }

  private listResources(input: Record<string, unknown>): ToolExecutionResult {
    const requestedServer = optionalString(input, 'server')
    let servers: readonly (readonly [string, ConnectedResourceServer])[]
    if (requestedServer) {
      if (!this.statuses.has(requestedServer)) {
        this.resourceServer(requestedServer)
      }
      const connected = this.resourceServers.get(requestedServer)
      if (!connected) return { content: NO_MCP_RESOURCES, isError: false }
      servers = [[requestedServer, connected]]
    } else {
      servers = [...this.resourceServers.entries()]
    }
    const resources = servers.flatMap(([server, connected]) =>
      connected.resources.map((resource) =>
        redactSensitiveValue(
          { ...resource, server },
          connected.sensitiveValues,
        ),
      ),
    )
    const serialized = resources.length > 0 ? JSON.stringify(resources) : null
    if (
      serialized !== null &&
      Buffer.byteLength(serialized) > MAX_RESOURCE_BYTES
    ) {
      throw new Error(`MCP resource list exceeded ${MAX_RESOURCE_BYTES} bytes`)
    }
    return {
      content: serialized ?? NO_MCP_RESOURCES,
      isError: false,
    }
  }

  private async readResource(
    input: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const serverName = requiredString(input, 'server')
    const uri = requiredString(input, 'uri')
    const server =
      this.resourceServers.get(serverName) ??
      this.resourceRoutes.get(serverName)
    if (!server) {
      this.resourceServer(serverName)
      throw new Error(`Server "${serverName}" is not connected`)
    }
    let result
    try {
      result = await server.session.readResource({ uri }, context.signal)
    } catch (error) {
      if (context.signal?.aborted) throw error
      if (isMissingResourceError(error)) {
        return {
          content: `Resource not found: ${uri} \u2014 it may have been deleted or the URI is stale. Re-run ListMcpResourcesTool to refresh.`,
          isError: false,
        }
      }
      throw redactSensitiveError(error, server.sensitiveValues)
    }
    if (!isRecord(result)) throw new Error('Invalid MCP resource result')
    return {
      content: await resourceContent(
        serverName,
        result,
        context,
        server.sensitiveValues,
      ),
      isError: false,
    }
  }

  private resourceServer(name: string): ConnectedResourceServer {
    const server = this.resourceServers.get(name)
    if (server) return server
    if (this.statuses.get(name)?.status === 'failed') {
      throw new Error(`Server "${name}" is not connected`)
    }
    if (this.statuses.get(name)?.status === 'connected') {
      throw new Error(`Server "${name}" does not support resources`)
    }
    const available = [...this.statuses.keys()].join(', ')
    throw new Error(
      `Server "${name}" not found. Available servers: ${available}`,
    )
  }

  private async connectServer(
    serverName: string,
    config: McpServerConfig,
    additionalSensitiveValues: readonly string[] = [],
    expectedGeneration = this.generation,
  ): Promise<void> {
    this.assertOpenGeneration(expectedGeneration)
    this.statuses.set(serverName, { name: serverName, status: 'failed' })
    const environment = this.options.environment ?? process.env
    const launchConfig = deriveMcpServerConfig(config, environment)
    const sensitiveValues = configSensitiveValues(
      launchConfig,
      additionalSensitiveValues,
      environment,
    )
    this.serverSensitiveValues.set(serverName, sensitiveValues)
    const session = new McpServerSession({
      serverName,
      connectionTimeoutMs: this.timeouts.connectionTimeoutMs,
      toolTimeoutMs: this.timeouts.toolTimeoutMs,
      ...(this.options.signal ? { lifetimeSignal: this.options.signal } : {}),
      createTransport: async () => {
        const configRoot = this.options.configRoot ?? join(homedir(), '.praxis')
        return (await transport(
          serverName,
          launchConfig,
          this.options.cwd,
          configRoot,
          environment,
        )) as unknown as Transport
      },
      configureClient: (client) => {
        client.setRequestHandler(ElicitRequestSchema, async (request) => {
          if (!this.options.onElicitation) return { action: 'decline' }
          return (await this.options.onElicitation({
            serverName,
            message: redactSensitiveText(
              request.params.message,
              sensitiveValues,
            ),
            ...(request.params.mode ? { mode: request.params.mode } : {}),
            ...('url' in request.params
              ? {
                  url: redactSensitiveText(request.params.url, sensitiveValues),
                }
              : {}),
            ...('elicitationId' in request.params
              ? { elicitationId: request.params.elicitationId }
              : {}),
            ...('requestedSchema' in request.params
              ? {
                  requestedSchema: redactSensitiveValue(
                    request.params.requestedSchema,
                    sensitiveValues,
                  ),
                }
              : {}),
          })) as ElicitResult
        })
        client.setNotificationHandler(
          ElicitationCompleteNotificationSchema,
          async (notification) => {
            this.options.eventSink?.({
              type: 'elicitation-complete',
              mcpServerName: serverName,
              elicitationId: notification.params.elicitationId,
            })
          },
        )
      },
      onDisconnected: () => {
        if (this.closed || this.sessions.get(serverName) !== session) return
        this.removeServerPublication(serverName)
        this.statuses.set(serverName, { name: serverName, status: 'failed' })
        this.publishPrompts()
        this.publishInstructions()
      },
      onCatalogChanged: (catalog) => {
        if (
          this.closed ||
          expectedGeneration !== this.generation ||
          this.sessions.get(serverName) !== session
        )
          return
        this.publishCatalog(serverName, session, catalog, sensitiveValues)
      },
      onDiscoveryWarning: (kind, error) => {
        this.warnDiscovery(serverName, kind, error, sensitiveValues)
      },
    })
    this.sessions.set(serverName, session)
    try {
      await session.connect()
      this.statuses.set(serverName, {
        name: serverName,
        status: 'connected',
        statusDetail: 'connected',
      })
    } catch (error) {
      if (
        this.options.signal?.aborted ||
        this.closed ||
        expectedGeneration !== this.generation
      )
        throw error
      const detail = redactSensitiveText(
        error instanceof Error ? error.message : String(error),
        sensitiveValues,
      )
      const needsAuthentication =
        /(?:401|unauthori[sz]ed|not authenticated|oauth|authentication required)/iu.test(
          detail,
        )
      this.statuses.set(serverName, {
        name: serverName,
        status: needsAuthentication ? 'needs-authentication' : 'failed',
        statusDetail: detail,
        ...(needsAuthentication ? { authDetail: `failed: ${detail}` } : {}),
      })
      this.options.onWarning?.(
        `MCP server ${serverName} unavailable: ${detail}`,
      )
    }
  }

  private async invokePrompt(
    prompt: ConnectedPrompt,
    argumentsText: string,
    signal?: AbortSignal,
    toolResultDirectory?: string,
  ): Promise<ClaudeMcpPromptResult> {
    if (this.closed) throw new Error('MCP registry is closed')
    try {
      prompt = await this.ensurePromptConnected(prompt)
    } catch (error) {
      throw redactSensitiveError(error, prompt.sensitiveValues)
    }
    const values = argumentsText.split(' ')
    const argumentsRecord: Record<string, string> = {}
    const argumentCount = Math.min(
      prompt.rawArgumentNames.length,
      values.length,
    )
    for (let index = 0; index < argumentCount; index += 1) {
      const name = prompt.rawArgumentNames[index]
      const value = values[index]
      if (name !== undefined && value !== undefined) {
        argumentsRecord[name] = value
      }
    }
    let result
    try {
      result = await prompt.session.getPrompt(
        { name: prompt.rawPromptName, arguments: argumentsRecord },
        signal ?? this.options.signal,
      )
    } catch (error) {
      throw redactSensitiveError(error, prompt.sensitiveValues)
    }
    const promptResultDirectory =
      toolResultDirectory ?? (await this.promptResultDirectory())
    const converted = await mcpToolResult(
      prompt.serverName,
      { content: result.messages.map((message) => message.content) },
      {
        cwd: this.options.cwd,
        toolResultDirectory: promptResultDirectory,
        ...(signal ? { signal } : {}),
      },
      prompt.sensitiveValues,
    )
    return {
      text: converted.content,
      contentBlocks: converted.contentBlocks ?? [],
      images: converted.images ?? [],
    }
  }

  private async ensurePromptConnected(
    prompt: ConnectedPrompt,
    force = false,
  ): Promise<ConnectedPrompt> {
    const session = this.sessions.get(prompt.serverName)
    if (
      !force &&
      session === prompt.session &&
      session?.isConnected() &&
      this.statuses.get(prompt.serverName)?.status === 'connected'
    ) {
      return prompt
    }
    if (!session)
      throw new Error(`MCP server ${prompt.serverName} cannot reconnect`)
    await session.reconnect()
    const refreshed = this.promptServers
      .get(prompt.serverName)
      ?.find((candidate) => candidate.rawPromptName === prompt.rawPromptName)
    if (!refreshed) {
      throw new Error(
        `MCP prompt ${prompt.serverName}:${prompt.promptName} is unavailable after reconnect`,
      )
    }
    return refreshed
  }

  private async reconnectServer(serverName: string): Promise<void> {
    if (this.closed) throw new Error('MCP registry is closed')
    const session = this.sessions.get(serverName)
    if (!session) throw new Error(`MCP server ${serverName} cannot reconnect`)
    await session.reconnect()
  }

  private removeServerPublication(serverName: string): void {
    for (const [name, tool] of this.connectedTools) {
      if (tool.serverName === serverName) this.connectedTools.delete(name)
    }
    this.resourceServers.delete(serverName)
    this.promptServers.delete(serverName)
    this.serverCapabilities.delete(serverName)
    this.serverInstructions.delete(serverName)
  }

  private removeServerRoutes(serverName: string): void {
    for (const [name, tool] of this.toolRoutes) {
      if (tool.serverName === serverName) this.toolRoutes.delete(name)
    }
    this.resourceRoutes.delete(serverName)
  }

  private publishCatalog(
    serverName: string,
    session: McpServerSession,
    catalog: McpServerCatalog,
    sensitiveValues: readonly string[],
  ): void {
    const stagedTools = new Map<string, ConnectedTool>()
    for (const tool of catalog.tools) {
      const name = `mcp__${normalizeMcpName(serverName)}__${normalizeMcpName(tool.name)}`
      if (redactSensitiveText(name, sensitiveValues) !== name) {
        throw new Error('MCP tool name contains sensitive data')
      }
      if (
        stagedTools.has(name) ||
        [...this.connectedTools.entries()].some(
          ([existingName, existingTool]) =>
            existingName === name && existingTool.serverName !== serverName,
        )
      )
        throw new Error(`Duplicate MCP tool ${name}`)
      const inputIsValid = schedulingInputValidator(tool.inputSchema)
      const connectedTool: ConnectedTool = {
        session,
        serverName,
        toolName: tool.name,
        readOnly: tool.annotations?.readOnlyHint === true,
        ...(inputIsValid ? { schedulingInputIsValid: inputIsValid } : {}),
        sensitiveValues,
        definition: {
          name,
          description: capMcpToolDescription(
            redactSensitiveText(
              tool.description ?? `MCP tool ${tool.name} from ${serverName}`,
              sensitiveValues,
            ),
          ),
          inputSchema: redactSensitiveValue(tool.inputSchema, sensitiveValues),
        },
      }
      stagedTools.set(name, connectedTool)
    }
    const stagedResource = catalog.capabilities.includes('resources')
      ? { session, resources: catalog.resources, sensitiveValues }
      : undefined
    const stagedPrompts = catalog.capabilities.includes('prompts')
      ? catalog.prompts.map((prompt) => {
          const promptName = sanitizeMcpUnicode(prompt.name)
          return {
            session,
            serverName,
            rawPromptName: prompt.name,
            rawArgumentNames: (prompt.arguments ?? []).map(
              (argument) => argument.name,
            ),
            promptName,
            name: `mcp__${normalizeMcpName(serverName)}__${promptName}`,
            userFacingName: `${serverName}:${promptName} (MCP)`,
            description: redactSensitiveText(
              sanitizeMcpUnicode(prompt.description ?? ''),
              sensitiveValues,
            ),
            argumentNames: (prompt.arguments ?? []).map((argument) =>
              sanitizeMcpUnicode(argument.name),
            ),
            sensitiveValues,
          }
        })
      : []

    this.removeServerPublication(serverName)
    this.removeServerRoutes(serverName)
    for (const [name, tool] of stagedTools) {
      this.connectedTools.set(name, tool)
      this.toolRoutes.set(name, tool)
    }
    this.serverCapabilities.set(serverName, catalog.capabilities)
    if (catalog.instructions)
      this.serverInstructions.set(
        serverName,
        redactSensitiveText(catalog.instructions, sensitiveValues),
      )
    if (stagedResource) {
      this.resourceServers.set(serverName, stagedResource)
      this.resourceRoutes.set(serverName, stagedResource)
    }
    if (stagedPrompts.length > 0 || catalog.capabilities.includes('prompts'))
      this.promptServers.set(serverName, stagedPrompts)
    this.statuses.set(serverName, {
      name: serverName,
      status: 'connected',
      statusDetail: 'connected',
    })
    this.publishPrompts()
    this.publishInstructions()
  }

  private publishPrompts(): void {
    if (!this.closed) this.options.onPromptsChanged?.(this.prompts())
  }

  private publishInstructions(): void {
    if (!this.closed) this.options.onInstructionsChanged?.(this.instructions())
  }

  private assertOpenGeneration(expectedGeneration: number): void {
    if (this.closed || expectedGeneration !== this.generation) {
      throw new Error('MCP registry is closed')
    }
  }

  private trackPromptOperation<T>(operation: Promise<T>): Promise<T> {
    this.promptOperations.add(operation)
    const clear = () => this.promptOperations.delete(operation)
    void operation.then(clear, clear)
    return operation
  }

  private async promptResultDirectory(): Promise<string> {
    if (this.closed) throw new Error('MCP registry is closed')
    this.promptResultDirectoryPromise ??= mkdtemp(
      join(tmpdir(), 'praxis-mcp-prompts-'),
    )
    const directory = await this.promptResultDirectoryPromise
    if (this.closed) {
      await rm(directory, { recursive: true, force: true })
      throw new Error('MCP registry is closed')
    }
    return directory
  }

  private warnDiscovery(
    serverName: string,
    kind: 'tools' | 'resources' | 'prompts',
    error: unknown,
    sensitiveValues: readonly string[],
  ): void {
    this.options.onWarning?.(
      redactSensitiveText(
        `MCP server ${serverName} ${kind} unavailable: ${error instanceof Error ? error.message : String(error)}`,
        sensitiveValues,
      ),
    )
  }
}
