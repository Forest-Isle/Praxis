#!/usr/bin/env node

import { realpathSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'

import {
  ClaudeSessionService,
  type ForkResult,
  type SessionInspection,
  type SessionRunResult,
  type SessionSummary,
} from './application/session-service.js'
import {
  ClaudeConditionalRuleResolver,
  ClaudeContextAssembler,
} from './compatibility/claude/context.js'
import {
  loadClaudeContextResources,
  loadClaudeSettings,
  loadClaudeSharedResources,
  resolveClaudeProjectMemoryDirectory,
} from './compatibility/claude/shared-resources.js'
import {
  AgentRunCancelledError,
  type ModelToolCall,
  type RuntimeEventSink,
} from './core/runtime.js'
import {
  runInteractive as renderInteractive,
  type InteractiveServiceFactory,
} from './cli/interactive.js'
import { DEFAULT_CLI_CONTROLS, resolveCliControls } from './cli/controls.js'
import { ClaudePermissionResolver } from './permissions/claude-permission-resolver.js'
import {
  ClaudeExtensionPermissionResolver,
  ClaudeExtensionToolRegistry,
} from './extensions/claude-extension-tools.js'
import { ClaudeExtensionCatalog } from './extensions/claude-extensions.js'
import { ClaudeHookRunner } from './hooks/claude-hooks.js'
import { ClaudeMcpToolRegistry } from './mcp/claude-mcp-tools.js'
import { detectInstalledClaudeVersion } from './platform/claude-version.js'
import {
  redactSensitiveText,
  sensitiveEnvironmentValues,
} from './platform/sensitive-data.js'
import { AnthropicCompatibleProvider } from './providers/anthropic-compatible.js'
import { OpenAICompatibleProvider } from './providers/openai-compatible.js'
import { LocalToolRegistry } from './tools/local-tools.js'
import { FilteredToolRegistry } from './tools/filtered-tool-registry.js'
import { WebToolRegistry } from './tools/web.js'
import {
  createErrorResult,
  createSuccessResult,
  parseCliInvocation,
  readStreamUserMessages,
  StreamJsonOutput,
  type CliOutputFormat,
  type CliControls,
  type CliRuntimeInfo,
  type StreamUserMessage,
} from './cli/protocol.js'

const VERSION = '0.1.0'

const HELP = `Praxis — local-first general agent

Usage:
  praxis
  praxis [options] [prompt]
  praxis -p [options] [prompt]
  praxis --resume <session-id> [options] [prompt]
  praxis run [options] <prompt>
  praxis resume [options] <session-id> <prompt>
  praxis fork [--json] <session-id>
  praxis sessions [--json]
  praxis inspect [--json] <session-id>
  praxis export [--json] <session-id>

Options:
  -p, --print                         Print response and exit
  -r, --resume <session-id>           Resume a session
  -c, --continue                      Continue latest session in this directory
  --fork-session                      Fork when resuming or continuing
  --session-id <uuid>                 Use an explicit ID for a new session
  -n, --name <name>                   Set session display name
  --no-session-persistence            Keep print-mode session in memory only
  --agent <name>                      Select a shared agent definition
  --settings <file-or-json>           Load additional settings
  --setting-sources <sources>         user, project, local, or an empty list
  --safe-mode                         Disable shared customizations
  --bare                              Use only explicitly supplied context
  --system-prompt <prompt>            Set system prompt
  --append-system-prompt <prompt>     Append system prompt
  --add-dir <directories...>          Allow access to additional directories
  --tools <tools...>                  Select available tools; empty disables all
  --allowedTools <tools...>           Add permission allow rules
  --disallowedTools <tools...>        Add permission deny rules
  --permission-mode <mode>            Set permission behavior
  --dangerously-skip-permissions      Bypass checks except explicit deny rules
  --allow-dangerously-skip-permissions
                                      Allow bypass mode without enabling it
  --input-format <format>             text (default) or stream-json
  --output-format <format>            text (default), json, or stream-json
  --include-partial-messages          Emit stream_event records
  --replay-user-messages              Echo stream-json user records
  --retry-interrupted-tools           Approve prepared interrupted tools
  --verbose                           Required for stream-json output
  --json                              Legacy Praxis runtime NDJSON output
  -h, --help                          Show help
  -v, --version                       Show version

Provider environment:
  PRAXIS_PROVIDER=openai|anthropic, PRAXIS_API_KEY, PRAXIS_MODEL
  PRAXIS_BASE_URL, PRAXIS_MAX_OUTPUT_TOKENS, PRAXIS_ANTHROPIC_VERSION
  PRAXIS_CONTEXT_WINDOW_TOKENS, PRAXIS_CONTEXT_RESERVE_TOKENS
`

export function parseProviderEnvironment(environment: NodeJS.ProcessEnv): {
  provider: 'openai' | 'anthropic'
  baseUrl: string
  maxOutputTokens?: number
  anthropicVersion?: string
} {
  const provider = environment.PRAXIS_PROVIDER ?? 'openai'
  if (provider !== 'openai' && provider !== 'anthropic') {
    throw new Error('PRAXIS_PROVIDER must be openai or anthropic')
  }
  const maxOutputTokens = environment.PRAXIS_MAX_OUTPUT_TOKENS
  if (
    maxOutputTokens !== undefined &&
    (!/^\d+$/.test(maxOutputTokens) ||
      Number(maxOutputTokens) <= 0 ||
      !Number.isSafeInteger(Number(maxOutputTokens)))
  ) {
    throw new Error('PRAXIS_MAX_OUTPUT_TOKENS must be a positive integer')
  }
  if (provider === 'openai' && maxOutputTokens !== undefined) {
    throw new Error(
      'PRAXIS_MAX_OUTPUT_TOKENS requires PRAXIS_PROVIDER=anthropic',
    )
  }
  const anthropicVersion = environment.PRAXIS_ANTHROPIC_VERSION
  if (provider === 'openai' && anthropicVersion !== undefined) {
    throw new Error(
      'PRAXIS_ANTHROPIC_VERSION requires PRAXIS_PROVIDER=anthropic',
    )
  }
  if (anthropicVersion !== undefined && anthropicVersion.trim().length === 0) {
    throw new Error('PRAXIS_ANTHROPIC_VERSION must not be empty')
  }
  return {
    provider,
    baseUrl:
      environment.PRAXIS_BASE_URL ??
      (provider === 'anthropic'
        ? 'https://api.anthropic.com/v1'
        : 'https://api.openai.com/v1'),
    ...(maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: Number(maxOutputTokens) }),
    ...(anthropicVersion === undefined ? {} : { anthropicVersion }),
  }
}

export function parseContextEnvironment(environment: NodeJS.ProcessEnv): {
  contextWindowTokens?: number
  contextReserveTokens?: number
} {
  const parse = (name: string): number | undefined => {
    const raw = environment[name]
    if (raw === undefined) return undefined
    if (
      !/^\d+$/.test(raw) ||
      Number(raw) <= 0 ||
      !Number.isSafeInteger(Number(raw))
    ) {
      throw new Error(`${name} must be a positive integer`)
    }
    return Number(raw)
  }
  const contextWindowTokens = parse('PRAXIS_CONTEXT_WINDOW_TOKENS')
  const contextReserveTokens = parse('PRAXIS_CONTEXT_RESERVE_TOKENS')
  if (contextReserveTokens !== undefined && contextWindowTokens === undefined) {
    throw new Error(
      'PRAXIS_CONTEXT_RESERVE_TOKENS requires PRAXIS_CONTEXT_WINDOW_TOKENS',
    )
  }
  return {
    ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
    ...(contextReserveTokens === undefined ? {} : { contextReserveTokens }),
  }
}

export interface CliIO {
  stdout(message: string | Uint8Array): void
  stderr(message: string): void
  isTTY?: boolean
  readStdinLines?: () => AsyncIterable<string | Uint8Array>
}

interface SessionCommands {
  run(
    prompt: string,
    signal?: AbortSignal,
    sessionId?: string,
  ): Promise<SessionRunResult>
  resume(
    sessionId: string,
    prompt: string,
    signal?: AbortSignal,
  ): Promise<SessionRunResult>
  fork(sessionId: string, targetSessionId?: string): Promise<ForkResult>
  sessions(): Promise<SessionSummary[]>
  inspect(sessionId: string): Promise<SessionInspection>
  export(sessionId: string): Promise<Buffer>
  close?(): Promise<void>
  runtimeInfo?(): CliRuntimeInfo
}

export interface CliDependencies extends InteractiveServiceFactory {
  createService(options: {
    eventSink: RuntimeEventSink
    requireProvider: boolean
    approveRecovery?: (call: ModelToolCall) => boolean | Promise<boolean>
    approveTool?: (call: ModelToolCall) => boolean | Promise<boolean>
    agent?: string
    controls?: CliControls
    signal?: AbortSignal
  }): Promise<SessionCommands>
  runInteractive?(options: { signal?: AbortSignal }): Promise<number>
}

const consoleIO: CliIO = {
  stdout: (message) => process.stdout.write(message),
  stderr: (message) => process.stderr.write(message),
  isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  readStdinLines: () => process.stdin,
}

const createDefaultService: CliDependencies['createService'] = async ({
  eventSink,
  requireProvider,
  approveRecovery,
  approveTool,
  agent,
  controls = DEFAULT_CLI_CONTROLS,
  signal,
}) => {
  const claudeVersion = await detectInstalledClaudeVersion()
  const cwd = process.cwd()
  const configuredRoot = process.env.CLAUDE_CONFIG_DIR
  const configRoot = resolve(configuredRoot ?? resolve(homedir(), '.claude'))
  const claudeStatePath = configuredRoot
    ? join(configRoot, '.claude.json')
    : resolve(homedir(), '.claude.json')
  const cli = await resolveCliControls(controls, cwd)
  let provider
  const context = parseContextEnvironment(process.env)
  if (requireProvider) {
    const apiKey = process.env.PRAXIS_API_KEY
    const model = process.env.PRAXIS_MODEL
    if (!apiKey || !model) {
      throw new Error('PRAXIS_API_KEY and PRAXIS_MODEL are required')
    }
    const providerEnvironment = parseProviderEnvironment(process.env)
    const providerOptions = {
      apiKey,
      model,
      baseUrl: providerEnvironment.baseUrl,
      ...('contextWindowTokens' in context
        ? { contextWindowTokens: context.contextWindowTokens }
        : {}),
    }
    provider =
      providerEnvironment.provider === 'anthropic'
        ? new AnthropicCompatibleProvider({
            ...providerOptions,
            ...('maxOutputTokens' in providerEnvironment
              ? { maxOutputTokens: providerEnvironment.maxOutputTokens }
              : {}),
            ...('anthropicVersion' in providerEnvironment
              ? { anthropicVersion: providerEnvironment.anthropicVersion }
              : {}),
          })
        : new OpenAICompatibleProvider(providerOptions)
  }

  const options = {
    configRoot,
    cwd,
    claudeVersion,
    eventSink,
    sessionPersistence: cli.sessionPersistence,
  }
  if (!provider) return new ClaudeSessionService(options)

  const automaticSettingSources =
    cli.safeMode || cli.bare ? [] : cli.settingSources
  const settings = [
    ...(await loadClaudeSettings({
      configRoot,
      cwd,
      ...(cli.bare
        ? { settingSources: [] }
        : cli.settingSources === undefined
          ? {}
          : { settingSources: cli.settingSources }),
    })),
    ...(cli.additionalSettings ? [cli.additionalSettings] : []),
  ]
  const loadedResources = await loadClaudeSharedResources({
    configRoot,
    cwd,
    claudeStatePath,
    ...(automaticSettingSources === undefined
      ? {}
      : { settingSources: automaticSettingSources }),
  })
  const resources = {
    ...loadedResources,
    settings: [
      ...loadedResources.settings,
      ...(cli.additionalSettings ? [cli.additionalSettings] : []),
    ],
  }
  const extensions = new ClaudeExtensionCatalog(resources)
  const memoryDirectory =
    cli.safeMode || cli.bare
      ? undefined
      : await resolveClaudeProjectMemoryDirectory({ configRoot, cwd })
  if (memoryDirectory) await mkdir(memoryDirectory, { recursive: true })
  const loadContextResources = () =>
    loadClaudeContextResources({
      configRoot,
      cwd,
      ...(automaticSettingSources === undefined
        ? {}
        : { settingSources: automaticSettingSources }),
    })
  const permissions = new ClaudeExtensionPermissionResolver(
    new ClaudePermissionResolver({
      cwd,
      settings,
      allowedTools: cli.allowedTools,
      disallowedTools: cli.disallowedTools,
      permissionMode: cli.dangerouslySkipPermissions
        ? 'bypassPermissions'
        : cli.permissionMode,
    }),
  )
  const localTools = new LocalToolRegistry({
    cwd,
    ...(memoryDirectory ? { sharedMemoryDirectory: memoryDirectory } : {}),
    additionalDirectories: cli.additionalDirectories,
  })
  const mcpTools = await ClaudeMcpToolRegistry.connect({
    base: cli.bare
      ? localTools
      : new WebToolRegistry({ base: localTools, provider }),
    resources: resources.mcp,
    cwd,
    onWarning: (message) => eventSink({ type: 'warning', message }),
    ...(signal ? { signal } : {}),
  })
  try {
    const extensionTools = new ClaudeExtensionToolRegistry(mcpTools, extensions)
    const subagentsSelected =
      cli.tools === undefined ||
      cli.tools.includes('default') ||
      cli.tools.includes('Agent')
    const selectedBaseTools = cli.tools?.filter(
      (name) =>
        name !== 'Agent' &&
        (!cli.bare || (name !== 'WebFetch' && name !== 'WebSearch')),
    )
    const filteredTools = new FilteredToolRegistry(extensionTools, {
      ...(cli.tools === undefined
        ? cli.bare
          ? { tools: ['Bash', 'Edit', 'Read'] }
          : {}
        : { tools: selectedBaseTools ?? [] }),
      disallowedTools: cli.disallowedTools,
    })
    const enableSubagents =
      cli.sessionPersistence &&
      !cli.bare &&
      subagentsSelected &&
      !cli.disallowedTools.includes('Agent')
    const service = new ClaudeSessionService({
      ...options,
      provider,
      tools: filteredTools,
      permissions,
      extensions,
      enableSubagents,
      ...(cli.safeMode || cli.bare
        ? {}
        : { hooks: new ClaudeHookRunner({ settings, cwd }) }),
      ...(agent ? { agent } : {}),
      contextAssembler: new ClaudeContextAssembler({
        loadResources: loadContextResources,
        ...(cli.systemPrompt === undefined
          ? {}
          : { systemPrompt: cli.systemPrompt }),
        ...(cli.appendSystemPrompt === undefined
          ? {}
          : { appendSystemPrompt: cli.appendSystemPrompt }),
      }),
      conditionalRuleResolver: new ClaudeConditionalRuleResolver({
        loadResources: loadContextResources,
      }),
      ...('contextReserveTokens' in context
        ? { contextReserveTokens: context.contextReserveTokens }
        : {}),
      ...(approveTool ? { approveTool } : {}),
      ...(approveRecovery ? { approveRecovery } : {}),
    })
    const toolNames = [
      ...filteredTools.definitions().map((definition) => definition.name),
      ...(enableSubagents ? ['Agent'] : []),
    ]
    const runtimeInfo: CliRuntimeInfo = {
      cwd,
      model: provider.model ?? process.env.PRAXIS_MODEL ?? 'unknown',
      tools: toolNames,
      mcpServers: mcpTools.serverStatuses(),
      permissionMode: cli.dangerouslySkipPermissions
        ? 'bypassPermissions'
        : cli.permissionMode,
      slashCommands: extensions
        .modelInvocableSkills()
        .map((definition) => definition.name),
      agents: extensions.agentNames(),
      skills: extensions
        .modelInvocableSkills()
        .map((definition) => definition.name),
      claudeCodeVersion: claudeVersion,
    }
    return {
      run: (prompt, signal, sessionId) =>
        service.run(prompt, signal, sessionId, cli.name),
      resume: (sessionId, prompt, signal) =>
        service.resume(sessionId, prompt, signal, cli.name),
      fork: (sessionId, targetSessionId) =>
        service.fork(sessionId, targetSessionId),
      sessions: () => service.sessions(),
      inspect: (sessionId) => service.inspect(sessionId),
      export: (sessionId) => service.export(sessionId),
      close: () => mcpTools.close(),
      runtimeInfo: () => runtimeInfo,
    }
  } catch (error) {
    try {
      await mcpTools.close()
    } catch {
      // Preserve the service-construction failure as the primary error.
    }
    throw error
  }
}

const defaultDependencies: CliDependencies = {
  createService: createDefaultService,
  runInteractive: ({ signal }) =>
    renderInteractive({
      factory: { createService: createDefaultService },
      ...(signal ? { signal } : {}),
    }),
}

function writeJson(io: CliIO, value: unknown): void {
  io.stdout(`${JSON.stringify(value)}\n`)
}

function formatSessionIssue(issue: SessionSummary['issue']): string {
  return issue
    ? `line ${issue.lineNumber}, byte ${issue.byteOffset}: ${issue.message}`
    : ''
}

function eventSink(
  io: CliIO,
  outputFormat: CliOutputFormat,
  legacyJson = false,
): RuntimeEventSink {
  const sensitiveValues = sensitiveEnvironmentValues(process.env)
  if (legacyJson) {
    return (event) =>
      writeJson(
        io,
        event.type === 'warning' || event.type === 'failed'
          ? {
              ...event,
              message: redactSensitiveText(event.message, sensitiveValues),
            }
          : event,
      )
  }
  if (outputFormat !== 'text') return () => undefined
  return (event) => {
    if (event.type === 'text-delta') io.stdout(event.delta)
    if (event.type === 'warning') {
      io.stderr(
        `Warning: ${redactSensitiveText(event.message, sensitiveValues)}\n`,
      )
    }
  }
}

function requireValue(value: string | undefined, label: string): string {
  if (!value) throw new Error(`${label} is required`)
  return value
}

function promptFrom(values: readonly string[]): string {
  const prompt = values.join(' ').trim()
  if (prompt.length === 0) throw new Error('Prompt is required')
  return prompt
}

function isCancellation(error: unknown, signal?: AbortSignal): boolean {
  return (
    error instanceof AgentRunCancelledError ||
    signal?.aborted === true ||
    (error instanceof DOMException && error.name === 'AbortError')
  )
}

async function execute(
  argv: readonly string[],
  io: CliIO,
  dependencies: CliDependencies,
  signal?: AbortSignal,
): Promise<number> {
  if (argv.length === 0 && io.isTTY && dependencies.runInteractive) {
    return dependencies.runInteractive(signal ? { signal } : {})
  }
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    io.stdout(HELP)
    return 0
  }
  if (argv.includes('--version') || argv.includes('-v')) {
    io.stdout(`${VERSION}\n`)
    return 0
  }

  const invocation = parseCliInvocation(argv)
  const { agent, args, outputFormat, inputFormat, includePartialMessages } =
    invocation
  const { retryInterruptedTools } = invocation
  const command = args[0]
  if (command === 'resume') requireValue(args[1], 'Session ID')
  const knownCommand = [
    'run',
    'resume',
    'fork',
    'sessions',
    'inspect',
    'export',
  ].includes(command ?? '')
  if (retryInterruptedTools && command !== 'resume') {
    throw new Error('--retry-interrupted-tools is only valid with resume')
  }
  if (agent && knownCommand && !['run', 'resume'].includes(command ?? 'run')) {
    throw new Error('--agent is only valid with run or resume')
  }
  const expectedOperands = command === 'sessions' ? 1 : 2
  if (
    ['sessions', 'fork', 'inspect', 'export'].includes(command ?? '') &&
    args.length > expectedOperands
  ) {
    throw new Error(
      `Unexpected operand for ${command}: ${args[expectedOperands]}`,
    )
  }
  let streamOutput: StreamJsonOutput | undefined
  let jsonModelTurns = 0
  const pendingEvents: Parameters<RuntimeEventSink>[0][] = []
  const service = await dependencies.createService({
    eventSink:
      outputFormat === 'stream-json' && !invocation.legacyJson
        ? (event) => {
            const safeEvent =
              event.type === 'warning' || event.type === 'failed'
                ? {
                    ...event,
                    message: redactSensitiveText(
                      event.message,
                      sensitiveEnvironmentValues(process.env),
                    ),
                  }
                : event
            if (streamOutput) streamOutput.sink(safeEvent)
            else pendingEvents.push(safeEvent)
          }
        : outputFormat === 'json'
          ? (event) => {
              if (event.type === 'state' && event.state === 'awaiting-model') {
                jsonModelTurns += 1
              }
            }
          : eventSink(io, outputFormat, invocation.legacyJson),
    requireProvider: !['fork', 'sessions', 'inspect', 'export'].includes(
      command ?? 'run',
    ),
    ...(retryInterruptedTools ? { approveRecovery: () => true } : {}),
    ...(signal ? { signal } : {}),
    ...(agent ? { agent } : {}),
    controls: invocation,
  })
  try {
    if (command === 'sessions') {
      const sessions = await service.sessions()
      if (outputFormat === 'json' || invocation.legacyJson) {
        writeJson(io, { type: 'sessions', sessions })
      } else if (outputFormat === 'stream-json') {
        for (const session of sessions)
          writeJson(io, { type: 'session', session })
      } else {
        for (const session of sessions) {
          io.stdout(
            `${session.sessionId}\t${session.updatedAt}\t${session.lastPrompt ?? ''}\t${session.status}\t${formatSessionIssue(session.issue)}\n`,
          )
        }
      }
      return 0
    }

    if (command === 'fork') {
      const result = await service.fork(requireValue(args[1], 'Session ID'))
      if (outputFormat !== 'text') writeJson(io, { type: 'forked', ...result })
      else io.stdout(`${result.sessionId}\n`)
      return 0
    }

    if (command === 'inspect') {
      const session = await service.inspect(requireValue(args[1], 'Session ID'))
      if (outputFormat !== 'text') writeJson(io, { type: 'session', session })
      else {
        io.stdout(
          `${session.sessionId}\t${session.status}\t${session.writeMode}\t${session.updatedAt}\t${session.entryCount}\t${session.byteLength}\t${session.newlineTerminated}\t${session.lastPrompt ?? ''}\t${formatSessionIssue(session.issue)}\n`,
        )
      }
      return 0
    }

    if (command === 'export') {
      const sessionId = requireValue(args[1], 'Session ID')
      const transcript = await service.export(sessionId)
      if (outputFormat !== 'text') {
        writeJson(io, {
          type: 'session-export',
          sessionId,
          encoding: 'base64',
          transcript: transcript.toString('base64'),
        })
      } else io.stdout(transcript)
      return 0
    }

    const runtimeInfo = service.runtimeInfo?.() ?? {
      cwd: process.cwd(),
      model: process.env.PRAXIS_MODEL ?? 'unknown',
      tools: [],
      mcpServers: [],
      permissionMode: 'default',
      slashCommands: [],
      agents: [],
      skills: [],
      claudeCodeVersion: 'unknown',
    }
    let existingSessionId =
      command === 'resume' ? requireValue(args[1], 'Session ID') : undefined
    if (!existingSessionId && invocation.continueSession) {
      const latest = (await service.sessions())[0]
      if (!latest) throw new Error('No conversation found to continue')
      existingSessionId = latest.sessionId
    }
    if (existingSessionId && invocation.forkSession) {
      existingSessionId = (
        await service.fork(existingSessionId, invocation.sessionId)
      ).sessionId
    }
    let activeSessionId =
      existingSessionId ?? invocation.sessionId ?? randomUUID()
    if (outputFormat === 'stream-json' && !invocation.legacyJson) {
      streamOutput = new StreamJsonOutput(
        (value) => writeJson(io, value),
        runtimeInfo,
        activeSessionId,
        includePartialMessages,
      )
    }
    let streamIterator: AsyncGenerator<StreamUserMessage> | undefined
    let firstStreamMessage: StreamUserMessage | undefined
    if (inputFormat === 'stream-json' && !invocation.legacyJson) {
      const input = io.readStdinLines?.()
      if (!input) throw new Error('stream-json input requires stdin support')
      const iterator = readStreamUserMessages(input)
      const first = await iterator.next()
      if (first.done || !first.value) return 0
      streamIterator = iterator
      firstStreamMessage = first.value
    }

    const initialPrompt =
      firstStreamMessage?.prompt ??
      promptFrom(
        command === 'resume'
          ? args.slice(2)
          : knownCommand
            ? args.slice(1)
            : args,
      )
    let isFirstTurn = true
    const runTurn = async (
      prompt: string,
      streamMessage?: StreamUserMessage,
    ): Promise<boolean> => {
      const startedAt = Date.now()
      if (streamOutput) {
        streamOutput.init()
        if (isFirstTurn) {
          for (const event of pendingEvents) streamOutput.sink(event)
        }
        if (invocation.replayUserMessages && streamMessage)
          streamOutput.replayUser(streamMessage.message)
      }
      let result: SessionRunResult
      try {
        result =
          existingSessionId !== undefined || !isFirstTurn
            ? signal
              ? await service.resume(activeSessionId, prompt, signal)
              : await service.resume(activeSessionId, prompt)
            : signal
              ? await service.run(prompt, signal, activeSessionId)
              : await service.run(prompt, undefined, activeSessionId)
      } catch (error) {
        if (isCancellation(error, signal)) throw error
        const message = redactSensitiveText(
          error instanceof Error ? error.message : String(error),
          sensitiveEnvironmentValues(process.env),
        )
        if (streamOutput) streamOutput.error(message, startedAt)
        else if (outputFormat === 'json') {
          writeJson(
            io,
            createErrorResult(
              message,
              activeSessionId,
              startedAt,
              jsonModelTurns,
            ),
          )
        } else throw error
        return false
      }
      activeSessionId = result.sessionId
      if (streamOutput) streamOutput.result(result, startedAt)
      else if (outputFormat === 'json') {
        writeJson(
          io,
          createSuccessResult(
            result,
            runtimeInfo,
            startedAt,
            Math.max(1, jsonModelTurns),
          ),
        )
      } else if (outputFormat !== 'text')
        writeJson(io, { type: 'result', ...result })
      else io.stdout('\n')
      isFirstTurn = false
      return true
    }

    if (!(await runTurn(initialPrompt, firstStreamMessage))) return 1
    if (streamIterator) {
      for await (const message of streamIterator) {
        if (!(await runTurn(message.prompt, message))) return 1
      }
    }
    return 0
  } finally {
    try {
      await service.close?.()
    } catch (error) {
      io.stderr(
        `Warning: ${redactSensitiveText(
          error instanceof Error ? error.message : String(error),
          sensitiveEnvironmentValues(process.env),
        )}\n`,
      )
    }
  }
}

export async function run(
  argv: readonly string[],
  io: CliIO = consoleIO,
  dependencies: CliDependencies = defaultDependencies,
  signal?: AbortSignal,
): Promise<number> {
  try {
    return await execute(argv, io, dependencies, signal)
  } catch (error) {
    if (isCancellation(error, signal)) {
      io.stderr('Praxis run cancelled.\n')
      return 130
    }
    const message = redactSensitiveText(
      error instanceof Error ? error.message : String(error),
      sensitiveEnvironmentValues(process.env),
    )
    if (argv.includes('--json')) writeJson(io, { type: 'error', message })
    else io.stderr(`${message}\n`)
    return 1
  }
}

function isDirectExecution(moduleUrl: string, argvPath: string | undefined) {
  if (!argvPath) return false
  try {
    return moduleUrl === pathToFileURL(realpathSync(argvPath)).href
  } catch {
    return false
  }
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  const controller = new AbortController()
  const cancel = () => controller.abort()
  process.once('SIGINT', cancel)
  process.exitCode = await run(
    process.argv.slice(2),
    consoleIO,
    defaultDependencies,
    controller.signal,
  )
  process.removeListener('SIGINT', cancel)
}
