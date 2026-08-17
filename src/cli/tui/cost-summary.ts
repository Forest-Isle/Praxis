/**
 * Pure formatter that renders an already-accumulated session cost summary as
 * Claude Code 2.1.208 `/cost` text. No I/O, no pricing, no provider logic, and
 * no mutable module state beyond the optional Intl formatter cache.
 */

export interface CostModelUsage {
  readonly model: string
  readonly canonicalName: string
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadInputTokens?: number
  readonly cacheCreationInputTokens?: number
  readonly webSearchRequests?: number
  readonly costUsd: number
}

export interface CostSummary {
  readonly totalCostUsd: number
  readonly apiDurationMs: number
  readonly wallDurationMs: number
  readonly linesAdded: number
  readonly linesRemoved: number
  readonly hasUnknownModelCost: boolean
  readonly modelUsage: readonly CostModelUsage[]
}

interface GroupedUsage {
  canonicalName: string
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  webSearchRequests: number
  costUsd: number
}

const LABEL_WIDTH = 23

const CLAUDE_MODEL_CANONICAL_ALIASES: Readonly<Record<string, string>> = {
  'claude-sonnet-4-20250514': 'claude-sonnet-4-0',
}

const compactFormatterCache = new Map<number, Intl.NumberFormat>()

function formatCompact(value: number): string {
  const minimumFractionDigits = value >= 1000 ? 1 : 0
  let formatter = compactFormatterCache.get(minimumFractionDigits)
  if (formatter === undefined) {
    formatter = new Intl.NumberFormat('en-US', {
      notation: 'compact',
      maximumFractionDigits: 1,
      minimumFractionDigits,
    })
    compactFormatterCache.set(minimumFractionDigits, formatter)
  }
  return formatter.format(value).toLowerCase()
}

function formatCost(costUsd: number): string {
  return costUsd > 0.5
    ? `$${(Math.round(costUsd * 100) / 100).toFixed(2)}`
    : `$${costUsd.toFixed(4)}`
}

function formatDuration(durationMs: number): string {
  if (durationMs === 0) {
    return '0s'
  }
  if (durationMs < 1) {
    return `${(durationMs / 1000).toFixed(1)}s`
  }
  if (durationMs < 60000) {
    return `${Math.floor(durationMs / 1000)}s`
  }

  const totalSeconds = durationMs / 1000
  let days = Math.floor(totalSeconds / 86400)
  let hours = Math.floor((totalSeconds % 86400) / 3600)
  let minutes = Math.floor((totalSeconds % 3600) / 60)
  let seconds = Math.round(totalSeconds % 60)

  if (seconds >= 60) {
    minutes += Math.floor(seconds / 60)
    seconds %= 60
  }
  if (minutes >= 60) {
    hours += Math.floor(minutes / 60)
    minutes %= 60
  }
  if (hours >= 24) {
    days += Math.floor(hours / 24)
    hours %= 24
  }

  if (days > 0) {
    return `${days}d ${hours}h ${minutes}m`
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`
  }
  return `${minutes}m ${seconds}s`
}

function formatCodeChanges(linesAdded: number, linesRemoved: number): string {
  const addedUnit = linesAdded === 1 ? 'line' : 'lines'
  const removedUnit = linesRemoved === 1 ? 'line' : 'lines'
  return `${linesAdded} ${addedUnit} added, ${linesRemoved} ${removedUnit} removed`
}

function formatUsage(
  inputTokens: number,
  outputTokens: number,
  cacheReadInputTokens: number,
  cacheCreationInputTokens: number,
): string {
  return `${formatCompact(inputTokens)} input, ${formatCompact(outputTokens)} output, ${formatCompact(cacheReadInputTokens)} cache read, ${formatCompact(cacheCreationInputTokens)} cache write`
}

function groupUsage(modelUsage: readonly CostModelUsage[]): GroupedUsage[] {
  const groups = new Map<string, GroupedUsage>()
  for (const usage of modelUsage) {
    let group = groups.get(usage.canonicalName)
    if (group === undefined) {
      group = {
        canonicalName: usage.canonicalName,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        webSearchRequests: 0,
        costUsd: 0,
      }
      groups.set(usage.canonicalName, group)
    }
    group.inputTokens += usage.inputTokens
    group.outputTokens += usage.outputTokens
    group.cacheReadInputTokens += usage.cacheReadInputTokens ?? 0
    group.cacheCreationInputTokens += usage.cacheCreationInputTokens ?? 0
    group.webSearchRequests += usage.webSearchRequests ?? 0
    group.costUsd += usage.costUsd
  }
  return [...groups.values()]
}

function assertFiniteNonNegative(
  value: unknown,
  field: string,
): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${field} must be a finite, non-negative number`)
  }
}

function assertInteger(value: unknown, field: string): asserts value is number {
  assertFiniteNonNegative(value, field)
  if (!Number.isInteger(value)) {
    throw new TypeError(`${field} must be a non-negative integer`)
  }
}

function validateUsage(usage: CostModelUsage): void {
  if (typeof usage !== 'object' || usage === null) {
    throw new TypeError('modelUsage entries must be objects')
  }
  if (typeof usage.model !== 'string' || usage.model.length === 0) {
    throw new TypeError('model must be a non-empty string')
  }
  if (
    typeof usage.canonicalName !== 'string' ||
    usage.canonicalName.length === 0
  ) {
    throw new TypeError('canonicalName must be a non-empty string')
  }
  assertInteger(usage.inputTokens, 'inputTokens')
  assertInteger(usage.outputTokens, 'outputTokens')
  if (usage.cacheReadInputTokens !== undefined) {
    assertInteger(usage.cacheReadInputTokens, 'cacheReadInputTokens')
  }
  if (usage.cacheCreationInputTokens !== undefined) {
    assertInteger(usage.cacheCreationInputTokens, 'cacheCreationInputTokens')
  }
  if (usage.webSearchRequests !== undefined) {
    assertInteger(usage.webSearchRequests, 'webSearchRequests')
  }
  assertFiniteNonNegative(usage.costUsd, 'costUsd')
}

function validateSummary(summary: CostSummary): void {
  if (typeof summary !== 'object' || summary === null) {
    throw new TypeError('summary must be a CostSummary object')
  }
  assertFiniteNonNegative(summary.totalCostUsd, 'totalCostUsd')
  assertFiniteNonNegative(summary.apiDurationMs, 'apiDurationMs')
  assertFiniteNonNegative(summary.wallDurationMs, 'wallDurationMs')
  assertInteger(summary.linesAdded, 'linesAdded')
  assertInteger(summary.linesRemoved, 'linesRemoved')
  if (typeof summary.hasUnknownModelCost !== 'boolean') {
    throw new TypeError('hasUnknownModelCost must be a boolean')
  }
  if (!Array.isArray(summary.modelUsage)) {
    throw new TypeError('modelUsage must be an array')
  }
  for (const usage of summary.modelUsage) {
    validateUsage(usage)
  }
}

/**
 * Canonicalizes the single dated Claude model alias observed in a Claude Code
 * 2.1.208 `/cost` fixture: `claude-sonnet-4-20250514` becomes
 * `claude-sonnet-4-0`. Every other model id, including already-canonical names
 * and unobserved dated Opus/Haiku/Sonnet ids, is returned byte-for-byte
 * unchanged.
 */
export function canonicalClaudeCostModelName(model: string): string {
  if (model.length === 0) {
    throw new TypeError('model must be a non-empty string')
  }
  return CLAUDE_MODEL_CANONICAL_ALIASES[model] ?? model
}

export function formatCostSummary(summary: CostSummary): string {
  validateSummary(summary)

  const totalCostText = formatCost(summary.totalCostUsd)
  const unknownModelWarning = summary.hasUnknownModelCost
    ? ' (costs may be inaccurate due to usage of unknown models)'
    : ''

  const lines: string[] = [
    `${'Total cost:'.padEnd(LABEL_WIDTH)}${totalCostText}${unknownModelWarning}`,
    `${'Total duration (API):'.padEnd(LABEL_WIDTH)}${formatDuration(summary.apiDurationMs)}`,
    `${'Total duration (wall):'.padEnd(LABEL_WIDTH)}${formatDuration(summary.wallDurationMs)}`,
    `${'Total code changes:'.padEnd(LABEL_WIDTH)}${formatCodeChanges(summary.linesAdded, summary.linesRemoved)}`,
  ]

  if (summary.modelUsage.length === 0) {
    lines.push(
      `${'Usage:'.padEnd(LABEL_WIDTH)}0 input, 0 output, 0 cache read, 0 cache write`,
    )
  } else {
    const groups = groupUsage(summary.modelUsage)

    lines.push('Usage by model:')

    for (const group of groups) {
      const nameLabel = `${group.canonicalName}:`.padStart(21)
      const webSearchText =
        group.webSearchRequests > 0
          ? `, ${formatCompact(group.webSearchRequests)} web search`
          : ''
      lines.push(
        `${nameLabel}  ${formatUsage(group.inputTokens, group.outputTokens, group.cacheReadInputTokens, group.cacheCreationInputTokens)}${webSearchText} (${formatCost(group.costUsd)})`,
      )
    }
  }

  return lines.join('\n')
}
