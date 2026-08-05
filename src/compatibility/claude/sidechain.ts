import { resolve } from 'node:path'

import type { ModelUsage } from '../../core/runtime.js'
import { isClaudeSessionId } from './paths.js'
import type { ClaudeTranscriptEntry } from './schema.js'

const AGENT_ID_PATTERN = /^a[0-9a-f]{16}$/u

export interface ClaudeSidechainPaths {
  sessionId: string
  agentId: string
  directory: string
  transcriptFile: string
  metadataFile: string
}

export interface ClaudeSidechainMetadata {
  agentType: string
  description: string
  toolUseId: string
  spawnDepth: number
}

export function resolveClaudeSidechainPaths(
  projectRoot: string,
  sessionId: string,
  agentId: string,
): ClaudeSidechainPaths {
  if (!isClaudeSessionId(sessionId)) {
    throw new Error(`Invalid Claude session ID: ${sessionId}`)
  }
  if (!AGENT_ID_PATTERN.test(agentId)) {
    throw new Error(`Invalid Claude agent ID: ${agentId}`)
  }
  const directory = resolve(projectRoot, sessionId, 'subagents')
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
}): ClaudeTranscriptEntry {
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
  entry: ClaudeTranscriptEntry,
  agentId: string,
  agentType: string,
): ClaudeTranscriptEntry {
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
