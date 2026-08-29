import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  ProviderCredentialVault,
  type ProviderCredentialMetadata,
} from '../persistence/provider-credential-vault.js'
import {
  executeProviderAuthCommand,
  secretLine,
  type ProviderAuthVault,
} from './provider-auth-command.js'

function fakeVault(
  initial: ProviderCredentialMetadata[] = [],
): ProviderAuthVault & {
  records: ProviderCredentialMetadata[]
  getSecret(): string | undefined
} {
  const records = [...initial]
  let secret: string | undefined
  return {
    records,
    getSecret() {
      return secret
    },
    async read(key) {
      const found = records.find(
        (record) =>
          record.key.providerId === key.providerId &&
          record.key.profileId === key.profileId,
      )
      return found
        ? {
            type: 'api-key' as const,
            secret: 'fixture-secret',
            revision: found.revision,
            updatedAt: found.updatedAt,
          }
        : undefined
    },
    async list() {
      return records
    },
    async modify(key, callback) {
      const next = await callback(undefined)
      if (next) {
        const metadata = {
          key,
          type: 'api-key' as const,
          revision: 1,
          updatedAt: '2026-01-01T00:00:00.000Z',
        }
        records.push(metadata)
        if (next.type === 'api-key') {
          secret = next.secret
          return {
            type: 'api-key',
            secret: next.secret,
            revision: metadata.revision,
            updatedAt: metadata.updatedAt,
          }
        }
        return {
          type: 'oauth',
          accessToken: next.accessToken,
          refreshToken: next.refreshToken,
          expiresAt: next.expiresAt,
          ...(next.accountId === undefined
            ? {}
            : { accountId: next.accountId }),
          revision: metadata.revision,
          updatedAt: metadata.updatedAt,
        }
      }
      return undefined
    },
    async delete(key) {
      for (let index = records.length - 1; index >= 0; index -= 1) {
        if (
          records[index]?.key.providerId === key.providerId &&
          records[index]?.key.profileId === key.profileId
        )
          records.splice(index, 1)
      }
    },
  }
}

function io(secret?: string) {
  const stdout: string[] = []
  const stderr: string[] = []
  return {
    stdout,
    stderr,
    io: {
      stdout: (value: string) => stdout.push(value),
      stderr: (value: string) => stderr.push(value),
      readSecret: async () => secret ?? '',
    },
  }
}

describe('provider auth command', () => {
  it('stores a selected profile without exposing the secret', async () => {
    const capture = io(`unit-${Date.now()}`)
    const vault = fakeVault()
    await expect(
      executeProviderAuthCommand(
        ['auth', 'set-key', 'openai', '--profile', 'work'],
        {
          io: capture.io,
          vault,
        },
      ),
    ).resolves.toBe(0)
    expect(vault.records[0]?.key).toEqual({
      providerId: 'openai',
      profileId: 'work',
    })
    expect(capture.stdout.join('')).not.toContain(vault.getSecret())
  })

  it('status is metadata-only and sorts credentials', async () => {
    const capture = io()
    const vault = fakeVault([
      {
        key: { providerId: 'zeta', profileId: 'default' },
        type: 'oauth',
        revision: 4,
        updatedAt: '2026-01-02T00:00:00.000Z',
        expiresAt: 1,
      },
      {
        key: { providerId: 'alpha', profileId: 'work' },
        type: 'api-key',
        revision: 2,
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ])
    await executeProviderAuthCommand(['auth', 'status', '--json'], {
      io: capture.io,
      vault,
    })
    const output = capture.stdout.join('')
    expect(output.indexOf('alpha')).toBeLessThan(output.indexOf('zeta'))
    expect(output).not.toContain('revision')
  })

  it('scopes logout to the requested profile and is idempotent', async () => {
    const capture = io()
    const vault = fakeVault([
      {
        key: { providerId: 'openai', profileId: 'work' },
        type: 'api-key',
        revision: 1,
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        key: { providerId: 'openai', profileId: 'default' },
        type: 'api-key',
        revision: 1,
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ])
    await executeProviderAuthCommand(
      ['auth', 'logout', 'openai', '--profile', 'work'],
      {
        io: capture.io,
        vault,
      },
    )
    await executeProviderAuthCommand(
      ['auth', 'logout', 'openai', '--profile', 'work'],
      {
        io: capture.io,
        vault,
      },
    )
    expect(vault.records.map((record) => record.key.profileId)).toEqual([
      'default',
    ])
  })

  it('persists set-key through the native file vault', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-provider-auth-'))
    try {
      const vault = new ProviderCredentialVault({
        configRoot: root,
        useKeychain: false,
        environment: { PRAXIS_PROVIDER_CREDENTIAL_STORE: 'file' },
      })
      const capture = io(`file-${Date.now()}`)
      await executeProviderAuthCommand(['auth', 'set-key', 'openai'], {
        io: capture.io,
        vault,
      })
      await expect(
        vault.read({ providerId: 'openai', profileId: 'default' }),
      ).resolves.toMatchObject({ type: 'api-key' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('selects device OAuth with the requested profile and keeps JSON clean', async () => {
    const capture = io()
    const vault = fakeVault()
    let seen:
      | { profileId: string; noBrowser?: boolean; signal?: AbortSignal }
      | undefined
    const signal = new AbortController().signal
    await executeProviderAuthCommand(
      ['auth', 'login', 'openai-codex', '--device', '--no-browser', '--json'],
      {
        io: capture.io,
        vault,
        signal,
        profile: 'work',
        assertCodexLoginEnabled: async () => undefined,
        deviceLoginWithCodexOAuth: async (options) => {
          seen = options
          return {
            type: 'oauth',
            accessToken: `access-${Date.now()}`,
            refreshToken: `refresh-${Date.now()}`,
            expiresAt: Date.now() + 1000,
            accountId: `account-${Date.now()}`,
          }
        },
      },
    )
    expect(seen).toMatchObject({ profileId: 'work', noBrowser: true, signal })
    expect(capture.stdout.join('')).toBe(
      '{"provider":"openai-codex","profile":"work","type":"oauth"}\n',
    )
    expect(capture.stdout.join('')).not.toMatch(/access-|refresh-|account-/u)
  })

  it('uses browser OAuth by default and routes instructions only to stderr', async () => {
    const capture = io()
    const vault = fakeVault()
    let browserCalls = 0
    let deviceCalls = 0
    await executeProviderAuthCommand(
      ['auth', 'login', 'openai-codex', '--profile', 'browser'],
      {
        io: capture.io,
        vault,
        assertCodexLoginEnabled: async () => undefined,
        loginWithCodexOAuth: async (options) => {
          browserCalls += 1
          expect(options).toMatchObject({ profileId: 'browser' })
          expect(options.noBrowser).toBeUndefined()
          options.write?.('Open the authorization page.\n')
          return {
            type: 'oauth',
            accessToken: 'browser-access-token',
            refreshToken: 'browser-refresh-token',
            expiresAt: Date.now() + 1000,
            accountId: 'browser-account-id',
          }
        },
        deviceLoginWithCodexOAuth: async () => {
          deviceCalls += 1
          throw new Error('device flow must not be selected')
        },
      },
    )
    expect(browserCalls).toBe(1)
    expect(deviceCalls).toBe(0)
    expect(capture.stdout.join('')).toBe('Logged in openai-codex/browser.\n')
    expect(capture.stderr.join('')).toBe('Open the authorization page.\n')
    expect(`${capture.stdout.join('')}${capture.stderr.join('')}`).not.toMatch(
      /browser-(?:access-token|refresh-token|account-id)/u,
    )
  })

  it('fails the experimental gate before invoking OAuth', async () => {
    const capture = io()
    let oauthCalls = 0
    await expect(
      executeProviderAuthCommand(['auth', 'login', 'openai-codex'], {
        io: capture.io,
        vault: fakeVault(),
        assertCodexLoginEnabled: async () => {
          throw new Error(
            'openai-codex requires experimental.codexSubscription=true',
          )
        },
        loginWithCodexOAuth: async () => {
          oauthCalls += 1
          throw new Error('OAuth must not start while disabled')
        },
      }),
    ).rejects.toThrow('experimental.codexSubscription=true')
    expect(oauthCalls).toBe(0)
    expect(capture.stdout).toEqual([])
    expect(capture.stderr).toEqual([])
  })

  it('rejects invalid auth grammar and conflicting profile selectors', async () => {
    const capture = io('unused')
    const vault = fakeVault()
    for (const args of [
      ['auth'],
      ['auth', 'set-key'],
      ['auth', 'set-key', 'openai-codex'],
      ['auth', 'login', 'openai'],
      ['auth', 'status', '--device'],
      ['auth', 'logout', 'openai', 'extra'],
      ['auth', 'status', 'invalid/provider'],
      ['auth', 'status', '--profile', 'invalid/profile'],
    ]) {
      await expect(
        executeProviderAuthCommand(args, { io: capture.io, vault }),
      ).rejects.toThrow()
    }
    await expect(
      executeProviderAuthCommand(
        ['auth', 'status', '--profile', 'auth-profile'],
        {
          io: capture.io,
          vault,
          providerProfile: 'global-profile',
        },
      ),
    ).rejects.toThrow('conflicts with --provider-profile')
  })

  it('accepts one final line ending and rejects extra or oversized input', () => {
    const exact = 'x'.repeat(64 * 1024)
    expect(secretLine(exact)).toBe(exact)
    const line = 'x'.repeat(64 * 1024 - 1)
    expect(secretLine(`${line}\n`)).toBe(line)
    const crlfLine = 'x'.repeat(64 * 1024 - 2)
    expect(secretLine(`${crlfLine}\r\n`)).toBe(crlfLine)
    expect(() => secretLine(`${exact}x`)).toThrow(/64 KiB/u)
    expect(() => secretLine('secret\nsecond')).toThrow(/one non-blank line/u)
    expect(() => secretLine('secret\rsecond')).toThrow(/one non-blank line/u)
    expect(() => secretLine('secret\n\n')).toThrow(/one non-blank line/u)
    expect(() => secretLine('\n')).toThrow(/one non-blank line/u)
    expect(() => secretLine('\r\n')).toThrow(/one non-blank line/u)
    expect(() => secretLine('   ')).toThrow(/one non-blank line/u)
  })
})
