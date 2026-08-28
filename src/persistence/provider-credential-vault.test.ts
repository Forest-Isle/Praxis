import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  ProviderCredentialVault,
  ProviderKeychainUnavailableError,
  providerCredentialFilePath,
  type ProviderCredentialKeychainAdapter,
} from './provider-credential-vault.js'

const key = { providerId: 'openai', profileId: 'default' }
const record = () => ({
  type: 'api-key' as const,
  secret: 'do-not-list',
})

async function root() {
  return mkdtemp(join(tmpdir(), 'praxis-provider-vault-'))
}

describe('ProviderCredentialVault', () => {
  it('writes a secure file, redacts list metadata, and increments revisions', async () => {
    const configRoot = await root()
    const vault = new ProviderCredentialVault({
      configRoot,
      useKeychain: false,
    })
    await vault.modify(key, () => record())
    const next = await vault.modify(key, () => ({
      type: 'api-key',
      secret: 'new-secret',
    }))
    expect(next).toMatchObject({
      type: 'api-key',
      secret: 'new-secret',
    })
    if (next === undefined) throw new Error('Expected updated credential')
    expect(next.revision).toBeGreaterThan(0)
    expect(await vault.list()).toEqual([
      {
        key,
        type: 'api-key',
        revision: expect.any(Number),
        updatedAt: expect.any(String),
      },
    ])
    await vault.modify(
      { providerId: 'openai-codex', profileId: 'work' },
      () => ({
        type: 'oauth',
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresAt: Date.now() + 60_000,
        accountId: 'account-id-must-not-list',
      }),
    )
    const listed = await vault.list()
    expect(
      listed.find(
        (value) =>
          value.key.providerId === 'openai-codex' &&
          value.key.profileId === 'work',
      ),
    ).toMatchObject({ type: 'oauth', expiresAt: expect.any(Number) })
    expect(JSON.stringify(listed)).not.toContain('account-id-must-not-list')
    expect(
      JSON.parse(await readFile(providerCredentialFilePath(configRoot), 'utf8'))
        .credentials['openai|default'].secret,
    ).toBe('new-secret')
  })

  it('rejects unsafe existing credential files and symlinks', async () => {
    const configRoot = await root()
    const path = providerCredentialFilePath(configRoot)
    await writeFile(path, JSON.stringify({ version: 1, credentials: {} }))
    await chmod(path, 0o644)
    await expect(
      new ProviderCredentialVault({ configRoot, useKeychain: false }).list(),
    ).rejects.toThrow(/group\/world/)
    await chmod(path, 0o600)
    const realPath = join(configRoot, 'real-credentials.json')
    await writeFile(realPath, JSON.stringify({ version: 1, credentials: {} }), {
      mode: 0o600,
    })
    await rm(path)
    await symlink(realPath, path)
    await expect(
      new ProviderCredentialVault({ configRoot, useKeychain: false }).read({
        providerId: 'openai',
        profileId: 'default',
      }),
    ).rejects.toThrow(/non-symlink/)
  })

  it('rejects unsafe root reads and repairs owned roots before mutation', async () => {
    const configRoot = await root()
    await chmod(configRoot, 0o755)
    const vault = new ProviderCredentialVault({
      configRoot,
      useKeychain: false,
    })

    await expect(vault.list()).rejects.toThrow(
      /config root must not be group\/world accessible/,
    )
    expect((await stat(configRoot)).mode & 0o777).toBe(0o755)
    await expect(vault.modify(key, () => record())).resolves.toMatchObject({
      secret: 'do-not-list',
    })
    expect((await stat(configRoot)).mode & 0o777).toBe(0o700)
    await expect(vault.read(key)).resolves.toMatchObject({
      secret: 'do-not-list',
    })
    await expect(vault.list()).resolves.toEqual([
      {
        key,
        type: 'api-key',
        revision: expect.any(Number),
        updatedAt: expect.any(String),
      },
    ])
  })

  it('reconciles a newer file record and removes fallback after Keychain mutation', async () => {
    const configRoot = await root()
    const path = providerCredentialFilePath(configRoot)
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        credentials: {
          'openai|default': {
            ...record(),
            revision: 2,
            updatedAt: '2026-08-28T00:00:00.000Z',
          },
        },
      }),
      { mode: 0o600 },
    )
    let serialized: string | undefined
    const adapter: ProviderCredentialKeychainAdapter = {
      read: async () => undefined,
      write: async (_service, value) => {
        serialized = value
      },
      delete: async () => undefined,
    }
    const vault = new ProviderCredentialVault({
      configRoot,
      useKeychain: true,
      keychain: adapter,
    })
    await vault.modify(key, () => ({
      type: 'api-key',
      secret: 'keychain-secret',
    }))
    if (serialized === undefined)
      throw new Error('Expected serialized credential')
    const serializedEnvelope = JSON.parse(serialized)
    expect(serializedEnvelope.credentials['openai|default']).toMatchObject({
      secret: 'keychain-secret',
    })
    expect(
      serializedEnvelope.credentials['openai|default'].revision,
    ).toBeGreaterThan(2)
    await expect(readFile(path, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('prefers the newer file over a stale Keychain record and rejects equal conflicts', async () => {
    const configRoot = await root()
    const path = providerCredentialFilePath(configRoot)
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        credentials: {
          'openai|default': {
            ...record(),
            revision: 2,
            updatedAt: '2026-08-28T00:00:00.000Z',
          },
        },
      }),
      { mode: 0o600 },
    )
    const stale = JSON.stringify({
      version: 1,
      credentials: {
        'openai|default': {
          ...record(),
          secret: 'stale',
          revision: 1,
          updatedAt: '2026-08-27T00:00:00.000Z',
        },
      },
    })
    const adapter: ProviderCredentialKeychainAdapter = {
      read: async () => stale,
      write: async () => undefined,
      delete: async () => undefined,
    }
    await expect(
      new ProviderCredentialVault({
        configRoot,
        useKeychain: true,
        keychain: adapter,
      }).read(key),
    ).resolves.toMatchObject({ revision: 2, secret: 'do-not-list' })
    const conflictValue = JSON.parse(stale) as {
      credentials: Record<string, { secret: string; revision: number }>
    }
    const conflictCredential = conflictValue.credentials['openai|default']
    if (conflictCredential === undefined)
      throw new Error('Expected stale credential')
    conflictCredential.secret = 'different'
    conflictCredential.revision = 2
    const conflict = JSON.stringify(conflictValue)
    const conflictAdapter: ProviderCredentialKeychainAdapter = {
      ...adapter,
      read: async () => conflict,
    }
    await expect(
      new ProviderCredentialVault({
        configRoot,
        useKeychain: true,
        keychain: conflictAdapter,
      }).read(key),
    ).rejects.toThrow(/Conflicting provider credentials/)
  })

  it('falls back only when Keychain is unavailable and keeps arbitrary errors fail-closed', async () => {
    const configRoot = await root()
    const unavailable: ProviderCredentialKeychainAdapter = {
      read: async () => undefined,
      write: async () => {
        throw new ProviderKeychainUnavailableError()
      },
      delete: async () => undefined,
    }
    await new ProviderCredentialVault({
      configRoot,
      useKeychain: true,
      keychain: unavailable,
    }).modify(key, () => record())
    const fileInformation = await stat(providerCredentialFilePath(configRoot))
    const rootInformation = await stat(configRoot)
    expect(fileInformation.mode & 0o777).toBe(0o600)
    expect(rootInformation.mode & 0o777).toBe(0o700)
    const arbitrary: ProviderCredentialKeychainAdapter = {
      ...unavailable,
      write: async () => {
        throw new Error('do-not-leak')
      },
    }
    await expect(
      new ProviderCredentialVault({
        configRoot: await root(),
        useKeychain: true,
        keychain: arbitrary,
      }).modify(key, () => record()),
    ).rejects.toThrow('do-not-leak')
  })

  it('rejects malformed and oversized credential files', async () => {
    const configRoot = await root()
    const path = providerCredentialFilePath(configRoot)
    await writeFile(path, '{bad', { mode: 0o600 })
    await expect(
      new ProviderCredentialVault({ configRoot, useKeychain: false }).list(),
    ).rejects.toThrow(/Invalid provider credential JSON/)
    await writeFile(path, 'x'.repeat(1024 * 1024 + 1), { mode: 0o600 })
    await expect(
      new ProviderCredentialVault({ configRoot, useKeychain: false }).list(),
    ).rejects.toThrow(/exceeds 1 MiB/)
  })

  it('rejects malformed OAuth account identities on input and read', async () => {
    const configRoot = await root()
    const vault = new ProviderCredentialVault({
      configRoot,
      useKeychain: false,
    })
    for (const accountId of [
      '',
      '   ',
      ' account',
      'account ',
      'é'.repeat(257),
    ]) {
      await expect(
        vault.modify(
          { providerId: 'openai-codex', profileId: 'default' },
          () => ({
            type: 'oauth',
            accessToken: 'access-token',
            refreshToken: 'refresh-token',
            expiresAt: Date.now() + 60_000,
            accountId,
          }),
        ),
      ).rejects.toThrow(/Invalid provider OAuth account ID/u)
    }

    await writeFile(
      providerCredentialFilePath(configRoot),
      JSON.stringify({
        version: 1,
        credentials: {
          'openai-codex|default': {
            type: 'oauth',
            accessToken: 'access-token',
            refreshToken: 'refresh-token',
            expiresAt: Date.now() + 60_000,
            accountId: '   ',
            revision: 1,
            updatedAt: '2026-08-28T00:00:00.000Z',
          },
        },
      }),
      { mode: 0o600 },
    )
    await expect(
      vault.read({ providerId: 'openai-codex', profileId: 'default' }),
    ).rejects.toThrow(/Invalid provider OAuth account ID/u)
  })

  it('serializes concurrent mutations and preserves both records', async () => {
    const configRoot = await root()
    const first = new ProviderCredentialVault({
      configRoot,
      useKeychain: false,
    })
    const second = new ProviderCredentialVault({
      configRoot,
      useKeychain: false,
    })
    await Promise.all([
      first.modify({ providerId: 'openai', profileId: 'default' }, () =>
        record(),
      ),
      second.modify({ providerId: 'anthropic', profileId: 'default' }, () => ({
        type: 'api-key',
        secret: 'second',
      })),
    ])
    expect(await first.read(key)).toMatchObject({
      revision: expect.any(Number),
    })
    expect(
      await second.read({ providerId: 'anthropic', profileId: 'default' }),
    ).toMatchObject({ revision: expect.any(Number), secret: 'second' })
  })

  it('awaits an async mutation callback before persisting', async () => {
    const configRoot = await root()
    const vault = new ProviderCredentialVault({
      configRoot,
      useKeychain: false,
    })
    let completed = false
    const stored = await vault.modify(key, async () => {
      await Promise.resolve()
      completed = true
      return record()
    })
    expect(completed).toBe(true)
    expect(stored).toMatchObject({ type: 'api-key', secret: 'do-not-list' })
    expect(await vault.read(key)).toMatchObject({ secret: 'do-not-list' })
  })

  it('persists deletion tombstones through Keychain unavailability and supports monotonic recreation', async () => {
    const configRoot = await root()
    const path = providerCredentialFilePath(configRoot)
    const initial = new ProviderCredentialVault({
      configRoot,
      useKeychain: false,
    })
    const created = await initial.modify(key, () => record())
    const unavailable: ProviderCredentialKeychainAdapter = {
      read: async () => undefined,
      write: async () => {
        throw new ProviderKeychainUnavailableError()
      },
      delete: async () => undefined,
    }
    await new ProviderCredentialVault({
      configRoot,
      useKeychain: true,
      keychain: unavailable,
    }).delete(key)
    expect(
      await new ProviderCredentialVault({
        configRoot,
        useKeychain: false,
      }).read(key),
    ).toBeUndefined()
    const stale: ProviderCredentialKeychainAdapter = {
      read: async () =>
        JSON.stringify({
          version: 1,
          credentials: {
            'openai|default': {
              ...record(),
              revision: 1,
              updatedAt: '2026-08-28T00:00:00.000Z',
            },
          },
        }),
      write: async () => undefined,
      delete: async () => undefined,
    }
    const reconciled = new ProviderCredentialVault({
      configRoot,
      useKeychain: true,
      keychain: stale,
    })
    await expect(reconciled.read(key)).resolves.toBeUndefined()
    await expect(reconciled.list()).resolves.toEqual([])
    const recreated = await new ProviderCredentialVault({
      configRoot,
      useKeychain: false,
    }).modify(key, () => ({ type: 'api-key', secret: 'new' }))
    if (created === undefined) throw new Error('Expected initial credential')
    expect(recreated?.revision).toBeGreaterThan(created.revision)
    expect(recreated).toMatchObject({ secret: 'new' })
    expect(JSON.parse(await readFile(path, 'utf8')).deleted).toBeUndefined()
  })
})
