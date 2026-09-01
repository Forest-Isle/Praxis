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
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path'

import { isPathWithin } from '../platform/path-containment.js'

import {
  AGENT_COLOR_DEFAULT,
  isAgentColorName,
  type AgentColorName,
  type AgentColorSelection,
  type AgentColorValue,
} from '../core/agent-color.js'
import type { ClaudeConditionalRuleResolver } from '../native/context.js'
import { formatClaudeCompactSummary } from '../native/compaction.js'
import { isClaudeAgentId } from '../native/sidechain.js'
import {
  assertNativeDataPlane,
  resolveDataPlanePaths,
  resolveScheduledTaskFile,
  type DataPlane,
} from '../persistence/data-plane.js'
import {
  downloadClaudeFileResources,
  type ClaudeFileResource,
  type ClaudeFileResourceConfig,
} from '../native/file-resources.js'
import { selectClaudeActiveTranscript } from '../native/history.js'
import { ClaudeFileHistory } from '../native/file-history.js'
import {
  getClaudeAgentSetting,
  projectClaudeModelMessages,
} from '../native/projection.js'
import type { TranscriptDisplayItem } from './transcript-projection.js'
import { projectNativeSessionEntries } from './native-session-projection.js'
import { type NativeTranscriptEntry } from '../native/schema.js'
import type { TranscriptEvent } from '../core/transcript-event.js'
import { type ClaudeSessionMetadata } from '../native/session-metadata.js'
import {
  classifyClaudeInterruption,
  type ClaudeInterruptionClassification,
} from '../native/interruption.js'
import {
  findUnresolvedClaudeToolCalls,
  getClaudeContentBlocks,
} from '../native/tool-links.js'
import {
  createClaudeAgentSettingEntry,
  createClaudeHookAttachmentEntries,
  createClaudeLastPromptEntry,
  createClaudeRuleAttachmentEntry,
  translateProviderEvents,
} from '../native/translation.js'
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
  type ModelToolDefinition,
  type ModelProvider,
  MALFORMED_TOOL_INPUT_MESSAGE,
  ModelProviderError,
  type ModelUsage,
  type PermissionApproval,
  type PermissionDecision,
  type PermissionResolver,
  type PermissionUpdate,
  type ProviderErrorKind,
  type RuntimeEventSink,
  type ToolRegistry,
} from '../core/runtime.js'
import { resolveToolSchedulingPolicy } from '../core/tool-scheduling-policy.js'
import {
  BackgroundTaskRuntime,
  type BackgroundTaskSnapshot,
} from './background-task-runtime.js'
import {
  backgroundAgentNotificationMarkers,
  type BackgroundAgentNotificationIdentity,
} from './background-agent-manager.js'
import { usageCostUsd } from '../core/usage.js'
import type { ModelPricingRegistry } from '../core/usage.js'
import { isSessionId } from '../core/session.js'
import {
  ActiveTurnInputMailbox,
  type ActiveTurnInputCommandResult,
  type SteeringItem,
} from '../core/active-turn-input.js'
import type { CompactionResult, Compactor } from '../core/compaction.js'

import {
  ContextBudget,
  estimateModelRequestTokens,
  isPromptTooLongError,
} from '../core/context-budget.js'
import { ContextEngine } from './context-engine.js'
import { TurnMemoryCoordinator } from './turn-memory-coordinator.js'
import {
  injectFirstUserMessageContext,
  projectContextSnapshot,
  type ContextProjection,
  type ContextAssembler,
} from '../core/context.js'
import { assembleContextSnapshot } from '../core/prompt-composer.js'
import type {
  ClaudeAgentRuntimeDefinition,
  ClaudeExtensionCatalog,
  ClaudePromptExpansionMessage,
} from '../extensions/claude-extensions.js'
import { ClaudeHookToolCoordinator } from '../hooks/claude-hook-tools.js'
import { ClaudeFileChangeWatcher } from '../hooks/claude-file-change-watcher.js'
import type {
  ClaudeHookInput,
  ClaudeHookOutcome,
  ClaudeHookRunner,
} from '../hooks/claude-hooks.js'
import {
  readNativeTranscript,
  readNativeTranscriptIndexes,
  NativeTranscriptIndexCandidateError,
} from '../persistence/native-transcript-reader.js'
import {
  lastUserPrompt,
  projectTranscriptDisplay,
  unresolvedActiveToolCallIds,
} from './transcript-projection.js'
import type { TranscriptCodecDiagnostic } from '../core/transcript-codec.js'

import { InMemoryTranscriptStore } from '../persistence/in-memory-transcript-store.js'
import {
  NativeTranscriptStore,
  type NativeTranscriptLease,
  type NativeTranscriptTail,
} from '../persistence/native-transcript-store.js'
import {
  NativeSessionTranscript,
  type NativeSessionTranscriptStore,
  type NativeSessionTranscriptLease,
} from './native-session-transcript.js'
import type { ClaudeCostStateStore } from '../persistence/claude-cost-state-store.js'
import { SubagentLifecycleStore } from '../persistence/subagent-lifecycle-store.js'
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
import { TurnTerminalController, type TurnRequest } from './turn-lifecycle.js'
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
import type { TeamLeadOperations } from './team-lead-operations.js'
import { DurableFollowUpTracker } from './durable-follow-up.js'
type TeamLeadToolRegistryFactory = (
  base: ToolRegistry,
  operations: TeamLeadOperations,
  sessionId: string,
  enabledTools: readonly string[],
) => ToolRegistry

type SessionTail = NativeTranscriptTail

export interface ClaudeSessionServiceOptions {
  configRoot: string
  /** Native Praxis transcript data plane. */
  dataPlane?: DataPlane
  /** Retained for compatibility; native transcripts are always writable. */
  experimentalNativeTranscriptWrites?: boolean
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
  /** Explicit Claude-compatible opt-in for replaying an interrupted turn. */
  resumeInterruptedTurn?: boolean
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
  teamToolNames?: readonly string[]
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
  /** Shared internal Team lead operations port. */
  teamLeadOperations?: TeamLeadOperations
  /** Lazily supplied Team tool wrapper, so disabled runs do not load Team code. */
  teamLeadToolRegistryFactory?: TeamLeadToolRegistryFactory
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

function transcriptContainsBackgroundAgentNotification(
  entries: readonly NativeTranscriptEntry[] | readonly ModelMessage[],
  notification: BackgroundAgentNotificationIdentity,
): boolean {
  const markers = backgroundAgentNotificationMarkers(notification)
  return entries.some((entry) => {
    if ('type' in entry) {
      if (entry.type !== 'user') return false
      return markers.every((marker) =>
        JSON.stringify(entry.message).includes(marker),
      )
    }
    if (entry.role !== 'user') return false
    return markers.every((marker) => JSON.stringify(entry).includes(marker))
  })
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

export interface CwdInspection {
  readonly canonicalTarget: string
  readonly canonicalCurrentCwd: string
  readonly sameDirectory: boolean
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
  tag?: string
  agentName?: string
  agentColor?: string
  agentSetting?: string
  permissionMode?: string
  mode?: string
  lastPrompt: string | null
  updatedAt: string
  status: SessionStatus
  issue: TranscriptCodecDiagnostic | null
  prNumber?: number
  prUrl?: string
  prRepository?: string
}

export type SessionStatus = 'ready' | 'read-only' | 'corrupt'

export interface SessionInspection extends SessionSummary {
  claudeVersion?: string
  writeMode: 'read-only' | 'read-write'
  entryCount: number
  byteLength: number
  newlineTerminated: boolean
}

function isSessionCandidateError(error: unknown): boolean {
  return (
    error instanceof NativeTranscriptIndexCandidateError ||
    ['ENOENT', 'ENOTDIR', 'ELOOP'].includes(
      (error as NodeJS.ErrnoException).code ?? '',
    )
  )
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
  readonly compactedEntries: readonly NativeTranscriptEntry[]
  /** Recent suffix retained verbatim after the compact boundary. */
  readonly preservedEntries: readonly NativeTranscriptEntry[]
  /** Last good memory artifact leading the compactor input. */
  readonly memoryMessage: ModelMessage
  /** Message the compact boundary links to, just before the preserved suffix. */
  readonly logicalParentUuid: string
}

function isTextBearingClaudeEntry(entry: NativeTranscriptEntry): boolean {
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

function claudeToolResultIds(entry: NativeTranscriptEntry): Set<string> {
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
  entry: NativeTranscriptEntry,
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
  entry: NativeTranscriptEntry | undefined,
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
  activeEntries: readonly NativeTranscriptEntry[],
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
  activeEntries: readonly NativeTranscriptEntry[],
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
  activeEntries: readonly NativeTranscriptEntry[],
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
  entries: readonly NativeTranscriptEntry[],
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

function successfulHookOutput(
  outcome: ClaudeHookOutcome | undefined,
): string[] {
  return (outcome?.executions ?? []).flatMap((execution) => {
    const output = execution.stdout.trim()
    return execution.exitCode === 0 && output.length > 0 ? [output] : []
  })
}

type ClaudeStopFailureError =
  | 'authentication_failed'
  | 'billing_error'
  | 'rate_limit'
  | 'invalid_request'
  | 'server_error'
  | 'unknown'
  | 'max_output_tokens'

function claudeStopFailureError(
  kind: ProviderErrorKind | undefined,
): ClaudeStopFailureError {
  switch (kind) {
    case 'authentication_failed':
    case 'billing_error':
    case 'rate_limit':
    case 'invalid_request':
    case 'server_error':
    case 'max_output_tokens':
      return kind
    case 'prompt_too_long':
      return 'invalid_request'
    case 'timeout':
    case 'overloaded':
    case 'api_error':
    case 'transport_error':
      return 'server_error'
    case 'cancelled':
    case 'unknown':
    case undefined:
      return 'unknown'
  }
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
  private readonly options: ClaudeSessionServiceOptions
  private readonly schema = { writeMode: 'read-write' as const }
  private readonly inMemoryStores = new Map<string, InMemoryTranscriptStore>()
  private readonly scheduledPrompts: ScheduledPromptManager | null
  private readonly workflowManager: WorkflowManager | null
  private readonly backgroundTasks: BackgroundTaskRuntime
  private readonly worktreeManager: SessionWorktreeManager | null
  private readonly sessionCwds = new Map<string, string>()
  private readonly discoveredProjectRoots = new Map<string, string>()
  private readonly explicitSessionFiles = new Map<string, string>()
  private readonly explicitResumeLeafUuids = new Map<string, string>()
  private readonly sessionPermissionUpdates = new Map<
    string,
    PermissionUpdate[]
  >()
  private readonly hostedSubagents = new Set<ClaudeSubagentExecutor>()
  private readonly subagentExecutors = new Set<ClaudeSubagentExecutor>()
  private readonly hostedSubagentsByRegistry = new WeakMap<
    ToolRegistry,
    ClaudeSubagentExecutor
  >()
  private readonly subagentExecutorSessions = new WeakMap<
    ClaudeSubagentExecutor,
    string
  >()
  private readonly hostedSubagentNotificationPumps = new WeakMap<
    ClaudeSubagentExecutor,
    Promise<void>
  >()
  private readonly hostedSubagentPumpPromises = new Set<Promise<void>>()
  private readonly hostedSubagentNotificationReservations =
    new WeakSet<ClaudeSubagentExecutor>()
  private readonly backgroundNotificationWrites = new Map<
    string,
    Promise<boolean>
  >()
  private closing = false
  private readonly downloadedFileResourceSessions = new Set<string>()
  private readonly detachedHookRuns = new Map<Promise<void>, AbortController>()
  private activeProvider: ModelProvider | undefined
  private mcpClosePromise: Promise<void> | undefined
  private readonly sessionCostTrackers = new Map<
    string,
    ClaudeSessionCostTracker
  >()
  private activeCostSessionId: string | undefined
  private closeCostSavePromise: Promise<void> | undefined
  private closeMetadataSavePromise: Promise<void> | undefined
  private readonly sessionMemoryControllers = new Map<
    string,
    SessionMemoryController
  >()
  private resolvedSessionMemoryProvider: ModelProvider | null | undefined
  private readonly hookLifecycle: HookLifecycle
  private readonly leadOperations: TeamLeadOperations | null
  private readonly fileChangeWatcher: ClaudeFileChangeWatcher | null
  private readonly activeTurnInputs = new Map<
    string,
    { readonly mailbox?: ActiveTurnInputMailbox }
  >()
  private runtimeCwd: string

  constructor(options: ClaudeSessionServiceOptions) {
    const dataPlane = options.dataPlane ?? 'native'
    assertNativeDataPlane(dataPlane)
    this.options = { ...options, dataPlane }
    this.assertNativeTranscriptOptions()
    this.leadOperations = options.teamLeadOperations ?? null
    this.hookLifecycle = new HookLifecycle(options.hooks, options.eventSink)
    this.runtimeCwd = options.workspace?.cwd() ?? options.cwd
    this.fileChangeWatcher = options.hooks
      ? new ClaudeFileChangeWatcher({
          cwd: this.runtimeCwd,
          staticPaths: options.hooks.fileChangedWatchPaths(this.runtimeCwd),
          onFileChanged: async (filePath, event, signal) => {
            const sessionId = this.activeCostSessionId
            if (!sessionId) return undefined
            const outcome = await this.runAdvisoryHook(
              sessionId,
              'FileChanged',
              { file_path: filePath, event },
              undefined,
              signal,
            )
            return outcome?.watchPaths
          },
          warn: (message) => options.eventSink?.({ type: 'warning', message }),
        })
      : null
    this.scheduledPrompts =
      options.tools && (options.scheduledToolNames?.length ?? 0) > 0
        ? new ScheduledPromptManager({
            filePath: resolveScheduledTaskFile({
              dataPlane: 'native',
              cwd: options.cwd,
              root: options.configRoot,
            }),
            lockFile: join(
              resolveDataPlanePaths({
                dataPlane: 'native',
                root: options.configRoot,
                cwd: options.cwd,
                sessionId: '00000000-0000-4000-8000-000000000000',
              }).praxisRoot,
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

  backgroundForegroundTask(sessionId: string) {
    return this.backgroundTasks.backgroundForeground(sessionId)
  }

  private sendOwnedBackgroundAgent(
    sessionId: string,
    agentId: string,
    message: string,
    summary: string | undefined,
    toolUseId: string,
  ): string | null {
    const sent = this.backgroundTasks.sendAgentWithOwner(
      sessionId,
      agentId,
      message,
      summary,
      toolUseId,
    )
    if (!sent) return null
    const hosted = [...this.hostedSubagents].find(
      (executor) => executor === sent.owner,
    )
    if (hosted) this.startHostedSubagentNotificationPump(sessionId, hosted)
    return sent.content
  }

  private sessionSubagentExecutors(
    sessionId: string,
    includeHosted = false,
  ): ClaudeSubagentExecutor[] {
    return [...this.subagentExecutors].filter(
      (executor) =>
        this.subagentExecutorSessions.get(executor) === sessionId &&
        (includeHosted ||
          (!this.hostedSubagentNotificationPumps.has(executor) &&
            !this.hostedSubagentNotificationReservations.has(executor))),
    )
  }

  private async collectSubagentNotifications(
    sessionId: string,
    waitForExecutor?: ClaudeSubagentExecutor,
  ): Promise<{
    messages: string[]
    usage: ModelUsage
    modelUsage?: Readonly<Record<string, ModelUsage>>
    durationApiMs?: number
    durationApiWithoutRetriesMs?: number
  } | null> {
    const executors = this.sessionSubagentExecutors(sessionId)
    if (executors.length === 0) return null
    const poll = () =>
      Promise.all(
        executors.map((executor) => executor.notifications(false, false)),
      )
    let batches = await poll()
    if (batches.every(({ messages }) => messages.length === 0)) {
      if (
        waitForExecutor &&
        executors.includes(waitForExecutor) &&
        waitForExecutor.notificationClaimAgentIds().length > 0
      ) {
        await waitForExecutor.notifications(true, false)
        batches = await poll()
      }
    }
    const durationSeen = batches.some(
      ({ durationApiMs, durationApiWithoutRetriesMs }) =>
        durationApiMs !== undefined ||
        durationApiWithoutRetriesMs !== undefined,
    )
    const modelUsage = mergeSessionRawModelUsage(
      ...batches.map((batch) => batch.modelUsage),
    )
    return {
      messages: batches.flatMap(({ messages }) => messages),
      usage: batches.reduce((total, { usage }) => mergeUsage(total, usage), {
        inputTokens: 0,
        outputTokens: 0,
      }),
      ...(modelUsage ? { modelUsage } : {}),
      ...(durationSeen
        ? {
            durationApiMs: batches.reduce(
              (total, batch) =>
                addApiDuration(batch.durationApiMs, total, 'durationApiMs'),
              0,
            ),
            durationApiWithoutRetriesMs: batches.reduce(
              (total, batch) =>
                addApiDuration(
                  batch.durationApiWithoutRetriesMs ?? batch.durationApiMs,
                  total,
                  'durationApiWithoutRetriesMs',
                ),
              0,
            ),
          }
        : {}),
    }
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
    this.closing = true
    for (const { mailbox } of this.activeTurnInputs.values()) {
      if (!mailbox) continue
      for (const item of mailbox.close()) {
        this.options.eventSink?.({
          type: 'user-input-rejected',
          id: item.id,
          content: item.content,
          reason: 'closed',
        })
      }
    }
    await this.fileChangeWatcher?.close(5_000)
    await this.hookLifecycle.close()
    await this.drainDetachedHookRuns(5_000)
    await this.options.hooks?.drainAsync(5_000)
    this.scheduledPrompts?.close()
    await this.options.projectMemoryExtraction?.close(5_000)
    await Promise.all(
      [...this.subagentExecutors].map((executor) => executor.close()),
    )
    await Promise.allSettled([...this.hostedSubagentPumpPromises])
    await Promise.resolve()
    await Promise.all([...this.backgroundNotificationWrites.values()])
    this.hostedSubagents.clear()
    this.subagentExecutors.clear()
    this.backgroundTasks.clear()
    await Promise.all(
      [...this.sessionMemoryControllers.values()].map((controller) =>
        controller.close(),
      ),
    )
    this.sessionMemoryControllers.clear()
    await this.workflowManager?.close()
    this.closeMetadataSavePromise ??= Promise.resolve()
    await this.closeMetadataSavePromise
    this.closeCostSavePromise ??= this.persistActiveSessionCost()
    await this.closeCostSavePromise
    this.mcpClosePromise ??= this.options.mcp?.close?.() ?? Promise.resolve()
    await this.mcpClosePromise
    await this.leadOperations?.close()
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

  async notify(
    sessionId: string | undefined,
    message: string,
    notificationType: string,
    title?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const targetSessionId = sessionId ?? this.activeCostSessionId
    if (!targetSessionId) return
    await this.runAdvisoryHook(
      targetSessionId,
      'Notification',
      {
        message,
        notification_type: notificationType,
        ...(title === undefined ? {} : { title }),
      },
      notificationType,
      signal,
    )
  }

  notifyDetached(
    sessionId: string | undefined,
    message: string,
    notificationType: string,
    title?: string,
  ): void {
    const controller = new AbortController()
    const pending = this.notify(
      sessionId,
      message,
      notificationType,
      title,
      controller.signal,
    )
    this.detachedHookRuns.set(pending, controller)
    void pending.finally(() => this.detachedHookRuns.delete(pending))
  }

  private async drainDetachedHookRuns(timeoutMs: number): Promise<void> {
    const pending = [...this.detachedHookRuns.keys()]
    if (pending.length === 0) return
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      if (
        (await Promise.race([
          Promise.allSettled(pending).then(() => 'settled' as const),
          new Promise<'timeout'>((resolve) => {
            timer = setTimeout(() => resolve('timeout'), timeoutMs)
          }),
        ])) === 'timeout'
      ) {
        for (const controller of this.detachedHookRuns.values()) {
          controller.abort()
        }
        this.detachedHookRuns.clear()
        await Promise.resolve()
      }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async instructionsLoaded(
    sessionId: string,
    resources: readonly {
      path: string
      scope: 'local' | 'project' | 'user'
      importedFrom?: string
    }[],
    reason: 'session_start' | 'compact' | 'resource_reload',
  ): Promise<void> {
    if (reason === 'resource_reload') return
    for (const resource of resources) {
      const loadReason = resource.importedFrom
        ? 'include'
        : reason === 'compact'
          ? 'compact'
          : 'session_start'
      await this.instructionLoaded(
        sessionId,
        {
          path: resource.path,
          memoryType:
            resource.scope === 'user'
              ? 'User'
              : resource.scope === 'local'
                ? 'Local'
                : 'Project',
          ...(resource.importedFrom === undefined
            ? {}
            : { parentFilePath: resource.importedFrom }),
        },
        loadReason,
      )
    }
  }

  async instructionLoaded(
    sessionId: string,
    resource: {
      path: string
      memoryType: 'User' | 'Project' | 'Local' | 'Managed'
      globs?: readonly string[]
      triggerFilePath?: string
      parentFilePath?: string
    },
    loadReason:
      | 'session_start'
      | 'nested_traversal'
      | 'path_glob_match'
      | 'include'
      | 'compact',
  ): Promise<void> {
    await this.runAdvisoryHook(
      sessionId,
      'InstructionsLoaded',
      {
        file_path: resource.path,
        memory_type: resource.memoryType,
        load_reason: loadReason,
        ...(resource.globs === undefined ? {} : { globs: resource.globs }),
        ...(resource.triggerFilePath === undefined
          ? {}
          : { trigger_file_path: resource.triggerFilePath }),
        ...(resource.parentFilePath === undefined
          ? {}
          : { parent_file_path: resource.parentFilePath }),
      },
      loadReason,
    )
  }

  private async runAdvisoryHook(
    sessionId: string,
    event: ClaudeHookInput['hook_event_name'],
    fields: Readonly<Record<string, unknown>>,
    matcher?: string,
    signal?: AbortSignal,
  ): Promise<ClaudeHookOutcome | undefined> {
    if (!this.options.hooks) return undefined
    try {
      const outcome = await this.options.hooks.run(
        {
          session_id: sessionId,
          transcript_path: this.paths(sessionId).sessionFile,
          cwd: this.activeCwd(),
          permission_mode: 'default',
          hook_event_name: event,
          ...fields,
        },
        matcher,
        signal,
      )
      for (const message of outcome.systemMessages ?? []) {
        this.options.eventSink?.({
          type: 'user-message',
          message,
          status: 'proactive',
        })
      }
      return outcome
    } catch (error) {
      this.options.eventSink?.({
        type: 'warning',
        message: `${event} hook failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      })
      return undefined
    }
  }

  private async cwdChanged(
    sessionId: string,
    previousCwd: string,
    cwd: string,
  ): Promise<void> {
    await this.options.hooks?.clearCwdEnvironment(sessionId)
    const outcome = await this.runAdvisoryHook(sessionId, 'CwdChanged', {
      old_cwd: previousCwd,
      new_cwd: cwd,
    })
    this.fileChangeWatcher?.updateForCwd(
      cwd,
      this.options.hooks?.fileChangedWatchPaths(cwd) ?? [],
      outcome?.watchPaths ?? [],
    )
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
            dataPlane: 'native',
          })
        : null
    const wrappedBase = scheduledTools ?? taskTools ?? baseTools
    const subagentExecutor =
      (this.options.enableSubagents || this.options.enableWorkflows) &&
      this.options.permissions
        ? new ClaudeSubagentExecutor({
            configRoot: this.options.configRoot,
            dataPlane: 'native',
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
            ...(this.options.experimentalNativeTranscriptWrites === true
              ? { experimentalNativeTranscriptWrites: true }
              : {}),
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
            stopOwnedBackgroundAgent: (ownerSessionId, agentId) =>
              this.backgroundTasks.stopAgent(ownerSessionId, agentId),
            outputOwnedBackgroundAgent: (ownerSessionId, agentId, options) =>
              this.backgroundTasks.outputAgent(
                ownerSessionId,
                agentId,
                options,
              ),
            sendOwnedBackgroundAgent: (
              ownerSessionId,
              agentId,
              message,
              summary,
              toolUseId,
            ) =>
              this.sendOwnedBackgroundAgent(
                ownerSessionId,
                agentId,
                message,
                summary,
                toolUseId,
              ),
          })
        : null
    if (subagentExecutor) {
      this.hostedSubagents.add(subagentExecutor)
      this.subagentExecutors.add(subagentExecutor)
      this.subagentExecutorSessions.set(subagentExecutor, sessionId)
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
          })
        : agentTools
    if (this.worktreeManager) this.worktreeManager.bindSession(sessionId)
    const registry =
      this.worktreeManager && this.options.workspace
        ? new ClaudeWorktreeToolRegistry({
            base: workflowTools,
            manager: this.worktreeManager,
            workspace: this.options.workspace,
            dataPlane: 'native',
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
    const teamToolNames = this.capabilityToolNames(
      this.options.teamToolNames,
      capabilities,
    )
    const teamRegistry = this.teamRegistry(
      interactiveRegistry,
      sessionId,
      teamToolNames,
    )
    const capabilityRegistry = new ClaudeCapabilityToolRegistry(
      teamRegistry,
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
      'TeamCreate',
      'TeamResume',
      'TeamList',
      'TeamAccept',
      'TeamStop',
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
    return this.executeTurn({
      activation: {
        kind: 'start',
        sessionId,
        ...(name !== undefined ? { name } : {}),
      },
      submission: {
        kind: 'prompt',
        text: prompt,
        ...(images ? { images } : {}),
        ...(documents ? { documents } : {}),
      },
      ...(signal ? { signal } : {}),
    })
  }

  async runShell(
    command: string,
    signal?: AbortSignal,
    sessionId: string = randomUUID(),
    name?: string,
  ): Promise<SessionRunResult> {
    this.worktreeManager?.bindSession(sessionId)
    return this.executeTurn({
      activation: {
        kind: 'start',
        sessionId,
        ...(name !== undefined ? { name } : {}),
      },
      submission: { kind: 'shell', command },
      ...(signal ? { signal } : {}),
    })
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
    return this.executeTurn({
      activation: {
        kind: 'resume',
        sessionId,
        ...(name !== undefined ? { name } : {}),
        ...(resumeSessionAt !== undefined
          ? { atMessageId: resumeSessionAt }
          : {}),
      },
      submission: {
        kind: 'prompt',
        text: prompt,
        ...(images ? { images } : {}),
        ...(documents ? { documents } : {}),
      },
      ...(signal ? { signal } : {}),
    })
  }

  steer(sessionId: string, content: string): ActiveTurnInputCommandResult {
    const active = this.activeTurnInputs.get(sessionId)
    if (!active) return { kind: 'no-active-turn' }
    const mailbox = active.mailbox
    if (!mailbox) return { kind: 'not-steerable' }
    const result = mailbox.enqueue(content)
    if (result.kind === 'accepted') return result
    if (result.kind === 'empty') return result
    return { kind: 'turn-completing' }
  }

  withdrawSteering(
    sessionId: string,
    id: string,
  ): ActiveTurnInputCommandResult {
    const active = this.activeTurnInputs.get(sessionId)
    if (!active) return { kind: 'no-active-turn' }
    const mailbox = active.mailbox
    if (!mailbox) return { kind: 'not-steerable' }
    const result = mailbox.withdraw(id)
    return result.kind === 'withdrawn' ? result : { kind: 'not-pending' }
  }

  async resumeShell(
    sessionId: string,
    command: string,
    signal?: AbortSignal,
    name?: string,
    resumeSessionAt?: string,
  ): Promise<SessionRunResult> {
    this.worktreeManager?.bindSession(sessionId)
    return this.executeTurn({
      activation: {
        kind: 'resume',
        sessionId,
        ...(name !== undefined ? { name } : {}),
        ...(resumeSessionAt !== undefined
          ? { atMessageId: resumeSessionAt }
          : {}),
      },
      submission: { kind: 'shell', command },
      ...(signal ? { signal } : {}),
    })
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
    let nativeMessages: ModelMessage[] = []
    if (sessionId) {
      const transcript = new NativeSessionTranscript({
        sessionId: activeSessionId,
        store: this.nativeStore(activeSessionId),
      })
      nativeMessages = await transcript.withLease(
        { kind: 'resume' },
        async (lease) => lease.activeMessages(),
      )
    }
    const assembledContext = await assembleContextSnapshot(
      this.options.contextAssembler,
      {
        cwd: this.activeCwd(),
        lifecycleId: activeSessionId,
      },
    )
    const contextProjection = projectContextSnapshot(assembledContext)
    const messages = [
      ...contextProjection.systemMessages,
      ...injectFirstUserMessageContext(
        [...nativeMessages, { role: 'user' as const, content: prompt }],
        contextProjection.firstUserMessageContext,
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
        stableSystemMessageCount: contextProjection.stableSystemSectionCount,
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
    const executor = this.hostedSubagentsByRegistry.get(registry)
    if (executor) this.hostedSubagentNotificationReservations.add(executor)
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
    try {
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
      if (executor) {
        this.startHostedSubagentNotificationPump(sessionId, executor)
      }
      return { agentId, name }
    } catch (error) {
      if (executor) {
        this.hostedSubagentNotificationReservations.delete(executor)
      }
      throw error
    }
  }

  private startHostedSubagentNotificationPump(
    sessionId: string,
    executor: ClaudeSubagentExecutor,
  ): void {
    this.hostedSubagentNotificationReservations.delete(executor)
    if (this.hostedSubagentNotificationPumps.has(executor)) return
    const pump = (async () => {
      while (!this.closing) {
        const reconciled = await new NativeSessionTranscript({
          sessionId,
          store: this.nativeStore(sessionId),
        })
          .withLease({ kind: 'resume' }, async (lease) => {
            await executor.reconcileDetachedNotifications((notification) =>
              transcriptContainsBackgroundAgentNotification(
                lease.activeMessages(),
                notification,
              ),
            )
          })
          .then(() => ({ status: 'completed' as const }))
        if (reconciled.status !== 'completed') {
          await new Promise<void>((resolve) => setTimeout(resolve, 25))
          continue
        }
        const { messages } = await executor.notifications(true, false)
        if (messages.length === 0) return
        await executor.prepareNotificationsDetached(messages)
        if (
          !(await this.enqueueBackgroundNotifications(
            sessionId,
            messages,
            async (message) => {
              await executor.confirmNotificationsDetached([message])
              await executor.acknowledgeNotifications([message])
            },
          ))
        ) {
          return
        }
        if (executor.notificationClaimAgentIds().length === 0) return
      }
    })()
      .catch((error: unknown) =>
        this.options.eventSink?.({
          type: 'warning',
          message:
            error instanceof Error
              ? error.message
              : `Could not persist background notification: ${String(error)}`,
        }),
      )
      .finally(() => {
        if (this.hostedSubagentNotificationPumps.get(executor) === pump) {
          this.hostedSubagentNotificationPumps.delete(executor)
        }
        this.hostedSubagentPumpPromises.delete(pump)
      })
    this.hostedSubagentNotificationPumps.set(executor, pump)
    this.hostedSubagentPumpPromises.add(pump)
    void pump
  }

  async promptSuggestion(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    {
      const transcript = new NativeSessionTranscript({
        sessionId,
        store: this.store(sessionId),
      })
      const nativeMessages = await transcript.withLease(
        { kind: 'resume' },
        async (lease) => lease.activeMessages(),
      )
      const provider = this.provider()
      const assembledContext = await assembleContextSnapshot(
        this.options.contextAssembler,
        { cwd: this.activeCwd(), lifecycleId: sessionId },
      )
      const contextProjection = projectContextSnapshot(assembledContext)
      const messages = [
        ...contextProjection.systemMessages,
        ...injectFirstUserMessageContext(
          [
            ...nativeMessages,
            { role: 'user' as const, content: PROMPT_SUGGESTION_INSTRUCTION },
          ],
          contextProjection.firstUserMessageContext,
        ),
      ]
      const metrics = await completeMeteredModelRequest(
        provider,
        {
          messages,
          stableSystemMessageCount: contextProjection.stableSystemSectionCount,
          ...(provider.capabilities.tools
            ? { tools: this.options.tools?.definitions() ?? [] }
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
  }

  async sessionNameSuggestion(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const provider = this.provider()
    {
      const transcript = new NativeSessionTranscript({
        sessionId,
        store: this.store(sessionId),
      })
      const messages = await transcript.withLease(
        { kind: 'resume' },
        async (lease) => lease.activeMessages(),
      )
      if (messages.length === 0) return null
      await this.activateSessionCostTracker(sessionId)
      const metrics = await completeMeteredModelRequest(
        provider,
        {
          messages: [
            ...messages,
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
  }

  async sessions(): Promise<SessionSummary[]> {
    const projectRoot = this.paths(randomUUID()).projectRoot
    let names: string[]
    try {
      names = await readdir(projectRoot)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') names = []
      else throw error
    }

    const discoveredSessionIds = names
      .filter((name) => extname(name) === '.jsonl')
      .map((name) => basename(name, '.jsonl'))
      .filter((sessionId) => isSessionId(sessionId))
    const sessionIds = [
      ...new Set([
        ...discoveredSessionIds,
        ...this.explicitSessionFiles.keys(),
      ]),
    ]
    const nativeResults = await readNativeTranscriptIndexes(
      sessionIds.map((sessionId) => ({
        sessionId,
        path:
          this.explicitSessionFiles.get(sessionId) ??
          join(projectRoot, `${sessionId}.jsonl`),
      })),
    )
    return nativeResults
      .map((result): SessionSummary | null => {
        try {
          if ('error' in result) throw result.error
          const file = result.result
          if (file.format === 'unsupported') return null
          return {
            sessionId: result.sessionId,
            lastPrompt: lastUserPrompt(
              file.records.map((record) => record.event),
            ),
            updatedAt: file.updatedAt,
            status: this.nativeSessionStatus(file.issue, file.records.length),
            issue: file.issue,
          }
        } catch (error) {
          if (isSessionCandidateError(error)) return null
          throw error
        }
      })
      .filter((summary): summary is SessionSummary => summary !== null)
      .sort(
        (left, right) =>
          right.updatedAt.localeCompare(left.updatedAt) ||
          left.sessionId.localeCompare(right.sessionId),
      )
  }

  async inspect(sessionId: string): Promise<SessionInspection> {
    this.assertSessionPersistence()
    const paths = this.paths(sessionId)
    const file = await readNativeTranscript(paths.sessionFile)
    if (file.format === 'unsupported')
      throw new Error(
        `Native session transcript is not a native file: ${sessionId}`,
      )
    return {
      sessionId,
      lastPrompt: lastUserPrompt(file.records.map((record) => record.event)),
      updatedAt: file.updatedAt,
      status: this.nativeSessionStatus(file.issue, file.records.length),
      issue: file.issue,
      writeMode: file.writeMode,
      entryCount: file.records.length,
      byteLength: file.byteLength,
      newlineTerminated: file.newlineTerminated,
    }
  }

  async readEffectiveAgentColor(
    sessionId: string,
  ): Promise<AgentColorName | undefined> {
    this.assertSessionPersistence()
    const transcript = new NativeSessionTranscript({
      sessionId,
      store: this.store(sessionId),
    })
    return transcript.withLease({ kind: 'resume' }, async (lease) => {
      let color: AgentColorName | undefined
      for (const event of lease.activeEvents()) {
        if (event.kind !== 'messages') continue
        for (const message of event.messages) {
          if (message.role !== 'user' || typeof message.content !== 'string')
            continue
          const match = message.content.match(/<praxis-agent-color>([^<]+)</u)
          if (!match) continue
          if (match[1] === AGENT_COLOR_DEFAULT) {
            color = undefined
          } else if (isAgentColorName(match[1])) {
            color = match[1]
          }
        }
      }
      return color
    })
  }

  async export(sessionId: string): Promise<Buffer> {
    this.assertSessionPersistence()
    const nativeStore = this.store(sessionId)
    const file = await readNativeTranscript(this.paths(sessionId).sessionFile)
    if (file.format === 'unsupported')
      throw new Error(
        `Native session transcript is not a native file: ${sessionId}`,
      )
    try {
      return await nativeStore.exportReadOnly()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`Native session not found: ${sessionId}`)
      }
      throw error
    }
  }

  async registerResumePath(requestedPath: string): Promise<SessionSummary> {
    this.assertSessionPersistence()
    const path = resolve(requestedPath)
    const pathMetadata = await lstat(path)
    const dataPlaneName = 'Native'
    if (!pathMetadata.isFile()) {
      throw new Error(
        `${dataPlaneName} resume path must be a regular JSONL file: ${path}`,
      )
    }
    if (extname(path).toLowerCase() !== '.jsonl') {
      throw new Error(
        `${dataPlaneName} resume path must end in .jsonl: ${path}`,
      )
    }
    const sessionId = basename(path, '.jsonl')
    if (!isSessionId(sessionId)) {
      throw new Error(
        `${dataPlaneName} resume path filename must be a session UUID: ${path}`,
      )
    }
    const canonicalPath = await realpath(path)
    const detected = await readNativeTranscript(canonicalPath)
    if (detected.format !== 'native')
      throw new Error(
        'Native resume transcript must use the Praxis transcript format',
      )
    if (detected.issue?.kind === 'unsupported-version')
      throw new Error('Native resume transcript version is unsupported')
    if (
      detected.issue ||
      !detected.newlineTerminated ||
      detected.records.length === 0
    )
      throw new Error(
        'Native resume transcript must be a complete non-empty newline-terminated file',
      )
    if (detected.records.some((record) => record.event.sessionId !== sessionId))
      throw new Error('Native resume transcript contains a different sessionId')
    this.explicitSessionFiles.set(sessionId, canonicalPath)
    this.discoveredProjectRoots.set(sessionId, dirname(canonicalPath))
    return {
      sessionId,
      lastPrompt: lastUserPrompt(
        detected.records.map((record) => record.event),
      ),
      updatedAt: detected.updatedAt,
      status: 'read-only',
      issue: detected.issue,
    }
  }

  async transcript(
    sessionId: string,
    resumeSessionAt?: string,
  ): Promise<TranscriptDisplayItem[]> {
    const file = await readNativeTranscript(this.paths(sessionId).sessionFile)
    if (file.format === 'native')
      return projectTranscriptDisplay(
        file.records.map((record) => record.event),
        resumeSessionAt,
      )
    throw new Error(
      `Native session transcript is not a native file: ${sessionId}`,
    )
  }

  async interruption(
    sessionId: string,
  ): Promise<ClaudeInterruptionClassification> {
    this.assertSessionPersistence()
    {
      const sessionPaths = this.paths(sessionId)
      const nativeTranscript = new NativeSessionTranscript({
        sessionId,
        store: new NativeTranscriptStore({
          transcriptFile: sessionPaths.sessionFile,
          lockFile: join(sessionPaths.praxisRoot, 'locks', `${sessionId}.lock`),
        }),
      })
      return nativeTranscript.withLease({ kind: 'resume' }, async (lease) => {
        const interruption = lease.interruption()
        if (
          interruption.kind === 'recoverable-tools' ||
          interruption.kind === 'indeterminate-tools'
        )
          return { kind: 'interrupted-turn' }
        if (interruption.kind === 'interrupted-prompt')
          return { kind: 'interrupted-prompt', prompt: interruption.prompt }
        return { kind: interruption.kind }
      })
    }
  }

  async metadata(sessionId: string): Promise<ClaudeSessionMetadata> {
    this.assertSessionPersistence()
    {
      const file = await readNativeTranscript(this.paths(sessionId).sessionFile)
      if (file.format === 'unsupported' || file.records.length === 0)
        throw new Error(`Native session not found: ${sessionId}`)
      const events = file.records.map((record) => record.event)
      const prompt = lastUserPrompt(events)
      const lastId = events.at(-1)?.id
      const metadata: ClaudeSessionMetadata = {
        ...(prompt === null ? {} : { lastPrompt: prompt }),
        ...(lastId === undefined ? {} : { lastPromptLeafUuid: lastId }),
      }
      for (const event of events) {
        if (event.kind !== 'messages') continue
        for (const message of event.messages) {
          if (message.role !== 'user' || typeof message.content !== 'string')
            continue
          const command = message.content.trim()
          let match = /^\/rename\s+(.+)$/u.exec(command)
          if (match?.[1]) metadata.customTitle = match[1].trim()
          match = /^\/tag\s+(.+)$/u.exec(command)
          if (match?.[1]) metadata.tag = match[1].trim()
          match = /^\/permission-mode\s+(.+)$/u.exec(command)
          if (match?.[1]) metadata.permissionMode = match[1].trim()
          match = /<praxis-agent-color>([^<]+)</u.exec(command)
          if (match?.[1]) {
            if (match[1] === AGENT_COLOR_DEFAULT) delete metadata.agentColor
            else metadata.agentColor = match[1]
          }
        }
      }
      return metadata
    }
  }

  async rename(sessionId: string, name: string): Promise<void> {
    this.assertWritable()
    const normalized = name.trim()
    if (!normalized) throw new Error('Session name must not be empty')
    await this.appendNativeCommand(sessionId, `/rename ${normalized}`)
  }

  async tag(sessionId: string, tag: string): Promise<void> {
    this.assertWritable()
    const normalized = tag.trim()
    await this.appendNativeCommand(sessionId, `/tag ${normalized}`)
  }

  async changeCwd(
    sessionId: string | undefined,
    requestedCwd: string,
    expectedCanonicalTarget?: string,
  ): Promise<string> {
    this.assertWritable()
    const previousCwd = this.activeCwd()
    let inspection: CwdInspection
    try {
      inspection = await this.inspectCwd(requestedCwd)
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes(' is not a directory.')
      )
        throw new Error(`Not a directory: ${requestedCwd}; ${error.message}`)
      throw error
    }
    const cwd = inspection.canonicalTarget
    if (
      expectedCanonicalTarget !== undefined &&
      cwd !== expectedCanonicalTarget
    ) {
      throw new Error(
        `Directory changed after approval: expected ${expectedCanonicalTarget}, resolved to ${cwd}. Review the target and try again.`,
      )
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
        const relocated = await sourceStore.withLease(
          async (lease: NativeTranscriptLease) => {
            const snapshot = await lease.load()
            if (snapshot.records.length === 0) {
              throw new Error(`Claude session not found: ${sessionId}`)
            }
            await mkdir(targetPaths.projectRoot, { recursive: true })
            const relocationId = randomUUID()
            const stagingFile = join(
              targetPaths.projectRoot,
              `.${sessionId}.${relocationId}.relocating`,
            )
            let publishedIdentity: { dev: number; ino: number } | undefined
            try {
              await copyFile(sourcePaths.sessionFile, stagingFile)
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
                const targetMetadata = await lstat(
                  targetPaths.sessionFile,
                ).catch(() => undefined)
                if (
                  targetMetadata?.dev === publishedIdentity.dev &&
                  targetMetadata.ino === publishedIdentity.ino
                ) {
                  await unlink(targetPaths.sessionFile).catch(() => undefined)
                }
              }
              throw error
            }
          },
        )
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
      await this.cwdChanged(sessionId, previousCwd, cwd)
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
      await this.cwdChanged(sessionId, previousCwd, cwd)
    }
    return cwd
  }

  async inspectCwd(requestedCwd: string): Promise<CwdInspection> {
    const current = await realpath(this.activeCwd())
    const expanded =
      requestedCwd === '~'
        ? homedir()
        : requestedCwd.startsWith('~/')
          ? join(homedir(), requestedCwd.slice(2))
          : requestedCwd
    const resolved = isAbsolute(expanded) ? expanded : join(current, expanded)
    let target: string
    try {
      target = await realpath(resolved)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new Error(`Could not find a directory at ${resolved}.`)
      throw error
    }
    const info = await stat(target)
    if (!info.isDirectory()) {
      throw new Error(
        `${target} is not a directory. Did you mean ${dirname(target)}?`,
      )
    }
    return {
      canonicalTarget: target,
      canonicalCurrentCwd: current,
      sameDirectory: target === current,
    }
  }

  async recordCdUsage(sessionId: string): Promise<void> {
    this.assertWritable()
    const transcript = new NativeSessionTranscript({
      sessionId,
      store: this.nativeStore(sessionId),
    })
    await transcript.withLease({ kind: 'resume' }, (lease) =>
      lease.appendMessages({
        messages: [
          {
            role: 'user',
            content: '<command-name>/cd</command-name>\nUsage: /cd <path>',
          },
        ],
      }),
    )
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
    return this.executeTurn({
      activation: { kind: 'resume', sessionId },
      submission: { kind: 'retry', prompt: '/permissions' },
      ...(signal ? { signal } : {}),
    })
  }

  async recordBtwUsage(
    sessionId: string | undefined,
    permissionMode: ClaudePermissionMode = 'default',
  ): Promise<string> {
    const activeSessionId = await this.ensureLocalSession(
      sessionId,
      permissionMode,
    )
    await this.appendNativeCommand(activeSessionId, '/btw')
    return activeSessionId
  }

  async recordColorUsage(
    sessionId: string | undefined,
    selection: AgentColorSelection,
    display: string,
    permissionMode: ClaudePermissionMode = 'default',
    options: { createSession?: boolean } = {},
  ): Promise<string> {
    const agentColor: AgentColorValue | undefined =
      selection.kind === 'color'
        ? selection.color
        : selection.kind === 'reset'
          ? AGENT_COLOR_DEFAULT
          : undefined
    const activeSessionId = await this.ensureLocalSession(
      sessionId,
      permissionMode,
      sessionId === undefined || options.createSession === true
        ? agentColor
        : undefined,
      options.createSession === true,
    )
    const transcript = new NativeSessionTranscript({
      sessionId: activeSessionId,
      store: this.nativeStore(activeSessionId),
    })
    await transcript.withLease({ kind: 'resume' }, (lease) =>
      lease.appendMessages({
        messages: [
          { role: 'user', content: display },
          ...(agentColor === undefined
            ? []
            : [
                {
                  role: 'user' as const,
                  content: `<praxis-agent-color>${agentColor}</praxis-agent-color>`,
                },
              ]),
        ],
      }),
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
    await this.appendNativeCommand(activeSessionId, '/background')
    return activeSessionId
  }

  async recordBackgroundLaunch(
    sessionId: string,
  ): Promise<SessionForkCheckpoint> {
    this.assertWritable()
    const snapshot = await this.store(sessionId).load()
    if (snapshot.records.length === 0)
      throw new Error(`Native session not found: ${sessionId}`)
    const resumeSessionAt = snapshot.tail.lastEventId
    if (!resumeSessionAt)
      throw new Error(`Native session not found: ${sessionId}`)
    await this.appendNativeCommand(sessionId, '/background')
    return { resumeSessionAt, entryCount: snapshot.records.length }
  }

  async compact(
    sessionId: string,
    signal?: AbortSignal,
    selection?: ManualCompactSelection,
  ): Promise<ManualCompactResult> {
    {
      this.assertSessionPersistence()
      const provider = this.provider()
      const sessionPaths = this.paths(sessionId)
      const nativeTranscript = new NativeSessionTranscript({
        sessionId,
        store: new NativeTranscriptStore({
          transcriptFile: sessionPaths.sessionFile,
          lockFile: join(sessionPaths.praxisRoot, 'locks', `${sessionId}.lock`),
        }),
      })
      return nativeTranscript.withLease(
        {
          kind: 'resume',
        },
        async (lease: NativeSessionTranscriptLease) => {
          const branchEvents = lease.activeEvents()
          let messages = lease.activeMessages()
          let preservedMessages: ModelMessage[] = []
          let logicalParentId: string | undefined
          let memorySelection: MemoryPreservedCompactSelection | null = null
          if (selection) {
            const targetIndex = branchEvents.findIndex(
              (event: TranscriptEvent) => event.id === selection.messageId,
            )
            if (targetIndex < 0)
              throw new Error(
                `No native rewind point found with event.id: ${selection.messageId}`,
              )
            const selectedEvents =
              selection.direction === 'from'
                ? branchEvents.slice(targetIndex)
                : branchEvents.slice(0, targetIndex)
            const suffixEvents =
              selection.direction === 'from'
                ? []
                : branchEvents.slice(targetIndex)
            const project = (events: typeof branchEvents): ModelMessage[] =>
              events.flatMap((event: TranscriptEvent) =>
                event.kind === 'messages' ? [...event.messages] : [],
              )
            messages = project(selectedEvents)
            preservedMessages = project(suffixEvents)
            logicalParentId = (
              selection.direction === 'from'
                ? branchEvents[targetIndex - 1]
                : branchEvents[targetIndex - 1]
            )?.id
          } else {
            memorySelection = await this.selectMemoryPreservedCompact(
              sessionId,
              projectNativeSessionEntries(branchEvents),
            )
            if (memorySelection) {
              messages = [
                memorySelection.memoryMessage,
                ...projectClaudeModelMessages(memorySelection.compactedEntries),
              ]
              preservedMessages = projectClaudeModelMessages(
                memorySelection.preservedEntries,
              )
              logicalParentId = memorySelection.logicalParentUuid
            }
          }
          if (messages.length === 0)
            throw new Error('Cannot compact an empty native transcript')
          // Do not create cost-state sidecars until the transcript has been
          // validated and a compactable message set exists.
          await this.activateSessionCostTracker(sessionId)
          const preTokens = estimateModelRequestTokens(messages)
          this.options.eventSink?.({ type: 'state', state: 'compacting' })
          const contextWindowTokens =
            this.contextBudget(provider)?.contextWindowTokens ??
            provider.capabilities.contextWindowTokens ??
            200_000
          const preCompact = await this.runAdvisoryHook(
            sessionId,
            'PreCompact',
            {
              trigger: 'manual',
              custom_instructions: selection?.context ?? null,
            },
            'manual',
            signal,
          )
          const compacted = await (
            this.options.compactor ?? new ModelCompactor(provider)
          ).compact({
            messages: [
              ...messages,
              ...(selection?.context
                ? [
                    {
                      role: 'user' as const,
                      content: `Additional summarization context: ${selection.context}`,
                    },
                  ]
                : []),
              ...successfulHookOutput(preCompact).map((content) => ({
                role: 'user' as const,
                content: `Additional summarization context: ${content}`,
              })),
            ],
            targetTokens: Math.min(
              8192,
              Math.max(1, Math.floor(contextWindowTokens / 4)),
            ),
            contextWindowTokens,
            ...(signal ? { signal } : {}),
          })
          if (signal?.aborted) throw new AgentRunCancelledError()
          const { durationMs, durationWithoutRetriesMs } =
            requireCompactionDurations(compacted)
          requireManualCompactUsage(compacted.usage)
          const compactModel =
            compacted.model !== undefined && compacted.model.trim() !== ''
              ? compacted.model
              : provider.model
          const meaningfulMetering =
            compacted.summary.trim().length > 0 &&
            (hasNonZeroUsage(compacted.usage) || durationMs > 0)
          if (
            meaningfulMetering &&
            (compactModel === undefined || compactModel.trim() === '')
          )
            throw new Error(
              'Manual compact usage requires a nonblank model identity',
            )
          const tracker = this.sessionCostTrackers.get(sessionId)
          if (!tracker)
            throw new Error(
              `Session cost tracker is not active for session ${sessionId}`,
            )
          let meteringTurnInput: ClaudeSessionTurnInput | undefined
          if (
            meaningfulMetering &&
            compactModel !== undefined &&
            compactModel.trim() !== ''
          ) {
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
              apiDurationMs: durationMs,
              apiDurationWithoutRetriesMs: durationWithoutRetriesMs,
            }
            const preflight = new ClaudeSessionCostTracker({
              sessionId,
              restored: tracker.snapshot(),
            })
            preflight.recordTurn(meteringTurnInput)
          }
          const postTokens = estimateModelRequestTokens([
            { role: 'user', content: compacted.summary },
          ])
          if (signal?.aborted) throw new AgentRunCancelledError()
          const ids = await lease.appendCompaction({
            summary: compacted.summary,
            trigger: 'manual',
            preTokens,
            postTokens,
            durationMs,
            ...(preservedMessages.length > 0 ? { preservedMessages } : {}),
            ...(logicalParentId === undefined ? {} : { logicalParentId }),
            ...(selection
              ? {
                  direction:
                    selection.direction === 'to'
                      ? ('up_to' as const)
                      : ('from' as const),
                  messagesSummarized: messages.length,
                  preservePrefix:
                    selection.direction === 'from' &&
                    branchEvents.findIndex(
                      (event: TranscriptEvent) =>
                        event.id === selection.messageId,
                    ) > 0,
                }
              : {}),
            ...(memorySelection
              ? {
                  direction: 'from' as const,
                  messagesSummarized: messages.length,
                  preservePrefix: false,
                }
              : {}),
          })
          if (meteringTurnInput !== undefined)
            tracker.recordTurn(meteringTurnInput)
          await this.runAdvisoryHook(
            sessionId,
            'PostCompact',
            { trigger: 'manual', compact_summary: compacted.summary },
            'manual',
            signal,
          )
          this.options.eventSink?.({
            type: 'compact-boundary',
            trigger: 'manual',
            preTokens,
            uuid: ids.boundaryId,
          })
          return {
            summary: compacted.summary,
            usage: compacted.usage,
            preTokens,
            messagesSummarized: messages.length,
          }
        },
      )
    }
  }

  async fork(
    parentSessionId: string,
    sessionId: string = randomUUID(),
    resumeSessionAt?: string,
  ): Promise<ForkResult> {
    {
      this.assertSessionPersistence()
      const sourcePaths = this.paths(parentSessionId)
      const targetPaths = this.paths(sessionId)
      const source = new NativeSessionTranscript({
        sessionId: parentSessionId,
        store: new NativeTranscriptStore({
          transcriptFile: sourcePaths.sessionFile,
          lockFile: join(
            sourcePaths.praxisRoot,
            'locks',
            `${parentSessionId}.lock`,
          ),
        }),
      })
      const target = new NativeSessionTranscript({
        sessionId,
        store: new NativeTranscriptStore({
          transcriptFile: targetPaths.sessionFile,
          lockFile: join(targetPaths.praxisRoot, 'locks', `${sessionId}.lock`),
        }),
      })
      await source.forkTo(target, {
        ...(resumeSessionAt === undefined
          ? {}
          : { atEventId: resumeSessionAt }),
        ensureExisting: false,
      })
      this.options.contextAssembler?.invalidate?.({
        lifecycleId: sessionId,
        reason: 'fork',
      })
      return { sessionId, parentSessionId }
    }
  }

  async ensureFork(
    parentSessionId: string,
    sessionId: string,
    checkpoint?: SessionForkCheckpoint,
  ): Promise<ForkResult> {
    {
      this.assertSessionPersistence()
      const sourcePaths = this.paths(parentSessionId)
      const targetPaths = this.paths(sessionId)
      const source = new NativeSessionTranscript({
        sessionId: parentSessionId,
        store: new NativeTranscriptStore({
          transcriptFile: sourcePaths.sessionFile,
          lockFile: join(
            sourcePaths.praxisRoot,
            'locks',
            `${parentSessionId}.lock`,
          ),
        }),
      })
      const target = new NativeSessionTranscript({
        sessionId,
        store: new NativeTranscriptStore({
          transcriptFile: targetPaths.sessionFile,
          lockFile: join(targetPaths.praxisRoot, 'locks', `${sessionId}.lock`),
        }),
      })
      await source.forkTo(target, {
        ...(checkpoint?.resumeSessionAt === undefined
          ? {}
          : { atEventId: checkpoint.resumeSessionAt }),
        ...(checkpoint?.entryCount === undefined
          ? {}
          : { recordCount: checkpoint.entryCount }),
        ensureExisting: true,
      })
      this.options.contextAssembler?.invalidate?.({
        lifecycleId: sessionId,
        reason: 'fork',
      })
      return { sessionId, parentSessionId }
    }
  }

  async rewindFiles(sessionId: string, userMessageId: string): Promise<void> {
    const transcript = new NativeSessionTranscript({
      sessionId,
      store: this.store(sessionId),
    })
    await transcript.withLease({ kind: 'resume' }, async (lease) => {
      const projected = projectNativeSessionEntries(
        lease.activeEvents(),
      ).filter(
        (entry) =>
          entry.type === 'file-history-snapshot' ||
          entry.type === 'file-history-delta',
      )
      if (projected.length === 0)
        throw new Error(`Native session has no file history: ${sessionId}`)
      // FileHistory operates on its historical projection and requires the
      // target user message to be present by UUID. Native messages carry
      // that identity as the event id, so provide a minimal projected user
      // entry for the requested native checkpoint.
      projected.unshift({
        type: 'user',
        uuid: userMessageId,
        message: { role: 'user', content: '' },
      })
      await new ClaudeFileHistory(this.options.configRoot, sessionId, [
        this.activeCwd(),
        ...(this.options.fileRewindRoots ?? []),
      ]).rewind(projected, userMessageId)
    })
  }

  async rewindPoints(sessionId: string): Promise<RewindPoint[]> {
    const transcript = new NativeSessionTranscript({
      sessionId,
      store: this.store(sessionId),
    })
    return transcript.withLease({ kind: 'resume' }, async (lease) => {
      const events = lease.activeEvents()
      const snapshots = new Set<string>()
      const changes = new Map<string, Set<string>>()
      const snapshotKeyToPrompt = new Map<string, string>()
      let lastPromptId: string | undefined
      for (const event of events) {
        if (event.kind !== 'messages') continue
        for (const message of event.messages) {
          if (
            message.role === 'user' &&
            typeof message.content === 'string' &&
            !message.content.startsWith('<praxis-file-history>')
          ) {
            lastPromptId = event.id
            continue
          }
          if (message.role !== 'user' || typeof message.content !== 'string')
            continue
          const match = message.content.match(
            /^<praxis-file-history>([\s\S]*)<\/praxis-file-history>$/u,
          )
          if (!match?.[1]) continue
          try {
            const value = JSON.parse(match[1]) as Record<string, unknown>
            if (
              value.type === 'file-history-snapshot' &&
              typeof value.messageId === 'string' &&
              lastPromptId
            ) {
              snapshots.add(lastPromptId)
              snapshotKeyToPrompt.set(value.messageId, lastPromptId)
            }
            if (
              value.type === 'file-history-delta' &&
              typeof value.snapshotMessageId === 'string' &&
              typeof value.trackingPath === 'string'
            ) {
              const promptId =
                snapshotKeyToPrompt.get(value.snapshotMessageId) ??
                value.snapshotMessageId
              const paths = changes.get(promptId) ?? new Set<string>()
              paths.add(value.trackingPath)
              changes.set(promptId, paths)
            }
          } catch {
            // Malformed operational markers are ignored; native transcript
            // validation remains authoritative.
          }
        }
      }
      const points: RewindPoint[] = []
      let branchMessageId: string | undefined
      for (const event of events) {
        if (event.kind !== 'messages') continue
        for (const message of event.messages) {
          if (message.role === 'user' && message.content.trim() !== '') {
            const isOperational =
              message.content.startsWith('<bash-input>') ||
              message.content.startsWith('<local-command-') ||
              message.content.startsWith('<command-name>') ||
              message.content.startsWith('<praxis-file-history>')
            if (!isOperational) {
              points.push({
                messageId: event.id,
                prompt: message.content,
                timestamp: event.timestamp,
                ...(branchMessageId === undefined ? {} : { branchMessageId }),
                fileChanges: [...(changes.get(event.id) ?? [])],
                fileRestoreAvailable: snapshots.has(event.id),
              })
            }
            branchMessageId = event.id
          } else if (message.role === 'assistant') {
            branchMessageId = event.id
          }
        }
      }
      return points
    })
  }

  async setPermissionMode(
    sessionId: string,
    permissionMode: ClaudePermissionMode,
  ): Promise<void> {
    this.assertSessionPersistence()
    this.assertWritable()
    await this.appendNativeCommand(
      sessionId,
      `/permission-mode ${permissionMode}`,
    )
    await this.options.interactiveTools?.setMode(sessionId, permissionMode)
  }

  private async activateSessionCostTracker(sessionId: string): Promise<void> {
    if (this.activeCostSessionId === sessionId) return
    const store = this.options.costStateStore
    if (store) {
      // Load the target native state before any save so the single
      // Native state slot is not overwritten before it is read.
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
    if (existing) {
      return this.withDetachedSubagentUsage(sessionId, existing.snapshot())
    }
    const store = this.options.costStateStore
    const loaded = store ? await store.load(sessionId) : null
    const tracker = new ClaudeSessionCostTracker({
      sessionId,
      ...(loaded ? { restored: loaded } : {}),
    })
    this.sessionCostTrackers.set(sessionId, tracker)
    return this.withDetachedSubagentUsage(sessionId, tracker.snapshot())
  }

  private async withDetachedSubagentUsage(
    sessionId: string,
    base: ClaudeSessionCostSnapshot,
  ): Promise<ClaudeSessionCostSnapshot> {
    const tracker = new ClaudeSessionCostTracker({
      sessionId,
      restored: base,
    })
    const directory = join(
      this.paths(sessionId).praxisRoot,
      'subagent-lifecycle',
      sessionId,
    )
    let entries: string[]
    try {
      entries = await readdir(directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return base
      throw error
    }
    for (const file of entries) {
      const agentId = file.endsWith('.json') ? file.slice(0, -5) : ''
      if (!isClaudeAgentId(agentId)) continue
      try {
        const lifecycle = await new SubagentLifecycleStore(
          this.paths(sessionId).praxisRoot,
          sessionId,
          agentId,
        ).read()
        for (const notification of lifecycle?.notifications ?? []) {
          if (
            notification.accounting?.kind !== 'detached' ||
            !notification.accounting.delivered ||
            notification.result === null
          ) {
            continue
          }
          const rows = Object.entries(
            notification.result.modelUsage ?? {
              [notification.accounting.model]: notification.result.usage,
            },
          )
          if (rows.length === 0) {
            tracker.recordDurations({
              ...(notification.result.durationApiMs === undefined
                ? {}
                : { apiDurationMs: notification.result.durationApiMs }),
              ...(notification.result.durationApiWithoutRetriesMs === undefined
                ? {}
                : {
                    durationApiWithoutRetriesMs:
                      notification.result.durationApiWithoutRetriesMs,
                  }),
            })
            continue
          }
          for (const [index, [model, usage]] of rows.entries()) {
            const pricing = this.options.pricing?.resolve(model)
            const costUsd = pricing ? usageCostUsd(usage, pricing) : undefined
            tracker.recordTurn({
              model,
              usage,
              ...(costUsd === undefined ? {} : { costUsd }),
              ...(usage.webSearchRequests === undefined
                ? {}
                : { webSearchRequests: usage.webSearchRequests }),
              ...(index === 0
                ? {
                    apiDurationMs: notification.result.durationApiMs,
                    apiDurationWithoutRetriesMs:
                      notification.result.durationApiWithoutRetriesMs,
                  }
                : {}),
            })
          }
        }
      } catch (error) {
        this.options.eventSink?.({
          type: 'warning',
          message: `Could not account detached subagent ${agentId}: ${error instanceof Error ? error.message : String(error)}`,
        })
      }
    }
    return tracker.snapshot()
  }

  private async executeTurn(request: TurnRequest): Promise<SessionRunResult> {
    const { activation, submission, signal } = request
    const sessionId = activation.sessionId
    const requireExisting = activation.kind === 'resume'
    const name = activation.name
    const resumeSessionAt =
      activation.kind === 'resume' ? activation.atMessageId : undefined
    const prompt =
      submission.kind === 'shell'
        ? `! ${submission.command}`
        : submission.kind === 'retry'
          ? submission.prompt
          : submission.text
    const images = submission.kind === 'prompt' ? (submission.images ?? []) : []
    const documents =
      submission.kind === 'prompt' ? (submission.documents ?? []) : []
    const shellCommand =
      submission.kind === 'shell' ? submission.command : undefined
    const skipUserPrompt = submission.kind === 'retry'
    const controller = new TurnTerminalController(
      this.options.eventSink ?? (() => undefined),
    )
    let activeTurnInput: ActiveTurnInputMailbox | undefined
    let activeTurnRecord:
      { readonly mailbox?: ActiveTurnInputMailbox } | undefined
    try {
      this.assertTurnWritable()
      if (prompt.length === 0 && images.length === 0 && documents.length === 0)
        throw new Error('Prompt must not be empty')
      if (name !== undefined && name.length === 0) {
        throw new Error('Session name must not be empty')
      }
      if (shellCommand !== undefined && shellCommand.trim().length === 0) {
        throw new Error('Shell command must not be empty')
      }
      if (this.activeTurnInputs.has(sessionId)) {
        throw new Error(
          `conflict: locked (session ${sessionId} already has an active turn)`,
        )
      }
      activeTurnRecord =
        shellCommand === undefined
          ? {
              mailbox: (activeTurnInput = new ActiveTurnInputMailbox(
                randomUUID,
              )),
            }
          : {}
      this.activeTurnInputs.set(sessionId, activeTurnRecord)

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
        // Native paths are canonical.
      }
      const sessionPaths = this.paths(sessionId)
      const toolResultDirectory = join(
        sessionPaths.projectRoot,
        sessionId,
        'tool-results',
      )
      const runUnderLease = async (
        lease: NativeTranscriptLease,
        nativeLease: NativeSessionTranscriptLease,
      ): Promise<SessionRunResult> => {
        const loadedSnapshot = await lease.load()
        let snapshot = {
          entries: projectNativeSessionEntries(nativeLease.activeEvents()),
          tail: loadedSnapshot.tail,
        }
        const activeTurnMessages = (): ModelMessage[] => {
          // Native events remain authoritative; refresh the derived projection
          // after each append so memory/compaction sees the live branch.
          snapshot = {
            ...snapshot,
            entries: projectNativeSessionEntries(nativeLease.activeEvents()),
          }
          return nativeLease.activeMessages()
        }
        if (
          nativeLease &&
          name !== undefined &&
          this.options.sessionPersistence !== false
        ) {
          const marker = `<praxis-session-name>${name}</praxis-session-name>`
          if (
            !nativeLease
              .activeEvents()
              .some(
                (event) =>
                  event.kind === 'messages' &&
                  event.messages.some(
                    (message) =>
                      message.role === 'user' && message.content === marker,
                  ),
              )
          ) {
            await nativeLease.appendMessages({
              messages: [{ role: 'user', content: marker }],
            })
          }
        }
        const nativeInterruption = nativeLease?.interruption()
        if (nativeInterruption?.kind === 'indeterminate-tools')
          throw new Error(
            `Native tool execution is indeterminate: ${nativeInterruption.callIds.join(', ')}`,
          )
        const nativeResumeInterrupted =
          nativeLease !== undefined &&
          this.options.resumeInterruptedTurn === true &&
          (nativeInterruption?.kind === 'interrupted-prompt' ||
            nativeInterruption?.kind === 'interrupted-turn')
        const shouldSkipUserPrompt = () =>
          skipUserPrompt || nativeResumeInterrupted
        let automaticReplayPrompt: string | undefined
        if (
          requireExisting &&
          resumeSessionAt === undefined &&
          this.options.resumeInterruptedTurn === true &&
          shellCommand === undefined &&
          !shouldSkipUserPrompt() &&
          !(
            this.options.approveRecovery !== undefined &&
            findUnresolvedClaudeToolCalls(snapshot.entries).length > 0
          )
        ) {
          const interruption = classifyClaudeInterruption(snapshot.entries)
          if (
            (interruption.kind === 'interrupted-prompt' ||
              interruption.kind === 'interrupted-turn') &&
            interruption.prompt !== undefined &&
            interruption.replayEntries !== undefined
          ) {
            automaticReplayPrompt = interruption.prompt
            snapshot = {
              entries: interruption.replayEntries,
              tail: {
                ...snapshot.tail,
                branchParentId: interruption.replayParentUuid ?? null,
              },
            }
          }
        }
        const initialTransition =
          this.worktreeManager?.consumeTransition('__initial__')
        if (initialTransition && snapshot.entries.length === 0) {
          const stateEntry: NativeTranscriptEntry = {
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
          const appendResult = await this.appendProjectionMany(
            snapshot.tail,
            entries,
          )
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
          automaticReplayPrompt ??
          (!requireExisting &&
          !shouldSkipUserPrompt() &&
          !this.options.agentInitialPromptHandledExternally &&
          shellCommand === undefined &&
          agent?.initialPrompt
            ? `${agent.initialPrompt}\n\n${prompt}`
            : prompt)
        const sessionMemory = this.sessionMemoryController(sessionId)
        const turnMemory = new TurnMemoryCoordinator({
          sessionId,
          ...(sessionMemory ? { session: sessionMemory } : {}),
          ...(this.options.projectMemoryRecall
            ? { projectRecall: this.options.projectMemoryRecall }
            : {}),
          ...(this.options.projectMemoryExtraction
            ? { projectExtraction: this.options.projectMemoryExtraction }
            : {}),
          warn: (message) =>
            this.options.eventSink?.({ type: 'warning', message }),
        })
        if (!shouldSkipUserPrompt() && shellCommand === undefined) {
          turnMemory.prefetch({
            turnId: randomUUID(),
            prompt: effectivePrompt,
            ...(signal ? { signal } : {}),
          })
        }
        const initialPricing = this.options.pricing?.resolve(
          provider.model ?? 'praxis/provider',
        )
        if (
          shellCommand === undefined &&
          this.options.maxBudgetUsd !== undefined &&
          !initialPricing
        ) {
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
        const unresolvedToolCalls = nativeLease
          ? nativeInterruption?.kind === 'recoverable-tools'
            ? [...nativeInterruption.calls]
            : []
          : findUnresolvedClaudeToolCalls(snapshot.entries)
        const pendingRecoveryToolCallIds = new Set(
          unresolvedToolCalls.map((call) => call.id),
        )
        const pendingRecoveryHookOutcomes: ClaudeHookOutcome[] = []
        let refreshRuntimeContext: (() => Promise<void>) | undefined
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
            if (nativeLease) {
              const attachment = entry.attachment as
                Record<string, unknown> | undefined
              const raw = attachment?.content
              const content =
                typeof raw === 'string'
                  ? raw
                  : Array.isArray(raw)
                    ? raw
                        .filter((value) => typeof value === 'string')
                        .join('\n')
                    : raw && typeof raw === 'object' && 'content' in raw
                      ? String((raw as { content: unknown }).content)
                      : ''
              if (content) {
                await nativeLease.appendMessages({
                  messages: [{ role: 'user', content }],
                })
              }
            }
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
          const entries: NativeTranscriptEntry[] = []
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
          const appendResult = await this.appendProjectionMany(
            snapshot.tail,
            entries,
          )
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
                ...(this.options.hooks
                  ? {
                      taskHooks: {
                        created: async (task, taskSignal) => {
                          const outcome = await this.options.hooks?.run(
                            {
                              ...hookSession,
                              hook_event_name: 'TaskCreated',
                              task_id: task.id,
                              task_subject: task.subject,
                              task_description: task.description,
                            },
                            undefined,
                            taskSignal,
                          )
                          if (!outcome) return
                          await recordHookOutcome(outcome)
                          if (outcome.blockedReason) {
                            throw new Error(
                              `TaskCreated hook error: ${outcome.blockedReason}`,
                            )
                          }
                        },
                        completed: async (task, taskSignal) => {
                          const outcome = await this.options.hooks?.run(
                            {
                              ...hookSession,
                              hook_event_name: 'TaskCompleted',
                              task_id: task.id,
                              task_subject: task.subject,
                              task_description: task.description,
                            },
                            undefined,
                            taskSignal,
                          )
                          if (!outcome) return
                          await recordHookOutcome(outcome)
                          if (outcome.blockedReason) {
                            throw new Error(
                              `TaskCompleted hook error: ${outcome.blockedReason}`,
                            )
                          }
                        },
                      },
                    }
                  : {}),
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
                dataPlane: 'native',
                cwd: this.activeCwd(),
                cwdProvider: () => this.activeCwd(),
                claudeVersion: this.options.claudeVersion,
                provider,
                persistence:
                  this.options.sessionPersistence === false ? 'memory' : 'disk',
                ...(this.options.experimentalNativeTranscriptWrites === true
                  ? { experimentalNativeTranscriptWrites: true }
                  : {}),
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
                notificationDelivered: (notification) =>
                  transcriptContainsBackgroundAgentNotification(
                    snapshot.entries,
                    notification,
                  ),
                stopOwnedBackgroundAgent: (ownerSessionId, agentId) =>
                  this.backgroundTasks.stopAgent(ownerSessionId, agentId),
                outputOwnedBackgroundAgent: (
                  ownerSessionId,
                  agentId,
                  options,
                ) =>
                  this.backgroundTasks.outputAgent(
                    ownerSessionId,
                    agentId,
                    options,
                  ),
                sendOwnedBackgroundAgent: (
                  ownerSessionId,
                  agentId,
                  message,
                  summary,
                  toolUseId,
                ) =>
                  this.sendOwnedBackgroundAgent(
                    ownerSessionId,
                    agentId,
                    message,
                    summary,
                    toolUseId,
                  ),
              })
            : null
        if (subagentExecutor) {
          this.subagentExecutors.add(subagentExecutor)
          this.subagentExecutorSessions.set(subagentExecutor, sessionId)
          this.backgroundTasks.registerAgents(sessionId, subagentExecutor)
        }
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
                dataPlane: 'native',
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
                    result = await interactiveMessageTools.execute(
                      call,
                      context,
                    )
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
                    if (nativeLease) {
                      await nativeLease.appendMessages({
                        messages: [
                          {
                            role: 'user',
                            content: `<praxis-file-history>${JSON.stringify(entry)}</praxis-file-history>`,
                          },
                        ],
                      })
                    }
                  }
                  return result
                },
              }
            : interactiveMessageTools
        const capabilityTools = fileHistoryTools
          ? new ClaudeCapabilityToolRegistry(
              this.teamRegistry(
                fileHistoryTools,
                sessionId,
                this.capabilityToolNames(
                  this.options.teamToolNames,
                  capabilities,
                ),
              ),
              capabilities,
            )
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
                ...(this.options.eventSink
                  ? {
                      warn: (message: string) =>
                        this.options.eventSink?.({
                          type: 'warning',
                          message,
                        }),
                    }
                  : {}),
                deferPreToolUseOutcome: (call) =>
                  pendingRecoveryToolCallIds.has(call.id),
              })
            : null
        const runtime = new AgentRuntime(provider, controller.emit, {
          emitInitialContextState: false,
          ...(this.options.emitToolUseSummaries
            ? {
                generateToolUseSummary: ({
                  tools,
                  lastAssistantText,
                  signal: summarySignal,
                }) =>
                  generateToolUseSummary(
                    provider,
                    tools,
                    summarySignal,
                    lastAssistantText,
                    (metrics) =>
                      this.recordAuxiliaryMetrics(sessionId, metrics),
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
        let observeModelRequestUsage: (input: {
          usage: ModelUsage
          messages: readonly ModelMessage[]
          tools: readonly ModelToolDefinition[]
        }) => void = () => undefined
        const durableFollowUps = new DurableFollowUpTracker()
        const claimedToolCallIds = new Set<string>()
        const observer = {
          ...(nativeLease
            ? {
                toolExecutionStarted: async (call: ModelToolCall) => {
                  await nativeLease.beginToolExecution(call.id)
                  claimedToolCallIds.add(call.id)
                },
              }
            : {}),
          modelRequestCompleted: async (input: {
            usage: ModelUsage
            messages: readonly ModelMessage[]
            tools: readonly ModelToolDefinition[]
          }) => {
            observeModelRequestUsage(input)
          },
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
            if (!entry)
              throw new Error('Could not translate assistant response')
            const tail = await this.append(lease, snapshot.tail, entry)
            snapshot = { entries: [...snapshot.entries, entry], tail }

            lastAssistantUuid = nativeLease
              ? await nativeLease.appendMessages({
                  messages: [
                    {
                      role: 'assistant',
                      content: message.content,
                      ...(message.thinkingBlocks?.length
                        ? { thinkingBlocks: message.thinkingBlocks }
                        : {}),
                      ...(message.toolCalls?.length
                        ? { toolCalls: message.toolCalls }
                        : {}),
                    },
                  ],
                  model: provider.model ?? 'praxis/provider',
                })
              : typeof entry.uuid === 'string'
                ? entry.uuid
                : lastAssistantUuid
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
              const stateEntry: NativeTranscriptEntry = {
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
              const modeEntry: NativeTranscriptEntry = {
                type: 'permission-mode',
                permissionMode,
                sessionId,
              }
              const modeTail = await this.append(
                lease,
                snapshot.tail,
                modeEntry,
              )
              snapshot = {
                entries: [...snapshot.entries, modeEntry],
                tail: modeTail,
              }
              if (nativeLease) {
                await nativeLease.appendMessages({
                  messages: [
                    {
                      role: 'user',
                      content: `/permission-mode ${permissionMode}`,
                    },
                  ],
                })
              }
              // Interactive mode transitions change the runtime system
              // context for the very next provider request. Refresh here so
              // an EnterPlanMode/ExitPlanMode tool call is immediately
              // reflected in the native execution path.
              if (typeof refreshRuntimeContext === 'function')
                await refreshRuntimeContext()
            }
            if (nativeLease) {
              if (!claimedToolCallIds.has(call.id) && !signal?.aborted) {
                await nativeLease.beginToolExecution(call.id)
                claimedToolCallIds.add(call.id)
              }
              await nativeLease.appendToolCompletion({
                callId: call.id,
                result: toolResult,
              })
            } else {
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
            }

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
                  turnMemory.recordRead(path)
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
                    turnMemory.recordRead(resolvedAccessedPath)
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
                if (nativeLease) {
                  const ruleContent = rule.content.trim()
                  if (ruleContent.length > 0) {
                    await nativeLease.appendMessages({
                      messages: [{ role: 'user', content: ruleContent }],
                    })
                  }
                }
                attachedRulePaths.add(rule.path)
                await this.instructionLoaded(
                  sessionId,
                  {
                    path: rule.path,
                    memoryType:
                      rule.scope === 'user'
                        ? 'User'
                        : rule.scope === 'local'
                          ? 'Local'
                          : 'Project',
                    globs: rule.globs,
                    triggerFilePath: filePath,
                    ...(rule.importedFrom === undefined
                      ? {}
                      : { parentFilePath: rule.importedFrom }),
                  },
                  'path_glob_match',
                )
              }
            }
          },
          followUpUserMessagesCompleted: async (
            messages: readonly string[],
          ) => {
            for (const content of messages) {
              if (nativeLease) {
                await nativeLease.appendMessages({
                  messages: [{ role: 'user', content }],
                })
                currentTurnUserMessages?.push(content)
                await Promise.all(
                  this.sessionSubagentExecutors(sessionId, true).map(
                    (executor) => executor.acknowledgeNotifications([content]),
                  ),
                )
                continue
              }
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
              await Promise.all(
                this.sessionSubagentExecutors(sessionId, true).map((executor) =>
                  executor.acknowledgeNotifications([content]),
                ),
              )
            }
            await durableFollowUps.followUpUserMessagesCompleted(messages)
          },
          userInputDelivered: async (item: SteeringItem) => {
            if (nativeLease) {
              await nativeLease.appendMessages({
                messages: [{ role: 'user', content: item.content }],
              })
              currentTurnUserMessages?.push(item.content)
              return
            }
            const [steeringEntry] = translateProviderEvents(
              [{ type: 'user-text-block', text: item.content }],
              this.translationContext(sessionId, snapshot),
            )
            if (!steeringEntry)
              throw new Error('Could not translate steering message')
            const steeringTail = await this.append(
              lease,
              snapshot.tail,
              steeringEntry,
            )
            snapshot = {
              entries: [...snapshot.entries, steeringEntry],
              tail: steeringTail,
            }
            currentTurnUserMessages?.push(item.content)
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
            await recordHookOutcome(
              outcome,
              pendingRecoveryToolCallIds.size > 0,
            )
          }
          const approveRecovery = this.options.approveRecovery
          const recoveryRequest = {
            cwd: this.activeCwd(),
            toolResultDirectory,
            messages: activeTurnMessages(),
            observer,
            permissionUpdates:
              this.sessionPermissionUpdates.get(sessionId) ?? [],
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
          if (
            unresolvedToolCall &&
            !unresolvedToolCalls.every(
              (call) =>
                (call as ModelToolCall).inputError?.kind === 'malformed_json' &&
                (call as ModelToolCall).inputError?.message ===
                  MALFORMED_TOOL_INPUT_MESSAGE,
            ) &&
            !approveRecovery
          ) {
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
            if (nativeLease) {
              await nativeLease.appendMessages({
                messages: [
                  {
                    role: 'user',
                    content: `<praxis-agent-setting>${this.options.agent}</praxis-agent-setting>`,
                  },
                ],
              })
            }
          }

          let agentSystem: string | null = null
          let planModeMessage: string | null | undefined
          let sessionMemoryMessage: string | null = null
          let contextMessages: ModelMessage[] = []
          let contextProjection: ContextProjection = {
            systemMessages: [],
            stableSystemSectionCount: 0,
          }
          let stableSystemMessageCount = 0
          refreshRuntimeContext = async () => {
            agentSystem = await this.mainAgentSystemPrompt(agent)
            planModeMessage =
              this.options.interactiveTools?.contextMessage(sessionId)
            // DEBUG_PLAN_CONTEXT
            sessionMemoryMessage = this.sessionMemoryMessage(
              await turnMemory.sessionSummary(),
            )
            const assembledContext = await assembleContextSnapshot(
              this.options.contextAssembler,
              {
                cwd: this.activeCwd(),
                lifecycleId: sessionId,
                ...(agentSystem
                  ? { mode: 'agent', baseSystemPrompt: agentSystem }
                  : {}),
                turn: {
                  ...(planModeMessage ? { planMode: planModeMessage } : {}),
                  ...(sessionMemoryMessage
                    ? { sessionMemory: sessionMemoryMessage }
                    : {}),
                  ...(this.options.brief ? { briefOutput: true } : {}),
                  ...(this.options.structuredOutputSchema
                    ? { structuredOutput: true }
                    : {}),
                },
              },
            )
            contextProjection = projectContextSnapshot(assembledContext)
            stableSystemMessageCount =
              contextProjection.stableSystemSectionCount
            contextMessages = [...contextProjection.systemMessages]
          }
          await refreshRuntimeContext()

          const expansion = shouldSkipUserPrompt()
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
          const expansionMessages =
            'messages' in expansion ? expansion.messages : undefined
          const userMessages =
            'userMessages' in expansion ? expansion.userMessages : []
          const expandedMessages: readonly ClaudePromptExpansionMessage[] =
            expansionMessages ?? userMessages.map((text) => ({ text }))
          const attachmentIndex = expansionMessages
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
          const contextEngine = new ContextEngine({
            ...(budget ? { budget } : {}),
            autoCompact: this.options.autoCompact !== false,
            memory: {
              beforeCompact: () => turnMemory.beforeCompact(),
              afterCompact: () => turnMemory.afterCompact(),
            },
          })
          observeModelRequestUsage = ({ usage, messages, tools }) => {
            contextEngine.observeUsage(usage, messages, tools)
          }
          const pendingUserMessages = expandedMessages.map(
            (message, index) => ({
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
            }),
          )
          const agentMentionMessages =
            shellCommand === undefined && !shouldSkipUserPrompt()
              ? (this.options.extensions?.agentMentionMessages(
                  effectivePrompt,
                ) ?? [])
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
              contextProjection.firstUserMessageContext,
            )
          const injectTurnContext = (
            messages: readonly ModelMessage[],
          ): ModelMessage[] =>
            injectAgentMentionContext(injectDynamicContext(messages))
          let compactionAnchorUuid = this.lastMessageUuid(snapshot.entries)
          const contextTransitionPort = (
            pendingMessages: readonly {
              role: 'user'
              content: string
            }[] = [],
            preservedUserMessages: readonly string[] = [],
          ) => ({
            current: () => {
              const historyMessages = [
                ...activeTurnMessages(),
                ...projectMemoryRecallMessages,
              ]
              return {
                messages: [
                  ...contextMessages,
                  ...injectTurnContext([
                    ...historyMessages,
                    ...pendingMessages,
                  ]),
                ],
                tools: definitions,
              }
            },
            irreducible: () => ({
              messages: [
                ...contextMessages,
                ...injectTurnContext([
                  ...pendingMessages,
                  ...preservedUserMessages.map((content) => ({
                    role: 'user' as const,
                    content,
                  })),
                ]),
              ],
              tools: definitions,
            }),
            propose: async () => {
              const activeNativeLease = nativeLease
              if (!budget) throw new Error('Context budget is unavailable')
              const historyMessages = activeTurnMessages()
              if (historyMessages.length === 0)
                throw new Error('Cannot compact an empty native transcript')
              if (unresolvedActiveToolCallIds(historyMessages).length > 0)
                throw new Error(
                  'Cannot compact a native transcript with unresolved tool calls',
                )
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
              let compactableMessages = historyMessages
              let preservedMessages: ModelMessage[] = []
              let compactionLogicalParentId: string | undefined
              if (preservedUserMessages.length > 0) {
                let searchFrom = historyMessages.length
                const matchedIndexes: number[] = []
                for (
                  let markerIndex = preservedUserMessages.length - 1;
                  markerIndex >= 0;
                  markerIndex -= 1
                ) {
                  const marker = preservedUserMessages[markerIndex]
                  let found = -1
                  for (let index = searchFrom - 1; index >= 0; index -= 1) {
                    const message = historyMessages[index]
                    if (
                      message?.role === 'user' &&
                      message.content === marker
                    ) {
                      found = index
                      break
                    }
                  }
                  if (found < 0)
                    throw new Error(
                      'Native automatic compaction could not match the current-turn suffix',
                    )
                  matchedIndexes.push(found)
                  searchFrom = found
                }
                const earliest = Math.min(...matchedIndexes)
                const promptContents = new Set(preservedUserMessages)
                // Preserve the complete current-turn suffix for replay, but
                // also feed its non-prompt context (hook output, assistant
                // tool calls, and tool results) to the compactor.
                preservedMessages = historyMessages.slice(earliest)
                compactableMessages = [
                  ...historyMessages.slice(0, earliest),
                  ...historyMessages
                    .slice(earliest)
                    .filter(
                      (message) =>
                        message.role !== 'user' ||
                        !promptContents.has(message.content),
                    ),
                ]
                if (earliest === 0 && preservedUserMessages[0] !== undefined) {
                  compactionLogicalParentId = activeNativeLease
                    .activeEvents()
                    .find(
                      (event) =>
                        event.kind === 'messages' &&
                        event.messages.some(
                          (message) =>
                            message.role === 'user' &&
                            message.content === preservedUserMessages[0],
                        ),
                    )?.id
                }
              }
              const memorySelection = sessionMemory
                ? await this.selectMemoryPreservedCompact(
                    sessionId,
                    projectNativeSessionEntries(
                      activeNativeLease.activeEvents(),
                    ),
                  )
                : null
              if (memorySelection) {
                compactableMessages = [
                  memorySelection.memoryMessage,
                  ...projectClaudeModelMessages(
                    memorySelection.compactedEntries,
                  ),
                ]
                preservedMessages = projectClaudeModelMessages(
                  memorySelection.preservedEntries,
                )
                compactionLogicalParentId = memorySelection.logicalParentUuid
              }
              // A completed tool turn can itself exceed the context budget
              // before a subsequent model request. In that case there is
              // no prior prefix to preserve, but the completed history is
              // still a valid compactable set.
              if (compactableMessages.length === 0) {
                compactableMessages = historyMessages
                // Keep user prompts available as the replayable suffix;
                // tool/assistant payloads remain summarized.
                preservedMessages = historyMessages.filter(
                  (message) => message.role === 'user',
                )
                const anchor = preservedMessages[0]
                if (anchor !== undefined) {
                  compactionLogicalParentId = nativeLease
                    .activeEvents()
                    .find(
                      (event) =>
                        event.kind === 'messages' &&
                        event.messages.some(
                          (message) =>
                            message.role === 'user' &&
                            message.content === anchor.content,
                        ),
                    )?.id
                }
              }
              this.options.eventSink?.({ type: 'state', state: 'compacting' })
              const preTokens = estimateModelRequestTokens(compactableMessages)
              const compactEnvelope = budget.evaluate(
                [
                  ...irreducibleMessages,
                  {
                    role: 'user' as const,
                    content: formatClaudeCompactSummary(''),
                  },
                ],
                definitions,
              )
              budget.assertFits(compactEnvelope)
              const compacted = await (
                this.options.compactor ?? new ModelCompactor(provider)
              ).compact({
                messages: [
                  ...compactableMessages,
                  ...successfulHookOutput(
                    await this.runAdvisoryHook(
                      sessionId,
                      'PreCompact',
                      {
                        trigger: 'auto',
                        custom_instructions: null,
                      },
                      'auto',
                      signal,
                    ),
                  ).map((content) => ({
                    role: 'user' as const,
                    content: `Additional summarization context: ${content}`,
                  })),
                ],
                targetTokens: Math.min(
                  8192,
                  Math.max(
                    1,
                    compactEnvelope.availableTokens -
                      compactEnvelope.estimatedTokens,
                  ),
                ),
                contextWindowTokens: budget.contextWindowTokens,
                ...(signal ? { signal } : {}),
              })
              const { durationMs, durationWithoutRetriesMs } =
                requireCompactionDurations(compacted)
              if (signal?.aborted) throw new AgentRunCancelledError()
              const proposedCompactionDurationMs =
                (compactionDurationMs ?? 0) + durationMs
              if (!Number.isFinite(proposedCompactionDurationMs)) {
                throw new TypeError('compaction durationMs total overflow')
              }
              const proposedCompactionDurationWithoutRetriesMs =
                (compactionDurationWithoutRetriesMs ?? 0) +
                durationWithoutRetriesMs
              if (
                !Number.isFinite(proposedCompactionDurationWithoutRetriesMs)
              ) {
                throw new TypeError(
                  'compaction durationWithoutRetriesMs total overflow',
                )
              }
              const postTokens = estimateModelRequestTokens([
                { role: 'user', content: compacted.summary },
                ...preservedMessages,
              ])
              const compactModel =
                compacted.model !== undefined && compacted.model.trim() !== ''
                  ? compacted.model
                  : provider.model
              const meaningfulUsage = hasNonZeroUsage(compacted.usage)
              if (
                meaningfulUsage &&
                (compactModel === undefined || compactModel.trim() === '')
              )
                throw new Error(
                  'Auto compact usage requires a nonblank model identity',
                )
              const tracker = this.sessionCostTrackers.get(sessionId)
              if (!tracker)
                throw new Error(
                  `Session cost tracker is not active for session ${sessionId}`,
                )
              let meteringTurnInput: ClaudeSessionTurnInput | undefined
              if (
                meaningfulUsage &&
                compactModel !== undefined &&
                compactModel.trim() !== ''
              ) {
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
                    : {
                        webSearchRequests: compacted.usage.webSearchRequests,
                      }),
                }
              }
              let meteringDurationsInput:
                ClaudeSessionDurationsInput | undefined
              if (durationMs > 0 || durationWithoutRetriesMs > 0)
                meteringDurationsInput = {
                  ...(durationMs === 0 ? {} : { apiDurationMs: durationMs }),
                  apiDurationWithoutRetriesMs: durationWithoutRetriesMs,
                }
              if (
                meteringTurnInput !== undefined ||
                meteringDurationsInput !== undefined
              ) {
                const preflight = new ClaudeSessionCostTracker({
                  sessionId,
                  restored: tracker.snapshot(),
                })
                if (meteringTurnInput !== undefined)
                  preflight.recordTurn(meteringTurnInput)
                if (meteringDurationsInput !== undefined)
                  preflight.recordDurations(meteringDurationsInput)
              }
              const summaryMessage = {
                role: 'user' as const,
                content: compacted.summary,
              }
              let replayMessages = preservedMessages
              try {
                const replayReport = budget.evaluate(
                  [
                    ...contextMessages,
                    ...injectTurnContext([
                      summaryMessage,
                      ...replayMessages,
                      ...pendingMessages,
                    ]),
                  ],
                  definitions,
                )
                if (replayReport.shouldCompact)
                  throw new Error('replay overflow')
              } catch {
                // A huge completed tool result may be needed in the
                // compactor input but cannot fit in the next model request.
                // Drop the tool pair only for replay; the summary already
                // contains its contents and user prompts remain available.
                replayMessages = replayMessages.filter(
                  (message) =>
                    message.role === 'user' && !Array.isArray(message.content),
                )
              }
              const proposedMessages = [
                ...contextMessages,
                ...injectTurnContext([
                  summaryMessage,
                  ...replayMessages,
                  ...pendingMessages,
                ]),
              ]
              return {
                envelope: { messages: proposedMessages, tools: definitions },
                commit: async () => {
                  if (signal?.aborted) throw new AgentRunCancelledError()
                  const ids = await nativeLease.appendCompaction({
                    summary: compacted.summary,
                    trigger: 'auto',
                    preTokens,
                    postTokens,
                    durationMs,
                    preservedMessages: replayMessages,
                    ...(compactionLogicalParentId === undefined
                      ? {}
                      : { logicalParentId: compactionLogicalParentId }),
                    ...(memorySelection
                      ? {
                          direction: 'from' as const,
                          messagesSummarized: compactableMessages.length,
                          preservePrefix: false,
                        }
                      : {}),
                  })
                  await this.runAdvisoryHook(
                    sessionId,
                    'PostCompact',
                    { trigger: 'auto', compact_summary: compacted.summary },
                    'auto',
                    signal,
                  )
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
                  await refreshRuntimeContext?.()
                  this.options.eventSink?.({
                    type: 'compact-boundary',
                    trigger: 'auto',
                    preTokens,
                    uuid: ids.boundaryId,
                  })
                  compactionUsage = mergeUsage(compactionUsage, compacted.usage)
                  compactionDurationMs =
                    (compactionDurationMs ?? 0) + durationMs
                  compactionDurationWithoutRetriesMs =
                    (compactionDurationWithoutRetriesMs ?? 0) +
                    durationWithoutRetriesMs
                  if (meteringTurnInput !== undefined) {
                    tracker.recordTurn(meteringTurnInput)
                  }
                  if (
                    compactModel !== undefined &&
                    compactModel.trim() !== ''
                  ) {
                    compactionModelUsage = mergeSessionRawModelUsage(
                      compactionModelUsage,
                      { [compactModel]: compacted.usage },
                    )
                  }
                  if (meteringDurationsInput !== undefined)
                    tracker.recordDurations(meteringDurationsInput)
                },
              }
            },
          })
          if (shellCommand === undefined) {
            await contextEngine.prepare(
              contextTransitionPort(pendingUserMessages),
              signal,
            )
          }

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
            if (
              currentPromptId === null &&
              typeof userEntry.uuid === 'string'
            ) {
              currentPromptId = userEntry.uuid
              compactionAnchorUuid ??= userEntry.uuid
            }
            const userTail = await this.append(lease, snapshot.tail, userEntry)
            snapshot = {
              entries: [...snapshot.entries, userEntry],
              tail: userTail,
            }
            if (nativeLease) {
              const nativePromptId = await nativeLease.appendMessages({
                messages: [
                  {
                    role: 'user',
                    content: message.text,
                    ...(messageImages.length ? { images: messageImages } : {}),
                    ...(index === attachmentIndex && documents.length > 0
                      ? { documents }
                      : {}),
                  },
                ],
              })
              // File-history snapshots key their metadata to the durable
              // native event id, not the scratch compatibility projection id.
              currentPromptId = nativePromptId
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
            if (nativeLease) {
              await nativeLease.appendMessages({
                messages: [
                  {
                    role: 'user',
                    content: `<praxis-file-history>${JSON.stringify(historySnapshot)}</praxis-file-history>`,
                  },
                ],
              })
            }
          }

          if (this.options.hooks && !shouldSkipUserPrompt()) {
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
          let shellDurationApiMs: number | undefined
          let shellDurationApiWithoutRetriesMs: number | undefined
          let shellToolDurationMs: number | undefined
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
                sessionId,
                toolResultDirectory,
                messages: activeTurnMessages(),
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
            shellDurationApiMs = shellResult.durationApiMs
            shellDurationApiWithoutRetriesMs =
              shellResult.durationApiWithoutRetriesMs
            shellToolDurationMs = shellResult.durationToolMs
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
            const shellAppend = await this.appendProjectionMany(snapshot.tail, [
              inputEntry,
              outputEntry,
            ])
            snapshot = {
              entries: [...snapshot.entries, inputEntry, outputEntry],
              tail: shellAppend.tail,
            }
            if (nativeLease) {
              await nativeLease.appendMessages({
                messages: [
                  {
                    role: 'user',
                    content: `<bash-input>${shellCommand}</bash-input>`,
                  },
                  {
                    role: 'user',
                    content: `<bash-stdout>${stdout}</bash-stdout><bash-stderr>${stderr}</bash-stderr>`,
                  },
                ],
              })
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
          if (shellCommand !== undefined) {
            const tracker = this.sessionCostTrackers.get(sessionId)
            if (!tracker) {
              throw new Error(
                `Session cost tracker is not active for session ${sessionId}`,
              )
            }
            const totalUsage = mergeUsage(recoveryUsage, shellUsage)
            const turnModelUsage = mergeSessionRawModelUsage(
              recoveryModelUsage,
              shellModelUsage,
            )
            let rawCostUsd: number | undefined
            if (turnModelUsage) {
              for (const [model, usage] of Object.entries(turnModelUsage)) {
                const pricing = this.options.pricing?.resolve(model)
                const costUsd = pricing
                  ? usageCostUsd(usage, pricing)
                  : undefined
                if (costUsd !== undefined)
                  rawCostUsd = (rawCostUsd ?? 0) + costUsd
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
              shellToolDurationMs,
              combinedToolDurationMs,
            )
            tracker.recordDurations({
              ...(shellDurationApiMs === undefined
                ? {}
                : { apiDurationMs: shellDurationApiMs }),
              ...(shellDurationApiWithoutRetriesMs === undefined
                ? {}
                : {
                    apiDurationWithoutRetriesMs:
                      shellDurationApiWithoutRetriesMs,
                  }),
              ...(combinedToolDurationMs === 0
                ? {}
                : { toolDurationMs: combinedToolDurationMs }),
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
            turnCompleted = true
            return {
              sessionId,
              text: '',
              usage: totalUsage,
              ...(rawCostUsd === undefined ? {} : { costUsd: rawCostUsd }),
              ...(turnModelUsage ? { modelUsage: { ...turnModelUsage } } : {}),
              ...(shellDurationApiMs === undefined
                ? {}
                : { durationApiMs: shellDurationApiMs }),
            }
          }
          if (shellCommand === undefined && budget) {
            await contextEngine.prepare(
              contextTransitionPort([], currentTurnUserMessages ?? []),
              signal,
            )
            budget.assertFits(
              budget.evaluate(
                [
                  ...contextMessages,
                  ...injectTurnContext(activeTurnMessages()),
                ],
                definitions,
              ),
            )
          }

          let stopHookActive = false
          const runtimeRequest: AgentRunRequest = {
            sessionId,
            messages: [
              ...contextMessages,
              ...injectTurnContext(activeTurnMessages()),
            ],
            stableSystemMessageCount,
            cwd: this.activeCwd(),
            toolResultDirectory,
            observer,
            ...(activeTurnInput ? { steering: activeTurnInput } : {}),
            ...(this.options.effort ? { effort: this.options.effort } : {}),
            ...(this.options.maxModelTurns !== undefined
              ? { maxModelTurns: this.options.maxModelTurns }
              : {}),
            ...(this.options.betas?.length
              ? { betas: this.options.betas }
              : {}),
            ...(this.options.collectMetrics || this.options.costStateStore
              ? { collectMetrics: true }
              : {}),
            ...(budget
              ? { deferFailureKinds: ['prompt_too_long'] as const }
              : {}),
            reloadMessages: async () => {
              const recalled = turnMemory.consumeRecall()
              if (recalled) {
                projectMemoryRecallMessages = [
                  { role: 'user', content: recalled.content },
                ]
              }
              await refreshRuntimeContext?.()
              if (shellCommand === undefined) {
                await contextEngine.prepare(
                  contextTransitionPort([], currentTurnUserMessages ?? []),
                  signal,
                )
              }
              runtimeRequest.stableSystemMessageCount = stableSystemMessageCount
              return [
                ...contextMessages,
                ...injectTurnContext([
                  ...activeTurnMessages(),
                  ...projectMemoryRecallMessages,
                ]),
              ]
            },
            ...(this.options.hooks ||
            subagentExecutor ||
            taskTools ||
            this.scheduledPrompts ||
            this.workflowManager ||
            this.leadOperations
              ? {
                  onStop: async (text: string) => {
                    const messages: string[] = []
                    const teamInbox =
                      await this.leadOperations?.projectInbox(sessionId)
                    if (teamInbox) {
                      durableFollowUps.register(teamInbox)
                      messages.push(...teamInbox.messages)
                    }
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
                        messages.push(
                          `Stop hook error: ${outcome.blockedReason}`,
                        )
                      }
                    }
                    const claimedAgentIds = new Set(
                      this.sessionSubagentExecutors(sessionId, true).flatMap(
                        (executor) => executor.notificationClaimAgentIds(),
                      ),
                    )
                    await Promise.all(
                      this.sessionSubagentExecutors(sessionId, true).map(
                        (executor) => {
                          const delivered = (
                            notification: BackgroundAgentNotificationIdentity,
                          ) =>
                            transcriptContainsBackgroundAgentNotification(
                              nativeLease
                                ? nativeLease.activeMessages()
                                : snapshot.entries,
                              notification,
                            )
                          return this.hostedSubagents.has(executor)
                            ? executor.reconcileDetachedNotifications(delivered)
                            : executor.reconcileDeliveredNotifications(
                                delivered,
                              )
                        },
                      ),
                    )
                    await subagentExecutor?.hydratePersistedTasks(
                      sessionId,
                      this.activeCwd(),
                      claimedAgentIds,
                    )
                    const background = await this.collectSubagentNotifications(
                      sessionId,
                      subagentExecutor ?? undefined,
                    )
                    if (background) {
                      if (nativeLease) {
                        for (const message of background.messages) {
                          await this.appendBackgroundNotification(
                            sessionId,
                            message,
                            nativeLease,
                          )
                        }
                      }
                      messages.push(...background.messages)
                    }
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
            permissionUpdates:
              this.sessionPermissionUpdates.get(sessionId) ?? [],
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
            try {
              result = await attemptMainTurn()
            } catch (error) {
              if (!budget || !isPromptTooLongError(error)) throw error
              const recovery = await contextEngine.recover(
                error,
                contextTransitionPort([], currentTurnUserMessages ?? []),
                signal,
              )
              if (recovery.kind !== 'retry') {
                surfaceExhaustedRecovery(error)
                throw error
              }
              // The single reactive retry must use the compacted transcript, not
              // the stale request copy captured before the compact boundary.
              runtimeRequest.messages = [
                ...contextMessages,
                ...injectTurnContext([
                  ...activeTurnMessages(),
                  ...projectMemoryRecallMessages,
                ]),
              ]
              runtimeRequest.stableSystemMessageCount = stableSystemMessageCount
              runtimeRequest.deferFailureKinds = true
              try {
                result = await attemptMainTurn()
              } catch (retryError) {
                // Exactly one reactive retry is consumed; fail deterministically
                // and surface the original prompt-too-long error.
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
          } catch (error) {
            if (
              !signal?.aborted &&
              !(error instanceof AgentRunCancelledError) &&
              !(
                error instanceof ModelProviderError &&
                error.kind === 'cancelled'
              )
            ) {
              const failureKind =
                error instanceof ModelProviderError
                  ? claudeStopFailureError(error.kind)
                  : 'unknown'
              await this.runAdvisoryHook(
                sessionId,
                'StopFailure',
                {
                  error: failureKind,
                  error_details:
                    error instanceof Error ? error.message : String(error),
                },
                failureKind,
                signal,
              )
            }
            throw error
          }
          if (structuredCapture && structuredCapture.calls !== 1) {
            throw new Error(
              `StructuredOutput must be called exactly once (received ${structuredCapture.calls})`,
            )
          }

          const finalLeafUuid = lastAssistantUuid
          if (!finalLeafUuid) {
            throw new Error('Could not locate final assistant response')
          }
          if (!nativeLease && !skipUserPrompt) {
            const lastPrompt = createClaudeLastPromptEntry({
              sessionId,
              lastPrompt: effectivePrompt,
              leafUuid: finalLeafUuid,
            })
            const tail = await this.append(lease, snapshot.tail, lastPrompt)
            snapshot = {
              entries: [...snapshot.entries, lastPrompt],
              tail,
            }
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
              if (costUsd !== undefined)
                rawCostUsd = (rawCostUsd ?? 0) + costUsd
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
                  apiDurationWithoutRetriesMs:
                    trackedDurationApiWithoutRetriesMs,
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
          const memorySnapshot = activeTurnMessages()
          const nativeMemoryMessageId = nativeLease
            ? projectNativeSessionEntries(nativeLease.activeEvents()).at(-1)
                ?.uuid
            : undefined
          const providerVisibleMessages = [
            ...contextMessages,
            ...injectTurnContext(memorySnapshot),
          ]
          const currentContextTokens =
            contextEngine.report({
              messages: providerVisibleMessages,
              tools: definitions,
            })?.occupancyTokens ??
            estimateModelRequestTokens(providerVisibleMessages, definitions)
          await turnMemory.observeSuccess({
            ...(finalLeafUuid
              ? {
                  messageId:
                    typeof nativeMemoryMessageId === 'string'
                      ? nativeMemoryMessageId
                      : finalLeafUuid,
                }
              : {}),
            occupancyTokens: currentContextTokens,
            toolCalls: currentTurnToolCalls,
            messages: memorySnapshot,
            projectMessages: nativeLease
              ? memorySnapshot.flatMap((message, index) =>
                  (message.role === 'user' || message.role === 'assistant') &&
                  message.content.trim().length > 0
                    ? [
                        {
                          id: `${finalLeafUuid ?? sessionId}:${index}`,
                          role: message.role,
                          content: message.content,
                        },
                      ]
                    : [],
                )
              : projectMemoryMessages(snapshot.entries),
            directMaintenance: projectMemoryMaintained,
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
      }
      let result: SessionRunResult
      {
        let nativeStore: NativeTranscriptStore | InMemoryTranscriptStore
        if (this.options.sessionPersistence === false) {
          nativeStore =
            this.inMemoryStores.get(sessionId) ?? new InMemoryTranscriptStore()
          this.inMemoryStores.set(sessionId, nativeStore)
        } else {
          nativeStore = new NativeTranscriptStore({
            transcriptFile: sessionPaths.sessionFile,
            lockFile: join(
              sessionPaths.praxisRoot,
              'locks',
              `${sessionId}.lock`,
            ),
          })
        }
        const nativeTranscript = new NativeSessionTranscript({
          sessionId,
          store: nativeStore,
        })
        const activationKind = requireExisting
          ? resumeSessionAt === undefined
            ? { kind: 'resume' as const }
            : { kind: 'resume' as const, atEventId: resumeSessionAt }
          : { kind: 'start' as const }
        result = await nativeTranscript.withLease(
          activationKind,
          async (nativeLease) => {
            const scratch = new InMemoryTranscriptStore()
            const scratchResult = await scratch.withLease((scratchLease) =>
              runUnderLease(scratchLease, nativeLease),
            )
            if (scratchResult.status === 'conflict') {
              throw new Error(
                `native scratch transcript conflict: ${scratchResult.reason}`,
              )
            }
            return scratchResult.value
          },
        )
      }
      controller.complete()
      return result
    } catch (error) {
      controller.fail(error, signal)
      throw error
    } finally {
      if (activeTurnInput !== undefined) {
        for (const item of activeTurnInput.close()) {
          this.options.eventSink?.({
            type: 'user-input-rejected',
            id: item.id,
            content: item.content,
            reason: signal?.aborted ? 'cancelled' : 'failed',
          })
        }
      }
      if (this.activeTurnInputs.get(sessionId) === activeTurnRecord)
        this.activeTurnInputs.delete(sessionId)
    }
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

  private translationContext(
    sessionId: string,
    snapshot: {
      tail: NativeTranscriptTail
      entries: readonly NativeTranscriptEntry[]
    },
  ) {
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
    entries: readonly NativeTranscriptEntry[],
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
  ): NativeTranscriptEntry[] {
    return [
      { type: 'custom-title', customTitle: name, sessionId },
      { type: 'agent-name', agentName: name, sessionId },
    ]
  }

  private hasSessionName(
    entries: readonly NativeTranscriptEntry[],
    name: string,
  ): boolean {
    return this.sessionName(entries) === name
  }

  private sessionName(
    entries: readonly NativeTranscriptEntry[],
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
    activeEntries: readonly NativeTranscriptEntry[],
    options: { sessionMemoryReady?: boolean } = {},
  ): Promise<MemoryPreservedCompactSelection | null> {
    const controller = this.sessionMemoryController(sessionId)
    if (controller === null) return null
    if (options.sessionMemoryReady !== true) await controller.waitForCompact()
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
    if (suffixStart <= 0) return null

    // A watermark can legitimately point at the last completed message event
    // before a newly appended prompt. There is no post-watermark range in
    // that shape, so retain the newest prompt as suffix and compact the
    // preceding conversation (the first prompt is already represented by the
    // durable memory artifact).
    const compactStart =
      suffixStart <= watermarkIndex + 1
        ? Math.min(1, Math.max(0, suffixStart - 1))
        : watermarkIndex + 1
    const compactedEntries = activeEntries.slice(compactStart, suffixStart)
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
    entries: readonly NativeTranscriptEntry[],
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
    entries: readonly NativeTranscriptEntry[],
    callId: string,
  ): string | null {
    const byUuid = new Map<string, NativeTranscriptEntry>()
    let source: NativeTranscriptEntry | undefined
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
    entries: readonly NativeTranscriptEntry[],
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

  private restoreWorktree(entries: readonly NativeTranscriptEntry[]): void {
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
    const explicitSessionFile = this.explicitSessionFiles.get(sessionId)
    if (explicitSessionFile !== undefined) {
      return {
        ...exact,
        projectRoot: dirname(explicitSessionFile),
        sessionFile: explicitSessionFile,
      }
    }
    return exact
  }

  private pathsForCwd(sessionId: string, cwd: string) {
    return resolveDataPlanePaths({
      dataPlane: 'native',
      root: this.options.configRoot,
      cwd,
      sessionId,
    })
  }

  private async appendCdCommand(sessionId: string, cwd: string): Promise<void> {
    await this.appendNativeCommand(sessionId, `/cd ${cwd}`)
  }

  private async appendSystemLocalCommand(
    sessionId: string,
    command: string,
    args: string,
    output: string,
  ): Promise<void> {
    const transcript = new NativeSessionTranscript({
      sessionId,
      store: this.nativeStore(sessionId),
    })
    while (!this.closing) {
      try {
        await transcript.withLease({ kind: 'resume' }, async (lease) => {
          if (lease.activeMessages().length === 0)
            throw new Error(`Native session not found: ${sessionId}`)
          await lease.appendMessages({
            messages: [
              {
                role: 'user',
                content: `<local-command-${command}>${args}</local-command-${command}>${output}`,
              },
            ],
          })
        })
        return
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !error.message.startsWith('native transcript lease conflict:')
        )
          throw error
        await new Promise<void>((resolve) => setTimeout(resolve, 25))
      }
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
    const nativeStore =
      this.options.sessionPersistence === false
        ? (this.inMemoryStores.get(createdSessionId) ??
          (() => {
            const store = new InMemoryTranscriptStore()
            this.inMemoryStores.set(createdSessionId, store)
            return store
          })())
        : this.store(createdSessionId)
    const transcript = new NativeSessionTranscript({
      sessionId: createdSessionId,
      store: nativeStore,
    })
    await transcript.withLease({ kind: 'start' }, (lease) =>
      lease.appendMessages({
        messages: [
          {
            role: 'user',
            content: agentColor
              ? `session color: ${agentColor}`
              : 'session start',
          },
        ],
      }),
    )
    this.sessionCwds.set(createdSessionId, this.activeCwd())
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

  private async appendNativeCommand(
    sessionId: string,
    command: string,
  ): Promise<void> {
    const transcript = new NativeSessionTranscript({
      sessionId,
      store: this.nativeStore(sessionId),
    })
    await transcript.withLease({ kind: 'resume' }, (lease) =>
      lease.appendMessages({
        messages: [{ role: 'user', content: command }],
      }),
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
    const transcript = new NativeSessionTranscript({
      sessionId,
      store: this.nativeStore(sessionId),
    })
    await transcript.withLease({ kind: 'resume' }, async (lease) => {
      if (lease.activeMessages().length === 0)
        throw new Error(`Native session not found: ${sessionId}`)
      const content = retry
        ? `Permission retry approved for: ${normalized}`
        : `Permission granted for: ${normalized}`
      await lease.appendMessages({
        messages: [{ role: 'user', content }],
      })
    })
  }

  private async appendBackgroundNotification(
    sessionId: string,
    content: string,
    nativeLease?: NativeSessionTranscriptLease,
  ): Promise<boolean> {
    if (nativeLease) {
      if (nativeLease.activeMessages().length === 0) {
        throw new Error(`Native session not found: ${sessionId}`)
      }
      await nativeLease.appendMessages({
        messages: [{ role: 'user', content }],
      })
      return true
    }
    const transcript = new NativeSessionTranscript({
      sessionId,
      store: this.nativeStore(sessionId),
    })
    while (!this.closing) {
      try {
        return await transcript.withLease({ kind: 'resume' }, async (lease) => {
          if (lease.activeMessages().length === 0)
            throw new Error(`Native session not found: ${sessionId}`)
          await lease.appendMessages({
            messages: [{ role: 'user', content }],
          })
          return true
        })
      } catch (error) {
        if (this.closing) return false
        if (
          error instanceof Error &&
          error.message.includes('native transcript lease conflict')
        ) {
          await new Promise<void>((resolve) => setTimeout(resolve, 25))
          continue
        }
        throw error
      }
    }
    return false
  }

  private enqueueBackgroundNotifications(
    sessionId: string,
    messages: readonly string[],
    onAppended?: (message: string) => Promise<void>,
    nativeLease?: NativeSessionTranscriptLease,
  ): Promise<boolean> {
    const previous = this.backgroundNotificationWrites.get(sessionId)
    const queued = (previous ?? Promise.resolve(true)).then(
      async (previousCompleted) => {
        if (!previousCompleted || this.closing) return false
        for (const message of messages) {
          if (
            !(await this.appendBackgroundNotification(
              sessionId,
              message,
              nativeLease,
            ))
          ) {
            return false
          }
          await onAppended?.(message)
        }
        return true
      },
    )
    this.backgroundNotificationWrites.set(sessionId, queued)
    const cleanup = () => {
      if (this.backgroundNotificationWrites.get(sessionId) === queued)
        this.backgroundNotificationWrites.delete(sessionId)
    }
    void queued.then(cleanup, cleanup)
    return queued
  }

  private store(sessionId: string): NativeTranscriptStore {
    const paths = this.paths(sessionId)
    return new NativeTranscriptStore({
      transcriptFile: paths.sessionFile,
      lockFile: join(paths.praxisRoot, 'locks', `${sessionId}.lock`),
    })
  }
  private nativeStore(sessionId: string): NativeSessionTranscriptStore {
    if (this.options.sessionPersistence === false) {
      const existing = this.inMemoryStores.get(sessionId)
      if (existing !== undefined) return existing
      const created = new InMemoryTranscriptStore()
      this.inMemoryStores.set(sessionId, created)
      return created
    }
    return this.store(sessionId)
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

  private assertTurnWritable(): void {
    this.assertWritable()
  }

  private nativeSessionStatus(
    issue: TranscriptCodecDiagnostic | null,
    entryCount: number,
  ): SessionStatus {
    if (issue?.kind === 'unsupported-version') return 'read-only'
    if (entryCount === 0 || issue) return 'corrupt'
    return 'ready'
  }

  private assertNativeTranscriptOptions(): void {
    if (this.options.experimentalNativeTranscriptWrites !== true) return
    if (this.options.sessionPersistence === false)
      throw new Error(
        'experimental native transcript writes require sessionPersistence',
      )
    const incompatible: Array<[string, boolean]> = [
      ['hooks', this.options.hooks !== undefined],
      [
        'conditionalRuleResolver',
        this.options.conditionalRuleResolver !== undefined,
      ],
      ['extensions', this.options.extensions !== undefined],
      ['agent', this.options.agent !== undefined],
      ['fileCheckpointing', this.options.fileCheckpointing === true],
      ['fileRewindRoots', (this.options.fileRewindRoots?.length ?? 0) > 0],
      ['interactiveTools', this.options.interactiveTools !== undefined],
      ['mcp', this.options.mcp !== undefined],
      ['taskToolNames', (this.options.taskToolNames?.length ?? 0) > 0],
      [
        'scheduledToolNames',
        (this.options.scheduledToolNames?.length ?? 0) > 0,
      ],
      ['enableDynamicWakeups', this.options.enableDynamicWakeups === true],
      ['enableSessionMemory', this.options.enableSessionMemory === true],
      [
        'sessionMemoryProviderFactory',
        this.options.sessionMemoryProviderFactory !== undefined,
      ],
      [
        'projectMemoryDirectory',
        this.options.projectMemoryDirectory !== undefined,
      ],
      ['projectMemoryRecall', this.options.projectMemoryRecall !== undefined],
      [
        'projectMemoryExtraction',
        this.options.projectMemoryExtraction !== undefined,
      ],
      ['sessionKind', this.options.sessionKind !== undefined],
      ['workspace', this.options.workspace !== undefined],
      ['initialWorktree', this.options.initialWorktree === true],
      ['initialWorktreeName', this.options.initialWorktreeName !== undefined],
      ['enableWorktrees', this.options.enableWorktrees === true],
      ['worktreeToolNames', (this.options.worktreeToolNames?.length ?? 0) > 0],
      ['worktreeBaseRef', this.options.worktreeBaseRef !== undefined],
    ]
    const active = incompatible.find(([, enabled]) => enabled)
    if (active)
      throw new Error(
        `experimental native transcript writes incompatible with option ${active[0]}`,
      )
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
      'native',
    )
    const system = memory ? `${agent.body}\n\n${memory}` : agent.body
    return system.trim() ? system : null
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
    if (!this.sessionMemoryEnabled() || !isSessionId(sessionId)) {
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
      teams: this.leadOperations !== null,
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
      .filter((name) => !name.startsWith('Team') || capabilities.has(name))
  }

  private teamRegistry(
    base: ToolRegistry,
    sessionId: string,
    enabledTools: readonly string[],
  ): ToolRegistry {
    if (enabledTools.length === 0) return base
    const operations = this.leadOperations
    if (!operations) return base
    const factory = this.options.teamLeadToolRegistryFactory
    if (!factory) {
      throw new Error(
        'Team lead operations require a Team lead tool registry factory',
      )
    }
    return factory(base, operations, sessionId, enabledTools)
  }

  private async append(
    lease: NativeTranscriptLease,
    tail: NativeTranscriptTail,
    entry: NativeTranscriptEntry,
  ): Promise<NativeTranscriptTail> {
    void lease
    return this.appendProjectionMany(tail, [entry]).then(
      (result) => result.tail,
    )
  }

  /**
   * Update the in-memory compatibility projection used by the turn pipeline.
   * Authoritative native persistence is performed by NativeSessionTranscript;
   * these entries are never written to the native event store.
   */
  private async appendProjectionMany(
    tail: NativeTranscriptTail,
    entries: readonly NativeTranscriptEntry[],
  ): Promise<{ status: 'appended'; tail: NativeTranscriptTail }> {
    if (entries.length === 0)
      throw new Error('Cannot append an empty projection')
    const lastUuid = [...entries]
      .reverse()
      .find((entry) => typeof entry.uuid === 'string')?.uuid
    return {
      status: 'appended',
      tail: {
        ...tail,
        byteLength: tail.byteLength + entries.length,
        lastLineHash: `projection:${tail.byteLength + entries.length}`,
        lastEventId: typeof lastUuid === 'string' ? lastUuid : tail.lastEventId,
        ...(tail.branchParentId === undefined ? {} : { branchParentId: null }),
      },
    }
  }

  private logicalTailUuid(tail: SessionTail): string | null {
    return tail.branchParentId ?? tail.lastEventId
  }
}
