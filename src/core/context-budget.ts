import type { ModelMessage, ModelToolDefinition } from './runtime.js'

export interface ContextBudgetOptions {
  contextWindowTokens: number
  reserveTokens?: number
}

export interface ContextBudgetReport {
  estimatedTokens: number
  contextWindowTokens: number
  reserveTokens: number
  availableTokens: number
  overflowTokens: number
  shouldCompact: boolean
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
  }

  evaluate(
    messages: readonly ModelMessage[],
    tools: readonly ModelToolDefinition[] = [],
  ): ContextBudgetReport {
    const estimatedTokens = estimateModelRequestTokens(messages, tools)
    const availableTokens = this.contextWindowTokens - this.reserveTokens
    const overflowTokens = Math.max(0, estimatedTokens - availableTokens)
    return {
      estimatedTokens,
      contextWindowTokens: this.contextWindowTokens,
      reserveTokens: this.reserveTokens,
      availableTokens,
      overflowTokens,
      shouldCompact: overflowTokens > 0,
    }
  }

  assertFits(report: ContextBudgetReport): void {
    if (report.shouldCompact) throw new ContextOverflowError(report)
  }
}
