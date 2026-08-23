import {
  AgentRunCancelledError,
  type ModelProviderError,
  type ModelMessage,
  type ModelToolDefinition,
  type ModelUsage,
} from '../core/runtime.js'
import {
  contextRecoveryMadeProgress,
  isPromptTooLongError,
  type ContextBudget,
  type ContextBudgetReport,
} from '../core/context-budget.js'

export interface ContextEnvelope {
  readonly messages: readonly ModelMessage[]
  readonly tools: readonly ModelToolDefinition[]
  readonly outputTokens?: number
}

export interface ContextCompactionProposal {
  readonly envelope: ContextEnvelope
  commit(): Promise<void>
}

export interface ContextTransitionInput {
  readonly trigger: 'auto' | 'reactive'
  readonly before: ContextBudgetReport
  readonly irreducible: ContextBudgetReport
  readonly signal?: AbortSignal
}

export interface ContextTransitionPort {
  current(): ContextEnvelope
  irreducible(): ContextEnvelope
  propose(input: ContextTransitionInput): Promise<ContextCompactionProposal>
}

export interface ContextEngineMemoryPort {
  beforeCompact?(): Promise<void>
  afterCompact?(): Promise<void>
}

export interface ContextEngineOptions {
  budget?: ContextBudget
  memory?: ContextEngineMemoryPort
  autoCompact?: boolean
}

export type ContextRecoveryResult =
  | { readonly kind: 'not-applicable' }
  | { readonly kind: 'retry'; readonly envelope: ContextEnvelope }
  | { readonly kind: 'exhausted'; readonly error: ModelProviderError }

function assertSignal(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AgentRunCancelledError()
}

function validateEnvelope(envelope: ContextEnvelope): void {
  if (!Array.isArray(envelope.messages) || !Array.isArray(envelope.tools)) {
    throw new TypeError(
      'Context envelope must contain messages and tools arrays',
    )
  }
  if (
    envelope.outputTokens !== undefined &&
    (!Number.isSafeInteger(envelope.outputTokens) || envelope.outputTokens < 0)
  ) {
    throw new TypeError('Context envelope outputTokens must be nonnegative')
  }
}

/** Owns context measurement, bounded recovery, and the proposal/commit seam. */
export class ContextEngine {
  private recoveryUsed = false
  private readonly budget: ContextBudget | undefined
  private readonly memory: ContextEngineMemoryPort
  private readonly autoCompact: boolean

  constructor(options: ContextEngineOptions = {}) {
    this.budget = options.budget
    this.memory = options.memory ?? {}
    this.autoCompact = options.autoCompact ?? true
  }

  async prepare(
    port: ContextTransitionPort,
    signal?: AbortSignal,
  ): Promise<ContextEnvelope> {
    const current = port.current()
    validateEnvelope(current)
    if (!this.budget || !this.autoCompact) return current
    const before = this.reportRequired(current)
    if (!before.shouldCompact) return current
    assertSignal(signal)
    const irreducible = port.irreducible()
    validateEnvelope(irreducible)
    const irreducibleReport = this.reportRequired(irreducible)
    this.budget.assertFits(irreducibleReport)
    await this.memory.beforeCompact?.()
    assertSignal(signal)
    const proposal = await port.propose({
      trigger: 'auto',
      before,
      irreducible: irreducibleReport,
      ...(signal ? { signal } : {}),
    })
    assertSignal(signal)
    validateEnvelope(proposal.envelope)
    this.budget.assertFits(this.reportRequired(proposal.envelope))
    await proposal.commit()
    await this.memory.afterCompact?.()
    return proposal.envelope
  }

  async recover(
    error: unknown,
    port: ContextTransitionPort,
    signal?: AbortSignal,
  ): Promise<ContextRecoveryResult> {
    if (!isPromptTooLongError(error)) return { kind: 'not-applicable' }
    if (this.recoveryUsed) return { kind: 'exhausted', error }
    // Recovery is a single turn-scoped opportunity, regardless of whether the
    // proposal eventually proves usable. This prevents provider retry loops.
    this.recoveryUsed = true
    assertSignal(signal)
    if (!this.budget || !this.autoCompact) {
      return { kind: 'exhausted', error }
    }
    try {
      const current = port.current()
      validateEnvelope(current)
      const before = this.reportRequired(current, { promptTooLong: true })
      const irreducible = port.irreducible()
      validateEnvelope(irreducible)
      const irreducibleReport = this.reportRequired(irreducible)
      this.budget.assertFits(irreducibleReport)
      await this.memory.beforeCompact?.()
      assertSignal(signal)
      const proposal = await port.propose({
        trigger: 'reactive',
        before,
        irreducible: irreducibleReport,
        ...(signal ? { signal } : {}),
      })
      assertSignal(signal)
      validateEnvelope(proposal.envelope)
      const after = this.reportRequired(proposal.envelope)
      this.budget.assertFits(after)
      if (
        !contextRecoveryMadeProgress({
          beforeOccupancyTokens: before.occupancyTokens,
          afterOccupancyTokens: after.occupancyTokens,
        })
      ) {
        return { kind: 'exhausted', error }
      }
      await proposal.commit()
      await this.memory.afterCompact?.()
      return { kind: 'retry', envelope: proposal.envelope }
    } catch (cause) {
      if (signal?.aborted || cause instanceof AgentRunCancelledError)
        throw cause
      return { kind: 'exhausted', error }
    }
  }

  observeUsage(
    usage: ModelUsage,
    messages: readonly ModelMessage[],
    tools: readonly ModelToolDefinition[],
  ): void {
    this.budget?.observeUsage(usage, messages, tools)
  }

  report(envelope: ContextEnvelope, options: { promptTooLong?: boolean } = {}) {
    validateEnvelope(envelope)
    if (!this.budget) {
      return undefined
    }
    return this.budget.evaluate(envelope.messages, envelope.tools, {
      ...(envelope.outputTokens === undefined
        ? {}
        : { outputTokens: envelope.outputTokens }),
      ...options,
    })
  }

  private reportRequired(
    envelope: ContextEnvelope,
    options: { promptTooLong?: boolean } = {},
  ): ContextBudgetReport {
    if (!this.budget) throw new Error('Context budget is unavailable')
    return this.budget.evaluate(envelope.messages, envelope.tools, {
      ...(envelope.outputTokens === undefined
        ? {}
        : { outputTokens: envelope.outputTokens }),
      ...options,
    })
  }
}
