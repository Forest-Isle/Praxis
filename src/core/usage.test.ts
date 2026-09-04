import { describe, expect, it } from 'vitest'

import { ModelPricingRegistry, usageCostUsd } from './usage.js'

describe('ModelPricingRegistry', () => {
  it('calculates regular and cache token pricing without treating cache as regular input', () => {
    const registry = new ModelPricingRegistry({
      fixture: {
        inputPerMillionUsd: 10,
        outputPerMillionUsd: 20,
        cacheReadInputPerMillionUsd: 1,
        cacheCreationInputPerMillionUsd: 4,
      },
    })
    const pricing = registry.resolve('fixture')
    if (!pricing) throw new Error('fixture pricing missing')
    expect(
      usageCostUsd(
        {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadInputTokens: 20,
          cacheCreationInputTokens: 10,
        },
        pricing,
      ),
    ).toBeCloseTo(0.00176)
  })

  it('parses explicit environment pricing and rejects invalid values', () => {
    const registry = ModelPricingRegistry.fromEnvironment(
      '{"fixture":{"inputPerMillionUsd":1,"outputPerMillionUsd":2}}',
    )
    expect(registry.resolve('fixture')).toEqual({
      inputPerMillionUsd: 1,
      outputPerMillionUsd: 2,
    })
    expect(() =>
      ModelPricingRegistry.fromEnvironment(
        '{"fixture":{"inputPerMillionUsd":-1}}',
      ),
    ).toThrow('non-negative')
  })

  it('returns no pricing for unknown models', () => {
    const registry = new ModelPricingRegistry()
    expect(registry.resolve('fixture-unknown')).toBeUndefined()
    for (const model of [
      'claude-sonnet-5[1m][1m]',
      'claude-sonnet-5[1m]-suffix',
      'anthropic/claude-sonnet-5',
      'Claude-sonnet-5',
      '[1m]',
    ]) {
      expect(registry.resolve(model)).toBeUndefined()
      expect(registry.diagnose(model)).toMatchObject({
        source: 'unknown',
        policy: 'fail-closed',
        budgetBehavior: 'reject-before-provider',
      })
    }
    expect(registry.diagnose('fixture-unknown')).toEqual({
      model: 'fixture-unknown',
      source: 'unknown',
      policy: 'fail-closed',
      budgetBehavior: 'reject-before-provider',
    })
  })

  it('identifies builtin and environment pricing sources', () => {
    const registry = new ModelPricingRegistry({
      'private-model': { inputPerMillionUsd: 1, outputPerMillionUsd: 2 },
    })
    expect(registry.diagnose('gpt-4o').source).toBe('builtin')
    expect(registry.diagnose('private-model')).toMatchObject({
      source: 'environment',
      budgetBehavior: 'enforce',
      policy: 'fail-closed',
    })

    const expectedPricing = {
      'claude-fable-5-1': [10, 50, 0.25, 12.5],
      'claude-opus-5': [5, 25, 0.5, 6.25],
      'claude-opus-4-8': [5, 25, 0.5, 6.25],
      'claude-opus-4-7': [5, 25, 0.5, 6.25],
      'claude-opus-4-6': [5, 25, 0.5, 6.25],
      'claude-opus-4-5': [5, 25, 0.5, 6.25],
      'claude-opus-4-5-20251101': [5, 25, 0.5, 6.25],
      'claude-sonnet-5': [2, 10, 0.2, 2.5],
      'claude-sonnet-4-6': [3, 15, 0.3, 3.75],
      'claude-sonnet-4-5': [3, 15, 0.3, 3.75],
      'claude-sonnet-4-5-20250929': [3, 15, 0.3, 3.75],
      'claude-haiku-4-5': [1, 5, 0.1, 1.25],
      'claude-haiku-4-5-20251001': [1, 5, 0.1, 1.25],
      'claude-opus-4': [15, 75, 1.5, 18.75],
      'claude-opus-4-1': [15, 75, 1.5, 18.75],
      'claude-opus-4-1-20250805': [15, 75, 1.5, 18.75],
      'claude-sonnet-4': [3, 15, 0.3, 3.75],
      'claude-3-5-sonnet-20240620': [3, 15, 0.3, 3.75],
      'claude-3-5-sonnet-latest': [3, 15, 0.3, 3.75],
      'claude-3-5-haiku-20241022': [0.8, 4, 0.08, 1],
      'claude-3-5-haiku-latest': [0.8, 4, 0.08, 1],
    } as const
    for (const [
      model,
      [input, output, cacheRead, cacheCreation],
    ] of Object.entries(expectedPricing)) {
      expect(registry.resolve(model)).toEqual({
        inputPerMillionUsd: input,
        outputPerMillionUsd: output,
        cacheReadInputPerMillionUsd: cacheRead,
        cacheCreationInputPerMillionUsd: cacheCreation,
      })
    }
    expect(registry.resolve('claude-sonnet-5[1m]')).toEqual(
      registry.resolve('claude-sonnet-5'),
    )
    expect(registry.resolve('claude-opus-5')).not.toBe(
      registry.resolve('claude-opus-4-8'),
    )

    const baseEnvironment = new ModelPricingRegistry({
      'claude-sonnet-5': { inputPerMillionUsd: 7, outputPerMillionUsd: 8 },
    })
    expect(baseEnvironment.diagnose('claude-sonnet-5[1m]')).toMatchObject({
      source: 'environment',
      pricing: { inputPerMillionUsd: 7, outputPerMillionUsd: 8 },
    })

    const exactEnvironment = new ModelPricingRegistry({
      'claude-sonnet-5': { inputPerMillionUsd: 7, outputPerMillionUsd: 8 },
      'claude-sonnet-5[1m]': { inputPerMillionUsd: 9, outputPerMillionUsd: 10 },
    })
    expect(exactEnvironment.resolve('claude-sonnet-5[1m]')).toEqual({
      inputPerMillionUsd: 9,
      outputPerMillionUsd: 10,
    })
    expect(exactEnvironment.diagnose('claude-sonnet-5[1m]').source).toBe(
      'environment',
    )
  })
})
