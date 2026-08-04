import { basename, dirname, extname } from 'node:path'

import { parse as parseYaml } from 'yaml'

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

export interface ClaudePromptExpansion {
  userMessages: readonly string[]
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

  constructor(
    resources: Pick<ClaudeSharedResources, 'agents' | 'commands' | 'skills'>,
  ) {
    this.commands = indexed('command', resources.commands)
    this.skills = indexed('skill', resources.skills)
    this.agents = indexed('agent', resources.agents)
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
