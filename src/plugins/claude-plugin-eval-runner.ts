import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { DataPlane } from '../persistence/data-plane.js'
import {
  BoundedProcessRunner,
  joinedProcessOutput,
} from '../platform/bounded-process-runner.js'
import type { ClaudePluginEvalCase } from './claude-plugin-eval-schema.js'
import { resolveContainedPath } from './claude-plugin-eval-schema.js'
import {
  normalizeEvalTraceEvent,
  resolveEvalAllowedTools,
} from '../evals/eval-contract.js'
import type {
  EvalRunArtifacts,
  EvalTraceEvent,
  EvalRuntime,
  EvalRuntimeFactory,
} from '../evals/eval-contract.js'
export {
  DEFAULT_EVAL_ALLOWED_TOOLS,
  resolveEvalAllowedTools,
} from '../evals/eval-contract.js'
export type PluginEvalRuntime = EvalRuntime
export type PluginEvalRuntimeFactory = EvalRuntimeFactory

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

const traceEvent = normalizeEvalTraceEvent

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
