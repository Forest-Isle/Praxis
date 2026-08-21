import { basename, dirname, extname } from 'node:path'

import { parse as parseYaml } from 'yaml'

import type { ModelContentBlock, ModelImage } from '../core/runtime.js'
import type { ClaudeMcpPromptDefinition } from '../mcp/claude-mcp-tools.js'
import type { DataPlane } from '../persistence/data-plane.js'
import type {
  ClaudeSharedResources,
  ClaudeTextResource,
} from '../compatibility/claude/shared-resources.js'
import {
  claudeInitDescription,
  claudeInitPrompt,
} from './claude-init-command.js'

export type ClaudeExtensionKind = 'agent' | 'command' | 'skill'

export interface ClaudeExtensionDefinition extends ClaudeTextResource {
  kind: ClaudeExtensionKind
  name: string
  description: string
  body: string
  modelInvocable: boolean
  permissionSafe: boolean
  progressMessage?: string
  builtin?: boolean
}

export interface ClaudeSlashCommandDefinition {
  name: string
  description: string
  kind: 'command' | 'skill' | 'mcp'
  progressMessage?: string
  builtin?: boolean
}

export interface ClaudeAgentDefinition {
  name: string
  description: string
}

export type ClaudeAgentEffort = 'low' | 'medium' | 'high' | 'max' | number

export type ClaudeAgentPermissionMode =
  'acceptEdits' | 'auto' | 'bypassPermissions' | 'default' | 'dontAsk' | 'plan'

export interface ClaudeAgentRuntimeDefinition extends ClaudeExtensionDefinition {
  kind: 'agent'
  tools?: readonly string[]
  disallowedTools?: readonly string[]
  model?: string
  effort?: ClaudeAgentEffort
  permissionMode?: ClaudeAgentPermissionMode
  maxTurns?: number
  skills?: readonly string[]
  initialPrompt?: string
  memory?: 'user' | 'project' | 'local'
  background?: boolean
  isolation?: 'worktree'
  mcpServers?: readonly unknown[]
  hooks?: Readonly<Record<string, unknown>>
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
  permissionSafe: true,
  builtin: true,
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

function builtinInitCommand(dataPlane: DataPlane): ClaudeExtensionDefinition {
  return {
    path: '/__praxis_builtin__/commands/init.md',
    scope: 'user',
    content: '',
    kind: 'command',
    name: 'init',
    description: claudeInitDescription(process.env, dataPlane),
    modelInvocable: false,
    permissionSafe: true,
    progressMessage: 'analyzing your codebase',
    builtin: true,
    body: claudeInitPrompt(process.env, dataPlane),
  }
}

const BUILTIN_STATUSLINE_COMMAND: ClaudeExtensionDefinition = {
  path: '/__praxis_builtin__/commands/statusline.md',
  scope: 'user',
  content: '',
  kind: 'command',
  name: 'statusline',
  description: "Set up Claude Code's status line UI",
  modelInvocable: false,
  permissionSafe: true,
  builtin: true,
  body: `Create an Agent with subagent_type "statusline-setup" and the prompt "$ARGUMENTS"`,
}

const NATIVE_BUILTIN_STATUSLINE_COMMAND: ClaudeExtensionDefinition = {
  ...BUILTIN_STATUSLINE_COMMAND,
  description: "Set up Praxis's status line UI",
}

export const BUILTIN_STATUSLINE_AGENT_PATH =
  '/__praxis_builtin__/agents/statusline-setup.md'

const BUILTIN_STATUSLINE_AGENT: ClaudeAgentRuntimeDefinition = {
  path: BUILTIN_STATUSLINE_AGENT_PATH,
  scope: 'user',
  content: '',
  kind: 'agent',
  name: 'statusline-setup',
  description: "Configure the user's Claude Code status line setting.",
  modelInvocable: false,
  permissionSafe: false,
  body: `You configure the statusLine command in the user's shared Claude Code settings.

Importing a shell prompt:
1. Inspect shell configuration in this order: ~/.zshrc, ~/.bashrc, ~/.bash_profile, then ~/.profile.
2. Find an exported or unexported quoted PS1 assignment. Preserve the prompt's information and colors.
3. Translate prompt escapes into commands: user to $(whoami), short/full host to $(hostname -s)/$(hostname), working directory to $(pwd), basename to $(basename "$(pwd)"), and time/date escapes to the corresponding date command. Preserve newlines and literal prompt counters.
4. Emit ANSI sequences with printf because the result is rendered by a terminal in dimmed colors.
5. Remove a trailing prompt marker such as "$" or ">" from the displayed status line.
6. If no PS1 exists and the request gives no other design, ask what information should be displayed.

The status command receives one JSON document on stdin. It contains session_id, optional session_name, transcript_path, cwd, model.id and model.display_name, workspace.current_dir/project_dir/added_dirs, version, output_style.name, cost totals, context_window totals/current_usage/used_percentage/remaining_percentage, exceeds_200k_tokens, and optional vim, agent, and worktree objects. Read stdin once and reuse it when extracting multiple values. Typical jq selectors include .model.display_name, .workspace.current_dir, .output_style.name, .context_window.remaining_percentage, and .context_window.used_percentage. Optional values must be tested before printing them.

Preserve every unrelated setting and update ~/.claude/settings.json with this shape:
{
  "statusLine": {
    "type": "command",
    "command": "the command"
  }
}

Resolve a symlinked settings file and edit its target. Complex implementations may live in a script under ~/.claude and be referenced by the setting. Git commands in that script must avoid optional locks. Report the exact configuration and script path, if any. End by telling the parent agent that future status-line changes must use the statusline-setup agent and that the user can request further changes.`,
}

const NATIVE_BUILTIN_STATUSLINE_AGENT: ClaudeAgentRuntimeDefinition = {
  ...BUILTIN_STATUSLINE_AGENT,
  description: "Configure the user's Praxis status line setting.",
  body: BUILTIN_STATUSLINE_AGENT.body
    .replaceAll('Claude Code', 'Praxis')
    .replaceAll('~/.claude', '~/.praxis'),
}

const GENERAL_PURPOSE_AGENT: ClaudeAgentDefinition = {
  name: 'general-purpose',
  description:
    'General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks.',
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

function parseAgentList(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  const values =
    typeof value === 'string'
      ? [value]
      : Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string')
        : []
  const parsed: string[] = []
  for (const value of values) {
    let current = ''
    let depth = 0
    for (const character of value) {
      if (character === '(') depth += 1
      if (character === ')' && depth > 0) depth -= 1
      if (depth === 0 && (character === ',' || /\s/u.test(character))) {
        if (current.trim()) parsed.push(current.trim())
        current = ''
      } else {
        current += character
      }
    }
    if (current.trim()) parsed.push(current.trim())
  }
  return parsed
}

function parseAgentEffort(value: unknown): ClaudeAgentEffort | undefined {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? value : undefined
  }
  if (typeof value !== 'string' || !value.trim()) return undefined
  const normalized = value.trim().toLowerCase()
  if (['low', 'medium', 'high', 'max'].includes(normalized)) {
    return normalized as Exclude<ClaudeAgentEffort, number>
  }
  if (!/^[+-]?\d+$/u.test(normalized)) return undefined
  const numeric = Number(normalized)
  return Number.isInteger(numeric) ? numeric : undefined
}

function parsePositiveInteger(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : undefined
  }
  if (typeof value !== 'string' || !/^[1-9]\d*$/u.test(value)) {
    return undefined
  }
  const numeric = Number(value)
  return Number.isSafeInteger(numeric) ? numeric : undefined
}

function parseAgentDefinition(
  resource: ClaudeTextResource,
): ClaudeAgentRuntimeDefinition {
  const definition = parseDefinition('agent', resource)
  const { metadata } = parseFrontmatter(resource)
  const parsedTools = parseAgentList(metadata.tools)
  const tools = parsedTools?.includes('*') ? undefined : parsedTools
  const disallowedTools = parseAgentList(metadata.disallowedTools)
  const skills = parseAgentList(metadata.skills)
  const model =
    typeof metadata.model === 'string' && metadata.model.trim()
      ? metadata.model.trim().toLowerCase() === 'inherit'
        ? 'inherit'
        : metadata.model.trim()
      : undefined
  const effort = parseAgentEffort(metadata.effort)
  const permissionMode = [
    'acceptEdits',
    'auto',
    'bypassPermissions',
    'default',
    'dontAsk',
    'plan',
  ].includes(String(metadata.permissionMode))
    ? (metadata.permissionMode as ClaudeAgentPermissionMode)
    : undefined
  const maxTurns = parsePositiveInteger(metadata.maxTurns)
  const initialPrompt =
    typeof metadata.initialPrompt === 'string' && metadata.initialPrompt.trim()
      ? metadata.initialPrompt
      : undefined
  const memory = ['user', 'project', 'local'].includes(String(metadata.memory))
    ? (metadata.memory as ClaudeAgentRuntimeDefinition['memory'])
    : undefined
  const background =
    metadata.background === true || metadata.background === 'true'
      ? true
      : undefined
  const isolation =
    metadata.isolation === 'worktree' ? ('worktree' as const) : undefined
  const mcpServers =
    Array.isArray(metadata.mcpServers) && metadata.mcpServers.length > 0
      ? [...metadata.mcpServers]
      : undefined
  const hooks =
    typeof metadata.hooks === 'object' &&
    metadata.hooks !== null &&
    !Array.isArray(metadata.hooks) &&
    Object.keys(metadata.hooks).length > 0
      ? { ...(metadata.hooks as Record<string, unknown>) }
      : undefined
  return {
    ...definition,
    kind: 'agent',
    ...(tools === undefined ? {} : { tools }),
    ...(disallowedTools === undefined ? {} : { disallowedTools }),
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
    ...(permissionMode === undefined ? {} : { permissionMode }),
    ...(maxTurns === undefined ? {} : { maxTurns }),
    ...(skills?.length ? { skills } : {}),
    ...(initialPrompt === undefined ? {} : { initialPrompt }),
    ...(memory === undefined ? {} : { memory }),
    ...(background === undefined ? {} : { background }),
    ...(isolation === undefined ? {} : { isolation }),
    ...(mcpServers === undefined ? {} : { mcpServers }),
    ...(hooks === undefined ? {} : { hooks }),
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
  const allowedTools = metadata['allowed-tools']
  const hasAllowedTools = Array.isArray(allowedTools)
    ? allowedTools.length > 0
    : typeof allowedTools === 'string' && allowedTools.trim().length > 0
  const hooks = metadata.hooks
  const hasHooks =
    hooks !== undefined &&
    hooks !== null &&
    (typeof hooks !== 'object' || Object.keys(hooks).length > 0)
  return {
    ...resource,
    kind,
    name,
    description,
    body,
    modelInvocable: metadata['disable-model-invocation'] !== true,
    permissionSafe: !hasAllowedTools && !hasHooks,
  }
}

function indexed(
  kind: Exclude<ClaudeExtensionKind, 'agent'>,
  resources: readonly ClaudeTextResource[],
): Map<string, ClaudeExtensionDefinition> {
  const definitions = new Map<string, ClaudeExtensionDefinition>()
  for (const resource of resources) {
    const definition = parseDefinition(kind, resource)
    definitions.set(definition.name, definition)
  }
  return definitions
}

function indexedAgents(
  resources: readonly ClaudeTextResource[],
): Map<string, ClaudeAgentRuntimeDefinition> {
  const definitions = new Map<string, ClaudeAgentRuntimeDefinition>()
  for (const resource of resources) {
    const definition = parseAgentDefinition(resource)
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
  private readonly agents: Map<string, ClaudeAgentRuntimeDefinition>
  private readonly disableSlashCommands: boolean
  private mcpPrompts = new Map<string, ClaudeMcpPromptDefinition>()

  constructor(
    resources: Pick<ClaudeSharedResources, 'agents' | 'commands' | 'skills'>,
    options: { disableSlashCommands?: boolean; dataPlane?: DataPlane } = {},
  ) {
    const dataPlane = options.dataPlane ?? 'claude'
    const statuslineCommand =
      dataPlane === 'native'
        ? NATIVE_BUILTIN_STATUSLINE_COMMAND
        : BUILTIN_STATUSLINE_COMMAND
    const statuslineAgent =
      dataPlane === 'native'
        ? NATIVE_BUILTIN_STATUSLINE_AGENT
        : BUILTIN_STATUSLINE_AGENT
    this.disableSlashCommands = options.disableSlashCommands === true
    this.commands = options.disableSlashCommands
      ? new Map()
      : new Map([
          ['loop', BUILTIN_LOOP],
          ['init', builtinInitCommand(dataPlane)],
          ['statusline', statuslineCommand],
        ])
    if (!options.disableSlashCommands) {
      for (const [name, command] of indexed('command', resources.commands)) {
        this.commands.set(name, command)
      }
    }
    this.skills = options.disableSlashCommands
      ? new Map()
      : indexed('skill', resources.skills)
    this.agents = new Map([
      ['statusline-setup', statuslineAgent],
      ...indexedAgents(resources.agents),
    ])
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
    const invocationArguments =
      definition.builtin === true &&
      definition.name === 'statusline' &&
      argumentsText.length === 0
        ? 'Configure my statusLine from my shell PS1 configuration'
        : argumentsText
    return {
      userMessages: [
        [
          `<command-message>${name}</command-message>`,
          `<command-name>/${name}</command-name>`,
          ...(argumentsText
            ? [`<command-args>${argumentsText}</command-args>`]
            : []),
        ].join('\n'),
        renderInvocation(definition, invocationArguments),
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
          ...(definition.progressMessage === undefined
            ? {}
            : { progressMessage: definition.progressMessage }),
          ...(definition.builtin === true ? { builtin: true } : {}),
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

  agent(name: string): ClaudeAgentRuntimeDefinition | null {
    return this.agents.get(name) ?? null
  }

  agentNames(): readonly string[] {
    return [...this.agents.keys()]
  }

  agentDefinitions(): readonly ClaudeAgentDefinition[] {
    const definitions = new Map<string, ClaudeAgentDefinition>([
      [GENERAL_PURPOSE_AGENT.name, GENERAL_PURPOSE_AGENT],
    ])
    for (const agent of this.agents.values()) {
      definitions.set(agent.name, {
        name: agent.name,
        description: agent.description,
      })
    }
    return [...definitions.values()].sort((left, right) =>
      left.name.localeCompare(right.name),
    )
  }

  agentMentionMessages(prompt: string): readonly string[] {
    const definitions = this.agentDefinitions()
    const available = new Set(definitions.map((definition) => definition.name))
    const mentioned = [...prompt.matchAll(/@"([^"\r\n]+) \(agent\)"/gu)]
      .map((match) => match[1])
      .filter(
        (name): name is string => name !== undefined && available.has(name),
      )
      .filter((name, index, names) => names.indexOf(name) === index)
    if (mentioned.length === 0) return []
    return [
      ...mentioned.map(
        (name) =>
          `<system-reminder>\nThe user has expressed a desire to invoke the agent "${name}". Please invoke the agent appropriately, passing in the required context to it.\n</system-reminder>`,
      ),
      `<system-reminder>\nAvailable agent types for the Agent tool:\n${definitions
        .map((definition) =>
          `- ${definition.name}: ${definition.description}`.trimEnd(),
        )
        .join('\n')}\n</system-reminder>`,
    ]
  }

  renderSkill(name: string, argumentsText: string): string | null {
    const definition = this.skill(name)
    return definition ? renderInvocation(definition, argumentsText) : null
  }
}
