import type { ModelMessage, ModelToolCall } from '../core/runtime.js'
import type { TranscriptEvent } from '../core/transcript-event.js'

export type TranscriptDisplayItem =
  | { kind: 'user' | 'assistant' | 'thinking'; text: string }
  | { kind: 'compact'; summary: string }
  | { kind: 'tool'; call: ModelToolCall; detail: string }
  | { kind: 'tool-result'; callId: string; text: string; isError: boolean }
  | { kind: 'shell'; callId: string; command: string }
  | {
      kind: 'shell-result'
      callId: string
      stdout: string
      stderr: string
      isError: boolean
    }

function effectiveParentId(event: TranscriptEvent): string | null {
  return event.kind === 'context-boundary'
    ? event.logicalParentId
    : event.parentId
}

function bashEnvelope(
  content: string,
):
  | { kind: 'input'; command: string }
  | { kind: 'output'; stdout: string; stderr: string }
  | null {
  const input = /^<bash-input>([\s\S]*)<\/bash-input>$/u.exec(content)
  if (input) return { kind: 'input', command: input[1] ?? '' }
  const output =
    /^<bash-stdout>([\s\S]*)<\/bash-stdout><bash-stderr>([\s\S]*)<\/bash-stderr>$/u.exec(
      content,
    )
  return output
    ? { kind: 'output', stdout: output[1] ?? '', stderr: output[2] ?? '' }
    : null
}

export function activeEvents(
  events: readonly TranscriptEvent[],
  checkpoint?: string,
): TranscriptEvent[] {
  const all = [...events]
  const byId = new Map(all.map((event) => [event.id, event]))
  const parentIds = new Set(
    all.flatMap((event) => {
      const parentId = effectiveParentId(event)
      return parentId === null ? [] : [parentId]
    }),
  )
  const newest = (list: TranscriptEvent[]) =>
    [...list]
      .sort(
        (a, b) =>
          a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id),
      )
      .at(-1)
  let leaf =
    checkpoint === undefined
      ? (newest(all.filter((event) => !parentIds.has(event.id))) ?? newest(all))
      : byId.get(checkpoint)
  if (checkpoint !== undefined && !leaf)
    throw new Error(`Unknown transcript checkpoint: ${checkpoint}`)
  if (!leaf) return []
  const selected: TranscriptEvent[] = []
  const seen = new Set<string>()
  while (leaf && !seen.has(leaf.id)) {
    selected.push(leaf)
    seen.add(leaf.id)
    const parentId = effectiveParentId(leaf)
    leaf = parentId ? byId.get(parentId) : undefined
  }
  return selected.reverse()
}

export function projectActiveMessages(
  events: readonly TranscriptEvent[],
  checkpoint?: string,
): ModelMessage[] {
  const messages: ModelMessage[] = []
  for (const event of activeEvents(events, checkpoint)) {
    if (event.kind === 'context-boundary') {
      messages.length = 0
      continue
    }
    if (event.kind === 'context-summary') {
      messages.push({ role: 'user', content: event.summary })
      continue
    }
    if (event.kind === 'tool-execution-started') continue
    messages.push(...event.messages)
  }
  return messages
}

/** Return tool calls whose results are absent from the selected active branch. */
export function unresolvedActiveToolCallIds(
  messages: readonly ModelMessage[],
): string[] {
  const calls = new Set<string>()
  const results = new Set<string>()
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const call of message.toolCalls ?? []) calls.add(call.id)
    } else if (message.role === 'tool') {
      results.add(message.toolCallId)
    }
  }
  return [...calls].filter((id) => !results.has(id))
}

export function projectTranscriptDisplay(
  events: readonly TranscriptEvent[],
  checkpoint?: string,
): TranscriptDisplayItem[] {
  const items: TranscriptDisplayItem[] = []
  let pendingShell: { callId: string; command: string } | null = null
  for (const event of activeEvents(events, checkpoint)) {
    if (event.kind === 'context-summary') {
      items.push({ kind: 'compact', summary: event.summary })
      continue
    }
    if (event.kind !== 'messages') continue
    for (const message of event.messages) {
      if (message.role === 'user') {
        const shell = bashEnvelope(message.content)
        if (shell?.kind === 'input') {
          pendingShell = { callId: event.id, command: shell.command }
          items.push({ kind: 'shell', ...pendingShell })
          continue
        }
        if (shell?.kind === 'output' && pendingShell) {
          items.push({
            kind: 'shell-result',
            callId: pendingShell.callId,
            stdout: shell.stdout,
            stderr: shell.stderr,
            isError: shell.stderr.length > 0,
          })
          pendingShell = null
          continue
        }
        if (message.content) items.push({ kind: 'user', text: message.content })
        continue
      }
      if (message.role === 'assistant') {
        for (const thinking of message.thinkingBlocks ?? [])
          if (thinking.type === 'thinking' && thinking.thinking)
            items.push({ kind: 'thinking', text: thinking.thinking })
        if (message.content)
          items.push({ kind: 'assistant', text: message.content })
        for (const call of message.toolCalls ?? [])
          items.push({ kind: 'tool', call, detail: '' })
        continue
      }
      if (message.role === 'tool')
        items.push({
          kind: 'tool-result',
          callId: message.toolCallId,
          text: message.content,
          isError: message.isError,
        })
    }
  }
  return items
}

export function lastUserPrompt(
  events: readonly TranscriptEvent[],
  checkpoint?: string,
): string | null {
  const messages = projectActiveMessages(events, checkpoint)
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (
      message?.role === 'user' &&
      message.content &&
      bashEnvelope(message.content) === null
    )
      return message.content
  }
  return null
}
