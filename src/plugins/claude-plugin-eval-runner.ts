import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { RuntimeEvent } from '../core/runtime.js'
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
  'NotebookRead',
  'Skill',
  'AskUserQuestion',
  'Task',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskUpdate',
  'TaskStop',
  'TaskOutput',
  'Agent',
  'TodoWrite',
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
  artifacts: EvalRunArtifacts
  tracePath: string
  error: string | null
  tempRoot?: string
}

function abortError(): DOMException {
  return new DOMException('Eval run timed out', 'AbortError')
}

async function scaffold(
  caseDef: ClaudePluginEvalCase,
  cwd: string,
  signal: AbortSignal,
): Promise<void> {
  if (!caseDef.context.scaffoldScript) return
  const script = await resolveContainedPath(
    caseDef.dir,
    caseDef.context.scaffoldScript,
    'Scaffold script',
  )
  await new Promise<void>((resolve, reject) => {
    const child = spawn('/bin/bash', [script], {
      cwd,
      detached: process.platform !== 'win32',
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        ...caseDef.execution.env,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      if (Buffer.byteLength(stderr) < 16 * 1024)
        stderr += chunk
          .toString('utf8')
          .slice(0, 16 * 1024 - Buffer.byteLength(stderr))
    })
    const kill = () => {
      if (child.pid) {
        try {
          if (process.platform === 'win32') child.kill('SIGKILL')
          else process.kill(-child.pid, 'SIGKILL')
        } catch {
          // Process may have exited between pid check and signal delivery.
        }
      }
    }
    signal.addEventListener('abort', kill, { once: true })
    const timer = setTimeout(kill, 120_000)
    child.once('error', reject)
    child.once('close', (code) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', kill)
      if (code === 0) resolve()
      else reject(new Error(`Scaffold failed (${String(code)}): ${stderr}`))
    })
  })
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
  keepTemp: boolean
  signal?: AbortSignal
}): Promise<EvalSingleRunResult> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'praxis-eval-'))
  const cwd = join(tempRoot, 'cwd')
  const configRoot = join(tempRoot, 'config')
  const home = join(tempRoot, 'home')
  const out = join(tempRoot, 'out')
  await Promise.all([mkdir(cwd), mkdir(configRoot), mkdir(home), mkdir(out)])
  const trace: EvalTraceEvent[] = []
  const tracePath = join(out, 'trace.jsonl')
  const controller = new AbortController()
  const forwardAbort = () => controller.abort(options.signal?.reason)
  options.signal?.addEventListener('abort', forwardAbort, { once: true })
  const timer = setTimeout(
    () => controller.abort(abortError()),
    options.case.execution.timeoutSeconds * 1000,
  )
  let runtime: PluginEvalRuntime | undefined
  let text = ''
  let turns = 0
  let costUsd = 0
  let error: string | null = null
  try {
    if (options.scaffold) await scaffold(options.case, cwd, controller.signal)
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
      cwd,
      configRoot,
      home,
      ...((options.model ?? options.case.execution.model)
        ? { model: options.model ?? options.case.execution.model }
        : {}),
      maxTurns: options.case.execution.maxTurns,
      pluginDirectories: options.pluginDirectories,
      allowedTools: [
        ...new Set([
          ...DEFAULT_EVAL_ALLOWED_TOOLS,
          ...options.case.execution.allowedTools,
          ...(options.allowTools ?? []),
        ]),
      ],
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
    costUsd = result.costUsd ?? 0
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught)
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', forwardAbort)
    try {
      await runtime?.close?.()
    } catch {
      // Cleanup errors do not replace primary run result.
    }
    await writeFile(
      tracePath,
      trace.map((item) => JSON.stringify(item)).join('\n'),
    )
  }
  return {
    text,
    turns,
    costUsd,
    artifacts: { lastMessage: text, trace, cwd },
    tracePath,
    error,
    tempRoot,
  }
}
