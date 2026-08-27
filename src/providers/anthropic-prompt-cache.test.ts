import { describe, expect, it } from 'vitest'

import { createAnthropicPromptCachePolicyResolver } from './anthropic-prompt-cache.js'

describe('createAnthropicPromptCachePolicyResolver', () => {
  it('defaults only official Anthropic endpoints to portable five-minute caching', () => {
    const resolve = createAnthropicPromptCachePolicyResolver({})

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
    const oneHour = createAnthropicPromptCachePolicyResolver({
      PRAXIS_ANTHROPIC_PROMPT_CACHING: 'true',
      PRAXIS_ANTHROPIC_PROMPT_CACHE_TTL: '1h',
    })
    const disabled = createAnthropicPromptCachePolicyResolver({
      PRAXIS_ANTHROPIC_PROMPT_CACHING: 'false',
    })

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
      createAnthropicPromptCachePolicyResolver({
        PRAXIS_ANTHROPIC_PROMPT_CACHING: 'sometimes',
      }),
    ).toThrow('must be true or false')
    expect(() =>
      createAnthropicPromptCachePolicyResolver({
        PRAXIS_ANTHROPIC_PROMPT_CACHE_TTL: 'forever',
      }),
    ).toThrow('must be 5m or 1h')
    expect(() =>
      createAnthropicPromptCachePolicyResolver({
        PRAXIS_ANTHROPIC_PROMPT_CACHING: 'false',
        PRAXIS_ANTHROPIC_PROMPT_CACHE_TTL: '1h',
      }),
    ).toThrow('cannot be set when prompt caching is false')
  })

  it('ignores legacy Claude prompt-cache variables', () => {
    const legacyDisableSonnet = ['DISABLE', 'PROMPT', 'CACHING', 'SONNET'].join(
      '_',
    )
    const legacyEnableOneHour = ['ENABLE', 'PROMPT', 'CACHING', '1H'].join('_')
    const legacyForceFiveMinutes = ['FORCE', 'PROMPT', 'CACHING', '5M'].join(
      '_',
    )
    const legacy = createAnthropicPromptCachePolicyResolver({
      [legacyDisableSonnet]: '1',
      [legacyEnableOneHour]: '1',
      [legacyForceFiveMinutes]: '1',
    })

    expect(
      legacy({
        baseUrl: 'https://relay.example/v1',
        model: 'claude-sonnet-4-20250514',
      }),
    ).toBe(false)
    expect(
      createAnthropicPromptCachePolicyResolver({
        [['DISABLE', 'PROMPT', 'CACHING'].join('_')]: '1',
        [legacyEnableOneHour]: '1',
        [legacyForceFiveMinutes]: '1',
      })({
        baseUrl: 'https://api.anthropic.com/v1',
        model: 'claude-sonnet-4-20250514',
      }),
    ).toEqual({ ttl: '5m' })
  })

  it('captures environment decisions for the lifetime of the resolver', () => {
    const environment: NodeJS.ProcessEnv = {
      PRAXIS_ANTHROPIC_PROMPT_CACHING: 'true',
    }
    const resolve = createAnthropicPromptCachePolicyResolver(environment)
    environment.PRAXIS_ANTHROPIC_PROMPT_CACHING = 'false'

    expect(
      resolve({
        baseUrl: 'https://relay.example/v1',
        model: 'claude-sonnet-4-20250514',
      }),
    ).toEqual({ ttl: '5m' })
  })
})
