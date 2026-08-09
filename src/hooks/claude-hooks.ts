import { spawn } from 'node:child_process'

import type { ClaudeJsonResource } from '../compatibility/claude/shared-resources.js'
import type { PermissionBehavior } from '../core/runtime.js'
import {
  commandShell,
  commandShellArguments,
} from '../platform/command-shell.js'
import {
  redactSensitiveText,
  sanitizeChildEnvironment,
  sensitiveEnvironmentValues,
} from '../platform/sensitive-data.js'

export type ClaudeHookEventName =
  | 'Setup'
  | 'SessionStart'
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PermissionRequest'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'Stop'
  | 'SessionEnd'

export interface ClaudeHookInput extends Record<string, unknown> {
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode: string
  hook_event_name: ClaudeHookEventName
}

export interface ClaudeHookExecution {
  event: ClaudeHookEventName
  hookName: string
  toolUseId: string
  command: string
  stdout: string
  stderr: string
  exitCode: number
  durationMs: number
}

export interface ClaudeHookCommandProgress {
  stdout: string
  stderr: string
  output?: string
}

export type ClaudeHookStreamEvent =
  | {
      type: 'started'
      hookId: string
      hookName: string
      hookEvent: ClaudeHookEventName
    }
  | {
      type: 'progress'
      hookId: string
      hookName: string
      hookEvent: ClaudeHookEventName
      stdout: string
      stderr: string
      output: string
    }
  | {
      type: 'response'
      hookId: string
      hookName: string
      hookEvent: ClaudeHookEventName
      stdout: string
      stderr: string
      output: string
      exitCode?: number
      outcome: 'success' | 'error' | 'cancelled'
    }

export interface ClaudeHookOutcome {
  executions: readonly ClaudeHookExecution[]
  additionalContext: readonly string[]
  updatedInput?: Record<string, unknown>
  permissionDecision?: PermissionBehavior
  permissionDecisionReason?: string
  blockedReason?: string
}

interface CommandHook {
  command: string
  timeoutMs: number
  environment?: Readonly<Record<string, string>>
  sensitiveValues?: readonly string[]
}

interface HookMatcher {
  matcher?: RegExp
  hooks: readonly CommandHook[]
}

interface ProcessResult {
  stdout: string
  stderr: string
  exitCode: number
  durationMs: number
  output?: string
  aborted?: boolean
}

export type ClaudeHookCommandExecutor = (
  command: string,
  input: ClaudeHookInput,
  timeoutMs: number,
  signal?: AbortSignal,
  onProgress?: (progress: ClaudeHookCommandProgress) => void,
  environment?: Readonly<Record<string, string>>,
) => Promise<ProcessResult>

export interface ClaudeHookRunnerOptions {
  settings: readonly ClaudeJsonResource[]
  cwd: string
  maxOutputBytes?: number
  maxTimeoutMs?: number
  executeCommand?: ClaudeHookCommandExecutor
  onEvent?: (event: ClaudeHookStreamEvent) => void
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
const DEFAULT_MAX_OUTPUT_BYTES = 128 * 1024
const KILL_GRACE_MS = 250

const HOOK_EVENTS: readonly ClaudeHookEventName[] = [
  'Setup',
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PostToolUseFailure',
  'Stop',
  'SessionEnd',
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`)
  }
  return value
}

function combinedSensitiveValues(
  ...groups: readonly (readonly string[] | undefined)[]
): readonly string[] {
  return [...new Set(groups.flatMap((group) => group ?? []))]
    .filter((value) => value.length > 0)
    .sort((left, right) => right.length - left.length)
}

function eventSettings(
  settings: readonly ClaudeJsonResource[],
  event: ClaudeHookEventName,
  maxTimeoutMs: number,
): HookMatcher[] {
  const matchers: HookMatcher[] = []
  for (const resource of settings) {
    if (!isRecord(resource.value) || !isRecord(resource.value.hooks)) continue
    const groups = resource.value.hooks[event]
    if (groups === undefined) continue
    if (!Array.isArray(groups)) {
      throw new Error(`Invalid Claude ${event} hooks: ${resource.path}`)
    }
    for (const group of groups) {
      if (!isRecord(group) || !Array.isArray(group.hooks)) {
        throw new Error(`Invalid Claude ${event} hook group: ${resource.path}`)
      }
      const matcherText = group.matcher
      let matcher: RegExp | undefined
      if (matcherText !== undefined && matcherText !== '') {
        if (matcherText !== '*' && typeof matcherText !== 'string') {
          throw new Error(`Invalid Claude ${event} matcher: ${resource.path}`)
        }
        if (matcherText !== '*') {
          try {
            matcher = new RegExp(`^(?:${matcherText})$`)
          } catch (error) {
            throw new Error(
              `Invalid Claude ${event} matcher: ${resource.path}`,
              {
                cause: error,
              },
            )
          }
        }
      }
      const hooks = group.hooks.flatMap((hook): CommandHook[] => {
        if (!isRecord(hook) || hook.type !== 'command') return []
        const command = nonEmptyString(
          hook.command,
          `Claude ${event} hook command`,
        )
        const timeoutSeconds = hook.timeout ?? DEFAULT_TIMEOUT_MS / 1000
        if (
          typeof timeoutSeconds !== 'number' ||
          !Number.isFinite(timeoutSeconds) ||
          timeoutSeconds <= 0
        ) {
          throw new Error(
            `Invalid Claude ${event} hook timeout: ${resource.path}`,
          )
        }
        return [
          {
            command,
            timeoutMs: Math.min(timeoutSeconds * 1000, maxTimeoutMs),
            ...(resource.environment === undefined
              ? {}
              : { environment: resource.environment }),
            ...(resource.sensitiveValues === undefined
              ? {}
              : { sensitiveValues: resource.sensitiveValues }),
          },
        ]
      })
      if (hooks.length > 0) {
        matchers.push({ ...(matcher ? { matcher } : {}), hooks })
      }
    }
  }
  return matchers
}

export function validateClaudeHooks(
  settings: readonly ClaudeJsonResource[],
  maxTimeoutMs = DEFAULT_TIMEOUT_MS,
): void {
  if (
    !Number.isFinite(maxTimeoutMs) ||
    maxTimeoutMs <= 0 ||
    !Number.isInteger(maxTimeoutMs)
  ) {
    throw new Error('Hook max timeout must be a positive integer')
  }
  for (const event of HOOK_EVENTS) eventSettings(settings, event, maxTimeoutMs)
}

function outputRecord(stdout: string): Record<string, unknown> | null {
  const trimmed = stdout.trim()
  if (!trimmed.startsWith('{')) return null
  try {
    const value: unknown = JSON.parse(trimmed)
    return isRecord(value) ? value : null
  } catch {
    return null
  }
}

function hookErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function hookWasCancelled(error: unknown, signal?: AbortSignal): boolean {
  return (
    signal?.aborted === true ||
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  )
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function permissionBehavior(value: unknown): PermissionBehavior | undefined {
  return value === 'allow' || value === 'ask' || value === 'deny'
    ? value
    : undefined
}

function abortError(): DOMException {
  return new DOMException('Hook execution aborted', 'AbortError')
}

export class ClaudeHookRunner {
  private readonly settings: readonly ClaudeJsonResource[]
  private readonly maxOutputBytes: number
  private readonly maxTimeoutMs: number
  private readonly executeCommand: ClaudeHookCommandExecutor
  private readonly onEvent: ((event: ClaudeHookStreamEvent) => void) | undefined

  constructor(options: ClaudeHookRunnerOptions) {
    this.settings = options.settings
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
    this.maxTimeoutMs = options.maxTimeoutMs ?? DEFAULT_TIMEOUT_MS
    this.executeCommand = options.executeCommand ?? this.runCommand.bind(this)
    this.onEvent = options.onEvent
  }

  async run(
    input: ClaudeHookInput,
    matcherValue?: string,
    signal?: AbortSignal,
  ): Promise<ClaudeHookOutcome> {
    if (signal?.aborted) throw abortError()
    const ambientSensitiveValues = sensitiveEnvironmentValues(process.env)
    const groups = eventSettings(
      this.settings,
      input.hook_event_name,
      this.maxTimeoutMs,
    ).filter(
      (group) => !group.matcher || group.matcher.test(matcherValue ?? ''),
    )
    const executions: ClaudeHookExecution[] = []
    const additionalContext: string[] = []
    let updatedInput: Record<string, unknown> | undefined
    let permissionDecision: PermissionBehavior | undefined
    let permissionDecisionReason: string | undefined
    let blockedReason: string | undefined

    for (const group of groups) {
      for (const hook of group.hooks) {
        const sensitiveValues = combinedSensitiveValues(
          ambientSensitiveValues,
          hook.sensitiveValues,
        )
        const hookId = crypto.randomUUID()
        const hookName = `${input.hook_event_name}${matcherValue ? `:${matcherValue}` : ''}`
        this.onEvent?.({
          type: 'started',
          hookId,
          hookName,
          hookEvent: input.hook_event_name,
        })
        let result: ProcessResult
        const reportProgress = (progress: ClaudeHookCommandProgress) => {
          const stdout = redactSensitiveText(progress.stdout, sensitiveValues)
          const stderr = redactSensitiveText(progress.stderr, sensitiveValues)
          const output = redactSensitiveText(
            progress.output ?? `${progress.stdout}${progress.stderr}`,
            sensitiveValues,
          )
          if (
            Buffer.byteLength(stdout) + Buffer.byteLength(stderr) >
            this.maxOutputBytes
          ) {
            return
          }
          this.onEvent?.({
            type: 'progress',
            hookId,
            hookName,
            hookEvent: input.hook_event_name,
            stdout,
            stderr,
            output,
          })
        }
        try {
          result = await this.executeCommand(
            hook.command,
            input,
            hook.timeoutMs,
            signal,
            reportProgress,
            hook.environment,
          )
        } catch (error) {
          const message = redactSensitiveText(
            hookErrorMessage(error),
            sensitiveValues,
          )
          const cancelled = hookWasCancelled(error, signal)
          this.onEvent?.({
            type: 'response',
            hookId,
            hookName,
            hookEvent: input.hook_event_name,
            output: message,
            stdout: '',
            stderr: message,
            ...(cancelled ? {} : { exitCode: 1 }),
            outcome: cancelled ? 'cancelled' : 'error',
          })
          throw error
        }
        const toolUseId =
          optionalString(input.tool_use_id) ?? crypto.randomUUID()
        const stdout = redactSensitiveText(result.stdout, sensitiveValues)
        const stderr = redactSensitiveText(result.stderr, sensitiveValues)
        const output = redactSensitiveText(
          result.output ?? `${result.stdout}${result.stderr}`,
          sensitiveValues,
        )
        if (
          Buffer.byteLength(stdout) + Buffer.byteLength(stderr) >
          this.maxOutputBytes
        ) {
          const error = new Error('Hook output exceeded byte limit')
          this.onEvent?.({
            type: 'response',
            hookId,
            hookName,
            hookEvent: input.hook_event_name,
            output: hookErrorMessage(error),
            stdout: '',
            stderr: hookErrorMessage(error),
            exitCode: 1,
            outcome: 'error',
          })
          throw error
        }
        this.onEvent?.({
          type: 'response',
          hookId,
          hookName,
          hookEvent: input.hook_event_name,
          stdout,
          stderr,
          output,
          exitCode: result.exitCode,
          outcome: result.aborted
            ? 'cancelled'
            : result.exitCode === 0
              ? 'success'
              : 'error',
        })
        executions.push({
          event: input.hook_event_name,
          hookName,
          toolUseId,
          command: redactSensitiveText(hook.command, sensitiveValues),
          stdout,
          stderr,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
        })
        if (result.exitCode === 2) {
          blockedReason = redactSensitiveText(
            result.stderr.trim() ||
              result.stdout.trim() ||
              'Hook blocked action',
            sensitiveValues,
          )
          break
        }
        if (result.exitCode !== 0) continue

        const parsedOutput = outputRecord(result.stdout)
        const specific = isRecord(parsedOutput?.hookSpecificOutput)
          ? parsedOutput.hookSpecificOutput
          : null
        const context = optionalString(specific?.additionalContext)
        if (context) {
          additionalContext.push(redactSensitiveText(context, sensitiveValues))
        }
        if (isRecord(specific?.updatedInput)) {
          updatedInput = specific.updatedInput
        }
        permissionDecision =
          permissionBehavior(specific?.permissionDecision) ?? permissionDecision
        const nextPermissionReason = optionalString(
          specific?.permissionDecisionReason,
        )
        permissionDecisionReason = nextPermissionReason
          ? redactSensitiveText(nextPermissionReason, sensitiveValues)
          : permissionDecisionReason
        if (
          parsedOutput?.continue === false ||
          parsedOutput?.decision === 'block'
        ) {
          blockedReason = redactSensitiveText(
            optionalString(parsedOutput.stopReason) ??
              optionalString(parsedOutput.reason) ??
              'Hook blocked action',
            sensitiveValues,
          )
          break
        }
      }
      if (blockedReason) break
    }

    return {
      executions,
      additionalContext,
      ...(updatedInput ? { updatedInput } : {}),
      ...(permissionDecision ? { permissionDecision } : {}),
      ...(permissionDecisionReason ? { permissionDecisionReason } : {}),
      ...(blockedReason ? { blockedReason } : {}),
    }
  }

  private runCommand(
    command: string,
    input: ClaudeHookInput,
    timeoutMs: number,
    signal?: AbortSignal,
    onProgress?: (progress: ClaudeHookCommandProgress) => void,
    environment?: Readonly<Record<string, string>>,
  ): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now()
      const child = spawn(commandShell(), commandShellArguments(command), {
        cwd: input.cwd,
        env: sanitizeChildEnvironment({
          ...environment,
          CLAUDE_PROJECT_DIR: input.cwd,
        }),
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      })
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      const output: Buffer[] = []
      let outputBytes = 0
      let settled = false
      let terminationError: Error | undefined
      let spawnError: Error | undefined
      let killTimer: ReturnType<typeof setTimeout> | undefined
      let lastProgressOutput = ''
      const progressTimer = setInterval(() => {
        const currentOutput = Buffer.concat(output).toString('utf8')
        if (currentOutput === lastProgressOutput) return
        lastProgressOutput = currentOutput
        onProgress?.({
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          output: currentOutput,
        })
      }, 1000)
      progressTimer.unref()
      const finish = (callback: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        clearInterval(progressTimer)
        if (killTimer) clearTimeout(killTimer)
        signal?.removeEventListener('abort', abort)
        callback()
      }
      const killGroup = (processSignal: NodeJS.Signals) => {
        try {
          if (process.platform !== 'win32' && child.pid) {
            process.kill(-child.pid, processSignal)
          } else {
            child.kill(processSignal)
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
            spawnError ??= error as Error
          }
        }
      }
      const terminate = (error: Error) => {
        if (terminationError) return
        terminationError = error
        killGroup('SIGTERM')
        killTimer = setTimeout(() => {
          killGroup('SIGKILL')
          finish(() => reject(error))
        }, KILL_GRACE_MS)
      }
      const abort = () => terminate(abortError())
      const collect = (target: Buffer[]) => (chunk: Buffer) => {
        if (terminationError) return
        outputBytes += chunk.length
        if (outputBytes > this.maxOutputBytes) {
          terminate(new Error('Hook output exceeded byte limit'))
          return
        }
        target.push(chunk)
        output.push(chunk)
      }
      child.stdout.on('data', collect(stdout))
      child.stderr.on('data', collect(stderr))
      child.stdin.on('error', () => undefined)
      child.once('error', (error) => {
        spawnError = error
      })
      child.once('close', (code) => {
        if (terminationError) return
        finish(() => {
          if (spawnError) {
            reject(spawnError)
            return
          }
          resolve({
            stdout: Buffer.concat(stdout).toString('utf8'),
            stderr: Buffer.concat(stderr).toString('utf8'),
            exitCode: code ?? 1,
            durationMs: Date.now() - startedAt,
            output: Buffer.concat(output).toString('utf8'),
          })
        })
      })
      const timer = setTimeout(() => {
        terminate(
          new DOMException(`Hook timed out after ${timeoutMs}ms`, 'AbortError'),
        )
      }, timeoutMs)
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
      child.stdin.end(JSON.stringify(input))
    })
  }
}
