import type { ModelUsage } from '../core/runtime.js'
import type {
  ClaudeSessionCostState,
  ClaudeStoredModelCostUsage,
} from '../persistence/claude-cost-state-store.js'

export interface ClaudeSessionCostTrackerOptions {
  readonly sessionId: string
  readonly restored?: ClaudeSessionCostState | null
  readonly now?: () => number
}

export interface ClaudeSessionTurnInput {
  readonly model: string
  readonly usage: ModelUsage
  readonly costUsd?: number
  readonly webSearchRequests?: number
  readonly apiDurationMs?: number
  readonly apiDurationWithoutRetriesMs?: number
  readonly toolDurationMs?: number
  readonly linesAdded?: number
  readonly linesRemoved?: number
}

export interface ClaudeLineChangesInput {
  readonly linesAdded?: number
  readonly linesRemoved?: number
}

export interface ClaudeSessionDurationsInput {
  readonly apiDurationMs?: number
  readonly apiDurationWithoutRetriesMs?: number
  readonly toolDurationMs?: number
}

export interface ClaudeSessionCostSnapshot extends ClaudeSessionCostState {
  readonly hasUnknownModelCost: boolean
}

interface MutableModelCostUsage {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  webSearchRequests: number
  costUsd: number
}

function requireNonBlank(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must not be blank`)
  }
  return value
}

function requireCounter(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a nonnegative safe integer`)
  }
  return value
}

function requireMetric(value: number, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${field} must be a finite nonnegative number`)
  }
  return value
}

function requireCounterTotal(value: number, field: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${field} total must be a safe integer`)
  }
}

function requireMetricTotal(value: number, field: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${field} total must be a finite nonnegative number`)
  }
}

function emptyModelUsage(): MutableModelCostUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    webSearchRequests: 0,
    costUsd: 0,
  }
}

export class ClaudeSessionCostTracker {
  private readonly sessionId: string
  private readonly now: () => number
  private readonly modelUsage = new Map<string, MutableModelCostUsage>()
  private totalCostUsd: number
  private apiDurationMs: number
  private apiDurationWithoutRetriesMs: number
  private toolDurationMs: number
  private linesAdded: number
  private linesRemoved: number
  private hasUnknownModelCost = false
  private startTime: number

  constructor(options: ClaudeSessionCostTrackerOptions) {
    this.sessionId = requireNonBlank(options.sessionId, 'sessionId')
    this.now = options.now ?? Date.now

    const restored = options.restored ?? null
    if (restored === null) {
      this.totalCostUsd = 0
      this.apiDurationMs = 0
      this.apiDurationWithoutRetriesMs = 0
      this.toolDurationMs = 0
      this.linesAdded = 0
      this.linesRemoved = 0
      this.startTime = this.now()
      return
    }

    if (restored.sessionId !== this.sessionId) {
      throw new TypeError(
        'restored sessionId does not match the tracker sessionId',
      )
    }
    this.totalCostUsd = restored.totalCostUsd
    this.apiDurationMs = restored.apiDurationMs
    this.apiDurationWithoutRetriesMs = restored.apiDurationWithoutRetriesMs
    this.toolDurationMs = restored.toolDurationMs
    this.linesAdded = restored.linesAdded
    this.linesRemoved = restored.linesRemoved
    for (const [model, usage] of Object.entries(restored.modelUsage)) {
      this.modelUsage.set(model, {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadInputTokens: usage.cacheReadInputTokens,
        cacheCreationInputTokens: usage.cacheCreationInputTokens,
        webSearchRequests: usage.webSearchRequests,
        costUsd: usage.costUsd,
      })
    }
    const current = this.now()
    this.startTime =
      restored.wallDurationMs !== 0
        ? current - restored.wallDurationMs
        : current
  }

  recordTurn(input: ClaudeSessionTurnInput): void {
    const model = requireNonBlank(input.model, 'model')

    const inputTokens = requireCounter(
      input.usage.inputTokens,
      'usage.inputTokens',
    )
    const outputTokens = requireCounter(
      input.usage.outputTokens,
      'usage.outputTokens',
    )
    const cacheReadInputTokens =
      input.usage.cacheReadInputTokens === undefined
        ? 0
        : requireCounter(
            input.usage.cacheReadInputTokens,
            'usage.cacheReadInputTokens',
          )
    const cacheCreationInputTokens =
      input.usage.cacheCreationInputTokens === undefined
        ? 0
        : requireCounter(
            input.usage.cacheCreationInputTokens,
            'usage.cacheCreationInputTokens',
          )

    const webSearchRequests =
      input.webSearchRequests === undefined
        ? 0
        : requireCounter(input.webSearchRequests, 'webSearchRequests')

    const costUsd =
      input.costUsd === undefined
        ? undefined
        : requireMetric(input.costUsd, 'costUsd')

    const apiDurationMs =
      input.apiDurationMs === undefined
        ? 0
        : requireMetric(input.apiDurationMs, 'apiDurationMs')
    const apiDurationWithoutRetriesMs =
      input.apiDurationWithoutRetriesMs === undefined
        ? apiDurationMs
        : requireMetric(
            input.apiDurationWithoutRetriesMs,
            'apiDurationWithoutRetriesMs',
          )
    const toolDurationMs =
      input.toolDurationMs === undefined
        ? 0
        : requireMetric(input.toolDurationMs, 'toolDurationMs')

    const linesAdded =
      input.linesAdded === undefined
        ? 0
        : requireCounter(input.linesAdded, 'linesAdded')
    const linesRemoved =
      input.linesRemoved === undefined
        ? 0
        : requireCounter(input.linesRemoved, 'linesRemoved')

    const existing = this.modelUsage.get(model) ?? emptyModelUsage()

    const newInputTokens = existing.inputTokens + inputTokens
    const newOutputTokens = existing.outputTokens + outputTokens
    const newCacheReadInputTokens =
      existing.cacheReadInputTokens + cacheReadInputTokens
    const newCacheCreationInputTokens =
      existing.cacheCreationInputTokens + cacheCreationInputTokens
    const newWebSearchRequests = existing.webSearchRequests + webSearchRequests

    requireCounterTotal(newInputTokens, 'inputTokens')
    requireCounterTotal(newOutputTokens, 'outputTokens')
    requireCounterTotal(newCacheReadInputTokens, 'cacheReadInputTokens')
    requireCounterTotal(newCacheCreationInputTokens, 'cacheCreationInputTokens')
    requireCounterTotal(newWebSearchRequests, 'webSearchRequests')

    const hasUsage =
      inputTokens > 0 ||
      outputTokens > 0 ||
      cacheReadInputTokens > 0 ||
      cacheCreationInputTokens > 0 ||
      webSearchRequests > 0

    const newCostUsd =
      costUsd === undefined ? existing.costUsd : existing.costUsd + costUsd
    requireMetricTotal(newCostUsd, 'costUsd')

    const newTotalCostUsd =
      costUsd === undefined ? this.totalCostUsd : this.totalCostUsd + costUsd
    requireMetricTotal(newTotalCostUsd, 'totalCostUsd')

    const durationTotals = this.durationTotals({
      apiDurationMs,
      apiDurationWithoutRetriesMs,
      toolDurationMs,
    })

    const newLinesAdded = this.linesAdded + linesAdded
    const newLinesRemoved = this.linesRemoved + linesRemoved
    requireCounterTotal(newLinesAdded, 'linesAdded')
    requireCounterTotal(newLinesRemoved, 'linesRemoved')

    // Every metric validated; commit atomically.
    if (costUsd === undefined && hasUsage) {
      this.hasUnknownModelCost = true
    }
    this.modelUsage.set(model, {
      inputTokens: newInputTokens,
      outputTokens: newOutputTokens,
      cacheReadInputTokens: newCacheReadInputTokens,
      cacheCreationInputTokens: newCacheCreationInputTokens,
      webSearchRequests: newWebSearchRequests,
      costUsd: newCostUsd,
    })
    this.totalCostUsd = newTotalCostUsd
    this.apiDurationMs = durationTotals.apiDurationMs
    this.apiDurationWithoutRetriesMs =
      durationTotals.apiDurationWithoutRetriesMs
    this.toolDurationMs = durationTotals.toolDurationMs
    this.linesAdded = newLinesAdded
    this.linesRemoved = newLinesRemoved
  }

  recordDurations(input: ClaudeSessionDurationsInput): void {
    const apiDurationMs =
      input.apiDurationMs === undefined
        ? undefined
        : requireMetric(input.apiDurationMs, 'apiDurationMs')
    const apiDurationWithoutRetriesMs =
      input.apiDurationWithoutRetriesMs === undefined
        ? undefined
        : requireMetric(
            input.apiDurationWithoutRetriesMs,
            'apiDurationWithoutRetriesMs',
          )
    const toolDurationMs =
      input.toolDurationMs === undefined
        ? undefined
        : requireMetric(input.toolDurationMs, 'toolDurationMs')

    // Legacy fallback: a supplied API duration implies the retry-free total
    // when the retry-free value is absent.
    const resolvedApiDurationWithoutRetriesMs =
      apiDurationMs !== undefined && apiDurationWithoutRetriesMs === undefined
        ? apiDurationMs
        : apiDurationWithoutRetriesMs

    const durationTotals = this.durationTotals({
      apiDurationMs,
      apiDurationWithoutRetriesMs: resolvedApiDurationWithoutRetriesMs,
      toolDurationMs,
    })

    this.apiDurationMs = durationTotals.apiDurationMs
    this.apiDurationWithoutRetriesMs =
      durationTotals.apiDurationWithoutRetriesMs
    this.toolDurationMs = durationTotals.toolDurationMs
  }

  private durationTotals(options: {
    apiDurationMs: number | undefined
    apiDurationWithoutRetriesMs: number | undefined
    toolDurationMs: number | undefined
  }): {
    apiDurationMs: number
    apiDurationWithoutRetriesMs: number
    toolDurationMs: number
  } {
    const { apiDurationMs, apiDurationWithoutRetriesMs, toolDurationMs } =
      options

    const newApiDurationMs =
      apiDurationMs === undefined
        ? this.apiDurationMs
        : this.apiDurationMs + apiDurationMs
    const newApiDurationWithoutRetriesMs =
      apiDurationWithoutRetriesMs === undefined
        ? this.apiDurationWithoutRetriesMs
        : this.apiDurationWithoutRetriesMs + apiDurationWithoutRetriesMs
    const newToolDurationMs =
      toolDurationMs === undefined
        ? this.toolDurationMs
        : this.toolDurationMs + toolDurationMs

    if (apiDurationMs !== undefined) {
      requireMetricTotal(newApiDurationMs, 'apiDurationMs')
    }
    if (apiDurationWithoutRetriesMs !== undefined) {
      requireMetricTotal(
        newApiDurationWithoutRetriesMs,
        'apiDurationWithoutRetriesMs',
      )
    }
    if (toolDurationMs !== undefined) {
      requireMetricTotal(newToolDurationMs, 'toolDurationMs')
    }

    return {
      apiDurationMs: newApiDurationMs,
      apiDurationWithoutRetriesMs: newApiDurationWithoutRetriesMs,
      toolDurationMs: newToolDurationMs,
    }
  }

  recordLineChanges(input: ClaudeLineChangesInput): void {
    const linesAdded =
      input.linesAdded === undefined
        ? 0
        : requireCounter(input.linesAdded, 'linesAdded')
    const linesRemoved =
      input.linesRemoved === undefined
        ? 0
        : requireCounter(input.linesRemoved, 'linesRemoved')

    const newLinesAdded = this.linesAdded + linesAdded
    const newLinesRemoved = this.linesRemoved + linesRemoved
    requireCounterTotal(newLinesAdded, 'linesAdded')
    requireCounterTotal(newLinesRemoved, 'linesRemoved')

    this.linesAdded = newLinesAdded
    this.linesRemoved = newLinesRemoved
  }

  snapshot(): ClaudeSessionCostSnapshot {
    const modelUsage: Record<string, ClaudeStoredModelCostUsage> = {}
    for (const [model, usage] of this.modelUsage) {
      modelUsage[model] = { ...usage }
    }
    return {
      sessionId: this.sessionId,
      totalCostUsd: this.totalCostUsd,
      apiDurationMs: this.apiDurationMs,
      apiDurationWithoutRetriesMs: this.apiDurationWithoutRetriesMs,
      toolDurationMs: this.toolDurationMs,
      wallDurationMs: this.now() - this.startTime,
      linesAdded: this.linesAdded,
      linesRemoved: this.linesRemoved,
      modelUsage,
      hasUnknownModelCost: this.hasUnknownModelCost,
    }
  }
}
