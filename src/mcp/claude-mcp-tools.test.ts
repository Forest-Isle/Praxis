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
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { RuntimeEvent, ToolRegistry } from '../core/runtime.js'
import { ClaudeMcpOAuthStore } from './claude-mcp-oauth.js'
import {
  ClaudeMcpToolRegistry,
  validateClaudeMcpConfiguration,
} from './claude-mcp-tools.js'

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
  it('discovers, invokes, refreshes, and closes MCP prompts with Claude naming and content semantics', async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'praxis-mcp-prompts-')),
    )
    roots.push(root)
    const serverScript = join(root, 'prompt-server.mjs')
    await writeFile(
      serverScript,
      `let buffer = ''
let refreshed = false
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
    let result
    if (request.method === 'initialize') {
      result = { protocolVersion: request.params.protocolVersion, capabilities: { prompts: { listChanged: true } }, serverInfo: { name: 'prompt-fixture', version: '1' } }
    } else if (request.method === 'prompts/list') {
      result = { prompts: refreshed
        ? [{ name: 'after-refresh', description: 'new prompt' }]
        : [
            { name: 'ｍｙ.prompt', title: 'Ignored Display Name', description: 'Prompt description', arguments: [{ name: 'ｆirst', required: true }, { name: 'second' }, { name: 'third' }, { name: 'omitted' }] },
            { name: 'broken' }
          ] }
    } else if (request.method === 'prompts/get') {
      result = request.params.name === 'broken'
        ? { messages: [
            { role: 'user', content: { type: 'audio', mimeType: 'audio/wav', data: 'YXVkaW8=' } },
            { role: 'user', content: { type: 'image', mimeType: 'image/tiff', data: 'aW1hZ2U=' } }
          ] }
        : { description: 'result description', messages: [
        { role: 'user', content: { type: 'text', text: JSON.stringify(request.params.arguments) } },
        { role: 'assistant', content: { type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' } },
        { role: 'user', content: { type: 'audio', mimeType: 'audio/wav', data: 'YXVkaW8=' } },
        { role: 'assistant', content: { type: 'resource', resource: { uri: 'fixture://text', mimeType: 'text/plain', text: 'resource text' } } },
        { role: 'user', content: { type: 'resource', resource: { uri: 'fixture://blob', mimeType: 'application/pdf', blob: 'cGRm' } } },
        { role: 'assistant', content: { type: 'resource_link', name: 'linked', uri: 'fixture://link', description: 'link detail' } }
      ] }
      refreshed = true
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/prompts/list_changed' }) + '\\n')
    } else {
      result = {}
    }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n')
  }
})
`,
    )
    const updates: string[][] = []
    const registry = await ClaudeMcpToolRegistry.connect({
      base,
      cwd: root,
      configRoot: root,
      resources: [
        {
          path: '/fixture.json',
          scope: 'user',
          value: {
            mcpServers: {
              'plugin:demo:prompt/server': {
                command: process.execPath,
                args: [serverScript],
              },
            },
          },
        },
      ],
      onPromptsChanged: (prompts) =>
        updates.push(prompts.map((prompt) => prompt.name)),
    })

    const [prompt] = registry.prompts()
    expect(prompt).toMatchObject({
      name: 'mcp__plugin_demo_prompt_server__my.prompt',
      userFacingName: 'plugin:demo:prompt/server:my.prompt (MCP)',
      description: 'Prompt description',
      argumentNames: ['first', 'second', 'third', 'omitted'],
    })
    if (!prompt) throw new Error('prompt missing')
    const broken = registry
      .prompts()
      .find((candidate) => candidate.userFacingName.endsWith(':broken (MCP)'))
    if (!broken) throw new Error('broken prompt missing')
    const temporaryEntries = new Set(await readdir(tmpdir()))
    await expect(broken.invoke('')).rejects.toThrow(
      'MCP image result is invalid or unsupported',
    )
    const promptDirectories = (await readdir(tmpdir())).filter(
      (entry) =>
        entry.startsWith('praxis-mcp-prompts-') && !temporaryEntries.has(entry),
    )
    expect(promptDirectories).toHaveLength(1)
    const temporaryPromptDirectory = join(tmpdir(), promptDirectories[0] ?? '')
    expect(await readdir(temporaryPromptDirectory)).toEqual([])
    const durableDirectory = join(root, 'session-tool-results')
    const result = await prompt.invoke('one  three', {
      toolResultDirectory: durableDirectory,
    })
    expect(result.text).toContain(
      '{"ｆirst":"one","second":"","third":"three"}',
    )
    expect(result.text).toContain(
      '[Resource from plugin:demo:prompt/server at fixture://text] resource text',
    )
    expect(result.text).toContain(
      '[Resource link: linked] fixture://link (link detail)',
    )
    expect(result.images).toEqual([
      { type: 'image', mediaType: 'image/png', data: 'aW1hZ2U=' },
    ])
    const savedFiles = [...result.text.matchAll(/saved to (.+)$/gm)].map(
      (match) => match[1],
    )
    expect(savedFiles).toHaveLength(2)
    const promptResultDirectory = dirname(savedFiles[0] ?? '')
    expect(promptResultDirectory).toBe(durableDirectory)
    expect(await readdir(promptResultDirectory)).toHaveLength(2)
    await vi.waitFor(() =>
      expect(registry.prompts().map((item) => item.name)).toEqual([
        'mcp__plugin_demo_prompt_server__after-refresh',
      ]),
    )
    expect(updates.at(-1)).toEqual([
      'mcp__plugin_demo_prompt_server__after-refresh',
    ])
    await registry.close()
    expect(await readdir(promptResultDirectory)).toHaveLength(2)
    await expect(readdir(temporaryPromptDirectory)).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await expect(prompt.invoke('closed')).rejects.toThrow(
      'MCP registry is closed',
    )
  })

  it('reconnects a disconnected MCP prompt server before invoking a retained command', async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'praxis-mcp-prompt-reconnect-')),
    )
    roots.push(root)
    const serverScript = join(root, 'reconnect-server.mjs')
    const generationFile = join(root, 'generation')
    await writeFile(
      serverScript,
      `import { existsSync, readFileSync, writeFileSync } from 'node:fs'
const generationFile = process.argv[2]
const generation = existsSync(generationFile) ? Number(readFileSync(generationFile, 'utf8')) + 1 : 1
writeFileSync(generationFile, String(generation))
let buffer = ''
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
      ? { protocolVersion: request.params.protocolVersion, capabilities: { prompts: {} }, serverInfo: { name: 'reconnect-fixture', version: '1' } }
      : request.method === 'prompts/list'
        ? { prompts: [{ name: 'probe' }] }
        : { messages: [{ role: 'user', content: { type: 'text', text: 'generation=' + generation } }] }
    const send = () => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n', () => {
      if (request.method === 'prompts/get') setTimeout(() => process.exit(0), 5)
    })
    if (request.method === 'initialize' && generation > 1 && process.argv[3] === 'slow') setTimeout(send, 500)
    else send()
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
          scope: 'user',
          value: {
            mcpServers: {
              reconnect: {
                command: process.execPath,
                args: [serverScript, generationFile],
              },
            },
          },
        },
      ],
    })
    const [prompt] = registry.prompts()
    if (!prompt) throw new Error('prompt missing')
    expect((await prompt.invoke('')).text).toBe('generation=1')
    await vi.waitFor(() =>
      expect(registry.serverStatuses()).toContainEqual({
        name: 'reconnect',
        status: 'failed',
      }),
    )
    expect((await prompt.invoke('')).text).toBe('generation=2')
    await registry.close()
  })

  it('closes an in-flight prompt reconnect without registering or leaking the new client', async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'praxis-mcp-prompt-close-race-')),
    )
    roots.push(root)
    const serverScript = join(root, 'reconnect-server.mjs')
    const generationFile = join(root, 'generation')
    await writeFile(
      serverScript,
      `import { existsSync, readFileSync, writeFileSync } from 'node:fs'
const generationFile = process.argv[2]
const generation = existsSync(generationFile) ? Number(readFileSync(generationFile, 'utf8')) + 1 : 1
writeFileSync(generationFile, String(generation))
let buffer = ''
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
      ? { protocolVersion: request.params.protocolVersion, capabilities: { prompts: {} }, serverInfo: { name: 'close-race', version: '1' } }
      : request.method === 'prompts/list'
        ? { prompts: [{ name: 'probe' }] }
        : { messages: [{ role: 'user', content: { type: 'text', text: 'generation=' + generation } }] }
    const send = () => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n', () => {
      if (request.method === 'prompts/get') setTimeout(() => process.exit(0), 5)
    })
    if (request.method === 'initialize' && generation > 1) setTimeout(send, 500)
    else send()
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
          scope: 'user',
          value: {
            mcpServers: {
              reconnect: {
                command: process.execPath,
                args: [serverScript, generationFile],
              },
            },
          },
        },
      ],
    })
    const [prompt] = registry.prompts()
    if (!prompt) throw new Error('prompt missing')
    expect((await prompt.invoke('')).text).toBe('generation=1')
    await vi.waitFor(() =>
      expect(registry.serverStatuses()).toContainEqual({
        name: 'reconnect',
        status: 'failed',
      }),
    )
    const reconnect = prompt.invoke('')
    await vi.waitFor(async () =>
      expect(await readFile(generationFile, 'utf8')).toBe('2'),
    )
    const firstClose = registry.close()
    expect(registry.close()).toBe(firstClose)
    await expect(reconnect).rejects.toThrow()
    await firstClose
    await expect(prompt.invoke('')).rejects.toThrow('MCP registry is closed')
  })

  it('keeps the first MCP prompt when normalized internal names collide', async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'praxis-mcp-prompt-collision-')),
    )
    roots.push(root)
    const serverScript = join(root, 'collision-server.mjs')
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
      ? { protocolVersion: request.params.protocolVersion, capabilities: { prompts: {} }, serverInfo: { name: process.argv[2], version: '1' } }
      : request.method === 'prompts/list'
        ? { prompts: [{ name: 'probe' }] }
        : { messages: [{ role: 'user', content: { type: 'text', text: process.argv[2] } }] }
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
          scope: 'user',
          value: {
            mcpServers: {
              'a.b': {
                command: process.execPath,
                args: [serverScript, 'first'],
              },
              'a/b': {
                command: process.execPath,
                args: [serverScript, 'second'],
              },
            },
          },
        },
      ],
    })
    try {
      expect(registry.prompts()).toHaveLength(1)
      expect(registry.prompts()[0]).toMatchObject({
        name: 'mcp__a_b__probe',
        userFacingName: 'a.b:probe (MCP)',
      })
      expect(await registry.prompts()[0]?.invoke('')).toMatchObject({
        text: 'first',
      })
    } finally {
      await registry.close()
    }
  })

  it('paginates MCP prompts and isolates cursor, page, and count limit failures', async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'praxis-mcp-prompt-pages-')),
    )
    roots.push(root)
    const serverScript = join(root, 'prompt-pages-server.mjs')
    await writeFile(
      serverScript,
      `let buffer = ''
const mode = process.argv[2]
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
    let result
    if (request.method === 'initialize') {
      result = { protocolVersion: request.params.protocolVersion, capabilities: { prompts: {} }, serverInfo: { name: mode, version: '1' } }
    } else if (mode === 'paged') {
      result = request.params?.cursor === 'next'
        ? { prompts: [{ name: 'second' }] }
        : { prompts: [{ name: 'first' }], nextCursor: 'next' }
    } else if (mode === 'repeat') {
      result = { prompts: [], nextCursor: 'same' }
    } else if (mode === 'too-many') {
      result = { prompts: Array.from({ length: 10001 }, (_, index) => ({ name: 'p' + index })) }
    } else {
      const page = Number(request.params?.cursor ?? 0)
      result = { prompts: [], nextCursor: page < 100 ? String(page + 1) : undefined }
    }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n')
  }
})
`,
    )
    const warnings: string[] = []
    const registry = await ClaudeMcpToolRegistry.connect({
      base,
      cwd: root,
      onWarning: (warning) => warnings.push(warning),
      resources: [
        {
          path: '/fixture.json',
          scope: 'user',
          value: {
            mcpServers: Object.fromEntries(
              ['paged', 'repeat', 'too-many', 'too-many-pages'].map((mode) => [
                mode,
                { command: process.execPath, args: [serverScript, mode] },
              ]),
            ),
          },
        },
      ],
    })
    try {
      expect(registry.prompts().map((prompt) => prompt.userFacingName)).toEqual(
        ['paged:first (MCP)', 'paged:second (MCP)'],
      )
      expect(warnings).toEqual(
        expect.arrayContaining([
          expect.stringContaining('Repeated MCP prompts cursor'),
          expect.stringContaining('MCP prompt limit exceeded'),
          expect.stringContaining('MCP prompts page limit exceeded'),
        ]),
      )
    } finally {
      await registry.close()
    }
  })

  it('deduplicates plugin servers by command or URL with manual precedence', () => {
    const report = validateClaudeMcpConfiguration([
      {
        path: '/plugins.json',
        scope: 'user',
        plugin: true,
        value: {
          mcpServers: {
            'plugin:first:stdio': {
              command: 'fixture',
              args: ['--stdio'],
              env: { TOKEN: 'first' },
            },
            'plugin:second:stdio': {
              command: 'fixture',
              args: ['--stdio'],
              cwd: '/ignored',
            },
            'plugin:first:url': {
              type: 'sse',
              url: 'https://proxy.example/v2/ccr-sessions/?mcp_url=https%3A%2F%2Fupstream.example%2Fmcp',
            },
            'plugin:first:unique': {
              command: 'plugin-only',
              args: ['--stdio'],
            },
            'plugin:second:unique': {
              command: 'plugin-only',
              args: ['--stdio'],
              env: { DIFFERENT: 'ignored' },
            },
          },
        },
      },
      {
        path: '/manual.json',
        scope: 'local',
        value: {
          mcpServers: {
            manual: {
              command: 'fixture',
              args: ['--stdio'],
              env: { TOKEN: 'manual' },
            },
            upstream: {
              type: 'http',
              url: 'https://upstream.example/mcp',
              headers: { Authorization: 'ignored' },
            },
          },
        },
      },
    ])

    expect(report.servers.map((server) => server.name)).toEqual([
      'plugin:first:unique',
      'manual',
      'upstream',
    ])
  })

  it('does not infer plugin origin from a manual server name', () => {
    const report = validateClaudeMcpConfiguration([
      {
        path: '/manual.json',
        scope: 'user',
        value: {
          mcpServers: {
            'plugin:user-chosen:name': {
              command: 'same-command',
              args: [],
            },
          },
        },
      },
      {
        path: '/plugin.json',
        scope: 'user',
        plugin: true,
        value: {
          mcpServers: {
            'plugin:actual:name': { command: 'same-command', args: [] },
          },
        },
      },
    ])

    expect(report.servers.map((server) => server.name)).toEqual([
      'plugin:user-chosen:name',
    ])
  })

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
    const authenticateServer = vi.fn(async () => undefined)

    const registry = await ClaudeMcpToolRegistry.connect({
      base,
      cwd: root,
      onWarning: warning,
      authenticateServer,
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
      await expect(registry.inspect()).resolves.toEqual([
        expect.objectContaining({
          name: 'stdio',
          status: 'connected',
          capabilities: ['tools'],
          toolCount: 1,
        }),
        expect.objectContaining({
          name: 'http',
          status: 'connected',
          capabilities: ['tools'],
          toolCount: 1,
        }),
      ])
      await expect(registry.tools('http')).resolves.toEqual([
        expect.objectContaining({
          name: 'marker',
          fullName: 'mcp__http__marker',
        }),
      ])
      await registry.reconnect('stdio')
      await registry.authenticate('stdio')
      expect(authenticateServer).toHaveBeenCalledWith('stdio')
      await registry.reload()
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
        ? { tools: [{ name: 'environment.tool', description: process.env.MCP_API_KEY, inputSchema: { type: 'object', description: process.env.MCP_API_KEY } }, { name: 'failure.tool', inputSchema: { type: 'object' } }] }
        : { content: [{ type: 'text', text: JSON.stringify({ ambient: process.env.PRAXIS_API_KEY ?? 'missing', explicit: process.env.MCP_API_KEY }) }] }
    const response = request.method === 'tools/call' && request.params.name === 'failure.tool'
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
                'plugin:fixture:environment': {
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
        .find(
          (tool) =>
            tool.name === 'mcp__plugin_fixture_environment__environment_tool',
        )
      expect(JSON.stringify(definition)).toContain('[REDACTED]')
      expect(JSON.stringify(definition)).not.toContain(explicitSecret)

      await expect(
        registry.execute(
          {
            id: 'environment',
            name: 'mcp__plugin_fixture_environment__environment_tool',
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
          {
            id: 'failure',
            name: 'mcp__plugin_fixture_environment__failure_tool',
            input: {},
          },
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
              'plugin:fixture:resource': {
                command: process.execPath,
                args: [serverScript],
              },
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
        { name: 'plugin:fixture:resource', status: 'connected' },
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
          server: 'plugin:fixture:resource',
        },
        {
          uri: 'fixture://second',
          name: 'Second',
          server: 'plugin:fixture:resource',
        },
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
        'Server "missing" not found. Available servers: plugin:fixture:resource, empty',
      )
      await expect(
        registry.execute(
          {
            id: 'read',
            name: 'ReadMcpResourceTool',
            input: {
              server: 'plugin:fixture:resource',
              uri: 'fixture://alpha',
            },
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
            input: {
              server: 'plugin:fixture:resource',
              uri: 'fixture://directory',
            },
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
        'Server "missing" not found. Available servers: plugin:fixture:resource, empty',
      )
      const blob = await registry.execute(
        {
          id: 'blob',
          name: 'ReadMcpResourceTool',
          input: {
            server: 'plugin:fixture:resource',
            uri: 'fixture://blob',
          },
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
            input: {
              server: 'plugin:fixture:resource',
              uri: 'fixture://blob',
            },
          },
          { cwd: root },
        ),
      ).rejects.toThrow('MCP binary resource output directory is unavailable')
      await expect(
        registry.execute(
          {
            id: 'invalid-blob',
            name: 'ReadMcpResourceTool',
            input: {
              server: 'plugin:fixture:resource',
              uri: 'fixture://invalid',
            },
          },
          { cwd: root, toolResultDirectory: resultDirectory },
        ),
      ).rejects.toThrow('Invalid Base64 string')
      await expect(
        registry.execute(
          {
            id: 'missing-resource',
            name: 'ReadMcpResourceTool',
            input: {
              server: 'plugin:fixture:resource',
              uri: 'fixture://missing',
            },
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

  it('bounds resource list and aggregate decoded blobs while cleaning partial files', async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'praxis-mcp-resource-list-limit-')),
    )
    roots.push(root)
    const resultDirectory = join(root, 'tool-results')
    const http = createServer(async (request, response) => {
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
      let result
      if (message.method === 'initialize') {
        result = {
          protocolVersion: message.params.protocolVersion,
          capabilities: { resources: {} },
          serverInfo: { name: 'large-resource', version: '1' },
        }
      } else if (message.method === 'resources/list') {
        result =
          request.url === '/large-list'
            ? {
                resources: [
                  {
                    uri: 'fixture://large',
                    name: 'Large',
                    description: 'x'.repeat(25 * 1024 * 1024),
                  },
                ],
              }
            : { resources: [{ uri: 'fixture://multi', name: 'Multi' }] }
      } else {
        const blob = Buffer.alloc(1024 * 1024).toString('base64')
        result = {
          contents: Array.from({ length: 26 }, (_, index) => ({
            uri: 'fixture://multi/' + index,
            blob,
          })),
        }
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
    const origin = `http://127.0.0.1:${address.port}`
    const registry = await ClaudeMcpToolRegistry.connect({
      base,
      cwd: root,
      resources: [
        {
          path: '/fixture.json',
          scope: 'user',
          value: {
            mcpServers: {
              large: { type: 'http', url: `${origin}/large-list` },
              multi: { type: 'http', url: `${origin}/multi` },
            },
          },
        },
      ],
    })
    try {
      await expect(
        registry.execute(
          {
            id: 'large-list',
            name: 'ListMcpResourcesTool',
            input: { server: 'large' },
          },
          { cwd: root },
        ),
      ).rejects.toThrow('MCP resource list exceeded 26214400 bytes')
      await expect(
        registry.execute(
          {
            id: 'multi-blob',
            name: 'ReadMcpResourceTool',
            input: { server: 'multi', uri: 'fixture://multi' },
          },
          { cwd: root, toolResultDirectory: resultDirectory },
        ),
      ).rejects.toThrow('MCP resource result exceeded 26214400 bytes')
      expect(await readdir(resultDirectory)).toEqual([])
    } finally {
      await registry.close()
      await new Promise<void>((resolve) => http.close(() => resolve()))
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
          : command === 'updates'
            ? { behavior: 'allow', updatedInput: {}, updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'localSettings' }] }
            : command === 'bad-updates'
              ? { behavior: 'allow', updatedInput: {}, updatedPermissions: [{ type: 'setMode', mode: 'auto', destination: 'session' }] }
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
          id: 'toolu_updates',
          name: 'Bash',
          input: { command: 'updates' },
        }),
      ).resolves.toEqual({
        behavior: 'allow',
        updatedInput: { command: 'updates' },
        updatedPermissions: [
          {
            type: 'addRules',
            rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }],
            behavior: 'allow',
            destination: 'localSettings',
          },
        ],
      })
      await expect(
        prompt({
          id: 'toolu_bad_updates',
          name: 'Bash',
          input: { command: 'bad-updates' },
        }),
      ).resolves.toEqual({
        behavior: 'allow',
        updatedInput: { command: 'bad-updates' },
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
          "The permission prompt tool returned an invalid permission result. Expected {behavior: 'allow', updatedInput: object} or {behavior: 'deny', message: string}.",
      })
      expect(() => registry.permissionPrompt('mcp__missing__approve')).toThrow(
        'Available MCP tools: mcp__permission__approve',
      )
    } finally {
      await registry.close()
    }
  })

  it('connects inline agent MCP servers without owning referenced parent servers', async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'praxis-agent-mcp-runtime-')),
    )
    roots.push(root)
    const serverScript = join(root, 'agent-server.mjs')
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
      ? { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'agent-fixture', version: '1' } }
      : request.method === 'tools/list'
        ? { tools: [{ name: 'probe', description: 'probe', inputSchema: { type: 'object' } }] }
        : { content: [{ type: 'text', text: 'INLINE_AGENT_MCP' }] }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n')
  }
})
`,
    )
    const warnings: string[] = []
    const parent = await ClaudeMcpToolRegistry.connect({
      base,
      cwd: root,
      resources: [],
      onWarning: (warning) => warnings.push(warning),
    })
    try {
      const child = await parent.connectAgent({
        specs: [
          'missing-parent',
          { inline: { command: process.execPath, args: [serverScript] } },
        ],
        base,
        cwd: root,
      })
      if (!child) throw new Error('agent MCP connection missing')
      try {
        expect(child.tools.definitions().map(({ name }) => name)).toContain(
          'mcp__inline__probe',
        )
        const call = await child.tools.prepare(
          { id: 'call_agent_inline', name: 'mcp__inline__probe', input: {} },
          { cwd: root },
        )
        await expect(
          child.tools.execute(call, { cwd: root }),
        ).resolves.toMatchObject({ content: 'INLINE_AGENT_MCP' })
      } finally {
        await child.close()
      }
      expect(warnings).toContain('Agent MCP server not found: missing-parent')
    } finally {
      await parent.close()
    }
  })
})
