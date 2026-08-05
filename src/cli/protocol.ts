import { randomUUID } from 'node:crypto'

import type {
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
}

export interface CliInvocation extends CliControls {
  command: string | undefined
  args: string[]
  agent: string | undefined
  inputFormat: CliInputFormat
  outputFormat: CliOutputFormat
  includePartialMessages: boolean
  replayUserMessages: boolean
  retryInterruptedTools: boolean
  sessionId: string | undefined
  verbose: boolean
  legacyJson: boolean
}

export interface StreamUserMessage {
  message: {
    role: 'user'
    content: string | readonly { type: 'text'; text: string }[]
  }
  prompt: string
}

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
}

export function createSuccessResult(
  result: ProtocolResult,
  info: CliRuntimeInfo,
  startedAt: number,
  modelTurns: number,
): Record<string, unknown> {
  const duration = Date.now() - startedAt
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: duration,
    duration_api_ms: null,
    num_turns: modelTurns,
    result: result.text,
    session_id: result.sessionId,
    total_cost_usd: null,
    usage: {
      input_tokens: result.usage.inputTokens,
      output_tokens: result.usage.outputTokens,
    },
    modelUsage: {
      [info.model]: {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUSD: null,
      },
    },
    permission_denials: [],
    structured_output: null,
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
const MAX_INPUT_LINE_BYTES = 1024 * 1024
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
    if (value === '-r' || value === '--resume') {
      if (resumeId !== undefined)
        throw new Error('--resume may only be specified once')
      resumeId = requiredValue(argv, index, '--resume')
      index += 1
      continue
    }
    if (value === '-p' || value === '--print') continue
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
    throw new Error(`Unknown option: ${value}`)
  }

  if (legacyJson) {
    if (outputFormat !== 'text') {
      throw new Error('--json cannot be combined with --output-format')
    }
    outputFormat = 'stream-json'
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

  if (resumeId !== undefined) {
    if (args[0] === 'resume')
      throw new Error('resume command cannot be combined with --resume')
    args.unshift('resume', resumeId)
  }
  if (sessionId !== undefined && !UUID_PATTERN.test(sessionId)) {
    throw new Error('--session-id must be a valid UUID')
  }
  const resumesSession = args[0] === 'resume' || continueSession
  if (sessionId !== undefined && resumesSession && !forkSession) {
    throw new Error(
      '--session-id can only be used with --continue or --resume if --fork-session is also specified',
    )
  }
  if (
    sessionId !== undefined &&
    ['fork', 'sessions', 'inspect', 'export'].includes(args[0] ?? '')
  ) {
    throw new Error('--session-id is only valid when starting a session')
  }
  return {
    command: args[0],
    args,
    agent,
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
  const blocks = content.map((block) => {
    if (
      !block ||
      typeof block !== 'object' ||
      Array.isArray(block) ||
      (block as Record<string, unknown>).type !== 'text' ||
      typeof (block as Record<string, unknown>).text !== 'string'
    ) {
      throw new Error(
        `stream-json input line ${lineNumber} contains unsupported content`,
      )
    }
    return { type: 'text' as const, text: (block as { text: string }).text }
  })
  const prompt = blocks.map((block) => block.text).join('')
  if (prompt.trim().length === 0) {
    throw new Error(
      `stream-json input line ${lineNumber} has empty user content`,
    )
  }
  return { message: { role: 'user', content: blocks }, prompt }
}

export async function* readStreamUserMessages(
  input: AsyncIterable<string | Uint8Array>,
): AsyncGenerator<StreamUserMessage> {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let buffer = ''
  let lineNumber = 0
  const parseLine = (line: string): StreamUserMessage | null => {
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
    return parseUserMessage(value, lineNumber)
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

  readonly sink: RuntimeEventSink = (event) => this.onEvent(event)

  result(result: ProtocolResult, startedAt: number): void {
    this.finishTurn()
    this.write(
      createSuccessResult(result, this.info, startedAt, this.modelTurns),
    )
    this.modelTurns = 0
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
