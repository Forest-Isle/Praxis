import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { promisify } from 'node:util'

export const CODEX_OAUTH = Object.freeze({
  clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
  authorizeUrl: 'https://auth.openai.com/oauth/authorize',
  tokenUrl: 'https://auth.openai.com/oauth/token',
  redirectUri: 'http://localhost:1455/auth/callback',
  scope: 'openid profile email offline_access',
  deviceCodeUrl: 'https://auth.openai.com/api/accounts/deviceauth/usercode',
  deviceTokenUrl: 'https://auth.openai.com/api/accounts/deviceauth/token',
  deviceVerificationUrl: 'https://auth.openai.com/codex/device',
  deviceRedirectUri: 'https://auth.openai.com/deviceauth/callback',
} as const)

export type CodexOAuthErrorCode =
  | 'invalid_callback'
  | 'invalid_state'
  | 'invalid_token'
  | 'invalid_account_claim'
  | 'authorization_timeout'
  | 'authorization_cancelled'
  | 'device_failure'
  | 'device_timeout'
  | 'missing_credential'
  | 'refresh_failure'

export class CodexOAuthError extends Error {
  readonly code: CodexOAuthErrorCode

  constructor(code: CodexOAuthErrorCode, message: string) {
    super(message)
    this.name = 'CodexOAuthError'
    this.code = code
  }
}

export interface CodexOAuthCredentialInput {
  type: 'oauth'
  accessToken: string
  refreshToken: string
  expiresAt: number
  accountId?: string
}

export interface CodexOAuthCredentialRecord extends CodexOAuthCredentialInput {
  revision?: number
  updatedAt?: string
}

type CodexOAuthApiKeyRecord = {
  type: 'api-key'
  secret: string
  revision?: number
  updatedAt?: string
}

type CodexOAuthVaultRecord = CodexOAuthCredentialRecord | CodexOAuthApiKeyRecord

type CodexOAuthVaultInput =
  CodexOAuthCredentialInput | { type: 'api-key'; secret: string }

export interface CodexOAuthVault {
  read(key: {
    providerId: string
    profileId: string
  }): Promise<CodexOAuthVaultRecord | undefined>
  modify(
    key: { providerId: string; profileId: string },
    callback: (
      current: CodexOAuthVaultRecord | undefined,
    ) =>
      | CodexOAuthVaultInput
      | undefined
      | Promise<CodexOAuthVaultInput | undefined>,
  ): Promise<CodexOAuthVaultRecord | undefined>
}

type FetchImplementation = typeof fetch

export interface CodexOAuthLoginOptions {
  profileId: string
  vault: CodexOAuthVault
  fetchImplementation?: FetchImplementation
  now?: () => number
  randomBytes?: (size: number) => Uint8Array
  openBrowser?: (url: URL) => Promise<void> | void
  noBrowser?: boolean
  readRedirectUrl?: () => Promise<string>
  /** Test seam only. Production callers omit this and use the registered port. */
  callbackPort?: number
  signal?: AbortSignal
  authorizationTimeoutMs?: number
  deviceTimeoutMs?: number
  requestTimeoutMs?: number
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>
  write?: (text: string) => void
}

export interface CodexAuthorizationBrowserOptions {
  platform?: NodeJS.Platform
  randomBytes?: (size: number) => Uint8Array
  bridgeTimeoutMs?: number
  runCommand?: (command: string, args: readonly string[]) => Promise<void>
}

export interface CodexOAuthAccess {
  accessToken: string
  accountId: string
  expiresAt: number
}

export interface CodexOAuthCredentialManagerOptions {
  fetchImplementation?: FetchImplementation
  now?: () => number
  requestTimeoutMs?: number
}

export interface CodexOAuthAccessOptions {
  /** Force refresh only if this is still the current failed access token. */
  forceAfter?: string
  signal?: AbortSignal
}

interface TokenResponse {
  accessToken: string
  refreshToken: string
  expiresIn: number
  accountId: string
}

interface CallbackListener {
  server: Server
  redirectUri: string
  wait(): Promise<string>
}

const MAX_RESPONSE_BYTES = 64 * 1024
const MAX_JWT_BYTES = 64 * 1024
const MAX_ACCOUNT_ID_BYTES = 512
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
const DEFAULT_AUTHORIZATION_TIMEOUT_MS = 5 * 60_000
const DEFAULT_DEVICE_TIMEOUT_MS = 15 * 60_000
const DEFAULT_BROWSER_BRIDGE_TIMEOUT_MS = 30_000
const REFRESH_WINDOW_MS = 5 * 60_000

function credentialKey(profileId: string) {
  return { providerId: 'openai-codex', profileId }
}

function fail(code: CodexOAuthErrorCode, message: string): never {
  throw new CodexOAuthError(code, message)
}

function cancellation(): CodexOAuthError {
  return new CodexOAuthError(
    'authorization_cancelled',
    'Codex OAuth authorization was cancelled',
  )
}

function base64Url(value: Uint8Array): string {
  return Buffer.from(value).toString('base64url')
}

function randomValue(
  size: number,
  implementation: (size: number) => Uint8Array,
): string {
  const value = implementation(size)
  if (!(value instanceof Uint8Array) || value.byteLength !== size) {
    fail('invalid_token', 'Codex OAuth secure random generation failed')
  }
  return base64Url(value)
}

function expiryTime(now: number, expiresIn: number): number {
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    !Number.isSafeInteger(expiresIn) ||
    expiresIn <= 0
  ) {
    fail('invalid_token', 'Codex OAuth token response was invalid')
  }
  const expiresAt = now + expiresIn * 1000
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) {
    fail('invalid_token', 'Codex OAuth token response was invalid')
  }
  return expiresAt
}

function validAccountId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value === value.trim() &&
    Buffer.byteLength(value) <= MAX_ACCOUNT_ID_BYTES
  )
}

function accountIdFromAccessToken(accessToken: string): string {
  try {
    if (
      Buffer.byteLength(accessToken) > MAX_JWT_BYTES ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/u.test(accessToken)
    ) {
      throw new Error('invalid JWT')
    }
    const payloadPart = accessToken.split('.')[1]
    if (
      payloadPart === undefined ||
      Buffer.byteLength(payloadPart) > MAX_JWT_BYTES
    ) {
      throw new Error('invalid JWT payload')
    }
    const decoded = Buffer.from(payloadPart, 'base64url')
    if (decoded.byteLength > MAX_JWT_BYTES)
      throw new Error('JWT payload is too large')
    const payload = JSON.parse(decoded.toString('utf8')) as unknown
    if (
      typeof payload !== 'object' ||
      payload === null ||
      Array.isArray(payload)
    ) {
      throw new Error('invalid JWT payload')
    }
    const auth = (payload as Record<string, unknown>)[
      'https://api.openai.com/auth'
    ]
    if (typeof auth !== 'object' || auth === null || Array.isArray(auth))
      throw new Error('missing auth claim')
    const accountId = (auth as Record<string, unknown>).chatgpt_account_id
    if (!validAccountId(accountId)) {
      throw new Error('invalid account claim')
    }
    return accountId
  } catch {
    fail(
      'invalid_account_claim',
      'Codex OAuth access token has no valid account identity',
    )
  }
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // Preserve the sanitized OAuth failure.
  }
}

async function readBoundedJson(
  response: Response,
  code: CodexOAuthErrorCode,
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<Record<string, unknown>> {
  const declared = response.headers.get('content-length')
  if (declared !== null) {
    const size = Number(declared)
    if (Number.isFinite(size) && size > MAX_RESPONSE_BYTES) {
      await cancelBody(response)
      fail(code, 'Codex OAuth response is too large')
    }
  }
  const reader = response.body?.getReader()
  if (!reader) fail(code, 'Codex OAuth response was malformed')
  const chunks: Uint8Array[] = []
  let bytes = 0
  let ended = false
  let timedOut = false
  const cancelReader = () => {
    void reader.cancel().catch(() => undefined)
  }
  const onAbort = () => cancelReader()
  options.signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    cancelReader()
  }, options.timeoutMs)
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) {
        ended = true
        break
      }
      bytes += result.value.byteLength
      if (bytes > MAX_RESPONSE_BYTES) {
        fail(code, 'Codex OAuth response is too large')
      }
      chunks.push(result.value)
    }
    if (options.signal?.aborted) throw cancellation()
    if (timedOut) fail(code, 'Codex OAuth response timed out')
  } catch (error) {
    if (error instanceof CodexOAuthError) throw error
    if (options.signal?.aborted) throw cancellation()
    if (timedOut) fail(code, 'Codex OAuth response timed out')
    fail(code, 'Codex OAuth response was malformed')
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
    if (!ended) {
      try {
        await reader.cancel()
      } catch {
        // Preserve the sanitized OAuth failure.
      }
    }
    reader.releaseLock()
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      throw new Error('not an object')
    return value as Record<string, unknown>
  } catch {
    fail(code, 'Codex OAuth response was malformed')
  }
}

async function fetchWithTimeout(
  fetchImplementation: FetchImplementation,
  input: string,
  init: RequestInit,
  options: {
    signal?: AbortSignal
    timeoutMs: number
    code: CodexOAuthErrorCode
    message: string
  },
): Promise<Response> {
  if (options.signal?.aborted) throw cancellation()
  const controller = new AbortController()
  let timedOut = false
  const onAbort = () => controller.abort()
  options.signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, options.timeoutMs)
  try {
    return await fetchImplementation(input, {
      ...init,
      signal: controller.signal,
    })
  } catch {
    if (options.signal?.aborted) throw cancellation()
    throw new CodexOAuthError(
      options.code,
      timedOut ? `${options.message} timed out` : options.message,
    )
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
  }
}

async function requestToken(
  body: URLSearchParams,
  options: {
    fetchImplementation: FetchImplementation
    signal?: AbortSignal
    timeoutMs: number
    code: 'invalid_token' | 'refresh_failure'
  },
): Promise<TokenResponse> {
  const response = await fetchWithTimeout(
    options.fetchImplementation,
    CODEX_OAUTH.tokenUrl,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    },
    {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      timeoutMs: options.timeoutMs,
      code: options.code,
      message: 'Codex OAuth token request failed',
    },
  )
  if (!response.ok) {
    await cancelBody(response)
    fail(options.code, 'Codex OAuth token request failed')
  }
  const value = await readBoundedJson(response, options.code, {
    timeoutMs: options.timeoutMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  const accessToken = value.access_token
  const refreshToken = value.refresh_token
  const expiresIn = value.expires_in
  if (
    typeof accessToken !== 'string' ||
    accessToken.length === 0 ||
    typeof refreshToken !== 'string' ||
    refreshToken.length === 0 ||
    !Number.isSafeInteger(expiresIn) ||
    (expiresIn as number) <= 0
  ) {
    fail(options.code, 'Codex OAuth token response was invalid')
  }
  return {
    accessToken,
    refreshToken,
    expiresIn: expiresIn as number,
    accountId: accountIdFromAccessToken(accessToken),
  }
}

export function validateAuthorizationCallback(
  value: string,
  expectedState: string,
  redirectUri: string = CODEX_OAUTH.redirectUri,
): URL {
  let actual: URL
  try {
    actual = new URL(value)
  } catch {
    fail('invalid_callback', 'Codex OAuth callback URL is invalid')
  }
  const expected = new URL(redirectUri)
  if (
    actual.origin !== expected.origin ||
    actual.pathname !== expected.pathname
  ) {
    fail(
      'invalid_callback',
      'Codex OAuth callback does not match the local redirect',
    )
  }
  const states = actual.searchParams.getAll('state')
  if (states.length !== 1 || states[0] !== expectedState) {
    fail('invalid_state', 'Codex OAuth callback state did not match')
  }
  const codes = actual.searchParams.getAll('code')
  const errors = actual.searchParams.getAll('error')
  if (
    codes.length > 1 ||
    errors.length > 1 ||
    (codes.length === 1) === (errors.length === 1)
  ) {
    fail('invalid_callback', 'Codex OAuth callback parameters are invalid')
  }
  if (codes.length === 1 && codes[0]?.length === 0)
    fail('invalid_callback', 'Codex OAuth callback did not contain a code')
  if (errors.length === 1 && errors[0]?.length === 0)
    fail('invalid_callback', 'Codex OAuth callback error was invalid')
  return actual
}

export function createAuthorizationCallbackValidator(
  expectedState: string,
  redirectUri: string = CODEX_OAUTH.redirectUri,
): (value: string) => URL {
  let consumed = false
  return (value) => {
    if (consumed)
      fail('invalid_state', 'Codex OAuth callback state was already used')
    const result = validateAuthorizationCallback(
      value,
      expectedState,
      redirectUri,
    )
    consumed = true
    return result
  }
}

async function listenForAuthorizationRedirect(
  authorizationUrl: URL,
  random: (size: number) => Uint8Array,
  timeoutMs: number,
): Promise<{ browserUrl: URL; close(): Promise<void> }> {
  const path = `/authorize/${randomValue(32, random)}`
  let consumed = false
  const lifetime: { timer?: NodeJS.Timeout } = {}
  let closeFlight: Promise<void> | undefined
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1')
    const headers = {
      'cache-control': 'no-store',
      pragma: 'no-cache',
      'referrer-policy': 'no-referrer',
    }
    if (
      request.method !== 'GET' ||
      requestUrl.pathname !== path ||
      requestUrl.search !== ''
    ) {
      response.writeHead(404, headers)
      response.end('Not found')
      return
    }
    if (consumed) {
      response.writeHead(410, headers)
      response.end('Gone')
      return
    }
    consumed = true
    response.writeHead(302, {
      ...headers,
      location: authorizationUrl.toString(),
    })
    response.once('finish', () => void close())
    response.end()
  })
  const close = (): Promise<void> => {
    if (closeFlight) return closeFlight
    if (lifetime.timer) clearTimeout(lifetime.timer)
    closeFlight = server.listening
      ? new Promise<void>((resolve) => {
          server.close(() => resolve())
          server.closeAllConnections()
        })
      : Promise.resolve()
    return closeFlight
  }
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        server.off('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(0, '127.0.0.1')
    })
  } catch (error) {
    await close()
    throw error
  }
  const address = server.address()
  if (!address || typeof address === 'string') {
    await close()
    throw new Error('Codex OAuth browser bridge failed')
  }
  server.on('error', () => void close())
  server.unref()
  lifetime.timer = setTimeout(() => void close(), timeoutMs)
  lifetime.timer.unref()
  return {
    browserUrl: new URL(`http://127.0.0.1:${address.port}${path}`),
    close,
  }
}

export async function openCodexAuthorizationUrl(
  authorizationUrl: URL,
  options: CodexAuthorizationBrowserOptions = {},
): Promise<void> {
  let bridge:
    Awaited<ReturnType<typeof listenForAuthorizationRedirect>> | undefined
  try {
    bridge = await listenForAuthorizationRedirect(
      authorizationUrl,
      options.randomBytes ?? randomBytes,
      options.bridgeTimeoutMs ?? DEFAULT_BROWSER_BRIDGE_TIMEOUT_MS,
    )
    const platform = options.platform ?? process.platform
    const command =
      platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open'
    const args =
      platform === 'win32'
        ? ['/c', 'start', '', bridge.browserUrl.toString()]
        : [bridge.browserUrl.toString()]
    await (
      options.runCommand ??
      (async (executable, commandArguments) => {
        await promisify(execFile)(executable, [...commandArguments], {
          timeout: 10_000,
        })
      })
    )(command, args)
  } catch {
    await bridge?.close()
  }
}

async function listenForCallback(port: number): Promise<CallbackListener> {
  let resolveCallback: (value: string) => void = () => undefined
  let rejectCallback: (error: Error) => void = () => undefined
  const callback = new Promise<string>((resolve, reject) => {
    resolveCallback = resolve
    rejectCallback = reject
  })
  let callbackOrigin = 'http://localhost'
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (url.pathname !== '/auth/callback') {
      response.writeHead(404)
      response.end('Not found')
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(
      '<html><body>Praxis authorization received. You may close this tab.</body></html>',
    )
    resolveCallback(`${callbackOrigin}${url.pathname}${url.search}`)
  })
  server.once('error', rejectCallback)
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve)
      server.once('error', reject)
      server.listen(port, '127.0.0.1')
    })
  } catch {
    fail('authorization_timeout', 'Codex OAuth callback server failed')
  }
  const address = server.address()
  if (!address || typeof address === 'string') {
    await closeCallbackServer(server)
    fail('authorization_timeout', 'Codex OAuth callback server failed')
  }
  callbackOrigin = `http://localhost:${address.port}`
  return {
    server,
    redirectUri: `${callbackOrigin}/auth/callback`,
    wait: () => callback,
  }
}

async function closeCallbackServer(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

async function waitForAuthorization(
  input: Promise<string>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) throw cancellation()
  let timer: NodeJS.Timeout | undefined
  let onAbort: (() => void) | undefined
  try {
    return await new Promise<string>((resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new CodexOAuthError(
              'authorization_timeout',
              'Codex OAuth authorization timed out',
            ),
          ),
        timeoutMs,
      )
      onAbort = () => reject(cancellation())
      signal?.addEventListener('abort', onAbort, { once: true })
      input.then(resolve, reject)
    })
  } finally {
    if (timer) clearTimeout(timer)
    if (onAbort) signal?.removeEventListener('abort', onAbort)
  }
}

async function defaultSleep(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw cancellation()
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(cancellation())
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function persistOAuthCredential(
  vault: CodexOAuthVault,
  profileId: string,
  input: CodexOAuthCredentialInput,
): Promise<CodexOAuthCredentialRecord> {
  const stored = await vault.modify(credentialKey(profileId), () => input)
  if (!stored || stored.type !== 'oauth') {
    fail('invalid_token', 'Codex OAuth credential could not be stored')
  }
  return stored
}

async function browserLogin(
  options: CodexOAuthLoginOptions,
): Promise<CodexOAuthCredentialRecord> {
  const random = options.randomBytes ?? randomBytes
  const verifier = randomValue(32, random)
  const challenge = base64Url(createHash('sha256').update(verifier).digest())
  const state = randomValue(32, random)
  const callback = await listenForCallback(options.callbackPort ?? 1455)
  try {
    const authorizationUrl = new URL(CODEX_OAUTH.authorizeUrl)
    authorizationUrl.search = new URLSearchParams({
      response_type: 'code',
      client_id: CODEX_OAUTH.clientId,
      redirect_uri: callback.redirectUri,
      scope: CODEX_OAUTH.scope,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true',
      originator: 'praxis',
    }).toString()
    options.write?.(
      `Visit this URL to authorize Praxis:\n  ${authorizationUrl}\n`,
    )
    if (!options.noBrowser) {
      await (options.openBrowser ?? openCodexAuthorizationUrl)(authorizationUrl)
    }
    const candidates = [callback.wait()]
    if (options.readRedirectUrl) candidates.push(options.readRedirectUrl())
    const redirect = await waitForAuthorization(
      Promise.race(candidates),
      options.authorizationTimeoutMs ?? DEFAULT_AUTHORIZATION_TIMEOUT_MS,
      options.signal,
    )
    const parsed = createAuthorizationCallbackValidator(
      state,
      callback.redirectUri,
    )(redirect)
    if (parsed.searchParams.has('error')) {
      fail('invalid_callback', 'Codex OAuth authorization was denied')
    }
    const authorizationCode = parsed.searchParams.get('code')
    if (!authorizationCode)
      fail('invalid_callback', 'Codex OAuth callback did not contain a code')
    const token = await requestToken(
      new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: CODEX_OAUTH.clientId,
        code: authorizationCode,
        redirect_uri: callback.redirectUri,
        code_verifier: verifier,
      }),
      {
        fetchImplementation: options.fetchImplementation ?? fetch,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        timeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
        code: 'invalid_token',
      },
    )
    const now = (options.now ?? Date.now)()
    return persistOAuthCredential(options.vault, options.profileId, {
      type: 'oauth',
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiresAt: expiryTime(now, token.expiresIn),
      accountId: token.accountId,
    })
  } catch (error) {
    if (error instanceof CodexOAuthError) throw error
    if (options.signal?.aborted) throw cancellation()
    fail('authorization_timeout', 'Codex OAuth authorization failed')
  } finally {
    await closeCallbackServer(callback.server)
  }
}

async function deviceRequest(
  url: string,
  body: Record<string, string>,
  options: CodexOAuthLoginOptions,
): Promise<Response> {
  return fetchWithTimeout(
    options.fetchImplementation ?? fetch,
    url,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      timeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      code: 'device_failure',
      message: 'Codex device authorization failed',
    },
  )
}

async function deviceLogin(
  options: CodexOAuthLoginOptions,
): Promise<CodexOAuthCredentialRecord> {
  const now = options.now ?? Date.now
  const userCodeResponse = await deviceRequest(
    CODEX_OAUTH.deviceCodeUrl,
    { client_id: CODEX_OAUTH.clientId },
    options,
  )
  if (!userCodeResponse.ok) {
    await cancelBody(userCodeResponse)
    fail('device_failure', 'Codex device authorization failed')
  }
  const initial = await readBoundedJson(userCodeResponse, 'device_failure', {
    timeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  const userCode = initial.user_code
  const deviceAuthId = initial.device_auth_id
  if (
    typeof userCode !== 'string' ||
    userCode.length === 0 ||
    typeof deviceAuthId !== 'string' ||
    deviceAuthId.length === 0
  ) {
    fail('device_failure', 'Codex device authorization response was invalid')
  }
  options.write?.(
    `Visit ${CODEX_OAUTH.deviceVerificationUrl} and enter code ${userCode}\n`,
  )
  let interval =
    typeof initial.interval === 'number' &&
    Number.isFinite(initial.interval) &&
    initial.interval > 0
      ? Math.min(initial.interval * 1000, 60_000)
      : 5000
  const startedAt = now()
  const timeoutMs = options.deviceTimeoutMs ?? DEFAULT_DEVICE_TIMEOUT_MS
  const sleep = options.sleep ?? defaultSleep
  let authorizationCode: string | undefined
  let verifier: string | undefined
  while (authorizationCode === undefined || verifier === undefined) {
    if (options.signal?.aborted) throw cancellation()
    if (now() - startedAt >= timeoutMs) {
      fail('device_timeout', 'Codex device authorization timed out')
    }
    try {
      await sleep(interval, options.signal)
    } catch (error) {
      if (error instanceof CodexOAuthError) throw error
      if (options.signal?.aborted) throw cancellation()
      fail('device_failure', 'Codex device authorization failed')
    }
    if (options.signal?.aborted) throw cancellation()
    if (now() - startedAt >= timeoutMs) {
      fail('device_timeout', 'Codex device authorization timed out')
    }
    const poll = await deviceRequest(
      CODEX_OAUTH.deviceTokenUrl,
      { device_auth_id: deviceAuthId, user_code: userCode },
      options,
    )
    if (poll.status === 403 || poll.status === 404) {
      await cancelBody(poll)
      continue
    }
    const value = await readBoundedJson(poll, 'device_failure', {
      timeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    const error = value.error
    if (error === 'authorization_pending') continue
    if (error === 'slow_down') {
      interval = Math.min(interval + 5000, 60_000)
      continue
    }
    if (!poll.ok) {
      fail('device_failure', 'Codex device authorization failed')
    }
    if (
      typeof value.authorization_code !== 'string' ||
      value.authorization_code.length === 0 ||
      typeof value.code_verifier !== 'string' ||
      value.code_verifier.length === 0
    ) {
      fail('device_failure', 'Codex device authorization response was invalid')
    }
    authorizationCode = value.authorization_code
    verifier = value.code_verifier
  }
  const token = await requestToken(
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CODEX_OAUTH.clientId,
      code: authorizationCode,
      redirect_uri: CODEX_OAUTH.deviceRedirectUri,
      code_verifier: verifier,
    }),
    {
      fetchImplementation: options.fetchImplementation ?? fetch,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      timeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      code: 'invalid_token',
    },
  )
  return persistOAuthCredential(options.vault, options.profileId, {
    type: 'oauth',
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    expiresAt: expiryTime(now(), token.expiresIn),
    accountId: token.accountId,
  })
}

export function loginWithCodexOAuth(
  options: CodexOAuthLoginOptions,
): Promise<CodexOAuthCredentialRecord> {
  return browserLogin(options)
}

export function deviceLoginWithCodexOAuth(
  options: CodexOAuthLoginOptions,
): Promise<CodexOAuthCredentialRecord> {
  return deviceLogin(options)
}

function requireOAuthCredential(
  value: CodexOAuthVaultRecord | undefined,
): CodexOAuthCredentialRecord {
  if (
    !value ||
    value.type !== 'oauth' ||
    value.accessToken.length === 0 ||
    value.refreshToken.length === 0 ||
    !Number.isFinite(value.expiresAt) ||
    value.expiresAt < 0
  ) {
    fail('missing_credential', 'Codex OAuth credential is unavailable')
  }
  return value
}

function accessFromCredential(
  credential: CodexOAuthCredentialRecord,
): CodexOAuthAccess {
  if (!validAccountId(credential.accountId)) {
    fail(
      'invalid_account_claim',
      'Codex OAuth credential has no account identity',
    )
  }
  return {
    accessToken: credential.accessToken,
    accountId: credential.accountId,
    expiresAt: credential.expiresAt,
  }
}

export class CodexOAuthCredentialManager {
  private refreshFlight: Promise<CodexOAuthAccess> | undefined

  constructor(
    private readonly vault: CodexOAuthVault,
    private readonly profileId: string,
    private readonly options: CodexOAuthCredentialManagerOptions = {},
  ) {}

  async access(
    options: CodexOAuthAccessOptions = {},
  ): Promise<CodexOAuthAccess> {
    if (options.signal?.aborted) throw cancellation()
    const current = requireOAuthCredential(
      await this.vault.read(credentialKey(this.profileId)),
    )
    const now = (this.options.now ?? Date.now)()
    const needsRefresh =
      current.expiresAt <= now + REFRESH_WINDOW_MS ||
      current.accessToken === options.forceAfter
    if (!needsRefresh) return accessFromCredential(current)
    if (!this.refreshFlight) {
      const flight = this.refresh(options).finally(() => {
        if (this.refreshFlight === flight) this.refreshFlight = undefined
      })
      this.refreshFlight = flight
    }
    return this.refreshFlight
  }

  private async refresh(
    accessOptions: CodexOAuthAccessOptions,
  ): Promise<CodexOAuthAccess> {
    let access: CodexOAuthAccess | undefined
    try {
      await this.vault.modify(credentialKey(this.profileId), async (stored) => {
        const current = requireOAuthCredential(stored)
        const now = (this.options.now ?? Date.now)()
        const stillNeedsRefresh =
          current.expiresAt <= now + REFRESH_WINDOW_MS ||
          current.accessToken === accessOptions.forceAfter
        if (!stillNeedsRefresh) {
          access = accessFromCredential(current)
          return {
            type: 'oauth',
            accessToken: current.accessToken,
            refreshToken: current.refreshToken,
            expiresAt: current.expiresAt,
            ...(current.accountId === undefined
              ? {}
              : { accountId: current.accountId }),
          }
        }
        const token = await requestToken(
          new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: CODEX_OAUTH.clientId,
            refresh_token: current.refreshToken,
          }),
          {
            fetchImplementation: this.options.fetchImplementation ?? fetch,
            ...(accessOptions.signal === undefined
              ? {}
              : { signal: accessOptions.signal }),
            timeoutMs:
              this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
            code: 'refresh_failure',
          },
        )
        if (token.refreshToken === current.refreshToken) {
          fail(
            'refresh_failure',
            'Codex OAuth refresh did not rotate the refresh token',
          )
        }
        if (!current.accountId || token.accountId !== current.accountId) {
          fail(
            'refresh_failure',
            'Codex OAuth account identity changed during refresh',
          )
        }
        const next: CodexOAuthCredentialInput = {
          type: 'oauth',
          accessToken: token.accessToken,
          refreshToken: token.refreshToken,
          expiresAt: expiryTime(now, token.expiresIn),
          accountId: token.accountId,
        }
        access = accessFromCredential(next)
        return next
      })
      if (!access) fail('refresh_failure', 'Codex OAuth refresh failed')
      return access
    } catch (error) {
      if (error instanceof CodexOAuthError) throw error
      fail('refresh_failure', 'Codex OAuth refresh failed')
    }
  }
}
