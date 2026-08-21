import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { run, type CliDependencies, type CliIO } from './cli.js'
import {
  ClaudeMcpOAuthStore,
  mcpOAuthRecordKey,
} from './mcp/claude-mcp-oauth.js'

const roots: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  )
})

function captureIO(): {
  io: CliIO
  stdout: string[]
  stderr: string[]
} {
  const stdout: string[] = []
  const stderr: string[] = []
  return {
    io: {
      stdout: (message) => stdout.push(Buffer.from(message).toString()),
      stderr: (message) => stderr.push(message),
    },
    stdout,
    stderr,
  }
}

async function configFixture(): Promise<{
  configRoot: string
  server: { name: string; type: 'http'; url: string }
}> {
  const root = await mkdtemp(join(tmpdir(), 'praxis-cli-mcp-'))
  roots.push(root)
  const configRoot = join(root, 'config')
  const server = {
    name: 'fixture',
    type: 'http' as const,
    url: 'https://example.com/mcp',
  }
  await mkdir(configRoot, { recursive: true })
  await writeFile(
    join(configRoot, '.claude.json'),
    JSON.stringify({
      mcpServers: {
        [server.name]: { type: server.type, url: server.url },
      },
    }),
  )
  vi.stubEnv('CLAUDE_CONFIG_DIR', configRoot)
  vi.stubEnv('PRAXIS_DATA_PLANE', 'claude')
  vi.stubEnv('PRAXIS_MCP_OAUTH_STORE', 'file')
  return { configRoot, server }
}

function baseDependencies(): CliDependencies {
  return {
    async createService() {
      throw new Error('runtime should not be created')
    },
  }
}

async function temporaryConfigRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'praxis-cli-mcp-add-'))
  roots.push(root)
  const configRoot = join(root, 'config')
  vi.stubEnv('CLAUDE_CONFIG_DIR', configRoot)
  vi.stubEnv('PRAXIS_DATA_PLANE', 'claude')
  vi.stubEnv('PRAXIS_MCP_OAUTH_STORE', 'file')
  return configRoot
}

describe('Praxis MCP CLI commands', () => {
  it('writes native MCP configuration without reading or changing Claude state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-cli-native-mcp-'))
    roots.push(root)
    const praxisRoot = join(root, 'praxis')
    const claudeRoot = join(root, 'claude')
    await mkdir(praxisRoot, { recursive: true })
    await mkdir(claudeRoot, { recursive: true })
    await writeFile(join(claudeRoot, '.claude.json'), 'claude-marker\n')
    vi.stubEnv('PRAXIS_HOME', praxisRoot)
    vi.stubEnv('CLAUDE_CONFIG_DIR', claudeRoot)
    const capture = captureIO()

    await expect(
      run(
        [
          'mcp',
          'add',
          '--scope',
          'user',
          '--transport',
          'http',
          'native-fixture',
          'https://example.test/mcp',
        ],
        capture.io,
        baseDependencies(),
      ),
    ).resolves.toBe(0)

    await expect(
      readFile(join(praxisRoot, 'mcp.json'), 'utf8'),
    ).resolves.toContain('native-fixture')
    await expect(
      readFile(join(claudeRoot, '.claude.json'), 'utf8'),
    ).resolves.toBe('claude-marker\n')
  })

  it('adds a stdio server with repeatable environment variables and subprocess arguments', async () => {
    const configRoot = await temporaryConfigRoot()
    const capture = captureIO()

    await expect(
      run(
        [
          'mcp',
          'add',
          'stdio-fixture',
          '-e',
          'ONE=1',
          '-e',
          'TWO=two',
          '--',
          'node',
          'server.mjs',
          '--flag',
        ],
        capture.io,
        baseDependencies(),
      ),
    ).resolves.toBe(0)

    const state = JSON.parse(
      await readFile(join(configRoot, '.claude.json'), 'utf8'),
    ) as {
      projects: Record<string, { mcpServers: Record<string, unknown> }>
    }
    const project = Object.values(state.projects)[0]
    expect(project?.mcpServers['stdio-fixture']).toEqual({
      type: 'stdio',
      command: 'node',
      args: ['server.mjs', '--flag'],
      env: { ONE: '1', TWO: 'two' },
    })
    expect(capture.stdout.join('')).toContain(
      'Added stdio MCP server stdio-fixture with command: node server.mjs --flag to local config',
    )
  })

  it('adds HTTP and SSE servers with OAuth metadata, headers, and an external client secret', async () => {
    const configRoot = await temporaryConfigRoot()
    vi.stubEnv('MCP_CLIENT_SECRET', 'fixture-client-secret')
    const capture = captureIO()

    await expect(
      run(
        [
          'mcp',
          'add',
          '--scope',
          'user',
          '--transport',
          'http',
          'web-fixture',
          'https://example.test/mcp',
          '-H',
          'Authorization: Bearer fixture-header',
          '-H',
          'X-Test: yes',
          '--callback-port',
          '4321',
          '--client-id',
          'fixture-client',
          '--client-secret',
        ],
        capture.io,
        baseDependencies(),
      ),
    ).resolves.toBe(0)
    await expect(
      run(
        [
          'mcp',
          'add',
          '-s',
          'user',
          '-t',
          'sse',
          'sse-fixture',
          'https://example.test/sse',
        ],
        capture.io,
        baseDependencies(),
      ),
    ).resolves.toBe(0)

    const userState = JSON.parse(
      await readFile(join(configRoot, '.claude.json'), 'utf8'),
    ) as { mcpServers: Record<string, unknown> }
    expect(userState.mcpServers['web-fixture']).toEqual({
      type: 'http',
      url: 'https://example.test/mcp',
      headers: {
        Authorization: 'Bearer fixture-header',
        'X-Test': 'yes',
      },
      oauth: { clientId: 'fixture-client', callbackPort: 4321 },
    })
    expect(userState.mcpServers['sse-fixture']).toEqual({
      type: 'sse',
      url: 'https://example.test/sse',
    })
    const web = {
      name: 'web-fixture',
      type: 'http' as const,
      url: 'https://example.test/mcp',
      headers: {
        Authorization: 'Bearer fixture-header',
        'X-Test': 'yes',
      },
    }
    const credentials = JSON.parse(
      await readFile(join(configRoot, '.credentials.json'), 'utf8'),
    ) as { mcpOAuthClientConfig: Record<string, { clientSecret?: string }> }
    expect(credentials.mcpOAuthClientConfig[mcpOAuthRecordKey(web)]).toEqual({
      clientSecret: 'fixture-client-secret',
    })
    expect(JSON.stringify(userState)).not.toContain('fixture-client-secret')
    expect(capture.stdout.join('')).toContain(
      'Added HTTP MCP server web-fixture with URL: https://example.test/mcp to user config',
    )
    expect(capture.stdout.join('')).toContain('"Authorization": "[REDACTED]"')
  })

  it('stores add-json client secrets outside shared MCP configuration', async () => {
    const configRoot = await temporaryConfigRoot()
    vi.stubEnv('MCP_CLIENT_SECRET', 'fixture-json-secret')
    const capture = captureIO()

    await expect(
      run(
        [
          'mcp',
          'add-json',
          '--scope',
          'user',
          '--client-secret',
          'json-fixture',
          JSON.stringify({
            type: 'http',
            url: 'https://example.test/json-mcp',
            oauth: { clientId: 'fixture-client' },
          }),
        ],
        capture.io,
        baseDependencies(),
      ),
    ).resolves.toBe(0)

    const shared = await readFile(join(configRoot, '.claude.json'), 'utf8')
    expect(shared).not.toContain('fixture-json-secret')
    const credentials = JSON.parse(
      await readFile(join(configRoot, '.credentials.json'), 'utf8'),
    ) as { mcpOAuthClientConfig: Record<string, { clientSecret?: string }> }
    expect(
      credentials.mcpOAuthClientConfig[
        mcpOAuthRecordKey({
          name: 'json-fixture',
          type: 'http',
          url: 'https://example.test/json-mcp',
        })
      ],
    ).toEqual({ clientSecret: 'fixture-json-secret' })
  })

  it('matches Claude transport-specific add flags and callback-port coercion', async () => {
    const configRoot = await temporaryConfigRoot()
    const capture = captureIO()
    const add = (name: string, port: string) =>
      run(
        [
          'mcp',
          'add',
          '-t',
          'http',
          name,
          'https://example.test/mcp',
          '--callback-port',
          port,
        ],
        capture.io,
        baseDependencies(),
      )

    await expect(add('callback-alpha', 'abc')).resolves.toBe(0)
    await expect(add('callback-prefix', '12junk')).resolves.toBe(0)
    await expect(add('callback-zero', '0')).resolves.toBe(0)
    await expect(add('callback-wide', '65536')).resolves.toBe(0)
    await expect(add('callback-negative', '-1')).resolves.toBe(1)
    await expect(
      run(
        [
          'mcp',
          'add',
          '-t',
          'http',
          'http-extra',
          'https://example.test/mcp',
          'ignored',
          '-e',
          'ONE=1',
        ],
        capture.io,
        baseDependencies(),
      ),
    ).resolves.toBe(0)
    await expect(
      run(
        ['mcp', 'add', 'stdio-header', 'node', '-H', 'X-Test: yes'],
        capture.io,
        baseDependencies(),
      ),
    ).resolves.toBe(0)

    const state = JSON.parse(
      await readFile(join(configRoot, '.claude.json'), 'utf8'),
    ) as {
      projects: Record<string, { mcpServers: Record<string, unknown> }>
    }
    const servers = Object.values(state.projects)[0]?.mcpServers ?? {}
    expect(servers['callback-alpha']).toEqual({
      type: 'http',
      url: 'https://example.test/mcp',
    })
    expect(servers['callback-prefix']).toEqual({
      type: 'http',
      url: 'https://example.test/mcp',
      oauth: { callbackPort: 12 },
    })
    expect(servers['callback-zero']).toEqual({
      type: 'http',
      url: 'https://example.test/mcp',
    })
    expect(servers['callback-wide']).toEqual({
      type: 'http',
      url: 'https://example.test/mcp',
      oauth: { callbackPort: 65536 },
    })
    expect(servers['callback-negative']).toBeUndefined()
    expect(servers['http-extra']).toEqual({
      type: 'http',
      url: 'https://example.test/mcp',
    })
    expect(servers['stdio-header']).toEqual({
      type: 'stdio',
      command: 'node',
      args: [],
      env: {},
    })
    expect(capture.stderr.join('')).toContain(
      'Invalid configuration: : Invalid input',
    )
  })

  it('rolls back an added config if client-secret persistence fails', async () => {
    const configRoot = await temporaryConfigRoot()
    vi.stubEnv('MCP_CLIENT_SECRET', 'fixture-client-secret')
    const persist = vi
      .spyOn(ClaudeMcpOAuthStore.prototype, 'saveClientSecret')
      .mockRejectedValueOnce(new Error('credential write failed'))
    const capture = captureIO()

    await expect(
      run(
        [
          'mcp',
          'add',
          '-t',
          'http',
          'rollback-fixture',
          'https://example.test/mcp',
          '--client-id',
          'fixture-client',
          '--client-secret',
        ],
        capture.io,
        baseDependencies(),
      ),
    ).resolves.toBe(1)
    persist.mockRestore()

    const state = JSON.parse(
      await readFile(join(configRoot, '.claude.json'), 'utf8'),
    ) as {
      projects: Record<string, { mcpServers: Record<string, unknown> }>
    }
    expect(
      Object.values(state.projects)[0]?.mcpServers['rollback-fixture'],
    ).toBeUndefined()
    expect(capture.stderr.join('')).toContain('credential write failed')
  })

  it('rolls back add-json replacement if client-secret persistence fails', async () => {
    const configRoot = await temporaryConfigRoot()
    vi.stubEnv('MCP_CLIENT_SECRET', 'fixture-client-secret')
    const capture = captureIO()
    await run(
      [
        'mcp',
        'add-json',
        '--scope',
        'user',
        'rollback-json',
        JSON.stringify({
          type: 'http',
          url: 'https://example.test/original',
          oauth: { clientId: 'fixture-client' },
        }),
      ],
      capture.io,
      baseDependencies(),
    )
    const persist = vi
      .spyOn(ClaudeMcpOAuthStore.prototype, 'saveClientSecret')
      .mockRejectedValueOnce(new Error('credential write failed'))

    await expect(
      run(
        [
          'mcp',
          'add-json',
          '--scope',
          'user',
          '--client-secret',
          'rollback-json',
          JSON.stringify({
            type: 'http',
            url: 'https://example.test/replacement',
            oauth: { clientId: 'fixture-client' },
          }),
        ],
        capture.io,
        baseDependencies(),
      ),
    ).resolves.toBe(1)
    persist.mockRestore()

    const state = JSON.parse(
      await readFile(join(configRoot, '.claude.json'), 'utf8'),
    ) as { mcpServers: Record<string, unknown> }
    expect(state.mcpServers['rollback-json']).toEqual({
      type: 'http',
      url: 'https://example.test/original',
      oauth: { clientId: 'fixture-client' },
    })
    expect(capture.stderr.join('')).toContain('credential write failed')
  })

  it('prints MCP add help and rejects malformed add inputs', async () => {
    const configRoot = await temporaryConfigRoot()
    const help = captureIO()
    await expect(
      run(['mcp', 'add', '--help'], help.io, baseDependencies()),
    ).resolves.toBe(0)
    expect(help.stdout.join('')).toContain(
      'Usage: praxis mcp add [options] <name> <commandOrUrl> [args...]',
    )
    expect(help.stdout.join('')).toContain('--callback-port <port>')

    for (const [argv, pattern] of [
      [
        ['mcp', 'add', '--transport', 'websocket', 'fixture', 'node'],
        'Invalid transport type: websocket',
      ],
      [
        ['mcp', 'add', 'fixture', '-e', 'BROKEN', '--', 'node'],
        'Invalid environment variable format: BROKEN',
      ],
      [
        [
          'mcp',
          'add',
          '--transport',
          'http',
          'fixture',
          'https://example.test/mcp',
          '-H',
          'broken',
        ],
        'Invalid header format: "broken"',
      ],
      [['mcp', 'add'], "missing required argument 'name'"],
      [['mcp', 'list', '--transport', 'http'], 'only valid with mcp add'],
    ] as const) {
      const capture = captureIO()
      await expect(run(argv, capture.io, baseDependencies())).resolves.toBe(1)
      expect(capture.stderr.join('')).toContain(pattern)
    }
    await expect(
      readFile(join(configRoot, '.claude.json'), 'utf8'),
    ).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('authenticates a configured HTTP server through the CLI boundary', async () => {
    const fixture = await configFixture()
    const capture = captureIO()
    const authenticate = vi.fn(async () => 'AUTHORIZED' as const)
    const dependencies = {
      ...baseDependencies(),
      mcpAuthenticate: authenticate,
    }

    await expect(
      run(
        [
          'mcp',
          'login',
          fixture.server.name,
          '--scope',
          'user',
          '--no-browser',
        ],
        capture.io,
        dependencies,
      ),
    ).resolves.toBe(0)
    expect(authenticate).toHaveBeenCalledWith(
      expect.objectContaining({
        configRoot: fixture.configRoot,
        server: fixture.server,
        noBrowser: true,
      }),
    )
    expect(capture.stdout.join('')).toContain(
      'Authenticated with "fixture". Its tools are now available in Praxis.',
    )
  })

  it('passes configured OAuth client credentials and callback port into login', async () => {
    const fixture = await configFixture()
    const state = JSON.parse(
      await readFile(join(fixture.configRoot, '.claude.json'), 'utf8'),
    ) as { mcpServers: Record<string, Record<string, unknown>> }
    state.mcpServers[fixture.server.name] = {
      ...state.mcpServers[fixture.server.name],
      oauth: { clientId: 'fixture-client', callbackPort: 4321 },
    }
    await writeFile(
      join(fixture.configRoot, '.claude.json'),
      JSON.stringify(state),
    )
    await new ClaudeMcpOAuthStore({
      configRoot: fixture.configRoot,
      useKeychain: false,
    }).saveClientSecret(
      { ...fixture.server, clientId: 'fixture-client', callbackPort: 4321 },
      'fixture-client-secret',
    )
    const capture = captureIO()
    const authenticate = vi.fn(async () => 'AUTHORIZED' as const)

    await expect(
      run(
        ['mcp', 'login', fixture.server.name, '--scope', 'user'],
        capture.io,
        { ...baseDependencies(), mcpAuthenticate: authenticate },
      ),
    ).resolves.toBe(0)
    expect(authenticate).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: 'fixture-client',
        clientSecret: 'fixture-client-secret',
        callbackPort: 4321,
        server: expect.objectContaining({
          ...fixture.server,
          clientId: 'fixture-client',
          callbackPort: 4321,
        }),
      }),
    )
  })

  it('removes only the selected shared OAuth credential', async () => {
    const fixture = await configFixture()
    const other = {
      name: 'other',
      type: 'http' as const,
      url: 'https://other.example/mcp',
    }
    const store = new ClaudeMcpOAuthStore({
      configRoot: fixture.configRoot,
      useKeychain: false,
    })
    await store.mutate(fixture.server, () => ({
      serverName: fixture.server.name,
      serverUrl: fixture.server.url,
      accessToken: 'fixture-token',
    }))
    await store.mutate(other, () => ({
      serverName: other.name,
      serverUrl: other.url,
      accessToken: 'other-token',
    }))
    const capture = captureIO()

    await expect(
      run(
        ['mcp', 'logout', fixture.server.name, '--scope', 'user'],
        capture.io,
        baseDependencies(),
      ),
    ).resolves.toBe(0)
    await expect(store.read(fixture.server)).resolves.toBeUndefined()
    await expect(store.read(other)).resolves.toMatchObject({
      accessToken: 'other-token',
    })
    expect(capture.stdout.join('')).toContain(
      'Signed out of "fixture". Run `praxis mcp login fixture`',
    )
  })

  it('hosts the MCP server with shared tools and lazy agent services', async () => {
    const capture = captureIO()
    const close = vi.fn(async () => undefined)
    const sharedRegistry = {
      marker: 'shared',
      definitions() {
        if (this.marker !== 'shared') throw new Error('registry binding lost')
        return [
          {
            name: 'SharedTool',
            description: 'Shared tool',
            inputSchema: { type: 'object' },
          },
        ]
      },
      async prepare(call: {
        id: string
        name: string
        input: Record<string, unknown>
      }) {
        if (this.marker !== 'shared') throw new Error('registry binding lost')
        return call
      },
      async execute() {
        if (this.marker !== 'shared') throw new Error('registry binding lost')
        return { content: 'shared', isError: false }
      },
    }
    const createService = vi.fn(async () => ({
      toolRegistry: sharedRegistry,
      run: async () => ({
        sessionId: 'session',
        text: 'result',
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
      resume: async () => ({
        sessionId: 'session',
        text: 'result',
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
      fork: async () => ({ parentSessionId: 'parent', sessionId: 'session' }),
      sessions: async () => [],
      inspect: async () => {
        throw new Error('unused')
      },
      export: async () => Buffer.alloc(0),
      close,
    }))
    const serve = vi.fn(async (options) => {
      expect(options).toMatchObject({ debug: true, verbose: true })
      const registry = await options.createToolRegistry?.()
      expect(
        registry
          ?.definitions()
          .map((definition: { name: string }) => definition.name),
      ).toEqual(['SharedTool'])
      await registry?.close?.()
      const service = await options.createAgentService?.({
        agent: 'reviewer',
        model: 'fixture-model',
        eventSink: () => undefined,
      })
      expect(service).toBeDefined()
    })
    const dependencies: CliDependencies = {
      createService,
      mcpServe: serve,
    }

    await expect(
      run(['mcp', 'serve', '-d', '--verbose'], capture.io, dependencies),
    ).resolves.toBe(0)
    expect(serve).toHaveBeenCalledTimes(1)
    expect(createService).toHaveBeenCalledWith(
      expect.objectContaining({
        requireProvider: false,
        exposeToolRegistry: true,
      }),
    )
    expect(createService).toHaveBeenCalledWith(
      expect.objectContaining({
        requireProvider: true,
        agent: 'reviewer',
        controls: expect.objectContaining({ model: 'fixture-model' }),
      }),
    )
    expect(close).toHaveBeenCalledTimes(1)
    expect(capture.stdout).toEqual([])
  })

  it('rejects MCP-only flags on unrelated commands', async () => {
    for (const argv of [
      ['run', '--no-browser', 'prompt'],
      ['mcp', 'login', 'fixture', '--mcp-debug'],
      ['mcp', 'serve', '--no-browser'],
    ]) {
      const capture = captureIO()
      await expect(run(argv, capture.io, baseDependencies())).resolves.toBe(1)
      expect(capture.stderr.join('')).toMatch(/only valid with/u)
    }
  })
})
