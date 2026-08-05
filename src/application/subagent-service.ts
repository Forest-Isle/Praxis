import { randomBytes, randomUUID } from 'node:crypto'
import { join } from 'node:path'

import { resolveClaudePaths } from '../compatibility/claude/paths.js'
import {
  createClaudeAgentToolUseResult,
  createClaudeSidechainRoot,
  resolveClaudeSidechainPaths,
  toClaudeSidechainEntry,
} from '../compatibility/claude/sidechain.js'
import {
  type ClaudeTranscriptEntry,
  selectClaudeSchemaAdapter,
} from '../compatibility/claude/schema.js'
import {
  createClaudeHookAttachmentEntries,
  translateProviderEvents,
} from '../compatibility/claude/translation.js'
import type { ContextAssembler } from '../core/context.js'
import {
  AgentRuntime,
  type ModelProvider,
  type ModelToolCall,
  type ModelToolDefinition,
  type PermissionResolver,
  type RuntimeEvent,
  type RuntimeEventSink,
  type ToolExecutionContext,
  type ToolExecutionResult,
  type ToolRegistry,
} from '../core/runtime.js'
import type { ClaudeExtensionCatalog } from '../extensions/claude-extensions.js'
import { ClaudeHookToolCoordinator } from '../hooks/claude-hook-tools.js'
import type {
  ClaudeHookOutcome,
  ClaudeHookRunner,
} from '../hooks/claude-hooks.js'
import { ClaudeSidechainStore } from '../persistence/claude-sidechain-store.js'
import type {
  ClaudeTranscriptLease,
  TranscriptSnapshot,
} from '../persistence/claude-transcript-store.js'

const DEFAULT_MAX_DEPTH = 4
const DEFAULT_MAX_CALLS = 16
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024

interface AgentInput {
  description: string
  prompt: string
  subagentType: string
}

export interface ClaudeSubagentExecutorOptions {
  configRoot: string
  cwd: string
  claudeVersion: string
  provider: ModelProvider
  baseTools: ToolRegistry
  permissions: PermissionResolver
  extensions?: ClaudeExtensionCatalog
  hooks?: ClaudeHookRunner
  contextAssembler?: ContextAssembler
  approveTool?: (call: ModelToolCall) => boolean | Promise<boolean>
  eventSink?: RuntimeEventSink
  maxDepth?: number
  maxCalls?: number
  maxOutputBytes?: number
}

function parseAgentInput(call: ModelToolCall): AgentInput {
  const allowed = new Set([
    'description',
    'prompt',
    'subagent_type',
    'run_in_background',
  ])
  for (const key of Object.keys(call.input)) {
    if (!allowed.has(key)) throw new Error(`Unknown Agent input field ${key}`)
  }
  const description = call.input.description
  const prompt = call.input.prompt
  const subagentType = call.input.subagent_type
  if (typeof description !== 'string' || description.trim().length === 0) {
    throw new Error('description must be a non-empty string')
  }
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    throw new Error('prompt must be a non-empty string')
  }
  if (typeof subagentType !== 'string' || subagentType.length === 0) {
    throw new Error('subagent_type must be a non-empty string')
  }
  if (
    call.input.run_in_background !== undefined &&
    call.input.run_in_background !== false
  ) {
    throw new Error('Praxis does not support background Agent execution yet')
  }
  return { description, prompt, subagentType }
}

export class ClaudeSubagentExecutor {
  private readonly schema
  private calls = 0

  constructor(private readonly options: ClaudeSubagentExecutorOptions) {
    this.schema = selectClaudeSchemaAdapter(options.claudeVersion)
  }

  registry(
    sessionId: string,
    depth: number,
    promptIdForCall: (callId: string) => string | null,
  ): ToolRegistry {
    return new ClaudeSubagentToolRegistry(
      this.options.baseTools,
      this,
      sessionId,
      depth,
      promptIdForCall,
    )
  }

  definitions(): ModelToolDefinition {
    const types = [
      'general-purpose',
      ...(this.options.extensions?.agentNames() ?? []),
    ]
    return {
      name: 'Agent',
      description:
        'Run an isolated foreground subagent and return its completed result.',
      inputSchema: {
        type: 'object',
        properties: {
          description: { type: 'string', minLength: 1 },
          prompt: { type: 'string', minLength: 1 },
          subagent_type: { type: 'string', enum: [...new Set(types)] },
          run_in_background: { type: 'boolean', const: false },
        },
        required: ['description', 'prompt', 'subagent_type'],
        additionalProperties: false,
      },
    }
  }

  prepare(call: ModelToolCall, depth: number): ModelToolCall {
    const input = parseAgentInput(call)
    const spawnDepth = depth + 1
    if (spawnDepth > (this.options.maxDepth ?? DEFAULT_MAX_DEPTH)) {
      throw new Error(
        `Agent spawn depth exceeded ${this.options.maxDepth ?? DEFAULT_MAX_DEPTH}`,
      )
    }
    if (
      input.subagentType !== 'general-purpose' &&
      !this.options.extensions?.agent(input.subagentType)
    ) {
      throw new Error(`Unknown Claude agent ${input.subagentType}`)
    }
    return {
      ...call,
      input: {
        description: input.description,
        prompt: input.prompt,
        subagent_type: input.subagentType,
        run_in_background: false,
      },
    }
  }

  async execute(
    call: ModelToolCall,
    sessionId: string,
    depth: number,
    promptId: string,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    this.calls += 1
    const maxCalls = this.options.maxCalls ?? DEFAULT_MAX_CALLS
    if (this.calls > maxCalls) {
      throw new Error(`Agent call count exceeded ${maxCalls}`)
    }
    const input = parseAgentInput(call)
    const spawnDepth = depth + 1
    const agentId = randomBytes(8).toString('hex')
    const paths = resolveClaudePaths({
      configDir: this.options.configRoot,
      cwd: this.options.cwd,
      sessionId,
    })
    const sidechainPaths = resolveClaudeSidechainPaths(
      paths.projectRoot,
      sessionId,
      agentId,
    )
    const sidechain = new ClaudeSidechainStore(
      sidechainPaths,
      join(paths.praxisRoot, 'locks', `${sessionId}-${agentId}.lock`),
      this.schema,
    )
    const root = createClaudeSidechainRoot({
      sessionId,
      promptId,
      prompt: input.prompt,
      agentId,
      cwd: this.options.cwd,
      claudeVersion: this.options.claudeVersion,
      gitBranch: null,
      uuid: randomUUID(),
      timestamp: new Date().toISOString(),
    })
    await sidechain.create(root, {
      agentType: input.subagentType,
      description: input.description,
      toolUseId: call.id,
      spawnDepth,
    })

    const startedAt = Date.now()
    const result = await sidechain.withLease(async (lease) =>
      this.runSidechain({
        lease,
        root,
        input,
        agentId,
        spawnDepth,
        promptId,
        transcriptPath: sidechainPaths.transcriptFile,
        toolResultDirectory: join(paths.projectRoot, sessionId, 'tool-results'),
        ...(context.signal ? { signal: context.signal } : {}),
      }),
    )
    const maxOutputBytes =
      this.options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
    if (Buffer.byteLength(result.text) > maxOutputBytes) {
      throw new Error(`Agent result exceeded ${maxOutputBytes} bytes`)
    }
    const durationMs = Date.now() - startedAt
    return {
      content: `${result.text}\n\nagentId: ${agentId}`,
      isError: false,
      usage: result.usage,
      nativeToolUseResult: createClaudeAgentToolUseResult({
        prompt: input.prompt,
        agentId,
        agentType: input.subagentType,
        text: result.text,
        resolvedModel: this.options.provider.model ?? 'praxis/provider',
        durationMs,
        usage: result.usage,
        toolUseCount: result.toolUseCount,
      }),
    }
  }

  private async runSidechain(options: {
    lease: ClaudeTranscriptLease
    root: ClaudeTranscriptEntry
    input: AgentInput
    agentId: string
    spawnDepth: number
    promptId: string
    transcriptPath: string
    toolResultDirectory: string
    signal?: AbortSignal
  }): Promise<{
    text: string
    usage: { inputTokens: number; outputTokens: number }
    toolUseCount: number
  }> {
    let snapshot: TranscriptSnapshot = {
      entries: [options.root],
      tail: (await options.lease.load()).tail,
    }
    let toolUseCount = 0
    const append = async (entry: ClaudeTranscriptEntry) => {
      const result = await options.lease.append(snapshot.tail, entry)
      if (result.status === 'conflict') {
        throw new Error(`Claude sidechain append conflict: ${result.reason}`)
      }
      snapshot = { entries: [...snapshot.entries, entry], tail: result.tail }
    }
    const translationContext = () => ({
      sessionId: String(options.root.sessionId),
      parentUuid: snapshot.tail.lastUuid,
      cwd: this.options.cwd,
      claudeVersion: this.options.claudeVersion,
      gitBranch: null,
      history: snapshot.entries,
    })
    const recordHookOutcome = async (outcome: ClaudeHookOutcome) => {
      for (const entry of createClaudeHookAttachmentEntries(
        outcome,
        translationContext(),
      )) {
        await append(
          toClaudeSidechainEntry(
            entry,
            options.agentId,
            options.input.subagentType,
          ),
        )
      }
    }
    const hookSession = {
      session_id: String(options.root.sessionId),
      transcript_path: options.transcriptPath,
      cwd: this.options.cwd,
      permission_mode: 'default',
    }
    const nestedTools = this.registry(
      String(options.root.sessionId),
      options.spawnDepth,
      () => options.promptId,
    )
    const runtimeTools = this.options.hooks
      ? new ClaudeHookToolCoordinator({
          tools: nestedTools,
          permissions: this.options.permissions,
          hooks: this.options.hooks,
          session: hookSession,
          recordOutcome: recordHookOutcome,
        })
      : nestedTools
    const runtimePermissions = this.options.hooks
      ? (runtimeTools as ClaudeHookToolCoordinator)
      : this.options.permissions
    const emit = (event: RuntimeEvent) => {
      if (event.type === 'tool-call') toolUseCount += 1
      if (event.type === 'warning') this.options.eventSink?.(event)
      if (event.type === 'failed') {
        this.options.eventSink?.({
          type: 'warning',
          message: `Subagent failed: ${event.message}`,
        })
      }
    }
    const runtime = new AgentRuntime(this.options.provider, emit, {
      tools: runtimeTools,
      permissions: runtimePermissions,
      maxModelTurns: 16,
      maxModelOutputBytes:
        this.options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      maxToolCallsPerTurn: 32,
      maxToolInputBytes: 1024 * 1024,
    })
    const observer = {
      assistantCompleted: async (message: {
        content: string
        toolCalls?: readonly ModelToolCall[]
      }) => {
        const [entry] = translateProviderEvents(
          [
            {
              type: 'assistant-message' as const,
              text: message.content,
              toolCalls: message.toolCalls ?? [],
              providerMessageId: `msg_${randomUUID().replaceAll('-', '')}`,
              model: this.options.provider.model ?? 'praxis/provider',
            },
          ],
          translationContext(),
        )
        if (!entry) throw new Error('Could not translate subagent response')
        await append(
          toClaudeSidechainEntry(
            entry,
            options.agentId,
            options.input.subagentType,
          ),
        )
      },
      toolCompleted: async (
        call: ModelToolCall,
        result: ToolExecutionResult,
      ) => {
        const nestedToolUseCount = result.nativeToolUseResult?.totalToolUseCount
        if (
          call.name === 'Agent' &&
          typeof nestedToolUseCount === 'number' &&
          Number.isSafeInteger(nestedToolUseCount) &&
          nestedToolUseCount > 0
        ) {
          toolUseCount += nestedToolUseCount
        }
        const [entry] = translateProviderEvents(
          [
            {
              type: 'tool-result' as const,
              toolCallId: call.id,
              content: result.content,
              ...(result.images ? { images: result.images } : {}),
              isError: result.isError,
              ...(result.nativeToolUseResult
                ? { nativeToolUseResult: result.nativeToolUseResult }
                : {}),
            },
          ],
          translationContext(),
        )
        if (!entry) throw new Error('Could not translate subagent tool result')
        await append(
          toClaudeSidechainEntry(
            entry,
            options.agentId,
            options.input.subagentType,
          ),
        )
      },
      followUpUserMessagesCompleted: async (messages: readonly string[]) => {
        for (const text of messages) {
          const [entry] = translateProviderEvents(
            [{ type: 'user-text-block' as const, text }],
            translationContext(),
          )
          if (!entry) throw new Error('Could not translate subagent follow-up')
          await append(
            toClaudeSidechainEntry(
              entry,
              options.agentId,
              options.input.subagentType,
            ),
          )
        }
      },
    }

    try {
      if (this.options.hooks) {
        const start = await this.options.hooks.run(
          {
            ...hookSession,
            hook_event_name: 'SessionStart',
            source: 'startup',
          },
          'startup',
          options.signal,
        )
        await recordHookOutcome(start)
        if (start.blockedReason) {
          throw new Error(`SessionStart hook error: ${start.blockedReason}`)
        }
        const prompt = await this.options.hooks.run(
          {
            ...hookSession,
            hook_event_name: 'UserPromptSubmit',
            prompt_id: options.promptId,
            prompt: options.input.prompt,
          },
          undefined,
          options.signal,
        )
        await recordHookOutcome(prompt)
        if (prompt.blockedReason) {
          throw new Error(
            `UserPromptSubmit hook error: ${prompt.blockedReason}`,
          )
        }
      }
      const customAgent = this.options.extensions?.agent(
        options.input.subagentType,
      )
      const system =
        options.input.subagentType === 'general-purpose'
          ? 'You are a general-purpose subagent. Complete the isolated task and return a concise result.'
          : `# Agent definition: ${options.input.subagentType}\n\n${customAgent?.body ?? ''}`
      let stopHookActive = false
      return {
        ...(await runtime.run({
          messages: [
            ...((await this.options.contextAssembler?.assemble()) ?? []),
            { role: 'system', content: system },
            { role: 'user', content: options.input.prompt },
          ],
          cwd: this.options.cwd,
          toolResultDirectory: options.toolResultDirectory,
          observer,
          ...(this.options.approveTool
            ? { approveTool: this.options.approveTool }
            : {}),
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
                    options.signal,
                  )
                  if (!outcome) return []
                  await recordHookOutcome(outcome)
                  if (!outcome.blockedReason) return []
                  stopHookActive = true
                  return [`Stop hook error: ${outcome.blockedReason}`]
                },
              }
            : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        })),
        toolUseCount,
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
        for (const execution of outcome?.executions.filter(
          (value) => value.exitCode !== 0,
        ) ?? []) {
          this.options.eventSink?.({
            type: 'warning',
            message: `Subagent SessionEnd hook failed: ${execution.stderr.trim() || execution.stdout.trim() || `exit code ${execution.exitCode}`}`,
          })
        }
      } catch (error) {
        this.options.eventSink?.({
          type: 'warning',
          message: `Subagent SessionEnd hook failed: ${error instanceof Error ? error.message : String(error)}`,
        })
      }
    }
  }
}

class ClaudeSubagentToolRegistry implements ToolRegistry {
  constructor(
    private readonly base: ToolRegistry,
    private readonly executor: ClaudeSubagentExecutor,
    private readonly sessionId: string,
    private readonly depth: number,
    private readonly promptIdForCall: (callId: string) => string | null,
  ) {}

  definitions(): readonly ModelToolDefinition[] {
    return [...this.base.definitions(), this.executor.definitions()]
  }

  async prepare(
    call: ModelToolCall,
    context: ToolExecutionContext,
  ): Promise<ModelToolCall> {
    return call.name === 'Agent'
      ? this.executor.prepare(call, this.depth)
      : this.base.prepare(call, context)
  }

  async execute(
    call: ModelToolCall,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    if (call.name !== 'Agent') return this.base.execute(call, context)
    const promptId = this.promptIdForCall(call.id)
    if (!promptId)
      throw new Error(`Could not locate prompt for Agent ${call.id}`)
    return this.executor.execute(
      call,
      this.sessionId,
      this.depth,
      promptId,
      context,
    )
  }
}
