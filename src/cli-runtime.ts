#!/usr/bin/env node

import { realpathSync } from 'node:fs'
import { access, copyFile, mkdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

import {
  ClaudeSessionService,
  type CwdInspection,
  type ForkResult,
  type ManualCompactResult,
  type ManualCompactSelection,
  type RewindPoint,
  type SessionForkCheckpoint,
  type SessionInspection,
  type SessionRunResult,
  type SessionSummary,
  type SideQuestionForkResult,
  type SideQuestionResult,
} from './application/session-service.js'
import type {
  TeamLeadOperations,
  TeamCreateRequest,
} from './application/team-lead-operations.js'
import type { JsonResource } from './core/resources.js'
import type { TeamSnapshot } from './core/team-ownership.js'
import {
  ProjectMemoryAgentExtractor,
  ProjectMemoryExtractionController,
  ProjectMemoryModelSelector,
  ProjectMemoryRecallController,
} from './application/project-memory.js'
import { resolveProjectMemoryPolicy } from './core/project-memory.js'
import {
  resolveProjectMemoryDirectory,
  resolveProjectMemoryStatePath,
} from './platform/project-memory-paths.js'
import type { ClaudeSessionCostSnapshot } from './application/session-cost-tracker.js'
import { ClaudeCostStateStore } from './persistence/claude-cost-state-store.js'
import {
  agentColorMessage,
  parseAgentColorInput,
  type AgentColorName,
  type AgentColorSelection,
} from './core/agent-color.js'
import type { TranscriptDisplayItem } from './application/transcript-projection.js'
import {
  ClaudeConditionalRuleResolver,
  ClaudeContextAssembler,
} from './native/context.js'
import { loadClaudeDynamicContext } from './native/dynamic-context.js'
import {
  createClaudePrSessionFilter,
  filterClaudePrLinkedSessions,
} from './native/pr-links.js'
import { isSessionId } from './core/session.js'
import {
  assertNativeDataPlane,
  resolveDataPlane,
  resolveDataPlaneRoot,
  resolveDataPlanePaths,
  type DataPlane,
} from './persistence/data-plane.js'
import {
  loadNativeContextResources,
  loadNativeSettings,
  loadNativeSharedResources,
} from './persistence/native-resources.js'
import { resolveProjectIdentity } from './platform/project-identity.js'
import {
  AgentRunCancelledError,
  ModelProviderError,
  type ModelDocument,
  type ModelImage,
  type ModelTerminalReason,
  type ModelUsage,
  type ModelProvider,
  type ModelToolCall,
  type PermissionApproval,
  type PermissionDecision,
  type ToolRegistry,
  type RuntimeEventSink,
} from './core/runtime.js'
import type {
  InteractiveBackgroundRequest,
  InteractiveResumeOptions,
  InteractiveServiceFactory,
} from './cli/interactive.js'
import type { TuiSlashCommand } from './cli/tui/slash-commands.js'
import { persistTuiPermissionUpdates } from './cli/tui/permission-settings.js'
import { loadClaudeReleaseNotes } from './cli/tui/release-notes.js'
import {
  canonicalClaudeCostModelName,
  formatCostSummary,
  type CostModelUsage,
  type CostSummary,
} from './cli/tui/cost-summary.js'
import {
  projectTuiHooks,
  type TuiHookConfiguration,
} from './cli/tui/hook-settings.js'
import { DEFAULT_CLI_CONTROLS, resolveCliControls } from './cli/controls.js'
import {
  PRAXIS_TEAM_TOOLS,
  resolveClaudeToolCapabilities,
} from './tools/claude-capabilities.js'
import {
  applyRuntimeSettingDefaults,
  loadRuntimeSettings,
  runtimeSettingsSystemPrompt,
  type PraxisRuntimeSettings,
} from './cli/tui/runtime-settings.js'
import { createCliDebugSink } from './cli/debug.js'
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
import {
  allowedWorkspaceHookSettings,
  allowedWorkspaceMcpResources,
  assessWorkspaceTrust,
  hasWorkspaceProviderSelection,
  persistWorkspaceTrust,
  workspaceTrustDecisionKey,
  workspaceTrustInventory,
  type WorkspaceTrustAssessment,
  type WorkspaceTrustInventory,
} from './security/workspace-trust.js'
import {
  createWorkspaceTrustDecisionCache,
  promptWorkspaceTrust,
  safeWorkspaceTrustDisplayField,
} from './cli/workspace-trust-prompt.js'
import { ClaudeSessionEnvironment } from './hooks/claude-session-environment.js'
import {
  ClaudeMcpToolRegistry,
  type ClaudeMcpServerStatus,
  type ClaudeMcpToolInspection,
} from './mcp/claude-mcp-tools.js'
import {
  ClaudeMcpManagement,
  filterDisabledMcpResources,
  mcpScope,
  type McpServerRecord,
} from './mcp/claude-mcp-management.js'
import {
  authenticateMcpServer,
  ClaudeMcpOAuthStore,
  mcpOAuthServerIdentity,
  readMcpClientSecret,
} from './mcp/claude-mcp-oauth.js'
import { servePraxisMcpStdio } from './mcp/praxis-mcp-server.js'
const VERIFIED_CLAUDE_SCHEMA_VERSION = 'native'
const isClaudeSessionId = isSessionId

function truthyEnvironmentValue(value: string | undefined): boolean {
  return /^(?:1|true|yes|on)$/iu.test((value ?? '').trim())
}
import { writeFileAtomically } from './platform/atomic-write.js'
import {
  redactSensitiveText,
  sensitiveEnvironmentValues,
} from './platform/sensitive-data.js'
import { FallbackModelProvider } from './providers/fallback-provider.js'
import { ProviderCredentialVault } from './persistence/provider-credential-vault.js'
import {
  parseContextEnvironment,
  parseProviderEnvironment,
} from './providers/environment.js'
import {
  ProviderAuthenticationError,
  resolveProviderCredential,
} from './providers/provider-auth.js'
import {
  resolveProviderContextWindowTokens,
  resolveProviderRegistry,
} from './providers/provider-registry.js'
import {
  ProviderSettingsError,
  resolveProviderTarget,
} from './providers/provider-settings.js'
import { ModelPricingRegistry, usageCostUsd } from './core/usage.js'
import { LocalToolRegistry } from './tools/local-tools.js'
import { ClaudeLspToolManager } from './tools/claude-lsp-tool.js'
import {
  ClaudeInteractiveToolManager,
  type ClaudeInteractiveToolCallbacks,
} from './tools/claude-interactive-tools.js'
import { nativeBackgroundTaskParent } from './application/background-bash-manager.js'
import {
  runTopLevelAgentWorker,
  TopLevelAgentManager,
  type ProviderEnvironmentOverride,
  type TopLevelAgentSummary,
} from './application/top-level-agent-manager.js'
import { FilteredToolRegistry } from './tools/filtered-tool-registry.js'
import { WebToolRegistry } from './tools/web.js'
import { WorkspaceContext } from './application/session-worktree.js'
import { launchTmuxWorktree } from './platform/tmux-worktree.js'
import { claudeSandboxRuntime } from './sandbox/claude-sandbox-runtime.js'
import {
  nativeSandboxTempDirectory,
  loadClaudeSandboxSettings,
} from './sandbox/claude-sandbox-settings.js'
import {
  createErrorResult,
  createSuccessResult,
  isHeadlessCostCommand,
  matchHeadlessColorCommand,
  formatPrintTextError,
  parseCliInvocation,
  projectProtocolTimings,
  readStreamJsonMessages,
  StreamJsonOutput,
  type CliOutputFormat,
  type CliControls,
  type CliInvocation,
  type CliRuntimeInfo,
  type CliElicitationRequest,
  type CliElicitationResult,
  type ProtocolResult,
  type StreamUserMessage,
  type StreamJsonMessage,
  type StreamControlResponse,
} from './cli/protocol.js'
import { isDirectProcessSigint } from './cli/process-signal.js'
import { executeProviderAuthCommand } from './cli/provider-auth-command.js'
import {
  describeClaudePlugin,
  type ClaudePluginInitComponent,
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
  disableAllNativePlugins,
  installClaudeMarketplacePlugin,
  listClaudeMarketplaceAvailablePlugins,
  listNativePluginRecords,
  readClaudeKnownMarketplaces,
  removeClaudeMarketplace,
  setNativePluginEnabled,
  saveClaudePluginConfig,
  uninstallNativePlugin,
  updateClaudeMarketplace,
  updateNativePlugin,
  validateClaudeMarketplace,
  type ClaudePluginScope,
} from './plugins/claude-plugin-marketplace.js'
import {
  executeClaudePluginEvalCommand,
  PLUGIN_EVAL_HELP,
  type PluginEvalDependencies,
} from './plugins/claude-plugin-eval.js'
import {
  executeProjectEvalCommand,
  PROJECT_EVAL_HELP,
  type ProjectEvalDependencies,
} from './evals/project-eval.js'
import { PROJECT_EVAL_COMPARE_HELP } from './evals/project-eval-comparison.js'
import {
  CLAUDE_PLUGIN_PRUNE_HELP,
  CLAUDE_PLUGIN_TAG_HELP,
  executeClaudePluginPrune,
  planClaudePluginPrune,
  tagClaudePlugin,
  type ClaudePluginPrunePlan,
} from './plugins/claude-plugin-maintenance.js'
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

const VERSION = (
  createRequire(import.meta.url)('../package.json') as { version: string }
).version

export function shouldDeferMcpTools(input: {
  simpleMode: boolean
  tools?: readonly string[] | undefined
  disallowedTools: readonly string[]
}): boolean {
  if (input.tools?.includes('ToolSearch')) {
    throw new Error('Unknown tool in --tools: ToolSearch')
  }
  return (
    !input.simpleMode &&
    !input.disallowedTools.includes('ToolSearch') &&
    (input.tools === undefined ||
      (input.tools.length > 0 &&
        input.tools.every((tool) => tool === 'default')))
  )
}

function fileResourceBaseUrl(
  environment: NodeJS.ProcessEnv,
  providerEnvironment: ReturnType<typeof parseProviderEnvironment> | undefined,
): string {
  return (
    environment.PRAXIS_FILES_BASE_URL ??
    providerEnvironment?.baseUrl ??
    environment.PRAXIS_BASE_URL ??
    (environment.PRAXIS_PROVIDER === 'anthropic'
      ? 'https://api.anthropic.com/v1'
      : 'https://api.openai.com/v1')
  )
}

function fileResourceHeaders(
  environment: NodeJS.ProcessEnv,
  providerEnvironment: ReturnType<typeof parseProviderEnvironment> | undefined,
  credential: string,
): Record<string, string> {
  const anthropic = providerEnvironment?.provider === 'anthropic'
  const bearer = Boolean(environment.PRAXIS_FILES_BEARER_TOKEN)
  const authentication = bearer
    ? { Authorization: `Bearer ${credential}` }
    : anthropic
      ? { 'x-api-key': credential }
      : { Authorization: `Bearer ${credential}` }
  return {
    ...authentication,
    ...(anthropic
      ? {
          'anthropic-version': '2023-06-01',
          'anthropic-beta': `files-api-2025-04-14${bearer ? ',oauth-2025-04-20' : ''}`,
        }
      : {}),
  }
}

const HELP = `Praxis — local-first general agent

Usage:
  praxis
  praxis [options] [prompt]
  praxis -p [options] [prompt]
  praxis --resume [session-id|title|search] [options] [prompt]
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
  praxis team <create|resume|list|accept|stop> ...
  praxis mcp <list|get|add|add-json|remove|reset-project-choices|login|logout|serve> ...
  praxis auto-mode <config|defaults|critique>
  praxis plugin|plugins <details|list|install|uninstall|enable|disable|update|init|prune|tag|validate|marketplace> ...
  praxis eval [options] <target>
  praxis doctor [--json]
  praxis auth <status|set-key|login|logout> ...
  praxis import [options] [source]
  praxis install [--force] [stable|latest|version]
  praxis update|upgrade
  praxis project purge [options] [path]

Options:
  -p, --print                         Print response and exit
  --bg, --background                  Run as a persistent background agent
  -r, --resume [session]              Resume by ID/title, or select interactively
  --from-pr [number-or-url]           Resume a session linked to a GitHub PR
  -c, --continue                      Continue latest session in this directory
  --fork-session                      Fork when resuming or continuing
  --resume-session-at <message-id>    Resume at an active conversation message
  --session-id <uuid>                 Use an explicit ID for a new session
  -n, --name <name>                   Set session display name
  --provider <id>                     Select provider for this session
  --provider-profile <id>             Select provider profile for this session
  --model <model>                     Select model for this session
  --effort <level>                    low, medium, high, xhigh, or max
  --environment <environment_id>      Unsupported: Praxis runs sessions locally
  --thinking <mode>                   enabled, adaptive, or disabled
  --max-thinking-tokens <tokens>      Cap extended-thinking tokens
  --fallback-model <models>           Comma-separated print-mode fallbacks
  --json-schema <schema>              Print-mode JSON Schema for structured output
  --max-budget-usd <amount>           Maximum print-mode API spend
  --autocompact <auto|tokens>         Accepted compatibility no-op; provider context budget remains authoritative
  --cloud [description|session_id|url]
                                      Unsupported: Praxis does not create or attach to cloud sessions
  --prefill <text>                    Accepted as a Claude 2.1.208-compatible no-op
  --prompt-suggestions [value]        Enable prompt suggestions. In print/SDK mode, emits a
                                      prompt_suggestion message after each turn with a predicted
                                      next user prompt (choices: "true", "false", "1", "0", "yes",
                                      "no", "on", "off", preset: "true")
  --scope <scope>                     MCP scope: local, project, or user
  --no-browser                       Print MCP OAuth URL without opening a browser
  --no-session-persistence            Keep print-mode session in memory only
  --agent <name>                      Select a shared agent definition
  --max-turns <turns>                  Limit print-mode model round trips
  --betas <betas...>                   Include Anthropic beta headers
  --brief                              Enable SendUserMessage communication
  --ax-screen-reader                   Render flat screen-reader output
  -d, --debug [filter]                 Enable debug mode with optional category filtering
                                      (e.g., "api,hooks" or "!1p,!file")
  --debug-file <path>                  Write runtime diagnostics to a file
  --file <specs...>                    Download file resources at startup (file_id:relative_path)
  --agents <json>                      Define inline agents for this session
  --mcp-config <configs...>            Load MCP server JSON files or objects
  --strict-mcp-config                  Ignore configured MCP servers
  --disable-slash-commands             Disable skills and slash commands
  --settings <file-or-json>           Load additional settings
  --setting-sources <sources>         user, project, local, or an empty list
  --safe-mode                         Disable shared customizations
  --bare                              Use only explicitly supplied context
  --trust-project                     Trust current workspace-controlled resources/configuration
  --system-prompt <prompt>            Set system prompt
  --append-system-prompt <prompt>     Append system prompt
  --exclude-dynamic-system-prompt-sections
                                      Move cwd, environment, memory path, and git status into first user message
                                      (default system prompt only; ignored with --system-prompt)
  --add-dir <directories...>          Allow access to additional directories
  --plugin-dir <path>                Load a local plugin directory or .zip for this session (repeatable)
  --plugin-url <url>                 Load a plugin .zip URL for this session (repeatable)
  --tools <tools...>                  Select available tools; empty disables all
  --allowedTools, --allowed-tools <tools...>
                                      Add permission allow rules
  --disallowedTools, --disallowed-tools <tools...>
                                      Add permission deny rules
  --permission-mode <mode>            Set permission behavior
  --dangerously-skip-permissions      Bypass checks except explicit deny rules
  --allow-dangerously-skip-permissions
                                      Allow bypass mode without enabling it
  --input-format <format>             text (default) or stream-json
  --output-format <format>            text (default), json, or stream-json
  --include-partial-messages          Emit stream_event records
  --include-hook-events               Emit hook_started/progress/response records
  --forward-subagent-text             Accepted compatibility no-op; child text is not duplicated into the parent stream
  --replay-user-messages              Echo stream-json user records
  --retry-interrupted-tools           Approve prepared interrupted tools
  --verbose                           Required for stream-json output
  --json                              Legacy Praxis runtime NDJSON output
  -h, --help                          Show help
  -v, --version                       Show version
  -w, --worktree [name]               Start in an isolated Git worktree
  --teleport [session]                Unsupported: Praxis cannot resume remote sessions
  --tmux[=classic]                    Launch worktree in an iTerm2 native pane when available; classic forces tmux

Provider environment:
  PRAXIS_PROVIDER=<provider-id>, PRAXIS_API_KEY, PRAXIS_MODEL
  PRAXIS_PROVIDER_PROFILE
  PRAXIS_BASE_URL, PRAXIS_MAX_OUTPUT_TOKENS, PRAXIS_ANTHROPIC_VERSION
  PRAXIS_ANTHROPIC_WEB_SEARCH=true|false
  PRAXIS_ANTHROPIC_PROMPT_CACHING=true|false
  PRAXIS_ANTHROPIC_PROMPT_CACHE_TTL=5m|1h
  PRAXIS_CONTEXT_WINDOW_TOKENS, PRAXIS_CONTEXT_RESERVE_TOKENS
`

const AUTH_HELP = `Usage: praxis auth <command>

Commands:
  status [provider] [--profile <profile>] [--json]
  set-key <provider> [--profile <profile>] [--json]
  login openai-codex [--profile <profile>] [--device] [--no-browser] [--json]
  logout <provider> [--profile <profile>] [--json]

Options:
  -h, --help  Display help for command
`

const AUTH_ACTION_HELP: Record<string, string> = {
  status: `Usage: praxis auth status [provider] [--profile <profile>] [--json]

List credential metadata without exposing secrets.

Options:
  --profile <profile>  Filter by provider profile
  --json               Output machine-readable metadata
  -h, --help           Display help for command
`,
  'set-key': `Usage: praxis auth set-key <provider> [--profile <profile>] [--json]

Read an API key securely from the terminal or stdin and store it in the native Vault.

Options:
  --profile <profile>  Select provider profile (default: default)
  --json               Output a machine-readable confirmation
  -h, --help           Display help for command
`,
  login: `Usage: praxis auth login openai-codex [--profile <profile>] [--device] [--no-browser] [--json]

Authorize an experimental Codex subscription profile with OpenAI OAuth.

Options:
  --profile <profile>  Select Codex profile (default: default)
  --device             Use the device authorization flow
  --no-browser         Print instructions without opening a browser
  --json               Keep stdout machine-readable
  -h, --help           Display help for command
`,
  logout: `Usage: praxis auth logout <provider> [--profile <profile>] [--json]

Delete exactly one native Vault credential.

Options:
  --profile <profile>  Select provider profile (default: default)
  --json               Output a machine-readable confirmation
  -h, --help           Display help for command
`,
}

const AGENTS_HELP = `Usage: praxis agents [options]

Manage background agents

Options:
  --add-dir <directory>                 Additional directory to allow tool
                                        access to in dispatched sessions
                                        (repeatable)
  --agent <agent>                       Default agent for sessions dispatched
                                        from agent view. Overrides the 'agent'
                                        setting.
  --all                                 With --json: include completed sessions
                                        (the full agent view list)
  --allow-dangerously-skip-permissions  Make bypass-permissions mode available
                                        to dispatched sessions without
                                        defaulting to it
  --cwd <path>                          Show only background sessions started
                                        under <path>
  --dangerously-skip-permissions        Alias for --permission-mode
                                        bypassPermissions
  --effort <level>                      Default effort level for sessions
                                        dispatched from agent view
  -h, --help                            Display help for command
  --json                                Print active sessions as a JSON array
                                        and exit (for scripting; does not
                                        require a TTY)
  --mcp-config <config>                 MCP server configuration to apply to
                                        dispatched sessions (repeatable)
  --model <model>                       Default model for sessions dispatched
                                        from agent view
  --provider <id>                       Default provider for sessions dispatched
                                        from agent view
  --provider-profile <id>               Default provider profile for dispatched
                                        sessions
  --permission-mode <mode>              Default permission mode for sessions
                                        dispatched from agent view
  --plugin-dir <path>                   Load plugins from specified directory
                                        for the agent view and dispatched
                                        sessions (repeatable)
  --setting-sources <sources>           Comma-separated list of setting sources
                                        to load (user, project, local).
  --settings <file-or-json>             Settings file or JSON string to apply to
                                        the agent view and dispatched sessions
  --strict-mcp-config                   Only use MCP servers from --mcp-config
                                        in dispatched sessions
`

const MCP_HELP = `Usage: praxis mcp [options] [command]

Configure and manage Model Context Protocol servers.

Options:
  -h, --help  Display help for command

Commands:
  list [options]                              List configured MCP servers
  get [options] <name>                        Get an MCP server configuration
  add [options] <name> <commandOrUrl> [args...]  Add an MCP server
  add-json [options] <name> <json>            Add an MCP server from JSON
  remove [options] <name>                     Remove an MCP server
  reset-project-choices                       Reset project MCP approvals
  login [options] <name>                      Authenticate with an MCP server
  logout [options] <name>                     Clear MCP OAuth credentials
  serve [options]                             Start Praxis MCP server over stdio
`

const MCP_LIST_HELP = `Usage: praxis mcp list [options]

List configured MCP servers. With --scope, list only servers in that scope.

Options:
  --scope <scope>  Configuration scope: local, project, or user
  --json           Print a machine-readable mcp-list result
  -h, --help        Display help for command
`

const MCP_GET_HELP = `Usage: praxis mcp get [options] <name>

Print configuration for one MCP server.

Options:
  --scope <scope>  Read from local, project, or user scope
  --json           Print a machine-readable mcp-server result
  -h, --help        Display help for command
`

const MCP_ADD_HELP = `Usage: praxis mcp add [options] <name> <commandOrUrl> [args...]

Add an MCP server to Praxis.

Examples:
  # Add HTTP server:
  praxis mcp add --transport http sentry https://mcp.sentry.dev/mcp

  # Add HTTP server with headers:
  praxis mcp add --transport http corridor https://app.corridor.dev/api/mcp --header "Authorization: Bearer ..."

  # Add stdio server with environment variables:
  praxis mcp add my-server -e API_KEY=xxx -- npx my-mcp-server

  # Add stdio server with subprocess flags:
  praxis mcp add my-server -- my-command --some-flag arg1

Options:
  --callback-port <port>       Fixed port for OAuth callback (for servers requiring pre-registered redirect URIs)
  --client-id <clientId>       OAuth client ID for HTTP/SSE servers
  --client-secret              Prompt for OAuth client secret (or set MCP_CLIENT_SECRET env var)
  -e, --env <env...>           Set environment variables (e.g. -e KEY=value)
  -H, --header <header...>     Set WebSocket headers (e.g. -H "X-Api-Key: abc123" -H "X-Custom: value")
  -h, --help                   Display help for command
  -s, --scope <scope>          Configuration scope (local, user, or project) (default: "local")
  -t, --transport <transport>  Transport type (stdio, sse, http). Defaults to stdio if not specified.
`

const MCP_ADD_JSON_HELP = `Usage: praxis mcp add-json [options] <name> <json>

Add an MCP server from a JSON configuration object. Supported configurations
include stdio and HTTP server records accepted by Praxis.

Options:
  --client-secret      Prompt for OAuth client secret (or set MCP_CLIENT_SECRET env var)
  -s, --scope <scope>  Configuration scope: local, project, or user (default: local)
  --json               Print a machine-readable mcp-added result
  -h, --help            Display help for command
`

const MCP_REMOVE_HELP = `Usage: praxis mcp remove [options] <name>

Remove an MCP server. Without --scope, Praxis resolves the configured server
across available scopes.

Options:
  -s, --scope <scope>  Remove from local, project, or user scope
  --json               Print a machine-readable mcp-removed result
  -h, --help            Display help for command
`

const MCP_RESET_PROJECT_CHOICES_HELP = `Usage: praxis mcp reset-project-choices [options]

Reset approved and rejected project-scoped MCP server choices.

Options:
  --json        Print a machine-readable confirmation
  -h, --help    Display help for command
`

const MCP_LOGIN_HELP = `Usage: praxis mcp login [options] <name>

Authenticate with an OAuth-enabled MCP server.

Options:
  --no-browser     Print authorization URL instead of opening a browser
  --scope <scope>  Read server from local, project, or user scope
  -h, --help        Display help for command
`

const MCP_LOGOUT_HELP = `Usage: praxis mcp logout [options] <name>

Clear stored OAuth credentials for an MCP server.

Options:
  --scope <scope>  Read server from local, project, or user scope
  -h, --help        Display help for command
`

const MCP_SERVE_HELP = `Usage: praxis mcp serve [options]

Start the Praxis MCP server over stdio.

Options:
  -d, --debug  Enable MCP server debug logging
  --verbose    Enable verbose MCP server output
  -h, --help   Display help for command
`

const MCP_ACTION_HELP: Record<string, string> = {
  list: MCP_LIST_HELP,
  get: MCP_GET_HELP,
  add: MCP_ADD_HELP,
  'add-json': MCP_ADD_JSON_HELP,
  remove: MCP_REMOVE_HELP,
  'reset-project-choices': MCP_RESET_PROJECT_CHOICES_HELP,
  login: MCP_LOGIN_HELP,
  logout: MCP_LOGOUT_HELP,
  serve: MCP_SERVE_HELP,
}

const PLUGIN_HELP = `Usage: praxis plugin|plugins [options] [command]

Manage Praxis-compatible Claude plugins and marketplaces.

Options:
  --json           Print machine-readable command output when supported
  --scope <scope>  Plugin configuration scope: local, project, or user
  -h, --help        Display help for command

Commands:
  details <name>                   Show component inventory and projected token cost
  list [options]                   List installed or available plugins
  install|i [options] <source>     Install a local plugin, URL, or plugin@marketplace
  uninstall|remove [options] <id>  Uninstall a plugin
  enable [options] <id>            Enable a plugin
  disable [options] [id]           Disable one plugin, or all with --all
  update [options] <id>            Update a plugin
  init|new [options] <name>         Scaffold ~/.praxis/skills/<name> by default
  prune|autoremove [options]        Remove unused auto-installed dependencies
  tag [options] [path]              Create a validated plugin release tag
  validate [options] <path>         Validate a plugin or marketplace manifest
  eval [options] [target]           Evaluate plugin behavior
  marketplace [command]            Manage configured marketplaces
`

const PLUGIN_DETAILS_HELP = `Usage: praxis plugin details <name>

Show a plugin's component inventory and projected token cost.

Options:
  -h, --help  Display help for command
`

const PLUGIN_LIST_HELP = `Usage: praxis plugin list [options]

List installed native and local plugins with enabled and validation status.

Options:
  --available  List marketplace plugins that are not installed
  --json       Print plugin records as JSON (default output is JSON as well)
  -h, --help   Display help for command
`

const PLUGIN_INSTALL_HELP = `Usage: praxis plugin install [options] <path-or-url-or-plugin@marketplace>

Install a plugin from a local directory, URL, or configured marketplace. A
marketplace plugin identifier uses the form plugin@marketplace.

Options:
  --config <key=value>  Set userConfig; use server.key=value for MCPB (repeatable)
  -s, --scope <scope>  Install native marketplace plugin at local, project, or user scope (default: user)
  -y, --yes            Skip install confirmation prompts
  --json               Print a machine-readable plugin-installed result
  -h, --help            Display help for command
`

const PLUGIN_UNINSTALL_HELP = `Usage: praxis plugin uninstall [options] <name-or-plugin@marketplace>

Uninstall a local plugin or a native marketplace plugin.

Options:
  --keep-data      Preserve the plugin's persistent data directory
  --prune          Also remove unused auto-installed dependencies
  -s, --scope <scope>  Select native plugin scope: local, project, or user
  -y, --yes        Skip the --prune confirmation prompt
  --json           Print a machine-readable plugin-uninstalled result
  -h, --help        Display help for command
`

const PLUGIN_ENABLE_HELP = `Usage: praxis plugin enable [options] <name-or-plugin@marketplace>

Enable a disabled local plugin or native marketplace plugin.

Options:
  -s, --scope <scope>  Select native plugin scope: local, project, or user
  --json               Print a machine-readable plugin-enabled result
  -h, --help            Display help for command
`

const PLUGIN_DISABLE_HELP = `Usage: praxis plugin disable [options] [name-or-plugin@marketplace]

Disable an enabled local plugin or native marketplace plugin.

Options:
  -a, --all            Disable all enabled plugins
  -s, --scope <scope>  Select native plugin scope: local, project, or user
  --json               Print a machine-readable plugin-disabled result
  -h, --help            Display help for command
`

const PLUGIN_UPDATE_HELP = `Usage: praxis plugin update [options] <name-or-plugin@marketplace>

Update a local plugin or native marketplace plugin from its configured source.

Options:
  -s, --scope <scope>  Select native plugin scope: local, project, or user
  -y, --yes            Skip update confirmation prompts
  --json               Print a machine-readable plugin-updated result
  -h, --help            Display help for command
`

const PLUGIN_INIT_HELP = `Usage: praxis plugin init|new [options] <name>

Scaffold a plugin at ~/.praxis/skills/<name> by default. In explicit Claude
native mode only; scaffold at ~/.praxis/skills/<name>. The
plugin init <directory> <name> form remains available without native options.

Options:
  --author <name>         Author name (default: git config user.name)
  --author-email <email>  Author email (default: git config user.email)
  --description <text>    Manifest description
  -f, --force             Overwrite an existing .claude-plugin at the target
  --with <components...>  Also scaffold: skills, agents, hooks, mcp, lsp, output-style, channel
  -h, --help              Display help for command
`

const PLUGIN_VALIDATE_HELP = `Usage: praxis plugin validate <directory>

Validate a plugin manifest and report its parsed metadata.

Options:
  --strict    Treat validation warnings as errors
  --json      Print a machine-readable plugin-valid result
  -h, --help  Display help for command
`

const PLUGIN_ACTION_HELP: Record<string, string> = {
  details: PLUGIN_DETAILS_HELP,
  list: PLUGIN_LIST_HELP,
  install: PLUGIN_INSTALL_HELP,
  i: PLUGIN_INSTALL_HELP,
  uninstall: PLUGIN_UNINSTALL_HELP,
  remove: PLUGIN_UNINSTALL_HELP,
  enable: PLUGIN_ENABLE_HELP,
  disable: PLUGIN_DISABLE_HELP,
  update: PLUGIN_UPDATE_HELP,
  init: PLUGIN_INIT_HELP,
  new: PLUGIN_INIT_HELP,
  prune: CLAUDE_PLUGIN_PRUNE_HELP,
  autoremove: CLAUDE_PLUGIN_PRUNE_HELP,
  tag: CLAUDE_PLUGIN_TAG_HELP,
  validate: PLUGIN_VALIDATE_HELP,
  eval: PLUGIN_EVAL_HELP,
}

const PLUGIN_MARKETPLACE_HELP = `Usage: praxis plugin marketplace [options] [command]

Manage configured plugin marketplaces.

Options:
  --scope <scope>  Scope for marketplace additions: local, project, or user (default: user)
  --json           Print machine-readable command output when supported
  -h, --help        Display help for command

Commands:
  list                 List configured marketplaces
  add <source>         Add marketplace from a local path or URL
  remove|rm <name>     Remove a configured marketplace
  update [name]        Update one marketplace, or all when name is omitted
`

const PLUGIN_MARKETPLACE_LIST_HELP = `Usage: praxis plugin marketplace list [options]

List configured marketplaces.

Options:
  --json      Print marketplace records as JSON (default output is JSON as well)
  -h, --help  Display help for command
`

const PLUGIN_MARKETPLACE_ADD_HELP = `Usage: praxis plugin marketplace add [options] <source>

Add a marketplace from a local path, URL, or supported repository source.

Options:
  --scope <scope>      Configuration scope: local, project, or user (default: user)
  --sparse <paths...>  Limit a Git checkout to specific directories
  --json               Print a machine-readable plugin-marketplace-added result
  -h, --help            Display help for command
`

const PLUGIN_MARKETPLACE_REMOVE_HELP = `Usage: praxis plugin marketplace remove [options] <name>

Remove a configured marketplace.

Options:
  --scope <scope>  Select marketplace scope: local, project, or user
  --json           Print a machine-readable plugin-marketplace-removed result
  -h, --help        Display help for command
`

const PLUGIN_MARKETPLACE_UPDATE_HELP = `Usage: praxis plugin marketplace update [options] [name]

Update one marketplace, or all configured marketplaces when name is omitted.

Options:
  --json      Print a machine-readable plugin-marketplace-updated result
  -h, --help  Display help for command
`

const PLUGIN_MARKETPLACE_ACTION_HELP: Record<string, string> = {
  list: PLUGIN_MARKETPLACE_LIST_HELP,
  add: PLUGIN_MARKETPLACE_ADD_HELP,
  remove: PLUGIN_MARKETPLACE_REMOVE_HELP,
  rm: PLUGIN_MARKETPLACE_REMOVE_HELP,
  update: PLUGIN_MARKETPLACE_UPDATE_HELP,
}

const AUTO_MODE_HELP = `Usage: praxis auto-mode [options] [command]

Inspect or reset auto mode classifier configuration.

Options:
  -h, --help  Display help for command

Commands:
  config              Print effective auto mode config as JSON
  defaults             Print default environment, allow, soft_deny, and hard_deny rules as JSON
  critique [options]  Get provider-backed feedback on custom auto mode rules
  reset [options]     Reset auto mode configuration to the shipped defaults by removing the autoMode section from your user settings file
`

const AUTO_MODE_CONFIG_HELP = `Usage: praxis auto-mode config

Print effective auto mode configuration as JSON. Settings values override
defaults; omitted rule lists retain their default values.

Options:
  -h, --help  Display help for command
`

const AUTO_MODE_DEFAULTS_HELP = `Usage: praxis auto-mode defaults [options]

Print default auto mode environment, allow, soft_deny, and hard_deny rules as
JSON.

Options:
  --label <prefix>  Show only rules whose label starts with this prefix (case-insensitive)
  -h, --help        Display help for command
`

const AUTO_MODE_CRITIQUE_HELP = `Usage: praxis auto-mode critique [options]

Get provider-backed feedback on custom auto mode rules. With no custom rule
lists configured, Praxis prints guidance without creating a provider request.

Options:
  --model <model>  Override model used for critique (default: PRAXIS_MODEL)
  -h, --help       Display help for command
`

const AUTO_MODE_RESET_HELP = `Usage: praxis auto-mode reset [options]

Reset auto mode configuration to the shipped defaults by removing the autoMode
section from your user settings file

Options:
  -h, --help  Display help for command
  -y, --yes   Skip the confirmation prompt
`

const AUTO_MODE_ACTION_HELP: Record<string, string> = {
  config: AUTO_MODE_CONFIG_HELP,
  defaults: AUTO_MODE_DEFAULTS_HELP,
  critique: AUTO_MODE_CRITIQUE_HELP,
  reset: AUTO_MODE_RESET_HELP,
}

const PROJECT_HELP = `Usage: praxis project [options] [command]

Manage Praxis project state in the selected data plane.

Options:
  -h, --help  Display help for command

Commands:
  purge [options] [path]  Delete project state for a path (default: current project)
`

const IMPORT_HELP = `Usage: praxis import [options] [source]

Import config from another AI coding agent into Praxis

Arguments:
  source      Which agent to import from (codex, gemini)

Options:
  --dry-run   Show what would be imported without writing anything
  -h, --help  Display help for command
  --yes       Skip the interactive picker
`

const DOCTOR_HELP = `Usage: praxis doctor [options]

Check Praxis installation and local single-user configuration health.

Options:
  --json      Output a machine-readable report
  -h, --help  Show help
`

const PROJECT_PURGE_HELP = `Usage: praxis project purge [options] [path]

Delete all Praxis state for a project in the selected data plane (transcripts,
memory, scheduled prompts, tasks, file history, config entry).

Options:
  --all              Purge state for every project (mutually exclusive with [path])
  --dry-run          List what would be deleted without deleting anything
  -i, --interactive  Prompt for each item before deleting
  --json             Print purge plan and result as JSON
  -y, --yes          Skip confirmation prompt
  -h, --help         Show help

Default: [path] is current project; Praxis requests confirmation unless --yes
is supplied.
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

const TEAM_HELP = `Usage: praxis team <command>

Commands:
  create <manifest.json> --lead-session-id <id> [--json]
  resume <team-id> --lead-session-id <id> [--json]
  list [--json]
  accept <team-id> <task-id> --lead-session-id <id> [--generation <n>] [--decision accepted|rejected] [--json]
  stop <team-id> --lead-session-id <id> [--drain-ms <ms>] [--json]
  status <team-id> [--json]
  logs <team-id> [--json]
  attach <team-id> [--json]
`

export { parseContextEnvironment, parseProviderEnvironment }

export interface CliIO {
  stdout(message: string | Uint8Array): void
  stderr(message: string): void
  isTTY?: boolean
  stdinIsTTY?: boolean
  readStdinLines?: () => AsyncIterable<string | Uint8Array>
  readSecret?: (prompt: string, signal?: AbortSignal) => Promise<string>
}

interface SessionCommands {
  teamLeadOperations?: TeamLeadOperations
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
  runShell?(
    command: string,
    signal?: AbortSignal,
    sessionId?: string,
    name?: string,
  ): Promise<SessionRunResult>
  resumeShell?(
    sessionId: string,
    command: string,
    signal?: AbortSignal,
    name?: string,
  ): Promise<SessionRunResult>
  fork(
    sessionId: string,
    targetSessionId?: string,
    resumeSessionAt?: string,
  ): Promise<ForkResult>
  ensureFork?(
    sessionId: string,
    targetSessionId: string,
    checkpoint?: SessionForkCheckpoint,
  ): Promise<ForkResult>
  setPermissionMode?(
    sessionId: string,
    mode: ClaudePermissionMode,
  ): Promise<void>
  rewindFiles?(sessionId: string, userMessageId: string): Promise<void>
  rewindPoints?(sessionId: string): Promise<RewindPoint[]>
  changeCwd?(
    sessionId: string | undefined,
    cwd: string,
    expectedCanonicalTarget?: string,
  ): Promise<string>
  inspectCwd?(cwd: string): Promise<CwdInspection>
  notify?(
    sessionId: string | undefined,
    message: string,
    notificationType: string,
    title?: string,
  ): void
  recordCdUsage?(sessionId: string): Promise<void>
  approveRecentlyDenied?(sessionId: string, display: string): Promise<void>
  retryRecentlyDenied?(
    sessionId: string,
    display: string,
    signal?: AbortSignal,
  ): Promise<SessionRunResult>
  answerSideQuestion?(
    sessionId: string | undefined,
    question: string,
    signal?: AbortSignal,
    onDelta?: (delta: string) => void,
    permissionMode?: ClaudePermissionMode,
  ): Promise<SideQuestionResult>
  recordBtwUsage?(
    sessionId: string | undefined,
    permissionMode?: ClaudePermissionMode,
  ): Promise<string>
  recordColorUsage?(
    sessionId: string | undefined,
    selection: AgentColorSelection,
    display: string,
    permissionMode?: ClaudePermissionMode,
    options?: { createSession?: boolean },
  ): Promise<string>
  agentColor?(sessionId: string): Promise<AgentColorName | undefined>
  recordBackgroundUsage?(
    sessionId: string | undefined,
    permissionMode?: ClaudePermissionMode,
  ): Promise<string>
  recordBackgroundLaunch?(sessionId: string): Promise<SessionForkCheckpoint>
  forkSideQuestion?(
    sessionId: string,
    question: string,
    signal?: AbortSignal,
  ): Promise<SideQuestionForkResult>
  lifecycle?(
    trigger: 'init' | 'maintenance',
    options?: { sessionStart?: boolean; sessionId?: string },
  ): Promise<void>
  sessions(): Promise<SessionSummary[]>
  registerResumePath?(path: string): Promise<SessionSummary>
  inspect(sessionId: string): Promise<SessionInspection>
  export(sessionId: string): Promise<Buffer>
  transcript?(sessionId: string): Promise<TranscriptDisplayItem[]>
  costSnapshot?(sessionId: string): Promise<ClaudeSessionCostSnapshot>
  compact?(
    sessionId: string,
    signal?: AbortSignal,
    selection?: ManualCompactSelection,
  ): Promise<ManualCompactResult>
  rename?(sessionId: string, name: string): Promise<void>
  sessionNameSuggestion?(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<string | null>
  nextScheduledPrompt?(
    signal?: AbortSignal,
  ): Promise<{ id: string; prompt: string } | null>
  slashCommands?(): readonly TuiSlashCommand[]
  hookConfiguration?(): Promise<TuiHookConfiguration>
  mcpInspect?(): Promise<readonly ClaudeMcpServerStatus[]>
  mcpReconnect?(name: string): Promise<void>
  mcpAuthenticate?(name: string): Promise<void>
  mcpReload?(): Promise<void>
  mcpTools?(name: string): Promise<readonly ClaudeMcpToolInspection[]>
  close?(): Promise<void>
  runtimeInfo?(): CliRuntimeInfo
  initialAgentPrompt?(): string | undefined
  agentDefinitions?(): readonly { name: string; description: string }[]
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
    cwd?: string
    deferInitialTurn?: boolean
    sourceSessionId?: string
    sourceCheckpoint?: SessionForkCheckpoint
    initialDetail?: string
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
  loadReleaseNotes?(configRoot: string): Promise<string>
  /** CLI entrypoint used when this runtime spawns child processes. */
  cliPath?: string
  createService(options: {
    eventSink: RuntimeEventSink
    requireProvider: boolean
    hooksOnly?: boolean
    approveRecovery?: (call: ModelToolCall) => boolean | Promise<boolean>
    approveTool?: (
      call: ModelToolCall,
      originalCall?: ModelToolCall,
      decision?: PermissionDecision,
    ) => PermissionApproval | Promise<PermissionApproval>
    agent?: string
    model?: string
    effort?: CliControls['effort']
    permissionMode?: ClaudePermissionMode
    isSessionActionApproved?: (call: ModelToolCall) => boolean
    controls?: CliControls
    interactive?: boolean
    sessionKind?: 'bg'
    signal?: AbortSignal
    exposeToolRegistry?: boolean
    emitToolUseSummaries?: boolean
    cwd?: string
    sandboxOriginalCwd?: string
    configRoot?: string
    environment?: Readonly<Record<string, string>>
    providerEnvironment?: NodeJS.ProcessEnv
    onElicitation?: (
      request: CliElicitationRequest,
    ) => Promise<CliElicitationResult>
    askUser?: ClaudeInteractiveToolCallbacks['askUser']
    approvePlan?: ClaudeInteractiveToolCallbacks['approvePlan']
    approveWorkspaceTrust?: (
      request: WorkspaceTrustInventory,
    ) => boolean | Promise<boolean>
  }): Promise<SessionCommands>
  createAutoModeCritic?(options: {
    model?: string
    provider?: string
    providerProfile?: string
    dataPlane?: DataPlane
    configRoot?: string
    statePath?: string
  }): Promise<ModelProvider>
  pluginEval?: PluginEvalDependencies
  projectEval?: ProjectEvalDependencies
  runInteractive?(options: {
    agent?: string
    controls?: CliControls
    initialPrompt?: string
    resume?: InteractiveResumeOptions & { fromPr?: string | true }
    signal?: AbortSignal
  }): Promise<number>
  runAgentsDashboard?(options: {
    manager: TopLevelAgentCommands
    defaults: { argv: readonly string[]; cwd?: string }
    signal?: AbortSignal
  }): Promise<number>
  topLevelAgents?: TopLevelAgentCommands
  createTopLevelAgents?(dataPlane: DataPlane): TopLevelAgentCommands
  launchTmux?: typeof launchTmuxWorktree
  mcpAuthenticate?: typeof authenticateMcpServer
  mcpServe?: typeof servePraxisMcpStdio
  executeProviderAuthCommand?: typeof executeProviderAuthCommand
  selfUpdate?: (options: {
    operation: 'install' | 'update'
    target?: string
    force?: boolean
    signal?: AbortSignal
  }) => Promise<SelfUpdateResult>
}

interface ConsoleSecretInput extends AsyncIterable<string | Uint8Array> {
  readonly isTTY?: boolean
  readonly isRaw?: boolean
  isPaused(): boolean
  setRawMode?(enabled: boolean): unknown
  pause(): unknown
  resume(): unknown
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown
  removeListener(
    event: 'data',
    listener: (chunk: Buffer | string) => void,
  ): unknown
}

interface ConsoleSecretOutput {
  write(message: string): unknown
}

export async function readConsoleSecret(
  prompt: string,
  signal?: AbortSignal,
  input: ConsoleSecretInput = process.stdin,
  output: ConsoleSecretOutput = process.stderr,
): Promise<string> {
  const limit = 64 * 1024
  if (signal?.aborted) throw new Error('Credential input cancelled')
  if (!input.isTTY || typeof input.setRawMode !== 'function') {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of input) {
      if (signal?.aborted) throw new Error('Credential input cancelled')
      const bytes =
        typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk)
      size += bytes.byteLength
      if (size > limit) throw new Error('Credential exceeds the 64 KiB limit')
      chunks.push(bytes)
    }
    if (signal?.aborted) throw new Error('Credential input cancelled')
    return Buffer.concat(chunks, size).toString('utf8')
  }
  output.write(prompt)
  const wasRaw = input.isRaw
  const wasPaused = input.isPaused()
  const value: number[] = []
  return await new Promise<string>((resolveSecret, reject) => {
    let settled = false
    let rawModeChanged = false
    let listenerAttached = false
    const restore = (): Error | undefined => {
      let failure: Error | undefined
      if (listenerAttached) {
        input.removeListener('data', onData)
        listenerAttached = false
      }
      signal?.removeEventListener('abort', onAbort)
      if (rawModeChanged) {
        try {
          input.setRawMode?.(Boolean(wasRaw))
        } catch (error) {
          failure = error instanceof Error ? error : new Error(String(error))
        }
        rawModeChanged = false
      }
      if (wasPaused) {
        try {
          input.pause()
        } catch (error) {
          failure ??= error instanceof Error ? error : new Error(String(error))
        }
      }
      return failure
    }
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      const restorationError = restore()
      let outputError: Error | undefined
      try {
        output.write('\n')
      } catch (writeError) {
        outputError =
          writeError instanceof Error
            ? writeError
            : new Error(String(writeError))
      }
      const failure = error ?? restorationError ?? outputError
      if (failure) reject(failure)
      else resolveSecret(Buffer.from(value).toString('utf8'))
    }
    const onAbort = () => finish(new Error('Credential input cancelled'))
    const onData = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      for (const byte of bytes) {
        if (byte === 3) return finish(new Error('Credential input cancelled'))
        if (byte === 13 || byte === 10) return finish()
        if (byte === 8 || byte === 127) {
          value.pop()
          continue
        }
        value.push(byte)
        if (value.length > limit)
          return finish(new Error('Credential exceeds the 64 KiB limit'))
      }
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) return onAbort()
    try {
      input.setRawMode?.(true)
      rawModeChanged = true
      input.resume()
      input.on('data', onData)
      listenerAttached = true
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

const consoleIO: CliIO = {
  stdout: (message) => process.stdout.write(message),
  stderr: (message) => process.stderr.write(message),
  isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  stdinIsTTY: Boolean(process.stdin.isTTY),
  readStdinLines: () => process.stdin,
  readSecret: readConsoleSecret,
}

function warningEventSink(io: Pick<CliIO, 'stderr'>): RuntimeEventSink {
  return (event) => {
    if (event.type === 'warning') io.stderr(`${event.message}\n`)
  }
}

/**
 * Shared runtime model precedence used by every consumer (provider
 * construction, status/doctor output, and the interactive display):
 * explicit CLI selection > non-empty PRAXIS_MODEL > Praxis settings model,
 * with the configured default (settings.model === 'default') falling through
 * to the existing default behavior (undefined).
 */
export function resolveRuntimeModel(
  explicitModel: string | undefined,
  environment: NodeJS.ProcessEnv,
  settings: PraxisRuntimeSettings | undefined,
): string | undefined {
  const envModel = environment.PRAXIS_MODEL
  const settingsModel =
    settings && settings.model !== 'default' ? settings.model : undefined
  return (
    explicitModel ??
    (envModel !== undefined && envModel.trim() !== '' ? envModel : undefined) ??
    settingsModel
  )
}

/** Builds the default CLI's isolated Session-memory adapter seam. Each
 * invocation reconstructs the selected main-model provider stack instead of
 * sharing foreground adapter-local cache and retry state. */
export function createSessionMemoryProviderFactory(
  providerForMainModel: ((model: string) => ModelProvider) | undefined,
  model: string | undefined,
): (() => ModelProvider) | undefined {
  if (!providerForMainModel || !model) return undefined
  return () => providerForMainModel(model)
}

export function resolveInteractiveRuntimeSettingsLocation(
  dataPlane: DataPlane,
  environment: NodeJS.ProcessEnv = process.env,
): { configRoot: string; statePath: string } {
  assertNativeDataPlane(dataPlane)
  const configRoot = resolveDataPlaneRoot({ environment })
  return {
    configRoot,
    statePath: join(configRoot, 'state.json'),
  }
}

async function assessCurrentWorkspaceProviderSelection(options: {
  configRoot: string
  statePath: string
  cwd: string
  environment: NodeJS.ProcessEnv
  pluginDirectories?: readonly string[]
  pluginUrls?: readonly string[]
  strictMcpConfig?: boolean
}): Promise<WorkspaceTrustAssessment | undefined> {
  const shared = await loadNativeSharedResources({
    root: options.configRoot,
    cwd: options.cwd,
    environment: options.environment,
    includeProjectMemory: false,
  })
  const plugins = await loadClaudePlugins({
    configRoot: options.configRoot,
    cwd: options.cwd,
    pluginDirectories: options.pluginDirectories ?? [],
    pluginUrls: options.pluginUrls ?? [],
    strictPluginDirectories:
      (options.pluginDirectories?.length ?? 0) +
        (options.pluginUrls?.length ?? 0) >
      0,
    loadInstalled: true,
    readOnlyExecutables: true,
    environment: options.environment,
  })
  const settings = [...shared.settings, ...plugins.settings]
  if (!hasWorkspaceProviderSelection(settings)) return undefined
  return assessWorkspaceTrust(
    await workspaceTrustInventory({
      cwd: options.cwd,
      settings,
      mcp: options.strictMcpConfig ? [] : [...shared.mcp, ...plugins.mcp],
    }),
    options.statePath,
  )
}

export function resolveUnknownCostSidecarPath(
  dataPlane: DataPlane,
  configRoot: string,
): string {
  assertNativeDataPlane(dataPlane)
  return join(configRoot, 'state', 'unknown-cost-sidecar.json')
}

const createDefaultService: CliDependencies['createService'] = async ({
  eventSink,
  requireProvider,
  hooksOnly = false,
  approveRecovery,
  approveTool,
  agent,
  model: interactiveModel,
  effort: interactiveEffort,
  permissionMode: interactivePermissionMode,
  isSessionActionApproved,
  controls = DEFAULT_CLI_CONTROLS,
  interactive = false,
  sessionKind,
  signal,
  exposeToolRegistry = false,
  onElicitation,
  askUser,
  approvePlan,
  approveWorkspaceTrust,
  emitToolUseSummaries = false,
  cwd: requestedCwd,
  sandboxOriginalCwd,
  configRoot: requestedConfigRoot,
  environment,
  providerEnvironment: requestedProviderEnvironment,
}) => {
  const runtimeEnvironment = requestedProviderEnvironment ?? process.env
  const sandboxEnvironment = { ...runtimeEnvironment, ...environment }
  const claudeVersion = VERIFIED_CLAUDE_SCHEMA_VERSION
  const cwd = requestedCwd ?? process.cwd()
  const workspace = new WorkspaceContext(cwd)
  const dataPlane: DataPlane =
    controls.dataPlane ?? resolveDataPlane(runtimeEnvironment)
  assertNativeDataPlane(dataPlane)
  const experimentalNativeTranscriptWrites = /^(?:1|true|yes|on)$/iu.test(
    (
      runtimeEnvironment.PRAXIS_EXPERIMENTAL_NATIVE_TRANSCRIPT_WRITES ?? ''
    ).trim(),
  )
  const configRoot = resolveDataPlaneRoot({
    ...(requestedConfigRoot === undefined ? {} : { root: requestedConfigRoot }),
    environment: runtimeEnvironment,
  })
  const claudeStatePath = join(configRoot, 'state.json')
  const simpleMode =
    controls.bare ||
    truthyEnvironmentValue(runtimeEnvironment.CLAUDE_CODE_SIMPLE)
  const runtimeSettings =
    controls.safeMode || simpleMode
      ? undefined
      : await loadRuntimeSettings({ configRoot, statePath: claudeStatePath })
  const runtimeSettingsPrompt = runtimeSettingsSystemPrompt(runtimeSettings)
  const cli = await resolveCliControls(
    {
      ...applyRuntimeSettingDefaults(controls, runtimeSettings),
      ...(interactiveModel === undefined ? {} : { model: interactiveModel }),
      ...(interactiveEffort === undefined ? {} : { effort: interactiveEffort }),
      ...(interactivePermissionMode === undefined
        ? {}
        : { permissionMode: interactivePermissionMode }),
    },
    cwd,
  )
  const deferMcpTools = shouldDeferMcpTools({
    simpleMode,
    tools: cli.tools,
    disallowedTools: cli.disallowedTools,
  })
  if (experimentalNativeTranscriptWrites) {
    const incompatible: Array<[string, boolean]> = [
      ['sessionPersistence', cli.sessionPersistence === false],
      ['interactive', interactive],
      ['simpleMode', !simpleMode],
      ['sessionKind', sessionKind !== undefined],
      ['name', cli.name !== undefined],
      [
        'worktree',
        cli.worktreeRequested === true || cli.worktreeName !== undefined,
      ],
      ['addDirectories', cli.additionalDirectories.length > 0],
      ['fileResources', cli.fileResources.length > 0],
      ['settings', cli.additionalSettings !== undefined],
      ['settingSources', cli.settingSources !== undefined],
      ['pluginDirectories', cli.pluginDirectories.length > 0],
      ['pluginUrls', cli.pluginUrls.length > 0],
      ['agent', agent !== undefined || cli.inlineAgents.length > 0],
      ['mcp', cli.mcpConfigs.length > 0 || cli.strictMcpConfig],
      [
        'checkpointing',
        cli.rewindFiles !== undefined ||
          /^(?:1|true|yes|on)$/iu.test(
            (
              runtimeEnvironment.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING ?? ''
            ).trim(),
          ),
      ],
      [
        'teams',
        /^(?:1|true|yes|on)$/iu.test(
          (runtimeEnvironment.PRAXIS_ENABLE_TEAMS ?? '').trim(),
        ),
      ],
    ]
    const active = incompatible.find(([, enabled]) => enabled)
    if (active) {
      throw new Error(
        `experimental native transcript writes incompatible with ${active[0]}`,
      )
    }
  }
  const debug =
    cli.debug !== undefined || cli.debugFile !== undefined
      ? createCliDebugSink(eventSink, {
          cwd,
          ...(cli.debug === undefined ? {} : { filter: cli.debug }),
          ...(cli.debugFile === undefined ? {} : { file: cli.debugFile }),
          ...(cli.debugFile === undefined
            ? { stderr: (message: string) => process.stderr.write(message) }
            : {}),
        })
      : undefined
  const runtimeEventSink = debug?.eventSink ?? eventSink
  let provider: ModelProvider | undefined
  let providerForModel: ((model: string) => ModelProvider) | undefined
  let providerForMainModel: ((model: string) => ModelProvider) | undefined
  let providerForTurn: ((model?: string) => ModelProvider) | undefined
  let sessionNameProviderFactory: (() => ModelProvider) | undefined
  let providerBillingMode: 'api' | 'subscription' | undefined
  const context = parseContextEnvironment(runtimeEnvironment)
  const apiKey = runtimeEnvironment.PRAXIS_API_KEY
  let model = resolveRuntimeModel(
    interactiveModel ?? controls.model,
    runtimeEnvironment,
    runtimeSettings,
  )
  const providerEnvironment =
    cli.fileResources.length > 0
      ? parseProviderEnvironment(runtimeEnvironment)
      : undefined
  const fileCredential =
    runtimeEnvironment.PRAXIS_FILES_BEARER_TOKEN ??
    runtimeEnvironment.PRAXIS_FILES_API_KEY ??
    apiKey
  if (cli.fileResources.length > 0 && !fileCredential) {
    throw new Error(
      '--file requires PRAXIS_FILES_BEARER_TOKEN, PRAXIS_FILES_API_KEY, or PRAXIS_API_KEY',
    )
  }
  const warnedWorkspaceFingerprints = new Set<string>()
  let trustProjectRequestAvailable = cli.trustProject
  const authorizeWorkspaceResources = async (
    automaticSettings: readonly JsonResource[],
    automaticMcp: readonly JsonResource[],
    runtimeCwd: string,
    precomputedAssessment?: WorkspaceTrustAssessment,
  ): Promise<boolean> => {
    if (cli.safeMode || simpleMode) return true
    const trustRequested = trustProjectRequestAvailable
    trustProjectRequestAvailable = false
    const assessment =
      precomputedAssessment ??
      (await assessWorkspaceTrust(
        await workspaceTrustInventory({
          cwd: runtimeCwd,
          settings: automaticSettings,
          mcp: automaticMcp,
        }),
        claudeStatePath,
      ))
    if (assessment.status !== 'untrusted') return true

    let approved = trustRequested
    if (!approved && approveWorkspaceTrust) {
      try {
        approved = await approveWorkspaceTrust(assessment)
      } catch (error) {
        if (!(
          error instanceof Error &&
          (error.name === 'AbortError' || error.name === 'CancellationError')
        )) {
          throw error
        }
        approved = false
      }
    }
    if (approved) {
      await persistWorkspaceTrust(assessment, claudeStatePath)
      return true
    }

    const warningKey = workspaceTrustDecisionKey(assessment)
    if (!warnedWorkspaceFingerprints.has(warningKey)) {
      warnedWorkspaceFingerprints.add(warningKey)
      runtimeEventSink({
        type: 'warning',
        message: `Workspace-controlled resources/configuration blocked for ${safeWorkspaceTrustDisplayField(assessment.canonicalPath)}; restart to review them interactively, or rerun with --trust-project to approve the current fingerprint.`,
      })
    }
    return false
  }
  let workspaceProviderSettingsTrusted = false
  if (!hooksOnly && !cli.safeMode && !simpleMode) {
    const assessment = await assessCurrentWorkspaceProviderSelection({
      configRoot,
      statePath: claudeStatePath,
      cwd,
      environment: runtimeEnvironment,
      pluginDirectories: cli.pluginDirectories,
      pluginUrls: cli.pluginUrls,
      strictMcpConfig: cli.strictMcpConfig,
    })
    if (assessment) {
      workspaceProviderSettingsTrusted = await authorizeWorkspaceResources(
        [],
        [],
        cwd,
        assessment,
      )
    }
  }
  if (!hooksOnly) {
    try {
      const registry = await resolveProviderRegistry({
        configRoot,
        cwd,
        environment: runtimeEnvironment,
        ...((interactiveModel ?? controls.model) === undefined
          ? {}
          : { model: interactiveModel ?? controls.model }),
        ...(controls.provider === undefined
          ? {}
          : { provider: controls.provider }),
        ...(controls.providerProfile === undefined
          ? {}
          : { profile: controls.providerProfile }),
        includeSettings: !(controls.safeMode || simpleMode),
        includeProjectSettings: workspaceProviderSettingsTrusted,
        context,
        vault: new ProviderCredentialVault({
          configRoot,
          environment: runtimeEnvironment,
        }),
        anthropicThinking: {
          mode: cli.thinking ?? 'enabled',
          ...(cli.maxThinkingTokens === undefined
            ? {}
            : { maxTokens: cli.maxThinkingTokens }),
        },
        codexThinking: {
          mode: cli.thinking ?? 'enabled',
          ...(cli.maxThinkingTokens === undefined
            ? {}
            : { maxTokens: cli.maxThinkingTokens }),
        },
        ...(controls.thinking === undefined &&
        controls.maxThinkingTokens === undefined
          ? {}
          : {
              openAiThinking: {
                mode: cli.thinking ?? 'enabled',
                ...(cli.maxThinkingTokens === undefined
                  ? {}
                  : { maxTokens: cli.maxThinkingTokens }),
              },
            }),
      })
      model = registry.target.modelId
      providerBillingMode = registry.target.billingMode
      providerForModel = (selectedModel: string) =>
        registry.create(selectedModel)
      const createProvider = providerForModel
      const createProviderStack = (
        primaryModel: string,
        routeScope: 'completion' | 'turn',
      ) => {
        const models = [primaryModel, ...(cli.fallbackModels ?? [])].filter(
          (candidate, index, all) => all.indexOf(candidate) === index,
        )
        const providers = models.map((candidate) => createProvider(candidate))
        const selected = providers[0]
        if (!selected) throw new Error('A primary model is required')
        return providers.length > 1
          ? new FallbackModelProvider({ providers, routeScope })
          : selected
      }
      providerForMainModel = (primaryModel: string) =>
        createProviderStack(primaryModel, 'completion')
      const defaultProvider = providerForMainModel(model)
      provider = defaultProvider
      providerForTurn = (turnModel?: string) => {
        const selectedModel = turnModel ?? model
        return selectedModel === undefined
          ? defaultProvider
          : createProviderStack(selectedModel, 'turn')
      }
      const haikuOverride = runtimeEnvironment.ANTHROPIC_DEFAULT_HAIKU_MODEL
      if (
        registry.target.providerId === 'anthropic' &&
        registry.target.protocol === 'anthropic-messages' &&
        haikuOverride !== undefined &&
        haikuOverride.trim() !== ''
      ) {
        sessionNameProviderFactory = () =>
          createProviderStack('haiku', 'completion')
      }
    } catch (error) {
      const optionalProviderError =
        error instanceof ProviderAuthenticationError ||
        (error instanceof ProviderSettingsError &&
          error.code === 'model_required')
      if (requireProvider || !optionalProviderError) throw error
    }
  }

  const costStateStore = new ClaudeCostStateStore({
    statePath: claudeStatePath,
    projectIdentity: await resolveProjectIdentity(cwd),
    sidecarPath: resolveUnknownCostSidecarPath(dataPlane, configRoot),
  })
  const sessionMemoryProviderFactory = createSessionMemoryProviderFactory(
    providerForMainModel,
    model,
  )

  const options = {
    configRoot,
    dataPlane,
    ...(experimentalNativeTranscriptWrites
      ? { experimentalNativeTranscriptWrites: true as const }
      : {}),
    cwd,
    claudeVersion,
    eventSink: runtimeEventSink,
    sessionPersistence: cli.sessionPersistence,
    resumeInterruptedTurn: /^(?:1|true|yes|on)$/iu.test(
      (runtimeEnvironment.CLAUDE_CODE_RESUME_INTERRUPTED_TURN ?? '').trim(),
    ),
    costStateStore,
    simpleMode,
    explicitModel:
      interactiveModel !== undefined || controls.model !== undefined,
    explicitSystemPrompt: cli.systemPrompt !== undefined,
    agentInitialPromptHandledExternally: interactive,
    agentSystemPromptOverridesExplicit: interactive,
    effort: cli.effort ?? 'high',
    ...(cli.maxTurns === undefined ? {} : { maxModelTurns: cli.maxTurns }),
    ...(cli.brief && !cli.disallowedTools.includes('SendUserMessage')
      ? { brief: true }
      : {}),
    ...(cli.betas.length ? { betas: cli.betas } : {}),
    ...(cli.jsonSchema ? { structuredOutputSchema: cli.jsonSchema } : {}),
    ...(cli.maxBudgetUsd === undefined
      ? {}
      : { maxBudgetUsd: cli.maxBudgetUsd }),
    ...(providerBillingMode === 'subscription'
      ? {}
      : {
          pricing: ModelPricingRegistry.fromEnvironment(
            runtimeEnvironment.PRAXIS_PRICING_JSON,
          ),
        }),
    collectMetrics: true,
    deferMcpTools,
    ...(!experimentalNativeTranscriptWrites && sessionMemoryProviderFactory
      ? { sessionMemoryProviderFactory }
      : {}),
    ...(!experimentalNativeTranscriptWrites && sessionNameProviderFactory
      ? { sessionNameProviderFactory }
      : {}),
    ...(!experimentalNativeTranscriptWrites && sessionKind !== undefined
      ? { sessionKind }
      : {}),
    ...(!experimentalNativeTranscriptWrites ? { workspace } : {}),
    ...(!experimentalNativeTranscriptWrites && cli.worktreeRequested
      ? {
          initialWorktree: true,
          ...(cli.worktreeName === undefined
            ? {}
            : { initialWorktreeName: cli.worktreeName }),
        }
      : {}),
    ...(!experimentalNativeTranscriptWrites && cli.fileResources.length > 0
      ? {
          fileResources: cli.fileResources,
          fileResourceConfig: {
            cwd,
            apiKey: fileCredential ?? '',
            baseUrl:
              runtimeEnvironment.PRAXIS_FILES_BASE_URL ??
              fileResourceBaseUrl(runtimeEnvironment, providerEnvironment),
            headers: fileResourceHeaders(
              runtimeEnvironment,
              providerEnvironment,
              fileCredential ?? '',
            ),
          },
        }
      : {}),
  }
  const hookConfiguration = async () => {
    const [sharedResources, pluginResources] = await Promise.all([
      cli.safeMode || simpleMode
        ? Promise.resolve({ settings: [], mcp: [] })
        : loadNativeSharedResources({
            root: configRoot,
            cwd,
            environment: runtimeEnvironment,
            includeProjectMemory: false,
          }),
      loadClaudePlugins({
        configRoot,
        cwd,
        pluginDirectories: cli.pluginDirectories,
        pluginUrls: cli.pluginUrls,
        strictPluginDirectories:
          cli.pluginDirectories.length + cli.pluginUrls.length > 0,
        loadInstalled: !cli.safeMode && !simpleMode,
        readOnlyExecutables: true,
        environment: runtimeEnvironment,
      }),
    ])
    const automaticSettings = [
      ...sharedResources.settings,
      ...pluginResources.settings,
    ]
    const automaticMcp = cli.strictMcpConfig
      ? []
      : [...sharedResources.mcp, ...pluginResources.mcp]
    const trusted = await authorizeWorkspaceResources(
      automaticSettings,
      automaticMcp,
      cwd,
    )
    return projectTuiHooks([
      ...allowedWorkspaceHookSettings(automaticSettings, trusted),
      ...(cli.additionalSettings ? [cli.additionalSettings] : []),
    ])
  }
  if (hooksOnly) {
    const service = new ClaudeSessionService(options)
    return Object.assign(service, { hookConfiguration })
  }
  if (!provider && !exposeToolRegistry) {
    const service = new ClaudeSessionService(options)
    if (!interactive) return service
    const initialHookConfiguration = await hookConfiguration()
    return Object.assign(service, {
      hookConfiguration: () => Promise.resolve(initialHookConfiguration),
    })
  }
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

  const nativeSharedResourcesEnabled = !cli.safeMode && !simpleMode
  const baseSettings = nativeSharedResourcesEnabled
    ? await loadNativeSettings({ root: configRoot, cwd })
    : []
  const pluginLoadOptions = {
    configRoot,
    cwd,
    pluginDirectories: cli.pluginDirectories,
    pluginUrls: cli.pluginUrls,
    strictPluginDirectories:
      cli.pluginDirectories.length + cli.pluginUrls.length > 0,
    loadInstalled: !cli.safeMode && !simpleMode,
    environment: runtimeEnvironment,
  }
  const executablePluginResources = await loadClaudePlugins({
    ...pluginLoadOptions,
    readOnlyExecutables: true,
  })
  const projectMemoryPolicy =
    cli.safeMode || simpleMode
      ? { enabled: false, extraction: false, recall: false }
      : resolveProjectMemoryPolicy({
          dataPlane,
          settings: [
            ...baseSettings,
            ...executablePluginResources.settings,
            ...(cli.additionalSettings ? [cli.additionalSettings] : []),
          ],
          environment: runtimeEnvironment,
        })
  const includeProjectMemory =
    projectMemoryPolicy.enabled && !projectMemoryPolicy.recall
  const loadedResources = nativeSharedResourcesEnabled
    ? await loadNativeSharedResources({
        root: configRoot,
        cwd,
        environment: runtimeEnvironment,
        includeProjectMemory,
      })
    : {
        instructions: [],
        memory: [],
        skills: [],
        commands: [],
        agents: [],
        settings: [],
        mcp: [],
      }
  const trustSettings = [
    ...loadedResources.settings,
    ...executablePluginResources.settings,
  ]
  const trustMcp = cli.strictMcpConfig
    ? []
    : [...loadedResources.mcp, ...executablePluginResources.mcp]
  const workspaceExecutablesTrusted = await authorizeWorkspaceResources(
    trustSettings,
    trustMcp,
    cwd,
  )
  const loadedPluginResources = await loadClaudePlugins({
    ...pluginLoadOptions,
    allowWorkspaceMcpb: workspaceExecutablesTrusted,
  })
  const materializedPluginMcp = new Map(
    loadedPluginResources.mcp.map((resource) => [resource.path, resource]),
  )
  const pluginResources = {
    ...loadedPluginResources,
    settings: executablePluginResources.settings,
    mcp: executablePluginResources.mcp.flatMap((resource) => {
      if (resource.pluginExecutableSource?.kind !== 'mcpb') return [resource]
      const materialized = materializedPluginMcp.get(resource.path)
      if (!materialized) return []
      if (
        materialized.pluginExecutableSource?.source !==
          resource.pluginExecutableSource.source ||
        materialized.pluginExecutableSource.fingerprint !==
          resource.pluginExecutableSource.fingerprint
      ) {
        runtimeEventSink({
          type: 'warning',
          message: `Workspace MCPB source changed during trust preflight and was blocked: ${safeWorkspaceTrustDisplayField(resource.path)}. Restart to review the new fingerprint.`,
        })
        return []
      }
      return [materialized]
    }),
  }
  const allSettings = [
    ...loadedResources.settings,
    ...pluginResources.settings,
    ...(cli.additionalSettings ? [cli.additionalSettings] : []),
  ]
  for (const plugin of pluginResources.plugins) {
    for (const error of plugin.errors) {
      runtimeEventSink({
        type: 'warning',
        message: `Plugin ${plugin.name} could not be loaded: ${error}`,
      })
    }
  }
  const configuredAgent = [...allSettings]
    .reverse()
    .map((resource) =>
      resource.value &&
      typeof resource.value === 'object' &&
      !Array.isArray(resource.value)
        ? (resource.value as Record<string, unknown>).agent
        : undefined,
    )
    .find(
      (value): value is string => typeof value === 'string' && value.length > 0,
    )
  const selectedMainAgent = agent ?? configuredAgent
  const automaticSettings = [
    ...loadedResources.settings,
    ...pluginResources.settings,
  ]
  const automaticMcp = cli.strictMcpConfig
    ? []
    : [...loadedResources.mcp, ...pluginResources.mcp]
  const hookSettings = [
    ...allowedWorkspaceHookSettings(
      automaticSettings,
      workspaceExecutablesTrusted,
    ),
    ...(cli.additionalSettings ? [cli.additionalSettings] : []),
  ]
  const executableMcp = [
    ...allowedWorkspaceMcpResources(automaticMcp, workspaceExecutablesTrusted),
    ...cli.mcpResources,
  ]
  const resources = {
    ...loadedResources,
    commands: [...loadedResources.commands, ...pluginResources.commands],
    skills: [...loadedResources.skills, ...pluginResources.skills],
    agents: [
      ...loadedResources.agents,
      ...pluginResources.agents,
      ...cli.inlineAgents,
    ],
    settings: allSettings,
    mcp: executableMcp,
  }
  const extensions = new ClaudeExtensionCatalog(resources, {
    disableSlashCommands: cli.disableSlashCommands,
    dataPlane,
  })
  const memoryDirectory = !projectMemoryPolicy.enabled
    ? undefined
    : await resolveProjectMemoryDirectory({
        dataPlane,
        configRoot,
        cwd,
      })
  if (memoryDirectory) await mkdir(memoryDirectory, { recursive: true })
  const projectMemoryProviderFactory = providerForTurn
    ? () => providerForTurn()
    : providerForMainModel && model
      ? () => providerForMainModel(model)
      : undefined
  const projectMemoryRecall =
    projectMemoryPolicy.recall &&
    memoryDirectory &&
    projectMemoryProviderFactory
      ? new ProjectMemoryRecallController({
          directory: memoryDirectory,
          selector: new ProjectMemoryModelSelector({
            directory: memoryDirectory,
            providerFactory: projectMemoryProviderFactory,
          }),
        })
      : undefined
  const projectMemoryExtraction =
    projectMemoryPolicy.extraction &&
    memoryDirectory &&
    projectMemoryProviderFactory
      ? new ProjectMemoryExtractionController({
          directory: memoryDirectory,
          cursorPath: resolveProjectMemoryStatePath({
            dataPlane,
            configRoot,
            memoryDirectory,
          }),
          extractor: new ProjectMemoryAgentExtractor({
            providerFactory: projectMemoryProviderFactory,
          }),
          onWarning: (message) =>
            runtimeEventSink({ type: 'warning', message }),
        })
      : undefined
  const loadContextResources = (runtimeCwd = workspace.cwd()) =>
    nativeSharedResourcesEnabled
      ? loadNativeContextResources({
          root: configRoot,
          cwd: runtimeCwd,
          environment: runtimeEnvironment,
          includeProjectMemory,
        })
      : Promise.resolve({
          instructions: [],
          conditionalRules: [],
          memoryIndex: null,
        })
  const exposePlanDirectory =
    interactive &&
    askUser !== undefined &&
    approvePlan !== undefined &&
    ['EnterPlanMode', 'ExitPlanMode'].some(
      (name) =>
        (cli.tools === undefined ||
          cli.tools.includes('default') ||
          cli.tools.includes(name)) &&
        !cli.disallowedTools.includes(name),
    )
  const initialAdditionalDirectories = [
    ...cli.additionalDirectories,
    ...(exposePlanDirectory ? [resolve(configRoot, 'plans')] : []),
  ]
  const sandboxSettings = loadClaudeSandboxSettings({
    resources: allSettings.filter((resource) => resource.plugin !== true),
    cwd: workspace.cwd(),
    originalCwd: sandboxOriginalCwd ?? workspace.cwd(),
    configRoot,
    dataPlane,
    homeDirectory:
      sandboxEnvironment.HOME ?? sandboxEnvironment.USERPROFILE ?? homedir(),
    additionalDirectories: initialAdditionalDirectories,
    tempDirectory: nativeSandboxTempDirectory(sandboxEnvironment),
  })
  await claudeSandboxRuntime.initialize(sandboxSettings)
  const sandboxUnavailableReason = claudeSandboxRuntime.unavailableReason()
  if (sandboxUnavailableReason && !sandboxSettings.failIfUnavailable) {
    runtimeEventSink({ type: 'warning', message: sandboxUnavailableReason })
  }
  const permissionAdditionalDirectories = [
    ...new Set([
      ...initialAdditionalDirectories,
      ...controls.addDirectories.map((directory) => resolve(cwd, directory)),
      ...(memoryDirectory ? [memoryDirectory] : []),
    ]),
  ]
  const initialAdditionalReadDirectories = [nativeBackgroundTaskParent(cwd)]
  const permissionResolverForMode = (permissionMode: ClaudePermissionMode) =>
    new ClaudeExtensionPermissionResolver(
      new ClaudePermissionResolver({
        cwd,
        cwdProvider: () => workspace.cwd(),
        configRoot,
        settings: allSettings,
        allowedTools: cli.allowedTools,
        disallowedTools: cli.disallowedTools,
        additionalDirectories: permissionAdditionalDirectories,
        additionalReadDirectories: initialAdditionalReadDirectories,
        sandbox: claudeSandboxRuntime,
        permissionMode,
        ...(isSessionActionApproved ? { isSessionActionApproved } : {}),
        ...(permissionMode === 'auto'
          ? {
              autoClassifier:
                createClaudeModelAutoClassifier(hostedToolProvider),
            }
          : {}),
      }),
      extensions,
    )
  const permissions = permissionResolverForMode(
    cli.dangerouslySkipPermissions ? 'bypassPermissions' : cli.permissionMode,
  )
  const hookSessionEnvironment = new ClaudeSessionEnvironment({
    stateRoot: resolveDataPlanePaths({
      dataPlane,
      root: configRoot,
      cwd,
      sessionId: '00000000-0000-4000-8000-000000000000',
    }).stateRoot,
    warn: (message) => runtimeEventSink({ type: 'warning', message }),
  })
  const localTools = new LocalToolRegistry({
    cwd,
    cwdProvider: () => workspace.cwd(),
    enableReportFindings: exposeToolRegistry,
    ...(memoryDirectory ? { sharedMemoryDirectory: memoryDirectory } : {}),
    additionalDirectories: initialAdditionalDirectories,
    additionalReadDirectories: initialAdditionalReadDirectories,
    sandbox: claudeSandboxRuntime,
    homeDirectory:
      sandboxEnvironment.HOME ?? sandboxEnvironment.USERPROFILE ?? homedir(),
    configRoot,
    dataPlane,
    sessionEnvironment: (sessionId) =>
      hookSessionEnvironment.environment(sessionId),
    ...(environment ? { environment } : {}),
  })
  const runtimeMcpResources = async (candidates: readonly JsonResource[]) => {
    const management = new ClaudeMcpManagement({
      dataPlane,
      configRoot,
      statePath: claudeStatePath,
      cwd: workspace.cwd(),
    })
    return filterDisabledMcpResources(candidates, await management.disabled())
  }
  let contextAssembler: ClaudeContextAssembler | undefined
  const mcpTools = await ClaudeMcpToolRegistry.connect({
    base: simpleMode
      ? localTools
      : new WebToolRegistry({
          base: localTools,
          provider: hostedToolProvider,
        }),
    resources: await runtimeMcpResources(resources.mcp),
    environment: runtimeEnvironment,
    reloadResources: async () => {
      if (cli.strictMcpConfig) return runtimeMcpResources(cli.mcpResources)
      const refreshed = nativeSharedResourcesEnabled
        ? await loadNativeSharedResources({
            root: configRoot,
            cwd: workspace.cwd(),
            environment: runtimeEnvironment,
            includeProjectMemory,
          })
        : {
            instructions: [],
            memory: [],
            skills: [],
            commands: [],
            agents: [],
            settings: [],
            mcp: [],
          }
      const refreshedSettings = [
        ...refreshed.settings,
        ...pluginResources.settings,
      ]
      const refreshedMcp = [...refreshed.mcp, ...pluginResources.mcp]
      const trusted = await authorizeWorkspaceResources(
        refreshedSettings,
        refreshedMcp,
        workspace.cwd(),
      )
      return runtimeMcpResources([
        ...allowedWorkspaceMcpResources(refreshedMcp, trusted),
        ...cli.mcpResources,
      ])
    },
    cwd,
    configRoot,
    onWarning: (message) => runtimeEventSink({ type: 'warning', message }),
    onPromptsChanged: (prompts) => extensions.setMcpPrompts(prompts),
    onInstructionsChanged: () =>
      contextAssembler?.invalidate({ reason: 'tool-pool' }),
    authenticateServer: async (name) => {
      const record = await new ClaudeMcpManagement({
        dataPlane,
        configRoot,
        statePath: claudeStatePath,
        cwd: workspace.cwd(),
      }).get(name)
      const server = mcpOAuthServerIdentity(record.name, record.config)
      const oauth = mcpOauthOptions(record.config)
      const clientSecret = oauth.clientId
        ? await new ClaudeMcpOAuthStore({ configRoot }).readClientSecret(server)
        : undefined
      await authenticateMcpServer({
        configRoot,
        server,
        ...oauth,
        ...(clientSecret ? { clientSecret } : {}),
        noBrowser: false,
        write: (message) => process.stdout.write(message),
      })
    },
    ...(onElicitation ? { onElicitation } : {}),
    eventSink: runtimeEventSink,
    ...(signal ? { signal } : {}),
  })
  let lspTools: ClaudeLspToolManager | undefined
  try {
    const permissionApprover = cli.permissionPromptTool
      ? mcpTools.permissionPrompt(cli.permissionPromptTool)
      : approveTool
    const extensionTools = new ClaudeExtensionToolRegistry(mcpTools, extensions)
    const lspEnabled =
      interactive &&
      !cli.safeMode &&
      !simpleMode &&
      pluginResources.lsp.length > 0
    lspTools = lspEnabled
      ? new ClaudeLspToolManager({
          servers: pluginResources.lsp,
          cwdProvider: () => workspace.cwd(),
          roots: () => [
            workspace.cwd(),
            ...cli.additionalDirectories,
            ...(memoryDirectory ? [memoryDirectory] : []),
          ],
          environment: runtimeEnvironment,
        })
      : undefined
    const extensionAndLspTools = lspTools
      ? lspTools.registry(extensionTools)
      : extensionTools
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
    const teamToolNames = PRAXIS_TEAM_TOOLS
    const worktreeToolNames = ['EnterWorktree', 'ExitWorktree'] as const
    const interactiveToolNames = [
      'AskUserQuestion',
      'EnterPlanMode',
      'ExitPlanMode',
    ] as const
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
        !simpleMode &&
        (cli.tools === undefined ||
          cli.tools.includes('default') ||
          cli.tools.includes(name)) &&
        !cli.disallowedTools.includes(name),
    )
    const selectedScheduledTools = scheduledToolNames.filter(
      (name) =>
        !simpleMode &&
        (cli.tools === undefined ||
          cli.tools.includes('default') ||
          cli.tools.includes(name)) &&
        !cli.disallowedTools.includes(name),
    )
    const selectedWorkflowTools = workflowToolNames.filter(
      (name) =>
        (runtimeSettings?.workflows ?? true) &&
        cli.sessionPersistence &&
        !simpleMode &&
        (cli.tools === undefined ||
          cli.tools.includes('default') ||
          cli.tools.includes(name)) &&
        !cli.disallowedTools.includes(name),
    )
    const teamEnabled = resolveClaudeToolCapabilities({
      role: 'main',
      interactive,
      simpleMode,
      env: runtimeEnvironment,
    }).has('TeamCreate')
    const selectedTeamTools = [
      ...teamToolNames.filter(
        (name) =>
          teamEnabled &&
          !simpleMode &&
          (cli.tools === undefined ||
            cli.tools.includes('default') ||
            cli.tools.includes(name)) &&
          !cli.disallowedTools.includes(name),
      ),
    ]
    const selectedWorktreeTools = worktreeToolNames.filter(
      (name) =>
        !simpleMode &&
        (cli.tools === undefined ||
          cli.tools.includes('default') ||
          cli.tools.includes(name)) &&
        !cli.disallowedTools.includes(name),
    )
    const selectedInteractiveTools = interactiveToolNames.filter(
      (name) =>
        interactive &&
        (cli.tools === undefined ||
          cli.tools.includes('default') ||
          cli.tools.includes(name)) &&
        !cli.disallowedTools.includes(name),
    )
    const enableBackgroundBash =
      cli.sessionPersistence &&
      !simpleMode &&
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
        !teamToolNames.includes(name as (typeof teamToolNames)[number]) &&
        !worktreeToolNames.includes(
          name as (typeof worktreeToolNames)[number],
        ) &&
        !interactiveToolNames.includes(
          name as (typeof interactiveToolNames)[number],
        ) &&
        (!simpleMode || (name !== 'WebFetch' && name !== 'WebSearch')),
    )
    const filteredTools = new FilteredToolRegistry(extensionAndLspTools, {
      ...(cli.tools === undefined
        ? simpleMode
          ? { tools: ['Bash', 'Edit', 'ApplyPatch', 'Read'] }
          : {}
        : { tools: selectedBaseTools ?? [] }),
      disallowedTools: cli.disallowedTools,
    })
    const enableSubagents = !simpleMode && selectedAgentTools.length > 0
    const hooks =
      cli.safeMode || simpleMode
        ? undefined
        : new ClaudeHookRunner({
            settings: hookSettings,
            cwd,
            onEvent: (event) => runtimeEventSink({ type: 'hook', event }),
            sessionEnvironment: hookSessionEnvironment,
          })
    const interactiveTools =
      selectedInteractiveTools.length > 0 && askUser && approvePlan
        ? new ClaudeInteractiveToolManager({
            configRoot,
            initialMode: cli.dangerouslySkipPermissions
              ? 'bypassPermissions'
              : cli.permissionMode,
            enabledTools: selectedInteractiveTools,
            callbacks: { askUser, approvePlan },
            permissionResolverForMode,
            settings: {
              useAutoModeDuringPlan:
                runtimeSettings?.useAutoModeDuringPlan ?? true,
            },
          })
        : undefined
    contextAssembler = new ClaudeContextAssembler({
      loadResources: loadContextResources,
      onInstructionsLoaded: async (instructions, context) => {
        if (!context.lifecycleId) return
        await service.instructionsLoaded(
          context.lifecycleId,
          instructions,
          context.reason,
        )
      },
      loadDynamicContext: (runtimeCwd = workspace.cwd()) =>
        loadClaudeDynamicContext({
          cwd: runtimeCwd,
          ...(memoryDirectory ? { memoryDirectory } : {}),
        }),
      loadMcpInstructions: async () => mcpTools.instructions(),
      loadSessionGuidance: async () => {
        const toolNames = [
          ...new Set([
            ...filteredTools.definitions().map((definition) => definition.name),
            ...selectedTaskRuntimeTools,
            ...selectedScheduledTools,
            ...selectedWorkflowTools,
            ...selectedTeamTools,
            ...selectedWorktreeTools,
            ...selectedInteractiveTools,
            ...(enableSubagents ? selectedAgentTools : []),
          ]),
        ].sort()
        const skillNames = extensions
          .modelInvocableSkills()
          .map((skill) => skill.name)
          .sort()
        if (
          toolNames.length === 0 &&
          skillNames.length === 0 &&
          runtimeSettingsPrompt === undefined
        )
          return undefined
        return [
          '# Session capabilities',
          ...(toolNames.length > 0
            ? [`Enabled tools: ${toolNames.join(', ')}`]
            : []),
          ...(skillNames.length > 0
            ? [`Model-invocable skills: ${skillNames.join(', ')}`]
            : []),
          'Use a capability only when it directly helps complete the request, and follow its declared input contract.',
          ...(runtimeSettingsPrompt ? ['', runtimeSettingsPrompt] : []),
        ].join('\n')
      },
      excludeDynamicSystemPromptSections:
        cli.excludeDynamicSystemPromptSections,
      ...(cli.systemPrompt === undefined
        ? {}
        : { systemPrompt: cli.systemPrompt }),
      ...(cli.appendSystemPrompt
        ? { appendSystemPrompt: cli.appendSystemPrompt }
        : {}),
      ...(simpleMode ? { bare: true } : {}),
    })
    const teamRuntimeEnabled = teamEnabled
    const teamModules = teamRuntimeEnabled
      ? await Promise.all([
          import('./application/team-capability.js'),
          import('./application/team-agent-runtime.js'),
          import('./application/team-lead-decision-surface.js'),
          import('./application/team-lead-operations.js'),
          import('./tools/team-lead-tools.js'),
        ])
      : undefined
    const teamDecisionSurface =
      teamModules && permissionApprover
        ? new teamModules[2].SerializedTeamLeadDecisionSurface(
            permissionApprover,
          )
        : undefined
    const teamCapability = teamModules
      ? new teamModules[0].LocalTeamCapability({
          nativeRoot: resolveDataPlaneRoot({
            environment: runtimeEnvironment,
          }),
          cwd: () => workspace.cwd(),
          maxConcurrent: teamModules[0].DEFAULT_LOCAL_TEAM_CONCURRENCY,
          baseTools: filteredTools,
          permissions,
          ...(hooks ? { hooks } : {}),
          permissionMode: cli.dangerouslySkipPermissions
            ? 'bypassPermissions'
            : cli.permissionMode,
          ...(signal ? { signal } : {}),
          createRuntime: () =>
            new teamModules[1].ClaudeTeamAgentRuntime({
              nativeRoot: resolveDataPlaneRoot({
                environment: runtimeEnvironment,
              }),
              configRoot,
              claudeVersion,
              provider: hostedToolProvider,
              ...(teamDecisionSurface
                ? { decisionSurface: teamDecisionSurface }
                : {}),
              ...(extensions ? { extensions } : {}),
              ...(hooks ? { hooks } : {}),
              ...(contextAssembler ? { contextAssembler } : {}),
              ...(providerForModel ? { providerForModel } : {}),
              ...(providerForTurn ? { providerForTurn } : {}),
              permissionResolverForMode,
              eventSink: runtimeEventSink,
            }),
        })
      : undefined
    const teamLeadOperations =
      teamCapability && teamModules
        ? new teamModules[3].TeamLeadOperations(teamCapability)
        : undefined
    const teamLeadToolRegistryFactory = teamModules
      ? (
          base: ToolRegistry,
          operations: TeamLeadOperations,
          sessionId: string,
          names: readonly string[],
        ) =>
          new teamModules[4].TeamLeadToolRegistry(
            base,
            operations,
            sessionId,
            names,
          )
      : undefined
    const service = new ClaudeSessionService({
      ...options,
      provider: hostedToolProvider,
      ...(providerForModel ? { providerForModel } : {}),
      ...(providerForMainModel ? { providerForMainModel } : {}),
      ...(providerForTurn ? { providerForTurn } : {}),
      tools: filteredTools,
      toolCapabilityEnvironment: runtimeEnvironment,
      ...(!experimentalNativeTranscriptWrites ? { mcp: mcpTools } : {}),
      permissions,
      permissionResolverForMode,
      permissionMode: cli.dangerouslySkipPermissions
        ? 'bypassPermissions'
        : cli.permissionMode,
      persistPermissionUpdates: (updates) =>
        persistTuiPermissionUpdates({
          cwd: workspace.cwd(),
          configRoot,
          updates,
        }),
      ...(experimentalNativeTranscriptWrites
        ? {}
        : {
            extensions,
            enableSubagents,
            subagentToolNames: routedSubagentTools,
            taskToolNames: selectedTaskRuntimeTools,
            scheduledToolNames: selectedScheduledTools,
            teamToolNames: selectedTeamTools,
            enableDynamicWakeups: interactive,
            enableWorkflows: selectedWorkflowTools.length > 0,
          }),
      emitToolUseSummaries,
      ...(!experimentalNativeTranscriptWrites
        ? {
            enableWorktrees:
              cli.worktreeRequested || selectedWorktreeTools.length > 0,
            worktreeToolNames: selectedWorktreeTools,
            ...(runtimeSettings
              ? { worktreeBaseRef: runtimeSettings.worktreeBaseRef }
              : {}),
            ...(interactiveTools ? { interactiveTools } : {}),
            ...(hooks ? { hooks } : {}),
            ...(selectedMainAgent ? { agent: selectedMainAgent } : {}),
            ...(memoryDirectory
              ? { projectMemoryDirectory: memoryDirectory }
              : {}),
            ...(projectMemoryRecall ? { projectMemoryRecall } : {}),
            ...(projectMemoryExtraction ? { projectMemoryExtraction } : {}),
          }
        : {}),
      contextAssembler,
      ...(!experimentalNativeTranscriptWrites
        ? {
            conditionalRuleResolver: new ClaudeConditionalRuleResolver({
              loadResources: loadContextResources,
            }),
          }
        : {}),
      ...('contextReserveTokens' in context
        ? { contextReserveTokens: context.contextReserveTokens }
        : {}),
      ...(permissionApprover ? { approveTool: permissionApprover } : {}),
      ...(approveRecovery ? { approveRecovery } : {}),
      ...(!experimentalNativeTranscriptWrites
        ? {
            fileCheckpointing:
              runtimeEnvironment.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING ===
                'true' || runtimeSettings?.checkpoints === true,
          }
        : {}),
      autoCompact: runtimeSettings?.autoCompact ?? true,
      ...(!experimentalNativeTranscriptWrites
        ? {
            fileRewindRoots: [
              ...cli.additionalDirectories,
              ...(memoryDirectory ? [memoryDirectory] : []),
            ],
          }
        : {}),
      ...(!experimentalNativeTranscriptWrites && teamLeadOperations
        ? {
            teamLeadOperations,
            ...(teamLeadToolRegistryFactory
              ? { teamLeadToolRegistryFactory }
              : {}),
          }
        : {}),
    })
    const toolNames = [
      ...filteredTools.definitions().map((definition) => definition.name),
      ...(cli.brief && !cli.disallowedTools.includes('SendUserMessage')
        ? ['SendUserMessage']
        : []),
      ...selectedTaskTools,
      ...selectedScheduledTools,
      ...selectedWorkflowTools,
      ...selectedWorktreeTools,
      ...selectedInteractiveTools,
      ...(enableSubagents ? selectedAgentTools : []),
      ...selectedTeamTools,
    ]
    const runtimeInfo: CliRuntimeInfo = {
      cwd: workspace.cwd(),
      model:
        provider?.model ??
        resolveRuntimeModel(
          interactiveModel ?? controls.model,
          runtimeEnvironment,
          runtimeSettings,
        ) ??
        'unknown',
      ...(provider?.capabilities.contextWindowTokens === undefined
        ? {}
        : { contextWindowTokens: provider.capabilities.contextWindowTokens }),
      ...(provider?.capabilities.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: provider.capabilities.maxOutputTokens }),
      tools: toolNames,
      mcpServers: mcpTools.serverStatuses(),
      permissionMode: cli.dangerouslySkipPermissions
        ? 'bypassPermissions'
        : cli.permissionMode,
      slashCommands: extensions
        .modelInvocableSkills()
        .map((definition) => definition.name)
        .concat(extensions.mcpPromptNames()),
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
    let pendingResumeSessionAt = cli.resumeSessionAt
    return {
      ...(teamLeadOperations ? { teamLeadOperations } : {}),
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
      resume: (sessionId, prompt, signal, name, images, documents) => {
        const resumeSessionAt = pendingResumeSessionAt
        pendingResumeSessionAt = undefined
        return service.resume(
          sessionId,
          prompt,
          signal,
          name ?? cli.name,
          images,
          documents,
          resumeSessionAt,
        )
      },
      runShell: (command, signal, sessionId, name) =>
        service.runShell(command, signal, sessionId, name ?? cli.name),
      resumeShell: (sessionId, command, signal, name) => {
        const resumeSessionAt = pendingResumeSessionAt
        pendingResumeSessionAt = undefined
        return service.resumeShell(
          sessionId,
          command,
          signal,
          name ?? cli.name,
          resumeSessionAt,
        )
      },
      fork: (sessionId, targetSessionId, requestedResumeSessionAt) => {
        const resumeSessionAt =
          requestedResumeSessionAt ?? pendingResumeSessionAt
        pendingResumeSessionAt = undefined
        return service.fork(sessionId, targetSessionId, resumeSessionAt)
      },
      ensureFork: (sessionId, targetSessionId, checkpoint) =>
        service.ensureFork(sessionId, targetSessionId, checkpoint),
      setPermissionMode: (sessionId, permissionMode) =>
        service.setPermissionMode(sessionId, permissionMode),
      rewindFiles: (sessionId, userMessageId) =>
        service.rewindFiles(sessionId, userMessageId),
      rewindPoints: (sessionId) => service.rewindPoints(sessionId),
      changeCwd: (sessionId, cwd, expectedCanonicalTarget) =>
        service.changeCwd(sessionId, cwd, expectedCanonicalTarget),
      inspectCwd: (cwd) => service.inspectCwd(cwd),
      notify: (sessionId, message, notificationType, title) =>
        service.notifyDetached(sessionId, message, notificationType, title),
      recordCdUsage: (sessionId) => service.recordCdUsage(sessionId),
      approveRecentlyDenied: (sessionId, display) =>
        service.approveRecentlyDenied(sessionId, display),
      retryRecentlyDenied: (sessionId, display, retrySignal) =>
        service.retryRecentlyDenied(sessionId, display, retrySignal),
      answerSideQuestion: (
        sessionId,
        question,
        sideSignal,
        onDelta,
        permissionMode,
      ) =>
        service.answerSideQuestion(
          sessionId,
          question,
          sideSignal,
          onDelta,
          permissionMode,
        ),
      recordBtwUsage: (sessionId, permissionMode) =>
        service.recordBtwUsage(sessionId, permissionMode),
      recordColorUsage: (
        sessionId,
        selection,
        display,
        permissionMode,
        options,
      ) =>
        service.recordColorUsage(
          sessionId,
          selection,
          display,
          permissionMode,
          options,
        ),
      agentColor: (sessionId) => service.readEffectiveAgentColor(sessionId),
      recordBackgroundUsage: (sessionId, permissionMode) =>
        service.recordBackgroundUsage(sessionId, permissionMode),
      recordBackgroundLaunch: (sessionId) =>
        service.recordBackgroundLaunch(sessionId),
      forkSideQuestion: (sessionId, question, sideSignal) =>
        service.forkSideQuestion(sessionId, question, sideSignal),
      lifecycle: async (trigger, lifecycleOptions = {}) => {
        if (!hooks) return
        const sessionId = lifecycleOptions.sessionId ?? randomUUID()
        const runtimeCwd = workspace.cwd()
        const transcriptPath = resolveDataPlanePaths({
          dataPlane: 'native',
          root: configRoot,
          cwd: runtimeCwd,
          sessionId,
        }).sessionFile
        const hookSession = {
          session_id: sessionId,
          transcript_path: transcriptPath,
          cwd: runtimeCwd,
          permission_mode: cli.dangerouslySkipPermissions
            ? 'bypassPermissions'
            : cli.permissionMode,
        }
        const setup = await hooks.run(
          { ...hookSession, hook_event_name: 'Setup', trigger },
          trigger,
          signal,
        )
        if (setup.blockedReason) {
          throw new Error(`Setup hook error: ${setup.blockedReason}`)
        }
        if (!lifecycleOptions.sessionStart) return
        const startup = await hooks.run(
          {
            ...hookSession,
            hook_event_name: 'SessionStart',
            source: 'startup',
          },
          'startup',
          signal,
        )
        if (startup.blockedReason) {
          throw new Error(`SessionStart hook error: ${startup.blockedReason}`)
        }
      },
      sessions: () => service.sessions(),
      registerResumePath: (path) => service.registerResumePath(path),
      costSnapshot: (sessionId) => service.costSnapshot(sessionId),
      slashCommands: () =>
        extensions.slashCommandDefinitions().map((definition) => ({
          name: definition.name,
          description: definition.description,
          source: definition.builtin === true ? 'builtin' : definition.kind,
          ...(definition.progressMessage === undefined
            ? {}
            : { progressMessage: definition.progressMessage }),
        })),
      hookConfiguration: async () => projectTuiHooks(hookSettings),
      mcpInspect: () => service.mcpInspect(),
      mcpReconnect: (name) => service.mcpReconnect(name),
      mcpAuthenticate: (name) => service.mcpAuthenticate(name),
      mcpReload: () => service.mcpReload(),
      mcpTools: (name) => service.mcpTools(name),
      taskSnapshots: (sessionId: string) => service.taskSnapshots(sessionId),
      stopTask: (sessionId: string, taskId: string) =>
        service.stopTask(sessionId, taskId),
      agentDefinitions: () => extensions.agentDefinitions(),
      initialAgentPrompt: () =>
        selectedMainAgent
          ? extensions.agent(selectedMainAgent)?.initialPrompt
          : undefined,
      inspect: (sessionId) => service.inspect(sessionId),
      export: (sessionId) => service.export(sessionId),
      transcript: (sessionId) =>
        service.transcript(sessionId, pendingResumeSessionAt),
      compact: (sessionId, signal, selection) =>
        service.compact(sessionId, signal, selection),
      rename: (sessionId, name) => service.rename(sessionId, name),
      sessionNameSuggestion: (sessionId, signal) =>
        service.sessionNameSuggestion(sessionId, signal),
      nextScheduledPrompt: (signal) => service.nextScheduledPrompt(signal),
      transitionHookSession: (sessionId: string, reason: 'clear' | 'resume') =>
        service.transitionHookSession(sessionId, reason),
      close: async () => {
        let failure: unknown
        try {
          await service.close()
        } catch (error) {
          failure = error
        }
        try {
          await mcpTools.close()
        } catch (error) {
          failure ??= error
        }
        try {
          await lspTools?.close()
        } catch (error) {
          failure ??= error
        }
        await debug?.close()
        if (failure !== undefined) throw failure
      },
      runtimeInfo: () => {
        // Drop the static capability snapshot so a fallback-routed provider
        // never reports stale context/output limits, then re-derive them from
        // the currently active provider.
        const staticInfo: CliRuntimeInfo = {
          ...runtimeInfo,
          cwd: workspace.cwd(),
          model:
            service.model() ??
            provider?.model ??
            resolveRuntimeModel(
              interactiveModel ?? controls.model,
              runtimeEnvironment,
              runtimeSettings,
            ) ??
            'unknown',
        }
        delete staticInfo.contextWindowTokens
        delete staticInfo.maxOutputTokens
        return {
          ...staticInfo,
          ...(provider?.capabilities.contextWindowTokens === undefined
            ? {}
            : {
                contextWindowTokens: provider.capabilities.contextWindowTokens,
              }),
          ...(provider?.capabilities.maxOutputTokens === undefined
            ? {}
            : { maxOutputTokens: provider.capabilities.maxOutputTokens }),
        }
      },
      promptSuggestion: (sessionId, suggestionSignal) =>
        service.promptSuggestion(sessionId, suggestionSignal),
    }
  } catch (error) {
    try {
      await lspTools?.close()
    } catch {
      // Preserve the service-construction failure as the primary error.
    }
    try {
      await mcpTools.close()
    } catch {
      // Preserve the service-construction failure as the primary error.
    } finally {
      await debug?.close()
    }
    throw error
  }
}

const createDefaultAutoModeCritic: NonNullable<
  CliDependencies['createAutoModeCritic']
> = async ({
  model,
  provider,
  providerProfile,
  dataPlane,
  configRoot,
  statePath,
}) => {
  const resolvedDataPlane = dataPlane ?? resolveDataPlane()
  const location = resolveInteractiveRuntimeSettingsLocation(resolvedDataPlane)
  const resolvedConfigRoot = configRoot ?? location.configRoot
  const assessment = await assessCurrentWorkspaceProviderSelection({
    configRoot: resolvedConfigRoot,
    statePath: statePath ?? join(resolvedConfigRoot, 'state.json'),
    cwd: process.cwd(),
    environment: process.env,
  })
  const registry = await resolveProviderRegistry({
    configRoot: resolvedConfigRoot,
    cwd: process.cwd(),
    environment: process.env,
    ...(model === undefined ? {} : { model }),
    ...(provider === undefined ? {} : { provider }),
    ...(providerProfile === undefined ? {} : { profile: providerProfile }),
    includeProjectSettings: assessment?.status === 'trusted',
    context: parseContextEnvironment(process.env),
    vault: new ProviderCredentialVault({
      configRoot: resolvedConfigRoot,
      environment: process.env,
    }),
  })
  return registry.create(model ?? registry.target.modelId)
}

const defaultPluginEvalRuntimeFactory: PluginEvalDependencies['runtimeFactory'] =
  {
    create: async (options) => {
      let turns = 0
      let historySessionId: string | undefined
      if (options.historyFile) {
        const source = await readFile(options.historyFile, 'utf8')
        for (const line of source.split(/\r?\n/u)) {
          if (!line.trim()) continue
          let entry: unknown
          try {
            entry = JSON.parse(line)
          } catch (error) {
            throw new Error(
              `Invalid history_file JSONL: ${options.historyFile}`,
              {
                cause: error,
              },
            )
          }
          if (!entry || typeof entry !== 'object' || Array.isArray(entry))
            throw new Error(
              `Invalid history_file entry: ${options.historyFile}`,
            )
          const candidate = (entry as Record<string, unknown>).sessionId
          if (typeof candidate === 'string' && isClaudeSessionId(candidate)) {
            historySessionId ??= candidate
          }
        }
        if (!historySessionId)
          throw new Error('history_file must contain a Claude sessionId')
        const sessionFile = resolveDataPlanePaths({
          dataPlane: 'native',
          root: options.configRoot,
          cwd: options.cwd,
          sessionId: historySessionId,
        }).sessionFile
        await mkdir(dirname(sessionFile), { recursive: true })
        await copyFile(options.historyFile, sessionFile)
      }
      const service = await createDefaultService({
        eventSink: (event) => {
          if (event.type === 'state' && event.state === 'awaiting-model')
            turns += 1
          options.eventSink(event)
        },
        requireProvider: true,
        cwd: options.cwd,
        configRoot: options.configRoot,
        environment: {
          ...options.env,
          HOME: options.home,
          USERPROFILE: options.home,
        },
        providerEnvironment: process.env,
        isSessionActionApproved: (call) =>
          options.allowedTools.includes(call.name),
        controls: {
          ...DEFAULT_CLI_CONTROLS,
          dataPlane: options.dataPlane,
          sessionPersistence: false,
          maxTurns: options.maxTurns,
          pluginDirectories: [...(options.pluginDirectories ?? [])],
          addDirectories: [...options.addDirs],
          allowedTools: [...options.allowedTools],
          disallowedTools: [],
          tools: [...options.allowedTools],
          permissionMode: 'dontAsk',
          ...(options.model ? { model: options.model } : {}),
          ...(options.appendSystemPrompt
            ? { appendSystemPrompt: options.appendSystemPrompt }
            : {}),
        },
      })
      return {
        run: async (prompt, signal) => {
          const result = historySessionId
            ? await service.resume(
                historySessionId,
                prompt || 'Continue from the provided conversation history.',
                signal,
              )
            : await service.run(prompt, signal)
          return {
            text: result.text,
            turns,
            ...(result.costUsd === undefined
              ? {}
              : { costUsd: result.costUsd }),
            usage: result.usage,
          }
        },
        close: () => service.close?.() ?? Promise.resolve(),
      }
    },
  }

const defaultPluginEvalJudge: NonNullable<PluginEvalDependencies['judge']> = {
  vote: async ({ criteria, focus, baseline, model, signal }) => {
    const environment = process.env
    const configRoot = resolveDataPlaneRoot({ environment })
    const assessment = await assessCurrentWorkspaceProviderSelection({
      configRoot,
      statePath: join(configRoot, 'state.json'),
      cwd: process.cwd(),
      environment,
    })
    const registry = await resolveProviderRegistry({
      configRoot,
      cwd: process.cwd(),
      environment,
      ...(model === undefined ? {} : { model }),
      includeProjectSettings: assessment?.status === 'trusted',
      context: parseContextEnvironment(environment),
      vault: new ProviderCredentialVault({
        configRoot,
        environment,
      }),
    })
    if (registry.target.billingMode === 'subscription') {
      throw new Error(
        'Plugin eval LLM judges require API-billed cost; subscription cost is unavailable',
      )
    }
    const provider = registry.create(model ?? registry.target.modelId)
    const prompt = `You are an eval judge. Return only JSON matching {"passed":boolean,"explanation":string}.

Criteria:
${criteria}

Candidate:
${focus}${baseline === undefined ? '' : `\n\nBaseline:\n${baseline}`}`
    let text = ''
    let usage: ModelUsage | undefined
    for await (const event of provider.complete({
      messages: [{ role: 'user', content: prompt }],
      ...(signal ? { signal } : {}),
    })) {
      if (event.type === 'text-delta') text += event.delta
      else if (event.type === 'usage') usage = event.usage
    }
    const object = /\{[\s\S]*\}/u.exec(text)?.[0]
    if (!object) throw new Error('Eval judge returned no JSON object')
    let parsed: unknown
    try {
      parsed = JSON.parse(object)
    } catch (error) {
      throw new Error('Eval judge returned invalid JSON', { cause: error })
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('Eval judge returned an invalid result')
    const result = parsed as Record<string, unknown>
    if (
      typeof result.passed !== 'boolean' ||
      (result.explanation !== undefined &&
        typeof result.explanation !== 'string')
    )
      throw new Error('Eval judge result must contain passed and explanation')
    if (!usage) throw new Error('Eval judge provider returned no usage')
    const pricing = ModelPricingRegistry.fromEnvironment(
      environment.PRAXIS_PRICING_JSON,
    ).resolve(model)
    if (!pricing)
      throw new Error(`No pricing configured for eval judge model ${model}`)
    return {
      passed: result.passed,
      ...(typeof result.explanation === 'string'
        ? { explanation: result.explanation }
        : {}),
      costUsd: usageCostUsd(usage, pricing),
    }
  },
}

async function resolveDetachedWorkerProviderEnvironment(request: {
  cwd: string
  argv: readonly string[]
}): Promise<ProviderEnvironmentOverride> {
  const environment = process.env
  const invocation = parseCliInvocation(request.argv)
  const configRoot = resolveDataPlaneRoot({ environment })
  const statePath = join(configRoot, 'state.json')
  const safe =
    invocation.safeMode ||
    invocation.bare ||
    truthyEnvironmentValue(environment.CLAUDE_CODE_SIMPLE)
  let includeProjectSettings = false
  if (!safe) {
    const assessment = await assessCurrentWorkspaceProviderSelection({
      configRoot,
      statePath,
      cwd: request.cwd,
      environment,
      pluginDirectories: invocation.pluginDirectories,
      pluginUrls: invocation.pluginUrls,
      strictMcpConfig: invocation.strictMcpConfig,
    })
    if (assessment?.status === 'trusted') includeProjectSettings = true
    else if (assessment?.status === 'untrusted' && invocation.trustProject) {
      await persistWorkspaceTrust(assessment, statePath)
      includeProjectSettings = true
    }
  }
  const target = await resolveProviderTarget({
    configRoot,
    cwd: request.cwd,
    environment,
    ...(invocation.model === undefined ? {} : { model: invocation.model }),
    ...(invocation.provider === undefined
      ? {}
      : { provider: invocation.provider }),
    ...(invocation.providerProfile === undefined
      ? {}
      : { profile: invocation.providerProfile }),
    includeSettings: !safe,
    includeProjectSettings,
  })
  const credential = await resolveProviderCredential({
    target,
    environment,
    vault: new ProviderCredentialVault({ configRoot, environment }),
  })
  return credential.type === 'api-key'
    ? { PRAXIS_API_KEY: credential.secret }
    : {}
}

export async function resolveInteractiveProviderStartup(options: {
  controls: CliControls
  configRoot: string
  statePath: string
  cwd: string
  environment?: NodeJS.ProcessEnv
  approveWorkspaceTrust?: (
    assessment: WorkspaceTrustAssessment,
  ) => boolean | Promise<boolean>
}): Promise<{
  effectiveModel: string | undefined
  trustProjectRequestAvailable: boolean
  contextWindowTokensForModel: (modelId?: string) => number | undefined
}> {
  const environment = options.environment ?? process.env
  const disabled =
    options.controls.safeMode ||
    options.controls.bare ||
    truthyEnvironmentValue(environment.CLAUDE_CODE_SIMPLE)
  if (disabled) {
    let effectiveModel: string | undefined
    let protocol:
      | Parameters<typeof resolveProviderContextWindowTokens>[0]['protocol']
      | undefined
    try {
      const target = await resolveProviderTarget({
        configRoot: options.configRoot,
        cwd: options.cwd,
        environment,
        ...(options.controls.model === undefined
          ? {}
          : { model: options.controls.model }),
        ...(options.controls.provider === undefined
          ? {}
          : { provider: options.controls.provider }),
        ...(options.controls.providerProfile === undefined
          ? {}
          : { profile: options.controls.providerProfile }),
        includeSettings: false,
      })
      effectiveModel = target.modelId
      protocol = target.protocol
    } catch (error) {
      if (!(
        error instanceof ProviderSettingsError &&
        error.code === 'model_required'
      ))
        throw error
    }
    const context = parseContextEnvironment(environment)
    return {
      effectiveModel,
      trustProjectRequestAvailable: options.controls.trustProject,
      contextWindowTokensForModel: (modelId) =>
        protocol === undefined
          ? undefined
          : resolveProviderContextWindowTokens({
              protocol,
              modelId: modelId ?? effectiveModel ?? '',
              ...(context.contextWindowTokens === undefined
                ? {}
                : { explicitContextWindowTokens: context.contextWindowTokens }),
            }),
    }
  }
  const assessment = await assessCurrentWorkspaceProviderSelection({
    configRoot: options.configRoot,
    statePath: options.statePath,
    cwd: options.cwd,
    environment,
    pluginDirectories: options.controls.pluginDirectories,
    pluginUrls: options.controls.pluginUrls,
    strictMcpConfig: options.controls.strictMcpConfig,
  })
  let includeProjectSettings = false
  let trustProjectRequestAvailable = options.controls.trustProject
  if (assessment) {
    trustProjectRequestAvailable = false
    if (assessment.status === 'trusted') includeProjectSettings = true
    else if (
      options.controls.trustProject ||
      (await options.approveWorkspaceTrust?.(assessment))
    ) {
      await persistWorkspaceTrust(assessment, options.statePath)
      includeProjectSettings = true
    }
  }
  let effectiveModel: string | undefined
  let protocol:
    | Parameters<typeof resolveProviderContextWindowTokens>[0]['protocol']
    | undefined
  try {
    const target = await resolveProviderTarget({
      configRoot: options.configRoot,
      cwd: options.cwd,
      environment,
      ...(options.controls.model === undefined
        ? {}
        : { model: options.controls.model }),
      ...(options.controls.provider === undefined
        ? {}
        : { provider: options.controls.provider }),
      ...(options.controls.providerProfile === undefined
        ? {}
        : { profile: options.controls.providerProfile }),
      includeSettings: true,
      includeProjectSettings,
    })
    effectiveModel = target.modelId
    protocol = target.protocol
  } catch (error) {
    if (!(
      error instanceof ProviderSettingsError && error.code === 'model_required'
    ))
      throw error
  }
  const context = parseContextEnvironment(environment)
  return {
    effectiveModel,
    trustProjectRequestAvailable,
    contextWindowTokensForModel: (modelId) =>
      protocol === undefined
        ? undefined
        : resolveProviderContextWindowTokens({
            protocol,
            modelId: modelId ?? effectiveModel ?? '',
            ...(context.contextWindowTokens === undefined
              ? {}
              : { explicitContextWindowTokens: context.contextWindowTokens }),
          }),
  }
}

export function createDefaultDependencies(
  entrypoint: string = fileURLToPath(import.meta.url),
): CliDependencies {
  const dependencies: CliDependencies = {
    createService: createDefaultService,
    createAutoModeCritic: createDefaultAutoModeCritic,
    pluginEval: {
      runtimeFactory: defaultPluginEvalRuntimeFactory,
      judge: defaultPluginEvalJudge,
    },
    projectEval: {
      runtimeFactory: defaultPluginEvalRuntimeFactory,
      version: VERSION,
      configRoot: resolveDataPlaneRoot(),
    },
    cliPath: entrypoint,
    runInteractive: async ({
      agent,
      controls,
      initialPrompt,
      resume,
      signal,
    }) => {
      const { runInteractive } = await import('./cli/interactive.js')
      const interactiveControls = controls ?? DEFAULT_CLI_CONTROLS
      let workspaceTrustPreflightOpen = true
      const cachedWorkspaceTrustDecision = createWorkspaceTrustDecisionCache(
        (request) =>
          promptWorkspaceTrust(request, {
            output: (text) => process.stderr.write(text),
            ...(signal ? { signal } : {}),
          }),
      )
      const approveInteractiveWorkspaceTrust = (
        request: WorkspaceTrustInventory,
      ): Promise<boolean> =>
        workspaceTrustPreflightOpen
          ? cachedWorkspaceTrustDecision(request)
          : Promise.resolve(false)
      const initialAdditionalDirectories =
        interactiveControls.addDirectories.map((directory) =>
          realpathSync(resolve(process.cwd(), directory)),
        )
      const interactiveDataPlane =
        interactiveControls.dataPlane ?? resolveDataPlane()
      const {
        configRoot: interactiveConfigRoot,
        statePath: interactiveStatePath,
      } = resolveInteractiveRuntimeSettingsLocation(interactiveDataPlane)
      const startup = await resolveInteractiveProviderStartup({
        controls: interactiveControls,
        configRoot: interactiveConfigRoot,
        statePath: interactiveStatePath,
        cwd: process.cwd(),
        approveWorkspaceTrust: cachedWorkspaceTrustDecision,
      })
      const effectiveModel = startup.effectiveModel
      const trustProjectRequestAvailable = startup.trustProjectRequestAvailable
      const resumePath =
        typeof resume?.sessionSelector === 'string' &&
        isResumePathSelector(resume.sessionSelector)
          ? resume.sessionSelector
          : undefined
      let continueSessionFilter:
        ((session: SessionSummary) => boolean) | undefined
      if (
        interactiveControls.continueSession &&
        resume?.fromPr === undefined &&
        resume?.sessionSelector === undefined
      ) {
        continueSessionFilter = await createContinueSessionFilter(
          liveTopLevelSessions(dependencies, interactiveDataPlane),
        )
      }
      const createInteractiveService = async (
        options: Parameters<InteractiveServiceFactory['createService']>[0],
      ) => {
        const commands = await createDefaultService({
          ...options,
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
          sandboxOriginalCwd: process.cwd(),
          ...(agent === undefined ? {} : { agent }),
          controls: {
            ...interactiveControls,
            trustProject:
              workspaceTrustPreflightOpen && trustProjectRequestAvailable,
            addDirectories:
              options.additionalDirectories ??
              interactiveControls.addDirectories,
          },
          interactive: true,
          approveWorkspaceTrust: approveInteractiveWorkspaceTrust,
        })
        workspaceTrustPreflightOpen = false
        if (resumePath !== undefined) {
          await commands.registerResumePath?.(resumePath)
        }
        return commands
      }
      return runInteractive({
        dataPlane: interactiveDataPlane,
        configRoot: interactiveConfigRoot,
        statePath: interactiveStatePath,
        factory: {
          createService: createInteractiveService,
          contextWindowTokens: startup.contextWindowTokensForModel,
          scheduledPrompts: Boolean(effectiveModel),
        },
        ...(signal ? { signal } : {}),
        ...(initialPrompt === undefined ? {} : { initialPrompt }),
        ...(controls?.axScreenReader ? { axScreenReader: true } : {}),
        ...(controls?.allowDangerouslySkipPermissions
          ? { allowDangerouslySkipPermissions: true }
          : {}),
        additionalDirectories: initialAdditionalDirectories,
        ...(interactiveControls.settingSources === undefined
          ? {}
          : { settingSources: interactiveControls.settingSources }),
        display: {
          version: VERSION,
          cwd: process.cwd(),
          ...(effectiveModel === undefined ? {} : { model: effectiveModel }),
          effort: controls?.effort ?? 'high',
          permissionMode: controls?.dangerouslySkipPermissions
            ? 'bypassPermissions'
            : (controls?.permissionMode ?? 'default'),
        },
        onBackground: (request: InteractiveBackgroundRequest) =>
          requireTopLevelAgentManager(
            dependencies,
            interactiveDataPlane,
          ).launch({
            prompt: request.prompt,
            initialDetail: request.detail,
            sourceSessionId: request.sourceSessionId,
            sourceCheckpoint: request.sourceCheckpoint,
            cwd: request.cwd,
            deferInitialTurn: true,
            argv: agentDashboardWorkerArgv({
              ...interactiveControls,
              agent,
            }),
          }),
        onBackgrounded: (result) => {
          process.stdout.write(backgroundLaunchMessage(result.id))
        },
        ...(resume === undefined ? {} : { resume }),
        ...(resume?.fromPr !== undefined
          ? {
              sessionFilter: createClaudePrSessionFilter<SessionSummary>(
                resume.fromPr,
              ),
              requireSession: true,
            }
          : resume?.sessionSelector !== undefined
            ? {
                sessionFilter: createResumeSessionFilter(
                  resumePathSessionId(resume.sessionSelector) ??
                    resume.sessionSelector,
                ),
                requireSession: true,
                missingSessionMessage: isClaudeSessionId(resume.sessionSelector)
                  ? `No conversation found with session ID: ${resume.sessionSelector}`
                  : `No conversation found matching: ${resume.sessionSelector}`,
              }
            : continueSessionFilter === undefined
              ? {}
              : {
                  sessionFilter: continueSessionFilter,
                  requireSession: true,
                  missingSessionMessage: 'No conversation found to continue',
                }),
        ...(resume?.requireSession ? { requireSession: true } : {}),
      })
    },
    runAgentsDashboard: async ({ manager, defaults, signal }) => {
      const { runAgentsDashboard } = await import('./cli/agents-dashboard.js')
      return runAgentsDashboard({
        manager,
        defaults,
        ...(signal ? { signal } : {}),
      })
    },
    createTopLevelAgents: (dataPlane) =>
      new TopLevelAgentManager({
        configRoot: resolveDataPlaneRoot(),
        dataPlane,
        cwd: process.cwd(),
        cliPath: entrypoint,
        resolveProviderEnvironment: resolveDetachedWorkerProviderEnvironment,
        version: VERSION,
      }),
    launchTmux: launchTmuxWorktree,
    selfUpdate: runSelfUpdate,
  }
  return dependencies
}

export async function createBackgroundWorkerRuntime(
  workerSink: RuntimeEventSink,
  dispatch: { argv: string[] },
  createService: CliDependencies['createService'] = createDefaultService,
): Promise<Awaited<ReturnType<CliDependencies['createService']>>> {
  const invocation = parseCliInvocation(dispatch.argv)
  return createService({
    eventSink: workerSink,
    requireProvider: true,
    ...(invocation.retryInterruptedTools
      ? { approveRecovery: () => true }
      : {}),
    ...(invocation.agent ? { agent: invocation.agent } : {}),
    controls: invocation,
    sessionKind: 'bg',
  })
}

async function runBackgroundWorker(id: string): Promise<void> {
  const dataPlane = resolveDataPlane()
  const configRoot = resolveDataPlaneRoot()
  await runTopLevelAgentWorker({
    configRoot,
    dataPlane,
    id,
    createRuntime: (workerSink, dispatch) =>
      createBackgroundWorkerRuntime(workerSink, dispatch),
  })
}

function writeJson(io: CliIO, value: unknown): void {
  io.stdout(`${JSON.stringify(value)}\n`)
}

function formatSessionIssue(issue: SessionSummary['issue']): string {
  return issue
    ? `${issue.lineNumber === null ? '' : `line ${issue.lineNumber}, `}byte ${issue.byteOffset}: ${issue.message}`
    : ''
}

function selectPrLinkedSession(
  sessions: readonly SessionSummary[],
  selector: string | true,
): SessionSummary {
  const matches = filterClaudePrLinkedSessions(sessions, selector)
  const label = selector === true ? 'a pull request' : `PR ${selector}`
  if (matches.length === 0) {
    throw new Error(`No conversation linked to ${label} in this project`)
  }
  if (matches.length > 1) {
    throw new Error(
      `Multiple conversations are linked to ${label}; use --resume with one of: ${matches
        .map((session) => session.sessionId)
        .join(', ')}`,
    )
  }
  return matches[0] as SessionSummary
}

async function selectImplicitResumeSession(
  sessions: readonly SessionSummary[],
  fromPr: string | true | undefined,
  liveSessions?: () => Promise<readonly TopLevelAgentSummary[]>,
): Promise<SessionSummary> {
  if (fromPr !== undefined) return selectPrLinkedSession(sessions, fromPr)
  const filter = await createContinueSessionFilter(liveSessions)
  const eligible = filter === undefined ? sessions : sessions.filter(filter)
  const latest = eligible[0]
  if (!latest) throw new Error('No conversation found to continue')
  return latest
}

async function createContinueSessionFilter(
  liveSessions?: () => Promise<readonly TopLevelAgentSummary[]>,
): Promise<((session: SessionSummary) => boolean) | undefined> {
  if (liveSessions === undefined) return undefined
  try {
    const liveBackgroundIds = new Set(
      (await liveSessions())
        .filter((agent) =>
          ['background', 'bg', 'daemon', 'daemon-worker'].includes(agent.kind),
        )
        .filter(
          (agent) => agent.state === 'working' || agent.status !== undefined,
        )
        .map((agent) => agent.sessionId),
    )
    return (session) => !liveBackgroundIds.has(session.sessionId)
  } catch {
    // Deterministic local ordering remains the fallback when the optional
    // liveness registry is unavailable or unreadable.
    return undefined
  }
}

function liveTopLevelSessions(
  dependencies: CliDependencies,
  dataPlane: DataPlane,
): (() => Promise<readonly TopLevelAgentSummary[]>) | undefined {
  let manager: TopLevelAgentCommands | undefined
  try {
    manager = dependencies.createTopLevelAgents?.(dataPlane)
    manager ??= dependencies.topLevelAgents
  } catch {
    return undefined
  }
  return manager === undefined
    ? undefined
    : () => manager.list({ cwd: process.cwd(), all: false })
}

function missingResumeSelectorMessage(invocation: CliInvocation): string {
  if (invocation.print) {
    return '--resume requires a valid session ID or session title when used with --print. Usage: praxis -p --resume <session-id|title>'
  }
  if (invocation.background) {
    return '--resume requires a valid session ID or session title when used with --background'
  }
  return '--resume requires a valid session ID or session title outside an interactive terminal'
}

function selectResumeSession(
  sessions: readonly SessionSummary[],
  selector: string,
  invocation: CliInvocation,
): SessionSummary {
  const normalized = selector.toLowerCase()
  const idMatch = sessions.find(
    (session) => session.sessionId.toLowerCase() === normalized,
  )
  if (idMatch) return idMatch
  if (isClaudeSessionId(selector)) {
    throw new Error(`No conversation found with session ID: ${selector}`)
  }
  const titleMatches = sessions.filter(
    (session) => session.name?.toLowerCase() === normalized,
  )
  if (titleMatches.length === 1) return titleMatches[0] as SessionSummary
  if (titleMatches.length > 1) {
    throw new Error(
      `--resume "${selector}" matches ${titleMatches.length} sessions. Pass one of these session IDs to disambiguate:\n${titleMatches
        .map(
          (session) =>
            `  ${session.sessionId}  (modified ${session.updatedAt})`,
        )
        .join('\n')}`,
    )
  }
  throw new Error(
    `${missingResumeSelectorMessage(invocation)}. Provided value "${selector}" is not a UUID and does not match any session title.`,
  )
}

function isResumePathSelector(selector: string): boolean {
  return extname(selector).toLowerCase() === '.jsonl'
}

function resumePathSessionId(selector: string): string | undefined {
  if (!isResumePathSelector(selector)) return undefined
  const sessionId = basename(selector, extname(selector))
  return isClaudeSessionId(sessionId) ? sessionId : undefined
}

async function resolveExplicitResumeSession(
  service: SessionCommands,
  selector: string,
  invocation: CliInvocation,
): Promise<SessionSummary> {
  if (isResumePathSelector(selector)) {
    if (!service.registerResumePath) {
      throw new Error('Explicit Claude transcript path resume is unavailable')
    }
    return service.registerResumePath(selector)
  }
  return selectResumeSession(await service.sessions(), selector, invocation)
}

function createResumeSessionFilter(
  selector: string,
): (session: SessionSummary) => boolean {
  const normalized = selector.toLowerCase()
  if (isClaudeSessionId(selector)) {
    return (session) => session.sessionId.toLowerCase() === normalized
  }
  return (session) =>
    [session.name, session.lastPrompt, session.sessionId].some((value) =>
      value?.toLowerCase().includes(normalized),
    )
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

function mcpEnvironment(values: readonly string[]): Record<string, string> {
  const environment: Record<string, string> = {}
  for (const value of values) {
    const [name, ...parts] = value.split('=')
    if (!name || parts.length === 0) {
      throw new Error(
        `Invalid environment variable format: ${value}, environment variables should be added as: -e KEY1=value1 -e KEY2=value2`,
      )
    }
    environment[name] = parts.join('=')
  }
  return environment
}

function mcpHeaders(
  values: readonly string[],
): Record<string, string> | undefined {
  if (values.length === 0) return undefined
  const headers: Record<string, string> = {}
  for (const value of values) {
    const separator = value.indexOf(':')
    if (separator < 0) {
      throw new Error(
        `Invalid header format: "${value}". Expected format: "Header-Name: value"`,
      )
    }
    const name = value.slice(0, separator).trim()
    if (!name) {
      throw new Error(
        `Invalid header: "${value}". Header name cannot be empty.`,
      )
    }
    headers[name] = value.slice(separator + 1).trim()
  }
  return headers
}

function mcpCallbackPort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const port = Number.parseInt(value, 10)
  if (!port) return undefined
  if (port < 0) throw new Error('Invalid configuration: : Invalid input')
  return port
}

function mcpOauthOptions(config: Record<string, unknown>): {
  clientId?: string
  callbackPort?: number
} {
  const oauth = config.oauth
  if (!oauth || typeof oauth !== 'object' || Array.isArray(oauth)) return {}
  const values = oauth as Record<string, unknown>
  return {
    ...(typeof values.clientId === 'string'
      ? { clientId: values.clientId }
      : {}),
    ...(typeof values.callbackPort === 'number'
      ? { callbackPort: values.callbackPort }
      : {}),
  }
}

function mcpConfigPath(record: McpServerRecord): string {
  return record.scope === 'local'
    ? `${record.path} [project: ${process.cwd()}]`
    : record.path
}

function redactMcpHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      /authorization|api[-_]?key|token|secret|cookie/iu.test(name)
        ? '[REDACTED]'
        : value,
    ]),
  )
}

function isLikelyMcpUrl(value: string): boolean {
  return (
    value.startsWith('http://') ||
    value.startsWith('https://') ||
    value.startsWith('localhost') ||
    value.endsWith('/sse') ||
    value.endsWith('/mcp')
  )
}

function mcpAddedOutput(
  io: CliIO,
  invocation: CliInvocation,
  record: McpServerRecord,
  transport: 'stdio' | 'http' | 'sse',
  commandOrUrl: string,
  args: readonly string[],
  headers: Record<string, string> | undefined,
): void {
  if (invocation.legacyJson || invocation.outputFormat !== 'text') {
    mcpOutput(io, invocation, {
      type: 'mcp-added',
      server: mcpRecordJson(record),
    })
    return
  }
  if (transport === 'stdio') {
    io.stdout(
      `Added stdio MCP server ${record.name} with command: ${commandOrUrl} ${args.join(' ')} to ${record.scope} config\n`,
    )
  } else {
    io.stdout(
      `Added ${transport.toUpperCase()} MCP server ${record.name} with URL: ${commandOrUrl} to ${record.scope} config\n`,
    )
    if (headers) {
      io.stdout(
        `Headers: ${JSON.stringify(redactMcpHeaders(headers), null, 2)}\n`,
      )
    }
  }
  io.stdout(`File modified: ${mcpConfigPath(record)}\n`)
}

async function existingMcpServer(
  management: ClaudeMcpManagement,
  name: string,
  scope: McpServerRecord['scope'],
): Promise<McpServerRecord | undefined> {
  try {
    return await management.get(name, scope)
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === `MCP server not found: ${name}`
    ) {
      return undefined
    }
    throw error
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

function filterAutoModeRules(
  config: ReturnType<typeof autoModeJson>,
  label: string | undefined,
): ReturnType<typeof autoModeJson> {
  if (label === undefined) return config
  const prefix = label.toLowerCase()
  const filter = (rules: readonly string[]) =>
    rules.filter((rule) => rule.toLowerCase().startsWith(prefix))
  return {
    ...config,
    allow: filter(config.allow),
    soft_deny: filter(config.soft_deny),
    hard_deny: filter(config.hard_deny),
    environment: filter(config.environment),
  }
}

function hasCustomAutoModeRules(
  settings: readonly { value: unknown }[],
): boolean {
  return settings.some((setting) => {
    if (
      !setting.value ||
      typeof setting.value !== 'object' ||
      Array.isArray(setting.value)
    ) {
      return false
    }
    const autoMode = (setting.value as Record<string, unknown>).autoMode
    if (!autoMode || typeof autoMode !== 'object' || Array.isArray(autoMode)) {
      return false
    }
    const rules = autoMode as Record<string, unknown>
    return ['allow', 'soft_deny', 'hard_deny', 'environment'].some(
      (key) => Array.isArray(rules[key]) && rules[key].length > 0,
    )
  })
}

async function readUserSettings(
  path: string,
): Promise<Record<string, unknown>> {
  let source: string
  try {
    source = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch (error) {
    throw new Error(`Invalid settings JSON: ${path}`, { cause: error })
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Settings JSON must be an object: ${path}`)
  }
  return value as Record<string, unknown>
}

async function confirmAutoModeReset(
  io: CliIO,
  settingsPath: string,
  skipConfirmation: boolean,
): Promise<boolean> {
  if (skipConfirmation) return true
  const input = io.readStdinLines?.()
  if (!input) throw new Error('auto-mode reset requires --yes without stdin')
  io.stderr(`Remove autoMode section from ${settingsPath}? [y/N] `)
  const next = await input[Symbol.asyncIterator]().next()
  const answer =
    typeof next.value === 'string'
      ? next.value
      : next.value instanceof Uint8Array
        ? Buffer.from(next.value).toString('utf8')
        : ''
  return ['y', 'yes'].includes(answer.trim().toLowerCase())
}

const AUTO_MODE_CRITIQUE_SYSTEM = `Praxis auto-mode critique. Review custom auto mode rules for ambiguity, coverage gaps, conflicts, risk, and actionable wording. Return concise Markdown only; do not claim to have changed settings.`

const NO_CUSTOM_AUTO_MODE_RULES = `No custom auto mode rules found.

Add rules to your settings file under autoMode.{allow, soft_deny, hard_deny,
environment}.
Run \`praxis auto-mode defaults\` to see the default rules for reference.
`

async function executeAutoModeCommand(
  args: readonly string[],
  invocation: CliInvocation,
  io: CliIO,
  dependencies: CliDependencies,
  signal?: AbortSignal,
): Promise<number> {
  const dataPlane = invocation.dataPlane ?? resolveDataPlane()
  const { configRoot, statePath } =
    resolveInteractiveRuntimeSettingsLocation(dataPlane)
  const loadSettings = async () =>
    loadNativeSettings({ root: configRoot, cwd: process.cwd() })
  const action = args[1]
  if (!action || action === 'help') {
    io.stdout(AUTO_MODE_HELP)
    return 0
  }
  if (invocation.autoModeLabel !== undefined && action !== 'defaults') {
    throw new Error('--label is only valid with auto-mode defaults')
  }
  if (args.length !== 2) {
    throw new Error(`auto-mode ${action} takes no operands`)
  }
  if (action === 'defaults') {
    const output = filterAutoModeRules(
      autoModeJson(defaultClaudeAutoModeConfig()),
      invocation.autoModeLabel,
    )
    if (invocation.legacyJson || invocation.outputFormat !== 'text')
      writeJson(io, output)
    else io.stdout(`${JSON.stringify(output)}\n`)
    return 0
  }
  if (action === 'critique') {
    const settings = await loadSettings()
    if (!hasCustomAutoModeRules(settings)) {
      io.stdout(NO_CUSTOM_AUTO_MODE_RULES)
      return 0
    }
    const config = autoModeJson(loadClaudeAutoModeConfig(settings))
    io.stdout('Analyzing your auto mode rules…\n\n')
    const provider = await (
      dependencies.createAutoModeCritic ?? createDefaultAutoModeCritic
    )({
      ...(invocation.model === undefined ? {} : { model: invocation.model }),
      ...(invocation.provider === undefined
        ? {}
        : { provider: invocation.provider }),
      ...(invocation.providerProfile === undefined
        ? {}
        : { providerProfile: invocation.providerProfile }),
      dataPlane,
      configRoot,
      statePath,
    })
    let critique = ''
    for await (const event of provider.complete({
      messages: [
        { role: 'system', content: AUTO_MODE_CRITIQUE_SYSTEM },
        {
          role: 'user',
          content: `Review this effective auto mode configuration:\n\n${JSON.stringify(config, null, 2)}`,
        },
      ],
      thinking: { mode: 'disabled' },
      ...(signal ? { signal } : {}),
    })) {
      if (event.type !== 'text-delta') continue
      critique += event.delta
      io.stdout(event.delta)
    }
    if (!critique.trim()) {
      io.stdout('No critique was generated. Please try again.\n')
    } else if (!critique.endsWith('\n')) {
      io.stdout('\n')
    }
    return 0
  }
  if (action === 'reset') {
    const settingsPath = join(configRoot, 'settings.json')
    const settings = await readUserSettings(settingsPath)
    if (!Object.hasOwn(settings, 'autoMode')) {
      io.stdout(
        `Auto mode configuration is already at defaults — ${settingsPath} has no autoMode section.\n`,
      )
      return 0
    }
    if (
      !(await confirmAutoModeReset(
        io,
        settingsPath,
        invocation.autoModeResetYes,
      ))
    ) {
      io.stderr('Auto mode reset cancelled.\n')
      return 1
    }
    const next = { ...settings }
    delete next.autoMode
    await writeFileAtomically(
      settingsPath,
      `${JSON.stringify(next, null, 2)}\n`,
    )
    io.stdout(
      `Auto mode configuration reset to defaults — autoMode section removed from ${settingsPath}.\nRun \`praxis auto-mode config\` to see the effective rules.\n`,
    )
    return 0
  }
  if (action === 'config') {
    const settings = await loadSettings()
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
  const dataPlane = invocation.dataPlane ?? resolveDataPlane()
  const { configRoot, statePath: claudeStatePath } =
    resolveInteractiveRuntimeSettingsLocation(dataPlane)
  const runtimeSettings = await loadRuntimeSettings({
    configRoot,
    statePath: claudeStatePath,
  })
  const report = await runDoctor({
    version: VERSION,
    executablePath: fileURLToPath(import.meta.url),
    nodeExecutablePath: process.execPath,
    nodeVersion: process.version,
    configRoot,
    claudeStatePath,
    cwd: process.cwd(),
    environment: {
      ...process.env,
      PRAXIS_DATA_PLANE: dataPlane,
      ...(invocation.provider === undefined
        ? {}
        : { PRAXIS_PROVIDER: invocation.provider }),
      ...(invocation.providerProfile === undefined
        ? {}
        : { PRAXIS_PROVIDER_PROFILE: invocation.providerProfile }),
      ...(invocation.model === undefined
        ? {}
        : { PRAXIS_MODEL: invocation.model }),
    },
    autoUpdateChannel: runtimeSettings.autoUpdatesChannel,
    ...(process.argv[1] === undefined
      ? {}
      : { invokedBinaryPath: process.argv[1] }),
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
  signal?: AbortSignal,
): Promise<number> {
  const command = argv[0]
  const values: string[] = []
  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === undefined) continue
    values.push(value)
  }
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
    const dataPlane = resolveDataPlane()
    const { configRoot, statePath } =
      resolveInteractiveRuntimeSettingsLocation(dataPlane)
    const runtimeSettings = await loadRuntimeSettings({ configRoot, statePath })
    const result = await dependencies.selfUpdate?.({
      operation: 'update',
      ...(signal ? { signal } : {}),
      ...(runtimeSettings.autoUpdatesChannel === 'latest'
        ? {}
        : { target: runtimeSettings.autoUpdatesChannel }),
    })
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
    ...(signal ? { signal } : {}),
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
  const dataPlane = resolveDataPlane()
  const { configRoot, statePath } =
    resolveInteractiveRuntimeSettingsLocation(dataPlane)
  const plan = await planClaudeProjectPurge({
    dataPlane,
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

function pluginPruneSummary(plan: ClaudePluginPrunePlan): string {
  const count = plan.candidates.length
  return `${count} auto-installed plugin${count === 1 ? '' : 's'} no longer needed at ${plan.scope} scope:\n${plan.candidates.map((plugin) => `  ${plugin.id} (${plugin.version})`).join('\n')}\n`
}

async function pluginConfirmation(io: CliIO): Promise<boolean> {
  const input = io.readStdinLines?.()
  if (!input) return false
  const next = await input[Symbol.asyncIterator]().next()
  const value =
    typeof next.value === 'string'
      ? next.value
      : next.value instanceof Uint8Array
        ? Buffer.from(next.value).toString('utf8')
        : ''
  return ['y', 'yes'].includes(value.trim().toLowerCase())
}

async function executePluginPruneFlow(
  configRoot: string,
  cwd: string,
  scope: ClaudePluginScope,
  invocation: CliInvocation,
  io: CliIO,
  uninstalledName?: string,
): Promise<number> {
  const structured = invocation.legacyJson || invocation.outputFormat !== 'text'
  const structuredOutput = (
    status: string,
    value: Record<string, unknown> = {},
  ): void => {
    pluginOutput(io, invocation, {
      type:
        uninstalledName === undefined
          ? 'plugin-pruned'
          : 'plugin-uninstalled-and-pruned',
      ...(uninstalledName === undefined ? {} : { name: uninstalledName }),
      scope,
      status,
      ...value,
    })
  }
  const plan = await planClaudePluginPrune(configRoot, cwd, scope)
  if (plan.failedPluginIds) {
    const message = `Skipped — cannot determine orphans: ${plan.failedPluginIds.join(', ')} failed to load. Fix or uninstall, then retry.`
    if (structured) {
      structuredOutput('skipped', {
        message,
        failedPluginIds: plan.failedPluginIds,
      })
    } else io.stdout(`${message}\n`)
    return 0
  }
  if (plan.candidates.length === 0) {
    const message =
      plan.autoCount === 0
        ? `Nothing to prune (no auto-installed plugins at ${scope} scope).`
        : `Nothing to prune (${plan.autoCount} auto-installed plugin${plan.autoCount === 1 ? '' : 's'} at ${scope} scope, all still needed).`
    if (structured) {
      structuredOutput('complete', {
        dryRun: invocation.pluginDryRun,
        removed: [],
      })
    } else io.stdout(`${message}\n`)
    return 0
  }
  if (structured) {
    if (invocation.pluginDryRun) {
      structuredOutput('complete', {
        dryRun: true,
        removed: [],
        candidates: plan.candidates,
      })
      return 0
    }
  } else {
    io.stdout(pluginPruneSummary(plan))
    if (invocation.pluginDryRun) {
      io.stdout('(dry run — nothing removed)\n')
      return 0
    }
  }
  if (!invocation.pluginYes && io.isTTY !== true) {
    if (structured) {
      structuredOutput('confirmation-required', {
        dryRun: false,
        removed: [],
        candidates: plan.candidates,
      })
    } else {
      io.stdout('Not a TTY — run `praxis plugin prune -y` to remove.\n')
    }
    return 0
  }
  if (!invocation.pluginYes) {
    if (structured) io.stderr('Remove? [y/N] ')
    else io.stdout('Remove? [y/N] ')
    if (!(await pluginConfirmation(io))) {
      if (structured) {
        structuredOutput('cancelled', {
          dryRun: false,
          removed: [],
          candidates: plan.candidates,
        })
      } else io.stdout('Cancelled.\n')
      return 0
    }
  }
  const removed = await executeClaudePluginPrune(configRoot, cwd, plan)
  if (structured) {
    structuredOutput('complete', {
      dryRun: false,
      removed,
    })
  } else {
    io.stdout(
      `Removed ${removed.length} auto-installed plugin${removed.length === 1 ? '' : 's'}: ${removed.map((plugin) => plugin.id.split('@')[0]).join(', ')}\n`,
    )
  }
  return 0
}

async function executePluginTag(
  path: string,
  invocation: CliInvocation,
  io: CliIO,
): Promise<number> {
  try {
    const result = await tagClaudePlugin({
      path,
      ...(invocation.pluginDryRun ? { dryRun: true } : {}),
      ...(invocation.pluginForce ? { force: true } : {}),
      ...(invocation.pluginMessage === undefined
        ? {}
        : { message: invocation.pluginMessage }),
      ...(invocation.pluginPush ? { push: true } : {}),
      ...(invocation.pluginRemote === undefined
        ? {}
        : { remote: invocation.pluginRemote }),
    })
    if (invocation.legacyJson || invocation.outputFormat !== 'text') {
      pluginOutput(io, invocation, { type: 'plugin-tagged', ...result })
      return 0
    }
    for (const warning of result.warnings) io.stdout(`⚠ ${warning}\n`)
    io.stdout(
      `Plugin:  ${result.name}\nVersion: ${result.version} (from plugin.json)\n${result.marketplaceEntry === undefined ? '' : `Marketplace entry: plugins[${result.marketplaceEntry.index}] in ${result.marketplaceEntry.path}${result.marketplaceEntry.version === undefined ? '' : ` (version: ${result.marketplaceEntry.version})`}\n`}Tag:     ${result.tag}\n\n`,
    )
    const forceFlag = result.force ? ' --force' : ''
    if (result.dryRun) {
      io.stdout(
        `✔ Dry run — would create tag ${result.tag} at HEAD in ${result.repository}\n  git -C ${result.repository} tag${forceFlag} -a ${result.tag} -m ${JSON.stringify(result.message)}\n  git -C ${result.repository} push${forceFlag} ${result.remote} refs/tags/${result.tag}\n`,
      )
    } else {
      io.stdout(`✔ Created tag ${result.tag}\n`)
      io.stdout(
        result.pushed
          ? `✔ Pushed to ${result.remote}\n`
          : `  Push with: git -C ${result.repository} push${forceFlag} ${result.remote} refs/tags/${result.tag}\n`,
      )
    }
    return 0
  } catch (error) {
    io.stdout(`✘ ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
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

function formatPluginDetails(
  details: Awaited<ReturnType<typeof describeClaudePlugin>>,
): string {
  const { plugin, components, tokenEstimate } = details
  const lines = [
    `${plugin.name}${plugin.version ? ` ${plugin.version}` : ''}`,
    ...(plugin.description ? [`  ${plugin.description}`] : []),
    `  Source: ${plugin.source}`,
    '',
    'Component inventory',
  ]
  const groups: Array<[string, readonly string[], string]> = [
    ['Skills', [...components.skills, ...components.commands].sort(), ''],
    ['Agents', components.agents, ''],
    ['Hooks', components.hooks, '  (harness-only — no model context cost)'],
    [
      'MCP servers',
      components.mcpServers,
      '  (tool schemas resolved at runtime; not counted)',
    ],
    [
      'LSP servers',
      components.lspServers,
      '  (out-of-process tooling; no model context cost)',
    ],
  ]
  for (const [label, values, annotation] of groups) {
    lines.push(
      `  ${label} (${values.length})${
        values.length === 0 ? '' : `  ${values.join(', ')}`
      }${values.length > 0 ? annotation : ''}`,
    )
  }
  lines.push(
    '',
    'Projected token cost',
    `  Always-on:   ~${tokenEstimate.alwaysOn.toLocaleString()} tok   added to every session`,
  )
  const textComponents = details.componentCosts
  if (textComponents.length === 0) return lines.join('\n')
  lines.push('', 'Per-component (rounded)', '  component  always-on  on-invoke')
  const width = Math.max(
    9,
    ...textComponents.map((component) => component.name.length),
  )
  for (const component of textComponents) {
    lines.push(
      `  ${component.name.padEnd(width)}  ${formatPluginTokenEstimate(
        component.alwaysOn,
      ).padStart(
        9,
      )}  ${formatPluginTokenEstimate(component.onInvoke).padStart(9)}`,
    )
  }
  lines.push(
    '',
    '  On-invoke cost is paid each time a skill or agent fires.',
    '  Token counts are estimates and may differ from actual usage.',
  )
  return lines.join('\n')
}

function formatPluginTokenEstimate(value: number): string {
  if (value < 20) return '< 20'
  return `~${Math.round(value / 10) * 10}`
}

async function pluginDetailsForName(
  configRoot: string,
  cwd: string,
  name: string,
  dataPlane?: DataPlane,
): Promise<Awaited<ReturnType<typeof describeClaudePlugin>>> {
  const [native, local] = await Promise.all([
    listNativePluginRecords(configRoot, cwd, dataPlane),
    readPluginRegistry(configRoot),
  ])
  const entries = [...native, ...local]
  const entry =
    entries.find((candidate) => candidate.name === name) ??
    entries.find((candidate) => candidate.name.startsWith(`${name}@`))
  if (!entry) {
    throw new Error(
      `Plugin "${name}" not found. Run \`praxis plugin list\` to see installed plugins.`,
    )
  }
  return describeClaudePlugin(entry.path, entry.source)
}

async function executePluginCommand(
  args: readonly string[],
  invocation: CliInvocation,
  io: CliIO,
): Promise<number> {
  const requestedAction = args[1]
  const action =
    requestedAction === 'i'
      ? 'install'
      : requestedAction === 'new'
        ? 'init'
        : requestedAction === 'remove'
          ? 'uninstall'
          : requestedAction
  const cwd = process.cwd()
  const dataPlane = invocation.dataPlane ?? resolveDataPlane()
  const configRoot = resolveDataPlaneRoot()
  const requestedScope = invocation.mcpScope as ClaudePluginScope | undefined
  const installScope = requestedScope ?? 'user'
  if (!action || action === 'help') {
    io.stdout(PLUGIN_HELP)
    return 0
  }
  if (invocation.pluginAvailable && action !== 'list') {
    throw new Error('--available is only valid with plugin list')
  }
  if (invocation.pluginAll || invocation.agentsAll) {
    if (action !== 'disable') {
      throw new Error('--all is only valid with plugin disable')
    }
  }
  if (
    (invocation.pluginKeepData || invocation.pluginPrune) &&
    action !== 'uninstall'
  ) {
    throw new Error(
      '--keep-data and --prune are only valid with plugin uninstall',
    )
  }
  if (
    invocation.pluginYes &&
    !['install', 'update', 'uninstall', 'prune', 'autoremove'].includes(action)
  ) {
    throw new Error('--yes is only valid with plugin uninstall or prune')
  }
  if (invocation.pluginStrict && action !== 'validate') {
    throw new Error('--strict is only valid with plugin validate')
  }
  if (invocation.pluginConfig.length > 0 && action !== 'install') {
    throw new Error('--config is only valid with plugin install')
  }
  if (
    (invocation.pluginAuthor !== undefined ||
      invocation.pluginAuthorEmail !== undefined ||
      invocation.pluginDescription !== undefined ||
      invocation.pluginWith.length > 0) &&
    action !== 'init'
  ) {
    throw new Error(
      '--author, --author-email, --description, and --with are only valid with plugin init',
    )
  }
  if (invocation.pluginForce && !['init', 'tag'].includes(action)) {
    throw new Error('--force is only valid with plugin init or tag')
  }
  if (
    invocation.pluginDryRun &&
    !['prune', 'autoremove', 'tag'].includes(action)
  ) {
    throw new Error('--dry-run is only valid with plugin prune or tag')
  }
  if (
    (invocation.pluginMessage !== undefined ||
      invocation.pluginPush ||
      invocation.pluginRemote !== undefined) &&
    action !== 'tag'
  ) {
    throw new Error(
      '--message, --push, and --remote are only valid with plugin tag',
    )
  }
  if (
    requestedScope !== undefined &&
    ![
      'install',
      'uninstall',
      'enable',
      'disable',
      'update',
      'marketplace',
      'prune',
      'autoremove',
    ].includes(action)
  ) {
    throw new Error(`--scope is not valid with plugin ${action}`)
  }
  if (action === 'marketplace') {
    const requestedMarketplaceAction = args[2]
    const marketplaceAction =
      requestedMarketplaceAction === 'rm'
        ? 'remove'
        : requestedMarketplaceAction
    if (!marketplaceAction || marketplaceAction === 'help') {
      io.stdout(PLUGIN_MARKETPLACE_HELP)
      return 0
    }
    if (marketplaceAction === 'list') {
      if (args.length !== 3)
        throw new Error('plugin marketplace list takes no operands')
      if (requestedScope !== undefined) {
        throw new Error('--scope is not valid with plugin marketplace list')
      }
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
          invocation.pluginSparsePaths,
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
      if (requestedScope !== undefined) {
        throw new Error('--scope is not valid with plugin marketplace update')
      }
      pluginOutput(io, invocation, {
        type: 'plugin-marketplace-updated',
        marketplaces: await updateClaudeMarketplace(configRoot, args[3]),
      })
      return 0
    }
    throw new Error(`Unknown plugin marketplace command: ${marketplaceAction}`)
  }
  if (action === 'list') {
    if (args.length !== 2) throw new Error('plugin list takes no operands')
    const registry = await readPluginRegistry(configRoot)
    const native = await listNativePluginRecords(configRoot, cwd, dataPlane)
    const installed = await Promise.all(
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
    const includeAvailable = invocation.pluginAvailable
    pluginOutput(
      io,
      invocation,
      includeAvailable
        ? {
            installed,
            available: await listClaudeMarketplaceAvailablePlugins(
              configRoot,
              cwd,
            ),
          }
        : installed,
    )
    return 0
  }
  if (action === 'details') {
    if (args.length !== 3)
      throw new Error('plugin details requires a plugin name')
    const details = await pluginDetailsForName(
      configRoot,
      cwd,
      args[2] as string,
      dataPlane,
    )
    pluginOutput(
      io,
      invocation,
      invocation.legacyJson || invocation.outputFormat !== 'text'
        ? details
        : formatPluginDetails(details),
    )
    return 0
  }
  if (action === 'install') {
    if (args.length !== 3)
      throw new Error(
        'plugin install requires a plugin path, URL, or plugin@marketplace id',
      )
    const source = args[2] as string
    if (isClaudeMarketplacePluginId(source)) {
      const plugin = await installClaudeMarketplacePlugin(
        configRoot,
        cwd,
        source,
        installScope,
        dataPlane,
      )
      const config = await saveClaudePluginConfig(
        configRoot,
        cwd,
        installScope,
        plugin.id,
        plugin.installPath,
        invocation.pluginConfig,
        dataPlane,
      )
      pluginOutput(io, invocation, {
        type: 'plugin-installed',
        plugin,
        ...(config.warnings.length === 0 ? {} : { warnings: config.warnings }),
      })
      return 0
    }
    if (requestedScope !== undefined) {
      throw new Error(
        '--scope is only supported when installing plugin@marketplace',
      )
    }
    const plugin = await installClaudePlugin(configRoot, source)
    const config = await saveClaudePluginConfig(
      configRoot,
      cwd,
      installScope,
      plugin.name,
      plugin.path,
      invocation.pluginConfig,
      dataPlane,
    )
    pluginOutput(io, invocation, {
      type: 'plugin-installed',
      plugin,
      ...(config.warnings.length === 0 ? {} : { warnings: config.warnings }),
    })
    return 0
  }
  if (action === 'uninstall') {
    if (args.length !== 3)
      throw new Error('plugin uninstall requires a plugin name')
    const name = args[2] as string
    if (isClaudeMarketplacePluginId(name))
      await uninstallNativePlugin(
        configRoot,
        cwd,
        name,
        installScope,
        !invocation.pluginKeepData,
        dataPlane,
      )
    else
      await uninstallClaudePlugin(configRoot, name, !invocation.pluginKeepData)
    if (!invocation.pluginPrune) {
      pluginOutput(io, invocation, { type: 'plugin-uninstalled', name })
      return 0
    }
    const structured =
      invocation.legacyJson || invocation.outputFormat !== 'text'
    if (!structured) {
      pluginOutput(io, invocation, { type: 'plugin-uninstalled', name })
    }
    return executePluginPruneFlow(
      configRoot,
      cwd,
      installScope,
      invocation,
      io,
      structured ? name : undefined,
    )
  }
  if (action === 'enable' || action === 'disable') {
    if (action === 'disable' && invocation.pluginAll) {
      if (args.length !== 2) {
        throw new Error('plugin disable --all takes no plugin name')
      }
      if (requestedScope !== undefined) {
        throw new Error('--scope cannot be used with plugin disable --all')
      }
      const native = await disableAllNativePlugins(configRoot, cwd, dataPlane)
      const local = (await readPluginRegistry(configRoot)).filter(
        (plugin) => plugin.enabled,
      )
      const disabledLocal = await Promise.all(
        local.map((plugin) =>
          setClaudePluginEnabled(configRoot, plugin.name, false),
        ),
      )
      pluginOutput(io, invocation, {
        type: 'plugins-disabled',
        plugins: [...native, ...disabledLocal],
      })
      return 0
    }
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
          dataPlane,
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
        ? await updateNativePlugin(
            configRoot,
            cwd,
            name,
            installScope,
            dataPlane,
          )
        : await updateClaudePlugin(configRoot, name),
    })
    return 0
  }
  if (action === 'prune' || action === 'autoremove') {
    if (args.length !== 2) throw new Error(`plugin ${action} takes no operands`)
    return executePluginPruneFlow(configRoot, cwd, installScope, invocation, io)
  }
  if (action === 'tag') {
    if (args.length > 3) throw new Error('plugin tag accepts at most one path')
    return executePluginTag(args[2] ?? cwd, invocation, io)
  }
  if (action === 'validate') {
    if (args.length !== 3)
      throw new Error('plugin validate requires a plugin directory')
    const path = resolve(args[2] as string)
    let marketplace = false
    try {
      await access(join(path, '.claude-plugin', 'marketplace.json'))
      marketplace = true
    } catch {
      // A plugin manifest remains the default validation target.
    }
    pluginOutput(io, invocation, {
      type: 'plugin-valid',
      ...(marketplace
        ? {
            marketplace: await validateClaudeMarketplace(path, {
              strict: invocation.pluginStrict,
            }),
          }
        : {
            plugin: await validateClaudePlugin(path, {
              strict: invocation.pluginStrict,
            }),
          }),
    })
    return 0
  }
  if (action === 'init') {
    if (args.length < 3 || args.length > 4) {
      throw new Error('plugin init requires a name')
    }
    const nativeOptionsUsed =
      invocation.pluginAuthor !== undefined ||
      invocation.pluginAuthorEmail !== undefined ||
      invocation.pluginDescription !== undefined ||
      invocation.pluginForce ||
      invocation.pluginWith.length > 0
    if (args.length === 4 && nativeOptionsUsed) {
      throw new Error(
        'plugin init native syntax accepts one name; use plugin init <directory> <name> without native init options for legacy scaffolding',
      )
    }
    const options = {
      ...(invocation.pluginAuthor === undefined
        ? {}
        : { author: invocation.pluginAuthor }),
      ...(invocation.pluginAuthorEmail === undefined
        ? {}
        : { authorEmail: invocation.pluginAuthorEmail }),
      ...(invocation.pluginDescription === undefined
        ? {}
        : { description: invocation.pluginDescription }),
      ...(invocation.pluginForce ? { force: true } : {}),
      ...(invocation.pluginWith.length === 0
        ? {}
        : {
            with: invocation.pluginWith as readonly ClaudePluginInitComponent[],
          }),
    }
    const nativeLayout = args.length === 3
    const path = nativeLayout
      ? join(configRoot, 'skills', args[2] as string)
      : (args[2] as string)
    const name = nativeLayout ? (args[2] as string) : args[3]
    const plugin = await initClaudePlugin(path, name, {
      ...options,
      nativeLayout,
    })
    pluginOutput(io, invocation, {
      type: 'plugin-initialized',
      path: resolve(path),
      ...(name ? { name } : {}),
      plugin,
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
    io.stdout(MCP_HELP)
    return 0
  }
  const dataPlane = invocation.dataPlane ?? resolveDataPlane()
  const { configRoot, statePath } =
    resolveInteractiveRuntimeSettingsLocation(dataPlane)
  const management = new ClaudeMcpManagement({
    dataPlane,
    configRoot,
    statePath,
    cwd: process.cwd(),
  })
  const scope = invocation.mcpScope ? mcpScope(invocation.mcpScope) : undefined
  if (action === 'login') {
    if (args.length !== 3) throw new Error('mcp login requires a server name')
    const record = await management.get(args[2] as string, scope)
    const server = mcpOAuthServerIdentity(record.name, record.config)
    const oauth = mcpOauthOptions(record.config)
    const clientSecret = oauth.clientId
      ? await new ClaudeMcpOAuthStore({ configRoot }).readClientSecret(server)
      : undefined
    await (dependencies.mcpAuthenticate ?? authenticateMcpServer)({
      configRoot,
      server,
      ...oauth,
      ...(clientSecret ? { clientSecret } : {}),
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
          eventSink: warningEventSink(io),
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
    const name = args[2] as string
    const serverConfig = config as Record<string, unknown>
    const oauth = serverConfig.oauth
    const hasClientId =
      oauth !== null &&
      typeof oauth === 'object' &&
      !Array.isArray(oauth) &&
      typeof (oauth as Record<string, unknown>).clientId === 'string' &&
      (oauth as Record<string, unknown>).clientId !== ''
    const clientSecret =
      invocation.mcpClientSecret && hasClientId
        ? await readMcpClientSecret()
        : undefined
    const targetScope = scope ?? 'local'
    const previous = clientSecret
      ? await existingMcpServer(management, name, targetScope)
      : undefined
    const server = await management.add(name, serverConfig, targetScope)
    if (clientSecret) {
      try {
        await new ClaudeMcpOAuthStore({ configRoot }).saveClientSecret(
          mcpOAuthServerIdentity(name, serverConfig),
          clientSecret,
        )
      } catch (error) {
        try {
          if (previous) await management.add(name, previous.config, targetScope)
          else await management.remove(name, targetScope)
        } catch {
          throw new Error(
            'MCP client secret could not be stored and configuration rollback failed',
            { cause: error },
          )
        }
        throw error
      }
    }
    mcpOutput(io, invocation, {
      type: 'mcp-added',
      server: mcpRecordJson(server),
    })
    return 0
  }
  if (action === 'add') {
    if (args.length < 3) throw new Error("missing required argument 'name'")
    if (args.length < 4)
      throw new Error("missing required argument 'commandOrUrl'")
    const name = args[2] as string
    const commandOrUrl = args[3] as string
    const transport = invocation.mcpTransport ?? 'stdio'
    const commandArgs = args.slice(4)
    if (transport === 'stdio') {
      if (
        invocation.mcpClientId ||
        invocation.mcpClientSecret ||
        invocation.mcpCallbackPort
      ) {
        io.stderr(
          'Warning: --client-id, --client-secret, and --callback-port are only supported for HTTP/SSE transports and will be ignored for stdio.\n',
        )
      }
      if (!invocation.mcpTransport && isLikelyMcpUrl(commandOrUrl)) {
        io.stderr(
          `\nWarning: The command "${commandOrUrl}" looks like a URL, but is being interpreted as a stdio server as --transport was not specified.\n`,
        )
        io.stderr(
          `If this is an HTTP server, use: praxis mcp add --transport http ${name} ${commandOrUrl}\n`,
        )
        io.stderr(
          `If this is an SSE server, use: praxis mcp add --transport sse ${name} ${commandOrUrl}\n`,
        )
      }
      const server = await management.add(
        name,
        {
          type: 'stdio',
          command: commandOrUrl,
          args: commandArgs,
          env: mcpEnvironment(invocation.mcpEnv),
        },
        scope ?? 'local',
      )
      mcpAddedOutput(
        io,
        invocation,
        server,
        transport,
        commandOrUrl,
        commandArgs,
        undefined,
      )
      return 0
    }
    const headers = mcpHeaders(invocation.mcpHeaders)
    const callbackPort = mcpCallbackPort(invocation.mcpCallbackPort)
    const oauth =
      invocation.mcpClientId || callbackPort
        ? {
            ...(invocation.mcpClientId
              ? { clientId: invocation.mcpClientId }
              : {}),
            ...(callbackPort ? { callbackPort } : {}),
          }
        : undefined
    const clientSecret =
      invocation.mcpClientSecret && invocation.mcpClientId
        ? await readMcpClientSecret()
        : undefined
    const config = {
      type: transport,
      url: commandOrUrl,
      ...(headers ? { headers } : {}),
      ...(oauth ? { oauth } : {}),
    }
    const targetScope = scope ?? 'local'
    const previous = clientSecret
      ? await existingMcpServer(management, name, targetScope)
      : undefined
    const server = await management.add(name, config, targetScope)
    if (clientSecret) {
      try {
        await new ClaudeMcpOAuthStore({ configRoot }).saveClientSecret(
          mcpOAuthServerIdentity(name, config),
          clientSecret,
        )
      } catch (error) {
        try {
          if (previous) {
            await management.add(name, previous.config, targetScope)
          } else {
            await management.remove(name, targetScope)
          }
        } catch {
          throw new Error(
            'MCP client secret could not be stored and configuration rollback failed',
            { cause: error },
          )
        }
        throw error
      }
    }
    mcpAddedOutput(
      io,
      invocation,
      server,
      transport,
      commandOrUrl,
      commandArgs,
      headers,
    )
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
  printText = false,
): RuntimeEventSink {
  const sensitiveValues = sensitiveEnvironmentValues(process.env)
  if (legacyJson) {
    return (event) => {
      if (event.type === 'warning') {
        io.stderr(
          `Warning: ${redactSensitiveText(event.message, sensitiveValues)}\n`,
        )
        return
      }
      writeJson(
        io,
        event.type === 'failed'
          ? {
              ...event,
              message: redactSensitiveText(event.message, sensitiveValues),
            }
          : event,
      )
    }
  }
  if (outputFormat !== 'text') return () => undefined
  if (printText)
    return (event) => {
      if (event.type === 'warning') {
        io.stderr(
          `Warning: ${redactSensitiveText(event.message, sensitiveValues)}\n`,
        )
      }
    }
  let turnBuffered = false
  let bufferedText = ''
  const flushBufferedText = () => {
    if (bufferedText.length > 0) io.stdout(bufferedText)
    bufferedText = ''
  }
  return (event) => {
    if (event.type === 'state' && event.state === 'awaiting-model') {
      turnBuffered = true
      bufferedText = ''
    }
    if (event.type === 'text-delta') {
      if (turnBuffered) bufferedText += event.delta
      else io.stdout(event.delta)
    }
    if (event.type === 'model-attempt-discarded') bufferedText = ''
    if (
      event.type === 'terminal' &&
      event.reason !== 'prompt_too_long' &&
      turnBuffered
    ) {
      flushBufferedText()
      turnBuffered = false
    }
    if (event.type === 'state' && event.state === 'completed' && turnBuffered) {
      flushBufferedText()
      turnBuffered = false
    }
    if (event.type === 'failed') {
      bufferedText = ''
      turnBuffered = false
    }
    if (event.type === 'user-message') io.stdout(`\n${event.message}\n`)
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

async function resolvePrintTextPrompt(
  io: CliIO,
  argvPrompt: string | undefined,
): Promise<string> {
  const missingInput = () =>
    new Error(
      'Error: Input must be provided either through stdin or as a prompt argument when using --print',
    )
  if (io.stdinIsTTY !== false) {
    if (argvPrompt !== undefined) return argvPrompt
    throw missingInput()
  }
  const input = io.readStdinLines?.()
  if (!input) throw new Error('print text input requires stdin support')
  const chunks: Buffer[] = []
  for await (const chunk of input) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  const stdinText = Buffer.concat(chunks).toString('utf8')
  if (argvPrompt !== undefined && stdinText.length > 0)
    return `${argvPrompt}\n${stdinText}`
  if (argvPrompt !== undefined) return argvPrompt
  if (stdinText.length > 0) return stdinText
  throw missingInput()
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

export function agentDashboardWorkerArgv(
  invocation: CliControls & { agent: string | undefined },
): string[] {
  const argv: string[] = []
  if (invocation.safeMode) argv.push('--safe-mode')
  if (invocation.bare) argv.push('--bare')
  if (invocation.provider !== undefined)
    argv.push('--provider', invocation.provider)
  if (invocation.providerProfile !== undefined)
    argv.push('--provider-profile', invocation.providerProfile)
  if (invocation.model !== undefined) argv.push('--model', invocation.model)
  if (invocation.effort !== undefined) argv.push('--effort', invocation.effort)
  if (invocation.permissionMode !== 'default') {
    argv.push('--permission-mode', invocation.permissionMode)
  }
  if (invocation.dangerouslySkipPermissions) {
    argv.push('--dangerously-skip-permissions')
  }
  if (invocation.allowDangerouslySkipPermissions) {
    argv.push('--allow-dangerously-skip-permissions')
  }
  if (invocation.agent !== undefined) argv.push('--agent', invocation.agent)
  for (const directory of invocation.addDirectories) {
    argv.push('--add-dir', directory)
  }
  for (const config of invocation.mcpConfigs) {
    argv.push('--mcp-config', config)
  }
  if (invocation.strictMcpConfig) argv.push('--strict-mcp-config')
  if (invocation.settings !== undefined) {
    argv.push('--settings', invocation.settings)
  }
  if (invocation.settingSources !== undefined) {
    argv.push('--setting-sources', invocation.settingSources.join(','))
  }
  for (const directory of invocation.pluginDirectories) {
    argv.push('--plugin-dir', directory)
  }
  for (const url of invocation.pluginUrls) argv.push('--plugin-url', url)
  return argv
}

function backgroundLaunchMessage(id: string): string {
  return `backgrounded · ${id}\n  praxis agents             list sessions\n  praxis attach ${id}    open in this terminal\n  praxis logs ${id}      show recent output\n  praxis stop ${id}      stop this session\n`
}

function requireTopLevelAgentManager(
  dependencies: CliDependencies,
  dataPlane: DataPlane = resolveDataPlane(),
): TopLevelAgentCommands {
  if (dependencies.createTopLevelAgents) {
    return dependencies.createTopLevelAgents(dataPlane)
  }
  if (!dependencies.topLevelAgents) {
    throw new Error('Top-level agent manager unavailable')
  }
  return dependencies.topLevelAgents
}

function assertAgentsOptionAllowlist(argv: readonly string[]): void {
  const valued = new Set([
    '--add-dir',
    '--agent',
    '--cwd',
    '--effort',
    '--mcp-config',
    '--model',
    '--provider',
    '--provider-profile',
    '--permission-mode',
    '--plugin-dir',
    '--setting-sources',
    '--settings',
  ])
  const flags = new Set([
    '--all',
    '--allow-dangerously-skip-permissions',
    '--dangerously-skip-permissions',
    '--json',
    '--strict-mcp-config',
  ])
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === 'agents') continue
    if (value === '--') throw new Error('Unexpected operand for agents')
    const option = value?.split('=', 1)[0]
    if (option === '-h' || option === '--help') continue
    if (option && flags.has(option)) {
      if (value.includes('='))
        throw new Error(`Option does not take a value: ${option}`)
      continue
    }
    if (option && valued.has(option)) {
      if (!value.includes('=')) {
        index += 1
        if (argv[index] === undefined)
          throw new Error(`Missing value for ${option}`)
      }
      continue
    }
    if (value?.startsWith('-'))
      throw new Error(`${value} is not valid with agents`)
    throw new Error(`Unexpected operand for agents: ${value}`)
  }
}

function isCancellation(error: unknown, signal?: AbortSignal): boolean {
  return (
    error instanceof AgentRunCancelledError ||
    signal?.aborted === true ||
    (error instanceof DOMException && error.name === 'AbortError')
  )
}

function emptyCostSnapshot(sessionId: string): ClaudeSessionCostSnapshot {
  return {
    sessionId,
    totalCostUsd: 0,
    apiDurationMs: 0,
    apiDurationWithoutRetriesMs: 0,
    toolDurationMs: 0,
    wallDurationMs: 0,
    linesAdded: 0,
    linesRemoved: 0,
    modelUsage: {},
    hasUnknownModelCost: false,
  }
}

/**
 * Computes the validated nonnegative delta between a current cost snapshot and
 * a process-local baseline. The baseline represents restored historic state or
 * the empty state before this process touched the session, so the delta shows
 * only same-process accumulation. Counter regression and incompatible model
 * state are rejected explicitly rather than clamped.
 */
function costSummaryDelta(
  current: ClaudeSessionCostSnapshot,
  baseline: ClaudeSessionCostSnapshot | undefined,
): CostSummary {
  const base = baseline ?? emptyCostSnapshot(current.sessionId)
  const assertAtLeast = (
    label: string,
    value: number,
    floor: number,
  ): number => {
    if (value < floor) {
      throw new Error(
        `Cost state regression: ${label} fell below the process baseline`,
      )
    }
    return value - floor
  }
  const totalCostUsd = assertAtLeast(
    'total cost',
    current.totalCostUsd,
    base.totalCostUsd,
  )
  const apiDurationMs = assertAtLeast(
    'API duration',
    current.apiDurationMs,
    base.apiDurationMs,
  )
  const wallDurationMs = assertAtLeast(
    'wall duration',
    current.wallDurationMs,
    base.wallDurationMs,
  )
  const linesAdded = assertAtLeast(
    'lines added',
    current.linesAdded,
    base.linesAdded,
  )
  const linesRemoved = assertAtLeast(
    'lines removed',
    current.linesRemoved,
    base.linesRemoved,
  )
  const modelUsage: CostModelUsage[] = []
  for (const [model, usage] of Object.entries(current.modelUsage)) {
    const baseUsage = base.modelUsage[model]
    if (baseUsage === undefined) {
      modelUsage.push({
        model,
        canonicalName: canonicalClaudeCostModelName(model),
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadInputTokens: usage.cacheReadInputTokens,
        cacheCreationInputTokens: usage.cacheCreationInputTokens,
        webSearchRequests: usage.webSearchRequests,
        costUsd: usage.costUsd,
      })
      continue
    }
    const inputTokens = usage.inputTokens - baseUsage.inputTokens
    const outputTokens = usage.outputTokens - baseUsage.outputTokens
    const cacheReadInputTokens =
      usage.cacheReadInputTokens - baseUsage.cacheReadInputTokens
    const cacheCreationInputTokens =
      usage.cacheCreationInputTokens - baseUsage.cacheCreationInputTokens
    const webSearchRequests =
      usage.webSearchRequests - baseUsage.webSearchRequests
    const costUsd = usage.costUsd - baseUsage.costUsd
    if (
      inputTokens < 0 ||
      outputTokens < 0 ||
      cacheReadInputTokens < 0 ||
      cacheCreationInputTokens < 0 ||
      webSearchRequests < 0 ||
      costUsd < 0
    ) {
      throw new Error(
        `Cost state regression for model ${model}: counters fell below the process baseline`,
      )
    }
    if (
      inputTokens === 0 &&
      outputTokens === 0 &&
      cacheReadInputTokens === 0 &&
      cacheCreationInputTokens === 0 &&
      webSearchRequests === 0 &&
      costUsd === 0
    ) {
      continue
    }
    modelUsage.push({
      model,
      canonicalName: canonicalClaudeCostModelName(model),
      inputTokens,
      outputTokens,
      cacheReadInputTokens,
      cacheCreationInputTokens,
      webSearchRequests,
      costUsd,
    })
  }
  for (const model of Object.keys(base.modelUsage)) {
    if (current.modelUsage[model] === undefined) {
      throw new Error(
        `Cost state regression for model ${model}: model disappeared from the session tracker`,
      )
    }
  }
  return {
    totalCostUsd,
    apiDurationMs,
    wallDurationMs,
    linesAdded,
    linesRemoved,
    hasUnknownModelCost:
      current.hasUnknownModelCost && !base.hasUnknownModelCost,
    modelUsage,
  }
}

function helpActionAt(
  argv: readonly string[],
  commandIndex: number,
  actions: readonly string[],
): { value: string; index: number } | undefined {
  for (let index = commandIndex + 1; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === undefined || value === '--') return undefined
    if (actions.includes(value)) return { value, index }
  }
  return undefined
}

function pluginActionHelp(
  action: string | undefined,
  marketplaceAction?: string,
): string {
  if (action === 'marketplace') {
    return (
      PLUGIN_MARKETPLACE_ACTION_HELP[marketplaceAction ?? ''] ??
      PLUGIN_MARKETPLACE_HELP
    )
  }
  return PLUGIN_ACTION_HELP[action ?? ''] ?? PLUGIN_HELP
}

function printCommandHelp(argv: readonly string[], io: CliIO): boolean {
  const hasHelpFlag = argv.includes('--help') || argv.includes('-h')
  const commandIndex = argv.findIndex((value) =>
    [
      'agents',
      'mcp',
      'plugin',
      'plugins',
      'auto-mode',
      'project',
      'import',
      'auth',
      'team',
    ].includes(value),
  )
  if (commandIndex < 0) return false
  const command = argv[commandIndex]
  if (command === 'agents') {
    if (!hasHelpFlag) return false
    io.stdout(AGENTS_HELP)
    return true
  }
  if (command === 'mcp') {
    const action = helpActionAt(argv, commandIndex, [
      'help',
      ...Object.keys(MCP_ACTION_HELP),
    ])
    if (!hasHelpFlag && action?.value !== 'help') return false
    const target =
      action?.value === 'help'
        ? helpActionAt(argv, action.index, Object.keys(MCP_ACTION_HELP))
        : action
    io.stdout(MCP_ACTION_HELP[target?.value ?? ''] ?? MCP_HELP)
    return true
  }
  if (command === 'plugin' || command === 'plugins') {
    const initialAction = helpActionAt(argv, commandIndex, [
      'help',
      'marketplace',
      ...Object.keys(PLUGIN_ACTION_HELP),
    ])
    let requestedHelp = hasHelpFlag || initialAction?.value === 'help'
    if (!requestedHelp && initialAction?.value !== 'marketplace') {
      return false
    }
    const action =
      initialAction?.value === 'help'
        ? helpActionAt(argv, initialAction.index, [
            'marketplace',
            ...Object.keys(PLUGIN_ACTION_HELP),
          ])
        : initialAction
    if (action?.value === 'marketplace') {
      const initialMarketplaceAction = helpActionAt(argv, action.index, [
        'help',
        ...Object.keys(PLUGIN_MARKETPLACE_ACTION_HELP),
      ])
      const marketplaceAction =
        initialMarketplaceAction?.value === 'help'
          ? helpActionAt(
              argv,
              initialMarketplaceAction.index,
              Object.keys(PLUGIN_MARKETPLACE_ACTION_HELP),
            )
          : initialMarketplaceAction
      requestedHelp ||= initialMarketplaceAction?.value === 'help'
      if (!requestedHelp) return false
      io.stdout(pluginActionHelp(action.value, marketplaceAction?.value))
      return true
    }
    if (!requestedHelp) return false
    io.stdout(pluginActionHelp(action?.value))
    return true
  }
  if (command === 'auto-mode') {
    const action = helpActionAt(argv, commandIndex, [
      'help',
      ...Object.keys(AUTO_MODE_ACTION_HELP),
    ])
    if (!hasHelpFlag && action?.value !== 'help') return false
    const target =
      action?.value === 'help'
        ? helpActionAt(argv, action.index, Object.keys(AUTO_MODE_ACTION_HELP))
        : action
    io.stdout(AUTO_MODE_ACTION_HELP[target?.value ?? ''] ?? AUTO_MODE_HELP)
    return true
  }
  if (command === 'project') {
    const action = helpActionAt(argv, commandIndex, ['help', 'purge'])
    if (!hasHelpFlag && action?.value !== 'help') return false
    const target =
      action?.value === 'help'
        ? helpActionAt(argv, action.index, ['purge'])
        : action
    io.stdout(target?.value === 'purge' ? PROJECT_PURGE_HELP : PROJECT_HELP)
    return true
  }
  if (command === 'import') {
    if (!hasHelpFlag) return false
    io.stdout(IMPORT_HELP)
    return true
  }
  if (command === 'auth') {
    const action = helpActionAt(argv, commandIndex, [
      'help',
      ...Object.keys(AUTH_ACTION_HELP),
    ])
    if (!hasHelpFlag && action?.value !== 'help') return false
    const target =
      action?.value === 'help'
        ? helpActionAt(argv, action.index, Object.keys(AUTH_ACTION_HELP))
        : action
    io.stdout(AUTH_ACTION_HELP[target?.value ?? ''] ?? AUTH_HELP)
    return true
  }
  if (command === 'team') {
    if (!hasHelpFlag) return false
    io.stdout(TEAM_HELP)
    return true
  }
  return false
}

type TeamCliCommand =
  | {
      command: 'create'
      manifest: string
      leadSessionId: string
      json: boolean
    }
  | { command: 'resume'; teamId: string; leadSessionId: string; json: boolean }
  | { command: 'list'; json: boolean }
  | {
      command: 'accept'
      teamId: string
      taskId: string
      leadSessionId: string
      generation?: number
      decision: 'accepted' | 'rejected'
      json: boolean
    }
  | {
      command: 'stop'
      teamId: string
      leadSessionId: string
      drainMs?: number
      json: boolean
    }
  | { command: 'status' | 'logs' | 'attach'; teamId: string; json: boolean }

function parseTeamCommand(args: readonly string[]): TeamCliCommand {
  if (args[0] !== 'team') throw new Error('Invalid Team command')
  const command = args[1]
  if (!command || command === 'help') throw new Error(TEAM_HELP.trim())
  if (
    ![
      'create',
      'resume',
      'list',
      'accept',
      'stop',
      'status',
      'logs',
      'attach',
    ].includes(command)
  )
    throw new Error(`Unsupported Team command: ${command}`)
  const operands: string[] = []
  let json = false
  let leadSessionId: string | undefined
  let generation: number | undefined
  let decision: 'accepted' | 'rejected' = 'accepted'
  let drainMs: number | undefined
  const seen = new Set<string>()
  const optionValue = (index: number, option: string): string => {
    const value = args[index + 1]
    if (value === undefined || value.startsWith('--'))
      throw new Error(`${option} requires a value`)
    if (seen.has(option))
      throw new Error(`${option} may only be specified once`)
    seen.add(option)
    return value
  }
  for (let index = 2; index < args.length; index += 1) {
    const value = args[index] as string
    if (value === '--json') {
      if (json) throw new Error('--json may only be specified once')
      json = true
    } else if (value === '--lead-session-id') {
      leadSessionId = optionValue(index, value)
      index += 1
    } else if (value === '--generation') {
      const raw = optionValue(index, value)
      if (!/^\d+$/.test(raw)) throw new Error('Invalid generation')
      generation = Number(raw)
      if (!Number.isSafeInteger(generation))
        throw new Error('Invalid generation')
      index += 1
    } else if (value === '--decision') {
      const raw = optionValue(index, value)
      if (raw !== 'accepted' && raw !== 'rejected')
        throw new Error('Invalid decision')
      decision = raw
      index += 1
    } else if (value === '--drain-ms') {
      const raw = optionValue(index, value)
      if (!/^\d+(?:\.\d+)?$/.test(raw)) throw new Error('Invalid drain-ms')
      drainMs = Number(raw)
      if (!Number.isFinite(drainMs) || drainMs < 0 || drainMs > 600000)
        throw new Error('Invalid drain-ms')
      index += 1
    } else if (value.startsWith('-')) {
      throw new Error(`Unknown Team option: ${value}`)
    } else operands.push(value)
  }
  const requireLead = (): string => {
    if (!leadSessionId) throw new Error('--lead-session-id requires a value')
    return leadSessionId
  }
  const rejectOptions = (allowed: readonly string[]): void => {
    for (const option of seen) {
      if (!allowed.includes(option))
        throw new Error(`${option} is not valid for team ${command}`)
    }
  }
  if (command === 'create') {
    rejectOptions(['--lead-session-id'])
    if (operands.length !== 1)
      throw new Error('create requires a manifest path')
    return {
      command,
      manifest: operands[0] as string,
      leadSessionId: requireLead(),
      json,
    }
  }
  if (command === 'list') {
    rejectOptions([])
    if (operands.length !== 0) throw new Error('Invalid list options')
    return { command, json }
  }
  if (command === 'resume') {
    rejectOptions(['--lead-session-id'])
    if (operands.length !== 1) throw new Error('resume requires a team ID')
    return {
      command,
      teamId: operands[0] as string,
      leadSessionId: requireLead(),
      json,
    }
  }
  if (command === 'accept') {
    rejectOptions(['--lead-session-id', '--generation', '--decision'])
    if (operands.length !== 2)
      throw new Error('accept requires team ID and task ID')
    return {
      command,
      teamId: operands[0] as string,
      taskId: operands[1] as string,
      leadSessionId: requireLead(),
      ...(generation === undefined ? {} : { generation }),
      decision,
      json,
    }
  }
  if (command === 'status' || command === 'logs' || command === 'attach') {
    rejectOptions([])
    if (operands.length !== 1) throw new Error(`${command} requires a team ID`)
    return { command, teamId: operands[0] as string, json }
  }
  rejectOptions(['--lead-session-id', '--drain-ms'])
  if (operands.length !== 1) throw new Error('stop requires a team ID')
  return {
    command: 'stop',
    teamId: operands[0] as string,
    leadSessionId: requireLead(),
    ...(drainMs === undefined ? {} : { drainMs }),
    json,
  }
}

function teamEnabled(environment: NodeJS.ProcessEnv): boolean {
  return /^(1|true|yes|on)$/i.test(
    (environment.PRAXIS_ENABLE_TEAMS ?? '').trim(),
  )
}

async function executeTeamCommand(
  args: readonly string[],
  io: CliIO,
  dependencies: CliDependencies,
  signal?: AbortSignal,
): Promise<number> {
  const parsed = parseTeamCommand(args)
  if (!teamEnabled(process.env))
    throw new Error(
      'Experimental Team capability is disabled; set PRAXIS_ENABLE_TEAMS=true',
    )
  const nativeControls = {
    ...DEFAULT_CLI_CONTROLS,
    dataPlane: 'native' as const,
  }
  const service = await dependencies.createService({
    eventSink: warningEventSink(io),
    requireProvider: !['list', 'status', 'logs', 'attach'].includes(
      parsed.command,
    ),
    exposeToolRegistry: true,
    controls: nativeControls,
    configRoot: resolveDataPlaneRoot(),
    providerEnvironment: process.env,
    ...(signal ? { signal } : {}),
  })
  try {
    const operations = service.teamLeadOperations
    if (!operations) throw new Error('Team lead operations are unavailable')
    if (
      parsed.command === 'status' ||
      parsed.command === 'logs' ||
      parsed.command === 'attach'
    ) {
      const {
        projectTeamDashboard,
        readTeamMailboxAudit,
        readTeamWorktreeEvidence,
        renderTeamAudit,
        renderTeamSummary,
      } = await import('./application/team-observability.js')
      const snapshot = (await operations.list()).find(
        (team) => team.teamId === parsed.teamId,
      )
      if (!snapshot) throw new Error(`Missing Team: ${parsed.teamId}`)
      const nativeRoot = resolveDataPlaneRoot()
      const [mailbox, worktrees] = await Promise.all([
        readTeamMailboxAudit({ nativeRoot, snapshot }),
        readTeamWorktreeEvidence({ nativeRoot, snapshot }),
      ])
      const dashboard = projectTeamDashboard(snapshot, { mailbox, worktrees })
      if (parsed.command === 'logs') {
        if (parsed.json) writeJson(io, dashboard)
        else
          io.stdout(
            `${renderTeamAudit(dashboard)}${dashboard.events.length ? '\n' : ''}`,
          )
      } else if (parsed.command === 'attach') {
        if (parsed.json)
          writeJson(io, { ...dashboard, transport: 'durable-local' })
        else
          io.stdout(
            `${renderTeamSummary(dashboard)}\ntransport: durable-local\n`,
          )
      } else if (parsed.json) writeJson(io, dashboard)
      else io.stdout(`${renderTeamSummary(dashboard)}\n`)
      return 0
    }
    if (parsed.command === 'list') {
      const teams = await operations.list()
      if (parsed.json) writeJson(io, { teams })
      else
        io.stdout(
          `${teams.map((team) => team.teamId).join('\n')}${teams.length ? '\n' : ''}`,
        )
      return 0
    }
    let snapshot: TeamSnapshot | undefined
    if (parsed.command === 'create') {
      const raw = await readFile(parsed.manifest, 'utf8')
      const value: unknown = JSON.parse(raw)
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Team manifest must be an object')
      const request = value as TeamCreateRequest
      snapshot = await operations.create(request, parsed.leadSessionId)
      snapshot = await operations.detach(request.teamId, parsed.leadSessionId)
    } else if (parsed.command === 'resume') {
      snapshot = await operations.resume(parsed.teamId, parsed.leadSessionId)
      snapshot = await operations.detach(parsed.teamId, parsed.leadSessionId)
    } else if (parsed.command === 'accept') {
      snapshot = await operations.accept(
        {
          teamId: parsed.teamId,
          taskId: parsed.taskId,
          ...(parsed.generation === undefined
            ? {}
            : { generation: parsed.generation }),
          decision: parsed.decision,
        },
        parsed.leadSessionId,
      )
      snapshot = await operations.detach(parsed.teamId, parsed.leadSessionId)
    } else if (parsed.command === 'stop') {
      snapshot = await operations.stop(
        {
          teamId: parsed.teamId,
          ...(parsed.drainMs === undefined ? {} : { drainMs: parsed.drainMs }),
        },
        parsed.leadSessionId,
      )
    }
    if (!snapshot) throw new Error('Team command did not produce a snapshot')
    if (parsed.json) writeJson(io, { team: snapshot })
    else io.stdout(`${snapshot.teamId}\n`)
    return 0
  } finally {
    await service.close?.()
  }
}

function specialCommandIndex(argv: readonly string[]): number {
  const commands = new Set([
    'eval',
    'team',
    'plugin',
    'plugins',
    'project',
    'install',
    'update',
    'upgrade',
  ])
  for (let index = 0; index < argv.length; index += 1) {
    const command = argv[index] ?? ''
    if (!commands.has(command)) continue
    try {
      const probe = parseCliInvocation([...argv.slice(0, index), '__probe__'])
      if (probe.args.length === 1 && probe.args[0] === '__probe__') return index
    } catch {
      if (command !== 'project') continue
      const filteredPrefix = argv
        .slice(0, index)
        .filter((value) => !PROJECT_PURGE_PREFIX_FLAGS.has(value))
      try {
        const probe = parseCliInvocation([...filteredPrefix, '__probe__'])
        if (probe.args.length === 1 && probe.args[0] === '__probe__')
          return index
      } catch {
        // This candidate is an option value or follows an invalid prefix.
      }
    }
  }
  return -1
}

const PROJECT_PURGE_PREFIX_FLAGS = new Set([
  '--all',
  '--dry-run',
  '--help',
  '--interactive',
  '--json',
  '--yes',
  '-h',
  '-i',
  '-y',
])

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
  const commandIndex = specialCommandIndex(argv)
  if (
    commandIndex >= 0 &&
    argv[commandIndex] === 'team' &&
    !argv.includes('--help') &&
    !argv.includes('-h')
  ) {
    if (
      argv.some(
        (value) =>
          value === '--data-plane' || value.startsWith('--data-plane='),
      )
    )
      throw new Error(
        'Team commands are native-only; --data-plane is not supported',
      )
    return executeTeamCommand(
      argv.slice(commandIndex),
      io,
      dependencies,
      signal,
    )
  }
  const specialPrefix =
    commandIndex > 0 &&
    (argv[commandIndex] === 'plugin' ||
      argv[commandIndex] === 'plugins' ||
      argv[commandIndex] === 'eval')
      ? parseCliInvocation([...argv.slice(0, commandIndex), '__probe__'])
      : undefined
  const special =
    commandIndex >= 0
      ? {
          args: argv.slice(commandIndex),
        }
      : { args: [...argv] }
  if (special.args[0] === 'eval') {
    if (
      special.args[1] === 'compare' &&
      special.args
        .slice(2)
        .some((value) => value === '-h' || value === '--help')
    ) {
      io.stdout(PROJECT_EVAL_COMPARE_HELP)
      return 0
    }
    if (
      special.args
        .slice(1)
        .some((value) => value === '-h' || value === '--help')
    ) {
      io.stdout(PROJECT_EVAL_HELP)
      return 0
    }
    if (!dependencies.projectEval) throw new Error('Project eval unavailable')
    return executeProjectEvalCommand(
      [
        ...(specialPrefix?.model === undefined
          ? []
          : ['--model', specialPrefix.model]),
        ...special.args.slice(1),
      ],
      io,
      dependencies.projectEval,
      process.cwd(),
      signal,
    )
  }
  if (
    (special.args[0] === 'plugin' || special.args[0] === 'plugins') &&
    special.args[1] === 'eval'
  ) {
    if (!dependencies.pluginEval) throw new Error('Plugin eval unavailable')
    return executeClaudePluginEvalCommand(
      [
        ...(specialPrefix?.model === undefined
          ? []
          : ['--model', specialPrefix.model]),
        ...special.args.slice(2),
      ],
      io,
      dependencies.pluginEval,
      resolveDataPlaneRoot(),
      signal,
      resolveDataPlane(),
    )
  }
  if (special.args[0] === 'project' && special.args[1] === 'purge') {
    const projectPrefix = argv.slice(0, commandIndex)
    const prefixedPurgeOptions = projectPrefix.filter((value) =>
      PROJECT_PURGE_PREFIX_FLAGS.has(value),
    )
    return executeProjectPurgeCommand(
      ['project', 'purge', ...prefixedPurgeOptions, ...special.args.slice(2)],
      io,
    )
  }
  if (['install', 'update', 'upgrade'].includes(special.args[0] ?? '')) {
    return executeSelfUpdateCommand(
      [special.args[0] as string, ...special.args.slice(1)],
      io,
      dependencies,
      signal,
    )
  }
  if (printCommandHelp(argv, io)) return 0
  if (
    argv[0] === 'doctor' &&
    (argv.includes('--help') || argv.includes('-h'))
  ) {
    io.stdout(DOCTOR_HELP)
    return 0
  }
  if (
    argv[0] === 'mcp' &&
    argv.includes('add') &&
    (argv.includes('--help') || argv.includes('-h'))
  ) {
    io.stdout(MCP_ADD_HELP)
    return 0
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
  const command = args[0]
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
    'plugins',
    'doctor',
    'install',
    'update',
    'upgrade',
    'project',
    'import',
    'auth',
  ].includes(command ?? '')
  if (command === 'auth') {
    return (
      dependencies.executeProviderAuthCommand ?? executeProviderAuthCommand
    )(args, {
      io,
      configRoot: resolveDataPlaneRoot({ environment: process.env }),
      environment: process.env,
      ...(signal === undefined ? {} : { signal }),
      ...(invocation.authProfile === undefined
        ? {}
        : { profile: invocation.authProfile }),
      ...(invocation.providerProfile === undefined
        ? {}
        : { providerProfile: invocation.providerProfile }),
      noBrowser: invocation.mcpNoBrowser,
      json: invocation.legacyJson,
      device: invocation.authDevice,
    })
  }
  if (args[0] === 'agents') assertAgentsOptionAllowlist(argv)
  const interactiveResume =
    invocation.resumeSelector !== undefined &&
    args.length === (typeof invocation.resumeSelector === 'string' ? 2 : 1)
  const interactivePromptArgs =
    command === 'resume' && invocation.resumeSelector !== undefined
      ? args.slice(2)
      : !knownCommand
        ? args
        : []
  const interactivePrompt =
    interactivePromptArgs.length > 0
      ? promptFrom(interactivePromptArgs)
      : undefined
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
      cliPath: dependencies.cliPath ?? fileURLToPath(import.meta.url),
      ...(invocation.worktreeName === undefined
        ? {}
        : { worktreeName: invocation.worktreeName }),
      mode: invocation.tmux,
      attach: Boolean(io.isTTY),
    })
    if (!io.isTTY)
      io.stdout(
        launched.kind === 'iterm'
          ? `Started iTerm2 pane ${launched.sessionName}\n`
          : `Started tmux session ${launched.sessionName}\n`,
      )
    return 0
  }
  if (invocation.rewindFiles !== undefined && args.length > 2) {
    throw new Error(
      '--rewind-files is a standalone operation and cannot be used with a prompt',
    )
  }
  if (
    io.isTTY &&
    dependencies.runInteractive &&
    (args.length === 0 ||
      interactiveResume ||
      interactivePrompt !== undefined) &&
    !invocation.print &&
    !invocation.background &&
    !invocation.initOnly &&
    inputFormat === 'text' &&
    outputFormat === 'text'
  ) {
    return dependencies.runInteractive({
      ...(agent === undefined ? {} : { agent }),
      controls: invocation,
      ...(interactivePrompt === undefined
        ? {}
        : { initialPrompt: interactivePrompt }),
      resume: {
        ...(typeof invocation.resumeSelector === 'string'
          ? {
              sessionSelector: invocation.resumeSelector,
              ...(isClaudeSessionId(invocation.resumeSelector) ||
              resumePathSessionId(invocation.resumeSelector) !== undefined
                ? {
                    sessionId:
                      resumePathSessionId(invocation.resumeSelector) ??
                      invocation.resumeSelector,
                  }
                : {}),
            }
          : {}),
        ...(invocation.resumeSelector === undefined
          ? {}
          : { requireSession: true }),
        ...(invocation.fromPr === undefined
          ? {}
          : { fromPr: invocation.fromPr }),
        ...(invocation.forkSession ? { forkSession: true } : {}),
        ...(invocation.sessionId === undefined
          ? {}
          : { forkSessionId: invocation.sessionId }),
        ...(invocation.retryInterruptedTools
          ? { retryInterruptedTools: true }
          : {}),
      },
      ...(signal ? { signal } : {}),
    })
  }
  if (invocation.initOnly) {
    const lifecycleService = await dependencies.createService({
      eventSink: warningEventSink(io),
      requireProvider: false,
      exposeToolRegistry: true,
      ...(signal ? { signal } : {}),
      controls: invocation,
    })
    try {
      await lifecycleService.lifecycle?.('init', {
        sessionStart: true,
        ...(invocation.sessionId === undefined
          ? {}
          : { sessionId: invocation.sessionId }),
      })
      return 0
    } finally {
      await lifecycleService.close?.()
    }
  }
  const { retryInterruptedTools } = invocation
  if (command === 'resume' && args[1] === undefined) {
    if (invocation.resumeSelector === true) {
      throw new Error(missingResumeSelectorMessage(invocation))
    }
    requireValue(args[1], 'Session ID')
  }
  if (
    retryInterruptedTools &&
    command !== 'resume' &&
    invocation.fromPr === undefined
  ) {
    throw new Error(
      '--retry-interrupted-tools is only valid with resume or --from-pr',
    )
  }
  if (
    agent &&
    knownCommand &&
    !['run', 'resume', 'agents'].includes(command ?? 'run')
  ) {
    throw new Error('--agent is only valid with run or resume')
  }
  if (
    (invocation.agentsAll || invocation.agentsCwd !== undefined) &&
    command !== 'agents'
  ) {
    throw new Error('--all and --cwd are only valid with agents')
  }
  if (invocation.mcpScope !== undefined && command !== 'mcp') {
    if (command !== 'plugin' && command !== 'plugins') {
      throw new Error('--scope is only valid with mcp or plugin commands')
    }
  }
  const mcpAction = command === 'mcp' ? args[1] : undefined
  if (
    (invocation.mcpTransport !== undefined ||
      invocation.mcpEnv.length > 0 ||
      invocation.mcpHeaders.length > 0 ||
      invocation.mcpCallbackPort !== undefined ||
      invocation.mcpClientId !== undefined) &&
    mcpAction !== 'add'
  ) {
    throw new Error(
      '--transport, --env, --header, --callback-port, and --client-id are only valid with mcp add',
    )
  }
  if (
    invocation.mcpClientSecret &&
    mcpAction !== 'add' &&
    mcpAction !== 'add-json'
  ) {
    throw new Error('--client-secret is only valid with mcp add or add-json')
  }
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
    return executeAutoModeCommand(args, invocation, io, dependencies, signal)
  }
  if (
    invocation.autoModeLabel !== undefined &&
    !(command === 'auto-mode' && args[1] === 'defaults')
  ) {
    throw new Error('--label is only valid with auto-mode defaults')
  }
  if (
    invocation.pluginSparsePaths.length > 0 &&
    !(
      (command === 'plugin' || command === 'plugins') &&
      args[1] === 'marketplace' &&
      args[2] === 'add'
    )
  ) {
    throw new Error('--sparse is only valid with plugin marketplace add')
  }
  if (command === 'plugin' || command === 'plugins') {
    return executePluginCommand(
      command === 'plugins' ? ['plugin', ...args.slice(1)] : args,
      invocation,
      io,
    )
  }
  if (command === 'doctor') {
    return executeDoctorCommand(args, invocation, io)
  }
  if (command === 'import') {
    throw new Error(
      'Praxis import does not yet support Codex or Gemini configuration; no files were changed',
    )
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
    if (invocation.legacyJson) {
      const agents = await requireTopLevelAgentManager(
        dependencies,
        invocation.dataPlane ?? resolveDataPlane(),
      ).list({
        ...(invocation.agentsCwd === undefined
          ? {}
          : { cwd: invocation.agentsCwd }),
        all: invocation.agentsAll,
      })
      writeJson(io, agents)
      return 0
    }
    if (!io.isTTY) {
      throw new Error(
        "'praxis agents' requires an interactive terminal (stdout is not a TTY) — use 'praxis agents --json' for a machine-readable listing.",
      )
    }
    const manager = requireTopLevelAgentManager(
      dependencies,
      invocation.dataPlane ?? resolveDataPlane(),
    )
    if (!dependencies.runAgentsDashboard) {
      throw new Error('Agents dashboard unavailable')
    }
    return dependencies.runAgentsDashboard({
      manager,
      defaults: {
        argv: agentDashboardWorkerArgv(invocation),
        ...(invocation.agentsCwd === undefined
          ? {}
          : { cwd: invocation.agentsCwd }),
      },
      ...(signal ? { signal } : {}),
    })
  }
  if (command === 'logs') {
    io.stdout(
      await requireTopLevelAgentManager(
        dependencies,
        invocation.dataPlane ?? resolveDataPlane(),
      ).logs(requireValue(args[1], 'Agent ID')),
    )
    return 0
  }
  if (command === 'stop') {
    const id = requireValue(args[1], 'Agent ID')
    await requireTopLevelAgentManager(
      dependencies,
      invocation.dataPlane ?? resolveDataPlane(),
    ).stop(id)
    io.stdout(`stopped ${id}\n`)
    return 0
  }
  if (command === 'attach') {
    const input = io.readStdinLines?.()
    if (!input) throw new Error('attach requires stdin support')
    await requireTopLevelAgentManager(
      dependencies,
      invocation.dataPlane ?? resolveDataPlane(),
    ).attach(
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
    const explicitResumeSelector =
      command === 'resume' ? requireValue(args[1], 'Session ID') : undefined
    let resumeSessionId: string | undefined
    let usedExplicitSessionId = false
    if (
      explicitResumeSelector !== undefined ||
      invocation.continueSession ||
      invocation.fromPr !== undefined
    ) {
      const sessionService = await dependencies.createService({
        eventSink: () => undefined,
        requireProvider: false,
        controls: invocation,
      })
      try {
        if (explicitResumeSelector !== undefined) {
          resumeSessionId = (
            await resolveExplicitResumeSession(
              sessionService,
              explicitResumeSelector,
              invocation,
            )
          ).sessionId
        } else {
          const sessions = await sessionService.sessions()
          resumeSessionId = (
            await selectImplicitResumeSession(
              sessions,
              invocation.fromPr,
              liveTopLevelSessions(
                dependencies,
                invocation.dataPlane ?? resolveDataPlane(),
              ),
            )
          ).sessionId
        }
        if (invocation.forkSession) {
          resumeSessionId = (
            await sessionService.fork(resumeSessionId, invocation.sessionId)
          ).sessionId
          usedExplicitSessionId = invocation.sessionId !== undefined
        }
      } finally {
        await sessionService.close?.()
      }
    }
    if (invocation.sessionId && !usedExplicitSessionId) {
      io.stderr(
        'warning: --bg manages the session id; ignoring --session-id (use --resume <id> to continue an existing session)\n',
      )
    }
    const launched = await requireTopLevelAgentManager(
      dependencies,
      invocation.dataPlane ?? resolveDataPlane(),
    ).launch({
      prompt,
      argv: backgroundWorkerArgv(argv),
      ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
    })
    io.stdout(backgroundLaunchMessage(launched.id))
    return 0
  }
  let streamOutput: StreamJsonOutput | undefined
  let jsonModelTurns = 0
  let jsonRequestAt: number | undefined
  let jsonOutputAt: number | undefined
  let jsonTerminalReason: ModelTerminalReason | undefined
  const pendingEvents: Parameters<RuntimeEventSink>[0][] = []
  let streamIterator: AsyncGenerator<StreamJsonMessage> | undefined
  let firstStreamMessage: StreamUserMessage | undefined
  let streamInputExhausted = false
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
  const headlessPromptArgs =
    command === 'resume' ? args.slice(2) : knownCommand ? args.slice(1) : args
  const headlessTurnReached =
    invocation.rewindFiles === undefined &&
    !['sessions', 'fork', 'inspect', 'export'].includes(command ?? 'run')
  const argvHeadlessPrompt =
    inputFormat === 'text' && headlessPromptArgs.length > 0
      ? promptFrom(headlessPromptArgs)
      : undefined
  const headlessPrompt =
    inputFormat === 'text' && headlessTurnReached && invocation.print
      ? await resolvePrintTextPrompt(io, argvHeadlessPrompt)
      : argvHeadlessPrompt
  if (headlessPrompt === '/release-notes' && !invocation.disableSlashCommands) {
    const startedAt = Date.now()
    const sessionId = invocation.sessionId ?? randomUUID()
    const dataPlane = invocation.dataPlane ?? resolveDataPlane()
    const { configRoot, statePath } =
      resolveInteractiveRuntimeSettingsLocation(dataPlane)
    const runtimeSettings = await loadRuntimeSettings({
      configRoot,
      statePath,
    })
    const text = dependencies.loadReleaseNotes
      ? await dependencies.loadReleaseNotes(configRoot)
      : await loadClaudeReleaseNotes({ configRoot })
    const result: SessionRunResult = {
      sessionId,
      text,
      usage: { inputTokens: 0, outputTokens: 0 },
    }
    const info: CliRuntimeInfo = {
      cwd: process.cwd(),
      model:
        resolveRuntimeModel(invocation.model, process.env, runtimeSettings) ??
        'unknown',
      tools: [],
      mcpServers: [],
      permissionMode: invocation.permissionMode,
      slashCommands: ['release-notes'],
      agents: [],
      skills: [],
      claudeCodeVersion: '2.1.208',
    }
    if (outputFormat === 'stream-json') {
      const output = new StreamJsonOutput(
        (value) => writeJson(io, value),
        info,
        sessionId,
        {
          includePartialMessages,
          includeHookEvents: invocation.includeHookEvents,
          emitSessionStateEvents:
            process.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS === '1',
        },
      )
      output.init()
      output.sink({ type: 'text-delta', delta: text })
      output.sink({ type: 'usage', usage: result.usage })
      output.result(result, startedAt, { localCommand: true })
    } else if (outputFormat === 'json' || invocation.legacyJson) {
      writeJson(
        io,
        createSuccessResult(result, info, startedAt, 0, { localCommand: true }),
      )
    } else {
      io.stdout(`${text}\n`)
    }
    return 0
  }
  if (streamIterator && headlessTurnReached) {
    const first = await nextStreamUser()
    if (first) firstStreamMessage = first
    else streamInputExhausted = true
  }
  const firstHeadlessPrompt = firstStreamMessage?.prompt ?? headlessPrompt
  const firstTurnIsLocalColor =
    !invocation.disableSlashCommands &&
    firstHeadlessPrompt !== undefined &&
    matchHeadlessColorCommand(firstHeadlessPrompt) !== undefined
  const firstTurnIsLocalCost =
    !invocation.disableSlashCommands &&
    firstHeadlessPrompt !== undefined &&
    isHeadlessCostCommand(firstHeadlessPrompt)
  const service = await dependencies.createService({
    eventSink:
      outputFormat === 'stream-json' && !invocation.legacyJson
        ? (event) => {
            if (event.type === 'warning') {
              io.stderr(
                `Warning: ${redactSensitiveText(
                  event.message,
                  sensitiveEnvironmentValues(process.env),
                )}\n`,
              )
              return
            }
            const safeEvent =
              event.type === 'failed'
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
                if (jsonRequestAt === undefined) jsonRequestAt = Date.now()
              }
              if (event.type === 'terminal') {
                jsonTerminalReason = event.reason
              }
              if (
                (event.type === 'text-delta' ||
                  event.type === 'thinking-start' ||
                  event.type === 'thinking-delta' ||
                  event.type === 'thinking-signature-delta' ||
                  event.type === 'thinking-stop' ||
                  event.type === 'tool-call') &&
                jsonOutputAt === undefined
              ) {
                jsonOutputAt = Date.now()
              }
              if (event.type === 'warning') {
                io.stderr(
                  `Warning: ${redactSensitiveText(
                    event.message,
                    sensitiveEnvironmentValues(process.env),
                  )}\n`,
                )
              }
            }
          : eventSink(
              io,
              outputFormat,
              invocation.legacyJson,
              invocation.print && inputFormat === 'text',
            ),
    requireProvider:
      !streamInputExhausted &&
      !firstTurnIsLocalColor &&
      !firstTurnIsLocalCost &&
      headlessTurnReached,
    ...(retryInterruptedTools ? { approveRecovery: () => true } : {}),
    ...(streamIterator ? { approveTool: approveStreamTool } : {}),
    ...(streamIterator ? { onElicitation: respondStreamElicitation } : {}),
    ...(streamIterator ? { emitToolUseSummaries: true } : {}),
    ...(signal ? { signal } : {}),
    ...(agent ? { agent } : {}),
    controls: invocation,
  })
  const costBaselines = new Map<string, ClaudeSessionCostSnapshot>()
  const ensureCostBaseline = async (sessionId: string): Promise<void> => {
    if (!service.costSnapshot || costBaselines.has(sessionId)) return
    costBaselines.set(sessionId, await service.costSnapshot(sessionId))
  }
  try {
    const lifecycleTrigger = invocation.init
      ? 'init'
      : invocation.maintenance
        ? 'maintenance'
        : undefined
    if (lifecycleTrigger !== undefined) {
      await service.lifecycle?.(lifecycleTrigger, {
        ...(invocation.sessionId === undefined
          ? {}
          : { sessionId: invocation.sessionId }),
      })
    }
    if (invocation.rewindFiles !== undefined) {
      const sessionId = requireValue(args[1], 'Session ID')
      if (!service.rewindFiles) throw new Error('File rewinding is unavailable')
      await service.rewindFiles(sessionId, invocation.rewindFiles)
      io.stdout(`Files rewound to state at message ${invocation.rewindFiles}\n`)
      return 0
    }
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

    const dataPlane = invocation.dataPlane ?? resolveDataPlane()
    const { configRoot, statePath } =
      resolveInteractiveRuntimeSettingsLocation(dataPlane)
    const runtimeSettings = await loadRuntimeSettings({
      configRoot,
      statePath,
    })
    const runtimeInfo = service.runtimeInfo?.() ?? {
      cwd: process.cwd(),
      model:
        resolveRuntimeModel(invocation.model, process.env, runtimeSettings) ??
        'unknown',
      tools: [],
      mcpServers: [],
      permissionMode: 'default',
      slashCommands: [],
      agents: [],
      skills: [],
      claudeCodeVersion: 'unknown',
    }
    const explicitResumeSelector =
      command === 'resume' ? requireValue(args[1], 'Session ID') : undefined
    let existingSessionId: string | undefined
    if (
      explicitResumeSelector !== undefined ||
      invocation.continueSession ||
      invocation.fromPr !== undefined
    ) {
      if (explicitResumeSelector === undefined) {
        existingSessionId = (
          await selectImplicitResumeSession(
            await service.sessions(),
            invocation.fromPr,
            liveTopLevelSessions(dependencies, dataPlane),
          )
        ).sessionId
      } else {
        existingSessionId = (
          await resolveExplicitResumeSession(
            service,
            explicitResumeSelector,
            invocation,
          )
        ).sessionId
      }
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
        {
          includePartialMessages,
          includeHookEvents: invocation.includeHookEvents,
          emitSessionStateEvents:
            process.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS === '1',
        },
      )
    }
    if (streamInputExhausted) return 0
    const initialPrompt =
      firstStreamMessage?.prompt ??
      headlessPrompt ??
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
      jsonModelTurns = 0
      jsonRequestAt = undefined
      jsonOutputAt = undefined
      jsonTerminalReason = undefined
      if (streamOutput) {
        streamOutput.init(startedAt)
        if (isFirstTurn) {
          for (const event of pendingEvents) streamOutput.sink(event)
        }
        if (invocation.replayUserMessages && streamMessage)
          streamOutput.replayUser(streamMessage.message)
      }
      let result: ProtocolResult
      let colorArgs: string | undefined
      let costTurn = false
      try {
        await ensureCostBaseline(activeSessionId)
        costTurn =
          !invocation.disableSlashCommands && isHeadlessCostCommand(prompt)
        colorArgs = invocation.disableSlashCommands
          ? undefined
          : matchHeadlessColorCommand(prompt)
        if (costTurn) {
          if (!service.costSnapshot) {
            throw new Error('Session cost is unavailable.')
          }
          const current = await service.costSnapshot(activeSessionId)
          const delta = costSummaryDelta(
            current,
            costBaselines.get(activeSessionId),
          )
          const modelUsageEntries = delta.modelUsage.map((entry) => [
            entry.model,
            {
              inputTokens: entry.inputTokens,
              outputTokens: entry.outputTokens,
              ...(entry.cacheReadInputTokens === undefined
                ? {}
                : { cacheReadInputTokens: entry.cacheReadInputTokens }),
              ...(entry.cacheCreationInputTokens === undefined
                ? {}
                : { cacheCreationInputTokens: entry.cacheCreationInputTokens }),
              ...(entry.webSearchRequests === undefined
                ? {}
                : { webSearchRequests: entry.webSearchRequests }),
            },
          ])
          result = {
            sessionId: activeSessionId,
            text: formatCostSummary(delta),
            usage: { inputTokens: 0, outputTokens: 0 },
            durationApiMs: 0,
            costUsd: delta.totalCostUsd,
            modelUsage: Object.fromEntries(modelUsageEntries),
            modelCostUsd: Object.fromEntries(
              delta.modelUsage.map((entry) => [entry.model, entry.costUsd]),
            ),
          }
        } else if (colorArgs !== undefined) {
          if (!service.recordColorUsage) {
            throw new Error('Session color is unavailable.')
          }
          const selection = parseAgentColorInput(colorArgs)
          const localSessionId = await service.recordColorUsage(
            activeSessionId,
            selection,
            prompt,
            invocation.permissionMode,
            isFirstTurn && existingSessionId === undefined
              ? { createSession: true }
              : undefined,
          )
          result = {
            sessionId: localSessionId,
            text: agentColorMessage(selection),
            usage: { inputTokens: 0, outputTokens: 0 },
            durationApiMs: 0,
            costUsd: 0,
            modelUsage: {},
          }
        } else {
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
        }
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
        const providerApiError =
          error instanceof ModelProviderError &&
          (error.status !== undefined || error.kind === 'api_error')
        const errorContext = providerApiError
          ? {
              providerApiError: true,
              apiErrorStatus:
                error instanceof ModelProviderError
                  ? (error.status ?? null)
                  : null,
            }
          : {}
        if (streamOutput) streamOutput.error(message, startedAt, errorContext)
        else if (outputFormat === 'json') {
          writeJson(
            io,
            createErrorResult(
              message,
              activeSessionId,
              startedAt,
              jsonModelTurns,
              errorContext,
            ),
          )
        } else if (
          invocation.print &&
          inputFormat === 'text' &&
          outputFormat === 'text'
        ) {
          io.stdout(formatPrintTextError(message, errorContext))
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
      await ensureCostBaseline(activeSessionId)
      const localCommand = colorArgs !== undefined || costTurn
      if (streamOutput) {
        if (localCommand) {
          streamOutput.syntheticAssistant(result.text)
        }
        streamOutput.result(result, startedAt, { localCommand })
      } else if (outputFormat === 'json') {
        const resultRuntimeInfo = service.runtimeInfo?.() ?? runtimeInfo
        writeJson(
          io,
          createSuccessResult(
            result,
            resultRuntimeInfo,
            startedAt,
            localCommand ? 0 : Math.max(1, jsonModelTurns),
            {
              localCommand,
              ...(jsonTerminalReason === undefined
                ? {}
                : { stopReason: jsonTerminalReason }),
              ...projectProtocolTimings(startedAt, jsonRequestAt, jsonOutputAt),
            },
          ),
        )
      } else if (outputFormat !== 'text')
        writeJson(io, { type: 'result', ...result })
      else if (invocation.print && inputFormat === 'text')
        io.stdout(`${result.text}\n`)
      else io.stdout(localCommand ? `${result.text}\n` : '\n')
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
  dependencies: CliDependencies = createDefaultDependencies(),
  signal?: AbortSignal,
): Promise<number> {
  try {
    return await execute(argv, io, dependencies, signal)
  } catch (error) {
    if (isCancellation(error, signal)) {
      if (isDirectProcessSigint(signal)) {
        try {
          if (parseCliInvocation(argv).print) return 0
        } catch {
          // Preserve the ordinary cancellation boundary when parsing fails.
        }
      }
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
