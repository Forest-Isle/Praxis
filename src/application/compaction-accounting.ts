import { createHash, randomUUID } from 'node:crypto'
import type { TranscriptEvent } from '../core/transcript-event.js'
import type { ModelPricingRegistry } from '../core/usage.js'
import { usageCostUsd } from '../core/usage.js'
import type { ClaudeCostStateStore } from '../persistence/claude-cost-state-store.js'
import type {
  CompactionReceiptStore,
  NativeCompactionReceipt,
} from '../persistence/native-compaction-receipt-store.js'
import type { ClaudeSessionCostSnapshot } from './session-cost-tracker.js'
import { ClaudeSessionCostTracker } from './session-cost-tracker.js'
import type { TurnCompactionMetric } from './turn-accounting.js'
import {
  CompactionTransactionError,
  type CompactionTrigger,
} from './compaction-errors.js'

export interface CompactionAccountingOptions {
  readonly sessionId: string
  readonly tracker: ClaudeSessionCostTracker
  readonly pricing?: ModelPricingRegistry
  readonly receiptStore?: CompactionReceiptStore
  readonly costStateStore?: Pick<ClaudeCostStateStore, 'save'>
  readonly readTranscript?: () => Promise<readonly TranscriptEvent[]>
  readonly createId?: () => string
}

export interface PreparedCompactionTransaction {
  readonly receiptId: string
  readonly boundaryId: string
  readonly summaryId: string
  readonly commit: (receipt: {
    readonly kind: 'compaction'
    readonly boundaryId: string
    readonly summaryId: string
  }) => Promise<void>
}

function clone<T>(value: T): T {
  return structuredClone(value)
}
function validTransactionId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value)
}
function fingerprint(snapshot: ClaudeSessionCostSnapshot): string {
  const modelUsage = Object.fromEntries(
    Object.entries(snapshot.modelUsage).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  )
  const stable = {
    sessionId: snapshot.sessionId,
    totalCostUsd: snapshot.totalCostUsd,
    apiDurationMs: snapshot.apiDurationMs,
    apiDurationWithoutRetriesMs: snapshot.apiDurationWithoutRetriesMs,
    toolDurationMs: snapshot.toolDurationMs,
    linesAdded: snapshot.linesAdded,
    linesRemoved: snapshot.linesRemoved,
    modelUsage,
    hasUnknownModelCost: snapshot.hasUnknownModelCost,
  }
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex')
}
function meaningful(usage: TurnCompactionMetric['usage']): boolean {
  return [
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheReadInputTokens,
    usage.cacheCreationInputTokens,
    usage.cacheCreationInputTokens1h,
    usage.webSearchRequests,
  ].some((value) => typeof value === 'number' && value > 0)
}
function applyMetric(
  tracker: ClaudeSessionCostTracker,
  metric: TurnCompactionMetric,
  costUsd: number | null,
): void {
  if (meaningful(metric.usage)) {
    if (!metric.model?.trim())
      throw new TypeError(
        'Auto compact usage requires a nonblank model identity',
      )
    tracker.recordTurn({
      model: metric.model,
      usage: metric.usage,
      ...(costUsd === null ? {} : { costUsd }),
      ...(metric.usage.webSearchRequests === undefined
        ? {}
        : { webSearchRequests: metric.usage.webSearchRequests }),
      apiDurationMs: metric.durationApiMs,
      apiDurationWithoutRetriesMs: metric.durationApiWithoutRetriesMs,
    })
  } else
    tracker.recordDurations({
      apiDurationMs: metric.durationApiMs,
      apiDurationWithoutRetriesMs: metric.durationApiWithoutRetriesMs,
    })
}
function compactPair(
  events: readonly TranscriptEvent[],
  receipt: NativeCompactionReceipt,
): number | null {
  const boundaries = events.filter((event) => event.id === receipt.boundaryId)
  const summaries = events.filter((event) => event.id === receipt.summaryId)
  if (boundaries.length === 0 && summaries.length === 0) return null
  if (boundaries.length !== 1 || summaries.length !== 1)
    throw new Error(
      'Compaction receipt has partial or duplicate Transcript evidence',
    )
  const matched = events.some((event, index) => {
    const summary = events[index + 1]
    return (
      event.kind === 'context-boundary' &&
      event.id === receipt.boundaryId &&
      event.parentId === null &&
      event.sessionId === receipt.sessionId &&
      event.trigger === receipt.trigger &&
      event.durationMs === receipt.metric.durationApiMs &&
      summary?.kind === 'context-summary' &&
      summary.id === receipt.summaryId &&
      summary.parentId === receipt.boundaryId &&
      summary.sessionId === receipt.sessionId
    )
  })
  if (!matched)
    throw new Error(
      'Compaction receipt Transcript evidence does not match boundary and summary',
    )
  return events.findIndex((event, index) => {
    const summary = events[index + 1]
    return event.id === receipt.boundaryId && summary?.id === receipt.summaryId
  })
}

export class CompactionAccounting {
  private readonly sessionId: string
  private readonly tracker: ClaudeSessionCostTracker
  private readonly pricing: ModelPricingRegistry | undefined
  private readonly receiptStore: CompactionReceiptStore | undefined
  private readonly costStateStore:
    Pick<ClaudeCostStateStore, 'save'> | undefined
  private readonly readTranscript:
    (() => Promise<readonly TranscriptEvent[]>) | undefined
  private readonly createId: () => string
  private recovered = false
  private recoveryPromise: Promise<void> | undefined
  private recoveredReceipts = new Set<string>()
  private appliedReceipts = new Set<string>()

  constructor(options: CompactionAccountingOptions) {
    this.sessionId = options.sessionId
    this.tracker = options.tracker
    this.pricing = options.pricing
    this.receiptStore = options.receiptStore
    this.costStateStore = options.costStateStore
    this.readTranscript = options.readTranscript
    this.createId = options.createId ?? randomUUID
  }

  async recover(): Promise<void> {
    if (this.recovered) return
    if (this.recoveryPromise) return this.recoveryPromise
    this.recoveryPromise = this.recoverOnce().catch((cause: unknown) => {
      if (cause instanceof CompactionTransactionError) throw cause
      throw this.error('auto', 'recovery', 'indeterminate', 'blocked', cause)
    })
    try {
      await this.recoveryPromise
      this.recovered = true
    } finally {
      this.recoveryPromise = undefined
    }
  }

  private async recoverOnce(): Promise<void> {
    if (!this.receiptStore) return
    if (!this.readTranscript)
      throw this.error(
        'auto',
        'recovery',
        'indeterminate',
        'blocked',
        new Error(
          'Compaction recovery requires the complete native Transcript',
        ),
      )
    const events = await this.readTranscript()
    const rows = await this.receiptStore.list(this.sessionId)
    const committed: Array<{
      readonly row: (typeof rows)[number]
      readonly index: number
    }> = []
    for (const row of rows) {
      const receipt = row.receipt
      if (receipt.sessionId !== this.sessionId)
        throw this.recoveryError(
          receipt,
          new Error('Compaction receipt session does not match recovery'),
        )
      let index: number | null
      try {
        index = compactPair(events, receipt)
      } catch (cause) {
        throw this.recoveryError(receipt, cause)
      }
      if (index === null) continue
      committed.push({ row, index })
    }
    committed.sort((a, b) => a.index - b.index)
    if (!this.costStateStore) {
      const preflight = new ClaudeSessionCostTracker({
        sessionId: this.sessionId,
        restored: this.tracker.snapshot(),
      })
      for (const { row } of committed) {
        if (this.appliedReceipts.has(row.receipt.receiptId)) continue
        try {
          applyMetric(preflight, row.receipt.metric, row.receipt.costUsd)
        } catch (cause) {
          throw this.recoveryError(row.receipt, cause)
        }
      }
      for (const { row } of committed) {
        const receipt = row.receipt
        if (this.recoveredReceipts.has(receipt.receiptId)) continue
        if (!this.appliedReceipts.has(receipt.receiptId)) {
          const check = new ClaudeSessionCostTracker({
            sessionId: this.sessionId,
            restored: this.tracker.snapshot(),
          })
          const before = fingerprint(this.tracker.snapshot())
          try {
            applyMetric(check, receipt.metric, receipt.costUsd)
          } catch (cause) {
            throw this.recoveryError(receipt, cause)
          }
          if (
            before === receipt.before &&
            fingerprint(check.snapshot()) !== receipt.after
          )
            throw this.recoveryError(
              receipt,
              new Error('Compaction receipt after fingerprint mismatch'),
            )
          try {
            applyMetric(this.tracker, receipt.metric, receipt.costUsd)
          } catch (cause) {
            throw this.recoveryError(receipt, cause)
          }
          this.appliedReceipts.add(receipt.receiptId)
        }
        if (!row.acknowledged) {
          try {
            await this.receiptStore.acknowledge(
              this.sessionId,
              receipt.receiptId,
            )
          } catch (cause) {
            throw this.recoveryError(receipt, cause, 'reconcile')
          }
        }
        this.recoveredReceipts.add(receipt.receiptId)
      }
      return
    }
    const pending = new Map(
      committed
        .filter(({ row }) => !row.acknowledged)
        .map(({ row }) => [row.receipt.receiptId, row]),
    )
    while (pending.size > 0) {
      const candidates = [...pending.values()].filter((row) => {
        const current = fingerprint(this.tracker.snapshot())
        return current === row.receipt.before || current === row.receipt.after
      })
      const candidate = candidates[0]
      const fallback = pending.values().next().value
      if (candidates.length !== 1 || !candidate) {
        if (!fallback)
          throw this.error(
            'auto',
            'recovery',
            'indeterminate',
            'blocked',
            new Error('Compaction receipt chain is empty'),
          )
        throw this.recoveryError(
          fallback.receipt,
          new Error(
            candidates.length > 1
              ? 'Ambiguous compaction receipt chain'
              : 'No compaction receipt chain candidate',
          ),
        )
      }
      const receipt = candidate.receipt
      const now = fingerprint(this.tracker.snapshot())
      if (now === receipt.before) {
        const check = new ClaudeSessionCostTracker({
          sessionId: this.sessionId,
          restored: this.tracker.snapshot(),
        })
        try {
          applyMetric(check, receipt.metric, receipt.costUsd)
        } catch (cause) {
          throw this.recoveryError(receipt, cause)
        }
        if (fingerprint(check.snapshot()) !== receipt.after)
          throw this.recoveryError(
            receipt,
            new Error('Compaction receipt after fingerprint mismatch'),
          )
        try {
          applyMetric(this.tracker, receipt.metric, receipt.costUsd)
        } catch (cause) {
          throw this.recoveryError(receipt, cause)
        }
      }
      try {
        await this.costStateStore.save(this.tracker.snapshot())
        await this.receiptStore.acknowledge(this.sessionId, receipt.receiptId)
      } catch (cause) {
        throw this.recoveryError(receipt, cause, 'reconcile')
      }
      this.recoveredReceipts.add(receipt.receiptId)
      pending.delete(receipt.receiptId)
    }
  }

  async prepare(input: {
    readonly trigger: CompactionTrigger
    readonly metric: TurnCompactionMetric
  }): Promise<PreparedCompactionTransaction> {
    const metric = clone(input.metric)
    const preflight = new ClaudeSessionCostTracker({
      sessionId: this.sessionId,
      restored: this.tracker.snapshot(),
    })
    let fixedCost: number | null
    try {
      const resolved = metric.model
        ? this.pricing?.resolve(metric.model)
        : undefined
      fixedCost = resolved ? usageCostUsd(metric.usage, resolved) : null
      applyMetric(preflight, metric, fixedCost)
    } catch (cause) {
      throw this.error(
        input.trigger,
        'validation',
        'not_committed',
        'none',
        cause,
      )
    }
    const receiptId = this.createId()
    const boundaryId = this.createId()
    const summaryId = this.createId()
    if (
      !validTransactionId(receiptId) ||
      !validTransactionId(boundaryId) ||
      !validTransactionId(summaryId) ||
      new Set([receiptId, boundaryId, summaryId]).size !== 3
    )
      throw this.error(
        input.trigger,
        'validation',
        'not_committed',
        'blocked',
        new Error(
          'Compaction transaction IDs must be safe, nonblank, and distinct',
        ),
      )
    const before = fingerprint(this.tracker.snapshot())
    const after = fingerprint(preflight.snapshot())
    const receipt: NativeCompactionReceipt = {
      version: 1,
      receiptId,
      sessionId: this.sessionId,
      boundaryId,
      summaryId,
      trigger: input.trigger,
      metric,
      costUsd: fixedCost,
      before,
      after,
    }
    try {
      await this.receiptStore?.prepare(receipt)
    } catch (cause) {
      throw this.error(
        input.trigger,
        'receipt_prepare',
        'not_committed',
        'retry',
        cause,
      )
    }
    if (this.receiptStore) this.recovered = false
    let used = false
    return {
      receiptId,
      boundaryId,
      summaryId,
      commit: async (appendReceipt) => {
        if (used)
          throw this.error(
            input.trigger,
            'accounting_commit',
            'committed',
            'reconcile',
            new Error('Prepared compaction transaction was already committed'),
          )
        if (
          typeof appendReceipt !== 'object' ||
          appendReceipt === null ||
          appendReceipt.kind !== 'compaction' ||
          appendReceipt.boundaryId !== boundaryId ||
          appendReceipt.summaryId !== summaryId
        )
          throw this.error(
            input.trigger,
            'transcript_commit',
            'indeterminate',
            'blocked',
            new Error(
              'Transcript compaction receipt does not match prepared IDs',
            ),
          )
        used = true
        try {
          const check = new ClaudeSessionCostTracker({
            sessionId: this.sessionId,
            restored: this.tracker.snapshot(),
          })
          applyMetric(check, metric, fixedCost)
          if (fingerprint(check.snapshot()) !== after)
            throw this.error(
              input.trigger,
              'accounting_commit',
              'indeterminate',
              'blocked',
              new Error('Compaction receipt after fingerprint mismatch'),
            )
          applyMetric(this.tracker, metric, fixedCost)
          this.appliedReceipts.add(receiptId)
        } catch (cause) {
          this.recovered = false
          throw this.error(
            input.trigger,
            'accounting_commit',
            'indeterminate',
            'blocked',
            cause,
          )
        }
        try {
          if (this.costStateStore)
            await this.costStateStore.save(this.tracker.snapshot())
          if (this.receiptStore)
            await this.receiptStore.acknowledge(this.sessionId, receiptId)
        } catch (cause) {
          this.recovered = false
          throw this.error(
            input.trigger,
            'accounting_commit',
            'committed',
            'reconcile',
            cause,
          )
        }
        this.recoveredReceipts.add(receiptId)
      },
    }
  }
  private recoveryError(
    receipt: NativeCompactionReceipt,
    cause: unknown,
    disposition: 'blocked' | 'reconcile' = 'blocked',
  ): CompactionTransactionError {
    return this.error(
      receipt.trigger,
      'recovery',
      'indeterminate',
      disposition,
      cause,
    )
  }
  private error(
    trigger: CompactionTrigger,
    phase:
      | 'validation'
      | 'generation'
      | 'receipt_prepare'
      | 'transcript_commit'
      | 'accounting_commit'
      | 'post_commit'
      | 'recovery',
    durableState: 'not_committed' | 'committed' | 'indeterminate',
    recoveryDisposition: 'none' | 'retry' | 'reconcile' | 'blocked',
    cause: unknown,
  ): CompactionTransactionError {
    return new CompactionTransactionError(
      `Compaction ${phase} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      { trigger, phase, durableState, recoveryDisposition },
      cause,
    )
  }
}
