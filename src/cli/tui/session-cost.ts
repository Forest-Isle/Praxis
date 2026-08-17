import type { ModelUsage } from '../../core/runtime.js'

export const PROVIDER_DEFAULT_MODEL_LABEL = 'provider default'

export interface SessionCostModelUsage {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
}

export interface SessionCostState {
  models: Readonly<Record<string, SessionCostModelUsage>>
  knownCostUsd: number
  hasUnknownCost: boolean
  durationApiMs: number
  durationWallMs: number
  linesAdded: number
  linesRemoved: number
}

export interface SessionCostInput {
  usage: ModelUsage
  costUsd?: number
  durationApiMs?: number
  wallDurationMs?: number
  modelUsage?: Readonly<Record<string, Partial<ModelUsage>>>
  linesAdded?: number
  linesRemoved?: number
}

export function createSessionCostState(): SessionCostState {
  return {
    models: {},
    knownCostUsd: 0,
    hasUnknownCost: false,
    durationApiMs: 0,
    durationWallMs: 0,
    linesAdded: 0,
    linesRemoved: 0,
  }
}

function finite(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function knownCostUsd(value: number | undefined): number | null {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0
  ) {
    return null
  }
  return value
}

function mergeUsage(
  current: SessionCostModelUsage | undefined,
  usage: Partial<ModelUsage>,
): SessionCostModelUsage {
  const base =
    current ?? {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    }
  return {
    inputTokens: base.inputTokens + finite(usage.inputTokens),
    outputTokens: base.outputTokens + finite(usage.outputTokens),
    cacheReadInputTokens:
      base.cacheReadInputTokens + finite(usage.cacheReadInputTokens),
    cacheCreationInputTokens:
      base.cacheCreationInputTokens + finite(usage.cacheCreationInputTokens),
  }
}

export function accumulateSessionCost(
  state: SessionCostState,
  input: SessionCostInput,
): SessionCostState {
  const entries: ReadonlyArray<readonly [string, Partial<ModelUsage>]> =
    input.modelUsage !== undefined && Object.keys(input.modelUsage).length > 0
      ? Object.entries(input.modelUsage)
      : [[PROVIDER_DEFAULT_MODEL_LABEL, input.usage]]
  const models: Record<string, SessionCostModelUsage> = { ...state.models }
  for (const [model, usage] of entries) {
    models[model] = mergeUsage(models[model], usage)
  }
  const cost = knownCostUsd(input.costUsd)
  return {
    models,
    knownCostUsd:
      cost === null ? state.knownCostUsd : state.knownCostUsd + cost,
    hasUnknownCost: state.hasUnknownCost || cost === null,
    durationApiMs: state.durationApiMs + finite(input.durationApiMs),
    durationWallMs: state.durationWallMs + finite(input.wallDurationMs),
    linesAdded: state.linesAdded + finite(input.linesAdded),
    linesRemoved: state.linesRemoved + finite(input.linesRemoved),
  }
}

export function formatCostUsd(usd: number): string {
  const value = Number.isFinite(usd) ? Math.max(0, usd) : 0
  return `$${value.toFixed(value < 0.5 ? 4 : 2)}`
}

export function formatDuration(ms: number): string {
  const totalMs = Math.max(0, Math.round(Number.isFinite(ms) ? ms : 0))
  if (totalMs < 1000) return `${totalMs}ms`
  const totalSeconds = totalMs / 1000
  if (totalSeconds < 60) {
    const tenths = Math.round(totalSeconds * 10) / 10
    return Number.isInteger(tenths)
      ? `${tenths}s`
      : `${tenths.toFixed(1)}s`
  }
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = Math.round(totalSeconds % 60)
  if (minutes < 60) return `${minutes}m ${seconds}s`
  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  return `${hours}h ${restMinutes}m`
}

export function formatCount(value: number): string {
  const magnitude = Math.abs(Math.trunc(Number.isFinite(value) ? value : 0))
  const grouped = String(magnitude).replace(/\B(?=(\d{3})+(?!\d))/gu, ',')
  return value < 0 ? `-${grouped}` : grouped
}

function formatUsageLine(usage: SessionCostModelUsage): string {
  const parts = [
    `${formatCount(usage.inputTokens)} input`,
    `${formatCount(usage.outputTokens)} output`,
  ]
  if (usage.cacheReadInputTokens > 0) {
    parts.push(`${formatCount(usage.cacheReadInputTokens)} cache read`)
  }
  if (usage.cacheCreationInputTokens > 0) {
    parts.push(`${formatCount(usage.cacheCreationInputTokens)} cache creation`)
  }
  return parts.join(' · ')
}

export function formatSessionCostReport(state: SessionCostState): string {
  const lines = [
    `Total cost: ${formatCostUsd(state.knownCostUsd)}`,
    ...(state.hasUnknownCost
      ? ['(costs may be inaccurate due to usage of unknown models)']
      : []),
    `Total duration (API): ${formatDuration(state.durationApiMs)}`,
    `Total duration (wall): ${formatDuration(state.durationWallMs)}`,
    `Total code changes: ${formatCount(state.linesAdded)} lines added, ${formatCount(state.linesRemoved)} lines removed`,
    'Usage by model:',
  ]
  const models = Object.entries(state.models).sort(([left], [right]) =>
    left.localeCompare(right),
  )
  for (const [model, usage] of models) {
    lines.push(`  ${model}: ${formatUsageLine(usage)}`)
  }
  return lines.join('\n')
}
