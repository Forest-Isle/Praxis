import { constants } from 'node:fs'
import { access, realpath, stat } from 'node:fs/promises'
import { basename, delimiter, dirname, resolve } from 'node:path'

export type DoctorInstallationType = 'npm' | 'source'

export interface DoctorSearchStatus {
  readonly working: boolean
  readonly mode: 'system'
  readonly systemPath: string | null
}

export interface DoctorDiagnosticWarning {
  readonly issue: string
  readonly fix: string
}

export interface DoctorInstallationDiagnostic {
  readonly installationType: DoctorInstallationType
  readonly version: string
  readonly packageManager: string | null
  readonly installationPath: string
  readonly invokedBinary: string
  readonly search: DoctorSearchStatus
  readonly recommendation: string | null
  readonly multipleInstallations: readonly string[]
  readonly warnings: readonly DoctorDiagnosticWarning[]
}

export interface DoctorUpdateBaseDiagnostic {
  readonly autoUpdates: string
  readonly hasUpdatePermissions: boolean | null
  readonly channel: 'latest' | 'stable'
}

export interface DoctorUpdateDiagnostic extends DoctorUpdateBaseDiagnostic {
  readonly stableVersion: string | null
  readonly latestVersion: string | null
  readonly registryStatus: 'available' | 'unavailable'
  readonly error?: string
}

export interface DoctorPendingUpdateDiagnostic extends DoctorUpdateBaseDiagnostic {
  readonly stableVersion: null
  readonly latestVersion: null
  readonly registryStatus: 'loading'
}

export interface PraxisDistTags {
  stable?: string
  latest?: string
}

export type PraxisDistTagLoader = () => Promise<PraxisDistTags>
export type DoctorUpdatePermissionChecker = (
  directory: string,
) => Promise<boolean | null>

export interface DoctorDiagnosticOptions {
  version: string
  executablePath: string
  invokedBinaryPath?: string
  configRoot: string
  environment: NodeJS.ProcessEnv
  autoUpdateChannel: 'latest' | 'stable'
  loadDistTags?: PraxisDistTagLoader
  checkUpdatePermissions?: DoctorUpdatePermissionChecker
}

export interface DoctorDiagnosticsResult {
  diagnostic: DoctorInstallationDiagnostic
  updates: DoctorUpdateDiagnostic
}

export interface DoctorLocalDiagnosticsResult {
  diagnostic: DoctorInstallationDiagnostic
  updates: DoctorPendingUpdateDiagnostic
}

const PRAXIS_NPM_PACKAGE = 'praxis-agent'
const DIST_TAGS_URL = `https://registry.npmjs.org/-/package/${PRAXIS_NPM_PACKAGE}/dist-tags`
const DIST_TAGS_TIMEOUT_MS = 5_000
const REGISTRY_ERROR =
  'Failed to fetch version information from the npm registry'

function parseDistTags(parsed: unknown): PraxisDistTags {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const record = parsed as Record<string, unknown>
  const tags: PraxisDistTags = {}
  for (const name of ['stable', 'latest'] as const) {
    const value = record[name]
    if (typeof value === 'string' && value.trim().length > 0) {
      tags[name] = value.trim()
    }
  }
  return tags
}

export async function loadPraxisDistTags(): Promise<PraxisDistTags> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), DIST_TAGS_TIMEOUT_MS)
  try {
    const response = await fetch(DIST_TAGS_URL, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) return {}
    return parseDistTags(await response.json())
  } catch {
    return {}
  } finally {
    clearTimeout(timeout)
  }
}

async function readableExecutable(path: string): Promise<string> {
  const metadata = await stat(path)
  if (!metadata.isFile()) throw new Error(`Executable is not a file: ${path}`)
  await access(path, constants.R_OK)
  return realpath(path)
}

async function executableRealpath(path: string): Promise<string | null> {
  try {
    const metadata = await stat(path)
    if (!metadata.isFile()) return null
    await access(path, constants.X_OK)
    return await realpath(path)
  } catch {
    return null
  }
}

async function findOnPath(
  names: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<string | null> {
  for (const root of (environment.PATH ?? '')
    .split(delimiter)
    .filter(Boolean)) {
    for (const name of names) {
      const candidate = resolve(root, name)
      const canonical = await executableRealpath(candidate)
      if (canonical !== null) return canonical
    }
  }
  return null
}

async function praxisInstallations(
  installationPath: string,
  environment: NodeJS.ProcessEnv,
): Promise<readonly string[]> {
  const names =
    process.platform === 'win32' ? ['praxis.exe', 'praxis.cmd'] : ['praxis']
  const found = new Set<string>()
  for (const root of (environment.PATH ?? '')
    .split(delimiter)
    .filter(Boolean)) {
    for (const name of names) {
      const candidate = resolve(root, name)
      const canonical = await executableRealpath(candidate)
      if (canonical !== null) found.add(canonical)
    }
  }
  if (names.includes(basename(installationPath))) found.add(installationPath)
  return [...found].sort()
}

async function updatePermissions(directory: string): Promise<boolean | null> {
  try {
    await access(directory, constants.W_OK)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === 'EACCES' || code === 'EPERM' ? false : null
  }
}

async function buildPendingUpdateDiagnostic(
  options: DoctorDiagnosticOptions,
  installation: {
    installationType: DoctorInstallationType
    invokedBinary: string
  },
): Promise<DoctorPendingUpdateDiagnostic> {
  const checkUpdatePermissions =
    options.checkUpdatePermissions ?? updatePermissions
  const hasUpdatePermissions = await checkUpdatePermissions(
    dirname(installation.invokedBinary),
  )
  return {
    autoUpdates:
      installation.installationType === 'npm'
        ? 'Manual (praxis update)'
        : 'Managed by source checkout',
    hasUpdatePermissions,
    channel: options.autoUpdateChannel,
    stableVersion: null,
    latestVersion: null,
    registryStatus: 'loading',
  }
}

export async function resolveDoctorUpdates(
  options: DoctorDiagnosticOptions,
  pendingUpdates: DoctorPendingUpdateDiagnostic,
): Promise<DoctorUpdateDiagnostic> {
  let stableVersion: string | null = null
  let latestVersion: string | null = null
  let registryStatus: 'available' | 'unavailable' = 'unavailable'
  let error: string | undefined
  try {
    const loader = options.loadDistTags ?? loadPraxisDistTags
    const tags = await loader()
    const latest = tags.latest?.trim()
    if (latest) {
      registryStatus = 'available'
      latestVersion = latest
      stableVersion = tags.stable?.trim() || null
    } else {
      error = REGISTRY_ERROR
    }
  } catch (cause) {
    error = `${REGISTRY_ERROR}: ${
      cause instanceof Error ? cause.message : String(cause)
    }`
  }
  return {
    autoUpdates: pendingUpdates.autoUpdates,
    hasUpdatePermissions: pendingUpdates.hasUpdatePermissions,
    channel: pendingUpdates.channel,
    stableVersion,
    latestVersion,
    registryStatus,
    ...(error === undefined ? {} : { error }),
  }
}

export async function collectDoctorLocalDiagnostics(
  options: DoctorDiagnosticOptions,
): Promise<DoctorLocalDiagnosticsResult> {
  const installationPath = await readableExecutable(options.executablePath)
  const invokedBinary = resolve(
    options.invokedBinaryPath ?? options.executablePath,
  )
  const installationType: DoctorInstallationType = installationPath
    .split(/[\\/]+/u)
    .includes('node_modules')
    ? 'npm'
    : 'source'

  const warnings: DoctorDiagnosticWarning[] = []
  const rgPath = await findOnPath(
    process.platform === 'win32' ? ['rg.exe'] : ['rg'],
    options.environment,
  )
  if (rgPath === null) {
    warnings.push({
      issue: 'The ripgrep (rg) command is not installed on PATH',
      fix: "Install ripgrep and ensure it is on PATH (for example: 'brew install ripgrep', 'apt install ripgrep', or 'npm install -g @vscode/ripgrep')",
    })
  }
  const search: DoctorSearchStatus = {
    working: rgPath !== null,
    mode: 'system',
    systemPath: rgPath,
  }

  const multipleInstallations = await praxisInstallations(
    installationPath,
    options.environment,
  )
  const recommendation =
    multipleInstallations.length > 1
      ? 'Remove stale duplicate Praxis installations and keep only the executable reported by this doctor report'
      : null

  const diagnostic: DoctorInstallationDiagnostic = {
    installationType,
    version: options.version,
    packageManager: installationType === 'npm' ? 'npm' : null,
    installationPath,
    invokedBinary,
    search,
    recommendation,
    multipleInstallations,
    warnings,
  }

  const updates = await buildPendingUpdateDiagnostic(options, {
    installationType,
    invokedBinary,
  })
  return { diagnostic, updates }
}

export async function collectDoctorDiagnostics(
  options: DoctorDiagnosticOptions,
): Promise<DoctorDiagnosticsResult> {
  const local = await collectDoctorLocalDiagnostics(options)
  const updates = await resolveDoctorUpdates(options, local.updates)
  return { diagnostic: local.diagnostic, updates }
}
