import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

import {
  auth,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'

import { writeFileAtomically } from '../platform/atomic-write.js'
import { ExclusiveFileLease } from '../platform/exclusive-file-lease.js'

const execFileAsync = promisify(execFile)
const CREDENTIAL_SERVICE = 'Claude Code-credentials'
const MAX_CREDENTIAL_BYTES = 2 * 1024 * 1024
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000
const LOCK_WAIT_MS = 10_000

export interface McpOAuthServerIdentity {
  name: string
  type: 'http' | 'sse'
  url: string
  headers?: Record<string, string>
  clientId?: string
  callbackPort?: number
}

export interface ClaudeMcpOAuthRecord {
  serverName: string
  serverUrl: string
  accessToken: string
  discoveryState?: {
    authorizationServerUrl?: string
    oauthMetadataFound?: boolean
  }
  clientId?: string
  clientSecret?: string
  redirectUri?: string
  refreshToken?: string
  expiresAt?: number
  scope?: string
}

interface CredentialEnvelope {
  mcpOAuth?: Record<string, ClaudeMcpOAuthRecord>
  mcpOAuthClientConfig?: Record<string, { clientSecret?: string }>
  [key: string]: unknown
}

export interface McpOAuthStoreOptions {
  configRoot: string
  useKeychain?: boolean
}

export interface McpOAuthLoginOptions {
  configRoot: string
  server: McpOAuthServerIdentity
  clientId?: string
  clientSecret?: string
  callbackPort?: number
  noBrowser?: boolean
  write: (message: string) => void
  readRedirectUrl?: () => Promise<string>
  openBrowser?: (url: URL) => Promise<void>
}

interface ConfiguredMcpOAuthClient {
  clientId: string
  clientSecret?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function validExpiresAt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function normalizeRecord(value: unknown): ClaudeMcpOAuthRecord | undefined {
  if (!isRecord(value)) return undefined
  const serverName = stringValue(value.serverName)
  const serverUrl = stringValue(value.serverUrl)
  if (!serverName || !serverUrl) return undefined
  const discovery = isRecord(value.discoveryState)
    ? {
        ...(stringValue(value.discoveryState.authorizationServerUrl)
          ? {
              authorizationServerUrl: value.discoveryState
                .authorizationServerUrl as string,
            }
          : {}),
        ...(typeof value.discoveryState.oauthMetadataFound === 'boolean'
          ? { oauthMetadataFound: value.discoveryState.oauthMetadataFound }
          : {}),
      }
    : undefined
  return {
    serverName,
    serverUrl,
    accessToken: stringValue(value.accessToken) ?? '',
    ...(discovery === undefined ? {} : { discoveryState: discovery }),
    ...(stringValue(value.clientId)
      ? { clientId: value.clientId as string }
      : {}),
    ...(stringValue(value.clientSecret)
      ? { clientSecret: value.clientSecret as string }
      : {}),
    ...(stringValue(value.redirectUri)
      ? { redirectUri: value.redirectUri as string }
      : {}),
    ...(stringValue(value.refreshToken)
      ? { refreshToken: value.refreshToken as string }
      : {}),
    ...(validExpiresAt(value.expiresAt) === undefined
      ? {}
      : { expiresAt: value.expiresAt as number }),
    ...(stringValue(value.scope) ? { scope: value.scope as string } : {}),
  }
}

function stableServerConfig(server: McpOAuthServerIdentity): string {
  return JSON.stringify({
    type: server.type,
    url: server.url,
    headers: server.headers ?? {},
  })
}

export function mcpOAuthRecordKey(server: McpOAuthServerIdentity): string {
  const digest = createHash('sha256')
    .update(stableServerConfig(server))
    .digest('hex')
    .slice(0, 16)
  return `${server.name}|${digest}`
}

export function mcpOAuthCredentialService(configRoot: string): string {
  const canonical = resolve(configRoot)
  const defaultRoot = resolve(join(homedir(), '.claude'))
  if (canonical === defaultRoot) return CREDENTIAL_SERVICE
  const digest = createHash('sha256')
    .update(canonical)
    .digest('hex')
    .slice(0, 8)
  return `${CREDENTIAL_SERVICE}-${digest}`
}

function credentialPath(configRoot: string): string {
  return join(resolve(configRoot), '.credentials.json')
}

function parseEnvelope(source: string): CredentialEnvelope {
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch (error) {
    throw new Error('Invalid MCP OAuth credential JSON', { cause: error })
  }
  if (!isRecord(value))
    throw new Error('MCP OAuth credentials must be an object')
  const envelope: CredentialEnvelope = { ...value }
  if (envelope.mcpOAuth !== undefined && !isRecord(envelope.mcpOAuth)) {
    throw new Error('MCP OAuth credentials mcpOAuth must be an object')
  }
  return envelope
}

function credentialAccount(): string {
  try {
    return userInfo().username
  } catch {
    return process.env.USER ?? 'user'
  }
}

async function readFileEnvelope(path: string): Promise<CredentialEnvelope> {
  try {
    const source = await readFile(path, 'utf8')
    if (Buffer.byteLength(source) > MAX_CREDENTIAL_BYTES) {
      throw new Error('MCP OAuth credential file exceeds 2 MiB')
    }
    return parseEnvelope(source)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
}

async function readKeychainEnvelope(
  service: string,
): Promise<CredentialEnvelope | undefined> {
  try {
    const result = await execFileAsync(
      'security',
      ['find-generic-password', '-a', credentialAccount(), '-s', service, '-w'],
      { maxBuffer: MAX_CREDENTIAL_BYTES },
    )
    return parseEnvelope(result.stdout)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    const detail = [
      String(error),
      String((error as { stderr?: unknown }).stderr ?? ''),
    ].join('\n')
    if (
      code === 'ENOENT' ||
      /could not be found|SecKeychainSearchCopyNext/u.test(detail)
    ) {
      return undefined
    }
    throw error
  }
}

async function writeKeychainEnvelope(
  service: string,
  envelope: CredentialEnvelope,
): Promise<void> {
  const source = JSON.stringify(envelope)
  if (Buffer.byteLength(source) > MAX_CREDENTIAL_BYTES) {
    throw new Error('MCP OAuth credentials exceed 2 MiB')
  }
  await execFileAsync(
    'security',
    [
      'add-generic-password',
      '-U',
      '-a',
      credentialAccount(),
      '-s',
      service,
      '-w',
      source,
    ],
    { maxBuffer: MAX_CREDENTIAL_BYTES },
  )
}

export class ClaudeMcpOAuthStore {
  private readonly configRoot: string
  private readonly useKeychain: boolean
  private readonly service: string
  private readonly lease: ExclusiveFileLease

  constructor(options: McpOAuthStoreOptions) {
    this.configRoot = resolve(options.configRoot)
    this.useKeychain =
      options.useKeychain ??
      (process.platform === 'darwin' &&
        process.env.PRAXIS_MCP_OAUTH_STORE !== 'file')
    this.service = mcpOAuthCredentialService(this.configRoot)
    this.lease = new ExclusiveFileLease(
      join(this.configRoot, '.mcp-oauth.lock'),
    )
  }

  async read(
    server: McpOAuthServerIdentity,
  ): Promise<ClaudeMcpOAuthRecord | undefined> {
    const envelope = await this.readEnvelope()
    return normalizeRecord(envelope.mcpOAuth?.[mcpOAuthRecordKey(server)])
  }

  async mutate(
    server: McpOAuthServerIdentity,
    update: (
      current: ClaudeMcpOAuthRecord | undefined,
    ) => ClaudeMcpOAuthRecord | undefined,
  ): Promise<ClaudeMcpOAuthRecord | undefined> {
    return this.withLock(async () => {
      const envelope = await this.readEnvelope()
      const entries = isRecord(envelope.mcpOAuth)
        ? { ...(envelope.mcpOAuth as Record<string, unknown>) }
        : {}
      const key = mcpOAuthRecordKey(server)
      const current = normalizeRecord(entries[key])
      const next = update(current)
      if (next === undefined) delete entries[key]
      else entries[key] = next
      if (Object.keys(entries).length === 0) delete envelope.mcpOAuth
      else envelope.mcpOAuth = entries as Record<string, ClaudeMcpOAuthRecord>
      await this.writeEnvelope(envelope)
      return next
    })
  }

  async clear(server: McpOAuthServerIdentity): Promise<void> {
    await this.mutate(server, () => undefined)
  }

  async readClientSecret(
    server: McpOAuthServerIdentity,
  ): Promise<string | undefined> {
    const envelope = await this.readEnvelope()
    return stringValue(
      envelope.mcpOAuthClientConfig?.[mcpOAuthRecordKey(server)]?.clientSecret,
    )
  }

  async saveClientSecret(
    server: McpOAuthServerIdentity,
    clientSecret: string,
  ): Promise<void> {
    await this.withLock(async () => {
      const envelope = await this.readEnvelope()
      const existing = isRecord(envelope.mcpOAuthClientConfig)
        ? { ...envelope.mcpOAuthClientConfig }
        : {}
      const key = mcpOAuthRecordKey(server)
      const current = isRecord(existing[key]) ? existing[key] : {}
      existing[key] = { ...current, clientSecret }
      envelope.mcpOAuthClientConfig = existing as Record<
        string,
        { clientSecret?: string }
      >
      await this.writeEnvelope(envelope)
    })
  }

  private async readEnvelope(): Promise<CredentialEnvelope> {
    if (this.useKeychain) {
      const keychain = await readKeychainEnvelope(this.service)
      if (keychain !== undefined) return keychain
    }
    return readFileEnvelope(credentialPath(this.configRoot))
  }

  private async writeEnvelope(envelope: CredentialEnvelope): Promise<void> {
    if (this.useKeychain) {
      try {
        await writeKeychainEnvelope(this.service, envelope)
        return
      } catch (error) {
        if (process.platform !== 'darwin') throw error
      }
    }
    const committed = await writeFileAtomically(
      credentialPath(this.configRoot),
      `${JSON.stringify(envelope, null, 2)}\n`,
    )
    if (!committed)
      throw new Error('MCP OAuth credential write was interrupted')
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const started = Date.now()
    let lock = await this.lease.tryAcquire()
    while (!lock) {
      if (Date.now() - started >= LOCK_WAIT_MS) {
        throw new Error('MCP OAuth credential store is locked')
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
      lock = await this.lease.tryAcquire()
    }
    try {
      return await operation()
    } finally {
      await lock.release()
    }
  }
}

function clientMetadata(
  serverName: string,
  redirectUri: string,
): OAuthClientMetadata {
  return {
    client_name: `Praxis (${serverName})`,
    redirect_uris: [redirectUri],
    response_types: ['code'],
    grant_types: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_method: 'none',
  }
}

export async function readMcpClientSecret(): Promise<string> {
  const envSecret = process.env.MCP_CLIENT_SECRET
  if (envSecret) return envSecret
  if (!process.stdin.isTTY) {
    throw new Error(
      'No TTY available to prompt for client secret. Set MCP_CLIENT_SECRET env var instead.',
    )
  }
  return new Promise((resolvePromise, rejectPromise) => {
    process.stderr.write('Enter OAuth client secret: ')
    process.stdin.setRawMode?.(true)
    let secret = ''
    const onData = (chunk: Buffer) => {
      const value = chunk.toString()
      if (value === '\n' || value === '\r') {
        process.stdin.setRawMode?.(false)
        process.stdin.removeListener('data', onData)
        process.stderr.write('\n')
        resolvePromise(secret)
      } else if (value === '\u0003') {
        process.stdin.setRawMode?.(false)
        process.stdin.removeListener('data', onData)
        rejectPromise(new Error('Cancelled'))
      } else if (value === '\u007f' || value === '\b') {
        secret = secret.slice(0, -1)
      } else {
        secret += value
      }
    }
    process.stdin.on('data', onData)
  })
}

export class ClaudeMcpOAuthProvider implements OAuthClientProvider {
  private codeVerifierValue: string | undefined
  private stateValue: string | undefined
  private recordValue: ClaudeMcpOAuthRecord | undefined

  constructor(
    private readonly store: ClaudeMcpOAuthStore,
    private readonly server: McpOAuthServerIdentity,
    private readonly redirectUri: string,
    private readonly onAuthorization: (url: URL) => Promise<void>,
    record?: ClaudeMcpOAuthRecord,
    private readonly configuredClient?: ConfiguredMcpOAuthClient,
  ) {
    this.recordValue = record
  }

  get redirectUrl(): string {
    return this.redirectUri
  }

  get clientMetadata(): OAuthClientMetadata {
    return clientMetadata(this.server.name, this.redirectUri)
  }

  async state(): Promise<string> {
    this.stateValue ??= randomBytes(32).toString('base64url')
    return this.stateValue
  }

  authorizationState(): string {
    if (!this.stateValue)
      throw new Error('MCP OAuth authorization state is unavailable')
    return this.stateValue
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    if (
      this.recordValue?.clientId &&
      this.recordValue.redirectUri === this.redirectUri
    ) {
      return {
        client_id: this.recordValue.clientId,
        ...(this.recordValue.clientSecret
          ? { client_secret: this.recordValue.clientSecret }
          : {}),
        redirect_uris: [this.recordValue.redirectUri ?? this.redirectUri],
        token_endpoint_auth_method: 'none',
      }
    }
    if (!this.configuredClient) return undefined
    return {
      client_id: this.configuredClient.clientId,
      ...(this.configuredClient.clientSecret
        ? { client_secret: this.configuredClient.clientSecret }
        : {}),
      redirect_uris: [this.redirectUri],
      token_endpoint_auth_method: 'none',
    }
  }

  async saveClientInformation(
    information: OAuthClientInformationMixed,
  ): Promise<void> {
    if (typeof information.client_id !== 'string') {
      throw new Error('MCP OAuth client registration returned no client_id')
    }
    this.recordValue = await this.store.mutate(this.server, (current) => ({
      serverName: this.server.name,
      serverUrl: this.server.url,
      accessToken: current?.accessToken ?? '',
      ...(current?.discoveryState === undefined
        ? {}
        : { discoveryState: current.discoveryState }),
      clientId: information.client_id,
      ...(typeof information.client_secret === 'string'
        ? { clientSecret: information.client_secret }
        : {}),
      redirectUri: this.redirectUri,
      ...(current?.refreshToken ? { refreshToken: current.refreshToken } : {}),
      ...(current?.expiresAt === undefined
        ? {}
        : { expiresAt: current.expiresAt }),
      ...(current?.scope ? { scope: current.scope } : {}),
    }))
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const record = this.recordValue ?? (await this.store.read(this.server))
    this.recordValue = record
    if (!record?.accessToken) return undefined
    const expiresIn =
      record.expiresAt === undefined
        ? undefined
        : Math.max(0, Math.floor((record.expiresAt - Date.now()) / 1000))
    return {
      access_token: record.accessToken,
      token_type: 'Bearer',
      ...(record.refreshToken ? { refresh_token: record.refreshToken } : {}),
      ...(expiresIn === undefined ? {} : { expires_in: expiresIn }),
      ...(record.scope ? { scope: record.scope } : {}),
    }
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    if (!tokens.access_token)
      throw new Error('MCP OAuth token response had no access_token')
    const expiresAt =
      typeof tokens.expires_in === 'number'
        ? Date.now() + Math.max(0, tokens.expires_in) * 1000
        : undefined
    this.recordValue = await this.store.mutate(this.server, (current) => ({
      serverName: this.server.name,
      serverUrl: this.server.url,
      accessToken: tokens.access_token,
      ...(current?.discoveryState === undefined
        ? {}
        : { discoveryState: current.discoveryState }),
      ...(current?.clientId ? { clientId: current.clientId } : {}),
      ...(current?.clientSecret ? { clientSecret: current.clientSecret } : {}),
      redirectUri: current?.redirectUri ?? this.redirectUri,
      ...(tokens.refresh_token
        ? { refreshToken: tokens.refresh_token }
        : current?.refreshToken
          ? { refreshToken: current.refreshToken }
          : {}),
      ...(expiresAt === undefined ? {} : { expiresAt }),
      ...(tokens.scope
        ? { scope: tokens.scope }
        : current?.scope
          ? { scope: current.scope }
          : {}),
    }))
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    await this.onAuthorization(url)
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.codeVerifierValue = codeVerifier
  }

  codeVerifier(): string {
    if (!this.codeVerifierValue)
      throw new Error('MCP OAuth code verifier is unavailable')
    return this.codeVerifierValue
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    this.recordValue = await this.store.mutate(this.server, (current) => ({
      serverName: this.server.name,
      serverUrl: this.server.url,
      accessToken: current?.accessToken ?? '',
      discoveryState: {
        ...(state.authorizationServerUrl
          ? { authorizationServerUrl: String(state.authorizationServerUrl) }
          : {}),
        oauthMetadataFound: state.authorizationServerMetadata !== undefined,
      },
      ...(current?.clientId ? { clientId: current.clientId } : {}),
      ...(current?.clientSecret ? { clientSecret: current.clientSecret } : {}),
      ...(current?.redirectUri
        ? { redirectUri: current.redirectUri }
        : { redirectUri: this.redirectUri }),
      ...(current?.refreshToken ? { refreshToken: current.refreshToken } : {}),
      ...(current?.expiresAt === undefined
        ? {}
        : { expiresAt: current.expiresAt }),
      ...(current?.scope ? { scope: current.scope } : {}),
    }))
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    const state = this.recordValue?.discoveryState
    if (!state?.authorizationServerUrl) return undefined
    return { authorizationServerUrl: state.authorizationServerUrl }
  }

  async invalidateCredentials(
    scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery',
  ): Promise<void> {
    if (scope === 'all') {
      this.recordValue = undefined
      await this.store.clear(this.server)
      return
    }
    this.recordValue = await this.store.mutate(this.server, (current) => {
      if (!current) return undefined
      if (scope === 'tokens') {
        const next = { ...current, accessToken: '' }
        delete next.refreshToken
        delete next.expiresAt
        delete next.scope
        return next
      }
      if (scope === 'client') {
        const next = { ...current }
        delete next.clientId
        delete next.clientSecret
        return next
      }
      if (scope === 'discovery') {
        const next = { ...current }
        delete next.discoveryState
        return next
      }
      if (scope === 'verifier') this.codeVerifierValue = undefined
      return current
    })
  }
}

export function mcpOAuthServerIdentity(
  name: string,
  config: Record<string, unknown>,
): McpOAuthServerIdentity {
  const type =
    config.type === 'sse'
      ? 'sse'
      : config.type === 'http' || config.url !== undefined
        ? 'http'
        : undefined
  if (!type || typeof config.url !== 'string' || config.url.length === 0) {
    throw new Error(
      `MCP server ${name} must use HTTP or SSE transport for OAuth`,
    )
  }
  const headers = isStringRecord(config.headers) ? config.headers : undefined
  const oauth = isRecord(config.oauth) ? config.oauth : undefined
  const clientId = stringValue(oauth?.clientId)
  const callbackPort =
    typeof oauth?.callbackPort === 'number' &&
    Number.isFinite(oauth.callbackPort)
      ? oauth.callbackPort
      : undefined
  return {
    name,
    type,
    url: config.url,
    ...(headers ? { headers } : {}),
    ...(clientId ? { clientId } : {}),
    ...(callbackPort === undefined ? {} : { callbackPort }),
  }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.values(value).every((item) => typeof item === 'string')
  )
}

async function listenCallbackServer(port = 0): Promise<{
  server: Server
  redirectUri: string
  wait: () => Promise<string>
}> {
  let callbackOrigin = 'http://localhost'
  let resolveCallback: (url: string) => void = () => undefined
  let rejectCallback: (error: Error) => void = () => undefined
  const callback = new Promise<string>((resolvePromise, rejectPromise) => {
    resolveCallback = resolvePromise
    rejectCallback = rejectPromise
  })
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (url.pathname !== '/callback') {
      response.writeHead(404)
      response.end('Not found')
      return
    }
    const callbackUrl = `${callbackOrigin}${url.pathname}${url.search}`
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(
      '<html><body>Praxis authorization received. You may close this tab.</body></html>',
    )
    resolveCallback(callbackUrl)
  })
  server.on('error', (error) => rejectCallback(error))
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('listening', () => resolvePromise())
    server.once('error', rejectPromise)
    server.listen(port, '127.0.0.1')
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    await new Promise<void>((resolvePromise) =>
      server.close(() => resolvePromise()),
    )
    throw new Error('MCP OAuth callback server did not expose a port')
  }
  callbackOrigin = `http://localhost:${address.port}`
  return {
    server,
    redirectUri: `http://localhost:${address.port}/callback`,
    wait: () => callback,
  }
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolvePromise) =>
    server.close(() => resolvePromise()),
  )
}

async function defaultOpenBrowser(url: URL): Promise<void> {
  const command =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'cmd'
        : 'xdg-open'
  const args =
    process.platform === 'win32'
      ? ['/c', 'start', '', url.toString()]
      : [url.toString()]
  await execFileAsync(command, args, { timeout: 10_000 }).catch(() => undefined)
}

async function firstInputLine(
  readRedirectUrl: () => Promise<string>,
): Promise<string> {
  const value = await readRedirectUrl()
  if (value.trim().length === 0)
    throw new Error('MCP OAuth redirect URL is required')
  return value.trim()
}

function callbackParameter(url: URL, name: string): string | undefined {
  const values = url.searchParams.getAll(name)
  if (values.length > 1) {
    throw new Error(`MCP OAuth redirect URL contained multiple ${name} values`)
  }
  return values[0]
}

function validateAuthorizationCallback(
  value: string,
  redirectUri: string,
  expectedState: string,
): URL {
  let actual: URL
  try {
    actual = new URL(value)
  } catch (error) {
    throw new Error('MCP OAuth redirect URL is invalid', { cause: error })
  }
  const expected = new URL(redirectUri)
  if (
    actual.origin !== expected.origin ||
    actual.pathname !== expected.pathname
  ) {
    throw new Error('MCP OAuth redirect URL does not match the local callback')
  }
  const state = callbackParameter(actual, 'state')
  if (!state || state !== expectedState) {
    throw new Error(
      'MCP OAuth redirect state did not match the authorization request',
    )
  }
  return actual
}

export async function authenticateMcpServer(
  options: McpOAuthLoginOptions,
): Promise<'AUTHORIZED'> {
  const callback = await listenCallbackServer(
    options.callbackPort ?? options.server.callbackPort,
  )
  const store = new ClaudeMcpOAuthStore({ configRoot: options.configRoot })
  const existing = await store.read(options.server)
  const clientId = options.clientId ?? options.server.clientId
  const clientSecret =
    options.clientSecret ??
    (clientId ? await store.readClientSecret(options.server) : undefined)
  const provider = new ClaudeMcpOAuthProvider(
    store,
    options.server,
    callback.redirectUri,
    async (url) => {
      options.write(`Visit this URL to authorize:\n  ${url}\n`)
      if (!options.noBrowser) {
        await (options.openBrowser ?? defaultOpenBrowser)(url)
      }
    },
    existing,
    clientId
      ? {
          clientId,
          ...(clientSecret ? { clientSecret } : {}),
        }
      : undefined,
  )
  try {
    const result = await auth(provider, { serverUrl: options.server.url })
    if (result === 'REDIRECT') {
      const input = options.noBrowser
        ? options.readRedirectUrl
          ? firstInputLine(options.readRedirectUrl)
          : callback.wait()
        : callback.wait()
      let timeout: NodeJS.Timeout | undefined
      let redirectUrl: string
      try {
        redirectUrl = await Promise.race([
          input,
          new Promise<string>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error('MCP OAuth authorization timed out')),
              LOGIN_TIMEOUT_MS,
            )
          }),
        ])
      } finally {
        if (timeout) clearTimeout(timeout)
      }
      const parsed = validateAuthorizationCallback(
        redirectUrl,
        callback.redirectUri,
        provider.authorizationState(),
      )
      const error = callbackParameter(parsed, 'error')
      if (error) {
        throw new Error(callbackParameter(parsed, 'error_description') ?? error)
      }
      const code = callbackParameter(parsed, 'code')
      if (!code)
        throw new Error('MCP OAuth redirect URL did not contain a code')
      const completed = await auth(provider, {
        serverUrl: options.server.url,
        authorizationCode: code,
      })
      if (completed !== 'AUTHORIZED') {
        throw new Error('MCP OAuth token exchange did not complete')
      }
    }
    return 'AUTHORIZED'
  } finally {
    await closeServer(callback.server)
  }
}

export async function loadMcpOAuthProvider(
  configRoot: string,
  server: McpOAuthServerIdentity,
): Promise<ClaudeMcpOAuthProvider | undefined> {
  const store = new ClaudeMcpOAuthStore({ configRoot })
  const record = await store.read(server)
  if (!record || (!record.accessToken && !record.refreshToken)) return undefined
  const redirectUri = record.redirectUri ?? 'http://localhost:0/callback'
  const clientSecret = server.clientId
    ? await store.readClientSecret(server)
    : undefined
  return new ClaudeMcpOAuthProvider(
    store,
    server,
    redirectUri,
    async () => {
      throw new Error(
        `MCP server ${server.name} requires authentication; run praxis mcp login ${server.name}`,
      )
    },
    record,
    server.clientId
      ? {
          clientId: server.clientId,
          ...(clientSecret ? { clientSecret } : {}),
        }
      : undefined,
  )
}
