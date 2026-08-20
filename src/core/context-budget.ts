import type {
  ModelMessage,
  ModelToolDefinition,
  ModelUsage,
} from './runtime.js'
import { ModelProviderError } from './runtime.js'

export interface ContextBudgetOptions {
  contextWindowTokens: number
  reserveTokens?: number
  /** Declares whether the configured window came from a provider capability so
   *  reports can distinguish provider-derived decisions from estimates. */
  windowSource?: 'capability' | 'estimate'
}

export interface ContextBudgetEvaluateOptions {
  /** Most recent provider usage observation; a positive `contextWindow` is
   *  authoritative for the effective window. */
  lastUsage?: ModelUsage
  /** Provider-reported output tokens to reserve in the overflow accounting. */
  outputTokens?: number
  /** Force `shouldCompact` when the provider rejected the prompt as too long. */
  promptTooLong?: boolean
}

export type ContextBudgetSource = 'provider' | 'capability' | 'estimate'

export interface ContextBudgetReport {
  estimatedTokens: number
  contextWindowTokens: number
  reserveTokens: number
  availableTokens: number
  overflowTokens: number
  shouldCompact: boolean
  source: ContextBudgetSource
}

export class ContextOverflowError extends Error {
  override readonly name = 'ContextOverflowError'

  constructor(readonly report: ContextBudgetReport) {
    super(
      `Context exceeds provider budget: estimated=${report.estimatedTokens}, window=${report.contextWindowTokens}, reserve=${report.reserveTokens}, available=${report.availableTokens}, overflow=${report.overflowTokens}. Increase PRAXIS_CONTEXT_WINDOW_TOKENS, reduce PRAXIS_CONTEXT_RESERVE_TOKENS, or start a new session.`,
    )
  }
}

function requirePositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`)
  }
}

export function estimateTextTokens(value: string): number {
  let ascii = 0
  let nonAscii = 0
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (codePoint !== undefined && codePoint <= 0x7f) ascii += 1
    else nonAscii += 1
  }
  return Math.ceil(ascii / 4) + nonAscii
}

function estimateMessageTokens(message: ModelMessage): number {
  let tokens = 4 + estimateTextTokens(message.role)
  if (message.role === 'tool') {
    tokens +=
      estimateTextTokens(message.toolCallId) +
      estimateTextTokens(message.content)
    for (const image of message.images ?? []) {
      tokens +=
        8 + estimateTextTokens(image.mediaType) + estimateTextTokens(image.data)
    }
    return tokens + (message.isError ? 1 : 0)
  }
  tokens += estimateTextTokens(message.content)
  if (message.role === 'user') {
    for (const image of message.images ?? []) {
      tokens +=
        8 + estimateTextTokens(image.mediaType) + estimateTextTokens(image.data)
    }
    for (const document of message.documents ?? []) {
      tokens += 8 + estimateTextTokens(document.mediaType) + 2000
    }
  }
  if (message.role !== 'assistant') return tokens
  for (const block of message.thinkingBlocks ?? []) {
    tokens +=
      4 +
      (block.type === 'thinking'
        ? estimateTextTokens(block.thinking) +
          estimateTextTokens(block.signature)
        : estimateTextTokens(block.data))
  }
  for (const call of message.toolCalls ?? []) {
    tokens +=
      6 +
      estimateTextTokens(call.id) +
      estimateTextTokens(call.name) +
      estimateTextTokens(JSON.stringify(call.input))
  }
  return tokens
}

export function estimateModelRequestTokens(
  messages: readonly ModelMessage[],
  tools: readonly ModelToolDefinition[] = [],
): number {
  const messageTokens = messages.reduce(
    (total, message) => total + estimateMessageTokens(message),
    3,
  )
  const toolTokens = tools.reduce(
    (total, tool) =>
      total +
      8 +
      estimateTextTokens(tool.name) +
      estimateTextTokens(tool.description) +
      estimateTextTokens(JSON.stringify(tool.inputSchema)),
    0,
  )
  return messageTokens + toolTokens
}

export class ContextBudget {
  readonly contextWindowTokens: number
  readonly reserveTokens: number
  readonly windowSource: 'capability' | 'estimate'
  private observedUsage: ModelUsage | undefined

  constructor(options: ContextBudgetOptions) {
    requirePositiveInteger(options.contextWindowTokens, 'Context window tokens')
    const defaultReserve = Math.min(
      8192,
      Math.max(1, Math.floor(options.contextWindowTokens / 10)),
    )
    const reserveTokens = options.reserveTokens ?? defaultReserve
    requirePositiveInteger(reserveTokens, 'Context reserve tokens')
    if (reserveTokens >= options.contextWindowTokens) {
      throw new Error('Context reserve tokens must be smaller than the window')
    }
    this.contextWindowTokens = options.contextWindowTokens
    this.reserveTokens = reserveTokens
    this.windowSource = options.windowSource ?? 'estimate'
  }

  observeUsage(usage: ModelUsage): void {
    this.observedUsage = usage
  }

  effectiveContextWindow(usage?: ModelUsage): number {
    return this.providerContextWindow(usage) ?? this.contextWindowTokens
  }

  evaluate(
    messages: readonly ModelMessage[],
    tools: readonly ModelToolDefinition[] = [],
    options: ContextBudgetEvaluateOptions = {},
  ): ContextBudgetReport {
    const estimatedTokens = estimateModelRequestTokens(messages, tools)
    const providerWindow = this.providerContextWindow(options.lastUsage)
    const contextWindowTokens = providerWindow ?? this.contextWindowTokens
    const outputTokens =
      options.outputTokens !== undefined &&
      Number.isSafeInteger(options.outputTokens) &&
      options.outputTokens >= 0
        ? options.outputTokens
        : 0
    const availableTokens = Math.max(
      0,
      contextWindowTokens - this.reserveTokens,
    )
    const overflowTokens = Math.max(
      0,
      estimatedTokens + outputTokens - availableTokens,
    )
    const shouldCompact = options.promptTooLong === true || overflowTokens > 0
    return {
      estimatedTokens,
      contextWindowTokens,
      reserveTokens: this.reserveTokens,
      availableTokens,
      overflowTokens,
      shouldCompact,
      source: providerWindow === undefined ? this.windowSource : 'provider',
    }
  }

  assertFits(report: ContextBudgetReport): void {
    if (report.shouldCompact) throw new ContextOverflowError(report)
  }

  /** Returns the positive provider-reported context window, if any. */
  private providerContextWindow(usage?: ModelUsage): number | undefined {
    const candidate = usage?.contextWindow ?? this.observedUsage?.contextWindow
    if (
      candidate !== undefined &&
      Number.isSafeInteger(candidate) &&
      candidate > 0
    ) {
      return candidate
    }
    return undefined
  }
}

export type ContextRecoveryStage =
  'preflight' | 'microcompact' | 'auto-compact' | 'reactive-retry' | 'blocked'

export interface ContextRecoveryPlannerOptions {
  /** Number of reactive retries allowed before the planner reports `blocked`. */
  maxReactiveRetries?: number
  /** Consecutive failures that trip the circuit breaker to `blocked`. */
  consecutiveFailureThreshold?: number
}

const DEFAULT_MAX_REACTIVE_RETRIES = 1
const DEFAULT_CONSECUTIVE_FAILURE_THRESHOLD = 3

export class ContextRecoveryPlanner {
  private readonly maxReactiveRetries: number
  private readonly consecutiveFailureThreshold: number
  private currentStage: ContextRecoveryStage = 'preflight'
  private reactiveRetriesUsed = 0
  private consecutiveFailures = 0

  constructor(options: ContextRecoveryPlannerOptions = {}) {
    const maxReactiveRetries =
      options.maxReactiveRetries ?? DEFAULT_MAX_REACTIVE_RETRIES
    const consecutiveFailureThreshold =
      options.consecutiveFailureThreshold ??
      DEFAULT_CONSECUTIVE_FAILURE_THRESHOLD
    if (!Number.isInteger(maxReactiveRetries) || maxReactiveRetries < 0) {
      throw new Error('maxReactiveRetries must be a nonnegative integer')
    }
    if (
      !Number.isInteger(consecutiveFailureThreshold) ||
      consecutiveFailureThreshold < 1
    ) {
      throw new Error('consecutiveFailureThreshold must be a positive integer')
    }
    this.maxReactiveRetries = maxReactiveRetries
    this.consecutiveFailureThreshold = consecutiveFailureThreshold
  }

  get stage(): ContextRecoveryStage {
    return this.currentStage
  }

  get reactiveRetriesRemaining(): number {
    return Math.max(0, this.maxReactiveRetries - this.reactiveRetriesUsed)
  }

  /** Advance one escalation stage; bounded so the planner never leaves
   *  `blocked`. Side-effect free apart from the internal stage. */
  advance(): ContextRecoveryStage {
    switch (this.currentStage) {
      case 'preflight':
        this.currentStage = 'microcompact'
        break
      case 'microcompact':
        this.currentStage = 'auto-compact'
        break
      case 'auto-compact':
        this.currentStage = 'reactive-retry'
        break
      case 'reactive-retry':
        this.currentStage = 'blocked'
        break
      case 'blocked':
        break
    }
    return this.currentStage
  }

  /** Consume one reactive retry decision; reports `blocked` once the maximum
   *  reactive retries have been consumed. */
  consumeReactiveRetry(): ContextRecoveryStage {
    this.reactiveRetriesUsed += 1
    this.currentStage =
      this.reactiveRetriesUsed <= this.maxReactiveRetries
        ? 'reactive-retry'
        : 'blocked'
    return this.currentStage
  }

  /** Record a failed recovery attempt; trips the circuit breaker to `blocked`
   *  after `consecutiveFailureThreshold` consecutive failures. */
  recordFailure(): ContextRecoveryStage {
    this.consecutiveFailures += 1
    if (this.consecutiveFailures >= this.consecutiveFailureThreshold) {
      this.currentStage = 'blocked'
    }
    return this.currentStage
  }

  /** Record a successful recovery/model attempt; resets the planner. */
  recordSuccess(): ContextRecoveryStage {
    this.consecutiveFailures = 0
    this.reactiveRetriesUsed = 0
    this.currentStage = 'preflight'
    return this.currentStage
  }
}

const PROMPT_TOO_LONG_PATTERN =
  /context(?:[_\s-]?length|[_\s-]?window)|prompt(?:[_\s-]?is)?[_\s-]?too[_\s-]?long|too[_\s-]?many[_\s-]?tokens|maximum[_\s-]?context/iu

/** True when a provider error signals that the request exceeded the model's
 *  context window and a reactive compaction retry is the relevant recovery. */
export function isPromptTooLongError(error: unknown): boolean {
  return (
    error instanceof ModelProviderError &&
    PROMPT_TOO_LONG_PATTERN.test(error.message)
  )
}
