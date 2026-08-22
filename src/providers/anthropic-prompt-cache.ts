export type AnthropicPromptCachePolicy = false | { ttl: '5m' | '1h' }

export interface AnthropicPromptCacheTarget {
  baseUrl: string
  model: string
}

function officialAnthropicEndpoint(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname === 'api.anthropic.com'
  } catch {
    return false
  }
}

function modelFamily(model: string): 'haiku' | 'sonnet' | 'opus' | undefined {
  const normalized = model.toLowerCase()
  if (normalized.includes('haiku')) return 'haiku'
  if (normalized.includes('sonnet')) return 'sonnet'
  if (normalized.includes('opus')) return 'opus'
  return undefined
}

/** Captures prompt-cache configuration once, then resolves a policy for each
 * Anthropic model adapter created during the same session. */
export function createAnthropicPromptCachePolicyResolver(
  environment: NodeJS.ProcessEnv,
  dataPlane: 'native' | 'claude',
): (target: AnthropicPromptCacheTarget) => AnthropicPromptCachePolicy {
  const praxisEnabled = environment.PRAXIS_ANTHROPIC_PROMPT_CACHING
  if (
    praxisEnabled !== undefined &&
    praxisEnabled !== 'true' &&
    praxisEnabled !== 'false'
  ) {
    throw new Error('PRAXIS_ANTHROPIC_PROMPT_CACHING must be true or false')
  }
  const praxisTtl = environment.PRAXIS_ANTHROPIC_PROMPT_CACHE_TTL
  if (praxisTtl !== undefined && praxisTtl !== '5m' && praxisTtl !== '1h') {
    throw new Error('PRAXIS_ANTHROPIC_PROMPT_CACHE_TTL must be 5m or 1h')
  }
  if (praxisEnabled === 'false' && praxisTtl !== undefined) {
    throw new Error(
      'PRAXIS_ANTHROPIC_PROMPT_CACHE_TTL cannot be set when prompt caching is false',
    )
  }

  const claudeCompatibility = dataPlane === 'claude'
  const disableAll = environment.DISABLE_PROMPT_CACHING === '1'
  const disabledFamilies = new Set(
    (['haiku', 'sonnet', 'opus'] as const).filter(
      (family) =>
        environment[`DISABLE_PROMPT_CACHING_${family.toUpperCase()}`] === '1',
    ),
  )
  const forceFiveMinutes = environment.FORCE_PROMPT_CACHING_5M === '1'
  const enableOneHour = environment.ENABLE_PROMPT_CACHING_1H === '1'

  return ({ baseUrl, model }) => {
    if (claudeCompatibility) {
      const family = modelFamily(model)
      if (disableAll || (family && disabledFamilies.has(family))) return false
    }
    if (praxisEnabled === 'false') return false
    if (claudeCompatibility && forceFiveMinutes) return { ttl: '5m' }
    if (claudeCompatibility && enableOneHour) return { ttl: '1h' }
    if (praxisEnabled === 'true' || praxisTtl !== undefined) {
      return { ttl: praxisTtl ?? '5m' }
    }
    return officialAnthropicEndpoint(baseUrl) ? { ttl: '5m' } : false
  }
}
