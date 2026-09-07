import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { resolveProviderTarget } from './provider-settings.js'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'praxis-provider-settings-'))
  const cwd = join(root, 'project')
  await mkdir(join(cwd, '.praxis'), { recursive: true })
  return { root, cwd }
}

describe('resolveProviderTarget', () => {
  it('resolves built-ins and legacy selection inputs', async () => {
    const { root, cwd } = await fixture()
    await expect(
      resolveProviderTarget({
        configRoot: root,
        cwd,
        environment: { PRAXIS_PROVIDER: 'anthropic', PRAXIS_MODEL: 'claude-3' },
      }),
    ).resolves.toMatchObject({
      providerId: 'anthropic',
      profileId: 'default',
      modelId: 'claude-3',
      protocol: 'anthropic-messages',
    })
  })

  it('selects Responses explicitly while preserving OpenAI Chat Completions', async () => {
    const { root, cwd } = await fixture()
    await expect(
      resolveProviderTarget({
        configRoot: root,
        cwd,
        environment: {
          PRAXIS_PROVIDER: 'openai-responses',
          PRAXIS_MODEL: 'gpt-responses',
        },
      }),
    ).resolves.toMatchObject({
      providerId: 'openai-responses',
      profileId: 'default',
      modelId: 'gpt-responses',
      protocol: 'openai-responses',
      baseUrl: 'https://api.openai.com/v1',
      credential: { source: 'env', name: 'OPENAI_API_KEY' },
      billingMode: 'api',
    })
    await expect(
      resolveProviderTarget({
        configRoot: root,
        cwd,
        environment: {
          PRAXIS_PROVIDER: 'openai',
          PRAXIS_MODEL: 'gpt-responses',
        },
      }),
    ).resolves.toMatchObject({
      providerId: 'openai',
      protocol: 'openai-compatible',
      modelId: 'gpt-responses',
    })
  })

  it('accepts explicit custom Responses profiles and rejects invalid variants', async () => {
    const { root, cwd } = await fixture()
    await writeFile(
      join(root, 'settings.json'),
      JSON.stringify({
        provider: 'vendor',
        model: 'vendor-model',
        providers: {
          vendor: {
            protocol: 'openai-responses',
            profiles: {
              default: {
                baseUrl: 'https://responses.example/v1',
                credential: { source: 'env', name: 'VENDOR_API_KEY' },
              },
            },
          },
        },
      }),
    )
    await expect(
      resolveProviderTarget({ configRoot: root, cwd, environment: {} }),
    ).resolves.toMatchObject({
      providerId: 'vendor',
      protocol: 'openai-responses',
      baseUrl: 'https://responses.example/v1',
      credential: { source: 'env', name: 'VENDOR_API_KEY' },
    })

    await writeFile(
      join(root, 'settings.json'),
      JSON.stringify({
        providers: {
          vendor: {
            protocol: 'responses-auto',
            profiles: {
              default: {
                baseUrl: 'https://responses.example/v1',
                credential: { source: 'env', name: 'VENDOR_API_KEY' },
              },
            },
          },
        },
      }),
    )
    await expect(
      resolveProviderTarget({
        configRoot: root,
        cwd,
        provider: 'vendor',
        model: 'm',
        environment: {},
      }),
    ).rejects.toThrow(/openai-responses/)
  })

  it('requires explicit Codex Responses opt-in and reports subscription billing', async () => {
    const { root, cwd } = await fixture()
    await writeFile(
      join(root, 'settings.json'),
      JSON.stringify({
        provider: 'codex-relay',
        model: 'gpt-codex',
        providers: {
          'codex-relay': {
            protocol: 'codex-responses',
            profiles: {
              default: {
                baseUrl: 'https://relay.example/v1',
                credential: { source: 'env', name: 'CODEX_RELAY_API_KEY' },
              },
            },
          },
        },
      }),
    )
    await expect(
      resolveProviderTarget({ configRoot: root, cwd, environment: {} }),
    ).rejects.toThrow(/codexResponses/)
    await writeFile(
      join(root, 'settings.json'),
      JSON.stringify({
        experimental: { codexResponses: true },
        provider: 'codex-relay',
        model: 'gpt-codex',
        providers: {
          'codex-relay': {
            protocol: 'codex-responses',
            profiles: {
              default: {
                baseUrl: 'https://relay.example/v1',
                credential: { source: 'env', name: 'CODEX_RELAY_API_KEY' },
              },
            },
          },
        },
      }),
    )
    await expect(
      resolveProviderTarget({ configRoot: root, cwd, environment: {} }),
    ).resolves.toMatchObject({
      protocol: 'codex-responses',
      billingMode: 'subscription',
      experimental: true,
    })
  })

  it('uses trusted local selection but ignores local provider definitions', async () => {
    const { root, cwd } = await fixture()
    await writeFile(
      join(root, 'settings.json'),
      JSON.stringify({
        model: 'global-model',
        providers: {
          vendor: {
            protocol: 'openai-compatible',
            profiles: {
              default: {
                baseUrl: 'https://vendor.example/v1',
                credential: { source: 'env', name: 'VENDOR_KEY' },
              },
            },
          },
        },
      }),
    )
    await writeFile(
      join(root, 'state.json'),
      JSON.stringify({ projects: { [cwd]: { trusted: true } } }),
    )
    await writeFile(
      join(cwd, '.praxis', 'settings.local.json'),
      JSON.stringify({
        provider: 'vendor',
        model: 'local-model',
        providers: { vendor: { protocol: 'anthropic-messages' } },
      }),
    )
    await expect(
      resolveProviderTarget({ configRoot: root, cwd, environment: {} }),
    ).resolves.toMatchObject({
      providerId: 'openai',
      modelId: 'global-model',
    })
    await expect(
      resolveProviderTarget({
        configRoot: root,
        cwd,
        includeProjectSettings: true,
        environment: {},
      }),
    ).resolves.toMatchObject({
      providerId: 'vendor',
      modelId: 'local-model',
      baseUrl: 'https://vendor.example/v1',
    })
  })

  it('ignores malformed project and local settings while untrusted, then fails when trusted', async () => {
    const { root, cwd } = await fixture()
    await writeFile(join(cwd, '.praxis', 'settings.json'), '{not-json')
    await writeFile(
      join(cwd, '.praxis', 'settings.local.json'),
      '{also-not-json',
    )
    await expect(
      resolveProviderTarget({
        configRoot: root,
        cwd,
        environment: { PRAXIS_MODEL: 'safe-model' },
      }),
    ).resolves.toMatchObject({ providerId: 'openai', modelId: 'safe-model' })
    await expect(
      resolveProviderTarget({
        configRoot: root,
        cwd,
        environment: { PRAXIS_MODEL: 'safe-model' },
        includeProjectSettings: true,
      }),
    ).rejects.toThrow(/Invalid provider settings JSON/)
  })

  it('rejects plaintext secrets, unsafe URLs, and unapproved Codex', async () => {
    const { root, cwd } = await fixture()
    await writeFile(
      join(root, 'settings.json'),
      JSON.stringify({
        providers: {
          vendor: {
            protocol: 'openai-compatible',
            profiles: {
              default: {
                baseUrl: 'https://x.example',
                credential: { source: 'env', name: 'KEY' },
                apiKey: 'secret',
              },
            },
          },
        },
      }),
    )
    await expect(
      resolveProviderTarget({
        configRoot: root,
        cwd,
        model: 'm',
        environment: {},
      }),
    ).rejects.toThrow(/plaintext secret/)
    await writeFile(join(root, 'settings.json'), '{}')
    await expect(
      resolveProviderTarget({
        configRoot: root,
        cwd,
        provider: 'openai-codex',
        model: 'm',
        environment: {
          PRAXIS_PROVIDER: 'openai-codex',
          PRAXIS_MODEL: 'm',
          PRAXIS_BASE_URL: 'https://override.example',
        },
      }),
    ).rejects.toThrow(/experimental/)
  })

  it('rejects unknown provider fields, including secret-shaped fields, by path', async () => {
    const cases = [
      {
        field: 'providers.vendor.secret',
        value: 'provider-secret-value',
        settings: {
          providers: {
            vendor: {
              protocol: 'openai-compatible',
              profiles: {
                default: {
                  baseUrl: 'https://vendor.example/v1',
                  credential: { source: 'env', name: 'VENDOR_KEY' },
                },
              },
              secret: 'provider-secret-value',
            },
          },
        },
      },
      {
        field: 'providers.vendor.profiles.default.token',
        value: 'profile-token-value',
        settings: {
          providers: {
            vendor: {
              protocol: 'openai-compatible',
              profiles: {
                default: {
                  baseUrl: 'https://vendor.example/v1',
                  credential: { source: 'env', name: 'VENDOR_KEY' },
                  token: 'profile-token-value',
                },
              },
            },
          },
        },
      },
      {
        field: 'providers.vendor.profiles.default.credential.api_key',
        value: 'credential-api-key-value',
        settings: {
          providers: {
            vendor: {
              protocol: 'openai-compatible',
              profiles: {
                default: {
                  baseUrl: 'https://vendor.example/v1',
                  credential: {
                    source: 'env',
                    name: 'VENDOR_KEY',
                    api_key: 'credential-api-key-value',
                  },
                },
              },
            },
          },
        },
      },
      {
        field: 'providers.vendor.profiles.default.baseUrll',
        value: 'https://typo.example/v1',
        settings: {
          providers: {
            vendor: {
              protocol: 'openai-compatible',
              profiles: {
                default: {
                  baseUrll: 'https://typo.example/v1',
                  credential: { source: 'env', name: 'VENDOR_KEY' },
                },
              },
            },
          },
        },
      },
    ]

    for (const testCase of cases) {
      const { root, cwd } = await fixture()
      await writeFile(
        join(root, 'settings.json'),
        JSON.stringify(testCase.settings),
      )
      try {
        await resolveProviderTarget({ configRoot: root, cwd, model: 'm' })
        expect.fail('expected invalid provider settings')
      } catch (error) {
        const message = (error as Error).message
        expect(message).toContain(testCase.field)
        expect(message).not.toContain(testCase.value)
      }
    }

    const { root, cwd } = await fixture()
    await writeFile(
      join(root, 'settings.json'),
      JSON.stringify({ unrelated: 'allowed', providers: {} }),
    )
    await expect(
      resolveProviderTarget({
        configRoot: root,
        cwd,
        model: 'm',
        environment: {},
      }),
    ).resolves.toMatchObject({ providerId: 'openai', modelId: 'm' })
  })

  it('requires a model and rejects endpoint overrides for Codex', async () => {
    const { root, cwd } = await fixture()
    await expect(
      resolveProviderTarget({ configRoot: root, cwd, environment: {} }),
    ).rejects.toThrow(/model is required/)
    await expect(
      resolveProviderTarget({
        configRoot: root,
        cwd,
        provider: 'openai-codex',
        model: 'm',
        environment: {
          PRAXIS_BASE_URL: 'https://override.example',
          PRAXIS_PROVIDER: 'openai-codex',
          PRAXIS_MODEL: 'm',
        },
      }),
    ).rejects.toThrow(/experimental/)
    await writeFile(
      join(root, 'settings.json'),
      JSON.stringify({ experimental: { codexSubscription: true } }),
    )
    await expect(
      resolveProviderTarget({
        configRoot: root,
        cwd,
        provider: 'openai-codex',
        model: 'm',
        environment: {
          PRAXIS_BASE_URL: 'https://override.example',
          PRAXIS_PROVIDER: 'openai-codex',
          PRAXIS_MODEL: 'm',
        },
      }),
    ).rejects.toThrow(/cannot override/)
  })

  it('preserves field-specific experimental validation errors', async () => {
    const { root, cwd } = await fixture()
    await writeFile(
      join(root, 'settings.json'),
      JSON.stringify({ experimental: { codexSubscription: 'yes' } }),
    )
    await expect(
      resolveProviderTarget({ configRoot: root, cwd, model: 'm' }),
    ).rejects.toThrow(
      'Invalid provider settings: experimental.codexSubscription must be a boolean',
    )
    await writeFile(
      join(root, 'settings.json'),
      JSON.stringify({ experimental: { codexResponses: 'yes' } }),
    )
    await expect(
      resolveProviderTarget({ configRoot: root, cwd, model: 'm' }),
    ).rejects.toThrow(
      'Invalid provider settings: experimental.codexResponses must be a boolean',
    )
    await writeFile(
      join(root, 'settings.json'),
      JSON.stringify({ experimental: { unrelated: 'allowed' } }),
    )
    await expect(
      resolveProviderTarget({ configRoot: root, cwd, model: 'm' }),
    ).resolves.toMatchObject({ modelId: 'm' })
  })

  it('defaults only the built-in Anthropic provider to the default model alias', async () => {
    const { root, cwd } = await fixture()
    await expect(
      resolveProviderTarget({
        configRoot: root,
        cwd,
        provider: 'anthropic',
        environment: {},
      }),
    ).resolves.toMatchObject({ providerId: 'anthropic', modelId: 'default' })
    await expect(
      resolveProviderTarget({
        configRoot: root,
        cwd,
        provider: 'openai',
        environment: {},
      }),
    ).rejects.toMatchObject({ code: 'model_required' })
    await expect(
      resolveProviderTarget({
        configRoot: root,
        cwd,
        provider: 'openai-responses',
        environment: {},
      }),
    ).rejects.toMatchObject({ code: 'model_required' })
    await writeFile(
      join(root, 'settings.json'),
      JSON.stringify({ experimental: { codexSubscription: true } }),
    )
    await expect(
      resolveProviderTarget({
        configRoot: root,
        cwd,
        provider: 'openai-codex',
        environment: {},
      }),
    ).rejects.toMatchObject({ code: 'model_required' })

    await writeFile(
      join(root, 'settings.json'),
      JSON.stringify({
        provider: 'vendor',
        providers: {
          anthropic: {
            protocol: 'anthropic-messages',
            profiles: {
              default: {
                baseUrl: 'https://custom-anthropic.example/v1',
                credential: { source: 'env', name: 'CUSTOM_ANTHROPIC_KEY' },
              },
            },
          },
          vendor: {
            protocol: 'openai-compatible',
            profiles: {
              default: {
                baseUrl: 'https://vendor.example/v1',
                credential: { source: 'env', name: 'VENDOR_KEY' },
              },
            },
          },
        },
      }),
    )
    await expect(
      resolveProviderTarget({ configRoot: root, cwd, environment: {} }),
    ).rejects.toMatchObject({ code: 'model_required' })
    await expect(
      resolveProviderTarget({
        configRoot: root,
        cwd,
        provider: 'anthropic',
        environment: {},
      }),
    ).rejects.toMatchObject({ code: 'model_required' })
  })
})
