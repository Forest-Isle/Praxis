import type {
  ModelMessage,
  ModelProvider,
  ModelUsage,
  ToolUseSummaryOutcome,
} from '../core/runtime.js'
import {
  completeMeteredModelRequest,
  type MeteredModelCompletion,
} from './metered-model-completion.js'

const TOOL_USE_SUMMARY_SYSTEM_PROMPT = `Write a short summary label describing what these tool calls accomplished. It appears as a single-line row in a mobile app and truncates around 30 characters, so think git-commit-subject, not sentence.

Keep the verb in past tense and the most distinctive noun. Drop articles, connectors, and long location context first.

Examples:
- Searched in auth/
- Fixed NPE in UserService
- Created signup endpoint
- Read config.json
- Ran failing tests`

export interface ToolUseSummaryInput {
  name: string
  input: Record<string, unknown>
  output: string
}

function truncateJson(value: unknown, maxLength: number): string {
  let serialized: string
  try {
    serialized = JSON.stringify(value)
  } catch {
    return '[unable to serialize]'
  }
  if (serialized.length <= maxLength) return serialized
  return `${serialized.slice(0, maxLength - 3)}...`
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

export async function generateToolUseSummary(
  provider: ModelProvider,
  tools: readonly ToolUseSummaryInput[],
  signal: AbortSignal,
  lastAssistantText?: string,
  onMetrics?: (metrics: {
    usage: ModelUsage
    model?: string
    durationApiMs: number
    durationApiWithoutRetriesMs: number
  }) => void,
): Promise<ToolUseSummaryOutcome | null> {
  if (tools.length === 0 || signal.aborted) return null
  const toolSummaries = tools
    .map(
      (tool) =>
        `Tool: ${tool.name}\nInput: ${truncateJson(tool.input, 300)}\nOutput: ${truncateJson(tool.output, 300)}`,
    )
    .join('\n\n')
  const contextPrefix = lastAssistantText
    ? `User's intent (from assistant's last message): ${lastAssistantText.slice(0, 200)}\n\n`
    : ''
  const messages: ModelMessage[] = [
    { role: 'system', content: TOOL_USE_SUMMARY_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `${contextPrefix}Tools completed:\n\n${toolSummaries}\n\nLabel:`,
    },
  ]
  let metrics: MeteredModelCompletion | undefined
  let summary: string | null = null
  try {
    const completed = await completeMeteredModelRequest(
      provider,
      { messages, signal },
      {
        onMetrics: (recorded) => {
          metrics = recorded
        },
      },
    )
    summary =
      completed.toolCalls.length === 0 ? completed.text.trim() || null : null
  } catch {
    // Provider/validation/abort errors keep the captured metrics but yield no
    // summary, preserving the auxiliary-failure semantics.
    summary = null
  }
  // Invoke the external callback exactly once when the provider call started.
  // Callback/tracker errors are intentionally not caught so cost accounting
  // fails closed. Without an external callback nothing was committed, so the
  // outcome stays unrecorded.
  let meteredExternally = false
  if (metrics) {
    onMetrics?.(metrics)
    meteredExternally = onMetrics !== undefined
  }
  const usage = metrics?.usage ?? { inputTokens: 0, outputTokens: 0 }
  const model =
    metrics?.model !== undefined && metrics.model.trim() !== ''
      ? metrics.model
      : 'praxis/provider'
  return {
    summary,
    usage,
    ...(hasNonZeroUsage(usage) ? { modelUsage: { [model]: usage } } : {}),
    durationApiMs: metrics?.durationApiMs ?? 0,
    durationApiWithoutRetriesMs: metrics?.durationApiWithoutRetriesMs ?? 0,
    meteredExternally,
  }
}
