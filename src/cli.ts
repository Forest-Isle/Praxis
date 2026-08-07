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
  type ToolRegistry,
  type RuntimeEventSink,
} from './core/runtime.js'
import {
  runInteractive as renderInteractive,
  type InteractiveServiceFactory,
} from './cli/interactive.js'
import { DEFAULT_CLI_CONTROLS, resolveCliControls } from './cli/controls.js'
import {
  ClaudePermissionResolver,
  type ClaudePermissionMode,
} from './permissions/claude-permission-resolver.js'
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
import {
  authenticateMcpServer,
  ClaudeMcpOAuthStore,
  mcpOAuthServerIdentity,
} from './mcp/claude-mcp-oauth.js'
import { servePraxisMcpStdio } from './mcp/praxis-mcp-server.js'
import { detectInstalledClaudeVersion } from './platform/claude-version.js'
import {
  redactSensitiveText,
  sensitiveEnvironmentValues,
} from './platform/sensitive-data.js'
import { AnthropicCompatibleProvider } from './providers/anthropic-compatible.js'
import { FallbackModelProvider } from './providers/fallback-provider.js'
import { OpenAICompatibleProvider } from './providers/openai-compatible.js'
import {
  parseContextEnvironment,
  parseProviderEnvironment,
} from './providers/environment.js'
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
  readStreamJsonMessages,
  StreamJsonOutput,
  type CliOutputFormat,
  type CliControls,
  type CliInvocation,
  type CliRuntimeInfo,
  type CliElicitationRequest,
  type CliElicitationResult,
  type StreamUserMessage,
  type StreamJsonMessage,
  type StreamControlResponse,
} from './cli/protocol.js'
import {
  initClaudePlugin,
  installClaudePlugin,
  loadClaudePlugins,
  readPluginRegistry,
  setClaudePluginEnabled,
  uninstallClaudePlugin,
  updateClaudePlugin,
  validateClaudePlugin,
} from './plugins/claude-plugin-runtime.js'
import {
  addClaudeMarketplace,
  installClaudeMarketplacePlugin,
  listNativePluginRecords,
  readClaudeKnownMarketplaces,
  removeClaudeMarketplace,
  setNativePluginEnabled,
  uninstallNativePlugin,
  updateClaudeMarketplace,
  updateNativePlugin,
  type ClaudePluginScope,
} from './plugins/claude-plugin-marketplace.js'
import { formatDoctorReport, runDoctor } from './maintenance/doctor.js'
import {
  runSelfUpdate,
  type SelfUpdateResult,
} from './maintenance/self-update.js'
import {
  executeClaudeProjectPurge,
  planClaudeProjectPurge,
  type ClaudeProjectPurgeItem,
  type ClaudeProjectPurgeResult,
  type ClaudeProjectPurgeSelection,
} from './application/claude-project-purge.js'

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
  praxis mcp <list|get|add|add-json|remove|reset-project-choices|login|logout|serve> ...
  praxis auto-mode <config|defaults>
  praxis plugin <list|install|uninstall|enable|disable|update|init|validate> ...
  praxis doctor [--json]
  praxis install [--force] [stable|latest|version]
  praxis update|upgrade
  praxis project purge [options] [path]

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
  --no-browser                       Print MCP OAuth URL without opening a browser
  -d, --debug                        Enable MCP server debug logging
  --no-session-persistence            Keep print-mode session in memory only
  --agent <name>                      Select a shared agent definition
  --settings <file-or-json>           Load additional settings
  --setting-sources <sources>         user, project, local, or an empty list
  --safe-mode                         Disable shared customizations
  --bare                              Use only explicitly supplied context
  --system-prompt <prompt>            Set system prompt
  --append-system-prompt <prompt>     Append system prompt
  --add-dir <directories...>          Allow access to additional directories
  --plugin-dir <path>                Load a local plugin directory or .zip for this session (repeatable)
  --plugin-url <url>                 Load a plugin .zip URL for this session (repeatable)
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
  --include-hook-events               Emit hook_started/progress/response records
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

const DOCTOR_HELP = `Usage: praxis doctor [options]

Check Praxis installation and local single-user configuration health.

Options:
  --json      Output a machine-readable report
  -h, --help  Show help
`

const PROJECT_PURGE_HELP = `Usage: praxis project purge [options] [path]

Delete all Claude Code state for a project (transcripts, tasks, file history,
config entry)

Options:
  --all              Purge state for every project (mutually exclusive with [path])
  --dry-run          List what would be deleted without deleting anything
  -i, --interactive  Prompt for each item before deleting
  -y, --yes          Skip confirmation prompt
  -h, --help         Show help
`

const INSTALL_HELP = `Usage: praxis install [options] [target]

Install Praxis global npm package. Target may be stable, latest, next, beta,
canary, or an exact semantic version.

Options:
  --force     Force installation even if already installed
  --json      Output a machine-readable result
  -h, --help  Show help
`

const UPDATE_HELP = `Usage: praxis update|upgrade [options]

Install latest Praxis global npm package.

Options:
  --json      Output a machine-readable result
  -h, --help  Show help
`

export { parseContextEnvironment, parseProviderEnvironment }

export interface CliIO {
  stdout(message: string | Uint8Array): void
  stderr(message: string): void
  isTTY?: boolean
  readStdinLines?: () => AsyncIterable<string | Uint8Array>
}

interface SessionCommands {
  toolRegistry?: ToolRegistry
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
    exposeToolRegistry?: boolean
    onElicitation?: (
      request: CliElicitationRequest,
    ) => Promise<CliElicitationResult>
  }): Promise<SessionCommands>
  runInteractive?(options: {
    agent?: string
    controls?: CliControls
    signal?: AbortSignal
  }): Promise<number>
  topLevelAgents?: TopLevelAgentCommands
  launchTmux?: typeof launchTmuxWorktree
  mcpAuthenticate?: typeof authenticateMcpServer
  mcpServe?: typeof servePraxisMcpStdio
  selfUpdate?: (options: {
    operation: 'install' | 'update'
    target?: string
    force?: boolean
  }) => Promise<SelfUpdateResult>
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
  exposeToolRegistry = false,
  onElicitation,
}) => {
  const claudeVersion = await detectInstalledClaudeVersion()
  const cwd = process.cwd()
  const workspace = new WorkspaceContext(cwd)
  const configuredRoot = process.env.CLAUDE_CONFIG_DIR || undefined
  const configRoot = resolve(configuredRoot ?? resolve(homedir(), '.claude'))
  const claudeStatePath = configuredRoot
    ? join(configRoot, '.claude.json')
    : resolve(homedir(), '.claude.json')
  const cli = await resolveCliControls(controls, cwd)
  let provider: ModelProvider | undefined
  let providerForModel: ((model: string) => ModelProvider) | undefined
  const context = parseContextEnvironment(process.env)
  const apiKey = process.env.PRAXIS_API_KEY
  const model = cli.model ?? process.env.PRAXIS_MODEL
  if (requireProvider && (!apiKey || !model)) {
    throw new Error(
      'PRAXIS_API_KEY and a model (--model or PRAXIS_MODEL) are required',
    )
  }
  if (apiKey && model) {
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
  if (!provider && !exposeToolRegistry) return new ClaudeSessionService(options)
  const toolProvider: ModelProvider = provider ?? {
    model: 'praxis/provider',
    capabilities: {
      streaming: true,
      usage: true,
      tools: true,
      images: true,
      documents: true,
      webSearch: true,
    },
    complete: () => ({
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          throw new Error(
            'A model provider is required to execute model-backed tools',
          )
        },
      }),
    }),
  }
  const hostedToolProvider: ModelProvider =
    exposeToolRegistry && !toolProvider.capabilities.webSearch
      ? {
          ...(toolProvider.model === undefined
            ? {}
            : { model: toolProvider.model }),
          capabilities: { ...toolProvider.capabilities, webSearch: true },
          complete: (request) => toolProvider.complete(request),
        }
      : toolProvider

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
  const pluginResources = await loadClaudePlugins({
    configRoot,
    cwd,
    pluginDirectories: cli.pluginDirectories,
    pluginUrls: cli.pluginUrls,
    strictPluginDirectories:
      cli.pluginDirectories.length + cli.pluginUrls.length > 0,
    loadInstalled: !cli.safeMode && !cli.bare,
  })
  for (const plugin of pluginResources.plugins) {
    for (const error of plugin.errors) {
      eventSink({
        type: 'warning',
        message: `Plugin ${plugin.name} could not be loaded: ${error}`,
      })
    }
  }
  settings.push(...pluginResources.settings)
  const resources = {
    ...loadedResources,
    commands: [...loadedResources.commands, ...pluginResources.commands],
    skills: [...loadedResources.skills, ...pluginResources.skills],
    agents: [...loadedResources.agents, ...pluginResources.agents],
    settings: [
      ...loadedResources.settings,
      ...pluginResources.settings,
      ...(cli.additionalSettings ? [cli.additionalSettings] : []),
    ],
    mcp: [...loadedResources.mcp, ...pluginResources.mcp],
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
  const permissionResolverForMode = (permissionMode: ClaudePermissionMode) =>
    new ClaudeExtensionPermissionResolver(
      new ClaudePermissionResolver({
        cwd,
        cwdProvider: () => workspace.cwd(),
        settings,
        allowedTools: cli.allowedTools,
        disallowedTools: cli.disallowedTools,
        permissionMode,
        ...(permissionMode === 'auto'
          ? {
              autoClassifier:
                createClaudeModelAutoClassifier(hostedToolProvider),
            }
          : {}),
      }),
    )
  const permissions = permissionResolverForMode(
    cli.dangerouslySkipPermissions ? 'bypassPermissions' : cli.permissionMode,
  )
  const localTools = new LocalToolRegistry({
    cwd,
    cwdProvider: () => workspace.cwd(),
    enableReportFindings: exposeToolRegistry,
    ...(memoryDirectory ? { sharedMemoryDirectory: memoryDirectory } : {}),
    additionalDirectories: cli.additionalDirectories,
    additionalReadDirectories: [claudeBackgroundTaskParent(cwd)],
  })
  const mcpTools = await ClaudeMcpToolRegistry.connect({
    base: cli.bare
      ? localTools
      : new WebToolRegistry({
          base: localTools,
          provider: hostedToolProvider,
        }),
    resources: resources.mcp,
    cwd,
    configRoot,
    onWarning: (message) => eventSink({ type: 'warning', message }),
    ...(onElicitation ? { onElicitation } : {}),
    eventSink,
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
      provider: hostedToolProvider,
      ...(providerForModel ? { providerForModel } : {}),
      tools: filteredTools,
      permissions,
      permissionResolverForMode,
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
        : {
            hooks: new ClaudeHookRunner({
              settings,
              cwd,
              onEvent: (event) => eventSink({ type: 'hook', event }),
            }),
          }),
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
      model: provider?.model ?? process.env.PRAXIS_MODEL ?? 'unknown',
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
      plugins: pluginResources.plugins
        .filter((plugin) => plugin.enabled && plugin.errors.length === 0)
        .map((plugin) => ({ name: plugin.name, path: plugin.path })),
      claudeCodeVersion: claudeVersion,
    }
    const toolRegistry = exposeToolRegistry
      ? service.createHostedToolRegistry(randomUUID())
      : filteredTools
    return {
      toolRegistry,
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
        model: provider?.model ?? process.env.PRAXIS_MODEL ?? 'unknown',
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
  selfUpdate: runSelfUpdate,
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

async function executeDoctorCommand(
  args: readonly string[],
  invocation: CliInvocation,
  io: CliIO,
): Promise<number> {
  if (args.length !== 1) throw new Error('doctor takes no operands')
  if (
    invocation.outputFormat !== 'text' &&
    invocation.outputFormat !== 'json' &&
    !invocation.legacyJson
  ) {
    throw new Error('doctor output format must be text or json')
  }
  const configuredRoot = process.env.CLAUDE_CONFIG_DIR || undefined
  const configRoot = resolve(configuredRoot ?? resolve(homedir(), '.claude'))
  const claudeStatePath = configuredRoot
    ? join(configRoot, '.claude.json')
    : resolve(homedir(), '.claude.json')
  const report = await runDoctor({
    version: VERSION,
    executablePath: fileURLToPath(import.meta.url),
    nodeExecutablePath: process.execPath,
    nodeVersion: process.version,
    configRoot,
    claudeStatePath,
    cwd: process.cwd(),
    environment: process.env,
  })
  if (invocation.legacyJson || invocation.outputFormat === 'json') {
    writeJson(io, report)
  } else {
    io.stdout(formatDoctorReport(report))
  }
  return report.ok ? 0 : 1
}

async function executeSelfUpdateCommand(
  argv: readonly string[],
  io: CliIO,
  dependencies: CliDependencies,
): Promise<number> {
  const command = argv[0]
  const values = argv.slice(1)
  if (values.includes('--help') || values.includes('-h')) {
    io.stdout(command === 'install' ? INSTALL_HELP : UPDATE_HELP)
    return 0
  }
  const json = values.includes('--json')
  const operands = values.filter((value) => value !== '--json')
  if (command === 'update' || command === 'upgrade') {
    if (operands.length > 0) {
      throw new Error(`${command} takes no operands`)
    }
    const result = await dependencies.selfUpdate?.({ operation: 'update' })
    if (!result) throw new Error('Self-update unavailable')
    if (json) writeJson(io, result)
    else io.stdout(`Praxis update completed: ${result.output}\n`)
    return 0
  }
  let force = false
  const targets = []
  for (const value of operands) {
    if (value === '--force') force = true
    else targets.push(value)
  }
  if (targets.length > 1) throw new Error('install accepts at most one target')
  const result = await dependencies.selfUpdate?.({
    operation: 'install',
    force,
    ...(targets[0] === undefined ? {} : { target: targets[0] }),
  })
  if (!result) throw new Error('Self-update unavailable')
  if (json) writeJson(io, result)
  else io.stdout(`Praxis install completed: ${result.output}\n`)
  return 0
}

async function executeProjectPurgeCommand(
  argv: readonly string[],
  io: CliIO,
): Promise<number> {
  let all = false
  let dryRun = false
  let interactive = false
  let yes = false
  let help = false
  let json = false
  const passthrough: string[] = []
  let path: string | undefined
  let optionsEnded = false
  for (let index = 2; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === undefined) continue
    if (!optionsEnded && value === '--') {
      optionsEnded = true
      continue
    }
    if (value === '--all') {
      all = true
      continue
    }
    if (value === '--dry-run') {
      dryRun = true
      continue
    }
    if (value === '-i' || value === '--interactive') {
      interactive = true
      continue
    }
    if (value === '-y' || value === '--yes') {
      yes = true
      continue
    }
    if (value === '--json') {
      json = true
      continue
    }
    if (value === '-h' || value === '--help') {
      help = true
      continue
    }
    if (!optionsEnded && value.startsWith('-')) {
      passthrough.push(value)
      continue
    }
    if (path !== undefined) throw new Error('project purge accepts one path')
    path = value
  }
  if (help) {
    io.stdout(PROJECT_PURGE_HELP)
    return 0
  }
  if (passthrough.length > 0) {
    throw new Error(`Unknown project purge option: ${passthrough[0]}`)
  }
  if (all && path !== undefined) {
    throw new Error('Cannot specify both a path and --all')
  }
  if (interactive && yes) {
    throw new Error('--interactive cannot be combined with --yes')
  }
  const configuredRoot = process.env.CLAUDE_CONFIG_DIR || undefined
  const configRoot = resolve(configuredRoot ?? resolve(homedir(), '.claude'))
  const statePath = configuredRoot
    ? join(configRoot, '.claude.json')
    : resolve(homedir(), '.claude.json')
  const plan = await planClaudeProjectPurge({
    cwd: process.cwd(),
    ...(path === undefined ? {} : { path }),
    ...(all ? { all: true } : {}),
    configRoot,
    statePath,
  })
  const jsonValue = (result: ClaudeProjectPurgeResult) => ({
    type: 'project-purge',
    plan,
    result: {
      ...result,
      failures: result.failures.map((failure) => ({
        item: failure.item,
        error: redactSensitiveText(
          failure.error.message,
          sensitiveEnvironmentValues(process.env),
        ),
      })),
    },
  })
  if (dryRun) {
    const result = await executeClaudeProjectPurge(plan, { dryRun: true })
    if (json) writeJson(io, jsonValue(result))
    else {
      io.stdout(
        `${plan.items.length} item(s) would be deleted for ${plan.mode === 'all' ? 'all projects' : plan.targetPath}\n`,
      )
      for (const item of plan.items) io.stdout(`  ${item.kind}\t${item.path}\n`)
    }
    return 0
  }
  if (plan.items.length === 0) {
    if (json) {
      writeJson(
        io,
        jsonValue({
          dryRun: false,
          aborted: false,
          deleted: [],
          skipped: [],
          failures: [],
        }),
      )
    } else io.stdout('No project state found.\n')
    return 0
  }

  let inputIterator: AsyncIterator<string | Uint8Array> | undefined
  if (!yes) {
    const input = io.readStdinLines?.()
    if (!input) throw new Error('project purge requires --yes without stdin')
    inputIterator = input[Symbol.asyncIterator]()
  }
  const nextAnswer = async (): Promise<string> => {
    const next = await inputIterator?.next()
    return typeof next?.value === 'string'
      ? next.value.trim().toLowerCase()
      : next?.value instanceof Uint8Array
        ? Buffer.from(next.value).toString('utf8').trim().toLowerCase()
        : ''
  }
  let confirmed = yes
  if (!yes && !interactive) {
    io.stderr(
      `Delete ${plan.items.length} item(s) for ${plan.mode === 'all' ? 'all projects' : plan.targetPath}? [y/N] `,
    )
    confirmed = ['y', 'yes'].includes(await nextAnswer())
    if (!confirmed) {
      io.stderr('Purge cancelled.\n')
      return 1
    }
  }
  const selectItem = interactive
    ? async (
        item: ClaudeProjectPurgeItem,
      ): Promise<ClaudeProjectPurgeSelection> => {
        io.stderr(`Delete ${item.description} (${item.path})? [y/N/a/q] `)
        const answer = await nextAnswer()
        if (answer === 'a' || answer === 'all') return 'delete-all'
        if (answer === 'q' || answer === 'quit') return 'abort'
        return answer === 'y' || answer === 'yes' ? 'delete' : 'skip'
      }
    : undefined
  const result = await executeClaudeProjectPurge(plan, {
    ...(selectItem ? { selectItem } : {}),
  })
  if (json) {
    writeJson(io, jsonValue(result))
  } else {
    for (const item of result.deleted) io.stdout(`deleted\t${item.path}\n`)
    for (const item of result.skipped) io.stdout(`skipped\t${item.path}\n`)
    for (const failure of result.failures) {
      io.stderr(`failed\t${failure.item.path}\t${failure.error.message}\n`)
    }
    if (result.aborted) io.stderr('Purge cancelled.\n')
  }
  return result.failures.length === 0 && !result.aborted ? 0 : 1
}

function pluginOutput(
  io: CliIO,
  invocation: CliInvocation,
  value: unknown,
): void {
  if (invocation.legacyJson || invocation.outputFormat !== 'text') {
    writeJson(io, value)
  } else if (typeof value === 'string') {
    io.stdout(`${value}\n`)
  } else {
    io.stdout(`${JSON.stringify(value)}\n`)
  }
}

function isClaudeMarketplacePluginId(value: string): boolean {
  const separator = value.lastIndexOf('@')
  return (
    separator > 0 &&
    separator < value.length - 1 &&
    !value.includes('/') &&
    !value.includes('\\')
  )
}

async function executePluginCommand(
  args: readonly string[],
  invocation: CliInvocation,
  io: CliIO,
): Promise<number> {
  const action = args[1]
  const cwd = process.cwd()
  const configRoot = resolve(
    process.env.CLAUDE_CONFIG_DIR ?? resolve(homedir(), '.claude'),
  )
  const requestedScope = invocation.mcpScope as ClaudePluginScope | undefined
  const installScope = requestedScope ?? 'user'
  if (!action || action === 'help') {
    io.stdout(
      'Usage: praxis plugin <list|install|uninstall|enable|disable|update|init|validate|marketplace> ...\n',
    )
    return 0
  }
  if (action === 'marketplace') {
    const marketplaceAction = args[2]
    if (!marketplaceAction || marketplaceAction === 'help') {
      io.stdout(
        'Usage: praxis plugin marketplace <list|add|remove|update> ...\n',
      )
      return 0
    }
    if (marketplaceAction === 'list') {
      if (args.length !== 3)
        throw new Error('plugin marketplace list takes no operands')
      pluginOutput(
        io,
        invocation,
        await readClaudeKnownMarketplaces(configRoot),
      )
      return 0
    }
    if (marketplaceAction === 'add') {
      if (args.length !== 4)
        throw new Error('plugin marketplace add requires a source')
      pluginOutput(io, invocation, {
        type: 'plugin-marketplace-added',
        marketplace: await addClaudeMarketplace(
          configRoot,
          cwd,
          args[3] as string,
          installScope,
        ),
      })
      return 0
    }
    if (marketplaceAction === 'remove') {
      if (args.length !== 4)
        throw new Error('plugin marketplace remove requires a name')
      await removeClaudeMarketplace(
        configRoot,
        cwd,
        args[3] as string,
        requestedScope,
      )
      pluginOutput(io, invocation, {
        type: 'plugin-marketplace-removed',
        name: args[3],
      })
      return 0
    }
    if (marketplaceAction === 'update') {
      if (args.length > 4)
        throw new Error('plugin marketplace update accepts at most one name')
      pluginOutput(io, invocation, {
        type: 'plugin-marketplace-updated',
        marketplaces: await updateClaudeMarketplace(configRoot, cwd, args[3]),
      })
      return 0
    }
    throw new Error(`Unknown plugin marketplace command: ${marketplaceAction}`)
  }
  if (action === 'list') {
    if (args.length !== 2) throw new Error('plugin list takes no operands')
    const registry = await readPluginRegistry(configRoot)
    const native = await listNativePluginRecords(configRoot, cwd)
    const output = await Promise.all(
      [...native, ...registry].map(async (entry) => {
        try {
          const record = await validateClaudePlugin(entry.path)
          return {
            ...entry,
            status: entry.enabled ? 'enabled' : 'disabled',
            valid: true,
            version: record.version ?? entry.version,
          }
        } catch (error) {
          return {
            ...entry,
            status: entry.enabled ? 'enabled' : 'disabled',
            valid: false,
            error: error instanceof Error ? error.message : String(error),
          }
        }
      }),
    )
    pluginOutput(io, invocation, output)
    return 0
  }
  if (action === 'install') {
    if (args.length !== 3)
      throw new Error(
        'plugin install requires a plugin path, URL, or plugin@marketplace id',
      )
    const source = args[2] as string
    if (isClaudeMarketplacePluginId(source)) {
      pluginOutput(io, invocation, {
        type: 'plugin-installed',
        plugin: await installClaudeMarketplacePlugin(
          configRoot,
          cwd,
          source,
          installScope,
        ),
      })
      return 0
    }
    pluginOutput(io, invocation, {
      type: 'plugin-installed',
      plugin: await installClaudePlugin(configRoot, source),
    })
    return 0
  }
  if (action === 'uninstall') {
    if (args.length !== 3)
      throw new Error('plugin uninstall requires a plugin name')
    const name = args[2] as string
    if (isClaudeMarketplacePluginId(name))
      await uninstallNativePlugin(configRoot, cwd, name, requestedScope)
    else await uninstallClaudePlugin(configRoot, name)
    pluginOutput(io, invocation, { type: 'plugin-uninstalled', name: args[2] })
    return 0
  }
  if (action === 'enable' || action === 'disable') {
    if (args.length !== 3)
      throw new Error(`plugin ${action} requires a plugin name`)
    const name = args[2] as string
    const plugin = isClaudeMarketplacePluginId(name)
      ? await setNativePluginEnabled(
          configRoot,
          cwd,
          name,
          action === 'enable',
          requestedScope,
        )
      : await setClaudePluginEnabled(configRoot, name, action === 'enable')
    pluginOutput(io, invocation, {
      type: action === 'enable' ? 'plugin-enabled' : 'plugin-disabled',
      plugin,
    })
    return 0
  }
  if (action === 'update') {
    if (args.length !== 3)
      throw new Error('plugin update requires a plugin name')
    const name = args[2] as string
    pluginOutput(io, invocation, {
      type: 'plugin-updated',
      plugin: isClaudeMarketplacePluginId(name)
        ? await updateNativePlugin(configRoot, cwd, name, requestedScope)
        : await updateClaudePlugin(configRoot, name),
    })
    return 0
  }
  if (action === 'validate') {
    if (args.length !== 3)
      throw new Error('plugin validate requires a plugin directory')
    pluginOutput(io, invocation, {
      type: 'plugin-valid',
      plugin: await validateClaudePlugin(args[2] as string),
    })
    return 0
  }
  if (action === 'init') {
    if (args.length < 3 || args.length > 4)
      throw new Error('plugin init requires a directory and optional name')
    await initClaudePlugin(args[2] as string, args[3])
    pluginOutput(io, invocation, {
      type: 'plugin-initialized',
      path: resolve(args[2] as string),
      ...(args[3] ? { name: args[3] } : {}),
    })
    return 0
  }
  throw new Error(`Unknown plugin command: ${action}`)
}

async function executeMcpCommand(
  args: readonly string[],
  invocation: CliInvocation,
  io: CliIO,
  dependencies: CliDependencies,
  signal?: AbortSignal,
): Promise<number> {
  const action = args[1]
  if (!action || action === 'help') {
    io.stdout(
      'Usage: praxis mcp <list|get|add|add-json|remove|reset-project-choices|login|logout|serve>\n',
    )
    return 0
  }
  const configRoot = resolve(
    process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'),
  )
  const management = new ClaudeMcpManagement({
    configRoot,
    cwd: process.cwd(),
  })
  const scope = invocation.mcpScope ? mcpScope(invocation.mcpScope) : undefined
  if (action === 'login') {
    if (args.length !== 3) throw new Error('mcp login requires a server name')
    const record = await management.get(args[2] as string, scope)
    const server = mcpOAuthServerIdentity(record.name, record.config)
    await (dependencies.mcpAuthenticate ?? authenticateMcpServer)({
      configRoot,
      server,
      noBrowser: invocation.mcpNoBrowser,
      write: (message) => io.stdout(message),
    })
    io.stdout(
      `Authenticated with "${record.name}". Its tools are now available in Praxis.\n`,
    )
    return 0
  }
  if (action === 'logout') {
    if (args.length !== 3) throw new Error('mcp logout requires a server name')
    const record = await management.get(args[2] as string, scope)
    const server = mcpOAuthServerIdentity(record.name, record.config)
    await new ClaudeMcpOAuthStore({ configRoot }).clear(server)
    io.stdout(
      `Signed out of "${record.name}". Run \`praxis mcp login ${record.name}\` to authenticate again.\n`,
    )
    return 0
  }
  if (action === 'serve') {
    if (args.length !== 2) throw new Error('mcp serve takes no operands')
    if (scope) throw new Error('--scope is not valid with mcp serve')
    await (dependencies.mcpServe ?? servePraxisMcpStdio)({
      cwd: process.cwd(),
      debug: invocation.mcpDebug,
      verbose: invocation.verbose,
      ...(signal ? { signal } : {}),
      writeError: (message) => io.stderr(message),
      createToolRegistry: async () => {
        const service = await dependencies.createService({
          eventSink: () => undefined,
          requireProvider: false,
          exposeToolRegistry: true,
          approveTool: async () => true,
          controls: invocation,
          ...(signal ? { signal } : {}),
        })
        const registry = service.toolRegistry
        if (!registry) {
          await service.close?.()
          throw new Error('MCP tool registry is unavailable')
        }
        return {
          definitions: registry.definitions.bind(registry),
          prepare: registry.prepare.bind(registry),
          execute: registry.execute.bind(registry),
          close: async () => service.close?.(),
        }
      },
      createAgentService: ({
        agent,
        model,
        permissionMode,
        worktree,
        eventSink: agentEventSink,
      }) =>
        dependencies.createService({
          eventSink: agentEventSink,
          requireProvider: true,
          approveTool: async () => true,
          ...(agent ? { agent } : {}),
          controls: {
            ...invocation,
            ...(model ? { model } : {}),
            ...(permissionMode ? { permissionMode } : {}),
            ...(worktree ? { worktreeRequested: true } : {}),
          },
          ...(signal ? { signal } : {}),
        }),
    })
    return 0
  }
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
  if (
    argv[0] === 'doctor' &&
    (argv.includes('--help') || argv.includes('-h'))
  ) {
    io.stdout(DOCTOR_HELP)
    return 0
  }
  if (argv[0] === 'project' && argv[1] === 'purge') {
    return executeProjectPurgeCommand(argv, io)
  }
  if (['install', 'update', 'upgrade'].includes(argv[0] ?? '')) {
    return executeSelfUpdateCommand(argv, io, dependencies)
  }
  if (
    argv[0]?.startsWith('-') &&
    argv[argv.indexOf('project') + 1] === 'purge'
  ) {
    const commandIndex = argv.indexOf('project')
    return executeProjectPurgeCommand(
      [
        'project',
        'purge',
        ...argv.slice(0, commandIndex),
        ...argv.slice(commandIndex + 2),
      ],
      io,
    )
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
    'plugin',
    'doctor',
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
    if (command !== 'plugin') {
      throw new Error('--scope is only valid with mcp or plugin commands')
    }
  }
  const mcpAction = command === 'mcp' ? args[1] : undefined
  if (invocation.mcpNoBrowser && mcpAction !== 'login') {
    throw new Error('--no-browser is only valid with mcp login')
  }
  if (invocation.mcpDebug && mcpAction !== 'serve') {
    throw new Error('--debug is only valid with mcp serve')
  }
  if (command === 'mcp') {
    return executeMcpCommand(args, invocation, io, dependencies, signal)
  }
  if (command === 'auto-mode') {
    return executeAutoModeCommand(args, invocation, io)
  }
  if (command === 'plugin') {
    return executePluginCommand(args, invocation, io)
  }
  if (command === 'doctor') {
    return executeDoctorCommand(args, invocation, io)
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
  let streamIterator: AsyncGenerator<StreamJsonMessage> | undefined
  let firstStreamMessage: StreamUserMessage | undefined
  const queuedStreamUsers: StreamUserMessage[] = []
  const earlyControlResponses = new Map<string, StreamControlResponse>()
  let currentTurnAbort: AbortController | undefined
  if (inputFormat === 'stream-json' && !invocation.legacyJson) {
    const input = io.readStdinLines?.()
    if (!input) throw new Error('stream-json input requires stdin support')
    streamIterator = readStreamJsonMessages(input)
  }
  const receiveStreamControl = (message: StreamJsonMessage): void => {
    if (!('type' in message)) {
      queuedStreamUsers.push(message)
      return
    }
    if (message.type === 'control_request') {
      if (message.request.subtype === 'interrupt') currentTurnAbort?.abort()
      return
    }
    if (message.type === 'control_response') {
      earlyControlResponses.set(message.response.request_id, message)
      return
    }
    if (message.type === 'control_cancel_request') {
      earlyControlResponses.set(message.request_id, {
        type: 'control_response',
        response: {
          subtype: 'error',
          request_id: message.request_id,
          error: 'Control request cancelled',
        },
      })
    }
  }
  const nextStreamMessage = async (): Promise<StreamJsonMessage | null> => {
    if (!streamIterator) return null
    const next = await streamIterator.next()
    return next.done ? null : next.value
  }
  const nextStreamUser = async (): Promise<StreamUserMessage | null> => {
    const queued = queuedStreamUsers.shift()
    if (queued) return queued
    for (;;) {
      const message = await nextStreamMessage()
      if (!message) return null
      if (!('type' in message)) return message
      receiveStreamControl(message)
    }
  }
  const awaitControlResponse = async (
    requestId: string,
  ): Promise<StreamControlResponse | null> => {
    const early = earlyControlResponses.get(requestId)
    if (early) {
      earlyControlResponses.delete(requestId)
      return early
    }
    for (;;) {
      const message = await nextStreamMessage()
      if (!message) return null
      if (!('type' in message)) {
        queuedStreamUsers.push(message)
        continue
      }
      if (message.type === 'control_response') {
        if (message.response.request_id === requestId) return message
        earlyControlResponses.set(message.response.request_id, message)
        continue
      }
      if (
        message.type === 'control_cancel_request' &&
        message.request_id === requestId
      ) {
        return {
          type: 'control_response',
          response: {
            subtype: 'error',
            request_id: requestId,
            error: 'Control request cancelled',
          },
        }
      }
      receiveStreamControl(message)
      if (currentTurnAbort?.signal.aborted) {
        return {
          type: 'control_response',
          response: {
            subtype: 'error',
            request_id: requestId,
            error: 'Control request interrupted',
          },
        }
      }
    }
  }
  const approveStreamTool = async (call: ModelToolCall): Promise<boolean> => {
    if (!streamOutput || !streamIterator) return false
    const requestId = randomUUID()
    streamOutput.controlRequest({
      request_id: requestId,
      request: {
        subtype: 'can_use_tool',
        tool_name: call.name,
        input: call.input,
        tool_use_id: call.id,
      },
    })
    const response = await awaitControlResponse(requestId)
    if (!response || response.response.subtype === 'error') return false
    const result = response.response.response
    if (!result || result.behavior !== 'allow') {
      if (result?.interrupt === true) currentTurnAbort?.abort()
      return false
    }
    return true
  }
  const respondStreamElicitation = async (
    request: CliElicitationRequest,
  ): Promise<CliElicitationResult> => {
    if (!streamOutput || !streamIterator) return { action: 'decline' }
    const requestId = randomUUID()
    streamOutput.controlRequest({
      request_id: requestId,
      request: {
        subtype: 'elicitation',
        mcp_server_name: request.serverName,
        message: request.message,
        ...(request.mode === undefined ? {} : { mode: request.mode }),
        ...(request.url === undefined ? {} : { url: request.url }),
        ...(request.elicitationId === undefined
          ? {}
          : { elicitation_id: request.elicitationId }),
        ...(request.requestedSchema === undefined
          ? {}
          : { requested_schema: request.requestedSchema }),
      },
    })
    const response = await awaitControlResponse(requestId)
    if (!response || response.response.subtype === 'error')
      return { action: 'decline' }
    const result = response.response.response
    if (
      !result ||
      !['accept', 'decline', 'cancel'].includes(String(result.action))
    )
      return { action: 'decline' }
    return {
      action: result.action as CliElicitationResult['action'],
      ...(result.content && typeof result.content === 'object'
        ? {
            content: result.content as Record<
              string,
              string | number | boolean | string[]
            >,
          }
        : {}),
    }
  }
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
    ...(streamIterator ? { approveTool: approveStreamTool } : {}),
    ...(streamIterator ? { onElicitation: respondStreamElicitation } : {}),
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
        invocation.includeHookEvents,
      )
    }
    if (streamIterator) {
      const first = await nextStreamUser()
      if (!first) return 0
      firstStreamMessage = first
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
      const turnAbort = new AbortController()
      const forwardAbort = () => turnAbort.abort()
      if (signal?.aborted) turnAbort.abort()
      signal?.addEventListener('abort', forwardAbort, { once: true })
      currentTurnAbort = streamIterator ? turnAbort : undefined
      const runSignal = streamIterator ? turnAbort.signal : signal
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
            ? runSignal
              ? await service.resume(
                  activeSessionId,
                  prompt,
                  runSignal,
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
            : runSignal
              ? await service.run(
                  prompt,
                  runSignal,
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
        if (isCancellation(error, turnAbort.signal)) {
          if (currentTurnAbort === turnAbort) currentTurnAbort = undefined
          signal?.removeEventListener('abort', forwardAbort)
          throw error
        }
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
        } else {
          if (currentTurnAbort === turnAbort) currentTurnAbort = undefined
          signal?.removeEventListener('abort', forwardAbort)
          throw error
        }
        if (currentTurnAbort === turnAbort) currentTurnAbort = undefined
        signal?.removeEventListener('abort', forwardAbort)
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
            runSignal,
          )
          if (suggestion) streamOutput.promptSuggestion(suggestion)
        } catch {
          // Prompt suggestions are auxiliary and must not change turn success.
        }
      }
      isFirstTurn = false
      if (currentTurnAbort === turnAbort) currentTurnAbort = undefined
      signal?.removeEventListener('abort', forwardAbort)
      return true
    }

    if (!(await runTurn(initialPrompt, firstStreamMessage))) return 1
    if (streamIterator) {
      for (;;) {
        const message = await nextStreamUser()
        if (!message) break
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
