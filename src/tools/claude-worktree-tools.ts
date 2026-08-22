import type {
  ModelToolCall,
  ModelToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolRegistry,
} from '../core/runtime.js'
import { resolveToolSchedulingPolicy } from '../core/tool-scheduling-policy.js'
import type {
  SessionWorktreeManager,
  WorkspaceContext,
} from '../application/session-worktree.js'
import type { DataPlane } from '../persistence/data-plane.js'

const ENTER_DEFINITION: ModelToolDefinition = {
  name: 'EnterWorktree',
  description:
    'Create or enter an isolated Git worktree and switch the current session into it.',
  inputSchema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      name: {
        description:
          'Optional name for a new worktree. Each "/"-separated segment may contain only letters, digits, dots, underscores, and dashes; max 64 chars total. A random name is generated if not provided. Mutually exclusive with path.',
        type: 'string',
      },
      path: {
        description:
          'Path to an existing worktree to switch into instead of creating a new one. Must be registered with the current repository and live under .claude/worktrees. Mutually exclusive with name.',
        type: 'string',
      },
    },
    additionalProperties: false,
  },
}

const EXIT_DEFINITION: ModelToolDefinition = {
  name: 'ExitWorktree',
  description:
    'Exit an active worktree session and return to the original working directory.',
  inputSchema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      action: {
        description:
          '"keep" leaves the worktree and branch on disk; "remove" deletes both.',
        type: 'string',
        enum: ['keep', 'remove'],
      },
      discard_changes: {
        description:
          'Required true when action is "remove" and the worktree has uncommitted files or unmerged commits.',
        type: 'boolean',
      },
    },
    required: ['action'],
    additionalProperties: false,
  },
}

function worktreeDefinitions(
  dataPlane: DataPlane,
): readonly ModelToolDefinition[] {
  if (dataPlane === 'claude') return [ENTER_DEFINITION, EXIT_DEFINITION]
  return [
    {
      ...ENTER_DEFINITION,
      inputSchema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: {
          name: {
            description:
              'Optional name for a new worktree. Each "/"-separated segment may contain only letters, digits, dots, underscores, and dashes; max 64 chars total. A random name is generated if not provided. Mutually exclusive with path.',
            type: 'string',
          },
          path: {
            description:
              'Path to an existing worktree to switch into instead of creating a new one. Must be registered with the current repository and live under .praxis/worktrees. Mutually exclusive with name.',
            type: 'string',
          },
        },
        additionalProperties: false,
      },
    },
    EXIT_DEFINITION,
  ]
}

function objectInput(call: ModelToolCall): Record<string, unknown> {
  if (
    !call.input ||
    typeof call.input !== 'object' ||
    Array.isArray(call.input)
  ) {
    throw new Error(`${call.name} input must be an object`)
  }
  return call.input
}

function optionalString(
  input: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = input[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${key} must be a non-empty string`)
  }
  return value
}

export class ClaudeWorktreeToolRegistry implements ToolRegistry {
  private readonly enabled: ReadonlySet<string>

  constructor(
    private readonly options: {
      base: ToolRegistry
      manager: SessionWorktreeManager
      workspace: WorkspaceContext
      enabledTools?: readonly ('EnterWorktree' | 'ExitWorktree')[]
      dataPlane?: DataPlane
    },
  ) {
    this.enabled = new Set(
      options.enabledTools ?? ['EnterWorktree', 'ExitWorktree'],
    )
  }

  definitions(): readonly ModelToolDefinition[] {
    const base = this.options.base.definitions()
    const existing = new Set(base.map(({ name }) => name))
    const definitions = worktreeDefinitions(this.options.dataPlane ?? 'claude')
    return [
      ...base,
      ...definitions.filter(
        (definition) =>
          this.enabled.has(definition.name) && !existing.has(definition.name),
      ),
    ]
  }

  schedulingPolicy(call: ModelToolCall) {
    if (['EnterWorktree', 'ExitWorktree'].includes(call.name)) {
      return { concurrency: 'exclusive' as const, cancelOnInterrupt: true }
    }
    return resolveToolSchedulingPolicy(this.options.base, call)
  }

  async prepare(
    call: ModelToolCall,
    context: ToolExecutionContext,
  ): Promise<ModelToolCall> {
    if (call.name === 'EnterWorktree' && this.enabled.has(call.name)) {
      const input = objectInput(call)
      const name = optionalString(input, 'name')
      const path = optionalString(input, 'path')
      if (name !== undefined && path !== undefined) {
        throw new Error('EnterWorktree name and path are mutually exclusive')
      }
      return {
        ...call,
        input: {
          ...(name === undefined ? {} : { name }),
          ...(path === undefined ? {} : { path }),
        },
      }
    }
    if (call.name === 'ExitWorktree' && this.enabled.has(call.name)) {
      const input = objectInput(call)
      const action = input.action
      if (action !== 'keep' && action !== 'remove') {
        throw new Error('action must be keep or remove')
      }
      const discardChanges = input.discard_changes
      if (discardChanges !== undefined && typeof discardChanges !== 'boolean') {
        throw new Error('discard_changes must be a boolean')
      }
      return {
        ...call,
        input: {
          action,
          ...(discardChanges === undefined
            ? {}
            : { discard_changes: discardChanges }),
        },
      }
    }
    return this.options.base.prepare(call, {
      ...context,
      cwd: this.options.workspace.cwd(),
    })
  }

  async execute(
    call: ModelToolCall,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    if (call.name === 'EnterWorktree' && this.enabled.has(call.name)) {
      const input = call.input as { name?: string; path?: string }
      const result = await this.options.manager.enter(input, call.id)
      return { ...result, isError: false }
    }
    if (call.name === 'ExitWorktree' && this.enabled.has(call.name)) {
      const input = call.input as {
        action: 'keep' | 'remove'
        discard_changes?: boolean
      }
      const result = await this.options.manager.exit(input, call.id)
      return { ...result, isError: false }
    }
    return this.options.base.execute(call, {
      ...context,
      cwd: this.options.workspace.cwd(),
    })
  }
}

export const claudeWorktreeToolDefinitions = [
  ENTER_DEFINITION,
  EXIT_DEFINITION,
] as const
