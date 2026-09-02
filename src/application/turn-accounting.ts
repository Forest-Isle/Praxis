import type { ModelUsage } from '../core/runtime.js'
import { usageCostUsd } from '../core/usage.js'
import type { ModelPricingRegistry } from '../core/usage.js'
import {
  ClaudeSessionCostTracker,
  type ClaudeSessionDurationsInput,
  type ClaudeSessionTurnInput,
} from './session-cost-tracker.js'

export interface TurnToolMetric {
  readonly isError: boolean
  readonly usage?: ModelUsage
  readonly modelUsage?: Readonly<Record<string, ModelUsage>>
  readonly durationApiMs?: number
  readonly durationApiWithoutRetriesMs?: number
  readonly durationToolMs?: number
  readonly linesAdded?: number
  readonly linesRemoved?: number
}

export interface TurnRuntimeMetric {
  readonly usage: ModelUsage
  readonly modelUsage?: Readonly<Record<string, ModelUsage>>
  readonly durationApiMs?: number
  readonly durationApiWithoutRetriesMs?: number
  readonly durationToolMs?: number
  readonly linesAdded?: number
  readonly linesRemoved?: number
  readonly unrecordedModelUsage?: Readonly<Record<string, ModelUsage>>
  readonly unrecordedDurationApiMs?: number
  readonly unrecordedDurationApiWithoutRetriesMs?: number
}

export interface TurnCompactionMetric {
  readonly usage: ModelUsage
  readonly model?: string
  readonly durationApiMs: number
  readonly durationApiWithoutRetriesMs: number
}

export interface TurnRuntimeCompletion {
  readonly kind: 'runtime'
  readonly recovery: readonly TurnToolMetric[]
  readonly result: TurnRuntimeMetric
}

export interface TurnShellCompletion {
  readonly kind: 'shell'
  readonly recovery: readonly TurnToolMetric[]
  readonly result: TurnToolMetric
}

export type TurnAccountingCompletion =
  TurnRuntimeCompletion | TurnShellCompletion

export interface TurnAccountingOutcome {
  readonly usage: ModelUsage
  readonly modelUsage?: Readonly<Record<string, ModelUsage>>
  readonly costUsd?: number
  readonly durationApiMs?: number
}

export interface PreparedCompactionAccounting {
  readonly commit: () => void
}

const counterFields = [
  'inputTokens',
  'outputTokens',
  'cacheReadInputTokens',
  'cacheCreationInputTokens',
  'webSearchRequests',
] as const

const metadataFields = ['contextWindow', 'maxOutputTokens'] as const

function clone<T>(value: T): T {
  return structuredClone(value)
}

function mergeUsage(left: ModelUsage, right: ModelUsage): ModelUsage {
  for (const [usage, prefix] of [
    [left, 'usage.left'],
    [right, 'usage.right'],
  ] as const) {
    for (const field of counterFields) {
      const value = usage[field]
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
        throw new TypeError(
          `${prefix}.${field} must be a nonnegative safe integer`,
        )
      }
    }
  }
  const cacheReadInputTokens =
    (left.cacheReadInputTokens ?? 0) + (right.cacheReadInputTokens ?? 0)
  const cacheCreationInputTokens =
    (left.cacheCreationInputTokens ?? 0) + (right.cacheCreationInputTokens ?? 0)
  const webSearchRequests =
    (left.webSearchRequests ?? 0) + (right.webSearchRequests ?? 0)
  if (
    !Number.isSafeInteger(left.inputTokens + right.inputTokens) ||
    !Number.isSafeInteger(left.outputTokens + right.outputTokens) ||
    !Number.isSafeInteger(cacheReadInputTokens) ||
    !Number.isSafeInteger(cacheCreationInputTokens) ||
    !Number.isSafeInteger(webSearchRequests)
  ) {
    throw new Error('Model usage total overflow')
  }
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    ...(cacheReadInputTokens === 0 ? {} : { cacheReadInputTokens }),
    ...(cacheCreationInputTokens === 0 ? {} : { cacheCreationInputTokens }),
    ...(webSearchRequests === 0 ? {} : { webSearchRequests }),
  }
}

function assertValidSessionUsageEntry(model: string, usage: ModelUsage): void {
  if (model.trim() === '') {
    throw new Error('Model usage breakdown contains a blank model name')
  }
  for (const field of counterFields) {
    const value = usage[field]
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new Error(
        `Model usage for "${model}" has an invalid ${field} counter`,
      )
    }
  }
  for (const field of metadataFields) {
    const value = usage[field]
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
      throw new Error(
        `Model usage for "${model}" has an invalid ${field} metadata value`,
      )
    }
  }
}

function mergeSessionUsageMetadataField(
  model: string,
  field: string,
  left: number | undefined,
  right: number | undefined,
): number | undefined {
  if (left === undefined) return right
  if (right === undefined) return left
  if (left !== right) {
    throw new Error(
      `Model usage for "${model}" has conflicting ${field} values: ${left} vs ${right}`,
    )
  }
  return left
}

function mergeSessionUsageMetadata(
  model: string,
  left: ModelUsage,
  right: ModelUsage,
): { contextWindow?: number; maxOutputTokens?: number } {
  const contextWindow = mergeSessionUsageMetadataField(
    model,
    'contextWindow',
    left.contextWindow,
    right.contextWindow,
  )
  const maxOutputTokens = mergeSessionUsageMetadataField(
    model,
    'maxOutputTokens',
    left.maxOutputTokens,
    right.maxOutputTokens,
  )
  return {
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
  }
}

function addSessionUsageChecked(
  model: string,
  left: ModelUsage,
  right: ModelUsage,
): ModelUsage {
  const inputTokens = left.inputTokens + right.inputTokens
  const outputTokens = left.outputTokens + right.outputTokens
  const cacheReadInputTokens =
    (left.cacheReadInputTokens ?? 0) + (right.cacheReadInputTokens ?? 0)
  const cacheCreationInputTokens =
    (left.cacheCreationInputTokens ?? 0) + (right.cacheCreationInputTokens ?? 0)
  const webSearchRequests =
    (left.webSearchRequests ?? 0) + (right.webSearchRequests ?? 0)
  if (
    !Number.isSafeInteger(inputTokens) ||
    !Number.isSafeInteger(outputTokens) ||
    !Number.isSafeInteger(cacheReadInputTokens) ||
    !Number.isSafeInteger(cacheCreationInputTokens) ||
    !Number.isSafeInteger(webSearchRequests)
  ) {
    throw new Error('Model usage total overflow')
  }
  const metadata = mergeSessionUsageMetadata(model, left, right)
  return {
    inputTokens,
    outputTokens,
    ...(cacheReadInputTokens === 0 ? {} : { cacheReadInputTokens }),
    ...(cacheCreationInputTokens === 0 ? {} : { cacheCreationInputTokens }),
    ...(webSearchRequests === 0 ? {} : { webSearchRequests }),
    ...metadata,
  }
}

function mergeModelUsage(
  ...parts: readonly (Readonly<Record<string, ModelUsage>> | undefined)[]
): Readonly<Record<string, ModelUsage>> | undefined {
  const merged = new Map<string, ModelUsage>()
  for (const part of parts) {
    if (part === undefined) continue
    for (const [model, usage] of Object.entries(part)) {
      assertValidSessionUsageEntry(model, usage)
      const existing = merged.get(model)
      merged.set(
        model,
        existing === undefined
          ? { ...usage }
          : addSessionUsageChecked(model, existing, usage),
      )
    }
  }
  return merged.size === 0 ? undefined : Object.fromEntries(merged)
}

function hasNonZeroUsage(usage: ModelUsage): boolean {
  return (
    usage.inputTokens > 0 ||
    usage.outputTokens > 0 ||
    (usage.cacheReadInputTokens ?? 0) > 0 ||
    (usage.cacheCreationInputTokens ?? 0) > 0 ||
    (usage.webSearchRequests ?? 0) > 0
  )
}

function validateMetricUsage(usage: ModelUsage): void {
  for (const field of ['inputTokens', 'outputTokens'] as const) {
    const value = usage[field]
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`usage.${field} must be a nonnegative safe integer`)
    }
  }
  for (const field of counterFields.slice(2)) {
    const value = usage[field]
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new TypeError(`usage.${field} must be a nonnegative safe integer`)
    }
  }
}

function requireMetric(value: number, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${field} must be a finite nonnegative number`)
  }
  return value
}

function addMetric(
  value: number | undefined,
  total: number,
  field: string,
): number {
  if (value === undefined) return total
  const next = total + requireMetric(value, field)
  if (!Number.isFinite(next) || next < 0) {
    throw new TypeError(`${field} total overflow`)
  }
  return next
}

function addLines(
  value: number | undefined,
  total: number,
  field: string,
): number {
  if (value === undefined) return total
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a nonnegative safe integer`)
  }
  const next = total + value
  if (!Number.isSafeInteger(next) || next < 0) {
    throw new TypeError(`${field} total must be a nonnegative safe integer`)
  }
  return next
}

function costForModelUsage(
  modelUsage: Readonly<Record<string, ModelUsage>> | undefined,
  pricing: ModelPricingRegistry | undefined,
): number | undefined {
  if (modelUsage === undefined) return undefined
  let costUsd: number | undefined
  for (const [model, usage] of Object.entries(modelUsage)) {
    const resolved = pricing?.resolve(model)
    if (resolved !== undefined) {
      costUsd = (costUsd ?? 0) + usageCostUsd(usage, resolved)
    }
  }
  return costUsd
}

interface TrackerPlan {
  readonly turnInputs: readonly ClaudeSessionTurnInput[]
  readonly durations?: ClaudeSessionDurationsInput
  readonly linesAdded: number
  readonly linesRemoved: number
}

interface CompactionState {
  readonly usage: ModelUsage
  readonly modelUsage: Readonly<Record<string, ModelUsage>> | undefined
  readonly durationApiMs: number
  readonly durationApiWithoutRetriesMs: number
}

function applyPlan(tracker: ClaudeSessionCostTracker, plan: TrackerPlan): void {
  for (const input of plan.turnInputs) tracker.recordTurn(input)
  if (plan.durations !== undefined) tracker.recordDurations(plan.durations)
  if (plan.linesAdded !== 0 || plan.linesRemoved !== 0) {
    tracker.recordLineChanges({
      ...(plan.linesAdded === 0 ? {} : { linesAdded: plan.linesAdded }),
      ...(plan.linesRemoved === 0 ? {} : { linesRemoved: plan.linesRemoved }),
    })
  }
}

function cloneTracker(
  tracker: ClaudeSessionCostTracker,
): ClaudeSessionCostTracker {
  const snapshot = tracker.snapshot()
  return new ClaudeSessionCostTracker({
    sessionId: snapshot.sessionId,
    restored: snapshot,
  })
}

export class TurnAccounting {
  private readonly tracker: ClaudeSessionCostTracker
  private readonly pricing: ModelPricingRegistry | undefined
  private compactionUsage: ModelUsage = {
    inputTokens: 0,
    outputTokens: 0,
  }
  private compactionModelUsage: Readonly<Record<string, ModelUsage>> | undefined
  private compactionDurationMs = 0
  private compactionDurationWithoutRetriesMs = 0
  private hasCompaction = false
  private outstandingCompaction = false
  private completed = false

  constructor(options: {
    readonly tracker: ClaudeSessionCostTracker
    readonly pricing?: ModelPricingRegistry
  }) {
    this.tracker = options.tracker
    this.pricing = options.pricing
  }

  prepareCompaction(input: TurnCompactionMetric): PreparedCompactionAccounting {
    if (this.completed) {
      throw new Error('Cannot prepare compaction after turn completion')
    }
    if (this.outstandingCompaction) {
      throw new Error('A compaction accounting plan is already outstanding')
    }
    const snapshot = clone(input)
    this.compactionStateAfter(snapshot)
    const plan = this.compactionPlan(snapshot)
    const preflight = cloneTracker(this.tracker)
    applyPlan(preflight, plan)
    this.outstandingCompaction = true
    let consumed = false
    return {
      commit: () => {
        if (consumed)
          throw new Error(
            'Prepared compaction accounting was already committed',
          )
        consumed = true
        try {
          const latestState = this.compactionStateAfter(snapshot)
          const latestPlan = this.compactionPlan(snapshot)
          const latestPreflight = cloneTracker(this.tracker)
          applyPlan(latestPreflight, latestPlan)
          applyPlan(this.tracker, latestPlan)
          this.compactionUsage = clone(latestState.usage)
          this.compactionModelUsage = clone(latestState.modelUsage)
          this.compactionDurationMs = latestState.durationApiMs
          this.compactionDurationWithoutRetriesMs =
            latestState.durationApiWithoutRetriesMs
          this.hasCompaction = true
        } finally {
          this.outstandingCompaction = false
        }
      },
    }
  }

  complete(input: TurnAccountingCompletion): TurnAccountingOutcome {
    if (this.completed) {
      throw new Error('Turn accounting is already complete')
    }
    if (this.outstandingCompaction) {
      throw new Error(
        'Cannot complete a turn while compaction accounting is outstanding',
      )
    }
    const snapshot = clone(input)
    const aggregate = this.aggregate(snapshot)
    const plan = this.trackerPlan(snapshot)
    const preflight = cloneTracker(this.tracker)
    applyPlan(preflight, plan)
    applyPlan(this.tracker, plan)
    this.completed = true
    return clone({
      usage: aggregate.usage,
      ...(aggregate.modelUsage === undefined
        ? {}
        : { modelUsage: aggregate.modelUsage }),
      ...(aggregate.costUsd === undefined
        ? {}
        : { costUsd: aggregate.costUsd }),
      ...(aggregate.durationApiMs === undefined
        ? {}
        : { durationApiMs: aggregate.durationApiMs }),
    })
  }

  private compactionStateAfter(input: TurnCompactionMetric): CompactionState {
    validateMetricUsage(input.usage)
    requireMetric(input.durationApiMs, 'compaction durationMs')
    requireMetric(
      input.durationApiWithoutRetriesMs,
      'compaction durationWithoutRetriesMs',
    )
    const meaningfulUsage = hasNonZeroUsage(input.usage)
    if (
      meaningfulUsage &&
      (input.model === undefined || input.model.trim() === '')
    ) {
      throw new Error('Auto compact usage requires a nonblank model identity')
    }
    const modelUsage =
      input.model !== undefined && input.model.trim() !== ''
        ? { [input.model]: input.usage }
        : undefined
    return {
      usage: mergeUsage(this.compactionUsage, input.usage),
      modelUsage: mergeModelUsage(this.compactionModelUsage, modelUsage),
      durationApiMs: addMetric(
        input.durationApiMs,
        this.compactionDurationMs,
        'compaction durationMs',
      ),
      durationApiWithoutRetriesMs: addMetric(
        input.durationApiWithoutRetriesMs,
        this.compactionDurationWithoutRetriesMs,
        'compaction durationWithoutRetriesMs',
      ),
    }
  }

  private compactionPlan(input: TurnCompactionMetric): TrackerPlan {
    const turnInputs: ClaudeSessionTurnInput[] = []
    if (hasNonZeroUsage(input.usage)) {
      const model = input.model
      if (model === undefined || model.trim() === '') {
        throw new Error('Auto compact usage requires a nonblank model identity')
      }
      const costUsd = this.pricing
        ? costForModelUsage({ [model]: input.usage }, this.pricing)
        : undefined
      turnInputs.push({
        model,
        usage: input.usage,
        ...(costUsd === undefined ? {} : { costUsd }),
        ...(input.usage.webSearchRequests === undefined
          ? {}
          : { webSearchRequests: input.usage.webSearchRequests }),
      })
    }
    const durations: ClaudeSessionDurationsInput = {
      ...(input.durationApiMs === 0
        ? {}
        : { apiDurationMs: input.durationApiMs }),
      apiDurationWithoutRetriesMs: input.durationApiWithoutRetriesMs,
    }
    return {
      turnInputs,
      durations,
      linesAdded: 0,
      linesRemoved: 0,
    }
  }

  private aggregate(input: TurnAccountingCompletion): {
    usage: ModelUsage
    modelUsage?: Readonly<Record<string, ModelUsage>>
    costUsd?: number
    durationApiMs?: number
  } {
    if (input.kind === 'runtime') {
      requireMetric(input.result.durationApiMs ?? 0, 'durationApiMs')
      requireMetric(
        input.result.durationApiWithoutRetriesMs ?? 0,
        'durationApiWithoutRetriesMs',
      )
    }
    if (input.kind === 'shell') {
      if (input.result.durationApiMs !== undefined)
        requireMetric(input.result.durationApiMs, 'durationApiMs')
      if (input.result.durationApiWithoutRetriesMs !== undefined)
        requireMetric(
          input.result.durationApiWithoutRetriesMs,
          'durationApiWithoutRetriesMs',
        )
    }
    const recoveryUsage = input.recovery.reduce(
      (total, result) =>
        result.usage ? mergeUsage(total, result.usage) : total,
      { inputTokens: 0, outputTokens: 0 },
    )
    const recoveryModelUsage = mergeModelUsage(
      ...input.recovery.map((result) =>
        result.isError ? undefined : result.modelUsage,
      ),
    )
    const resultUsage = input.result.usage ?? {
      inputTokens: 0,
      outputTokens: 0,
    }
    const usage =
      input.kind === 'runtime'
        ? mergeUsage(
            mergeUsage(recoveryUsage, this.compactionUsage),
            resultUsage,
          )
        : mergeUsage(recoveryUsage, resultUsage)
    const modelUsage = mergeModelUsage(
      recoveryModelUsage,
      ...(input.kind === 'runtime' ? [this.compactionModelUsage] : []),
      input.kind === 'runtime'
        ? input.result.modelUsage
        : input.result.isError
          ? undefined
          : input.result.modelUsage,
    )
    const hasDuration =
      input.kind === 'runtime' &&
      (this.hasCompaction || input.result.durationApiMs !== undefined)
    const durationApiMs =
      input.kind === 'runtime' && hasDuration
        ? addMetric(
            input.result.durationApiMs,
            this.compactionDurationMs,
            'durationApiMs',
          )
        : input.result.durationApiMs
    const costUsd = costForModelUsage(modelUsage, this.pricing)
    return {
      usage,
      ...(modelUsage === undefined ? {} : { modelUsage }),
      ...(costUsd === undefined ? {} : { costUsd }),
      ...(durationApiMs === undefined ? {} : { durationApiMs }),
    }
  }

  private trackerPlan(input: TurnAccountingCompletion): TrackerPlan {
    const turnInputs: ClaudeSessionTurnInput[] = []
    const lines = { linesAdded: 0, linesRemoved: 0 }
    let toolDurationMs = 0
    for (const result of input.recovery) {
      toolDurationMs = addMetric(
        result.durationToolMs,
        toolDurationMs,
        'durationToolMs',
      )
      if (!result.isError) {
        lines.linesAdded = addLines(
          result.linesAdded,
          lines.linesAdded,
          'linesAdded',
        )
        lines.linesRemoved = addLines(
          result.linesRemoved,
          lines.linesRemoved,
          'linesRemoved',
        )
      }
    }
    const trackedModelUsage =
      input.kind === 'shell'
        ? mergeModelUsage(
            ...input.recovery.map((result) =>
              result.isError ? undefined : result.modelUsage,
            ),
            input.result.isError ? undefined : input.result.modelUsage,
          )
        : mergeModelUsage(
            ...input.recovery.map((result) =>
              result.isError ? undefined : result.modelUsage,
            ),
            input.result.unrecordedModelUsage ?? input.result.modelUsage,
          )
    if (trackedModelUsage !== undefined) {
      this.appendModelInputs(turnInputs, trackedModelUsage)
    }
    if (input.kind === 'shell') {
      toolDurationMs = addMetric(
        input.result.durationToolMs,
        toolDurationMs,
        'durationToolMs',
      )
      if (!input.result.isError) {
        lines.linesAdded = addLines(
          input.result.linesAdded,
          lines.linesAdded,
          'linesAdded',
        )
        lines.linesRemoved = addLines(
          input.result.linesRemoved,
          lines.linesRemoved,
          'linesRemoved',
        )
      }
      return {
        turnInputs,
        durations: {
          ...(input.result.durationApiMs === undefined
            ? {}
            : { apiDurationMs: input.result.durationApiMs }),
          ...(input.result.durationApiWithoutRetriesMs === undefined
            ? {}
            : {
                apiDurationWithoutRetriesMs:
                  input.result.durationApiWithoutRetriesMs,
              }),
          ...(toolDurationMs === 0 ? {} : { toolDurationMs }),
        },
        ...lines,
      }
    }
    toolDurationMs = addMetric(
      input.result.durationToolMs,
      toolDurationMs,
      'durationToolMs',
    )
    lines.linesAdded = addLines(
      input.result.linesAdded,
      lines.linesAdded,
      'linesAdded',
    )
    lines.linesRemoved = addLines(
      input.result.linesRemoved,
      lines.linesRemoved,
      'linesRemoved',
    )
    const trackedDurationApiMs =
      input.result.unrecordedDurationApiMs ?? input.result.durationApiMs
    const trackedDurationApiWithoutRetriesMs =
      input.result.unrecordedDurationApiWithoutRetriesMs ??
      input.result.durationApiWithoutRetriesMs
    return {
      turnInputs,
      durations: {
        ...(trackedDurationApiMs === undefined
          ? {}
          : { apiDurationMs: trackedDurationApiMs }),
        ...(trackedDurationApiWithoutRetriesMs === undefined
          ? {}
          : {
              apiDurationWithoutRetriesMs: trackedDurationApiWithoutRetriesMs,
            }),
        ...(toolDurationMs === 0 ? {} : { toolDurationMs }),
      },
      ...lines,
    }
  }

  private appendModelInputs(
    target: ClaudeSessionTurnInput[],
    modelUsage: Readonly<Record<string, ModelUsage>>,
  ): void {
    for (const [model, usage] of Object.entries(modelUsage)) {
      const costUsd = this.pricing
        ? costForModelUsage({ [model]: usage }, this.pricing)
        : undefined
      target.push({
        model,
        usage,
        ...(costUsd === undefined ? {} : { costUsd }),
        ...(usage.webSearchRequests === undefined
          ? {}
          : { webSearchRequests: usage.webSearchRequests }),
      })
    }
  }
}
