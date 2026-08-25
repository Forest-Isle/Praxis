import { accessSync, constants, realpathSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'

const PRESERVED_CREDENTIAL_KEYS = new Set([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'PRAXIS_API_KEY',
])

const PROVIDER_ENV_PREFIXES = [
  'AWS_',
  'AZURE_',
  'CLOUD_ML_',
  'GOOGLE_',
  'VERTEX_',
]

const AUTHENTICATION_PATTERNS = [
  /authentication_error/iu,
  /not logged in/iu,
  /please run\s+\/login/iu,
  /^(?:error:\s*)?authentication failed(?::[^\n]+)?[.!]?$/imu,
  /^(?:error:\s*)?unauthorized[.!]?$/imu,
  /^(?:error:\s*)?invalid api key(?: for claude)?[.!]?$/imu,
  /^(?:error:\s*)?expired credentials[.!]?$/imu,
  /api error:\s*(?:401|403)\b[^\n]*(?:auth|credential|token|api key|unauthorized)/iu,
  /(?:auth|credential|token|api key)[^\n]*\b(?:invalid|expired|missing)\b[^\n]*(?:api error|please run \/login)/iu,
]

const BALANCE_PATTERNS = [
  /insufficient (?:account )?balance/iu,
  /(?:account )?balance[^\n]*(?:insufficient|too low)/iu,
  /credit balance/iu,
  /billing[^\n]*(?:limit|balance|credit)/iu,
  /\b402\b[^\n]*(?:balance|billing|credit)/iu,
]

export const compatibilityScriptExclusions = new Set([
  // Native/core qualification gates are not Claude compatibility lanes.
  'test:native:deletion',
  'test:core-completion',
  'test:performance:active-stream',
  'test:compat:all',
  'test:docs',
  'test:package',
  'test:performance',
])

export function discoverCompatibilityEntrypoints(
  scripts,
  excluded = compatibilityScriptExclusions,
) {
  const entrypoints = []
  const seen = new Set()
  for (const [name, command] of Object.entries(scripts ?? {})) {
    if (!name.startsWith('test:') || excluded.has(name)) continue
    const parts = String(command).split(' && ')
    if (parts.shift() !== 'npm run build' || parts.length === 0) {
      throw new Error(
        `${name} does not follow compatibility gate command shape`,
      )
    }
    for (const part of parts) {
      const match = /^node (scripts\/[a-z0-9-]+\.mjs)$/u.exec(part)
      if (!match) {
        throw new Error(
          `${name} has unsupported compatibility command: ${part}`,
        )
      }
      const file = match[1]
      if (seen.has(file))
        throw new Error(`Duplicate compatibility gate: ${file}`)
      seen.add(file)
      entrypoints.push({ name, file })
    }
  }
  if (entrypoints.length === 0)
    throw new Error('No compatibility gates discovered')
  return entrypoints
}

export function buildQualificationEnvironment(
  hostEnvironment,
  { configRoot, projectRoot, realClaudeBinary, referenceBinary },
) {
  const environment = { ...hostEnvironment }
  for (const key of Object.keys(environment)) {
    const providerSpecific = PROVIDER_ENV_PREFIXES.some((prefix) =>
      key.startsWith(prefix),
    )
    const anthropicSelection =
      key.startsWith('ANTHROPIC_') && !PRESERVED_CREDENTIAL_KEYS.has(key)
    const claudeSelection =
      (key.startsWith('CLAUDE_CODE_') || key === 'CLAUDE_CONFIG_DIR') &&
      !PRESERVED_CREDENTIAL_KEYS.has(key)
    const praxisSelection =
      (key.startsWith('PRAXIS_') &&
        !key.startsWith('PRAXIS_CLAUDE_') &&
        !PRESERVED_CREDENTIAL_KEYS.has(key)) ||
      key === 'PRAXIS_HOME'
    if (
      providerSpecific ||
      anthropicSelection ||
      claudeSelection ||
      praxisSelection
    ) {
      delete environment[key]
    }
  }

  environment.PRAXIS_PROVIDER = 'openai'
  environment.PRAXIS_DATA_PLANE = 'claude'
  environment.CLAUDE_CONFIG_DIR = configRoot
  environment.PRAXIS_REAL_CLAUDE_BINARY = realClaudeBinary
  if (referenceBinary) environment.PRAXIS_CLAUDE_BINARY = referenceBinary
  environment.PATH = [
    join(projectRoot, 'scripts'),
    dirname(realClaudeBinary),
    hostEnvironment.PATH,
  ]
    .filter(Boolean)
    .join(delimiter)
  return environment
}

function executablePaths(value, pathValue = process.env.PATH) {
  if (!value) return []
  const candidates = isAbsolute(value)
    ? [value]
    : String(pathValue ?? '')
        .split(delimiter)
        .filter(Boolean)
        .map((directory) => join(directory, value))
  return candidates.flatMap((candidate) => {
    try {
      accessSync(candidate, constants.X_OK)
      return [realpathSync(resolve(candidate))]
    } catch {
      return []
    }
  })
}

export function canonicalizeBinary(value, { path = process.env.PATH } = {}) {
  const resolved = executablePaths(value, path)[0]
  if (!resolved) throw new Error(`Could not resolve executable: ${value}`)
  return resolved
}

export function canonicalizePrerequisiteBinaries(
  environment,
  keys = Object.keys(environment).filter((key) =>
    key.startsWith('PRAXIS_CLAUDE_'),
  ),
) {
  const result = { ...environment }
  const invalid = []
  for (const key of keys) {
    if (!result[key]) continue
    try {
      result[key] = canonicalizeBinary(result[key], { path: result.PATH })
    } catch {
      invalid.push(key)
    }
  }
  return { environment: result, invalid }
}

export function selectPrimaryReferenceBinary(candidates, wrapperPath) {
  return candidates.find((candidate) => candidate !== wrapperPath)
}

export function resolvePrimaryReferenceBinary(
  value,
  { path = process.env.PATH, wrapperPath },
) {
  return selectPrimaryReferenceBinary(executablePaths(value, path), wrapperPath)
}

export function findMissingPrerequisites(
  entrypoints,
  requiredEnvironment,
  environment,
  invalid = [],
) {
  const invalidKeys = new Set(invalid)
  return entrypoints.flatMap((entrypoint) => {
    const missing = (requiredEnvironment.get(entrypoint.file) ?? []).filter(
      (name) => !environment[name] || invalidKeys.has(name),
    )
    return missing.length > 0 ? [{ ...entrypoint, missing }] : []
  })
}

export function classifyQualification({
  failures = 0,
  blocked = 0,
  skipped = 0,
}) {
  if (failures > 0) return 'failed'
  if (blocked > 0) return 'blocked'
  if (skipped > 0) return 'skipped'
  return 'complete'
}

export function qualificationExitCode(verdict) {
  return { complete: 0, failed: 1, blocked: 2, skipped: 3 }[verdict] ?? 1
}

export function classifyGateError(error) {
  const diagnostics =
    error && typeof error === 'object' && 'diagnostics' in error
      ? String(error.diagnostics)
      : String(error ?? '')
  if (BALANCE_PATTERNS.some((pattern) => pattern.test(diagnostics))) {
    return { verdict: 'blocked', prerequisite: 'Claude account balance' }
  }
  if (AUTHENTICATION_PATTERNS.some((pattern) => pattern.test(diagnostics))) {
    return { verdict: 'blocked', prerequisite: 'Claude credentials' }
  }
  return { verdict: 'failed' }
}
