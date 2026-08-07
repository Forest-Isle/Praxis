import { randomBytes } from 'node:crypto'
import { mkdir, open, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'

import type { ClaudeJsonResource } from '../compatibility/claude/shared-resources.js'
import type {
  ModelToolCall,
  ModelToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolRegistry,
} from '../core/runtime.js'
import {
  redactSensitiveError,
  redactSensitiveText,
  redactSensitiveValue,
  sanitizeChildEnvironment,
  sensitiveEnvironmentValues,
} from '../platform/sensitive-data.js'
import {
  loadMcpOAuthProvider,
  mcpOAuthServerIdentity,
} from './claude-mcp-oauth.js'

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
}

interface ConnectedTool {
  client: Client
  toolName: string
  definition: ModelToolDefinition
  sensitiveValues: readonly string[]
}

interface ConnectedResourceServer {
  client: Client
  resources: readonly Record<string, unknown>[]
  sensitiveValues: readonly string[]
}

export interface ClaudeMcpServerStatus {
  name: string
  status: 'connected' | 'failed'
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
  resources: readonly ClaudeJsonResource[]
  cwd: string
  configRoot?: string
  onWarning?: (message: string) => void
  signal?: AbortSignal
}

const MAX_TOOL_PAGES = 100
const MAX_TOOLS = 10_000
const MAX_RESOURCE_PAGES = 100
const MAX_RESOURCES = 10_000
const MAX_RESOURCE_BYTES = 25 * 1024 * 1024
const DISCOVERY_TIMEOUT_MS = 10_000
const RESOURCE_TIMEOUT_MS = 30_000
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
  resources: readonly ClaudeJsonResource[],
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
      })
    }
  }
  return [...servers.values()]
}

export function validateClaudeMcpConfiguration(
  resources: readonly ClaudeJsonResource[],
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
) {
  if (config.type === 'stdio') {
    return new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: sanitizeChildEnvironment(config.env),
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

function configSensitiveValues(config: McpServerConfig): readonly string[] {
  return sensitiveEnvironmentValues(
    process.env,
    config.type === 'stdio' ? config.env : config.headers,
  )
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

function requestSignal(signal: AbortSignal | undefined, timeout: number) {
  const timeoutSignal = AbortSignal.timeout(timeout)
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
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
  for (let index = 0; index < result.contents.length; index += 1) {
    const item = result.contents[index]
    if (!isRecord(item) || typeof item.uri !== 'string') {
      throw new Error('Invalid MCP resource content')
    }
    if (typeof item.text === 'string') {
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
    const filePath = await writeResourceBlob(
      context.toolResultDirectory,
      bytes,
      resourceExtension(item.mimeType),
      index,
    )
    const mimeType =
      typeof item.mimeType === 'string'
        ? item.mimeType
        : 'application/octet-stream'
    contents.push({
      uri: item.uri,
      ...(typeof item.mimeType === 'string' ? { mimeType: item.mimeType } : {}),
      blobSavedTo: filePath,
      text: `[Resource from ${server} at ${item.uri}] Binary content (${mimeType}, ${bytes.length} bytes) saved to ${filePath}`,
    })
  }
  const serialized = JSON.stringify(
    redactSensitiveValue({ contents }, sensitiveValues),
  )
  if (Buffer.byteLength(serialized) > MAX_RESOURCE_BYTES) {
    throw new Error(`MCP resource result exceeded ${MAX_RESOURCE_BYTES} bytes`)
  }
  return serialized
}

export class ClaudeMcpToolRegistry implements ToolRegistry {
  private readonly tools = new Map<string, ConnectedTool>()
  private readonly resourceServers = new Map<string, ConnectedResourceServer>()
  private readonly statuses = new Map<string, ClaudeMcpServerStatus>()
  private readonly clients: Client[] = []
  private closed = false

  private constructor(private readonly options: ClaudeMcpToolRegistryOptions) {}

  static async connect(
    options: ClaudeMcpToolRegistryOptions,
  ): Promise<ClaudeMcpToolRegistry> {
    const registry = new ClaudeMcpToolRegistry(options)
    const ambientSensitiveValues = sensitiveEnvironmentValues(process.env)
    const warn = (message: string) =>
      options.onWarning?.(redactSensitiveText(message, ambientSensitiveValues))
    try {
      for (const server of configuredServers(options.resources, warn)) {
        registry.statuses.set(server.name, {
          name: server.name,
          status: 'failed',
        })
        let config
        try {
          config = parseServerConfig(server.name, server.value, server.path)
        } catch (error) {
          warn(
            `MCP server ${server.name} unavailable: ${error instanceof Error ? error.message : String(error)}`,
          )
          continue
        }
        await registry.connectServer(server.name, config)
      }
    } catch (error) {
      await registry.close()
      throw error
    }
    return registry
  }

  definitions(): readonly ModelToolDefinition[] {
    return [
      ...this.options.base.definitions(),
      ...[...this.tools.values()].map((tool) => tool.definition),
      ...(this.resourceServers.size > 0 ? MCP_RESOURCE_TOOL_DEFINITIONS : []),
    ]
  }

  serverStatuses(): readonly ClaudeMcpServerStatus[] {
    return [...this.statuses.values()]
  }

  async prepare(
    call: ModelToolCall,
    context: ToolExecutionContext,
  ): Promise<ModelToolCall> {
    return this.tools.has(call.name) ||
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
    const tool = this.tools.get(call.name)
    if (!tool) return this.options.base.execute(call, context)
    let result
    try {
      result = await tool.client.callTool(
        { name: tool.toolName, arguments: call.input },
        undefined,
        context.signal ? { signal: context.signal } : undefined,
      )
    } catch (error) {
      throw redactSensitiveError(error, tool.sensitiveValues)
    }
    if (!isRecord(result)) throw new Error('Invalid MCP tool result')
    return {
      content: toolContent(result, tool.sensitiveValues),
      isError: result.isError === true,
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await Promise.allSettled(this.clients.map((client) => client.close()))
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
    return {
      content:
        resources.length > 0 ? JSON.stringify(resources) : NO_MCP_RESOURCES,
      isError: false,
    }
  }

  private async readResource(
    input: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const serverName = requiredString(input, 'server')
    const uri = requiredString(input, 'uri')
    const server = this.resourceServer(serverName)
    let result
    try {
      result = await server.client.readResource(
        { uri },
        {
          timeout: RESOURCE_TIMEOUT_MS,
          signal: requestSignal(context.signal, RESOURCE_TIMEOUT_MS),
        },
      )
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
  ): Promise<void> {
    const client = new Client({ name: 'praxis', version: '0.1.0' })
    const sensitiveValues = configSensitiveValues(config)
    const discoverySignal = requestSignal(
      this.options.signal,
      DISCOVERY_TIMEOUT_MS,
    )
    try {
      const configRoot =
        this.options.configRoot ??
        process.env.CLAUDE_CONFIG_DIR ??
        join(homedir(), '.claude')
      await client.connect(
        (await transport(
          serverName,
          config,
          this.options.cwd,
          configRoot,
        )) as Transport,
        {
          timeout: DISCOVERY_TIMEOUT_MS,
          signal: discoverySignal,
        },
      )
      const capabilities = client.getServerCapabilities()
      const tools = capabilities?.tools
        ? await this.discoverTools(client, serverName, sensitiveValues)
        : []
      const resources = capabilities?.resources
        ? await this.discoverResources(client, serverName, sensitiveValues)
        : []
      const connectedTools = new Map<string, ConnectedTool>()
      for (const tool of tools) {
        const name = `mcp__${serverName}__${tool.name}`
        if (redactSensitiveText(name, sensitiveValues) !== name) {
          throw new Error('MCP tool name contains sensitive data')
        }
        if (this.tools.has(name) || connectedTools.has(name)) {
          throw new Error(`Duplicate MCP tool ${name}`)
        }
        connectedTools.set(name, {
          client,
          toolName: tool.name,
          sensitiveValues,
          definition: {
            name,
            description: redactSensitiveText(
              tool.description ?? `MCP tool ${tool.name} from ${serverName}`,
              sensitiveValues,
            ),
            inputSchema: redactSensitiveValue(
              tool.inputSchema,
              sensitiveValues,
            ),
          },
        })
      }
      this.clients.push(client)
      for (const [name, tool] of connectedTools) this.tools.set(name, tool)
      if (capabilities?.resources) {
        this.resourceServers.set(serverName, {
          client,
          resources,
          sensitiveValues,
        })
      }
      this.statuses.set(serverName, { name: serverName, status: 'connected' })
    } catch (error) {
      await client.close().catch(() => undefined)
      if (this.options.signal?.aborted) throw error
      this.options.onWarning?.(
        redactSensitiveText(
          `MCP server ${serverName} unavailable: ${error instanceof Error ? error.message : String(error)}`,
          sensitiveValues,
        ),
      )
    }
  }

  private async discoverTools(
    client: Client,
    serverName: string,
    sensitiveValues: readonly string[],
  ) {
    try {
      const tools = []
      let cursor: string | undefined
      const cursors = new Set<string>()
      let pages = 0
      do {
        if (cursor && cursors.has(cursor)) {
          throw new Error('Repeated MCP tools cursor')
        }
        if (cursor) cursors.add(cursor)
        if (++pages > MAX_TOOL_PAGES) {
          throw new Error('MCP tools page limit exceeded')
        }
        const page = await client.listTools(cursor ? { cursor } : undefined, {
          timeout: DISCOVERY_TIMEOUT_MS,
          signal: requestSignal(this.options.signal, DISCOVERY_TIMEOUT_MS),
        })
        tools.push(...page.tools)
        if (tools.length > MAX_TOOLS) {
          throw new Error('MCP tool limit exceeded')
        }
        cursor = page.nextCursor
      } while (cursor)
      return tools
    } catch (error) {
      if (this.options.signal?.aborted) throw error
      this.warnDiscovery(serverName, 'tools', error, sensitiveValues)
      return []
    }
  }

  private async discoverResources(
    client: Client,
    serverName: string,
    sensitiveValues: readonly string[],
  ): Promise<readonly Record<string, unknown>[]> {
    try {
      const resources: Record<string, unknown>[] = []
      let cursor: string | undefined
      const cursors = new Set<string>()
      let pages = 0
      do {
        if (cursor && cursors.has(cursor)) {
          throw new Error('Repeated MCP resources cursor')
        }
        if (cursor) cursors.add(cursor)
        if (++pages > MAX_RESOURCE_PAGES) {
          throw new Error('MCP resources page limit exceeded')
        }
        const page = await client.listResources(
          cursor ? { cursor } : undefined,
          {
            timeout: DISCOVERY_TIMEOUT_MS,
            signal: requestSignal(this.options.signal, DISCOVERY_TIMEOUT_MS),
          },
        )
        resources.push(...page.resources.map((resource) => ({ ...resource })))
        if (resources.length > MAX_RESOURCES) {
          throw new Error('MCP resource limit exceeded')
        }
        cursor = page.nextCursor
      } while (cursor)
      return resources
    } catch (error) {
      if (this.options.signal?.aborted) throw error
      this.warnDiscovery(serverName, 'resources', error, sensitiveValues)
      return []
    }
  }

  private warnDiscovery(
    serverName: string,
    kind: 'tools' | 'resources',
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
