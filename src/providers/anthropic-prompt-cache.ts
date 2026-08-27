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

/** Captures prompt-cache configuration once, then resolves a policy for each
 * Anthropic model adapter created during the same session. */
export function createAnthropicPromptCachePolicyResolver(
  environment: NodeJS.ProcessEnv,
  _dataPlane?: unknown,
): (target: AnthropicPromptCacheTarget) => AnthropicPromptCachePolicy {
  void _dataPlane
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

  return ({ baseUrl }) => {
    if (praxisEnabled === 'false') return false
    if (praxisEnabled === 'true' || praxisTtl !== undefined) {
      return { ttl: praxisTtl ?? '5m' }
    }
    return officialAnthropicEndpoint(baseUrl) ? { ttl: '5m' } : false
  }
}
