export const PROJECT_MEMORY_INDEX_MAX_LINES = 200
export const PROJECT_MEMORY_INDEX_MAX_BYTES = 25 * 1024

export type ProjectMemoryDataPlane = 'native' | 'claude'

export interface ProjectMemoryPolicy {
  enabled: boolean
  extraction: boolean
  recall: boolean
}

export interface ResolveProjectMemoryPolicyOptions {
  dataPlane: ProjectMemoryDataPlane
  settings: readonly { value: unknown }[]
  environment: Readonly<Record<string, string | undefined>>
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function utf8Prefix(source: string, maxBytes: number): string {
  const buffer = Buffer.from(source, 'utf8')
  if (buffer.byteLength <= maxBytes) return source
  for (let end = maxBytes; end >= Math.max(0, maxBytes - 4); end -= 1) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(
        buffer.subarray(0, end),
      )
    } catch {
      // Try the previous Unicode boundary.
    }
  }
  return ''
}

export function boundProjectMemoryText(
  source: string,
  maxLines: number,
  maxBytes: number,
): string {
  return utf8Prefix(
    source.split(/\r?\n/u).slice(0, maxLines).join('\n'),
    maxBytes,
  )
}

export function boundProjectMemoryIndex(source: string): string {
  return boundProjectMemoryText(
    source,
    PROJECT_MEMORY_INDEX_MAX_LINES,
    PROJECT_MEMORY_INDEX_MAX_BYTES,
  )
}

function settingBoolean(
  settings: readonly { value: unknown }[],
  path: readonly string[],
): boolean | undefined {
  let selected: boolean | undefined
  for (const resource of settings) {
    let value: unknown = resource.value
    for (const key of path) value = record(value)?.[key]
    if (typeof value === 'boolean') selected = value
  }
  return selected
}

function enabledEnvironmentValue(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true'
}

export function resolveProjectMemoryPolicy({
  dataPlane,
  settings,
  environment,
}: ResolveProjectMemoryPolicyOptions): ProjectMemoryPolicy {
  const disabledByEnvironment = enabledEnvironmentValue(
    dataPlane === 'claude'
      ? environment.CLAUDE_CODE_DISABLE_AUTO_MEMORY
      : environment.PRAXIS_DISABLE_AUTO_MEMORY,
  )
  const enabled =
    !disabledByEnvironment &&
    (settingBoolean(settings, ['autoMemoryEnabled']) ?? true)
  if (!enabled) return { enabled: false, extraction: false, recall: false }
  return {
    enabled: true,
    extraction:
      settingBoolean(settings, ['projectMemory', 'backgroundExtraction']) ??
      enabledEnvironmentValue(environment.PRAXIS_PROJECT_MEMORY_EXTRACTION),
    recall:
      settingBoolean(settings, ['projectMemory', 'selectiveRecall']) ??
      enabledEnvironmentValue(environment.PRAXIS_PROJECT_MEMORY_RECALL),
  }
}
