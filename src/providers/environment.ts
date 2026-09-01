import { createAnthropicPromptCachePolicyResolver } from './anthropic-prompt-cache.js'
import {
  DEFAULT_PROVIDER_CONNECT_TIMEOUT_MS,
  DEFAULT_PROVIDER_DEADLINE_MS,
  DEFAULT_PROVIDER_IDLE_TIMEOUT_MS,
} from './deadline-provider.js'

export interface ProviderEnvironment {
  provider: 'openai' | 'anthropic'
  baseUrl: string
  deadlineMs: number
  connectTimeoutMs: number
  idleTimeoutMs: number
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
  const rawDeadlineMs = environment.PRAXIS_PROVIDER_DEADLINE_MS
  if (
    rawDeadlineMs !== undefined &&
    (!/^\d+$/.test(rawDeadlineMs) ||
      Number(rawDeadlineMs) <= 0 ||
      !Number.isSafeInteger(Number(rawDeadlineMs)))
  ) {
    throw new Error(
      'PRAXIS_PROVIDER_DEADLINE_MS must be a positive safe integer',
    )
  }
  const deadlineMs =
    rawDeadlineMs === undefined
      ? DEFAULT_PROVIDER_DEADLINE_MS
      : Number(rawDeadlineMs)
  const parseTimeout = (name: string, fallback: number): number => {
    const raw = environment[name]
    if (
      raw !== undefined &&
      (!/^\d+$/.test(raw) ||
        Number(raw) <= 0 ||
        !Number.isSafeInteger(Number(raw)))
    )
      throw new Error(`${name} must be a positive safe integer`)
    return raw === undefined ? fallback : Number(raw)
  }
  const connectTimeoutMs = parseTimeout(
    'PRAXIS_PROVIDER_CONNECT_TIMEOUT_MS',
    DEFAULT_PROVIDER_CONNECT_TIMEOUT_MS,
  )
  const idleTimeoutMs = parseTimeout(
    'PRAXIS_PROVIDER_IDLE_TIMEOUT_MS',
    DEFAULT_PROVIDER_IDLE_TIMEOUT_MS,
  )
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
  for (const name of [
    'PRAXIS_ANTHROPIC_PROMPT_CACHING',
    'PRAXIS_ANTHROPIC_PROMPT_CACHE_TTL',
  ] as const) {
    if (provider === 'openai' && environment[name] !== undefined) {
      throw new Error(`${name} requires PRAXIS_PROVIDER=anthropic`)
    }
  }
  if (provider === 'anthropic') {
    createAnthropicPromptCachePolicyResolver(environment, 'native')
  }
  return {
    provider,
    baseUrl:
      environment.PRAXIS_BASE_URL ??
      (provider === 'anthropic'
        ? 'https://api.anthropic.com/v1'
        : 'https://api.openai.com/v1'),
    deadlineMs,
    connectTimeoutMs,
    idleTimeoutMs,
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
