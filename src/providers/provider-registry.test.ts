import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  createProviderRegistry,
  resolveProviderRegistry,
} from './provider-registry.js'
import { ProviderAuthenticationError } from './provider-auth.js'
import type { ProviderTarget } from './provider-settings.js'

const target = (protocol: ProviderTarget['protocol']): ProviderTarget => ({
  providerId: 'fixture',
  profileId: 'default',
  modelId: 'fixture-model',
  protocol,
  baseUrl:
    protocol === 'anthropic-messages'
      ? 'https://relay.example/v1'
      : 'https://relay.example/v1',
  credential: { source: 'env', name: 'FIXTURE_KEY' },
  billingMode: 'api',
  experimental: false,
})

describe('ProviderRegistry', () => {
  it('creates OpenAI and Anthropic adapters from one resolved target', () => {
    const credential = {
      type: 'api-key' as const,
      secret: 'secret',
      source: { source: 'env' as const, name: 'FIXTURE_KEY' },
    }
    const openai = createProviderRegistry({
      target: target('openai-compatible'),
      credential,
    })
    const anthropic = createProviderRegistry({
      target: target('anthropic-messages'),
      credential,
    })
    expect(openai.target).toMatchObject({
      providerId: 'fixture',
      modelId: 'fixture-model',
    })
    expect(openai.credentialSource).toEqual({
      source: 'env',
      name: 'FIXTURE_KEY',
    })
    expect(openai.create().model).toBe('fixture-model')
    expect(anthropic.create('other-model').model).toBe('other-model')
  })

  it('resolves Anthropic prompt caching for each created model', () => {
    const credential = {
      type: 'api-key' as const,
      secret: 'secret',
      source: { source: 'env' as const, name: 'FIXTURE_KEY' },
    }
    const resolved: Array<{ baseUrl: string; model: string }> = []
    const registry = createProviderRegistry({
      target: target('anthropic-messages'),
      credential,
      anthropicPromptCacheResolver: (value) => {
        resolved.push(value)
        return false
      },
    })

    registry.create('alternate-model')

    expect(resolved).toEqual([
      { baseUrl: 'https://relay.example/v1', model: 'alternate-model' },
    ])
  })

  it('rejects direct Codex construction without its OAuth vault', () => {
    expect(() =>
      createProviderRegistry({
        target: {
          ...target('codex-subscription'),
          providerId: 'openai-codex',
          protocol: 'codex-subscription',
          billingMode: 'subscription',
        },
        credential: {
          type: 'oauth',
          accessToken: 'a',
          refreshToken: 'r',
          expiresAt: 1,
          source: {
            source: 'vault',
            providerId: 'openai-codex',
            profileId: 'default',
          },
        },
      }),
    ).toThrow(ProviderAuthenticationError)
  })

  it('resolves custom settings and can exclude settings in safe mode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-provider-registry-'))
    const cwd = join(root, 'project')
    await mkdir(cwd, { recursive: true })
    await writeFile(
      join(root, 'settings.json'),
      JSON.stringify({
        provider: 'fixture',
        model: 'custom-model',
        providers: {
          fixture: {
            protocol: 'openai-compatible',
            profiles: {
              default: {
                baseUrl: 'https://relay.example/v1',
                credential: { source: 'env', name: 'FIXTURE_KEY' },
              },
            },
          },
        },
      }),
    )
    const vault = {
      read: async () => undefined,
      modify: async () => undefined,
    }
    await expect(
      resolveProviderRegistry({
        configRoot: root,
        cwd,
        environment: { FIXTURE_KEY: 'secret' },
        vault,
      }),
    ).resolves.toMatchObject({
      target: { providerId: 'fixture', modelId: 'custom-model' },
    })
    await expect(
      resolveProviderRegistry({
        configRoot: root,
        cwd,
        environment: {
          FIXTURE_KEY: 'secret',
          PRAXIS_PROVIDER: 'openai',
          PRAXIS_MODEL: 'safe-model',
          OPENAI_API_KEY: 'openai',
        },
        includeSettings: false,
        vault,
      }),
    ).resolves.toMatchObject({
      target: { providerId: 'openai', modelId: 'safe-model' },
    })
  })
})
