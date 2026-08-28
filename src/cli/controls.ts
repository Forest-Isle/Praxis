import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, normalize, resolve } from 'node:path'

import { stringify as stringifyYaml } from 'yaml'

import type { JsonResource, TextResource } from '../core/resources.js'
import type { CliControls } from './protocol.js'

interface FileResource {
  fileId: string
  relativePath: string
}

export const DEFAULT_CLI_CONTROLS: CliControls = {
  forwardSubagentText: false,
  settings: undefined,
  settingSources: undefined,
  safeMode: false,
  bare: false,
  trustProject: false,
  systemPrompt: undefined,
  systemPromptFile: undefined,
  appendSystemPrompt: undefined,
  appendSystemPromptFile: undefined,
  excludeDynamicSystemPromptSections: false,
  addDirectories: [],
  pluginDirectories: [],
  pluginUrls: [],
  betas: [],
  brief: false,
  axScreenReader: false,
  fileResources: [],
  mcpConfigs: [],
  strictMcpConfig: false,
  disableSlashCommands: false,
  tools: undefined,
  allowedTools: [],
  disallowedTools: [],
  permissionMode: 'default',
  init: false,
  initOnly: false,
  maintenance: false,
  dangerouslySkipPermissions: false,
  allowDangerouslySkipPermissions: false,
  continueSession: false,
  forkSession: false,
  resumeSessionAt: undefined,
  name: undefined,
  sessionPersistence: true,
  prefill: undefined,
  promptSuggestions: false,
}

export interface ResolvedCliControls extends Omit<
  CliControls,
  | 'settings'
  | 'systemPromptFile'
  | 'appendSystemPromptFile'
  | 'addDirectories'
  | 'fileResources'
> {
  additionalSettings: JsonResource | undefined
  inlineAgents: readonly TextResource[]
  mcpResources: readonly JsonResource[]
  systemPrompt: string | undefined
  appendSystemPrompt: string | undefined
  additionalDirectories: readonly string[]
  fileResources: readonly FileResource[]
}

function absolutePath(cwd: string, path: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path)
}

function parseSettings(source: string, path: string): JsonResource {
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
): Promise<JsonResource | undefined> {
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

function parseObject(source: string, label: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch (error) {
    throw new Error(`Invalid ${label} JSON`, { cause: error })
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} JSON must be an object`)
  }
  return value as Record<string, unknown>
}

async function resolveMcpConfigs(
  cwd: string,
  values: readonly string[],
): Promise<JsonResource[]> {
  return Promise.all(
    values.map(async (value, index) => {
      const path = value.trimStart().startsWith('{')
        ? `<command-line:${index + 1}>`
        : absolutePath(cwd, value)
      const source = value.trimStart().startsWith('{')
        ? value
        : await readFile(path, 'utf8')
      const parsed = parseObject(source, 'MCP config')
      if (
        parsed.mcpServers !== undefined &&
        (!parsed.mcpServers ||
          typeof parsed.mcpServers !== 'object' ||
          Array.isArray(parsed.mcpServers))
      ) {
        throw new Error(`MCP config mcpServers must be an object: ${path}`)
      }
      return { path, scope: 'local' as const, value: parsed }
    }),
  )
}

function resolveInlineAgents(source: string | undefined): TextResource[] {
  if (source === undefined) return []
  const parsed = parseObject(source, 'agents')
  return Object.entries(parsed).map(([name, value]) => {
    if (!name || !value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`Agent ${name || '<empty>'} must be an object`)
    }
    const record = value as Record<string, unknown>
    if (typeof record.prompt !== 'string' || record.prompt.length === 0) {
      throw new Error(`Agent ${name} requires a non-empty prompt`)
    }
    if (
      record.description !== undefined &&
      typeof record.description !== 'string'
    ) {
      throw new Error(`Agent ${name} description must be a string`)
    }
    const metadata = stringifyYaml({
      name,
      description: record.description ?? '',
      ...(record['disable-model-invocation'] === undefined
        ? {}
        : { 'disable-model-invocation': record['disable-model-invocation'] }),
    }).trimEnd()
    return {
      path: `<command-line-agent:${name}>`,
      scope: 'local',
      content: `---\n${metadata}\n---\n${record.prompt}`,
    }
  })
}

function parseFileSpecs(values: readonly string[]): FileResource[] {
  const resources: FileResource[] = []
  for (const value of values) {
    for (const spec of value.split(/\s+/u).filter(Boolean)) {
      const separator = spec.indexOf(':')
      if (separator <= 0 || separator === spec.length - 1) {
        throw new Error(
          `Invalid --file spec ${spec}; expected file_id:relative_path`,
        )
      }
      const fileId = spec.slice(0, separator)
      const relativePath = spec.slice(separator + 1).replaceAll('\\', '/')
      if (!fileId || /[\\/\s\0]/u.test(fileId))
        throw new Error(`Invalid --file file ID: ${fileId}`)
      if (
        !relativePath ||
        relativePath.includes('\0') ||
        isAbsolute(relativePath)
      )
        throw new Error(
          `Invalid file resource path: ${relativePath || '<empty>'}`,
        )
      const normalized = normalize(relativePath)
      if (
        normalized === '.' ||
        normalized === '..' ||
        normalized.startsWith('../')
      )
        throw new Error(
          `File resource path escapes the session uploads directory: ${relativePath}`,
        )
      resources.push({ fileId, relativePath: normalized })
    }
  }
  return resources
}

export async function resolveCliControls(
  controls: CliControls,
  cwd: string,
): Promise<ResolvedCliControls> {
  const [
    additionalSettings,
    systemPrompt,
    appendSystemPrompt,
    directories,
    mcpResources,
  ] = await Promise.all([
    resolveSettings(cwd, controls.settings),
    controls.systemPromptFile
      ? readFile(absolutePath(cwd, controls.systemPromptFile), 'utf8')
      : Promise.resolve(controls.systemPrompt),
    controls.appendSystemPromptFile
      ? readFile(absolutePath(cwd, controls.appendSystemPromptFile), 'utf8')
      : Promise.resolve(controls.appendSystemPrompt),
    resolveDirectories(cwd, controls.addDirectories),
    resolveMcpConfigs(cwd, controls.mcpConfigs),
  ])

  return {
    ...(controls.autocompact === undefined
      ? {}
      : { autocompact: controls.autocompact }),
    settingSources: controls.settingSources,
    safeMode: controls.safeMode,
    bare: controls.bare,
    trustProject: controls.trustProject,
    systemPrompt,
    appendSystemPrompt,
    excludeDynamicSystemPromptSections:
      controls.excludeDynamicSystemPromptSections,
    tools: controls.tools,
    allowedTools: controls.allowedTools,
    disallowedTools: controls.disallowedTools,
    permissionMode: controls.permissionMode,
    ...(controls.permissionPromptTool === undefined
      ? {}
      : { permissionPromptTool: controls.permissionPromptTool }),
    init: controls.init,
    initOnly: controls.initOnly,
    maintenance: controls.maintenance,
    dangerouslySkipPermissions: controls.dangerouslySkipPermissions,
    allowDangerouslySkipPermissions: controls.allowDangerouslySkipPermissions,
    continueSession: controls.continueSession,
    forkSession: controls.forkSession,
    resumeSessionAt: controls.resumeSessionAt,
    ...(controls.rewindFiles === undefined
      ? {}
      : { rewindFiles: controls.rewindFiles }),
    name: controls.name,
    sessionPersistence: controls.sessionPersistence,
    ...(controls.model === undefined ? {} : { model: controls.model }),
    ...(controls.effort === undefined ? {} : { effort: controls.effort }),
    ...(controls.thinking === undefined ? {} : { thinking: controls.thinking }),
    ...(controls.maxThinkingTokens === undefined
      ? {}
      : { maxThinkingTokens: controls.maxThinkingTokens }),
    ...(controls.fallbackModels === undefined
      ? {}
      : { fallbackModels: controls.fallbackModels }),
    ...(controls.jsonSchema === undefined
      ? {}
      : { jsonSchema: controls.jsonSchema }),
    ...(controls.maxBudgetUsd === undefined
      ? {}
      : { maxBudgetUsd: controls.maxBudgetUsd }),
    prefill: controls.prefill,
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
    betas: controls.betas,
    ...(controls.debug === undefined ? {} : { debug: controls.debug }),
    ...(controls.debugFile === undefined
      ? {}
      : { debugFile: controls.debugFile }),
    ...(controls.brief ? { brief: true } : {}),
    ...(controls.axScreenReader ? { axScreenReader: true } : {}),
    forwardSubagentText: controls.forwardSubagentText,
    fileResources: parseFileSpecs(controls.fileResources),
    ...(controls.maxTurns === undefined ? {} : { maxTurns: controls.maxTurns }),
    inlineAgents: resolveInlineAgents(controls.agentDefinitions),
    mcpResources,
    mcpConfigs: controls.mcpConfigs,
    strictMcpConfig: controls.strictMcpConfig,
    disableSlashCommands: controls.disableSlashCommands,
  }
}
