import type { ModelUsage } from './runtime.js'

export interface ModelPricing {
  inputPerMillionUsd: number
  outputPerMillionUsd: number
  cacheReadInputPerMillionUsd?: number
  cacheCreationInputPerMillionUsd?: number
  /** Falls back to cacheCreationInputPerMillionUsd when omitted. */
  cacheCreationInputPerMillionUsd1h?: number
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

function anthropicPricing(
  inputPerMillionUsd: number,
  outputPerMillionUsd: number,
  cacheReadInputPerMillionUsd: number,
  cacheCreationInputPerMillionUsd: number,
): ModelPricing {
  return {
    inputPerMillionUsd,
    outputPerMillionUsd,
    cacheReadInputPerMillionUsd,
    cacheCreationInputPerMillionUsd,
    cacheCreationInputPerMillionUsd1h: inputPerMillionUsd * 2,
  }
}

const BUILTIN_PRICING: ModelPricingTable = {
  'claude-3-5-sonnet-20241022': {
    inputPerMillionUsd: 3,
    outputPerMillionUsd: 15,
    cacheReadInputPerMillionUsd: 0.3,
    cacheCreationInputPerMillionUsd: 3.75,
    cacheCreationInputPerMillionUsd1h: 6,
  },
  'claude-3-7-sonnet-20250219': {
    inputPerMillionUsd: 3,
    outputPerMillionUsd: 15,
    cacheReadInputPerMillionUsd: 0.3,
    cacheCreationInputPerMillionUsd: 3.75,
    cacheCreationInputPerMillionUsd1h: 6,
  },
  'claude-sonnet-4-20250514': {
    inputPerMillionUsd: 3,
    outputPerMillionUsd: 15,
    cacheReadInputPerMillionUsd: 0.3,
    cacheCreationInputPerMillionUsd: 3.75,
    cacheCreationInputPerMillionUsd1h: 6,
  },
  'claude-opus-4-20250514': {
    inputPerMillionUsd: 15,
    outputPerMillionUsd: 75,
    cacheReadInputPerMillionUsd: 1.5,
    cacheCreationInputPerMillionUsd: 18.75,
    cacheCreationInputPerMillionUsd1h: 30,
  },
  'claude-fable-5-1': anthropicPricing(10, 50, 0.25, 12.5),
  'claude-opus-5': anthropicPricing(5, 25, 0.5, 6.25),
  'claude-opus-4-8': anthropicPricing(5, 25, 0.5, 6.25),
  'claude-opus-4-7': anthropicPricing(5, 25, 0.5, 6.25),
  'claude-opus-4-6': anthropicPricing(5, 25, 0.5, 6.25),
  'claude-opus-4-5': anthropicPricing(5, 25, 0.5, 6.25),
  'claude-opus-4-5-20251101': anthropicPricing(5, 25, 0.5, 6.25),
  'claude-sonnet-5': anthropicPricing(2, 10, 0.2, 2.5),
  'claude-sonnet-4-6': anthropicPricing(3, 15, 0.3, 3.75),
  'claude-sonnet-4-5': anthropicPricing(3, 15, 0.3, 3.75),
  'claude-sonnet-4-5-20250929': anthropicPricing(3, 15, 0.3, 3.75),
  'claude-haiku-4-5': anthropicPricing(1, 5, 0.1, 1.25),
  'claude-haiku-4-5-20251001': anthropicPricing(1, 5, 0.1, 1.25),
  'claude-opus-4': anthropicPricing(15, 75, 1.5, 18.75),
  'claude-opus-4-1': anthropicPricing(15, 75, 1.5, 18.75),
  'claude-opus-4-1-20250805': anthropicPricing(15, 75, 1.5, 18.75),
  'claude-sonnet-4': anthropicPricing(3, 15, 0.3, 3.75),
  'claude-3-5-sonnet-20240620': anthropicPricing(3, 15, 0.3, 3.75),
  'claude-3-5-sonnet-latest': anthropicPricing(3, 15, 0.3, 3.75),
  'claude-3-5-haiku-20241022': anthropicPricing(0.8, 4, 0.08, 1),
  'claude-3-5-haiku-latest': anthropicPricing(0.8, 4, 0.08, 1),
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
  const cacheCreation1h = record.cacheCreationInputPerMillionUsd1h
  if (cacheRead !== undefined && !validRate(cacheRead)) {
    throw new Error(`${label}.cacheReadInputPerMillionUsd must be non-negative`)
  }
  if (cacheCreation !== undefined && !validRate(cacheCreation)) {
    throw new Error(
      `${label}.cacheCreationInputPerMillionUsd must be non-negative`,
    )
  }
  if (cacheCreation1h !== undefined && !validRate(cacheCreation1h)) {
    throw new Error(
      `${label}.cacheCreationInputPerMillionUsd1h must be non-negative`,
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
    ...(cacheCreation1h === undefined
      ? {}
      : { cacheCreationInputPerMillionUsd1h: cacheCreation1h }),
  }
}

export class ModelPricingRegistry {
  private readonly table: ModelPricingTable
  private readonly environmentModels: ReadonlySet<string>

  constructor(overrides: ModelPricingTable = {}) {
    this.table = { ...BUILTIN_PRICING, ...overrides }
    this.environmentModels = new Set(Object.keys(overrides))
  }

  private resolveKey(model: string): string | undefined {
    if (Object.prototype.hasOwnProperty.call(this.table, model)) {
      return model
    }
    const suffix = '[1m]'
    if (!model.endsWith(suffix)) return undefined
    const base = model.slice(0, -suffix.length)
    if (base.length === 0 || base.endsWith(suffix)) return undefined
    return Object.prototype.hasOwnProperty.call(this.table, base)
      ? base
      : undefined
  }

  resolve(model: string): ModelPricing | undefined {
    const key = this.resolveKey(model)
    return key === undefined ? undefined : this.table[key]
  }

  diagnose(model: string): ModelPricingDiagnosis {
    const key = this.resolveKey(model)
    if (key === undefined) {
      return {
        model,
        source: 'unknown',
        policy: 'fail-closed',
        budgetBehavior: 'reject-before-provider',
      }
    }
    const pricing = this.table[key]
    if (pricing === undefined) {
      return {
        model,
        source: 'unknown',
        policy: 'fail-closed',
        budgetBehavior: 'reject-before-provider',
      }
    }
    return {
      model,
      source: this.environmentModels.has(key) ? 'environment' : 'builtin',
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

export function cacheCreationInputTokenSplit(usage: ModelUsage): {
  total: number
  fiveMinute: number
  oneHour: number
} {
  const total = usage.cacheCreationInputTokens ?? 0
  const oneHour = usage.cacheCreationInputTokens1h ?? 0
  if (
    !Number.isSafeInteger(total) ||
    total < 0 ||
    !Number.isSafeInteger(oneHour) ||
    oneHour < 0 ||
    oneHour > total
  ) {
    throw new Error(
      'cacheCreationInputTokens1h must be a nonnegative safe integer no greater than cacheCreationInputTokens',
    )
  }
  return { total, fiveMinute: total - oneHour, oneHour }
}

function regularInputTokens(usage: ModelUsage): number {
  const { total } = cacheCreationInputTokenSplit(usage)
  return Math.max(
    0,
    usage.inputTokens - (usage.cacheReadInputTokens ?? 0) - total,
  )
}

export function usageCostUsd(usage: ModelUsage, pricing: ModelPricing): number {
  const cacheCreation = cacheCreationInputTokenSplit(usage)
  const regularInput = regularInputTokens(usage)
  const input = regularInput * pricing.inputPerMillionUsd
  const output = usage.outputTokens * pricing.outputPerMillionUsd
  const cacheRead =
    (usage.cacheReadInputTokens ?? 0) *
    (pricing.cacheReadInputPerMillionUsd ?? pricing.inputPerMillionUsd)
  const cacheCreationCost =
    cacheCreation.fiveMinute *
      (pricing.cacheCreationInputPerMillionUsd ?? pricing.inputPerMillionUsd) +
    cacheCreation.oneHour *
      (pricing.cacheCreationInputPerMillionUsd1h ??
        pricing.cacheCreationInputPerMillionUsd ??
        pricing.inputPerMillionUsd)
  return (input + output + cacheRead + cacheCreationCost) / 1_000_000
}
