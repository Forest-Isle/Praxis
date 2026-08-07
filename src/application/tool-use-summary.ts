import type { ModelMessage, ModelProvider } from '../core/runtime.js'

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

export async function generateToolUseSummary(
  provider: ModelProvider,
  tools: readonly ToolUseSummaryInput[],
  signal: AbortSignal,
  lastAssistantText?: string,
): Promise<string | null> {
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
  let summary = ''
  try {
    for await (const event of provider.complete({ messages, signal })) {
      if (signal.aborted) return null
      if (event.type === 'text-delta') summary += event.delta
    }
  } catch {
    return null
  }
  return summary.trim() || null
}
