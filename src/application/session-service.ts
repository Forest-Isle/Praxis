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
} from '../compatibility/claude/paths.js'
import { createClaudeNativeFork } from '../compatibility/claude/fork.js'
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
  type ModelToolCall,
  type ModelProvider,
  type ModelUsage,
  type PermissionResolver,
  type RuntimeEventSink,
  type ToolRegistry,
} from '../core/runtime.js'
import type { Compactor } from '../core/compaction.js'
import { ContextBudget } from '../core/context-budget.js'
import type { ContextAssembler } from '../core/context.js'
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
import { ModelCompactor } from './model-compactor.js'
import { ClaudeSubagentExecutor } from './subagent-service.js'

export interface ClaudeSessionServiceOptions {
  configRoot: string
  cwd: string
  claudeVersion: string
  provider?: ModelProvider
  tools?: ToolRegistry
  permissions?: PermissionResolver
  approveTool?: (call: ModelToolCall) => boolean | Promise<boolean>
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
}

export interface SessionRunResult {
  sessionId: string
  text: string
  usage: ModelUsage
}

export interface SessionSummary {
  sessionId: string
  lastPrompt: string | null
  updatedAt: string
  status: SessionStatus
  issue: TranscriptParseIssue | null
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

export class ClaudeSessionService {
  private readonly schema

  constructor(private readonly options: ClaudeSessionServiceOptions) {
    this.schema = selectClaudeSchemaAdapter(options.claudeVersion)
  }

  async run(prompt: string, signal?: AbortSignal): Promise<SessionRunResult> {
    return this.executeTurn(randomUUID(), prompt, false, signal)
  }

  async resume(
    sessionId: string,
    prompt: string,
    signal?: AbortSignal,
  ): Promise<SessionRunResult> {
    return this.executeTurn(sessionId, prompt, true, signal)
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
            return {
              sessionId,
              lastPrompt: getClaudeLastPrompt(recovery.entries),
              updatedAt: metadata.mtime.toISOString(),
              status: this.sessionStatus(
                recovery.issue,
                recovery.entries.length,
              ),
              issue: recovery.issue,
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
    }
  }

  async export(sessionId: string): Promise<Buffer> {
    try {
      return await this.store(sessionId).exportReadOnly()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`Claude session not found: ${sessionId}`)
      }
      throw error
    }
  }

  async fork(parentSessionId: string): Promise<ForkResult> {
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

    const sessionId = randomUUID()
    const target = this.store(sessionId)
    const result = await target.create(
      createClaudeNativeFork({
        source: source.entries,
        sourceSessionId: parentSessionId,
        sessionId,
      }),
    )
    if (result.status === 'conflict') {
      throw new Error('Generated Claude fork session already exists')
    }
    return { sessionId, parentSessionId }
  }

  private async executeTurn(
    sessionId: string,
    prompt: string,
    requireExisting: boolean,
    signal?: AbortSignal,
  ): Promise<SessionRunResult> {
    this.assertWritable()
    if (prompt.length === 0) throw new Error('Prompt must not be empty')

    const store = this.store(sessionId)
    const leaseResult = await store.withLease(async (lease) => {
      let snapshot = await lease.load()
      if (requireExisting && snapshot.entries.length === 0) {
        throw new Error(`Claude session not found: ${sessionId}`)
      }
      const provider = this.provider()
      let currentPromptId: string | null = null
      const unresolvedToolCalls = findUnresolvedClaudeToolCalls(
        snapshot.entries,
      )
      const pendingRecoveryToolCallIds = new Set(
        unresolvedToolCalls.map((call) => call.id),
      )
      const pendingRecoveryHookOutcomes: ClaudeHookOutcome[] = []
      const hookSession = {
        session_id: sessionId,
        transcript_path: this.paths(sessionId).sessionFile,
        cwd: this.options.cwd,
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
        let parentUuid = snapshot.tail.lastUuid
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
      const subagentExecutor =
        this.options.enableSubagents &&
        this.options.tools &&
        this.options.permissions
          ? new ClaudeSubagentExecutor({
              configRoot: this.options.configRoot,
              cwd: this.options.cwd,
              claudeVersion: this.options.claudeVersion,
              provider,
              baseTools: this.options.tools,
              permissions: this.options.permissions,
              ...(this.options.extensions
                ? { extensions: this.options.extensions }
                : {}),
              ...(this.options.hooks ? { hooks: this.options.hooks } : {}),
              ...(this.options.contextAssembler
                ? { contextAssembler: this.options.contextAssembler }
                : {}),
              ...(this.options.approveTool
                ? { approveTool: this.options.approveTool }
                : {}),
              ...(this.options.eventSink
                ? { eventSink: this.options.eventSink }
                : {}),
            })
          : null
      const turnTools = subagentExecutor
        ? subagentExecutor.registry(
            sessionId,
            0,
            (callId) =>
              currentPromptId ??
              this.promptIdForToolCall(snapshot.entries, callId),
          )
        : this.options.tools
      const hookTools =
        this.options.hooks && turnTools && this.options.permissions
          ? new ClaudeHookToolCoordinator({
              tools: turnTools,
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
        ...(hookTools
          ? { tools: hookTools, permissions: hookTools }
          : {
              ...(turnTools ? { tools: turnTools } : {}),
              ...(this.options.permissions
                ? { permissions: this.options.permissions }
                : {}),
            }),
      })
      let lastAssistantUuid: string | null = null
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
            isError: boolean
            accessedPaths?: readonly string[]
            followUpUserMessages?: readonly string[]
            nativeToolUseResult?: Record<string, unknown>
          },
        ) => {
          const [entry] = translateProviderEvents(
            [
              {
                type: 'tool-result',
                toolCallId: call.id,
                content: toolResult.content,
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
          cwd: this.options.cwd,
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

        const contextMessages = [
          ...((await this.options.contextAssembler?.assemble()) ?? []),
          ...(agent
            ? [
                {
                  role: 'system' as const,
                  content: `# Agent definition: ${agent.name}\n\n${agent.body}`,
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
          ? (turnTools?.definitions() ?? [])
          : []
        const budget = this.contextBudget(provider)
        const pendingUserMessages = expansion.userMessages.map((content) => ({
          role: 'user' as const,
          content,
        }))
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
            [...contextMessages, ...historyMessages, ...pendingMessages],
            definitions,
          )
          if (!predicted.shouldCompact) return
          const irreducibleMessages = [
            ...contextMessages,
            ...pendingMessages,
            ...preservedUserMessages.map((content) => ({
              role: 'user' as const,
              content,
            })),
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
          const compactEntries = (postTokens: number) => {
            const uuids = [boundaryUuid, summaryUuid]
            return createClaudeCompactEntries({
              sessionId,
              logicalParentUuid,
              summary: compacted.summary,
              preTokens: budget.evaluate(
                [...contextMessages, ...historyMessages],
                definitions,
              ).estimatedTokens,
              postTokens,
              previousCumulativeDroppedTokens: getCumulativeDroppedTokens(
                snapshot.entries,
              ),
              durationMs: compacted.durationMs,
              cwd: this.options.cwd,
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
              cwd: this.options.cwd,
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
            [...contextMessages, ...compactedHistory],
            definitions,
          )
          const afterPending = budget.evaluate(
            [...contextMessages, ...compactedHistory, ...pendingMessages],
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
              index === 0
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
                ...projectClaudeModelMessages(snapshot.entries),
              ],
              definitions,
            ),
          )
        }

        let stopHookActive = false
        const runtimeRequest = {
          messages: [
            ...contextMessages,
            ...projectClaudeModelMessages(snapshot.entries),
          ],
          cwd: this.options.cwd,
          observer,
          reloadMessages: async () => {
            await compactIfNeeded([], currentTurnUserMessages ?? [])
            return [
              ...contextMessages,
              ...projectClaudeModelMessages(snapshot.entries),
            ]
          },
          ...(this.options.hooks
            ? {
                onStop: async (text: string) => {
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
                  if (!outcome) return []
                  await recordHookOutcome(outcome)
                  if (!outcome.blockedReason) return []
                  stopHookActive = true
                  return [`Stop hook error: ${outcome.blockedReason}`]
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
        return {
          sessionId,
          text: result.text,
          usage: {
            inputTokens:
              recoveryUsage.inputTokens +
              compactionUsage.inputTokens +
              result.usage.inputTokens,
            outputTokens:
              recoveryUsage.outputTokens +
              compactionUsage.outputTokens +
              result.usage.outputTokens,
          },
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

  private translationContext(sessionId: string, snapshot: TranscriptSnapshot) {
    return {
      sessionId,
      parentUuid: snapshot.tail.lastUuid,
      cwd: this.options.cwd,
      claudeVersion: this.options.claudeVersion,
      gitBranch: null,
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

  private displayRulePath(rulePath: string): string {
    const pathFromCwd = relative(this.options.cwd, rulePath)
    return pathFromCwd.startsWith('..') || isAbsolute(pathFromCwd)
      ? rulePath
      : pathFromCwd
  }

  private paths(sessionId: string) {
    return resolveClaudePaths({
      configDir: this.options.configRoot,
      cwd: this.options.cwd,
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
}
