import { randomUUID } from 'node:crypto'
import {
  appendFile,
  copyFile,
  link,
  lstat,
  mkdir,
  readdir,
  realpath,
  stat,
  unlink,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import {
  basename,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path'

import { isPathWithin } from '../platform/path-containment.js'

import {
  AGENT_COLOR_DEFAULT,
  agentColorMessage,
  getClaudeEffectiveAgentColor,
  type AgentColorName,
  type AgentColorSelection,
  type AgentColorValue,
} from '../compatibility/claude/agent-color.js'
import type { ClaudeConditionalRuleResolver } from '../compatibility/claude/context.js'
import {
  createClaudeCompactEntries,
  formatClaudeCompactSummary,
  getCumulativeDroppedTokens,
} from '../compatibility/claude/compaction.js'
import {
  discoverClaudeProjectRoot,
  isClaudeSessionId,
  resolveClaudePaths,
  resolveClaudeScheduledTaskFile,
} from '../compatibility/claude/paths.js'
import {
  resolveDataPlanePaths,
  resolveScheduledTaskFile,
  type DataPlane,
} from '../persistence/data-plane.js'
import {
  downloadClaudeFileResources,
  type ClaudeFileResource,
  type ClaudeFileResourceConfig,
} from '../compatibility/claude/file-resources.js'
import { createClaudeNativeFork } from '../compatibility/claude/fork.js'
import {
  selectClaudeActiveTranscript,
  selectClaudeTranscriptAtMessage,
} from '../compatibility/claude/history.js'
import { ClaudeFileHistory } from '../compatibility/claude/file-history.js'
import { getClaudePrLink } from '../compatibility/claude/pr-links.js'
import {
  type ClaudeDisplayTranscriptItem,
  getClaudeAgentSetting,
  getClaudeLastPrompt,
  projectClaudeDisplayTranscript,
  projectClaudeModelMessages,
} from '../compatibility/claude/projection.js'
import {
  type ClaudeTranscriptEntry,
  selectClaudeSchemaAdapter,
} from '../compatibility/claude/schema.js'
import {
  findUnresolvedClaudeToolCalls,
  getClaudeContentBlocks,
} from '../compatibility/claude/tool-links.js'
import {
  createClaudeAgentSettingEntry,
  createClaudeHookAttachmentEntries,
  createClaudeLastPromptEntry,
  createClaudeRuleAttachmentEntry,
  translateProviderEvents,
} from '../compatibility/claude/translation.js'
import {
  AgentRunCancelledError,
  type AgentRunRequest,
  type AgentRunResult,
  AgentRuntime,
  type ModelContentBlock,
  type ModelDocument,
  type ModelImage,
  type ModelMessage,
  type ModelThinkingBlock,
  type ModelToolCall,
  type ModelProvider,
  type ModelProviderError,
  type ModelUsage,
  type PermissionApproval,
  type PermissionDecision,
  type PermissionResolver,
  type PermissionUpdate,
  type RuntimeEventSink,
  type ToolRegistry,
} from '../core/runtime.js'
import { resolveToolSchedulingPolicy } from '../core/tool-scheduling-policy.js'
import {
  BackgroundTaskRuntime,
  type BackgroundTaskSnapshot,
} from './background-task-runtime.js'
import { usageCostUsd } from '../core/usage.js'
import type { ModelPricingRegistry } from '../core/usage.js'
import type { CompactionResult, Compactor } from '../core/compaction.js'
import {
  ContextBudget,
  ContextRecoveryPlanner,
  contextRecoveryMadeProgress,
  estimateModelRequestTokens,
  isPromptTooLongError,
} from '../core/context-budget.js'
import {
  injectFirstUserMessageContext,
  type AssembledContext,
  type ContextAssembler,
} from '../core/context.js'
import type {
  ClaudeAgentRuntimeDefinition,
  ClaudeExtensionCatalog,
  ClaudePromptExpansionMessage,
} from '../extensions/claude-extensions.js'
import { ClaudeHookToolCoordinator } from '../hooks/claude-hook-tools.js'
import type {
  ClaudeHookInput,
  ClaudeHookOutcome,
  ClaudeHookRunner,
} from '../hooks/claude-hooks.js'
import {
  ClaudeTranscriptStore,
  type ClaudeTranscriptLease,
  type TranscriptParseIssue,
  type TranscriptSnapshot,
  type TranscriptTail,
} from '../persistence/claude-transcript-store.js'
import { InMemoryTranscriptStore } from '../persistence/in-memory-transcript-store.js'
import type { ClaudeCostStateStore } from '../persistence/claude-cost-state-store.js'
import { ModelCompactor } from './model-compactor.js'
import {
  agentMemoryPrompt,
  type AgentPermissionMode,
  ClaudeSubagentExecutor,
  StructuredOutputRegistry,
} from './subagent-service.js'
import {
  ScheduledPromptManager,
  type ScheduledPrompt,
} from './scheduled-prompt-manager.js'
import { ClaudeScheduledToolRegistry } from '../tools/claude-scheduled-tools.js'
import { ClaudeTaskToolRegistry } from '../tools/claude-task-tools.js'
import { ClaudeWorkflowToolRegistry } from '../tools/claude-workflow-tools.js'
import {
  WorkflowManager,
  type WorkflowTaskSnapshot,
} from './workflow-manager.js'
import { SessionWorktreeManager } from './session-worktree.js'
import type {
  WorktreeSessionState,
  WorkspaceContext,
} from './session-worktree.js'
import {
  ClaudeSessionCostTracker,
  type ClaudeSessionCostSnapshot,
  type ClaudeSessionDurationsInput,
  type ClaudeSessionTurnInput,
} from './session-cost-tracker.js'
import { ClaudeWorktreeToolRegistry } from '../tools/claude-worktree-tools.js'
import { completeMeteredModelRequest } from './metered-model-completion.js'
import {
  SessionMemoryController,
  SessionMemoryStateError,
  SessionMemoryStore,
  type SessionMemoryExtractorInput,
} from './session-memory.js'
import type {
  ProjectMemoryExtractionRuntime,
  ProjectMemoryMessage,
  ProjectMemoryRecallRuntime,
} from './project-memory.js'
import { FilteredToolRegistry } from '../tools/filtered-tool-registry.js'
import {
  ClaudeCapabilityToolRegistry,
  resolveClaudeToolCapabilities,
  type ClaudeToolCapabilityInput,
  type ClaudeToolRole,
} from '../tools/claude-capabilities.js'
import { generateToolUseSummary } from './tool-use-summary.js'
import {
  ClaudeUserMessageToolRegistry,
  CLAUDE_USER_MESSAGE_PROMPT,
  type UserMessage,
} from '../tools/claude-user-message.js'
import type {
  ClaudeInteractiveToolCallbacks,
  ClaudeInteractiveToolManager,
  ClaudeQuestion,
} from '../tools/claude-interactive-tools.js'
import type { ClaudePermissionMode } from '../permissions/claude-permission-resolver.js'
import type {
  ClaudeMcpRuntime,
  ClaudeMcpServerStatus,
  ClaudeMcpToolInspection,
} from '../mcp/claude-mcp-tools.js'

export interface ClaudeSessionServiceOptions {
  configRoot: string
  /** `claude` preserves the legacy shared layout; the CLI selects `native` by default. */
  dataPlane?: DataPlane
  cwd: string
  claudeVersion: string
  provider?: ModelProvider
  tools?: ToolRegistry
  permissions?: PermissionResolver
  permissionResolverForMode?: (mode: AgentPermissionMode) => PermissionResolver
  permissionMode?: ClaudePermissionMode
  persistPermissionUpdates?: (
    updates: readonly PermissionUpdate[],
  ) => void | Promise<void>
  approveTool?: (
    call: ModelToolCall,
    originalCall?: ModelToolCall,
    decision?: PermissionDecision,
  ) => PermissionApproval | Promise<PermissionApproval>
  approveRecovery?: (call: ModelToolCall) => boolean | Promise<boolean>
  contextAssembler?: ContextAssembler
  conditionalRuleResolver?: Pick<ClaudeConditionalRuleResolver, 'resolve'>
  extensions?: ClaudeExtensionCatalog
  hooks?: ClaudeHookRunner
  agent?: string
  eventSink?: RuntimeEventSink
  compactor?: Compactor
  contextBudget?: ContextBudget
  contextReserveTokens?: number
  enableSubagents?: boolean
  subagentToolNames?: readonly string[]
  taskToolNames?: readonly string[]
  scheduledToolNames?: readonly string[]
  /** Runtime gates for Claude capability-driven tool exposure. */
  toolRole?: ClaudeToolRole
  toolCapabilityEnvironment?: Readonly<Record<string, string | undefined>>
  simpleMode?: boolean
  enableDynamicWakeups?: boolean
  enableWorkflows?: boolean
  providerForModel?: (model: string) => ModelProvider
  providerForMainModel?: (model: string) => ModelProvider
  /** Creates a provider adapter dedicated to Session memory requests so
   *  adapter-local cache and retry state are not shared with the foreground. */
  sessionMemoryProviderFactory?: () => ModelProvider
  explicitModel?: boolean
  explicitSystemPrompt?: boolean
  agentInitialPromptHandledExternally?: boolean
  agentSystemPromptOverridesExplicit?: boolean
  effort?: string
  maxModelTurns?: number
  betas?: readonly string[]
  structuredOutputSchema?: Record<string, unknown>
  pricing?: ModelPricingRegistry
  maxBudgetUsd?: number
  emitToolUseSummaries?: boolean
  brief?: boolean
  collectMetrics?: boolean
  sessionPersistence?: boolean
  /** Enable durable per-session memory extraction and injection. It runs only
   *  when persistence and an isolated provider factory are available. */
  enableSessionMemory?: boolean
  sessionKind?: 'bg'
  workspace?: WorkspaceContext
  initialWorktree?: boolean
  initialWorktreeName?: string
  enableWorktrees?: boolean
  worktreeToolNames?: readonly ('EnterWorktree' | 'ExitWorktree')[]
  worktreeBaseRef?: 'fresh' | 'head'
  fileResources?: readonly ClaudeFileResource[]
  fileResourceConfig?: Omit<ClaudeFileResourceConfig, 'sessionId' | 'signal'>
  fileCheckpointing?: boolean
  /** Disable only automatic context compaction; manual /compact remains available. */
  autoCompact?: boolean
  /** Explicit Project-memory capabilities. Disabled callers omit these ports. */
  projectMemoryDirectory?: string
  projectMemoryRecall?: ProjectMemoryRecallRuntime
  projectMemoryExtraction?: ProjectMemoryExtractionRuntime
  fileRewindRoots?: readonly string[]
  interactiveTools?: ClaudeInteractiveToolManager
  mcp?: ClaudeMcpRuntime
  costStateStore?: Pick<ClaudeCostStateStore, 'load' | 'save'>
}

function agentPermissionMode(
  mode: ClaudePermissionMode | undefined,
): AgentPermissionMode {
  return mode === undefined || mode === 'manual' ? 'default' : mode
}

function agentToolName(rule: string): string {
  const opening = rule.indexOf('(')
  return (opening < 0 ? rule : rule.slice(0, opening)).trim()
}

function mainAgentToolNames(
  tools: ToolRegistry,
  agent: ClaudeAgentRuntimeDefinition,
): readonly string[] {
  const requested = agent.tools ? new Set(agent.tools.map(agentToolName)) : null
  if (requested && agent.memory) {
    requested.add('Read')
    requested.add('Edit')
    requested.add('Write')
  }
  const disallowed = new Set(agent.disallowedTools?.map(agentToolName) ?? [])
  return tools
    .definitions()
    .map(({ name }) => name)
    .filter(
      (name) => (!requested || requested.has(name)) && !disallowed.has(name),
    )
}

export interface SessionRunResult {
  sessionId: string
  text: string
  usage: ModelUsage
  structuredOutput?: unknown
  durationApiMs?: number
  costUsd?: number
  modelUsage?: Readonly<Record<string, ModelUsage>>
}

export interface SideQuestionResult {
  sessionId: string
  text: string
  usage: ModelUsage
  costUsd?: number
  modelUsage?: Readonly<Record<string, ModelUsage>>
  durationApiMs?: number
  durationApiWithoutRetriesMs?: number
}

export interface SideQuestionForkResult {
  agentId: string
  name: string
}

export interface SessionSummary {
  sessionId: string
  name?: string
  lastPrompt: string | null
  updatedAt: string
  status: SessionStatus
  issue: TranscriptParseIssue | null
  prNumber?: number
  prUrl?: string
  prRepository?: string
}

export type SessionStatus = 'ready' | 'read-only' | 'corrupt'

export interface SessionInspection extends SessionSummary {
  claudeVersion: string
  writeMode: 'read-only' | 'read-write'
  entryCount: number
  byteLength: number
  newlineTerminated: boolean
}

export interface ForkResult {
  sessionId: string
  parentSessionId: string
}

export interface SessionForkCheckpoint {
  resumeSessionAt: string
  entryCount: number
}

export interface ManualCompactResult {
  summary: string
  usage: ModelUsage
  preTokens: number
  messagesSummarized?: number
}

export interface ManualCompactSelection {
  messageId: string
  direction: 'from' | 'to'
  context?: string
}

export interface RewindPoint {
  messageId: string
  prompt: string
  timestamp?: string
  branchMessageId?: string
  fileChanges: readonly string[]
  fileRestoreAvailable: boolean
}

const emptyToolRegistry: ToolRegistry = {
  definitions: () => [],
  schedulingPolicy: () => ({ concurrency: 'exclusive' }),
  prepare: async (call) => call,
  execute: async () => ({ content: '', isError: false }),
}

function mergeUsage(left: ModelUsage, right: ModelUsage): ModelUsage {
  const cacheReadInputTokens =
    (left.cacheReadInputTokens ?? 0) + (right.cacheReadInputTokens ?? 0)
  const cacheCreationInputTokens =
    (left.cacheCreationInputTokens ?? 0) + (right.cacheCreationInputTokens ?? 0)
  const webSearchRequests =
    (left.webSearchRequests ?? 0) + (right.webSearchRequests ?? 0)
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    ...(cacheReadInputTokens === 0 ? {} : { cacheReadInputTokens }),
    ...(cacheCreationInputTokens === 0 ? {} : { cacheCreationInputTokens }),
    ...(webSearchRequests === 0 ? {} : { webSearchRequests }),
  }
}

const sessionUsageCounterFields = [
  'inputTokens',
  'outputTokens',
  'cacheReadInputTokens',
  'cacheCreationInputTokens',
  'webSearchRequests',
] as const

const sessionUsageMetadataFields = ['contextWindow', 'maxOutputTokens'] as const

function assertValidSessionUsageEntry(model: string, usage: ModelUsage): void {
  if (model.trim() === '') {
    throw new Error('Model usage breakdown contains a blank model name')
  }
  for (const field of sessionUsageCounterFields) {
    const value = usage[field]
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new Error(
        `Model usage for "${model}" has an invalid ${field} counter`,
      )
    }
  }
  for (const field of sessionUsageMetadataFields) {
    const value = usage[field]
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
      throw new Error(
        `Model usage for "${model}" has an invalid ${field} metadata value`,
      )
    }
  }
}

function mergeSessionUsageMetadata(
  model: string,
  left: ModelUsage,
  right: ModelUsage,
): { contextWindow?: number; maxOutputTokens?: number } {
  const contextWindow = mergeSessionUsageMetadataField(
    model,
    'contextWindow',
    left.contextWindow,
    right.contextWindow,
  )
  const maxOutputTokens = mergeSessionUsageMetadataField(
    model,
    'maxOutputTokens',
    left.maxOutputTokens,
    right.maxOutputTokens,
  )
  return {
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
  }
}

function mergeSessionUsageMetadataField(
  model: string,
  field: string,
  left: number | undefined,
  right: number | undefined,
): number | undefined {
  if (left === undefined) return right
  if (right === undefined) return left
  if (left !== right) {
    throw new Error(
      `Model usage for "${model}" has conflicting ${field} values: ${left} vs ${right}`,
    )
  }
  return left
}

function addSessionUsageChecked(
  model: string,
  left: ModelUsage,
  right: ModelUsage,
): ModelUsage {
  const inputTokens = left.inputTokens + right.inputTokens
  const outputTokens = left.outputTokens + right.outputTokens
  const cacheReadInputTokens =
    (left.cacheReadInputTokens ?? 0) + (right.cacheReadInputTokens ?? 0)
  const cacheCreationInputTokens =
    (left.cacheCreationInputTokens ?? 0) + (right.cacheCreationInputTokens ?? 0)
  const webSearchRequests =
    (left.webSearchRequests ?? 0) + (right.webSearchRequests ?? 0)
  if (
    !Number.isSafeInteger(inputTokens) ||
    !Number.isSafeInteger(outputTokens) ||
    !Number.isSafeInteger(cacheReadInputTokens) ||
    !Number.isSafeInteger(cacheCreationInputTokens) ||
    !Number.isSafeInteger(webSearchRequests)
  ) {
    throw new Error('Model usage total overflow')
  }
  const metadata = mergeSessionUsageMetadata(model, left, right)
  return {
    inputTokens,
    outputTokens,
    ...(cacheReadInputTokens === 0 ? {} : { cacheReadInputTokens }),
    ...(cacheCreationInputTokens === 0 ? {} : { cacheCreationInputTokens }),
    ...(webSearchRequests === 0 ? {} : { webSearchRequests }),
    ...metadata,
  }
}

function mergeSessionRawModelUsage(
  ...parts: readonly (Readonly<Record<string, ModelUsage>> | undefined)[]
): Readonly<Record<string, ModelUsage>> | undefined {
  const rows: Array<[string, ModelUsage]> = []
  for (const part of parts) {
    if (part === undefined) continue
    for (const [model, usage] of Object.entries(part)) {
      assertValidSessionUsageEntry(model, usage)
      rows.push([model, usage])
    }
  }
  if (rows.length === 0) return undefined
  // Validate every pairwise counter/metadata/overflow merge across all rows
  // before any row becomes observable so a malformed or conflicting batch never
  // merges partially.
  const preview = new Map<string, ModelUsage>()
  for (const [model, usage] of rows) {
    const existing = preview.get(model)
    preview.set(
      model,
      existing === undefined
        ? { ...usage }
        : addSessionUsageChecked(model, existing, usage),
    )
  }
  const merged = new Map<string, ModelUsage>()
  for (const [model, usage] of rows) {
    const existing = merged.get(model)
    merged.set(
      model,
      existing === undefined
        ? { ...usage }
        : addSessionUsageChecked(model, existing, usage),
    )
  }
  return Object.fromEntries(merged)
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

function requireUsageCounter(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a nonnegative safe integer`)
  }
}

function requireManualCompactUsage(usage: ModelUsage): void {
  requireUsageCounter(usage.inputTokens, 'usage.inputTokens')
  requireUsageCounter(usage.outputTokens, 'usage.outputTokens')
  if (usage.cacheReadInputTokens !== undefined) {
    requireUsageCounter(
      usage.cacheReadInputTokens,
      'usage.cacheReadInputTokens',
    )
  }
  if (usage.cacheCreationInputTokens !== undefined) {
    requireUsageCounter(
      usage.cacheCreationInputTokens,
      'usage.cacheCreationInputTokens',
    )
  }
  if (usage.webSearchRequests !== undefined) {
    requireUsageCounter(usage.webSearchRequests, 'usage.webSearchRequests')
  }
}

function requireCompactionDurations(result: CompactionResult): {
  durationMs: number
  durationWithoutRetriesMs: number
} {
  const durationMs = result.durationMs
  if (
    typeof durationMs !== 'number' ||
    !Number.isFinite(durationMs) ||
    durationMs < 0
  ) {
    throw new TypeError(
      'compaction durationMs must be a finite nonnegative number',
    )
  }
  if (result.durationWithoutRetriesMs === undefined) {
    return { durationMs, durationWithoutRetriesMs: durationMs }
  }
  const durationWithoutRetriesMs = result.durationWithoutRetriesMs
  if (
    typeof durationWithoutRetriesMs !== 'number' ||
    !Number.isFinite(durationWithoutRetriesMs) ||
    durationWithoutRetriesMs < 0
  ) {
    throw new TypeError(
      'compaction durationWithoutRetriesMs must be a finite nonnegative number',
    )
  }
  return { durationMs, durationWithoutRetriesMs }
}

function addToolDuration(value: number | undefined, total: number): number {
  if (value === undefined) return total
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError('durationToolMs must be a finite nonnegative number')
  }
  const next = total + value
  if (!Number.isFinite(next) || next < 0) {
    throw new TypeError('durationToolMs total overflow')
  }
  return next
}

function addApiDuration(
  value: number | undefined,
  total: number,
  field: 'durationApiMs' | 'durationApiWithoutRetriesMs',
): number {
  if (value === undefined) return total
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${field} must be a finite nonnegative number`)
  }
  const next = total + value
  if (!Number.isFinite(next) || next < 0) {
    throw new TypeError(`${field} total overflow`)
  }
  return next
}

function createLineCountAccumulator(): {
  readonly linesAdded: number
  readonly linesRemoved: number
  add(input: {
    isError: boolean
    linesAdded?: number
    linesRemoved?: number
  }): void
} {
  let linesAdded = 0
  let linesRemoved = 0
  const addCounter = (
    current: number,
    value: number | undefined,
    field: 'linesAdded' | 'linesRemoved',
  ): number => {
    if (value === undefined) return current
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`${field} must be a nonnegative safe integer`)
    }
    const next = current + value
    if (!Number.isSafeInteger(next) || next < 0) {
      throw new TypeError(`${field} total must be a nonnegative safe integer`)
    }
    return next
  }
  return {
    get linesAdded(): number {
      return linesAdded
    },
    get linesRemoved(): number {
      return linesRemoved
    },
    add(input) {
      if (input.isError) return
      linesAdded = addCounter(linesAdded, input.linesAdded, 'linesAdded')
      linesRemoved = addCounter(
        linesRemoved,
        input.linesRemoved,
        'linesRemoved',
      )
    },
  }
}

export function workflowTokenTarget(prompt: string): number | null {
  const match = /(?:^|\s)\+(\d+(?:\.\d+)?)([km])\b/iu.exec(prompt)
  if (!match) return null
  const value = Number(match[1])
  if (!Number.isFinite(value) || value <= 0) return null
  return Math.floor(
    value * (match[2]?.toLowerCase() === 'm' ? 1_000_000 : 1_000),
  )
}

const PROMPT_SUGGESTION_INSTRUCTION = `[SUGGESTION MODE: Suggest what the user might naturally type next into Claude Code.]

FIRST: Look at the user's recent messages and original request.

Your job is to predict what THEY would type - not what you think they should do.

Reply with ONLY the suggestion, no quotes or explanation.
Use 2-12 words. Do not ask a question, evaluate the prior response, introduce a new idea, or use a Claude voice. If the topic is unsafe or sensitive, reply with an empty string.`

const SESSION_NAME_INSTRUCTION = `Generate a concise name for this coding session based on the conversation.
Use 2-5 short words in kebab-case. Reply with ONLY the name, without quotes, punctuation, or explanation.`

const SESSION_MEMORY_MAX_LINES = 200
const SESSION_MEMORY_MAX_CHARS = 32_000

const SESSION_MEMORY_EXTRACTION_PROMPT = `You maintain durable session memory for one coding session.

Update the durable session memory from the conversation so far. Preserve:
- The user's intent and current goals
- Decisions made and the reasoning behind them
- Active constraints, requirements, and preferences
- Pending work, blockers, and next steps

Omit transient chatter, credentials, secrets, or personal data.

Return ONLY an updated Markdown document that becomes the session's durable memory. Do not call tools. Do not include any prose outside the Markdown document.`

/** Memory-anchored manual compact keeps a recent suffix of at least five
 *  text-bearing messages and approximately ten thousand tokens when the active
 *  branch can provide them. Larger suffixes stay conservative. */
const MEMORY_COMPACT_MIN_SUFFIX_MESSAGES = 5
const MEMORY_COMPACT_MIN_SUFFIX_TOKENS = 10_000
/** Above this estimated post-compact envelope the selective path falls back to
 *  full compaction instead of retaining an oversized active projection. */
const MEMORY_COMPACT_MAX_PROJECTION_TOKENS = 40_000
const MEMORY_COMPACT_MAX_SUMMARY_TOKENS = 8_192

/** Conservative selective-preservation plan for a manual compact anchored on
 *  the durable session memory watermark. */
interface MemoryPreservedCompactSelection {
  /** Active entries after the watermark that are folded into the summary. */
  readonly compactedEntries: readonly ClaudeTranscriptEntry[]
  /** Recent suffix retained verbatim after the compact boundary. */
  readonly preservedEntries: readonly ClaudeTranscriptEntry[]
  /** Last good memory artifact leading the compactor input. */
  readonly memoryMessage: ModelMessage
  /** Message the compact boundary links to, just before the preserved suffix. */
  readonly logicalParentUuid: string
}

function isTextBearingClaudeEntry(entry: ClaudeTranscriptEntry): boolean {
  if (
    typeof entry.message !== 'object' ||
    entry.message === null ||
    Array.isArray(entry.message)
  ) {
    return false
  }
  const message = entry.message as Record<string, unknown>
  const content = message.content
  if (message.role === 'user') {
    if (typeof content === 'string') return content.trim().length > 0
    if (!Array.isArray(content)) return false
    return content.some(
      (block) =>
        typeof block === 'object' &&
        block !== null &&
        ((block as Record<string, unknown>).type === 'text' ||
          (block as Record<string, unknown>).type === 'tool_result' ||
          (block as Record<string, unknown>).type === 'image' ||
          (block as Record<string, unknown>).type === 'document'),
    )
  }
  if (message.role === 'assistant') {
    if (!Array.isArray(content)) return false
    return content.some(
      (block) =>
        typeof block === 'object' &&
        block !== null &&
        ((block as Record<string, unknown>).type === 'text' ||
          (block as Record<string, unknown>).type === 'tool_use' ||
          (block as Record<string, unknown>).type === 'thinking'),
    )
  }
  return false
}

function claudeToolResultIds(entry: ClaudeTranscriptEntry): Set<string> {
  const ids = new Set<string>()
  if (entry.type !== 'user') return ids
  for (const block of getClaudeContentBlocks(entry)) {
    if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
      ids.add(block.tool_use_id)
    }
  }
  return ids
}

function claudeAssistantHasToolUse(
  entry: ClaudeTranscriptEntry,
  ids: ReadonlySet<string>,
): boolean {
  if (entry.type !== 'assistant') return false
  return getClaudeContentBlocks(entry).some(
    (block) =>
      block.type === 'tool_use' &&
      typeof block.id === 'string' &&
      ids.has(block.id),
  )
}

function claudeAssistantResponseId(
  entry: ClaudeTranscriptEntry | undefined,
): string | null {
  if (
    entry?.type !== 'assistant' ||
    typeof entry.message !== 'object' ||
    entry.message === null ||
    Array.isArray(entry.message)
  ) {
    return null
  }
  const id = (entry.message as Record<string, unknown>).id
  return typeof id === 'string' && id.length > 0 ? id : null
}

/** Claude transcripts may normalize one provider response into consecutive
 *  assistant records with the same message.id. Keep the whole response on one
 *  side of the compact boundary so thinking and tool siblings stay together. */
function completeClaudeAssistantResponseBoundary(
  activeEntries: readonly ClaudeTranscriptEntry[],
  startIndex: number,
  lowerBound: number,
): number {
  const responseId = claudeAssistantResponseId(activeEntries[startIndex])
  if (responseId === null) return startIndex
  let boundary = startIndex
  for (let index = startIndex - 1; index >= lowerBound; index -= 1) {
    const candidate = activeEntries[index]
    if (claudeAssistantResponseId(candidate) !== responseId) break
    boundary = index
  }
  return boundary
}

/** Pulls the preserved-suffix boundary backward so a tool_use assistant entry
 *  and its tool_result user entry stay siblings: the suffix never opens with an
 *  orphaned tool_result and the compacted input never ends with a dangling
 *  tool_use. Same-response thinking/tool blocks live in one assistant entry,
 *  so entry-level cutting never splits them. */
function completeClaudeToolPairBoundary(
  activeEntries: readonly ClaudeTranscriptEntry[],
  startIndex: number,
  lowerBound: number,
): number {
  let boundary = startIndex
  while (boundary < activeEntries.length) {
    const entry = activeEntries[boundary]
    if (!entry) break
    const ids = claudeToolResultIds(entry)
    if (ids.size === 0) break
    let extended = false
    for (let index = boundary - 1; index >= lowerBound; index -= 1) {
      const candidate = activeEntries[index]
      if (candidate && claudeAssistantHasToolUse(candidate, ids)) {
        boundary = index
        extended = true
        break
      }
    }
    if (!extended) break
  }
  return boundary
}

/** Walks back from the active tail to the inclusive start of the recent suffix
 *  retained verbatim, then completes sibling adjacency at the boundary. */
export function memoryPreservedSuffixStart(
  activeEntries: readonly ClaudeTranscriptEntry[],
): number {
  let latestCompactBoundary = 0
  for (let index = activeEntries.length - 1; index >= 0; index -= 1) {
    if (activeEntries[index]?.isCompactSummary === true) {
      latestCompactBoundary = index
      break
    }
  }
  let start = activeEntries.length
  let textBearing = 0
  let estimatedTokens = 0
  for (
    let index = activeEntries.length - 1;
    index >= latestCompactBoundary;
    index -= 1
  ) {
    const entry = activeEntries[index]
    if (!entry) continue
    start = index
    if (!isTextBearingClaudeEntry(entry)) continue
    textBearing += 1
    estimatedTokens += estimateModelRequestTokens(
      projectClaudeModelMessages([entry]),
    )
    if (
      textBearing >= MEMORY_COMPACT_MIN_SUFFIX_MESSAGES &&
      (estimatedTokens >= MEMORY_COMPACT_MIN_SUFFIX_TOKENS ||
        index === latestCompactBoundary)
    ) {
      break
    }
  }
  const toolSafeStart = completeClaudeToolPairBoundary(
    activeEntries,
    start,
    latestCompactBoundary,
  )
  return completeClaudeAssistantResponseBoundary(
    activeEntries,
    toolSafeStart,
    latestCompactBoundary,
  )
}

function validPromptSuggestion(value: string): string | null {
  const suggestion = value.trim()
  if (!suggestion) return null
  const words = suggestion.split(/\s+/u)
  if (words.length < 2 || words.length > 12) return null
  if (/[?？\n\r]/u.test(suggestion) || /[.!。！]/u.test(suggestion)) return null
  return suggestion
}

function validSessionName(value: string): string | null {
  const name = value.trim().split(/\r?\n/u)[0]?.trim() ?? ''
  return /^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+){1,4}$/u.test(name)
    ? name.toLocaleLowerCase()
    : null
}

function projectMemoryMessages(
  entries: readonly ClaudeTranscriptEntry[],
): ProjectMemoryMessage[] {
  return selectClaudeActiveTranscript(entries).flatMap((entry) => {
    if (typeof entry.uuid !== 'string') return []
    return projectClaudeModelMessages([entry]).flatMap((message) =>
      (message.role === 'user' || message.role === 'assistant') &&
      message.content.trim().length > 0
        ? [
            {
              id: entry.uuid as string,
              role: message.role,
              content: message.content,
            },
          ]
        : [],
    )
  })
}

type HookSessionInput = Pick<
  ClaudeHookInput,
  'session_id' | 'transcript_path' | 'cwd' | 'permission_mode'
>
type HookSessionStartSource = 'startup' | 'resume' | 'clear' | 'compact'
export type HookSessionEndReason = 'clear' | 'resume' | 'other'

interface HookLifecycleState {
  input: HookSessionInput
  started: boolean
  starting: Promise<ClaudeHookOutcome | undefined> | undefined
  ending: Promise<void> | undefined
}

const SESSION_END_HOOK_TIMEOUT_MS = 15_000

class HookLifecycle {
  private readonly sessions = new Map<string, HookLifecycleState>()
  private pendingSource: Exclude<HookSessionStartSource, 'compact'> | undefined

  constructor(
    private readonly hooks: ClaudeHookRunner | undefined,
    private readonly eventSink: RuntimeEventSink | undefined,
  ) {}

  async start(
    sessionId: string,
    input: HookSessionInput,
    fallbackSource: 'startup' | 'resume',
    signal?: AbortSignal,
  ): Promise<ClaudeHookOutcome | undefined> {
    let state = this.sessions.get(sessionId)
    if (state?.started) return undefined
    if (state?.starting) return state.starting
    state = {
      input,
      started: false,
      starting: undefined,
      ending: undefined,
    }
    this.sessions.set(sessionId, state)
    const source = this.pendingSource ?? fallbackSource
    this.pendingSource = undefined
    state.starting = this.hooks?.run(
      { ...input, hook_event_name: 'SessionStart', source },
      source,
      signal,
    )
    try {
      const outcome = await state.starting
      state.started = true
      return outcome
    } catch (error) {
      this.sessions.delete(sessionId)
      throw error
    } finally {
      state.starting = undefined
    }
  }

  async refresh(
    sessionId: string,
    input: HookSessionInput,
    signal?: AbortSignal,
  ): Promise<ClaudeHookOutcome | undefined> {
    const state = this.sessions.get(sessionId)
    if (state) state.input = input
    return this.hooks?.run(
      { ...input, hook_event_name: 'SessionStart', source: 'compact' },
      'compact',
      signal,
    )
  }

  async transition(
    sessionId: string,
    reason: Exclude<HookSessionEndReason, 'other'>,
  ): Promise<void> {
    await this.end(sessionId, reason)
    this.pendingSource = reason
  }

  async end(sessionId: string, reason: HookSessionEndReason): Promise<void> {
    const state = this.sessions.get(sessionId)
    if (!state) return
    if (state.starting) await state.starting
    if (!state.started) return
    if (state.ending) return state.ending
    state.ending = this.runEnd(state.input, reason).finally(() => {
      this.sessions.delete(sessionId)
    })
    await state.ending
  }

  async close(): Promise<void> {
    await Promise.all(
      [...this.sessions.keys()].map((sessionId) =>
        this.end(sessionId, 'other'),
      ),
    )
  }

  private async runEnd(
    input: HookSessionInput,
    reason: HookSessionEndReason,
  ): Promise<void> {
    if (!this.hooks) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new Error(`timed out after ${SESSION_END_HOOK_TIMEOUT_MS}ms`))
        }, SESSION_END_HOOK_TIMEOUT_MS)
      })
      const outcome = await Promise.race([
        this.hooks.run(
          { ...input, hook_event_name: 'SessionEnd', reason },
          reason,
          controller.signal,
        ),
        timeout,
      ])
      for (const execution of outcome.executions) {
        if (execution.exitCode === 0) continue
        const detail =
          execution.stderr.trim() ||
          execution.stdout.trim() ||
          `exit code ${execution.exitCode}`
        this.warn(detail)
      }
      if (outcome.blockedReason && outcome.executions.at(-1)?.exitCode === 0) {
        this.warn(outcome.blockedReason)
      }
    } catch (error) {
      this.warn(error instanceof Error ? error.message : String(error))
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  private warn(detail: string): void {
    this.eventSink?.({
      type: 'warning',
      message: `SessionEnd hook failed: ${detail}`,
    })
  }
}

export class ClaudeSessionService {
  private readonly schema
  private readonly inMemoryStores = new Map<string, InMemoryTranscriptStore>()
  private readonly scheduledPrompts: ScheduledPromptManager | null
  private readonly workflowManager: WorkflowManager | null
  private readonly backgroundTasks: BackgroundTaskRuntime
  private readonly worktreeManager: SessionWorktreeManager | null
  private readonly sessionCwds = new Map<string, string>()
  private readonly discoveredProjectRoots = new Map<string, string>()
  private readonly sessionPermissionUpdates = new Map<
    string,
    PermissionUpdate[]
  >()
  private readonly hostedSubagents = new Set<ClaudeSubagentExecutor>()
  private readonly hostedSubagentsByRegistry = new WeakMap<
    ToolRegistry,
    ClaudeSubagentExecutor
  >()
  private readonly backgroundNotificationWrites = new Map<
    string,
    Promise<void>
  >()
  private readonly downloadedFileResourceSessions = new Set<string>()
  private activeProvider: ModelProvider | undefined
  private mcpClosePromise: Promise<void> | undefined
  private readonly sessionCostTrackers = new Map<
    string,
    ClaudeSessionCostTracker
  >()
  private activeCostSessionId: string | undefined
  private closeCostSavePromise: Promise<void> | undefined
  private readonly sessionMemoryControllers = new Map<
    string,
    SessionMemoryController
  >()
  private resolvedSessionMemoryProvider: ModelProvider | null | undefined
  private readonly hookLifecycle: HookLifecycle
  private runtimeCwd: string

  constructor(private readonly options: ClaudeSessionServiceOptions) {
    this.hookLifecycle = new HookLifecycle(options.hooks, options.eventSink)
    this.runtimeCwd = options.workspace?.cwd() ?? options.cwd
    this.schema = selectClaudeSchemaAdapter(options.claudeVersion)
    this.scheduledPrompts =
      options.tools && (options.scheduledToolNames?.length ?? 0) > 0
        ? new ScheduledPromptManager({
            filePath:
              options.dataPlane === 'native'
                ? resolveScheduledTaskFile({
                    dataPlane: 'native',
                    cwd: options.cwd,
                    root: options.configRoot,
                  })
                : resolveClaudeScheduledTaskFile(options.cwd),
            lockFile: join(
              options.dataPlane === 'native'
                ? resolveDataPlanePaths({
                    dataPlane: 'native',
                    root: options.configRoot,
                    cwd: options.cwd,
                    sessionId: '00000000-0000-4000-8000-000000000000',
                  }).praxisRoot
                : resolve(options.configRoot, 'praxis'),
              'locks',
              'scheduled-tasks.lock',
            ),
            ...(options.enableDynamicWakeups === undefined
              ? {}
              : { dynamicWakeupsEnabled: options.enableDynamicWakeups }),
          })
        : null
    this.workflowManager = options.enableWorkflows
      ? new WorkflowManager(
          options.configRoot,
          options.cwd,
          () => this.activeCwd(),
          options.dataPlane,
        )
      : null
    this.backgroundTasks = new BackgroundTaskRuntime(this.workflowManager)
    this.worktreeManager =
      options.enableWorktrees && options.workspace
        ? new SessionWorktreeManager({
            workspace: options.workspace,
            sessionId: '',
            dataPlane: options.dataPlane ?? 'claude',
            ...(options.worktreeBaseRef
              ? { baseRef: options.worktreeBaseRef }
              : {}),
          })
        : null
    const configuredAgent = options.agent
      ? (options.extensions?.agent(options.agent) ?? null)
      : null
    if (configuredAgent && options.provider) {
      this.activeProvider = this.providerForAgent(configuredAgent)
    }
  }

  nextScheduledPrompt(signal?: AbortSignal): Promise<ScheduledPrompt | null> {
    const manager = this.scheduledPrompts
    if (!manager) return Promise.resolve(null)
    return this.nextScheduledPromptForManager(manager, signal)
  }

  private async nextScheduledPromptForManager(
    manager: ScheduledPromptManager,
    signal?: AbortSignal,
  ): Promise<ScheduledPrompt | null> {
    // Scan durable tasks so a missed one-shot surfaces as a pending
    // confirmation instead of silently entering the normal due drain.
    await manager.list()
    const pending = manager.pendingScheduledPrompts()[0]
    if (!pending) return manager.next(signal)
    const askUser = this.options.interactiveTools?.callbacks.askUser
    if (!askUser) return manager.next(signal)
    const approved = await this.confirmPendingScheduledPrompt(
      manager,
      pending,
      askUser,
      signal,
    )
    if (!approved) return null
    // Consume the approved prompt from the scheduler due queue exactly once.
    return manager.next(signal)
  }

  private async confirmPendingScheduledPrompt(
    manager: ScheduledPromptManager,
    pending: ScheduledPrompt,
    askUser: ClaudeInteractiveToolCallbacks['askUser'],
    signal?: AbortSignal,
  ): Promise<boolean> {
    const question: ClaudeQuestion = {
      header: 'Missed scheduled prompt',
      question: pending.prompt,
      options: [
        {
          label: 'Run now',
          description:
            'Run this scheduled prompt that was missed while Praxis was not running.',
        },
        {
          label: 'Skip',
          description: 'Decline this scheduled prompt and discard it.',
        },
      ],
      multiSelect: false,
    }
    const result = await askUser([question], signal)
    const decision = result?.answers[question.question]
    if (decision === 'Run now') {
      return manager.approveScheduledPrompt(pending.id)
    }
    if (decision === 'Skip') {
      manager.declineScheduledPrompt(pending.id)
      return false
    }
    return false
  }

  workflows(): readonly WorkflowTaskSnapshot[] {
    return this.workflowManager?.list() ?? []
  }

  mcpInspect(): Promise<readonly ClaudeMcpServerStatus[]> {
    return this.requireMcp().inspect()
  }

  mcpReconnect(name: string): Promise<void> {
    return this.requireMcp().reconnect(name)
  }

  mcpAuthenticate(name: string): Promise<void> {
    return this.requireMcp().authenticate(name)
  }

  mcpReload(): Promise<void> {
    return this.requireMcp().reload()
  }

  mcpTools(name: string): Promise<readonly ClaudeMcpToolInspection[]> {
    return this.requireMcp().tools(name)
  }

  private requireMcp(): ClaudeMcpRuntime {
    if (!this.options.mcp) throw new Error('MCP runtime is not configured')
    return this.options.mcp
  }

  taskSnapshots(sessionId: string): Promise<BackgroundTaskSnapshot> {
    return this.backgroundTasks.snapshot(sessionId)
  }

  stopTask(sessionId: string, taskId: string): Promise<void> {
    return this.backgroundTasks.stop(sessionId, taskId)
  }

  private async applyPermissionUpdates(
    sessionId: string,
    updates: readonly PermissionUpdate[],
  ): Promise<void> {
    if (updates.length === 0) return
    await this.options.persistPermissionUpdates?.(updates)
    const current = this.sessionPermissionUpdates.get(sessionId) ?? []
    current.push(...updates)
    this.sessionPermissionUpdates.set(sessionId, current)
    const mode = updates.findLast(
      (update): update is Extract<PermissionUpdate, { type: 'setMode' }> =>
        update.type === 'setMode',
    )?.mode
    if (mode && this.options.interactiveTools) {
      await this.options.interactiveTools.setMode(sessionId, mode)
    }
  }

  async close(): Promise<void> {
    await this.hookLifecycle.close()
    this.scheduledPrompts?.close()
    await this.options.projectMemoryExtraction?.close(5_000)
    await Promise.all(
      [...this.hostedSubagents].map((executor) => executor.close()),
    )
    await Promise.resolve()
    await Promise.all([...this.backgroundNotificationWrites.values()])
    this.hostedSubagents.clear()
    this.backgroundTasks.clear()
    await Promise.all(
      [...this.sessionMemoryControllers.values()].map((controller) =>
        controller.close(),
      ),
    )
    this.sessionMemoryControllers.clear()
    await this.workflowManager?.close()
    this.closeCostSavePromise ??= this.persistActiveSessionCost()
    await this.closeCostSavePromise
    this.mcpClosePromise ??= this.options.mcp?.close?.() ?? Promise.resolve()
    await this.mcpClosePromise
  }

  async transitionHookSession(
    sessionId: string,
    reason: Exclude<HookSessionEndReason, 'other'>,
  ): Promise<void> {
    await this.hookLifecycle.transition(sessionId, reason)
    if (reason === 'clear') {
      this.options.projectMemoryRecall?.clearSession?.(sessionId)
    }
    this.options.contextAssembler?.invalidate?.({
      lifecycleId: sessionId,
      reason: reason === 'resume' ? 'restore' : 'clear',
    })
  }

  reloadContextResources(sessionId: string): void {
    this.options.contextAssembler?.invalidate?.({
      lifecycleId: sessionId,
      reason: 'resource-reload',
    })
  }

  createHostedToolRegistry(sessionId: string): ToolRegistry {
    const baseTools = this.options.tools
    if (!baseTools) throw new Error('Hosted tool registry requires base tools')
    const paths = this.paths(sessionId)
    const capabilities = this.toolCapabilities()
    const taskToolNames = this.capabilityToolNames(
      this.options.taskToolNames,
      capabilities,
    )
    const scheduledToolNames = this.capabilityToolNames(
      this.options.scheduledToolNames,
      capabilities,
    )
    const taskTools =
      taskToolNames.length > 0
        ? new ClaudeTaskToolRegistry({
            base: baseTools,
            cwd: this.activeCwd(),
            cwdProvider: () => this.activeCwd(),
            praxisRoot: paths.praxisRoot,
            sessionId,
            taskRoot: paths.taskRoot,
            ...(this.options.eventSink
              ? { eventSink: this.options.eventSink }
              : {}),
            enabledTools: taskToolNames,
          })
        : null
    if (taskTools) this.backgroundTasks.registerBash(sessionId, taskTools)
    const scheduledTools =
      this.scheduledPrompts && scheduledToolNames.length > 0
        ? new ClaudeScheduledToolRegistry({
            base: taskTools ?? baseTools,
            manager: this.scheduledPrompts,
            sessionId,
            enabledTools: scheduledToolNames,
            dataPlane: this.options.dataPlane ?? 'claude',
          })
        : null
    const wrappedBase = scheduledTools ?? taskTools ?? baseTools
    const subagentExecutor =
      (this.options.enableSubagents || this.options.enableWorkflows) &&
      this.options.permissions
        ? new ClaudeSubagentExecutor({
            configRoot: this.options.configRoot,
            dataPlane: this.options.dataPlane ?? 'claude',
            cwd: this.activeCwd(),
            cwdProvider: () => this.activeCwd(),
            claudeVersion: this.options.claudeVersion,
            provider:
              this.options.provider ??
              (() => {
                throw new Error(
                  'A model provider is required to execute hosted Agent tools',
                )
              })(),
            persistence:
              this.options.sessionPersistence === false ? 'memory' : 'disk',
            ...(this.options.providerForModel
              ? { providerForModel: this.options.providerForModel }
              : {}),
            baseTools: wrappedBase,
            permissions: this.options.permissions,
            ...(this.options.permissionResolverForMode
              ? {
                  permissionResolverForMode:
                    this.options.permissionResolverForMode,
                }
              : {}),
            parentPermissionMode: () =>
              agentPermissionMode(
                this.options.interactiveTools?.mode(sessionId) ??
                  this.options.permissionMode,
              ),
            ...(this.options.subagentToolNames
              ? {
                  toolNames: this.capabilityToolNames(
                    this.options.subagentToolNames,
                    capabilities,
                  ),
                }
              : {}),
            ...(this.options.extensions
              ? { extensions: this.options.extensions }
              : {}),
            ...(this.options.mcp ? { mcp: this.options.mcp } : {}),
            ...(this.options.hooks ? { hooks: this.options.hooks } : {}),
            ...(this.options.contextAssembler
              ? { contextAssembler: this.options.contextAssembler }
              : {}),
            ...((this.options.contextBudget?.reserveTokens ??
              this.options.contextReserveTokens) === undefined
              ? {}
              : {
                  contextReserveTokens:
                    this.options.contextBudget?.reserveTokens ??
                    this.options.contextReserveTokens,
                }),
            ...(this.options.approveTool
              ? { approveTool: this.options.approveTool }
              : {}),
            permissionUpdates: () =>
              this.sessionPermissionUpdates.get(sessionId) ?? [],
            onPermissionUpdates: (updates) =>
              this.applyPermissionUpdates(sessionId, updates),
            ...(this.options.eventSink
              ? { eventSink: this.options.eventSink }
              : {}),
            ...(taskTools
              ? {
                  backgroundTaskNotifications: (waitForRunning: boolean) =>
                    taskTools.notifications(waitForRunning),
                }
              : {}),
          })
        : null
    if (subagentExecutor) this.hostedSubagents.add(subagentExecutor)
    if (subagentExecutor) {
      this.backgroundTasks.registerAgents(sessionId, subagentExecutor)
    }
    const agentTools = subagentExecutor
      ? subagentExecutor.registry(sessionId, 0, (callId) => callId)
      : wrappedBase
    const workflowTools =
      this.workflowManager && subagentExecutor
        ? new ClaudeWorkflowToolRegistry({
            base: agentTools,
            manager: this.workflowManager,
            executor: subagentExecutor,
            cwd: this.activeCwd(),
            cwdProvider: () => this.activeCwd(),
            configRoot: this.options.configRoot,
            sessionId,
            promptIdForCall: (callId) => callId,
            defaultModel: this.options.provider?.model ?? 'praxis/provider',
            tokenBudget: null,
            enabled: capabilities.has('Workflow'),
            dataPlane: this.options.dataPlane ?? 'claude',
          })
        : agentTools
    if (this.worktreeManager) this.worktreeManager.bindSession(sessionId)
    const registry =
      this.worktreeManager && this.options.workspace
        ? new ClaudeWorktreeToolRegistry({
            base: workflowTools,
            manager: this.worktreeManager,
            workspace: this.options.workspace,
            dataPlane: this.options.dataPlane ?? 'claude',
            ...(this.options.worktreeToolNames
              ? { enabledTools: this.options.worktreeToolNames }
              : {}),
          })
        : workflowTools
    const messageRegistry = this.options.brief
      ? new ClaudeUserMessageToolRegistry(registry, (message: UserMessage) =>
          this.options.eventSink?.({
            type: 'user-message',
            message: message.message,
            status: message.status,
            ...(message.attachments.length
              ? { attachments: message.attachments }
              : {}),
          }),
        )
      : registry
    const interactiveRegistry = this.options.interactiveTools
      ? this.options.interactiveTools.registry(messageRegistry, sessionId)
      : messageRegistry
    const capabilityRegistry = new ClaudeCapabilityToolRegistry(
      interactiveRegistry,
      capabilities,
    )
    const preferredOrder = [
      'Agent',
      'AskUserQuestion',
      'TaskOutput',
      'Bash',
      'EnterPlanMode',
      'Read',
      'LSP',
      'Edit',
      'Write',
      'NotebookEdit',
      'WebFetch',
      'ReportFindings',
      'WebSearch',
      'TaskStop',
      'Skill',
      'DesignSync',
      'TaskCreate',
      'TaskGet',
      'TaskUpdate',
      'ExitPlanMode',
      'EnterWorktree',
      'ExitWorktree',
      'SendMessage',
      'SendUserMessage',
      'Workflow',
      'CronCreate',
      'CronDelete',
      'CronList',
      'ScheduleWakeup',
      'Monitor',
      'PushNotification',
    ]
    const hostedRegistry: ToolRegistry = {
      definitions: () => {
        const definitions = capabilityRegistry.definitions()
        return [...definitions].sort((left, right) => {
          const leftIndex = preferredOrder.indexOf(left.name)
          const rightIndex = preferredOrder.indexOf(right.name)
          return (
            (leftIndex < 0 ? preferredOrder.length : leftIndex) -
            (rightIndex < 0 ? preferredOrder.length : rightIndex)
          )
        })
      },
      schedulingPolicy: (call) =>
        resolveToolSchedulingPolicy(capabilityRegistry, call),
      prepare: (call, context) => capabilityRegistry.prepare(call, context),
      execute: (call, context) => capabilityRegistry.execute(call, context),
    }
    if (subagentExecutor) {
      this.hostedSubagentsByRegistry.set(hostedRegistry, subagentExecutor)
    }
    return hostedRegistry
  }

  async run(
    prompt: string,
    signal?: AbortSignal,
    sessionId: string = randomUUID(),
    name?: string,
    images?: readonly ModelImage[],
    documents?: readonly ModelDocument[],
  ): Promise<SessionRunResult> {
    this.worktreeManager?.bindSession(sessionId)
    return this.executeTurn(
      sessionId,
      prompt,
      false,
      signal,
      name,
      images,
      documents,
    )
  }

  async runShell(
    command: string,
    signal?: AbortSignal,
    sessionId: string = randomUUID(),
    name?: string,
  ): Promise<SessionRunResult> {
    this.worktreeManager?.bindSession(sessionId)
    return this.executeTurn(
      sessionId,
      `! ${command}`,
      false,
      signal,
      name,
      [],
      [],
      undefined,
      command,
    )
  }

  async resume(
    sessionId: string,
    prompt: string,
    signal?: AbortSignal,
    name?: string,
    images?: readonly ModelImage[],
    documents?: readonly ModelDocument[],
    resumeSessionAt?: string,
  ): Promise<SessionRunResult> {
    this.worktreeManager?.bindSession(sessionId)
    return this.executeTurn(
      sessionId,
      prompt,
      true,
      signal,
      name,
      images,
      documents,
      resumeSessionAt,
    )
  }

  async resumeShell(
    sessionId: string,
    command: string,
    signal?: AbortSignal,
    name?: string,
    resumeSessionAt?: string,
  ): Promise<SessionRunResult> {
    this.worktreeManager?.bindSession(sessionId)
    return this.executeTurn(
      sessionId,
      `! ${command}`,
      true,
      signal,
      name,
      [],
      [],
      resumeSessionAt,
      command,
    )
  }

  async answerSideQuestion(
    sessionId: string | undefined,
    question: string,
    signal?: AbortSignal,
    onDelta?: (delta: string) => void,
    permissionMode: ClaudePermissionMode = 'default',
  ): Promise<SideQuestionResult> {
    const prompt = question.trim()
    if (!prompt) throw new Error('Side question must not be empty')
    const activeSessionId = await this.ensureLocalSession(
      sessionId,
      permissionMode,
    )
    await this.appendInputHistory(`/btw ${prompt}`, activeSessionId)
    const provider = this.provider()
    let entries: ClaudeTranscriptEntry[] = []
    if (sessionId) {
      const loaded =
        this.options.sessionPersistence === false
          ? await this.turnStore(activeSessionId).withLease((lease) =>
              lease.load(),
            )
          : {
              status: 'completed' as const,
              value: await this.store(activeSessionId).loadReadOnly(),
            }
      if (loaded.status === 'conflict') {
        throw new Error(`Claude side question conflict: ${loaded.reason}`)
      }
      if (loaded.value.entries.length === 0) {
        throw new Error(`Claude session not found: ${activeSessionId}`)
      }
      entries = loaded.value.entries
      this.restoreWorktree(entries)
    }
    const assembledContext = await this.options.contextAssembler?.assemble({
      cwd: this.activeCwd(),
      lifecycleId: activeSessionId,
    })
    const messages = [
      ...(assembledContext?.systemMessages ?? []),
      ...injectFirstUserMessageContext(
        [
          ...projectClaudeModelMessages(entries),
          { role: 'user' as const, content: prompt },
        ],
        assembledContext?.firstUserMessageContext,
      ),
    ]
    const budget = this.contextBudget(provider)
    if (budget) budget.assertFits(budget.evaluate(messages))
    await this.activateSessionCostTracker(activeSessionId)
    const model =
      provider.model !== undefined && provider.model.trim() !== ''
        ? provider.model
        : 'praxis/provider'
    const metrics = await completeMeteredModelRequest(
      provider,
      {
        messages,
        ...(this.options.effort ? { effort: this.options.effort } : {}),
        ...(signal ? { signal } : {}),
      },
      {
        ...(onDelta ? { onTextDelta: onDelta } : {}),
        onMetrics: (recorded) =>
          this.recordAuxiliaryMetrics(activeSessionId, recorded),
      },
    )
    budget?.observeUsage(metrics.usage, messages)
    if (metrics.toolCalls.length > 0) {
      throw new Error('Side questions cannot call tools; press f to fork')
    }
    const pricing = this.options.pricing?.resolve(model)
    const costUsd = pricing ? usageCostUsd(metrics.usage, pricing) : undefined
    return {
      sessionId: activeSessionId,
      text: metrics.text,
      usage: metrics.usage,
      ...(costUsd === undefined ? {} : { costUsd }),
      ...(hasNonZeroUsage(metrics.usage)
        ? { modelUsage: { [model]: metrics.usage } }
        : {}),
      ...(metrics.durationApiMs === 0
        ? {}
        : {
            durationApiMs: metrics.durationApiMs,
            durationApiWithoutRetriesMs: metrics.durationApiWithoutRetriesMs,
          }),
    }
  }

  async forkSideQuestion(
    sessionId: string,
    question: string,
    signal?: AbortSignal,
  ): Promise<SideQuestionForkResult> {
    const prompt = question.trim()
    if (!prompt) throw new Error('Side question must not be empty')
    const name =
      prompt
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, '-')
        .replace(/^-+|-+$/gu, '')
        .split('-')
        .filter(Boolean)
        .slice(0, 3)
        .join('-')
        .slice(0, 64) || 'side-question'
    const registry = this.createHostedToolRegistry(sessionId)
    const call: ModelToolCall = {
      id: randomUUID(),
      name: 'Agent',
      input: {
        description: prompt,
        prompt,
        subagent_type: 'general-purpose',
        run_in_background: true,
        name,
      },
    }
    const context = {
      cwd: this.activeCwd(),
      ...(signal ? { signal } : {}),
    }
    const prepared = await registry.prepare(call, context)
    const result = await registry.execute(prepared, context)
    const agentId = result.nativeToolUseResult?.agentId
    if (result.isError || typeof agentId !== 'string') {
      throw new Error(result.content || 'Could not fork side question')
    }
    await this.appendSystemLocalCommand(
      sessionId,
      'btw',
      prompt,
      `⑂ forked ${name} (${agentId.slice(-4)})`,
    )
    const executor = this.hostedSubagentsByRegistry.get(registry)
    if (executor) {
      void executor
        .notifications(true)
        .then(({ messages }) =>
          this.enqueueBackgroundNotifications(sessionId, messages),
        )
        .catch((error: unknown) =>
          this.options.eventSink?.({
            type: 'warning',
            message:
              error instanceof Error
                ? error.message
                : `Could not persist background notification: ${String(error)}`,
          }),
        )
    }
    return { agentId, name }
  }

  async promptSuggestion(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const loaded =
      this.options.sessionPersistence === false
        ? await this.turnStore(sessionId).withLease((lease) => lease.load())
        : {
            status: 'completed' as const,
            value: await this.store(sessionId).loadReadOnly(),
          }
    if (loaded.status === 'conflict') return null
    const entries = loaded.value
    this.restoreWorktree(entries.entries)
    const agentName =
      this.options.agent ?? getClaudeAgentSetting(entries.entries)
    const agent = this.resolveAgent(agentName)
    const provider = this.providerForAgent(agent)
    this.activeProvider = provider
    const agentSystem = await this.mainAgentSystemPrompt(agent)
    const assembledContext = await this.options.contextAssembler?.assemble({
      cwd: this.activeCwd(),
      lifecycleId: sessionId,
      ...(agentSystem ? { mode: 'agent', baseSystemPrompt: agentSystem } : {}),
    })
    const hasPromptManifest = assembledContext?.promptSections !== undefined
    const assembledSystemMessages = hasPromptManifest
      ? (assembledContext?.systemMessages ?? [])
      : this.assembledSystemMessages(
          agent,
          assembledContext?.systemMessages ?? [],
        )
    const contextMessages = [
      ...(!hasPromptManifest && agentSystem
        ? [{ role: 'system' as const, content: agentSystem }]
        : []),
      ...assembledSystemMessages,
    ]
    const messages = [
      ...contextMessages,
      ...injectFirstUserMessageContext(
        [
          ...projectClaudeModelMessages(entries.entries),
          { role: 'user' as const, content: PROMPT_SUGGESTION_INSTRUCTION },
        ],
        assembledContext?.firstUserMessageContext,
      ),
    ]
    const suggestionTools =
      agent && this.options.tools
        ? new FilteredToolRegistry(this.options.tools, {
            tools: mainAgentToolNames(this.options.tools, agent),
          })
        : this.options.tools
    await this.activateSessionCostTracker(sessionId)
    const metrics = await completeMeteredModelRequest(
      provider,
      {
        messages,
        ...(provider.capabilities.tools
          ? { tools: suggestionTools?.definitions() ?? [] }
          : {}),
        ...(this.options.effort ? { effort: this.options.effort } : {}),
        ...(signal ? { signal } : {}),
      },
      {
        onMetrics: (recorded) =>
          this.recordAuxiliaryMetrics(sessionId, recorded),
      },
    )
    if (metrics.toolCalls.length > 0) return null
    return validPromptSuggestion(metrics.text)
  }

  async sessionNameSuggestion(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const provider = this.provider()
    const loaded = await this.turnStore(sessionId).withLease((lease) =>
      lease.load(),
    )
    if (loaded.status === 'conflict' || loaded.value.entries.length === 0) {
      return null
    }
    await this.activateSessionCostTracker(sessionId)
    const metrics = await completeMeteredModelRequest(
      provider,
      {
        messages: [
          ...projectClaudeModelMessages(loaded.value.entries),
          { role: 'user', content: SESSION_NAME_INSTRUCTION },
        ],
        ...(this.options.effort ? { effort: this.options.effort } : {}),
        ...(signal ? { signal } : {}),
      },
      {
        onMetrics: (recorded) =>
          this.recordAuxiliaryMetrics(sessionId, recorded),
      },
    )
    if (metrics.toolCalls.length > 0) return null
    return validSessionName(metrics.text)
  }

  async sessions(): Promise<SessionSummary[]> {
    const discoveredRoot = await discoverClaudeProjectRoot({
      configRoot: this.options.configRoot,
      cwd: this.activeCwd(),
    })
    const projectRoot = discoveredRoot ?? this.paths(randomUUID()).projectRoot
    let names: string[]
    try {
      names = await readdir(projectRoot)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }

    const sessionIds = names
      .filter((name) => extname(name) === '.jsonl')
      .map((name) => basename(name, '.jsonl'))
      .filter((sessionId) => isClaudeSessionId(sessionId))
    if (discoveredRoot !== undefined) {
      for (const sessionId of sessionIds) {
        this.discoveredProjectRoots.set(sessionId, projectRoot)
      }
    }

    const summaries = await Promise.all(
      sessionIds.map(async (sessionId) => {
        const sessionFile = join(projectRoot, `${sessionId}.jsonl`)
        try {
          const metadata = await lstat(sessionFile)
          if (!metadata.isFile()) return null
          const recovery = await this.store(sessionId).loadReadOnly()
          if (!(await lstat(sessionFile)).isFile()) return null
          const name = this.sessionName(recovery.entries)
          const prLink = getClaudePrLink(recovery.entries, sessionId)
          return {
            sessionId,
            ...(name === null ? {} : { name }),
            lastPrompt: getClaudeLastPrompt(recovery.entries),
            updatedAt: metadata.mtime.toISOString(),
            status: this.sessionStatus(recovery.issue, recovery.entries.length),
            issue: recovery.issue,
            ...(prLink
              ? {
                  prNumber: prLink.prNumber,
                  prUrl: prLink.prUrl,
                  prRepository: prLink.prRepository,
                }
              : {}),
          }
        } catch (error) {
          if (typeof (error as NodeJS.ErrnoException).code === 'string') {
            return null
          }
          throw error
        }
      }),
    )
    return summaries
      .filter((summary): summary is SessionSummary => summary !== null)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }

  async inspect(sessionId: string): Promise<SessionInspection> {
    this.assertSessionPersistence()
    await this.discoverProjectRoot(sessionId)
    const paths = this.paths(sessionId)
    let metadata
    try {
      metadata = await stat(paths.sessionFile)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`Claude session not found: ${sessionId}`)
      }
      throw error
    }
    const recovery = await this.store(sessionId).loadReadOnly()
    const prLink = getClaudePrLink(recovery.entries, sessionId)
    return {
      sessionId,
      lastPrompt: getClaudeLastPrompt(recovery.entries),
      updatedAt: metadata.mtime.toISOString(),
      status: this.sessionStatus(recovery.issue, recovery.entries.length),
      issue: recovery.issue,
      claudeVersion: this.options.claudeVersion,
      writeMode: this.schema.writeMode,
      entryCount: recovery.entries.length,
      byteLength: recovery.tail.byteLength,
      newlineTerminated: recovery.tail.newlineTerminated,
      ...(prLink
        ? {
            prNumber: prLink.prNumber,
            prUrl: prLink.prUrl,
            prRepository: prLink.prRepository,
          }
        : {}),
    }
  }

  async readEffectiveAgentColor(
    sessionId: string,
  ): Promise<AgentColorName | undefined> {
    this.assertSessionPersistence()
    const recovery = await this.store(sessionId).loadReadOnly()
    return getClaudeEffectiveAgentColor(recovery.entries, sessionId)
  }

  async export(sessionId: string): Promise<Buffer> {
    this.assertSessionPersistence()
    await this.discoverProjectRoot(sessionId)
    try {
      return await this.store(sessionId).exportReadOnly()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`Claude session not found: ${sessionId}`)
      }
      throw error
    }
  }

  async transcript(
    sessionId: string,
    resumeSessionAt?: string,
  ): Promise<ClaudeDisplayTranscriptItem[]> {
    await this.discoverProjectRoot(sessionId)
    try {
      const recovery = await this.store(sessionId).loadReadOnly()
      if (recovery.entries.length === 0) {
        throw new Error(`Claude session not found: ${sessionId}`)
      }
      const entries =
        resumeSessionAt === undefined
          ? recovery.entries
          : selectClaudeTranscriptAtMessage(recovery.entries, resumeSessionAt)
      return projectClaudeDisplayTranscript(entries)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`Claude session not found: ${sessionId}`)
      }
      throw error
    }
  }

  async rename(sessionId: string, name: string): Promise<void> {
    this.assertWritable()
    const normalized = name.trim()
    if (!normalized) throw new Error('Session name must not be empty')
    const result = await this.turnStore(sessionId).withLease(async (lease) => {
      const snapshot = await lease.load()
      if (snapshot.entries.length === 0) {
        throw new Error(`Claude session not found: ${sessionId}`)
      }
      if (this.hasSessionName(snapshot.entries, normalized)) return
      const appendResult = await lease.appendMany(
        snapshot.tail,
        this.sessionNameEntries(sessionId, normalized),
      )
      if (appendResult.status === 'conflict') {
        throw new Error(
          `Claude transcript rename conflict: ${appendResult.reason}`,
        )
      }
    })
    if (result.status === 'conflict') {
      throw new Error(`Claude transcript rename conflict: ${result.reason}`)
    }
  }

  async changeCwd(
    sessionId: string | undefined,
    requestedCwd: string,
  ): Promise<string> {
    this.assertWritable()
    const previousCwd = this.activeCwd()
    const expandedCwd =
      requestedCwd === '~'
        ? homedir()
        : requestedCwd.startsWith('~/')
          ? join(homedir(), requestedCwd.slice(2))
          : requestedCwd
    const cwd = await realpath(
      isAbsolute(expandedCwd) ? expandedCwd : join(previousCwd, expandedCwd),
    )
    if (!(await stat(cwd)).isDirectory()) {
      throw new Error(`Not a directory: ${requestedCwd}`)
    }
    if (sessionId && this.options.sessionPersistence !== false) {
      const sourcePaths = this.pathsForCwd(
        sessionId,
        this.sessionCwds.get(sessionId) ?? previousCwd,
      )
      const targetPaths = this.pathsForCwd(sessionId, cwd)
      if (sourcePaths.sessionFile !== targetPaths.sessionFile) {
        try {
          await lstat(targetPaths.sessionFile)
          throw new Error(
            `Claude transcript already exists at relocation target: ${targetPaths.sessionFile}`,
          )
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        const sourceStore = this.store(sessionId)
        const relocated = await sourceStore.withLease(async (lease) => {
          const snapshot = await lease.load()
          if (snapshot.entries.length === 0) {
            throw new Error(`Claude session not found: ${sessionId}`)
          }
          await mkdir(targetPaths.projectRoot, { recursive: true })
          const relocationId = randomUUID()
          const stagingFile = join(
            targetPaths.projectRoot,
            `.${sessionId}.${relocationId}.relocating`,
          )
          const stagingStore = new ClaudeTranscriptStore({
            sessionFile: stagingFile,
            lockFile: join(
              targetPaths.praxisRoot,
              'locks',
              `${sessionId}.${relocationId}.lock`,
            ),
            schema: this.schema,
          })
          let publishedIdentity: { dev: number; ino: number } | undefined
          try {
            await copyFile(sourcePaths.sessionFile, stagingFile)
            const staged = await stagingStore.withLease((stagingLease) =>
              stagingLease.appendMany(snapshot.tail, [
                {
                  type: 'relocated',
                  sessionId,
                  relocatedCwd: cwd,
                },
                ...this.cdCommandEntries(
                  sessionId,
                  cwd,
                  this.logicalTailUuid(snapshot.tail),
                ),
              ]),
            )
            if (staged.status === 'conflict') {
              throw new Error(
                `Claude transcript relocation conflict: ${staged.reason}`,
              )
            }
            if (staged.value.status === 'conflict') {
              throw new Error(
                `Claude transcript relocation conflict: ${staged.value.reason}`,
              )
            }
            const stagingMetadata = await lstat(stagingFile)
            await link(stagingFile, targetPaths.sessionFile)
            publishedIdentity = {
              dev: stagingMetadata.dev,
              ino: stagingMetadata.ino,
            }
            await unlink(stagingFile)
            await unlink(sourcePaths.sessionFile)
          } catch (error) {
            await unlink(stagingFile).catch(() => undefined)
            if (publishedIdentity) {
              const targetMetadata = await lstat(targetPaths.sessionFile).catch(
                () => undefined,
              )
              if (
                targetMetadata?.dev === publishedIdentity.dev &&
                targetMetadata.ino === publishedIdentity.ino
              ) {
                await unlink(targetPaths.sessionFile).catch(() => undefined)
              }
            }
            throw error
          }
        })
        if (relocated.status === 'conflict') {
          throw new Error(
            `Claude transcript relocation conflict: ${relocated.reason}`,
          )
        }
        // The transcript moved to the exact root for the new cwd; any
        // previously discovered alternate-hash root is now stale.
        this.discoveredProjectRoots.delete(sessionId)
      } else {
        await this.appendCdCommand(sessionId, cwd)
      }
      this.sessionCwds.set(sessionId, cwd)
      this.runtimeCwd = cwd
      this.options.workspace?.setCwd(cwd)
      this.options.contextAssembler?.invalidate?.({
        lifecycleId: sessionId,
        reason: 'cwd',
      })
      return cwd
    }
    this.runtimeCwd = cwd
    this.options.workspace?.setCwd(cwd)
    if (sessionId) this.sessionCwds.set(sessionId, cwd)
    if (sessionId) {
      this.options.contextAssembler?.invalidate?.({
        lifecycleId: sessionId,
        reason: 'cwd',
      })
    }
    return cwd
  }

  async recordCdUsage(sessionId: string): Promise<void> {
    this.assertWritable()
    const result = await this.turnStore(sessionId).withLease(async (lease) => {
      const snapshot = await lease.load()
      if (snapshot.entries.length === 0) {
        throw new Error(`Claude session not found: ${sessionId}`)
      }
      const promptId = randomUUID()
      const firstUuid = randomUUID()
      const timestamp = new Date().toISOString()
      const common = {
        isSidechain: false,
        promptId,
        timestamp,
        userType: 'external',
        entrypoint: 'cli',
        cwd: this.activeCwd(),
        sessionId,
        version: this.options.claudeVersion,
        gitBranch: null,
      }
      const appendResult = await lease.appendMany(snapshot.tail, [
        {
          ...common,
          parentUuid: this.logicalTailUuid(snapshot.tail),
          type: 'user',
          message: {
            role: 'user',
            content:
              '<command-name>/cd</command-name>\n            <command-message>cd</command-message>\n            <command-args></command-args>',
          },
          uuid: firstUuid,
        },
        {
          ...common,
          parentUuid: firstUuid,
          type: 'user',
          message: {
            role: 'user',
            content:
              '<local-command-stdout>Usage: /cd <path></local-command-stdout>',
          },
          uuid: randomUUID(),
        },
      ])
      if (appendResult.status === 'conflict') {
        throw new Error(
          `Claude cd usage append conflict: ${appendResult.reason}`,
        )
      }
    })
    if (result.status === 'conflict') {
      throw new Error(`Claude cd usage conflict: ${result.reason}`)
    }
  }

  async approveRecentlyDenied(
    sessionId: string,
    display: string,
  ): Promise<void> {
    await this.appendPermissionGrant(sessionId, display, false)
  }

  async retryRecentlyDenied(
    sessionId: string,
    display: string,
    signal?: AbortSignal,
  ): Promise<SessionRunResult> {
    await this.appendPermissionGrant(sessionId, display, true)
    return this.executeTurn(
      sessionId,
      '/permissions',
      true,
      signal,
      undefined,
      [],
      [],
      undefined,
      undefined,
      true,
    )
  }

  async recordBtwUsage(
    sessionId: string | undefined,
    permissionMode: ClaudePermissionMode = 'default',
  ): Promise<string> {
    const activeSessionId = await this.ensureLocalSession(
      sessionId,
      permissionMode,
    )
    await this.appendInputHistory('/btw', activeSessionId)
    while (true) {
      const result = await this.turnStore(activeSessionId).withLease(
        async (lease) => {
          const snapshot = await lease.load()
          if (snapshot.entries.length === 0) {
            throw new Error(`Claude session not found: ${activeSessionId}`)
          }
          const entries = this.localCommandEntries(
            activeSessionId,
            this.activeCwd(),
            this.logicalTailUuid(snapshot.tail),
            'btw',
            '',
            'Usage: /btw <your question>',
          )
          const leafUuid = entries.at(-1)?.uuid
          if (typeof leafUuid !== 'string') {
            throw new Error('Claude btw local command pair is incomplete')
          }
          const appended = await lease.appendMany(snapshot.tail, [
            ...entries,
            { type: 'last-prompt', leafUuid, sessionId: activeSessionId },
          ])
          if (appended.status === 'conflict') {
            throw new Error(
              `Claude local command append conflict: ${appended.reason}`,
            )
          }
        },
      )
      if (result.status === 'completed') return activeSessionId
      await new Promise<void>((resolve) => setTimeout(resolve, 25))
    }
  }

  async recordColorUsage(
    sessionId: string | undefined,
    selection: AgentColorSelection,
    display: string,
    permissionMode: ClaudePermissionMode = 'default',
    options: { createSession?: boolean } = {},
  ): Promise<string> {
    const output = agentColorMessage(selection)
    const agentColor: AgentColorValue | undefined =
      selection.kind === 'color'
        ? selection.color
        : selection.kind === 'reset'
          ? AGENT_COLOR_DEFAULT
          : undefined
    const createLocalSession =
      sessionId === undefined || options.createSession === true
    const activeSessionId = await this.ensureLocalSession(
      sessionId,
      permissionMode,
      createLocalSession ? agentColor : undefined,
      options.createSession === true,
    )
    if (this.options.sessionPersistence !== false) {
      await this.appendInputHistory(display, activeSessionId)
    }
    await this.appendAgentColorUsage(
      activeSessionId,
      display,
      output,
      createLocalSession ? undefined : agentColor,
    )
    return activeSessionId
  }

  async recordBackgroundUsage(
    sessionId: string | undefined,
    permissionMode: ClaudePermissionMode = 'default',
  ): Promise<string> {
    this.assertWritable()
    const activeSessionId = await this.ensureLocalSession(
      sessionId,
      permissionMode,
    )
    await this.appendInputHistory('/background', activeSessionId)
    while (true) {
      const result = await this.turnStore(activeSessionId).withLease(
        async (lease) => {
          const snapshot = await lease.load()
          if (snapshot.entries.length === 0) {
            throw new Error(`Claude session not found: ${activeSessionId}`)
          }
          const timestamp = new Date().toISOString()
          const promptId = randomUUID()
          const firstUuid = randomUUID()
          const commandUuid = randomUUID()
          const common = {
            isSidechain: false,
            promptId,
            timestamp,
            userType: 'external',
            entrypoint: 'cli',
            cwd: this.activeCwd(),
            sessionId: activeSessionId,
            version: this.options.claudeVersion,
            gitBranch: null,
          }
          const appended = await lease.appendMany(snapshot.tail, [
            {
              ...common,
              parentUuid: this.logicalTailUuid(snapshot.tail),
              type: 'user',
              message: {
                role: 'user',
                content:
                  '<local-command-caveat>Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages or otherwise consider them in your response unless the user explicitly asks you to.</local-command-caveat>',
              },
              isMeta: true,
              uuid: firstUuid,
            },
            {
              ...common,
              parentUuid: firstUuid,
              type: 'user',
              message: {
                role: 'user',
                content:
                  '<command-name>/background</command-name>\n            <command-message>background</command-message>\n            <command-args></command-args>',
              },
              uuid: commandUuid,
            },
            {
              ...common,
              parentUuid: commandUuid,
              type: 'user',
              message: {
                role: 'user',
                content:
                  '<local-command-stdout>Nothing to background yet — send a message first.</local-command-stdout>',
              },
              uuid: randomUUID(),
            },
          ])
          if (appended.status === 'conflict') {
            throw new Error(
              `Claude background command append conflict: ${appended.reason}`,
            )
          }
        },
      )
      if (result.status === 'completed') return activeSessionId
      await new Promise<void>((resolve) => setTimeout(resolve, 25))
    }
  }

  async recordBackgroundLaunch(
    sessionId: string,
  ): Promise<SessionForkCheckpoint> {
    this.assertWritable()
    const result = await this.turnStore(sessionId).withLease((lease) =>
      lease.load(),
    )
    if (result.status === 'conflict') {
      throw new Error(`Claude background checkpoint conflict: ${result.reason}`)
    }
    const resumeSessionAt = this.logicalTailUuid(result.value.tail)
    if (!resumeSessionAt) {
      throw new Error(`Claude session not found: ${sessionId}`)
    }
    await this.appendInputHistory('/background', sessionId)
    return { resumeSessionAt, entryCount: result.value.entries.length }
  }

  async compact(
    sessionId: string,
    signal?: AbortSignal,
    selection?: ManualCompactSelection,
  ): Promise<ManualCompactResult> {
    this.assertWritable()
    const provider = this.provider()
    const result = await this.turnStore(sessionId).withLease(async (lease) => {
      const snapshot = await lease.load()
      if (snapshot.entries.length === 0) {
        throw new Error(`Claude session not found: ${sessionId}`)
      }
      await this.activateSessionCostTracker(sessionId)
      const activeEntries = selectClaudeActiveTranscript(snapshot.entries)
      const allMessages = projectClaudeModelMessages(activeEntries)
      let selectedEntries = activeEntries
      let logicalParentUuid = this.lastMessageUuid(activeEntries)
      let preservedEntries: ClaudeTranscriptEntry[] = []
      let memoryMessage: ModelMessage | undefined
      if (selection) {
        const targetIndex = activeEntries.findIndex(
          (entry) => entry.uuid === selection.messageId,
        )
        if (targetIndex < 0) {
          throw new Error(
            `No rewind point found with message.uuid of: ${selection.messageId}`,
          )
        }
        if (selection.direction === 'from') {
          selectedEntries = activeEntries.slice(targetIndex)
          preservedEntries = activeEntries.slice(0, targetIndex)
          logicalParentUuid = this.lastMessageUuid(preservedEntries)
          if (!logicalParentUuid) logicalParentUuid = selection.messageId
        } else {
          selectedEntries = activeEntries.slice(0, targetIndex)
          preservedEntries = activeEntries.slice(targetIndex)
          const target = activeEntries[targetIndex]
          logicalParentUuid =
            typeof target?.parentUuid === 'string'
              ? target.parentUuid
              : this.lastMessageUuid(selectedEntries)
        }
      } else {
        const memorySelection = await this.selectMemoryPreservedCompact(
          sessionId,
          activeEntries,
        )
        if (memorySelection) {
          selectedEntries = [...memorySelection.compactedEntries]
          preservedEntries = [...memorySelection.preservedEntries]
          logicalParentUuid = memorySelection.logicalParentUuid
          memoryMessage = memorySelection.memoryMessage
        }
      }
      const selectedMessages = projectClaudeModelMessages(selectedEntries)
      const messages: ModelMessage[] = [
        ...(memoryMessage === undefined ? [] : [memoryMessage]),
        ...selectedMessages,
        ...(selection?.context
          ? [
              {
                role: 'user' as const,
                content: `Additional summarization context: ${selection.context}`,
              },
            ]
          : []),
      ]
      if (!logicalParentUuid || selectedMessages.length === 0) {
        throw new Error('Cannot compact an empty Claude transcript')
      }
      if (findUnresolvedClaudeToolCalls(snapshot.entries).length > 0) {
        throw new Error(
          'Cannot compact a Claude session with unresolved tool calls',
        )
      }
      this.options.eventSink?.({ type: 'state', state: 'compacting' })
      const contextWindowTokens =
        this.contextBudget(provider)?.contextWindowTokens ??
        provider.capabilities.contextWindowTokens ??
        200_000
      const compacted = await (
        this.options.compactor ?? new ModelCompactor(provider)
      ).compact({
        messages,
        targetTokens: Math.min(
          8192,
          Math.max(1, Math.floor(contextWindowTokens / 4)),
        ),
        contextWindowTokens,
        ...(signal ? { signal } : {}),
      })
      if (signal?.aborted) throw new AgentRunCancelledError()
      const {
        durationMs: compactedDurationMs,
        durationWithoutRetriesMs: compactedDurationWithoutRetriesMs,
      } = requireCompactionDurations(compacted)
      requireManualCompactUsage(compacted.usage)
      const compactorModel = compacted.model
      const compactModel =
        compactorModel !== undefined && compactorModel.trim() !== ''
          ? compactorModel
          : provider.model
      const summary = compacted.summary
      const meaningfulMetering =
        summary.trim().length > 0 &&
        (hasNonZeroUsage(compacted.usage) || compactedDurationMs > 0)
      if (
        meaningfulMetering &&
        (compactModel === undefined || compactModel.trim() === '')
      ) {
        throw new Error(
          'Manual compact usage requires a nonblank model identity',
        )
      }
      const preTokens = estimateModelRequestTokens(allMessages)
      const preservedMessages = projectClaudeModelMessages(preservedEntries)
      const boundaryUuid = randomUUID()
      const summaryUuid = randomUUID()
      const uuids = [boundaryUuid, summaryUuid]
      let meteringTurnInput: ClaudeSessionTurnInput | undefined
      if (
        meaningfulMetering &&
        compactModel !== undefined &&
        compactModel.trim() !== ''
      ) {
        const tracker = this.sessionCostTrackers.get(sessionId)
        if (!tracker) {
          throw new Error(
            `Session cost tracker is not active for session ${sessionId}`,
          )
        }
        const pricing = this.options.pricing?.resolve(compactModel)
        const costUsd = pricing
          ? usageCostUsd(compacted.usage, pricing)
          : undefined
        meteringTurnInput = {
          model: compactModel,
          usage: compacted.usage,
          ...(costUsd === undefined ? {} : { costUsd }),
          ...(compacted.usage.webSearchRequests === undefined
            ? {}
            : { webSearchRequests: compacted.usage.webSearchRequests }),
          apiDurationMs: compactedDurationMs,
          apiDurationWithoutRetriesMs: compactedDurationWithoutRetriesMs,
        }
        // Preflight the exact record input against a clone of the live
        // tracker so a cumulative total overflow rejects before the compact
        // boundary is appended rather than after a half-commit.
        const preflight = new ClaudeSessionCostTracker({
          sessionId,
          restored: tracker.snapshot(),
        })
        preflight.recordTurn(meteringTurnInput)
      }
      const entries = createClaudeCompactEntries({
        sessionId,
        logicalParentUuid,
        summary,
        preTokens,
        postTokens: estimateModelRequestTokens([
          { role: 'user', content: formatClaudeCompactSummary(summary) },
          ...preservedMessages,
        ]),
        previousCumulativeDroppedTokens: getCumulativeDroppedTokens(
          snapshot.entries,
        ),
        durationMs: compactedDurationMs,
        cwd: this.activeCwd(),
        claudeVersion: this.options.claudeVersion,
        gitBranch: null,
        trigger: 'manual',
        ...(selection
          ? {
              summarizeMetadata: {
                messagesSummarized: selectedMessages.length,
                direction:
                  selection.direction === 'to' ? 'up_to' : selection.direction,
              },
              preservedUuids: preservedEntries.flatMap((entry) =>
                typeof entry.uuid === 'string' ? [entry.uuid] : [],
              ),
            }
          : memoryMessage
            ? {
                preservedUuids: preservedEntries.flatMap((entry) =>
                  typeof entry.uuid === 'string' ? [entry.uuid] : [],
                ),
              }
            : {}),
        createUuid: () => uuids.shift() ?? randomUUID(),
      })
      const appendResult = await lease.appendMany(snapshot.tail, entries)
      if (appendResult.status === 'conflict') {
        throw new Error(
          `Claude transcript append conflict: ${appendResult.reason}`,
        )
      }
      this.options.projectMemoryRecall?.recordCompact(sessionId)
      this.options.eventSink?.({
        type: 'compact-boundary',
        trigger: 'manual',
        preTokens,
        uuid: boundaryUuid,
      })
      if (meteringTurnInput !== undefined) {
        const tracker = this.sessionCostTrackers.get(sessionId)
        if (!tracker) {
          throw new Error(
            `Session cost tracker is not active for session ${sessionId}`,
          )
        }
        tracker.recordTurn(meteringTurnInput)
      }
      return {
        summary,
        usage: compacted.usage,
        preTokens,
        ...(selection ? { messagesSummarized: selectedMessages.length } : {}),
      }
    })
    if (result.status === 'conflict') {
      throw new Error(`Claude transcript compact conflict: ${result.reason}`)
    }
    return result.value
  }

  async fork(
    parentSessionId: string,
    sessionId: string = randomUUID(),
    resumeSessionAt?: string,
  ): Promise<ForkResult> {
    this.assertSessionPersistence()
    this.assertWritable()
    const entries = await this.nativeForkEntries(
      parentSessionId,
      sessionId,
      resumeSessionAt,
    )
    const result = await this.store(sessionId).create(entries)
    if (result.status === 'conflict') {
      throw new Error('Generated Claude fork session already exists')
    }
    this.options.contextAssembler?.invalidate?.({
      lifecycleId: sessionId,
      reason: 'fork',
    })
    return { sessionId, parentSessionId }
  }

  async ensureFork(
    parentSessionId: string,
    sessionId: string,
    checkpoint?: SessionForkCheckpoint,
  ): Promise<ForkResult> {
    this.assertSessionPersistence()
    this.assertWritable()
    const expected = await this.nativeForkEntries(
      parentSessionId,
      sessionId,
      checkpoint?.resumeSessionAt,
      checkpoint?.entryCount,
    )
    const target = this.store(sessionId)
    const created = await target.create(expected)
    if (created.status === 'created') {
      this.options.contextAssembler?.invalidate?.({
        lifecycleId: sessionId,
        reason: 'fork',
      })
      return { sessionId, parentSessionId }
    }
    const existing = await target.withLease((lease) => lease.load())
    if (existing.status === 'conflict') {
      throw new Error(`Claude transcript fork conflict: ${existing.reason}`)
    }
    if (
      existing.value.entries.length < expected.length ||
      expected.some(
        (entry, index) =>
          JSON.stringify(existing.value.entries[index]) !==
          JSON.stringify(entry),
      )
    ) {
      throw new Error('Claude handoff target is not the expected native fork')
    }
    this.options.contextAssembler?.invalidate?.({
      lifecycleId: sessionId,
      reason: 'fork',
    })
    return { sessionId, parentSessionId }
  }

  private async nativeForkEntries(
    parentSessionId: string,
    sessionId: string,
    resumeSessionAt?: string,
    sourceEntryCount?: number,
  ): Promise<ClaudeTranscriptEntry[]> {
    const sourceResult = await this.store(parentSessionId).withLease((lease) =>
      lease.load(),
    )
    if (sourceResult.status === 'conflict') {
      throw new Error(`Claude transcript fork conflict: ${sourceResult.reason}`)
    }
    const source = sourceResult.value
    if (source.entries.length === 0) {
      throw new Error(`Claude session not found: ${parentSessionId}`)
    }
    if (
      sourceEntryCount !== undefined &&
      (sourceEntryCount <= 0 || sourceEntryCount > source.entries.length)
    ) {
      throw new Error('Claude handoff source checkpoint is no longer available')
    }

    return createClaudeNativeFork({
      source:
        sourceEntryCount === undefined
          ? source.entries
          : source.entries.slice(0, sourceEntryCount),
      sourceSessionId: parentSessionId,
      sessionId,
      ...(resumeSessionAt === undefined ? {} : { resumeSessionAt }),
    })
  }

  async rewindFiles(sessionId: string, userMessageId: string): Promise<void> {
    const result = await this.store(sessionId).withLease(async (lease) => {
      const snapshot = await lease.load()
      if (snapshot.entries.length === 0) {
        throw new Error(`Claude session not found: ${sessionId}`)
      }
      this.restoreWorktree(snapshot.entries)
      this.options.interactiveTools?.restore(sessionId, snapshot.entries)
      await new ClaudeFileHistory(this.options.configRoot, sessionId, [
        this.activeCwd(),
        ...(this.options.fileRewindRoots ?? []),
      ]).rewind(snapshot.entries, userMessageId)
    })
    if (result.status === 'conflict') {
      throw new Error(`Claude file rewind conflict: ${result.reason}`)
    }
  }

  async rewindPoints(sessionId: string): Promise<RewindPoint[]> {
    const result = await this.turnStore(sessionId).withLease((lease) =>
      lease.load(),
    )
    if (result.status === 'conflict') {
      throw new Error(`Claude transcript rewind conflict: ${result.reason}`)
    }
    if (result.value.entries.length === 0) {
      throw new Error(`Claude session not found: ${sessionId}`)
    }
    const active = selectClaudeActiveTranscript(result.value.entries)
    const snapshots = new Set(
      active
        .filter(
          (entry) =>
            entry.type === 'file-history-snapshot' &&
            typeof entry.messageId === 'string',
        )
        .map((entry) => entry.messageId as string),
    )
    const changes = new Map<string, Set<string>>()
    for (const entry of active) {
      if (
        entry.type !== 'file-history-delta' ||
        typeof entry.snapshotMessageId !== 'string' ||
        typeof entry.trackingPath !== 'string'
      ) {
        continue
      }
      const paths = changes.get(entry.snapshotMessageId) ?? new Set<string>()
      paths.add(entry.trackingPath)
      changes.set(entry.snapshotMessageId, paths)
    }
    const points: RewindPoint[] = []
    let branchMessageId: string | undefined
    for (const entry of active) {
      if (
        (entry.type === 'user' || entry.type === 'assistant') &&
        typeof entry.uuid === 'string'
      ) {
        const message = entry.message
        if (
          typeof message === 'object' &&
          message !== null &&
          !Array.isArray(message)
        ) {
          const role = (message as Record<string, unknown>).role
          const content = (message as Record<string, unknown>).content
          if (
            entry.type === 'user' &&
            role === 'user' &&
            typeof content === 'string' &&
            entry.isCompactSummary !== true &&
            entry.isMeta !== true &&
            typeof entry.sourceToolAssistantUUID !== 'string' &&
            !content.startsWith('<bash-input>') &&
            !content.startsWith('<local-command-') &&
            !content.startsWith('<command-name>')
          ) {
            points.push({
              messageId: entry.uuid,
              prompt: content,
              ...(typeof entry.timestamp === 'string'
                ? { timestamp: entry.timestamp }
                : {}),
              ...(branchMessageId === undefined ? {} : { branchMessageId }),
              fileChanges: [...(changes.get(entry.uuid) ?? [])],
              fileRestoreAvailable: snapshots.has(entry.uuid),
            })
          }
          if (role === 'user' || role === 'assistant') {
            branchMessageId = entry.uuid
          }
        }
      }
    }
    return points
  }

  async setPermissionMode(
    sessionId: string,
    permissionMode: ClaudePermissionMode,
  ): Promise<void> {
    this.assertSessionPersistence()
    this.assertWritable()
    const result = await this.store(sessionId).withLease(async (lease) => {
      const snapshot = await lease.load()
      if (snapshot.entries.length === 0) {
        throw new Error(`Claude session not found: ${sessionId}`)
      }
      this.options.interactiveTools?.restore(sessionId, snapshot.entries)
      const entry: ClaudeTranscriptEntry = {
        type: 'permission-mode',
        permissionMode,
        sessionId,
      }
      await this.append(lease, snapshot.tail, entry)
      await this.options.interactiveTools?.setMode(sessionId, permissionMode)
    })
    if (result.status === 'conflict') {
      throw new Error(
        `Claude permission mode update conflict: ${result.reason}`,
      )
    }
  }

  private async activateSessionCostTracker(sessionId: string): Promise<void> {
    if (this.activeCostSessionId === sessionId) return
    const store = this.options.costStateStore
    if (store) {
      // Load the target native state before any save so the single
      // `.claude.json` slot is not overwritten before it is read.
      const loaded = await store.load(sessionId)
      const currentId = this.activeCostSessionId
      if (currentId !== undefined) {
        const current = this.sessionCostTrackers.get(currentId)
        if (current) await store.save(current.snapshot())
      }
      if (!this.sessionCostTrackers.has(sessionId)) {
        this.sessionCostTrackers.set(
          sessionId,
          new ClaudeSessionCostTracker({
            sessionId,
            ...(loaded ? { restored: loaded } : {}),
          }),
        )
      }
    } else if (!this.sessionCostTrackers.has(sessionId)) {
      this.sessionCostTrackers.set(
        sessionId,
        new ClaudeSessionCostTracker({ sessionId }),
      )
    }
    this.activeCostSessionId = sessionId
  }

  private persistActiveSessionCost(): Promise<void> {
    const store = this.options.costStateStore
    const activeId = this.activeCostSessionId
    if (!store || activeId === undefined) return Promise.resolve()
    const tracker = this.sessionCostTrackers.get(activeId)
    if (!tracker) return Promise.resolve()
    return store.save(tracker.snapshot())
  }

  private recordAuxiliaryMetrics(
    sessionId: string,
    metrics: {
      usage: ModelUsage
      model?: string
      durationApiMs: number
      durationApiWithoutRetriesMs: number
    },
  ): void {
    const tracker = this.sessionCostTrackers.get(sessionId)
    if (!tracker) {
      throw new Error(
        `Session cost tracker is not active for session ${sessionId}`,
      )
    }
    const model =
      metrics.model !== undefined && metrics.model.trim() !== ''
        ? metrics.model
        : 'praxis/provider'
    if (hasNonZeroUsage(metrics.usage)) {
      const pricing = this.options.pricing?.resolve(model)
      const costUsd = pricing ? usageCostUsd(metrics.usage, pricing) : undefined
      tracker.recordTurn({
        model,
        usage: metrics.usage,
        ...(costUsd === undefined ? {} : { costUsd }),
        ...(metrics.usage.webSearchRequests === undefined
          ? {}
          : { webSearchRequests: metrics.usage.webSearchRequests }),
        apiDurationMs: metrics.durationApiMs,
        apiDurationWithoutRetriesMs: metrics.durationApiWithoutRetriesMs,
      })
      return
    }
    tracker.recordDurations({
      apiDurationMs: metrics.durationApiMs,
      apiDurationWithoutRetriesMs: metrics.durationApiWithoutRetriesMs,
    })
  }

  async costSnapshot(sessionId: string): Promise<ClaudeSessionCostSnapshot> {
    const existing = this.sessionCostTrackers.get(sessionId)
    if (existing) return existing.snapshot()
    const store = this.options.costStateStore
    const loaded = store ? await store.load(sessionId) : null
    const tracker = new ClaudeSessionCostTracker({
      sessionId,
      ...(loaded ? { restored: loaded } : {}),
    })
    this.sessionCostTrackers.set(sessionId, tracker)
    return tracker.snapshot()
  }

  private async executeTurn(
    sessionId: string,
    prompt: string,
    requireExisting: boolean,
    signal?: AbortSignal,
    name?: string,
    images: readonly ModelImage[] = [],
    documents: readonly ModelDocument[] = [],
    resumeSessionAt?: string,
    shellCommand?: string,
    skipUserPrompt = false,
  ): Promise<SessionRunResult> {
    this.assertWritable()
    if (prompt.length === 0 && images.length === 0 && documents.length === 0)
      throw new Error('Prompt must not be empty')
    if (name !== undefined && name.length === 0) {
      throw new Error('Session name must not be empty')
    }
    if (shellCommand !== undefined && shellCommand.trim().length === 0) {
      throw new Error('Shell command must not be empty')
    }

    await this.activateSessionCostTracker(sessionId)

    await this.ensureFileResources(sessionId, signal)

    this.worktreeManager?.bindSession(sessionId)
    if (this.options.initialWorktree) {
      await this.worktreeManager?.ensureInitial(
        this.options.initialWorktreeName,
      )
    }
    const pinnedCwd = this.sessionCwds.get(sessionId) ?? this.activeCwd()
    this.sessionCwds.set(sessionId, pinnedCwd)
    if (this.options.workspace?.cwd() !== pinnedCwd) {
      this.options.workspace?.setCwd(pinnedCwd)
    }
    this.runtimeCwd = pinnedCwd
    if (requireExisting) {
      await this.discoverProjectRoot(sessionId)
    }
    const sessionPaths = this.paths(sessionId)
    const toolResultDirectory = join(
      sessionPaths.projectRoot,
      sessionId,
      'tool-results',
    )
    const store = this.turnStore(sessionId)
    const leaseResult = await store.withLease(async (lease) => {
      if (!requireExisting) {
        const initialization =
          name === undefined
            ? await store.reserve()
            : await store.create(this.sessionNameEntries(sessionId, name))
        if (initialization.status === 'conflict') {
          throw new Error(`Session ID ${sessionId} is already in use`)
        }
      }
      let snapshot = await lease.load()
      if (
        requireExisting &&
        this.options.sessionPersistence === false &&
        snapshot.entries.length === 0
      ) {
        const persisted = await this.store(sessionId).load()
        if (persisted.entries.length > 0) {
          const imported = await store.create(persisted.entries)
          if (imported.status === 'created') snapshot = await lease.load()
        }
      }
      if (requireExisting && snapshot.entries.length === 0) {
        throw new Error(`Claude session not found: ${sessionId}`)
      }
      if (resumeSessionAt !== undefined) {
        snapshot = {
          entries: selectClaudeTranscriptAtMessage(
            snapshot.entries,
            resumeSessionAt,
          ),
          tail: { ...snapshot.tail, branchParentUuid: resumeSessionAt },
        }
      }
      const initialTransition =
        this.worktreeManager?.consumeTransition('__initial__')
      if (initialTransition && snapshot.entries.length === 0) {
        const stateEntry: ClaudeTranscriptEntry = {
          type: 'worktree-state',
          worktreeSession: initialTransition.state,
          sessionId,
        }
        const stateTail = await this.append(lease, snapshot.tail, stateEntry)
        snapshot = {
          entries: [...snapshot.entries, stateEntry],
          tail: stateTail,
        }
      }
      this.restoreWorktree(snapshot.entries)
      this.options.interactiveTools?.restore(sessionId, snapshot.entries)
      if (
        requireExisting &&
        name !== undefined &&
        !this.hasSessionName(snapshot.entries, name)
      ) {
        const entries = this.sessionNameEntries(sessionId, name)
        const appendResult = await lease.appendMany(snapshot.tail, entries)
        if (appendResult.status === 'conflict') {
          throw new Error(
            `Claude transcript append conflict: ${appendResult.reason}`,
          )
        }
        snapshot = {
          entries: [...snapshot.entries, ...entries],
          tail: appendResult.tail,
        }
      }
      const agentName =
        this.options.agent ?? getClaudeAgentSetting(snapshot.entries)
      const agent = this.resolveAgent(agentName)
      const provider = this.providerForAgent(agent)
      this.activeProvider = provider
      const effectivePrompt =
        !requireExisting &&
        !skipUserPrompt &&
        !this.options.agentInitialPromptHandledExternally &&
        shellCommand === undefined &&
        agent?.initialPrompt
          ? `${agent.initialPrompt}\n\n${prompt}`
          : prompt
      const projectMemoryRecallTurn =
        !skipUserPrompt && shellCommand === undefined
          ? this.options.projectMemoryRecall?.prefetch({
              sessionId,
              turnId: randomUUID(),
              prompt: effectivePrompt,
              ...(signal ? { signal } : {}),
            })
          : undefined
      const initialPricing = this.options.pricing?.resolve(
        provider.model ?? 'praxis/provider',
      )
      if (this.options.maxBudgetUsd !== undefined && !initialPricing) {
        throw new Error(
          `Cannot enforce --max-budget-usd: no pricing is configured for model ${provider.model ?? 'praxis/provider'}`,
        )
      }
      const shellInputUuid = shellCommand === undefined ? null : randomUUID()
      let currentPromptId: string | null = shellInputUuid
      let lastAssistantUuid: string | null = null
      const fileHistory =
        this.options.fileCheckpointing &&
        this.options.sessionPersistence !== false
          ? new ClaudeFileHistory(this.options.configRoot, sessionId, [
              this.activeCwd(),
              ...(this.options.fileRewindRoots ?? []),
            ])
          : null
      const unresolvedToolCalls = findUnresolvedClaudeToolCalls(
        snapshot.entries,
      )
      const pendingRecoveryToolCallIds = new Set(
        unresolvedToolCalls.map((call) => call.id),
      )
      const pendingRecoveryHookOutcomes: ClaudeHookOutcome[] = []
      const currentHookCwd = () => this.activeCwd()
      const hookSession = {
        session_id: sessionId,
        transcript_path: sessionPaths.sessionFile,
        get cwd() {
          return currentHookCwd()
        },
        permission_mode: 'default',
      }
      const appendHookOutcome = async (outcome: ClaudeHookOutcome) => {
        for (const entry of createClaudeHookAttachmentEntries(
          outcome,
          this.translationContext(sessionId, snapshot),
        )) {
          const tail = await this.append(lease, snapshot.tail, entry)
          snapshot = { entries: [...snapshot.entries, entry], tail }
        }
      }
      const recordHookOutcome = async (
        outcome: ClaudeHookOutcome,
        deferUntilApproval = false,
      ) => {
        if (deferUntilApproval) {
          pendingRecoveryHookOutcomes.push(outcome)
          return
        }
        await appendHookOutcome(outcome)
      }
      const flushRecoveryHookOutcomes = async () => {
        const entries: ClaudeTranscriptEntry[] = []
        let history = snapshot.entries
        let parentUuid = this.logicalTailUuid(snapshot.tail)
        for (const outcome of pendingRecoveryHookOutcomes) {
          const outcomeEntries = createClaudeHookAttachmentEntries(outcome, {
            ...this.translationContext(sessionId, snapshot),
            parentUuid,
            history,
          })
          entries.push(...outcomeEntries)
          history = [...history, ...outcomeEntries]
          const lastEntry = outcomeEntries.at(-1)
          if (typeof lastEntry?.uuid === 'string') parentUuid = lastEntry.uuid
        }
        if (entries.length === 0) {
          pendingRecoveryHookOutcomes.length = 0
          return
        }
        const appendResult = await lease.appendMany(snapshot.tail, entries)
        if (appendResult.status === 'conflict') {
          throw new Error(
            `Claude transcript append conflict: ${appendResult.reason}`,
          )
        }
        snapshot = { entries: history, tail: appendResult.tail }
        pendingRecoveryHookOutcomes.length = 0
      }
      const capabilities = this.toolCapabilities()
      const taskToolNames = this.capabilityToolNames(
        this.options.taskToolNames,
        capabilities,
      )
      const scheduledToolNames = this.capabilityToolNames(
        this.options.scheduledToolNames,
        capabilities,
      )
      const taskTools =
        this.options.tools && taskToolNames.length > 0
          ? new ClaudeTaskToolRegistry({
              base: this.options.tools,
              cwd: this.activeCwd(),
              cwdProvider: () => this.activeCwd(),
              praxisRoot: sessionPaths.praxisRoot,
              sessionId,
              taskRoot: sessionPaths.taskRoot,
              ...(this.options.eventSink
                ? { eventSink: this.options.eventSink }
                : {}),
              enabledTools: taskToolNames,
            })
          : null
      const scheduledTools =
        this.scheduledPrompts &&
        this.options.tools &&
        scheduledToolNames.length > 0
          ? new ClaudeScheduledToolRegistry({
              base: taskTools ?? this.options.tools,
              manager: this.scheduledPrompts,
              sessionId,
              enabledTools: scheduledToolNames,
              dataPlane: this.options.dataPlane ?? 'claude',
            })
          : null
      const baseTools = scheduledTools ?? taskTools ?? this.options.tools
      const turnPermissions =
        this.options.interactiveTools?.permissions(sessionId) ??
        this.options.permissions
      const subagentExecutor =
        (this.options.enableSubagents || this.options.enableWorkflows) &&
        baseTools &&
        turnPermissions
          ? new ClaudeSubagentExecutor({
              configRoot: this.options.configRoot,
              dataPlane: this.options.dataPlane ?? 'claude',
              cwd: this.activeCwd(),
              cwdProvider: () => this.activeCwd(),
              claudeVersion: this.options.claudeVersion,
              provider,
              persistence:
                this.options.sessionPersistence === false ? 'memory' : 'disk',
              ...(this.options.providerForModel
                ? { providerForModel: this.options.providerForModel }
                : {}),
              baseTools,
              permissions: turnPermissions,
              ...(this.options.permissionResolverForMode
                ? {
                    permissionResolverForMode:
                      this.options.permissionResolverForMode,
                  }
                : {}),
              parentPermissionMode: () =>
                agentPermissionMode(
                  this.options.interactiveTools?.mode(sessionId) ??
                    this.options.permissionMode,
                ),
              ...(this.options.subagentToolNames
                ? {
                    toolNames: this.capabilityToolNames(
                      this.options.subagentToolNames,
                      capabilities,
                    ),
                  }
                : {}),
              ...(this.options.extensions
                ? { extensions: this.options.extensions }
                : {}),
              ...(this.options.mcp ? { mcp: this.options.mcp } : {}),
              ...(this.options.hooks ? { hooks: this.options.hooks } : {}),
              ...(this.options.contextAssembler
                ? { contextAssembler: this.options.contextAssembler }
                : {}),
              ...((this.options.contextBudget?.reserveTokens ??
                this.options.contextReserveTokens) === undefined
                ? {}
                : {
                    contextReserveTokens:
                      this.options.contextBudget?.reserveTokens ??
                      this.options.contextReserveTokens,
                  }),
              ...(this.options.approveTool
                ? { approveTool: this.options.approveTool }
                : {}),
              permissionUpdates: () =>
                this.sessionPermissionUpdates.get(sessionId) ?? [],
              onPermissionUpdates: (updates) =>
                this.applyPermissionUpdates(sessionId, updates),
              onLineChanges: (changes) => {
                const tracker = this.sessionCostTrackers.get(sessionId)
                if (!tracker) {
                  throw new Error(
                    `Session cost tracker is not active for session ${sessionId}`,
                  )
                }
                tracker.recordLineChanges(changes)
              },
              ...(this.options.eventSink
                ? { eventSink: this.options.eventSink }
                : {}),
              ...(taskTools
                ? {
                    backgroundTaskNotifications: (waitForRunning: boolean) =>
                      taskTools.notifications(waitForRunning),
                  }
                : {}),
            })
          : null
      const agentTools = subagentExecutor
        ? subagentExecutor.registry(
            sessionId,
            0,
            (callId) =>
              currentPromptId ??
              this.promptIdForToolCall(snapshot.entries, callId),
          )
        : baseTools
      const turnTools =
        this.workflowManager && subagentExecutor && agentTools
          ? new ClaudeWorkflowToolRegistry({
              base: agentTools,
              manager: this.workflowManager,
              executor: subagentExecutor,
              cwd: this.activeCwd(),
              cwdProvider: () => this.activeCwd(),
              configRoot: this.options.configRoot,
              sessionId,
              promptIdForCall: (callId) =>
                currentPromptId ??
                this.promptIdForToolCall(snapshot.entries, callId),
              defaultModel: provider.model ?? 'praxis/provider',
              tokenBudget: workflowTokenTarget(effectivePrompt),
              enabled: capabilities.has('Workflow'),
              dataPlane: this.options.dataPlane ?? 'claude',
            })
          : agentTools
      const workspaceTools =
        this.worktreeManager &&
        turnTools &&
        this.options.workspace &&
        (this.options.worktreeToolNames?.length ?? 0) > 0
          ? new ClaudeWorktreeToolRegistry({
              base: turnTools,
              manager: this.worktreeManager,
              workspace: this.options.workspace,
              enabledTools: this.options.worktreeToolNames ?? [],
              dataPlane: this.options.dataPlane ?? 'claude',
            })
          : turnTools
      const messageTools =
        this.options.brief && workspaceTools
          ? new ClaudeUserMessageToolRegistry(
              workspaceTools,
              (message: UserMessage) =>
                this.options.eventSink?.({
                  type: 'user-message',
                  message: message.message,
                  status: message.status,
                  ...(message.attachments.length
                    ? { attachments: message.attachments }
                    : {}),
                }),
            )
          : workspaceTools
      const interactiveMessageTools =
        this.options.interactiveTools && messageTools
          ? this.options.interactiveTools.registry(messageTools, sessionId)
          : messageTools
      const fileHistoryTools: ToolRegistry | undefined =
        fileHistory && interactiveMessageTools
          ? {
              definitions: () => interactiveMessageTools.definitions(),
              schedulingPolicy: (call) => ({
                ...resolveToolSchedulingPolicy(interactiveMessageTools, call),
                startAfterAssistant: true,
              }),
              prepare: (call, context) =>
                interactiveMessageTools.prepare(call, context),
              execute: async (call, context) => {
                const path =
                  call.name === 'Write' || call.name === 'Edit'
                    ? call.input.file_path
                    : call.name === 'NotebookEdit'
                      ? call.input.notebook_path
                      : undefined
                if (typeof path !== 'string') {
                  return interactiveMessageTools.execute(call, context)
                }
                if (
                  (call.name === 'Write' || call.name === 'Edit') &&
                  (await this.options.interactiveTools?.isPlanFile(
                    sessionId,
                    path,
                  ))
                ) {
                  return interactiveMessageTools.execute(call, context)
                }
                const snapshotMessageId =
                  currentPromptId ??
                  this.promptIdForToolCall(snapshot.entries, call.id)
                const assistantMessageId =
                  lastAssistantUuid ??
                  this.assistantIdForToolCall(snapshot.entries, call.id)
                if (!snapshotMessageId || !assistantMessageId) {
                  throw new Error(
                    'Claude file history could not link tool call',
                  )
                }
                const prepared = await fileHistory.prepareMutation(
                  snapshot.entries,
                  snapshotMessageId,
                  path,
                )
                let result
                try {
                  result = await interactiveMessageTools.execute(call, context)
                } catch (error) {
                  await prepared.rollback()
                  throw error
                }
                if (result.isError) {
                  await prepared.rollback()
                  return result
                }
                const entry = prepared.commit(assistantMessageId)
                if (entry) {
                  const tail = await this.append(lease, snapshot.tail, entry)
                  snapshot = { entries: [...snapshot.entries, entry], tail }
                }
                return result
              },
            }
          : interactiveMessageTools
      const capabilityTools = fileHistoryTools
        ? new ClaudeCapabilityToolRegistry(fileHistoryTools, capabilities)
        : undefined
      const structuredCapture = this.options.structuredOutputSchema
        ? { calls: 0, value: undefined as unknown }
        : undefined
      const agentScopedTools =
        agent && capabilityTools
          ? new FilteredToolRegistry(capabilityTools, {
              tools: mainAgentToolNames(capabilityTools, agent),
            })
          : capabilityTools
      const structuredTools =
        this.options.structuredOutputSchema && structuredCapture
          ? new StructuredOutputRegistry(
              agentScopedTools ?? this.options.tools ?? emptyToolRegistry,
              this.options.structuredOutputSchema,
              structuredCapture,
            )
          : agentScopedTools
      const hookTools =
        this.options.hooks && structuredTools && turnPermissions
          ? new ClaudeHookToolCoordinator({
              tools: structuredTools,
              permissions: turnPermissions,
              hooks: this.options.hooks,
              session: hookSession,
              recordOutcome: recordHookOutcome,
              deferPreToolUseOutcome: (call) =>
                pendingRecoveryToolCallIds.has(call.id),
            })
          : null
      const runtime = new AgentRuntime(provider, this.options.eventSink, {
        emitInitialContextState: false,
        ...(this.options.emitToolUseSummaries
          ? {
              generateToolUseSummary: ({ tools, lastAssistantText, signal }) =>
                generateToolUseSummary(
                  provider,
                  tools,
                  signal,
                  lastAssistantText,
                  (metrics) => this.recordAuxiliaryMetrics(sessionId, metrics),
                ),
            }
          : {}),
        ...(this.options.pricing
          ? {
              costUsd: (usage) => {
                const pricing = this.options.pricing?.resolve(
                  provider.model ?? 'praxis/provider',
                )
                return pricing ? usageCostUsd(usage, pricing) : undefined
              },
            }
          : {}),
        ...(this.options.maxBudgetUsd === undefined
          ? {}
          : { maxBudgetUsd: this.options.maxBudgetUsd }),
        ...(hookTools
          ? { tools: hookTools, permissions: hookTools }
          : {
              ...(structuredTools ? { tools: structuredTools } : {}),
              ...(turnPermissions ? { permissions: turnPermissions } : {}),
            }),
      })
      let currentTurnUserMessages: string[] | null = null
      let currentTurnToolCalls = 0
      let projectMemoryMaintained = false
      let projectMemoryRecallMessages: ModelMessage[] = []
      const observer = {
        assistantCompleted: async (message: {
          content: string
          thinkingBlocks?: readonly ModelThinkingBlock[]
          toolCalls?: readonly ModelToolCall[]
        }) => {
          const [entry] = translateProviderEvents(
            [
              {
                type: 'assistant-message',
                text: message.content,
                ...(message.thinkingBlocks
                  ? { thinkingBlocks: message.thinkingBlocks }
                  : {}),
                toolCalls: message.toolCalls ?? [],
                providerMessageId: `msg_${randomUUID().replaceAll('-', '')}`,
                model: provider.model ?? 'praxis/provider',
              },
            ],
            this.translationContext(sessionId, snapshot),
          )
          if (!entry) throw new Error('Could not translate assistant response')
          const tail = await this.append(lease, snapshot.tail, entry)
          snapshot = { entries: [...snapshot.entries, entry], tail }

          lastAssistantUuid =
            typeof entry.uuid === 'string' ? entry.uuid : lastAssistantUuid
        },
        toolCompleted: async (
          call: ModelToolCall,
          toolResult: {
            content: string
            contentBlocks?: readonly ModelContentBlock[]
            images?: readonly ModelImage[]
            documents?: readonly ModelDocument[]
            isError: boolean
            accessedPaths?: readonly string[]
            followUpUserMessages?: readonly string[]
            nativeToolUseResult?: Record<string, unknown>
            nativeMcpMeta?: Record<string, unknown>
          },
        ) => {
          currentTurnToolCalls += 1
          const transition = this.worktreeManager?.consumeTransition(call.id)
          if (transition) {
            this.options.contextAssembler?.invalidate?.({
              lifecycleId: sessionId,
              reason: 'worktree',
            })
            const stateEntry: ClaudeTranscriptEntry = {
              type: 'worktree-state',
              worktreeSession: transition.state,
              sessionId,
            }
            const stateTail = await this.append(
              lease,
              snapshot.tail,
              stateEntry,
            )
            snapshot = {
              entries: [...snapshot.entries, stateEntry],
              tail: stateTail,
            }
          }
          const permissionMode =
            this.options.interactiveTools?.consumeTransition(call.id)
          if (permissionMode) {
            const modeEntry: ClaudeTranscriptEntry = {
              type: 'permission-mode',
              permissionMode,
              sessionId,
            }
            const modeTail = await this.append(lease, snapshot.tail, modeEntry)
            snapshot = {
              entries: [...snapshot.entries, modeEntry],
              tail: modeTail,
            }
          }
          const [entry] = translateProviderEvents(
            [
              {
                type: 'tool-result',
                toolCallId: call.id,
                content: toolResult.content,
                ...(toolResult.contentBlocks
                  ? { contentBlocks: toolResult.contentBlocks }
                  : {}),
                ...(toolResult.images ? { images: toolResult.images } : {}),
                ...(toolResult.documents
                  ? { documents: toolResult.documents }
                  : {}),
                isError: toolResult.isError,
                ...(toolResult.nativeToolUseResult
                  ? { nativeToolUseResult: toolResult.nativeToolUseResult }
                  : {}),
                ...(toolResult.nativeMcpMeta
                  ? { nativeMcpMeta: toolResult.nativeMcpMeta }
                  : {}),
              },
            ],
            this.translationContext(sessionId, snapshot),
          )
          if (!entry) throw new Error('Could not translate tool result')
          const tail = await this.append(lease, snapshot.tail, entry)
          snapshot = { entries: [...snapshot.entries, entry], tail }

          if (!toolResult.isError && this.options.projectMemoryDirectory) {
            const pathValue = call.input.file_path
            const path =
              typeof pathValue === 'string'
                ? resolve(this.activeCwd(), pathValue)
                : null
            if (
              path &&
              isPathWithin(this.options.projectMemoryDirectory, path)
            ) {
              if (call.name === 'Read') {
                this.options.projectMemoryRecall?.recordRead(sessionId, path)
              } else if (call.name === 'Write' || call.name === 'Edit') {
                projectMemoryMaintained = true
              }
            }
            if (call.name === 'Read') {
              for (const accessedPath of toolResult.accessedPaths ?? []) {
                const resolvedAccessedPath = resolve(
                  this.activeCwd(),
                  accessedPath,
                )
                if (
                  isPathWithin(
                    this.options.projectMemoryDirectory,
                    resolvedAccessedPath,
                  )
                ) {
                  this.options.projectMemoryRecall?.recordRead(
                    sessionId,
                    resolvedAccessedPath,
                  )
                }
              }
            }
          }

          if (
            toolResult.isError ||
            call.name !== 'Read' ||
            !this.options.conditionalRuleResolver ||
            !toolResult.accessedPaths
          ) {
            return
          }
          const attachedRulePaths = this.attachedRulePaths(snapshot.entries)
          for (const filePath of toolResult.accessedPaths) {
            const rules = await this.options.conditionalRuleResolver.resolve(
              filePath,
              [...attachedRulePaths],
            )
            for (const rule of rules) {
              const attachment = createClaudeRuleAttachmentEntry(
                rule,
                this.displayRulePath(rule.path),
                this.translationContext(sessionId, snapshot),
              )
              const attachmentTail = await this.append(
                lease,
                snapshot.tail,
                attachment,
              )
              snapshot = {
                entries: [...snapshot.entries, attachment],
                tail: attachmentTail,
              }
              attachedRulePaths.add(rule.path)
            }
          }
        },
        followUpUserMessagesCompleted: async (messages: readonly string[]) => {
          for (const content of messages) {
            const [followUpEntry] = translateProviderEvents(
              [{ type: 'user-text-block', text: content }],
              this.translationContext(sessionId, snapshot),
            )
            if (!followUpEntry) {
              throw new Error('Could not translate tool follow-up message')
            }
            const followUpTail = await this.append(
              lease,
              snapshot.tail,
              followUpEntry,
            )
            snapshot = {
              entries: [...snapshot.entries, followUpEntry],
              tail: followUpTail,
            }
            currentTurnUserMessages?.push(content)
          }
        },
      }
      let turnCompleted = false
      try {
        const outcome = await this.hookLifecycle.start(
          sessionId,
          hookSession,
          requireExisting ? 'resume' : 'startup',
          signal,
        )
        if (outcome) {
          await recordHookOutcome(outcome, pendingRecoveryToolCallIds.size > 0)
        }
        const approveRecovery = this.options.approveRecovery
        const recoveryRequest = {
          cwd: this.activeCwd(),
          toolResultDirectory,
          messages: projectClaudeModelMessages(snapshot.entries),
          observer,
          permissionUpdates: this.sessionPermissionUpdates.get(sessionId) ?? [],
          onPermissionUpdates: (updates: readonly PermissionUpdate[]) =>
            this.applyPermissionUpdates(sessionId, updates),
          ...(signal ? { signal } : {}),
          ...(approveRecovery
            ? {
                approveRecovery: async (call: ModelToolCall) => {
                  if (!(await approveRecovery(call))) {
                    throw new Error(
                      `Claude session tool call ${call.id} recovery was declined`,
                    )
                  }
                  if (signal?.aborted) throw new AgentRunCancelledError()
                  await flushRecoveryHookOutcomes()
                  pendingRecoveryToolCallIds.delete(call.id)
                  return true
                },
                approveTool: () => true,
              }
            : {}),
        }
        const unresolvedToolCall = unresolvedToolCalls[0]
        if (unresolvedToolCall && !approveRecovery) {
          throw new Error(
            `Claude session tool call ${unresolvedToolCall.id} requires explicit recovery approval`,
          )
        }
        const recoveryResults = await runtime.recoverToolCalls(
          unresolvedToolCalls,
          recoveryRequest,
        )
        const recoveryUsage = recoveryResults.reduce<ModelUsage>(
          (usage, result) =>
            result.usage ? mergeUsage(usage, result.usage) : usage,
          { inputTokens: 0, outputTokens: 0 },
        )
        const recoveryModelUsage = mergeSessionRawModelUsage(
          ...recoveryResults.map((result) =>
            result.isError ? undefined : result.modelUsage,
          ),
        )
        const foregroundLineChanges = createLineCountAccumulator()
        for (const result of recoveryResults) {
          foregroundLineChanges.add(result)
        }

        if (
          this.options.agent &&
          agent &&
          getClaudeAgentSetting(snapshot.entries) !== this.options.agent
        ) {
          const agentSetting = createClaudeAgentSettingEntry(
            sessionId,
            this.options.agent,
          )
          const settingTail = await this.append(
            lease,
            snapshot.tail,
            agentSetting,
          )
          snapshot = {
            entries: [...snapshot.entries, agentSetting],
            tail: settingTail,
          }
        }

        const sessionMemory = this.sessionMemoryController(sessionId)
        let assembledContext: AssembledContext | undefined
        let agentSystem: string | null = null
        let planModeMessage: string | null | undefined
        let sessionMemoryMessage: string | null = null
        let contextMessages: ModelMessage[] = []
        let stableSystemMessageCount: number | undefined
        const refreshRuntimeContext = async () => {
          agentSystem = await this.mainAgentSystemPrompt(agent)
          planModeMessage =
            this.options.interactiveTools?.contextMessage(sessionId)
          sessionMemoryMessage = sessionMemory
            ? this.sessionMemoryMessage(await sessionMemory.summary())
            : null
          const additionalSections = [
            ...(planModeMessage
              ? [
                  {
                    id: 'plan-mode',
                    placement: 'system' as const,
                    stability: 'volatile' as const,
                    content: planModeMessage,
                  },
                ]
              : []),
            ...(sessionMemoryMessage
              ? [
                  {
                    id: 'session-memory',
                    placement: 'system' as const,
                    stability: 'volatile' as const,
                    content: sessionMemoryMessage,
                  },
                ]
              : []),
            ...(this.options.brief
              ? [
                  {
                    id: 'brief-output',
                    placement: 'system' as const,
                    stability: 'volatile' as const,
                    content: CLAUDE_USER_MESSAGE_PROMPT,
                  },
                ]
              : []),
            ...(this.options.structuredOutputSchema
              ? [
                  {
                    id: 'structured-output',
                    placement: 'system' as const,
                    stability: 'volatile' as const,
                    content:
                      'You MUST call StructuredOutput exactly once at the end with a value matching the requested JSON Schema.',
                  },
                ]
              : []),
          ]
          assembledContext = await this.options.contextAssembler?.assemble({
            cwd: this.activeCwd(),
            lifecycleId: sessionId,
            ...(agentSystem
              ? { mode: 'agent', baseSystemPrompt: agentSystem }
              : {}),
            additionalSections,
          })
          const hasPromptManifest =
            assembledContext?.promptSections !== undefined
          stableSystemMessageCount = hasPromptManifest
            ? assembledContext?.stableSystemSectionCount
            : undefined
          const assembledSystemMessages = hasPromptManifest
            ? (assembledContext?.systemMessages ?? [])
            : this.assembledSystemMessages(
                agent,
                assembledContext?.systemMessages ?? [],
              )
          contextMessages = [
            ...(!hasPromptManifest && agentSystem
              ? [{ role: 'system' as const, content: agentSystem }]
              : []),
            ...assembledSystemMessages,
            ...(!hasPromptManifest && planModeMessage
              ? [{ role: 'system' as const, content: planModeMessage }]
              : []),
            ...(!hasPromptManifest && sessionMemoryMessage
              ? [{ role: 'system' as const, content: sessionMemoryMessage }]
              : []),
            ...(!hasPromptManifest && this.options.brief
              ? [
                  {
                    role: 'system' as const,
                    content: CLAUDE_USER_MESSAGE_PROMPT,
                  },
                ]
              : []),
            ...(!hasPromptManifest && this.options.structuredOutputSchema
              ? [
                  {
                    role: 'system' as const,
                    content:
                      'You MUST call StructuredOutput exactly once at the end with a value matching the requested JSON Schema.',
                  },
                ]
              : []),
          ]
        }
        await refreshRuntimeContext()

        const expansion = skipUserPrompt
          ? { userMessages: [] as string[] }
          : shellCommand === undefined
            ? this.options.extensions
              ? await this.options.extensions.expandPromptAsync(
                  effectivePrompt,
                  signal,
                  toolResultDirectory,
                )
              : { userMessages: [effectivePrompt] }
            : {
                userMessages: [`<bash-input>${shellCommand}</bash-input>`],
              }
        const expandedMessages: readonly ClaudePromptExpansionMessage[] =
          expansion.messages ?? expansion.userMessages.map((text) => ({ text }))
        const attachmentIndex = expansion.messages
          ? expandedMessages.length - 1
          : 0
        currentTurnUserMessages = [...expansion.userMessages]
        this.options.eventSink?.({
          type: 'state',
          state: 'assembling-context',
        })
        let compactionUsage: ModelUsage = {
          inputTokens: 0,
          outputTokens: 0,
        }
        let compactionDurationMs: number | undefined
        let compactionDurationWithoutRetriesMs: number | undefined
        let compactionModelUsage:
          Readonly<Record<string, ModelUsage>> | undefined
        const definitions = provider.capabilities.tools
          ? (structuredTools?.definitions() ?? [])
          : []
        const budget = this.contextBudget(provider)
        const recoveryPlanner = new ContextRecoveryPlanner()
        const pendingUserMessages = expandedMessages.map((message, index) => ({
          role: 'user' as const,
          content: message.text,
          ...(message.contentBlocks?.length
            ? { contentBlocks: message.contentBlocks }
            : {}),
          ...((index === attachmentIndex && images.length > 0) ||
          message.images?.length
            ? {
                images: [
                  ...(index === attachmentIndex ? images : []),
                  ...(message.images ?? []),
                ],
              }
            : {}),
          ...(index === attachmentIndex && documents.length > 0
            ? { documents }
            : {}),
        }))
        const agentMentionMessages =
          shellCommand === undefined && !skipUserPrompt
            ? (this.options.extensions?.agentMentionMessages(effectivePrompt) ??
              [])
            : []
        const injectAgentMentionContext = (
          messages: readonly ModelMessage[],
        ): ModelMessage[] => {
          if (agentMentionMessages.length === 0) return [...messages]
          let insertionIndex = messages.length
          let foundPrompt = false
          for (let index = messages.length - 1; index >= 0; index -= 1) {
            const message = messages[index]
            if (
              message?.role === 'user' &&
              typeof message.content === 'string' &&
              message.content.endsWith(effectivePrompt)
            ) {
              insertionIndex = index
              foundPrompt = true
              break
            }
          }
          if (!foundPrompt) return [...messages]
          return [
            ...messages.slice(0, insertionIndex),
            ...agentMentionMessages.map((content) => ({
              role: 'user' as const,
              content,
            })),
            ...messages.slice(insertionIndex),
          ]
        }
        const injectDynamicContext = (
          messages: readonly ModelMessage[],
        ): ModelMessage[] =>
          injectFirstUserMessageContext(
            messages,
            assembledContext?.firstUserMessageContext,
          )
        const injectTurnContext = (
          messages: readonly ModelMessage[],
        ): ModelMessage[] =>
          injectAgentMentionContext(injectDynamicContext(messages))
        let compactionAnchorUuid = this.lastMessageUuid(snapshot.entries)
        const compactIfNeeded = async (
          pendingMessages: readonly {
            role: 'user'
            content: string
          }[] = [],
          preservedUserMessages: readonly string[] = [],
          options: { promptTooLong?: boolean } = {},
        ) => {
          if (!budget || this.options.autoCompact === false) return
          const historyMessages = [
            ...projectClaudeModelMessages(snapshot.entries),
            ...projectMemoryRecallMessages,
          ]
          const predicted = budget.evaluate(
            [
              ...contextMessages,
              ...injectTurnContext([...historyMessages, ...pendingMessages]),
            ],
            definitions,
            options,
          )
          if (!predicted.shouldCompact) return
          const irreducibleMessages = [
            ...contextMessages,
            ...injectTurnContext([
              ...pendingMessages,
              ...preservedUserMessages.map((content) => ({
                role: 'user' as const,
                content,
              })),
            ]),
          ]
          const irreducible = budget.evaluate(irreducibleMessages, definitions)
          budget.assertFits(irreducible)
          let logicalParentUuid = compactionAnchorUuid
          if (!logicalParentUuid || historyMessages.length === 0) {
            budget.assertFits(predicted)
            throw new Error('Cannot compact an empty Claude transcript')
          }
          if (findUnresolvedClaudeToolCalls(snapshot.entries).length > 0) {
            throw new Error(
              'Cannot compact a Claude session with unresolved tool calls',
            )
          }
          const memorySelection = sessionMemory
            ? await this.selectMemoryPreservedCompact(
                sessionId,
                selectClaudeActiveTranscript(snapshot.entries),
              )
            : null
          const compactorMessages = memorySelection
            ? [
                memorySelection.memoryMessage,
                ...projectClaudeModelMessages(memorySelection.compactedEntries),
              ]
            : historyMessages
          if (memorySelection) {
            logicalParentUuid = memorySelection.logicalParentUuid
          }
          this.options.eventSink?.({ type: 'state', state: 'compacting' })
          const compactEnvelope = budget.evaluate(
            [
              ...irreducibleMessages,
              {
                role: 'user',
                content: formatClaudeCompactSummary(''),
              },
            ],
            definitions,
          )
          let targetTokens = Math.min(
            8192,
            compactEnvelope.availableTokens - compactEnvelope.estimatedTokens,
          )
          if (targetTokens < 1) {
            budget.assertFits(
              budget.evaluate(
                [
                  ...irreducibleMessages,
                  {
                    role: 'user',
                    content: formatClaudeCompactSummary('a'),
                  },
                ],
                definitions,
              ),
            )
            targetTokens = 1
          }
          const compacted = await (
            this.options.compactor ?? new ModelCompactor(provider)
          ).compact({
            messages: compactorMessages,
            targetTokens,
            contextWindowTokens: budget.contextWindowTokens,
            ...(signal ? { signal } : {}),
          })
          const {
            durationMs: compactedDurationMs,
            durationWithoutRetriesMs: compactedDurationWithoutRetriesMs,
          } = requireCompactionDurations(compacted)
          const proposedCompactionDurationMs =
            (compactionDurationMs ?? 0) + compactedDurationMs
          if (!Number.isFinite(proposedCompactionDurationMs)) {
            throw new TypeError('compaction durationMs total overflow')
          }
          const proposedCompactionDurationWithoutRetriesMs =
            (compactionDurationWithoutRetriesMs ?? 0) +
            compactedDurationWithoutRetriesMs
          if (!Number.isFinite(proposedCompactionDurationWithoutRetriesMs)) {
            throw new TypeError(
              'compaction durationWithoutRetriesMs total overflow',
            )
          }
          const boundaryUuid = randomUUID()
          const summaryUuid = randomUUID()
          const timestamp = new Date().toISOString()
          const preTokens = budget.evaluate(
            [...contextMessages, ...injectTurnContext(historyMessages)],
            definitions,
          ).estimatedTokens
          const compactEntries = (postTokens: number) => {
            const uuids = [boundaryUuid, summaryUuid]
            return createClaudeCompactEntries({
              sessionId,
              logicalParentUuid,
              summary: compacted.summary,
              preTokens,
              postTokens,
              previousCumulativeDroppedTokens: getCumulativeDroppedTokens(
                snapshot.entries,
              ),
              durationMs: compactedDurationMs,
              cwd: this.activeCwd(),
              claudeVersion: this.options.claudeVersion,
              gitBranch: null,
              ...(memorySelection
                ? {
                    preservedUuids: memorySelection.preservedEntries.flatMap(
                      (entry) =>
                        typeof entry.uuid === 'string' ? [entry.uuid] : [],
                    ),
                  }
                : {}),
              createUuid: () => uuids.shift() ?? randomUUID(),
              now: () => timestamp,
            })
          }
          const provisionalEntries = compactEntries(0)
          const compactSummaryUuid = provisionalEntries.at(-1)?.uuid
          if (typeof compactSummaryUuid !== 'string') {
            throw new Error('Could not create Claude compact summary')
          }
          const replayUuids = preservedUserMessages.map(() => randomUUID())
          const replayEntries = translateProviderEvents(
            preservedUserMessages.map((text, index) =>
              index === 0
                ? { type: 'user-text' as const, text }
                : { type: 'user-text-block' as const, text },
            ),
            {
              sessionId,
              parentUuid: compactSummaryUuid,
              cwd: this.activeCwd(),
              claudeVersion: this.options.claudeVersion,
              gitBranch: null,
              history: [...snapshot.entries, ...provisionalEntries],
              createUuid: () => replayUuids.shift() ?? randomUUID(),
              now: () => timestamp,
            },
          )
          const compactedHistory = [
            ...projectClaudeModelMessages([
              ...snapshot.entries,
              ...provisionalEntries,
              ...replayEntries,
            ]),
            ...projectMemoryRecallMessages,
          ]
          const afterHistory = budget.evaluate(
            [...contextMessages, ...injectTurnContext(compactedHistory)],
            definitions,
          )
          const afterPending = budget.evaluate(
            [
              ...contextMessages,
              ...injectTurnContext([...compactedHistory, ...pendingMessages]),
            ],
            definitions,
          )
          budget.assertFits(afterPending)
          if (
            options.promptTooLong === true &&
            !contextRecoveryMadeProgress({
              beforeOccupancyTokens: predicted.occupancyTokens,
              afterOccupancyTokens: afterPending.occupancyTokens,
            })
          ) {
            throw new Error(
              'Reactive context compaction made no occupancy progress',
            )
          }
          const entries = [
            ...compactEntries(afterHistory.estimatedTokens),
            ...replayEntries,
          ]
          if (signal?.aborted) throw new AgentRunCancelledError()
          // Construct the exact tracker mutations for this single committed
          // boundary and preflight them against a clone of the live tracker so
          // invalid input or cumulative overflow rejects before the compact
          // boundary is appended rather than after a half-commit.
          const tracker = this.sessionCostTrackers.get(sessionId)
          if (!tracker) {
            throw new Error(
              `Session cost tracker is not active for session ${sessionId}`,
            )
          }
          const compactModel =
            compacted.model !== undefined && compacted.model.trim() !== ''
              ? compacted.model
              : provider.model
          const compactModelNonBlank =
            compactModel !== undefined && compactModel.trim() !== ''
          if (hasNonZeroUsage(compacted.usage) && !compactModelNonBlank) {
            throw new Error(
              'Auto compact usage requires a nonblank model identity',
            )
          }
          let meteringTurnInput: ClaudeSessionTurnInput | undefined
          if (compactModelNonBlank && hasNonZeroUsage(compacted.usage)) {
            const pricing = this.options.pricing?.resolve(compactModel)
            const costUsd = pricing
              ? usageCostUsd(compacted.usage, pricing)
              : undefined
            meteringTurnInput = {
              model: compactModel,
              usage: compacted.usage,
              ...(costUsd === undefined ? {} : { costUsd }),
              ...(compacted.usage.webSearchRequests === undefined
                ? {}
                : { webSearchRequests: compacted.usage.webSearchRequests }),
            }
          }
          let meteringDurationsInput: ClaudeSessionDurationsInput | undefined
          if (
            compactedDurationMs > 0 ||
            compactedDurationWithoutRetriesMs > 0
          ) {
            meteringDurationsInput = {
              ...(compactedDurationMs === 0
                ? {}
                : { apiDurationMs: compactedDurationMs }),
              apiDurationWithoutRetriesMs: compactedDurationWithoutRetriesMs,
            }
          }
          if (
            meteringTurnInput !== undefined ||
            meteringDurationsInput !== undefined
          ) {
            const preflight = new ClaudeSessionCostTracker({
              sessionId,
              restored: tracker.snapshot(),
            })
            if (meteringTurnInput !== undefined) {
              preflight.recordTurn(meteringTurnInput)
            }
            if (meteringDurationsInput !== undefined) {
              preflight.recordDurations(meteringDurationsInput)
            }
          }
          const appendResult = await lease.appendMany(snapshot.tail, entries)
          if (appendResult.status === 'conflict') {
            throw new Error(
              `Claude transcript append conflict: ${appendResult.reason}`,
            )
          }
          snapshot = {
            entries: [...snapshot.entries, ...entries],
            tail: appendResult.tail,
          }
          // The boundary is durable: mirror Claude's full-compact behavior by
          // rerunning SessionStart with source compact and refreshing the
          // runtime-only context so the next request retains current
          // instructions, plan state, session memory, and hook context.
          if (this.options.hooks) {
            const outcome = await this.hookLifecycle.refresh(
              sessionId,
              hookSession,
              signal,
            )
            if (outcome) await recordHookOutcome(outcome)
          }
          this.options.contextAssembler?.invalidate?.({
            lifecycleId: sessionId,
            reason: 'compact',
          })
          this.options.projectMemoryRecall?.recordCompact(sessionId)
          await refreshRuntimeContext()
          this.options.eventSink?.({
            type: 'compact-boundary',
            trigger: 'auto',
            preTokens,
            uuid: boundaryUuid,
          })
          compactionAnchorUuid = compactSummaryUuid
          compactionUsage = mergeUsage(compactionUsage, compacted.usage)
          compactionDurationMs = proposedCompactionDurationMs
          compactionDurationWithoutRetriesMs =
            proposedCompactionDurationWithoutRetriesMs
          if (meteringTurnInput !== undefined) {
            compactionModelUsage = mergeSessionRawModelUsage(
              compactionModelUsage,
              { [meteringTurnInput.model]: compacted.usage },
            )
          }
          // Commit the preflighted mutations once the boundary is durable so a
          // later main-provider failure or cancellation cannot lose the
          // compactor's usage/cost/API durations.
          if (meteringTurnInput !== undefined) {
            tracker.recordTurn(meteringTurnInput)
          }
          if (meteringDurationsInput !== undefined) {
            tracker.recordDurations(meteringDurationsInput)
          }
        }
        await compactIfNeeded(pendingUserMessages)

        for (const [index, message] of expandedMessages.entries()) {
          if (shellCommand !== undefined) break
          const messageImages = [
            ...(index === attachmentIndex ? images : []),
            ...(message.images ?? []),
          ]
          const persistenceEvent =
            messageImages.length > 0 ||
            (index === attachmentIndex && documents.length > 0)
              ? ({
                  type: 'user-message',
                  text: message.text,
                  images: messageImages,
                  ...(index === attachmentIndex && documents.length > 0
                    ? { documents }
                    : {}),
                } as const)
              : index === 0
                ? ({ type: 'user-text', text: message.text } as const)
                : ({ type: 'user-text-block', text: message.text } as const)
          const [userEntry] = translateProviderEvents(
            [persistenceEvent],
            this.translationContext(sessionId, snapshot),
          )
          if (!userEntry) throw new Error('Could not translate user prompt')
          if (currentPromptId === null && typeof userEntry.uuid === 'string') {
            currentPromptId = userEntry.uuid
            compactionAnchorUuid ??= userEntry.uuid
          }
          const userTail = await this.append(lease, snapshot.tail, userEntry)
          snapshot = {
            entries: [...snapshot.entries, userEntry],
            tail: userTail,
          }
        }

        if (fileHistory && currentPromptId) {
          const historySnapshot = await fileHistory.snapshot(
            snapshot.entries,
            currentPromptId,
          )
          const historyTail = await this.append(
            lease,
            snapshot.tail,
            historySnapshot,
          )
          snapshot = {
            entries: [...snapshot.entries, historySnapshot],
            tail: historyTail,
          }
        }

        if (this.options.hooks && !skipUserPrompt) {
          const outcome = await this.options.hooks.run(
            {
              ...hookSession,
              hook_event_name: 'UserPromptSubmit',
              prompt_id: currentPromptId ?? randomUUID(),
              prompt: effectivePrompt,
            },
            undefined,
            signal,
          )
          await recordHookOutcome(outcome)
          if (outcome.blockedReason) {
            throw new Error(
              `UserPromptSubmit hook error: ${outcome.blockedReason}`,
            )
          }
        }
        let shellUsage: ModelUsage = { inputTokens: 0, outputTokens: 0 }
        let shellModelUsage: Readonly<Record<string, ModelUsage>> | undefined
        if (shellCommand !== undefined) {
          const call: ModelToolCall = {
            id: `shell_${randomUUID().replaceAll('-', '')}`,
            name: 'Bash',
            input: { command: shellCommand },
          }
          this.options.eventSink?.({
            type: 'shell-command',
            callId: call.id,
            command: shellCommand,
          })
          let shellResult
          try {
            shellResult = await runtime.executeDirectToolCall(call, {
              cwd: this.activeCwd(),
              toolResultDirectory,
              messages: projectClaudeModelMessages(snapshot.entries),
              observer: {
                assistantCompleted: async () => undefined,
                toolCompleted: async () => undefined,
                followUpUserMessagesCompleted:
                  observer.followUpUserMessagesCompleted,
              },
              ...(this.options.approveTool
                ? { approveTool: this.options.approveTool }
                : {}),
              permissionUpdates:
                this.sessionPermissionUpdates.get(sessionId) ?? [],
              onPermissionUpdates: (updates) =>
                this.applyPermissionUpdates(sessionId, updates),
              ...(signal ? { signal } : {}),
            })
          } catch (error) {
            this.options.eventSink?.({
              type: 'shell-cancelled',
              callId: call.id,
            })
            throw error
          }
          shellUsage = shellResult.usage ?? shellUsage
          if (!shellResult.isError) {
            shellModelUsage = shellResult.modelUsage
            foregroundLineChanges.add(shellResult)
          }
          const stdout =
            shellResult.processOutput?.stdout ??
            (shellResult.isError ? '' : shellResult.content)
          const stderr =
            shellResult.processOutput?.stderr ??
            (shellResult.isError ? shellResult.content : '')
          const shellUuids = [shellInputUuid ?? randomUUID(), randomUUID()]
          const [inputEntry, outputEntry] = translateProviderEvents(
            [
              { type: 'bash-input', command: shellCommand },
              { type: 'bash-output', stdout, stderr },
            ],
            {
              ...this.translationContext(sessionId, snapshot),
              createUuid: () => shellUuids.shift() ?? randomUUID(),
            },
          )
          if (!inputEntry || !outputEntry) {
            throw new Error('Could not translate shell command result')
          }
          const shellAppend = await lease.appendMany(snapshot.tail, [
            inputEntry,
            outputEntry,
          ])
          if (shellAppend.status === 'conflict') {
            throw new Error(
              `Claude transcript append conflict: ${shellAppend.reason}`,
            )
          }
          snapshot = {
            entries: [...snapshot.entries, inputEntry, outputEntry],
            tail: shellAppend.tail,
          }
          currentTurnUserMessages.push(
            `<bash-stdout>${stdout}</bash-stdout><bash-stderr>${stderr}</bash-stderr>`,
          )
          this.options.eventSink?.({
            type: 'shell-result',
            callId: call.id,
            stdout,
            stderr,
            isError: shellResult.isError,
          })
        }
        if (budget) {
          await compactIfNeeded([], currentTurnUserMessages ?? [])
          budget.assertFits(
            budget.evaluate(
              [
                ...contextMessages,
                ...injectTurnContext(
                  projectClaudeModelMessages(snapshot.entries),
                ),
              ],
              definitions,
            ),
          )
        }

        let stopHookActive = false
        const runtimeRequest: AgentRunRequest = {
          messages: [
            ...contextMessages,
            ...injectTurnContext(projectClaudeModelMessages(snapshot.entries)),
          ],
          ...(stableSystemMessageCount === undefined
            ? {}
            : { stableSystemMessageCount }),
          cwd: this.activeCwd(),
          toolResultDirectory,
          observer,
          ...(this.options.effort ? { effort: this.options.effort } : {}),
          ...(this.options.maxModelTurns !== undefined
            ? { maxModelTurns: this.options.maxModelTurns }
            : {}),
          ...(this.options.betas?.length ? { betas: this.options.betas } : {}),
          ...(this.options.collectMetrics || this.options.costStateStore
            ? { collectMetrics: true }
            : {}),
          ...(budget
            ? { deferFailureKinds: ['prompt_too_long'] as const }
            : {}),
          reloadMessages: async () => {
            const recalled = projectMemoryRecallTurn?.consumeIfSettled()
            if (recalled) {
              projectMemoryRecallMessages = [
                { role: 'user', content: recalled.content },
              ]
            }
            await compactIfNeeded([], currentTurnUserMessages ?? [])
            if (stableSystemMessageCount === undefined) {
              delete runtimeRequest.stableSystemMessageCount
            } else {
              runtimeRequest.stableSystemMessageCount = stableSystemMessageCount
            }
            return [
              ...contextMessages,
              ...injectTurnContext([
                ...projectClaudeModelMessages(snapshot.entries),
                ...projectMemoryRecallMessages,
              ]),
            ]
          },
          ...(this.options.hooks ||
          subagentExecutor ||
          taskTools ||
          this.scheduledPrompts ||
          this.workflowManager
            ? {
                onStop: async (text: string) => {
                  const messages: string[] = []
                  const outcome = await this.options.hooks?.run(
                    {
                      ...hookSession,
                      hook_event_name: 'Stop',
                      stop_hook_active: stopHookActive,
                      last_assistant_message: text,
                    },
                    undefined,
                    signal,
                  )
                  if (outcome) {
                    await recordHookOutcome(outcome)
                    if (outcome.blockedReason) {
                      stopHookActive = true
                      messages.push(`Stop hook error: ${outcome.blockedReason}`)
                    }
                  }
                  const background = await subagentExecutor?.notifications(true)
                  if (background) messages.push(...background.messages)
                  const workflow =
                    await this.workflowManager?.notifications(true)
                  if (workflow) messages.push(...workflow.messages)
                  const bashMessages = await taskTools?.notifications(true)
                  if (bashMessages) messages.push(...bashMessages)
                  const scheduled = await this.scheduledPrompts?.drainDue()
                  if (scheduled) {
                    messages.push(...scheduled.map(({ prompt }) => prompt))
                  }
                  const batchUsage =
                    background || workflow
                      ? mergeUsage(
                          background?.usage ?? {
                            inputTokens: 0,
                            outputTokens: 0,
                          },
                          workflow?.usage ?? {
                            inputTokens: 0,
                            outputTokens: 0,
                          },
                        )
                      : undefined
                  const batchModelUsage = mergeSessionRawModelUsage(
                    background?.modelUsage,
                    workflow?.modelUsage,
                  )
                  const batchDurationApiMs = addApiDuration(
                    workflow?.durationApiMs,
                    addApiDuration(
                      background?.durationApiMs,
                      0,
                      'durationApiMs',
                    ),
                    'durationApiMs',
                  )
                  const backgroundDurationWithoutRetries =
                    background?.durationApiWithoutRetriesMs ??
                    background?.durationApiMs
                  const workflowDurationWithoutRetries =
                    workflow?.durationApiWithoutRetriesMs ??
                    workflow?.durationApiMs
                  const batchDurationApiWithoutRetriesMs = addApiDuration(
                    workflowDurationWithoutRetries,
                    addApiDuration(
                      backgroundDurationWithoutRetries,
                      0,
                      'durationApiWithoutRetriesMs',
                    ),
                    'durationApiWithoutRetriesMs',
                  )
                  const hasBatchDuration =
                    background?.durationApiMs !== undefined ||
                    background?.durationApiWithoutRetriesMs !== undefined ||
                    workflow?.durationApiMs !== undefined ||
                    workflow?.durationApiWithoutRetriesMs !== undefined
                  return {
                    messages,
                    ...(batchUsage
                      ? {
                          usage: batchUsage,
                          ...(batchModelUsage
                            ? { modelUsage: batchModelUsage }
                            : {}),
                        }
                      : {}),
                    ...(hasBatchDuration
                      ? {
                          durationApiMs: batchDurationApiMs,
                          durationApiWithoutRetriesMs:
                            batchDurationApiWithoutRetriesMs,
                        }
                      : {}),
                  }
                },
              }
            : {}),
          ...(this.options.approveTool
            ? { approveTool: this.options.approveTool }
            : {}),
          permissionUpdates: this.sessionPermissionUpdates.get(sessionId) ?? [],
          onPermissionUpdates: (updates: readonly PermissionUpdate[]) =>
            this.applyPermissionUpdates(sessionId, updates),
        }
        const attemptMainTurn = () =>
          signal
            ? runtime.run({ ...runtimeRequest, signal })
            : runtime.run(runtimeRequest)
        const surfaceExhaustedRecovery = (error: ModelProviderError) => {
          this.options.eventSink?.({
            type: 'failed',
            message: error.message,
            retryable: false,
          })
        }
        let result: AgentRunResult
        try {
          result = await attemptMainTurn()
        } catch (error) {
          if (!budget || !isPromptTooLongError(error)) throw error
          if (recoveryPlanner.reactiveRetriesRemaining === 0) {
            surfaceExhaustedRecovery(error)
            throw error
          }
          const beforeRecovery = budget.evaluate(
            runtimeRequest.messages,
            definitions,
          )
          try {
            await compactIfNeeded([], currentTurnUserMessages ?? [], {
              promptTooLong: true,
            })
          } catch (compactionError) {
            if (
              signal?.aborted ||
              compactionError instanceof AgentRunCancelledError
            ) {
              throw new AgentRunCancelledError()
            }
            // Compaction could not free the provider-bounded context; surface
            // the original prompt-too-long error rather than the compaction
            // failure.
            surfaceExhaustedRecovery(error)
            throw error
          }
          // The single reactive retry must use the compacted transcript, not
          // the stale request copy captured before the compact boundary.
          runtimeRequest.messages = [
            ...contextMessages,
            ...injectTurnContext([
              ...projectClaudeModelMessages(snapshot.entries),
              ...projectMemoryRecallMessages,
            ]),
          ]
          if (stableSystemMessageCount === undefined) {
            delete runtimeRequest.stableSystemMessageCount
          } else {
            runtimeRequest.stableSystemMessageCount = stableSystemMessageCount
          }
          const afterRecovery = budget.evaluate(
            runtimeRequest.messages,
            definitions,
          )
          if (
            recoveryPlanner.consumeReactiveRetry({
              beforeOccupancyTokens: beforeRecovery.occupancyTokens,
              afterOccupancyTokens: afterRecovery.occupancyTokens,
            }) !== 'reactive-retry'
          ) {
            surfaceExhaustedRecovery(error)
            throw error
          }
          runtimeRequest.deferFailureKinds = true
          try {
            result = await attemptMainTurn()
          } catch (retryError) {
            // Exactly one reactive retry is consumed; fail deterministically
            // and surface the original prompt-too-long error.
            recoveryPlanner.recordFailure()
            if (
              signal?.aborted ||
              retryError instanceof AgentRunCancelledError
            ) {
              throw new AgentRunCancelledError()
            }
            surfaceExhaustedRecovery(error)
            throw error
          }
        }
        recoveryPlanner.recordSuccess()
        const mainModel =
          provider.model !== undefined && provider.model.trim() !== ''
            ? provider.model
            : undefined
        const observedUsage =
          (mainModel !== undefined
            ? result.modelUsage?.[mainModel]
            : undefined) ??
          Object.values(result.modelUsage ?? {})[0] ??
          result.usage
        budget?.observeUsage(
          observedUsage,
          runtimeRequest.messages,
          definitions,
        )

        if (structuredCapture && structuredCapture.calls !== 1) {
          throw new Error(
            `StructuredOutput must be called exactly once (received ${structuredCapture.calls})`,
          )
        }

        const finalLeafUuid = lastAssistantUuid
        if (!finalLeafUuid) {
          throw new Error('Could not locate final assistant response')
        }
        if (!skipUserPrompt) {
          await this.append(
            lease,
            snapshot.tail,
            createClaudeLastPromptEntry({
              sessionId,
              lastPrompt: effectivePrompt,
              leafUuid: finalLeafUuid,
            }),
          )
        }
        const totalUsage = mergeUsage(
          mergeUsage(mergeUsage(recoveryUsage, compactionUsage), shellUsage),
          result.usage,
        )
        const tracker = this.sessionCostTrackers.get(sessionId)
        if (!tracker) {
          throw new Error(
            `Session cost tracker is not active for session ${sessionId}`,
          )
        }
        const turnModelUsage = mergeSessionRawModelUsage(
          recoveryModelUsage,
          compactionModelUsage,
          shellModelUsage,
          result.modelUsage,
        )
        const combinedDurationMs =
          compactionDurationMs === undefined &&
          result.durationApiMs === undefined
            ? undefined
            : (compactionDurationMs ?? 0) + (result.durationApiMs ?? 0)
        let rawCostUsd: number | undefined
        if (turnModelUsage) {
          for (const [model, usage] of Object.entries(turnModelUsage)) {
            const pricing = this.options.pricing?.resolve(model)
            const costUsd = pricing ? usageCostUsd(usage, pricing) : undefined
            if (costUsd !== undefined) rawCostUsd = (rawCostUsd ?? 0) + costUsd
          }
        }
        // Auto-compaction metering was already recorded atomically with each
        // committed boundary, and externally metered tool-summary metrics were
        // committed through the summary callback, so the live tracker receives
        // only the unrecorded subset here. The inclusive public aggregates
        // above still contain every row and duration.
        const trackedModelUsage = mergeSessionRawModelUsage(
          recoveryModelUsage,
          shellModelUsage,
          result.unrecordedModelUsage ?? result.modelUsage,
        )
        if (trackedModelUsage) {
          for (const [model, usage] of Object.entries(trackedModelUsage)) {
            const pricing = this.options.pricing?.resolve(model)
            const costUsd = pricing ? usageCostUsd(usage, pricing) : undefined
            tracker.recordTurn({
              model,
              usage,
              ...(costUsd === undefined ? {} : { costUsd }),
              ...(usage.webSearchRequests === undefined
                ? {}
                : { webSearchRequests: usage.webSearchRequests }),
            })
          }
        }
        let combinedToolDurationMs = 0
        for (const recoveryResult of recoveryResults) {
          combinedToolDurationMs = addToolDuration(
            recoveryResult.durationToolMs,
            combinedToolDurationMs,
          )
        }
        combinedToolDurationMs = addToolDuration(
          result.durationToolMs,
          combinedToolDurationMs,
        )
        const trackedDurationApiMs =
          result.unrecordedDurationApiMs ?? result.durationApiMs
        const trackedDurationApiWithoutRetriesMs =
          result.unrecordedDurationApiWithoutRetriesMs ??
          result.durationApiWithoutRetriesMs
        tracker.recordDurations({
          ...(trackedDurationApiMs === undefined
            ? {}
            : { apiDurationMs: trackedDurationApiMs }),
          ...(trackedDurationApiWithoutRetriesMs === undefined
            ? {}
            : {
                apiDurationWithoutRetriesMs: trackedDurationApiWithoutRetriesMs,
              }),
          ...(combinedToolDurationMs === 0
            ? {}
            : { toolDurationMs: combinedToolDurationMs }),
        })
        foregroundLineChanges.add({
          isError: false,
          ...(result.linesAdded === undefined
            ? {}
            : { linesAdded: result.linesAdded }),
          ...(result.linesRemoved === undefined
            ? {}
            : { linesRemoved: result.linesRemoved }),
        })
        if (
          foregroundLineChanges.linesAdded !== 0 ||
          foregroundLineChanges.linesRemoved !== 0
        ) {
          tracker.recordLineChanges({
            ...(foregroundLineChanges.linesAdded === 0
              ? {}
              : { linesAdded: foregroundLineChanges.linesAdded }),
            ...(foregroundLineChanges.linesRemoved === 0
              ? {}
              : { linesRemoved: foregroundLineChanges.linesRemoved }),
          })
        }
        if (sessionMemory && finalLeafUuid) {
          const memorySnapshot = projectClaudeModelMessages(snapshot.entries)
          const providerVisibleMessages = [
            ...contextMessages,
            ...injectTurnContext(memorySnapshot),
          ]
          const currentContextTokens = budget
            ? budget.evaluate(providerVisibleMessages, definitions)
                .occupancyTokens
            : estimateModelRequestTokens(providerVisibleMessages, definitions)
          try {
            await sessionMemory.observeContext(
              currentContextTokens,
              currentTurnToolCalls,
              finalLeafUuid,
              memorySnapshot,
            )
          } catch (error) {
            // A failed observation must not fail the user turn; the sidecar
            // retains a retryable error for the next observation.
            this.options.eventSink?.({
              type: 'warning',
              message: `Session memory observation failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            })
          }
        }
        this.options.projectMemoryExtraction?.observe({
          sessionId,
          directMaintenance: projectMemoryMaintained,
          messages: projectMemoryMessages(snapshot.entries),
        })
        turnCompleted = true
        return {
          sessionId,
          text:
            structuredCapture && structuredCapture.calls === 1
              ? JSON.stringify(structuredCapture.value)
              : result.text,
          usage: totalUsage,
          ...(combinedDurationMs === undefined
            ? {}
            : { durationApiMs: combinedDurationMs }),
          ...(rawCostUsd === undefined ? {} : { costUsd: rawCostUsd }),
          ...(turnModelUsage ? { modelUsage: { ...turnModelUsage } } : {}),
          ...(structuredCapture && structuredCapture.calls === 1
            ? { structuredOutput: structuredCapture.value }
            : {}),
        }
      } finally {
        if (!turnCompleted) {
          await this.hookLifecycle.end(sessionId, 'other')
        }
      }
    })
    if (leaseResult.status === 'conflict') {
      throw new Error(
        `Claude transcript append conflict: ${leaseResult.reason}`,
      )
    }
    return leaseResult.value
  }

  private async ensureFileResources(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const resources = this.options.fileResources ?? []
    if (
      resources.length === 0 ||
      this.downloadedFileResourceSessions.has(sessionId)
    ) {
      return
    }
    const config = this.options.fileResourceConfig
    if (!config) {
      throw new Error(
        '--file requires PRAXIS_FILES_BEARER_TOKEN, PRAXIS_FILES_API_KEY, or PRAXIS_API_KEY',
      )
    }
    const downloads = await downloadClaudeFileResources(resources, {
      ...config,
      sessionId,
      ...(signal ? { signal } : {}),
    })
    this.downloadedFileResourceSessions.add(sessionId)
    for (const download of downloads) {
      if (download.success) continue
      this.options.eventSink?.({
        type: 'warning',
        message: `File ${download.fileId} failed to download: ${download.error ?? 'unknown error'}`,
      })
    }
  }

  private translationContext(sessionId: string, snapshot: TranscriptSnapshot) {
    return {
      sessionId,
      parentUuid: this.logicalTailUuid(snapshot.tail),
      cwd: this.activeCwd(),
      claudeVersion: this.options.claudeVersion,
      gitBranch: null,
      ...(this.options.sessionKind === undefined
        ? {}
        : { sessionKind: this.options.sessionKind }),
      history: snapshot.entries,
    }
  }

  private attachedRulePaths(
    entries: readonly ClaudeTranscriptEntry[],
  ): Set<string> {
    const paths = new Set<string>()
    for (const entry of entries) {
      if (entry.type !== 'attachment') continue
      const attachment = entry.attachment
      if (
        typeof attachment !== 'object' ||
        attachment === null ||
        Array.isArray(attachment)
      ) {
        continue
      }
      const path = (attachment as Record<string, unknown>).path
      if (typeof path === 'string') paths.add(path)
    }
    return paths
  }

  private sessionNameEntries(
    sessionId: string,
    name: string,
  ): ClaudeTranscriptEntry[] {
    return [
      { type: 'custom-title', customTitle: name, sessionId },
      { type: 'agent-name', agentName: name, sessionId },
    ]
  }

  private hasSessionName(
    entries: readonly ClaudeTranscriptEntry[],
    name: string,
  ): boolean {
    return this.sessionName(entries) === name
  }

  private sessionName(
    entries: readonly ClaudeTranscriptEntry[],
  ): string | null {
    let customTitle: unknown
    let agentName: unknown
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index]
      if (customTitle === undefined && entry?.type === 'custom-title') {
        customTitle = entry.customTitle
      }
      if (agentName === undefined && entry?.type === 'agent-name') {
        agentName = entry.agentName
      }
      if (customTitle !== undefined && agentName !== undefined) break
    }
    if (typeof customTitle === 'string' && customTitle === agentName) {
      return customTitle
    }
    if (typeof customTitle === 'string') return customTitle
    if (typeof agentName === 'string') return agentName
    return null
  }

  /** Conservative selective-preservation seam for full compact: when the
   *  durable session memory watermark matches an active entry, summarize the
   *  last good memory artifact plus the post-watermark branch and retain a
   *  recent suffix. Returns null to fall back to the existing full-compaction
   *  behavior (missing/invalid watermark, empty projection, or oversized
   *  projection). */
  private async selectMemoryPreservedCompact(
    sessionId: string,
    activeEntries: readonly ClaudeTranscriptEntry[],
  ): Promise<MemoryPreservedCompactSelection | null> {
    const controller = this.sessionMemoryController(sessionId)
    if (controller === null) return null
    await controller.waitForCompact()
    let watermark: string | null = null
    let memorySummary = ''
    try {
      const [state, summary] = await Promise.all([
        controller.state(),
        controller.summary(),
      ])
      watermark = state.lastSummarizedMessageId
      memorySummary = summary
    } catch {
      return null
    }
    if (watermark === null || watermark.length === 0) return null
    if (memorySummary.trim().length === 0) return null
    const watermarkIndex = activeEntries.findIndex(
      (entry) => entry.uuid === watermark,
    )
    if (watermarkIndex < 0) return null

    const suffixStart = memoryPreservedSuffixStart(activeEntries)
    if (suffixStart <= 0 || suffixStart <= watermarkIndex + 1) return null

    const compactedEntries = activeEntries.slice(
      watermarkIndex + 1,
      suffixStart,
    )
    const preservedEntries = activeEntries.slice(suffixStart)
    const preservedMessages = projectClaudeModelMessages(preservedEntries)
    if (projectClaudeModelMessages(compactedEntries).length === 0) return null

    const memoryMessage: ModelMessage = { role: 'user', content: memorySummary }
    if (
      estimateModelRequestTokens([
        {
          role: 'user',
          content: formatClaudeCompactSummary(''),
        },
        ...preservedMessages,
      ]) +
        MEMORY_COMPACT_MAX_SUMMARY_TOKENS >
      MEMORY_COMPACT_MAX_PROJECTION_TOKENS
    ) {
      return null
    }

    const logicalParentUuid = this.lastMessageUuid(
      activeEntries.slice(0, suffixStart),
    )
    if (logicalParentUuid === null) return null
    return {
      compactedEntries,
      preservedEntries,
      memoryMessage,
      logicalParentUuid,
    }
  }

  private lastMessageUuid(
    entries: readonly ClaudeTranscriptEntry[],
  ): string | null {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index]
      if (
        entry &&
        typeof entry.uuid === 'string' &&
        typeof entry.message === 'object' &&
        entry.message !== null &&
        !Array.isArray(entry.message)
      ) {
        return entry.uuid
      }
    }
    return null
  }

  private promptIdForToolCall(
    entries: readonly ClaudeTranscriptEntry[],
    callId: string,
  ): string | null {
    const byUuid = new Map<string, ClaudeTranscriptEntry>()
    let source: ClaudeTranscriptEntry | undefined
    for (const entry of entries) {
      if (typeof entry.uuid === 'string') byUuid.set(entry.uuid, entry)
      if (
        entry.type !== 'assistant' ||
        typeof entry.message !== 'object' ||
        entry.message === null ||
        Array.isArray(entry.message)
      ) {
        continue
      }
      const message = entry.message as unknown
      if (
        typeof message !== 'object' ||
        message === null ||
        !Array.isArray((message as Record<string, unknown>).content)
      ) {
        continue
      }
      const content = (message as Record<string, unknown>).content as unknown[]
      if (
        content.some(
          (block) =>
            typeof block === 'object' &&
            block !== null &&
            (block as Record<string, unknown>).type === 'tool_use' &&
            (block as Record<string, unknown>).id === callId,
        )
      ) {
        source = entry
      }
    }
    let candidate = source
    while (candidate) {
      if (
        candidate.type === 'user' &&
        typeof candidate.promptId === 'string' &&
        (candidate.promptSource === 'interactive' ||
          candidate.promptSource === 'sdk')
      ) {
        return candidate.promptId
      }
      candidate =
        typeof candidate.parentUuid === 'string'
          ? byUuid.get(candidate.parentUuid)
          : undefined
    }
    return null
  }

  private assistantIdForToolCall(
    entries: readonly ClaudeTranscriptEntry[],
    callId: string,
  ): string | null {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index]
      if (
        entry?.type !== 'assistant' ||
        typeof entry.uuid !== 'string' ||
        typeof entry.message !== 'object' ||
        entry.message === null ||
        !Array.isArray((entry.message as Record<string, unknown>).content)
      ) {
        continue
      }
      if (
        ((entry.message as Record<string, unknown>).content as unknown[]).some(
          (block) =>
            typeof block === 'object' &&
            block !== null &&
            (block as Record<string, unknown>).type === 'tool_use' &&
            (block as Record<string, unknown>).id === callId,
        )
      ) {
        return entry.uuid
      }
    }
    return null
  }

  private displayRulePath(rulePath: string): string {
    const pathFromCwd = relative(this.activeCwd(), rulePath)
    return pathFromCwd.startsWith('..') || isAbsolute(pathFromCwd)
      ? rulePath
      : pathFromCwd
  }

  private activeCwd(): string {
    return this.options.workspace?.cwd() ?? this.runtimeCwd
  }

  private restoreWorktree(entries: readonly ClaudeTranscriptEntry[]): void {
    const latest = [...entries]
      .reverse()
      .find((entry) => entry.type === 'worktree-state')
    if (!latest || !this.worktreeManager) return
    const state = latest.worktreeSession
    if (!state || typeof state !== 'object' || Array.isArray(state)) return
    this.worktreeManager.restore(state as WorktreeSessionState)
  }

  private paths(sessionId: string) {
    const exact = this.pathsForCwd(
      sessionId,
      this.sessionCwds.get(sessionId) ?? this.activeCwd(),
    )
    if (this.options.dataPlane === 'native') return exact
    const discovered = this.discoveredProjectRoots.get(sessionId)
    if (discovered === undefined) return exact
    return {
      ...exact,
      projectRoot: discovered,
      sessionFile: resolve(discovered, `${sessionId}.jsonl`),
    }
  }

  private async discoverProjectRoot(sessionId: string): Promise<void> {
    if (this.options.dataPlane === 'native') return
    if (this.discoveredProjectRoots.has(sessionId)) return
    const discovered = await discoverClaudeProjectRoot({
      configRoot: this.options.configRoot,
      cwd: this.sessionCwds.get(sessionId) ?? this.activeCwd(),
      sessionId,
    })
    if (discovered !== undefined) {
      this.discoveredProjectRoots.set(sessionId, discovered)
    }
  }

  private pathsForCwd(sessionId: string, cwd: string) {
    if (this.options.dataPlane === 'native') {
      return resolveDataPlanePaths({
        dataPlane: 'native',
        root: this.options.configRoot,
        cwd,
        sessionId,
      })
    }
    return resolveClaudePaths({
      configDir: this.options.configRoot,
      cwd,
      sessionId,
    })
  }

  private async appendCdCommand(sessionId: string, cwd: string): Promise<void> {
    const result = await this.store(sessionId).withLease(async (lease) => {
      const snapshot = await lease.load()
      if (snapshot.entries.length === 0) {
        throw new Error(`Claude session not found: ${sessionId}`)
      }
      const appendResult = await lease.appendMany(
        snapshot.tail,
        this.cdCommandEntries(
          sessionId,
          cwd,
          this.logicalTailUuid(snapshot.tail),
        ),
      )
      if (appendResult.status === 'conflict') {
        throw new Error(
          `Claude local command append conflict: ${appendResult.reason}`,
        )
      }
    })
    if (result.status === 'conflict') {
      throw new Error(`Claude local command conflict: ${result.reason}`)
    }
  }

  private async appendAgentColorUsage(
    sessionId: string,
    display: string,
    output: string,
    agentColor: AgentColorValue | undefined,
  ): Promise<void> {
    const args = display.replace(/^\/color\s*/u, '').trim()
    while (true) {
      const result = await this.turnStore(sessionId).withLease(
        async (lease) => {
          const snapshot = await lease.load()
          if (snapshot.entries.length === 0) {
            throw new Error(`Claude session not found: ${sessionId}`)
          }
          const appended = await lease.appendMany(snapshot.tail, [
            ...(agentColor === undefined
              ? []
              : [
                  {
                    type: 'agent-color',
                    agentColor,
                    sessionId,
                  } as const,
                ]),
            ...this.localCommandEntries(
              sessionId,
              this.activeCwd(),
              this.logicalTailUuid(snapshot.tail),
              'color',
              args,
              output,
            ),
          ])
          if (appended.status === 'conflict') {
            throw new Error(
              `Claude color local command append conflict: ${appended.reason}`,
            )
          }
        },
      )
      if (result.status === 'completed') return
      await new Promise<void>((resolve) => setTimeout(resolve, 25))
    }
  }

  private async appendSystemLocalCommand(
    sessionId: string,
    command: string,
    args: string,
    output: string,
  ): Promise<void> {
    while (true) {
      const result = await this.turnStore(sessionId).withLease(
        async (lease) => {
          const snapshot = await lease.load()
          if (snapshot.entries.length === 0) {
            throw new Error(`Claude session not found: ${sessionId}`)
          }
          const appendResult = await lease.appendMany(
            snapshot.tail,
            this.localCommandEntries(
              sessionId,
              this.activeCwd(),
              this.logicalTailUuid(snapshot.tail),
              command,
              args,
              output,
            ),
          )
          if (appendResult.status === 'conflict') {
            throw new Error(
              `Claude local command append conflict: ${appendResult.reason}`,
            )
          }
        },
      )
      if (result.status === 'completed') return
      await new Promise<void>((resolve) => setTimeout(resolve, 25))
    }
  }

  private async ensureLocalSession(
    sessionId: string | undefined,
    permissionMode: ClaudePermissionMode,
    agentColor?: AgentColorValue,
    createExplicit = false,
  ): Promise<string> {
    if (sessionId !== undefined && !createExplicit) return sessionId
    this.assertWritable()
    const createdSessionId = sessionId ?? randomUUID()
    const store = this.turnStore(createdSessionId)
    const created = await store.create([
      ...(agentColor === undefined
        ? []
        : [
            {
              type: 'agent-color',
              agentColor,
              sessionId: createdSessionId,
            } as const,
          ]),
      { type: 'mode', mode: 'normal', sessionId: createdSessionId },
      {
        type: 'permission-mode',
        permissionMode,
        sessionId: createdSessionId,
      },
    ])
    if (created.status === 'conflict') {
      throw new Error(`Session ID ${createdSessionId} is already in use`)
    }
    this.sessionCwds.set(createdSessionId, this.activeCwd())
    this.options.interactiveTools?.restore(createdSessionId, [
      { type: 'mode', mode: 'normal', sessionId: createdSessionId },
      {
        type: 'permission-mode',
        permissionMode,
        sessionId: createdSessionId,
      },
    ])
    return createdSessionId
  }

  private async appendInputHistory(
    display: string,
    sessionId: string,
  ): Promise<void> {
    await mkdir(this.options.configRoot, { recursive: true })
    await appendFile(
      join(this.options.configRoot, 'history.jsonl'),
      `${JSON.stringify({
        display,
        pastedContents: {},
        timestamp: Date.now(),
        project: this.activeCwd(),
        sessionId,
      })}\n`,
      'utf8',
    )
  }

  private async appendPermissionGrant(
    sessionId: string,
    display: string,
    retry: boolean,
  ): Promise<void> {
    this.assertWritable()
    const normalized = display.trim()
    if (!normalized) throw new Error('Permission action must not be empty')
    while (true) {
      const result = await this.turnStore(sessionId).withLease(
        async (lease) => {
          const snapshot = await lease.load()
          if (snapshot.entries.length === 0) {
            throw new Error(`Claude session not found: ${sessionId}`)
          }
          const timestamp = new Date().toISOString()
          const promptId = randomUUID()
          const commandUuid = randomUUID()
          const common = {
            isSidechain: false,
            promptId,
            timestamp,
            userType: 'external',
            entrypoint: 'cli',
            cwd: this.activeCwd(),
            sessionId,
            version: this.options.claudeVersion,
            gitBranch: null,
          }
          let parentUuid = this.logicalTailUuid(snapshot.tail)
          const entries: ClaudeTranscriptEntry[] = []
          if (
            this.options.fileCheckpointing &&
            this.options.sessionPersistence !== false
          ) {
            const fileHistory = new ClaudeFileHistory(
              this.options.configRoot,
              sessionId,
              [this.activeCwd(), ...(this.options.fileRewindRoots ?? [])],
            )
            entries.push(
              await fileHistory.snapshot(snapshot.entries, commandUuid),
            )
          }
          if (retry) {
            const retryUuid = randomUUID()
            entries.push({
              parentUuid,
              isSidechain: false,
              type: 'system',
              subtype: 'permission_retry',
              content: `Allowed ${normalized}`,
              commands: [normalized],
              level: 'info',
              isMeta: false,
              timestamp,
              uuid: retryUuid,
              userType: 'external',
              entrypoint: 'cli',
              cwd: this.activeCwd(),
              sessionId,
              version: this.options.claudeVersion,
              gitBranch: null,
            })
            parentUuid = retryUuid
          } else {
            const caveatUuid = randomUUID()
            entries.push({
              ...common,
              parentUuid,
              type: 'user',
              message: {
                role: 'user',
                content:
                  '<local-command-caveat>Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages or otherwise consider them in your response unless the user explicitly asks you to.</local-command-caveat>',
              },
              isMeta: true,
              uuid: caveatUuid,
            })
            parentUuid = caveatUuid
          }
          entries.push({
            ...common,
            parentUuid,
            type: 'user',
            message: {
              role: 'user',
              content:
                '<command-name>/permissions</command-name>\n            <command-message>permissions</command-message>\n            <command-args></command-args>',
            },
            uuid: commandUuid,
          })
          const outputUuid = randomUUID()
          entries.push({
            ...common,
            parentUuid: commandUuid,
            type: 'user',
            message: {
              role: 'user',
              content: `<local-command-stdout>${retry ? '(no content)' : `Approved ${normalized}`}</local-command-stdout>`,
            },
            uuid: outputUuid,
          })
          entries.push({
            ...common,
            parentUuid: outputUuid,
            type: 'user',
            message: {
              role: 'user',
              content: `Permission granted for: ${normalized}. You may now retry this command if you would like.`,
            },
            isMeta: true,
            uuid: randomUUID(),
          })
          const appended = await lease.appendMany(snapshot.tail, entries)
          if (appended.status === 'conflict') {
            throw new Error(
              `Claude permission grant append conflict: ${appended.reason}`,
            )
          }
        },
      )
      if (result.status === 'completed') return
      await new Promise<void>((resolve) => setTimeout(resolve, 25))
    }
  }

  private async appendBackgroundNotification(
    sessionId: string,
    content: string,
  ): Promise<void> {
    while (true) {
      const result = await this.turnStore(sessionId).withLease(
        async (lease) => {
          const snapshot = await lease.load()
          if (snapshot.entries.length === 0) {
            throw new Error(`Claude session not found: ${sessionId}`)
          }
          const timestamp = new Date().toISOString()
          const entries: ClaudeTranscriptEntry[] = [
            {
              type: 'queue-operation',
              operation: 'enqueue',
              timestamp,
              sessionId,
              content,
            },
            {
              type: 'queue-operation',
              operation: 'dequeue',
              timestamp,
              sessionId,
            },
            {
              parentUuid: this.logicalTailUuid(snapshot.tail),
              isSidechain: false,
              promptId: randomUUID(),
              type: 'user',
              message: { role: 'user', content },
              uuid: randomUUID(),
              timestamp,
              permissionMode: 'default',
              origin: { kind: 'task-notification' },
              promptSource: 'system',
              userType: 'external',
              entrypoint: 'cli',
              cwd: this.activeCwd(),
              sessionId,
              version: this.options.claudeVersion,
              gitBranch: null,
            },
          ]
          const appended = await lease.appendMany(snapshot.tail, entries)
          if (appended.status === 'conflict') {
            throw new Error(
              `Claude background notification append conflict: ${appended.reason}`,
            )
          }
        },
      )
      if (result.status === 'completed') return
      await new Promise<void>((resolve) => setTimeout(resolve, 25))
    }
  }

  private enqueueBackgroundNotifications(
    sessionId: string,
    messages: readonly string[],
  ): Promise<void> {
    const previous = this.backgroundNotificationWrites.get(sessionId)
    const queued = (previous ?? Promise.resolve()).then(async () => {
      for (const message of messages) {
        await this.appendBackgroundNotification(sessionId, message)
      }
    })
    this.backgroundNotificationWrites.set(sessionId, queued)
    const cleanup = () => {
      if (this.backgroundNotificationWrites.get(sessionId) === queued)
        this.backgroundNotificationWrites.delete(sessionId)
    }
    void queued.then(cleanup, cleanup)
    return queued
  }

  private cdCommandEntries(
    sessionId: string,
    cwd: string,
    parentUuid: string | null,
  ): ClaudeTranscriptEntry[] {
    const timestamp = new Date().toISOString()
    const common = {
      isSidechain: false,
      timestamp,
      userType: 'external',
      entrypoint: 'cli',
      cwd,
      sessionId,
      version: this.options.claudeVersion,
      gitBranch: null,
    }
    const localCommands = this.localCommandEntries(
      sessionId,
      cwd,
      parentUuid,
      'cd',
      cwd,
      `Moved to ${cwd}`,
      timestamp,
    )
    const secondUuid = localCommands[1]?.uuid
    if (typeof secondUuid !== 'string') {
      throw new Error('Claude cd local command pair is incomplete')
    }
    return [
      ...localCommands,
      {
        ...common,
        parentUuid: secondUuid,
        promptId: randomUUID(),
        type: 'user',
        message: {
          role: 'user',
          content: `<system-reminder>\nThe session's working directory has changed to ${cwd} (via /cd). The environment block at the start of this conversation still names the previous directory — that information is stale. All tool calls and relative paths now resolve from ${cwd}.\n</system-reminder>`,
        },
        isMeta: true,
        uuid: randomUUID(),
      },
    ]
  }

  private localCommandEntries(
    sessionId: string,
    cwd: string,
    parentUuid: string | null,
    command: string,
    args: string,
    output: string,
    timestamp: string = new Date().toISOString(),
  ): ClaudeTranscriptEntry[] {
    const firstUuid = randomUUID()
    return [
      {
        parentUuid,
        isSidechain: false,
        type: 'system',
        subtype: 'local_command',
        content: `<command-name>/${command}</command-name>\n            <command-message>${command}</command-message>\n            <command-args>${args}</command-args>`,
        level: 'info',
        timestamp,
        uuid: firstUuid,
        isMeta: false,
        userType: 'external',
        entrypoint: 'cli',
        cwd,
        sessionId,
        version: this.options.claudeVersion,
        gitBranch: null,
      },
      {
        parentUuid: firstUuid,
        isSidechain: false,
        type: 'system',
        subtype: 'local_command',
        content: `<local-command-stdout>${output}</local-command-stdout>`,
        level: 'info',
        timestamp,
        uuid: randomUUID(),
        isMeta: false,
        userType: 'external',
        entrypoint: 'cli',
        cwd,
        sessionId,
        version: this.options.claudeVersion,
        gitBranch: null,
      },
    ]
  }

  private store(sessionId: string): ClaudeTranscriptStore {
    const paths = this.paths(sessionId)
    return new ClaudeTranscriptStore({
      sessionFile: paths.sessionFile,
      lockFile: join(paths.praxisRoot, 'locks', `${sessionId}.lock`),
      schema: this.schema,
    })
  }

  private turnStore(
    sessionId: string,
  ): ClaudeTranscriptStore | InMemoryTranscriptStore {
    if (this.options.sessionPersistence !== false) return this.store(sessionId)
    let store = this.inMemoryStores.get(sessionId)
    if (!store) {
      store = new InMemoryTranscriptStore()
      this.inMemoryStores.set(sessionId, store)
    }
    return store
  }

  private assertSessionPersistence(): void {
    if (this.options.sessionPersistence === false) {
      throw new Error('Session persistence is disabled')
    }
  }

  private assertWritable(): void {
    if (this.schema.writeMode !== 'read-write') {
      throw new Error(
        `Claude ${this.options.claudeVersion} session is read-only`,
      )
    }
  }

  private sessionStatus(
    issue: TranscriptParseIssue | null,
    entryCount: number,
  ): SessionStatus {
    if (issue || entryCount === 0) return 'corrupt'
    return this.schema.writeMode === 'read-write' ? 'ready' : 'read-only'
  }

  private provider(): ModelProvider {
    if (!this.options.provider) {
      throw new Error('A model provider is required for run and resume')
    }
    return this.options.provider
  }

  model(): string | undefined {
    return this.activeProvider?.model ?? this.options.provider?.model
  }

  private providerForAgent(
    agent: ClaudeAgentRuntimeDefinition | null,
  ): ModelProvider {
    const inherited = this.provider()
    const selectProvider =
      this.options.providerForMainModel ?? this.options.providerForModel
    if (
      this.options.explicitModel ||
      !agent?.model ||
      agent.model === 'inherit' ||
      !selectProvider
    ) {
      return inherited
    }
    return selectProvider(agent.model)
  }

  private resolveAgent(
    name: string | null | undefined,
  ): ClaudeAgentRuntimeDefinition | null {
    if (!name) return null
    return this.options.extensions?.agent(name) ?? null
  }

  private async mainAgentSystemPrompt(
    agent: ClaudeAgentRuntimeDefinition | null,
  ): Promise<string | null> {
    if (
      !agent ||
      (this.options.explicitSystemPrompt &&
        !this.options.agentSystemPromptOverridesExplicit)
    ) {
      return null
    }
    const memory = await agentMemoryPrompt(
      this.options.configRoot,
      this.activeCwd(),
      agent,
      this.options.dataPlane ?? 'claude',
    )
    const system = memory ? `${agent.body}\n\n${memory}` : agent.body
    return system.trim() ? system : null
  }

  private assembledSystemMessages(
    agent: ClaudeAgentRuntimeDefinition | null,
    messages: readonly ModelMessage[],
  ): readonly ModelMessage[] {
    return agent &&
      this.options.explicitSystemPrompt &&
      this.options.agentSystemPromptOverridesExplicit
      ? messages.slice(1)
      : messages
  }

  private contextBudget(provider: ModelProvider): ContextBudget | null {
    if (this.options.contextBudget) return this.options.contextBudget
    const contextWindowTokens = provider.capabilities.contextWindowTokens
    if (contextWindowTokens === undefined) return null
    return new ContextBudget({
      contextWindowTokens,
      windowSource: 'capability',
      onAccountingDiagnostic: (message) =>
        this.options.eventSink?.({
          type: 'warning',
          message: `Context usage accounting: ${message}`,
        }),
      ...(this.options.contextReserveTokens === undefined
        ? {}
        : { reserveTokens: this.options.contextReserveTokens }),
    })
  }

  private sessionMemoryEnabled(): boolean {
    if (this.options.enableSessionMemory === false) return false
    if (this.options.sessionPersistence === false) return false
    if (this.options.sessionKind === 'bg') return false
    return this.sessionMemoryProviderFactory() !== null
  }

  private sessionMemoryController(
    sessionId: string,
  ): SessionMemoryController | null {
    if (!this.sessionMemoryEnabled() || !isClaudeSessionId(sessionId)) {
      return null
    }
    let controller = this.sessionMemoryControllers.get(sessionId)
    if (!controller) {
      controller = new SessionMemoryController({
        store: new SessionMemoryStore({
          configRoot: this.options.configRoot,
          sessionId,
          sidecarRoot: this.paths(sessionId).praxisRoot,
        }),
        extractor: (input) => this.extractSessionMemory(input),
        onExtractionError: (error) =>
          this.options.eventSink?.({
            type: 'warning',
            message: `Session memory extraction failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          }),
      })
      this.sessionMemoryControllers.set(sessionId, controller)
    }
    return controller
  }

  private sessionMemoryMessage(summary: string): string | null {
    const bounded = this.boundSessionMemorySummary(summary.trim())
    if (bounded.length === 0) return null
    return `# Session Memory\n\n${bounded}`
  }

  private boundSessionMemorySummary(summary: string): string {
    const lines = summary.split('\n')
    const content =
      lines.length > SESSION_MEMORY_MAX_LINES
        ? lines.slice(0, SESSION_MEMORY_MAX_LINES).join('\n')
        : summary
    return content.length > SESSION_MEMORY_MAX_CHARS
      ? content.slice(0, SESSION_MEMORY_MAX_CHARS)
      : content
  }

  private formatSessionMemoryConversation(
    messages: readonly ModelMessage[],
  ): string {
    const parts: string[] = []
    for (const message of messages) {
      if (message.role === 'system') {
        parts.push(`System: ${message.content}`)
      } else if (message.role === 'user') {
        const body =
          message.contentBlocks === undefined
            ? message.content
            : message.contentBlocks
                .map((block) =>
                  block.type === 'text'
                    ? block.text
                    : block.type === 'image'
                      ? '[image]'
                      : '[document]',
                )
                .join('\n')
        parts.push(`User: ${body}`)
      } else if (message.role === 'assistant') {
        const toolCalls =
          message.toolCalls === undefined || message.toolCalls.length === 0
            ? ''
            : `\n${message.toolCalls
                .map((call) => `${call.name}(${JSON.stringify(call.input)})`)
                .join('\n')}`
        parts.push(`Assistant: ${message.content}${toolCalls}`)
      } else {
        parts.push(`Tool result: ${message.content}`)
      }
    }
    // The successful watermark names the newest message in this snapshot, so
    // extraction must receive every message in full. Summary injection remains
    // bounded separately; provider refusal leaves the old watermark retryable.
    return parts.join('\n\n')
  }

  private async extractSessionMemory(
    input: SessionMemoryExtractorInput,
  ): Promise<string> {
    const provider = this.sessionMemoryProvider()
    if (provider === null) {
      throw new SessionMemoryStateError(
        'Session memory requires an isolated provider factory',
      )
    }
    const messages: ModelMessage[] = [
      { role: 'system', content: SESSION_MEMORY_EXTRACTION_PROMPT },
      ...(input.summary.trim().length === 0
        ? []
        : [
            {
              role: 'system' as const,
              content: `Previous session memory summary:\n\n${this.boundSessionMemorySummary(input.summary)}`,
            },
          ]),
      ...(input.messages === undefined || input.messages.length === 0
        ? []
        : [
            {
              role: 'user' as const,
              content: `Conversation so far:\n\n${this.formatSessionMemoryConversation(input.messages)}`,
            },
          ]),
    ]
    // Session memory is operational side work: it never contributes to the
    // foreground result or the persisted session cost/usage tracker.
    const metrics = await completeMeteredModelRequest(provider, {
      messages,
      signal: input.signal,
    })
    if (metrics.toolCalls.length > 0) {
      throw new SessionMemoryStateError(
        'Session memory extraction must not call tools',
      )
    }
    const summary = metrics.text.trim()
    if (summary.length === 0) {
      throw new SessionMemoryStateError(
        'Session memory extractor returned an empty summary',
      )
    }
    return summary
  }

  private sessionMemoryProvider(): ModelProvider | null {
    if (this.resolvedSessionMemoryProvider !== undefined) {
      return this.resolvedSessionMemoryProvider
    }
    const factory = this.sessionMemoryProviderFactory()
    this.resolvedSessionMemoryProvider = factory?.() ?? null
    return this.resolvedSessionMemoryProvider
  }

  private sessionMemoryProviderFactory(): (() => ModelProvider) | null {
    if (this.options.sessionMemoryProviderFactory) {
      return this.options.sessionMemoryProviderFactory
    }
    const selectProvider =
      this.options.providerForMainModel ?? this.options.providerForModel
    const foregroundModel = this.options.provider?.model
    return foregroundModel && selectProvider
      ? () => selectProvider(foregroundModel)
      : null
  }

  private toolCapabilities(): ReadonlySet<string> {
    const taskNames = this.options.taskToolNames ?? []
    const input: ClaudeToolCapabilityInput = {
      role: this.options.toolRole ?? 'main',
      interactive: this.options.interactiveTools !== undefined,
      simpleMode: this.options.simpleMode ?? false,
      tasks: taskNames.some((name) =>
        ['TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate'].includes(name),
      ),
      agentTriggers: (this.options.scheduledToolNames?.length ?? 0) > 0,
      backgroundAgents: taskNames.some((name) =>
        ['TaskOutput', 'TaskStop'].includes(name),
      ),
      ...(this.options.enableWorkflows === undefined
        ? {}
        : { workflowScripts: this.options.enableWorkflows }),
      ...(this.options.enableSubagents === undefined
        ? {}
        : { subagents: this.options.enableSubagents }),
      ...(this.options.toolCapabilityEnvironment
        ? { env: this.options.toolCapabilityEnvironment }
        : {}),
    }
    return resolveClaudeToolCapabilities(input)
  }

  private capabilityToolNames(
    names: readonly string[] | undefined,
    capabilities: ReadonlySet<string>,
  ): readonly string[] {
    return (names ?? [])
      .filter((name) => !name.startsWith('Task') || capabilities.has(name))
      .filter(
        (name) =>
          ![
            'Workflow',
            'Agent',
            'CronCreate',
            'CronDelete',
            'CronList',
            'ScheduleWakeup',
          ].includes(name) || capabilities.has(name),
      )
  }

  private async append(
    lease: ClaudeTranscriptLease,
    tail: TranscriptTail,
    entry: ClaudeTranscriptEntry,
  ): Promise<TranscriptTail> {
    const result = await lease.append(tail, entry)
    if (result.status === 'conflict') {
      throw new Error(`Claude transcript append conflict: ${result.reason}`)
    }
    return result.tail
  }

  private logicalTailUuid(tail: TranscriptTail): string | null {
    return tail.branchParentUuid ?? tail.lastUuid
  }
}
