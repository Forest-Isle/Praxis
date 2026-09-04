import { describe, expect, it } from 'vitest'

import {
  anthropicModelAliasOverridesFromEnvironment,
  resolveAnthropicModelAlias,
} from './anthropic-model-alias.js'

describe('Anthropic model aliases', () => {
  it('resolves the built-in family aliases', () => {
    expect(resolveAnthropicModelAlias('sonnet')).toBe('claude-sonnet-5')
    expect(resolveAnthropicModelAlias('opus')).toBe('claude-opus-5')
    expect(resolveAnthropicModelAlias('haiku')).toBe(
      'claude-haiku-4-5-20251001',
    )
    expect(resolveAnthropicModelAlias('sonnet[1m]')).toBe('claude-sonnet-5[1m]')
    expect(resolveAnthropicModelAlias('opus[1m]')).toBe('claude-opus-5[1m]')
  })

  it('uses nonblank environment overrides and ignores empty ones', () => {
    const overrides = anthropicModelAliasOverridesFromEnvironment({
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'custom-sonnet',
      ANTHROPIC_DEFAULT_OPUS_MODEL: '  ',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'custom-haiku[1m]',
    })
    expect(resolveAnthropicModelAlias('sonnet', overrides)).toBe(
      'custom-sonnet',
    )
    expect(resolveAnthropicModelAlias('sonnet[1m]', overrides)).toBe(
      'custom-sonnet[1m]',
    )
    expect(resolveAnthropicModelAlias('opus', overrides)).toBe('claude-opus-5')
    expect(resolveAnthropicModelAlias('haiku', overrides)).toBe(
      'custom-haiku[1m]',
    )
    expect(resolveAnthropicModelAlias('haiku[1m]', overrides)).toBe('haiku[1m]')
  })

  it('does not duplicate a long-context suffix', () => {
    const overrides = { sonnet: 'custom[1m]', opus: 'custom-opus' }
    expect(resolveAnthropicModelAlias('sonnet', overrides)).toBe('custom[1m]')
    expect(resolveAnthropicModelAlias('sonnet[1m]', overrides)).toBe(
      'custom[1m]',
    )
    expect(resolveAnthropicModelAlias('opus[1m]', overrides)).toBe(
      'custom-opus[1m]',
    )
  })

  it('passes through non-alias model names exactly', () => {
    for (const model of [
      'Sonnet',
      'claude-sonnet-5',
      'provider/sonnet',
      'sonnet[1m][1m]',
      'haiku[1m]',
      'default',
      'best',
      'opusplan',
    ]) {
      expect(resolveAnthropicModelAlias(model)).toBe(model)
    }
  })

  it('rejects oversized nonblank overrides', () => {
    expect(() =>
      anthropicModelAliasOverridesFromEnvironment({
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'x'.repeat(257),
      }),
    ).toThrow('ANTHROPIC_DEFAULT_OPUS_MODEL')
  })
})
