import type {
  CompactionRequest,
  CompactionResult,
  Compactor,
} from '../core/compaction.js'
import { estimateTextTokens } from '../core/context-budget.js'
import {
  AgentRunCancelledError,
  type ModelProvider,
  type ModelUsage,
} from '../core/runtime.js'

const COMPACTION_INSTRUCTIONS = `You are compacting an agent conversation so work can continue without the discarded messages. Preserve user intent, completed work, exact decisions, constraints, file paths, commands, errors, pending tasks, and the latest user request. Do not solve the task. Return only the durable summary as plain text. Do not call tools.`

export class ModelCompactor implements Compactor {
  constructor(private readonly provider: ModelProvider) {}

  async compact(request: CompactionRequest): Promise<CompactionResult> {
    if (!Number.isInteger(request.targetTokens) || request.targetTokens <= 0) {
      throw new Error('Compaction target tokens must be a positive integer')
    }
    if (request.signal?.aborted) throw new AgentRunCancelledError()

    const startedAt = Date.now()
    let summary = ''
    let usage: ModelUsage = { inputTokens: 0, outputTokens: 0 }
    const providerRequest = {
      messages: [
        { role: 'system' as const, content: COMPACTION_INSTRUCTIONS },
        ...request.messages,
        {
          role: 'user' as const,
          content: `Create a continuation summary no longer than ${request.targetTokens} estimated tokens.`,
        },
      ],
      ...(request.signal ? { signal: request.signal } : {}),
    }

    for await (const event of this.provider.complete(providerRequest)) {
      if (request.signal?.aborted) throw new AgentRunCancelledError()
      if (event.type === 'tool-call') {
        throw new Error('Compaction model must not call tools')
      }
      if (event.type === 'text-delta') summary += event.delta
      else usage = event.usage
    }

    summary = summary.trim()
    if (summary.length === 0) {
      throw new Error('Compaction model returned an empty summary')
    }
    const summaryTokens = estimateTextTokens(summary)
    if (summaryTokens > request.targetTokens) {
      throw new Error(
        `Compaction summary exceeded ${request.targetTokens} tokens (estimated ${summaryTokens})`,
      )
    }
    return { summary, usage, durationMs: Date.now() - startedAt }
  }
}
