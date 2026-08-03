import { randomUUID } from 'node:crypto'

import type { ClaudeTranscriptEntry } from './schema.js'

export type ProviderPersistenceEvent =
  | { type: 'user-text'; text: string }
  | {
      type: 'assistant-text'
      text: string
      providerMessageId: string
      model: string
    }
  | {
      type: 'assistant-tool-call'
      toolCallId: string
      name: string
      input: Record<string, unknown>
      providerMessageId: string
      model: string
    }
  | {
      type: 'tool-result'
      toolCallId: string
      content: string
      isError: boolean
    }

export interface TranslationContext {
  sessionId: string
  parentUuid: string | null
  cwd: string
  claudeVersion: string
  gitBranch: string | null
  createUuid?: () => string
  now?: () => string
}

function emptyUsage() {
  return {
    input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
    server_tool_use: {
      web_search_requests: 0,
      web_fetch_requests: 0,
    },
    service_tier: 'standard',
    cache_creation: {
      ephemeral_1h_input_tokens: 0,
      ephemeral_5m_input_tokens: 0,
    },
  }
}

export function translateProviderEvents(
  events: readonly ProviderPersistenceEvent[],
  context: TranslationContext,
): ClaudeTranscriptEntry[] {
  const createUuid = context.createUuid ?? randomUUID
  const now = context.now ?? (() => new Date().toISOString())
  const entries: ClaudeTranscriptEntry[] = []
  const toolSources = new Map<string, string>()
  let parentUuid = context.parentUuid

  for (const event of events) {
    const uuid = createUuid()
    const common = {
      parentUuid,
      isSidechain: false,
      uuid,
      timestamp: now(),
      userType: 'external',
      entrypoint: 'cli',
      cwd: context.cwd,
      sessionId: context.sessionId,
      version: context.claudeVersion,
      gitBranch: context.gitBranch,
    }
    let entry: ClaudeTranscriptEntry

    switch (event.type) {
      case 'user-text':
        entry = {
          ...common,
          type: 'user',
          promptId: uuid,
          permissionMode: 'default',
          promptSource: 'interactive',
          message: { role: 'user', content: event.text },
        }
        break

      case 'assistant-text':
        entry = {
          ...common,
          type: 'assistant',
          message: {
            id: event.providerMessageId,
            type: 'message',
            role: 'assistant',
            model: event.model,
            content: [{ type: 'text', text: event.text }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: emptyUsage(),
            stop_details: null,
          },
        }
        break

      case 'assistant-tool-call':
        toolSources.set(event.toolCallId, uuid)
        entry = {
          ...common,
          type: 'assistant',
          message: {
            id: event.providerMessageId,
            type: 'message',
            role: 'assistant',
            model: event.model,
            content: [
              {
                type: 'tool_use',
                id: event.toolCallId,
                name: event.name,
                input: event.input,
              },
            ],
            stop_reason: 'tool_use',
            stop_sequence: null,
            usage: emptyUsage(),
            stop_details: null,
          },
        }
        break

      case 'tool-result': {
        const sourceToolAssistantUUID = toolSources.get(event.toolCallId)
        if (!sourceToolAssistantUUID) {
          throw new Error(
            `Tool result has no matching tool call: ${event.toolCallId}`,
          )
        }
        entry = {
          ...common,
          type: 'user',
          promptId: uuid,
          sourceToolAssistantUUID,
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: event.toolCallId,
                content: event.content,
                is_error: event.isError,
              },
            ],
          },
          toolUseResult: {
            stdout: event.isError ? '' : event.content,
            stderr: event.isError ? event.content : '',
            interrupted: false,
            isImage: false,
            noOutputExpected: false,
          },
        }
        break
      }
    }

    entries.push(entry)
    parentUuid = uuid
  }

  return entries
}
