import { randomUUID } from 'node:crypto'
import { lstat, readdir, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative } from 'node:path'

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
import { selectClaudeTranscriptAtMessage } from '../compatibility/claude/history.js'
import { ClaudeFileHistory } from '../compatibility/claude/file-history.js'
import { getClaudePrLink } from '../compatibility/claude/pr-links.js'
import {
  getClaudeAgentSetting,
  getClaudeLastPrompt,
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
  type ModelDocument,
  type ModelImage,
  type ModelMessage,
  type ModelToolCall,
  type ModelProvider,
  type ModelUsage,
  type PermissionApproval,
  type PermissionResolver,
  type RuntimeEventSink,
  type ToolRegistry,
} from '../core/runtime.js'
import { usageCostUsd } from '../core/usage.js'
import type { ModelPricingRegistry } from '../core/usage.js'
import type { Compactor } from '../core/compaction.js'
import { ContextBudget } from '../core/context-budget.js'
import {
  injectFirstUserMessageContext,
  type ContextAssembler,
} from '../core/context.js'
import type { ClaudeExtensionCatalog } from '../extensions/claude-extensions.js'
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
  type AgentPermissionMode,
  ClaudeSubagentExecutor,
  StructuredOutputRegistry,
} from './subagent-service.js'
import { ScheduledPromptManager } from './scheduled-prompt-manager.js'
import { ClaudeScheduledToolRegistry } from '../tools/claude-scheduled-tools.js'
import { ClaudeTaskToolRegistry } from '../tools/claude-task-tools.js'
import { ClaudeWorkflowToolRegistry } from '../tools/claude-workflow-tools.js'
import { WorkflowManager } from './workflow-manager.js'
import { SessionWorktreeManager } from './session-worktree.js'
import type {
  WorktreeSessionState,
  WorkspaceContext,
} from './session-worktree.js'
import { ClaudeWorktreeToolRegistry } from '../tools/claude-worktree-tools.js'
import { generateToolUseSummary } from './tool-use-summary.js'
import {
  ClaudeUserMessageToolRegistry,
  CLAUDE_USER_MESSAGE_PROMPT,
  type UserMessage,
} from '../tools/claude-user-message.js'

export interface ClaudeSessionServiceOptions {
  configRoot: string
  cwd: string
  claudeVersion: string
  provider?: ModelProvider
  tools?: ToolRegistry
  permissions?: PermissionResolver
  permissionResolverForMode?: (mode: AgentPermissionMode) => PermissionResolver
  approveTool?: (
    call: ModelToolCall,
    originalCall?: ModelToolCall,
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
  fileResources?: readonly ClaudeFileResource[]
  fileResourceConfig?: Omit<ClaudeFileResourceConfig, 'sessionId' | 'signal'>
  fileCheckpointing?: boolean
  fileRewindRoots?: readonly string[]
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

function validPromptSuggestion(value: string): string | null {
  const suggestion = value.trim()
  if (!suggestion) return null
  const words = suggestion.split(/\s+/u)
  if (words.length < 2 || words.length > 12) return null
  if (/[?？\n\r]/u.test(suggestion) || /[.!。！]/u.test(suggestion)) return null
  return suggestion
}

export class ClaudeSessionService {
  private readonly schema
  private readonly inMemoryStores = new Map<string, InMemoryTranscriptStore>()
  private readonly scheduledPrompts: ScheduledPromptManager | null
  private readonly workflowManager: WorkflowManager | null
  private readonly worktreeManager: SessionWorktreeManager | null
  private readonly sessionCwds = new Map<string, string>()
  private readonly hostedSubagents = new Set<ClaudeSubagentExecutor>()
  private readonly downloadedFileResourceSessions = new Set<string>()

  constructor(private readonly options: ClaudeSessionServiceOptions) {
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
    this.worktreeManager =
      options.enableWorktrees && options.workspace
        ? new SessionWorktreeManager({
            workspace: options.workspace,
            sessionId: '',
          })
        : null
  }

  nextScheduledPrompt(signal?: AbortSignal) {
    return this.scheduledPrompts?.next(signal) ?? Promise.resolve(null)
  }

  workflows(): readonly Record<string, unknown>[] {
    return this.workflowManager?.list() ?? []
  }

  async close(): Promise<void> {
    this.scheduledPrompts?.close()
    await Promise.all(
      [...this.hostedSubagents].map((executor) => executor.close()),
    )
    this.hostedSubagents.clear()
    await this.workflowManager?.close()
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
            ...(this.options.subagentToolNames
              ? { toolNames: this.options.subagentToolNames }
              : {}),
            ...(this.options.extensions
              ? { extensions: this.options.extensions }
              : {}),
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
    const preferredOrder = [
      'Agent',
      'TaskOutput',
      'Bash',
      'Read',
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
    return {
      definitions: () => {
        const definitions = messageRegistry.definitions()
        return [...definitions].sort((left, right) => {
          const leftIndex = preferredOrder.indexOf(left.name)
          const rightIndex = preferredOrder.indexOf(right.name)
          return (
            (leftIndex < 0 ? preferredOrder.length : leftIndex) -
            (rightIndex < 0 ? preferredOrder.length : rightIndex)
          )
        })
      },
      prepare: (call, context) => messageRegistry.prepare(call, context),
      execute: (call, context) => messageRegistry.execute(call, context),
    }
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

  async promptSuggestion(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const provider = this.provider()
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
    const agent = agentName ? this.options.extensions?.agent(agentName) : null
    const assembledContext = await this.options.contextAssembler?.assemble({
      cwd: this.activeCwd(),
    })
    const contextMessages = [
      ...(assembledContext?.systemMessages ?? []),
      ...(agent
        ? [
            {
              role: 'system' as const,
              content: `# Agent definition: ${agent.name}\n\n${agent.body}`,
            },
          ]
        : []),
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
    let suggestion = ''
    for await (const event of provider.complete({
      messages,
      ...(provider.capabilities.tools
        ? { tools: this.options.tools?.definitions() ?? [] }
        : {}),
      ...(this.options.effort ? { effort: this.options.effort } : {}),
      ...(signal ? { signal } : {}),
    })) {
      if (event.type === 'text-delta') suggestion += event.delta
      if (event.type === 'tool-call') return null
    }
    return validPromptSuggestion(suggestion)
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

  async fork(
    parentSessionId: string,
    sessionId: string = randomUUID(),
    resumeSessionAt?: string,
  ): Promise<ForkResult> {
    this.assertSessionPersistence()
    this.assertWritable()
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

    const target = this.store(sessionId)
    const result = await target.create(
      createClaudeNativeFork({
        source: source.entries,
        sourceSessionId: parentSessionId,
        sessionId,
        ...(resumeSessionAt === undefined ? {} : { resumeSessionAt }),
      }),
    )
    if (result.status === 'conflict') {
      throw new Error('Generated Claude fork session already exists')
    }
    return { sessionId, parentSessionId }
  }

  async rewindFiles(sessionId: string, userMessageId: string): Promise<void> {
    const result = await this.store(sessionId).withLease(async (lease) => {
      const snapshot = await lease.load()
      if (snapshot.entries.length === 0) {
        throw new Error(`Claude session not found: ${sessionId}`)
      }
      this.restoreWorktree(snapshot.entries)
      await new ClaudeFileHistory(this.options.configRoot, sessionId, [
        this.activeCwd(),
        ...(this.options.fileRewindRoots ?? []),
      ]).rewind(snapshot.entries, userMessageId)
    })
    if (result.status === 'conflict') {
      throw new Error(`Claude file rewind conflict: ${result.reason}`)
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
  ): Promise<SessionRunResult> {
    this.assertWritable()
    if (prompt.length === 0 && images.length === 0 && documents.length === 0)
      throw new Error('Prompt must not be empty')
    if (name !== undefined && name.length === 0) {
      throw new Error('Session name must not be empty')
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
      const provider = this.provider()
      const initialPricing = this.options.pricing?.resolve(
        provider.model ?? 'praxis/provider',
      )
      if (this.options.maxBudgetUsd !== undefined && !initialPricing) {
        throw new Error(
          `Cannot enforce --max-budget-usd: no pricing is configured for model ${provider.model ?? 'praxis/provider'}`,
        )
      }
      let currentPromptId: string | null = null
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
      const subagentExecutor =
        (this.options.enableSubagents || this.options.enableWorkflows) &&
        baseTools &&
        this.options.permissions
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
              permissions: this.options.permissions,
              ...(this.options.permissionResolverForMode
                ? {
                    permissionResolverForMode:
                      this.options.permissionResolverForMode,
                  }
                : {}),
              ...(this.options.subagentToolNames
                ? { toolNames: this.options.subagentToolNames }
                : {}),
              ...(this.options.extensions
                ? { extensions: this.options.extensions }
                : {}),
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
              tokenBudget: workflowTokenTarget(prompt),
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
      const fileHistoryTools: ToolRegistry | undefined =
        fileHistory && messageTools
          ? {
              definitions: () => messageTools.definitions(),
              prepare: (call, context) => messageTools.prepare(call, context),
              execute: async (call, context) => {
                const path =
                  call.name === 'Write' || call.name === 'Edit'
                    ? call.input.file_path
                    : call.name === 'NotebookEdit'
                      ? call.input.notebook_path
                      : undefined
                if (typeof path !== 'string') {
                  return messageTools.execute(call, context)
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
                  result = await messageTools.execute(call, context)
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
          : messageTools
      const structuredCapture = this.options.structuredOutputSchema
        ? { calls: 0, value: undefined as unknown }
        : undefined
      const structuredTools =
        this.options.structuredOutputSchema && structuredCapture
          ? new StructuredOutputRegistry(
              fileHistoryTools ?? this.options.tools ?? emptyToolRegistry,
              this.options.structuredOutputSchema,
              structuredCapture,
            )
          : fileHistoryTools
      const hookTools =
        this.options.hooks && structuredTools && this.options.permissions
          ? new ClaudeHookToolCoordinator({
              tools: structuredTools,
              permissions: this.options.permissions,
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
              ...(this.options.permissions
                ? { permissions: this.options.permissions }
                : {}),
            }),
      })
      let currentTurnUserMessages: string[] | null = null
      const observer = {
        assistantCompleted: async (message: {
          content: string
          toolCalls?: readonly ModelToolCall[]
        }) => {
          const [entry] = translateProviderEvents(
            [
              {
                type: 'assistant-message',
                text: message.content,
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
            images?: readonly ModelImage[]
            documents?: readonly ModelDocument[]
            isError: boolean
            accessedPaths?: readonly string[]
            followUpUserMessages?: readonly string[]
            nativeToolUseResult?: Record<string, unknown>
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
          const [entry] = translateProviderEvents(
            [
              {
                type: 'tool-result',
                toolCallId: call.id,
                content: toolResult.content,
                ...(toolResult.images ? { images: toolResult.images } : {}),
                ...(toolResult.documents
                  ? { documents: toolResult.documents }
                  : {}),
                isError: toolResult.isError,
                ...(toolResult.nativeToolUseResult
                  ? { nativeToolUseResult: toolResult.nativeToolUseResult }
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

        const agentName =
          this.options.agent ?? getClaudeAgentSetting(snapshot.entries)
        const agent = agentName
          ? this.options.extensions?.agent(agentName)
          : null
        if (agentName && !agent) {
          throw new Error(`Unknown Claude agent ${agentName}`)
        }
        if (
          this.options.agent &&
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
        const contextMessages = [
          ...(assembledContext?.systemMessages ?? []),
          ...(this.options.brief
            ? [
                {
                  role: 'system' as const,
                  content: CLAUDE_USER_MESSAGE_PROMPT,
                },
              ]
            : []),
          ...(agent
            ? [
                {
                  role: 'system' as const,
                  content: `# Agent definition: ${agent.name}\n\n${agent.body}`,
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

        const expansion = this.options.extensions?.expandPrompt(prompt) ?? {
          userMessages: [prompt],
        }
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
        const pendingUserMessages = expansion.userMessages.map(
          (content, index) => ({
            role: 'user' as const,
            content,
            ...(index === 0 && images.length > 0 ? { images } : {}),
            ...(index === 0 && documents.length > 0 ? { documents } : {}),
          }),
        )
        const injectDynamicContext = (
          messages: readonly ModelMessage[],
        ): ModelMessage[] =>
          injectFirstUserMessageContext(
            messages,
            assembledContext?.firstUserMessageContext,
          )
        let compactionAnchorUuid = this.lastMessageUuid(snapshot.entries)
        const compactIfNeeded = async (
          pendingMessages: readonly {
            role: 'user'
            content: string
          }[] = [],
          preservedUserMessages: readonly string[] = [],
        ) => {
          if (!budget) return
          const historyMessages = projectClaudeModelMessages(snapshot.entries)
          const predicted = budget.evaluate(
            [
              ...contextMessages,
              ...injectDynamicContext([...historyMessages, ...pendingMessages]),
            ],
            definitions,
          )
          if (!predicted.shouldCompact) return
          const irreducibleMessages = [
            ...contextMessages,
            ...injectDynamicContext([
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
            [...contextMessages, ...injectDynamicContext(historyMessages)],
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
            [...contextMessages, ...injectDynamicContext(compactedHistory)],
            definitions,
          )
          const afterPending = budget.evaluate(
            [
              ...contextMessages,
              ...injectDynamicContext([
                ...compactedHistory,
                ...pendingMessages,
              ]),
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

        for (const [index, text] of expansion.userMessages.entries()) {
          const [userEntry] = translateProviderEvents(
            [
              index === 0 && (images.length > 0 || documents.length > 0)
                ? { type: 'user-message', text, images, documents }
                : index === 0
                  ? { type: 'user-text', text }
                  : { type: 'user-text-block', text },
            ],
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

        if (this.options.hooks) {
          const outcome = await this.options.hooks.run(
            {
              ...hookSession,
              hook_event_name: 'UserPromptSubmit',
              prompt_id: currentPromptId ?? randomUUID(),
              prompt,
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
        if (budget) {
          await compactIfNeeded([], currentTurnUserMessages ?? [])
          budget.assertFits(
            budget.evaluate(
              [
                ...contextMessages,
                ...injectDynamicContext(
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
            ...injectDynamicContext(
              projectClaudeModelMessages(snapshot.entries),
            ),
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
              ...injectDynamicContext(
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
        await this.append(
          lease,
          snapshot.tail,
          createClaudeLastPromptEntry({
            sessionId,
            lastPrompt: prompt,
            leafUuid: finalLeafUuid,
          }),
        )
        const totalUsage = mergeUsage(
          mergeUsage(recoveryUsage, compactionUsage),
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
    return this.options.workspace?.cwd() ?? this.options.cwd
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
      cwd: this.sessionCwds.get(sessionId) ?? this.options.cwd,
      sessionId,
    })
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
