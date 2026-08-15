import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { Ajv2020 } from 'ajv/dist/2020.js'

import { resolveClaudePaths } from '../compatibility/claude/paths.js'
import { workflowAgentFiles } from '../compatibility/claude/workflow.js'
import {
  createClaudeAsyncAgentToolUseResult,
  createClaudeAgentToolUseResult,
  createClaudeSidechainRoot,
  resolveClaudeSidechainPaths,
  toClaudeSidechainEntry,
  type ClaudeSidechainPermissionMode,
  type ClaudeSidechainPaths,
} from '../compatibility/claude/sidechain.js'
import { projectClaudeModelMessages } from '../compatibility/claude/projection.js'
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
  type ContextAssembler,
} from '../core/context.js'
import { ContextBudget } from '../core/context-budget.js'
import {
  AgentRuntime,
  type ModelProvider,
  type ModelThinkingBlock,
  type ModelToolCall,
  type ModelToolDefinition,
  type ModelUsage,
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
import { ClaudeSidechainStore } from '../persistence/claude-sidechain-store.js'
import { InMemorySidechainStore } from '../persistence/in-memory-sidechain-store.js'
import type {
  ClaudeTranscriptLease,
  TranscriptSnapshot,
} from '../persistence/claude-transcript-store.js'
import {
  BackgroundAgentManager,
  BackgroundAgentRunError,
  type BackgroundAgentSnapshot,
  type BackgroundAgentRunResult,
  type BackgroundAgentTaskSpec,
} from './background-agent-manager.js'
import { isBackgroundBashTaskId } from './background-task-id.js'
import {
  createManagedWorktree,
  type ManagedWorktree,
} from './managed-worktree.js'
import { createWorkflowWorktree } from './workflow-worktree.js'

const DEFAULT_MAX_DEPTH = 4
const DEFAULT_MAX_CALLS = 16
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024

const structuredOnlyTools: ToolRegistry = {
  definitions: () => [],
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
      if (AGENT_UNAVAILABLE_TOOLS.has(name)) return false
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
): string {
  const directoryName = agentType.replaceAll(':', '-')
  if (scope === 'user') {
    return join(configRoot, 'agent-memory', directoryName)
  }
  return join(
    cwd,
    '.claude',
    scope === 'project' ? 'agent-memory' : 'agent-memory-local',
    directoryName,
  )
}

async function agentMemoryPrompt(
  configRoot: string,
  cwd: string,
  definition: ClaudeAgentRuntimeDefinition | null,
): Promise<string | null> {
  if (!definition?.memory) return null
  const directory = agentMemoryDirectory(
    configRoot,
    cwd,
    definition.name,
    definition.memory,
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

export interface ClaudeSubagentExecutorOptions {
  configRoot: string
  cwd: string
  cwdProvider?: () => string
  claudeVersion: string
  provider: ModelProvider
  baseTools: ToolRegistry
  permissions: PermissionResolver
  permissionResolverForMode?: (mode: AgentPermissionMode) => PermissionResolver
  parentPermissionMode?: () => AgentPermissionMode
  extensions?: ClaudeExtensionCatalog
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
  persistence?: 'disk' | 'memory'
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

  isEnabled(name: string): boolean {
    return this.options.toolNames?.includes(name) ?? true
  }

  constructor(private readonly options: ClaudeSubagentExecutorOptions) {
    this.schema = selectClaudeSchemaAdapter(options.claudeVersion)
  }

  async close(): Promise<void> {
    await this.background.close()
    this.ephemeralSidechains.clear()
  }

  backgroundSnapshots(): readonly BackgroundAgentSnapshot[] {
    return this.background.snapshots()
  }

  stopBackgroundTask(taskId: string): string {
    return this.background.stop(taskId)
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
    const parentPermissionMode = this.options.parentPermissionMode?.()
    const definitionCanOverridePermissionMode = ![
      'acceptEdits',
      'auto',
      'bypassPermissions',
    ].includes(parentPermissionMode ?? 'default')
    const permissionMode =
      input.permissionMode ??
      (definitionCanOverridePermissionMode
        ? definition?.permissionMode
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
              'Agents run in the background by default; you will be notified when one completes. Set to false to run this agent synchronously when you need its result before continuing.',
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
            to: { description: 'Recipient: teammate name', type: 'string' },
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
    if (input.permissionMode && !this.options.permissionResolverForMode) {
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
  ): Promise<ToolExecutionResult> {
    this.calls += 1
    const maxCalls = this.options.maxCalls ?? DEFAULT_MAX_CALLS
    if (this.calls > maxCalls) {
      throw new Error(`Agent call count exceeded ${maxCalls}`)
    }
    const input = this.resolveAgentInput(parseAgentInput(call))
    const spawnDepth = depth + 1
    const agentId = `a${randomBytes(8).toString('hex')}`
    const paths = resolveClaudePaths({
      configDir: this.options.configRoot,
      cwd: this.cwd(),
      sessionId,
    })
    const initialIsolation = input.isolation
      ? await this.createAgentWorktree(paths.praxisRoot, sessionId, agentId)
      : undefined
    const agentCwd = initialIsolation?.cwd ?? this.cwd()
    const sidechainPaths = resolveClaudeSidechainPaths(
      paths.projectRoot,
      sessionId,
      agentId,
    )
    const sidechain = this.sidechainStore(sessionId, agentId, sidechainPaths)
    const root = createClaudeSidechainRoot({
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
      await sidechain.create(root, {
        agentType: input.subagentType,
        description: input.description,
        toolUseId: call.id,
        spawnDepth,
        ...(input.name ? { name: input.name } : {}),
        ...(input.permissionMode
          ? { permissionMode: input.permissionMode }
          : {}),
        ...(input.isolation ? { isolation: input.isolation } : {}),
      })
    } catch (error) {
      await initialIsolation?.cleanup()
      throw error
    }
    const provider = input.model
      ? (this.options.providerForModel?.(input.model) ?? this.options.provider)
      : this.options.provider
    const run = this.createBackgroundAgentRun({
      input,
      ...(initialIsolation ? { initialIsolation } : {}),
      createIsolation: () =>
        this.createAgentWorktree(paths.praxisRoot, sessionId, agentId),
      execute: (cwd, message, signal, continuation) =>
        sidechain.withLease(async (lease) =>
          this.runSidechain({
            lease,
            root,
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
          }),
        ),
    })
    if (input.runInBackground) {
      const resolvedModel = provider.model ?? 'praxis/provider'
      this.background.launch({
        agentId,
        ...(input.name ? { name: input.name } : {}),
        agentType: input.subagentType,
        description: input.description,
        prompt: input.prompt,
        toolUseId: call.id,
        outputFile: sidechainPaths.transcriptFile,
        resolvedModel,
        run,
      })
      return {
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
      }
    }

    const controller = new AbortController()
    const abort = () => controller.abort()
    context.signal?.addEventListener('abort', abort, { once: true })
    let result: BackgroundAgentRunResult
    try {
      result = await run(input.prompt, controller.signal, false)
    } finally {
      context.signal?.removeEventListener('abort', abort)
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
      nativeToolUseResult: {
        ...createClaudeAgentToolUseResult({
          prompt: input.prompt,
          agentId,
          agentType: input.subagentType,
          text: result.text,
          resolvedModel: provider.model ?? 'praxis/provider',
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
  ): ClaudeSidechainStore | InMemorySidechainStore {
    if (this.options.persistence !== 'memory') {
      return new ClaudeSidechainStore(
        paths,
        join(
          this.options.configRoot,
          'praxis',
          'locks',
          `${sessionId}-${agentId}.lock`,
        ),
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

  private createAgentWorktree(
    praxisRoot: string,
    sessionId: string,
    agentId: string,
  ): Promise<ManagedWorktree> {
    return createManagedWorktree({
      cwd: this.cwd(),
      parentDirectory: join(praxisRoot, 'agent-worktrees'),
      directoryName: `${sessionId}-${agentId}`,
      label: 'Agent',
    })
  }

  private createBackgroundAgentRun(options: {
    input: AgentInput
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
      toolUseCount: number
    }>
  }): BackgroundAgentTaskSpec['run'] {
    let availableIsolation = options.initialIsolation
    let retainedIsolation: ManagedWorktree | undefined
    return async (message, signal, continuation) => {
      const isolation = options.input.isolation
        ? (retainedIsolation ??
          availableIsolation ??
          (await options.createIsolation()))
        : undefined
      availableIsolation = undefined
      const startedAt = Date.now()
      let result:
        { text: string; usage: ModelUsage; toolUseCount: number } | undefined
      let failure: unknown
      let cleanup: { retained: boolean; reason?: string } | undefined
      try {
        result = await options.execute(
          isolation?.cwd ?? this.cwd(),
          message,
          signal,
          continuation,
        )
      } catch (error) {
        failure = error
      } finally {
        cleanup = await isolation?.cleanup()
        retainedIsolation = cleanup?.retained ? isolation : undefined
      }
      if (failure !== undefined) {
        if (isolation && cleanup) {
          const message =
            failure instanceof Error ? failure.message : String(failure)
          const result: BackgroundAgentRunResult = {
            text: message,
            usage: { inputTokens: 0, outputTokens: 0 },
            toolUseCount: 0,
            durationMs: Date.now() - startedAt,
            isolationPath: isolation.cwd,
            isolationRetained: cleanup.retained,
            ...(cleanup.reason ? { isolationWarning: cleanup.reason } : {}),
          }
          throw new BackgroundAgentRunError(
            cleanup.reason ? `${message}\n${cleanup.reason}` : message,
            result,
            failure,
          )
        }
        if (cleanup?.reason) {
          throw new Error(
            `${failure instanceof Error ? failure.message : String(failure)}\n${cleanup.reason}`,
            { cause: failure },
          )
        }
        throw failure
      }
      if (!result) throw new Error('Agent completed without a result')
      return {
        ...result,
        durationMs: Date.now() - startedAt,
        ...(isolation ? { isolationPath: isolation.cwd } : {}),
        ...(cleanup ? { isolationRetained: cleanup.retained } : {}),
        ...(cleanup?.reason ? { isolationWarning: cleanup.reason } : {}),
      }
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
    const sidechain = new ClaudeSidechainStore(
      paths,
      join(
        this.options.configRoot,
        'praxis',
        'locks',
        `${options.sessionId}-${options.runId}-${options.agentId}.lock`,
      ),
      this.schema,
    )
    const claudePaths = resolveClaudePaths({
      configDir: this.options.configRoot,
      cwd: this.cwd(),
      sessionId: options.sessionId,
    })
    const isolation = options.isolation
      ? await createWorkflowWorktree({
          cwd: this.cwd(),
          praxisRoot: claudePaths.praxisRoot,
          runId: options.runId,
          agentId: options.agentId,
        })
      : null
    const agentCwd = isolation?.cwd ?? this.cwd()
    const root = createClaudeSidechainRoot({
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
      await sidechain.createWorkflow(root, {
        agentType: options.agentType ?? 'workflow-subagent',
        spawnDepth: 1,
      })
      run = await sidechain.withLease((lease) =>
        this.runSidechain({
          lease,
          root,
          input,
          provider,
          agentId: options.agentId,
          spawnDepth: 1,
          promptId: options.promptId,
          transcriptPath: paths.transcriptFile,
          toolResultDirectory: join(
            claudePaths.projectRoot,
            options.sessionId,
            'tool-results',
          ),
          ...(options.schema
            ? { outputSchema: options.schema, structuredOutput: structured }
            : {}),
          ...(options.effort ? { effort: options.effort } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
          cwd: agentCwd,
        }),
      )
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
  ): Promise<ToolExecutionResult> {
    if (call.name === 'TaskOutput') {
      const taskId = String(call.input.task_id)
      await this.hydrateCompletedTask(sessionId, taskId)
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
      await this.hydrateCompletedTask(sessionId, taskId)
      return { content: this.background.stop(taskId), isError: false }
    }
    const agentId = String(call.input.to)
    await this.hydrateCompletedTask(sessionId, agentId)
    return {
      content: this.background.send(
        agentId,
        String(call.input.message),
        typeof call.input.summary === 'string' ? call.input.summary : undefined,
        call.id,
      ),
      isError: false,
    }
  }

  notifications(
    waitForRunning: boolean,
  ): Promise<{ messages: string[]; usage: ModelUsage }> {
    return this.background.notifications({ waitForRunning })
  }

  private async hydrateCompletedTask(
    sessionId: string,
    identifier: string,
  ): Promise<void> {
    if (this.background.has(identifier)) return
    const paths = resolveClaudePaths({
      configDir: this.options.configRoot,
      cwd: this.cwd(),
      sessionId,
    })
    const agentId = await this.resolvePersistedAgentId(
      paths.projectRoot,
      sessionId,
      identifier,
    )
    if (!agentId) return
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
    let metadata
    let snapshot
    try {
      ;[metadata, snapshot] = await Promise.all([
        sidechain.metadata(),
        sidechain.loadReadOnly(),
      ])
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    const root = snapshot.entries[0]
    if (!root || root.type !== 'user') {
      throw new Error(`Background agent ${agentId} has no sidechain root`)
    }
    const prompt =
      typeof root.message === 'object' &&
      root.message !== null &&
      typeof (root.message as Record<string, unknown>).content === 'string'
        ? String((root.message as Record<string, unknown>).content)
        : ''
    const projected = projectClaudeModelMessages(snapshot.entries)
    const lastAssistant = projected.at(-1)
    if (
      !lastAssistant ||
      lastAssistant.role !== 'assistant' ||
      (lastAssistant.toolCalls?.length ?? 0) > 0
    ) {
      throw new Error(`Background agent ${agentId} is not completed`)
    }
    const input: AgentInput = {
      description: metadata.description,
      prompt,
      subagentType: metadata.agentType,
      ...(metadata.name ? { name: metadata.name } : {}),
      ...(metadata.permissionMode
        ? { permissionMode: metadata.permissionMode }
        : {}),
      ...(metadata.isolation ? { isolation: metadata.isolation } : {}),
      runInBackground: true,
    }
    const provider = this.options.provider
    const run = this.createBackgroundAgentRun({
      input,
      createIsolation: () =>
        this.createAgentWorktree(paths.praxisRoot, sessionId, agentId),
      execute: (cwd, message, signal, continuation) =>
        sidechain.withLease(async (lease) =>
          this.runSidechain({
            lease,
            root,
            input,
            provider,
            agentId,
            spawnDepth: metadata.spawnDepth,
            promptId: String(root.promptId ?? randomUUID()),
            toolUseId: metadata.toolUseId,
            transcriptPath: sidechainPaths.transcriptFile,
            toolResultDirectory: join(
              paths.projectRoot,
              sessionId,
              'tool-results',
            ),
            ...(continuation ? { continuationMessage: message } : {}),
            signal,
            cwd,
          }),
        ),
    })
    this.background.registerCompleted(
      {
        agentId,
        ...(metadata.name ? { name: metadata.name } : {}),
        agentType: metadata.agentType,
        description: metadata.description,
        prompt,
        toolUseId: metadata.toolUseId,
        outputFile: sidechainPaths.transcriptFile,
        resolvedModel: provider.model ?? 'praxis/provider',
        run,
      },
      {
        text: lastAssistant.content,
        usage: { inputTokens: 0, outputTokens: 0 },
        toolUseCount: 0,
        durationMs: 0,
      },
    )
  }

  private async resolvePersistedAgentId(
    projectRoot: string,
    sessionId: string,
    identifier: string,
  ): Promise<string | null> {
    if (/^a[0-9a-f]{16}$/u.test(identifier)) return identifier
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(identifier)) return null
    const directory = join(projectRoot, sessionId, 'subagents')
    let names: string[]
    try {
      names = await readdir(directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    const matches = await Promise.all(
      names
        .map((name) => /^agent-(a[0-9a-f]{16})\.meta\.json$/u.exec(name)?.[1])
        .filter((agentId): agentId is string => agentId !== undefined)
        .map(async (agentId) => {
          const sidechainPaths = resolveClaudeSidechainPaths(
            projectRoot,
            sessionId,
            agentId,
          )
          const sidechain = new ClaudeSidechainStore(
            sidechainPaths,
            join(
              this.options.configRoot,
              'praxis',
              'locks',
              `${sessionId}-${agentId}.lock`,
            ),
            this.schema,
          )
          const metadata = await sidechain.metadata()
          if (metadata.name !== identifier) return null
          const file = await stat(sidechainPaths.metadataFile)
          return { agentId, modifiedAt: file.mtimeMs }
        }),
    )
    return (
      matches
        .filter(
          (match): match is { agentId: string; modifiedAt: number } =>
            match !== null,
        )
        .sort(
          (left, right) =>
            right.modifiedAt - left.modifiedAt ||
            right.agentId.localeCompare(left.agentId),
        )[0]?.agentId ?? null
    )
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
    lease: ClaudeTranscriptLease
    root: ClaudeTranscriptEntry
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
    toolUseCount: number
  }> {
    const cwd = options.cwd ?? this.cwd()
    const permissions = options.input.permissionMode
      ? this.options.permissionResolverForMode?.(options.input.permissionMode)
      : this.options.permissions
    if (!permissions) {
      throw new Error('Agent permission mode overrides are unavailable')
    }
    let snapshot: TranscriptSnapshot = await options.lease.load()
    if (options.continuationMessage !== undefined) {
      const [entry] = translateProviderEvents(
        [
          {
            type: 'user-text-block',
            text: `The coordinator sent a message while you were working:\n${options.continuationMessage}\n\nAddress this before completing your current task.`,
          },
        ],
        {
          sessionId: String(options.root.sessionId),
          parentUuid: snapshot.tail.lastUuid,
          cwd,
          claudeVersion: this.options.claudeVersion,
          gitBranch: null,
          history: snapshot.entries,
        },
      )
      if (!entry) throw new Error('Could not translate subagent message')
      const sidechainEntry = toClaudeSidechainEntry(
        entry,
        options.agentId,
        options.input.subagentType,
      )
      const appendResult = await options.lease.append(
        snapshot.tail,
        sidechainEntry,
      )
      if (appendResult.status === 'conflict') {
        throw new Error(
          `Claude sidechain append conflict: ${appendResult.reason}`,
        )
      }
      snapshot = {
        entries: [...snapshot.entries, sidechainEntry],
        tail: appendResult.tail,
      }
    }
    let toolUseCount = 0
    let taskTokenTotal = 0
    let lastToolName: string | undefined
    const taskStartedAt = Date.now()
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
      cwd,
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
      cwd,
      permission_mode: options.input.permissionMode ?? 'default',
    }
    const nestedTools = this.registry(
      String(options.root.sessionId),
      options.spawnDepth,
      () => options.promptId,
    )
    const customAgent = this.agentDefinition(options.input)
    const agentScopedTools = new RestrictedToolRegistry(
      nestedTools,
      enabledAgentToolNames(
        nestedTools,
        customAgent,
        options.input.runInBackground,
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
    const runtimeTools = this.options.hooks
      ? new ClaudeHookToolCoordinator({
          tools: agentTools,
          permissions,
          hooks: this.options.hooks,
          session: hookSession,
          recordOutcome: recordHookOutcome,
        })
      : agentTools
    const runtimePermissions = this.options.hooks
      ? (runtimeTools as ClaudeHookToolCoordinator)
      : permissions
    const emit = (event: RuntimeEvent) => {
      if (event.type === 'usage') {
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
      maxModelTurns: customAgent?.maxTurns ?? 16,
      maxModelOutputBytes:
        this.options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      maxToolCallsPerTurn: 32,
      maxToolInputBytes: 1024 * 1024,
    })
    const observer = {
      assistantCompleted: async (message: {
        content: string
        thinkingBlocks?: readonly ModelThinkingBlock[]
        toolCalls?: readonly ModelToolCall[]
      }) => {
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

    this.options.eventSink?.({
      type: 'task-started',
      taskId: options.agentId,
      ...(options.toolUseId ? { toolUseId: options.toolUseId } : {}),
      description: options.input.description,
      taskType: options.input.subagentType,
      prompt: options.input.prompt,
    })

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
      )
      const agentSystem = memoryPrompt
        ? `${baseSystem}\n\n${memoryPrompt}`
        : baseSystem
      const system = options.outputSchema
        ? `${agentSystem}\n\nYou MUST call StructuredOutput exactly once at the end with a value matching its schema.`
        : agentSystem
      const preloadedSkills = agentSkillMessages(
        this.options.extensions,
        customAgent,
      )
      let stopHookActive = false
      const contextBudget = options.provider.capabilities.contextWindowTokens
        ? new ContextBudget({
            contextWindowTokens:
              options.provider.capabilities.contextWindowTokens,
            ...(this.options.contextReserveTokens === undefined
              ? {}
              : { reserveTokens: this.options.contextReserveTokens }),
          })
        : null
      const definitions = options.provider.capabilities.tools
        ? runtimeTools.definitions()
        : []
      const assembleMessages = async () => {
        const assembledContext = await this.options.contextAssembler?.assemble({
          cwd,
        })
        const messages = [
          ...(assembledContext?.systemMessages ?? []),
          { role: 'system' as const, content: system },
          ...injectFirstUserMessageContext(
            projectClaudeModelMessages(snapshot.entries),
            assembledContext?.firstUserMessageContext,
          ),
          ...preloadedSkills,
        ]
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
      const result = await runtime.run({
        messages: await assembleMessages(),
        reloadMessages: assembleMessages,
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
        ...(this.options.hooks || this.options.backgroundTaskNotifications
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
                  options.signal,
                )
                if (outcome) {
                  await recordHookOutcome(outcome)
                  if (outcome.blockedReason) {
                    stopHookActive = true
                    messages.push(`Stop hook error: ${outcome.blockedReason}`)
                  }
                }
                const background = await this.background.notifications({
                  waitForRunning: false,
                  excludeAgentId: options.agentId,
                })
                messages.push(...background.messages)
                messages.push(
                  ...((await this.options.backgroundTaskNotifications?.(
                    true,
                  )) ?? []),
                )
                return { messages, usage: background.usage }
              },
            }
          : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      })
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
      this.options.eventSink?.({
        type: 'task-notification',
        taskId: options.agentId,
        ...(options.toolUseId ? { toolUseId: options.toolUseId } : {}),
        status: options.signal?.aborted ? 'stopped' : 'failed',
        outputFile: options.transcriptPath,
        summary: error instanceof Error ? error.message : String(error),
        usage: {
          totalTokens: 0,
          toolUses: toolUseCount,
          durationMs: Date.now() - taskStartedAt,
        },
      })
      throw error
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
      return this.executor.executeManagement(call, this.sessionId)
    }
    if (call.name === 'TaskOutput' || call.name === 'TaskStop') {
      const taskId = call.input.task_id ?? call.input.shell_id
      if (typeof taskId === 'string' && isBackgroundBashTaskId(taskId)) {
        return this.base.execute(call, context)
      }
      return this.executor.executeManagement(call, this.sessionId)
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
    )
  }
}
