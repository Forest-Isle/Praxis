import type { ModelToolDefinition } from '../core/runtime.js'
import type {
  ModelToolCall,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolRegistry,
} from '../core/runtime.js'
import { resolveToolSchedulingPolicy } from '../core/tool-scheduling-policy.js'

/**
 * Capability-driven Claude tool exposure.
 *
 * The advertised/allowed set of capability-gated tools is derived from the
 * runtime role and explicit gates rather than from a Claude version or a fixed
 * global list. Base tools (Bash, Read, Edit, ...) are never part of this
 * resolver; callers keep them and apply the resolved set only to the
 * capability-gated tools they actually expose.
 */

export type ClaudeToolRole = 'main' | 'worker' | 'coordinator'

/**
 * Immutable capability input. `interactive`/`simpleMode` describe the runtime
 * mode; the gate booleans are explicit when present and otherwise fall back to
 * the documented environment overrides, then to the default rules. Explicit
 * booleans always override the environment.
 */
export interface ClaudeToolCapabilityInput {
  readonly role: ClaudeToolRole
  readonly interactive: boolean
  readonly simpleMode: boolean
  readonly tasks?: boolean
  readonly workflowScripts?: boolean
  readonly agentTriggers?: boolean
  readonly backgroundAgents?: boolean
  readonly subagents?: boolean
  readonly teams?: boolean
  /** Explicit allow-list for capability-gated tools; never enables a gate. */
  readonly tools?: readonly string[]
  /** Always wins over the allow-list and the default rules. */
  readonly disallowedTools?: readonly string[]
  readonly env?: Readonly<Record<string, string | undefined>>
}

/** Stable environment names. Explicit input booleans override these. */
export const CLAUDE_CODE_ENABLE_TASKS = 'CLAUDE_CODE_ENABLE_TASKS'
export const CLAUDE_CODE_DISABLE_CRON = 'CLAUDE_CODE_DISABLE_CRON'
export const PRAXIS_ENABLE_WORKFLOW_SCRIPTS = 'PRAXIS_ENABLE_WORKFLOW_SCRIPTS'
export const PRAXIS_ENABLE_TEAMS = 'PRAXIS_ENABLE_TEAMS'

/** task-v2 task-board tools, gated by the `tasks` capability. */
export const CLAUDE_TASK_V2_TOOLS = [
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskUpdate',
] as const

/** Workflow tool, gated by the `workflowScripts` capability. */
export const CLAUDE_WORKFLOW_TOOLS = ['Workflow'] as const

/** Cron and wakeup tools, gated by the `agentTriggers` capability. */
export const CLAUDE_AGENT_TRIGGER_TOOLS = [
  'CronCreate',
  'CronDelete',
  'CronList',
  'ScheduleWakeup',
] as const

/** Agent tool, gated by the `subagents` capability. */
export const CLAUDE_AGENT_TOOLS = ['Agent'] as const

/** Background task lifecycle tools, gated by the `backgroundAgents` capability. */
export const CLAUDE_BACKGROUND_TOOLS = ['TaskOutput', 'TaskStop'] as const

/** Experimental local Team lifecycle names, gated by `PRAXIS_ENABLE_TEAMS`. */
export const PRAXIS_TEAM_TOOLS = Object.freeze([
  'TeamCreate',
  'TeamResume',
  'TeamList',
  'TeamAccept',
  'TeamStop',
] as const)

/** Coordination tools advertised by a coordinator only when explicitly enabled. */
export const CLAUDE_COORDINATION_TOOLS = [
  'AskUserQuestion',
  'SendMessage',
  'SendUserMessage',
  'Monitor',
  'PushNotification',
] as const

/** Recursively suppressed for worker agents regardless of any allow-list. */
export const CLAUDE_WORKER_RECURSIVE_TOOLS = [
  'Agent',
  'TaskOutput',
  'TaskStop',
] as const

export const CLAUDE_CAPABILITY_GATED_TOOLS: ReadonlySet<string> = new Set([
  ...CLAUDE_TASK_V2_TOOLS,
  ...CLAUDE_WORKFLOW_TOOLS,
  ...CLAUDE_AGENT_TRIGGER_TOOLS,
  ...CLAUDE_AGENT_TOOLS,
  ...CLAUDE_BACKGROUND_TOOLS,
  ...PRAXIS_TEAM_TOOLS,
  ...CLAUDE_COORDINATION_TOOLS,
])

const EMPTY_ENV: Readonly<Record<string, string | undefined>> = {}

const ENV_TRUE = /^(?:1|true|yes|on)$/iu
const ENV_FALSE = /^(?:0|false|no|off|)$/iu

function envBoolean(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): boolean | undefined {
  const value = env[name]
  if (value === undefined) return undefined
  if (ENV_TRUE.test(value)) return true
  if (ENV_FALSE.test(value)) return false
  return undefined
}

function validateNames(names: readonly string[], flag: string): void {
  for (const name of names) {
    if (!CLAUDE_CAPABILITY_GATED_TOOLS.has(name)) {
      throw new Error(`Unknown capability tool in ${flag}: ${name}`)
    }
  }
}

/**
 * Resolve the deterministic set of capability-gated tool names enabled for the
 * given role, gates, allow-list, and disallow-list. Tools outside this set that
 * are not capability-gated are unaffected by the resolver.
 */
export function resolveClaudeToolCapabilities(
  input: ClaudeToolCapabilityInput,
): ReadonlySet<string> {
  const env = input.env ?? EMPTY_ENV
  const tasks =
    input.tasks ??
    envBoolean(env, CLAUDE_CODE_ENABLE_TASKS) ??
    (input.interactive && !input.simpleMode)
  const workflowScripts =
    input.workflowScripts ??
    envBoolean(env, PRAXIS_ENABLE_WORKFLOW_SCRIPTS) ??
    false
  let agentTriggers = input.agentTriggers
  if (agentTriggers === undefined) {
    const disableCron = envBoolean(env, CLAUDE_CODE_DISABLE_CRON)
    agentTriggers = disableCron === undefined ? false : !disableCron
  }
  // The local kill switch takes priority over the internal agentTriggers
  // capability input: a truthy CLAUDE_CODE_DISABLE_CRON suppresses the cron
  // tools even when selected scheduled names would otherwise enable them.
  if (envBoolean(env, CLAUDE_CODE_DISABLE_CRON) === true) {
    agentTriggers = false
  }
  const backgroundAgents = input.backgroundAgents ?? false
  const subagents = input.subagents ?? false
  const teams = input.teams ?? envBoolean(env, PRAXIS_ENABLE_TEAMS) ?? false

  if (input.tools) validateNames(input.tools, '--tools')
  if (input.disallowedTools)
    validateNames(input.disallowedTools, '--disallowedTools')

  // Simple mode is an absolute suppressor for every capability-gated tool,
  // regardless of role, explicit gates, environment overrides, or allow-list.
  if (input.simpleMode) {
    return new Set<string>()
  }

  const enabled = new Set<string>(CLAUDE_COORDINATION_TOOLS)
  if (tasks) {
    for (const name of CLAUDE_TASK_V2_TOOLS) enabled.add(name)
  }
  if (workflowScripts) {
    for (const name of CLAUDE_WORKFLOW_TOOLS) enabled.add(name)
  }
  if (agentTriggers) {
    for (const name of CLAUDE_AGENT_TRIGGER_TOOLS) enabled.add(name)
  }
  if (subagents) {
    for (const name of CLAUDE_AGENT_TOOLS) enabled.add(name)
  }
  if (backgroundAgents) {
    for (const name of CLAUDE_BACKGROUND_TOOLS) enabled.add(name)
  }
  if (teams) {
    for (const name of PRAXIS_TEAM_TOOLS) enabled.add(name)
  }

  if (input.role === 'worker') {
    for (const name of [...CLAUDE_WORKER_RECURSIVE_TOOLS, ...PRAXIS_TEAM_TOOLS])
      enabled.delete(name)
  } else if (input.role === 'coordinator') {
    const explicit = new Set(input.tools ?? [])
    for (const name of [...CLAUDE_COORDINATION_TOOLS, ...PRAXIS_TEAM_TOOLS]) {
      if (!explicit.has(name)) enabled.delete(name)
    }
  }

  if (input.tools) {
    const allowList = new Set(input.tools)
    for (const name of [...enabled]) {
      if (!allowList.has(name)) enabled.delete(name)
    }
  }
  for (const name of input.disallowedTools ?? []) enabled.delete(name)

  return enabled
}

/** Whether a single tool name is enabled under the given capability input. */
export function isClaudeToolEnabled(
  input: ClaudeToolCapabilityInput,
  name: string,
): boolean {
  return resolveClaudeToolCapabilities(input).has(name)
}

/** Whether the tool name participates in capability gating. */
export function isClaudeCapabilityGated(name: string): boolean {
  return CLAUDE_CAPABILITY_GATED_TOOLS.has(name)
}

/** Keep only capability-gated definitions the resolved capabilities include. */
export function filterClaudeToolDefinitions(
  definitions: readonly ModelToolDefinition[],
  capabilities: ReadonlySet<string>,
): readonly ModelToolDefinition[] {
  return definitions.filter(
    (definition) =>
      !CLAUDE_CAPABILITY_GATED_TOOLS.has(definition.name) ||
      capabilities.has(definition.name),
  )
}

/**
 * Applies the capability set at both advertisement and invocation boundaries.
 * This keeps a caller from executing a capability-gated tool that was omitted
 * from the model-facing tool list.
 */
export class ClaudeCapabilityToolRegistry implements ToolRegistry {
  constructor(
    private readonly base: ToolRegistry,
    private readonly capabilities: ReadonlySet<string>,
  ) {}

  definitions(): readonly ModelToolDefinition[] {
    return filterClaudeToolDefinitions(
      this.base.definitions(),
      this.capabilities,
    )
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
    if (isClaudeCapabilityGated(name) && !this.capabilities.has(name)) {
      throw new Error(`Tool ${name} is unavailable in this runtime`)
    }
  }
}
