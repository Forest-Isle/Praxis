import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { RuntimeEvent } from '../core/runtime.js'
import type { DataPlane } from '../persistence/data-plane.js'
import {
  BoundedProcessRunner,
  joinedProcessOutput,
} from '../platform/bounded-process-runner.js'
import type { ClaudePluginEvalCase } from './claude-plugin-eval-schema.js'
import { resolveContainedPath } from './claude-plugin-eval-schema.js'
import type {
  EvalRunArtifacts,
  EvalTraceEvent,
} from './claude-plugin-eval-graders.js'

export const DEFAULT_EVAL_ALLOWED_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'Skill',
] as const

export interface PluginEvalRuntime {
  run(
    prompt: string,
    signal: AbortSignal,
  ): Promise<{ text: string; turns: number; costUsd?: number }>
  close?(): Promise<void>
}
export interface PluginEvalRuntimeFactory {
  create(options: {
    dataPlane: DataPlane
    cwd: string
    configRoot: string
    home: string
    model?: string
    maxTurns: number
    pluginDirectories: readonly string[]
    allowedTools: readonly string[]
    appendSystemPrompt?: string
    historyFile?: string
    addDirs: readonly string[]
    env: Readonly<Record<string, string>>
    eventSink(event: RuntimeEvent): void
  }): Promise<PluginEvalRuntime>
}

export interface EvalSingleRunResult {
  text: string
  turns: number
  costUsd: number
  costKnown: boolean
  artifacts: EvalRunArtifacts
  tracePath: string
  error: string | null
  termination: 'timeout' | 'interrupted' | null
  tempRoot?: string
}

function abortError(): DOMException {
  return new DOMException('Eval run timed out', 'AbortError')
}

function toolName(rule: string): string {
  const separator = rule.indexOf('(')
  return separator < 0 ? rule : rule.slice(0, separator)
}

function gatedTool(rule: string): boolean {
  const name = toolName(rule)
  return (
    ['Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch'].includes(
      name,
    ) || name.startsWith('mcp__')
  )
}

function operatorGrants(requested: string, grants: readonly string[]): boolean {
  const name = toolName(requested)
  const wildcardMatch = (pattern: string): boolean => {
    const parts = pattern.split('*')
    if (parts.length === 1) return false
    if (!requested.startsWith(parts[0] ?? '')) return false
    let cursor = parts[0]?.length ?? 0
    for (const part of parts.slice(1, -1)) {
      const index = requested.indexOf(part, cursor)
      if (index < 0) return false
      cursor = index + part.length
    }
    const last = parts.at(-1) ?? ''
    return last.length === 0 || requested.slice(cursor).endsWith(last)
  }
  return grants.some(
    (grant) => grant === requested || grant === name || wildcardMatch(grant),
  )
}

export function resolveEvalAllowedTools(
  requested: readonly string[],
  grants: readonly string[],
): string[] {
  const selected = requested.length ? requested : DEFAULT_EVAL_ALLOWED_TOOLS
  for (const rule of selected)
    if (gatedTool(rule) && !operatorGrants(rule, grants))
      throw new Error(
        `Eval case requests gated tool ${rule}; grant it with --allow-tools`,
      )
  return [...new Set(selected)]
}

async function scaffold(
  caseDef: ClaudePluginEvalCase,
  cwd: string,
  home: string,
  signal: AbortSignal,
): Promise<void> {
  if (!caseDef.context.scaffoldScript) return
  const script = await resolveContainedPath(
    caseDef.dir,
    caseDef.context.scaffoldScript,
    'Scaffold script',
  )
  const result = await new BoundedProcessRunner({
    cwd,
    maxOutputBytes: 16 * 1024,
  }).run({
    command: '/bin/bash',
    args: [script],
    timeoutMs: caseDef.execution.timeoutSeconds * 1000,
    signal,
    env: {
      ...caseDef.execution.env,
      HOME: home,
      USERPROFILE: home,
    },
  })
  if (result.timedOut) throw new Error('Scaffold timed out')
  if (result.code !== 0)
    throw new Error(
      `Scaffold failed (${result.code}): ${joinedProcessOutput(result)}`,
    )
}

function traceEvent(event: RuntimeEvent): EvalTraceEvent {
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

export async function runClaudePluginEvalOnce(options: {
  case: ClaudePluginEvalCase
  factory: PluginEvalRuntimeFactory
  pluginDirectories: readonly string[]
  model?: string
  allowTools?: readonly string[]
  scaffold: boolean
  signal?: AbortSignal
  dataPlane?: DataPlane
}): Promise<EvalSingleRunResult> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'praxis-eval-'))
  const cwd = join(tempRoot, 'cwd')
  const configRoot = join(tempRoot, 'config')
  const home = join(tempRoot, 'home')
  const out = join(tempRoot, 'out')
  try {
    await Promise.all([mkdir(cwd), mkdir(configRoot), mkdir(home), mkdir(out)])
  } catch (error) {
    await rm(tempRoot, { recursive: true, force: true })
    throw error
  }
  const trace: EvalTraceEvent[] = []
  const tracePath = join(out, 'trace.jsonl')
  const controller = new AbortController()
  const forwardAbort = () => controller.abort(options.signal?.reason)
  options.signal?.addEventListener('abort', forwardAbort, { once: true })
  if (options.signal?.aborted) forwardAbort()
  const timer = setTimeout(
    () => controller.abort(abortError()),
    options.case.execution.timeoutSeconds * 1000,
  )
  let runtime: PluginEvalRuntime | undefined
  let text = ''
  let turns = 0
  let costUsd = 0
  let costKnown = false
  let error: string | null = null
  let termination: EvalSingleRunResult['termination'] = null
  try {
    if (options.scaffold)
      await scaffold(options.case, cwd, home, controller.signal)
    const addDirs = await Promise.all(
      options.case.context.addDirs.map((path) =>
        resolveContainedPath(options.case.dir, path, 'Add directory'),
      ),
    )
    const historyFile = options.case.context.historyFile
      ? await resolveContainedPath(
          options.case.dir,
          options.case.context.historyFile,
          'History file',
        )
      : undefined
    runtime = await options.factory.create({
      dataPlane: options.dataPlane ?? 'native',
      cwd,
      configRoot,
      home,
      ...((options.model ?? options.case.execution.model)
        ? { model: options.model ?? options.case.execution.model }
        : {}),
      maxTurns: options.case.execution.maxTurns,
      pluginDirectories: options.pluginDirectories,
      allowedTools: resolveEvalAllowedTools(
        options.case.execution.allowedTools,
        options.allowTools ?? [],
      ),
      ...(options.case.execution.appendSystemPrompt
        ? { appendSystemPrompt: options.case.execution.appendSystemPrompt }
        : {}),
      ...(historyFile ? { historyFile } : {}),
      addDirs,
      env: options.case.execution.env,
      eventSink: (event) => trace.push(traceEvent(event)),
    })
    const result = await runtime.run(
      options.case.execution.prompt ?? '',
      controller.signal,
    )
    text = result.text
    turns = result.turns
    costKnown = result.costUsd !== undefined
    costUsd = result.costUsd ?? 0
  } catch (caught) {
    if (options.signal?.aborted) {
      termination = 'interrupted'
      error = 'Eval run interrupted'
    } else if (controller.signal.aborted) {
      termination = 'timeout'
      error = 'Eval run timed out'
    } else error = caught instanceof Error ? caught.message : String(caught)
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', forwardAbort)
    try {
      await runtime?.close?.()
    } catch (caught) {
      error ??= `Runtime cleanup failed: ${
        caught instanceof Error ? caught.message : String(caught)
      }`
    }
    try {
      await writeFile(
        tracePath,
        trace.map((item) => JSON.stringify(item)).join('\n'),
      )
    } catch (caught) {
      error ??= `Trace write failed: ${
        caught instanceof Error ? caught.message : String(caught)
      }`
    }
  }
  return {
    text,
    turns,
    costUsd,
    costKnown,
    artifacts: { lastMessage: text, trace, cwd },
    tracePath,
    error,
    termination,
    tempRoot,
  }
}
