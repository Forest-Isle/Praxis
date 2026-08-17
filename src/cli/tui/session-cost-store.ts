import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { isClaudeSessionId } from '../../compatibility/claude/paths.js'
import { writeFileAtomically } from '../../platform/atomic-write.js'
import {
  createSessionCostState,
  type SessionCostModelUsage,
  type SessionCostState,
} from './session-cost.js'

export interface TuiSessionCostStore {
  load(sessionId: string): Promise<SessionCostState>
  save(sessionId: string, state: SessionCostState): Promise<void>
}

export function sessionCostDirectory(configRoot: string): string {
  return join(configRoot, 'praxis', 'session-costs')
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isValidModelLabel(value: string): boolean {
  if (value.length === 0 || value === '.' || value === '..') return false
  if (value.includes('/') || value.includes('\\')) return false
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 32 || code === 127) return false
  }
  return true
}

function parseUsage(
  value: unknown,
): SessionCostModelUsage | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return null
  const record = value as Record<string, unknown>
  if (!finiteNonNegative(record.inputTokens)) return null
  if (!finiteNonNegative(record.outputTokens)) return null
  if (
    record.cacheReadInputTokens !== undefined &&
    !finiteNonNegative(record.cacheReadInputTokens)
  )
    return null
  if (
    record.cacheCreationInputTokens !== undefined &&
    !finiteNonNegative(record.cacheCreationInputTokens)
  )
    return null
  return {
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    cacheReadInputTokens: record.cacheReadInputTokens ?? 0,
    cacheCreationInputTokens: record.cacheCreationInputTokens ?? 0,
  }
}

export function parseSessionCostState(
  value: unknown,
): SessionCostState | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return null
  const record = value as Record<string, unknown>
  if (
    typeof record.models !== 'object' ||
    record.models === null ||
    Array.isArray(record.models)
  )
    return null
  const models: Record<string, SessionCostModelUsage> = {}
  for (const [model, usage] of Object.entries(record.models)) {
    if (!isValidModelLabel(model)) return null
    const parsed = parseUsage(usage)
    if (!parsed) return null
    models[model] = parsed
  }
  if (!finiteNonNegative(record.knownCostUsd)) return null
  if (typeof record.hasUnknownCost !== 'boolean') return null
  if (!finiteNonNegative(record.durationApiMs)) return null
  if (!finiteNonNegative(record.durationWallMs)) return null
  if (!finiteNonNegative(record.linesAdded)) return null
  if (!finiteNonNegative(record.linesRemoved)) return null
  return {
    models,
    knownCostUsd: record.knownCostUsd,
    hasUnknownCost: record.hasUnknownCost,
    durationApiMs: record.durationApiMs,
    durationWallMs: record.durationWallMs,
    linesAdded: record.linesAdded,
    linesRemoved: record.linesRemoved,
  }
}

function serializeSessionCostState(state: SessionCostState): string {
  return `${JSON.stringify(state, null, 2)}\n`
}

export class FileSystemTuiSessionCostStore implements TuiSessionCostStore {
  constructor(private readonly configRoot: string) {}

  async load(sessionId: string): Promise<SessionCostState> {
    if (!isClaudeSessionId(sessionId)) {
      throw new Error(`Invalid Claude session ID: ${sessionId}`)
    }
    const path = join(
      sessionCostDirectory(this.configRoot),
      `${sessionId}.json`,
    )
    let content: string
    try {
      content = await readFile(path, 'utf8')
    } catch {
      return createSessionCostState()
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(content)
    } catch {
      return createSessionCostState()
    }
    return parseSessionCostState(parsed) ?? createSessionCostState()
  }

  async save(sessionId: string, state: SessionCostState): Promise<void> {
    if (!isClaudeSessionId(sessionId)) {
      throw new Error(`Invalid Claude session ID: ${sessionId}`)
    }
    const validated = parseSessionCostState(state)
    if (!validated) {
      throw new Error(`Invalid session cost state for ${sessionId}`)
    }
    const path = join(
      sessionCostDirectory(this.configRoot),
      `${sessionId}.json`,
    )
    await writeFileAtomically(path, serializeSessionCostState(validated), {
      mode: 0o600,
    })
  }
}
