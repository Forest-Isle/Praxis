import { randomUUID } from 'node:crypto'

import type { NativeTranscriptEntry } from './schema.js'
import type { ConditionalRule } from '../core/resources.js'
import { getClaudeContentBlocks, indexClaudeToolLinks } from './tool-links.js'
import type {
  ModelContentBlock,
  ModelDocument,
  ModelImage,
  ModelThinkingBlock,
} from '../core/runtime.js'
import type {
  ClaudeHookExecution,
  ClaudeHookOutcome,
} from '../hooks/claude-hooks.js'

export type ProviderPersistenceEvent =
  | { type: 'user-text'; text: string }
  | { type: 'user-text-block'; text: string }
  | { type: 'bash-input'; command: string }
  | { type: 'bash-output'; stdout: string; stderr: string }
  | {
      type: 'user-message'
      text: string
      images?: readonly ModelImage[]
      documents?: readonly ModelDocument[]
    }
  | {
      type: 'assistant-message'
      text: string
      thinkingBlocks?: readonly ModelThinkingBlock[]
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
      contentBlocks?: readonly ModelContentBlock[]
      images?: readonly ModelImage[]
      documents?: readonly ModelDocument[]
      isError: boolean
      nativeToolUseResult?: Record<string, unknown>
      nativeMcpMeta?: Record<string, unknown>
    }

export interface TranslationContext {
  sessionId: string
  parentUuid: string | null
  cwd: string
  claudeVersion: string
  gitBranch: string | null
  sessionKind?: 'bg'
  history?: readonly NativeTranscriptEntry[]
  createUuid?: () => string
  now?: () => string
}

export interface ClaudeLastPromptEntryOptions {
  sessionId: string
  lastPrompt: string
  leafUuid: string
}

function hookExecutionContent(execution: ClaudeHookExecution): string {
  if (
    execution.event !== 'UserPromptSubmit' &&
    execution.event !== 'SessionStart'
  ) {
    return ''
  }
  const stdout = execution.stdout.trim()
  if (stdout.startsWith('{')) {
    try {
      const value = JSON.parse(stdout) as Record<string, unknown>
      if (typeof value.stopReason === 'string') return value.stopReason
      const specific = value.hookSpecificOutput
      if (
        specific &&
        typeof specific === 'object' &&
        typeof (specific as Record<string, unknown>).additionalContext ===
          'string'
      )
        return (specific as Record<string, unknown>).additionalContext as string
      return ''
    } catch {
      return stdout
    }
  }
  return stdout
}

export function createClaudeHookAttachmentEntries(
  outcome: ClaudeHookOutcome,
  context: TranslationContext,
): NativeTranscriptEntry[] {
  const createUuid = context.createUuid ?? randomUUID
  const now = context.now ?? (() => new Date().toISOString())
  const entries: NativeTranscriptEntry[] = []
  let parentUuid = context.parentUuid
  const persistedExecutions = outcome.executions.filter(
    (execution) =>
      !(
        (execution.event === 'Stop' || execution.event === 'SessionEnd') &&
        execution.exitCode === 0 &&
        execution.stdout.length === 0 &&
        execution.stderr.length === 0
      ),
  )
  for (const execution of persistedExecutions) {
    const uuid = createUuid()
    entries.push({
      parentUuid,
      isSidechain: false,
      attachment: {
        type: execution.exitCode === 0 ? 'hook_success' : 'hook_error',
        hookName: execution.hookName,
        toolUseID: execution.toolUseId,
        hookEvent: execution.event,
        content:
          execution.exitCode === 0
            ? hookExecutionContent(execution)
            : execution.stderr.trim(),
        stdout: execution.stdout,
        stderr: execution.stderr,
        exitCode: execution.exitCode,
        command: execution.command,
        durationMs: execution.durationMs,
      },
      type: 'attachment',
      uuid,
      timestamp: now(),
      userType: 'external',
      entrypoint: 'cli',
      cwd: context.cwd,
      sessionId: context.sessionId,
      version: context.claudeVersion,
      gitBranch: context.gitBranch,
    })
    parentUuid = uuid
  }
  if (outcome.additionalContext.length > 0) {
    const execution = persistedExecutions.at(-1)
    entries.push({
      parentUuid,
      isSidechain: false,
      attachment: {
        type: 'hook_additional_context',
        content: outcome.additionalContext,
        ...(execution
          ? {
              hookName: execution.hookName,
              toolUseID: execution.toolUseId,
              hookEvent: execution.event,
            }
          : {}),
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
    })
  }
  return entries
}

export function createClaudeRuleAttachmentEntry(
  rule: ConditionalRule,
  displayPath: string,
  context: TranslationContext,
): NativeTranscriptEntry {
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
}: ClaudeLastPromptEntryOptions): NativeTranscriptEntry {
  return {
    type: 'last-prompt',
    lastPrompt,
    sessionId,
    leafUuid,
  }
}

export function createClaudeAgentSettingEntry(
  sessionId: string,
  agent: string,
): NativeTranscriptEntry {
  return { type: 'agent-setting', agentSetting: agent, sessionId }
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

function mcpAttribution(toolName: string | undefined) {
  if (!toolName?.startsWith('mcp__')) return undefined
  const separator = toolName.indexOf('__', 5)
  if (separator < 0) return undefined
  const server = toolName.slice(5, separator)
  const tool = toolName.slice(separator + 2)
  return server.length > 0 && tool.length > 0
    ? { attributionMcpServer: server, attributionMcpTool: tool }
    : undefined
}

function nativeContentBlocks(
  blocks: readonly ModelContentBlock[],
): Record<string, unknown>[] {
  return blocks.map((block) =>
    block.type === 'text'
      ? { type: 'text', text: block.text }
      : {
          type: block.type,
          source: {
            type: 'base64',
            media_type: block.mediaType,
            data: block.data,
          },
        },
  )
}

export function translateProviderEvents(
  events: readonly ProviderPersistenceEvent[],
  context: TranslationContext,
): NativeTranscriptEntry[] {
  const createUuid = context.createUuid ?? randomUUID
  const now = context.now ?? (() => new Date().toISOString())
  const entries: NativeTranscriptEntry[] = []
  const history = context.history ?? []
  const indexedTools = indexClaudeToolLinks(history)
  const toolSources = indexedTools.toolCalls
  const toolNames = indexedTools.toolNames
  const lastHistoryEntry = history.at(-1)
  const lastToolResult =
    lastHistoryEntry?.type === 'user'
      ? getClaudeContentBlocks(lastHistoryEntry)
          .filter(
            (block) =>
              block.type === 'tool_result' &&
              typeof block.tool_use_id === 'string',
          )
          .at(-1)
      : undefined
  let pendingMcpAttribution = mcpAttribution(
    typeof lastToolResult?.tool_use_id === 'string'
      ? toolNames.get(lastToolResult.tool_use_id)
      : undefined,
  )
  let currentPromptId = history.findLast(
    (entry) => entry.type === 'user' && typeof entry.promptId === 'string',
  )?.promptId as string | undefined
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
      ...(context.sessionKind === undefined
        ? {}
        : { sessionKind: context.sessionKind }),
    }
    let entry: NativeTranscriptEntry

    switch (event.type) {
      case 'user-text':
        currentPromptId = uuid
        entry = {
          ...common,
          type: 'user',
          promptId: uuid,
          permissionMode: 'default',
          promptSource: 'interactive',
          message: { role: 'user', content: event.text },
        }
        break

      case 'user-text-block':
        currentPromptId = uuid
        entry = {
          ...common,
          type: 'user',
          promptId: uuid,
          permissionMode: 'default',
          promptSource: 'interactive',
          message: {
            role: 'user',
            content: [{ type: 'text', text: event.text }],
          },
        }
        break

      case 'bash-input':
        entry = {
          ...common,
          type: 'user',
          message: {
            role: 'user',
            content: `<bash-input>${event.command}</bash-input>`,
          },
        }
        break

      case 'bash-output':
        entry = {
          ...common,
          type: 'user',
          message: {
            role: 'user',
            content: `<bash-stdout>${event.stdout}</bash-stdout><bash-stderr>${event.stderr}</bash-stderr>`,
          },
        }
        break

      case 'user-message': {
        currentPromptId = uuid
        const content: Record<string, unknown>[] = []
        if (event.text.length > 0)
          content.push({ type: 'text', text: event.text })
        for (const image of event.images ?? []) {
          content.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: image.mediaType,
              data: image.data,
            },
          })
        }
        for (const document of event.documents ?? []) {
          content.push({
            type: 'document',
            source: {
              type: 'base64',
              media_type: document.mediaType,
              data: document.data,
            },
          })
        }
        if (content.length === 0) throw new Error('User message has no content')
        entry = {
          ...common,
          type: 'user',
          promptId: currentPromptId ?? uuid,
          permissionMode: 'default',
          promptSource: 'interactive',
          message: { role: 'user', content },
        }
        break
      }

      case 'assistant-message': {
        const content: Record<string, unknown>[] = []
        content.push(...(event.thinkingBlocks ?? []))
        if (event.text.length > 0) {
          content.push({ type: 'text', text: event.text })
        }
        for (const call of event.toolCalls) {
          toolSources.set(call.id, uuid)
          toolNames.set(call.id, call.name)
          content.push({
            type: 'tool_use',
            id: call.id,
            name: call.name,
            input: call.input,
          })
        }
        if (content.length === 0) {
          throw new Error(
            'Assistant message has no thinking, text, or tool calls',
          )
        }
        entry = {
          ...common,
          type: 'assistant',
          ...pendingMcpAttribution,
          message: assistantMessage(
            event,
            content,
            event.toolCalls.length > 0 ? 'tool_use' : 'end_turn',
          ),
        }
        pendingMcpAttribution = undefined
        break
      }

      case 'assistant-text':
        entry = {
          ...common,
          type: 'assistant',
          ...pendingMcpAttribution,
          message: assistantMessage(
            event,
            [{ type: 'text', text: event.text }],
            'end_turn',
          ),
        }
        pendingMcpAttribution = undefined
        break

      case 'assistant-tool-call':
        toolSources.set(event.toolCallId, uuid)
        toolNames.set(event.toolCallId, event.name)
        entry = {
          ...common,
          type: 'assistant',
          ...pendingMcpAttribution,
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
        pendingMcpAttribution = undefined
        break

      case 'tool-result': {
        const sourceToolAssistantUUID = toolSources.get(event.toolCallId)
        if (!sourceToolAssistantUUID) {
          throw new Error(
            `Tool result has no matching tool call: ${event.toolCallId}`,
          )
        }
        const media = [
          ...(event.images ?? []).map((image) => ({
            type: 'image',
            source: {
              type: 'base64',
              media_type: image.mediaType,
              data: image.data,
            },
          })),
          ...(event.documents ?? []).map((document) => ({
            type: 'document',
            source: {
              type: 'base64',
              media_type: document.mediaType,
              data: document.data,
            },
          })),
        ]
        if (media.length > 0 && event.isError) {
          throw new Error('Claude media tool results cannot be errors')
        }
        const orderedContent = event.contentBlocks
          ? nativeContentBlocks(event.contentBlocks)
          : undefined
        const toolResultContent =
          orderedContent ??
          (media.length === 0
            ? event.content
            : [
                ...(event.content.length > 0
                  ? [{ type: 'text', text: event.content }]
                  : []),
                ...media,
              ])
        const attribution = mcpAttribution(toolNames.get(event.toolCallId))
        const nativeToolUseResult = event.nativeToolUseResult
        const fallbackToolUseResult =
          media.length === 0
            ? {
                stdout: event.isError ? '' : event.content,
                stderr: event.isError ? event.content : '',
                interrupted: false,
                isImage: false,
                noOutputExpected: false,
              }
            : event.images?.length === 1 && !event.documents?.length
              ? {
                  type: 'image',
                  file: {
                    base64: event.images[0]?.data,
                    type: event.images[0]?.mediaType,
                    originalSize: Buffer.from(
                      event.images[0]?.data ?? '',
                      'base64',
                    ).length,
                  },
                }
              : event.documents?.length === 1 && !event.images?.length
                ? {
                    type: 'document',
                    file: {
                      base64: event.documents[0]?.data,
                      type: event.documents[0]?.mediaType,
                      originalSize: Buffer.from(
                        event.documents[0]?.data ?? '',
                        'base64',
                      ).length,
                    },
                  }
                : {
                    type: 'media',
                    count: media.length,
                  }
        entry = {
          ...common,
          type: 'user',
          promptId: currentPromptId ?? uuid,
          sourceToolAssistantUUID,
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: event.toolCallId,
                content: toolResultContent,
                ...(media.length === 0 && !orderedContent
                  ? { is_error: event.isError }
                  : event.isError
                    ? { is_error: true }
                    : {}),
              },
            ],
          },
          toolUseResult:
            attribution && Array.isArray(toolResultContent)
              ? toolResultContent
              : (nativeToolUseResult ?? fallbackToolUseResult),
          ...(event.nativeMcpMeta ? { mcpMeta: event.nativeMcpMeta } : {}),
        }
        pendingMcpAttribution = attribution
        break
      }
    }

    entries.push(entry)
    parentUuid = uuid
  }

  return entries
}
