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
import { basename, extname, isAbsolute, join, relative } from 'node:path'

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
  isClaudeSessionId,
  resolveClaudePaths,
  resolveClaudeScheduledTaskFile,
} from '../compatibility/claude/paths.js'
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
import { findUnresolvedClaudeToolCalls } from '../compatibility/claude/tool-links.js'
import {
  createClaudeAgentSettingEntry,
  createClaudeHookAttachmentEntries,
  createClaudeLastPromptEntry,
  createClaudeRuleAttachmentEntry,
  translateProviderEvents,
} from '../compatibility/claude/translation.js'
import {
  AgentRunCancelledError,
  AgentRuntime,
  type ModelContentBlock,
  type ModelDocument,
  type ModelImage,
  type ModelMessage,
  type ModelThinkingBlock,
  type ModelToolCall,
  type ModelProvider,
  type ModelUsage,
  type PermissionApproval,
  type PermissionDecision,
  type PermissionResolver,
  type PermissionUpdate,
  type RuntimeEventSink,
  type ToolRegistry,
} from '../core/runtime.js'
import {
  BackgroundTaskRuntime,
  type BackgroundTaskSnapshot,
} from './background-task-runtime.js'
import { usageCostUsd } from '../core/usage.js'
import type { ModelPricingRegistry } from '../core/usage.js'
import type { Compactor } from '../core/compaction.js'
import {
  ContextBudget,
  estimateModelRequestTokens,
} from '../core/context-budget.js'
import {
  injectFirstUserMessageContext,
  type ContextAssembler,
} from '../core/context.js'
import type {
  ClaudeAgentRuntimeDefinition,
  ClaudeExtensionCatalog,
  ClaudePromptExpansionMessage,
} from '../extensions/claude-extensions.js'
import { ClaudeHookToolCoordinator } from '../hooks/claude-hook-tools.js'
import type {
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
import { ModelCompactor } from './model-compactor.js'
import {
  agentMemoryPrompt,
  type AgentPermissionMode,
  ClaudeSubagentExecutor,
  StructuredOutputRegistry,
} from './subagent-service.js'
import { ScheduledPromptManager } from './scheduled-prompt-manager.js'
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
import { ClaudeWorktreeToolRegistry } from '../tools/claude-worktree-tools.js'
import { FilteredToolRegistry } from '../tools/filtered-tool-registry.js'
import { generateToolUseSummary } from './tool-use-summary.js'
import {
  ClaudeUserMessageToolRegistry,
  CLAUDE_USER_MESSAGE_PROMPT,
  type UserMessage,
} from '../tools/claude-user-message.js'
import type { ClaudeInteractiveToolManager } from '../tools/claude-interactive-tools.js'
import type { ClaudePermissionMode } from '../permissions/claude-permission-resolver.js'
import type {
  ClaudeMcpRuntime,
  ClaudeMcpServerStatus,
  ClaudeMcpToolInspection,
} from '../mcp/claude-mcp-tools.js'

export interface ClaudeSessionServiceOptions {
  configRoot: string
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
  enableDynamicWakeups?: boolean
  enableWorkflows?: boolean
  providerForModel?: (model: string) => ModelProvider
  providerForMainModel?: (model: string) => ModelProvider
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
  fileRewindRoots?: readonly string[]
  interactiveTools?: ClaudeInteractiveToolManager
  mcp?: ClaudeMcpRuntime
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
  prepare: async (call) => call,
  execute: async () => ({ content: '', isError: false }),
}

function mergeUsage(left: ModelUsage, right: ModelUsage): ModelUsage {
  const cacheReadInputTokens =
    (left.cacheReadInputTokens ?? 0) + (right.cacheReadInputTokens ?? 0)
  const cacheCreationInputTokens =
    (left.cacheCreationInputTokens ?? 0) + (right.cacheCreationInputTokens ?? 0)
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    ...(cacheReadInputTokens === 0 ? {} : { cacheReadInputTokens }),
    ...(cacheCreationInputTokens === 0 ? {} : { cacheCreationInputTokens }),
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

export class ClaudeSessionService {
  private readonly schema
  private readonly inMemoryStores = new Map<string, InMemoryTranscriptStore>()
  private readonly scheduledPrompts: ScheduledPromptManager | null
  private readonly workflowManager: WorkflowManager | null
  private readonly backgroundTasks: BackgroundTaskRuntime
  private readonly worktreeManager: SessionWorktreeManager | null
  private readonly sessionCwds = new Map<string, string>()
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
  private runtimeCwd: string

  constructor(private readonly options: ClaudeSessionServiceOptions) {
    this.runtimeCwd = options.workspace?.cwd() ?? options.cwd
    this.schema = selectClaudeSchemaAdapter(options.claudeVersion)
    this.scheduledPrompts =
      options.tools && (options.scheduledToolNames?.length ?? 0) > 0
        ? new ScheduledPromptManager({
            filePath: resolveClaudeScheduledTaskFile(options.cwd),
            lockFile: join(
              options.configRoot,
              'praxis',
              'locks',
              'scheduled-tasks.lock',
            ),
            ...(options.enableDynamicWakeups === undefined
              ? {}
              : { dynamicWakeupsEnabled: options.enableDynamicWakeups }),
          })
        : null
    this.workflowManager = options.enableWorkflows
      ? new WorkflowManager(options.configRoot, options.cwd, () =>
          this.activeCwd(),
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

  nextScheduledPrompt(signal?: AbortSignal) {
    return this.scheduledPrompts?.next(signal) ?? Promise.resolve(null)
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
    this.scheduledPrompts?.close()
    await Promise.all(
      [...this.hostedSubagents].map((executor) => executor.close()),
    )
    await Promise.resolve()
    await Promise.all([...this.backgroundNotificationWrites.values()])
    this.hostedSubagents.clear()
    this.backgroundTasks.clear()
    await this.workflowManager?.close()
    this.mcpClosePromise ??= this.options.mcp?.close?.() ?? Promise.resolve()
    await this.mcpClosePromise
  }

  createHostedToolRegistry(sessionId: string): ToolRegistry {
    const baseTools = this.options.tools
    if (!baseTools) throw new Error('Hosted tool registry requires base tools')
    const paths = this.paths(sessionId)
    const taskTools =
      (this.options.taskToolNames?.length ?? 0) > 0
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
            ...(this.options.taskToolNames
              ? { enabledTools: this.options.taskToolNames }
              : {}),
          })
        : null
    if (taskTools) this.backgroundTasks.registerBash(sessionId, taskTools)
    const scheduledTools =
      this.scheduledPrompts &&
      (this.options.scheduledToolNames?.length ?? 0) > 0
        ? new ClaudeScheduledToolRegistry({
            base: taskTools ?? baseTools,
            manager: this.scheduledPrompts,
            sessionId,
            ...(this.options.scheduledToolNames
              ? { enabledTools: this.options.scheduledToolNames }
              : {}),
          })
        : null
    const wrappedBase = scheduledTools ?? taskTools ?? baseTools
    const subagentExecutor =
      (this.options.enableSubagents || this.options.enableWorkflows) &&
      this.options.permissions
        ? new ClaudeSubagentExecutor({
            configRoot: this.options.configRoot,
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
              ? { toolNames: this.options.subagentToolNames }
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
            enabled: true,
          })
        : agentTools
    if (this.worktreeManager) this.worktreeManager.bindSession(sessionId)
    const registry =
      this.worktreeManager && this.options.workspace
        ? new ClaudeWorktreeToolRegistry({
            base: workflowTools,
            manager: this.worktreeManager,
            workspace: this.options.workspace,
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
        const definitions = interactiveRegistry.definitions()
        return [...definitions].sort((left, right) => {
          const leftIndex = preferredOrder.indexOf(left.name)
          const rightIndex = preferredOrder.indexOf(right.name)
          return (
            (leftIndex < 0 ? preferredOrder.length : leftIndex) -
            (rightIndex < 0 ? preferredOrder.length : rightIndex)
          )
        })
      },
      prepare: (call, context) => interactiveRegistry.prepare(call, context),
      execute: (call, context) => interactiveRegistry.execute(call, context),
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
    let text = ''
    let usage: ModelUsage = { inputTokens: 0, outputTokens: 0 }
    for await (const event of provider.complete({
      messages,
      ...(this.options.effort ? { effort: this.options.effort } : {}),
      ...(signal ? { signal } : {}),
    })) {
      if (event.type === 'text-delta') {
        text += event.delta
        onDelta?.(event.delta)
      } else if (event.type === 'usage') {
        usage = event.usage
      } else if (event.type === 'tool-call') {
        throw new Error('Side questions cannot call tools; press f to fork')
      }
    }
    const pricing = this.options.pricing?.resolve(
      provider.model ?? 'praxis/provider',
    )
    return {
      sessionId: activeSessionId,
      text,
      usage,
      ...(pricing ? { costUsd: usageCostUsd(usage, pricing) } : {}),
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
    const assembledContext = await this.options.contextAssembler?.assemble({
      cwd: this.activeCwd(),
    })
    const agentSystem = await this.mainAgentSystemPrompt(agent)
    const assembledSystemMessages = this.assembledSystemMessages(
      agent,
      assembledContext?.systemMessages ?? [],
    )
    const contextMessages = [
      ...(agentSystem
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
    let suggestion = ''
    for await (const event of provider.complete({
      messages,
      ...(provider.capabilities.tools
        ? { tools: suggestionTools?.definitions() ?? [] }
        : {}),
      ...(this.options.effort ? { effort: this.options.effort } : {}),
      ...(signal ? { signal } : {}),
    })) {
      if (event.type === 'text-delta') suggestion += event.delta
      if (event.type === 'tool-call') return null
    }
    return validPromptSuggestion(suggestion)
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
    let suggestion = ''
    for await (const event of provider.complete({
      messages: [
        ...projectClaudeModelMessages(loaded.value.entries),
        { role: 'user', content: SESSION_NAME_INSTRUCTION },
      ],
      ...(this.options.effort ? { effort: this.options.effort } : {}),
      ...(signal ? { signal } : {}),
    })) {
      if (event.type === 'text-delta') suggestion += event.delta
      if (event.type === 'tool-call') return null
    }
    return validSessionName(suggestion)
  }

  async sessions(): Promise<SessionSummary[]> {
    const paths = this.paths(randomUUID())
    let names: string[]
    try {
      names = await readdir(paths.projectRoot)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }

    const summaries = await Promise.all(
      names
        .filter((name) => extname(name) === '.jsonl')
        .map(async (name) => {
          const sessionId = basename(name, '.jsonl')
          if (!isClaudeSessionId(sessionId)) return null
          const sessionFile = join(paths.projectRoot, name)
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
              status: this.sessionStatus(
                recovery.issue,
                recovery.entries.length,
              ),
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
      const sourcePaths = resolveClaudePaths({
        configDir: this.options.configRoot,
        cwd: this.sessionCwds.get(sessionId) ?? previousCwd,
        sessionId,
      })
      const targetPaths = resolveClaudePaths({
        configDir: this.options.configRoot,
        cwd,
        sessionId,
      })
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
      } else {
        await this.appendCdCommand(sessionId, cwd)
      }
      this.sessionCwds.set(sessionId, cwd)
      this.runtimeCwd = cwd
      this.options.workspace?.setCwd(cwd)
      return cwd
    }
    this.runtimeCwd = cwd
    this.options.workspace?.setCwd(cwd)
    if (sessionId) this.sessionCwds.set(sessionId, cwd)
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
      const activeEntries = selectClaudeActiveTranscript(snapshot.entries)
      const allMessages = projectClaudeModelMessages(activeEntries)
      let selectedEntries = activeEntries
      let logicalParentUuid = this.lastMessageUuid(activeEntries)
      let preservedEntries: ClaudeTranscriptEntry[] = []
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
      }
      const selectedMessages = projectClaudeModelMessages(selectedEntries)
      const messages: ModelMessage[] = [
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
      const preTokens = estimateModelRequestTokens(allMessages)
      const summary = compacted.summary
      const preservedMessages = projectClaudeModelMessages(preservedEntries)
      const boundaryUuid = randomUUID()
      const summaryUuid = randomUUID()
      const uuids = [boundaryUuid, summaryUuid]
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
        durationMs: compacted.durationMs,
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
          : {}),
        createUuid: () => uuids.shift() ?? randomUUID(),
      })
      const appendResult = await lease.appendMany(snapshot.tail, entries)
      if (appendResult.status === 'conflict') {
        throw new Error(
          `Claude transcript append conflict: ${appendResult.reason}`,
        )
      }
      this.options.eventSink?.({
        type: 'compact-boundary',
        trigger: 'manual',
        preTokens,
        uuid: boundaryUuid,
      })
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
    if (created.status === 'created') return { sessionId, parentSessionId }
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
      const taskTools =
        this.options.tools && (this.options.taskToolNames?.length ?? 0) > 0
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
              ...(this.options.taskToolNames
                ? { enabledTools: this.options.taskToolNames }
                : {}),
            })
          : null
      const scheduledTools =
        this.scheduledPrompts &&
        this.options.tools &&
        (this.options.scheduledToolNames?.length ?? 0) > 0
          ? new ClaudeScheduledToolRegistry({
              base: taskTools ?? this.options.tools,
              manager: this.scheduledPrompts,
              sessionId,
              ...(this.options.scheduledToolNames
                ? { enabledTools: this.options.scheduledToolNames }
                : {}),
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
                ? { toolNames: this.options.subagentToolNames }
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
              enabled: true,
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
      const structuredCapture = this.options.structuredOutputSchema
        ? { calls: 0, value: undefined as unknown }
        : undefined
      const agentScopedTools =
        agent && fileHistoryTools
          ? new FilteredToolRegistry(fileHistoryTools, {
              tools: mainAgentToolNames(fileHistoryTools, agent),
            })
          : fileHistoryTools
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
          const transition = this.worktreeManager?.consumeTransition(call.id)
          if (transition) {
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
      try {
        if (this.options.hooks) {
          const outcome = await this.options.hooks.run(
            {
              ...hookSession,
              hook_event_name: 'SessionStart',
              source: requireExisting ? 'resume' : 'startup',
            },
            requireExisting ? 'resume' : 'startup',
            signal,
          )
          await recordHookOutcome(outcome, pendingRecoveryToolCallIds.size > 0)
          if (outcome.blockedReason) {
            throw new Error(`SessionStart hook error: ${outcome.blockedReason}`)
          }
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
          (usage, result) => ({
            inputTokens: usage.inputTokens + (result.usage?.inputTokens ?? 0),
            outputTokens:
              usage.outputTokens + (result.usage?.outputTokens ?? 0),
          }),
          { inputTokens: 0, outputTokens: 0 },
        )

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

        const assembledContext = await this.options.contextAssembler?.assemble({
          cwd: this.activeCwd(),
        })
        const agentSystem = await this.mainAgentSystemPrompt(agent)
        const assembledSystemMessages = this.assembledSystemMessages(
          agent,
          assembledContext?.systemMessages ?? [],
        )
        const planModeMessage =
          this.options.interactiveTools?.contextMessage(sessionId)
        const contextMessages = [
          ...(agentSystem
            ? [{ role: 'system' as const, content: agentSystem }]
            : []),
          ...assembledSystemMessages,
          ...(planModeMessage
            ? [{ role: 'system' as const, content: planModeMessage }]
            : []),
          ...(this.options.brief
            ? [
                {
                  role: 'system' as const,
                  content: CLAUDE_USER_MESSAGE_PROMPT,
                },
              ]
            : []),
          ...(this.options.structuredOutputSchema
            ? [
                {
                  role: 'system' as const,
                  content:
                    'You MUST call StructuredOutput exactly once at the end with a value matching the requested JSON Schema.',
                },
              ]
            : []),
        ]

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
        const definitions = provider.capabilities.tools
          ? (structuredTools?.definitions() ?? [])
          : []
        const budget = this.contextBudget(provider)
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
        ) => {
          if (!budget || this.options.autoCompact === false) return
          const historyMessages = projectClaudeModelMessages(snapshot.entries)
          const predicted = budget.evaluate(
            [
              ...contextMessages,
              ...injectTurnContext([...historyMessages, ...pendingMessages]),
            ],
            definitions,
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
          const logicalParentUuid = compactionAnchorUuid
          if (!logicalParentUuid || historyMessages.length === 0) {
            budget.assertFits(predicted)
            throw new Error('Cannot compact an empty Claude transcript')
          }
          if (findUnresolvedClaudeToolCalls(snapshot.entries).length > 0) {
            throw new Error(
              'Cannot compact a Claude session with unresolved tool calls',
            )
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
            messages: historyMessages,
            targetTokens,
            contextWindowTokens: budget.contextWindowTokens,
            ...(signal ? { signal } : {}),
          })
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
              durationMs: compacted.durationMs,
              cwd: this.activeCwd(),
              claudeVersion: this.options.claudeVersion,
              gitBranch: null,
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
          const compactedHistory = projectClaudeModelMessages([
            ...snapshot.entries,
            ...provisionalEntries,
            ...replayEntries,
          ])
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
          const entries = [
            ...compactEntries(afterHistory.estimatedTokens),
            ...replayEntries,
          ]
          if (signal?.aborted) throw new AgentRunCancelledError()
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
          this.options.eventSink?.({
            type: 'compact-boundary',
            trigger: 'auto',
            preTokens,
            uuid: boundaryUuid,
          })
          compactionAnchorUuid = compactSummaryUuid
          compactionUsage = {
            inputTokens:
              compactionUsage.inputTokens + compacted.usage.inputTokens,
            outputTokens:
              compactionUsage.outputTokens + compacted.usage.outputTokens,
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
        const runtimeRequest = {
          messages: [
            ...contextMessages,
            ...injectTurnContext(projectClaudeModelMessages(snapshot.entries)),
          ],
          cwd: this.activeCwd(),
          toolResultDirectory,
          observer,
          ...(this.options.effort ? { effort: this.options.effort } : {}),
          ...(this.options.maxModelTurns
            ? { maxModelTurns: this.options.maxModelTurns }
            : {}),
          ...(this.options.betas?.length ? { betas: this.options.betas } : {}),
          ...(this.options.collectMetrics ? { collectMetrics: true } : {}),
          reloadMessages: async () => {
            await compactIfNeeded([], currentTurnUserMessages ?? [])
            return [
              ...contextMessages,
              ...injectTurnContext(
                projectClaudeModelMessages(snapshot.entries),
              ),
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
                  return {
                    messages,
                    ...(background || workflow
                      ? {
                          usage: {
                            inputTokens:
                              (background?.usage.inputTokens ?? 0) +
                              (workflow?.usage.inputTokens ?? 0),
                            outputTokens:
                              (background?.usage.outputTokens ?? 0) +
                              (workflow?.usage.outputTokens ?? 0),
                          },
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
        const result = signal
          ? await runtime.run({ ...runtimeRequest, signal })
          : await runtime.run(runtimeRequest)

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
        return {
          sessionId,
          text:
            structuredCapture && structuredCapture.calls === 1
              ? JSON.stringify(structuredCapture.value)
              : result.text,
          usage: totalUsage,
          ...(result.durationApiMs === undefined
            ? {}
            : { durationApiMs: result.durationApiMs }),
          ...(this.options.pricing
            ? (() => {
                const pricing = this.options.pricing?.resolve(
                  provider.model ?? 'praxis/provider',
                )
                return pricing
                  ? { costUsd: usageCostUsd(result.usage, pricing) }
                  : {}
              })()
            : {}),
          ...(provider.model
            ? { modelUsage: { [provider.model]: result.usage } }
            : {}),
          ...(structuredCapture && structuredCapture.calls === 1
            ? { structuredOutput: structuredCapture.value }
            : {}),
        }
      } finally {
        try {
          const outcome = await this.options.hooks?.run(
            {
              ...hookSession,
              hook_event_name: 'SessionEnd',
              reason: 'other',
            },
            'other',
          )
          const failedExecutions =
            outcome?.executions.filter(
              (execution) => execution.exitCode !== 0,
            ) ?? []
          for (const execution of failedExecutions) {
            const detail =
              execution.stderr.trim() ||
              execution.stdout.trim() ||
              `exit code ${execution.exitCode}`
            this.options.eventSink?.({
              type: 'warning',
              message: `SessionEnd hook failed: ${detail}`,
            })
          }
          if (
            outcome?.blockedReason &&
            outcome.executions.at(-1)?.exitCode === 0
          ) {
            this.options.eventSink?.({
              type: 'warning',
              message: `SessionEnd hook failed: ${outcome.blockedReason}`,
            })
          }
        } catch (error) {
          this.options.eventSink?.({
            type: 'warning',
            message: `SessionEnd hook failed: ${error instanceof Error ? error.message : String(error)}`,
          })
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
    return resolveClaudePaths({
      configDir: this.options.configRoot,
      cwd: this.sessionCwds.get(sessionId) ?? this.activeCwd(),
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
      ...(this.options.contextReserveTokens === undefined
        ? {}
        : { reserveTokens: this.options.contextReserveTokens }),
    })
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
