import type { ModelUsage } from './runtime.js'

export interface ModelPricing {
  inputPerMillionUsd: number
  outputPerMillionUsd: number
  cacheReadInputPerMillionUsd?: number
  cacheCreationInputPerMillionUsd?: number
}

export type ModelPricingTable = Readonly<Record<string, ModelPricing>>

export type ModelPricingSource = 'builtin' | 'environment' | 'unknown'

export interface ModelPricingDiagnosis {
  model: string
  source: ModelPricingSource
  pricing?: ModelPricing
  policy: 'fail-closed'
  budgetBehavior: 'enforce' | 'reject-before-provider'
}

const BUILTIN_PRICING: ModelPricingTable = {
  'claude-3-5-sonnet-20241022': {
    inputPerMillionUsd: 3,
    outputPerMillionUsd: 15,
    cacheReadInputPerMillionUsd: 0.3,
    cacheCreationInputPerMillionUsd: 3.75,
  },
  'claude-3-7-sonnet-20250219': {
    inputPerMillionUsd: 3,
    outputPerMillionUsd: 15,
    cacheReadInputPerMillionUsd: 0.3,
    cacheCreationInputPerMillionUsd: 3.75,
  },
  'claude-sonnet-4-20250514': {
    inputPerMillionUsd: 3,
    outputPerMillionUsd: 15,
    cacheReadInputPerMillionUsd: 0.3,
    cacheCreationInputPerMillionUsd: 3.75,
  },
  'claude-opus-4-20250514': {
    inputPerMillionUsd: 15,
    outputPerMillionUsd: 75,
    cacheReadInputPerMillionUsd: 1.5,
    cacheCreationInputPerMillionUsd: 18.75,
  },
  'gpt-4o': {
    inputPerMillionUsd: 5,
    outputPerMillionUsd: 15,
  },
  'gpt-4o-mini': {
    inputPerMillionUsd: 0.15,
    outputPerMillionUsd: 0.6,
  },
}

function validRate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function parsePricing(value: unknown, label: string): ModelPricing {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  const record = value as Record<string, unknown>
  const input = record.inputPerMillionUsd
  const output = record.outputPerMillionUsd
  if (!validRate(input) || !validRate(output)) {
    throw new Error(
      `${label} requires non-negative inputPerMillionUsd and outputPerMillionUsd`,
    )
  }
  const cacheRead = record.cacheReadInputPerMillionUsd
  const cacheCreation = record.cacheCreationInputPerMillionUsd
  if (cacheRead !== undefined && !validRate(cacheRead)) {
    throw new Error(`${label}.cacheReadInputPerMillionUsd must be non-negative`)
  }
  if (cacheCreation !== undefined && !validRate(cacheCreation)) {
    throw new Error(
      `${label}.cacheCreationInputPerMillionUsd must be non-negative`,
    )
  }
  return {
    inputPerMillionUsd: input,
    outputPerMillionUsd: output,
    ...(cacheRead === undefined
      ? {}
      : { cacheReadInputPerMillionUsd: cacheRead }),
    ...(cacheCreation === undefined
      ? {}
      : { cacheCreationInputPerMillionUsd: cacheCreation }),
  }
}

export class ModelPricingRegistry {
  private readonly table: ModelPricingTable
  private readonly environmentModels: ReadonlySet<string>

  constructor(overrides: ModelPricingTable = {}) {
    this.table = { ...BUILTIN_PRICING, ...overrides }
    this.environmentModels = new Set(Object.keys(overrides))
  }

  resolve(model: string): ModelPricing | undefined {
    return this.table[model]
  }

  diagnose(model: string): ModelPricingDiagnosis {
    const pricing = this.resolve(model)
    if (!pricing) {
      return {
        model,
        source: 'unknown',
        policy: 'fail-closed',
        budgetBehavior: 'reject-before-provider',
      }
    }
    return {
      model,
      source: this.environmentModels.has(model) ? 'environment' : 'builtin',
      pricing,
      policy: 'fail-closed',
      budgetBehavior: 'enforce',
    }
  }

  static fromEnvironment(value: string | undefined): ModelPricingRegistry {
    if (value === undefined || value.trim().length === 0) {
      return new ModelPricingRegistry()
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(value)
    } catch (error) {
      throw new Error('PRAXIS_PRICING_JSON must be valid JSON', {
        cause: error,
      })
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('PRAXIS_PRICING_JSON must be an object keyed by model')
    }
    const overrides: Record<string, ModelPricing> = {}
    for (const [model, pricing] of Object.entries(parsed)) {
      overrides[model] = parsePricing(pricing, `PRAXIS_PRICING_JSON.${model}`)
    }
    return new ModelPricingRegistry(overrides)
  }
}

function regularInputTokens(usage: ModelUsage): number {
  return Math.max(
    0,
    usage.inputTokens -
      (usage.cacheReadInputTokens ?? 0) -
      (usage.cacheCreationInputTokens ?? 0),
  )
}

export function usageCostUsd(usage: ModelUsage, pricing: ModelPricing): number {
  const regularInput = regularInputTokens(usage)
  const input = regularInput * pricing.inputPerMillionUsd
  const output = usage.outputTokens * pricing.outputPerMillionUsd
  const cacheRead =
    (usage.cacheReadInputTokens ?? 0) *
    (pricing.cacheReadInputPerMillionUsd ?? pricing.inputPerMillionUsd)
  const cacheCreation =
    (usage.cacheCreationInputTokens ?? 0) *
    (pricing.cacheCreationInputPerMillionUsd ?? pricing.inputPerMillionUsd)
  return (input + output + cacheRead + cacheCreation) / 1_000_000
}
