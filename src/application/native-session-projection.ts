import type { TranscriptEvent } from '../core/transcript-event.js'
import type { NativeTranscriptEntry } from '../native/schema.js'

export function projectNativeSessionEntries(
  events: readonly TranscriptEvent[],
): NativeTranscriptEntry[] {
  const entries: NativeTranscriptEntry[] = []
  for (const event of events) {
    if (event.kind === 'context-boundary') {
      entries.push({
        type: 'system',
        uuid: event.id,
        parentUuid: event.parentId,
        subtype: 'compact_boundary',
        logicalParentUuid: event.logicalParentId,
        compactMetadata: {
          trigger: event.trigger,
          preTokens: event.preTokens,
          postTokens: event.postTokens,
          durationMs: event.durationMs,
        },
      })
      continue
    }
    if (event.kind === 'context-summary') {
      entries.push({
        type: 'user',
        uuid: event.id,
        parentUuid: event.parentId,
        isCompactSummary: true,
        message: { role: 'user', content: event.summary },
      })
      continue
    }
    if (event.kind !== 'messages') continue
    let parentUuid = event.parentId
    event.messages.forEach((message, index) => {
      const uuid =
        index === event.messages.length - 1 ? event.id : `${event.id}:${index}`
      if (message.role === 'user' && typeof message.content === 'string') {
        const agentMatch = message.content.match(
          /^<praxis-agent-setting>([^<]+)<\/praxis-agent-setting>$/u,
        )
        if (agentMatch?.[1]) {
          entries.push({
            type: 'agent-setting',
            agentSetting: agentMatch[1],
            uuid,
            parentUuid,
            sessionId: event.sessionId,
          })
          parentUuid = uuid
          return
        }
        const nameMatch = message.content.match(
          /^<praxis-session-name>([^<]+)<\/praxis-session-name>$/u,
        )
        if (nameMatch?.[1]) {
          entries.push({
            type: 'custom-title',
            customTitle: nameMatch[1],
            uuid,
            parentUuid,
            sessionId: event.sessionId,
          })
          parentUuid = uuid
          return
        }
        const match = message.content.match(
          /^<praxis-file-history>([\s\S]*)<\/praxis-file-history>$/u,
        )
        if (match?.[1]) {
          try {
            const operational = JSON.parse(match[1]) as NativeTranscriptEntry
            if (
              operational &&
              typeof operational === 'object' &&
              typeof operational.type === 'string' &&
              (operational.type === 'file-history-snapshot' ||
                operational.type === 'file-history-delta')
            ) {
              entries.push({
                ...operational,
                uuid,
                parentUuid,
                sessionId: event.sessionId,
              })
              parentUuid = uuid
              return
            }
          } catch {
            // Keep malformed operational markers visible as ordinary native user messages.
          }
        }
      }
      if (message.role === 'tool') {
        entries.push({
          type: 'user',
          uuid,
          parentUuid,
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: message.toolCallId,
                content: message.content,
                is_error: message.isError,
              },
            ],
          },
        })
        parentUuid = uuid
        return
      }
      if (message.role === 'assistant') {
        const content: Record<string, unknown>[] = []
        if (message.content)
          content.push({ type: 'text', text: message.content })
        for (const call of message.toolCalls ?? [])
          content.push({
            type: 'tool_use',
            id: call.id,
            name: call.name,
            input: call.input,
          })
        entries.push({
          type: 'assistant',
          uuid,
          parentUuid,
          message: { role: 'assistant', content },
        })
        parentUuid = uuid
        return
      }
      entries.push({
        type: message.role,
        uuid,
        parentUuid,
        message: { role: message.role, content: message.content },
      })
      parentUuid = uuid
    })
  }
  return entries
}
