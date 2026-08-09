import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { auth } from '@modelcontextprotocol/sdk/client/auth.js'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  authenticateMcpServer,
  ClaudeMcpOAuthProvider,
  ClaudeMcpOAuthStore,
  loadMcpOAuthProvider,
  mcpOAuthCredentialService,
  mcpOAuthRecordKey,
  type McpOAuthServerIdentity,
} from './claude-mcp-oauth.js'

const roots: string[] = []
const servers: Server[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  )
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  )
})

async function temporaryConfigRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'praxis-mcp-oauth-'))
  roots.push(root)
  return root
}

async function availablePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('callback fixture did not expose a port')
  }
  await new Promise<void>((resolvePromise) =>
    server.close(() => resolvePromise()),
  )
  return address.port
}

interface OAuthFixture {
  issuer: string
  server: McpOAuthServerIdentity
  registrations: Record<string, unknown>[]
  tokenRequests: URLSearchParams[]
}

async function startOAuthFixture(): Promise<OAuthFixture> {
  let issuer = ''
  const registrations: Record<string, unknown>[] = []
  const tokenRequests: URLSearchParams[] = []
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', issuer)
    let body = ''
    request.setEncoding('utf8')
    for await (const chunk of request) body += chunk
    const json = (status: number, value: unknown): void => {
      response
        .writeHead(status, { 'content-type': 'application/json' })
        .end(JSON.stringify(value))
    }
    if (
      url.pathname === '/.well-known/oauth-protected-resource/mcp' ||
      url.pathname === '/.well-known/oauth-protected-resource'
    ) {
      json(200, {
        resource: `${issuer}/mcp`,
        authorization_servers: [issuer],
        scopes_supported: ['mcp'],
      })
      return
    }
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      json(200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        registration_endpoint: `${issuer}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'],
        code_challenge_methods_supported: ['S256'],
      })
      return
    }
    if (url.pathname === '/register' && request.method === 'POST') {
      registrations.push(JSON.parse(body) as Record<string, unknown>)
      json(201, {
        client_id: 'fixture-client',
        client_secret: 'fixture-secret',
        redirect_uris: (registrations.at(-1)?.redirect_uris ?? []) as string[],
      })
      return
    }
    if (url.pathname === '/token' && request.method === 'POST') {
      const params = new URLSearchParams(body)
      tokenRequests.push(params)
      if (params.get('grant_type') === 'refresh_token') {
        json(200, {
          access_token: 'fixture-refreshed',
          token_type: 'Bearer',
          expires_in: 7200,
          scope: 'mcp',
        })
        return
      }
      json(200, {
        access_token: 'fixture-access',
        refresh_token: 'fixture-refresh',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'mcp',
      })
      return
    }
    json(404, { error: 'not_found' })
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no address')
  issuer = `http://127.0.0.1:${address.port}`
  return {
    issuer,
    server: { name: 'fixture-token', type: 'http', url: `${issuer}/mcp` },
    registrations,
    tokenRequests,
  }
}

describe('Claude MCP OAuth compatibility', () => {
  it('derives the Claude credential record and custom-root service keys', () => {
    expect(
      mcpOAuthRecordKey({
        name: 'fixture-token',
        type: 'http',
        url: 'http://127.0.0.1:18999/mcp',
      }),
    ).toBe('fixture-token|74351e277c42d144')
    expect(mcpOAuthCredentialService('/tmp/praxis-oauth-fixture')).toBe(
      'Claude Code-credentials-e8f6c73b',
    )
  })

  it('round-trips the shared credential file without replacing unrelated state', async () => {
    const configRoot = await temporaryConfigRoot()
    await mkdir(configRoot, { recursive: true })
    await writeFile(
      join(configRoot, '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: { accessToken: 'keep-account' },
        custom: { keep: true },
        mcpOAuth: {
          'other|record': {
            serverName: 'other',
            serverUrl: 'https://other.example/mcp',
            accessToken: 'keep-other',
          },
        },
      }),
    )
    const server: McpOAuthServerIdentity = {
      name: 'fixture',
      type: 'http',
      url: 'https://example.com/mcp',
    }
    const store = new ClaudeMcpOAuthStore({ configRoot, useKeychain: false })
    await store.mutate(server, () => ({
      serverName: server.name,
      serverUrl: server.url,
      accessToken: 'new-token',
    }))

    const value = JSON.parse(
      await readFile(join(configRoot, '.credentials.json'), 'utf8'),
    )
    expect(value).toMatchObject({
      claudeAiOauth: { accessToken: 'keep-account' },
      custom: { keep: true },
      mcpOAuth: {
        'other|record': { accessToken: 'keep-other' },
        [mcpOAuthRecordKey(server)]: { accessToken: 'new-token' },
      },
    })
  })

  it('updates and removes plugin secrets without replacing other credentials', async () => {
    const configRoot = await temporaryConfigRoot()
    await mkdir(configRoot, { recursive: true })
    await writeFile(
      join(configRoot, '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: { accessToken: 'keep-account' },
        pluginSecrets: {
          'fixture@market': { old: 'remove-me', keep: 'old-value' },
          'fixture@market/server': { token: 'remove-composite' },
          'other@market': { token: 'keep-other' },
        },
      }),
    )
    const store = new ClaudeMcpOAuthStore({
      configRoot,
      useKeychain: false,
    })

    await store.updatePluginSecrets(
      'fixture@market',
      { token: 'new-secret', keep: 'new-value' },
      ['old'],
    )
    await expect(store.readPluginSecrets('fixture@market')).resolves.toEqual({
      keep: 'new-value',
      token: 'new-secret',
    })
    await store.deletePluginSecrets('fixture@market')

    const stored = JSON.parse(
      await readFile(join(configRoot, '.credentials.json'), 'utf8'),
    )
    expect(stored).toEqual({
      claudeAiOauth: { accessToken: 'keep-account' },
      pluginSecrets: { 'other@market': { token: 'keep-other' } },
    })
  })

  it('persists discovery, client, and tokens and clears only the selected record', async () => {
    const configRoot = await temporaryConfigRoot()
    const store = new ClaudeMcpOAuthStore({ configRoot, useKeychain: false })
    const selected: McpOAuthServerIdentity = {
      name: 'selected',
      type: 'http',
      url: 'https://selected.example/mcp',
    }
    const other: McpOAuthServerIdentity = {
      name: 'other',
      type: 'sse',
      url: 'https://other.example/sse',
    }
    await store.mutate(other, () => ({
      serverName: other.name,
      serverUrl: other.url,
      accessToken: 'other-token',
    }))
    const provider = new ClaudeMcpOAuthProvider(
      store,
      selected,
      'http://localhost:54321/callback',
      async () => undefined,
    )
    await provider.saveDiscoveryState({
      authorizationServerUrl: 'https://auth.example',
    })
    await provider.saveClientInformation({
      client_id: 'client-id',
      client_secret: 'client-secret',
    })
    await provider.saveTokens({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      token_type: 'Bearer',
      expires_in: 60,
      scope: 'mcp',
    })

    await expect(store.read(selected)).resolves.toMatchObject({
      serverName: 'selected',
      serverUrl: 'https://selected.example/mcp',
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'http://localhost:54321/callback',
      scope: 'mcp',
      discoveryState: {
        authorizationServerUrl: 'https://auth.example',
        oauthMetadataFound: false,
      },
    })
    await store.clear(selected)
    await expect(store.read(selected)).resolves.toBeUndefined()
    await expect(store.read(other)).resolves.toMatchObject({
      accessToken: 'other-token',
    })
  })

  it('re-registers a dynamic client when the loopback callback port changes', async () => {
    const configRoot = await temporaryConfigRoot()
    const server: McpOAuthServerIdentity = {
      name: 'redirect-change',
      type: 'http',
      url: 'https://redirect-change.example/mcp',
    }
    const store = new ClaudeMcpOAuthStore({ configRoot, useKeychain: false })
    const provider = new ClaudeMcpOAuthProvider(
      store,
      server,
      'http://localhost:10001/callback',
      async () => undefined,
      {
        serverName: server.name,
        serverUrl: server.url,
        accessToken: 'expired',
        clientId: 'old-client',
        clientSecret: 'old-secret',
        redirectUri: 'http://localhost:10000/callback',
      },
    )

    expect(provider.clientInformation()).toBeUndefined()
    await provider.saveClientInformation({
      client_id: 'new-client',
      client_secret: 'new-secret',
    })
    expect(provider.clientInformation()).toMatchObject({
      client_id: 'new-client',
      redirect_uris: ['http://localhost:10001/callback'],
    })
  })

  it('completes discovery, DCR, PKCE, token exchange, and refresh', async () => {
    vi.stubEnv('PRAXIS_MCP_OAUTH_STORE', 'file')
    const configRoot = await temporaryConfigRoot()
    const fixture = await startOAuthFixture()
    let authorizationUrl: URL | undefined

    await expect(
      authenticateMcpServer({
        configRoot,
        server: fixture.server,
        write: () => undefined,
        openBrowser: async (url) => {
          authorizationUrl = url
          const redirect = new URL(url.searchParams.get('redirect_uri') ?? '')
          redirect.searchParams.set('code', 'fixture-code')
          redirect.searchParams.set(
            'state',
            url.searchParams.get('state') ?? '',
          )
          const response = await fetch(redirect)
          expect(response.ok).toBe(true)
        },
      }),
    ).resolves.toBe('AUTHORIZED')

    expect(authorizationUrl?.searchParams.get('code_challenge_method')).toBe(
      'S256',
    )
    expect(fixture.registrations).toEqual([
      expect.objectContaining({
        client_name: 'Praxis (fixture-token)',
        redirect_uris: [
          expect.stringMatching(/^http:\/\/localhost:\d+\/callback$/u),
        ],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
    ])
    expect(fixture.tokenRequests[0]?.get('grant_type')).toBe(
      'authorization_code',
    )
    expect(fixture.tokenRequests[0]?.get('code')).toBe('fixture-code')
    expect(fixture.tokenRequests[0]?.get('code_verifier')).toMatch(
      /^[A-Za-z0-9._~-]{43,128}$/u,
    )
    expect(fixture.tokenRequests[0]?.get('resource')).toBe(fixture.server.url)

    const stored = await new ClaudeMcpOAuthStore({
      configRoot,
      useKeychain: false,
    }).read(fixture.server)
    expect(stored).toMatchObject({
      accessToken: 'fixture-access',
      refreshToken: 'fixture-refresh',
      clientId: 'fixture-client',
      clientSecret: 'fixture-secret',
      scope: 'mcp',
      discoveryState: {
        authorizationServerUrl: fixture.issuer,
        oauthMetadataFound: true,
      },
    })

    const provider = await loadMcpOAuthProvider(configRoot, fixture.server)
    expect(provider).toBeDefined()
    await expect(
      auth(provider as ClaudeMcpOAuthProvider, {
        serverUrl: fixture.server.url,
      }),
    ).resolves.toBe('AUTHORIZED')
    expect(fixture.tokenRequests[1]?.get('grant_type')).toBe('refresh_token')
    await expect(
      new ClaudeMcpOAuthStore({ configRoot, useKeychain: false }).read(
        fixture.server,
      ),
    ).resolves.toMatchObject({
      accessToken: 'fixture-refreshed',
      refreshToken: 'fixture-refresh',
    })
  })

  it('uses configured OAuth credentials and callback port without inventing a token', async () => {
    vi.stubEnv('PRAXIS_MCP_OAUTH_STORE', 'file')
    const configRoot = await temporaryConfigRoot()
    const fixture = await startOAuthFixture()
    const callbackPort = await availablePort()
    const server = {
      ...fixture.server,
      clientId: 'configured-client',
      callbackPort,
    }
    const store = new ClaudeMcpOAuthStore({ configRoot, useKeychain: false })
    await store.saveClientSecret(server, 'configured-secret')
    let authorizationUrl: URL | undefined

    await expect(
      authenticateMcpServer({
        configRoot,
        server,
        write: () => undefined,
        openBrowser: async (url) => {
          authorizationUrl = url
          const redirect = new URL(url.searchParams.get('redirect_uri') ?? '')
          redirect.searchParams.set('code', 'configured-code')
          redirect.searchParams.set(
            'state',
            url.searchParams.get('state') ?? '',
          )
          const response = await fetch(redirect)
          expect(response.ok).toBe(true)
        },
      }),
    ).resolves.toBe('AUTHORIZED')

    expect(authorizationUrl?.searchParams.get('redirect_uri')).toBe(
      `http://localhost:${callbackPort}/callback`,
    )
    expect(fixture.registrations).toEqual([])
    expect(fixture.tokenRequests[0]?.get('code')).toBe('configured-code')
    await expect(store.read(server)).resolves.toMatchObject({
      accessToken: 'fixture-access',
      refreshToken: 'fixture-refresh',
    })
    const loaded = await loadMcpOAuthProvider(configRoot, server)
    expect(loaded?.clientInformation()).toMatchObject({
      client_id: 'configured-client',
      client_secret: 'configured-secret',
      redirect_uris: [
        expect.stringMatching(/^http:\/\/localhost:\d+\/callback$/u),
      ],
    })
  })

  it.each([
    {
      name: 'state mismatch',
      redirect: (authorization: URL) => {
        const redirect = new URL(
          authorization.searchParams.get('redirect_uri') ?? '',
        )
        redirect.searchParams.set('code', 'fixture-code')
        redirect.searchParams.set('state', 'wrong-state')
        return redirect.toString()
      },
      error: /redirect state did not match/u,
    },
    {
      name: 'callback path mismatch',
      redirect: (authorization: URL) => {
        const redirect = new URL(
          authorization.searchParams.get('redirect_uri') ?? '',
        )
        redirect.pathname = '/other'
        redirect.searchParams.set('code', 'fixture-code')
        redirect.searchParams.set(
          'state',
          authorization.searchParams.get('state') ?? '',
        )
        return redirect.toString()
      },
      error: /does not match the local callback/u,
    },
    {
      name: 'callback origin mismatch',
      redirect: (authorization: URL) => {
        const redirect = new URL('http://localhost:9/callback')
        redirect.searchParams.set('code', 'fixture-code')
        redirect.searchParams.set(
          'state',
          authorization.searchParams.get('state') ?? '',
        )
        return redirect.toString()
      },
      error: /does not match the local callback/u,
    },
  ])('rejects $name', async ({ redirect, error }) => {
    vi.stubEnv('PRAXIS_MCP_OAUTH_STORE', 'file')
    const configRoot = await temporaryConfigRoot()
    const fixture = await startOAuthFixture()
    let authorizationUrl: URL | undefined

    await expect(
      authenticateMcpServer({
        configRoot,
        server: fixture.server,
        noBrowser: true,
        write: (message) => {
          const match = message.match(/https?:\/\/\S+/u)
          if (match) authorizationUrl = new URL(match[0])
        },
        readRedirectUrl: async () => {
          if (!authorizationUrl) throw new Error('missing authorization URL')
          return redirect(authorizationUrl)
        },
      }),
    ).rejects.toThrow(error)
    expect(fixture.tokenRequests).toHaveLength(0)
  })
})
