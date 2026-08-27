import { createHash } from 'node:crypto'

export interface WorkflowReplayOptions {
  model?: string
  effort?: string
  agentType?: string
  schema?: Record<string, unknown>
  isolation?: 'worktree'
}

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
    .join(',')}}`
}

function canonicalReplayOptions(options: WorkflowReplayOptions): string {
  const selected: Record<string, unknown> = {}
  for (const field of [
    'schema',
    'model',
    'effort',
    'isolation',
    'agentType',
  ] as const) {
    const value = options[field]
    if (value !== undefined && typeof value !== 'function') {
      selected[field] = value
    }
  }
  const canonical = (value: unknown): unknown => {
    if (typeof value === 'function') return undefined
    if (Array.isArray(value)) return value.map(canonical)
    if (value && typeof value === 'object') {
      const result = Object.create(null) as Record<string, unknown>
      for (const key of Object.keys(value).sort()) {
        result[key] = canonical((value as Record<string, unknown>)[key])
      }
      return result
    }
    return value
  }
  return JSON.stringify(canonical(selected))
}

export function workflowReplayDescriptor(
  prompt: string,
  options: WorkflowReplayOptions = {},
): string {
  return stable({
    prompt,
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.effort === undefined ? {} : { effort: options.effort }),
    ...(options.agentType === undefined
      ? {}
      : { agentType: options.agentType }),
    ...(options.schema === undefined ? {} : { schema: options.schema }),
    ...(options.isolation === undefined
      ? {}
      : { isolation: options.isolation }),
  })
}

export function workflowReplayKey(
  prompt: string,
  options: WorkflowReplayOptions = {},
  previousKey = '',
): string {
  return `v2:${createHash('sha256')
    .update(previousKey)
    .update('\0')
    .update(prompt)
    .update('\0')
    .update(canonicalReplayOptions(options))
    .digest('hex')}`
}
