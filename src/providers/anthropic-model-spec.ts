export const ANTHROPIC_LONG_CONTEXT_BETA = 'context-1m-2025-08-07'

export interface ResolvedAnthropicModelSpec {
  readonly model: string
  readonly wireModel: string
  readonly contextWindowTokens: number
  readonly betas: readonly string[]
}

export function resolveAnthropicModelSpec(
  model: string,
  explicitContextWindowTokens?: number,
): ResolvedAnthropicModelSpec {
  const longContext = model.endsWith('[1m]')
  const wireModel = longContext ? model.slice(0, -'[1m]'.length) : model
  if (longContext && wireModel.trim().length === 0) {
    throw new Error('Anthropic [1m] model spec must include a base model name')
  }
  return Object.freeze({
    model,
    wireModel,
    contextWindowTokens:
      explicitContextWindowTokens ?? (longContext ? 1_000_000 : 200_000),
    betas: Object.freeze(longContext ? [ANTHROPIC_LONG_CONTEXT_BETA] : []),
  })
}
