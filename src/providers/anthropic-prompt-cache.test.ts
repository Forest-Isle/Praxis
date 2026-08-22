import { describe, expect, it } from 'vitest'

import { createAnthropicPromptCachePolicyResolver } from './anthropic-prompt-cache.js'

describe('createAnthropicPromptCachePolicyResolver', () => {
  it('defaults only official Anthropic endpoints to portable five-minute caching', () => {
    const resolve = createAnthropicPromptCachePolicyResolver({}, 'native')

    expect(
      resolve({
        baseUrl: 'https://api.anthropic.com/v1',
        model: 'claude-sonnet-4-20250514',
      }),
    ).toEqual({ ttl: '5m' })
    expect(
      resolve({
        baseUrl: 'https://relay.example/v1',
        model: 'claude-sonnet-4-20250514',
      }),
    ).toBe(false)
  })

  it('uses strict Praxis opt-in, opt-out, and supported TTL settings', () => {
    const oneHour = createAnthropicPromptCachePolicyResolver(
      {
        PRAXIS_ANTHROPIC_PROMPT_CACHING: 'true',
        PRAXIS_ANTHROPIC_PROMPT_CACHE_TTL: '1h',
      },
      'native',
    )
    const disabled = createAnthropicPromptCachePolicyResolver(
      { PRAXIS_ANTHROPIC_PROMPT_CACHING: 'false' },
      'native',
    )

    expect(
      oneHour({
        baseUrl: 'https://relay.example/v1',
        model: 'claude-opus-4-20250514',
      }),
    ).toEqual({ ttl: '1h' })
    expect(
      disabled({
        baseUrl: 'https://api.anthropic.com/v1',
        model: 'claude-opus-4-20250514',
      }),
    ).toBe(false)
    expect(() =>
      createAnthropicPromptCachePolicyResolver(
        { PRAXIS_ANTHROPIC_PROMPT_CACHING: 'sometimes' },
        'native',
      ),
    ).toThrow('must be true or false')
    expect(() =>
      createAnthropicPromptCachePolicyResolver(
        { PRAXIS_ANTHROPIC_PROMPT_CACHE_TTL: 'forever' },
        'native',
      ),
    ).toThrow('must be 5m or 1h')
    expect(() =>
      createAnthropicPromptCachePolicyResolver(
        {
          PRAXIS_ANTHROPIC_PROMPT_CACHING: 'false',
          PRAXIS_ANTHROPIC_PROMPT_CACHE_TTL: '1h',
        },
        'native',
      ),
    ).toThrow('cannot be set when prompt caching is false')
  })

  it('honors Claude compatibility disable and TTL variables by model family', () => {
    const disabledSonnet = createAnthropicPromptCachePolicyResolver(
      {
        DISABLE_PROMPT_CACHING_SONNET: '1',
        ENABLE_PROMPT_CACHING_1H: '1',
      },
      'claude',
    )
    const forcedFiveMinutes = createAnthropicPromptCachePolicyResolver(
      {
        ENABLE_PROMPT_CACHING_1H: '1',
        FORCE_PROMPT_CACHING_5M: '1',
      },
      'claude',
    )
    const native = createAnthropicPromptCachePolicyResolver(
      { DISABLE_PROMPT_CACHING: '1' },
      'native',
    )

    expect(
      disabledSonnet({
        baseUrl: 'https://relay.example/v1',
        model: 'claude-sonnet-4-20250514',
      }),
    ).toBe(false)
    expect(
      disabledSonnet({
        baseUrl: 'https://relay.example/v1',
        model: 'claude-opus-4-20250514',
      }),
    ).toEqual({ ttl: '1h' })
    expect(
      forcedFiveMinutes({
        baseUrl: 'https://relay.example/v1',
        model: 'claude-haiku-4-5-20251001',
      }),
    ).toEqual({ ttl: '5m' })
    expect(
      native({
        baseUrl: 'https://api.anthropic.com/v1',
        model: 'claude-sonnet-4-20250514',
      }),
    ).toEqual({ ttl: '5m' })
  })

  it('captures environment decisions for the lifetime of the resolver', () => {
    const environment: NodeJS.ProcessEnv = {
      PRAXIS_ANTHROPIC_PROMPT_CACHING: 'true',
    }
    const resolve = createAnthropicPromptCachePolicyResolver(
      environment,
      'native',
    )
    environment.PRAXIS_ANTHROPIC_PROMPT_CACHING = 'false'

    expect(
      resolve({
        baseUrl: 'https://relay.example/v1',
        model: 'claude-sonnet-4-20250514',
      }),
    ).toEqual({ ttl: '5m' })
  })
})
