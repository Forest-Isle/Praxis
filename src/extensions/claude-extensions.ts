import { basename, dirname, extname } from 'node:path'

import { parse as parseYaml } from 'yaml'

import type { ModelContentBlock, ModelImage } from '../core/runtime.js'
import type { ClaudeMcpPromptDefinition } from '../mcp/claude-mcp-tools.js'
import type {
  ClaudeSharedResources,
  ClaudeTextResource,
} from '../compatibility/claude/shared-resources.js'

export type ClaudeExtensionKind = 'agent' | 'command' | 'skill'

export interface ClaudeExtensionDefinition extends ClaudeTextResource {
  kind: ClaudeExtensionKind
  name: string
  description: string
  body: string
  modelInvocable: boolean
}

export interface ClaudeSlashCommandDefinition {
  name: string
  description: string
  kind: 'command' | 'skill' | 'mcp'
}

export interface ClaudePromptExpansion {
  userMessages: readonly string[]
  messages?: readonly ClaudePromptExpansionMessage[]
}

export interface ClaudePromptExpansionMessage {
  text: string
  contentBlocks?: readonly ModelContentBlock[]
  images?: readonly ModelImage[]
}

const BUILTIN_LOOP: ClaudeExtensionDefinition = {
  path: '/__praxis_builtin__/commands/loop.md',
  scope: 'user',
  content: '',
  kind: 'command',
  name: 'loop',
  description:
    'Run a prompt or slash command on a recurring interval; defaults to 10 minutes.',
  modelInvocable: true,
  body: `# /loop — schedule a recurring prompt

Parse the input into an optional interval followed by a prompt, then schedule it with CronCreate.

Parsing order:
1. A leading token matching ^\\d+[smhd]$ is the interval; the remainder is the prompt.
2. Otherwise, a trailing "every <N><unit>" or "every <N> <unit-word>" clause is the interval when it is a valid time expression.
3. Otherwise, use 10m and keep the complete input as the prompt.

If the resulting prompt is empty, show usage /loop [interval] <prompt> and do not call CronCreate.

Convert intervals to five-field cron:
- Ns: ceil(N/60) minutes, minimum one minute.
- Nm up to 59: */N * * * *.
- Nm of 60 or more: 0 */H * * *, rounded to a clean hour divisor.
- Nh up to 23: 0 */N * * * *.
- Nd: 0 0 */N * *.

If an interval cannot be represented evenly, choose the nearest clean interval and tell the user what was rounded.

Call CronCreate with the derived cron, the parsed prompt verbatim, and recurring true. Confirm the prompt, cron, human cadence, seven-day auto-expiration, CronDelete cancellation, and job ID. Then immediately execute the parsed prompt once; invoke slash commands through Skill and otherwise act on the prompt directly.

Input:
$ARGUMENTS`,
}

function parseFrontmatter(resource: ClaudeTextResource): {
  metadata: Record<string, unknown>
  body: string
} {
  const lines = resource.content.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') {
    return { metadata: {}, body: resource.content }
  }
  const closingIndex = lines.findIndex(
    (line, index) => index > 0 && line.trim() === '---',
  )
  if (closingIndex < 0) return { metadata: {}, body: resource.content }

  let metadata: unknown
  try {
    metadata = parseYaml(lines.slice(1, closingIndex).join('\n'))
  } catch {
    return { metadata: {}, body: lines.slice(closingIndex + 1).join('\n') }
  }
  if (metadata !== null && typeof metadata !== 'object') {
    return { metadata: {}, body: lines.slice(closingIndex + 1).join('\n') }
  }
  return {
    metadata: (metadata ?? {}) as Record<string, unknown>,
    body: lines.slice(closingIndex + 1).join('\n'),
  }
}

export function validateClaudeExtensions(
  resources: readonly ClaudeTextResource[],
): void {
  for (const resource of resources) {
    const lines = resource.content.split(/\r?\n/)
    if (lines[0]?.trim() !== '---') continue
    const closingIndex = lines.findIndex(
      (line, index) => index > 0 && line.trim() === '---',
    )
    if (closingIndex < 0) {
      throw new Error(`Unterminated extension frontmatter: ${resource.path}`)
    }
    let metadata: unknown
    try {
      metadata = parseYaml(lines.slice(1, closingIndex).join('\n'))
    } catch (error) {
      throw new Error(`Invalid extension frontmatter: ${resource.path}`, {
        cause: error,
      })
    }
    if (metadata !== null && typeof metadata !== 'object') {
      throw new Error(
        `Extension frontmatter must be an object: ${resource.path}`,
      )
    }
    const record = (metadata ?? {}) as Record<string, unknown>
    if (
      record.name !== undefined &&
      (typeof record.name !== 'string' || record.name.length === 0)
    ) {
      throw new Error(
        `Extension name must be a non-empty string: ${resource.path}`,
      )
    }
    if (
      record.description !== undefined &&
      typeof record.description !== 'string'
    ) {
      throw new Error(
        `Extension description must be a string: ${resource.path}`,
      )
    }
    if (
      record['disable-model-invocation'] !== undefined &&
      typeof record['disable-model-invocation'] !== 'boolean'
    ) {
      throw new Error(
        `Extension disable-model-invocation must be a boolean: ${resource.path}`,
      )
    }
  }
}

function defaultName(kind: ClaudeExtensionKind, path: string): string {
  if (kind === 'command') {
    const normalized = path.replaceAll('\\', '/')
    const marker = '/commands/'
    const markerIndex = normalized.lastIndexOf(marker)
    const relativePath =
      markerIndex < 0
        ? basename(path, extname(path))
        : normalized.slice(markerIndex + marker.length).replace(/\.md$/, '')
    return relativePath.replaceAll('/', ':')
  }
  return kind === 'skill'
    ? basename(dirname(path))
    : basename(path, extname(path))
}

function parseDefinition(
  kind: ClaudeExtensionKind,
  resource: ClaudeTextResource,
): ClaudeExtensionDefinition {
  const parsed = parseFrontmatter(resource)
  const metadata =
    (parsed.metadata.name === undefined ||
      (typeof parsed.metadata.name === 'string' &&
        parsed.metadata.name.length > 0)) &&
    (parsed.metadata.description === undefined ||
      typeof parsed.metadata.description === 'string') &&
    (parsed.metadata['disable-model-invocation'] === undefined ||
      typeof parsed.metadata['disable-model-invocation'] === 'boolean')
      ? parsed.metadata
      : {}
  const { body } = parsed
  const name =
    kind === 'command'
      ? defaultName(kind, resource.path)
      : typeof metadata.name === 'string'
        ? metadata.name
        : defaultName(kind, resource.path)
  const description =
    typeof metadata.description === 'string' ? metadata.description : ''
  return {
    ...resource,
    kind,
    name,
    description,
    body,
    modelInvocable: metadata['disable-model-invocation'] !== true,
  }
}

function indexed(
  kind: ClaudeExtensionKind,
  resources: readonly ClaudeTextResource[],
): Map<string, ClaudeExtensionDefinition> {
  const definitions = new Map<string, ClaudeExtensionDefinition>()
  for (const resource of resources) {
    const definition = parseDefinition(kind, resource)
    definitions.set(definition.name, definition)
  }
  return definitions
}

function substituteArguments(body: string, argumentsText: string): string {
  const values = argumentsText.length === 0 ? [] : argumentsText.split(/\s+/)
  return body.replace(/\$(ARGUMENTS|\d+)/g, (_, key: string) =>
    key === 'ARGUMENTS' ? argumentsText : (values[Number(key)] ?? ''),
  )
}

function renderInvocation(
  definition: ClaudeExtensionDefinition,
  argumentsText: string,
): string {
  const content = substituteArguments(definition.body, argumentsText)
  return definition.kind === 'skill'
    ? `Base directory for this skill: ${dirname(definition.path)}\n\n${content}`
    : content
}

export class ClaudeExtensionCatalog {
  private readonly commands: Map<string, ClaudeExtensionDefinition>
  private readonly skills: Map<string, ClaudeExtensionDefinition>
  private readonly agents: Map<string, ClaudeExtensionDefinition>
  private readonly disableSlashCommands: boolean
  private mcpPrompts = new Map<string, ClaudeMcpPromptDefinition>()

  constructor(
    resources: Pick<ClaudeSharedResources, 'agents' | 'commands' | 'skills'>,
    options: { disableSlashCommands?: boolean } = {},
  ) {
    this.disableSlashCommands = options.disableSlashCommands === true
    this.commands = options.disableSlashCommands
      ? new Map()
      : new Map([['loop', BUILTIN_LOOP]])
    if (!options.disableSlashCommands) {
      for (const [name, command] of indexed('command', resources.commands)) {
        this.commands.set(name, command)
      }
    }
    this.skills = options.disableSlashCommands
      ? new Map()
      : indexed('skill', resources.skills)
    this.agents = indexed('agent', resources.agents)
  }

  setMcpPrompts(prompts: readonly ClaudeMcpPromptDefinition[]): void {
    this.mcpPrompts.clear()
    if (this.disableSlashCommands) return
    const occupied = new Set([...this.commands.keys(), ...this.skills.keys()])
    for (const prompt of prompts) {
      if (occupied.has(prompt.name) || this.mcpPrompts.has(prompt.name))
        continue
      this.mcpPrompts.set(prompt.name, prompt)
    }
  }

  expandPrompt(prompt: string): ClaudePromptExpansion {
    const match = /^\/([^\s]+)(?:\s+(.*))?$/.exec(prompt)
    if (!match?.[1]) {
      return { userMessages: [prompt] }
    }
    const name = match[1]
    const argumentsText = match[2]?.trim() ?? ''
    const definition = this.skills.get(name) ?? this.commands.get(name)
    if (!definition) {
      return { userMessages: [prompt] }
    }
    return {
      userMessages: [
        [
          `<command-message>${name}</command-message>`,
          `<command-name>/${name}</command-name>`,
          ...(argumentsText
            ? [`<command-args>${argumentsText}</command-args>`]
            : []),
        ].join('\n'),
        renderInvocation(definition, argumentsText),
      ],
    }
  }

  async expandPromptAsync(
    prompt: string,
    signal?: AbortSignal,
    toolResultDirectory?: string,
  ): Promise<ClaudePromptExpansion> {
    const staticExpansion = this.expandPrompt(prompt)
    if (
      staticExpansion.userMessages.length !== 1 ||
      staticExpansion.userMessages[0] !== prompt
    ) {
      return staticExpansion
    }
    const match = /^\/([^\s]+) \(MCP\)(?: (.*))?$/.exec(prompt.trim())
    if (!match?.[1]) return staticExpansion
    const userFacingName = `${match[1]} (MCP)`
    const definition = [...this.mcpPrompts.values()].find(
      (candidate) => candidate.userFacingName === userFacingName,
    )
    if (!definition) return staticExpansion
    const argumentsText = match[2] ?? ''
    const result = await definition.invoke(argumentsText, {
      ...(signal ? { signal } : {}),
      ...(toolResultDirectory ? { toolResultDirectory } : {}),
    })
    const metadata = [
      `<command-message>${definition.name}</command-message>`,
      `<command-name>/${definition.name}</command-name>`,
      ...(argumentsText
        ? [`<command-args>${argumentsText}</command-args>`]
        : []),
    ].join('\n')
    return {
      userMessages: [metadata, result.text],
      messages: [
        { text: metadata },
        {
          text: result.text,
          contentBlocks: result.contentBlocks,
          images: result.images,
        },
      ],
    }
  }

  mcpPromptNames(): readonly string[] {
    return [...this.mcpPrompts.values()].map((prompt) => prompt.userFacingName)
  }

  slashCommandDefinitions(): readonly ClaudeSlashCommandDefinition[] {
    const definitions = new Map(this.commands)
    for (const [name, skill] of this.skills) definitions.set(name, skill)
    return [
      ...[...definitions.values()].map(
        (definition): ClaudeSlashCommandDefinition => ({
          name: definition.name,
          description: definition.description,
          kind: definition.kind === 'skill' ? 'skill' : 'command',
        }),
      ),
      ...[...this.mcpPrompts.values()].map((prompt) => ({
        name: prompt.userFacingName,
        description: prompt.description,
        kind: 'mcp' as const,
      })),
    ]
  }

  skill(name: string): ClaudeExtensionDefinition | null {
    return this.skills.get(name) ?? this.commands.get(name) ?? null
  }

  modelInvocableSkills(): readonly ClaudeExtensionDefinition[] {
    const definitions = new Map(this.commands)
    for (const [name, skill] of this.skills) definitions.set(name, skill)
    return [...definitions.values()].filter(
      (definition) => definition.modelInvocable,
    )
  }

  agent(name: string): ClaudeExtensionDefinition | null {
    return this.agents.get(name) ?? null
  }

  agentNames(): readonly string[] {
    return [...this.agents.keys()]
  }

  renderSkill(name: string, argumentsText: string): string | null {
    const definition = this.skill(name)
    return definition ? renderInvocation(definition, argumentsText) : null
  }
}
