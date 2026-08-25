import type {
  ModelToolCall,
  ModelToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolRegistry,
} from '../core/runtime.js'
import type {
  TeamLeadOperations,
  TeamCreateRequest,
} from '../application/team-lead-operations.js'
import {
  parseTeamMailboxPayload,
  type TeamMailboxPayload,
} from '../core/team-mailbox.js'
import { parseTeamBudgetOverrides } from '../core/team-ownership.js'

const names = [
  'TeamCreate',
  'TeamResume',
  'TeamList',
  'TeamAccept',
  'TeamStop',
  'TeamSend',
] as const
type TeamName = (typeof names)[number]

/** Claude's compatibility names are opt-in and never part of native definitions. */
export const CLAUDE_TEAM_TOOL_NAMES = [
  'ClaudeTeamCreate',
  'ClaudeTeamDelete',
  'ClaudeSendMessage',
] as const
type ClaudeTeamToolName = (typeof CLAUDE_TEAM_TOOL_NAMES)[number]
export interface ClaudeTeamCompatibilityPort {
  decodeCreate(input: unknown): unknown
  decodeDelete(input: unknown): unknown
  decodeSendMessage(input: unknown): unknown
  executeCreate(input: unknown): Promise<Record<string, unknown>>
  executeDelete(
    input: unknown,
    operations: TeamLeadOperations,
    leadSessionId: string,
  ): Promise<Record<string, unknown>>
  executeSend(
    input: unknown,
    operations: TeamLeadOperations,
    leadSessionId: string,
    operationId: string,
  ): Promise<Record<string, unknown>>
}
const unsupportedClaudeTeamToolNames = new Set([
  'ClaudeTask',
  'ClaudeNotification',
  'ClaudeContext',
  'ClaudeSessionResume',
])

/** Tools a Coordinator Lead may use; all other base/MCP tools are denied. */
export const COORDINATOR_LEAD_ALLOWLIST = Object.freeze([
  'TaskOutput',
  'TaskStop',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskUpdate',
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'SendMessage',
  'SendUserMessage',
  'Monitor',
  'PushNotification',
  ...names,
] as const)
const coordinatorAllowlist = new Set<string>(COORDINATOR_LEAD_ALLOWLIST)

const teamPayloadSchema = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'text'],
      properties: {
        kind: { const: 'text' },
        text: { type: 'string', minLength: 1 },
        summary: { type: 'string', minLength: 1 },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'phase', 'requestId', 'taskId', 'text'],
      properties: {
        kind: { const: 'task' },
        phase: { const: 'request' },
        requestId: { type: 'string', minLength: 1 },
        taskId: { type: 'string', minLength: 1 },
        text: { type: 'string', minLength: 1 },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'phase', 'requestId', 'taskId', 'status'],
      properties: {
        kind: { const: 'task' },
        phase: { const: 'response' },
        requestId: { type: 'string', minLength: 1 },
        taskId: { type: 'string', minLength: 1 },
        status: { enum: ['accepted', 'rejected', 'completed', 'failed'] },
        text: { type: 'string', minLength: 1 },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'phase', 'requestId'],
      properties: {
        kind: { const: 'shutdown' },
        phase: { const: 'request' },
        requestId: { type: 'string', minLength: 1 },
        reason: { type: 'string', minLength: 1 },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'phase', 'requestId', 'approved'],
      properties: {
        kind: { const: 'shutdown' },
        phase: { const: 'response' },
        requestId: { type: 'string', minLength: 1 },
        approved: { type: 'boolean' },
        reason: { type: 'string', minLength: 1 },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'phase', 'requestId', 'plan'],
      properties: {
        kind: { const: 'plan' },
        phase: { const: 'request' },
        requestId: { type: 'string', minLength: 1 },
        plan: { type: 'string', minLength: 1 },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'phase', 'requestId', 'approved'],
      properties: {
        kind: { const: 'plan' },
        phase: { const: 'response' },
        requestId: { type: 'string', minLength: 1 },
        approved: { type: 'boolean' },
        feedback: { type: 'string', minLength: 1 },
      },
    },
  ],
} as const

const definitions: readonly ModelToolDefinition[] = [
  {
    name: 'TeamCreate',
    description: 'Create a local Team.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['teamId', 'name', 'roster', 'tasks'],
      properties: {
        teamId: { type: 'string' },
        name: { type: 'string' },
        roster: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'agentType', 'access'],
            properties: {
              name: { type: 'string' },
              agentType: { type: 'string' },
              access: { enum: ['read-only', 'write'] },
            },
          },
        },
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'description', 'assignee', 'blockedBy', 'claims'],
            properties: {
              id: { type: 'string' },
              description: { type: 'string' },
              assignee: { type: 'string' },
              blockedBy: { type: 'array', items: { type: 'string' } },
              claims: {
                type: 'object',
                additionalProperties: false,
                required: [
                  'files',
                  'publicContracts',
                  'generatedArtifacts',
                  'migrations',
                  'mergeTargets',
                ],
                properties: Object.fromEntries(
                  [
                    'files',
                    'publicContracts',
                    'generatedArtifacts',
                    'migrations',
                    'mergeTargets',
                  ].map((key) => [
                    key,
                    { type: 'array', items: { type: 'string' } },
                  ]),
                ),
              },
            },
          },
        },
        leadPolicy: { enum: ['hybrid', 'coordinator'] },
        executionPolicy: { enum: ['sequential', 'swarm'] },
        commitPolicy: { enum: ['lead'] },
        budgets: {
          type: 'object',
          additionalProperties: false,
          properties: {
            maxAgents: { type: 'integer', minimum: 1 },
            maxConcurrent: { type: 'integer', minimum: 1 },
            maxTokens: { type: 'integer', minimum: 1 },
            maxDurationMs: { type: 'integer', minimum: 1 },
            shutdownDrainMs: { type: 'integer', minimum: 0, maximum: 600000 },
          },
        },
      },
    },
  },
  {
    name: 'TeamResume',
    description: 'Resume a local Team.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['teamId'],
      properties: { teamId: { type: 'string' } },
    },
  },
  {
    name: 'TeamList',
    description: 'List local Teams.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: 'TeamAccept',
    description: 'Accept or reject a completed Team task.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['teamId', 'taskId'],
      properties: {
        teamId: { type: 'string' },
        taskId: { type: 'string' },
        generation: { type: 'integer', minimum: 0 },
        decision: { enum: ['accepted', 'rejected'], default: 'accepted' },
      },
    },
  },
  {
    name: 'TeamStop',
    description: 'Stop a local Team.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['teamId'],
      properties: {
        teamId: { type: 'string' },
        drainMs: { type: 'integer', minimum: 0, maximum: 600000 },
      },
    },
  },
  {
    name: 'TeamSend',
    description: 'Send a typed message through a local Team mailbox.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['teamId', 'to', 'payload'],
      properties: {
        teamId: { type: 'string' },
        to: {
          anyOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' }, minItems: 1 },
            { const: 'broadcast' },
          ],
        },
        payload: teamPayloadSchema,
      },
    },
  },
]

const claudeDefinitions: readonly ModelToolDefinition[] = [
  {
    name: 'ClaudeTeamCreate',
    description: 'Create a Claude-compatible local Team.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['team_name'],
      properties: {
        team_name: { type: 'string' },
        description: { type: 'string' },
        agent_type: { type: 'string' },
      },
    },
  },
  {
    name: 'ClaudeTeamDelete',
    description: 'Delete a Claude-compatible local Team.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      oneOf: [{ required: ['team_name'] }, { required: ['team_id'] }],
      properties: {
        team_name: { type: 'string' },
        team_id: { type: 'string' },
      },
    },
  },
  {
    name: 'ClaudeSendMessage',
    description: 'Send a Claude-compatible Team message.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['team_name', 'to', 'message'],
      properties: {
        team_name: { type: 'string' },
        to: { anyOf: [{ type: 'string' }, { const: '*' }] },
        summary: { type: 'string' },
        message: {
          oneOf: [
            { type: 'string', minLength: 1 },
            { type: 'object', additionalProperties: false },
          ],
        },
      },
    },
  },
]

function isClaudeTeamToolName(name: string): name is ClaudeTeamToolName {
  return CLAUDE_TEAM_TOOL_NAMES.includes(name as ClaudeTeamToolName)
}

function objectInput(
  input: Record<string, unknown>,
  allowed: readonly string[],
): void {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Team tool input must be an object')
  for (const key of Object.keys(input))
    if (!allowed.includes(key)) throw new Error(`Unknown Team field: ${key}`)
}
function stringValue(input: Record<string, unknown>, key: string): string {
  const value = input[key]
  if (typeof value !== 'string' || value.trim() === '')
    throw new Error(`Invalid ${key}`)
  return value
}
function validate(
  input: Record<string, unknown>,
  name: TeamName,
): Record<string, unknown> {
  if (name === 'TeamCreate') {
    objectInput(input, [
      'teamId',
      'name',
      'roster',
      'tasks',
      'leadPolicy',
      'executionPolicy',
      'commitPolicy',
      'budgets',
    ])
    stringValue(input, 'teamId')
    stringValue(input, 'name')
    if (!Array.isArray(input.roster) || !Array.isArray(input.tasks))
      throw new Error('Invalid Team roster or tasks')
    if (
      input.leadPolicy !== undefined &&
      input.leadPolicy !== 'hybrid' &&
      input.leadPolicy !== 'coordinator'
    )
      throw new Error('Invalid leadPolicy')
    if (
      input.executionPolicy !== undefined &&
      input.executionPolicy !== 'sequential' &&
      input.executionPolicy !== 'swarm'
    )
      throw new Error('Invalid executionPolicy')
    if (input.commitPolicy !== undefined && input.commitPolicy !== 'lead')
      throw new Error('Invalid commitPolicy')
    if (input.budgets !== undefined) {
      if (
        !input.budgets ||
        typeof input.budgets !== 'object' ||
        Array.isArray(input.budgets)
      )
        throw new Error('Invalid Team budgets')
      parseTeamBudgetOverrides(input.budgets)
    }
    for (const member of input.roster) {
      if (!member || typeof member !== 'object' || Array.isArray(member))
        throw new Error('Invalid Team member')
      objectInput(member as Record<string, unknown>, [
        'name',
        'agentType',
        'access',
      ])
    }
    for (const task of input.tasks) {
      if (!task || typeof task !== 'object' || Array.isArray(task))
        throw new Error('Invalid Team task')
      const value = task as Record<string, unknown>
      objectInput(value, [
        'id',
        'description',
        'assignee',
        'blockedBy',
        'claims',
      ])
      if (
        !value.claims ||
        typeof value.claims !== 'object' ||
        Array.isArray(value.claims)
      )
        throw new Error('Invalid Team claims')
      objectInput(value.claims as Record<string, unknown>, [
        'files',
        'publicContracts',
        'generatedArtifacts',
        'migrations',
        'mergeTargets',
      ])
    }
    return input
  }
  if (name === 'TeamList') {
    objectInput(input, [])
    return {}
  }
  if (name === 'TeamResume') {
    objectInput(input, ['teamId'])
    stringValue(input, 'teamId')
    return input
  }
  if (name === 'TeamAccept') {
    objectInput(input, ['teamId', 'taskId', 'generation', 'decision'])
    stringValue(input, 'teamId')
    stringValue(input, 'taskId')
    if (
      input.generation !== undefined &&
      (!Number.isSafeInteger(input.generation) ||
        (input.generation as number) < 0)
    )
      throw new Error('Invalid generation')
    if (
      input.decision !== undefined &&
      input.decision !== 'accepted' &&
      input.decision !== 'rejected'
    )
      throw new Error('Invalid decision')
    return {
      ...input,
      ...(input.decision === undefined ? { decision: 'accepted' } : {}),
    }
  }
  if (name === 'TeamSend') {
    objectInput(input, ['teamId', 'to', 'payload'])
    stringValue(input, 'teamId')
    if (input.to !== 'broadcast') {
      if (typeof input.to === 'string') {
        stringValue(input, 'to')
      } else if (Array.isArray(input.to)) {
        if (
          input.to.length === 0 ||
          input.to.some(
            (value) => typeof value !== 'string' || value.trim() === '',
          )
        )
          throw new Error('Invalid Team recipients')
      } else throw new Error('Invalid Team recipients')
    }
    return { ...input, payload: parseTeamMailboxPayload(input.payload) }
  }
  objectInput(input, ['teamId', 'drainMs'])
  stringValue(input, 'teamId')
  if (
    input.drainMs !== undefined &&
    (typeof input.drainMs !== 'number' ||
      !Number.isFinite(input.drainMs) ||
      input.drainMs < 0 ||
      input.drainMs > 600000)
  )
    throw new Error('Invalid drainMs')
  if (input.drainMs !== undefined && !Number.isSafeInteger(input.drainMs))
    throw new Error('Invalid drainMs')
  return input
}

export class TeamLeadToolRegistry implements ToolRegistry {
  private readonly enabled: ReadonlySet<string>
  constructor(
    private readonly base: ToolRegistry,
    private readonly operations: TeamLeadOperations,
    private readonly sessionId: string,
    toolNames: readonly string[],
    private readonly claudeTeam?: ClaudeTeamCompatibilityPort,
  ) {
    this.enabled = new Set(
      toolNames.filter(
        (name): name is TeamName | ClaudeTeamToolName =>
          names.includes(name as TeamName) ||
          CLAUDE_TEAM_TOOL_NAMES.includes(name as ClaudeTeamToolName),
      ),
    )
  }
  definitions(): readonly ModelToolDefinition[] {
    return [
      ...this.base
        .definitions()
        .filter((definition) => this.isAllowed(definition.name)),
      ...definitions.filter(
        (definition) =>
          this.enabled.has(definition.name) && this.isAllowed(definition.name),
      ),
      ...claudeDefinitions.filter(
        (definition) =>
          this.claudeTeam !== undefined &&
          this.enabled.has(definition.name) &&
          this.isAllowed(definition.name),
      ),
    ]
  }
  /** Explicit compatibility discovery; native definitions remain unchanged. */
  claudeDefinitions(): readonly ModelToolDefinition[] {
    return claudeDefinitions
  }
  claudeToolNames(): readonly string[] {
    return CLAUDE_TEAM_TOOL_NAMES
  }
  schedulingPolicy(call: ModelToolCall) {
    if (isClaudeTeamToolName(call.name)) {
      if (!this.claudeTeam) throw new Error(`Tool ${call.name} is unavailable`)
      if (!this.enabled.has(call.name))
        throw new Error(`Tool ${call.name} is unavailable`)
      return { concurrency: 'exclusive' as const, cancelOnInterrupt: true }
    }
    if (unsupportedClaudeTeamToolNames.has(call.name))
      throw new Error(`Unsupported Claude Team tool: ${call.name}`)
    this.assertLeadPolicyAllows(call.name)
    if (names.includes(call.name as TeamName)) {
      if (!this.enabled.has(call.name))
        throw new Error(`Tool ${call.name} is unavailable`)
      return { concurrency: 'exclusive' as const, cancelOnInterrupt: true }
    }
    return (
      this.base.schedulingPolicy?.(call) ?? {
        concurrency: 'concurrent' as const,
      }
    )
  }
  async prepare(
    call: ModelToolCall,
    context: ToolExecutionContext,
  ): Promise<ModelToolCall> {
    this.assertLeadPolicyAllows(call.name)
    if (isClaudeTeamToolName(call.name)) {
      const claudeTeam = this.claudeTeam
      if (!claudeTeam) throw new Error(`Tool ${call.name} is unavailable`)
      if (!this.enabled.has(call.name))
        throw new Error(`Tool ${call.name} is unavailable`)
      if (call.name === 'ClaudeTeamCreate') claudeTeam.decodeCreate(call.input)
      else if (call.name === 'ClaudeTeamDelete')
        claudeTeam.decodeDelete(call.input)
      else claudeTeam.decodeSendMessage(call.input)
      return call
    }
    if (unsupportedClaudeTeamToolNames.has(call.name))
      throw new Error(`Unsupported Claude Team tool: ${call.name}`)
    if (names.includes(call.name as TeamName) && !this.enabled.has(call.name))
      throw new Error(`Tool ${call.name} is unavailable`)
    if (!this.enabled.has(call.name)) return this.base.prepare(call, context)
    return { ...call, input: validate(call.input, call.name as TeamName) }
  }
  async execute(
    call: ModelToolCall,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    if (unsupportedClaudeTeamToolNames.has(call.name))
      throw new Error(`Unsupported Claude Team tool: ${call.name}`)
    if (isClaudeTeamToolName(call.name) && !this.enabled.has(call.name))
      throw new Error(`Tool ${call.name} is unavailable`)
    if (isClaudeTeamToolName(call.name)) {
      const claudeTeam = this.claudeTeam
      if (!claudeTeam) throw new Error(`Tool ${call.name} is unavailable`)
      if (call.name === 'ClaudeTeamCreate')
        return this.result({
          claude: await claudeTeam.executeCreate(call.input),
        })
      if (call.name === 'ClaudeTeamDelete')
        return this.result({
          claude: await claudeTeam.executeDelete(
            call.input,
            this.operations,
            this.sessionId,
          ),
        })
      return this.result({
        claude: await claudeTeam.executeSend(
          call.input,
          this.operations,
          this.sessionId,
          call.id,
        ),
      })
    }
    this.assertLeadPolicyAllows(call.name)
    if (names.includes(call.name as TeamName) && !this.enabled.has(call.name))
      throw new Error(`Tool ${call.name} is unavailable`)
    if (!this.enabled.has(call.name)) return this.base.execute(call, context)
    if (context.signal?.aborted) throw new Error('Team tool interrupted')
    const input = validate(call.input, call.name as TeamName)
    let value
    switch (call.name as TeamName) {
      case 'TeamCreate':
        value = await this.operations.create(
          input as unknown as TeamCreateRequest,
          this.sessionId,
        )
        break
      case 'TeamResume':
        value = await this.operations.resume(
          input.teamId as string,
          this.sessionId,
        )
        break
      case 'TeamList':
        return this.result({ teams: await this.operations.list() })
      case 'TeamAccept':
        value = await this.operations.accept(
          input as {
            teamId: string
            taskId: string
            generation?: number
            decision?: 'accepted' | 'rejected'
          },
          this.sessionId,
        )
        break
      case 'TeamStop':
        value = await this.operations.stop(
          input as { teamId: string; drainMs?: number },
          this.sessionId,
        )
        break
      case 'TeamSend':
        value = await this.operations.send(
          input as {
            teamId: string
            to: string | readonly string[] | 'broadcast'
            payload: TeamMailboxPayload
          },
          this.sessionId,
          call.id,
        )
        return this.result({ message: value })
    }
    return this.result({ team: value })
  }
  private isAllowed(name: string): boolean {
    return (
      this.operations.activeLeadPolicy(this.sessionId) !== 'coordinator' ||
      coordinatorAllowlist.has(name)
    )
  }
  private assertLeadPolicyAllows(name: string): void {
    if (!this.isAllowed(name))
      throw new Error(`Tool ${name} is unavailable for Coordinator Lead`)
  }
  private result(value: Record<string, unknown>): ToolExecutionResult {
    return {
      content: JSON.stringify(value),
      isError: false,
      nativeToolUseResult: value,
    }
  }
}
