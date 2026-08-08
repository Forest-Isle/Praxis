#!/usr/bin/env node

import { realpathSync } from 'node:fs'
import { access, mkdir } from 'node:fs/promises'
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
import { loadClaudeDynamicContext } from './compatibility/claude/dynamic-context.js'
import {
  createClaudePrSessionFilter,
  filterClaudePrLinkedSessions,
} from './compatibility/claude/pr-links.js'
import {
  isClaudeSessionId,
  resolveClaudePaths,
} from './compatibility/claude/paths.js'
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
  type PermissionApproval,
  type ToolRegistry,
  type RuntimeEventSink,
} from './core/runtime.js'
import {
  runInteractive as renderInteractive,
  type InteractiveResumeOptions,
  type InteractiveServiceFactory,
} from './cli/interactive.js'
import { DEFAULT_CLI_CONTROLS, resolveCliControls } from './cli/controls.js'
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
  readMcpClientSecret,
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
import { executeClaudePluginMaintenanceCommand } from './plugins/claude-plugin-maintenance.js'
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

function createProviderForModel(
  apiKey: string,
  providerEnvironment: ReturnType<typeof parseProviderEnvironment>,
  context: ReturnType<typeof parseContextEnvironment>,
  controls: Pick<CliControls, 'thinking' | 'maxThinkingTokens'>,
): (selectedModel: string) => ModelProvider {
  return (selectedModel) => {
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
          thinking: {
            mode: controls.thinking ?? 'enabled',
            ...(controls.maxThinkingTokens === undefined
              ? {}
              : { maxTokens: controls.maxThinkingTokens }),
          },
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
      : new OpenAICompatibleProvider({
          ...providerOptions,
          ...(controls.thinking === undefined &&
          controls.maxThinkingTokens === undefined
            ? {}
            : {
                thinking: {
                  mode: controls.thinking ?? 'enabled',
                  ...(controls.maxThinkingTokens === undefined
                    ? {}
                    : { maxTokens: controls.maxThinkingTokens }),
                },
              }),
        })
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
  praxis mcp <list|get|add|add-json|remove|reset-project-choices|login|logout|serve> ...
  praxis auto-mode <config|defaults|critique>
  praxis plugin|plugins <details|list|install|uninstall|enable|disable|update|init|validate|marketplace> ...
  praxis doctor [--json]
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
  --model <model>                     Select model for this session
  --effort <level>                    low, medium, high, xhigh, or max
  --thinking <mode>                   enabled, adaptive, or disabled
  --max-thinking-tokens <tokens>      Cap extended-thinking tokens
  --fallback-model <models>           Comma-separated print-mode fallbacks
  --json-schema <schema>              Print-mode JSON Schema for structured output
  --max-budget-usd <amount>           Maximum print-mode API spend
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
  --system-prompt <prompt>            Set system prompt
  --append-system-prompt <prompt>     Append system prompt
  --exclude-dynamic-system-prompt-sections
                                      Move cwd, environment, memory path, and git status into first user message
                                      (default system prompt only; ignored with --system-prompt)
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

const AGENTS_HELP = `Usage: praxis agents [options]

List persistent background agents managed by Praxis.

Options:
  --all         Include completed agents as well as active agents
  --cwd <path>  Show agents started under this directory
  --json        Print agent records as JSON for scripting
  -h, --help    Display help for command
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
  --scope <scope>  Configuration scope: local, project, or user (default: local)
  --json           Print a machine-readable mcp-added result
  -h, --help        Display help for command
`

const MCP_REMOVE_HELP = `Usage: praxis mcp remove [options] <name>

Remove an MCP server. Without --scope, Praxis resolves the configured server
across available scopes.

Options:
  --scope <scope>  Remove from local, project, or user scope
  --json           Print a machine-readable mcp-removed result
  -h, --help        Display help for command
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
  init|new [options] <name>         Scaffold ~/.claude/skills/<name>
  validate [options] <path>         Validate a plugin or marketplace manifest
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
  --config <key=value>  Set a declared userConfig option (repeatable)
  --scope <scope>  Install native marketplace plugin at local, project, or user scope (default: user)
  --json           Print a machine-readable plugin-installed result
  -h, --help        Display help for command
`

const PLUGIN_UNINSTALL_HELP = `Usage: praxis plugin uninstall [options] <name-or-plugin@marketplace>

Uninstall a local plugin or a native marketplace plugin.

Options:
  --keep-data      Preserve the plugin's persistent data directory
  --prune          Also remove unused auto-installed dependencies
  --scope <scope>  Select native plugin scope: local, project, or user
  -y, --yes        Skip the --prune confirmation prompt
  --json           Print a machine-readable plugin-uninstalled result
  -h, --help        Display help for command
`

const PLUGIN_ENABLE_HELP = `Usage: praxis plugin enable [options] <name-or-plugin@marketplace>

Enable a disabled local plugin or native marketplace plugin.

Options:
  --all            Disable all enabled plugins
  --scope <scope>  Select native plugin scope: local, project, or user
  --json           Print a machine-readable plugin-enabled result
  -h, --help        Display help for command
`

const PLUGIN_DISABLE_HELP = `Usage: praxis plugin disable [options] <name-or-plugin@marketplace>

Disable an enabled local plugin or native marketplace plugin.

Options:
  --scope <scope>  Select native plugin scope: local, project, or user
  --json           Print a machine-readable plugin-disabled result
  -h, --help        Display help for command
`

const PLUGIN_UPDATE_HELP = `Usage: praxis plugin update [options] <name-or-plugin@marketplace>

Update a local plugin or native marketplace plugin from its configured source.

Options:
  --scope <scope>  Select native plugin scope: local, project, or user
  --json           Print a machine-readable plugin-updated result
  -h, --help        Display help for command
`

const PLUGIN_INIT_HELP = `Usage: praxis plugin init|new [options] <name>

Scaffold a plugin at ~/.claude/skills/<name>. The legacy
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
  validate: PLUGIN_VALIDATE_HELP,
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
  --scope <scope>  Configuration scope: local, project, or user (default: user)
  --json           Print a machine-readable plugin-marketplace-added result
  -h, --help        Display help for command
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

Inspect auto mode classifier configuration and critique custom rules.

Options:
  -h, --help  Display help for command

Commands:
  config              Print effective auto mode config as JSON
  defaults             Print default environment, allow, soft_deny, and hard_deny rules as JSON
  critique [options]  Get provider-backed feedback on custom auto mode rules
`

const AUTO_MODE_CONFIG_HELP = `Usage: praxis auto-mode config

Print effective auto mode configuration as JSON. Settings values override
defaults; omitted rule lists retain their default values.

Options:
  -h, --help  Display help for command
`

const AUTO_MODE_DEFAULTS_HELP = `Usage: praxis auto-mode defaults

Print default auto mode environment, allow, soft_deny, and hard_deny rules as
JSON.

Options:
  -h, --help  Display help for command
`

const AUTO_MODE_CRITIQUE_HELP = `Usage: praxis auto-mode critique [options]

Get provider-backed feedback on custom auto mode rules. With no custom rule
lists configured, Praxis prints guidance without creating a provider request.

Options:
  --model <model>  Override model used for critique (default: PRAXIS_MODEL)
  -h, --help       Display help for command
`

const AUTO_MODE_ACTION_HELP: Record<string, string> = {
  config: AUTO_MODE_CONFIG_HELP,
  defaults: AUTO_MODE_DEFAULTS_HELP,
  critique: AUTO_MODE_CRITIQUE_HELP,
}

const PROJECT_HELP = `Usage: praxis project [options] [command]

Manage Praxis-compatible Claude project state.

Options:
  -h, --help  Display help for command

Commands:
  purge [options] [path]  Delete Claude project state for a path (default: current project)
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
  rewindFiles?(sessionId: string, userMessageId: string): Promise<void>
  lifecycle?(
    trigger: 'init' | 'maintenance',
    options?: { sessionStart?: boolean; sessionId?: string },
  ): Promise<void>
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
    approveTool?: (
      call: ModelToolCall,
      originalCall?: ModelToolCall,
    ) => PermissionApproval | Promise<PermissionApproval>
    agent?: string
    controls?: CliControls
    interactive?: boolean
    sessionKind?: 'bg'
    signal?: AbortSignal
    exposeToolRegistry?: boolean
    emitToolUseSummaries?: boolean
    onElicitation?: (
      request: CliElicitationRequest,
    ) => Promise<CliElicitationResult>
  }): Promise<SessionCommands>
  createAutoModeCritic?(options: { model?: string }): Promise<ModelProvider>
  runInteractive?(options: {
    agent?: string
    controls?: CliControls
    resume?: InteractiveResumeOptions & { fromPr?: string | true }
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
  emitToolUseSummaries = false,
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
  const context = parseContextEnvironment(process.env)
  const apiKey = process.env.PRAXIS_API_KEY
  const model = cli.model ?? process.env.PRAXIS_MODEL
  const providerEnvironment =
    apiKey && model
      ? parseProviderEnvironment(process.env)
      : cli.fileResources.length > 0
        ? parseProviderEnvironment(process.env)
        : undefined
  const fileCredential =
    process.env.PRAXIS_FILES_BEARER_TOKEN ??
    process.env.PRAXIS_FILES_API_KEY ??
    apiKey
  if (cli.fileResources.length > 0 && !fileCredential) {
    throw new Error(
      '--file requires PRAXIS_FILES_BEARER_TOKEN, PRAXIS_FILES_API_KEY, or PRAXIS_API_KEY',
    )
  }
  if (requireProvider && (!apiKey || !model)) {
    throw new Error(
      'PRAXIS_API_KEY and a model (--model or PRAXIS_MODEL) are required',
    )
  }
  if (apiKey && model) {
    if (!providerEnvironment) {
      throw new Error('Provider environment is unavailable')
    }
    providerForModel = createProviderForModel(
      apiKey,
      providerEnvironment,
      context,
      cli,
    )
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
    eventSink: runtimeEventSink,
    sessionPersistence: cli.sessionPersistence,
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
    ...(cli.fileResources.length > 0
      ? {
          fileResources: cli.fileResources,
          fileResourceConfig: {
            cwd,
            apiKey: fileCredential ?? '',
            baseUrl:
              process.env.PRAXIS_FILES_BASE_URL ??
              fileResourceBaseUrl(process.env, providerEnvironment),
            headers: fileResourceHeaders(
              process.env,
              providerEnvironment,
              fileCredential ?? '',
            ),
          },
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
      runtimeEventSink({
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
    agents: [
      ...loadedResources.agents,
      ...pluginResources.agents,
      ...cli.inlineAgents,
    ],
    settings: [
      ...loadedResources.settings,
      ...pluginResources.settings,
      ...(cli.additionalSettings ? [cli.additionalSettings] : []),
    ],
    mcp: cli.strictMcpConfig
      ? cli.mcpResources
      : [...loadedResources.mcp, ...pluginResources.mcp, ...cli.mcpResources],
  }
  const extensions = new ClaudeExtensionCatalog(resources, {
    disableSlashCommands: cli.disableSlashCommands,
  })
  const memoryDirectory =
    cli.safeMode || cli.bare
      ? undefined
      : await resolveClaudeProjectMemoryDirectory({ configRoot, cwd })
  if (memoryDirectory) await mkdir(memoryDirectory, { recursive: true })
  const loadContextResources = (runtimeCwd = workspace.cwd()) =>
    loadClaudeContextResources({
      configRoot,
      cwd: runtimeCwd,
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
    onWarning: (message) => runtimeEventSink({ type: 'warning', message }),
    ...(onElicitation ? { onElicitation } : {}),
    eventSink: runtimeEventSink,
    ...(signal ? { signal } : {}),
  })
  try {
    const permissionApprover = cli.permissionPromptTool
      ? mcpTools.permissionPrompt(cli.permissionPromptTool)
      : approveTool
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
    const hooks =
      cli.safeMode || cli.bare
        ? undefined
        : new ClaudeHookRunner({
            settings,
            cwd,
            onEvent: (event) => runtimeEventSink({ type: 'hook', event }),
          })
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
      emitToolUseSummaries,
      enableWorktrees:
        cli.worktreeRequested || selectedWorktreeTools.length > 0,
      worktreeToolNames: selectedWorktreeTools,
      ...(hooks ? { hooks } : {}),
      ...(agent ? { agent } : {}),
      contextAssembler: new ClaudeContextAssembler({
        loadResources: loadContextResources,
        loadDynamicContext: (runtimeCwd = workspace.cwd()) =>
          loadClaudeDynamicContext({
            cwd: runtimeCwd,
            ...(memoryDirectory ? { memoryDirectory } : {}),
          }),
        excludeDynamicSystemPromptSections:
          cli.excludeDynamicSystemPromptSections,
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
      ...(permissionApprover ? { approveTool: permissionApprover } : {}),
      ...(approveRecovery ? { approveRecovery } : {}),
      fileCheckpointing:
        process.env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING === 'true',
      fileRewindRoots: [
        ...cli.additionalDirectories,
        ...(memoryDirectory ? [memoryDirectory] : []),
      ],
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
    let pendingResumeSessionAt = cli.resumeSessionAt
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
      fork: (sessionId, targetSessionId) => {
        const resumeSessionAt = pendingResumeSessionAt
        pendingResumeSessionAt = undefined
        return service.fork(sessionId, targetSessionId, resumeSessionAt)
      },
      rewindFiles: (sessionId, userMessageId) =>
        service.rewindFiles(sessionId, userMessageId),
      lifecycle: async (trigger, lifecycleOptions = {}) => {
        if (!hooks) return
        const sessionId = lifecycleOptions.sessionId ?? randomUUID()
        const runtimeCwd = workspace.cwd()
        const hookSession = {
          session_id: sessionId,
          transcript_path: resolveClaudePaths({
            cwd: runtimeCwd,
            sessionId,
            configDir: configRoot,
          }).sessionFile,
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
      inspect: (sessionId) => service.inspect(sessionId),
      export: (sessionId) => service.export(sessionId),
      nextScheduledPrompt: (signal) => service.nextScheduledPrompt(signal),
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
        await debug?.close()
        if (failure !== undefined) throw failure
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
    } finally {
      await debug?.close()
    }
    throw error
  }
}

const createDefaultAutoModeCritic: NonNullable<
  CliDependencies['createAutoModeCritic']
> = async ({ model }) => {
  const apiKey = process.env.PRAXIS_API_KEY
  const selectedModel = model ?? process.env.PRAXIS_MODEL
  if (!apiKey || !selectedModel) {
    throw new Error(
      'PRAXIS_API_KEY and a model (--model or PRAXIS_MODEL) are required',
    )
  }
  return createProviderForModel(
    apiKey,
    parseProviderEnvironment(process.env),
    parseContextEnvironment(process.env),
    {},
  )(selectedModel)
}

const defaultDependencies: CliDependencies = {
  createService: createDefaultService,
  createAutoModeCritic: createDefaultAutoModeCritic,
  runInteractive: ({ agent, controls, resume, signal }) =>
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
      ...(controls?.axScreenReader ? { axScreenReader: true } : {}),
      ...(resume === undefined ? {} : { resume }),
      ...(resume?.fromPr !== undefined
        ? {
            sessionFilter: createClaudePrSessionFilter<SessionSummary>(
              resume.fromPr,
            ),
            requireSession: true,
          }
        : resume?.sessionSelector === undefined
          ? {}
          : {
              sessionFilter: createResumeSessionFilter(resume.sessionSelector),
              requireSession: true,
              missingSessionMessage: isClaudeSessionId(resume.sessionSelector)
                ? `No conversation found with session ID: ${resume.sessionSelector}`
                : `No conversation found matching: ${resume.sessionSelector}`,
            }),
      ...(resume?.requireSession ? { requireSession: true } : {}),
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
  const configRoot = resolve(
    process.env.CLAUDE_CONFIG_DIR ?? resolve(homedir(), '.claude'),
  )
  await runTopLevelAgentWorker({
    configRoot,
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
    ? `line ${issue.lineNumber}, byte ${issue.byteOffset}: ${issue.message}`
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

function selectImplicitResumeSession(
  sessions: readonly SessionSummary[],
  fromPr: string | true | undefined,
): SessionSummary {
  if (fromPr !== undefined) return selectPrLinkedSession(sessions, fromPr)
  const latest = sessions[0]
  if (!latest) throw new Error('No conversation found to continue')
  return latest
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
  const action = args[1]
  if (!action || action === 'help') {
    io.stdout(AUTO_MODE_HELP)
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
  if (action === 'critique') {
    const configRoot = resolve(
      process.env.CLAUDE_CONFIG_DIR ?? resolve(homedir(), '.claude'),
    )
    const settings = await loadClaudeSettings({
      configRoot,
      cwd: process.cwd(),
    })
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
): Promise<Awaited<ReturnType<typeof describeClaudePlugin>>> {
  const [native, local] = await Promise.all([
    listNativePluginRecords(configRoot, cwd),
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
  const configRoot = resolve(
    process.env.CLAUDE_CONFIG_DIR ?? resolve(homedir(), '.claude'),
  )
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
    !['uninstall', 'prune', 'autoremove'].includes(action)
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
    const includeAvailable =
      invocation.pluginAvailable &&
      (invocation.legacyJson || invocation.outputFormat !== 'text')
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
      )
      const config = await saveClaudePluginConfig(
        configRoot,
        cwd,
        plugin.id,
        plugin.installPath,
        invocation.pluginConfig,
      )
      pluginOutput(io, invocation, {
        type: 'plugin-installed',
        plugin,
        ...(config.warnings.length === 0 ? {} : { warnings: config.warnings }),
      })
      return 0
    }
    const plugin = await installClaudePlugin(configRoot, source)
    const config = await saveClaudePluginConfig(
      configRoot,
      cwd,
      plugin.name,
      plugin.path,
      invocation.pluginConfig,
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
      )
    else
      await uninstallClaudePlugin(configRoot, name, !invocation.pluginKeepData)
    pluginOutput(io, invocation, { type: 'plugin-uninstalled', name: args[2] })
    return 0
  }
  if (action === 'enable' || action === 'disable') {
    if (action === 'disable' && invocation.pluginAll) {
      if (args.length !== 2) {
        throw new Error('plugin disable --all takes no plugin name')
      }
      if (requestedScope !== undefined) {
        throw new Error('--scope cannot be used with plugin disable --all')
      }
      const native = await disableAllNativePlugins(configRoot, cwd)
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
        ? await updateNativePlugin(configRoot, cwd, name, installScope)
        : await updateClaudePlugin(configRoot, name),
    })
    return 0
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
    ['agents', 'mcp', 'plugin', 'plugins', 'auto-mode', 'project'].includes(
      value,
    ),
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
  return false
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
  const pluginMaintenance = await executeClaudePluginMaintenanceCommand(argv, {
    configRoot: resolve(
      process.env.CLAUDE_CONFIG_DIR ?? resolve(homedir(), '.claude'),
    ),
    cwd: process.cwd(),
    io,
  })
  if (pluginMaintenance !== null) return pluginMaintenance
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
  const interactiveResume =
    invocation.resumeSelector !== undefined &&
    args.length === (typeof invocation.resumeSelector === 'string' ? 2 : 1)
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
    (args.length === 0 || interactiveResume) &&
    !invocation.print &&
    !invocation.background &&
    !invocation.initOnly
  ) {
    return dependencies.runInteractive({
      ...(agent === undefined ? {} : { agent }),
      controls: invocation,
      resume: {
        ...(typeof invocation.resumeSelector === 'string'
          ? {
              sessionSelector: invocation.resumeSelector,
              ...(isClaudeSessionId(invocation.resumeSelector)
                ? { sessionId: invocation.resumeSelector }
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
      eventSink: () => undefined,
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
  const command = args[0]
  if (command === 'resume' && args[1] === undefined) {
    if (invocation.resumeSelector === true) {
      throw new Error(missingResumeSelectorMessage(invocation))
    }
    requireValue(args[1], 'Session ID')
  }
  if (invocation.rewindFiles !== undefined && args.length > 2) {
    throw new Error(
      '--rewind-files is a standalone operation and cannot be used with a prompt',
    )
  }
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
  ].includes(command ?? '')
  if (
    retryInterruptedTools &&
    command !== 'resume' &&
    invocation.fromPr === undefined
  ) {
    throw new Error(
      '--retry-interrupted-tools is only valid with resume or --from-pr',
    )
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
      invocation.mcpClientId !== undefined ||
      invocation.mcpClientSecret) &&
    mcpAction !== 'add'
  ) {
    throw new Error(
      '--transport, --env, --header, --callback-port, --client-id, and --client-secret are only valid with mcp add',
    )
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
        const sessions = await sessionService.sessions()
        if (explicitResumeSelector !== undefined) {
          resumeSessionId = selectResumeSession(
            sessions,
            explicitResumeSelector,
            invocation,
          ).sessionId
        } else {
          resumeSessionId = selectImplicitResumeSession(
            sessions,
            invocation.fromPr,
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
              if (event.type === 'warning') {
                io.stderr(
                  `Warning: ${redactSensitiveText(
                    event.message,
                    sensitiveEnvironmentValues(process.env),
                  )}\n`,
                )
              }
            }
          : eventSink(io, outputFormat, invocation.legacyJson),
    requireProvider:
      invocation.rewindFiles === undefined &&
      !['fork', 'sessions', 'inspect', 'export'].includes(command ?? 'run'),
    ...(retryInterruptedTools ? { approveRecovery: () => true } : {}),
    ...(streamIterator ? { approveTool: approveStreamTool } : {}),
    ...(streamIterator ? { onElicitation: respondStreamElicitation } : {}),
    ...(streamIterator ? { emitToolUseSummaries: true } : {}),
    ...(signal ? { signal } : {}),
    ...(agent ? { agent } : {}),
    controls: invocation,
  })
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
    const explicitResumeSelector =
      command === 'resume' ? requireValue(args[1], 'Session ID') : undefined
    let existingSessionId: string | undefined
    if (
      explicitResumeSelector !== undefined ||
      invocation.continueSession ||
      invocation.fromPr !== undefined
    ) {
      const sessions = await service.sessions()
      existingSessionId =
        explicitResumeSelector === undefined
          ? selectImplicitResumeSession(sessions, invocation.fromPr).sessionId
          : selectResumeSession(sessions, explicitResumeSelector, invocation)
              .sessionId
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
