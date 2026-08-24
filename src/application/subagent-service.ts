import { randomBytes, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'

import { Ajv2020 } from 'ajv/dist/2020.js'

import { resolveClaudePaths } from '../compatibility/claude/paths.js'
import type { ClaudeJsonResource } from '../compatibility/claude/shared-resources.js'
import { workflowAgentFiles } from '../compatibility/claude/workflow.js'
import {
  createClaudeAsyncAgentToolUseResult,
  createClaudeAgentToolUseResult,
  createClaudeSidechainRoot,
  isClaudeAgentId,
  resolveClaudeSidechainPaths,
  toClaudeSidechainEntry,
  type ClaudeSidechainMetadata,
  type ClaudeSidechainPermissionMode,
  type ClaudeSidechainPaths,
} from '../compatibility/claude/sidechain.js'
import {
  projectClaudeModelMessages,
  projectClaudeSidechainContinuationMessages,
} from '../compatibility/claude/projection.js'
import {
  type ClaudeTranscriptEntry,
  selectClaudeSchemaAdapter,
} from '../compatibility/claude/schema.js'
import {
  createClaudeHookAttachmentEntries,
  translateProviderEvents,
} from '../compatibility/claude/translation.js'
import {
  injectFirstUserMessageContext,
  projectContextSnapshot,
  type ContextAssembler,
} from '../core/context.js'
import { assembleContextSnapshot } from '../core/prompt-composer.js'
import { ContextBudget } from '../core/context-budget.js'
import type { LifecycleState } from '../core/agent-orchestration.js'
import {
  AgentRuntime,
  type ModelMessage,
  type ModelProvider,
  type ModelThinkingBlock,
  type ModelToolCall,
  type ModelToolDefinition,
  type ModelUsage,
  type ModelUsageByModel,
  type PermissionResolver,
  type PermissionApproval,
  type PermissionDecision,
  type PermissionUpdate,
  type RuntimeEvent,
  type RuntimeEventSink,
  type ToolExecutionContext,
  type ToolExecutionResult,
  type ToolRegistry,
} from '../core/runtime.js'
import { resolveToolSchedulingPolicy } from '../core/tool-scheduling-policy.js'
import {
  BUILTIN_STATUSLINE_AGENT_PATH,
  type ClaudeAgentRuntimeDefinition,
  type ClaudeExtensionCatalog,
} from '../extensions/claude-extensions.js'
import { ClaudeHookToolCoordinator } from '../hooks/claude-hook-tools.js'
import type {
  ClaudeHookOutcome,
  ClaudeHookRunner,
} from '../hooks/claude-hooks.js'
import type { ClaudeMcpRuntime } from '../mcp/claude-mcp-tools.js'
import { ClaudeSidechainStore } from '../persistence/claude-sidechain-store.js'
import { InMemorySidechainStore } from '../persistence/in-memory-sidechain-store.js'
import {
  SubagentLifecycleStore,
  type SubagentExecution,
} from '../persistence/subagent-lifecycle-store.js'
import {
  resolveDataPlanePaths,
  type DataPlane,
} from '../persistence/data-plane.js'
import type {
  ClaudeTranscriptLease,
  TranscriptSnapshot,
} from '../persistence/claude-transcript-store.js'
import {
  BackgroundAgentManager,
  BackgroundAgentRunError,
  BackgroundAgentShutdownError,
  backgroundAgentNotificationMarkers,
  type BackgroundAgentNotificationIdentity,
  type BackgroundAgentSnapshot,
  type BackgroundAgentRunResult,
  type BackgroundAgentLifecycleSource,
  type BackgroundAgentTaskSpec,
} from './background-agent-manager.js'
import { isBackgroundBashTaskId } from './background-task-id.js'
import {
  createManagedWorktree,
  restoreManagedWorktree,
  type ManagedWorktree,
} from './managed-worktree.js'
import { createWorkflowWorktree } from './workflow-worktree.js'
import {
  NativeSidechainTranscript,
  type NativeSidechainMetadata,
} from './native-sidechain-transcript.js'
import type { NativeSessionTranscriptLease } from './native-session-transcript.js'
import {
  DurableFollowUpTracker,
  type DurableFollowUpBatch,
} from './durable-follow-up.js'

const DEFAULT_MAX_DEPTH = 4
const DEFAULT_MAX_CALLS = 16
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024

const SIDECHAIN_DISCOVERY_MAX_DEPTH = 4

function mergeSubagentUsage(left: ModelUsage, right: ModelUsage): ModelUsage {
  for (const usage of [left, right]) {
    for (const field of [
      'inputTokens',
      'outputTokens',
      'cacheReadInputTokens',
      'cacheCreationInputTokens',
      'webSearchRequests',
    ] as const) {
      const value = usage[field]
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
        throw new Error(`Subagent usage has an invalid ${field}`)
      }
    }
    for (const field of ['contextWindow', 'maxOutputTokens'] as const) {
      const value = usage[field]
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
        throw new Error(`Subagent usage has an invalid ${field}`)
      }
    }
  }
  const counters = {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadInputTokens:
      (left.cacheReadInputTokens ?? 0) + (right.cacheReadInputTokens ?? 0),
    cacheCreationInputTokens:
      (left.cacheCreationInputTokens ?? 0) +
      (right.cacheCreationInputTokens ?? 0),
    webSearchRequests:
      (left.webSearchRequests ?? 0) + (right.webSearchRequests ?? 0),
  }
  if (Object.values(counters).some((value) => !Number.isSafeInteger(value))) {
    throw new Error('Subagent usage total overflow')
  }
  const metadata = (field: 'contextWindow' | 'maxOutputTokens') => {
    const leftValue = left[field]
    const rightValue = right[field]
    if (
      leftValue !== undefined &&
      rightValue !== undefined &&
      leftValue !== rightValue
    ) {
      throw new Error(`Subagent usage has conflicting ${field}`)
    }
    return leftValue ?? rightValue
  }
  const contextWindow = metadata('contextWindow')
  const maxOutputTokens = metadata('maxOutputTokens')
  return {
    inputTokens: counters.inputTokens,
    outputTokens: counters.outputTokens,
    ...(counters.cacheReadInputTokens === 0
      ? {}
      : { cacheReadInputTokens: counters.cacheReadInputTokens }),
    ...(counters.cacheCreationInputTokens === 0
      ? {}
      : { cacheCreationInputTokens: counters.cacheCreationInputTokens }),
    ...(counters.webSearchRequests === 0
      ? {}
      : { webSearchRequests: counters.webSearchRequests }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
  }
}

function mergeSubagentModelUsage(
  target: Map<string, ModelUsage>,
  source: ModelUsageByModel,
): void {
  for (const [model, usage] of Object.entries(source)) {
    if (model.trim().length === 0) {
      throw new Error('Subagent model usage has a blank model name')
    }
    target.set(
      model,
      mergeSubagentUsage(
        target.get(model) ?? { inputTokens: 0, outputTokens: 0 },
        usage,
      ),
    )
  }
}

class SubagentExecutionFailure extends Error {
  override readonly name = 'SubagentExecutionFailure'

  constructor(
    cause: unknown,
    readonly result: BackgroundAgentRunResult,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
  }
}

const structuredOnlyTools: ToolRegistry = {
  definitions: () => [],
  schedulingPolicy: () => ({ concurrency: 'exclusive' }),
  prepare: async (call) => call,
  execute: async () => ({ content: '', isError: false }),
}

export interface WorkflowAgentRunOptions {
  sessionId: string
  promptId: string
  runId: string
  agentId: string
  transcriptDirectory: string
  prompt: string
  label?: string
  model?: string
  effort?: string
  isolation?: 'worktree'
  agentType?: string
  schema?: Record<string, unknown>
  signal?: AbortSignal
}

export interface WorkflowAgentRunResult {
  result: unknown
  usage: ModelUsage
  modelUsage?: ModelUsageByModel
  durationApiMs?: number
  durationApiWithoutRetriesMs?: number
  toolUseCount: number
  durationMs: number
  resolvedModel: string
  isolationPath?: string
  isolationRetained?: boolean
  isolationWarning?: string
}

interface AgentInput {
  description: string
  prompt: string
  subagentType: string
  model?: string
  name?: string
  teamName?: string
  permissionMode?: AgentPermissionMode
  isolation?: 'worktree'
  runInBackground: boolean
}

interface DiscoveredSidechainCandidate {
  agentId: string
  paths: ClaudeSidechainPaths
  metadataModifiedAt?: number
  name?: string
}

interface ForegroundAgentTask {
  spec: BackgroundAgentTaskSpec
  controller: AbortController
  operation: Promise<BackgroundAgentRunResult>
  startedAt: number
  detachParentSignal(): void
  resolveHandoff(): void
  backgrounded: boolean
}

function sidechainAgentIdFromFile(
  fileName: string,
  suffix: '.jsonl' | '.meta.json',
): string | undefined {
  if (!fileName.startsWith('agent-') || !fileName.endsWith(suffix)) {
    return undefined
  }
  const agentId = fileName.slice('agent-'.length, -suffix.length)
  return isClaudeAgentId(agentId) ? agentId : undefined
}

async function readSidechainMetadataName(
  metadataFile: string,
): Promise<string | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(metadataFile, 'utf8'))
    if (!value || typeof value !== 'object') return undefined
    const name = (value as Record<string, unknown>).name
    return typeof name === 'string' ? name : undefined
  } catch {
    return undefined
  }
}

function projectNativeSidechainContinuationMessages(
  messages: readonly ModelMessage[],
): ModelMessage[] {
  const callCounts = new Map<string, number>()
  const resultCounts = new Map<string, number>()
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const call of message.toolCalls ?? [])
        callCounts.set(call.id, (callCounts.get(call.id) ?? 0) + 1)
    } else if (message.role === 'tool') {
      resultCounts.set(
        message.toolCallId,
        (resultCounts.get(message.toolCallId) ?? 0) + 1,
      )
    }
  }
  for (const [callId, count] of callCounts) {
    if (count > 1)
      throw new Error(
        `Native sidechain continuation has duplicate tool ID ${callId}`,
      )
  }
  for (const [callId, count] of resultCounts) {
    if (count > 1)
      throw new Error(
        `Native sidechain continuation has duplicate tool result ${callId}`,
      )
  }
  const resolved = new Set(
    [...callCounts.keys()].filter((callId) => resultCounts.get(callId) === 1),
  )
  return messages.flatMap((message): ModelMessage[] => {
    if (message.role === 'assistant') {
      const toolCalls = (message.toolCalls ?? []).filter((call) =>
        resolved.has(call.id),
      )
      if (message.content.trim() === '' && toolCalls.length === 0) return []
      return [
        {
          role: 'assistant',
          content: message.content,
          ...(message.thinkingBlocks
            ? { thinkingBlocks: message.thinkingBlocks }
            : {}),
          ...(toolCalls.length === 0 ? {} : { toolCalls }),
        },
      ]
    }
    if (message.role === 'tool' && !resolved.has(message.toolCallId)) return []
    return [message]
  })
}

export type AgentPermissionMode = ClaudeSidechainPermissionMode

export class StructuredOutputRegistry implements ToolRegistry {
  private readonly validate

  constructor(
    private readonly base: ToolRegistry,
    private readonly schema: Record<string, unknown>,
    private readonly capture?: { calls: number; value: unknown },
  ) {
    this.validate = new Ajv2020({ allErrors: true, strict: false }).compile(
      schema,
    )
  }

  definitions(): readonly ModelToolDefinition[] {
    const base = this.base.definitions()
    const existing = new Set(base.map(({ name }) => name))
    return [
      ...base,
      ...(existing.has('StructuredOutput')
        ? []
        : [
            {
              name: 'StructuredOutput',
              description:
                'Use this tool to return your final response in the requested structured format. You MUST call this tool exactly once at the end of your response to provide the structured output.',
              inputSchema: this.schema,
            },
          ]),
    ]
  }

  schedulingPolicy(call: ModelToolCall) {
    if (call.name === 'StructuredOutput') {
      return { concurrency: 'exclusive' as const }
    }
    return resolveToolSchedulingPolicy(this.base, call)
  }

  prepare(
    call: ModelToolCall,
    context: ToolExecutionContext,
  ): Promise<ModelToolCall> {
    if (call.name !== 'StructuredOutput')
      return this.base.prepare(call, context)
    if (this.capture && this.capture.calls > 0) {
      throw new Error('StructuredOutput must be called exactly once')
    }
    if (!this.validate(call.input)) {
      throw new Error(
        `StructuredOutput validation failed: ${this.validate.errors
          ?.map(
            (error) =>
              `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`,
          )
          .join('; ')}`,
      )
    }
    return Promise.resolve(call)
  }

  execute(
    call: ModelToolCall,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    if (call.name !== 'StructuredOutput')
      return this.base.execute(call, context)
    if (!this.capture)
      throw new Error('StructuredOutput capture is unavailable')
    this.capture.calls += 1
    this.capture.value = structuredClone(call.input)
    return Promise.resolve({
      content: 'Structured output recorded.',
      isError: false,
    })
  }
}

class RestrictedToolRegistry implements ToolRegistry {
  private readonly allowed: ReadonlySet<string>

  constructor(
    private readonly base: ToolRegistry,
    names: readonly string[],
  ) {
    this.allowed = new Set(names)
  }

  definitions(): readonly ModelToolDefinition[] {
    return this.base
      .definitions()
      .filter((definition) => this.allowed.has(definition.name))
  }

  schedulingPolicy(call: ModelToolCall) {
    if (!this.allowed.has(call.name)) {
      return { concurrency: 'exclusive' as const }
    }
    return resolveToolSchedulingPolicy(this.base, call)
  }

  prepare(
    call: ModelToolCall,
    context: ToolExecutionContext,
  ): Promise<ModelToolCall> {
    if (!this.allowed.has(call.name))
      throw new Error(`Tool ${call.name} is unavailable to this agent`)
    return this.base.prepare(call, context)
  }

  execute(
    call: ModelToolCall,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    if (!this.allowed.has(call.name))
      throw new Error(`Tool ${call.name} is unavailable to this agent`)
    return this.base.execute(call, context)
  }
}

const AGENT_UNAVAILABLE_TOOLS = new Set([
  'Agent',
  'Task',
  'TaskOutput',
  'TaskStop',
  'ExitPlanMode',
  'EnterPlanMode',
  'AskUserQuestion',
  'Workflow',
])

const BACKGROUND_AGENT_TOOLS = new Set([
  'Read',
  'WebSearch',
  'TodoWrite',
  'Grep',
  'WebFetch',
  'Glob',
  'Bash',
  'Edit',
  'Write',
  'NotebookEdit',
  'Skill',
  'StructuredOutput',
  'ToolSearch',
  'EnterWorktree',
  'ExitWorktree',
])

function agentToolRuleName(rule: string): string {
  const opening = rule.indexOf('(')
  return (opening < 0 ? rule : rule.slice(0, opening)).trim()
}

function enabledAgentToolNames(
  base: ToolRegistry,
  definition: ClaudeAgentRuntimeDefinition | null,
  background: boolean,
  permissionMode: AgentPermissionMode | undefined,
  additiveTools: ReadonlySet<string> = new Set(),
): readonly string[] {
  const requested = definition?.tools
    ? new Set(definition.tools.map(agentToolRuleName))
    : null
  if (requested && definition?.memory) {
    requested.add('Read')
    requested.add('Edit')
    requested.add('Write')
  }
  const disallowed = new Set(
    definition?.disallowedTools?.map(agentToolRuleName) ?? [],
  )
  return base
    .definitions()
    .map(({ name }) => name)
    .filter((name) => {
      if (additiveTools.has(name)) return true
      if (
        AGENT_UNAVAILABLE_TOOLS.has(name) &&
        !(name === 'ExitPlanMode' && permissionMode === 'plan')
      ) {
        return false
      }
      if (
        background &&
        !name.startsWith('mcp__') &&
        !BACKGROUND_AGENT_TOOLS.has(name)
      ) {
        return false
      }
      if (requested && !requested.has(name)) return false
      return !disallowed.has(name)
    })
}

function agentMemoryDirectory(
  configRoot: string,
  cwd: string,
  agentType: string,
  scope: NonNullable<ClaudeAgentRuntimeDefinition['memory']>,
  dataPlane: DataPlane,
): string {
  const directoryName = agentType.replaceAll(':', '-')
  if (scope === 'user') {
    return join(configRoot, 'agent-memory', directoryName)
  }
  return join(
    cwd,
    dataPlane === 'native' ? '.praxis' : '.claude',
    scope === 'project' ? 'agent-memory' : 'agent-memory-local',
    directoryName,
  )
}

export async function agentMemoryPrompt(
  configRoot: string,
  cwd: string,
  definition: ClaudeAgentRuntimeDefinition | null,
  dataPlane: DataPlane,
): Promise<string | null> {
  if (!definition?.memory) return null
  const directory = agentMemoryDirectory(
    configRoot,
    cwd,
    definition.name,
    definition.memory,
    dataPlane,
  )
  await mkdir(directory, { recursive: true }).catch(() => undefined)
  let source = ''
  try {
    source = await readFile(join(directory, 'MEMORY.md'), 'utf8')
  } catch {
    source = ''
  }
  const lines = source.trim().split('\n')
  const truncated = lines.slice(0, 200).join('\n').slice(0, 25_000)
  const scopeGuidance =
    definition.memory === 'user'
      ? 'Keep entries general enough to apply across projects.'
      : definition.memory === 'project'
        ? 'Keep entries specific to this project and suitable for version control.'
        : 'Keep entries specific to this project and machine; this scope is not version controlled.'
  return [
    '# Persistent Agent Memory',
    '',
    `Use the file-based memory directory at \`${directory}\`. The directory already exists.`,
    'Keep MEMORY.md as a concise index and store detailed durable knowledge in linked Markdown files. Update existing entries instead of duplicating them, and do not save transient task state.',
    scopeGuidance,
    '',
    '## MEMORY.md',
    '',
    truncated || 'The memory index is currently empty.',
  ].join('\n')
}

function agentSkillMessages(
  catalog: ClaudeExtensionCatalog | undefined,
  definition: ClaudeAgentRuntimeDefinition | null,
): readonly { role: 'user'; content: string }[] {
  if (!catalog || !definition?.skills?.length) return []
  const available = catalog.modelInvocableSkills()
  const prefix = definition.name.split(':')[0]
  return definition.skills.flatMap((requested) => {
    const skill =
      available.find(({ name }) => name === requested) ??
      available.find(({ name }) => name === `${prefix}:${requested}`) ??
      available.find(({ name }) => name.endsWith(`:${requested}`))
    if (!skill) return []
    const content = catalog.renderSkill(skill.name, '')
    if (content === null) return []
    return [
      {
        role: 'user' as const,
        content: [
          `<command-message>${skill.name}</command-message>`,
          `<command-name>${skill.name}</command-name>`,
          '<skill-format>true</skill-format>',
          '',
          content,
        ].join('\n'),
      },
    ]
  })
}

function agentHookSettings(
  definition: ClaudeAgentRuntimeDefinition | null,
): readonly ClaudeJsonResource[] {
  if (!definition?.hooks) return []
  const { Stop, SubagentStop, ...hooks } = definition.hooks
  const stopHooks =
    Stop === undefined
      ? SubagentStop
      : SubagentStop === undefined
        ? Stop
        : Array.isArray(Stop) && Array.isArray(SubagentStop)
          ? [...SubagentStop, ...Stop]
          : Stop
  return [
    {
      path: definition.path,
      scope: definition.scope,
      value: {
        hooks: {
          ...hooks,
          ...(stopHooks === undefined ? {} : { SubagentStop: stopHooks }),
        },
      },
    },
  ]
}

export interface ClaudeSubagentExecutorOptions {
  configRoot: string
  dataPlane: DataPlane
  cwd: string
  cwdProvider?: () => string
  claudeVersion: string
  provider: ModelProvider
  baseTools: ToolRegistry
  permissions: PermissionResolver
  permissionResolverForMode?: (mode: AgentPermissionMode) => PermissionResolver
  parentPermissionMode?: () => AgentPermissionMode
  extensions?: ClaudeExtensionCatalog
  mcp?: ClaudeMcpRuntime
  hooks?: ClaudeHookRunner
  contextAssembler?: ContextAssembler
  contextReserveTokens?: number
  approveTool?: (
    call: ModelToolCall,
    originalCall?: ModelToolCall,
    decision?: PermissionDecision,
  ) => PermissionApproval | Promise<PermissionApproval>
  permissionUpdates?: () => readonly PermissionUpdate[]
  onPermissionUpdates?: (
    updates: readonly PermissionUpdate[],
  ) => void | Promise<void>
  eventSink?: RuntimeEventSink
  maxDepth?: number
  maxCalls?: number
  maxOutputBytes?: number
  providerForModel?: (model: string) => ModelProvider
  toolNames?: readonly string[]
  backgroundTaskNotifications?: (waitForRunning: boolean) => Promise<string[]>
  notificationDelivered?: (notification: {
    agentId: string
    toolUseId: string
    status: 'completed' | 'failed' | 'killed'
  }) => boolean
  stopOwnedBackgroundAgent?: (
    sessionId: string,
    agentId: string,
  ) => Promise<string | null>
  outputOwnedBackgroundAgent?: (
    sessionId: string,
    agentId: string,
    options: { block: boolean; timeout: number },
  ) => Promise<string | null>
  sendOwnedBackgroundAgent?: (
    sessionId: string,
    agentId: string,
    message: string,
    summary: string | undefined,
    toolUseId: string,
  ) => string | null | Promise<string | null>
  durableFollowUpSource?: () => Promise<DurableFollowUpBatch | null>
  persistence?: 'disk' | 'memory'
  experimentalNativeTranscriptWrites?: boolean
  onLineChanges?: (changes: {
    readonly linesAdded: number
    readonly linesRemoved: number
  }) => void | Promise<void>
}

function parseAgentInput(call: ModelToolCall): AgentInput {
  const allowed = new Set([
    'description',
    'prompt',
    'subagent_type',
    'model',
    'run_in_background',
    'name',
    'team_name',
    'mode',
    'isolation',
  ])
  for (const key of Object.keys(call.input)) {
    if (!allowed.has(key)) throw new Error(`Unknown Agent input field ${key}`)
  }
  const description = call.input.description
  const prompt = call.input.prompt
  const subagentType = call.input.subagent_type ?? 'general-purpose'
  const model = call.input.model
  const name = call.input.name
  const teamName = call.input.team_name
  const permissionMode = call.input.mode
  const isolation = call.input.isolation
  if (typeof description !== 'string' || description.trim().length === 0) {
    throw new Error('description must be a non-empty string')
  }
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    throw new Error('prompt must be a non-empty string')
  }
  if (typeof subagentType !== 'string' || subagentType.length === 0) {
    throw new Error('subagent_type must be a non-empty string')
  }
  if (model !== undefined && typeof model !== 'string') {
    throw new Error('model must be a string')
  }
  if (
    name !== undefined &&
    (typeof name !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(name))
  ) {
    throw new Error('name must be a valid agent name')
  }
  if (teamName !== undefined && typeof teamName !== 'string') {
    throw new Error('team_name must be a string')
  }
  if (
    permissionMode !== undefined &&
    (typeof permissionMode !== 'string' ||
      ![
        'acceptEdits',
        'auto',
        'bypassPermissions',
        'default',
        'dontAsk',
        'plan',
      ].includes(permissionMode))
  ) {
    throw new Error('mode is not a supported permission mode')
  }
  if (
    call.input.run_in_background !== undefined &&
    typeof call.input.run_in_background !== 'boolean'
  ) {
    throw new Error('run_in_background must be a boolean')
  }
  if (isolation !== undefined && isolation !== 'worktree') {
    if (isolation !== 'remote') {
      throw new Error('isolation must be worktree or remote')
    }
    throw new Error('Praxis does not support Agent isolation remote')
  }
  return {
    description,
    prompt,
    subagentType,
    ...(model === undefined ? {} : { model }),
    ...(name === undefined ? {} : { name }),
    ...(teamName === undefined ? {} : { teamName }),
    ...(permissionMode === undefined
      ? {}
      : { permissionMode: permissionMode as AgentPermissionMode }),
    ...(isolation === undefined ? {} : { isolation }),
    runInBackground: call.input.run_in_background === true,
  }
}

export class ClaudeSubagentExecutor {
  private readonly schema
  private calls = 0
  private readonly background = new BackgroundAgentManager()
  private readonly ephemeralSidechains = new Map<
    string,
    InMemorySidechainStore
  >()
  private readonly foreground = new Map<string, ForegroundAgentTask>()

  isEnabled(name: string): boolean {
    return this.options.toolNames?.includes(name) ?? true
  }

  constructor(private readonly options: ClaudeSubagentExecutorOptions) {
    if (
      options.experimentalNativeTranscriptWrites === true &&
      (options.dataPlane !== 'native' || options.persistence !== 'disk')
    ) {
      throw new Error(
        'experimental native transcript writes require native dataPlane and disk persistence',
      )
    }
    if (
      options.experimentalNativeTranscriptWrites === true &&
      options.hooks !== undefined
    ) {
      throw new Error(
        'experimental native sidechain writes do not support Claude hooks',
      )
    }
    this.schema = selectClaudeSchemaAdapter(options.claudeVersion)
  }

  private nativeSidechainWritesEnabled(): boolean {
    return this.options.experimentalNativeTranscriptWrites === true
  }

  async close(): Promise<void> {
    for (const agentId of [...this.foreground.keys()]) {
      this.backgroundForegroundTask(agentId)
    }
    await this.background.close()
    this.foreground.clear()
    this.ephemeralSidechains.clear()
  }

  backgroundSnapshots(): readonly BackgroundAgentSnapshot[] {
    return this.background.snapshots()
  }

  hasForegroundTask(): boolean {
    return this.foreground.size > 0
  }

  backgroundForegroundTask(identifier?: string): BackgroundAgentSnapshot {
    const candidates = [...this.foreground.entries()]
    const selected =
      identifier === undefined
        ? candidates.at(-1)
        : candidates.find(
            ([agentId, task]) =>
              agentId === identifier || task.spec.name === identifier,
          )
    if (!selected) {
      throw new Error(
        identifier === undefined
          ? 'No foreground agent is running'
          : `No foreground agent found with ID or name: ${identifier}`,
      )
    }
    const [, task] = selected
    if (task.backgrounded) {
      throw new Error(`Agent ${task.spec.agentId} is already backgrounded`)
    }
    const snapshot = this.background.adopt({
      spec: task.spec,
      controller: task.controller,
      operation: task.operation,
      startedAt: task.startedAt,
    })
    task.backgrounded = true
    task.detachParentSignal()
    task.resolveHandoff()
    return snapshot
  }

  stopBackgroundTask(taskId: string): Promise<string> {
    return this.background.stopAndWait(taskId)
  }

  outputBackgroundTask(
    taskId: string,
    options: { block: boolean; timeout: number },
  ): Promise<string> {
    return this.background.output(taskId, options)
  }

  sendBackgroundMessage(
    agentId: string,
    message: string,
    summary: string | undefined,
    toolUseId: string,
  ): string {
    return this.background.send(agentId, message, summary, toolUseId)
  }

  stopAllBackgroundTasks(): readonly string[] {
    return this.background.stopAll()
  }

  private cwd(): string {
    return this.options.cwdProvider?.() ?? this.options.cwd
  }

  private agentDefinition(
    input: Pick<AgentInput, 'subagentType'>,
  ): ClaudeAgentRuntimeDefinition | null {
    return this.options.extensions?.agent(input.subagentType) ?? null
  }

  private resolveAgentInput(input: AgentInput): AgentInput {
    const definition = this.agentDefinition(input)
    const environmentModel = process.env.CLAUDE_CODE_SUBAGENT_MODEL?.trim()
    const configuredModel =
      definition?.model && definition.model !== 'inherit'
        ? definition.model
        : undefined
    const model = environmentModel || input.model || configuredModel
    const parentPermissionMode =
      this.options.parentPermissionMode?.() ?? 'default'
    const definitionCanOverridePermissionMode = ![
      'acceptEdits',
      'auto',
      'bypassPermissions',
    ].includes(parentPermissionMode ?? 'default')
    const permissionMode =
      input.permissionMode ??
      (definitionCanOverridePermissionMode
        ? (definition?.permissionMode ?? parentPermissionMode)
        : parentPermissionMode)
    const isolation = input.isolation ?? definition?.isolation
    return {
      ...input,
      ...(model ? { model } : {}),
      ...(permissionMode ? { permissionMode } : {}),
      ...(isolation ? { isolation } : {}),
      runInBackground: input.runInBackground || definition?.background === true,
    }
  }

  registry(
    sessionId: string,
    depth: number,
    promptIdForCall: (callId: string) => string | null,
    parentAgentId?: string,
  ): ToolRegistry {
    return new ClaudeSubagentToolRegistry(
      this.options.baseTools,
      this,
      sessionId,
      depth,
      promptIdForCall,
      parentAgentId,
    )
  }

  definitions(): ModelToolDefinition {
    return {
      name: 'Agent',
      description:
        'Launch a new agent to handle complex, multi-step tasks. Agents run in the background by default; set run_in_background to false when the result is required synchronously.',
      inputSchema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: {
          description: {
            description: 'A short (3-5 word) description of the task',
            type: 'string',
          },
          prompt: {
            description: 'The task for the agent to perform',
            type: 'string',
          },
          subagent_type: {
            description: 'The type of specialized agent to use for this task',
            type: 'string',
          },
          model: {
            description:
              'Optional model override for this agent. Takes precedence over the agent definition\'s model frontmatter. If omitted, uses the agent definition\'s model, or inherits from the parent. Ignored for subagent_type: "fork" — forks always inherit the parent model.',
            type: 'string',
            enum: ['sonnet', 'opus', 'haiku', 'fable'],
          },
          run_in_background: {
            description:
              "Agents run in the background by default; you will be notified when one completes. Set to false only when your very next action depends on this agent's result and nothing else could usefully happen while it runs — otherwise leave it in the background so the user can hand you other work.",
            type: 'boolean',
          },
          isolation: {
            description:
              'Isolation mode. "worktree" creates a temporary git worktree so the agent works on an isolated copy of the repo. "remote" launches the agent in a remote cloud environment (always runs in background; availability is gated).',
            type: 'string',
            enum: ['worktree', 'remote'],
          },
        },
        required: ['description', 'prompt'],
        additionalProperties: false,
      },
    }
  }

  managementDefinitions(): readonly ModelToolDefinition[] {
    return [
      {
        name: 'SendMessage',
        description: 'Send a message to another agent.',
        inputSchema: {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          type: 'object',
          properties: {
            to: {
              description: 'Recipient: teammate name',
              type: 'string',
              allOf: [
                { pattern: '^[^\\n\\r]*$' },
                { pattern: '^[\\s\\S]{0,300}$' },
              ],
            },
            summary: {
              description:
                'A 5-10 word summary shown as a preview in the UI (required when message is a string)',
              type: 'string',
              maxLength: 200,
            },
            message: {
              description: 'Plain text message content',
              type: 'string',
            },
          },
          required: ['to', 'message'],
          additionalProperties: false,
        },
      },
      {
        name: 'TaskOutput',
        description:
          'Retrieves output and status from a running or completed background task.',
        inputSchema: {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          type: 'object',
          properties: {
            task_id: {
              description: 'The task ID to get output from',
              type: 'string',
            },
            block: {
              description: 'Whether to wait for completion',
              default: true,
              type: 'boolean',
            },
            timeout: {
              description: 'Max wait time in ms',
              default: 30000,
              type: 'number',
              minimum: 0,
              maximum: 600000,
            },
          },
          required: ['task_id', 'block', 'timeout'],
          additionalProperties: false,
        },
      },
      {
        name: 'TaskStop',
        description: 'Stops a running background task by its ID.',
        inputSchema: {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          type: 'object',
          properties: {
            task_id: {
              description:
                'The ID of the background task to stop. Agent-team teammates and named background agents are also accepted by agent ID or name.',
              type: 'string',
            },
            shell_id: {
              description: 'Deprecated: use task_id instead',
              type: 'string',
            },
          },
          additionalProperties: false,
        },
      },
    ]
  }

  prepare(call: ModelToolCall, depth: number): ModelToolCall {
    if (!this.isEnabled('Agent')) throw new Error('Tool Agent is unavailable')
    const input = this.resolveAgentInput(parseAgentInput(call))
    if (input.runInBackground && this.options.persistence === 'memory') {
      throw new Error('Background agents require session persistence')
    }
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
    if (input.model && !this.options.providerForModel) {
      throw new Error('Agent model overrides are unavailable for this provider')
    }
    if (
      input.permissionMode &&
      input.permissionMode !== 'default' &&
      !this.options.permissionResolverForMode
    ) {
      throw new Error('Agent permission mode overrides are unavailable')
    }
    return {
      ...call,
      input: {
        description: input.description,
        prompt: input.prompt,
        subagent_type: input.subagentType,
        ...(input.model ? { model: input.model } : {}),
        ...(input.name ? { name: input.name } : {}),
        ...(input.teamName ? { team_name: input.teamName } : {}),
        ...(input.permissionMode ? { mode: input.permissionMode } : {}),
        ...(input.isolation ? { isolation: input.isolation } : {}),
        run_in_background: input.runInBackground,
      },
    }
  }

  async execute(
    call: ModelToolCall,
    sessionId: string,
    depth: number,
    promptId: string,
    context: ToolExecutionContext,
    parentAgentId?: string,
  ): Promise<ToolExecutionResult> {
    this.calls += 1
    const maxCalls = this.options.maxCalls ?? DEFAULT_MAX_CALLS
    if (this.calls > maxCalls) {
      throw new Error(`Agent call count exceeded ${maxCalls}`)
    }
    const input = this.resolveAgentInput(parseAgentInput(call))
    const spawnDepth = depth + 1
    const agentId = `a${randomBytes(8).toString('hex')}`
    const parentCwd = context.cwd
    const paths = this.sessionPaths(sessionId, parentCwd)
    const sidechainPaths = resolveClaudeSidechainPaths(
      paths.projectRoot,
      sessionId,
      agentId,
    )
    const lifecycleStore =
      this.options.persistence === 'memory'
        ? undefined
        : new SubagentLifecycleStore(
            paths.praxisRoot,
            sessionId,
            agentId,
            sidechainPaths.transcriptFile,
          )
    const initialExecution = lifecycleStore
      ? await lifecycleStore.start()
      : undefined
    let initialIsolation: ManagedWorktree | undefined
    const settleInitialSetupFailure = async (
      primary: unknown,
      isolation?: ManagedWorktree,
    ): Promise<never> => {
      const secondary: unknown[] = []
      const message =
        primary instanceof Error ? primary.message : String(primary)
      try {
        await initialExecution?.finish(
          'failed',
          {
            text: message,
            usage: { inputTokens: 0, outputTokens: 0 },
            toolUseCount: 0,
            durationMs: 0,
          },
          message,
        )
      } catch (error) {
        secondary.push(error)
      }
      try {
        await initialExecution?.release()
      } catch (error) {
        secondary.push(error)
      }
      try {
        await isolation?.cleanup()
      } catch (error) {
        secondary.push(error)
      }
      if (secondary.length > 0)
        throw new AggregateError(
          [primary, ...secondary],
          'Background agent setup and cleanup failed',
        )
      throw primary
    }
    try {
      initialIsolation = input.isolation
        ? await this.createAgentWorktree(
            paths.praxisRoot,
            sessionId,
            agentId,
            parentCwd,
          )
        : undefined
    } catch (error) {
      return settleInitialSetupFailure(error, initialIsolation)
    }
    const agentCwd = initialIsolation?.cwd ?? parentCwd
    const nativeSidechain = this.nativeSidechainWritesEnabled()
      ? new NativeSidechainTranscript({
          ...sidechainPaths,
          lockFile: join(
            paths.praxisRoot,
            'locks',
            `${sessionId}-${agentId}.lock`,
          ),
        })
      : undefined
    const claudeSidechain = nativeSidechain
      ? undefined
      : this.sidechainStore(
          sessionId,
          agentId,
          sidechainPaths,
          paths.praxisRoot,
        )
    const root = nativeSidechain
      ? undefined
      : createClaudeSidechainRoot({
          sessionId,
          promptId,
          prompt: input.prompt,
          agentId,
          cwd: agentCwd,
          claudeVersion: this.options.claudeVersion,
          gitBranch: null,
          uuid: randomUUID(),
          timestamp: new Date().toISOString(),
        })
    try {
      const metadata = {
        agentType: input.subagentType,
        description: input.description,
        toolUseId: call.id,
        spawnDepth,
        ...(input.name ? { name: input.name } : {}),
        ...(input.permissionMode
          ? { permissionMode: input.permissionMode }
          : {}),
        ...(input.isolation ? { isolation: input.isolation } : {}),
        ...(parentAgentId ? { parentAgentId } : {}),
        ...(initialIsolation ? { worktreePath: initialIsolation.cwd } : {}),
      }
      if (nativeSidechain) {
        await nativeSidechain.create(input.prompt, {
          ...metadata,
          cwd: agentCwd,
          promptId,
        })
      } else {
        if (!claudeSidechain || !root)
          throw new Error('Claude sidechain initialization is unavailable')
        await claudeSidechain.create(root, metadata)
      }
    } catch (error) {
      return settleInitialSetupFailure(error, initialIsolation)
    }
    const provider = input.model
      ? (this.options.providerForModel?.(input.model) ?? this.options.provider)
      : this.options.provider
    const backgroundRun = this.createBackgroundAgentRun({
      input,
      parentCwd,
      ...(lifecycleStore ? { lifecycle: lifecycleStore } : {}),
      ...(initialExecution ? { initialExecution } : {}),
      ...(initialIsolation ? { initialIsolation } : {}),
      createIsolation: () =>
        this.createAgentWorktree(
          paths.praxisRoot,
          sessionId,
          agentId,
          parentCwd,
        ),
      execute: async (cwd, message, signal, continuation) => {
        const run = (lease: {
          claudeLease?: ClaudeTranscriptLease
          nativeLease?: NativeSessionTranscriptLease
        }) =>
          this.runSidechain({
            ...lease,
            sessionId,
            input,
            provider,
            agentId,
            spawnDepth,
            promptId,
            toolUseId: call.id,
            transcriptPath: sidechainPaths.transcriptFile,
            toolResultDirectory: join(
              paths.projectRoot,
              sessionId,
              'tool-results',
            ),
            ...(continuation ? { continuationMessage: message } : {}),
            signal,
            cwd,
          })
        if (nativeSidechain)
          return nativeSidechain.withLease((nativeLease) =>
            run({ nativeLease }),
          )
        if (!claudeSidechain)
          throw new Error('Claude sidechain execution is unavailable')
        return claudeSidechain.withLease((claudeLease) => run({ claudeLease }))
      },
    })
    const resolvedModel = provider.model ?? 'praxis/provider'
    const spec: BackgroundAgentTaskSpec = {
      agentId,
      ...(input.name ? { name: input.name } : {}),
      agentType: input.subagentType,
      description: input.description,
      prompt: input.prompt,
      toolUseId: call.id,
      outputFile: sidechainPaths.transcriptFile,
      resolvedModel,
      lifecycle: backgroundRun.lifecycle,
      run: backgroundRun.run,
      markBackground: backgroundRun.markBackground,
      ...(lifecycleStore
        ? {
            acknowledgeNotification: (notificationId: string) =>
              lifecycleStore.acknowledgeNotification(notificationId),
            prepareNotificationDetached: (
              notificationId: string,
              model: string,
            ) =>
              lifecycleStore.prepareNotificationDetached(notificationId, model),
            confirmNotificationDetached: (notificationId: string) =>
              lifecycleStore.confirmNotificationDetached(notificationId),
          }
        : {}),
    }
    const asyncResult = (): ToolExecutionResult => ({
      content: this.asyncLaunchResult({
        agentId,
        description: input.description,
        outputFile: sidechainPaths.transcriptFile,
        ...(initialIsolation ? { worktreePath: initialIsolation.cwd } : {}),
      }),
      isError: false,
      nativeToolUseResult: {
        ...createClaudeAsyncAgentToolUseResult({
          prompt: input.prompt,
          agentId,
          description: input.description,
          resolvedModel,
          outputFile: sidechainPaths.transcriptFile,
        }),
        ...(initialIsolation ? { worktreePath: initialIsolation.cwd } : {}),
      },
    })
    if (input.runInBackground) {
      try {
        this.background.launch(spec)
      } catch (error) {
        try {
          await backgroundRun.disposeBeforeStart()
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            'Background agent launch and pre-start cleanup failed',
          )
        }
        throw error
      }
      return asyncResult()
    }

    const controller = new AbortController()
    const abort = () => controller.abort(context.signal?.reason)
    context.signal?.addEventListener('abort', abort, { once: true })
    if (context.signal?.aborted) abort()
    const operation = backgroundRun.run(
      input.prompt,
      controller.signal,
      false,
      call.id,
    )
    let resolveHandoff!: () => void
    const handoff = new Promise<void>((resolve) => {
      resolveHandoff = resolve
    })
    const foreground: ForegroundAgentTask = {
      spec,
      controller,
      operation,
      startedAt: Date.now(),
      detachParentSignal: () =>
        context.signal?.removeEventListener('abort', abort),
      resolveHandoff,
      backgrounded: false,
    }
    this.foreground.set(agentId, foreground)
    let result: BackgroundAgentRunResult
    try {
      const outcome = await Promise.race([
        operation.then((value) => ({ kind: 'completed' as const, value })),
        handoff.then(() => ({ kind: 'backgrounded' as const })),
      ])
      if (outcome.kind === 'backgrounded') return asyncResult()
      result = outcome.value
    } finally {
      foreground.detachParentSignal()
      this.foreground.delete(agentId)
    }
    const maxOutputBytes =
      this.options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
    if (Buffer.byteLength(result.text) > maxOutputBytes) {
      throw new Error(`Agent result exceeded ${maxOutputBytes} bytes`)
    }
    return {
      content: [
        result.text,
        `agentId: ${agentId}`,
        ...(result.isolationPath
          ? [
              `worktreePath: ${result.isolationPath}`,
              `worktreeRetained: ${String(result.isolationRetained)}`,
              ...(result.isolationWarning
                ? [`worktreeWarning: ${result.isolationWarning}`]
                : []),
            ]
          : []),
      ].join('\n\n'),
      isError: false,
      usage: result.usage,
      ...(result.modelUsage ? { modelUsage: { ...result.modelUsage } } : {}),
      ...(result.durationApiMs === undefined
        ? {}
        : { durationApiMs: result.durationApiMs }),
      ...(result.durationApiWithoutRetriesMs === undefined
        ? {}
        : {
            durationApiWithoutRetriesMs: result.durationApiWithoutRetriesMs,
          }),
      nativeToolUseResult: {
        ...createClaudeAgentToolUseResult({
          prompt: input.prompt,
          agentId,
          agentType: input.subagentType,
          text: result.text,
          resolvedModel,
          durationMs: result.durationMs,
          usage: result.usage,
          toolUseCount: result.toolUseCount,
        }),
        ...(result.isolationPath
          ? {
              worktreePath: result.isolationPath,
              worktreeRetained: result.isolationRetained,
              ...(result.isolationWarning
                ? { worktreeWarning: result.isolationWarning }
                : {}),
            }
          : {}),
      },
    }
  }

  private sidechainStore(
    sessionId: string,
    agentId: string,
    paths: ClaudeSidechainPaths,
    lockRoot: string,
  ): ClaudeSidechainStore | InMemorySidechainStore {
    if (this.options.persistence !== 'memory') {
      return new ClaudeSidechainStore(
        paths,
        join(lockRoot, 'locks', `${sessionId}-${agentId}.lock`),
        this.schema,
      )
    }
    const key = `${sessionId}/${agentId}`
    let store = this.ephemeralSidechains.get(key)
    if (!store) {
      store = new InMemorySidechainStore(paths)
      this.ephemeralSidechains.set(key, store)
    }
    return store
  }

  private sessionPaths(sessionId: string, cwd = this.cwd()) {
    return this.options.dataPlane === 'native'
      ? resolveDataPlanePaths({
          dataPlane: 'native',
          root: this.options.configRoot,
          cwd,
          sessionId,
        })
      : resolveClaudePaths({
          configDir: this.options.configRoot,
          cwd,
          sessionId,
        })
  }

  private createAgentWorktree(
    praxisRoot: string,
    sessionId: string,
    agentId: string,
    cwd = this.cwd(),
  ): Promise<ManagedWorktree> {
    return createManagedWorktree({
      cwd,
      parentDirectory: join(praxisRoot, 'agent-worktrees'),
      directoryName: `${sessionId}-${agentId}`,
      label: 'Agent',
    })
  }

  private createBackgroundAgentRun(options: {
    input: AgentInput
    parentCwd: string
    lifecycle?: SubagentLifecycleStore
    initialLifecycleState?: LifecycleState
    recover?: boolean
    initialExecution?: SubagentExecution
    initialIsolation?: ManagedWorktree
    createIsolation: () => Promise<ManagedWorktree>
    execute: (
      cwd: string,
      message: string,
      signal: AbortSignal,
      continuation: boolean,
    ) => Promise<{
      text: string
      usage: ModelUsage
      modelUsage?: ModelUsageByModel
      toolUseCount: number
    }>
  }): {
    run: BackgroundAgentTaskSpec['run']
    markBackground(): void
    disposeBeforeStart(): Promise<void>
    lifecycle: BackgroundAgentLifecycleSource
  } {
    let availableIsolation = options.initialIsolation
    let retainedIsolation: ManagedWorktree | undefined
    let notificationExpected = options.input.runInBackground
    let recoverNext = options.recover ?? false
    let pendingExecution = options.initialExecution
    let disposed = false
    let lifecycleState: LifecycleState =
      options.initialExecution?.snapshot.state ??
      options.initialLifecycleState ??
      'queued'
    const lifecycleListeners = new Set<(state: LifecycleState) => void>()
    const publishLifecycle = (state: LifecycleState): void => {
      lifecycleState = state
      if (state === 'orphaned') recoverNext = true
      for (const listener of lifecycleListeners) listener(state)
    }
    const lifecycle: BackgroundAgentLifecycleSource = {
      current: () => lifecycleState,
      subscribe(listener) {
        lifecycleListeners.add(listener)
        return () => lifecycleListeners.delete(listener)
      },
    }
    const disposeBeforeStart = async (): Promise<void> => {
      if (disposed) return
      disposed = true
      const execution = pendingExecution
      pendingExecution = undefined
      const isolation = availableIsolation
      availableIsolation = undefined
      const errors: unknown[] = []
      if (execution) {
        try {
          const snapshot = await execution.finish(
            'failed',
            {
              text: 'Background agent launch was rejected before execution started',
              usage: { inputTokens: 0, outputTokens: 0 },
              toolUseCount: 0,
              durationMs: 0,
            },
            'Background agent launch was rejected before execution started',
          )
          publishLifecycle(snapshot.state)
        } catch (error) {
          errors.push(error)
        } finally {
          try {
            await execution.release()
            publishLifecycle(execution.snapshot.state)
          } catch (error) {
            errors.push(error)
          }
        }
      }
      if (isolation) {
        try {
          await isolation.cleanup()
        } catch (error) {
          errors.push(error)
        }
      }
      if (errors.length > 0) {
        throw new AggregateError(
          errors,
          'Background agent pre-start cleanup failed',
        )
      }
    }
    const run: BackgroundAgentTaskSpec['run'] = async (
      message,
      signal,
      continuation,
      currentToolUseId,
    ) => {
      let execution: SubagentExecution | undefined
      let cancellation: Promise<void> | undefined
      let lifecycleTerminalized = false
      let onAbort: (() => void) | undefined
      const startedAt = Date.now()
      let isolation: ManagedWorktree | undefined
      let result:
        | {
            text: string
            usage: ModelUsage
            modelUsage?: ModelUsageByModel
            durationApiMs?: number
            durationApiWithoutRetriesMs?: number
            toolUseCount: number
          }
        | undefined
      let failure: unknown
      let cleanup: { retained: boolean; reason?: string } | undefined
      const finishLifecycle = async (
        state: 'completed' | 'failed' | 'cancelled',
        result: BackgroundAgentRunResult,
        detail?: string,
        notification?: {
          id: string
          status: 'completed' | 'failed' | 'killed'
          toolUseId: string
          error: string | null
        },
      ): Promise<void> => {
        if (execution) {
          const snapshot = await execution.finish(
            state,
            result,
            detail,
            notification,
          )
          publishLifecycle(snapshot.state)
        } else publishLifecycle(state)
      }
      try {
        if (pendingExecution) {
          execution = pendingExecution
          pendingExecution = undefined
          publishLifecycle(execution.snapshot.state)
        } else if (options.lifecycle) {
          execution = await options.lifecycle.acquire(
            recoverNext ? 'recover' : continuation ? 'continue' : 'start',
          )
          publishLifecycle(execution.snapshot.state)
          recoverNext = false
        }
        if (execution) {
          const snapshot = await execution.running()
          publishLifecycle(snapshot.state)
        } else {
          publishLifecycle('running')
        }
        onAbort = () => {
          if (cancellation) return
          if (!execution) {
            cancellation = Promise.resolve(publishLifecycle('cancelling'))
            return
          }
          const activeExecution = execution
          const transition = activeExecution.beginCancellation()
          transition.catch(() => undefined)
          const observedCancellation = transition
            .then((snapshot) => publishLifecycle(snapshot.state))
            .finally(() => publishLifecycle(activeExecution.snapshot.state))
          observedCancellation.catch(() => undefined)
          cancellation = observedCancellation
        }
        signal.addEventListener('abort', onAbort, { once: true })
        if (signal.aborted) onAbort()
        try {
          isolation = options.input.isolation
            ? (retainedIsolation ??
              availableIsolation ??
              (await options.createIsolation()))
            : undefined
          availableIsolation = undefined
          result = await options.execute(
            isolation?.cwd ?? options.parentCwd,
            message,
            signal,
            continuation,
          )
        } catch (error) {
          failure = error
        } finally {
          try {
            cleanup = await isolation?.cleanup()
          } catch (error) {
            failure ??= error
          }
          retainedIsolation = cleanup?.retained ? isolation : undefined
        }
        if (failure !== undefined) {
          const underlyingFailure =
            failure instanceof SubagentExecutionFailure
              ? failure.cause
              : failure
          const failureMessage =
            underlyingFailure instanceof Error
              ? underlyingFailure.message
              : String(underlyingFailure)
          const detail = cleanup?.reason
            ? `${failureMessage}\n${cleanup.reason}`
            : failureMessage
          const partialResult =
            failure instanceof SubagentExecutionFailure
              ? failure.result
              : undefined
          const failureResult: BackgroundAgentRunResult = {
            ...partialResult,
            text: failureMessage,
            usage: partialResult?.usage ?? {
              inputTokens: 0,
              outputTokens: 0,
            },
            toolUseCount: partialResult?.toolUseCount ?? 0,
            durationMs: Date.now() - startedAt,
            ...(isolation ? { isolationPath: isolation.cwd } : {}),
            ...(cleanup ? { isolationRetained: cleanup.retained } : {}),
            ...(cleanup?.reason ? { isolationWarning: cleanup.reason } : {}),
          }
          await cancellation
          const status = signal.aborted ? 'killed' : 'failed'
          const notificationId =
            notificationExpected &&
            !(signal.reason instanceof BackgroundAgentShutdownError)
              ? randomUUID()
              : undefined
          await finishLifecycle(
            signal.aborted ? 'cancelled' : 'failed',
            failureResult,
            detail,
            notificationId
              ? {
                  id: notificationId,
                  status,
                  toolUseId: currentToolUseId,
                  error: detail,
                }
              : undefined,
          )
          lifecycleTerminalized = true
          if (!notificationExpected && !isolation && !cleanup?.reason) {
            throw underlyingFailure
          }
          throw new BackgroundAgentRunError(
            detail,
            { ...failureResult, ...(notificationId ? { notificationId } : {}) },
            underlyingFailure,
          )
        }
        if (!result) {
          const error = new Error('Agent completed without a result')
          const failureResult: BackgroundAgentRunResult = {
            text: error.message,
            usage: { inputTokens: 0, outputTokens: 0 },
            toolUseCount: 0,
            durationMs: Date.now() - startedAt,
            ...(isolation ? { isolationPath: isolation.cwd } : {}),
            ...(cleanup ? { isolationRetained: cleanup.retained } : {}),
            ...(cleanup?.reason ? { isolationWarning: cleanup.reason } : {}),
          }
          const notificationId =
            notificationExpected &&
            !(signal.reason instanceof BackgroundAgentShutdownError)
              ? randomUUID()
              : undefined
          await cancellation
          await finishLifecycle(
            signal.aborted ? 'cancelled' : 'failed',
            failureResult,
            error.message,
            notificationId
              ? {
                  id: notificationId,
                  status: signal.aborted ? 'killed' : 'failed',
                  toolUseId: currentToolUseId,
                  error: error.message,
                }
              : undefined,
          )
          lifecycleTerminalized = true
          if (!notificationExpected) throw error
          throw new BackgroundAgentRunError(
            error.message,
            { ...failureResult, ...(notificationId ? { notificationId } : {}) },
            error,
          )
        }
        const finalResult: BackgroundAgentRunResult = {
          ...result,
          durationMs: Date.now() - startedAt,
          ...(isolation ? { isolationPath: isolation.cwd } : {}),
          ...(cleanup ? { isolationRetained: cleanup.retained } : {}),
          ...(cleanup?.reason ? { isolationWarning: cleanup.reason } : {}),
        }
        await cancellation
        const status = signal.aborted ? 'killed' : 'completed'
        const detail = signal.aborted
          ? 'Agent was aborted before terminal cleanup'
          : undefined
        const notificationId =
          notificationExpected &&
          !(signal.reason instanceof BackgroundAgentShutdownError)
            ? randomUUID()
            : undefined
        await finishLifecycle(
          signal.aborted ? 'cancelled' : 'completed',
          finalResult,
          detail,
          notificationId
            ? {
                id: notificationId,
                status,
                toolUseId: currentToolUseId,
                error: status === 'killed' ? (detail ?? null) : null,
              }
            : undefined,
        )
        lifecycleTerminalized = true
        return {
          ...finalResult,
          ...(notificationId ? { notificationId } : {}),
        }
      } finally {
        if (onAbort) signal.removeEventListener('abort', onAbort)
        if (!lifecycleTerminalized) {
          try {
            await execution?.release()
          } catch (releaseError) {
            this.options.eventSink?.({
              type: 'warning',
              message: `Background agent execution cleanup could not release its durable owner; durable owner reconciliation is required: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`,
            })
          } finally {
            if (execution) publishLifecycle(execution.snapshot.state)
          }
        } else {
          try {
            await execution?.release()
          } finally {
            if (execution) publishLifecycle(execution.snapshot.state)
          }
        }
      }
    }
    return {
      run,
      markBackground: () => {
        notificationExpected = true
      },
      disposeBeforeStart,
      lifecycle,
    }
  }

  async runWorkflowAgent(
    options: WorkflowAgentRunOptions,
  ): Promise<WorkflowAgentRunResult> {
    if (this.options.persistence === 'memory') {
      throw new Error('Workflow agents require session persistence')
    }
    if (
      options.agentType &&
      options.agentType !== 'general-purpose' &&
      !this.options.extensions?.agent(options.agentType)
    ) {
      throw new Error(`Unknown Claude agent ${options.agentType}`)
    }
    if (options.model && !this.options.providerForModel) {
      throw new Error(
        'Workflow agent model overrides are unavailable for this provider',
      )
    }
    const provider = options.model
      ? (this.options.providerForModel?.(options.model) ??
        this.options.provider)
      : this.options.provider
    const input: AgentInput = {
      description: options.label ?? 'Workflow agent',
      prompt: options.prompt,
      subagentType: options.agentType ?? 'workflow-subagent',
      ...(options.model ? { model: options.model } : {}),
      runInBackground: false,
    }
    const agentFiles = workflowAgentFiles(
      options.transcriptDirectory,
      options.agentId,
    )
    const paths = {
      sessionId: options.sessionId,
      agentId: options.agentId,
      directory: options.transcriptDirectory,
      transcriptFile: agentFiles.transcriptFile,
      metadataFile: agentFiles.metadataFile,
    }
    const sessionPaths = this.sessionPaths(options.sessionId)
    const lockFile = join(
      sessionPaths.praxisRoot,
      'locks',
      `${options.sessionId}-${options.runId}-${options.agentId}.lock`,
    )
    const nativeSidechain = this.nativeSidechainWritesEnabled()
      ? new NativeSidechainTranscript({ ...paths, lockFile })
      : undefined
    const claudeSidechain = nativeSidechain
      ? undefined
      : new ClaudeSidechainStore(paths, lockFile, this.schema)
    const isolation = options.isolation
      ? await createWorkflowWorktree({
          cwd: this.cwd(),
          praxisRoot: sessionPaths.praxisRoot,
          runId: options.runId,
          agentId: options.agentId,
        })
      : null
    const agentCwd = isolation?.cwd ?? this.cwd()
    const root = nativeSidechain
      ? undefined
      : createClaudeSidechainRoot({
          sessionId: options.sessionId,
          promptId: options.promptId,
          prompt: options.prompt,
          agentId: options.agentId,
          cwd: agentCwd,
          claudeVersion: this.options.claudeVersion,
          gitBranch: null,
          uuid: randomUUID(),
          timestamp: new Date().toISOString(),
        })
    const startedAt = Date.now()
    const structured = { calls: 0, value: undefined as unknown }
    let run
    let cleanup: { retained: boolean; reason?: string } | undefined
    try {
      if (nativeSidechain) {
        await nativeSidechain.create(options.prompt, {
          agentType: options.agentType ?? 'workflow-subagent',
          description: input.description,
          toolUseId: `workflow:${options.runId}`,
          spawnDepth: 1,
          cwd: agentCwd,
          promptId: options.promptId,
          ...(options.isolation ? { isolation: options.isolation } : {}),
          ...(isolation ? { worktreePath: isolation.cwd } : {}),
        })
      } else {
        if (!claudeSidechain || !root)
          throw new Error('Claude workflow sidechain is unavailable')
        await claudeSidechain.createWorkflow(root, {
          agentType: options.agentType ?? 'workflow-subagent',
          spawnDepth: 1,
        })
      }
      const runWithLease = (lease: {
        claudeLease?: ClaudeTranscriptLease
        nativeLease?: NativeSessionTranscriptLease
      }) =>
        this.runSidechain({
          ...lease,
          sessionId: options.sessionId,
          input,
          provider,
          agentId: options.agentId,
          spawnDepth: 1,
          promptId: options.promptId,
          transcriptPath: paths.transcriptFile,
          toolResultDirectory: join(
            sessionPaths.projectRoot,
            options.sessionId,
            'tool-results',
          ),
          ...(options.schema
            ? { outputSchema: options.schema, structuredOutput: structured }
            : {}),
          ...(options.effort ? { effort: options.effort } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
          cwd: agentCwd,
        })
      if (nativeSidechain) {
        run = await nativeSidechain.withLease((nativeLease) =>
          runWithLease({ nativeLease }),
        )
      } else {
        if (!claudeSidechain)
          throw new Error('Claude workflow sidechain is unavailable')
        run = await claudeSidechain.withLease((claudeLease) =>
          runWithLease({ claudeLease }),
        )
      }
    } finally {
      cleanup = await isolation?.cleanup()
    }
    if (options.schema && structured.calls !== 1) {
      throw new Error(
        `StructuredOutput must be called exactly once (received ${structured.calls})`,
      )
    }
    return {
      result: options.schema ? structured.value : run.text,
      usage: run.usage,
      ...(run.modelUsage ? { modelUsage: { ...run.modelUsage } } : {}),
      ...(run.durationApiMs === undefined
        ? {}
        : { durationApiMs: run.durationApiMs }),
      ...(run.durationApiWithoutRetriesMs === undefined
        ? {}
        : {
            durationApiWithoutRetriesMs: run.durationApiWithoutRetriesMs,
          }),
      toolUseCount: run.toolUseCount,
      durationMs: Date.now() - startedAt,
      resolvedModel: provider.model ?? 'praxis/provider',
      ...(isolation ? { isolationPath: isolation.cwd } : {}),
      ...(cleanup ? { isolationRetained: cleanup.retained } : {}),
      ...(cleanup?.reason ? { isolationWarning: cleanup.reason } : {}),
    }
  }

  prepareManagement(call: ModelToolCall): ModelToolCall {
    if (!this.isEnabled(call.name)) {
      throw new Error(`Tool ${call.name} is unavailable`)
    }
    const allowed = new Set(
      this.managementDefinitions().map(({ name }) => name),
    )
    if (!allowed.has(call.name))
      throw new Error(`Unknown task tool ${call.name}`)
    if (call.name === 'TaskOutput') {
      const taskId = call.input.task_id
      const block = call.input.block ?? true
      const timeout = call.input.timeout ?? 30_000
      if (typeof taskId !== 'string' || taskId.length === 0) {
        throw new Error('task_id must be a non-empty string')
      }
      if (typeof block !== 'boolean') throw new Error('block must be a boolean')
      if (typeof timeout !== 'number')
        throw new Error('timeout must be a number')
      return { ...call, input: { task_id: taskId, block, timeout } }
    }
    if (call.name === 'TaskStop') {
      const taskId = call.input.task_id ?? call.input.shell_id
      if (typeof taskId !== 'string' || taskId.length === 0) {
        throw new Error('task_id must be a non-empty string')
      }
      return { ...call, input: { task_id: taskId } }
    }
    const to = call.input.to
    const message = call.input.message
    const summary = call.input.summary
    if (typeof to !== 'string' || to.length === 0) {
      throw new Error('to must be a non-empty string')
    }
    if (typeof message !== 'string' || message.trim().length === 0) {
      throw new Error('message must be a non-empty string')
    }
    if (summary !== undefined && typeof summary !== 'string') {
      throw new Error('summary must be a string')
    }
    return {
      ...call,
      input: { to, message, ...(summary === undefined ? {} : { summary }) },
    }
  }

  async executeManagement(
    call: ModelToolCall,
    sessionId: string,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    if (call.name === 'TaskOutput') {
      const taskId = String(call.input.task_id)
      const owned = await this.options.outputOwnedBackgroundAgent?.(
        sessionId,
        taskId,
        {
          block: Boolean(call.input.block),
          timeout: Number(call.input.timeout),
        },
      )
      if (owned !== undefined && owned !== null) {
        return { content: owned, isError: false }
      }
      await this.hydratePersistedTask(sessionId, taskId, context.cwd)
      return {
        content: await this.background.output(taskId, {
          block: Boolean(call.input.block),
          timeout: Number(call.input.timeout),
        }),
        isError: false,
      }
    }
    if (call.name === 'TaskStop') {
      const taskId = String(call.input.task_id)
      const owned = await this.options.stopOwnedBackgroundAgent?.(
        sessionId,
        taskId,
      )
      if (owned !== undefined && owned !== null) {
        return { content: owned, isError: false }
      }
      await this.hydratePersistedTask(sessionId, taskId, context.cwd)
      return {
        content: await this.background.stopAndWait(taskId),
        isError: false,
      }
    }
    const agentId = String(call.input.to)
    const summary =
      typeof call.input.summary === 'string' ? call.input.summary : undefined
    const owned = await this.options.sendOwnedBackgroundAgent?.(
      sessionId,
      agentId,
      String(call.input.message),
      summary,
      call.id,
    )
    if (owned !== undefined && owned !== null) {
      return { content: owned, isError: false }
    }
    await this.hydratePersistedTask(sessionId, agentId, context.cwd)
    return {
      content: this.background.send(
        agentId,
        String(call.input.message),
        summary,
        call.id,
      ),
      isError: false,
    }
  }

  notifications(
    waitForRunning: boolean,
    consume = true,
  ): Promise<{
    messages: string[]
    usage: ModelUsage
    modelUsage?: ModelUsageByModel
    durationApiMs?: number
    durationApiWithoutRetriesMs?: number
  }> {
    return this.background.notifications({ waitForRunning, consume })
  }

  acknowledgeNotifications(messages: readonly string[]): Promise<void> {
    return this.background.acknowledge(messages)
  }

  prepareNotificationsDetached(messages: readonly string[]): Promise<void> {
    return this.background.prepareNotificationsDetached(messages)
  }

  confirmNotificationsDetached(messages: readonly string[]): Promise<void> {
    return this.background.confirmNotificationsDetached(messages)
  }

  reconcileDeliveredNotifications(
    delivered: (
      notification: BackgroundAgentNotificationIdentity,
    ) => boolean = this.options.notificationDelivered ?? (() => false),
  ): Promise<void> {
    return this.background.acknowledgeDelivered(delivered)
  }

  reconcileDetachedNotifications(
    delivered: (notification: BackgroundAgentNotificationIdentity) => boolean,
  ): Promise<void> {
    return this.background.acknowledgeDeliveredAsDetached(delivered)
  }

  notificationClaimAgentIds(): string[] {
    return this.background.notificationClaimAgentIds()
  }

  async hydratePersistedTasks(
    sessionId: string,
    parentCwd: string,
    excludedAgentIds: ReadonlySet<string> = new Set(),
  ): Promise<void> {
    if (this.options.persistence === 'memory') return
    const paths = this.sessionPaths(sessionId, parentCwd)
    const candidates = await this.discoverSidechainCandidates(
      paths.projectRoot,
      sessionId,
    )
    for (const agentId of new Set(
      candidates.map((candidate) => candidate.agentId),
    )) {
      if (excludedAgentIds.has(agentId) || this.background.has(agentId)) {
        continue
      }
      try {
        const lifecycle = await new SubagentLifecycleStore(
          paths.praxisRoot,
          sessionId,
          agentId,
        ).read()
        if (
          !lifecycle?.notifications?.some(
            (notification) => !notification.consumed,
          )
        ) {
          continue
        }
        await this.hydratePersistedTask(sessionId, agentId, parentCwd)
      } catch (error) {
        this.options.eventSink?.({
          type: 'warning',
          message: `Background agent ${agentId} could not be recovered automatically: ${error instanceof Error ? error.message : String(error)}`,
        })
      }
    }
  }

  private async hydratePersistedTask(
    sessionId: string,
    identifier: string,
    parentCwd: string,
  ): Promise<void> {
    if (this.background.has(identifier)) return
    const paths = this.sessionPaths(sessionId, parentCwd)
    const sidechainPaths = await this.resolvePersistedSidechain(
      paths.projectRoot,
      sessionId,
      identifier,
    )
    if (!sidechainPaths) return
    const agentId = sidechainPaths.agentId
    const lockFile = join(
      paths.praxisRoot,
      'locks',
      `${sessionId}-${agentId}.lock`,
    )
    const nativeSidechain = this.nativeSidechainWritesEnabled()
      ? new NativeSidechainTranscript({ ...sidechainPaths, lockFile })
      : undefined
    const claudeSidechain = nativeSidechain
      ? undefined
      : new ClaudeSidechainStore(sidechainPaths, lockFile, this.schema)
    let metadata: ClaudeSidechainMetadata | NativeSidechainMetadata | null =
      null
    let root: ClaudeTranscriptEntry | undefined
    let projected: ModelMessage[]
    try {
      if (nativeSidechain) {
        await nativeSidechain.loadReadOnly()
        metadata = await nativeSidechain.metadata()
        projected = await nativeSidechain.withLease(async (lease) =>
          lease.activeMessages(),
        )
      } else {
        if (!claudeSidechain)
          throw new Error('Claude persisted sidechain is unavailable')
        const snapshot = await claudeSidechain.loadReadOnly()
        metadata = await claudeSidechain.metadata().catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
          throw error
        })
        root = snapshot.entries[0]
        if (!root || root.type !== 'user') {
          throw new Error(`Background agent ${agentId} has no sidechain root`)
        }
        projected = projectClaudeModelMessages(snapshot.entries)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    const rootMessage = projected[0]
    if (rootMessage?.role !== 'user' || rootMessage.content.trim() === '') {
      throw new Error(`Background agent ${agentId} has no sidechain root`)
    }
    const prompt = rootMessage.content
    const lastAssistant = projected.at(-1)
    const completed =
      lastAssistant?.role === 'assistant' &&
      lastAssistant.content.trim().length > 0 &&
      (lastAssistant.toolCalls?.length ?? 0) === 0
    const lifecycleStore = new SubagentLifecycleStore(
      paths.praxisRoot,
      sessionId,
      agentId,
      sidechainPaths.transcriptFile,
    )
    const ownership = await lifecycleStore.reconcileOwnerLoss()
    if (ownership.owned) return
    let lifecycle = await lifecycleStore.read()
    if (!lifecycle) {
      const seed = await lifecycleStore.start()
      await seed.running()
      if (completed) {
        await seed.finish('completed', {
          text: lastAssistant?.content ?? '',
          usage: { inputTokens: 0, outputTokens: 0 },
          toolUseCount: 0,
          durationMs: 0,
        })
      }
      await seed.release()
      lifecycle = await lifecycleStore.read()
    }
    if (!lifecycle) {
      throw new Error(
        `Unable to establish lifecycle state for background agent ${agentId}`,
      )
    }
    const lifecycleIsCurrent =
      lifecycle !== null && (await lifecycleStore.matchesTranscript(lifecycle))
    if (lifecycleIsCurrent && lifecycle.status === 'completed' && !completed) {
      throw new Error(
        `Background agent ${agentId} has completed lifecycle state but an incomplete sidechain`,
      )
    }
    const agentType = metadata?.agentType ?? 'general-purpose'
    const description = metadata?.description ?? 'Recovered Claude sidechain'
    const toolUseId = metadata?.toolUseId ?? `recovered:${agentId}`
    const spawnDepth = metadata?.spawnDepth ?? 1
    const name = metadata?.name
    const permissionMode = metadata?.permissionMode
    let isolation = metadata?.isolation
    let restoredIsolation: ManagedWorktree | undefined
    let restoredCwd = parentCwd
    if (isolation === 'worktree') {
      if (metadata?.worktreePath === undefined) {
        this.options.eventSink?.({
          type: 'warning',
          message: `Background agent ${agentId} has no retained worktree path; falling back to parent cwd ${parentCwd}`,
        })
        isolation = undefined
      } else {
        try {
          restoredIsolation = await restoreManagedWorktree({
            cwd: parentCwd,
            path: metadata.worktreePath,
            label: 'Agent',
          })
        } catch (error) {
          this.options.eventSink?.({
            type: 'warning',
            message: `Background agent ${agentId} could not restore its retained worktree; falling back to parent cwd ${parentCwd}: ${error instanceof Error ? error.message : String(error)}`,
          })
          isolation = undefined
        }
      }
    } else {
      const persistedCwd = nativeSidechain
        ? (metadata as NativeSidechainMetadata).cwd
        : root?.cwd
      if (
        typeof persistedCwd === 'string' &&
        persistedCwd.length > 0 &&
        !persistedCwd.includes('\0') &&
        isAbsolute(persistedCwd)
      ) {
        try {
          if (!(await lstat(persistedCwd)).isDirectory()) {
            throw new Error('persisted cwd is not a directory')
          }
          restoredCwd = persistedCwd
        } catch (error) {
          this.options.eventSink?.({
            type: 'warning',
            message: `Background agent ${agentId} could not restore its persisted cwd; falling back to parent cwd ${parentCwd}: ${error instanceof Error ? error.message : String(error)}`,
          })
        }
      } else {
        this.options.eventSink?.({
          type: 'warning',
          message: `Background agent ${agentId} has an invalid persisted cwd; falling back to parent cwd ${parentCwd}`,
        })
      }
    }
    const input: AgentInput = {
      description,
      prompt,
      subagentType: agentType,
      ...(name ? { name } : {}),
      ...(permissionMode ? { permissionMode } : {}),
      ...(isolation ? { isolation } : {}),
      runInBackground: true,
    }
    const provider = this.options.provider
    const recoveredPromptId = nativeSidechain
      ? (metadata as NativeSidechainMetadata).promptId
      : String(root?.promptId ?? randomUUID())
    const backgroundRun = this.createBackgroundAgentRun({
      input,
      parentCwd: restoredCwd,
      lifecycle: lifecycleStore,
      recover: lifecycle.lifecycle.state === 'orphaned',
      initialLifecycleState: lifecycle.lifecycle.state,
      ...(restoredIsolation ? { initialIsolation: restoredIsolation } : {}),
      createIsolation: () =>
        this.createAgentWorktree(
          paths.praxisRoot,
          sessionId,
          agentId,
          parentCwd,
        ),
      execute: async (cwd, message, signal, continuation) => {
        const run = (lease: {
          claudeLease?: ClaudeTranscriptLease
          nativeLease?: NativeSessionTranscriptLease
        }) =>
          this.runSidechain({
            ...lease,
            sessionId,
            input,
            provider,
            agentId,
            spawnDepth,
            promptId: recoveredPromptId,
            toolUseId,
            transcriptPath: sidechainPaths.transcriptFile,
            toolResultDirectory: join(
              paths.projectRoot,
              sessionId,
              'tool-results',
            ),
            ...(continuation ? { continuationMessage: message } : {}),
            signal,
            cwd,
          })
        if (nativeSidechain)
          return nativeSidechain.withLease((nativeLease) =>
            run({ nativeLease }),
          )
        if (!claudeSidechain)
          throw new Error('Claude persisted sidechain is unavailable')
        return claudeSidechain.withLease((claudeLease) => run({ claudeLease }))
      },
    })
    const spec = {
      agentId,
      ...(name ? { name } : {}),
      agentType,
      description,
      prompt,
      toolUseId,
      outputFile: sidechainPaths.transcriptFile,
      resolvedModel: provider.model ?? 'praxis/provider',
      lifecycle: backgroundRun.lifecycle,
      run: backgroundRun.run,
      markBackground: backgroundRun.markBackground,
      acknowledgeNotification: (notificationId: string) =>
        lifecycleStore.acknowledgeNotification(notificationId),
      prepareNotificationDetached: (notificationId: string, model: string) =>
        lifecycleStore.prepareNotificationDetached(notificationId, model),
      confirmNotificationDetached: (notificationId: string) =>
        lifecycleStore.confirmNotificationDetached(notificationId),
    }
    this.background.registerPersisted(spec, {
      ...(lifecycleIsCurrent && lifecycle.result
        ? { result: lifecycle.result }
        : completed
          ? {
              result: {
                text: lastAssistant.content,
                usage: { inputTokens: 0, outputTokens: 0 },
                toolUseCount: 0,
                durationMs: 0,
              },
            }
          : {}),
      ...(lifecycleIsCurrent && lifecycle.status === 'failed'
        ? { error: lifecycle.detail ?? 'Persisted agent failed' }
        : lifecycleIsCurrent && lifecycle.status === 'killed'
          ? { error: lifecycle.detail ?? 'Persisted agent was killed' }
          : !completed && lifecycle.lifecycle.state === 'orphaned'
            ? { error: 'Persisted agent was interrupted before completion' }
            : {}),
    })
    for (const notification of lifecycle?.notifications ?? []) {
      if (notification.consumed) continue
      if (
        this.options.notificationDelivered?.({
          agentId,
          toolUseId: notification.toolUseId,
          status: notification.status,
        })
      ) {
        if (
          notification.accounting?.kind === 'detached' &&
          !notification.accounting.delivered
        ) {
          await lifecycleStore.confirmNotificationDetached(notification.id)
        }
        await lifecycleStore.acknowledgeNotification(notification.id)
        continue
      }
      this.background.registerPersistedNotification(agentId, {
        id: notification.id,
        status:
          notification.status === 'killed' ? 'cancelled' : notification.status,
        result: notification.result,
        error: notification.error,
        toolUseId: notification.toolUseId,
      })
    }
  }

  private async resolvePersistedSidechain(
    projectRoot: string,
    sessionId: string,
    identifier: string,
  ): Promise<ClaudeSidechainPaths | null> {
    const isAgentId = isClaudeAgentId(identifier)
    const isName = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(identifier)
    if (!isAgentId && !isName) return null
    const candidates = await this.discoverSidechainCandidates(
      projectRoot,
      sessionId,
    )
    const matches = candidates.filter((candidate) =>
      isAgentId
        ? candidate.agentId === identifier
        : candidate.name === identifier,
    )
    if (matches.length > 1) {
      throw new Error(
        `Ambiguous persisted background agent ${identifier}: ${matches.length} sidechains match`,
      )
    }
    matches.sort(
      (left, right) =>
        (right.metadataModifiedAt ?? -Infinity) -
          (left.metadataModifiedAt ?? -Infinity) ||
        left.agentId.localeCompare(right.agentId) ||
        left.paths.directory.localeCompare(right.paths.directory),
    )
    return matches[0]?.paths ?? null
  }

  private async discoverSidechainCandidates(
    projectRoot: string,
    sessionId: string,
  ): Promise<DiscoveredSidechainCandidate[]> {
    const rootDirectory = join(projectRoot, sessionId, 'subagents')
    let rootStat
    try {
      rootStat = await lstat(rootDirectory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return []
    const candidates: DiscoveredSidechainCandidate[] = []
    const walk = async (directory: string, depth: number): Promise<void> => {
      if (depth > SIDECHAIN_DISCOVERY_MAX_DEPTH) return
      let entries
      try {
        entries = await readdir(directory, { withFileTypes: true })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
      const byName = new Map(entries.map((entry) => [entry.name, entry]))
      const subdirectory = relative(rootDirectory, directory).replaceAll(
        '\\',
        '/',
      )
      await Promise.all(
        entries.map(async (entry) => {
          if (entry.isSymbolicLink()) return
          const entryPath = join(directory, entry.name)
          if (entry.isDirectory()) {
            await walk(entryPath, depth + 1)
            return
          }
          if (!entry.isFile()) return
          const metadataAgentId = sidechainAgentIdFromFile(
            entry.name,
            '.meta.json',
          )
          if (metadataAgentId !== undefined) {
            const agentId = metadataAgentId
            const transcriptEntry = byName.get(`agent-${agentId}.jsonl`)
            if (
              !transcriptEntry ||
              transcriptEntry.isSymbolicLink() ||
              !transcriptEntry.isFile()
            ) {
              return
            }
            const paths = resolveClaudeSidechainPaths(
              projectRoot,
              sessionId,
              agentId,
              subdirectory === '' ? {} : { subdirectory },
            )
            let metadataStat
            try {
              metadataStat = await lstat(paths.metadataFile)
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
              throw error
            }
            if (metadataStat.isSymbolicLink() || !metadataStat.isFile()) return
            const name = await readSidechainMetadataName(paths.metadataFile)
            candidates.push({
              agentId,
              paths,
              metadataModifiedAt: metadataStat.mtimeMs,
              ...(name === undefined ? {} : { name }),
            })
            return
          }
          const transcriptAgentId = sidechainAgentIdFromFile(
            entry.name,
            '.jsonl',
          )
          if (transcriptAgentId === undefined) return
          const agentId = transcriptAgentId
          // A metadata companion (even an invalid one) is owned by the
          // metadata branch; only a bare transcript without metadata is a
          // legacy candidate.
          if (byName.has(`agent-${agentId}.meta.json`)) return
          candidates.push({
            agentId,
            paths: resolveClaudeSidechainPaths(
              projectRoot,
              sessionId,
              agentId,
              subdirectory === '' ? {} : { subdirectory },
            ),
          })
        }),
      )
    }
    await walk(rootDirectory, 0)
    return candidates
  }

  private asyncLaunchResult(options: {
    agentId: string
    description: string
    outputFile: string
    worktreePath?: string
  }): string {
    return [
      'Async agent launched successfully. (This tool result is internal metadata - never quote or paste any part of it into a user-facing reply.)',
      `agentId: ${options.agentId} (internal ID - do not mention to user. Use SendMessage with to: '${options.agentId}' to continue this agent.)`,
      'The agent is working in the background. You will be notified automatically when it completes.',
      "Do not duplicate this agent's work - avoid working with the same files or topics it is using.",
      `output_file: ${options.outputFile}`,
      ...(options.worktreePath
        ? [`worktree_path: ${options.worktreePath}`]
        : []),
      'Do NOT Read or tail this file via the shell tool - it is the full subagent JSONL transcript.',
    ].join('\n')
  }

  private async runSidechain(options: {
    claudeLease?: ClaudeTranscriptLease
    nativeLease?: NativeSessionTranscriptLease
    sessionId: string
    input: AgentInput
    provider: ModelProvider
    agentId: string
    spawnDepth: number
    promptId: string
    toolUseId?: string
    transcriptPath: string
    toolResultDirectory: string
    continuationMessage?: string
    outputSchema?: Record<string, unknown>
    structuredOutput?: { calls: number; value: unknown }
    effort?: string
    cwd?: string
    signal?: AbortSignal
  }): Promise<{
    text: string
    usage: { inputTokens: number; outputTokens: number }
    modelUsage?: ModelUsageByModel
    durationApiMs?: number
    durationApiWithoutRetriesMs?: number
    toolUseCount: number
  }> {
    const cwd = options.cwd ?? this.cwd()
    const permissions =
      options.input.permissionMode && options.input.permissionMode !== 'default'
        ? this.options.permissionResolverForMode?.(options.input.permissionMode)
        : this.options.permissions
    if (!permissions) {
      throw new Error('Agent permission mode overrides are unavailable')
    }
    if (
      (options.claudeLease === undefined) ===
      (options.nativeLease === undefined)
    )
      throw new Error('Exactly one sidechain transcript lease is required')
    const claudeLease = options.claudeLease
    const nativeLease = options.nativeLease
    let snapshot: TranscriptSnapshot | undefined = claudeLease
      ? await claudeLease.load()
      : undefined
    const requireClaudeSnapshot = (): TranscriptSnapshot => {
      if (!snapshot) throw new Error('Claude sidechain snapshot is unavailable')
      return snapshot
    }
    const nativeInterruption = nativeLease?.interruption()
    if (nativeInterruption?.kind === 'indeterminate-tools')
      throw new Error(
        `Native sidechain tool execution is indeterminate: ${nativeInterruption.callIds.join(', ')}`,
      )
    const nativeRecoveryCalls =
      options.continuationMessage === undefined &&
      nativeInterruption?.kind === 'recoverable-tools'
        ? [...nativeInterruption.calls]
        : []
    if (options.continuationMessage !== undefined) {
      // Validate ambiguous tool linkage before the append-only sidechain is
      // mutated. The projection is rebuilt after appending the one explicit
      // continuation prompt so that prompt is visible to the provider.
      const continuation = `The coordinator sent a message while you were working:\n${options.continuationMessage}\n\nAddress this before completing your current task.`
      if (nativeLease) {
        projectNativeSidechainContinuationMessages(nativeLease.activeMessages())
        await nativeLease.appendMessages({
          messages: [{ role: 'user', content: continuation }],
        })
      } else {
        const current = requireClaudeSnapshot()
        projectClaudeSidechainContinuationMessages(current.entries)
        const [entry] = translateProviderEvents(
          [{ type: 'user-text-block', text: continuation }],
          {
            sessionId: options.sessionId,
            parentUuid: current.tail.lastUuid,
            cwd,
            claudeVersion: this.options.claudeVersion,
            gitBranch: null,
            history: current.entries,
          },
        )
        if (!entry) throw new Error('Could not translate subagent message')
        const sidechainEntry = toClaudeSidechainEntry(
          entry,
          options.agentId,
          options.input.subagentType,
        )
        if (!claudeLease)
          throw new Error('Claude sidechain continuation is unavailable')
        const appendResult = await claudeLease.append(
          current.tail,
          sidechainEntry,
        )
        if (appendResult.status === 'conflict') {
          throw new Error(
            `Claude sidechain append conflict: ${appendResult.reason}`,
          )
        }
        snapshot = {
          entries: [...current.entries, sidechainEntry],
          tail: appendResult.tail,
        }
      }
    }
    const durableFollowUps = new DurableFollowUpTracker()
    let toolUseCount = 0
    let taskTokenTotal = 0
    let recordedUsage: ModelUsage = { inputTokens: 0, outputTokens: 0 }
    let pendingProviderUsage: ModelUsage | undefined
    const recordedModelUsage = new Map<string, ModelUsage>()
    let recordedDurationApiMs = 0
    let recordedDurationApiWithoutRetriesMs = 0
    let recordedApiDurationSeen = false
    let lastToolName: string | undefined
    const taskStartedAt = Date.now()
    const appendClaude = async (entry: ClaudeTranscriptEntry) => {
      if (!claudeLease)
        throw new Error('Claude sidechain append is unavailable')
      const current = requireClaudeSnapshot()
      const result = await claudeLease.append(current.tail, entry)
      if (result.status === 'conflict') {
        throw new Error(`Claude sidechain append conflict: ${result.reason}`)
      }
      snapshot = { entries: [...current.entries, entry], tail: result.tail }
    }
    const translationContext = () => {
      const current = requireClaudeSnapshot()
      return {
        sessionId: options.sessionId,
        parentUuid: current.tail.lastUuid,
        cwd,
        claudeVersion: this.options.claudeVersion,
        gitBranch: null,
        history: current.entries,
      }
    }
    const recordHookOutcome = async (outcome: ClaudeHookOutcome) => {
      if (nativeLease)
        throw new Error('Claude hooks are unavailable for native sidechains')
      for (const entry of createClaudeHookAttachmentEntries(
        outcome,
        translationContext(),
      )) {
        await appendClaude(
          toClaudeSidechainEntry(
            entry,
            options.agentId,
            options.input.subagentType,
          ),
        )
      }
    }
    const customAgent = this.agentDefinition(options.input)
    const hookSession = {
      session_id: options.sessionId,
      transcript_path: options.transcriptPath,
      cwd,
      permission_mode: options.input.permissionMode ?? 'default',
    }
    const scopedHookSettings = agentHookSettings(customAgent)
    const scopedHooks =
      scopedHookSettings.length > 0
        ? this.options.hooks?.withAdditionalSettings(scopedHookSettings)
        : this.options.hooks
    const commitProviderUsage = () => {
      if (!pendingProviderUsage) return
      recordedUsage = mergeSubagentUsage(recordedUsage, pendingProviderUsage)
      const model = options.provider.model?.trim()
      if (model) {
        mergeSubagentModelUsage(recordedModelUsage, {
          [model]: {
            ...pendingProviderUsage,
            ...(options.provider.capabilities.contextWindowTokens === undefined
              ? {}
              : {
                  contextWindow:
                    options.provider.capabilities.contextWindowTokens,
                }),
            ...(options.provider.capabilities.maxOutputTokens === undefined
              ? {}
              : {
                  maxOutputTokens:
                    options.provider.capabilities.maxOutputTokens,
                }),
          },
        })
      }
      pendingProviderUsage = undefined
    }
    const recordApiDuration = (options: {
      durationApiMs?: number
      durationApiWithoutRetriesMs?: number
    }) => {
      if (
        options.durationApiMs === undefined &&
        options.durationApiWithoutRetriesMs === undefined
      ) {
        return
      }
      const total = options.durationApiMs ?? 0
      const withoutRetries = options.durationApiWithoutRetriesMs ?? total
      if (
        !Number.isFinite(total) ||
        total < 0 ||
        !Number.isFinite(withoutRetries) ||
        withoutRetries < 0
      ) {
        throw new Error('Subagent API duration must be finite and nonnegative')
      }
      recordedDurationApiMs += total
      recordedDurationApiWithoutRetriesMs += withoutRetries
      recordedApiDurationSeen = true
    }
    const nestedTools = this.registry(
      options.sessionId,
      options.spawnDepth,
      () => options.promptId,
      options.agentId,
    )
    const agentMcp = customAgent?.mcpServers?.length
      ? await this.options.mcp?.connectAgent?.({
          specs: customAgent.mcpServers,
          base: nestedTools,
          cwd,
          ...(options.signal ? { signal: options.signal } : {}),
        })
      : null
    const agentToolBase = agentMcp?.tools ?? nestedTools
    const inheritedToolNames = new Set(
      nestedTools.definitions().map(({ name }) => name),
    )
    const additiveAgentToolNames = new Set(
      agentToolBase
        .definitions()
        .map(({ name }) => name)
        .filter((name) => !inheritedToolNames.has(name)),
    )
    const agentScopedTools = new RestrictedToolRegistry(
      agentToolBase,
      enabledAgentToolNames(
        agentToolBase,
        customAgent,
        options.input.runInBackground,
        options.input.permissionMode,
        additiveAgentToolNames,
      ),
    )
    const builtInStatusLineAgent =
      customAgent?.path === BUILTIN_STATUSLINE_AGENT_PATH
    const scopedTools = builtInStatusLineAgent
      ? new RestrictedToolRegistry(agentScopedTools, ['Read', 'Edit'])
      : agentScopedTools
    const agentTools = options.outputSchema
      ? new StructuredOutputRegistry(
          builtInStatusLineAgent
            ? new RestrictedToolRegistry(structuredOnlyTools, ['Read', 'Edit'])
            : structuredOnlyTools,
          options.outputSchema,
          options.structuredOutput,
        )
      : scopedTools
    const runtimeTools = scopedHooks
      ? new ClaudeHookToolCoordinator({
          tools: agentTools,
          permissions,
          hooks: scopedHooks,
          session: hookSession,
          recordOutcome: recordHookOutcome,
          ...(this.options.eventSink
            ? {
                warn: (message: string) =>
                  this.options.eventSink?.({ type: 'warning', message }),
              }
            : {}),
        })
      : agentTools
    const runtimePermissions = scopedHooks
      ? (runtimeTools as ClaudeHookToolCoordinator)
      : permissions
    const emit = (event: RuntimeEvent) => {
      if (event.type === 'usage') {
        pendingProviderUsage = event.usage
        taskTokenTotal += event.usage.inputTokens + event.usage.outputTokens
        this.options.eventSink?.({
          type: 'task-progress',
          taskId: options.agentId,
          ...(options.toolUseId ? { toolUseId: options.toolUseId } : {}),
          description: options.input.description,
          usage: {
            totalTokens: taskTokenTotal,
            toolUses: toolUseCount,
            durationMs: Date.now() - taskStartedAt,
          },
          ...(lastToolName ? { lastToolName } : {}),
        })
      }
      if (event.type === 'tool-call') {
        toolUseCount += 1
        lastToolName = event.call.name
        this.options.eventSink?.({
          type: 'task-progress',
          taskId: options.agentId,
          ...(options.toolUseId ? { toolUseId: options.toolUseId } : {}),
          description: options.input.description,
          usage: {
            totalTokens: taskTokenTotal,
            toolUses: toolUseCount,
            durationMs: Date.now() - taskStartedAt,
          },
          lastToolName,
        })
      }
      if (event.type === 'warning') this.options.eventSink?.(event)
      if (event.type === 'failed') {
        this.options.eventSink?.({
          type: 'warning',
          message: `Subagent failed: ${event.message}`,
        })
      }
    }
    const runtime = new AgentRuntime(options.provider, emit, {
      tools: runtimeTools,
      permissions: runtimePermissions,
      ...(customAgent?.maxTurns === undefined
        ? {}
        : { maxModelTurns: customAgent.maxTurns }),
      maxModelOutputBytes:
        this.options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      maxToolCallsPerTurn: 32,
      maxToolInputBytes: 1024 * 1024,
    })
    const observer = {
      toolExecutionStarted: async (call: ModelToolCall) => {
        await nativeLease?.beginToolExecution(call.id)
      },
      assistantCompleted: async (message: {
        content: string
        thinkingBlocks?: readonly ModelThinkingBlock[]
        toolCalls?: readonly ModelToolCall[]
      }) => {
        commitProviderUsage()
        if (nativeLease) {
          await nativeLease.appendMessages({
            messages: [
              {
                role: 'assistant',
                content: message.content,
                ...(message.thinkingBlocks
                  ? { thinkingBlocks: message.thinkingBlocks }
                  : {}),
                ...(message.toolCalls?.length
                  ? { toolCalls: message.toolCalls }
                  : {}),
              },
            ],
            model: options.provider.model ?? 'praxis/provider',
          })
          return
        }
        const [entry] = translateProviderEvents(
          [
            {
              type: 'assistant-message' as const,
              text: message.content,
              ...(message.thinkingBlocks
                ? { thinkingBlocks: message.thinkingBlocks }
                : {}),
              toolCalls: message.toolCalls ?? [],
              providerMessageId: `msg_${randomUUID().replaceAll('-', '')}`,
              model: options.provider.model ?? 'praxis/provider',
            },
          ],
          translationContext(),
        )
        if (!entry) throw new Error('Could not translate subagent response')
        await appendClaude(
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
        if (result.usage) {
          recordedUsage = mergeSubagentUsage(recordedUsage, result.usage)
        }
        if (result.isError === false && result.modelUsage) {
          mergeSubagentModelUsage(recordedModelUsage, result.modelUsage)
        }
        recordApiDuration(result)
        if (result.isError === false) {
          const linesAdded = result.linesAdded ?? 0
          const linesRemoved = result.linesRemoved ?? 0
          if (linesAdded !== 0 || linesRemoved !== 0) {
            await this.options.onLineChanges?.({ linesAdded, linesRemoved })
          }
        }
        const nestedToolUseCount = result.nativeToolUseResult?.totalToolUseCount
        if (
          call.name === 'Agent' &&
          typeof nestedToolUseCount === 'number' &&
          Number.isSafeInteger(nestedToolUseCount) &&
          nestedToolUseCount > 0
        ) {
          toolUseCount += nestedToolUseCount
        }
        if (nativeLease) {
          await nativeLease.appendToolCompletion({
            callId: call.id,
            result,
            ...(result.followUpUserMessages?.length
              ? { followUpUserMessages: result.followUpUserMessages }
              : {}),
          })
          return
        }
        const [entry] = translateProviderEvents(
          [
            {
              type: 'tool-result' as const,
              toolCallId: call.id,
              content: result.content,
              ...(result.contentBlocks
                ? { contentBlocks: result.contentBlocks }
                : {}),
              ...(result.images ? { images: result.images } : {}),
              ...(result.documents ? { documents: result.documents } : {}),
              isError: result.isError,
              ...(result.nativeToolUseResult
                ? { nativeToolUseResult: result.nativeToolUseResult }
                : {}),
              ...(result.nativeMcpMeta
                ? { nativeMcpMeta: result.nativeMcpMeta }
                : {}),
            },
          ],
          translationContext(),
        )
        if (!entry) throw new Error('Could not translate subagent tool result')
        await appendClaude(
          toClaudeSidechainEntry(
            entry,
            options.agentId,
            options.input.subagentType,
          ),
        )
      },
      followUpUserMessagesCompleted: async (messages: readonly string[]) => {
        for (const text of messages) {
          if (!nativeLease) {
            const [entry] = translateProviderEvents(
              [{ type: 'user-text-block' as const, text }],
              translationContext(),
            )
            if (!entry)
              throw new Error('Could not translate subagent follow-up')
            await appendClaude(
              toClaudeSidechainEntry(
                entry,
                options.agentId,
                options.input.subagentType,
              ),
            )
          }
          await this.background.acknowledge([text])
        }
        await durableFollowUps.followUpUserMessagesCompleted(messages)
      },
    }

    this.options.eventSink?.({
      type: 'task-started',
      taskId: options.agentId,
      ...(options.toolUseId ? { toolUseId: options.toolUseId } : {}),
      description: options.input.description,
      taskType: options.input.subagentType,
      prompt: options.input.prompt,
    })

    try {
      if (scopedHooks) {
        const start = await scopedHooks.run(
          {
            ...hookSession,
            hook_event_name: 'SubagentStart',
            agent_id: options.agentId,
            agent_type: options.input.subagentType,
          },
          options.input.subagentType,
          options.signal,
        )
        await recordHookOutcome(start)
        if (start.blockedReason) {
          throw new Error(`SubagentStart hook error: ${start.blockedReason}`)
        }
      }
      const baseSystem =
        options.input.subagentType === 'general-purpose'
          ? 'You are a general-purpose subagent. Complete the isolated task and return a concise result.'
          : options.input.subagentType === 'workflow-subagent'
            ? 'You are a workflow subagent. Complete the isolated task. Your final text is the raw return value consumed by the workflow, not a user-facing message.'
            : `# Agent definition: ${options.input.subagentType}\n\n${customAgent?.body ?? ''}`
      const memoryPrompt = await agentMemoryPrompt(
        this.options.configRoot,
        cwd,
        customAgent,
        this.options.dataPlane,
      )
      const agentSystem = memoryPrompt
        ? `${baseSystem}\n\n${memoryPrompt}`
        : baseSystem
      const preloadedSkills = agentSkillMessages(
        this.options.extensions,
        customAgent,
      )
      let stopHookActive = false
      const contextBudget = options.provider.capabilities.contextWindowTokens
        ? new ContextBudget({
            contextWindowTokens:
              options.provider.capabilities.contextWindowTokens,
            onAccountingDiagnostic: (message) =>
              this.options.eventSink?.({
                type: 'warning',
                message: `Context usage accounting: ${message}`,
              }),
            ...(this.options.contextReserveTokens === undefined
              ? {}
              : { reserveTokens: this.options.contextReserveTokens }),
          })
        : null
      const definitions = options.provider.capabilities.tools
        ? runtimeTools.definitions()
        : []
      let observedMessages: readonly ModelMessage[] | undefined
      let stableSystemMessageCount = 0
      const assembleMessages = async () => {
        const assembledContext = await assembleContextSnapshot(
          this.options.contextAssembler,
          {
            cwd,
            lifecycleId: options.agentId,
            mode: 'subagent',
            baseSystemPrompt: agentSystem,
            ...(options.outputSchema
              ? {
                  turn: {
                    structuredOutput: true,
                  },
                }
              : {}),
          },
        )
        const contextProjection = projectContextSnapshot(assembledContext)
        stableSystemMessageCount = contextProjection.stableSystemSectionCount
        const transcriptMessages = nativeLease
          ? options.continuationMessage === undefined
            ? nativeLease.activeMessages()
            : projectNativeSidechainContinuationMessages(
                nativeLease.activeMessages(),
              )
          : options.continuationMessage === undefined
            ? projectClaudeModelMessages(requireClaudeSnapshot().entries)
            : projectClaudeSidechainContinuationMessages(
                requireClaudeSnapshot().entries,
              )
        const messages = [
          ...contextProjection.systemMessages,
          ...injectFirstUserMessageContext(
            transcriptMessages,
            contextProjection.firstUserMessageContext,
          ),
          ...preloadedSkills,
        ]
        observedMessages = messages
        if (contextBudget) {
          contextBudget.assertFits(
            contextBudget.evaluate(messages, definitions),
          )
        }
        return messages
      }
      const configuredEffort =
        typeof customAgent?.effort === 'string' ? customAgent.effort : undefined
      const effectiveEffort = options.effort ?? configuredEffort
      if (nativeRecoveryCalls.length > 0) {
        if (!nativeLease)
          throw new Error('Native sidechain recovery lease is unavailable')
        await runtime.recoverToolCalls(nativeRecoveryCalls, {
          cwd,
          toolResultDirectory: options.toolResultDirectory,
          messages: nativeLease.activeMessages(),
          observer,
          ...(this.options.approveTool
            ? { approveTool: this.options.approveTool }
            : {}),
          permissionUpdates: this.options.permissionUpdates?.() ?? [],
          ...(this.options.onPermissionUpdates
            ? { onPermissionUpdates: this.options.onPermissionUpdates }
            : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        })
      }
      const initialMessages = await assembleMessages()
      const runtimeRequest: Parameters<typeof runtime.run>[0] = {
        sessionId: options.sessionId,
        messages: initialMessages,
        collectMetrics: true,
        stableSystemMessageCount,
        reloadMessages: async () => {
          const messages = await assembleMessages()
          runtimeRequest.stableSystemMessageCount = stableSystemMessageCount
          return messages
        },
        cwd,
        ...(effectiveEffort ? { effort: effectiveEffort } : {}),
        toolResultDirectory: options.toolResultDirectory,
        observer,
        ...(this.options.approveTool
          ? { approveTool: this.options.approveTool }
          : {}),
        permissionUpdates: this.options.permissionUpdates?.() ?? [],
        ...(this.options.onPermissionUpdates
          ? { onPermissionUpdates: this.options.onPermissionUpdates }
          : {}),
        ...(scopedHooks ||
        this.options.backgroundTaskNotifications ||
        this.options.durableFollowUpSource
          ? {
              onStop: async (text: string) => {
                const messages: string[] = []
                const durableBatch =
                  await this.options.durableFollowUpSource?.()
                if (durableBatch) {
                  durableFollowUps.register(durableBatch)
                  messages.push(...durableBatch.messages)
                }
                const outcome = await scopedHooks?.run(
                  {
                    ...hookSession,
                    hook_event_name: 'SubagentStop',
                    stop_hook_active: stopHookActive,
                    agent_id: options.agentId,
                    agent_transcript_path: options.transcriptPath,
                    agent_type: options.input.subagentType,
                    last_assistant_message: text,
                  },
                  options.input.subagentType,
                  options.signal,
                )
                if (outcome) {
                  await recordHookOutcome(outcome)
                  if (outcome.blockedReason) {
                    stopHookActive = true
                    messages.push(
                      `SubagentStop hook error: ${outcome.blockedReason}`,
                    )
                  }
                }
                await this.hydratePersistedTasks(
                  options.sessionId,
                  options.cwd ?? this.cwd(),
                )
                await this.reconcileDeliveredNotifications((notification) => {
                  const markers =
                    backgroundAgentNotificationMarkers(notification)
                  const source = JSON.stringify(
                    nativeLease
                      ? nativeLease.activeMessages()
                      : requireClaudeSnapshot().entries,
                  )
                  return markers.every((marker) => source.includes(marker))
                })
                const background = await this.background.notifications({
                  waitForRunning: false,
                  excludeAgentId: options.agentId,
                  consume: false,
                })
                recordedUsage = mergeSubagentUsage(
                  recordedUsage,
                  background.usage,
                )
                if (background.modelUsage) {
                  mergeSubagentModelUsage(
                    recordedModelUsage,
                    background.modelUsage,
                  )
                }
                recordApiDuration(background)
                messages.push(...background.messages)
                messages.push(
                  ...((await this.options.backgroundTaskNotifications?.(
                    true,
                  )) ?? []),
                )
                return {
                  messages,
                  usage: background.usage,
                  ...(background.modelUsage
                    ? { modelUsage: background.modelUsage }
                    : {}),
                  ...(background.durationApiMs === undefined
                    ? {}
                    : { durationApiMs: background.durationApiMs }),
                  ...(background.durationApiWithoutRetriesMs === undefined
                    ? {}
                    : {
                        durationApiWithoutRetriesMs:
                          background.durationApiWithoutRetriesMs,
                      }),
                }
              },
            }
          : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      }
      const result = await runtime.run(runtimeRequest)
      contextBudget?.observeUsage(
        result.usage,
        observedMessages ?? [],
        definitions,
      )
      this.options.eventSink?.({
        type: 'task-progress',
        taskId: options.agentId,
        ...(options.toolUseId ? { toolUseId: options.toolUseId } : {}),
        description: options.input.description,
        usage: {
          totalTokens: result.usage.inputTokens + result.usage.outputTokens,
          toolUses: toolUseCount,
          durationMs: Date.now() - taskStartedAt,
        },
        ...(lastToolName ? { lastToolName } : {}),
        summary: result.text,
      })
      this.options.eventSink?.({
        type: 'task-notification',
        taskId: options.agentId,
        ...(options.toolUseId ? { toolUseId: options.toolUseId } : {}),
        status: 'completed',
        outputFile: options.transcriptPath,
        summary: result.text,
        usage: {
          totalTokens: result.usage.inputTokens + result.usage.outputTokens,
          toolUses: toolUseCount,
          durationMs: Date.now() - taskStartedAt,
        },
      })
      return {
        ...result,
        toolUseCount,
      }
    } catch (error) {
      commitProviderUsage()
      const partialModelUsage =
        recordedModelUsage.size === 0
          ? undefined
          : Object.fromEntries(recordedModelUsage)
      if (!(options.signal?.reason instanceof BackgroundAgentShutdownError)) {
        this.options.eventSink?.({
          type: 'task-notification',
          taskId: options.agentId,
          ...(options.toolUseId ? { toolUseId: options.toolUseId } : {}),
          status: options.signal?.aborted ? 'stopped' : 'failed',
          outputFile: options.transcriptPath,
          summary: error instanceof Error ? error.message : String(error),
          usage: {
            totalTokens: recordedUsage.inputTokens + recordedUsage.outputTokens,
            toolUses: toolUseCount,
            durationMs: Date.now() - taskStartedAt,
          },
        })
      }
      throw new SubagentExecutionFailure(error, {
        text: error instanceof Error ? error.message : String(error),
        usage: recordedUsage,
        ...(partialModelUsage ? { modelUsage: partialModelUsage } : {}),
        ...(recordedApiDurationSeen
          ? {
              durationApiMs: recordedDurationApiMs,
              durationApiWithoutRetriesMs: recordedDurationApiWithoutRetriesMs,
            }
          : {}),
        toolUseCount,
        durationMs: Date.now() - taskStartedAt,
      })
    } finally {
      await agentMcp?.close().catch((error: unknown) => {
        this.options.eventSink?.({
          type: 'warning',
          message: `Agent MCP cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
        })
      })
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
    private readonly parentAgentId?: string,
  ) {}

  definitions(): readonly ModelToolDefinition[] {
    const base = this.base.definitions()
    const management = this.executor
      .managementDefinitions()
      .filter(({ name }) => this.executor.isEnabled(name))
    const managementNames = new Set(management.map(({ name }) => name))
    const firstManagement = base.findIndex(({ name }) =>
      managementNames.has(name),
    )
    const insertionIndex =
      firstManagement < 0
        ? base.length
        : base
            .slice(0, firstManagement)
            .filter(({ name }) => !managementNames.has(name)).length
    const ordinary = base.filter(({ name }) => !managementNames.has(name))
    const baseByName = new Map(
      base.map((definition) => [definition.name, definition]),
    )
    return [
      ...ordinary.slice(0, insertionIndex),
      ...(this.executor.isEnabled('Agent')
        ? [this.executor.definitions()]
        : []),
      ...management.map(
        (definition) => baseByName.get(definition.name) ?? definition,
      ),
      ...ordinary.slice(insertionIndex),
    ]
  }

  schedulingPolicy(call: ModelToolCall) {
    if (
      ['Agent', 'SendMessage', 'TaskOutput', 'TaskStop'].includes(call.name)
    ) {
      return { concurrency: 'exclusive' as const, cancelOnInterrupt: true }
    }
    return resolveToolSchedulingPolicy(this.base, call)
  }

  async prepare(
    call: ModelToolCall,
    context: ToolExecutionContext,
  ): Promise<ModelToolCall> {
    if (call.name === 'Agent') return this.executor.prepare(call, this.depth)
    if (call.name === 'SendMessage') {
      return this.executor.prepareManagement(call)
    }
    if (call.name === 'TaskOutput' || call.name === 'TaskStop') {
      const taskId = call.input.task_id ?? call.input.shell_id
      if (typeof taskId === 'string' && isBackgroundBashTaskId(taskId)) {
        return this.base.prepare(call, context)
      }
      return this.executor.prepareManagement(call)
    }
    return this.base.prepare(call, context)
  }

  async execute(
    call: ModelToolCall,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    if (call.name === 'SendMessage') {
      return this.executor.executeManagement(call, this.sessionId, context)
    }
    if (call.name === 'TaskOutput' || call.name === 'TaskStop') {
      const taskId = call.input.task_id ?? call.input.shell_id
      if (typeof taskId === 'string' && isBackgroundBashTaskId(taskId)) {
        return this.base.execute(call, context)
      }
      return this.executor.executeManagement(call, this.sessionId, context)
    }
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
      this.parentAgentId,
    )
  }
}
