import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { sanitizeProjectPath } from '../platform/project-path-key.js'
import type { RuntimeEventSink } from '../core/runtime.js'
import { writeFileAtomically } from '../platform/atomic-write.js'
import {
  BoundedProcessRunner,
  type ProcessResult,
} from '../platform/bounded-process-runner.js'
import {
  commandShell,
  commandShellArguments,
} from '../platform/command-shell.js'
import {
  assertBackgroundBashTaskId,
  backgroundBashTaskIdFromStateFile,
  createBackgroundBashTaskId,
} from './background-task-id.js'

export type BackgroundBashStatus =
  'running' | 'completed' | 'failed' | 'stopped'

interface BackgroundBashTask {
  taskId: string
  command: string
  description: string
  toolUseId: string
  outputFile: string
  status: BackgroundBashStatus
  output: string
  exitCode: number | null
  notified: boolean
  controller: AbortController
  completion: Promise<void>
  startedAt: number
  durationMs: number | null
  parentSignal?: AbortSignal
  parentAbort?: () => void
}

interface PersistedBackgroundBashTask {
  version: 1
  taskId: string
  command: string
  description: string
  toolUseId: string
  outputFile: string
  status: Exclude<BackgroundBashStatus, 'running'>
  output: string
  exitCode: number | null
  notified: boolean
  startedAt?: number
  durationMs?: number
}

export interface BackgroundBashSnapshot {
  taskId: string
  status: BackgroundBashStatus
  command: string
  description: string
  outputFile: string
  output: string
  exitCode: number | null
  startedAt: number
  durationMs: number | null
}

export interface BackgroundBashManagerOptions {
  cwd: string
  cwdProvider?: () => string
  sessionId: string
  stateRoot: string
  maxOutputBytes?: number
  eventSink?: RuntimeEventSink
}

export interface BackgroundBashLaunchInput {
  command: string
  description: string
  toolUseId: string
  timeout: number
  signal?: AbortSignal
}

export interface BackgroundBashToolResult {
  content: string
  nativeToolUseResult: Record<string, unknown> & {
    task?: Record<string, unknown>
  }
}

export function nativeBackgroundTaskParent(cwd: string): string {
  const uid = process.getuid?.() ?? 'unknown'
  return resolve('/tmp', `praxis-${uid}`, sanitizeProjectPath(resolve(cwd)))
}

export function nativeBackgroundTaskRoot(
  cwd: string,
  sessionId: string,
): string {
  return resolve(nativeBackgroundTaskParent(cwd), sessionId, 'tasks')
}

function parsePersistedTask(
  source: string,
  taskId: string,
  outputFile: string,
): PersistedBackgroundBashTask | null {
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const task = value as Record<string, unknown>
  if (
    task.version !== 1 ||
    task.taskId !== taskId ||
    typeof task.command !== 'string' ||
    typeof task.description !== 'string' ||
    typeof task.toolUseId !== 'string' ||
    task.outputFile !== outputFile ||
    !['completed', 'failed', 'stopped'].includes(String(task.status)) ||
    typeof task.output !== 'string' ||
    (task.exitCode !== null && !Number.isSafeInteger(task.exitCode)) ||
    typeof task.notified !== 'boolean' ||
    (task.startedAt !== undefined &&
      (typeof task.startedAt !== 'number' ||
        !Number.isSafeInteger(task.startedAt) ||
        task.startedAt < 0)) ||
    (task.durationMs !== undefined &&
      (typeof task.durationMs !== 'number' ||
        !Number.isSafeInteger(task.durationMs) ||
        task.durationMs < 0))
  ) {
    return null
  }
  return task as unknown as PersistedBackgroundBashTask
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

export class BackgroundBashManager {
  private readonly tasks = new Map<string, BackgroundBashTask>()
  private readonly runner: BoundedProcessRunner
  private readonly outputRoot: string
  private readonly sessionStateRoot: string

  constructor(private readonly options: BackgroundBashManagerOptions) {
    this.runner = new BoundedProcessRunner({
      cwd: options.cwd,
      maxOutputBytes: options.maxOutputBytes ?? 128 * 1024,
    })
    this.outputRoot = nativeBackgroundTaskRoot(options.cwd, options.sessionId)
    this.sessionStateRoot = resolve(options.stateRoot, options.sessionId)
  }

  has(taskId: string): boolean {
    return this.tasks.has(taskId)
  }

  async snapshots(): Promise<readonly BackgroundBashSnapshot[]> {
    await this.hydratePersistedTasks()
    return [...this.tasks.values()]
      .sort((left, right) => right.startedAt - left.startedAt)
      .map((task) => this.snapshot(task))
  }

  async launch(input: BackgroundBashLaunchInput): Promise<{
    taskId: string
    outputFile: string
    content: string
    nativeToolUseResult: Record<string, unknown>
  }> {
    await Promise.all([
      mkdir(this.outputRoot, { recursive: true }),
      mkdir(this.sessionStateRoot, { recursive: true }),
    ])
    let id = createBackgroundBashTaskId()
    while (this.tasks.has(id)) id = createBackgroundBashTaskId()
    const outputFile = resolve(this.outputRoot, `${id}.output`)
    await writeFile(outputFile, '', { mode: 0o600 })
    const controller = new AbortController()
    const task = {
      taskId: id,
      command: input.command,
      description: input.description,
      toolUseId: input.toolUseId,
      outputFile,
      status: 'running' as const,
      output: '',
      exitCode: null,
      notified: false,
      controller,
      completion: Promise.resolve(),
      startedAt: Date.now(),
      durationMs: null,
      ...(input.signal
        ? {
            parentSignal: input.signal,
            parentAbort: () => controller.abort(),
          }
        : {}),
    }
    if (task.parentSignal && task.parentAbort) {
      if (task.parentSignal.aborted) task.parentAbort()
      else {
        task.parentSignal.addEventListener('abort', task.parentAbort, {
          once: true,
        })
      }
    }
    this.tasks.set(id, task)
    this.options.eventSink?.({
      type: 'task-started',
      taskId: id,
      toolUseId: input.toolUseId,
      description: input.description,
      taskType: 'local_bash',
      prompt: input.command,
    })
    task.completion = this.run(task, input.timeout)
    return {
      taskId: id,
      outputFile,
      content: `Command running in background with ID: ${id}. Output is being written to: ${outputFile}. You will be notified when it completes. To check interim output, use Read on that file path.`,
      nativeToolUseResult: {
        stdout: '',
        stderr: '',
        interrupted: false,
        isImage: false,
        noOutputExpected: false,
        backgroundTaskId: id,
      },
    }
  }

  async output(
    taskId: string,
    options: { block: boolean; timeout: number },
  ): Promise<BackgroundBashToolResult> {
    const task = await this.resolveTask(taskId)
    if (!task) throw new Error(`No task found with ID: ${taskId}`)
    if (options.timeout < 0 || options.timeout > 600_000) {
      throw new Error('timeout must be between 0 and 600000')
    }
    let waitTimedOut = false
    if (options.block && task.status === 'running') {
      await new Promise<void>((resolveWait) => {
        const timeout = setTimeout(() => {
          waitTimedOut = true
          resolveWait()
        }, options.timeout)
        void task.completion.then(() => {
          clearTimeout(timeout)
          resolveWait()
        })
      })
    }
    const result = this.outputResult(task, waitTimedOut ? 'timeout' : undefined)
    if (task.status !== 'running' && !task.notified) {
      task.notified = true
      await this.persist(task)
    }
    return result
  }

  async stop(taskId: string): Promise<BackgroundBashToolResult> {
    const task = await this.resolveTask(taskId)
    if (!task) throw new Error(`No task found with ID: ${taskId}`)
    if (task.status !== 'running') {
      throw new Error(`Task ${taskId} is not running (status: ${task.status})`)
    }
    task.controller.abort()
    await task.completion
    const nativeToolUseResult = {
      message: `Successfully stopped task: ${task.taskId} (${task.command})`,
      task_id: task.taskId,
      task_type: 'local_bash',
      command: task.command,
    }
    return {
      content: JSON.stringify(nativeToolUseResult),
      nativeToolUseResult,
    }
  }

  async notifications(waitForRunning: boolean): Promise<string[]> {
    await this.hydratePersistedTasks()
    if (waitForRunning) {
      await Promise.all(
        [...this.tasks.values()]
          .filter(({ status }) => status === 'running')
          .map(({ completion }) => completion),
      )
    }
    const messages: string[] = []
    for (const task of this.tasks.values()) {
      if (
        task.status === 'running' ||
        task.status === 'stopped' ||
        task.notified
      ) {
        continue
      }
      task.notified = true
      messages.push(this.notification(task))
      await this.persist(task)
    }
    return messages
  }

  private async run(task: BackgroundBashTask, timeout: number): Promise<void> {
    try {
      const result = await this.runner.run({
        command: commandShell(),
        args: commandShellArguments(task.command),
        timeoutMs: timeout,
        cwd: this.options.cwdProvider?.() ?? this.options.cwd,
        signal: task.controller.signal,
        onOutput: async (output) => {
          task.output = output
          await writeFile(task.outputFile, output, { mode: 0o600 })
        },
      })
      this.complete(task, result)
      await this.persist(task)
    } catch (error) {
      if (task.controller.signal.aborted) {
        task.status = 'stopped'
        task.exitCode = null
      } else {
        task.status = 'failed'
        task.exitCode = 1
        task.output = `Background task failed: ${error instanceof Error ? error.message : String(error)}`
      }
      task.durationMs = Date.now() - task.startedAt
      await writeFile(task.outputFile, task.output, { mode: 0o600 }).catch(
        () => undefined,
      )
      await this.persist(task).catch((persistError: unknown) => {
        task.output = `${task.output}${task.output ? '\n' : ''}Failed to persist background task: ${
          persistError instanceof Error
            ? persistError.message
            : String(persistError)
        }`
      })
    } finally {
      this.emitNotification(task)
      if (task.parentSignal && task.parentAbort) {
        task.parentSignal.removeEventListener('abort', task.parentAbort)
      }
    }
  }

  private emitNotification(task: BackgroundBashTask): void {
    if (task.status === 'running') return
    const summary =
      task.status === 'completed'
        ? `Background command "${task.description}" completed (exit code ${task.exitCode})`
        : task.status === 'stopped'
          ? `Background command "${task.description}" was stopped`
          : `Background command "${task.description}" failed with exit code ${task.exitCode}`
    this.options.eventSink?.({
      type: 'task-notification',
      taskId: task.taskId,
      toolUseId: task.toolUseId,
      status: task.status,
      outputFile: task.outputFile,
      summary,
      usage: {
        totalTokens: 0,
        toolUses: 0,
        durationMs: Date.now() - task.startedAt,
      },
    })
  }

  private complete(task: BackgroundBashTask, result: ProcessResult): void {
    task.output = result.output
    task.exitCode = result.code
    task.status = result.code === 0 && !result.timedOut ? 'completed' : 'failed'
    task.durationMs = Date.now() - task.startedAt
  }

  private outputResult(
    task: BackgroundBashTask,
    retrievalOverride?: 'timeout',
  ): BackgroundBashToolResult {
    const retrievalStatus =
      retrievalOverride ?? (task.status === 'running' ? 'not_ready' : 'success')
    const exitCode = task.exitCode
    const content = [
      `<retrieval_status>${retrievalStatus}</retrieval_status>`,
      `<task_id>${task.taskId}</task_id>`,
      '<task_type>local_bash</task_type>',
      `<status>${task.status}</status>`,
      ...(exitCode === null ? [] : [`<exit_code>${exitCode}</exit_code>`]),
      `<output>\n${task.output}</output>`,
    ].join('\n\n')
    return {
      content,
      nativeToolUseResult: {
        retrieval_status: retrievalStatus,
        task: {
          task_id: task.taskId,
          task_type: 'local_bash',
          status: task.status,
          description: task.description,
          output: task.output,
          exitCode,
        },
      },
    }
  }

  private notification(task: BackgroundBashTask): string {
    const summary =
      task.status === 'completed'
        ? `Background command "${task.description}" completed (exit code ${task.exitCode})`
        : `Background command "${task.description}" failed with exit code ${task.exitCode}`
    return `<task-notification>\n<task-id>${escapeXml(task.taskId)}</task-id>\n<tool-use-id>${escapeXml(task.toolUseId)}</tool-use-id>\n<output-file>${escapeXml(task.outputFile)}</output-file>\n<status>${escapeXml(task.status)}</status>\n<summary>${escapeXml(summary)}</summary>\n</task-notification>`
  }

  private async resolveTask(
    taskId: string,
  ): Promise<BackgroundBashTask | null> {
    assertBackgroundBashTaskId(taskId)
    const existing = this.tasks.get(taskId)
    if (existing) return existing
    try {
      const stateFile = resolve(this.sessionStateRoot, `${taskId}.json`)
      const [source, metadata] = await Promise.all([
        readFile(stateFile, 'utf8'),
        stat(stateFile),
      ])
      const state = parsePersistedTask(
        source,
        taskId,
        resolve(this.outputRoot, `${taskId}.output`),
      )
      if (!state) return null
      const task: BackgroundBashTask = {
        ...state,
        controller: new AbortController(),
        completion: Promise.resolve(),
        startedAt: state.startedAt ?? Math.floor(metadata.mtimeMs),
        durationMs: state.durationMs ?? null,
      }
      this.tasks.set(taskId, task)
      return task
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  private async hydratePersistedTasks(): Promise<void> {
    let names: string[]
    try {
      names = await readdir(this.sessionStateRoot)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    const taskIds = names
      .map(backgroundBashTaskIdFromStateFile)
      .filter((taskId): taskId is string => taskId !== null)
    await Promise.all(taskIds.map((taskId) => this.resolveTask(taskId)))
  }

  private async persist(task: BackgroundBashTask): Promise<void> {
    if (task.status === 'running') return
    await mkdir(this.sessionStateRoot, { recursive: true })
    const state: PersistedBackgroundBashTask = {
      version: 1,
      taskId: task.taskId,
      command: task.command,
      description: task.description,
      toolUseId: task.toolUseId,
      outputFile: task.outputFile,
      status: task.status,
      output: task.output,
      exitCode: task.exitCode,
      notified: task.notified,
      startedAt: task.startedAt,
      ...(task.durationMs === null ? {} : { durationMs: task.durationMs }),
    }
    await writeFileAtomically(
      resolve(this.sessionStateRoot, `${task.taskId}.json`),
      JSON.stringify(state, null, 2),
      { mode: 0o600 },
    )
  }

  private snapshot(task: BackgroundBashTask): BackgroundBashSnapshot {
    return {
      taskId: task.taskId,
      status: task.status,
      command: task.command,
      description: task.description,
      outputFile: task.outputFile,
      output: task.output,
      exitCode: task.exitCode,
      startedAt: task.startedAt,
      durationMs: task.durationMs,
    }
  }
}
