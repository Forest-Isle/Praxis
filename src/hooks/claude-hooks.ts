import { spawn } from 'node:child_process'

import type { ClaudeJsonResource } from '../compatibility/claude/shared-resources.js'
import type { PermissionBehavior } from '../core/runtime.js'

export type ClaudeHookEventName =
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
}

export type ClaudeHookCommandExecutor = (
  command: string,
  input: ClaudeHookInput,
  timeoutMs: number,
  signal?: AbortSignal,
) => Promise<ProcessResult>

export interface ClaudeHookRunnerOptions {
  settings: readonly ClaudeJsonResource[]
  cwd: string
  maxOutputBytes?: number
  maxTimeoutMs?: number
  executeCommand?: ClaudeHookCommandExecutor
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
const DEFAULT_MAX_OUTPUT_BYTES = 128 * 1024
const KILL_GRACE_MS = 250

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`)
  }
  return value
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
  private readonly cwd: string
  private readonly maxOutputBytes: number
  private readonly maxTimeoutMs: number
  private readonly executeCommand: ClaudeHookCommandExecutor

  constructor(options: ClaudeHookRunnerOptions) {
    this.settings = options.settings
    this.cwd = options.cwd
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
    this.maxTimeoutMs = options.maxTimeoutMs ?? DEFAULT_TIMEOUT_MS
    this.executeCommand = options.executeCommand ?? this.runCommand.bind(this)
  }

  async run(
    input: ClaudeHookInput,
    matcherValue?: string,
    signal?: AbortSignal,
  ): Promise<ClaudeHookOutcome> {
    if (signal?.aborted) throw abortError()
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
        const result = await this.executeCommand(
          hook.command,
          input,
          hook.timeoutMs,
          signal,
        )
        const toolUseId =
          optionalString(input.tool_use_id) ?? crypto.randomUUID()
        executions.push({
          event: input.hook_event_name,
          hookName: `${input.hook_event_name}${matcherValue ? `:${matcherValue}` : ''}`,
          toolUseId,
          command: hook.command,
          ...result,
        })
        if (result.exitCode === 2) {
          blockedReason =
            result.stderr.trim() ||
            result.stdout.trim() ||
            'Hook blocked action'
          break
        }
        if (result.exitCode !== 0) continue

        const output = outputRecord(result.stdout)
        const specific = isRecord(output?.hookSpecificOutput)
          ? output.hookSpecificOutput
          : null
        const context = optionalString(specific?.additionalContext)
        if (context) additionalContext.push(context)
        if (isRecord(specific?.updatedInput)) {
          updatedInput = specific.updatedInput
        }
        permissionDecision =
          permissionBehavior(specific?.permissionDecision) ?? permissionDecision
        permissionDecisionReason =
          optionalString(specific?.permissionDecisionReason) ??
          permissionDecisionReason
        if (output?.continue === false || output?.decision === 'block') {
          blockedReason =
            optionalString(output.stopReason) ??
            optionalString(output.reason) ??
            'Hook blocked action'
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
  ): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now()
      const child = spawn('/bin/zsh', ['-lc', command], {
        cwd: this.cwd,
        env: { ...process.env, CLAUDE_PROJECT_DIR: input.cwd },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      })
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let outputBytes = 0
      let settled = false
      let terminationError: Error | undefined
      let spawnError: Error | undefined
      let killTimer: ReturnType<typeof setTimeout> | undefined
      const finish = (callback: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
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
        killTimer = setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS)
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
      }
      child.stdout.on('data', collect(stdout))
      child.stderr.on('data', collect(stderr))
      child.stdin.on('error', () => undefined)
      child.once('error', (error) => {
        spawnError = error
      })
      child.once('close', (code) =>
        finish(() => {
          if (terminationError) {
            reject(terminationError)
            return
          }
          if (spawnError) {
            reject(spawnError)
            return
          }
          resolve({
            stdout: Buffer.concat(stdout).toString('utf8'),
            stderr: Buffer.concat(stderr).toString('utf8'),
            exitCode: code ?? 1,
            durationMs: Date.now() - startedAt,
          })
        }),
      )
      const timer = setTimeout(
        () => terminate(new Error(`Hook timed out after ${timeoutMs}ms`)),
        timeoutMs,
      )
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
      child.stdin.end(JSON.stringify(input))
    })
  }
}
