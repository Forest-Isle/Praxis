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
}

export interface ClaudeMcpToolRegistryOptions {
  base: ToolRegistry
  resources: readonly ClaudeJsonResource[]
  cwd: string
  onWarning?: (message: string) => void
  signal?: AbortSignal
}

const MAX_TOOL_PAGES = 100
const MAX_TOOLS = 10_000
const DISCOVERY_TIMEOUT_MS = 10_000

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

function transport(config: McpServerConfig, cwd: string) {
  if (config.type === 'stdio') {
    return new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: { ...process.env, ...config.env } as Record<string, string>,
      cwd: config.cwd ?? cwd,
      stderr: 'pipe',
    })
  }
  const requestInit = { headers: config.headers }
  return config.type === 'sse'
    ? new SSEClientTransport(new URL(config.url), { requestInit })
    : new StreamableHTTPClientTransport(new URL(config.url), { requestInit })
}

function toolContent(result: Record<string, unknown>): string {
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
  return parts.join('\n')
}

export class ClaudeMcpToolRegistry implements ToolRegistry {
  private readonly tools = new Map<string, ConnectedTool>()
  private readonly clients: Client[] = []
  private closed = false

  private constructor(private readonly options: ClaudeMcpToolRegistryOptions) {}

  static async connect(
    options: ClaudeMcpToolRegistryOptions,
  ): Promise<ClaudeMcpToolRegistry> {
    const registry = new ClaudeMcpToolRegistry(options)
    try {
      for (const server of configuredServers(
        options.resources,
        options.onWarning,
      )) {
        let config
        try {
          config = parseServerConfig(server.name, server.value, server.path)
        } catch (error) {
          options.onWarning?.(
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
    ]
  }

  async prepare(
    call: ModelToolCall,
    context: ToolExecutionContext,
  ): Promise<ModelToolCall> {
    return this.tools.has(call.name)
      ? call
      : this.options.base.prepare(call, context)
  }

  async execute(
    call: ModelToolCall,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const tool = this.tools.get(call.name)
    if (!tool) return this.options.base.execute(call, context)
    const result = await tool.client.callTool(
      { name: tool.toolName, arguments: call.input },
      undefined,
      context.signal ? { signal: context.signal } : undefined,
    )
    if (!isRecord(result)) throw new Error('Invalid MCP tool result')
    return {
      content: toolContent(result),
      isError: result.isError === true,
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await Promise.allSettled(this.clients.map((client) => client.close()))
  }

  private async connectServer(
    serverName: string,
    config: McpServerConfig,
  ): Promise<void> {
    const client = new Client({ name: 'praxis', version: '0.1.0' })
    const timeoutSignal = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)
    const discoverySignal = this.options.signal
      ? AbortSignal.any([this.options.signal, timeoutSignal])
      : timeoutSignal
    try {
      await client.connect(transport(config, this.options.cwd) as Transport, {
        timeout: DISCOVERY_TIMEOUT_MS,
        signal: discoverySignal,
      })
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
          signal: discoverySignal,
        })
        tools.push(...page.tools)
        if (tools.length > MAX_TOOLS) throw new Error('MCP tool limit exceeded')
        cursor = page.nextCursor
      } while (cursor)
      const connectedTools = new Map<string, ConnectedTool>()
      for (const tool of tools) {
        const name = `mcp__${serverName}__${tool.name}`
        if (this.tools.has(name) || connectedTools.has(name)) {
          throw new Error(`Duplicate MCP tool ${name}`)
        }
        connectedTools.set(name, {
          client,
          toolName: tool.name,
          definition: {
            name,
            description:
              tool.description ?? `MCP tool ${tool.name} from ${serverName}`,
            inputSchema: tool.inputSchema,
          },
        })
      }
      this.clients.push(client)
      for (const [name, tool] of connectedTools) this.tools.set(name, tool)
    } catch (error) {
      await client.close().catch(() => undefined)
      if (this.options.signal?.aborted) throw error
      this.options.onWarning?.(
        `MCP server ${serverName} unavailable: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
}
