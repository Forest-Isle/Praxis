import type {
  ModelToolCall,
  ModelToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolRegistry,
} from '../core/runtime.js'
import { resolveToolSchedulingPolicy } from '../core/tool-scheduling-policy.js'

export interface FilteredToolRegistryOptions {
  tools?: readonly string[]
  disallowedTools?: readonly string[]
}

function exactToolNames(rules: readonly string[]): Set<string> {
  return new Set(
    rules.flatMap((rule) => {
      const match = /^([A-Za-z][\w-]*)$/.exec(rule)
      return match?.[1] ? [match[1]] : []
    }),
  )
}

export class FilteredToolRegistry implements ToolRegistry {
  private readonly definitionsByName: ReadonlyMap<string, ModelToolDefinition>
  private readonly enabledNames: ReadonlySet<string>

  constructor(
    private readonly base: ToolRegistry,
    options: FilteredToolRegistryOptions = {},
  ) {
    const definitions = base.definitions()
    this.definitionsByName = new Map(
      definitions.map((definition) => [definition.name, definition]),
    )
    const selected = options.tools
    const enabled =
      selected === undefined || selected.includes('default')
        ? new Set(this.definitionsByName.keys())
        : new Set(selected)
    for (const name of enabled) {
      if (!this.definitionsByName.has(name)) {
        throw new Error(`Unknown tool in --tools: ${name}`)
      }
    }
    for (const name of exactToolNames(options.disallowedTools ?? [])) {
      enabled.delete(name)
    }
    this.enabledNames = enabled
  }

  definitions(): readonly ModelToolDefinition[] {
    return [...this.enabledNames].map((name) => {
      const definition = this.definitionsByName.get(name)
      if (!definition) throw new Error(`Unknown enabled tool: ${name}`)
      return definition
    })
  }

  schedulingPolicy(call: ModelToolCall) {
    this.assertEnabled(call.name)
    return resolveToolSchedulingPolicy(this.base, call)
  }

  async prepare(
    call: ModelToolCall,
    context: ToolExecutionContext,
  ): Promise<ModelToolCall> {
    this.assertEnabled(call.name)
    return this.base.prepare(call, context)
  }

  async execute(
    call: ModelToolCall,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    this.assertEnabled(call.name)
    return this.base.execute(call, context)
  }

  private assertEnabled(name: string): void {
    if (!this.enabledNames.has(name)) {
      throw new Error(`Tool ${name} is disabled by CLI controls`)
    }
  }
}
