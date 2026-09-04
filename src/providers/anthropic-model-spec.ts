export const ANTHROPIC_LONG_CONTEXT_BETA = 'context-1m-2025-08-07'

function defaultMaxOutputTokens(wireModel: string): number {
  if (
    /(?:^|[^a-z0-9])claude-(?:opus-4-[678]|opus-5|sonnet-5)(?=$|[-@.:/_])/.test(
      wireModel,
    )
  ) {
    return 64_000
  }
  return wireModel.startsWith('claude-') ? 32_000 : 8192
}

export function resolveAnthropicEffort(
  wireModel: string,
  effort: string | undefined,
): string | undefined {
  if (effort === undefined) return undefined
  if (wireModel === 'claude-sonnet-4-6' || wireModel === 'claude-opus-4-6') {
    return effort === 'xhigh' ? 'high' : effort
  }
  if (/^claude-opus-4-5(?:-|$)/.test(wireModel)) {
    return effort === 'xhigh' || effort === 'max' ? 'high' : effort
  }
  return effort
}

export interface ResolvedAnthropicModelSpec {
  readonly model: string
  readonly wireModel: string
  readonly contextWindowTokens: number
  readonly defaultMaxOutputTokens: number
  readonly betas: readonly string[]
  readonly supportsAdaptiveThinking: boolean
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
    defaultMaxOutputTokens: defaultMaxOutputTokens(wireModel),
    contextWindowTokens:
      explicitContextWindowTokens ?? (longContext ? 1_000_000 : 200_000),
    betas: Object.freeze(longContext ? [ANTHROPIC_LONG_CONTEXT_BETA] : []),
    supportsAdaptiveThinking:
      wireModel === 'claude-sonnet-4-6' || wireModel === 'claude-opus-4-6',
  })
}
