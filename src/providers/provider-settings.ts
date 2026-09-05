import { readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'

export type ProviderProtocol =
  | 'openai-compatible'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'codex-subscription'

export type CredentialSource =
  | { source: 'env'; name: string }
  | { source: 'command'; command: readonly [string, ...string[]] }
  | { source: 'vault'; profile?: string }

export interface ProviderTarget {
  providerId: string
  profileId: string
  modelId: string
  protocol: ProviderProtocol
  baseUrl: string
  credential: CredentialSource
  billingMode: 'api' | 'subscription'
  experimental: boolean
}

export interface ResolveProviderTargetOptions {
  configRoot: string
  cwd: string
  environment?: Readonly<Record<string, string | undefined>>
  model?: string
  provider?: string
  profile?: string
  includeSettings?: boolean
  includeProjectSettings?: boolean
}

export type ProviderSettingsErrorCode =
  'invalid_settings' | 'model_required' | 'unknown_provider' | 'unknown_profile'

export class ProviderSettingsError extends Error {
  readonly code: ProviderSettingsErrorCode

  constructor(code: ProviderSettingsErrorCode, message: string) {
    super(message)
    this.name = 'ProviderSettingsError'
    this.code = code
  }
}

interface ProfileDefinition {
  baseUrl: string
  credential: CredentialSource
}

interface ProviderDefinition {
  protocol: ProviderProtocol
  profiles: Record<string, ProfileDefinition>
  defaultModel?: string
}

interface Selection {
  provider?: string
  profile?: string
  model?: string
}

const BUILT_INS: Record<string, ProviderDefinition> = {
  openai: {
    protocol: 'openai-compatible',
    profiles: {
      default: {
        baseUrl: 'https://api.openai.com/v1',
        credential: { source: 'env', name: 'OPENAI_API_KEY' },
      },
    },
  },
  'openai-responses': {
    protocol: 'openai-responses',
    profiles: {
      default: {
        baseUrl: 'https://api.openai.com/v1',
        credential: { source: 'env', name: 'OPENAI_API_KEY' },
      },
    },
  },
  anthropic: {
    protocol: 'anthropic-messages',
    defaultModel: 'default',
    profiles: {
      default: {
        baseUrl: 'https://api.anthropic.com/v1',
        credential: { source: 'env', name: 'ANTHROPIC_API_KEY' },
      },
    },
  },
  'openai-codex': {
    protocol: 'codex-subscription',
    profiles: {
      default: {
        baseUrl: 'https://chatgpt.com/backend-api',
        credential: { source: 'vault' },
      },
    },
  },
}

const MAX_ID = 128
const MAX_STRING = 4096

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function rejectUnknownFields(
  value: Record<string, unknown>,
  path: string,
  allowed: readonly string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${path}.${key} is not supported`)
  }
}

function fail(message: string): never {
  throw new ProviderSettingsError(
    'invalid_settings',
    `Invalid provider settings: ${message}`,
  )
}

function stringField(value: unknown, field: string, max = MAX_STRING): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > max
  ) {
    fail(`${field} must be a non-empty string of at most ${max} characters`)
  }
  return value
}

function identifier(value: unknown, field: string): string {
  const result = stringField(value, field, MAX_ID)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(result)) {
    fail(`${field} must contain only letters, numbers, '.', '_' or '-'`)
  }
  return result
}

function url(value: unknown, field: string): string {
  const result = stringField(value, field, 2048)
  if (result !== result.trim())
    fail(`${field} must not have surrounding whitespace`)
  let parsed: URL
  try {
    parsed = new URL(result)
  } catch {
    fail(`${field} must be an http or https URL`)
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username ||
    parsed.password
  ) {
    fail(`${field} must be an http or https URL without credentials`)
  }
  return result
}

function credential(value: unknown, field: string): CredentialSource {
  if (!isRecord(value) || typeof value.source !== 'string')
    fail(`${field} is malformed`)
  if (value.source === 'env') {
    rejectUnknownFields(value, field, ['source', 'name'])
    const name = stringField(value.name, `${field}.name`, 128)
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name))
      fail(`${field}.name is not a valid environment variable`)
    return { source: 'env', name }
  }
  if (value.source === 'command') {
    rejectUnknownFields(value, field, ['source', 'command'])
    if (
      !Array.isArray(value.command) ||
      value.command.length === 0 ||
      value.command.length > 64 ||
      value.command.some(
        (item) =>
          typeof item !== 'string' || item.length === 0 || item.length > 1024,
      )
    ) {
      fail(`${field}.command must be a non-empty argv array`)
    }
    return {
      source: 'command',
      command: value.command as [string, ...string[]],
    }
  }
  if (value.source === 'vault') {
    rejectUnknownFields(value, field, ['source', 'profile'])
    if (value.profile !== undefined)
      return {
        source: 'vault',
        profile: identifier(value.profile, `${field}.profile`),
      }
    return { source: 'vault' }
  }
  fail(`${field}.source is unsupported`)
}

function scanForPlaintextSecrets(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      scanForPlaintextSecrets(item, `${path}[${index}]`),
    )
    return
  }
  if (!isRecord(value)) return
  for (const [key, child] of Object.entries(value)) {
    if (key === 'apiKey' || key === 'accessToken' || key === 'refreshToken')
      fail(`plaintext secret field ${path}.${key} is not allowed`)
    scanForPlaintextSecrets(child, `${path}.${key}`)
  }
}

function parseProfile(value: unknown, path: string): ProfileDefinition {
  if (!isRecord(value)) fail(`${path} must be an object`)
  rejectUnknownFields(value, path, ['baseUrl', 'credential'])
  return {
    baseUrl: url(value.baseUrl, `${path}.baseUrl`),
    credential: credential(value.credential, `${path}.credential`),
  }
}

function parseProvider(value: unknown, providerId: string): ProviderDefinition {
  if (!isRecord(value)) fail(`providers.${providerId} must be an object`)
  rejectUnknownFields(value, `providers.${providerId}`, [
    'protocol',
    'profiles',
  ])
  const protocol = value.protocol
  if (
    protocol !== 'openai-compatible' &&
    protocol !== 'openai-responses' &&
    protocol !== 'anthropic-messages'
  ) {
    fail(
      `providers.${providerId}.protocol must be openai-compatible, openai-responses, or anthropic-messages`,
    )
  }
  if (!isRecord(value.profiles) || Object.keys(value.profiles).length === 0)
    fail(`providers.${providerId}.profiles must be a non-empty object`)
  const profiles: Record<string, ProfileDefinition> = {}
  for (const [profileId, profile] of Object.entries(value.profiles)) {
    identifier(profileId, `providers.${providerId}.profiles key`)
    profiles[profileId] = parseProfile(
      profile,
      `providers.${providerId}.profiles.${profileId}`,
    )
  }
  return { protocol, profiles }
}

function parseProviders(value: unknown): Record<string, ProviderDefinition> {
  if (value === undefined) return {}
  if (!isRecord(value)) fail('providers must be an object')
  const result: Record<string, ProviderDefinition> = {}
  for (const [providerId, definition] of Object.entries(value)) {
    identifier(providerId, 'provider ID')
    result[providerId] = parseProvider(definition, providerId)
  }
  return result
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  try {
    const source = await readFile(path, 'utf8')
    let value: unknown
    try {
      value = JSON.parse(source)
    } catch {
      throw new ProviderSettingsError(
        'invalid_settings',
        `Invalid provider settings JSON: ${path}`,
      )
    }
    if (!isRecord(value)) fail(`${path} must contain an object`)
    return value
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
}

function selectionFrom(
  value: Record<string, unknown>,
  path: string,
): Selection {
  const result: Selection = {}
  if (value.provider !== undefined)
    result.provider = identifier(value.provider, `${path}.provider`)
  if (value.providerProfile !== undefined)
    result.profile = identifier(
      value.providerProfile,
      `${path}.providerProfile`,
    )
  if (value.model !== undefined)
    result.model = stringField(value.model, `${path}.model`, 256)
  return result
}

function mergeSelection(...values: Selection[]): Selection {
  return values.reduce((result, value) => ({ ...result, ...value }), {})
}

function validateExperimental(value: unknown): boolean {
  if (value === undefined) return false
  if (
    !isRecord(value) ||
    (value.codexSubscription !== undefined &&
      typeof value.codexSubscription !== 'boolean')
  )
    fail('experimental.codexSubscription must be a boolean')
  return value.codexSubscription === true
}

function ensureSelectionPart(value: string, field: string): string {
  return identifier(value, field)
}

export async function resolveProviderTarget(
  options: ResolveProviderTargetOptions,
): Promise<ProviderTarget> {
  const environment = options.environment ?? process.env
  const configRoot = resolve(options.configRoot)
  const cwd = resolve(options.cwd)
  const includeSettings = options.includeSettings !== false
  const user = includeSettings
    ? await readJson(join(configRoot, 'settings.json'))
    : {}
  const includeProjectSettings =
    includeSettings && options.includeProjectSettings === true
  const project = includeProjectSettings
    ? await readJson(join(cwd, '.praxis', 'settings.json'))
    : {}
  const local = includeProjectSettings
    ? await readJson(join(cwd, '.praxis', 'settings.local.json'))
    : {}
  scanForPlaintextSecrets(user.providers, 'providers')
  const userProviders = parseProviders(user.providers)
  const codexEnabled = validateExperimental(user.experimental)
  const explicit: Selection = {
    ...(options.provider === undefined
      ? {}
      : {
          provider: ensureSelectionPart(options.provider, 'explicit provider'),
        }),
    ...(options.profile === undefined
      ? {}
      : {
          profile: ensureSelectionPart(
            options.profile,
            'explicit provider profile',
          ),
        }),
    ...(options.model === undefined
      ? {}
      : { model: stringField(options.model, 'explicit model', 256) }),
  }
  const envSelection: Selection = {
    ...(environment.PRAXIS_PROVIDER === undefined
      ? {}
      : {
          provider: identifier(environment.PRAXIS_PROVIDER, 'PRAXIS_PROVIDER'),
        }),
    ...(environment.PRAXIS_PROVIDER_PROFILE === undefined
      ? {}
      : {
          profile: identifier(
            environment.PRAXIS_PROVIDER_PROFILE,
            'PRAXIS_PROVIDER_PROFILE',
          ),
        }),
    ...(environment.PRAXIS_MODEL === undefined
      ? {}
      : { model: stringField(environment.PRAXIS_MODEL, 'PRAXIS_MODEL', 256) }),
  }
  const localSelection = includeProjectSettings
    ? selectionFrom(local, 'local settings')
    : {}
  const projectSelection = includeProjectSettings
    ? selectionFrom(project, 'project settings')
    : {}
  const settingsSelection = selectionFrom(user, 'settings')
  const selected = mergeSelection(
    settingsSelection,
    projectSelection,
    localSelection,
    envSelection,
    explicit,
  )
  const providerId = selected.provider ?? 'openai'
  identifier(providerId, 'provider ID')
  if (providerId === 'openai-codex' && !codexEnabled)
    fail('openai-codex requires experimental.codexSubscription=true')
  if (
    providerId !== 'openai-codex' &&
    selected.profile === undefined &&
    environment.PRAXIS_PROVIDER_PROFILE === undefined
  ) {
    // The default profile is intentionally implicit for built-ins and custom providers.
  }
  const custom = userProviders[providerId]
  if (providerId === 'openai-codex' && custom !== undefined)
    fail('openai-codex cannot be customized')
  if (
    custom !== undefined &&
    (providerId === 'openai' || providerId === 'anthropic') &&
    custom.protocol !== BUILT_INS[providerId]?.protocol
  )
    fail(`built-in provider ${providerId} has an incompatible protocol`)
  if (custom?.protocol === 'codex-subscription')
    fail('custom codex-subscription providers are not allowed')
  const definition = custom ?? BUILT_INS[providerId]
  if (!definition)
    throw new ProviderSettingsError(
      'unknown_provider',
      `Invalid provider settings: unknown provider ${providerId}`,
    )
  const profileId = selected.profile ?? 'default'
  const profile =
    definition.profiles[profileId] ??
    (providerId === 'openai-codex'
      ? {
          baseUrl: BUILT_INS['openai-codex']?.profiles.default?.baseUrl ?? '',
          credential: { source: 'vault' as const, profile: profileId },
        }
      : undefined)
  if (!profile)
    throw new ProviderSettingsError(
      'unknown_profile',
      `Invalid provider settings: unknown profile ${profileId} for provider ${providerId}`,
    )
  const modelId = selected.model ?? definition.defaultModel
  if (!modelId)
    throw new ProviderSettingsError(
      'model_required',
      'Invalid provider settings: model is required',
    )
  const override = environment.PRAXIS_BASE_URL
  if (providerId === 'openai-codex' && override !== undefined)
    fail('PRAXIS_BASE_URL cannot override openai-codex')
  const baseUrl =
    override === undefined ? profile.baseUrl : url(override, 'PRAXIS_BASE_URL')
  if (providerId === 'openai-codex') {
    const codexDefault = BUILT_INS['openai-codex']
    if (profile.baseUrl !== codexDefault?.profiles.default?.baseUrl)
      fail('openai-codex endpoint is fixed')
  }
  const protocol = definition.protocol
  const resolvedCredential =
    providerId === 'openai-codex'
      ? { source: 'vault' as const, profile: profileId }
      : profile.credential
  return {
    providerId,
    profileId,
    modelId,
    protocol,
    baseUrl,
    credential: resolvedCredential,
    billingMode: protocol === 'codex-subscription' ? 'subscription' : 'api',
    experimental: providerId === 'openai-codex',
  }
}
