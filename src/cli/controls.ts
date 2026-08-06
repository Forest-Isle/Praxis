import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'

import type { ClaudeJsonResource } from '../compatibility/claude/shared-resources.js'
import type { CliControls } from './protocol.js'

export const DEFAULT_CLI_CONTROLS: CliControls = {
  settings: undefined,
  settingSources: undefined,
  safeMode: false,
  bare: false,
  systemPrompt: undefined,
  systemPromptFile: undefined,
  appendSystemPrompt: undefined,
  appendSystemPromptFile: undefined,
  addDirectories: [],
  pluginDirectories: [],
  pluginUrls: [],
  tools: undefined,
  allowedTools: [],
  disallowedTools: [],
  permissionMode: 'default',
  dangerouslySkipPermissions: false,
  allowDangerouslySkipPermissions: false,
  continueSession: false,
  forkSession: false,
  name: undefined,
  sessionPersistence: true,
  promptSuggestions: false,
}

export interface ResolvedCliControls extends Omit<
  CliControls,
  'settings' | 'systemPromptFile' | 'appendSystemPromptFile' | 'addDirectories'
> {
  additionalSettings: ClaudeJsonResource | undefined
  systemPrompt: string | undefined
  appendSystemPrompt: string | undefined
  additionalDirectories: readonly string[]
}

function absolutePath(cwd: string, path: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path)
}

function parseSettings(source: string, path: string): ClaudeJsonResource {
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch (error) {
    throw new Error(`Invalid settings JSON: ${path}`, { cause: error })
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Settings JSON must be an object: ${path}`)
  }
  return { path, scope: 'local', value }
}

async function resolveSettings(
  cwd: string,
  value: string | undefined,
): Promise<ClaudeJsonResource | undefined> {
  if (value === undefined) return undefined
  if (value.trimStart().startsWith('{')) {
    return parseSettings(value, '<command-line>')
  }
  const path = absolutePath(cwd, value)
  return parseSettings(await readFile(path, 'utf8'), path)
}

async function resolveDirectories(
  cwd: string,
  directories: readonly string[],
): Promise<string[]> {
  const resolved = await Promise.all(
    directories.map(async (directory) => {
      const path = await realpath(absolutePath(cwd, directory))
      if (!(await stat(path)).isDirectory()) {
        throw new Error(`Additional path is not a directory: ${directory}`)
      }
      return path
    }),
  )
  return [...new Set(resolved)]
}

export async function resolveCliControls(
  controls: CliControls,
  cwd: string,
): Promise<ResolvedCliControls> {
  const [additionalSettings, systemPrompt, appendSystemPrompt, directories] =
    await Promise.all([
      resolveSettings(cwd, controls.settings),
      controls.systemPromptFile
        ? readFile(absolutePath(cwd, controls.systemPromptFile), 'utf8')
        : Promise.resolve(controls.systemPrompt),
      controls.appendSystemPromptFile
        ? readFile(absolutePath(cwd, controls.appendSystemPromptFile), 'utf8')
        : Promise.resolve(controls.appendSystemPrompt),
      resolveDirectories(cwd, controls.addDirectories),
    ])

  return {
    settingSources: controls.settingSources,
    safeMode: controls.safeMode,
    bare: controls.bare,
    systemPrompt,
    appendSystemPrompt,
    tools: controls.tools,
    allowedTools: controls.allowedTools,
    disallowedTools: controls.disallowedTools,
    permissionMode: controls.permissionMode,
    dangerouslySkipPermissions: controls.dangerouslySkipPermissions,
    allowDangerouslySkipPermissions: controls.allowDangerouslySkipPermissions,
    continueSession: controls.continueSession,
    forkSession: controls.forkSession,
    name: controls.name,
    sessionPersistence: controls.sessionPersistence,
    ...(controls.model === undefined ? {} : { model: controls.model }),
    ...(controls.effort === undefined ? {} : { effort: controls.effort }),
    ...(controls.fallbackModels === undefined
      ? {}
      : { fallbackModels: controls.fallbackModels }),
    ...(controls.jsonSchema === undefined
      ? {}
      : { jsonSchema: controls.jsonSchema }),
    ...(controls.maxBudgetUsd === undefined
      ? {}
      : { maxBudgetUsd: controls.maxBudgetUsd }),
    promptSuggestions: controls.promptSuggestions ?? false,
    ...(controls.worktreeName === undefined
      ? {}
      : { worktreeName: controls.worktreeName }),
    ...(controls.worktreeRequested ? { worktreeRequested: true } : {}),
    ...(controls.tmux === undefined ? {} : { tmux: controls.tmux }),
    additionalSettings,
    additionalDirectories: directories,
    pluginDirectories: controls.pluginDirectories,
    pluginUrls: controls.pluginUrls,
  }
}
