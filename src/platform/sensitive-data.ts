const REDACTION = '[REDACTED]'
const CHILD_STARTUP_VARIABLES = new Set(['BASH_ENV', 'ENV'])
const SENSITIVE_EXACT_NAMES = new Set([
  'DATABASE_URL',
  'DOCKER_AUTH_CONFIG',
  'MYSQL_PWD',
  'PGPASSWORD',
  'REDIS_URL',
])

type Environment = Readonly<Record<string, string | undefined>>

function normalizedName(name: string): string {
  return name.toUpperCase().replaceAll('-', '_')
}

function isSensitiveName(name: string): boolean {
  const normalized = normalizedName(name)
  return (
    SENSITIVE_EXACT_NAMES.has(normalized) ||
    normalized.includes('CREDENTIAL') ||
    normalized.includes('AUTHTOKEN') ||
    /(?:^|_)(?:ACCESS_KEY|API_?KEY|AUTH(?:ORIZATION)?|COOKIE|JWT|PAT|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_KEY)(?:_|$)/u.test(
      normalized,
    )
  )
}

function addValue(values: Set<string>, value: string | undefined): void {
  if (!value) return
  values.add(value)
  const jsonEncoded = JSON.stringify(value).slice(1, -1)
  if (jsonEncoded !== value) values.add(jsonEncoded)
}

function addDerivedValues(
  values: Set<string>,
  name: string,
  value: string,
): void {
  const normalized = normalizedName(name)
  if (normalized.includes('AUTHORIZATION')) {
    addValue(values, value.replace(/^\S+\s+/u, ''))
  }
  if (/(?:^|_)COOKIE(?:_|$)/u.test(normalized)) {
    for (const field of value.split(';')) {
      const separator = field.indexOf('=')
      if (separator >= 0) addValue(values, field.slice(separator + 1).trim())
    }
  }
}

export function sanitizeChildEnvironment(
  explicitOverrides: Environment = {},
  ambient: Environment = process.env,
): Record<string, string> {
  const sanitized: Record<string, string> = {}
  for (const [name, value] of Object.entries(ambient)) {
    if (
      value !== undefined &&
      !isSensitiveName(name) &&
      !CHILD_STARTUP_VARIABLES.has(normalizedName(name))
    ) {
      sanitized[name] = value
    }
  }
  for (const [name, value] of Object.entries(explicitOverrides)) {
    if (value === undefined) delete sanitized[name]
    else sanitized[name] = value
  }
  return sanitized
}

export function sensitiveEnvironmentValues(
  ...environments: readonly Environment[]
): readonly string[] {
  const values = new Set<string>()
  for (const environment of environments) {
    for (const [name, value] of Object.entries(environment)) {
      if (!isSensitiveName(name) || value === undefined) continue
      addValue(values, value)
      addDerivedValues(values, name, value)
    }
  }
  return [...values].sort((left, right) => right.length - left.length)
}

export function redactSensitiveText(
  text: string,
  sensitiveValues: readonly string[],
): string {
  let redacted = text
  for (const value of sensitiveValues) {
    redacted = redacted.replaceAll(value, REDACTION)
  }
  return redacted
}

export function redactSensitiveValue<T>(
  value: T,
  sensitiveValues: readonly string[],
): T {
  return redactValue(value, sensitiveValues, new WeakSet<object>()) as T
}

function redactValue(
  value: unknown,
  sensitiveValues: readonly string[],
  seen: WeakSet<object>,
): unknown {
  if (typeof value === 'string') {
    return redactSensitiveText(value, sensitiveValues)
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return '[Circular]'
    seen.add(value)
    return value.map((item) => redactValue(item, sensitiveValues, seen))
  }
  if (typeof value === 'object' && value !== null) {
    if (seen.has(value)) return '[Circular]'
    seen.add(value)
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [
        redactSensitiveText(name, sensitiveValues),
        redactValue(item, sensitiveValues, seen),
      ]),
    )
  }
  return value
}

export function redactSensitiveError(
  error: unknown,
  sensitiveValues: readonly string[],
): Error {
  return redactError(error, sensitiveValues, new WeakSet<Error>())
}

function redactError(
  error: unknown,
  sensitiveValues: readonly string[],
  seen: WeakSet<Error>,
): Error {
  if (error instanceof Error && seen.has(error)) {
    return new Error('Circular error cause')
  }
  if (error instanceof Error) seen.add(error)

  const sanitized = new Error(
    redactSensitiveText(
      error instanceof Error ? error.message : String(error),
      sensitiveValues,
    ),
  )
  if (error instanceof Error) {
    sanitized.name = error.name
    if (error.stack) {
      sanitized.stack = redactSensitiveText(error.stack, sensitiveValues)
    }
    if (error.cause !== undefined) {
      Object.defineProperty(sanitized, 'cause', {
        configurable: true,
        value:
          error.cause instanceof Error
            ? redactError(error.cause, sensitiveValues, seen)
            : redactSensitiveValue(error.cause, sensitiveValues),
      })
    }
  }

  if (typeof error === 'object' && error !== null) {
    const target = sanitized as Error & Record<string, unknown>
    for (const [name, value] of Object.entries(error)) {
      if (['cause', 'message', 'name', 'stack'].includes(name)) continue
      target[redactSensitiveText(name, sensitiveValues)] =
        value instanceof Error
          ? redactError(value, sensitiveValues, seen)
          : redactSensitiveValue(value, sensitiveValues)
    }
  }
  return sanitized
}
