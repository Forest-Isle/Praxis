# Praxis

[English](README.md) | [简体中文](README_zh.md)

[![CI](https://github.com/Forest-Isle/Praxis/actions/workflows/ci.yml/badge.svg)](https://github.com/Forest-Isle/Praxis/actions/workflows/ci.yml)
[![CodeQL](https://github.com/Forest-Isle/Praxis/actions/workflows/codeql.yml/badge.svg)](https://github.com/Forest-Isle/Praxis/actions/workflows/codeql.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/Forest-Isle/Praxis/badge)](https://scorecard.dev/viewer/?uri=github.com/Forest-Isle/Praxis)
[![npm](https://img.shields.io/npm/v/praxis-agent)](https://www.npmjs.com/package/praxis-agent)
[![npm provenance](https://img.shields.io/badge/npm-provenance-blue)](https://www.npmjs.com/package/praxis-agent)
[![license](https://img.shields.io/github/license/Forest-Isle/Praxis)](https://github.com/Forest-Isle/Praxis/blob/main/LICENSE)

Praxis is a local-first, single-user general agent for the command line.

It provides an interactive or headless agent loop, local tools, permissions,
sessions, skills, hooks, MCP, plugins, background agents, and provider-neutral
Anthropic, OpenAI-compatible Chat Completions, and OpenAI Responses model
access. Praxis deliberately excludes
accounts, organizations, billing, managed enterprise policy, remote control,
IDE surfaces, and telemetry control planes.

Claude Code 2.1.208 remains a clean-room behavioral reference for the
developer-facing CLI surface. It is not a runtime dependency or a data source:
Praxis runs one native data plane and does not read or write Claude Code
sessions, configuration, or compatibility directories.

## Requirements

- macOS or Linux
- Node.js 24 or newer
- [`ripgrep`](https://github.com/BurntSushi/ripgrep) (`rg`) for the Grep and Glob tools
- an API key and model ID for an Anthropic, OpenAI-compatible, or OpenAI
  Responses provider (the stable setup), or the explicitly enabled experimental
  ChatGPT-backed Codex subscription integration

Praxis does not use Claude subscription authentication. Claude-shaped message,
tool, and CLI protocol forms remain supported where they are part of the
public surface, while all persisted state is Praxis-native.

Team operations are local-only and opt-in. Unsupported or lossy Team payloads
are rejected rather than silently simplified.

## Install

```sh
npm install --global praxis-agent
praxis --version
```

Release tarballs, SBOMs, SHA-256 checksums, and build attestations are attached
to every [GitHub release](https://github.com/Forest-Isle/Praxis/releases).
Use `praxis update` for transactional self-updates; see [Getting Started](https://github.com/Forest-Isle/Praxis/blob/main/docs/GETTING_STARTED.md) for recovery and verification details.

## Quick start

OpenAI or an OpenAI-compatible endpoint is the default provider:

```sh
export PRAXIS_API_KEY="your-api-key"
export PRAXIS_MODEL="your-model-id"
# Optional for a compatible gateway:
# export PRAXIS_BASE_URL="https://api.example.com/v1"

cd /path/to/project
praxis
```

To use OpenAI's Responses API with an explicit API-key provider:

```sh
export PRAXIS_PROVIDER="openai-responses"
export OPENAI_API_KEY="your-api-key"
export PRAXIS_MODEL="your-responses-model-id"

cd /path/to/project
praxis
```

The `openai` provider remains OpenAI-compatible Chat Completions. Provider
protocols are selected explicitly; model IDs never switch protocols implicitly.

Praxis also has an experimental `openai-codex` provider for ChatGPT-backed
Codex subscriptions. It is separate from OpenAI API-key access, requires
`experimental.codexSubscription: true`, and stores OAuth credentials in the
native Vault. Start with `praxis auth login openai-codex`; see [Getting
Started](docs/GETTING_STARTED.md) for the browser/device flow and limitations.
This uses an undocumented third-party subscription/backend contract and may
change; it is not Claude subscription authentication. Subscription runs retain
token usage but do not provide API-dollar cost or enforce USD budgets.

For Anthropic Messages:

```sh
export PRAXIS_PROVIDER="anthropic"
export PRAXIS_API_KEY="your-api-key"
export PRAXIS_MODEL="claude-sonnet-4-20250514"

cd /path/to/project
praxis
```

Common non-interactive operations:

```sh
praxis -p "Inspect this project"
praxis -p --output-format json "Summarize the test failures"
praxis --resume
praxis sessions --json
praxis doctor
```

See
[Getting Started](https://github.com/Forest-Isle/Praxis/blob/main/docs/GETTING_STARTED.md)
for provider setup, shared Praxis state, permissions, updating, and
troubleshooting. Run `praxis --help` for the authoritative command surface.

## What Praxis provides

- **Outcome-driven evaluation** — `praxis eval <target>` runs contained cases
  in isolated workspaces, requires explicit verifier authorization, and writes
  versioned artifacts locally; usage and cost remain explicitly available or
  unknown. Separate runs can be compared with `praxis eval compare`; unknown
  token/cost evidence produces null deltas, while the gate requires no pass-rate
  or safety-rate regression and rejects incomplete safety evidence.
- **Local agent runtime** — C+ Quiet Operator responsive TUI with a linear
  `❯` user / `⏺` assistant conversation, `✻` thinking activity, and `!` shell
  composer grammar, compact stable tool rows, responsive density,
  terminal-native background, and a minimal composer/status row. Successful
  background Bash completion bursts collapse in normal reading, while
  failed/stopped notifications remain detailed.
  Prompt-like background Bash output that remains unchanged for 50 seconds
  raises one warning and model follow-up without stopping or reclassifying the
  running task; silent and ordinary output remain quiet.
  Interactive surfaces share the same presentation across terminals, with English
  permission/configuration choices and a taught `❯` / Up/Down / Enter / Esc
  interaction grammar. While a regular turn is active, the composer remains
  editable: Enter steers at the next safe continuation boundary, Tab or
  Alt+Enter queues a sequential follow-up turn, and pending input stays visible
  and can be withdrawn with Up. The TUI also includes a
  shared-command
  slash palette, tabbed help and shortcut surfaces, searchable resume picker,
  restored active-branch conversation history, streaming and expandable
  thinking, grouped multi-file reads, globally expandable tool results,
  command-specific `/add-dir`, code-aware `/copy`, `/branch`, `/rename`, `/export`,
  provider-free read-only shared `/hooks`, provider-backed `/compact`, native
  `/rewind`, runtime `/cd`, transcript-free
  `/btw` side questions with background-Agent handoff, interactive
  `/background` terminal handoff, unified `/status`/`/config`/`/usage` settings
  tabs, `/sandbox` mode/dependency/override/config controls, local cached
  `/release-notes`, Claude-compatible `/statusline` command execution and setup
  agent, source-aligned `/init` project-instruction onboarding with its enhanced
  skills/hooks flow, provider-free per-session `/color` prompt-bar styling,
  `/mcp`, `/memory` shared instruction and auto-memory
  access, and live extension-reload controls,
  plus automatic fallback when a terminal renderer fails, screen-reader
  support, and no-color output,
  cursor/history composer, provider-free `/cost` usage and pricing summaries,
  with a hermetic PTY smoke covering real `runInteractive` ANSI entry,
  resize-safe lifecycle, Ctrl-C restoration, fullscreen `Ctrl+L` redraw, and
  mouse-wheel/drag selection with edge autoscroll and OSC 52 copy,
  interactive `/doctor` diagnostics, per-session model/effort/permission controls,
  context/status/skill/task dashboards, prompt stash and continuation shortcuts,
  filterable `@` file and agent references, composer undo, `Ctrl+G` external
  editing, shared `/keybindings` creation/editing and supported-action remapping,
  shared built-in and custom `/theme` profiles with immediate
  semantic recoloring, token editing/reset, deletion, and persisted syntax
  toggles across transcript code and diff views,
  shared runtime preferences for reduced motion, spinner tips, progress and
  turn-duration display, editor mode, recap, notifications, auto-update channel,
  gitignore-aware file references, and configurable AskUserQuestion timeouts,
  provider-free `/terminal-setup` diagnostics and repeatable Shift+Enter setup
  for supported local terminals,
  `Ctrl+V` text/image clipboard paste, `Ctrl+Z` shell suspension and `fg`
  recovery, permission-gated provider-free `!` shell turns that persist shell
  input/output for later ordinary prompts without creating an assistant turn,
  navigable session-start/current-per-turn Git diff views with bounded per-file
  patches and readable binary/conflict/transient-path notes, semantic plan/question decision panels with complete
  screen-reader actions, semantic screen projection across selectable surfaces,
  deterministic resize-aware URL/form elicitation rendering, and measured
  context budgets; print mode,
  structured JSON/JSONL, context compaction, tool loops, and bounded execution.
- **Built-in tools** — read, write, edit, `ApplyPatch` for bounded ordered exact
  multi-file replacements, configured plugin LSP navigation with fresh bounded
  diagnostics after successful edits, glob, search, shell, notebook, PDF,
  image, web, scheduled prompts, workflows, and worktrees.
- **Shell lifecycle** — foreground Bash allows up to 10 minutes and carries a
  validated final working directory across calls in the same session without
  leaking state across sessions or overriding an explicit `/cd`.
- **Permission boundary** — local allow/ask/deny rules, safe and bare modes,
  searchable scoped-rule creation/removal, local/project/user atomic settings
  writes, tool-specific Bash/PowerShell/file/notebook/WebFetch/Skill approval
  dialogs, editable reusable shell and Skill rules, source-root-aware Claude
  file-rule matching, atomic session permission updates, compound-shell rule
  suggestions backed by a bounded Bash AST, source-shaped exact/prefix/wildcard
  matching, wrapper and environment normalization, fail-closed Bash semantic
  checks with control-flow-aware variable scopes, declaration and literal-only
  arithmetic analysis, exact `cat` heredoc handling, argv-based
  command/redirection path validation, full symlink-chain checks, dangerous-removal,
  sensitive-file, and suspicious Windows-path gates, source-ordered strict sed
  constraints, internal auto-memory/session/task path handling, compound `cd` +
  Git protection, mode-ordered `acceptEdits` handling, live raw/resolved-path
  grants for external directories,
  Claude-compatible opt-in Bash sandboxing with filesystem and network
  isolation, explicit ask/deny precedence, sandbox-only auto-allow,
  write-allowlist/deny-within-allow enforcement, per-command overrides and
  exclusions, violation reporting, and bare-repository control-file cleanup,
  safe-property Skill auto-allow, interactive workspace-directory add/remove
  controls, path confinement, credential redaction, sanitized child processes,
  and exact-fingerprint workspace trust that blocks automatically discovered
  project/local provider selection, hooks, and MCP until the canonical
  workspace configuration is accepted.
- **Durable local work** — resumable sessions, full-history forks, file
  checkpoints, tasks, foreground/background subagents, top-level agents, and
  Claude-compatible main-thread agent definitions with native prompt, model,
  tool, memory, first-turn, and resume behavior. Agent execution uses one
  durable lifecycle vocabulary with bounded cancellation and drain,
  continuation, notifications, and single-owner orphan recovery. Experimental
  local Teams (`PRAXIS_ENABLE_TEAMS=true`) stay absent from ordinary startup by
  default and add durable task ownership plus one ordered mailbox with stable
  identities, fixed broadcast recipients, durable cursors, bounded retention,
  and bounded model-context projection. Teams are explicitly experimental and
  opt-in: `PRAXIS_ENABLE_TEAMS=true` is required; otherwise Team code is not
  loaded, discovered, or exposed. New Teams default to Hybrid lead control and
  sequential execution, with optional Coordinator and Swarm policies. Commits
  remain Lead-owned. Swarm admits only independent, dependency-ready,
  non-conflicting tasks, within durable agent, concurrency, token, duration,
  and shutdown-drain budgets.
  Child permissions can only tighten the parent; concurrent asks form one FIFO
  Lead Decision queue with provenance. Coordinator leads are restricted to
  orchestration, and custom Team agents receive no MCP capability. The native
  CLI also exposes `praxis team status`, `logs`, and `attach` in human or JSON
  form; durable-local attach does not require tmux. Native task, notification,
  context, and Team resume/inbox seams are implemented with fail-closed
  validation for unsupported payloads.
- **Native resource ecosystem** — shared Praxis instructions with recursive `@`
  imports, memory, skills, commands, agents, hooks, settings, MCP servers,
  plugins, and append-only `praxis.transcript` JSONL sessions under `~/.praxis`,
  with bounded MCP connection, discovery, and tool operations plus safe
  disconnect recovery that never replays an already-dispatched call. Stdio MCP
  environment grants expand defined `${NAME}` references at launch without
  exposing unrelated ambient credentials or shell-startup variables; reconnect
  retains the derived grants, while reload derives them again from the current
  environment. Default tool selection defers `mcp__*` schemas behind a
  turn-scoped `ToolSearch`;
  each query activates at most eight deterministic matches for the next model
  request, and published MCP tool descriptions are capped at 2,048 Unicode
  code points. Text-only MCP results above 100,000 UTF-8 bytes are redacted
  into mode-`0600` `.txt` files under the session-scoped `tool-results`
  directory; providers and transcripts receive only a bounded instruction with
  the absolute file path. Results at or below the limit remain inline, while
  structured, mixed-media, and binary-resource handling is unchanged. MCP
  tools that declare `readOnlyHint: true` default to allow through
  provider-neutral permission metadata; explicit PreToolUse and permission
  ask/deny decisions retain precedence, and missing or false hints retain the
  existing default behavior. This is a Praxis permission contract, not a claim
  of verified Claude Code 2.1.208 parity. Explicit concrete `--tools`
  selections load selected tools directly, while
  `--disallowedTools ToolSearch` restores the complete tool list. For each
  context assembly, Git status is refreshed from the caller-resolved cwd while
  environment and memory remain lifecycle-stable; collection uses
  `--no-optional-locks`, fails closed on repository/status errors, and bounds
  the rendered status to 2,048 UTF-8 bytes.
- **Provider-neutral models** — native Provider Registry/Vault routing, API
  adapters, an experimental Codex OAuth adapter, explicit capability checks,
  separate per-attempt connect, byte-idle, and absolute-total timeouts, typed
  recovery for malformed streamed tool arguments without tool execution or
  lost resumability, one default-on bounded Anthropic non-streaming replay for
  eligible stream/idle failures without exposing failed-attempt output, and
  token-only/no-API-dollar accounting for subscription runs. Each main user
  Turn and independent auxiliary Agent, Workflow, Team, recovery, or memory
  Turn receives its own provider client. Session-memory requests reuse a
  completion-scoped client but restart routing from primary for each request;
  auto-mode critic and eval-judge requests remain independently constructed
  one-shot clients. Failed attempts stay buffered, and the first successful
  route, whether primary or fallback, stays sticky only through that logical
  Turn's tool continuations; incompatible routes fail closed, and the next
  independent Turn starts from primary. Recovery may persist only an optional
  selected model, never provider route or wire state.
- **Transactional self-update** — `praxis update` verifies the package before
  installing it, rejects concurrent updates, and can roll back after an
  interruption or crash.

Current qualification status and executable evidence live in the
[Native Fixture Contracts](https://github.com/Forest-Isle/Praxis/blob/main/docs/NATIVE_FIXTURE_CONTRACTS.md)
and its machine-readable
[fixture manifest](https://github.com/Forest-Isle/Praxis/blob/main/test/fixtures/manifest.json).
The [parity matrix](https://github.com/Forest-Isle/Praxis/blob/main/docs/PARITY_MATRIX.md)
and [roadmap](https://github.com/Forest-Isle/Praxis/blob/main/docs/ROADMAP.md) are
historical clean-room records.

## Native data plane

Praxis defaults to an independent local native data plane:

```text
Praxis ─── ~/.praxis (or PRAXIS_HOME)
```

All sessions, memory, tasks, scheduled tasks, resources, and private state live
under `~/.praxis` (or `PRAXIS_HOME`). The authoritative transcript is
append-only `praxis.transcript` v1 JSONL; legacy Claude transcripts, indexes,
sidechains, and migration/recovery paths have been removed. `CLAUDE_CONFIG_DIR`
does not participate in native runs, and legacy directories are neither read
nor written. Claude-shaped messages and tool fields describe protocol shape
only; they do not change Praxis data ownership.

## Documentation

| Need                                       | Document                                                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Install and run the first session          | [Getting Started](https://github.com/Forest-Isle/Praxis/blob/main/docs/GETTING_STARTED.md)                   |
| Common commands and environment variables  | [CLI Reference](https://github.com/Forest-Isle/Praxis/blob/main/docs/CLI_REFERENCE.md)                       |
| Find all user and maintainer documentation | [Documentation Index](https://github.com/Forest-Isle/Praxis/blob/main/docs/README.md)                        |
| Understand module and data-flow boundaries | [Architecture](https://github.com/Forest-Isle/Praxis/blob/main/docs/ARCHITECTURE.md)                         |
| Review security assumptions                | [Threat Model](https://github.com/Forest-Isle/Praxis/blob/main/docs/THREAT_MODEL.md)                         |
| Qualify native behavior and evidence       | [Native Fixture Contracts](https://github.com/Forest-Isle/Praxis/blob/main/docs/NATIVE_FIXTURE_CONTRACTS.md) |
| Review interactive TUI design and evidence | [Quiet Operator Spec](https://github.com/Forest-Isle/Praxis/blob/main/docs/TUI_REDESIGN_SPEC.md)             |
| Build, test, and contribute                | [Contributing](https://github.com/Forest-Isle/Praxis/blob/main/CONTRIBUTING.md)                              |
| Verify release and supply-chain controls   | [Release Contract](https://github.com/Forest-Isle/Praxis/blob/main/docs/RELEASE.md)                          |

## Project boundary

Praxis targets one local OS user working across multiple repositories and
sessions. It is CLI-only and provider-capability-aware. Organization, tenant,
RBAC, billing, enterprise gateway,
IDE/Desktop/mobile clients, Remote Control, Claude Desktop import, and hosted
review-product surfaces are permanent non-goals.

## Security and support

Report vulnerabilities through
[GitHub private vulnerability reporting](https://github.com/Forest-Isle/Praxis/security/advisories/new),
not a public issue. See
[SECURITY.md](https://github.com/Forest-Isle/Praxis/blob/main/SECURITY.md) for
response expectations.

Use [GitHub Discussions](https://github.com/Forest-Isle/Praxis/discussions) for
questions and usage help, and issues for reproducible defects or scoped feature
requests. See
[SUPPORT.md](https://github.com/Forest-Isle/Praxis/blob/main/SUPPORT.md).

## Development

```sh
git clone git@github.com:Forest-Isle/Praxis.git
cd Praxis
npm ci
npm run check
```

`npm run build:native` compiles the Praxis-owned core, provider, native
transcript, and session profile.
`npm run test:native:deletion` adds an emitted-output deletion gate. These are
implemented profile checks, not qualification of the full native package.
`npm run test:performance` enforces TUI projection scaling, doubling ratios
`<=3.25`, the absolute 120k median budget of `<1000 ms`, and deterministic
injected regression protection, plus Quiet Operator input echo `<50 ms` and
normal/low-capability full-frame p95 budgets of `<16.7/<33 ms`.
`npm run check` also enforces the corresponding source dependency direction.
`npm run test:coverage` measures all production code under `src/**` with V8 and
enforces global floors of 79% statements, 70% branches, 85% functions, and 81% lines,
and rejects any production runtime module with zero covered statements (while allowing
type-only modules). `npm run test:fixtures` executes the 71-behavior native contract; 63 behaviors
are qualified and 8 are explicitly excluded. `npm run verify:fixture-contracts`
performs the structural check and is part of `npm run check`.
`npm run test:core-completion` is retained as a compatibility alias for
`npm run test:fixtures`.

Contributions use Conventional Commit pull-request titles and the protected
squash-merge workflow. Read
[CONTRIBUTING.md](https://github.com/Forest-Isle/Praxis/blob/main/CONTRIBUTING.md)
before changing compatibility, persistence, release, or security behavior.

## License

Praxis is available under the
[MIT License](https://github.com/Forest-Isle/Praxis/blob/main/LICENSE). Vendored
dependency attributions are listed in
[THIRD_PARTY_NOTICES.md](https://github.com/Forest-Isle/Praxis/blob/main/THIRD_PARTY_NOTICES.md).
