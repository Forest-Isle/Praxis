import { randomUUID } from 'node:crypto'

import type {
  ModelDocument,
  ModelDocumentMediaType,
  ModelImage,
  ModelImageMediaType,
  ModelToolCall,
  ModelUsage,
  RuntimeEvent,
  RuntimeEventSink,
} from '../core/runtime.js'

export type CliInputFormat = 'text' | 'stream-json'
export type CliOutputFormat = 'text' | 'json' | 'stream-json'
export type CliPermissionMode =
  | 'acceptEdits'
  | 'auto'
  | 'bypassPermissions'
  | 'manual'
  | 'dontAsk'
  | 'plan'
  | 'default'

export type CliMcpScope = 'local' | 'project' | 'user'

export interface CliControls {
  settings: string | undefined
  settingSources: readonly ('user' | 'project' | 'local')[] | undefined
  safeMode: boolean
  bare: boolean
  systemPrompt: string | undefined
  systemPromptFile: string | undefined
  appendSystemPrompt: string | undefined
  appendSystemPromptFile: string | undefined
  addDirectories: readonly string[]
  pluginDirectories: readonly string[]
  pluginUrls: readonly string[]
  tools: readonly string[] | undefined
  allowedTools: readonly string[]
  disallowedTools: readonly string[]
  permissionMode: CliPermissionMode
  dangerouslySkipPermissions: boolean
  allowDangerouslySkipPermissions: boolean
  continueSession: boolean
  forkSession: boolean
  name: string | undefined
  sessionPersistence: boolean
  model?: string
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  fallbackModels?: readonly string[]
  jsonSchema?: Record<string, unknown>
  maxBudgetUsd?: number
  promptSuggestions?: boolean
  worktreeName?: string
  worktreeRequested?: boolean
  tmux?: 'classic'
}

export interface CliInvocation extends CliControls {
  command: string | undefined
  args: string[]
  agent: string | undefined
  background: boolean
  print: boolean
  agentsAll: boolean
  agentsCwd: string | undefined
  inputFormat: CliInputFormat
  outputFormat: CliOutputFormat
  includePartialMessages: boolean
  replayUserMessages: boolean
  retryInterruptedTools: boolean
  sessionId: string | undefined
  verbose: boolean
  legacyJson: boolean
  mcpScope?: CliMcpScope
}

export interface StreamUserMessage {
  message: {
    role: 'user'
    content:
      | string
      | readonly (
          | { type: 'text'; text: string }
          | {
              type: 'image'
              source: {
                type: 'base64'
                media_type: ModelImageMediaType
                data: string
              }
            }
          | {
              type: 'document'
              source: {
                type: 'base64'
                media_type: ModelDocumentMediaType
                data: string
              }
            }
        )[]
  }
  prompt: string
  images?: readonly ModelImage[]
  documents?: readonly ModelDocument[]
}

export interface StreamControlResponse {
  type: 'control_response'
  response:
    | {
        subtype: 'success'
        request_id: string
        response?: Record<string, unknown>
      }
    | { subtype: 'error'; request_id: string; error: string }
}

export interface StreamControlCancelRequest {
  type: 'control_cancel_request'
  request_id: string
}

export interface StreamControlRequest {
  type: 'control_request'
  request_id: string
  request: { subtype: 'interrupt' }
}

export type StreamJsonMessage =
  | StreamUserMessage
  | StreamControlResponse
  | StreamControlCancelRequest
  | StreamControlRequest

export interface CliRuntimeInfo {
  cwd: string
  model: string
  tools: readonly string[]
  mcpServers: readonly { name: string; status: string }[]
  permissionMode: string
  slashCommands: readonly string[]
  agents: readonly string[]
  skills: readonly string[]
  claudeCodeVersion: string
}

export interface ProtocolResult {
  sessionId: string
  text: string
  usage: ModelUsage
  structuredOutput?: unknown
  durationApiMs?: number
  costUsd?: number
  modelUsage?: Readonly<Record<string, ModelUsage>>
}

export function createSuccessResult(
  result: ProtocolResult,
  info: CliRuntimeInfo,
  startedAt: number,
  modelTurns: number,
): Record<string, unknown> {
  const duration = Date.now() - startedAt
  const modelUsage = result.modelUsage ?? { [info.model]: result.usage }
  const usage = {
    input_tokens: result.usage.inputTokens,
    output_tokens: result.usage.outputTokens,
    ...(result.usage.cacheReadInputTokens === undefined
      ? {}
      : { cache_read_input_tokens: result.usage.cacheReadInputTokens }),
    ...(result.usage.cacheCreationInputTokens === undefined
      ? {}
      : {
          cache_creation_input_tokens: result.usage.cacheCreationInputTokens,
        }),
  }
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: duration,
    duration_api_ms:
      result.durationApiMs === undefined
        ? null
        : Math.round(result.durationApiMs),
    num_turns: modelTurns,
    result: result.text,
    session_id: result.sessionId,
    total_cost_usd: result.costUsd ?? null,
    usage,
    modelUsage: Object.fromEntries(
      Object.entries(modelUsage).map(([model, modelUsage]) => [
        model,
        {
          inputTokens: modelUsage.inputTokens,
          outputTokens: modelUsage.outputTokens,
          cacheReadInputTokens: modelUsage.cacheReadInputTokens ?? 0,
          cacheCreationInputTokens: modelUsage.cacheCreationInputTokens ?? 0,
          costUSD: model === info.model ? (result.costUsd ?? null) : null,
        },
      ]),
    ),
    permission_denials: [],
    structured_output: result.structuredOutput ?? null,
  }
}

export function createErrorResult(
  message: string,
  sessionId: string,
  startedAt: number,
  modelTurns: number,
): Record<string, unknown> {
  const duration = Date.now() - startedAt
  return {
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    duration_ms: duration,
    duration_api_ms: null,
    num_turns: modelTurns,
    result: message,
    session_id: sessionId,
    total_cost_usd: null,
    usage: { input_tokens: 0, output_tokens: 0 },
    permission_denials: [],
  }
}

const INPUT_FORMATS = ['text', 'stream-json'] as const
const OUTPUT_FORMATS = ['text', 'json', 'stream-json'] as const
const PERMISSION_MODES = [
  'acceptEdits',
  'auto',
  'bypassPermissions',
  'manual',
  'dontAsk',
  'plan',
  'default',
] as const
const SETTING_SOURCES = ['user', 'project', 'local'] as const
const MCP_SCOPES = ['local', 'project', 'user'] as const
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
const MAX_INPUT_LINE_BYTES = 1024 * 1024
const IMAGE_MEDIA_TYPES = new Set<ModelImageMediaType>([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
])
const DOCUMENT_MEDIA_TYPES = new Set<ModelDocumentMediaType>([
  'application/pdf',
  'text/plain',
  'text/markdown',
  'application/json',
])

function isBase64Data(value: string): boolean {
  return (
    value.length > 0 &&
    value.length % 4 === 0 &&
    /^[A-Za-z0-9+/]*={0,2}$/.test(value) &&
    Buffer.from(value, 'base64').toString('base64') === value
  )
}
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function requiredValue(
  argv: readonly string[],
  index: number,
  label: string,
): string {
  const value = argv[index + 1]
  if (!value || value.startsWith('-')) throw new Error(`${label} is required`)
  return value
}

function choice<T extends string>(
  value: string,
  label: string,
  choices: readonly T[],
): T {
  if (!choices.includes(value as T)) {
    throw new Error(`${label} must be one of ${choices.join(', ')}`)
  }
  return value as T
}

function positiveDecimal(value: string, label: string): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive number`)
  }
  return parsed
}

function optionValue(
  argv: readonly string[],
  index: number,
  option: string,
): { value: string; consumed: number } | null {
  const current = argv[index]
  if (current === option) {
    return { value: requiredValue(argv, index, option), consumed: 1 }
  }
  const prefix = `${option}=`
  if (current?.startsWith(prefix)) {
    const value = current.slice(prefix.length)
    if (!value) throw new Error(`${option} is required`)
    return { value, consumed: 0 }
  }
  return null
}

function listOptionValue(
  argv: readonly string[],
  index: number,
  options: readonly string[],
): { values: string[]; consumed: number } | null {
  const current = argv[index]
  const option = options.find((candidate) => current === candidate)
  if (option) {
    const values: string[] = []
    let consumed = 0
    while (index + consumed + 1 < argv.length) {
      const candidate = argv[index + consumed + 1]
      if (candidate === undefined || candidate === '--') break
      if (candidate.startsWith('-') && candidate !== '-') break
      values.push(candidate)
      consumed += 1
    }
    if (values.length === 0) throw new Error(`${option} is required`)
    return { values, consumed }
  }
  for (const candidate of options) {
    const prefix = `${candidate}=`
    if (current?.startsWith(prefix)) {
      return { values: [current.slice(prefix.length)], consumed: 0 }
    }
  }
  return null
}

function splitList(values: readonly string[]): string[] {
  return values.flatMap((value) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  )
}

export function parseCliInvocation(argv: readonly string[]): CliInvocation {
  const args: string[] = []
  let agent: string | undefined
  let background = false
  let print = false
  let agentsAll = false
  let agentsCwd: string | undefined
  let inputFormat: CliInputFormat = 'text'
  let outputFormat: CliOutputFormat = 'text'
  let includePartialMessages = false
  let replayUserMessages = false
  let retryInterruptedTools = false
  let sessionId: string | undefined
  let resumeId: string | undefined
  let verbose = false
  let legacyJson = false
  let optionsEnded = false
  let settings: string | undefined
  let settingSources: ('user' | 'project' | 'local')[] | undefined
  let safeMode = false
  let bare = false
  let systemPrompt: string | undefined
  let systemPromptFile: string | undefined
  let appendSystemPrompt: string | undefined
  let appendSystemPromptFile: string | undefined
  const addDirectories: string[] = []
  const pluginDirectories: string[] = []
  const pluginUrls: string[] = []
  let tools: string[] | undefined
  const allowedTools: string[] = []
  const disallowedTools: string[] = []
  let permissionMode: CliPermissionMode = 'default'
  let dangerouslySkipPermissions = false
  let allowDangerouslySkipPermissions = false
  let continueSession = false
  let forkSession = false
  let name: string | undefined
  let sessionPersistence = true
  let worktreeName: string | undefined
  let worktreeRequested = false
  let tmux: 'classic' | undefined
  let model: string | undefined
  let effort: (typeof EFFORT_LEVELS)[number] | undefined
  let fallbackModels: string[] | undefined
  let jsonSchema: Record<string, unknown> | undefined
  let maxBudgetUsd: number | undefined
  let promptSuggestions = false
  let mcpScope: CliMcpScope | undefined

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === undefined) continue
    if (!optionsEnded && value === '--') {
      optionsEnded = true
      continue
    }
    if (optionsEnded || !value.startsWith('-') || value === '-') {
      args.push(value)
      continue
    }

    const input = optionValue(argv, index, '--input-format')
    if (input) {
      inputFormat = choice(input.value, '--input-format', INPUT_FORMATS)
      index += input.consumed
      continue
    }
    const output = optionValue(argv, index, '--output-format')
    if (output) {
      outputFormat = choice(output.value, '--output-format', OUTPUT_FORMATS)
      index += output.consumed
      continue
    }
    const selectedAgent = optionValue(argv, index, '--agent')
    if (selectedAgent) {
      if (agent !== undefined)
        throw new Error('--agent may only be specified once')
      agent = selectedAgent.value
      index += selectedAgent.consumed
      continue
    }
    const selectedModel = optionValue(argv, index, '--model')
    if (selectedModel) {
      if (model !== undefined)
        throw new Error('--model may only be specified once')
      model = selectedModel.value
      index += selectedModel.consumed
      continue
    }
    const selectedEffort = optionValue(argv, index, '--effort')
    if (selectedEffort) {
      if (effort !== undefined)
        throw new Error('--effort may only be specified once')
      effort = choice(selectedEffort.value, '--effort', EFFORT_LEVELS)
      index += selectedEffort.consumed
      continue
    }
    const selectedFallback = optionValue(argv, index, '--fallback-model')
    if (selectedFallback) {
      if (fallbackModels !== undefined)
        throw new Error('--fallback-model may only be specified once')
      fallbackModels = splitList([selectedFallback.value])
      if (fallbackModels.length === 0)
        throw new Error('--fallback-model requires at least one model')
      index += selectedFallback.consumed
      continue
    }
    const selectedSchema = optionValue(argv, index, '--json-schema')
    if (selectedSchema) {
      if (jsonSchema !== undefined)
        throw new Error('--json-schema may only be specified once')
      let parsed: unknown
      try {
        parsed = JSON.parse(selectedSchema.value)
      } catch (error) {
        throw new Error('--json-schema must be valid JSON', { cause: error })
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('--json-schema must be a JSON object')
      }
      jsonSchema = parsed as Record<string, unknown>
      index += selectedSchema.consumed
      continue
    }
    const selectedBudget = optionValue(argv, index, '--max-budget-usd')
    if (selectedBudget) {
      if (maxBudgetUsd !== undefined)
        throw new Error('--max-budget-usd may only be specified once')
      maxBudgetUsd = positiveDecimal(selectedBudget.value, '--max-budget-usd')
      index += selectedBudget.consumed
      continue
    }
    const selectedMcpScope = optionValue(argv, index, '--scope')
    if (selectedMcpScope) {
      if (mcpScope !== undefined)
        throw new Error('--scope may only be specified once')
      mcpScope = choice(selectedMcpScope.value, '--scope', MCP_SCOPES)
      index += selectedMcpScope.consumed
      continue
    }
    const selectedCwd = optionValue(argv, index, '--cwd')
    if (selectedCwd) {
      if (agentsCwd !== undefined)
        throw new Error('--cwd may only be specified once')
      agentsCwd = selectedCwd.value
      index += selectedCwd.consumed
      continue
    }
    const selectedSession = optionValue(argv, index, '--session-id')
    if (selectedSession) {
      if (sessionId !== undefined) {
        throw new Error('--session-id may only be specified once')
      }
      sessionId = selectedSession.value
      index += selectedSession.consumed
      continue
    }
    const selectedSettings = optionValue(argv, index, '--settings')
    if (selectedSettings) {
      if (settings !== undefined)
        throw new Error('--settings may only be specified once')
      settings = selectedSettings.value
      index += selectedSettings.consumed
      continue
    }
    const selectedSources =
      value === '--setting-sources='
        ? { value: '', consumed: 0 }
        : optionValue(argv, index, '--setting-sources')
    if (selectedSources) {
      if (settingSources !== undefined)
        throw new Error('--setting-sources may only be specified once')
      const sources = splitList([selectedSources.value])
      for (const source of sources) {
        if (
          !SETTING_SOURCES.includes(source as (typeof SETTING_SOURCES)[number])
        ) {
          throw new Error(`Invalid setting source: ${source}`)
        }
      }
      settingSources = sources as ('user' | 'project' | 'local')[]
      index += selectedSources.consumed
      continue
    }
    const selectedSystemPrompt = optionValue(argv, index, '--system-prompt')
    if (selectedSystemPrompt) {
      if (systemPrompt !== undefined)
        throw new Error('--system-prompt may only be specified once')
      systemPrompt = selectedSystemPrompt.value
      index += selectedSystemPrompt.consumed
      continue
    }
    const selectedSystemPromptFile = optionValue(
      argv,
      index,
      '--system-prompt-file',
    )
    if (selectedSystemPromptFile) {
      if (systemPromptFile !== undefined)
        throw new Error('--system-prompt-file may only be specified once')
      systemPromptFile = selectedSystemPromptFile.value
      index += selectedSystemPromptFile.consumed
      continue
    }
    const selectedAppendPrompt = optionValue(
      argv,
      index,
      '--append-system-prompt',
    )
    if (selectedAppendPrompt) {
      if (appendSystemPrompt !== undefined)
        throw new Error('--append-system-prompt may only be specified once')
      appendSystemPrompt = selectedAppendPrompt.value
      index += selectedAppendPrompt.consumed
      continue
    }
    const selectedAppendPromptFile = optionValue(
      argv,
      index,
      '--append-system-prompt-file',
    )
    if (selectedAppendPromptFile) {
      if (appendSystemPromptFile !== undefined) {
        throw new Error(
          '--append-system-prompt-file may only be specified once',
        )
      }
      appendSystemPromptFile = selectedAppendPromptFile.value
      index += selectedAppendPromptFile.consumed
      continue
    }
    const selectedDirectories = listOptionValue(argv, index, ['--add-dir'])
    if (selectedDirectories) {
      addDirectories.push(...splitList(selectedDirectories.values))
      index += selectedDirectories.consumed
      continue
    }
    const selectedPluginDirectory = optionValue(argv, index, '--plugin-dir')
    if (selectedPluginDirectory) {
      pluginDirectories.push(selectedPluginDirectory.value)
      index += selectedPluginDirectory.consumed
      continue
    }
    const selectedPluginUrl = optionValue(argv, index, '--plugin-url')
    if (selectedPluginUrl) {
      pluginUrls.push(selectedPluginUrl.value)
      index += selectedPluginUrl.consumed
      continue
    }
    const selectedTools = listOptionValue(argv, index, ['--tools'])
    if (selectedTools) {
      if (tools !== undefined)
        throw new Error('--tools may only be specified once')
      tools = splitList(selectedTools.values)
      index += selectedTools.consumed
      continue
    }
    const selectedAllowedTools = listOptionValue(argv, index, [
      '--allowedTools',
      '--allowed-tools',
    ])
    if (selectedAllowedTools) {
      allowedTools.push(...splitList(selectedAllowedTools.values))
      index += selectedAllowedTools.consumed
      continue
    }
    const selectedDisallowedTools = listOptionValue(argv, index, [
      '--disallowedTools',
      '--disallowed-tools',
    ])
    if (selectedDisallowedTools) {
      disallowedTools.push(...splitList(selectedDisallowedTools.values))
      index += selectedDisallowedTools.consumed
      continue
    }
    const selectedPermissionMode = optionValue(argv, index, '--permission-mode')
    if (selectedPermissionMode) {
      permissionMode = choice(
        selectedPermissionMode.value,
        '--permission-mode',
        PERMISSION_MODES,
      )
      index += selectedPermissionMode.consumed
      continue
    }
    const selectedName = optionValue(argv, index, '--name')
    if (selectedName || value === '-n') {
      if (name !== undefined)
        throw new Error('--name may only be specified once')
      name = selectedName?.value ?? requiredValue(argv, index, '--name')
      index += selectedName?.consumed ?? 1
      continue
    }
    if (value === '--worktree' || value === '-w') {
      worktreeRequested = true
      const candidate = argv[index + 1]
      if (
        candidate !== undefined &&
        candidate !== '--' &&
        !candidate.startsWith('-')
      ) {
        worktreeName = candidate
        index += 1
      }
      continue
    }
    if (value.startsWith('--worktree=')) {
      worktreeRequested = true
      worktreeName = value.slice('--worktree='.length)
      if (!worktreeName) throw new Error('--worktree name must not be empty')
      continue
    }
    if (value === '--tmux' || value === '--tmux=classic') {
      if (tmux !== undefined)
        throw new Error('--tmux may only be specified once')
      tmux = 'classic'
      continue
    }
    if (value.startsWith('--tmux=')) throw new Error('--tmux must be classic')
    if (value === '-r' || value === '--resume') {
      if (resumeId !== undefined)
        throw new Error('--resume may only be specified once')
      resumeId = requiredValue(argv, index, '--resume')
      index += 1
      continue
    }
    if (value === '-p' || value === '--print') {
      print = true
      continue
    }
    if (value === '--bg' || value === '--background') {
      background = true
      continue
    }
    if (value === '--all') {
      agentsAll = true
      continue
    }
    if (value === '-c' || value === '--continue') {
      continueSession = true
      continue
    }
    if (value === '--fork-session') {
      forkSession = true
      continue
    }
    if (value === '--no-session-persistence') {
      sessionPersistence = false
      continue
    }
    if (value === '--safe-mode') {
      safeMode = true
      continue
    }
    if (value === '--bare') {
      bare = true
      continue
    }
    if (value === '--dangerously-skip-permissions') {
      dangerouslySkipPermissions = true
      continue
    }
    if (value === '--allow-dangerously-skip-permissions') {
      allowDangerouslySkipPermissions = true
      continue
    }
    if (value === '--verbose') {
      verbose = true
      continue
    }
    if (value === '--json') {
      legacyJson = true
      continue
    }
    if (value === '--include-partial-messages') {
      includePartialMessages = true
      continue
    }
    if (value === '--replay-user-messages') {
      replayUserMessages = true
      continue
    }
    if (value === '--retry-interrupted-tools') {
      retryInterruptedTools = true
      continue
    }
    if (value === '--prompt-suggestions') {
      promptSuggestions = true
      continue
    }
    if (value.startsWith('--prompt-suggestions=')) {
      const raw = value.slice('--prompt-suggestions='.length).toLowerCase()
      if (
        !['true', 'false', '1', '0', 'yes', 'no', 'on', 'off'].includes(raw)
      ) {
        throw new Error('--prompt-suggestions must be a boolean')
      }
      promptSuggestions = ['true', '1', 'yes', 'on'].includes(raw)
      continue
    }
    throw new Error(`Unknown option: ${value}`)
  }

  if (legacyJson) {
    if (outputFormat !== 'text') {
      throw new Error('--json cannot be combined with --output-format')
    }
    outputFormat = 'stream-json'
  }
  if (background && print) {
    throw new Error(
      "--bg and --print conflict: --print never starts the interactive session that `claude agents` attaches to, so the job would be unattachable. The prompt is the positional — drop --print: `claude --bg '<task>'`.",
    )
  }
  if (inputFormat === 'stream-json' && outputFormat !== 'stream-json') {
    throw new Error(
      '--input-format=stream-json requires --output-format=stream-json',
    )
  }
  if (inputFormat === 'stream-json' && legacyJson) {
    throw new Error('--input-format=stream-json cannot be combined with --json')
  }
  if (outputFormat === 'stream-json' && !verbose && !legacyJson) {
    throw new Error('--output-format=stream-json requires --verbose')
  }
  if (includePartialMessages && outputFormat !== 'stream-json') {
    throw new Error(
      '--include-partial-messages requires --output-format=stream-json',
    )
  }
  if (includePartialMessages && legacyJson) {
    throw new Error('--include-partial-messages cannot be combined with --json')
  }
  if (promptSuggestions && (!print || outputFormat !== 'stream-json')) {
    throw new Error(
      '--prompt-suggestions requires --print and --output-format=stream-json',
    )
  }
  if (
    replayUserMessages &&
    (inputFormat !== 'stream-json' || outputFormat !== 'stream-json')
  ) {
    throw new Error(
      '--replay-user-messages requires stream-json input and output',
    )
  }
  if (systemPrompt !== undefined && systemPromptFile !== undefined) {
    throw new Error('Cannot use both --system-prompt and --system-prompt-file')
  }
  if (
    appendSystemPrompt !== undefined &&
    appendSystemPromptFile !== undefined
  ) {
    throw new Error(
      'Cannot use both --append-system-prompt and --append-system-prompt-file',
    )
  }
  if (tmux !== undefined && !worktreeRequested) {
    throw new Error('--tmux requires --worktree')
  }

  if (resumeId !== undefined) {
    if (args[0] === 'resume')
      throw new Error('resume command cannot be combined with --resume')
    args.unshift('resume', resumeId)
  }
  if (sessionId !== undefined && !UUID_PATTERN.test(sessionId)) {
    throw new Error('--session-id must be a valid UUID')
  }
  const resumesSession = args[0] === 'resume' || continueSession
  if (
    sessionId !== undefined &&
    resumesSession &&
    !forkSession &&
    !background
  ) {
    throw new Error(
      '--session-id can only be used with --continue or --resume if --fork-session is also specified',
    )
  }
  if (
    sessionId !== undefined &&
    [
      'fork',
      'sessions',
      'inspect',
      'export',
      'agents',
      'attach',
      'logs',
      'stop',
    ].includes(args[0] ?? '')
  ) {
    throw new Error('--session-id is only valid when starting a session')
  }
  return {
    command: args[0],
    args,
    agent,
    background,
    print,
    agentsAll,
    agentsCwd,
    inputFormat,
    outputFormat,
    includePartialMessages,
    replayUserMessages,
    retryInterruptedTools,
    sessionId,
    verbose,
    legacyJson,
    settings,
    settingSources,
    safeMode,
    bare,
    systemPrompt,
    systemPromptFile,
    appendSystemPrompt,
    appendSystemPromptFile,
    addDirectories,
    pluginDirectories,
    pluginUrls,
    tools,
    allowedTools,
    disallowedTools,
    permissionMode,
    dangerouslySkipPermissions,
    allowDangerouslySkipPermissions,
    continueSession,
    forkSession,
    name,
    sessionPersistence,
    ...(worktreeName === undefined ? {} : { worktreeName }),
    ...(worktreeRequested ? { worktreeRequested: true } : {}),
    ...(tmux === undefined ? {} : { tmux }),
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
    ...(fallbackModels === undefined ? {} : { fallbackModels }),
    ...(jsonSchema === undefined ? {} : { jsonSchema }),
    ...(maxBudgetUsd === undefined ? {} : { maxBudgetUsd }),
    promptSuggestions,
    ...(mcpScope === undefined ? {} : { mcpScope }),
  }
}

function parseUserMessage(
  value: unknown,
  lineNumber: number,
): StreamUserMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`stream-json input line ${lineNumber} must be an object`)
  }
  const record = value as Record<string, unknown>
  if (record.type !== 'user') {
    throw new Error(`stream-json input line ${lineNumber} must have type user`)
  }
  if (
    !record.message ||
    typeof record.message !== 'object' ||
    Array.isArray(record.message)
  ) {
    throw new Error(
      `stream-json input line ${lineNumber} requires a message object`,
    )
  }
  const message = record.message as Record<string, unknown>
  if (message.role !== 'user') {
    throw new Error(
      `stream-json input line ${lineNumber} message role must be user`,
    )
  }
  const content = message.content
  if (typeof content === 'string') {
    if (content.trim().length === 0) {
      throw new Error(
        `stream-json input line ${lineNumber} has empty user content`,
      )
    }
    return { message: { role: 'user', content }, prompt: content }
  }
  if (!Array.isArray(content) || content.length === 0) {
    throw new Error(
      `stream-json input line ${lineNumber} requires text content`,
    )
  }
  const images: ModelImage[] = []
  const documents: ModelDocument[] = []
  const blocks = content.map((block) => {
    if (
      !block ||
      typeof block !== 'object' ||
      Array.isArray(block) ||
      typeof (block as Record<string, unknown>).type !== 'string'
    ) {
      throw new Error(
        `stream-json input line ${lineNumber} contains unsupported content`,
      )
    }
    const record = block as Record<string, unknown>
    if (record.type === 'text' && typeof record.text === 'string') {
      return { type: 'text' as const, text: record.text }
    }
    const source = record.source
    if (
      record.type === 'image' &&
      source &&
      typeof source === 'object' &&
      !Array.isArray(source) &&
      (source as Record<string, unknown>).type === 'base64' &&
      typeof (source as Record<string, unknown>).media_type === 'string' &&
      IMAGE_MEDIA_TYPES.has(
        (source as Record<string, unknown>).media_type as ModelImageMediaType,
      ) &&
      typeof (source as Record<string, unknown>).data === 'string' &&
      isBase64Data((source as Record<string, unknown>).data as string)
    ) {
      const image = {
        type: 'image' as const,
        mediaType: (source as Record<string, unknown>)
          .media_type as ModelImageMediaType,
        data: (source as Record<string, unknown>).data as string,
      }
      images.push(image)
      return {
        type: 'image' as const,
        source: {
          type: 'base64' as const,
          media_type: image.mediaType,
          data: image.data,
        },
      }
    }
    if (
      record.type === 'document' &&
      source &&
      typeof source === 'object' &&
      !Array.isArray(source) &&
      (source as Record<string, unknown>).type === 'base64' &&
      typeof (source as Record<string, unknown>).media_type === 'string' &&
      DOCUMENT_MEDIA_TYPES.has(
        (source as Record<string, unknown>)
          .media_type as ModelDocumentMediaType,
      ) &&
      typeof (source as Record<string, unknown>).data === 'string' &&
      isBase64Data((source as Record<string, unknown>).data as string)
    ) {
      const document = {
        type: 'document' as const,
        mediaType: (source as Record<string, unknown>)
          .media_type as ModelDocumentMediaType,
        data: (source as Record<string, unknown>).data as string,
      }
      documents.push(document)
      return {
        type: 'document' as const,
        source: {
          type: 'base64' as const,
          media_type: document.mediaType,
          data: document.data,
        },
      }
    }
    throw new Error(
      `stream-json input line ${lineNumber} contains unsupported content`,
    )
  })
  const prompt = blocks
    .filter(
      (block): block is { type: 'text'; text: string } => block.type === 'text',
    )
    .map((block) => block.text)
    .join('')
  if (
    prompt.trim().length === 0 &&
    images.length === 0 &&
    documents.length === 0
  ) {
    throw new Error(
      `stream-json input line ${lineNumber} has empty user content`,
    )
  }
  return {
    message: { role: 'user', content: blocks },
    prompt,
    ...(images.length > 0 ? { images } : {}),
    ...(documents.length > 0 ? { documents } : {}),
  }
}

function parseStreamJsonMessage(
  value: unknown,
  lineNumber: number,
): StreamJsonMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`stream-json input line ${lineNumber} must be an object`)
  }
  const record = value as Record<string, unknown>
  if (record.type === 'user') return parseUserMessage(value, lineNumber)
  if (record.type === 'control_cancel_request') {
    if (
      typeof record.request_id !== 'string' ||
      record.request_id.length === 0
    ) {
      throw new Error(
        `stream-json input line ${lineNumber} has invalid request_id`,
      )
    }
    return { type: 'control_cancel_request', request_id: record.request_id }
  }
  if (record.type === 'control_request') {
    const request = record.request
    if (
      typeof record.request_id !== 'string' ||
      record.request_id.length === 0 ||
      !request ||
      typeof request !== 'object' ||
      Array.isArray(request) ||
      (request as Record<string, unknown>).subtype !== 'interrupt'
    ) {
      throw new Error(
        `stream-json input line ${lineNumber} has invalid interrupt request`,
      )
    }
    return {
      type: 'control_request',
      request_id: record.request_id,
      request: { subtype: 'interrupt' },
    }
  }
  if (record.type === 'control_response') {
    const response = record.response
    if (!response || typeof response !== 'object' || Array.isArray(response)) {
      throw new Error(
        `stream-json input line ${lineNumber} has invalid control response`,
      )
    }
    const responseRecord = response as Record<string, unknown>
    if (
      typeof responseRecord.request_id !== 'string' ||
      responseRecord.request_id.length === 0
    ) {
      throw new Error(
        `stream-json input line ${lineNumber} has invalid request_id`,
      )
    }
    if (responseRecord.subtype === 'success') {
      if (
        responseRecord.response !== undefined &&
        (!responseRecord.response ||
          typeof responseRecord.response !== 'object' ||
          Array.isArray(responseRecord.response))
      ) {
        throw new Error(
          `stream-json input line ${lineNumber} has invalid success response`,
        )
      }
      return {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: responseRecord.request_id,
          ...(responseRecord.response === undefined
            ? {}
            : { response: responseRecord.response as Record<string, unknown> }),
        },
      }
    }
    if (
      responseRecord.subtype === 'error' &&
      typeof responseRecord.error === 'string'
    ) {
      return {
        type: 'control_response',
        response: {
          subtype: 'error',
          request_id: responseRecord.request_id,
          error: responseRecord.error,
        },
      }
    }
    throw new Error(
      `stream-json input line ${lineNumber} has invalid control response`,
    )
  }
  throw new Error(
    `stream-json input line ${lineNumber} must have type user or a supported control type`,
  )
}

export async function* readStreamJsonMessages(
  input: AsyncIterable<string | Uint8Array>,
): AsyncGenerator<StreamJsonMessage> {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let buffer = ''
  let lineNumber = 0
  const parseLine = (line: string): StreamJsonMessage | null => {
    lineNumber += 1
    if (line.trim().length === 0) return null
    if (Buffer.byteLength(line) > MAX_INPUT_LINE_BYTES) {
      throw new Error(
        `stream-json input line ${lineNumber} exceeds ${MAX_INPUT_LINE_BYTES} bytes`,
      )
    }
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      throw new Error(`Invalid stream-json input at line ${lineNumber}`)
    }
    return parseStreamJsonMessage(value, lineNumber)
  }

  try {
    for await (const chunk of input) {
      buffer +=
        typeof chunk === 'string'
          ? chunk
          : decoder.decode(chunk, { stream: true })
      if (
        Buffer.byteLength(buffer) > MAX_INPUT_LINE_BYTES &&
        !buffer.includes('\n')
      ) {
        throw new Error(
          `stream-json input line ${lineNumber + 1} exceeds ${MAX_INPUT_LINE_BYTES} bytes`,
        )
      }
      for (;;) {
        const newline = buffer.indexOf('\n')
        if (newline < 0) break
        const line = buffer.slice(0, newline).replace(/\r$/, '')
        buffer = buffer.slice(newline + 1)
        const message = parseLine(line)
        if (message) yield message
      }
    }
    buffer += decoder.decode()
  } catch (error) {
    if (error instanceof TypeError)
      throw new Error('stream-json input is not valid UTF-8')
    throw error
  }
  if (buffer.length > 0) {
    const message = parseLine(buffer.replace(/\r$/, ''))
    if (message) yield message
  }
}

export async function* readStreamUserMessages(
  input: AsyncIterable<string | Uint8Array>,
): AsyncGenerator<StreamUserMessage> {
  for await (const message of readStreamJsonMessages(input)) {
    if (!('type' in message)) yield message
  }
}

const emptyUsage = (): ModelUsage => ({ inputTokens: 0, outputTokens: 0 })

export class StreamJsonOutput {
  private turnId = randomUUID()
  private turnText = ''
  private turnCalls: ModelToolCall[] = []
  private turnUsage = emptyUsage()
  private turnActive = false
  private assistantFlushed = true
  private contentStarted = false
  private modelTurns = 0

  constructor(
    private readonly write: (value: unknown) => void,
    private readonly info: CliRuntimeInfo,
    private readonly sessionId: string,
    private readonly includePartialMessages: boolean,
  ) {}

  init(): void {
    this.write({
      type: 'system',
      subtype: 'init',
      cwd: this.info.cwd,
      session_id: this.sessionId,
      tools: this.info.tools,
      mcp_servers: this.info.mcpServers,
      model: this.info.model,
      permissionMode: this.info.permissionMode,
      slash_commands: this.info.slashCommands,
      apiKeySource: 'PRAXIS_API_KEY',
      praxis_version: '0.1.0',
      claude_code_version: this.info.claudeCodeVersion,
      agents: this.info.agents,
      skills: this.info.skills,
    })
  }

  replayUser(message: StreamUserMessage['message']): void {
    this.write({ type: 'user', message, session_id: this.sessionId })
  }

  controlRequest(request: {
    request_id: string
    request: Record<string, unknown>
  }): void {
    this.write({ type: 'control_request', ...request })
  }

  readonly sink: RuntimeEventSink = (event) => this.onEvent(event)

  result(result: ProtocolResult, startedAt: number): void {
    this.finishTurn()
    this.write(
      createSuccessResult(result, this.info, startedAt, this.modelTurns),
    )
    this.modelTurns = 0
  }

  promptSuggestion(suggestion: string): void {
    this.write({
      type: 'prompt_suggestion',
      suggestion,
      uuid: randomUUID(),
      session_id: this.sessionId,
    })
  }

  error(message: string, startedAt: number): void {
    this.finishTurn()
    this.write(
      createErrorResult(message, this.sessionId, startedAt, this.modelTurns),
    )
    this.modelTurns = 0
  }

  private onEvent(event: RuntimeEvent): void {
    if (event.type === 'state') {
      if (event.state === 'awaiting-model') this.startTurn()
      else if (
        event.state === 'awaiting-permission' ||
        event.state === 'executing-tools' ||
        event.state === 'persisting-results' ||
        event.state === 'completed'
      ) {
        this.flushAssistant()
      }
      return
    }
    if (event.type === 'text-delta') {
      this.ensureTurn()
      this.turnText += event.delta
      this.partialText(event.delta)
      return
    }
    if (event.type === 'tool-call') {
      this.ensureTurn()
      this.turnCalls.push(event.call)
      return
    }
    if (event.type === 'usage') {
      this.turnUsage = event.usage
      return
    }
    if (event.type === 'permission-decision') {
      this.flushAssistant()
      return
    }
    if (event.type === 'tool-result') {
      this.flushAssistant()
      this.write({
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              tool_use_id: event.callId,
              type: 'tool_result',
              content: event.content,
              ...(event.isError ? { is_error: true } : {}),
            },
          ],
        },
        parent_tool_use_id: null,
        session_id: this.sessionId,
      })
      return
    }
    if (event.type === 'warning') {
      this.write({
        type: 'system',
        subtype: 'warning',
        message: event.message,
        session_id: this.sessionId,
      })
      return
    }
    if (event.type === 'failed') {
      this.ensureTurn()
      if (this.turnText.length === 0 && this.turnCalls.length === 0) {
        this.turnText = event.message
        this.partialText(event.message)
      }
      this.flushAssistant()
    }
  }

  private ensureTurn(): void {
    if (!this.turnActive) this.startTurn()
  }

  private startTurn(): void {
    if (this.turnActive) this.finishTurn()
    this.turnId = randomUUID()
    this.turnText = ''
    this.turnCalls = []
    this.turnUsage = emptyUsage()
    this.turnActive = true
    this.assistantFlushed = false
    this.contentStarted = false
    this.modelTurns += 1
    if (this.includePartialMessages) {
      this.write({
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: {
            id: this.turnId,
            type: 'message',
            role: 'assistant',
            model: this.info.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        },
        parent_tool_use_id: null,
        session_id: this.sessionId,
      })
    }
  }

  private partialText(delta: string): void {
    if (!this.includePartialMessages) return
    if (!this.contentStarted) {
      this.contentStarted = true
      this.write({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        },
        parent_tool_use_id: null,
        session_id: this.sessionId,
      })
    }
    this.write({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: delta },
      },
      parent_tool_use_id: null,
      session_id: this.sessionId,
    })
  }

  private finishPartial(): void {
    if (!this.includePartialMessages) return
    if (this.contentStarted) {
      this.write({
        type: 'stream_event',
        event: { type: 'content_block_stop', index: 0 },
        parent_tool_use_id: null,
        session_id: this.sessionId,
      })
    }
    const toolOffset = this.contentStarted ? 1 : 0
    for (const [toolIndex, call] of this.turnCalls.entries()) {
      const index = toolOffset + toolIndex
      this.write({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index,
          content_block: {
            type: 'tool_use',
            id: call.id,
            name: call.name,
            input: {},
          },
        },
        parent_tool_use_id: null,
        session_id: this.sessionId,
      })
      this.write({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index,
          delta: {
            type: 'input_json_delta',
            partial_json: JSON.stringify(call.input),
          },
        },
        parent_tool_use_id: null,
        session_id: this.sessionId,
      })
      this.write({
        type: 'stream_event',
        event: { type: 'content_block_stop', index },
        parent_tool_use_id: null,
        session_id: this.sessionId,
      })
    }
    this.write({
      type: 'stream_event',
      event: {
        type: 'message_delta',
        delta: {
          stop_reason: this.turnCalls.length > 0 ? 'tool_use' : 'end_turn',
          stop_sequence: null,
        },
        usage: { output_tokens: this.turnUsage.outputTokens },
      },
      parent_tool_use_id: null,
      session_id: this.sessionId,
    })
    this.write({
      type: 'stream_event',
      event: { type: 'message_stop' },
      parent_tool_use_id: null,
      session_id: this.sessionId,
    })
  }

  private flushAssistant(): void {
    if (!this.turnActive || this.assistantFlushed) return
    this.assistantFlushed = true
    this.finishPartial()
    const content: Record<string, unknown>[] = []
    if (this.turnText.length > 0)
      content.push({ type: 'text', text: this.turnText })
    content.push(
      ...this.turnCalls.map((call) => ({
        type: 'tool_use',
        id: call.id,
        name: call.name,
        input: call.input,
      })),
    )
    this.write({
      type: 'assistant',
      message: {
        id: this.turnId,
        type: 'message',
        role: 'assistant',
        model: this.info.model,
        content,
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: this.turnUsage.inputTokens,
          output_tokens: this.turnUsage.outputTokens,
        },
      },
      parent_tool_use_id: null,
      session_id: this.sessionId,
    })
  }

  private finishTurn(): void {
    this.flushAssistant()
    this.turnActive = false
  }
}
