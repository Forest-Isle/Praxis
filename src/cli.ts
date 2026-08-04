#!/usr/bin/env node

import { realpathSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

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

const VERSION = '0.1.0'

const HELP = `Praxis — local-first general agent

Usage:
  praxis
  praxis run [--json] [--agent <name>] <prompt>
  praxis resume [--json] [--agent <name>] [--retry-interrupted-tools] <session-id> <prompt>
  praxis fork [--json] <session-id>
  praxis sessions [--json]
  praxis inspect [--json] <session-id>
  praxis export [--json] <session-id>
  praxis <prompt>
  praxis --help
  praxis --version

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
}

interface SessionCommands {
  run(prompt: string, signal?: AbortSignal): Promise<SessionRunResult>
  resume(
    sessionId: string,
    prompt: string,
    signal?: AbortSignal,
  ): Promise<SessionRunResult>
  fork(sessionId: string): Promise<ForkResult>
  sessions(): Promise<SessionSummary[]>
  inspect(sessionId: string): Promise<SessionInspection>
  export(sessionId: string): Promise<Buffer>
}

export interface CliDependencies extends InteractiveServiceFactory {
  createService(options: {
    eventSink: RuntimeEventSink
    requireProvider: boolean
    approveRecovery?: (call: ModelToolCall) => boolean | Promise<boolean>
    approveTool?: (call: ModelToolCall) => boolean | Promise<boolean>
    agent?: string
    signal?: AbortSignal
  }): Promise<SessionCommands>
  runInteractive?(options: { signal?: AbortSignal }): Promise<number>
}

const consoleIO: CliIO = {
  stdout: (message) => process.stdout.write(message),
  stderr: (message) => process.stderr.write(message),
  isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
}

const createDefaultService: CliDependencies['createService'] = async ({
  eventSink,
  requireProvider,
  approveRecovery,
  approveTool,
  agent,
  signal,
}) => {
  const claudeVersion = await detectInstalledClaudeVersion()
  const cwd = process.cwd()
  const configuredRoot = process.env.CLAUDE_CONFIG_DIR
  const configRoot = resolve(configuredRoot ?? resolve(homedir(), '.claude'))
  const claudeStatePath = configuredRoot
    ? join(configRoot, '.claude.json')
    : resolve(homedir(), '.claude.json')
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
  }
  if (!provider) return new ClaudeSessionService(options)

  const settings = await loadClaudeSettings({ configRoot, cwd })
  const resources = await loadClaudeSharedResources({
    configRoot,
    cwd,
    claudeStatePath,
  })
  const extensions = new ClaudeExtensionCatalog(resources)
  const memoryDirectory = await resolveClaudeProjectMemoryDirectory({
    configRoot,
    cwd,
  })
  await mkdir(memoryDirectory, { recursive: true })
  const loadContextResources = () =>
    loadClaudeContextResources({ configRoot, cwd })
  const permissions = new ClaudeExtensionPermissionResolver(
    new ClaudePermissionResolver({ cwd, settings }),
  )
  const mcpTools = await ClaudeMcpToolRegistry.connect({
    base: new LocalToolRegistry({
      cwd,
      sharedMemoryDirectory: memoryDirectory,
    }),
    resources: resources.mcp,
    cwd,
    onWarning: (message) => eventSink({ type: 'warning', message }),
    ...(signal ? { signal } : {}),
  })
  const service = new ClaudeSessionService({
    ...options,
    provider,
    tools: new ClaudeExtensionToolRegistry(mcpTools, extensions),
    permissions,
    extensions,
    hooks: new ClaudeHookRunner({ settings, cwd }),
    ...(agent ? { agent } : {}),
    contextAssembler: new ClaudeContextAssembler({
      loadResources: loadContextResources,
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
  return {
    run: (prompt, signal) =>
      service.run(prompt, signal).finally(() => mcpTools.close()),
    resume: (sessionId, prompt, signal) =>
      service.resume(sessionId, prompt, signal).finally(() => mcpTools.close()),
    fork: (sessionId) => service.fork(sessionId),
    sessions: () => service.sessions(),
    inspect: (sessionId) => service.inspect(sessionId),
    export: (sessionId) => service.export(sessionId),
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

function eventSink(io: CliIO, json: boolean): RuntimeEventSink {
  const sensitiveValues = sensitiveEnvironmentValues(process.env)
  if (json) {
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

function extractAgent(argv: readonly string[]): {
  agent: string | undefined
  args: string[]
} {
  const args: string[] = []
  let agent: string | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value !== '--agent') {
      if (value !== undefined) args.push(value)
      continue
    }
    if (agent !== undefined)
      throw new Error('--agent may only be specified once')
    agent = requireValue(argv[index + 1], 'Agent name')
    index += 1
  }
  return { agent, args }
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

  const { agent, args: agentArgs } = extractAgent(argv)
  const json = agentArgs.includes('--json')
  const retryInterruptedTools = agentArgs.includes('--retry-interrupted-tools')
  const args = agentArgs.filter(
    (value) => value !== '--json' && value !== '--retry-interrupted-tools',
  )
  const command = args[0]
  if (retryInterruptedTools && command !== 'resume') {
    throw new Error('--retry-interrupted-tools is only valid with resume')
  }
  if (agent && !['run', 'resume'].includes(command ?? 'run')) {
    throw new Error('--agent is only valid with run or resume')
  }
  const knownCommand = [
    'run',
    'resume',
    'fork',
    'sessions',
    'inspect',
    'export',
  ].includes(command ?? '')
  const expectedOperands = command === 'sessions' ? 1 : 2
  if (
    ['sessions', 'fork', 'inspect', 'export'].includes(command ?? '') &&
    args.length > expectedOperands
  ) {
    throw new Error(
      `Unexpected operand for ${command}: ${args[expectedOperands]}`,
    )
  }
  const service = await dependencies.createService({
    eventSink: eventSink(io, json),
    requireProvider: !['fork', 'sessions', 'inspect', 'export'].includes(
      command ?? 'run',
    ),
    ...(retryInterruptedTools ? { approveRecovery: () => true } : {}),
    ...(signal ? { signal } : {}),
    ...(agent ? { agent } : {}),
  })

  if (command === 'sessions') {
    const sessions = await service.sessions()
    if (json) writeJson(io, { type: 'sessions', sessions })
    else {
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
    if (json) writeJson(io, { type: 'forked', ...result })
    else io.stdout(`${result.sessionId}\n`)
    return 0
  }

  if (command === 'inspect') {
    const session = await service.inspect(requireValue(args[1], 'Session ID'))
    if (json) writeJson(io, { type: 'session', session })
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
    if (json) {
      writeJson(io, {
        type: 'session-export',
        sessionId,
        encoding: 'base64',
        transcript: transcript.toString('base64'),
      })
    } else io.stdout(transcript)
    return 0
  }

  let result: SessionRunResult
  if (command === 'resume') {
    const sessionId = requireValue(args[1], 'Session ID')
    const prompt = promptFrom(args.slice(2))
    result = signal
      ? await service.resume(sessionId, prompt, signal)
      : await service.resume(sessionId, prompt)
  } else {
    const prompt = promptFrom(knownCommand ? args.slice(1) : args)
    result = signal
      ? await service.run(prompt, signal)
      : await service.run(prompt)
  }

  if (json) writeJson(io, { type: 'result', ...result })
  else io.stdout('\n')
  return 0
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
    if (
      error instanceof AgentRunCancelledError ||
      signal?.aborted ||
      (error instanceof DOMException && error.name === 'AbortError')
    ) {
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
