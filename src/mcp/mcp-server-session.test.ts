import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_MCP_CONNECTION_TIMEOUT_MS,
  DEFAULT_MCP_TOOL_TIMEOUT_MS,
  McpServerSession,
  parseMcpSessionTimeouts,
} from './mcp-server-session.js'

const execFileAsync = promisify(execFile)

function transport(): Transport {
  return {
    start: async () => undefined,
    close: async () => undefined,
    send: async () => undefined,
  }
}

function sessionOptions(
  overrides: Partial<ConstructorParameters<typeof McpServerSession>[0]> = {},
) {
  return {
    serverName: 'fixture',
    connectionTimeoutMs: 100,
    toolTimeoutMs: 25,
    createTransport: async () => transport(),
    onDisconnected: () => undefined,
    onCatalogChanged: () => undefined,
    onDiscoveryWarning: () => undefined,
    ...overrides,
  }
}

async function configuredSession(options = sessionOptions()) {
  let client: Client | undefined
  const session = new McpServerSession({
    ...options,
    configureClient: (configured) => {
      client = configured
      vi.spyOn(configured, 'connect').mockResolvedValue(undefined)
      vi.spyOn(configured, 'getServerCapabilities').mockReturnValue({
        tools: {},
      })
      vi.spyOn(configured, 'listTools').mockResolvedValue({
        tools: [{ name: 'echo', inputSchema: { type: 'object' } }],
      })
      options.configureClient?.(configured)
    },
  })
  await session.connect()
  if (!client) throw new Error('fixture client was not configured')
  return { session, client }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('McpServerSession', () => {
  it('owns and closes a resolved transport when client configuration throws', async () => {
    let closed = 0
    const value = transport()
    value.close = async () => {
      closed += 1
    }
    const session = new McpServerSession(
      sessionOptions({
        createTransport: async () => value,
        configureClient: () => {
          throw new Error('configuration failed')
        },
      }),
    )
    await expect(session.connect()).rejects.toThrow('configuration failed')
    await vi.waitFor(() => expect(closed).toBe(1))
    await session.close()
  })

  it('rejects and never publishes when transport closes during discovery', async () => {
    let value: Transport | undefined
    let closed = 0
    let publications = 0
    const session = new McpServerSession(
      sessionOptions({
        createTransport: async () => {
          value = transport()
          value.close = async () => {
            closed += 1
          }
          return value
        },
        configureClient: (client) => {
          vi.spyOn(client, 'connect').mockResolvedValue(undefined)
          vi.spyOn(client, 'getServerCapabilities').mockReturnValue({
            tools: {},
          })
          vi.spyOn(client, 'listTools').mockImplementation(async () => {
            value?.onclose?.()
            return {
              tools: [{ name: 'late', inputSchema: { type: 'object' } }],
            }
          })
        },
        onCatalogChanged: () => {
          publications += 1
        },
      }),
    )
    await expect(session.connect()).rejects.toThrow(
      'MCP server fixture disconnected during connection',
    )
    expect(publications).toBe(0)
    await vi.waitFor(() => expect(closed).toBe(1))
    expect(session.catalog()).toBeUndefined()
    await session.close()
  })

  it('parses defaults and strict positive safe-integer overrides for both bounds', () => {
    expect(parseMcpSessionTimeouts({})).toEqual({
      connectionTimeoutMs: DEFAULT_MCP_CONNECTION_TIMEOUT_MS,
      toolTimeoutMs: DEFAULT_MCP_TOOL_TIMEOUT_MS,
    })
    expect(
      parseMcpSessionTimeouts({ MCP_TIMEOUT: '12', MCP_TOOL_TIMEOUT: '34' }),
    ).toEqual({ connectionTimeoutMs: 12, toolTimeoutMs: 34 })
    for (const name of ['MCP_TIMEOUT', 'MCP_TOOL_TIMEOUT']) {
      for (const value of ['', '0', '-1', '1.5', '1e3', '9007199254740992']) {
        expect(() => parseMcpSessionTimeouts({ [name]: value })).toThrow(name)
      }
    }
  })

  it('keeps an idle child alive until a hung transport reaches the typed timeout', async () => {
    const moduleUrl = JSON.stringify(
      new URL('./mcp-server-session.ts', import.meta.url).href,
    )
    const source = `
      const { McpServerSession } = await import(${moduleUrl})
      const session = new McpServerSession({
        serverName: 'child', connectionTimeoutMs: 20, toolTimeoutMs: 20,
        createTransport: () => new Promise(() => {}), onDisconnected() {},
        onCatalogChanged() {}, onDiscoveryWarning() {},
      })
      try { await session.connect() } catch (error) {
        process.stdout.write(error.message)
      }
    `
    const { stdout } = await execFileAsync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', source],
      { cwd: process.cwd(), timeout: 2_000 },
    )
    expect(stdout).toContain('MCP server child connection timed out after 20ms')
  })

  it('preserves lifetime cancellation instead of classifying it as timeout', async () => {
    const lifetime = new AbortController()
    const reason = new Error('lifetime stopped')
    const session = new McpServerSession(
      sessionOptions({
        lifetimeSignal: lifetime.signal,
        createTransport: () => new Promise(() => undefined),
      }),
    )
    const connecting = session.connect()
    lifetime.abort(reason)
    await expect(connecting).rejects.toBe(reason)
    await session.close()
  })

  it('uses one absolute deadline across discovery pages', async () => {
    vi.useFakeTimers()
    let calls = 0
    const session = new McpServerSession(
      sessionOptions({
        connectionTimeoutMs: 40,
        configureClient: (client) => {
          vi.spyOn(client, 'connect').mockResolvedValue(undefined)
          vi.spyOn(client, 'getServerCapabilities').mockReturnValue({
            tools: {},
          })
          vi.spyOn(client, 'listTools').mockImplementation(async () => {
            calls += 1
            await new Promise((resolve) => setTimeout(resolve, 25))
            return {
              tools: [],
              ...(calls === 1 ? { nextCursor: 'next' } : {}),
            }
          })
        },
      }),
    )
    const connecting = session.connect()
    const failed = expect(connecting).rejects.toThrow(
      'MCP server fixture connection timed out after 40ms',
    )
    await vi.advanceTimersByTimeAsync(40)
    await failed
    expect(calls).toBe(2)
    await session.close()
  })

  it('times out a tool with the Praxis message and invokes the SDK once', async () => {
    const { session, client } = await configuredSession()
    const callTool = vi
      .spyOn(client, 'callTool')
      .mockImplementation((() => new Promise(() => undefined)) as never)
    await expect(
      session.callTool({ name: 'echo', arguments: {} }),
    ).rejects.toThrow('MCP tool call fixture:echo timed out after 25ms')
    expect(callTool).toHaveBeenCalledTimes(1)
    await session.close()
  })

  it('does not dispatch a tool when the caller is already aborted', async () => {
    const { session, client } = await configuredSession()
    const callTool = vi.spyOn(client, 'callTool')
    const controller = new AbortController()
    const reason = new Error('caller stopped')
    controller.abort(reason)
    await expect(
      session.callTool({ name: 'echo', arguments: {} }, controller.signal),
    ).rejects.toBe(reason)
    expect(callTool).not.toHaveBeenCalled()
    await session.close()
  })

  it('preserves a caller abort after dispatch and never retries the tool', async () => {
    const { session, client } = await configuredSession()
    const callTool = vi
      .spyOn(client, 'callTool')
      .mockImplementation((() => new Promise(() => undefined)) as never)
    const controller = new AbortController()
    const reason = new Error('caller stopped')
    const calling = session.callTool(
      { name: 'echo', arguments: {} },
      controller.signal,
    )
    await Promise.resolve()
    controller.abort(reason)
    await expect(calling).rejects.toBe(reason)
    expect(callTool).toHaveBeenCalledTimes(1)
    await session.close()
  })

  it('shares reconnect callers and applies exactly the 250/500ms backoff schedule', async () => {
    vi.useFakeTimers()
    let creations = 0
    const session = new McpServerSession(
      sessionOptions({
        connectionTimeoutMs: 10,
        createTransport: vi.fn(async () => {
          creations += 1
          throw new Error(`failure ${creations}`)
        }),
      }),
    )
    const first = session.reconnect()
    const second = session.reconnect()
    expect(second).toBe(first)
    await Promise.resolve()
    expect(creations).toBe(1)
    await vi.advanceTimersByTimeAsync(249)
    expect(creations).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    await Promise.resolve()
    expect(creations).toBe(2)
    await vi.advanceTimersByTimeAsync(499)
    expect(creations).toBe(2)
    await vi.advanceTimersByTimeAsync(1)
    await expect(first).rejects.toThrow('failure 3')
    expect(creations).toBe(3)
    await session.close()
  })

  it('hides state after transport close and allows a later invocation to reconnect', async () => {
    let created = 0
    const transports: Transport[] = []
    const session = new McpServerSession(
      sessionOptions({
        createTransport: async () => {
          const value = transport()
          transports.push(value)
          created += 1
          return value
        },
        configureClient: (client) => {
          vi.spyOn(client, 'connect').mockResolvedValue(undefined)
          vi.spyOn(client, 'getServerCapabilities').mockReturnValue({
            tools: {},
          })
          vi.spyOn(client, 'listTools').mockResolvedValue({
            tools: [{ name: 'echo', inputSchema: { type: 'object' } }],
          })
          vi.spyOn(client, 'callTool').mockResolvedValue({ content: [] })
        },
      }),
    )
    await session.connect()
    expect(session.isConnected()).toBe(true)
    const initialTransport = transports[0]
    if (!initialTransport) throw new Error('initial transport missing')
    initialTransport.onclose?.()
    expect(session.isConnected()).toBe(false)
    expect(session.catalog()).toBeUndefined()
    await session.callTool({ name: 'echo', arguments: {} })
    expect(created).toBe(2)
    await session.close()
  })

  it('does not replay an already-dispatched failed tool after disconnect', async () => {
    let creations = 0
    let dispatches = 0
    const transports: Transport[] = []
    const clients: Client[] = []
    const session = new McpServerSession(
      sessionOptions({
        createTransport: async () => {
          const value = transport()
          transports.push(value)
          creations += 1
          return value
        },
        configureClient: (client) => {
          const index = clients.length
          clients.push(client)
          vi.spyOn(client, 'connect').mockResolvedValue(undefined)
          vi.spyOn(client, 'getServerCapabilities').mockReturnValue({
            tools: {},
          })
          vi.spyOn(client, 'listTools').mockResolvedValue({
            tools: [{ name: 'echo', inputSchema: { type: 'object' } }],
          })
          vi.spyOn(client, 'callTool').mockImplementation(async () => {
            dispatches += 1
            if (index === 0) {
              transports[index]?.onclose?.()
              throw new Error('connection closed')
            }
            return { content: [] }
          })
        },
      }),
    )
    await session.connect()
    await expect(
      session.callTool({ name: 'echo', arguments: {} }),
    ).rejects.toThrow('connection closed')
    expect(creations).toBe(1)
    expect(dispatches).toBe(1)
    await expect(
      session.callTool({ name: 'echo', arguments: {} }),
    ).resolves.toEqual({ content: [] })
    expect(creations).toBe(2)
    expect(dispatches).toBe(2)
    await session.close()
  })

  it('closes idempotently within the bound during a hung connect and contains late transport', async () => {
    vi.useFakeTimers()
    let lateClose = 0
    let resolveTransport!: (value: Transport) => void
    const session = new McpServerSession(
      sessionOptions({
        connectionTimeoutMs: 20,
        createTransport: () =>
          new Promise<Transport>((resolve) => {
            resolveTransport = resolve
          }),
      }),
    )
    const connecting = session.connect()
    const failed = expect(connecting).rejects.toThrow('MCP session is closed')
    const closing = session.close()
    expect(session.close()).toBe(closing)
    await vi.advanceTimersByTimeAsync(20)
    await closing
    resolveTransport({
      ...transport(),
      close: async () => {
        lateClose += 1
      },
    })
    await failed
    expect(lateClose).toBe(1)
    expect(session.catalog()).toBeUndefined()
  })

  it('drains pressured stdio stderr without echoing it and still discovers', async () => {
    const marker = 'PRAXIS_STDERR_PRESSURE_MARKER'
    const source = `
      const { Server } = await import('@modelcontextprotocol/sdk/server/index.js')
      const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js')
      const { ListToolsRequestSchema } = await import('@modelcontextprotocol/sdk/types.js')
      const server = new Server({name: 'stdio-fixture', version: '1.0.0'}, {capabilities: {tools: {}}})
      server.setRequestHandler(ListToolsRequestSchema, async () => ({tools: [{name: 'echo', inputSchema: {type: 'object'}}]}))
      const stderrPayload = 'x'.repeat(1024 * 1024) + ${JSON.stringify(marker)}
      if (!process.stderr.write(stderrPayload)) {
        await new Promise((resolve) => process.stderr.once('drain', resolve))
      }
      await server.connect(new StdioServerTransport())
    `
    const stderrWrite = vi.spyOn(process.stderr, 'write')
    const session = new McpServerSession({
      serverName: 'stdio-fixture',
      connectionTimeoutMs: 2_000,
      toolTimeoutMs: 25,
      createTransport: async () => {
        const value = new StdioClientTransport({
          command: process.execPath,
          args: ['--import', 'tsx', '--input-type=module', '--eval', source],
          stderr: 'pipe',
        })
        return value
      },
      onDisconnected: () => undefined,
      onCatalogChanged: () => undefined,
      onDiscoveryWarning: () => undefined,
    })
    await session.connect()
    expect(session.catalog()?.tools.map((tool) => tool.name)).toEqual(['echo'])
    expect(stderrWrite).not.toHaveBeenCalledWith(
      expect.stringContaining(marker),
    )
    await session.close()
  })
})
