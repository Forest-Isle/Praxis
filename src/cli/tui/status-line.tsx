import { spawn } from 'node:child_process'
import { watchFile, unwatchFile } from 'node:fs'
import { join, resolve } from 'node:path'

import { Box, Text } from 'ink'
import { useCallback, useEffect, useRef, useState } from 'react'

import type { ResourceScope } from '../../core/resources.js'
import type { ModelUsage } from '../../core/runtime.js'
import type { DataPlane } from '../../persistence/data-plane.js'
import { loadNativeSharedResources } from '../../persistence/native-resources.js'
import {
  commandShell,
  commandShellArguments,
} from '../../platform/command-shell.js'

export interface ClaudeStatusLineSetting {
  type: 'command'
  command: string
  padding?: number
}

export interface ClaudeStatusLineInput {
  session_id: string
  session_name?: string
  transcript_path: string
  cwd: string
  permission_mode?: string
  model: { id: string; display_name: string }
  workspace: {
    current_dir: string
    project_dir: string
    added_dirs: readonly string[]
  }
  version: string
  output_style: { name: string }
  cost: {
    total_cost_usd: number
    total_duration_ms: number
    total_api_duration_ms: number
    total_lines_added: number
    total_lines_removed: number
  }
  context_window: {
    total_input_tokens: number
    total_output_tokens: number
    context_window_size: number
    current_usage: {
      input_tokens: number
      output_tokens: number
      cache_creation_input_tokens: number
      cache_read_input_tokens: number
    } | null
    used_percentage: number | null
    remaining_percentage: number | null
  }
  exceeds_200k_tokens: boolean
  vim?: { mode: 'INSERT' | 'NORMAL' }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export async function loadClaudeStatusLineSetting(options: {
  configRoot: string
  cwd: string
  settingSources?: readonly ResourceScope[]
  dataPlane?: DataPlane
}): Promise<{
  setting?: ClaudeStatusLineSetting
  disabled: boolean
}> {
  const resources = (
    await loadNativeSharedResources({
      root: options.configRoot,
      cwd: options.cwd,
    })
  ).settings.filter(
    (resource) =>
      options.settingSources === undefined ||
      options.settingSources.includes(resource.scope),
  )
  const merged = Object.assign(
    {},
    ...resources.map((resource) => record(resource.value) ?? {}),
  ) as Record<string, unknown>
  const value = record(merged.statusLine)
  const setting =
    value?.type === 'command' && typeof value.command === 'string'
      ? {
          type: 'command' as const,
          command: value.command,
          ...(typeof value.padding === 'number' &&
          Number.isFinite(value.padding)
            ? { padding: value.padding }
            : {}),
        }
      : undefined
  return {
    ...(setting ? { setting } : {}),
    disabled: merged.disableAllHooks === true,
  }
}

export async function executeClaudeStatusLine(
  setting: ClaudeStatusLineSetting,
  input: ClaudeStatusLineInput,
  options: {
    cwd: string
    signal?: AbortSignal
    timeoutMs?: number
    columns?: number
  } = {
    cwd: process.cwd(),
  },
): Promise<string | undefined> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 5000)
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout])
    : timeout
  return new Promise((resolve) => {
    let settled = false
    let stdout = ''
    const finish = (value?: string) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    let child
    try {
      const env = { ...process.env }
      if (
        options.columns !== undefined &&
        Number.isFinite(options.columns) &&
        options.columns > 0
      ) {
        env.COLUMNS = String(Math.trunc(options.columns))
      }
      child = spawn(commandShell(), commandShellArguments(setting.command), {
        cwd: options.cwd,
        detached: process.platform !== 'win32',
        env,
        stdio: ['pipe', 'pipe', 'ignore'],
      })
    } catch {
      finish()
      return
    }
    child.stdout.setEncoding('utf8')
    const terminate = () => {
      if (child.pid === undefined) return
      try {
        if (process.platform === 'win32') child.kill('SIGKILL')
        else process.kill(-child.pid, 'SIGKILL')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') finish()
      }
    }
    if (signal.aborted) terminate()
    else signal.addEventListener('abort', terminate, { once: true })
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length <= 1024 * 1024) stdout += chunk
    })
    child.on('error', () => {
      signal.removeEventListener('abort', terminate)
      finish()
    })
    child.on('close', (code) => {
      signal.removeEventListener('abort', terminate)
      if (code !== 0 || signal.aborted) {
        finish()
        return
      }
      const output = stdout
        .trim()
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean)
        .join('\n')
      finish(output || undefined)
    })
    child.stdin.on('error', () => undefined)
    child.stdin.end(JSON.stringify(input))
  })
}

export function createClaudeStatusLineInput(options: {
  configRoot: string
  cwd: string
  projectDir: string
  sessionId: string
  sessionName?: string | null
  model?: string
  version: string
  outputStyle: string
  permissionMode?: string
  additionalDirectories: readonly string[]
  usage?: ModelUsage
  costUsd?: number
  contextWindowTokens?: number
  vimMode?: 'INSERT' | 'NORMAL'
  dataPlane?: DataPlane
}): ClaudeStatusLineInput {
  const usage = options.usage
  const contextInputTokens = usage
    ? usage.inputTokens +
      (usage.cacheReadInputTokens ?? 0) +
      (usage.cacheCreationInputTokens ?? 0)
    : null
  const usedTokens =
    contextInputTokens === null || usage === undefined
      ? null
      : contextInputTokens + usage.outputTokens
  const contextWindowSize = options.contextWindowTokens ?? 0
  const usedPercentage =
    contextInputTokens === null || contextWindowSize <= 0
      ? null
      : Math.min(
          100,
          Math.max(
            0,
            Math.round((contextInputTokens / contextWindowSize) * 100),
          ),
        )
  const model = options.model ?? 'default'
  const transcriptPath = resolve(
    options.configRoot,
    'sessions',
    `${options.sessionId}.jsonl`,
  )
  return {
    session_id: options.sessionId,
    ...(options.sessionName ? { session_name: options.sessionName } : {}),
    transcript_path: transcriptPath,
    cwd: options.cwd,
    ...(options.permissionMode
      ? { permission_mode: options.permissionMode }
      : {}),
    model: { id: model, display_name: model },
    workspace: {
      current_dir: options.cwd,
      project_dir: options.projectDir,
      added_dirs: options.additionalDirectories,
    },
    version: options.version,
    output_style: { name: options.outputStyle },
    cost: {
      total_cost_usd: options.costUsd ?? 0,
      total_duration_ms: 0,
      total_api_duration_ms: 0,
      total_lines_added: 0,
      total_lines_removed: 0,
    },
    context_window: {
      total_input_tokens: usage?.inputTokens ?? 0,
      total_output_tokens: usage?.outputTokens ?? 0,
      context_window_size: contextWindowSize,
      current_usage: usage
        ? {
            input_tokens: usage.inputTokens,
            output_tokens: usage.outputTokens,
            cache_creation_input_tokens: usage.cacheCreationInputTokens ?? 0,
            cache_read_input_tokens: usage.cacheReadInputTokens ?? 0,
          }
        : null,
      used_percentage: usedPercentage,
      remaining_percentage:
        usedPercentage === null ? null : 100 - usedPercentage,
    },
    exceeds_200k_tokens: usedTokens !== null && usedTokens > 200_000,
    ...(options.vimMode ? { vim: { mode: options.vimMode } } : {}),
  }
}

export interface ClaudeStatusLineState {
  readonly text?: string
  readonly padding: number
}

export interface UseClaudeStatusLineOptions {
  readonly configRoot: string
  readonly cwd: string
  readonly input: ClaudeStatusLineInput
  readonly refreshKey: string
  readonly width?: number
  readonly settingSources?: readonly ResourceScope[]
  readonly dataPlane?: DataPlane
}

export function useClaudeStatusLine({
  configRoot,
  cwd,
  input,
  refreshKey,
  width,
  settingSources,
  dataPlane: _dataPlane = 'native',
}: UseClaudeStatusLineOptions): ClaudeStatusLineState {
  void _dataPlane
  const [text, setText] = useState<string>()
  const [padding, setPadding] = useState(0)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const controller = useRef<AbortController | undefined>(undefined)
  const latestInput = useRef(input)
  latestInput.current = input

  const update = useCallback(async () => {
    controller.current?.abort()
    const current = new AbortController()
    controller.current = current
    try {
      const loaded = await loadClaudeStatusLineSetting({
        configRoot,
        cwd,
        ...(settingSources === undefined ? {} : { settingSources }),
      })
      if (current.signal.aborted) return
      setPadding(loaded.setting?.padding ?? 0)
      if (loaded.disabled || !loaded.setting) {
        setText(undefined)
        return
      }
      const result = await executeClaudeStatusLine(
        loaded.setting,
        latestInput.current,
        {
          cwd,
          signal: current.signal,
          ...(width === undefined ? {} : { columns: width }),
        },
      )
      if (!current.signal.aborted) setText(result)
    } catch {
      if (!current.signal.aborted) setText(undefined)
    }
  }, [configRoot, cwd, settingSources, width])

  const schedule = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => void update(), 300)
  }, [update])

  useEffect(() => {
    schedule()
  }, [refreshKey, schedule])

  useEffect(() => {
    const paths = [
      join(configRoot, 'settings.json'),
      join(cwd, '.praxis', 'settings.json'),
      join(cwd, '.praxis', 'settings.local.json'),
    ]
    const changed = () => schedule()
    for (const path of paths) watchFile(path, { interval: 500 }, changed)
    return () => {
      for (const path of paths) unwatchFile(path, changed)
      controller.current?.abort()
      if (timer.current) clearTimeout(timer.current)
    }
  }, [configRoot, cwd, schedule])

  return text === undefined ? { padding } : { text, padding }
}

export function StatusLine({
  configRoot,
  cwd,
  input,
  refreshKey,
  width,
  settingSources,
  dataPlane,
}: UseClaudeStatusLineOptions) {
  const { text, padding } = useClaudeStatusLine({
    configRoot,
    cwd,
    input,
    refreshKey,
    ...(width === undefined ? {} : { width }),
    ...(settingSources === undefined ? {} : { settingSources }),
    ...(dataPlane === undefined ? {} : { dataPlane }),
  })
  if (!text) return null
  return (
    <Box paddingX={padding} flexShrink={0}>
      <Text dimColor wrap="truncate">
        {text}
      </Text>
    </Box>
  )
}
