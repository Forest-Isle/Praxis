import type { ModelProvider, ModelThinkingConfig } from '../core/runtime.js'
import { AnthropicCompatibleProvider } from './anthropic-compatible.js'
import { OpenAICompatibleProvider } from './openai-compatible.js'
import { OpenAIResponsesProvider } from './openai-responses.js'
import { CodexSubscriptionProvider } from './codex-subscription.js'
import { DeadlineModelProvider } from './deadline-provider.js'
import { NonStreamingFallbackModelProvider } from './non-streaming-fallback-provider.js'
import {
  CodexOAuthCredentialManager,
  type CodexOAuthVault,
} from './codex-oauth.js'
import {
  resolveProviderTarget,
  type ProviderProtocol,
  type ProviderTarget,
} from './provider-settings.js'
import { resolveAnthropicModelSpec } from './anthropic-model-spec.js'
import {
  anthropicModelAliasOverridesFromEnvironment,
  resolveAnthropicModelAliasFamily,
  resolveAnthropicModelAlias,
  type AnthropicModelAliasOverrides,
} from './anthropic-model-alias.js'
import type {
  ProviderCredentialSourceMetadata,
  ProviderCredentialReader,
  ResolvedProviderCredential,
} from './provider-auth.js'
import {
  ProviderAuthenticationError,
  resolveProviderCredential,
} from './provider-auth.js'
import {
  parseContextEnvironment,
  parseProviderEnvironment,
  type ContextEnvironment,
} from './environment.js'
import {
  createAnthropicPromptCachePolicyResolver,
  type AnthropicPromptCachePolicy,
} from './anthropic-prompt-cache.js'

export type ProviderRegistryErrorCode = 'unsupported_provider'

export class ProviderRegistryError extends Error {
  readonly code: ProviderRegistryErrorCode

  constructor(code: ProviderRegistryErrorCode, message: string) {
    super(message)
    this.name = 'ProviderRegistryError'
    this.code = code
  }
}

export interface ProviderRegistryOptions {
  target: ProviderTarget
  credential: ResolvedProviderCredential
  context?: ContextEnvironment
  anthropicThinking?: ModelThinkingConfig
  openAiThinking?: ModelThinkingConfig
  codexThinking?: ModelThinkingConfig
  anthropicPromptCacheResolver?: (target: {
    baseUrl: string
    model: string
  }) => AnthropicPromptCachePolicy
  fetchImplementation?: typeof fetch
  providerEnvironment?: ReturnType<typeof parseProviderEnvironment>
  anthropicModelAliasOverrides?: AnthropicModelAliasOverrides
  vault?: CodexOAuthVault
}

export interface ResolveProviderRegistryOptions {
  configRoot: string
  cwd: string
  environment?: Readonly<Record<string, string | undefined>>
  provider?: string
  profile?: string
  model?: string
  includeSettings?: boolean
  includeProjectSettings?: boolean
  apiKey?: string
  context?: ContextEnvironment
  anthropicThinking?: ModelThinkingConfig
  openAiThinking?: ModelThinkingConfig
  codexThinking?: ModelThinkingConfig
  vault: ProviderCredentialReader & CodexOAuthVault
  fetchImplementation?: typeof fetch
}

export type ProviderRegistrySourceMetadata = ProviderCredentialSourceMetadata

export interface ProviderRegistry {
  readonly target: ProviderTarget
  readonly credentialSource: ProviderRegistrySourceMetadata
  hasExplicitModelAlias(modelId: string): boolean
  create(modelId?: string): ModelProvider
}

export function resolveProviderContextWindowTokens(options: {
  protocol: ProviderProtocol
  modelId: string
  explicitContextWindowTokens?: number
}): number | undefined {
  if (options.protocol === 'anthropic-messages')
    return resolveAnthropicModelSpec(
      options.modelId,
      options.explicitContextWindowTokens,
    ).contextWindowTokens
  if (
    options.protocol === 'openai-compatible' ||
    options.protocol === 'openai-responses'
  )
    return options.explicitContextWindowTokens
  return undefined
}

export async function resolveProviderRegistry(
  options: ResolveProviderRegistryOptions,
): Promise<ProviderRegistry> {
  const environment = options.environment ?? process.env
  const target = await resolveProviderTarget({
    configRoot: options.configRoot,
    cwd: options.cwd,
    environment,
    ...(options.provider === undefined ? {} : { provider: options.provider }),
    ...(options.profile === undefined ? {} : { profile: options.profile }),
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.includeSettings === undefined
      ? {}
      : { includeSettings: options.includeSettings }),
    ...(options.includeProjectSettings === undefined
      ? {}
      : { includeProjectSettings: options.includeProjectSettings }),
  })
  const credential = await resolveProviderCredential({
    target,
    environment,
    vault: options.vault,
    ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
  })
  const context =
    options.context ?? parseContextEnvironment(environment as NodeJS.ProcessEnv)
  const controlsEnvironment = {
    ...environment,
    PRAXIS_PROVIDER:
      target.protocol === 'anthropic-messages' ? 'anthropic' : 'openai',
    PRAXIS_BASE_URL: target.baseUrl,
  } as NodeJS.ProcessEnv
  const providerEnvironment = parseProviderEnvironment(controlsEnvironment)
  const anthropicModelAliasOverrides =
    target.providerId === 'anthropic' &&
    target.protocol === 'anthropic-messages'
      ? anthropicModelAliasOverridesFromEnvironment(environment)
      : undefined
  const promptCacheResolver =
    target.protocol === 'anthropic-messages'
      ? createAnthropicPromptCachePolicyResolver(controlsEnvironment)
      : undefined
  return createProviderRegistry({
    target,
    credential,
    context,
    ...(options.anthropicThinking === undefined
      ? {}
      : { anthropicThinking: options.anthropicThinking }),
    ...(options.openAiThinking === undefined
      ? {}
      : { openAiThinking: options.openAiThinking }),
    ...(options.codexThinking === undefined
      ? {}
      : { codexThinking: options.codexThinking }),
    ...(promptCacheResolver === undefined
      ? {}
      : { anthropicPromptCacheResolver: promptCacheResolver }),
    ...(anthropicModelAliasOverrides === undefined
      ? {}
      : { anthropicModelAliasOverrides }),
    ...(options.fetchImplementation === undefined
      ? {}
      : { fetchImplementation: options.fetchImplementation }),
    providerEnvironment,
    vault: options.vault,
  })
}

export function createProviderRegistry(
  options: ProviderRegistryOptions,
): ProviderRegistry {
  return new NativeProviderRegistry(options)
}

class NativeProviderRegistry implements ProviderRegistry {
  readonly target: ProviderTarget
  readonly credentialSource: ProviderRegistrySourceMetadata
  private readonly codexManager: CodexOAuthCredentialManager | undefined

  constructor(private readonly options: ProviderRegistryOptions) {
    this.target = this.resolveTarget(options.target)
    this.credentialSource = options.credential.source
    if (options.target.protocol === 'codex-subscription') {
      if (options.credential.type !== 'oauth') {
        throw new ProviderAuthenticationError(
          'invalid_credential',
          'Provider authentication failed: Codex subscription requires an OAuth credential',
        )
      }
      if (!options.vault) {
        throw new ProviderAuthenticationError(
          'invalid_credential',
          'Provider authentication failed: Codex subscription requires a credential vault',
        )
      }
      this.codexManager = new CodexOAuthCredentialManager(
        options.vault,
        options.target.profileId,
        options.fetchImplementation === undefined
          ? {}
          : { fetchImplementation: options.fetchImplementation },
      )
    }
  }

  create(modelId = this.target.modelId): ModelProvider {
    const target = this.resolveTarget({ ...this.target, modelId })
    if (target.protocol === 'codex-subscription') {
      if (!this.codexManager)
        throw new ProviderAuthenticationError(
          'invalid_credential',
          'Provider authentication failed: Codex subscription credentials are unavailable',
        )
      return this.withDeadline(
        new CodexSubscriptionProvider({
          model: target.modelId,
          access: this.codexManager.access.bind(this.codexManager),
          ...(this.options.fetchImplementation === undefined
            ? {}
            : { fetchImplementation: this.options.fetchImplementation }),
          ...(this.options.codexThinking === undefined
            ? {}
            : { thinking: this.options.codexThinking }),
        }),
      )
    }
    if (target.protocol === 'openai-compatible') {
      if (this.options.credential.type !== 'api-key') {
        throw new ProviderAuthenticationError(
          'invalid_credential',
          'Provider authentication failed: an API key is required',
        )
      }
      return this.withDeadline(
        new OpenAICompatibleProvider({
          baseUrl: target.baseUrl,
          model: target.modelId,
          apiKey: this.options.credential.secret,
          ...(this.options.context?.contextWindowTokens === undefined
            ? {}
            : {
                contextWindowTokens: this.options.context.contextWindowTokens,
              }),
          ...(this.options.openAiThinking === undefined
            ? {}
            : { thinking: this.options.openAiThinking }),
          ...(this.options.fetchImplementation === undefined
            ? {}
            : { fetchImplementation: this.options.fetchImplementation }),
        }),
      )
    }
    if (target.protocol === 'openai-responses') {
      if (this.options.credential.type !== 'api-key') {
        throw new ProviderAuthenticationError(
          'invalid_credential',
          'Provider authentication failed: an API key is required',
        )
      }
      return this.withDeadline(
        new OpenAIResponsesProvider({
          baseUrl: target.baseUrl,
          model: target.modelId,
          apiKey: this.options.credential.secret,
          ...(this.options.context?.contextWindowTokens === undefined
            ? {}
            : {
                contextWindowTokens: this.options.context.contextWindowTokens,
              }),
          ...(this.options.openAiThinking === undefined
            ? {}
            : { thinking: this.options.openAiThinking }),
          ...(this.options.fetchImplementation === undefined
            ? {}
            : { fetchImplementation: this.options.fetchImplementation }),
        }),
      )
    }
    if (target.protocol === 'anthropic-messages') {
      if (this.options.credential.type !== 'api-key') {
        throw new ProviderAuthenticationError(
          'invalid_credential',
          'Provider authentication failed: an API key is required',
        )
      }
      const anthropicOptions = {
        baseUrl: target.baseUrl,
        model: target.modelId,
        apiKey: this.options.credential.secret,
        ...(this.options.context?.contextWindowTokens === undefined
          ? {}
          : {
              contextWindowTokens: this.options.context.contextWindowTokens,
            }),
        ...(this.options.anthropicThinking === undefined
          ? {}
          : {
              thinking: this.options.anthropicThinking,
            }),
        ...(this.options.anthropicPromptCacheResolver === undefined
          ? {}
          : {
              promptCacheResolver: this.options.anthropicPromptCacheResolver,
            }),
        ...(this.options.providerEnvironment?.maxOutputTokens === undefined
          ? {}
          : {
              maxOutputTokens: this.options.providerEnvironment.maxOutputTokens,
            }),
        ...(this.options.providerEnvironment?.anthropicVersion === undefined
          ? {}
          : {
              anthropicVersion:
                this.options.providerEnvironment.anthropicVersion,
            }),
        ...(this.options.providerEnvironment?.webSearch === undefined
          ? {}
          : { webSearch: this.options.providerEnvironment.webSearch }),
        ...(this.options.fetchImplementation === undefined
          ? {}
          : { fetchImplementation: this.options.fetchImplementation }),
      }
      const streaming = this.withDeadline(
        new AnthropicCompatibleProvider({
          ...anthropicOptions,
          streaming: true,
        }),
      )
      if (
        this.options.providerEnvironment?.disableNonStreamingFallback === true
      )
        return streaming
      const nonStreaming = this.withDeadline(
        new AnthropicCompatibleProvider({
          ...anthropicOptions,
          streaming: false,
        }),
      )
      return new NonStreamingFallbackModelProvider({
        provider: streaming,
        nonStreamingProvider: nonStreaming,
      })
    }
    throw new ProviderRegistryError(
      'unsupported_provider',
      `Unsupported provider protocol: ${target.protocol}`,
    )
  }

  hasExplicitModelAlias(modelId: string): boolean {
    if (
      this.target.providerId !== 'anthropic' ||
      this.target.protocol !== 'anthropic-messages'
    )
      return false
    const family = resolveAnthropicModelAliasFamily(modelId)
    if (family === undefined) return false
    const override = this.options.anthropicModelAliasOverrides?.[family]
    return override !== undefined && override.trim().length > 0
  }

  private resolveTarget(target: ProviderTarget): ProviderTarget {
    if (
      target.providerId !== 'anthropic' ||
      target.protocol !== 'anthropic-messages'
    )
      return target
    return {
      ...target,
      modelId: resolveAnthropicModelAlias(
        target.modelId,
        this.options.anthropicModelAliasOverrides,
      ),
    }
  }

  private withDeadline(provider: ModelProvider): ModelProvider {
    const environment = this.options.providerEnvironment
    return environment === undefined
      ? provider
      : new DeadlineModelProvider({
          provider,
          deadlineMs: environment.deadlineMs,
          connectTimeoutMs: environment.connectTimeoutMs,
          idleTimeoutMs: environment.idleTimeoutMs,
        })
  }
}
