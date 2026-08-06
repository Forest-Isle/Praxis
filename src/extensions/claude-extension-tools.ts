import type {
  ModelToolCall,
  ModelToolDefinition,
  PermissionDecision,
  PermissionResolver,
  PermissionResolutionContext,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolRegistry,
} from '../core/runtime.js'
import type { ClaudeExtensionCatalog } from './claude-extensions.js'

function skillInput(call: ModelToolCall): { skill: string; args: string } {
  const skill = call.input.skill
  const args = call.input.args ?? ''
  if (typeof skill !== 'string' || skill.length === 0) {
    throw new Error('skill must be a non-empty string')
  }
  if (typeof args !== 'string') throw new Error('args must be a string')
  return { skill, args }
}

export class ClaudeExtensionToolRegistry implements ToolRegistry {
  constructor(
    private readonly base: ToolRegistry,
    private readonly catalog: ClaudeExtensionCatalog,
  ) {}

  definitions(): readonly ModelToolDefinition[] {
    const skills = this.catalog.modelInvocableSkills()
    if (skills.length === 0) return this.base.definitions()
    return [
      ...this.base.definitions(),
      {
        name: 'Skill',
        description: 'Load an available Claude skill or command by name.',
        inputSchema: {
          type: 'object',
          properties: {
            skill: {
              type: 'string',
              enum: skills.map((skill) => skill.name),
            },
            args: { type: 'string' },
          },
          required: ['skill'],
          additionalProperties: false,
        },
      },
    ]
  }

  async prepare(
    call: ModelToolCall,
    context: ToolExecutionContext,
  ): Promise<ModelToolCall> {
    if (call.name !== 'Skill') return this.base.prepare(call, context)
    const input = skillInput(call)
    const definition = this.catalog
      .modelInvocableSkills()
      .find((skill) => skill.name === input.skill)
    if (!definition) throw new Error(`Unknown or disabled skill ${input.skill}`)
    return { ...call, input }
  }

  async execute(
    call: ModelToolCall,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    if (call.name !== 'Skill') return this.base.execute(call, context)
    const { skill, args } = skillInput(call)
    const content = this.catalog.renderSkill(skill, args)
    if (content === null) throw new Error(`Unknown skill ${skill}`)
    return {
      content: `Launching skill: ${skill}`,
      isError: false,
      followUpUserMessages: [content],
    }
  }
}

export class ClaudeExtensionPermissionResolver implements PermissionResolver {
  constructor(private readonly base: PermissionResolver) {}

  resolve(
    call: ModelToolCall,
    context?: PermissionResolutionContext,
  ): PermissionDecision | Promise<PermissionDecision> {
    return call.name === 'Skill'
      ? { behavior: 'allow' }
      : this.base.resolve(call, context)
  }
}
