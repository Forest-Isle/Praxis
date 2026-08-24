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

const names = [
  'TeamCreate',
  'TeamResume',
  'TeamList',
  'TeamAccept',
  'TeamStop',
] as const
type TeamName = (typeof names)[number]

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
        drainMs: { type: 'number', minimum: 0, maximum: 600000, default: 5000 },
      },
    },
  },
]

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
    objectInput(input, ['teamId', 'name', 'roster', 'tasks'])
    stringValue(input, 'teamId')
    stringValue(input, 'name')
    if (!Array.isArray(input.roster) || !Array.isArray(input.tasks))
      throw new Error('Invalid Team roster or tasks')
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
  return { ...input, ...(input.drainMs === undefined ? { drainMs: 5000 } : {}) }
}

export class TeamLeadToolRegistry implements ToolRegistry {
  private readonly enabled: ReadonlySet<string>
  constructor(
    private readonly base: ToolRegistry,
    private readonly operations: TeamLeadOperations,
    private readonly sessionId: string,
    toolNames: readonly string[],
  ) {
    this.enabled = new Set(
      toolNames.filter((name): name is TeamName =>
        names.includes(name as TeamName),
      ),
    )
  }
  definitions(): readonly ModelToolDefinition[] {
    return [
      ...this.base.definitions(),
      ...definitions.filter((definition) => this.enabled.has(definition.name)),
    ]
  }
  schedulingPolicy(call: ModelToolCall) {
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
    if (names.includes(call.name as TeamName) && !this.enabled.has(call.name))
      throw new Error(`Tool ${call.name} is unavailable`)
    if (!this.enabled.has(call.name)) return this.base.prepare(call, context)
    return { ...call, input: validate(call.input, call.name as TeamName) }
  }
  async execute(
    call: ModelToolCall,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
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
    }
    return this.result({ team: value })
  }
  private result(value: Record<string, unknown>): ToolExecutionResult {
    return {
      content: JSON.stringify(value),
      isError: false,
      nativeToolUseResult: value,
    }
  }
}
