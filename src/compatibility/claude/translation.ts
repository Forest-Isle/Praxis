import { randomUUID } from 'node:crypto'

import type { ClaudeTranscriptEntry } from './schema.js'
import type { ClaudeConditionalRule } from './shared-resources.js'
import { indexClaudeToolLinks } from './tool-links.js'

export type ProviderPersistenceEvent =
  | { type: 'user-text'; text: string }
  | {
      type: 'assistant-message'
      text: string
      toolCalls: readonly {
        id: string
        name: string
        input: Record<string, unknown>
      }[]
      providerMessageId: string
      model: string
    }
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
  history?: readonly ClaudeTranscriptEntry[]
  createUuid?: () => string
  now?: () => string
}

export interface ClaudeLastPromptEntryOptions {
  sessionId: string
  lastPrompt: string
  leafUuid: string
}

export function createClaudeRuleAttachmentEntry(
  rule: ClaudeConditionalRule,
  displayPath: string,
  context: TranslationContext,
): ClaudeTranscriptEntry {
  const createUuid = context.createUuid ?? randomUUID
  const now = context.now ?? (() => new Date().toISOString())
  return {
    parentUuid: context.parentUuid,
    isSidechain: false,
    attachment: {
      type: 'nested_memory',
      path: rule.path,
      content: {
        path: rule.path,
        type: rule.scope === 'user' ? 'User' : 'Project',
        content: rule.content,
        globs: rule.globs,
        contentDiffersFromDisk: true,
        rawContent: rule.rawContent,
      },
      displayPath,
    },
    type: 'attachment',
    uuid: createUuid(),
    timestamp: now(),
    userType: 'external',
    entrypoint: 'cli',
    cwd: context.cwd,
    sessionId: context.sessionId,
    version: context.claudeVersion,
    gitBranch: context.gitBranch,
  }
}

export function createClaudeLastPromptEntry({
  sessionId,
  lastPrompt,
  leafUuid,
}: ClaudeLastPromptEntryOptions): ClaudeTranscriptEntry {
  return {
    type: 'last-prompt',
    lastPrompt,
    sessionId,
    leafUuid,
  }
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
    inference_geo: '',
  }
}

function assistantMessage(
  event: {
    providerMessageId: string
    model: string
  },
  content: readonly Record<string, unknown>[],
  stopReason: 'end_turn' | 'tool_use',
) {
  return {
    id: event.providerMessageId,
    type: 'message',
    role: 'assistant',
    model: event.model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: emptyUsage(),
    stop_details: null,
  }
}

export function translateProviderEvents(
  events: readonly ProviderPersistenceEvent[],
  context: TranslationContext,
): ClaudeTranscriptEntry[] {
  const createUuid = context.createUuid ?? randomUUID
  const now = context.now ?? (() => new Date().toISOString())
  const entries: ClaudeTranscriptEntry[] = []
  const toolSources = indexClaudeToolLinks(context.history ?? []).toolCalls
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

      case 'assistant-message': {
        const content: Record<string, unknown>[] = []
        if (event.text.length > 0) {
          content.push({ type: 'text', text: event.text })
        }
        for (const call of event.toolCalls) {
          toolSources.set(call.id, uuid)
          content.push({
            type: 'tool_use',
            id: call.id,
            name: call.name,
            input: call.input,
          })
        }
        if (content.length === 0) {
          throw new Error('Assistant message has no text or tool calls')
        }
        entry = {
          ...common,
          type: 'assistant',
          message: assistantMessage(
            event,
            content,
            event.toolCalls.length > 0 ? 'tool_use' : 'end_turn',
          ),
        }
        break
      }

      case 'assistant-text':
        entry = {
          ...common,
          type: 'assistant',
          message: assistantMessage(
            event,
            [{ type: 'text', text: event.text }],
            'end_turn',
          ),
        }
        break

      case 'assistant-tool-call':
        toolSources.set(event.toolCallId, uuid)
        entry = {
          ...common,
          type: 'assistant',
          message: assistantMessage(
            event,
            [
              {
                type: 'tool_use',
                id: event.toolCallId,
                name: event.name,
                input: event.input,
              },
            ],
            'tool_use',
          ),
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
