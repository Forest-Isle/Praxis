import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import type { ProviderTarget } from './provider-settings.js'

interface ProviderCredentialKey {
  providerId: string
  profileId: string
}

type ProviderCredentialRecord =
  | { type: 'api-key'; secret: string }
  | {
      type: 'oauth'
      accessToken: string
      refreshToken: string
      expiresAt: number
      accountId?: string
    }

export interface ProviderCredentialReader {
  read(
    key: ProviderCredentialKey,
  ): Promise<ProviderCredentialRecord | undefined>
}

export type ProviderAuthenticationErrorCode =
  'missing_credential' | 'invalid_credential' | 'command_failed'

export class ProviderAuthenticationError extends Error {
  readonly code: ProviderAuthenticationErrorCode

  constructor(code: ProviderAuthenticationErrorCode, message: string) {
    super(message)
    this.name = 'ProviderAuthenticationError'
    this.code = code
  }
}

const execFileAsync = promisify(execFile)
const COMMAND_TIMEOUT_MS = 10_000
const MAX_COMMAND_OUTPUT = 64 * 1024

export type ProviderCredentialSourceMetadata =
  | { source: 'explicit' }
  | { source: 'legacy-env'; name: 'PRAXIS_API_KEY' }
  | { source: 'env'; name: string }
  | { source: 'command'; command: readonly string[] }
  | { source: 'vault'; providerId: string; profileId: string }

export type ResolvedApiKeyCredential = {
  type: 'api-key'
  secret: string
  source: ProviderCredentialSourceMetadata
}

export type ResolvedOAuthCredential = {
  type: 'oauth'
  accessToken: string
  refreshToken: string
  expiresAt: number
  accountId?: string
  source: ProviderCredentialSourceMetadata
}

export type ResolvedProviderCredential =
  ResolvedApiKeyCredential | ResolvedOAuthCredential

export interface ProviderCommandResult {
  stdout: string
  exitCode: number
}

export type ProviderCommandRunner = (
  argv: readonly string[],
  options: { timeoutMs: number; maxOutputBytes: number },
) => Promise<ProviderCommandResult>

export interface ResolveProviderCredentialOptions {
  target: ProviderTarget
  environment?: Readonly<Record<string, string | undefined>>
  vault: ProviderCredentialReader
  apiKey?: string
  commandRunner?: ProviderCommandRunner
}

function missing(message: string): never {
  throw new ProviderAuthenticationError(
    'missing_credential',
    `Provider authentication failed: ${message}`,
  )
}

function secretValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0)
    missing(`${label} is missing or blank`)
  return value
}

const defaultCommandRunner: ProviderCommandRunner = async (argv, options) => {
  const executable = argv[0]
  if (executable === undefined || executable.length === 0)
    missing('credential command is empty')
  try {
    const result = await execFileAsync(executable, argv.slice(1), {
      shell: false,
      timeout: options.timeoutMs,
      maxBuffer: options.maxOutputBytes,
    })
    return { stdout: result.stdout, exitCode: 0 }
  } catch (error) {
    const stdout =
      typeof (error as { stdout?: unknown }).stdout === 'string'
        ? (error as { stdout: string }).stdout
        : ''
    const exitCode =
      typeof (error as { code?: unknown }).code === 'number'
        ? (error as { code: number }).code
        : 1
    return { stdout, exitCode }
  }
}

function keyFor(
  target: ProviderTarget,
  profileId = target.profileId,
): ProviderCredentialKey {
  return { providerId: target.providerId, profileId }
}

async function vaultApiKey(
  target: ProviderTarget,
  vault: ProviderCredentialReader,
  profileId: string,
): Promise<ResolvedApiKeyCredential> {
  let record
  try {
    record = await vault.read(keyFor(target, profileId))
  } catch {
    missing(
      `vault credential for ${target.providerId}/${profileId} is unavailable`,
    )
  }
  if (!record || record.type !== 'api-key')
    missing(
      `vault API key for ${target.providerId}/${profileId} is unavailable`,
    )
  return {
    type: 'api-key',
    secret: record.secret,
    source: { source: 'vault', providerId: target.providerId, profileId },
  }
}

export async function resolveProviderCredential(
  options: ResolveProviderCredentialOptions,
): Promise<ResolvedProviderCredential> {
  const { target } = options
  const environment = options.environment ?? process.env
  const explicitProvided = options.apiKey !== undefined
  const legacyProvided = environment.PRAXIS_API_KEY !== undefined
  if (target.protocol === 'codex-subscription') {
    if (explicitProvided || legacyProvided)
      missing('Codex subscription does not accept API keys')
    if (target.credential.source !== 'vault')
      missing('Codex subscription requires a vault OAuth credential')
    const profileId = target.credential.profile ?? target.profileId
    if (profileId !== target.profileId)
      missing(
        'Codex subscription vault profile must match the selected profile',
      )
    let record
    try {
      record = await options.vault.read(keyFor(target, target.profileId))
    } catch {
      missing(
        `vault credential for ${target.providerId}/${target.profileId} is unavailable`,
      )
    }
    if (!record || record.type !== 'oauth')
      missing(
        `vault OAuth credential for ${target.providerId}/${target.profileId} is unavailable`,
      )
    return {
      type: 'oauth',
      accessToken: record.accessToken,
      refreshToken: record.refreshToken,
      expiresAt: record.expiresAt,
      ...(record.accountId === undefined
        ? {}
        : { accountId: record.accountId }),
      source: {
        source: 'vault',
        providerId: target.providerId,
        profileId: target.profileId,
      },
    }
  }
  if (explicitProvided) {
    return {
      type: 'api-key',
      secret: secretValue(options.apiKey, 'explicit API key'),
      source: { source: 'explicit' },
    }
  }
  if (legacyProvided) {
    return {
      type: 'api-key',
      secret: secretValue(environment.PRAXIS_API_KEY, 'PRAXIS_API_KEY'),
      source: { source: 'legacy-env', name: 'PRAXIS_API_KEY' },
    }
  }
  const source = target.credential
  if (source.source === 'env') {
    return {
      type: 'api-key',
      secret: secretValue(environment[source.name], source.name),
      source: { source: 'env', name: source.name },
    }
  }
  if (source.source === 'command') {
    const runner = options.commandRunner ?? defaultCommandRunner
    let result: ProviderCommandResult
    try {
      result = await runner(source.command, {
        timeoutMs: COMMAND_TIMEOUT_MS,
        maxOutputBytes: MAX_COMMAND_OUTPUT,
      })
    } catch {
      missing('credential command failed')
    }
    if (result.exitCode !== 0)
      missing('credential command exited unsuccessfully')
    const output = secretValue(
      result.stdout,
      'credential command output',
    ).trim()
    if (output.length > MAX_COMMAND_OUTPUT)
      missing('credential command output exceeds 64 KiB')
    if (/\r?\n/u.test(output))
      missing('credential command must return exactly one secret')
    return {
      type: 'api-key',
      secret: output,
      source: { source: 'command', command: source.command },
    }
  }
  return vaultApiKey(target, options.vault, source.profile ?? target.profileId)
}
