import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  CODEX_OAUTH,
  CodexOAuthCredentialManager,
  CodexOAuthError,
  createAuthorizationCallbackValidator,
  deviceLoginWithCodexOAuth,
  loginWithCodexOAuth,
  openCodexAuthorizationUrl,
  validateAuthorizationCallback,
  type CodexOAuthCredentialRecord,
  type CodexOAuthVault,
} from './codex-oauth.js'

type VaultRecord = Awaited<ReturnType<CodexOAuthVault['read']>>

class MemoryVault implements CodexOAuthVault {
  record: VaultRecord
  beforeModify: (() => void) | undefined
  modifications = 0

  constructor(record?: VaultRecord) {
    this.record = record
  }

  async read(): Promise<VaultRecord> {
    return this.record
  }

  async modify(
    _key: { providerId: string; profileId: string },
    callback: Parameters<CodexOAuthVault['modify']>[1],
  ): Promise<VaultRecord> {
    this.beforeModify?.()
    this.beforeModify = undefined
    const next = await callback(this.record)
    this.modifications += 1
    this.record =
      next === undefined
        ? undefined
        : {
            ...next,
            revision: (this.record?.revision ?? 0) + 1,
            updatedAt: '2026-08-28T00:00:00.000Z',
          }
    return this.record
  }
}

function accessToken(accountId: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString(
    'base64url',
  )
  const payload = Buffer.from(
    JSON.stringify({
      'https://api.openai.com/auth': { chatgpt_account_id: accountId },
    }),
  ).toString('base64url')
  return `${header}.${payload}.signature`
}

function tokenResponse(
  accountId = 'acct-1',
  refreshToken = 'refresh-2',
  status = 200,
): Response {
  return new Response(
    JSON.stringify({
      access_token: accessToken(accountId),
      refresh_token: refreshToken,
      expires_in: 3600,
    }),
    { status, headers: { 'content-type': 'application/json' } },
  )
}

async function completeBrowserLogin(
  options: {
    vault?: CodexOAuthVault
    tokenResponse?: () => Response | Promise<Response>
    tokenFetch?: typeof fetch
    accountId?: string
    now?: number
  } = {},
): Promise<{
  record: CodexOAuthCredentialRecord
  authorizationUrl: URL
  tokenForm: URLSearchParams
  output: string
  vault: CodexOAuthVault
}> {
  const vault = options.vault ?? new MemoryVault()
  let authorizationUrl: URL | undefined
  let tokenForm: URLSearchParams | undefined
  let output = ''
  const fetchImplementation =
    options.tokenFetch ??
    (async (input, init) => {
      expect(String(input)).toBe(CODEX_OAUTH.tokenUrl)
      tokenForm = new URLSearchParams(String(init?.body))
      return (
        options.tokenResponse?.() ??
        tokenResponse(options.accountId ?? 'acct-1')
      )
    })
  const record = await loginWithCodexOAuth({
    profileId: 'default',
    vault,
    callbackPort: 0,
    noBrowser: true,
    now: () => options.now ?? 1_000_000,
    randomBytes: (size) => new Uint8Array(size).fill(7),
    write: (text) => {
      output += text
      const match = text.match(/https:\/\/\S+/u)
      if (match) authorizationUrl = new URL(match[0])
    },
    readRedirectUrl: async () => {
      if (!authorizationUrl) throw new Error('authorization URL unavailable')
      const redirect = new URL(
        authorizationUrl.searchParams.get('redirect_uri') ?? '',
      )
      redirect.searchParams.set('code', 'authorization-code')
      redirect.searchParams.set(
        'state',
        authorizationUrl.searchParams.get('state') ?? '',
      )
      return redirect.toString()
    },
    fetchImplementation,
    authorizationTimeoutMs: 1000,
    requestTimeoutMs: 1000,
  })
  if (!authorizationUrl || !tokenForm)
    throw new Error('browser login fixture did not capture requests')
  return { record, authorizationUrl, tokenForm, output, vault }
}

function expiringCredential(
  overrides: Partial<CodexOAuthCredentialRecord> = {},
): CodexOAuthCredentialRecord {
  return {
    type: 'oauth',
    accessToken: 'old-access',
    refreshToken: 'old-refresh',
    expiresAt: 1,
    accountId: 'acct-1',
    revision: 1,
    updatedAt: '2026-08-28T00:00:00.000Z',
    ...overrides,
  }
}

function expectOAuthCode(
  promise: Promise<unknown>,
  code: CodexOAuthError['code'],
): Promise<void> {
  return expect(promise).rejects.toMatchObject({
    name: 'CodexOAuthError',
    code,
  }) as Promise<void>
}

describe('Codex OAuth', () => {
  it('opens only a one-use loopback bridge URL in the browser process', async () => {
    const authorizationUrl = new URL(CODEX_OAUTH.authorizeUrl)
    authorizationUrl.search = new URLSearchParams({
      state: 'sensitive-state',
      code_challenge: 'sensitive-challenge',
    }).toString()
    let command = ''
    let args: readonly string[] = []
    let redirectLocation: string | null = null

    await openCodexAuthorizationUrl(authorizationUrl, {
      platform: 'linux',
      randomBytes: (size) => new Uint8Array(size).fill(11),
      bridgeTimeoutMs: 1000,
      runCommand: async (nextCommand, nextArgs) => {
        command = nextCommand
        args = nextArgs
        const browserUrl = nextArgs.at(-1)
        if (!browserUrl) throw new Error('Expected browser URL')
        const response = await fetch(browserUrl, { redirect: 'manual' })
        redirectLocation = response.headers.get('location')
        expect(response.status).toBe(302)
        expect(response.headers.get('cache-control')).toBe('no-store')
      },
    })

    expect(command).toBe('xdg-open')
    expect(args).toHaveLength(1)
    expect(args[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/authorize\//u)
    expect(args.join(' ')).not.toContain(authorizationUrl.toString())
    expect(args.join(' ')).not.toContain('sensitive-state')
    expect(args.join(' ')).not.toContain('sensitive-challenge')
    expect(redirectLocation).toBe(authorizationUrl.toString())
  })

  it('validates exact callback parameters and rejects replay', () => {
    const redirect = CODEX_OAUTH.redirectUri
    expect(
      validateAuthorizationCallback(
        `${redirect}?code=accepted&state=expected`,
        'expected',
      ).searchParams.get('code'),
    ).toBe('accepted')

    for (const invalid of [
      'not-a-url',
      'http://127.0.0.1:1455/auth/callback?code=c&state=expected',
      'http://localhost:1455/other?code=c&state=expected',
      `${redirect}?code=c`,
      `${redirect}?code=c&state=wrong`,
      `${redirect}?code=c&state=expected&state=expected`,
      `${redirect}?state=expected`,
      `${redirect}?code=c&code=d&state=expected`,
      `${redirect}?error=denied&error=again&state=expected`,
      `${redirect}?code=c&error=denied&state=expected`,
    ]) {
      expect(() => validateAuthorizationCallback(invalid, 'expected')).toThrow(
        CodexOAuthError,
      )
    }

    const validateOnce = createAuthorizationCallbackValidator('expected')
    validateOnce(`${redirect}?code=c&state=expected`)
    expect(() => validateOnce(`${redirect}?code=c&state=expected`)).toThrow(
      /already used/u,
    )
  })

  it('performs browser PKCE login, prints the URL, and persists the credential', async () => {
    const result = await completeBrowserLogin()
    const query = result.authorizationUrl.searchParams
    expect(
      result.authorizationUrl.origin + result.authorizationUrl.pathname,
    ).toBe(CODEX_OAUTH.authorizeUrl)
    expect(Object.fromEntries(query)).toMatchObject({
      response_type: 'code',
      client_id: CODEX_OAUTH.clientId,
      scope: CODEX_OAUTH.scope,
      code_challenge_method: 'S256',
      id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true',
      originator: 'praxis',
    })
    expect(query.get('redirect_uri')).toMatch(
      /^http:\/\/localhost:\d+\/auth\/callback$/u,
    )
    expect(query.get('state')).toBeTruthy()
    expect(result.output).toContain(result.authorizationUrl.toString())
    expect(result.output).not.toContain('code_verifier')

    const verifier = result.tokenForm.get('code_verifier')
    expect(verifier).toBeTruthy()
    expect(query.get('code_challenge')).toBe(
      createHash('sha256')
        .update(verifier ?? '')
        .digest('base64url'),
    )
    expect(Object.fromEntries(result.tokenForm)).toMatchObject({
      grant_type: 'authorization_code',
      client_id: CODEX_OAUTH.clientId,
      code: 'authorization-code',
      redirect_uri: query.get('redirect_uri'),
    })
    expect(result.record).toMatchObject({
      type: 'oauth',
      refreshToken: 'refresh-2',
      expiresAt: 4_600_000,
      accountId: 'acct-1',
    })
    await expect(
      result.vault.read({ providerId: 'openai-codex', profileId: 'default' }),
    ).resolves.toMatchObject({ accountId: 'acct-1' })
  })

  it('closes browser authorization on timeout and cancellation', async () => {
    const never = () => new Promise<string>(() => undefined)
    await expectOAuthCode(
      loginWithCodexOAuth({
        profileId: 'default',
        vault: new MemoryVault(),
        callbackPort: 0,
        noBrowser: true,
        readRedirectUrl: never,
        authorizationTimeoutMs: 5,
      }),
      'authorization_timeout',
    )

    const controller = new AbortController()
    controller.abort()
    await expectOAuthCode(
      loginWithCodexOAuth({
        profileId: 'default',
        vault: new MemoryVault(),
        callbackPort: 0,
        noBrowser: true,
        readRedirectUrl: never,
        signal: controller.signal,
      }),
      'authorization_cancelled',
    )
  })

  it('fails closed on token errors, oversized bodies, and invalid account claims', async () => {
    const secretMarker = 'raw-secret-response-marker'
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(40_000))
        controller.enqueue(new Uint8Array(40_000))
        controller.close()
      },
    })
    const responses = [
      () => new Response(secretMarker, { status: 401 }),
      () => new Response('{malformed'),
      () => new Response(oversized),
      () => new Response(JSON.stringify({ access_token: 'missing-fields' })),
      () =>
        new Response(
          JSON.stringify({
            access_token: 'not.a.jwt.with.too.many.parts',
            refresh_token: 'refresh',
            expires_in: 3600,
          }),
        ),
      () => tokenResponse('a'.repeat(513)),
    ]

    for (const response of responses) {
      let thrown: unknown
      try {
        await completeBrowserLogin({ tokenResponse: response })
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(CodexOAuthError)
      expect(String((thrown as Error).message)).not.toContain(secretMarker)
      expect(String((thrown as Error).message)).not.toContain('missing-fields')
    }
  })

  it('uses device JSON polling, pending statuses, slow-down, and returned verifier', async () => {
    const vault = new MemoryVault()
    const requests: Array<{ url: string; body: unknown; contentType: string }> =
      []
    const sleeps: number[] = []
    let now = 10_000
    let polls = 0
    let tokenForm: URLSearchParams | undefined
    const fetchImplementation = (async (input, init) => {
      const url = String(input)
      if (url === CODEX_OAUTH.tokenUrl) {
        tokenForm = new URLSearchParams(String(init?.body))
        return tokenResponse()
      }
      requests.push({
        url,
        body: JSON.parse(String(init?.body)),
        contentType: String(new Headers(init?.headers).get('content-type')),
      })
      if (url === CODEX_OAUTH.deviceCodeUrl) {
        return new Response(
          JSON.stringify({
            device_auth_id: 'device-id',
            user_code: 'ABCD-EFGH',
            interval: 1,
          }),
        )
      }
      polls += 1
      if (polls === 1) return new Response(null, { status: 403 })
      if (polls === 2)
        return new Response(
          JSON.stringify({ error: 'authorization_pending' }),
          {
            status: 400,
          },
        )
      if (polls === 3)
        return new Response(JSON.stringify({ error: 'slow_down' }), {
          status: 400,
        })
      return new Response(
        JSON.stringify({
          authorization_code: 'device-authorization-code',
          code_verifier: 'server-device-verifier',
        }),
      )
    }) as typeof fetch

    const output: string[] = []
    const record = await deviceLoginWithCodexOAuth({
      profileId: 'default',
      vault,
      fetchImplementation,
      now: () => now,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds)
        now += milliseconds
      },
      write: (text) => output.push(text),
      deviceTimeoutMs: 60_000,
      requestTimeoutMs: 1000,
    })

    expect(requests[0]).toEqual({
      url: CODEX_OAUTH.deviceCodeUrl,
      body: { client_id: CODEX_OAUTH.clientId },
      contentType: 'application/json',
    })
    expect(requests[1]).toMatchObject({
      url: CODEX_OAUTH.deviceTokenUrl,
      body: { device_auth_id: 'device-id', user_code: 'ABCD-EFGH' },
      contentType: 'application/json',
    })
    expect(sleeps).toEqual([1000, 1000, 1000, 6000])
    expect(output.join('')).toContain(CODEX_OAUTH.deviceVerificationUrl)
    expect(output.join('')).toContain('ABCD-EFGH')
    expect(tokenForm).toBeDefined()
    expect(Object.fromEntries(tokenForm ?? [])).toMatchObject({
      grant_type: 'authorization_code',
      code: 'device-authorization-code',
      code_verifier: 'server-device-verifier',
      redirect_uri: CODEX_OAUTH.deviceRedirectUri,
    })
    expect(record).toMatchObject({ accountId: 'acct-1' })
  })

  it('fails device flow on timeout, cancellation, and malformed success', async () => {
    const userCode = () =>
      new Response(
        JSON.stringify({
          device_auth_id: 'device-id',
          user_code: 'CODE',
          interval: 1,
        }),
      )
    let now = 0
    await expectOAuthCode(
      deviceLoginWithCodexOAuth({
        profileId: 'default',
        vault: new MemoryVault(),
        fetchImplementation: (async () => userCode()) as typeof fetch,
        now: () => now,
        sleep: async (milliseconds) => {
          now += milliseconds
        },
        deviceTimeoutMs: 500,
      }),
      'device_timeout',
    )

    const cancelled = new AbortController()
    cancelled.abort()
    await expectOAuthCode(
      deviceLoginWithCodexOAuth({
        profileId: 'default',
        vault: new MemoryVault(),
        fetchImplementation: (async () => userCode()) as typeof fetch,
        signal: cancelled.signal,
      }),
      'authorization_cancelled',
    )

    let call = 0
    await expectOAuthCode(
      deviceLoginWithCodexOAuth({
        profileId: 'default',
        vault: new MemoryVault(),
        fetchImplementation: (async () => {
          call += 1
          return call === 1
            ? userCode()
            : new Response(
                JSON.stringify({ authorization_code: 'missing-verifier' }),
              )
        }) as typeof fetch,
        now: () => call * 1000,
        sleep: async () => undefined,
        deviceTimeoutMs: 10_000,
      }),
      'device_failure',
    )
  })

  it('singleflights concurrent refresh and commits rotated credentials', async () => {
    const vault = new MemoryVault(expiringCredential())
    let refreshes = 0
    let refreshForm: URLSearchParams | undefined
    const manager = new CodexOAuthCredentialManager(vault, 'default', {
      now: () => 1000,
      requestTimeoutMs: 1000,
      fetchImplementation: (async (_input, init) => {
        refreshes += 1
        refreshForm = new URLSearchParams(String(init?.body))
        return tokenResponse('acct-1', 'rotated-refresh')
      }) as typeof fetch,
    })

    const [first, second] = await Promise.all([
      manager.access(),
      manager.access(),
    ])
    expect(first).toEqual(second)
    expect(refreshes).toBe(1)
    expect(Object.fromEntries(refreshForm ?? [])).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: 'old-refresh',
      client_id: CODEX_OAUTH.clientId,
    })
    expect(vault.record).toMatchObject({
      refreshToken: 'rotated-refresh',
      accountId: 'acct-1',
    })
  })

  it('double-checks a fresher credential under the Vault lock', async () => {
    const vault = new MemoryVault(expiringCredential())
    vault.beforeModify = () => {
      vault.record = expiringCredential({
        accessToken: 'other-process-access',
        refreshToken: 'other-process-refresh',
        expiresAt: 10_000_000,
      })
    }
    let requests = 0
    const manager = new CodexOAuthCredentialManager(vault, 'default', {
      now: () => 1000,
      fetchImplementation: (async () => {
        requests += 1
        return tokenResponse()
      }) as typeof fetch,
    })

    await expect(manager.access()).resolves.toMatchObject({
      accessToken: 'other-process-access',
      accountId: 'acct-1',
    })
    expect(requests).toBe(0)
    expect(vault.record).toMatchObject({
      accessToken: 'other-process-access',
      refreshToken: 'other-process-refresh',
    })
  })

  it('preserves the old credential on rotation, account, response, and cancellation failures', async () => {
    const rawSecret = 'server-secret-body'
    const cases: Array<() => Response | Promise<Response>> = [
      () => tokenResponse('acct-1', 'old-refresh'),
      () => tokenResponse('acct-2', 'new-refresh'),
      () => new Response(rawSecret, { status: 500 }),
    ]
    for (const response of cases) {
      const original = expiringCredential()
      const vault = new MemoryVault(original)
      const manager = new CodexOAuthCredentialManager(vault, 'default', {
        now: () => 1000,
        requestTimeoutMs: 1000,
        fetchImplementation: (async () => response()) as typeof fetch,
      })
      let thrown: unknown
      try {
        await manager.access()
      } catch (error) {
        thrown = error
      }
      expect(thrown).toMatchObject({ code: 'refresh_failure' })
      expect(String((thrown as Error).message)).not.toContain(rawSecret)
      expect(vault.record).toEqual(original)
    }

    const original = expiringCredential()
    const vault = new MemoryVault(original)
    const controller = new AbortController()
    const manager = new CodexOAuthCredentialManager(vault, 'default', {
      now: () => 1000,
      requestTimeoutMs: 1000,
      fetchImplementation: ((_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new Error('aborted')),
            { once: true },
          )
        })) as typeof fetch,
    })
    const pending = manager.access({ signal: controller.signal })
    controller.abort()
    await expectOAuthCode(pending, 'authorization_cancelled')
    expect(vault.record).toEqual(original)
  })

  it('rejects missing and API-key credentials without any fallback', async () => {
    await expectOAuthCode(
      new CodexOAuthCredentialManager(new MemoryVault(), 'default').access(),
      'missing_credential',
    )
    await expectOAuthCode(
      new CodexOAuthCredentialManager(
        new MemoryVault({ type: 'api-key', secret: 'not-oauth' }),
        'default',
      ).access(),
      'missing_credential',
    )
  })

  it('rejects malformed account identities returned by custom Vaults', async () => {
    for (const accountId of ['   ', ' account', 'account ', 'é'.repeat(257)]) {
      const vault = new MemoryVault(
        expiringCredential({ accountId, expiresAt: 10_000_000 }),
      )
      await expectOAuthCode(
        new CodexOAuthCredentialManager(vault, 'default', {
          now: () => 1000,
        }).access(),
        'invalid_account_claim',
      )
    }
  })
})
