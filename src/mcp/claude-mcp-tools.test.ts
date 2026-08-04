import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ToolRegistry } from '../core/runtime.js'
import { ClaudeMcpToolRegistry } from './claude-mcp-tools.js'

const roots: string[] = []

const base: ToolRegistry = {
  definitions: () => [
    { name: 'Read', description: 'read', inputSchema: { type: 'object' } },
  ],
  prepare: async (call) => call,
  execute: async () => ({ content: 'base', isError: false }),
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  )
})

describe('ClaudeMcpToolRegistry', () => {
  it('discovers and calls layered stdio and HTTP tools', async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'praxis-mcp-tools-')),
    )
    roots.push(root)
    const serverScript = join(root, 'stdio-server.mjs')
    await writeFile(
      serverScript,
      `let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffer += chunk
  while (buffer.includes('\\n')) {
    const newline = buffer.indexOf('\\n')
    const line = buffer.slice(0, newline)
    buffer = buffer.slice(newline + 1)
    if (!line.trim()) continue
    const request = JSON.parse(line)
    if (request.id === undefined) continue
    const result = request.method === 'initialize'
      ? { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'stdio-fixture', version: '1' } }
      : request.method === 'tools/list'
        ? { tools: [{ name: 'marker', description: 'stdio marker', inputSchema: { type: 'object' } }] }
        : { content: [{ type: 'text', text: process.env.MARKER + ':' + process.cwd() }] }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n')
  }
})
`,
    )

    const http = createServer(async (request, response) => {
      let body = ''
      request.setEncoding('utf8')
      for await (const chunk of request) body += chunk
      if (!body) {
        response.writeHead(204).end()
        return
      }
      const message = JSON.parse(body)
      if (message.id === undefined) {
        response.writeHead(202).end()
        return
      }
      const result =
        message.method === 'initialize'
          ? {
              protocolVersion: message.params.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: 'http-fixture', version: '1' },
            }
          : message.method === 'tools/list'
            ? {
                tools: [
                  {
                    name: 'marker',
                    description: 'http marker',
                    inputSchema: { type: 'object' },
                  },
                ],
              }
            : { content: [{ type: 'text', text: request.headers['x-test'] }] }
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
    })
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject)
      http.listen(0, '127.0.0.1', resolve)
    })
    const address = http.address()
    if (!address || typeof address === 'string') throw new Error('no address')
    const warning = vi.fn()

    const registry = await ClaudeMcpToolRegistry.connect({
      base,
      cwd: root,
      onWarning: warning,
      resources: [
        { path: '/broken.json', scope: 'user', value: { mcpServers: [] } },
        {
          path: '/user.json',
          scope: 'user',
          value: {
            mcpServers: {
              stdio: {
                command: process.execPath,
                args: [serverScript],
                env: { MARKER: 'STDIO' },
              },
            },
          },
        },
        {
          path: '/project.json',
          scope: 'project',
          value: {
            mcpServers: {
              http: {
                type: 'http',
                url: `http://127.0.0.1:${address.port}/mcp`,
                headers: { 'X-Test': 'HTTP' },
              },
            },
          },
        },
      ],
    })

    try {
      expect(warning).toHaveBeenCalledWith(
        'Invalid Claude MCP resource: /broken.json',
      )
      expect(registry.definitions().map((tool) => tool.name)).toEqual([
        'Read',
        'mcp__stdio__marker',
        'mcp__http__marker',
      ])
      await expect(
        registry.execute(
          { id: '1', name: 'mcp__stdio__marker', input: {} },
          { cwd: root },
        ),
      ).resolves.toEqual({ content: `STDIO:${root}`, isError: false })
      await expect(
        registry.execute(
          { id: '2', name: 'mcp__http__marker', input: {} },
          { cwd: root },
        ),
      ).resolves.toEqual({ content: 'HTTP', isError: false })
    } finally {
      await registry.close()
      await new Promise<void>((resolve, reject) =>
        http.close((error) => (error ? reject(error) : resolve())),
      )
    }
  })

  it('uses later scopes and skips unavailable servers with a warning', async () => {
    const warning = vi.fn()
    const secret = 'mcp-warning-secret-canary'
    const registry = await ClaudeMcpToolRegistry.connect({
      base,
      cwd: '/tmp',
      onWarning: warning,
      resources: [
        {
          path: '/user.json',
          scope: 'user',
          value: {
            mcpServers: {
              fixture: { type: 'websocket', command: 'user-command' },
            },
          },
        },
        {
          path: '/local.json',
          scope: 'local',
          value: {
            mcpServers: {
              fixture: {
                command: secret,
                env: { MCP_API_KEY: secret },
              },
            },
          },
        },
      ],
    })

    expect(registry.definitions()).toEqual(base.definitions())
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('MCP server fixture unavailable'),
    )
    expect(JSON.stringify(warning.mock.calls)).toContain('[REDACTED]')
    expect(JSON.stringify(warning.mock.calls)).not.toContain(secret)
    await registry.close()
  })

  it('isolates ambient credentials and redacts explicitly authorized stdio credentials', async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'praxis-mcp-environment-')),
    )
    roots.push(root)
    const serverScript = join(root, 'environment-server.mjs')
    await writeFile(
      serverScript,
      `let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffer += chunk
  while (buffer.includes('\\n')) {
    const newline = buffer.indexOf('\\n')
    const line = buffer.slice(0, newline)
    buffer = buffer.slice(newline + 1)
    if (!line.trim()) continue
    const request = JSON.parse(line)
    if (request.id === undefined) continue
    const result = request.method === 'initialize'
      ? { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'environment-fixture', version: '1' } }
      : request.method === 'tools/list'
        ? { tools: [{ name: 'environment', description: process.env.MCP_API_KEY, inputSchema: { type: 'object', description: process.env.MCP_API_KEY } }, { name: 'failure', inputSchema: { type: 'object' } }] }
        : { content: [{ type: 'text', text: JSON.stringify({ ambient: process.env.PRAXIS_API_KEY ?? 'missing', explicit: process.env.MCP_API_KEY }) }] }
    const response = request.method === 'tools/call' && request.params.name === 'failure'
      ? { jsonrpc: '2.0', id: request.id, error: { code: -32000, message: process.env.MCP_API_KEY } }
      : { jsonrpc: '2.0', id: request.id, result }
    process.stdout.write(JSON.stringify(response) + '\\n')
  }
})
`,
    )
    const ambientVariable = 'PRAXIS_API_KEY'
    const previous = process.env[ambientVariable]
    process.env[ambientVariable] = 'ambient-mcp-secret-canary'
    const explicitSecret = 'explicit-mcp-secret-canary'
    let registry: ClaudeMcpToolRegistry | undefined

    try {
      registry = await ClaudeMcpToolRegistry.connect({
        base,
        cwd: root,
        resources: [
          {
            path: '/settings.json',
            scope: 'user',
            value: {
              mcpServers: {
                environment: {
                  command: process.execPath,
                  args: [serverScript],
                  env: { MCP_API_KEY: explicitSecret },
                },
              },
            },
          },
        ],
      })

      const definition = registry
        .definitions()
        .find((tool) => tool.name === 'mcp__environment__environment')
      expect(JSON.stringify(definition)).toContain('[REDACTED]')
      expect(JSON.stringify(definition)).not.toContain(explicitSecret)

      await expect(
        registry.execute(
          {
            id: 'environment',
            name: 'mcp__environment__environment',
            input: {},
          },
          { cwd: root },
        ),
      ).resolves.toEqual({
        content: JSON.stringify({
          ambient: 'missing',
          explicit: '[REDACTED]',
        }),
        isError: false,
      })
      const error = await registry
        .execute(
          { id: 'failure', name: 'mcp__environment__failure', input: {} },
          { cwd: root },
        )
        .then(
          () => new Error('expected MCP failure'),
          (failure: unknown) => failure,
        )
      expect(String(error)).toContain('[REDACTED]')
      expect(String(error)).not.toContain(explicitSecret)
    } finally {
      await registry?.close()
      if (previous === undefined) delete process.env[ambientVariable]
      else process.env[ambientVariable] = previous
    }
  })

  it('redacts sensitive HTTP headers returned by MCP tools', async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'praxis-mcp-http-secret-')),
    )
    roots.push(root)
    const secret = 'http-header-secret-canary'
    const http = createServer(async (request, response) => {
      let body = ''
      request.setEncoding('utf8')
      for await (const chunk of request) body += chunk
      if (!body) {
        response.writeHead(204).end()
        return
      }
      const message = JSON.parse(body)
      if (message.id === undefined) {
        response.writeHead(202).end()
        return
      }
      const result =
        message.method === 'initialize'
          ? {
              protocolVersion: message.params.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: 'http-secret-fixture', version: '1' },
            }
          : message.method === 'tools/list'
            ? { tools: [{ name: 'header', inputSchema: { type: 'object' } }] }
            : {
                content: [
                  { type: 'text', text: request.headers.authorization },
                ],
              }
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
    })
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject)
      http.listen(0, '127.0.0.1', resolve)
    })
    const address = http.address()
    if (!address || typeof address === 'string') throw new Error('no address')
    let registry: ClaudeMcpToolRegistry | undefined

    try {
      registry = await ClaudeMcpToolRegistry.connect({
        base,
        cwd: root,
        resources: [
          {
            path: '/settings.json',
            scope: 'user',
            value: {
              mcpServers: {
                secret: {
                  type: 'http',
                  url: `http://127.0.0.1:${address.port}/mcp`,
                  headers: { Authorization: `Bearer ${secret}` },
                },
              },
            },
          },
        ],
      })
      await expect(
        registry.execute(
          { id: 'header', name: 'mcp__secret__header', input: {} },
          { cwd: root },
        ),
      ).resolves.toEqual({ content: '[REDACTED]', isError: false })
    } finally {
      await registry?.close()
      await new Promise<void>((resolve, reject) =>
        http.close((error) => (error ? reject(error) : resolve())),
      )
    }
  })
})
