import { randomUUID } from 'node:crypto'
import { readdir, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative } from 'node:path'

import type { ClaudeConditionalRuleResolver } from '../compatibility/claude/context.js'
import {
  createClaudeCompactEntries,
  formatClaudeCompactSummary,
  getCumulativeDroppedTokens,
} from '../compatibility/claude/compaction.js'
import { resolveClaudePaths } from '../compatibility/claude/paths.js'
import { createClaudeTextFork } from '../compatibility/claude/fork.js'
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
  type TranscriptSnapshot,
  type TranscriptTail,
} from '../persistence/claude-transcript-store.js'
import { ModelCompactor } from './model-compactor.js'

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
          const store = this.store(sessionId)
          const [snapshot, metadata] = await Promise.all([
            store.load(),
            stat(join(paths.projectRoot, name)),
          ])
          return {
            sessionId,
            lastPrompt: getClaudeLastPrompt(snapshot.entries),
            updatedAt: metadata.mtime.toISOString(),
          }
        }),
    )
    return summaries.sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    )
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
      createClaudeTextFork({
        source: source.entries,
        sessionId,
        cwd: this.options.cwd,
        claudeVersion: this.options.claudeVersion,
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
      const hookSession = {
        session_id: sessionId,
        transcript_path: this.paths(sessionId).sessionFile,
        cwd: this.options.cwd,
        permission_mode: 'default',
      }
      const recordHookOutcome = async (outcome: ClaudeHookOutcome) => {
        for (const entry of createClaudeHookAttachmentEntries(
          outcome,
          this.translationContext(sessionId, snapshot),
        )) {
          const tail = await this.append(lease, snapshot.tail, entry)
          snapshot = { entries: [...snapshot.entries, entry], tail }
        }
      }
      const hookTools =
        this.options.hooks && this.options.tools && this.options.permissions
          ? new ClaudeHookToolCoordinator({
              tools: this.options.tools,
              permissions: this.options.permissions,
              hooks: this.options.hooks,
              session: hookSession,
              recordOutcome: recordHookOutcome,
            })
          : null
      const runtime = new AgentRuntime(provider, this.options.eventSink, {
        emitInitialContextState: false,
        ...(hookTools
          ? { tools: hookTools, permissions: hookTools }
          : {
              ...(this.options.tools ? { tools: this.options.tools } : {}),
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
          },
        ) => {
          const [entry] = translateProviderEvents(
            [
              {
                type: 'tool-result',
                toolCallId: call.id,
                content: toolResult.content,
                isError: toolResult.isError,
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
          await recordHookOutcome(outcome)
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
                  if (await approveRecovery(call)) return true
                  throw new Error(
                    `Claude session tool call ${call.id} recovery was declined`,
                  )
                },
                approveTool: () => true,
              }
            : {}),
        }
        const unresolvedToolCalls = findUnresolvedClaudeToolCalls(
          snapshot.entries,
        )
        const unresolvedToolCall = unresolvedToolCalls[0]
        if (unresolvedToolCall && !approveRecovery) {
          throw new Error(
            `Claude session tool call ${unresolvedToolCall.id} requires explicit recovery approval`,
          )
        }
        await runtime.recoverToolCalls(unresolvedToolCalls, recoveryRequest)

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
          ? (this.options.tools?.definitions() ?? [])
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

        let promptId: string | undefined
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
          if (promptId === undefined && typeof userEntry.uuid === 'string') {
            promptId = userEntry.uuid
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
              prompt_id: promptId ?? randomUUID(),
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
            inputTokens: compactionUsage.inputTokens + result.usage.inputTokens,
            outputTokens:
              compactionUsage.outputTokens + result.usage.outputTokens,
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
