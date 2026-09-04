import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createProviderRegistry,
  resolveProviderContextWindowTokens,
  resolveProviderRegistry,
} from './provider-registry.js'
import { FallbackModelProvider } from './fallback-provider.js'
import { ProviderAuthenticationError } from './provider-auth.js'
import type { ProviderTarget } from './provider-settings.js'

afterEach(() => {
  vi.useRealTimers()
})

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
  it('previews context capacity from protocol and model without provider I/O', () => {
    expect(
      resolveProviderContextWindowTokens({
        protocol: 'anthropic-messages',
        modelId: 'claude-sonnet-4',
      }),
    ).toBe(200_000)
    expect(
      resolveProviderContextWindowTokens({
        protocol: 'anthropic-messages',
        modelId: 'claude-sonnet-4[1m]',
      }),
    ).toBe(1_000_000)
    expect(
      resolveProviderContextWindowTokens({
        protocol: 'anthropic-messages',
        modelId: 'claude-sonnet-4[1m]',
        explicitContextWindowTokens: 777_777,
      }),
    ).toBe(777_777)
    expect(
      resolveProviderContextWindowTokens({
        protocol: 'openai-compatible',
        modelId: 'gpt-test',
      }),
    ).toBeUndefined()
    expect(
      resolveProviderContextWindowTokens({
        protocol: 'openai-responses',
        modelId: 'gpt-test',
        explicitContextWindowTokens: 123_456,
      }),
    ).toBe(123_456)
    expect(
      resolveProviderContextWindowTokens({
        protocol: 'codex-subscription',
        modelId: 'gpt-test',
        explicitContextWindowTokens: 123_456,
      }),
    ).toBeUndefined()
  })

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

  it('resolves built-in Anthropic family aliases at the registry seam', () => {
    const credential = {
      type: 'api-key' as const,
      secret: 'secret',
      source: { source: 'env' as const, name: 'FIXTURE_KEY' },
    }
    const registry = createProviderRegistry({
      target: {
        ...target('anthropic-messages'),
        providerId: 'anthropic',
        modelId: 'sonnet',
      },
      credential,
      anthropicModelAliasOverrides: { opus: 'custom-opus' },
    })
    expect(registry.target.modelId).toBe('claude-sonnet-5')
    expect(registry.hasExplicitModelAlias('opus')).toBe(true)
    expect(registry.hasExplicitModelAlias('best')).toBe(true)
    expect(registry.hasExplicitModelAlias('best[1m]')).toBe(false)
    expect(registry.hasExplicitModelAlias('haiku')).toBe(false)
    expect(registry.create('opus').model).toBe('custom-opus')
    expect(registry.create('best').model).toBe('custom-opus')
    expect(registry.create('opus[1m]').model).toBe('custom-opus[1m]')
    expect(registry.create('haiku').model).toBe('claude-haiku-4-5-20251001')

    const custom = createProviderRegistry({
      target: {
        ...target('anthropic-messages'),
        providerId: 'relay',
        modelId: 'sonnet',
      },
      credential,
      anthropicModelAliasOverrides: { sonnet: 'should-not-apply' },
    })
    expect(custom.target.modelId).toBe('sonnet')
    expect(custom.hasExplicitModelAlias('sonnet')).toBe(false)
    expect(custom.hasExplicitModelAlias('best')).toBe(false)
    expect(custom.create('opus').model).toBe('opus')
    expect(custom.create('best').model).toBe('best')

    const builtInWithoutOverride = createProviderRegistry({
      target: {
        ...target('anthropic-messages'),
        providerId: 'anthropic',
        modelId: 'haiku',
      },
      credential,
    })
    expect(builtInWithoutOverride.hasExplicitModelAlias('haiku')).toBe(false)
    expect(builtInWithoutOverride.hasExplicitModelAlias('best')).toBe(false)
    expect(builtInWithoutOverride.hasExplicitModelAlias('unknown')).toBe(false)

    const nonAnthropic = createProviderRegistry({
      target: target('openai-compatible'),
      credential,
      anthropicModelAliasOverrides: { haiku: 'should-not-apply' },
    })
    expect(nonAnthropic.hasExplicitModelAlias('haiku')).toBe(false)
    expect(nonAnthropic.hasExplicitModelAlias('best')).toBe(false)
    expect(nonAnthropic.create('best').model).toBe('best')
  })

  it('enables one Anthropic stream-to-non-stream fallback by default', async () => {
    const requestBodies: Array<Record<string, unknown>> = []
    const fetchImplementation = vi.fn(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      requestBodies.push(body)
      if (body.stream === true) {
        return new Response(
          'data: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n' +
            'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"partial"}}\n\n',
        )
      }
      return Response.json({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'complete' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 2, output_tokens: 3 },
      })
    })
    const registry = createProviderRegistry({
      target: target('anthropic-messages'),
      credential: {
        type: 'api-key',
        secret: 'secret',
        source: { source: 'env', name: 'FIXTURE_KEY' },
      },
      fetchImplementation,
    })
    const events = []
    for await (const event of registry
      .create('single-model')
      .complete({ messages: [] })) {
      events.push(event)
    }

    expect(requestBodies.map((body) => body.stream)).toEqual([true, false])
    expect(events).toContainEqual({ type: 'text-delta', delta: 'complete' })
    expect(events).toContainEqual({ type: 'terminal', reason: 'end_turn' })
    expect(JSON.stringify(events)).not.toContain('partial')
    expect(fetchImplementation).toHaveBeenCalledTimes(2)
  })

  it('resolves Anthropic context specs and applies long-context request semantics', async () => {
    const requestBodies: Array<Record<string, unknown>> = []
    const requestBetas: string[] = []
    const fetchImplementation = vi.fn(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      requestBodies.push(body)
      requestBetas.push(new Headers(init?.headers).get('anthropic-beta') ?? '')
      if (body.stream === true) {
        return new Response(
          'data: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n',
        )
      }
      return Response.json({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'complete' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 2, output_tokens: 3 },
      })
    })
    const credential = {
      type: 'api-key' as const,
      secret: 'secret',
      source: { source: 'env' as const, name: 'FIXTURE_KEY' },
    }
    const cacheModels: string[] = []
    const registry = createProviderRegistry({
      target: target('anthropic-messages'),
      credential,
      context: { contextWindowTokens: 777_777 },
      anthropicThinking: { mode: 'enabled', maxTokens: 100 },
      anthropicPromptCacheResolver: ({ model }) => {
        cacheModels.push(model)
        return false
      },
      fetchImplementation,
    })
    const provider = registry.create('claude-sonnet-4[1m]')
    const events = []
    for await (const event of provider.complete({
      messages: [],
      betas: ['context-1m-2025-08-07', 'custom-beta'],
    }))
      events.push(event)

    expect(provider.model).toBe('claude-sonnet-4[1m]')
    expect(provider.capabilities.contextWindowTokens).toBe(777_777)
    expect(cacheModels).toEqual(['claude-sonnet-4', 'claude-sonnet-4'])
    expect(requestBodies.map((body) => body.model)).toEqual([
      'claude-sonnet-4',
      'claude-sonnet-4',
    ])
    expect(requestBodies.map((body) => body.stream)).toEqual([true, false])
    expect(requestBodies[0]).toBeDefined()
    expect(requestBetas).toEqual([
      'context-1m-2025-08-07,custom-beta,interleaved-thinking-2025-05-14',
      'context-1m-2025-08-07,custom-beta,interleaved-thinking-2025-05-14',
    ])

    const ordinary = createProviderRegistry({
      target: target('anthropic-messages'),
      credential,
    }).create('unknown')
    expect(ordinary.capabilities.contextWindowTokens).toBe(200_000)
    const longContext = createProviderRegistry({
      target: target('anthropic-messages'),
      credential,
    }).create('claude-sonnet-4[1m]')
    expect(longContext.model).toBe('claude-sonnet-4[1m]')
    expect(longContext.capabilities.contextWindowTokens).toBe(1_000_000)
    const adaptiveLongContext = createProviderRegistry({
      target: target('anthropic-messages'),
      credential,
    }).create('claude-sonnet-4-6[1m]')
    expect(adaptiveLongContext.capabilities.thinking?.modes).toEqual([
      'enabled',
      'adaptive',
      'disabled',
    ])
    const openai = createProviderRegistry({
      target: target('openai-compatible'),
      credential,
    }).create()
    expect(openai.capabilities.contextWindowTokens).toBeUndefined()
    expect(() => registry.create('[1m]')).toThrow(
      'Anthropic [1m] model spec must include a base model name',
    )
    expect(fetchImplementation).toHaveBeenCalledTimes(2)
  })

  it('flows built-in Anthropic environment aliases into long-context requests', async () => {
    const requestBodies: Array<Record<string, unknown>> = []
    const requestBetas: string[] = []
    const fetchImplementation = vi.fn(async (_input, init) => {
      requestBodies.push(
        JSON.parse(String(init?.body)) as Record<string, unknown>,
      )
      requestBetas.push(new Headers(init?.headers).get('anthropic-beta') ?? '')
      if (requestBodies.at(-1)?.stream === true)
        return new Response(
          'data: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n',
        )
      return Response.json({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'complete' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 2, output_tokens: 3 },
      })
    })
    const registry = createProviderRegistry({
      target: {
        ...target('anthropic-messages'),
        providerId: 'anthropic',
        modelId: 'sonnet',
      },
      credential: {
        type: 'api-key',
        secret: 'secret',
        source: { source: 'env', name: 'ANTHROPIC_API_KEY' },
      },
      anthropicModelAliasOverrides: { sonnet: 'fixture-sonnet' },
      fetchImplementation,
    })
    const provider = registry.create('sonnet[1m]')
    for await (const event of provider.complete({ messages: [] })) {
      expect(event).toBeDefined()
    }

    expect(provider.model).toBe('fixture-sonnet[1m]')
    expect(provider.capabilities.contextWindowTokens).toBe(1_000_000)
    expect(requestBodies.map((body) => body.model)).toEqual([
      'fixture-sonnet',
      'fixture-sonnet',
    ])
    expect(
      requestBetas.every((value) => value.includes('context-1m-2025-08-07')),
    ).toBe(true)
  })

  it('keeps Anthropic non-streaming recovery inside multi-model routing', async () => {
    const requestBodies: Array<Record<string, unknown>> = []
    const fetchImplementation = vi.fn(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      requestBodies.push(body)
      if (body.stream === true) {
        return new Response(
          'data: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n',
        )
      }
      return Response.json({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'recovered-primary' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 2, output_tokens: 3 },
      })
    })
    const registry = createProviderRegistry({
      target: target('anthropic-messages'),
      credential: {
        type: 'api-key',
        secret: 'secret',
        source: { source: 'env', name: 'FIXTURE_KEY' },
      },
      fetchImplementation,
    })
    const provider = new FallbackModelProvider({
      providers: [registry.create('primary'), registry.create('secondary')],
      retryDelayMs: 0,
    })
    const events = []
    for await (const event of provider.complete({ messages: [] }))
      events.push(event)

    expect(
      requestBodies.map((body) => ({ model: body.model, stream: body.stream })),
    ).toEqual([
      { model: 'primary', stream: true },
      { model: 'primary', stream: false },
    ])
    expect(events).toContainEqual({
      type: 'text-delta',
      delta: 'recovered-primary',
    })
    expect(JSON.stringify(events)).not.toContain('secondary')
    expect(fetchImplementation).toHaveBeenCalledTimes(2)
  })

  it('preserves the Anthropic stream failure when fallback is disabled', async () => {
    const requestBodies: Array<Record<string, unknown>> = []
    const fetchImplementation = vi.fn(async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)))
      return new Response(
        'data: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n',
      )
    })
    const registry = createProviderRegistry({
      target: target('anthropic-messages'),
      credential: {
        type: 'api-key',
        secret: 'secret',
        source: { source: 'env', name: 'FIXTURE_KEY' },
      },
      providerEnvironment: {
        provider: 'anthropic',
        baseUrl: 'https://relay.example/v1',
        deadlineMs: 1_000,
        connectTimeoutMs: 100,
        idleTimeoutMs: 100,
        disableNonStreamingFallback: true,
      },
      fetchImplementation,
    })
    const consume = async () => {
      for await (const event of registry.create().complete({ messages: [] }))
        void event
    }

    await expect(consume()).rejects.toThrow(
      'Provider stream ended before a terminal event',
    )
    expect(requestBodies.map((body) => body.stream)).toEqual([true])
    expect(fetchImplementation).toHaveBeenCalledTimes(1)
  })

  it.each([
    [401, 'authentication_error', 'authentication_failed'],
    [429, 'rate_limit_error', 'rate_limit'],
    [400, 'prompt_too_long', 'prompt_too_long'],
  ] as const)(
    'does not replay an Anthropic HTTP %s %s failure',
    async (status, type, kind) => {
      const requestBodies: Array<Record<string, unknown>> = []
      const fetchImplementation = vi.fn(async (_input, init) => {
        requestBodies.push(JSON.parse(String(init?.body)))
        return Response.json(
          { type: 'error', error: { type, message: type } },
          { status },
        )
      })
      const registry = createProviderRegistry({
        target: target('anthropic-messages'),
        credential: {
          type: 'api-key',
          secret: 'secret',
          source: { source: 'env', name: 'FIXTURE_KEY' },
        },
        fetchImplementation,
      })
      const consume = async () => {
        for await (const event of registry.create().complete({ messages: [] }))
          void event
      }

      await expect(consume()).rejects.toMatchObject({ kind, status })
      expect(requestBodies.map((body) => body.stream)).toEqual([true])
      expect(fetchImplementation).toHaveBeenCalledTimes(1)
    },
  )

  it('does not install a hidden non-streaming fallback for OpenAI-compatible providers', async () => {
    const requestBodies: Array<Record<string, unknown>> = []
    const fetchImplementation = vi.fn(async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)))
      return Response.json(
        { error: { message: 'temporary failure' } },
        { status: 503 },
      )
    })
    const registry = createProviderRegistry({
      target: target('openai-compatible'),
      credential: {
        type: 'api-key',
        secret: 'secret',
        source: { source: 'env', name: 'FIXTURE_KEY' },
      },
      providerEnvironment: {
        provider: 'openai',
        baseUrl: 'https://relay.example/v1',
        deadlineMs: 1_000,
        connectTimeoutMs: 100,
        idleTimeoutMs: 100,
        disableNonStreamingFallback: false,
      },
      fetchImplementation,
    })
    const consume = async () => {
      for await (const event of registry.create().complete({ messages: [] }))
        void event
    }

    await expect(consume()).rejects.toThrow('temporary failure')
    expect(requestBodies.map((body) => body.stream)).toEqual([true])
    expect(fetchImplementation).toHaveBeenCalledTimes(1)
  })

  it('creates API-key Responses without a non-streaming replay', async () => {
    const requestBodies: Array<Record<string, unknown>> = []
    const requestHeaders: Headers[] = []
    const fetchImplementation = vi.fn(async (_input, init) => {
      requestBodies.push(
        JSON.parse(String(init?.body)) as Record<string, unknown>,
      )
      requestHeaders.push(new Headers(init?.headers))
      return Response.json(
        { error: { type: 'server_error', message: 'temporary' } },
        { status: 503 },
      )
    })
    const registry = createProviderRegistry({
      target: target('openai-responses'),
      credential: {
        type: 'api-key',
        secret: 'responses-secret',
        source: { source: 'env', name: 'FIXTURE_KEY' },
      },
      providerEnvironment: {
        provider: 'openai',
        baseUrl: 'https://relay.example/v1',
        deadlineMs: 1_000,
        connectTimeoutMs: 100,
        idleTimeoutMs: 100,
        disableNonStreamingFallback: false,
      },
      fetchImplementation,
    })
    const consume = async () => {
      for await (const event of registry.create().complete({ messages: [] }))
        void event
    }

    await expect(consume()).rejects.toMatchObject({
      kind: 'server_error',
      retryable: true,
      status: 503,
    })
    expect(requestBodies).toHaveLength(1)
    expect(requestBodies[0]).toMatchObject({ stream: true, store: false })
    expect(requestHeaders[0]?.get('authorization')).toBe(
      'Bearer responses-secret',
    )
    expect(requestHeaders[0]?.has('chatgpt-account-id')).toBe(false)
    expect(fetchImplementation).toHaveBeenCalledTimes(1)
  })

  it('wraps Responses with the resolved deadline controls', async () => {
    vi.useFakeTimers()
    const registry = createProviderRegistry({
      target: target('openai-responses'),
      credential: {
        type: 'api-key',
        secret: 'secret',
        source: { source: 'env', name: 'FIXTURE_KEY' },
      },
      providerEnvironment: {
        provider: 'openai',
        baseUrl: 'https://relay.example/v1',
        deadlineMs: 1_000,
        connectTimeoutMs: 20,
        idleTimeoutMs: 100,
        disableNonStreamingFallback: false,
      },
      fetchImplementation: async () => new Promise<Response>(() => {}),
    })
    const completion = registry.create().complete({ messages: [] })
    const pending = completion[Symbol.asyncIterator]().next()
    const timedOut = expect(pending).rejects.toMatchObject({
      kind: 'timeout',
      timeoutPhase: 'connect',
      message: 'Provider connection timed out',
    })
    await vi.advanceTimersByTimeAsync(20)
    await timedOut
  })

  it('rejects OAuth credentials for public Responses', () => {
    expect(() =>
      createProviderRegistry({
        target: target('openai-responses'),
        credential: {
          type: 'oauth',
          accessToken: 'access',
          refreshToken: 'refresh',
          expiresAt: Date.now() + 100_000,
          source: {
            source: 'vault',
            providerId: 'fixture',
            profileId: 'default',
          },
        },
      }).create(),
    ).toThrow(ProviderAuthenticationError)
  })

  it('composes resolved connect and idle timeouts around providers', async () => {
    vi.useFakeTimers()
    const credential = {
      type: 'api-key' as const,
      secret: 'secret',
      source: { source: 'env' as const, name: 'FIXTURE_KEY' },
    }
    const connectRegistry = createProviderRegistry({
      target: target('openai-compatible'),
      credential,
      providerEnvironment: {
        provider: 'openai',
        baseUrl: 'https://relay.example/v1',
        deadlineMs: 1_000,
        connectTimeoutMs: 20,
        idleTimeoutMs: 100,
        disableNonStreamingFallback: false,
      },
      fetchImplementation: async () => new Promise<Response>(() => {}),
    })
    const connectCompletion = connectRegistry
      .create()
      .complete({ messages: [] })
    const connectPending = connectCompletion[Symbol.asyncIterator]().next()
    const connectTimedOut = expect(connectPending).rejects.toMatchObject({
      timeoutPhase: 'connect',
      message: 'Provider connection timed out',
    })
    await vi.advanceTimersByTimeAsync(20)
    await connectTimedOut

    const idleRegistry = createProviderRegistry({
      target: target('openai-compatible'),
      credential,
      providerEnvironment: {
        provider: 'openai',
        baseUrl: 'https://relay.example/v1',
        deadlineMs: 1_000,
        connectTimeoutMs: 100,
        idleTimeoutMs: 30,
        disableNonStreamingFallback: false,
      },
      fetchImplementation: async () =>
        new Response(
          new ReadableStream<Uint8Array>({ start: () => undefined }),
        ),
    })
    const idleCompletion = idleRegistry.create().complete({ messages: [] })
    const idlePending = idleCompletion[Symbol.asyncIterator]().next()
    const idleTimedOut = expect(idlePending).rejects.toMatchObject({
      timeoutPhase: 'idle',
      message: 'Provider stream idle timed out',
    })
    await vi.advanceTimersByTimeAsync(30)
    await idleTimedOut
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

  it('parses built-in Anthropic model aliases from explicit environment', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-provider-alias-'))
    const vault = { read: async () => undefined, modify: async () => undefined }
    try {
      const registry = await resolveProviderRegistry({
        configRoot: root,
        cwd: root,
        environment: {
          PRAXIS_PROVIDER: 'anthropic',
          PRAXIS_MODEL: 'sonnet',
          ANTHROPIC_API_KEY: 'secret',
          ANTHROPIC_DEFAULT_SONNET_MODEL: 'fixture-sonnet',
        },
        vault,
      })
      expect(registry.target.modelId).toBe('fixture-sonnet')
      expect(registry.create().model).toBe('fixture-sonnet')

      const fallback = await resolveProviderRegistry({
        configRoot: root,
        cwd: root,
        environment: {
          PRAXIS_PROVIDER: 'anthropic',
          PRAXIS_MODEL: 'sonnet',
          ANTHROPIC_API_KEY: 'secret',
          ANTHROPIC_DEFAULT_SONNET_MODEL: '   ',
        },
        vault,
      })
      expect(fallback.target.modelId).toBe('claude-sonnet-5')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
