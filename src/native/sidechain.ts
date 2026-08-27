import { resolve } from 'node:path'

import type { ModelUsage } from '../core/runtime.js'
import { isClaudeSessionId } from './paths.js'
import type { NativeTranscriptEntry } from './schema.js'

/** Claude uses a stable 16-hex suffix and may prefix it with a bounded label.
 * Keeping the accepted alphabet filename-safe makes path construction a pure
 * validation boundary rather than a sanitizing rewrite. */
const CLAUDE_AGENT_ID_PATTERN =
  /^a(?:[A-Za-z0-9][A-Za-z0-9_-]{0,62}-)?[0-9a-f]{16}$/u

export function isClaudeAgentId(agentId: string): boolean {
  return CLAUDE_AGENT_ID_PATTERN.test(agentId)
}

export function assertClaudeAgentId(agentId: string): void {
  if (!isClaudeAgentId(agentId)) {
    throw new Error(`Invalid Claude agent ID: ${agentId}`)
  }
}

export interface ClaudeSidechainPaths {
  sessionId: string
  agentId: string
  directory: string
  transcriptFile: string
  metadataFile: string
}

export interface ClaudeSidechainPathOptions {
  /** Bounded relative subdirectory under `<sessionId>/subagents` (e.g. `workflows/<runId>`). */
  subdirectory?: string
}

export interface ClaudeSidechainMetadata {
  readonly [key: string]: unknown
  agentType: string
  description: string
  toolUseId: string
  spawnDepth: number
  name?: string
  permissionMode?: ClaudeSidechainPermissionMode
  isolation?: 'worktree'
  parentAgentId?: string
  worktreePath?: string
}

export type ClaudeSidechainPermissionMode =
  'acceptEdits' | 'auto' | 'bypassPermissions' | 'default' | 'dontAsk' | 'plan'

export function resolveClaudeSidechainPaths(
  projectRoot: string,
  sessionId: string,
  agentId: string,
  options: ClaudeSidechainPathOptions = {},
): ClaudeSidechainPaths {
  if (!isClaudeSessionId(sessionId)) {
    throw new Error(`Invalid Claude session ID: ${sessionId}`)
  }
  assertClaudeAgentId(agentId)
  const subdirectory = options.subdirectory
  if (
    subdirectory !== undefined &&
    (subdirectory.length === 0 ||
      subdirectory.startsWith('/') ||
      subdirectory.includes('\\') ||
      subdirectory.includes('\0') ||
      subdirectory
        .split('/')
        .some((segment) => segment === '.' || segment === '..'))
  ) {
    throw new Error(`Invalid Claude sidechain subdirectory: ${subdirectory}`)
  }
  const directory =
    subdirectory === undefined
      ? resolve(projectRoot, sessionId, 'subagents')
      : resolve(projectRoot, sessionId, 'subagents', subdirectory)
  return {
    sessionId,
    agentId,
    directory,
    transcriptFile: resolve(directory, `agent-${agentId}.jsonl`),
    metadataFile: resolve(directory, `agent-${agentId}.meta.json`),
  }
}

export function createClaudeSidechainRoot(options: {
  sessionId: string
  promptId: string
  prompt: string
  agentId: string
  cwd: string
  claudeVersion: string
  gitBranch: string | null
  uuid: string
  timestamp: string
}): NativeTranscriptEntry {
  return {
    parentUuid: null,
    isSidechain: true,
    agentId: options.agentId,
    promptId: options.promptId,
    type: 'user',
    message: { role: 'user', content: options.prompt },
    uuid: options.uuid,
    timestamp: options.timestamp,
    userType: 'external',
    entrypoint: 'cli',
    cwd: options.cwd,
    sessionId: options.sessionId,
    version: options.claudeVersion,
    gitBranch: options.gitBranch,
  }
}

export function toClaudeSidechainEntry(
  entry: NativeTranscriptEntry,
  agentId: string,
  agentType: string,
): NativeTranscriptEntry {
  return {
    ...entry,
    isSidechain: true,
    agentId,
    ...(entry.type === 'assistant' ? { attributionAgent: agentType } : {}),
  }
}

function nativeUsage(usage: ModelUsage): Record<string, unknown> {
  return {
    input_tokens: usage.inputTokens,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: usage.outputTokens,
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

export function createClaudeAgentToolUseResult(options: {
  prompt: string
  agentId: string
  agentType: string
  text: string
  resolvedModel: string
  durationMs: number
  usage: ModelUsage
  toolUseCount: number
}): Record<string, unknown> {
  return {
    status: 'completed',
    prompt: options.prompt,
    agentId: options.agentId,
    agentType: options.agentType,
    content: [{ type: 'text', text: options.text }],
    resolvedModel: options.resolvedModel,
    totalDurationMs: options.durationMs,
    totalTokens: options.usage.inputTokens + options.usage.outputTokens,
    totalToolUseCount: options.toolUseCount,
    usage: nativeUsage(options.usage),
  }
}

export function createClaudeAsyncAgentToolUseResult(options: {
  prompt: string
  agentId: string
  description: string
  resolvedModel: string
  outputFile: string
}): Record<string, unknown> {
  return {
    isAsync: true,
    status: 'async_launched',
    agentId: options.agentId,
    description: options.description,
    resolvedModel: options.resolvedModel,
    prompt: options.prompt,
    outputFile: options.outputFile,
    canReadOutputFile: true,
  }
}
