import {
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { RuntimeEvent, ToolRegistry } from '../core/runtime.js'
import { ClaudeMcpOAuthStore } from './claude-mcp-oauth.js'
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
  vi.unstubAllEnvs()
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  )
})

describe('ClaudeMcpToolRegistry', () => {
  it('routes MCP elicitation requests and completion notifications', async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'praxis-mcp-elicitation-')),
    )
    roots.push(root)
    const serverScript = join(root, 'elicitation-server.mjs')
    await writeFile(
      serverScript,
      `let buffer = ''
let sent = false
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
      ? { protocolVersion: request.params.protocolVersion, capabilities: { tools: {}, elicitation: { form: {}, url: {} } }, serverInfo: { name: 'elicitation-fixture', version: '1' } }
      : request.method === 'tools/list'
        ? { tools: [] }
        : { content: [{ type: 'text', text: 'unused' }] }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n')
    if (request.method === 'initialize' && !sent) {
      sent = true
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 91, method: 'elicitation/create', params: { mode: 'form', message: 'Provide ' + process.argv[2], requestedSchema: { type: 'object', properties: { code: { type: 'string', description: process.argv[2] } } } } }) + '\\n')
    }
    if (request.id === 91) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 92, method: 'elicitation/create', params: { mode: 'url', message: 'Open ' + process.argv[2], url: 'https://example.com/' + process.argv[2], elicitationId: 'fixture-url-elicit' } }) + '\\n')
    }
    if (request.id === 92) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/elicitation/complete', params: { elicitationId: 'fixture-elicit' } }) + '\\n')
    }
  }
})
`,
    )
    const events: RuntimeEvent[] = []
    const elicitation = vi.fn(
      async (request: {
        serverName: string
        message: string
        mode?: 'form' | 'url'
        url?: string
        requestedSchema?: Record<string, unknown>
      }) => {
        expect(request.serverName).toBe('fixture')
        expect(JSON.stringify(request)).not.toContain('plugin-mcp-secret')
        if (request.mode === 'form') {
          expect(request.message).toBe('Provide [REDACTED]')
          expect(request.requestedSchema).toEqual({
            type: 'object',
            properties: {
              code: { type: 'string', description: '[REDACTED]' },
            },
          })
        } else {
          expect(request.message).toBe('Open [REDACTED]')
          expect(request.url).toBe('https://example.com/[REDACTED]')
        }
        return { action: 'accept' as const, content: { code: 'ok' } }
      },
    )
    const registry = await ClaudeMcpToolRegistry.connect({
      base,
      cwd: root,
      resources: [
        {
          path: '/fixture.json',
          scope: 'user',
          value: {
            mcpServers: {
              fixture: {
                command: process.execPath,
                args: [serverScript, 'plugin-mcp-secret'],
                env: {},
              },
            },
          },
          sensitiveValues: ['mcp-secret', 'plugin-mcp-secret', ''],
        },
      ],
      eventSink: (event) => events.push(event),
      onElicitation: elicitation,
    })
    try {
      await vi.waitFor(() => expect(elicitation).toHaveBeenCalledTimes(2))
      await vi.waitFor(() =>
        expect(events).toContainEqual({
          type: 'elicitation-complete',
          mcpServerName: 'fixture',
          elicitationId: 'fixture-elicit',
        }),
      )
    } finally {
      await registry.close()
    }
  })

  it('loads shared OAuth credentials for HTTP transports', async () => {
    vi.stubEnv('PRAXIS_MCP_OAUTH_STORE', 'file')
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'praxis-mcp-oauth-transport-')),
    )
    roots.push(root)
    const configRoot = join(root, 'config')
    const authorizationHeaders: (string | undefined)[] = []
    const http = createServer(async (request, response) => {
      authorizationHeaders.push(request.headers.authorization)
      if (request.headers.authorization !== 'Bearer stored-access') {
        response
          .writeHead(401, {
            'www-authenticate': 'Bearer error="invalid_token"',
          })
          .end()
        return
      }
      let body = ''
      request.setEncoding('utf8')
      for await (const chunk of request) body += chunk
      if (!body) {
        response.writeHead(405).end()
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
              serverInfo: { name: 'oauth-fixture', version: '1' },
            }
          : message.method === 'tools/list'
            ? {
                tools: [
                  {
                    name: 'secured',
                    description: 'secured tool',
                    inputSchema: { type: 'object' },
                  },
                ],
              }
            : { content: [{ type: 'text', text: 'authenticated' }] }
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
    const url = `http://127.0.0.1:${address.port}/mcp`
    const identity = { name: 'secured', type: 'http' as const, url }
    await new ClaudeMcpOAuthStore({
      configRoot,
      useKeychain: false,
    }).mutate(identity, () => ({
      serverName: identity.name,
      serverUrl: identity.url,
      accessToken: 'stored-access',
    }))
    const warning = vi.fn()
    const registry = await ClaudeMcpToolRegistry.connect({
      base,
      configRoot,
      cwd: root,
      onWarning: warning,
      resources: [
        {
          path: '/oauth.json',
          scope: 'user',
          value: {
            mcpServers: { secured: { type: 'http', url } },
          },
        },
      ],
    })

    try {
      expect(warning).not.toHaveBeenCalled()
      expect(registry.definitions().map((tool) => tool.name)).toContain(
        'mcp__secured__secured',
      )
      await expect(
        registry.execute(
          { id: 'secured', name: 'mcp__secured__secured', input: {} },
          { cwd: root },
        ),
      ).resolves.toMatchObject({ content: 'authenticated', isError: false })
      expect(authorizationHeaders.length).toBeGreaterThan(0)
      expect(authorizationHeaders).toEqual(
        expect.arrayContaining(['Bearer stored-access']),
      )
    } finally {
      await registry.close()
      await new Promise<void>((resolve) => http.close(() => resolve()))
    }
  })

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
      ).resolves.toEqual({
        content: `STDIO:${root}`,
        contentBlocks: [{ type: 'text', text: `STDIO:${root}` }],
        isError: false,
      })
      await expect(
        registry.execute(
          { id: '2', name: 'mcp__http__marker', input: {} },
          { cwd: root },
        ),
      ).resolves.toEqual({
        content: 'HTTP',
        contentBlocks: [{ type: 'text', text: 'HTTP' }],
        isError: false,
      })
      await expect(
        registry.execute(
          {
            id: 'list-tools-only',
            name: 'ListMcpResourcesTool',
            input: { server: 'stdio' },
          },
          { cwd: root },
        ),
      ).resolves.toEqual({
        content:
          'No resources found. MCP servers may still provide tools even if they have no resources.',
        isError: false,
      })
      await expect(
        registry.execute(
          {
            id: 'read-tools-only',
            name: 'ReadMcpResourceTool',
            input: { server: 'stdio', uri: 'fixture://alpha' },
          },
          { cwd: root },
        ),
      ).rejects.toThrow('Server "stdio" does not support resources')
    } finally {
      await registry.close()
      await new Promise<void>((resolve, reject) =>
        http.close((error) => (error ? reject(error) : resolve())),
      )
    }
  })

  it('preserves MCP media order and materializes non-image binary blocks', async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'praxis-mcp-media-')),
    )
    roots.push(root)
    const serverScript = join(root, 'media-server.mjs')
    const resultDirectory = join(root, 'tool-results')
    const image =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
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
      ? { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'media-fixture', version: '1' } }
      : request.method === 'tools/list'
        ? { tools: [{ name: 'media', description: 'media', inputSchema: { type: 'object' } }, { name: 'rollback', description: 'rollback', inputSchema: { type: 'object' } }, { name: 'invalid_base64', description: 'invalid base64', inputSchema: { type: 'object' } }, { name: 'missing_directory', description: 'missing directory', inputSchema: { type: 'object' } }] }
        : request.params.name === 'rollback'
          ? { content: [{ type: 'audio', mimeType: 'audio/wav', data: 'UklGRg==' }, { type: 'image', mimeType: 'image/svg+xml', data: 'PHN2Zy8+' }] }
          : request.params.name === 'invalid_base64'
            ? { content: [{ type: 'image', mimeType: 'image/png', data: 'not-base64' }] }
            : request.params.name === 'missing_directory'
              ? { content: [{ type: 'audio', mimeType: 'audio/wav', data: 'UklGRg==' }] }
          : { content: [{ type: 'text', text: 'omitted when structured' }, { type: 'image', mimeType: 'image/png', data: '${image}' }, { type: 'audio', mimeType: 'audio/wav', data: 'UklGRg==' }, { type: 'resource_link', uri: 'fixture://linked', name: 'Linked' }, { type: 'resource', resource: { uri: 'fixture://embedded', mimeType: 'text/plain', text: 'EMBEDDED' } }], structuredContent: { value: 'STRUCTURED' } }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n')
  }
})
`,
    )
    const registry = await ClaudeMcpToolRegistry.connect({
      base,
      cwd: root,
      resources: [
        {
          path: '/fixture.json',
          scope: 'local',
          value: {
            mcpServers: {
              fixture: { command: process.execPath, args: [serverScript] },
            },
          },
        },
      ],
    })
    try {
      const result = await registry.execute(
        { id: 'media', name: 'mcp__fixture__media', input: {} },
        { cwd: root, toolResultDirectory: resultDirectory },
      )
      expect(result.images).toEqual([
        { type: 'image', mediaType: 'image/png', data: image },
      ])
      expect(result.nativeMcpMeta).toEqual({
        structuredContent: { value: 'STRUCTURED' },
      })
      expect(result.contentBlocks).toHaveLength(5)
      expect(result.contentBlocks?.[0]).toEqual({
        type: 'image',
        mediaType: 'image/png',
        data: image,
      })
      const audioText = result.contentBlocks?.[1]
      expect(audioText).toMatchObject({ type: 'text' })
      if (audioText?.type !== 'text') throw new Error('audio text missing')
      expect(audioText.text).toMatch(
        /\[Audio from fixture\] Binary content \(audio\/wav, 4 bytes\) saved to .*\/mcp-fixture-blob-\d+-[a-f0-9]{6}\.wav$/u,
      )
      const audioPath = audioText.text.slice(
        audioText.text.indexOf(' saved to ') + 10,
      )
      expect(await readFile(audioPath)).toEqual(Buffer.from('RIFF'))
      expect(result.contentBlocks?.slice(2)).toEqual([
        { type: 'text', text: '[Resource link: Linked] fixture://linked' },
        {
          type: 'text',
          text: '[Resource from fixture at fixture://embedded] EMBEDDED',
        },
        { type: 'text', text: '{"value":"STRUCTURED"}' },
      ])
      expect(result.content).not.toContain('omitted when structured')
      expect(result.isError).toBe(false)
      const existingFiles = await readdir(resultDirectory)
      await expect(
        registry.execute(
          { id: 'rollback', name: 'mcp__fixture__rollback', input: {} },
          { cwd: root, toolResultDirectory: resultDirectory },
        ),
      ).rejects.toThrow('MCP image result is invalid or unsupported')
      expect(await readdir(resultDirectory)).toEqual(existingFiles)
      await expect(
        registry.execute(
          {
            id: 'invalid-base64',
            name: 'mcp__fixture__invalid_base64',
            input: {},
          },
          { cwd: root, toolResultDirectory: resultDirectory },
        ),
      ).rejects.toThrow('Invalid Base64 string')
      await expect(
        registry.execute(
          {
            id: 'missing-directory',
            name: 'mcp__fixture__missing_directory',
            input: {},
          },
          { cwd: root },
        ),
      ).rejects.toThrow(
        'MCP binary tool result output directory is unavailable',
      )
    } finally {
      await registry.close()
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
    expect(registry.serverStatuses()).toEqual([
      { name: 'fixture', status: 'failed' },
    ])
    await expect(
      registry.execute(
        {
          id: 'failed-resource',
          name: 'ReadMcpResourceTool',
          input: { server: 'fixture', uri: 'fixture://alpha' },
        },
        { cwd: '/tmp' },
      ),
    ).rejects.toThrow('Server "fixture" is not connected')
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
        contentBlocks: [
          {
            type: 'text',
            text: JSON.stringify({
              ambient: 'missing',
              explicit: '[REDACTED]',
            }),
          },
        ],
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
      ).resolves.toEqual({
        content: '[REDACTED]',
        contentBlocks: [{ type: 'text', text: '[REDACTED]' }],
        isError: false,
      })
    } finally {
      await registry?.close()
      await new Promise<void>((resolve, reject) =>
        http.close((error) => (error ? reject(error) : resolve())),
      )
    }
  })

  it('discovers, lists, and reads paginated MCP resources', async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'praxis-mcp-resources-')),
    )
    roots.push(root)
    const serverScript = join(root, 'resource-server.mjs')
    const resultDirectory = join(root, 'session', 'tool-results')
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
    if (request.method === 'resources/read' && request.params.uri === 'fixture://missing') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32002, message: 'missing' } }) + '\\n')
      continue
    }
    const result = request.method === 'initialize'
      ? { protocolVersion: request.params.protocolVersion, capabilities: { resources: {} }, serverInfo: { name: 'resource-fixture', version: '1' } }
      : request.method === 'resources/list'
        ? process.argv[2] === 'empty'
          ? { resources: [] }
          : request.params?.cursor === 'next'
            ? { resources: [{ uri: 'fixture://second', name: 'Second' }] }
            : { resources: [{ uri: 'fixture://alpha', name: 'Alpha', description: 'Alpha resource', mimeType: 'text/plain', size: 17 }], nextCursor: 'next' }
        : request.params.uri === 'fixture://blob'
          ? { contents: [{ uri: request.params.uri, mimeType: 'application/octet-stream', blob: 'AQID' }] }
          : request.params.uri === 'fixture://invalid'
            ? { contents: [{ uri: request.params.uri, blob: 'not-base64' }] }
            : { contents: [{ uri: request.params.uri, mimeType: 'text/plain', text: 'RESOURCE_CONTENT', _meta: { private: true } }], _meta: { private: true } }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n')
  }
})
`,
    )
    const registry = await ClaudeMcpToolRegistry.connect({
      base,
      cwd: root,
      resources: [
        {
          path: '/mcp.json',
          scope: 'project',
          value: {
            mcpServers: {
              fixture: { command: process.execPath, args: [serverScript] },
              empty: {
                command: process.execPath,
                args: [serverScript, 'empty'],
              },
            },
          },
        },
      ],
    })

    try {
      expect(registry.serverStatuses()).toEqual([
        { name: 'fixture', status: 'connected' },
        { name: 'empty', status: 'connected' },
      ])
      expect(registry.definitions().map((tool) => tool.name)).toEqual([
        'Read',
        'ListMcpResourcesTool',
        'ReadMcpResourceDirTool',
        'ReadMcpResourceTool',
      ])
      const list = await registry.execute(
        { id: 'list', name: 'ListMcpResourcesTool', input: {} },
        { cwd: root },
      )
      expect(JSON.parse(list.content)).toEqual([
        {
          uri: 'fixture://alpha',
          name: 'Alpha',
          description: 'Alpha resource',
          mimeType: 'text/plain',
          size: 17,
          server: 'fixture',
        },
        { uri: 'fixture://second', name: 'Second', server: 'fixture' },
      ])
      await expect(
        registry.execute(
          {
            id: 'empty-server',
            name: 'ListMcpResourcesTool',
            input: { server: 'empty' },
          },
          { cwd: root },
        ),
      ).resolves.toEqual({
        content:
          'No resources found. MCP servers may still provide tools even if they have no resources.',
        isError: false,
      })
      await expect(
        registry.execute(
          {
            id: 'missing-server',
            name: 'ListMcpResourcesTool',
            input: { server: 'missing' },
          },
          { cwd: root },
        ),
      ).rejects.toThrow(
        'Server "missing" not found. Available servers: fixture, empty',
      )
      await expect(
        registry.execute(
          {
            id: 'read',
            name: 'ReadMcpResourceTool',
            input: { server: 'fixture', uri: 'fixture://alpha' },
          },
          { cwd: root },
        ),
      ).resolves.toEqual({
        content:
          '{"contents":[{"uri":"fixture://alpha","mimeType":"text/plain","text":"RESOURCE_CONTENT"}]}',
        isError: false,
      })
      await expect(
        registry.execute(
          {
            id: 'directory',
            name: 'ReadMcpResourceDirTool',
            input: { server: 'fixture', uri: 'fixture://directory' },
          },
          { cwd: root },
        ),
      ).resolves.toEqual({
        content: 'Directory listing is not enabled in this build.',
        isError: false,
      })
      await expect(
        registry.execute(
          {
            id: 'missing-directory-server',
            name: 'ReadMcpResourceDirTool',
            input: { server: 'missing', uri: 'fixture://directory' },
          },
          { cwd: root },
        ),
      ).rejects.toThrow(
        'Server "missing" not found. Available servers: fixture, empty',
      )
      const blob = await registry.execute(
        {
          id: 'blob',
          name: 'ReadMcpResourceTool',
          input: { server: 'fixture', uri: 'fixture://blob' },
        },
        { cwd: root, toolResultDirectory: resultDirectory },
      )
      const blobContent = JSON.parse(blob.content).contents[0]
      expect(blobContent).toMatchObject({
        uri: 'fixture://blob',
        mimeType: 'application/octet-stream',
      })
      expect(blobContent.blobSavedTo).toMatch(
        /tool-results\/mcp-resource-\d+-0-[a-f0-9]{6}\.bin$/,
      )
      expect(await readFile(blobContent.blobSavedTo)).toEqual(
        Buffer.from([1, 2, 3]),
      )
      await expect(
        registry.execute(
          {
            id: 'blob-without-directory',
            name: 'ReadMcpResourceTool',
            input: { server: 'fixture', uri: 'fixture://blob' },
          },
          { cwd: root },
        ),
      ).rejects.toThrow('MCP binary resource output directory is unavailable')
      await expect(
        registry.execute(
          {
            id: 'invalid-blob',
            name: 'ReadMcpResourceTool',
            input: { server: 'fixture', uri: 'fixture://invalid' },
          },
          { cwd: root, toolResultDirectory: resultDirectory },
        ),
      ).rejects.toThrow('Invalid Base64 string')
      await expect(
        registry.execute(
          {
            id: 'missing-resource',
            name: 'ReadMcpResourceTool',
            input: { server: 'fixture', uri: 'fixture://missing' },
          },
          { cwd: root },
        ),
      ).resolves.toEqual({
        content:
          'Resource not found: fixture://missing — it may have been deleted or the URI is stale. Re-run ListMcpResourcesTool to refresh.',
        isError: false,
      })
    } finally {
      await registry.close()
    }
  })

  it('reserves and invokes a permission prompt tool outside model definitions', async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'praxis-mcp-permission-prompt-')),
    )
    roots.push(root)
    const serverScript = join(root, 'permission-server.mjs')
    const callLog = join(root, 'calls.json')
    await writeFile(
      serverScript,
      `import { writeFile } from 'node:fs/promises'
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', async chunk => {
  buffer += chunk
  while (buffer.includes('\\n')) {
    const newline = buffer.indexOf('\\n')
    const line = buffer.slice(0, newline)
    buffer = buffer.slice(newline + 1)
    if (!line.trim()) continue
    const request = JSON.parse(line)
    if (request.id === undefined) continue
    let result
    if (request.method === 'initialize') {
      result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'permission', version: '1' } }
    } else if (request.method === 'tools/list') {
      result = { tools: [{ name: 'approve', inputSchema: { type: 'object' } }] }
    } else {
      await writeFile(process.argv[2], JSON.stringify(request.params))
      const command = request.params.arguments.input.command
      const text = command === 'invalid'
        ? 'not-json'
        : JSON.stringify(command === 'deny'
          ? { behavior: 'deny', message: 'DENIED_BY_MCP', interrupt: true }
          : { behavior: 'allow', updatedInput: { command: 'updated' } })
      result = { content: [{ type: 'text', text }] }
    }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n')
  }
})
`,
    )
    const registry = await ClaudeMcpToolRegistry.connect({
      base,
      cwd: root,
      resources: [
        {
          path: '/permission.json',
          scope: 'local',
          value: {
            mcpServers: {
              permission: {
                command: process.execPath,
                args: [serverScript, callLog],
              },
            },
          },
        },
      ],
    })

    try {
      const prompt = registry.permissionPrompt('mcp__permission__approve')
      expect(registry.definitions().map((tool) => tool.name)).toEqual(['Read'])
      await expect(
        prompt({
          id: 'toolu_permission',
          name: 'Bash',
          input: { command: 'original' },
        }),
      ).resolves.toEqual({
        behavior: 'allow',
        updatedInput: { command: 'updated' },
      })
      expect(JSON.parse(await readFile(callLog, 'utf8'))).toMatchObject({
        name: 'approve',
        arguments: {
          tool_name: 'Bash',
          input: { command: 'original' },
          tool_use_id: 'toolu_permission',
        },
        _meta: { 'claudecode/toolUseId': 'toolu_permission' },
      })
      await expect(
        prompt({ id: 'toolu_deny', name: 'Bash', input: { command: 'deny' } }),
      ).resolves.toEqual({
        behavior: 'deny',
        message: 'DENIED_BY_MCP',
        interrupt: true,
      })
      await expect(
        prompt({
          id: 'toolu_invalid',
          name: 'Bash',
          input: { command: 'invalid' },
        }),
      ).resolves.toEqual({
        behavior: 'deny',
        message:
          "The permission prompt tool returned an invalid permission result. Expected {behavior: 'allow', updatedInput?: object} or {behavior: 'deny', message: string}.",
      })
      expect(() => registry.permissionPrompt('mcp__missing__approve')).toThrow(
        'Available MCP tools: mcp__permission__approve',
      )
    } finally {
      await registry.close()
    }
  })
})
