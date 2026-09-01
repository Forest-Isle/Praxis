import type {
  ModelToolCall,
  ModelToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolRegistry,
  ToolSchedulingPolicy,
} from '../core/runtime.js'
import { resolveToolSchedulingPolicy } from '../core/tool-scheduling-policy.js'

const TOOL_SEARCH = 'ToolSearch'
const MAX_MATCHES = 8
const isDeferred = (definition: ModelToolDefinition) =>
  definition.name.startsWith('mcp__')
const truncateCodePoints = (value: string, max: number): string =>
  Array.from(value).slice(0, max).join('')

const toolSearchDefinition: ModelToolDefinition = {
  name: TOOL_SEARCH,
  description:
    'Search available MCP tools. A successful search activates matching tools, whose schemas appear on the next model request.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 1, maxLength: 256 },
    },
    required: ['query'],
    additionalProperties: false,
  },
}

function invalidSearch(): ToolExecutionResult {
  return { content: 'Invalid ToolSearch input', isError: true }
}

function summary(definition: ModelToolDefinition): string {
  const text = definition.description || '(no description)'
  return Array.from(text).length > 240
    ? `${truncateCodePoints(text, 237)}...`
    : text
}

class ActiveDeferredToolRegistry implements ToolRegistry {
  private readonly active = new Set<string>()
  private readonly deferred: readonly ModelToolDefinition[]

  constructor(
    private readonly base: ToolRegistry,
    private readonly definitionsByOrder: readonly ModelToolDefinition[],
    restoredToolNames: readonly string[],
  ) {
    this.deferred = definitionsByOrder.filter(isDeferred)
    for (const name of restoredToolNames) {
      if (this.deferred.some((definition) => definition.name === name))
        this.active.add(name)
    }
  }

  definitions(): readonly ModelToolDefinition[] {
    const visible = this.definitionsByOrder.filter(
      (definition) =>
        !isDeferred(definition) || this.active.has(definition.name),
    )
    return [...visible, toolSearchDefinition]
  }

  schedulingPolicy(call: ModelToolCall): ToolSchedulingPolicy {
    if (call.name === TOOL_SEARCH)
      return { concurrency: 'exclusive', cancelOnInterrupt: true }
    this.assertAvailable(call.name)
    return resolveToolSchedulingPolicy(this.base, call)
  }

  async prepare(
    call: ModelToolCall,
    context: ToolExecutionContext,
  ): Promise<ModelToolCall> {
    if (call.name === TOOL_SEARCH) return call
    this.assertAvailable(call.name)
    return this.base.prepare(call, context)
  }

  async execute(
    call: ModelToolCall,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    if (call.name === TOOL_SEARCH) return this.search(call)
    this.assertAvailable(call.name)
    return this.base.execute(call, context)
  }

  private assertAvailable(name: string): void {
    if (
      this.deferred.some((definition) => definition.name === name) &&
      !this.active.has(name)
    ) {
      throw new Error(`Tool ${name} is inactive; call ToolSearch first`)
    }
  }

  private search(call: ModelToolCall): ToolExecutionResult {
    const input = call.input
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).length !== 1 ||
      typeof input.query !== 'string' ||
      input.query.trim().length < 1 ||
      Array.from(input.query).length > 256
    )
      return invalidSearch()
    const query = input.query.trim().toLowerCase()
    const tokens = query.split(/\s+/)
    const candidates = this.deferred
      .map((definition, index) => ({ definition, index }))
      .filter(({ definition }) => {
        const haystack =
          `${definition.name} ${definition.description}`.toLowerCase()
        return tokens.every((token) => haystack.includes(token))
      })
      .sort((left, right) => {
        const score = (item: typeof left) => {
          const name = item.definition.name.toLowerCase()
          if (name === query) return 0
          if (name.startsWith(query)) return 1
          if (name.includes(query)) return 2
          if (item.definition.description.toLowerCase().includes(query))
            return 3
          return 4
        }
        return score(left) - score(right) || left.index - right.index
      })
      .slice(0, MAX_MATCHES)
    const newlyActivated = candidates.filter(
      ({ definition }) => !this.active.has(definition.name),
    )
    const alreadyActive = candidates.filter(({ definition }) =>
      this.active.has(definition.name),
    )
    for (const { definition } of candidates) this.active.add(definition.name)
    const names = candidates.map(({ definition }) => definition.name)
    let content = names.length
      ? 'Matching MCP tools were found; their schemas will appear on the next model request.'
      : 'No matching MCP tools found; no schemas were activated.'
    if (names.length) {
      if (newlyActivated.length) {
        content += `\nActivated: ${newlyActivated.map(({ definition }) => definition.name).join(', ')}`
      }
      if (alreadyActive.length) {
        content += `\nAlready active: ${alreadyActive.map(({ definition }) => definition.name).join(', ')}`
      }
      content += `\n${candidates.map(({ definition }) => `${definition.name}: ${summary(definition)}`).join('\n')}`
    }
    return { content: truncateCodePoints(content, 4096), isError: false }
  }
}

export class DeferredToolCatalog {
  private readonly definitions: readonly ModelToolDefinition[]

  constructor(private readonly base: ToolRegistry) {
    this.definitions = [...base.definitions()]
  }

  startTurn(
    options: { enabled?: boolean; restoredToolNames?: readonly string[] } = {},
  ): ToolRegistry {
    const deferred = this.definitions.some(isDeferred)
    if (options.enabled === false || !deferred) return this.base
    const seen = new Set<string>()
    for (const definition of this.definitions) {
      if (seen.has(definition.name))
        throw new Error(`Duplicate tool definition: ${definition.name}`)
      seen.add(definition.name)
    }
    if (seen.has(TOOL_SEARCH))
      throw new Error(`Tool definition collision: ${TOOL_SEARCH}`)
    return new ActiveDeferredToolRegistry(
      this.base,
      this.definitions,
      options.restoredToolNames ?? [],
    )
  }
}
