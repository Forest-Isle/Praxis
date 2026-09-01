import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createProviderRegistry,
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
