import { describe, expect, it } from 'vitest'

import { resolveProviderCredential } from './provider-auth.js'
import type { ProviderTarget } from './provider-settings.js'

const target = (credential: ProviderTarget['credential']): ProviderTarget => ({
  providerId: 'vendor',
  profileId: 'default',
  modelId: 'model',
  protocol: 'openai-compatible',
  baseUrl: 'https://vendor.example/v1',
  credential,
  billingMode: 'api',
  experimental: false,
})
const vault = (record: unknown) => ({ read: async () => record as never })

describe('resolveProviderCredential', () => {
  it('honors explicit and legacy API keys before configured sources', async () => {
    await expect(
      resolveProviderCredential({
        target: target({ source: 'env', name: 'VENDOR_KEY' }),
        environment: { VENDOR_KEY: 'configured' },
        apiKey: 'explicit',
        vault: vault(undefined),
      }),
    ).resolves.toMatchObject({
      secret: 'explicit',
      source: { source: 'explicit' },
    })
    await expect(
      resolveProviderCredential({
        target: target({ source: 'env', name: 'VENDOR_KEY' }),
        environment: { PRAXIS_API_KEY: 'legacy', VENDOR_KEY: 'configured' },
        vault: vault(undefined),
      }),
    ).resolves.toMatchObject({
      secret: 'legacy',
      source: { source: 'legacy-env' },
    })
  })

  it('supports command and vault API key sources without fallback', async () => {
    let commandOptions:
      { timeoutMs: number; maxOutputBytes: number } | undefined
    await expect(
      resolveProviderCredential({
        target: target({ source: 'command', command: ['helper', '--token'] }),
        vault: vault(undefined),
        commandRunner: async (argv, options) => {
          commandOptions = options
          return {
            stdout: `${argv.join(' ')}-token\n`,
            exitCode: 0,
          }
        },
      }),
    ).resolves.toMatchObject({
      secret: 'helper --token-token',
      source: { source: 'command' },
    })
    expect(commandOptions).toEqual({
      timeoutMs: 10_000,
      maxOutputBytes: 64 * 1024,
    })
    const secret = 'command-secret'
    await expect(
      resolveProviderCredential({
        target: target({ source: 'command', command: ['helper'] }),
        vault: vault(undefined),
        commandRunner: async () => {
          throw new Error(`helper failed with ${secret}`)
        },
      }),
    ).rejects.toThrow(/credential command failed/)
    await expect(
      resolveProviderCredential({
        target: target({ source: 'command', command: ['helper'] }),
        vault: vault(undefined),
        commandRunner: async () => ({
          stdout: `${secret}\nother`,
          exitCode: 0,
        }),
      }),
    ).rejects.toThrow(/exactly one secret/)
    await expect(
      resolveProviderCredential({
        target: target({ source: 'command', command: ['helper'] }),
        vault: vault(undefined),
        commandRunner: async () => ({ stdout: secret, exitCode: 1 }),
      }),
    ).rejects.toThrow(/exited unsuccessfully/)
    await expect(
      resolveProviderCredential({
        target: target({ source: 'env', name: 'MISSING' }),
        environment: {},
        vault: vault({
          type: 'api-key',
          secret: 'vault',
          revision: 1,
          updatedAt: '2026-08-28T00:00:00.000Z',
        }),
      }),
    ).rejects.toThrow(/MISSING/)
  })

  it('resolves Codex OAuth only from the matching vault profile', async () => {
    const codex: ProviderTarget = {
      providerId: 'openai-codex',
      profileId: 'default',
      modelId: 'codex',
      protocol: 'codex-subscription',
      baseUrl: 'https://chatgpt.com/backend-api',
      credential: { source: 'vault' },
      billingMode: 'subscription',
      experimental: true,
    }
    await expect(
      resolveProviderCredential({
        target: codex,
        vault: vault({
          type: 'oauth',
          accessToken: 'access',
          refreshToken: 'refresh',
          expiresAt: 1,
          revision: 1,
          updatedAt: '2026-08-28T00:00:00.000Z',
        }),
      }),
    ).resolves.toMatchObject({ type: 'oauth', accessToken: 'access' })
    await expect(
      resolveProviderCredential({
        target: codex,
        environment: { PRAXIS_API_KEY: 'secret' },
        vault: vault(undefined),
      }),
    ).rejects.toThrow(/does not accept API keys/)
  })
})
