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
  /** Receives at most one bounded diagnostic when provider accounting is
   * malformed and the deterministic estimate fallback is used. */
  onAccountingDiagnostic?: (message: string) => void
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
  /** Total context occupancy used for overflow accounting: the actual provider
   *  input/cache tokens at the observation watermark plus deterministic
   *  estimated tokens added after that watermark. Without a usable watermark
   *  this equals `estimatedTokens`. */
  occupancyTokens: number
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

const IMAGE_VISUAL_TOKEN_ESTIMATE = 1_600
// This provider-neutral conservative fallback never interprets billed usage;
// observed provider usage remains authoritative at a ContextBudget watermark.

function estimateImageTokens(mediaType: string): number {
  return 8 + estimateTextTokens(mediaType) + IMAGE_VISUAL_TOKEN_ESTIMATE
}

function estimateMessageTokens(message: ModelMessage): number {
  let tokens = 4 + estimateTextTokens(message.role)
  if (message.role === 'tool') {
    tokens +=
      estimateTextTokens(message.toolCallId) +
      estimateTextTokens(message.content)
    for (const image of message.images ?? []) {
      tokens += estimateImageTokens(image.mediaType)
    }
    return tokens + (message.isError ? 1 : 0)
  }
  tokens += estimateTextTokens(message.content)
  if (message.role === 'user') {
    for (const image of message.images ?? []) {
      tokens += estimateImageTokens(image.mediaType)
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

/** Normalized provider input occupancy counting input and cache-read/creation
 *  fields without output tokens. Returns `undefined` for malformed, negative,
 *  or non-safe usage so accounting fails open. */
function normalizedInputAndCacheTokens(usage: ModelUsage): number | undefined {
  if (
    !Number.isSafeInteger(usage.inputTokens) ||
    usage.inputTokens < 0 ||
    (usage.cacheReadInputTokens !== undefined &&
      (!Number.isSafeInteger(usage.cacheReadInputTokens) ||
        usage.cacheReadInputTokens < 0)) ||
    (usage.cacheCreationInputTokens !== undefined &&
      (!Number.isSafeInteger(usage.cacheCreationInputTokens) ||
        usage.cacheCreationInputTokens < 0))
  ) {
    return undefined
  }
  const candidate =
    (usage.inputTokens ?? 0) +
    (usage.cacheReadInputTokens ?? 0) +
    (usage.cacheCreationInputTokens ?? 0)
  return Number.isSafeInteger(candidate) ? candidate : undefined
}

export class ContextBudget {
  readonly contextWindowTokens: number
  readonly reserveTokens: number
  readonly windowSource: 'capability' | 'estimate'
  private observedUsage: ModelUsage | undefined
  /** Actual provider input/cache tokens at the most recent usable observation;
   *  the watermark that anchors later occupancy. */
  private watermarkActualInputTokens: number | undefined
  /** Deterministic estimate of the request snapshot captured at observation
   *  time; only growth beyond this baseline is added to the watermark. */
  private watermarkBaselineEstimate: number | undefined
  private accountingDiagnosticEmitted = false
  private readonly onAccountingDiagnostic:
    ((message: string) => void) | undefined

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
    this.onAccountingDiagnostic = options.onAccountingDiagnostic
  }

  /** Record a completed provider request: `usage` carries the actual token
   *  counts and `messages`/`tools` are the exact snapshot used for that
   *  request. The snapshot's deterministic estimate becomes the watermark
   *  baseline so later evaluations add only post-watermark growth. Malformed
   *  usage is ignored (fail-open) and never throws; a valid `contextWindow`
   *  still updates the effective window through `observedUsage`. */
  observeUsage(
    usage: ModelUsage,
    messages: readonly ModelMessage[] = [],
    tools: readonly ModelToolDefinition[] = [],
  ): void {
    this.observedUsage = usage
    const actualInputTokens = normalizedInputAndCacheTokens(usage)
    if (actualInputTokens === undefined) {
      this.emitAccountingDiagnostic()
      return
    }
    if (messages.length === 0 && tools.length === 0) return
    this.watermarkActualInputTokens = actualInputTokens
    this.watermarkBaselineEstimate = estimateModelRequestTokens(messages, tools)
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
    const occupancyTokens = this.anchoredOccupancyTokens(estimatedTokens)
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
      occupancyTokens + outputTokens - availableTokens,
    )
    const shouldCompact = options.promptTooLong === true || overflowTokens > 0
    return {
      estimatedTokens,
      occupancyTokens,
      contextWindowTokens,
      reserveTokens: this.reserveTokens,
      availableTokens,
      overflowTokens,
      shouldCompact,
      source: providerWindow === undefined ? this.windowSource : 'provider',
    }
  }

  /** Occupancy anchored at the actual input/cache watermark, adding only the
   *  deterministic estimated growth past the observation baseline. Without a
   *  usable watermark this is the plain estimate fallback. */
  private anchoredOccupancyTokens(estimatedTokens: number): number {
    if (
      this.watermarkActualInputTokens === undefined ||
      this.watermarkBaselineEstimate === undefined
    ) {
      return estimatedTokens
    }
    const growthAfterWatermark = Math.max(
      0,
      estimatedTokens - this.watermarkBaselineEstimate,
    )
    return this.watermarkActualInputTokens + growthAfterWatermark
  }

  private emitAccountingDiagnostic(): void {
    if (this.accountingDiagnosticEmitted) return
    this.accountingDiagnosticEmitted = true
    try {
      this.onAccountingDiagnostic?.(
        'Provider input usage was malformed; using deterministic context estimates.',
      )
    } catch {
      // Diagnostics are strictly best-effort. A broken sink must never turn
      // fail-open accounting into a healthy-turn failure.
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
}

const DEFAULT_MAX_REACTIVE_RETRIES = 1

export interface ContextRecoveryProgress {
  beforeOccupancyTokens: number
  afterOccupancyTokens: number
}

export function contextRecoveryMadeProgress(
  progress: ContextRecoveryProgress,
): boolean {
  for (const [name, value] of Object.entries(progress)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${name} must be a nonnegative safe integer`)
    }
  }
  return progress.afterOccupancyTokens < progress.beforeOccupancyTokens
}

export class ContextRecoveryPlanner {
  private readonly maxReactiveRetries: number
  private currentStage: ContextRecoveryStage = 'preflight'
  private reactiveRetriesUsed = 0

  constructor(options: ContextRecoveryPlannerOptions = {}) {
    const maxReactiveRetries =
      options.maxReactiveRetries ?? DEFAULT_MAX_REACTIVE_RETRIES
    if (!Number.isInteger(maxReactiveRetries) || maxReactiveRetries < 0) {
      throw new Error('maxReactiveRetries must be a nonnegative integer')
    }
    this.maxReactiveRetries = maxReactiveRetries
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
  consumeReactiveRetry(
    progress: ContextRecoveryProgress,
  ): ContextRecoveryStage {
    if (!contextRecoveryMadeProgress(progress)) {
      this.currentStage = 'blocked'
      return this.currentStage
    }
    this.reactiveRetriesUsed += 1
    this.currentStage =
      this.reactiveRetriesUsed <= this.maxReactiveRetries
        ? 'reactive-retry'
        : 'blocked'
    return this.currentStage
  }

  /** A failed reactive attempt exhausts the only selected context transition. */
  recordFailure(): ContextRecoveryStage {
    this.currentStage = 'blocked'
    return this.currentStage
  }

  /** Record a successful recovery/model attempt; resets the planner. */
  recordSuccess(): ContextRecoveryStage {
    this.reactiveRetriesUsed = 0
    this.currentStage = 'preflight'
    return this.currentStage
  }
}

/** True when a provider error signals that the request exceeded the model's
 *  context window and a reactive compaction retry is the relevant recovery. */
export function isPromptTooLongError(
  error: unknown,
): error is ModelProviderError {
  return error instanceof ModelProviderError && error.kind === 'prompt_too_long'
}
