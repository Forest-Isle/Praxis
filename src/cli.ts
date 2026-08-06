#!/usr/bin/env node

import { realpathSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
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
  type ModelDocument,
  type ModelImage,
  type ModelProvider,
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
  createClaudeModelAutoClassifier,
  defaultClaudeAutoModeConfig,
  loadClaudeAutoModeConfig,
} from './permissions/claude-auto-classifier.js'
import {
  ClaudeExtensionPermissionResolver,
  ClaudeExtensionToolRegistry,
} from './extensions/claude-extension-tools.js'
import { ClaudeExtensionCatalog } from './extensions/claude-extensions.js'
import { ClaudeHookRunner } from './hooks/claude-hooks.js'
import { ClaudeMcpToolRegistry } from './mcp/claude-mcp-tools.js'
import {
  ClaudeMcpManagement,
  mcpScope,
  type McpServerRecord,
} from './mcp/claude-mcp-management.js'
import { detectInstalledClaudeVersion } from './platform/claude-version.js'
import {
  redactSensitiveText,
  sensitiveEnvironmentValues,
} from './platform/sensitive-data.js'
import { AnthropicCompatibleProvider } from './providers/anthropic-compatible.js'
import { FallbackModelProvider } from './providers/fallback-provider.js'
import { OpenAICompatibleProvider } from './providers/openai-compatible.js'
import { ModelPricingRegistry } from './core/usage.js'
import { LocalToolRegistry } from './tools/local-tools.js'
import { claudeBackgroundTaskParent } from './application/background-bash-manager.js'
import {
  runTopLevelAgentWorker,
  TopLevelAgentManager,
  type TopLevelAgentSummary,
} from './application/top-level-agent-manager.js'
import { FilteredToolRegistry } from './tools/filtered-tool-registry.js'
import { WebToolRegistry } from './tools/web.js'
import { WorkspaceContext } from './application/session-worktree.js'
import { launchTmuxWorktree } from './platform/tmux-worktree.js'
import {
  createErrorResult,
  createSuccessResult,
  parseCliInvocation,
  readStreamUserMessages,
  StreamJsonOutput,
  type CliOutputFormat,
  type CliControls,
  type CliInvocation,
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
  praxis --bg [options] <prompt>
  praxis agents [--json] [--all] [--cwd <path>]
  praxis attach <agent-id>
  praxis logs <agent-id>
  praxis stop <agent-id>
  praxis mcp <list|get|add|add-json|remove|reset-project-choices> ...
  praxis auto-mode <config|defaults>

Options:
  -p, --print                         Print response and exit
  --bg, --background                  Run as a persistent background agent
  -r, --resume <session-id>           Resume a session
  -c, --continue                      Continue latest session in this directory
  --fork-session                      Fork when resuming or continuing
  --session-id <uuid>                 Use an explicit ID for a new session
  -n, --name <name>                   Set session display name
  --model <model>                     Select model for this session
  --effort <level>                    low, medium, high, xhigh, or max
  --fallback-model <models>           Comma-separated print-mode fallbacks
  --json-schema <schema>              Print-mode JSON Schema for structured output
  --max-budget-usd <amount>           Maximum print-mode API spend
  --prompt-suggestions                Emit a suggested next prompt (stream-json print mode)
  --scope <scope>                     MCP scope: local, project, or user
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
  -w, --worktree [name]               Start in an isolated Git worktree
  --tmux[=classic]                    Launch the worktree session in tmux

Provider environment:
  PRAXIS_PROVIDER=openai|anthropic, PRAXIS_API_KEY, PRAXIS_MODEL
  PRAXIS_BASE_URL, PRAXIS_MAX_OUTPUT_TOKENS, PRAXIS_ANTHROPIC_VERSION
  PRAXIS_ANTHROPIC_WEB_SEARCH=true|false
  PRAXIS_CONTEXT_WINDOW_TOKENS, PRAXIS_CONTEXT_RESERVE_TOKENS
`

export function parseProviderEnvironment(environment: NodeJS.ProcessEnv): {
  provider: 'openai' | 'anthropic'
  baseUrl: string
  maxOutputTokens?: number
  anthropicVersion?: string
  webSearch?: boolean
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
  const webSearch = environment.PRAXIS_ANTHROPIC_WEB_SEARCH
  if (
    webSearch !== undefined &&
    webSearch !== 'true' &&
    webSearch !== 'false'
  ) {
    throw new Error('PRAXIS_ANTHROPIC_WEB_SEARCH must be true or false')
  }
  if (provider === 'openai' && webSearch !== undefined) {
    throw new Error(
      'PRAXIS_ANTHROPIC_WEB_SEARCH requires PRAXIS_PROVIDER=anthropic',
    )
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
    ...(webSearch === undefined ? {} : { webSearch: webSearch === 'true' }),
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
    name?: string,
    images?: readonly ModelImage[],
    documents?: readonly ModelDocument[],
  ): Promise<SessionRunResult>
  resume(
    sessionId: string,
    prompt: string,
    signal?: AbortSignal,
    name?: string,
    images?: readonly ModelImage[],
    documents?: readonly ModelDocument[],
  ): Promise<SessionRunResult>
  fork(sessionId: string, targetSessionId?: string): Promise<ForkResult>
  sessions(): Promise<SessionSummary[]>
  inspect(sessionId: string): Promise<SessionInspection>
  export(sessionId: string): Promise<Buffer>
  nextScheduledPrompt?(
    signal?: AbortSignal,
  ): Promise<{ id: string; prompt: string } | null>
  close?(): Promise<void>
  runtimeInfo?(): CliRuntimeInfo
  promptSuggestion?(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<string | null>
}

interface TopLevelAgentCommands {
  launch(options: {
    prompt: string
    argv: string[]
    resumeSessionId?: string
  }): Promise<{ id: string; sessionId: string }>
  list(options: { cwd?: string; all: boolean }): Promise<TopLevelAgentSummary[]>
  logs(id: string): Promise<string>
  stop(id: string): Promise<void>
  attach(
    id: string,
    input: AsyncIterable<string | Uint8Array>,
    output: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<void>
}

export interface CliDependencies extends InteractiveServiceFactory {
  createService(options: {
    eventSink: RuntimeEventSink
    requireProvider: boolean
    approveRecovery?: (call: ModelToolCall) => boolean | Promise<boolean>
    approveTool?: (call: ModelToolCall) => boolean | Promise<boolean>
    agent?: string
    controls?: CliControls
    interactive?: boolean
    sessionKind?: 'bg'
    signal?: AbortSignal
  }): Promise<SessionCommands>
  runInteractive?(options: {
    agent?: string
    controls?: CliControls
    signal?: AbortSignal
  }): Promise<number>
  topLevelAgents?: TopLevelAgentCommands
  launchTmux?: typeof launchTmuxWorktree
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
  interactive = false,
  sessionKind,
  signal,
}) => {
  const claudeVersion = await detectInstalledClaudeVersion()
  const cwd = process.cwd()
  const workspace = new WorkspaceContext(cwd)
  const configuredRoot = process.env.CLAUDE_CONFIG_DIR
  const configRoot = resolve(configuredRoot ?? resolve(homedir(), '.claude'))
  const claudeStatePath = configuredRoot
    ? join(configRoot, '.claude.json')
    : resolve(homedir(), '.claude.json')
  const cli = await resolveCliControls(controls, cwd)
  let provider: ModelProvider | undefined
  let providerForModel: ((model: string) => ModelProvider) | undefined
  const context = parseContextEnvironment(process.env)
  if (requireProvider) {
    const apiKey = process.env.PRAXIS_API_KEY
    const model = cli.model ?? process.env.PRAXIS_MODEL
    if (!apiKey || !model) {
      throw new Error(
        'PRAXIS_API_KEY and a model (--model or PRAXIS_MODEL) are required',
      )
    }
    const providerEnvironment = parseProviderEnvironment(process.env)
    providerForModel = (selectedModel: string) => {
      const providerOptions = {
        apiKey,
        model: selectedModel,
        baseUrl: providerEnvironment.baseUrl,
        ...('contextWindowTokens' in context
          ? { contextWindowTokens: context.contextWindowTokens }
          : {}),
      }
      return providerEnvironment.provider === 'anthropic'
        ? new AnthropicCompatibleProvider({
            ...providerOptions,
            ...('maxOutputTokens' in providerEnvironment
              ? { maxOutputTokens: providerEnvironment.maxOutputTokens }
              : {}),
            ...('anthropicVersion' in providerEnvironment
              ? { anthropicVersion: providerEnvironment.anthropicVersion }
              : {}),
            ...('webSearch' in providerEnvironment
              ? { webSearch: providerEnvironment.webSearch }
              : {}),
          })
        : new OpenAICompatibleProvider(providerOptions)
    }
    const models = [model, ...(cli.fallbackModels ?? [])].filter(
      (candidate, index, all) => all.indexOf(candidate) === index,
    )
    const createProvider = providerForModel
    const providers = models.map((candidate) => createProvider(candidate))
    provider =
      providers.length > 1
        ? new FallbackModelProvider({ providers })
        : providers[0]
  }

  const options = {
    configRoot,
    cwd,
    claudeVersion,
    eventSink,
    sessionPersistence: cli.sessionPersistence,
    effort: cli.effort ?? 'high',
    ...(cli.jsonSchema ? { structuredOutputSchema: cli.jsonSchema } : {}),
    ...(cli.maxBudgetUsd === undefined
      ? {}
      : { maxBudgetUsd: cli.maxBudgetUsd }),
    pricing: ModelPricingRegistry.fromEnvironment(
      process.env.PRAXIS_PRICING_JSON,
    ),
    collectMetrics: true,
    ...(sessionKind === undefined ? {} : { sessionKind }),
    workspace,
    ...(cli.worktreeRequested
      ? {
          initialWorktree: true,
          ...(cli.worktreeName === undefined
            ? {}
            : { initialWorktreeName: cli.worktreeName }),
        }
      : {}),
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
      cwd: workspace.cwd(),
      ...(automaticSettingSources === undefined
        ? {}
        : { settingSources: automaticSettingSources }),
    })
  const permissions = new ClaudeExtensionPermissionResolver(
    new ClaudePermissionResolver({
      cwd,
      cwdProvider: () => workspace.cwd(),
      settings,
      allowedTools: cli.allowedTools,
      disallowedTools: cli.disallowedTools,
      permissionMode: cli.dangerouslySkipPermissions
        ? 'bypassPermissions'
        : cli.permissionMode,
      ...(cli.permissionMode === 'auto'
        ? { autoClassifier: createClaudeModelAutoClassifier(provider) }
        : {}),
    }),
  )
  const localTools = new LocalToolRegistry({
    cwd,
    cwdProvider: () => workspace.cwd(),
    ...(memoryDirectory ? { sharedMemoryDirectory: memoryDirectory } : {}),
    additionalDirectories: cli.additionalDirectories,
    additionalReadDirectories: [claudeBackgroundTaskParent(cwd)],
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
    const agentToolNames = ['Agent', 'SendMessage'] as const
    const taskToolNames = [
      'TaskCreate',
      'TaskGet',
      'TaskList',
      'TaskOutput',
      'TaskStop',
      'TaskUpdate',
    ] as const
    const scheduledToolNames = [
      'CronCreate',
      'CronDelete',
      'CronList',
      'ScheduleWakeup',
    ] as const
    const workflowToolNames = ['Workflow'] as const
    const worktreeToolNames = ['EnterWorktree', 'ExitWorktree'] as const
    const selectedAgentTools = agentToolNames.filter(
      (name) =>
        (cli.tools === undefined ||
          cli.tools.includes('default') ||
          cli.tools.includes(name)) &&
        !cli.disallowedTools.includes(name),
    )
    const selectedTaskTools = taskToolNames.filter(
      (name) =>
        cli.sessionPersistence &&
        !cli.bare &&
        (cli.tools === undefined ||
          cli.tools.includes('default') ||
          cli.tools.includes(name)) &&
        !cli.disallowedTools.includes(name),
    )
    const selectedScheduledTools = scheduledToolNames.filter(
      (name) =>
        !cli.bare &&
        (cli.tools === undefined ||
          cli.tools.includes('default') ||
          cli.tools.includes(name)) &&
        !cli.disallowedTools.includes(name),
    )
    const selectedWorkflowTools = workflowToolNames.filter(
      (name) =>
        cli.sessionPersistence &&
        !cli.bare &&
        (cli.tools === undefined ||
          cli.tools.includes('default') ||
          cli.tools.includes(name)) &&
        !cli.disallowedTools.includes(name),
    )
    const selectedWorktreeTools = worktreeToolNames.filter(
      (name) =>
        !cli.bare &&
        (cli.tools === undefined ||
          cli.tools.includes('default') ||
          cli.tools.includes(name)) &&
        !cli.disallowedTools.includes(name),
    )
    const enableBackgroundBash =
      cli.sessionPersistence &&
      !cli.bare &&
      (cli.tools === undefined ||
        cli.tools.includes('default') ||
        cli.tools.includes('Bash')) &&
      !cli.disallowedTools.includes('Bash')
    const selectedTaskRuntimeTools = [
      ...selectedTaskTools,
      ...(enableBackgroundBash ? ['Bash'] : []),
    ]
    const routedSubagentTools = [
      ...selectedAgentTools,
      ...selectedTaskTools.filter(
        (name) => name === 'TaskOutput' || name === 'TaskStop',
      ),
    ]
    const selectedBaseTools = cli.tools?.filter(
      (name) =>
        !agentToolNames.includes(name as (typeof agentToolNames)[number]) &&
        !taskToolNames.includes(name as (typeof taskToolNames)[number]) &&
        !scheduledToolNames.includes(
          name as (typeof scheduledToolNames)[number],
        ) &&
        !workflowToolNames.includes(
          name as (typeof workflowToolNames)[number],
        ) &&
        !worktreeToolNames.includes(
          name as (typeof worktreeToolNames)[number],
        ) &&
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
    const enableSubagents = !cli.bare && selectedAgentTools.length > 0
    const service = new ClaudeSessionService({
      ...options,
      provider,
      ...(providerForModel ? { providerForModel } : {}),
      tools: filteredTools,
      permissions,
      extensions,
      enableSubagents,
      subagentToolNames: routedSubagentTools,
      taskToolNames: selectedTaskRuntimeTools,
      scheduledToolNames: selectedScheduledTools,
      enableDynamicWakeups: interactive,
      enableWorkflows: selectedWorkflowTools.length > 0,
      enableWorktrees:
        cli.worktreeRequested || selectedWorktreeTools.length > 0,
      worktreeToolNames: selectedWorktreeTools,
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
      ...selectedTaskTools,
      ...selectedScheduledTools,
      ...selectedWorkflowTools,
      ...selectedWorktreeTools,
      ...(enableSubagents ? selectedAgentTools : []),
    ]
    const runtimeInfo: CliRuntimeInfo = {
      cwd: workspace.cwd(),
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
      run: (prompt, signal, sessionId, name, images, documents) =>
        service.run(
          prompt,
          signal,
          sessionId,
          name ?? cli.name,
          images,
          documents,
        ),
      resume: (sessionId, prompt, signal, name, images, documents) =>
        service.resume(
          sessionId,
          prompt,
          signal,
          name ?? cli.name,
          images,
          documents,
        ),
      fork: (sessionId, targetSessionId) =>
        service.fork(sessionId, targetSessionId),
      sessions: () => service.sessions(),
      inspect: (sessionId) => service.inspect(sessionId),
      export: (sessionId) => service.export(sessionId),
      nextScheduledPrompt: (signal) => service.nextScheduledPrompt(signal),
      close: async () => {
        await service.close()
        await mcpTools.close()
      },
      runtimeInfo: () => ({
        ...runtimeInfo,
        cwd: workspace.cwd(),
        model: provider.model ?? process.env.PRAXIS_MODEL ?? 'unknown',
      }),
      promptSuggestion: (sessionId, suggestionSignal) =>
        service.promptSuggestion(sessionId, suggestionSignal),
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
  runInteractive: ({ agent, controls, signal }) =>
    renderInteractive({
      factory: {
        createService: (options) =>
          createDefaultService({
            ...options,
            ...(agent === undefined ? {} : { agent }),
            ...(controls === undefined ? {} : { controls }),
            interactive: true,
          }),
        scheduledPrompts: true,
      },
      ...(signal ? { signal } : {}),
    }),
  topLevelAgents: new TopLevelAgentManager({
    configRoot: resolve(
      process.env.CLAUDE_CONFIG_DIR ?? resolve(homedir(), '.claude'),
    ),
    cwd: process.cwd(),
    cliPath: fileURLToPath(import.meta.url),
    version: VERSION,
  }),
  launchTmux: launchTmuxWorktree,
}

async function runBackgroundWorker(id: string): Promise<void> {
  const configRoot = resolve(
    process.env.CLAUDE_CONFIG_DIR ?? resolve(homedir(), '.claude'),
  )
  await runTopLevelAgentWorker({
    configRoot,
    id,
    async createRuntime(workerSink, dispatch) {
      const invocation = parseCliInvocation(dispatch.argv)
      return createDefaultService({
        eventSink: workerSink,
        requireProvider: true,
        ...(invocation.agent ? { agent: invocation.agent } : {}),
        controls: invocation,
        sessionKind: 'bg',
      })
    },
  })
}

function writeJson(io: CliIO, value: unknown): void {
  io.stdout(`${JSON.stringify(value)}\n`)
}

function formatSessionIssue(issue: SessionSummary['issue']): string {
  return issue
    ? `line ${issue.lineNumber}, byte ${issue.byteOffset}: ${issue.message}`
    : ''
}

function mcpOutput(io: CliIO, invocation: CliInvocation, value: unknown): void {
  if (invocation.legacyJson || invocation.outputFormat !== 'text') {
    writeJson(io, value)
  } else if (typeof value === 'string') {
    io.stdout(`${value}\n`)
  } else {
    io.stdout(`${JSON.stringify(value)}\n`)
  }
}

function mcpRecordJson(record: McpServerRecord): Record<string, unknown> {
  return {
    name: record.name,
    scope: record.scope,
    path: record.path,
    config: record.config,
  }
}

function autoModeJson(config: ReturnType<typeof defaultClaudeAutoModeConfig>) {
  return {
    allow: config.allow,
    soft_deny: config.softDeny,
    hard_deny: config.hardDeny,
    environment: config.environment,
    classifyAllShell: config.classifyAllShell,
  }
}

async function executeAutoModeCommand(
  args: readonly string[],
  invocation: CliInvocation,
  io: CliIO,
): Promise<number> {
  const action = args[1]
  if (!action || action === 'help') {
    io.stdout('Usage: praxis auto-mode <config|defaults>\n')
    return 0
  }
  if (args.length !== 2) {
    throw new Error(`auto-mode ${action} takes no operands`)
  }
  if (action === 'defaults') {
    const output = autoModeJson(defaultClaudeAutoModeConfig())
    if (invocation.legacyJson || invocation.outputFormat !== 'text')
      writeJson(io, output)
    else io.stdout(`${JSON.stringify(output)}\n`)
    return 0
  }
  if (action === 'config') {
    const configRoot = resolve(
      process.env.CLAUDE_CONFIG_DIR ?? resolve(homedir(), '.claude'),
    )
    const settings = await loadClaudeSettings({
      configRoot,
      cwd: process.cwd(),
    })
    const output = autoModeJson(loadClaudeAutoModeConfig(settings))
    if (invocation.legacyJson || invocation.outputFormat !== 'text')
      writeJson(io, output)
    else io.stdout(`${JSON.stringify(output)}\n`)
    return 0
  }
  throw new Error(`Unknown auto-mode command: ${action}`)
}

async function executeMcpCommand(
  args: readonly string[],
  invocation: CliInvocation,
  io: CliIO,
): Promise<number> {
  const action = args[1]
  if (!action || action === 'help') {
    io.stdout(
      'Usage: praxis mcp <list|get|add|add-json|remove|reset-project-choices>\n',
    )
    return 0
  }
  const management = new ClaudeMcpManagement({ cwd: process.cwd() })
  const scope = invocation.mcpScope ? mcpScope(invocation.mcpScope) : undefined
  if (action === 'list') {
    if (args.length !== 2) throw new Error('mcp list takes no operands')
    const servers = await management.list(scope)
    if (invocation.legacyJson || invocation.outputFormat !== 'text') {
      mcpOutput(io, invocation, {
        type: 'mcp-list',
        servers: servers.map(mcpRecordJson),
      })
    } else {
      for (const server of servers) {
        io.stdout(
          `${server.name}\t${server.scope}\t${JSON.stringify(server.config)}\n`,
        )
      }
    }
    return 0
  }
  if (action === 'get') {
    if (args.length !== 3) throw new Error('mcp get requires a server name')
    const server = await management.get(args[2] as string, scope)
    mcpOutput(io, invocation, {
      type: 'mcp-server',
      server: mcpRecordJson(server),
    })
    return 0
  }
  if (action === 'add-json') {
    if (args.length !== 4)
      throw new Error('mcp add-json requires name and JSON')
    let config: unknown
    try {
      config = JSON.parse(args[3] as string)
    } catch (error) {
      throw new Error('mcp add-json requires valid JSON', { cause: error })
    }
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error('mcp add-json server config must be an object')
    }
    const server = await management.add(
      args[2] as string,
      config as Record<string, unknown>,
      scope ?? 'local',
    )
    mcpOutput(io, invocation, {
      type: 'mcp-added',
      server: mcpRecordJson(server),
    })
    return 0
  }
  if (action === 'add') {
    if (args.length < 4)
      throw new Error('mcp add requires name and command or URL')
    const name = args[2] as string
    const commandOrUrl = args[3] as string
    const config = /^https?:\/\//u.test(commandOrUrl)
      ? { type: 'http', url: commandOrUrl }
      : { type: 'stdio', command: commandOrUrl, args: args.slice(4) }
    const server = await management.add(name, config, scope ?? 'local')
    mcpOutput(io, invocation, {
      type: 'mcp-added',
      server: mcpRecordJson(server),
    })
    return 0
  }
  if (action === 'remove') {
    if (args.length !== 3) throw new Error('mcp remove requires a server name')
    const server = await management.remove(args[2] as string, scope)
    mcpOutput(io, invocation, {
      type: 'mcp-removed',
      server: mcpRecordJson(server),
    })
    return 0
  }
  if (action === 'reset-project-choices') {
    if (args.length !== 2) {
      throw new Error('mcp reset-project-choices takes no operands')
    }
    await management.resetProjectChoices()
    mcpOutput(io, invocation, 'Reset project MCP choices')
    return 0
  }
  throw new Error(`Unknown mcp command: ${action}`)
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

function backgroundWorkerArgv(argv: readonly string[]): string[] {
  const filtered: string[] = []
  let optionsEnded = false
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === undefined) continue
    if (!optionsEnded && value === '--') {
      optionsEnded = true
      filtered.push(value)
      continue
    }
    if (!optionsEnded && (value === '--bg' || value === '--background')) {
      continue
    }
    if (!optionsEnded && value === '--session-id') {
      index += 1
      continue
    }
    if (!optionsEnded && value.startsWith('--session-id=')) continue
    filtered.push(value)
  }
  return filtered
}

function requireTopLevelAgentManager(
  dependencies: CliDependencies,
): TopLevelAgentCommands {
  if (!dependencies.topLevelAgents) {
    throw new Error('Top-level agent manager unavailable')
  }
  return dependencies.topLevelAgents
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
  if (argv[0] === '__background-worker') {
    await runBackgroundWorker(requireValue(argv[1], 'Agent ID'))
    return 0
  }
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
  if (
    (invocation.fallbackModels !== undefined ||
      invocation.jsonSchema !== undefined ||
      invocation.maxBudgetUsd !== undefined) &&
    !invocation.print
  ) {
    throw new Error(
      '--fallback-model, --json-schema, and --max-budget-usd require --print',
    )
  }
  if (invocation.tmux) {
    if (!dependencies.launchTmux) throw new Error('tmux launcher unavailable')
    const launched = await dependencies.launchTmux({
      argv,
      cwd: process.cwd(),
      cliPath: fileURLToPath(import.meta.url),
      ...(invocation.worktreeName === undefined
        ? {}
        : { worktreeName: invocation.worktreeName }),
      attach: Boolean(io.isTTY),
    })
    if (!io.isTTY) io.stdout(`Started tmux session ${launched.sessionName}\n`)
    return 0
  }
  if (
    io.isTTY &&
    dependencies.runInteractive &&
    args.length === 0 &&
    !invocation.print &&
    !invocation.background
  ) {
    return dependencies.runInteractive({
      ...(agent === undefined ? {} : { agent }),
      controls: invocation,
      ...(signal ? { signal } : {}),
    })
  }
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
    'agents',
    'attach',
    'logs',
    'stop',
    'mcp',
    'auto-mode',
  ].includes(command ?? '')
  if (retryInterruptedTools && command !== 'resume') {
    throw new Error('--retry-interrupted-tools is only valid with resume')
  }
  if (agent && knownCommand && !['run', 'resume'].includes(command ?? 'run')) {
    throw new Error('--agent is only valid with run or resume')
  }
  if (
    (invocation.agentsAll || invocation.agentsCwd !== undefined) &&
    command !== 'agents'
  ) {
    throw new Error('--all and --cwd are only valid with agents')
  }
  if (invocation.mcpScope !== undefined && command !== 'mcp') {
    throw new Error('--scope is only valid with mcp commands')
  }
  if (command === 'mcp') {
    return executeMcpCommand(args, invocation, io)
  }
  if (command === 'auto-mode') {
    return executeAutoModeCommand(args, invocation, io)
  }
  const expectedOperands =
    command === 'sessions' || command === 'agents' ? 1 : 2
  if (
    [
      'sessions',
      'fork',
      'inspect',
      'export',
      'agents',
      'attach',
      'logs',
      'stop',
    ].includes(command ?? '') &&
    args.length > expectedOperands
  ) {
    throw new Error(
      `Unexpected operand for ${command}: ${args[expectedOperands]}`,
    )
  }
  if (command === 'agents') {
    const agents = await requireTopLevelAgentManager(dependencies).list({
      ...(invocation.agentsCwd === undefined
        ? {}
        : { cwd: invocation.agentsCwd }),
      all: invocation.agentsAll,
    })
    if (invocation.legacyJson) writeJson(io, agents)
    else {
      for (const current of agents) {
        io.stdout(
          `${current.id}\t${current.status ?? current.state}\t${current.cwd}\t${current.name}\n`,
        )
      }
    }
    return 0
  }
  if (command === 'logs') {
    io.stdout(
      await requireTopLevelAgentManager(dependencies).logs(
        requireValue(args[1], 'Agent ID'),
      ),
    )
    return 0
  }
  if (command === 'stop') {
    const id = requireValue(args[1], 'Agent ID')
    await requireTopLevelAgentManager(dependencies).stop(id)
    io.stdout(`stopped ${id}\n`)
    return 0
  }
  if (command === 'attach') {
    const input = io.readStdinLines?.()
    if (!input) throw new Error('attach requires stdin support')
    await requireTopLevelAgentManager(dependencies).attach(
      requireValue(args[1], 'Agent ID'),
      input,
      (text) => io.stdout(text),
      signal,
    )
    return 0
  }
  if (invocation.background) {
    if (!invocation.sessionPersistence) {
      throw new Error('--bg requires session persistence')
    }
    if (inputFormat !== 'text' || outputFormat !== 'text') {
      throw new Error('--bg only supports text input and output')
    }
    if (command && knownCommand && command !== 'run' && command !== 'resume') {
      throw new Error(`--bg cannot be combined with ${command}`)
    }
    const prompt = promptFrom(
      command === 'resume'
        ? args.slice(2)
        : command === 'run'
          ? args.slice(1)
          : args,
    )
    let resumeSessionId =
      command === 'resume' ? requireValue(args[1], 'Session ID') : undefined
    if (
      invocation.continueSession ||
      (resumeSessionId && invocation.forkSession)
    ) {
      const sessionService = await dependencies.createService({
        eventSink: () => undefined,
        requireProvider: false,
        controls: invocation,
      })
      try {
        if (!resumeSessionId) {
          const latest = (await sessionService.sessions())[0]
          if (!latest) throw new Error('No conversation found to continue')
          resumeSessionId = latest.sessionId
        }
        if (invocation.forkSession) {
          resumeSessionId = (await sessionService.fork(resumeSessionId))
            .sessionId
        }
      } finally {
        await sessionService.close?.()
      }
    }
    if (invocation.sessionId) {
      io.stderr(
        'warning: --bg manages the session id; ignoring --session-id (use --resume <id> to continue an existing session)\n',
      )
    }
    const launched = await requireTopLevelAgentManager(dependencies).launch({
      prompt,
      argv: backgroundWorkerArgv(argv),
      ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
    })
    io.stdout(
      `backgrounded · ${launched.id}\n  praxis agents             list sessions\n  praxis attach ${launched.id}    open in this terminal\n  praxis logs ${launched.id}      show recent output\n  praxis stop ${launched.id}      stop this session\n`,
    )
    return 0
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
              ? await service.resume(
                  activeSessionId,
                  prompt,
                  signal,
                  undefined,
                  streamMessage?.images,
                  streamMessage?.documents,
                )
              : await service.resume(
                  activeSessionId,
                  prompt,
                  undefined,
                  undefined,
                  streamMessage?.images,
                  streamMessage?.documents,
                )
            : signal
              ? await service.run(
                  prompt,
                  signal,
                  activeSessionId,
                  undefined,
                  streamMessage?.images,
                  streamMessage?.documents,
                )
              : await service.run(
                  prompt,
                  undefined,
                  activeSessionId,
                  undefined,
                  streamMessage?.images,
                  streamMessage?.documents,
                )
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
        const resultRuntimeInfo = service.runtimeInfo?.() ?? runtimeInfo
        writeJson(
          io,
          createSuccessResult(
            result,
            resultRuntimeInfo,
            startedAt,
            Math.max(1, jsonModelTurns),
          ),
        )
      } else if (outputFormat !== 'text')
        writeJson(io, { type: 'result', ...result })
      else io.stdout('\n')
      if (streamOutput && invocation.promptSuggestions) {
        try {
          const suggestion = await service.promptSuggestion?.(
            activeSessionId,
            signal,
          )
          if (suggestion) streamOutput.promptSuggestion(suggestion)
        } catch {
          // Prompt suggestions are auxiliary and must not change turn success.
        }
      }
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
