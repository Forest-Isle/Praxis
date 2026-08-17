import type {
  CompactionRequest,
  CompactionResult,
  Compactor,
} from '../core/compaction.js'
import {
  estimateModelRequestTokens,
  estimateTextTokens,
} from '../core/context-budget.js'
import {
  AgentRunCancelledError,
  type ModelProvider,
  type ModelUsage,
} from '../core/runtime.js'

const COMPACTION_INSTRUCTIONS = `You are compacting an agent conversation so work can continue without the discarded messages. Preserve user intent, completed work, exact decisions, constraints, file paths, commands, errors, pending tasks, and the latest user request. Do not solve the task. Return only the durable summary as plain text. Do not call tools.`

function compactionMessages(
  messages: CompactionRequest['messages'],
  targetTokens: number,
) {
  return [
    { role: 'system' as const, content: COMPACTION_INSTRUCTIONS },
    ...messages,
    {
      role: 'user' as const,
      content: `Create a continuation summary no longer than ${targetTokens} estimated tokens.`,
    },
  ]
}

export class ModelCompactor implements Compactor {
  constructor(private readonly provider: ModelProvider) {}

  async compact(request: CompactionRequest): Promise<CompactionResult> {
    if (!Number.isInteger(request.targetTokens) || request.targetTokens <= 0) {
      throw new Error('Compaction target tokens must be a positive integer')
    }
    if (
      !Number.isInteger(request.contextWindowTokens) ||
      request.contextWindowTokens <= request.targetTokens
    ) {
      throw new Error(
        'Compaction context window must be larger than target tokens',
      )
    }
    if (request.signal?.aborted) throw new AgentRunCancelledError()

    let targetTokens = request.targetTokens
    let messages = compactionMessages(request.messages, targetTokens)
    let estimatedInputTokens = estimateModelRequestTokens(messages)
    while (estimatedInputTokens + targetTokens > request.contextWindowTokens) {
      const nextTarget = Math.min(
        targetTokens - 1,
        request.contextWindowTokens - estimatedInputTokens,
      )
      if (nextTarget < 1) {
        throw new Error(
          `Compaction input exceeds provider budget: estimated=${estimatedInputTokens}, window=${request.contextWindowTokens}, target=${targetTokens}, available=${Math.max(0, request.contextWindowTokens - targetTokens)}. Start a new session or use a provider with a larger context window.`,
        )
      }
      targetTokens = nextTarget
      messages = compactionMessages(request.messages, targetTokens)
      estimatedInputTokens = estimateModelRequestTokens(messages)
    }

    const startedAt = Date.now()
    let summary = ''
    let usage: ModelUsage = { inputTokens: 0, outputTokens: 0 }
    let attemptDurationMs: number | undefined
    let attemptDurationSeen = false
    const providerRequest = {
      messages,
      ...(request.signal ? { signal: request.signal } : {}),
    }

    for await (const event of this.provider.complete(providerRequest)) {
      if (request.signal?.aborted) throw new AgentRunCancelledError()
      if (event.type === 'tool-call') {
        throw new Error('Compaction model must not call tools')
      }
      if (event.type === 'api-attempt-duration') {
        if (attemptDurationSeen) {
          throw new Error(
            'Provider emitted multiple api-attempt-duration events in one attempt',
          )
        }
        attemptDurationSeen = true
        const { durationMs } = event
        if (
          typeof durationMs !== 'number' ||
          !Number.isFinite(durationMs) ||
          durationMs < 0
        ) {
          throw new TypeError(
            'api-attempt-duration durationMs must be a finite nonnegative number',
          )
        }
        attemptDurationMs = durationMs
        continue
      }
      if (event.type === 'text-delta') summary += event.delta
      else if (event.type === 'usage') usage = event.usage
    }

    summary = summary.trim()
    if (summary.length === 0) {
      throw new Error('Compaction model returned an empty summary')
    }
    const summaryTokens = estimateTextTokens(summary)
    if (summaryTokens > targetTokens) {
      throw new Error(
        `Compaction summary exceeded ${targetTokens} tokens (estimated ${summaryTokens})`,
      )
    }
    const durationMs = Date.now() - startedAt
    const model = this.provider.model
    return {
      summary,
      usage,
      durationMs,
      durationWithoutRetriesMs: attemptDurationMs ?? durationMs,
      ...(model !== undefined && model.trim() !== '' ? { model } : {}),
    }
  }
}
