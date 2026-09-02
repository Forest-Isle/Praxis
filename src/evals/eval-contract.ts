import type { ModelUsage, RuntimeEvent } from '../core/runtime.js'
import type { DataPlane } from '../persistence/data-plane.js'

export interface EvalRuntime {
  run(
    prompt: string,
    signal: AbortSignal,
  ): Promise<{
    text: string
    turns: number
    costUsd?: number
    usage?: ModelUsage
  }>
  close?(): Promise<void>
}

export interface EvalRuntimeFactoryOptions {
  dataPlane: DataPlane
  cwd: string
  configRoot: string
  home: string
  model?: string
  maxTurns: number
  pluginDirectories?: readonly string[]
  allowedTools: readonly string[]
  appendSystemPrompt?: string
  historyFile?: string
  addDirs: readonly string[]
  env: Readonly<Record<string, string>>
  eventSink(event: RuntimeEvent): void
}
export interface EvalRuntimeFactory {
  create(options: EvalRuntimeFactoryOptions): Promise<EvalRuntime>
}

export interface EvalTraceEvent {
  type: string
  tool?: string
  input?: Record<string, unknown>
  [key: string]: unknown
}

export type EvalFocus =
  'last_message' | 'trace' | 'files' | { source: 'file'; path: string }
export type EvalArm = 'with-only' | 'both'
export type EvalToolMatch =
  string | { tool: string; input_match?: Record<string, unknown> }

export interface EvalGrader {
  name: string
  weight: number
  arm?: EvalArm
}
export type EvalGraderBase = EvalGrader

export type EvalDeterministicGrader =
  | (EvalGrader & {
      type: 'regex'
      target: EvalFocus
      pattern: string
      flags: string
      match: 'contains' | 'not_contains' | `count:${number}`
    })
  | (EvalGrader & {
      type: 'tool_order'
      before: EvalToolMatch
      after: EvalToolMatch
    })
  | (EvalGrader & {
      type: 'tool_used'
      tool: string
      input_match?: Record<string, unknown>
      min: number
      max: number
    })
  | (EvalGrader & {
      type: 'file_exists'
      path: string
      exists: boolean
    })

export interface EvalRunArtifacts {
  lastMessage: string
  trace: readonly EvalTraceEvent[]
  cwd: string
}
export interface EvalGraderResult {
  name: string
  passed: boolean
  weight: number
  explanation: string
  judge_votes?: readonly boolean[]
  evidence?: string
  with_only?: boolean
}
export interface EvalJudge {
  vote(request: {
    criteria: string
    focus: string
    baseline?: string
    model: string
    signal?: AbortSignal
  }): Promise<{ passed: boolean; explanation?: string; costUsd: number }>
}

export const DEFAULT_EVAL_ALLOWED_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'Skill',
] as const
function toolName(rule: string): string {
  const i = rule.indexOf('(')
  return i < 0 ? rule : rule.slice(0, i)
}
function gatedTool(rule: string): boolean {
  const name = toolName(rule)
  return (
    [
      'Bash',
      'Write',
      'Edit',
      'ApplyPatch',
      'NotebookEdit',
      'WebFetch',
      'WebSearch',
    ].includes(name) || name.startsWith('mcp__')
  )
}
function grants(requested: string, allowed: readonly string[]): boolean {
  const name = toolName(requested)
  const wildcard = (pattern: string): boolean => {
    const parts = pattern.split('*')
    if (parts.length === 1 || !requested.startsWith(parts[0] ?? ''))
      return false
    let cursor = parts[0]?.length ?? 0
    for (const part of parts.slice(1, -1)) {
      const index = requested.indexOf(part, cursor)
      if (index < 0) return false
      cursor = index + part.length
    }
    const last = parts.at(-1) ?? ''
    return last.length === 0 || requested.slice(cursor).endsWith(last)
  }
  return allowed.some(
    (grant) => grant === requested || grant === name || wildcard(grant),
  )
}
export function resolveEvalAllowedTools(
  requested: readonly string[],
  operatorGrants: readonly string[],
): string[] {
  const selected = requested.length ? requested : DEFAULT_EVAL_ALLOWED_TOOLS
  for (const rule of selected)
    if (gatedTool(rule) && !grants(rule, operatorGrants))
      throw new Error(
        `Eval case requests gated tool ${rule}; grant it with --allow-tools`,
      )
  return [...new Set(selected)]
}

export function normalizeEvalTraceEvent(event: RuntimeEvent): EvalTraceEvent {
  if (event.type === 'tool-call')
    return {
      type: 'tool-call',
      tool: event.call.name,
      input: event.call.input,
      id: event.call.id,
    }
  if (event.type === 'tool-result')
    return {
      type: 'tool-result',
      callId: event.callId,
      content: event.content,
      isError: event.isError,
    }
  return event as unknown as EvalTraceEvent
}
