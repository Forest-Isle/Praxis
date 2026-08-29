import {
  ProviderCredentialVault,
  type ProviderCredentialKey,
  type ProviderCredentialMetadata,
  type ProviderCredentialInput,
  type ProviderCredentialRecord,
  type ProviderCredentialVaultOptions,
} from '../persistence/provider-credential-vault.js'
import {
  deviceLoginWithCodexOAuth,
  loginWithCodexOAuth,
  type CodexOAuthVault,
} from '../providers/codex-oauth.js'
import { resolveProviderTarget } from '../providers/provider-settings.js'
import { resolveDataPlaneRoot } from '../persistence/data-plane.js'

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const MAX_SECRET_BYTES = 64 * 1024

export interface ProviderAuthCommandIO {
  stdout(message: string): void
  stderr?(message: string): void
  readSecret?(prompt: string, signal?: AbortSignal): Promise<string>
}

export interface ProviderAuthVault {
  read(
    key: ProviderCredentialKey,
  ): Promise<ProviderCredentialRecord | undefined>
  list(): Promise<ProviderCredentialMetadata[]>
  modify(
    key: ProviderCredentialKey,
    callback: (
      current: ProviderCredentialRecord | undefined,
    ) =>
      | ProviderCredentialInput
      | undefined
      | Promise<ProviderCredentialInput | undefined>,
  ): Promise<ProviderCredentialRecord | undefined>
  delete(key: ProviderCredentialKey): Promise<void>
}

export interface ProviderAuthCommandOptions {
  io: ProviderAuthCommandIO
  vault?: ProviderAuthVault
  configRoot?: string
  cwd?: string
  environment?: Readonly<Record<string, string | undefined>>
  signal?: AbortSignal
  profile?: string
  providerProfile?: string
  noBrowser?: boolean
  json?: boolean
  device?: boolean
  loginWithCodexOAuth?: typeof loginWithCodexOAuth
  deviceLoginWithCodexOAuth?: typeof deviceLoginWithCodexOAuth
  assertCodexLoginEnabled?: (profileId: string) => Promise<void>
}

interface ParsedAuthArgs {
  action: 'status' | 'set-key' | 'login' | 'logout'
  provider?: string
  profile?: string
  json: boolean
  device: boolean
  noBrowser: boolean
}

function fail(message: string): never {
  throw new Error(message)
}

function identifier(value: string, label: string): string {
  if (!IDENTIFIER.test(value))
    fail(`${label} must match [A-Za-z0-9][A-Za-z0-9._-]{0,127}`)
  return value
}

function parse(
  args: readonly string[],
  options: ProviderAuthCommandOptions,
): ParsedAuthArgs {
  if (args[0] === 'auth') args = args.slice(1)
  const action = args[0]
  if (
    action !== 'status' &&
    action !== 'set-key' &&
    action !== 'login' &&
    action !== 'logout'
  ) {
    fail('auth requires status, set-key, login, or logout')
  }
  let provider: string | undefined
  let profile: string | undefined
  let json = options.json ?? false
  let noBrowser = options.noBrowser ?? false
  let device = options.device ?? false
  for (let index = 1; index < args.length; index += 1) {
    const value = args[index]
    if (value === '--json') {
      if (json) fail('--json may only be specified once')
      json = true
      continue
    }
    if (value === '--device') {
      if (device) fail('--device may only be specified once')
      device = true
      continue
    }
    if (value === '--no-browser') {
      if (noBrowser) fail('--no-browser may only be specified once')
      noBrowser = true
      continue
    }
    if (value === '--profile' || value?.startsWith('--profile=')) {
      if (profile !== undefined) fail('--profile may only be specified once')
      const selected =
        value === '--profile' ? args[++index] : value.slice('--profile='.length)
      if (typeof selected !== 'string' || selected.length === 0)
        fail('--profile requires a value')
      profile = identifier(selected, 'profile')
      continue
    }
    if (value?.startsWith('-')) fail(`Unknown option: ${value}`)
    if (typeof value !== 'string') fail(`Unexpected operand for auth ${action}`)
    if (provider !== undefined)
      fail(`Unexpected operand for auth ${action}: ${value}`)
    provider = identifier(value, 'provider')
  }
  if (
    options.profile !== undefined &&
    profile !== undefined &&
    options.profile !== profile
  )
    fail('auth --profile conflicts with the selected profile')
  if (
    options.providerProfile !== undefined &&
    profile !== undefined &&
    options.providerProfile !== profile
  )
    fail('auth --profile conflicts with --provider-profile')
  if (
    options.profile !== undefined &&
    options.providerProfile !== undefined &&
    options.profile !== options.providerProfile
  )
    fail('auth --profile conflicts with --provider-profile')
  const selectedProfile = profile ?? options.profile ?? options.providerProfile
  profile =
    action === 'status' && selectedProfile === undefined
      ? undefined
      : identifier(selectedProfile ?? 'default', 'profile')
  if (action === 'status' && provider === undefined) {
    // status accepts zero or one provider operand.
  } else if (action !== 'status' && provider === undefined) {
    fail(`auth ${action} requires a provider`)
  }
  if (action === 'set-key' && provider === 'openai-codex')
    fail('auth set-key does not support openai-codex; use auth login')
  if (action === 'login' && provider !== 'openai-codex')
    fail('auth login only supports openai-codex')
  if (action !== 'login' && (device || noBrowser))
    fail('--device and --no-browser are only valid with auth login')
  return {
    action,
    ...(provider === undefined ? {} : { provider }),
    ...(profile === undefined ? {} : { profile }),
    json,
    device,
    noBrowser,
  }
}

function defaultVault(options: ProviderAuthCommandOptions): ProviderAuthVault {
  const environment = options.environment ?? process.env
  const vaultOptions: ProviderCredentialVaultOptions = {
    configRoot: options.configRoot ?? resolveDataPlaneRoot({ environment }),
    environment,
  }
  return new ProviderCredentialVault(vaultOptions)
}

async function assertCodexLoginEnabled(
  options: ProviderAuthCommandOptions,
  profileId: string,
): Promise<void> {
  const environment = options.environment ?? process.env
  await resolveProviderTarget({
    configRoot: options.configRoot ?? resolveDataPlaneRoot({ environment }),
    cwd: options.cwd ?? process.cwd(),
    environment,
    provider: 'openai-codex',
    profile: profileId,
    model: 'codex-authentication',
  })
}

function json(io: ProviderAuthCommandIO, value: unknown): void {
  io.stdout(`${JSON.stringify(value)}\n`)
}

function text(io: ProviderAuthCommandIO, message: string): void {
  io.stdout(`${message}\n`)
}

function metadata(value: ProviderCredentialMetadata): Record<string, unknown> {
  return {
    provider: value.key.providerId,
    profile: value.key.profileId,
    type: value.type,
    updatedAt: value.updatedAt,
    ...(value.expiresAt === undefined
      ? {}
      : { expiry: value.expiresAt > Date.now() ? 'valid' : 'expired' }),
  }
}

function sortedMetadata(
  records: readonly ProviderCredentialMetadata[],
  provider: string | undefined,
  profile: string | undefined,
): Record<string, unknown>[] {
  return records
    .filter(
      (record) =>
        (provider === undefined || record.key.providerId === provider) &&
        (profile === undefined || record.key.profileId === profile),
    )
    .sort((left, right) => {
      const providerOrder = left.key.providerId.localeCompare(
        right.key.providerId,
      )
      return (
        providerOrder || left.key.profileId.localeCompare(right.key.profileId)
      )
    })
    .map(metadata)
}

export function secretLine(value: string): string {
  if (Buffer.byteLength(value, 'utf8') > MAX_SECRET_BYTES)
    fail('Credential exceeds the 64 KiB limit')
  const stripped = value.endsWith('\r\n')
    ? value.slice(0, -2)
    : value.endsWith('\r') || value.endsWith('\n')
      ? value.slice(0, -1)
      : value
  if (/[\r\n]/u.test(stripped) || stripped.trim().length === 0)
    fail('Credential must be exactly one non-blank line')
  return stripped
}

export async function executeProviderAuthCommand(
  args: readonly string[],
  options: ProviderAuthCommandOptions,
): Promise<number> {
  const parsed = parse(args, options)
  const vault = options.vault ?? defaultVault(options)
  if (parsed.action === 'status') {
    const credentials = sortedMetadata(
      await vault.list(),
      parsed.provider,
      parsed.profile,
    )
    if (parsed.json) {
      json(options.io, { type: 'provider-auth-status', credentials })
    } else if (credentials.length === 0) {
      text(options.io, 'No provider credentials configured.')
    } else {
      text(
        options.io,
        credentials
          .map(
            (credential) =>
              `${credential.provider}/${credential.profile}: ${credential.type}${
                credential.expiry === undefined ? '' : ` (${credential.expiry})`
              }`,
          )
          .join('\n'),
      )
    }
    return 0
  }

  const provider = parsed.provider
  if (provider === undefined) fail(`auth ${parsed.action} requires a provider`)
  const key = {
    providerId: provider,
    profileId: parsed.profile ?? 'default',
  }
  if (parsed.action === 'set-key') {
    if (!options.io.readSecret)
      fail('auth set-key requires an interactive secret reader')
    const secret = secretLine(
      await options.io.readSecret('API key: ', options.signal),
    )
    await vault.modify(key, () => ({ type: 'api-key', secret }))
    const result = {
      provider: key.providerId,
      profile: key.profileId,
      type: 'api-key',
    }
    if (parsed.json) json(options.io, result)
    else
      text(
        options.io,
        `Stored api-key credential for ${key.providerId}/${key.profileId}.`,
      )
    return 0
  }
  if (parsed.action === 'logout') {
    const existing = await vault.read(key)
    if (existing !== undefined) await vault.delete(key)
    const result = {
      provider: key.providerId,
      profile: key.profileId,
      deleted: true,
    }
    if (parsed.json) json(options.io, result)
    else text(options.io, `Logged out ${key.providerId}/${key.profileId}.`)
    return 0
  }

  await (
    options.assertCodexLoginEnabled ??
    ((profileId) => assertCodexLoginEnabled(options, profileId))
  )(key.profileId)
  const loginOptions = {
    profileId: key.profileId,
    vault: createCodexOAuthVault(vault),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(parsed.noBrowser ? { noBrowser: true } : {}),
    write: (message: string) => options.io.stderr?.(message),
  }
  const login = parsed.device
    ? (options.deviceLoginWithCodexOAuth ?? deviceLoginWithCodexOAuth)
    : (options.loginWithCodexOAuth ?? loginWithCodexOAuth)
  await login(loginOptions)
  const result = {
    provider: key.providerId,
    profile: key.profileId,
    type: 'oauth',
  }
  if (parsed.json) json(options.io, result)
  else text(options.io, `Logged in ${key.providerId}/${key.profileId}.`)
  return 0
}

function createCodexOAuthVault(vault: ProviderAuthVault): CodexOAuthVault {
  return {
    read: (key) => vault.read(key),
    modify: (key, callback) =>
      vault.modify(key, async (current) => callback(current)),
  }
}
