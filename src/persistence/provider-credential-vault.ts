import { createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, rm, stat } from 'node:fs/promises'
import { getuid } from 'node:process'
import { userInfo } from 'node:os'
import { promisify } from 'node:util'
import { join, resolve } from 'node:path'

import { writeFileAtomically } from '../platform/atomic-write.js'
import { ExclusiveFileLease } from '../platform/exclusive-file-lease.js'

const execFileAsync = promisify(execFile)
const MAX_BYTES = 1024 * 1024
const LOCK_WAIT_MS = 10_000

export class ProviderKeychainUnavailableError extends Error {
  constructor() {
    super('Provider credential Keychain is unavailable')
    this.name = 'ProviderKeychainUnavailableError'
  }
}

export interface ProviderCredentialKey {
  providerId: string
  profileId: string
}

export interface ApiKeyCredential {
  type: 'api-key'
  secret: string
  revision: number
  updatedAt: string
}

export interface ApiKeyCredentialInput {
  type: 'api-key'
  secret: string
}

export interface OAuthCredential {
  type: 'oauth'
  accessToken: string
  refreshToken: string
  expiresAt: number
  accountId?: string
  revision: number
  updatedAt: string
}

export interface OAuthCredentialInput {
  type: 'oauth'
  accessToken: string
  refreshToken: string
  expiresAt: number
  accountId?: string
}

export type ProviderCredentialRecord = ApiKeyCredential | OAuthCredential
export type ProviderCredentialInput =
  ApiKeyCredentialInput | OAuthCredentialInput

export interface ProviderCredentialMetadata {
  key: ProviderCredentialKey
  type: ProviderCredentialRecord['type']
  revision: number
  updatedAt: string
  expiresAt?: number
}

export interface ProviderCredentialKeychainAdapter {
  read(service: string): Promise<string | undefined>
  write(service: string, serializedEnvelope: string): Promise<void>
  delete(service: string): Promise<void>
}

export interface ProviderCredentialVaultOptions {
  configRoot: string
  useKeychain?: boolean
  keychain?: ProviderCredentialKeychainAdapter
  environment?: Readonly<Record<string, string | undefined>>
}

export function providerCredentialFilePath(configRoot: string): string {
  return join(resolve(configRoot), '.provider-credentials.json')
}

export function providerCredentialService(configRoot: string): string {
  const canonical = resolve(configRoot)
  const digest = createHash('sha256')
    .update(canonical)
    .digest('hex')
    .slice(0, 12)
  return `Praxis-provider-credentials-${digest}`
}

interface Envelope {
  version: 1
  credentials: Record<string, ProviderCredentialRecord>
  deleted?: Record<string, ProviderCredentialTombstone>
}

interface ProviderCredentialTombstone {
  revision: number
  updatedAt: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)
  )
}

function validUpdatedAt(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  )
}

function validAccountId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value === value.trim() &&
    Buffer.byteLength(value) <= 512
  )
}

function validateRecord(
  value: unknown,
  path: string,
): ProviderCredentialRecord {
  if (!isRecord(value) || (value.type !== 'api-key' && value.type !== 'oauth'))
    throw new Error(`Invalid provider credential record: ${path}`)
  if (
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) <= 0 ||
    !validUpdatedAt(value.updatedAt)
  )
    throw new Error(`Invalid provider credential metadata: ${path}`)
  const revision = value.revision as number
  if (value.type === 'api-key') {
    if (
      typeof value.secret !== 'string' ||
      value.secret.trim().length === 0 ||
      value.secret.length > MAX_BYTES
    )
      throw new Error(`Invalid provider API key credential: ${path}`)
    return {
      type: 'api-key',
      secret: value.secret,
      revision,
      updatedAt: value.updatedAt,
    }
  }
  if (
    typeof value.accessToken !== 'string' ||
    value.accessToken.length === 0 ||
    typeof value.refreshToken !== 'string' ||
    value.refreshToken.length === 0 ||
    typeof value.expiresAt !== 'number' ||
    !Number.isFinite(value.expiresAt) ||
    value.expiresAt < 0 ||
    value.accessToken.length > MAX_BYTES ||
    value.refreshToken.length > MAX_BYTES
  )
    throw new Error(`Invalid provider OAuth credential: ${path}`)
  if (value.accountId !== undefined && !validAccountId(value.accountId))
    throw new Error(`Invalid provider OAuth account ID: ${path}`)
  return {
    type: 'oauth',
    accessToken: value.accessToken,
    refreshToken: value.refreshToken,
    expiresAt: value.expiresAt,
    ...(value.accountId === undefined ? {} : { accountId: value.accountId }),
    revision,
    updatedAt: value.updatedAt,
  }
}

function validateInput(value: unknown, path: string): ProviderCredentialInput {
  if (!isRecord(value) || (value.type !== 'api-key' && value.type !== 'oauth'))
    throw new Error(`Invalid provider credential input: ${path}`)
  if (value.revision !== undefined || value.updatedAt !== undefined)
    throw new Error(
      `Provider credential input must not include persistence metadata: ${path}`,
    )
  if (value.type === 'api-key') {
    if (
      typeof value.secret !== 'string' ||
      value.secret.trim().length === 0 ||
      value.secret.length > MAX_BYTES
    )
      throw new Error(`Invalid provider API key input: ${path}`)
    return { type: 'api-key', secret: value.secret }
  }
  if (
    typeof value.accessToken !== 'string' ||
    value.accessToken.length === 0 ||
    value.accessToken.length > MAX_BYTES ||
    typeof value.refreshToken !== 'string' ||
    value.refreshToken.length === 0 ||
    value.refreshToken.length > MAX_BYTES ||
    typeof value.expiresAt !== 'number' ||
    !Number.isFinite(value.expiresAt) ||
    value.expiresAt < 0
  )
    throw new Error(`Invalid provider OAuth input: ${path}`)
  if (value.accountId !== undefined && !validAccountId(value.accountId))
    throw new Error(`Invalid provider OAuth account ID: ${path}`)
  return {
    type: 'oauth',
    accessToken: value.accessToken,
    refreshToken: value.refreshToken,
    expiresAt: value.expiresAt,
    ...(value.accountId === undefined ? {} : { accountId: value.accountId }),
  }
}

function keyString(key: ProviderCredentialKey): string {
  if (!validId(key.providerId) || !validId(key.profileId))
    throw new Error('Invalid provider credential key')
  return `${key.providerId}|${key.profileId}`
}

function parseKey(value: string): ProviderCredentialKey {
  const separator = value.indexOf('|')
  if (separator <= 0 || separator === value.length - 1)
    throw new Error(`Invalid provider credential key: ${value}`)
  const key = {
    providerId: value.slice(0, separator),
    profileId: value.slice(separator + 1),
  }
  keyString(key)
  return key
}

function parseEnvelope(source: string, path: string): Envelope {
  if (Buffer.byteLength(source) > MAX_BYTES)
    throw new Error(`Provider credential store exceeds 1 MiB: ${path}`)
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch (error) {
    throw new Error(`Invalid provider credential JSON: ${path}`, {
      cause: error,
    })
  }
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.credentials))
    throw new Error(`Unsupported provider credential envelope: ${path}`)
  const credentials: Record<string, ProviderCredentialRecord> = {}
  for (const [key, record] of Object.entries(value.credentials)) {
    parseKey(key)
    credentials[key] = validateRecord(record, `${path}:${key}`)
  }
  let deleted: Record<string, ProviderCredentialTombstone> | undefined
  if (value.deleted !== undefined) {
    if (!isRecord(value.deleted))
      throw new Error(`Invalid provider credential tombstones: ${path}`)
    deleted = {}
    for (const [key, tombstone] of Object.entries(value.deleted)) {
      parseKey(key)
      const revision = isRecord(tombstone) ? tombstone.revision : undefined
      const updatedAt = isRecord(tombstone) ? tombstone.updatedAt : undefined
      if (
        !isRecord(tombstone) ||
        !Number.isSafeInteger(revision) ||
        (revision as number) <= 0 ||
        !validUpdatedAt(updatedAt)
      )
        throw new Error(`Invalid provider credential tombstone: ${path}:${key}`)
      if (credentials[key] !== undefined)
        throw new Error(
          `Provider credential has both record and tombstone: ${key}`,
        )
      deleted[key] = {
        revision: revision as number,
        updatedAt,
      }
    }
  }
  return {
    version: 1,
    credentials,
    ...(deleted === undefined || Object.keys(deleted).length === 0
      ? {}
      : { deleted }),
  }
}

async function secureRoot(root: string, forWrite: boolean): Promise<void> {
  let information
  try {
    const linkInformation = await lstat(root)
    if (linkInformation.isSymbolicLink())
      throw new Error(
        `Provider credential config root must not be a symlink: ${root}`,
      )
    information = await stat(root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    if (!forWrite) return
    await mkdir(root, { recursive: true, mode: 0o700 })
    information = await stat(root)
  }
  if (!information.isDirectory())
    throw new Error(
      `Provider credential config root is not a directory: ${root}`,
    )
  if (getuid && information.uid !== getuid())
    throw new Error(
      `Provider credential config root is not owned by the current user: ${root}`,
    )
  if (forWrite) {
    await chmod(root, 0o700)
    information = await stat(root)
  }
  if ((information.mode & 0o077) !== 0)
    throw new Error(
      `Provider credential config root must not be group/world accessible: ${root}`,
    )
}

async function readFileEnvelope(path: string): Promise<Envelope | undefined> {
  let handle
  try {
    const noFollow =
      typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
    handle = await open(path, constants.O_RDONLY | noFollow)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    if ((error as NodeJS.ErrnoException).code === 'ELOOP')
      throw new Error(
        `Provider credential path must be a regular non-symlink file: ${path}`,
      )
    throw error
  }
  try {
    const information = await handle.stat()
    if (!information.isFile())
      throw new Error(
        `Provider credential path must be a regular non-symlink file: ${path}`,
      )
    if (getuid && information.uid !== getuid())
      throw new Error(
        `Provider credential file is not owned by the current user: ${path}`,
      )
    if ((information.mode & 0o077) !== 0)
      throw new Error(
        `Provider credential file must not be group/world accessible: ${path}`,
      )
    if (information.size > MAX_BYTES)
      throw new Error(`Provider credential store exceeds 1 MiB: ${path}`)
    const source = await handle.readFile('utf8')
    return parseEnvelope(source, path)
  } finally {
    await handle.close()
  }
}

type CredentialCandidate =
  | { kind: 'credential'; value: ProviderCredentialRecord }
  | { kind: 'deleted'; value: ProviderCredentialTombstone }

function sameCandidate(
  left: CredentialCandidate,
  right: CredentialCandidate,
): boolean {
  return (
    left.kind === right.kind &&
    JSON.stringify(left.value) === JSON.stringify(right.value)
  )
}

function mergeEnvelopes(
  file: Envelope | undefined,
  keychain: Envelope | undefined,
): Envelope {
  const credentials: Record<string, ProviderCredentialRecord> = {}
  const deleted: Record<string, ProviderCredentialTombstone> = {}
  const keys = new Set([
    ...Object.keys(file?.credentials ?? {}),
    ...Object.keys(file?.deleted ?? {}),
    ...Object.keys(keychain?.credentials ?? {}),
    ...Object.keys(keychain?.deleted ?? {}),
  ])
  for (const key of keys) {
    const fromFile: CredentialCandidate | undefined = file?.credentials[key]
      ? { kind: 'credential', value: file.credentials[key] }
      : file?.deleted?.[key]
        ? { kind: 'deleted', value: file.deleted[key] }
        : undefined
    const fromKeychain: CredentialCandidate | undefined = keychain?.credentials[
      key
    ]
      ? { kind: 'credential', value: keychain.credentials[key] }
      : keychain?.deleted?.[key]
        ? { kind: 'deleted', value: keychain.deleted[key] }
        : undefined
    if (fromFile && fromKeychain) {
      if (
        fromFile.value.revision === fromKeychain.value.revision &&
        !sameCandidate(fromFile, fromKeychain)
      )
        throw new Error(`Conflicting provider credentials for ${key}`)
      const winner =
        fromFile.value.revision > fromKeychain.value.revision
          ? fromFile
          : fromKeychain
      if (winner.kind === 'credential') credentials[key] = winner.value
      else deleted[key] = winner.value
    } else {
      const winner = fromFile ?? fromKeychain
      if (!winner) continue
      if (winner.kind === 'credential') credentials[key] = winner.value
      else deleted[key] = winner.value
    }
  }
  return {
    version: 1,
    credentials,
    ...(Object.keys(deleted).length === 0 ? {} : { deleted }),
  }
}

function metadata(
  key: string,
  record: ProviderCredentialRecord,
): ProviderCredentialMetadata {
  const parsed = parseKey(key)
  return {
    key: parsed,
    type: record.type,
    revision: record.revision,
    updatedAt: record.updatedAt,
    ...(record.type === 'oauth' && record.expiresAt !== undefined
      ? { expiresAt: record.expiresAt }
      : {}),
  }
}

function productionKeychain(): ProviderCredentialKeychainAdapter {
  let account: string
  try {
    const username = userInfo().username
    account = username.length > 0 && username.length <= 256 ? username : 'user'
  } catch {
    account = 'user'
  }
  return {
    async read(service) {
      try {
        const result = await execFileAsync(
          'security',
          ['find-generic-password', '-a', account, '-s', service, '-w'],
          { maxBuffer: MAX_BYTES },
        )
        return result.stdout
      } catch (error) {
        const detail = `${String(error)}\n${String((error as { stderr?: unknown }).stderr ?? '')}`
        if (/could not be found|SecKeychainSearchCopyNext/u.test(detail))
          return undefined
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
          throw new ProviderKeychainUnavailableError()
        throw new Error('Unable to read macOS Keychain provider credentials')
      }
    },
    async write(service, serializedEnvelope) {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        const child = spawn(
          'security',
          ['add-generic-password', '-U', '-a', account, '-s', service, '-w'],
          { stdio: ['pipe', 'ignore', 'ignore'] },
        )
        let settled = false
        const reject = (error?: NodeJS.ErrnoException) => {
          if (!settled) {
            settled = true
            rejectPromise(
              error?.code === 'ENOENT'
                ? new ProviderKeychainUnavailableError()
                : new Error(
                    'Unable to update macOS Keychain provider credentials',
                  ),
            )
          }
        }
        child.once('error', reject)
        child.once('close', (code) => {
          if (settled) return
          settled = true
          if (code === 0) resolvePromise()
          else
            rejectPromise(
              new Error('Unable to update macOS Keychain provider credentials'),
            )
        })
        child.stdin.once('error', reject)
        child.stdin.end(`${serializedEnvelope}\n`)
      })
    },
    async delete(service) {
      try {
        await execFileAsync(
          'security',
          ['delete-generic-password', '-a', account, '-s', service],
          { maxBuffer: MAX_BYTES },
        )
      } catch (error) {
        const detail = `${String(error)}\n${String((error as { stderr?: unknown }).stderr ?? '')}`
        if (/could not be found|SecKeychainSearchCopyNext/u.test(detail)) return
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
          throw new ProviderKeychainUnavailableError()
        throw new Error('Unable to delete macOS Keychain provider credentials')
      }
    },
  }
}

export class ProviderCredentialVault {
  private readonly root: string
  private readonly file: string
  private readonly useKeychain: boolean
  private readonly service: string
  private readonly keychain: ProviderCredentialKeychainAdapter
  private readonly lease: ExclusiveFileLease

  constructor(options: ProviderCredentialVaultOptions) {
    this.root = resolve(options.configRoot)
    this.file = providerCredentialFilePath(this.root)
    const environment = options.environment ?? process.env
    this.useKeychain =
      options.useKeychain ??
      (process.platform === 'darwin' &&
        environment.PRAXIS_PROVIDER_CREDENTIAL_STORE !== 'file')
    this.service = providerCredentialService(this.root)
    this.keychain = options.keychain ?? productionKeychain()
    this.lease = new ExclusiveFileLease(
      join(this.root, '.provider-credentials.lock'),
    )
  }

  async read(
    key: ProviderCredentialKey,
  ): Promise<ProviderCredentialRecord | undefined> {
    const keyName = keyString(key)
    const envelope = await this.readReconciled()
    return envelope.credentials[keyName]
  }

  async list(): Promise<ProviderCredentialMetadata[]> {
    const envelope = await this.readReconciled()
    return Object.entries(envelope.credentials).map(([key, record]) =>
      metadata(key, record),
    )
  }

  async modify(
    key: ProviderCredentialKey,
    callback: (
      current: ProviderCredentialRecord | undefined,
    ) =>
      | ProviderCredentialInput
      | undefined
      | Promise<ProviderCredentialInput | undefined>,
  ): Promise<ProviderCredentialRecord | undefined> {
    const keyName = keyString(key)
    await secureRoot(this.root, true)
    const handle = await this.acquire()
    try {
      await secureRoot(this.root, true)
      const currentEnvelope = await this.readReconciled()
      const next = await callback(currentEnvelope.credentials[keyName])
      const previousRevision = Math.max(
        currentEnvelope.credentials[keyName]?.revision ?? 0,
        currentEnvelope.deleted?.[keyName]?.revision ?? 0,
      )
      const revision = nextRevision(previousRevision)
      if (next === undefined) {
        delete currentEnvelope.credentials[keyName]
        currentEnvelope.deleted = {
          ...(currentEnvelope.deleted ?? {}),
          [keyName]: { revision, updatedAt: new Date().toISOString() },
        }
      } else {
        const checked = validateInput(next, keyName)
        currentEnvelope.credentials[keyName] = {
          ...checked,
          revision,
          updatedAt: new Date().toISOString(),
        }
        if (currentEnvelope.deleted !== undefined) {
          delete currentEnvelope.deleted[keyName]
          if (Object.keys(currentEnvelope.deleted).length === 0)
            delete currentEnvelope.deleted
        }
      }
      await this.persist(currentEnvelope)
      return currentEnvelope.credentials[keyName]
    } finally {
      await handle.release()
    }
  }

  async delete(key: ProviderCredentialKey): Promise<void> {
    await this.modify(key, () => undefined)
  }

  private async readReconciled(): Promise<Envelope> {
    await secureRoot(this.root, false)
    const file = await readFileEnvelope(this.file)
    let keychain: Envelope | undefined
    if (this.useKeychain) {
      let source: string | undefined
      try {
        source = await this.keychain.read(this.service)
      } catch (error) {
        if (!(error instanceof ProviderKeychainUnavailableError)) throw error
      }
      if (source !== undefined) keychain = parseEnvelope(source, 'Keychain')
    }
    return mergeEnvelopes(file, keychain)
  }

  private async persist(envelope: Envelope): Promise<void> {
    const source = JSON.stringify(envelope)
    if (Buffer.byteLength(source) > MAX_BYTES)
      throw new Error('Provider credential store exceeds 1 MiB')
    if (this.useKeychain) {
      try {
        await this.keychain.write(this.service, source)
        await rm(this.file, { force: true })
        return
      } catch (error) {
        if (!(error instanceof ProviderKeychainUnavailableError)) throw error
      }
    }
    const committed = await writeFileAtomically(this.file, source, {
      mode: 0o600,
    })
    if (!committed)
      throw new Error('Provider credential store write was interrupted')
  }

  private async acquire() {
    const started = Date.now()
    while (Date.now() - started < LOCK_WAIT_MS) {
      const handle = await this.lease.tryAcquire()
      if (handle) return handle
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20))
    }
    throw new Error('Provider credential store lock timed out')
  }
}

function nextRevision(previousRevision: number): number {
  const revision = Math.max(previousRevision + 1, Date.now())
  if (!Number.isSafeInteger(revision) || revision <= 0)
    throw new Error('Provider credential revision overflow')
  return revision
}
