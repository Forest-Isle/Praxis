export interface ProviderEnvironment {
  provider: 'openai' | 'anthropic'
  baseUrl: string
  maxOutputTokens?: number
  anthropicVersion?: string
  webSearch?: boolean
}

export interface ContextEnvironment {
  contextWindowTokens?: number
  contextReserveTokens?: number
}

export function parseProviderEnvironment(
  environment: NodeJS.ProcessEnv,
): ProviderEnvironment {
  const provider = environment.PRAXIS_PROVIDER ?? 'openai'
  if (provider !== 'openai' && provider !== 'anthropic') {
    throw new Error('PRAXIS_PROVIDER must be openai or anthropic')
  }
  const maxOutputTokens = environment.PRAXIS_MAX_OUTPUT_TOKENS
  if (
    maxOutputTokens !== undefined &&
    (!/^\d+$/.test(maxOutputTokens) ||
      Number(maxOutputTokens) <= 0 ||
      !Number.isSafeInteger(Number(maxOutputTokens)))
  ) {
    throw new Error('PRAXIS_MAX_OUTPUT_TOKENS must be a positive integer')
  }
  if (provider === 'openai' && maxOutputTokens !== undefined) {
    throw new Error(
      'PRAXIS_MAX_OUTPUT_TOKENS requires PRAXIS_PROVIDER=anthropic',
    )
  }
  const anthropicVersion = environment.PRAXIS_ANTHROPIC_VERSION
  if (provider === 'openai' && anthropicVersion !== undefined) {
    throw new Error(
      'PRAXIS_ANTHROPIC_VERSION requires PRAXIS_PROVIDER=anthropic',
    )
  }
  if (anthropicVersion !== undefined && anthropicVersion.trim().length === 0) {
    throw new Error('PRAXIS_ANTHROPIC_VERSION must not be empty')
  }
  const webSearch = environment.PRAXIS_ANTHROPIC_WEB_SEARCH
  if (
    webSearch !== undefined &&
    webSearch !== 'true' &&
    webSearch !== 'false'
  ) {
    throw new Error('PRAXIS_ANTHROPIC_WEB_SEARCH must be true or false')
  }
  if (provider === 'openai' && webSearch !== undefined) {
    throw new Error(
      'PRAXIS_ANTHROPIC_WEB_SEARCH requires PRAXIS_PROVIDER=anthropic',
    )
  }
  return {
    provider,
    baseUrl:
      environment.PRAXIS_BASE_URL ??
      (provider === 'anthropic'
        ? 'https://api.anthropic.com/v1'
        : 'https://api.openai.com/v1'),
    ...(maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: Number(maxOutputTokens) }),
    ...(anthropicVersion === undefined ? {} : { anthropicVersion }),
    ...(webSearch === undefined ? {} : { webSearch: webSearch === 'true' }),
  }
}

export function parseContextEnvironment(
  environment: NodeJS.ProcessEnv,
): ContextEnvironment {
  const parse = (name: string): number | undefined => {
    const raw = environment[name]
    if (raw === undefined) return undefined
    if (
      !/^\d+$/.test(raw) ||
      Number(raw) <= 0 ||
      !Number.isSafeInteger(Number(raw))
    ) {
      throw new Error(`${name} must be a positive integer`)
    }
    return Number(raw)
  }
  const contextWindowTokens = parse('PRAXIS_CONTEXT_WINDOW_TOKENS')
  const contextReserveTokens = parse('PRAXIS_CONTEXT_RESERVE_TOKENS')
  if (contextReserveTokens !== undefined && contextWindowTokens === undefined) {
    throw new Error(
      'PRAXIS_CONTEXT_RESERVE_TOKENS requires PRAXIS_CONTEXT_WINDOW_TOKENS',
    )
  }
  return {
    ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
    ...(contextReserveTokens === undefined ? {} : { contextReserveTokens }),
  }
}
