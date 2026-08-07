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
  })
})
