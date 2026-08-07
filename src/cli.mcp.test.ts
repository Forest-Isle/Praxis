import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { run, type CliDependencies, type CliIO } from './cli.js'
import { ClaudeMcpOAuthStore } from './mcp/claude-mcp-oauth.js'

const roots: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
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

describe('Praxis MCP CLI commands', () => {
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
