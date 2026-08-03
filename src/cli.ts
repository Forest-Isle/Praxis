#!/usr/bin/env node

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  ClaudeSessionService,
  type ForkResult,
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
} from './compatibility/claude/shared-resources.js'
import {
  AgentRunCancelledError,
  type RuntimeEventSink,
} from './core/runtime.js'
import { ClaudePermissionResolver } from './permissions/claude-permission-resolver.js'
import {
  ClaudeExtensionPermissionResolver,
  ClaudeExtensionToolRegistry,
} from './extensions/claude-extension-tools.js'
import { ClaudeExtensionCatalog } from './extensions/claude-extensions.js'
import { ClaudeHookRunner } from './hooks/claude-hooks.js'
import { ClaudeMcpToolRegistry } from './mcp/claude-mcp-tools.js'
import { detectInstalledClaudeVersion } from './platform/claude-version.js'
import { OpenAICompatibleProvider } from './providers/openai-compatible.js'
import { LocalToolRegistry } from './tools/local-tools.js'

const VERSION = '0.1.0'

const HELP = `Praxis — local-first general agent

Usage:
  praxis run [--json] [--agent <name>] <prompt>
  praxis resume [--json] [--agent <name>] [--retry-interrupted-tools] <session-id> <prompt>
  praxis fork [--json] <session-id>
  praxis sessions [--json]
  praxis <prompt>
  praxis --help
  praxis --version

Provider environment:
  PRAXIS_API_KEY, PRAXIS_MODEL, PRAXIS_BASE_URL
`

export interface CliIO {
  stdout(message: string): void
  stderr(message: string): void
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
}

export interface CliDependencies {
  createService(options: {
    eventSink: RuntimeEventSink
    requireProvider: boolean
    approveRecovery: boolean
    agent?: string
    signal?: AbortSignal
  }): Promise<SessionCommands>
}

const consoleIO: CliIO = {
  stdout: (message) => process.stdout.write(message),
  stderr: (message) => process.stderr.write(message),
}

const defaultDependencies: CliDependencies = {
  async createService({
    eventSink,
    requireProvider,
    approveRecovery,
    agent,
    signal,
  }) {
    const claudeVersion = await detectInstalledClaudeVersion()
    const cwd = process.cwd()
    const configuredRoot = process.env.CLAUDE_CONFIG_DIR
    const configRoot = resolve(configuredRoot ?? resolve(homedir(), '.claude'))
    const claudeStatePath = configuredRoot
      ? join(configRoot, '.claude.json')
      : resolve(homedir(), '.claude.json')
    let provider
    if (requireProvider) {
      const apiKey = process.env.PRAXIS_API_KEY
      const model = process.env.PRAXIS_MODEL
      if (!apiKey || !model) {
        throw new Error('PRAXIS_API_KEY and PRAXIS_MODEL are required')
      }
      provider = new OpenAICompatibleProvider({
        apiKey,
        model,
        baseUrl: process.env.PRAXIS_BASE_URL ?? 'https://api.openai.com/v1',
      })
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
    const loadContextResources = () =>
      loadClaudeContextResources({ configRoot, cwd })
    const permissions = new ClaudeExtensionPermissionResolver(
      new ClaudePermissionResolver({ cwd, settings }),
    )
    const mcpTools = await ClaudeMcpToolRegistry.connect({
      base: new LocalToolRegistry({ cwd }),
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
      ...(approveRecovery ? { approveRecovery: () => true } : {}),
    })
    return {
      run: (prompt, signal) =>
        service.run(prompt, signal).finally(() => mcpTools.close()),
      resume: (sessionId, prompt, signal) =>
        service
          .resume(sessionId, prompt, signal)
          .finally(() => mcpTools.close()),
      fork: (sessionId) => service.fork(sessionId),
      sessions: () => service.sessions(),
    }
  },
}

function writeJson(io: CliIO, value: unknown): void {
  io.stdout(`${JSON.stringify(value)}\n`)
}

function eventSink(io: CliIO, json: boolean): RuntimeEventSink {
  if (json) return (event) => writeJson(io, event)
  return (event) => {
    if (event.type === 'text-delta') io.stdout(event.delta)
    if (event.type === 'warning') io.stderr(`Warning: ${event.message}\n`)
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
  const approveRecovery = agentArgs.includes('--retry-interrupted-tools')
  const args = agentArgs.filter(
    (value) => value !== '--json' && value !== '--retry-interrupted-tools',
  )
  const command = args[0]
  if (approveRecovery && command !== 'resume') {
    throw new Error('--retry-interrupted-tools is only valid with resume')
  }
  if (agent && !['run', 'resume'].includes(command ?? 'run')) {
    throw new Error('--agent is only valid with run or resume')
  }
  const knownCommand = ['run', 'resume', 'fork', 'sessions'].includes(
    command ?? '',
  )
  const service = await dependencies.createService({
    eventSink: eventSink(io, json),
    requireProvider: !['fork', 'sessions'].includes(command ?? 'run'),
    approveRecovery,
    ...(signal ? { signal } : {}),
    ...(agent ? { agent } : {}),
  })

  if (command === 'sessions') {
    const sessions = await service.sessions()
    if (json) writeJson(io, { type: 'sessions', sessions })
    else {
      for (const session of sessions) {
        io.stdout(
          `${session.sessionId}\t${session.updatedAt}\t${session.lastPrompt ?? ''}\n`,
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
    const message = error instanceof Error ? error.message : String(error)
    if (argv.includes('--json')) writeJson(io, { type: 'error', message })
    else io.stderr(`${message}\n`)
    return 1
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
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
