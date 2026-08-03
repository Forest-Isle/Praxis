import { randomUUID } from 'node:crypto'
import { readdir, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative } from 'node:path'

import type { ClaudeConditionalRuleResolver } from '../compatibility/claude/context.js'
import { resolveClaudePaths } from '../compatibility/claude/paths.js'
import { createClaudeTextFork } from '../compatibility/claude/fork.js'
import {
  getClaudeLastPrompt,
  projectClaudeModelMessages,
} from '../compatibility/claude/projection.js'
import {
  type ClaudeTranscriptEntry,
  selectClaudeSchemaAdapter,
} from '../compatibility/claude/schema.js'
import { findUnresolvedClaudeToolCalls } from '../compatibility/claude/tool-links.js'
import {
  createClaudeLastPromptEntry,
  createClaudeRuleAttachmentEntry,
  translateProviderEvents,
} from '../compatibility/claude/translation.js'
import {
  AgentRuntime,
  type ModelToolCall,
  type ModelProvider,
  type ModelUsage,
  type PermissionResolver,
  type RuntimeEventSink,
  type ToolRegistry,
} from '../core/runtime.js'
import type { ContextAssembler } from '../core/context.js'
import {
  ClaudeTranscriptStore,
  type ClaudeTranscriptLease,
  type TranscriptSnapshot,
  type TranscriptTail,
} from '../persistence/claude-transcript-store.js'

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
  eventSink?: RuntimeEventSink
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
      const runtime = new AgentRuntime(provider, this.options.eventSink, {
        ...(this.options.tools ? { tools: this.options.tools } : {}),
        ...(this.options.permissions
          ? { permissions: this.options.permissions }
          : {}),
      })
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
        },
        toolCompleted: async (
          call: ModelToolCall,
          toolResult: {
            content: string
            isError: boolean
            accessedPaths?: readonly string[]
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
      }
      const recoveryRequest = {
        cwd: this.options.cwd,
        observer,
        ...(signal ? { signal } : {}),
        ...(this.options.approveRecovery
          ? { approveTool: this.options.approveRecovery }
          : {}),
      }
      const unresolvedToolCalls = findUnresolvedClaudeToolCalls(
        snapshot.entries,
      )
      for (const unresolvedToolCall of unresolvedToolCalls) {
        if (!this.options.approveRecovery) {
          throw new Error(
            `Claude session tool call ${unresolvedToolCall.id} requires explicit recovery approval`,
          )
        }
        if (!(await this.options.approveRecovery(unresolvedToolCall))) {
          throw new Error(
            `Claude session tool call ${unresolvedToolCall.id} recovery was declined`,
          )
        }
      }
      await runtime.recoverToolCalls(unresolvedToolCalls, recoveryRequest)

      const contextMessages =
        (await this.options.contextAssembler?.assemble()) ?? []

      const [userEntry] = translateProviderEvents(
        [{ type: 'user-text', text: prompt }],
        this.translationContext(sessionId, snapshot),
      )
      if (!userEntry) throw new Error('Could not translate user prompt')
      const userTail = await this.append(lease, snapshot.tail, userEntry)
      snapshot = { entries: [...snapshot.entries, userEntry], tail: userTail }

      const runtimeRequest = {
        messages: [
          ...contextMessages,
          ...projectClaudeModelMessages(snapshot.entries),
        ],
        cwd: this.options.cwd,
        observer,
        reloadMessages: async () => [
          ...contextMessages,
          ...projectClaudeModelMessages(snapshot.entries),
        ],
        ...(this.options.approveTool
          ? { approveTool: this.options.approveTool }
          : {}),
      }
      const result = signal
        ? await runtime.run({ ...runtimeRequest, signal })
        : await runtime.run(runtimeRequest)

      const finalLeafUuid = snapshot.tail.lastUuid
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

      return { sessionId, text: result.text, usage: result.usage }
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
