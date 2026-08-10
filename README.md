# Praxis

[![CI](https://github.com/Forest-Isle/Praxis/actions/workflows/ci.yml/badge.svg)](https://github.com/Forest-Isle/Praxis/actions/workflows/ci.yml)
[![CodeQL](https://github.com/Forest-Isle/Praxis/actions/workflows/codeql.yml/badge.svg)](https://github.com/Forest-Isle/Praxis/actions/workflows/codeql.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/Forest-Isle/Praxis/badge)](https://scorecard.dev/viewer/?uri=github.com/Forest-Isle/Praxis)
[![npm](https://img.shields.io/npm/v/praxis-agent)](https://www.npmjs.com/package/praxis-agent)
[![license](https://img.shields.io/github/license/Forest-Isle/Praxis)](LICENSE)

Praxis is a local-first, single-user general agent for the command line.

The project cleanly reimplements production-proven agent behavior without
copying Claude Code source. It keeps the CLI agent loop, tool use, permissions,
sessions, context compaction, skills, hooks, and MCP concepts while excluding
accounts, organizations, billing, managed enterprise policy, remote control,
IDE surfaces, and telemetry control planes.

## Installation

Praxis requires Node.js 24 or newer and `ripgrep` (`rg`).

```sh
npm install --global praxis-agent
praxis --version
```

Release tarballs, SBOMs, SHA-256 checksums, and build attestations are attached
to each [GitHub release](https://github.com/Forest-Isle/Praxis/releases).

## Status

Stage 90 exact CLI signature closure is implemented on top of the
Stage 89 executable CLI surface closure,
Stage 88 plugin MCP bundle parity,
Stage 87 protected plugin option parity,
Stage 86 interactive plugin LSP parity,
Stage 85 interactive question and plan-mode parity, and
Stage 84 completion audit, interactive dynamic wakeups,
Workflow, scheduled prompts, and
top-level background sessions and agent management, durable tasks, background Bash,
WebFetch/WebSearch, MCP resource tools,
native file globbing, notebook editing, CLI customization and session
controls, print and machine-I/O support, image tool results, native foreground
and background subagents, resilient sessions, native full-history forks, child-process
credential boundaries, shared memory, and native Anthropic/OpenAI-compatible
providers.
Headless runs support Claude-style settings/source isolation, safe and bare
modes, direct/file system prompts, additional canonical directory roots,
dynamic cwd/environment/memory/git context with optional first-user relocation,
explicit tool sets, CLI permission rules and modes, current-directory
continue/fork, PR-linked resume/fork, native session names, and in-memory
no-persistence execution.
`--resume` accepts an optional selector: UUID resumes directly, print/background
mode resolves an exact case-insensitive session title, and TTY text filters the
required session picker. Bare TTY `--resume` opens that picker.
The hidden-compatible `--permission-prompt-tool` control routes ask decisions
through a reserved MCP tool, supports approved input replacement, and keeps the
permission tool out of the model-visible tool surface. Denials can either return
a failed tool result or interrupt the run, matching the MCP response contract.
Classifier-backed `auto` permissions use the bounded provider decision path and
fail closed when classification is unavailable. No-persistence runs disable
Agent because native sidechains are disk-backed.
Running `praxis` or `praxis "prompt"` in a
TTY opens an
Ink session UI with streaming
responses, recent-session selection, runtime status, ask-permission prompts,
model-driven `AskUserQuestion`, and `EnterPlanMode`/`ExitPlanMode`. A positional
TTY prompt is submitted once after any required resume selection; `-p` remains
headless. Plan mode persists native `permission-mode` records, resumes across
Praxis and Claude transcripts, and restricts writes to the current session's
exact plan file under the shared Claude plans directory.
When resume finds a tool call interrupted before its result was persisted, the
UI shows the prepared tool name/input and requires a separate retry decision.
Praxis can run, resume, fork, and list Claude-compatible sessions
through a provider-neutral event loop and Anthropic-compatible or
OpenAI-compatible streaming providers. Built-in read, write, edit, glob, search,
shell, notebook, and web tools execute behind Claude-compatible local permission
rules with path checks, timeouts, cancellation, and bounded output. Notebook `Read`
emits Claude-compatible cell IDs and `NotebookEdit` performs one structured
replace, insert, or delete only after a successful read. `Read`, `Write`, and `Edit`
also accept the canonical shared Claude project-memory root; other external
paths and memory-root symlink escapes remain rejected.
`Read` detects PNG, JPEG, GIF, and WebP by file signature and returns bounded
provider-neutral image data. Anthropic receives a native image tool-result
block; OpenAI-compatible providers receive a paired tool confirmation and user
`image_url`. The image persists in Claude Code 2.1.208's native
`tool_result`/`toolUseResult` envelope and survives Praxis or Claude resume.
User image/document attachments and ordered MCP text, image, audio, resource,
and structured-content results use their validated native envelopes. Binary MCP
audio/resources are bounded and materialized under the session tool-result path.

Interactive plugin sessions expose Claude's `LSP` tool when an enabled plugin
provides `.lsp.json` or manifest `lspServers` configuration. Praxis implements
the nine Claude operations over bounded stdio JSON-RPC, exact result formatting,
document synchronization, gitignored-result filtering, transient retry,
crash recovery, and graceful shutdown. Plugin root/data/environment expansion,
effective user/project/local `${user_config.*}` options, workspace settings,
initialization options, and case-insensitive extension mapping follow the shared
plugin contract. Headless, safe, bare, explicitly denied, and `mcp serve`
surfaces do not expose LSP.
Plugin options merge user, project, and local settings with protected
`pluginSecrets`, with secure values winning collisions. Sensitive values are
stored in Claude-compatible credentials, scrubbed from plaintext settings,
removed after the last installed scope, and redacted from LSP, MCP, and hook
diagnostics. `${user_config.*}` substitution spans LSP/MCP/hook runtime config;
plugin hooks also receive `CLAUDE_PLUGIN_OPTION_*`. Commands, skills, and agents
receive non-sensitive values while sensitive references become explicit
model-safe placeholders.
Plugin MCP servers use Claude's `plugin:<plugin>:<server>` runtime namespace,
explicit plugin-origin metadata, manual-server-first signature deduplication,
and normalized model-visible tool names while preserving raw scoped names for
status and resource operations.
Manifest declarations support ordinary JSON plus local or HTTP(S) `.mcpb` and
`.dxt` bundles. Bundle loading uses vendored official MCPB schemas and local
compatible config expansion, sticky remote and change-aware local caches, bounded downloads and ZIP
extraction, traversal/symlink/bomb rejection, executable-bit restoration, and
per-bundle failure isolation. MCPB user config shares the protected plugin
option plane; required values, qualified `server.key=value` assignments,
defaults, arrays, platform overrides, plugin data/root expansion, and sensitive
diagnostic redaction are preserved through packed runtime execution.
Protected plugin configuration commits credentials and settings under one
cross-process lease with a crash-recovery journal; interrupted writes recover
forward or roll back from exact file hashes without exposing Keychain values in
process arguments.

Each run or resume holds one session lease through model completion and final
persistence. Native tool calls and results append immediately to the shared
Claude transcript, and Claude Code 2.1.208 can resume a Praxis tool session.
`--resume-session-at <message-id>` with explicit `--resume` starts from any
active user or assistant message. Praxis preserves abandoned descendants in
the append-only JSONL, appends a native `parentUuid` branch, projects only the
new active chain on later resumes, and applies the same boundary before a
generated or explicit `--fork-session`. Foreground, interactive, background,
and no-persistence paths share this behavior, and either CLI can resume the
other runtime's branch.
The synchronous `Agent` tool runs bounded `general-purpose` or shared custom
agents through the same provider, local/MCP/Skill tools, permissions, hooks,
context, and cancellation path. Completed work writes native sidechain JSONL,
metadata, and main-chain Agent results that Claude Code 2.1.208 can discover and
resume. Background Agent execution, output/stop, same-ID messaging, and
completion notifications share that sidechain path.
`TaskCreate`, `TaskGet`, `TaskList`, and `TaskUpdate` use Claude's authoritative
`<config>/tasks/<session-id>` graph, including reciprocal dependencies,
metadata merge/delete, monotonic IDs, internal-task filtering, optimistic
cross-runtime update replay, and bidirectional resume. Bash accepts
`run_in_background`, writes bounded redacted output under Claude's temporary
task path, and shares `TaskOutput`/`TaskStop` routing with Agent IDs. Resumable
Bash sidecars use atomic replacement and malformed records are ignored. Only
`Read` can access the temporary output root.
Top-level `--bg`/`--background` launches a detached, persistent session whose
eight-hex job ID owns an idle/active/stopped lifecycle. In a TTY, `praxis agents`
opens a live grouped dashboard for native Claude and Praxis sessions, including
history review, background dispatch, completed-session resume, attach,
continuation, detach, and stop. `agents --json [--all] [--cwd <path>]` retains a
non-interactive scripting surface; `logs`, `attach`, and `stop` use an
owner-authenticated local control socket. Job state follows Claude's local
`jobs/` and `sessions/` layout while Praxis-only dispatch ownership prevents
cross-runtime process takeover. Background user/assistant entries carry native
`sessionKind: "bg"` metadata, and either CLI can resume the shared transcript.
CLI worktree sessions support `--tmux`: iTerm2 receives a native split pane
with an explicitly rooted, shell-escaped child command; other terminals fall
back to detached classic tmux. `--tmux=classic` always forces traditional tmux.
`CronCreate`, `CronList`, and `CronDelete` expose Claude Code 2.1.208-compatible
schemas and results for session-only and durable prompts. Durable jobs share
`<cwd>/.claude/scheduled_tasks.json`, preserve unknown native fields, use atomic
optimistic mutations, avoid live foreign process owners, catch up missed
one-shot jobs, and expire recurring jobs after a final seven-day execution. The
interactive CLI keeps one service alive, submits due prompts while idle, and
releases timers on exit. Built-in `/loop` expands fixed intervals through
`CronCreate` and executes the prompt immediately once. In an interactive Praxis
service, `ScheduleWakeup` clamps session-only one-shot delays, submits the prompt
through the same idle queue, and supports stop/close cancellation. Headless runs
retain the observed Claude inactive result. Active replacement, max-age,
stop, and close behavior follows the validated process-local lifecycle.
The opt-in `Workflow` tool runs sandboxed JavaScript orchestration with agents,
parallel/pipeline helpers, structured results, token targets, worktree isolation,
background task control, native run/journal files, and same-run replay. Praxis can
fallback-replay a unique Claude-created prompt without semantic options. Exact
chained `v2` replay keys, semantic sidecars, and ordered fallbacks are validated
in both directions. Claude Code 2.1.208 exposes no standalone `Monitor` tool.
Forks preserve the complete supported main-chain native history, including
tool calls/results, compact boundaries/summaries, attachments, agent settings,
titles, images, errors, and interrupted-tool denial records. Existing UUIDs,
parent links, and payload fields remain unchanged; only `sessionId` changes.
Latest mode and permission state is retained. Queue and file-history records
are transient and excluded, while unknown entry types, mismatched session IDs,
and malformed cross-entry links fail closed. Subagent sidechains and orphaned
`last-prompt` hints are excluded from the main-session fork.
When `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=true`, successful `Write`,
`Edit`, and `NotebookEdit` calls append native file-history snapshot/delta
records and bounded backups under `<config>/file-history/<session-id>`.
`--resume <session-id> --rewind-files <user-message-uuid>` is a provider-free
standalone operation that restores or removes tracked files at that checkpoint.
Claude Code can rewind Praxis checkpoints, and Praxis can rewind Claude
checkpoints; restore paths remain confined to the active workspace, explicit
additional directories, and shared memory root.

Session leases now carry PID/token ownership and safely reclaim locks left by a
dead Praxis process while preserving live or unrecognized locks. Session
listing isolates malformed JSONL instead of failing the entire project and
reports the exact line and byte offset. `praxis inspect` exposes read/write
status and recovery metadata; `praxis export` returns the original transcript
bytes without normalization. Both commands remain available when the detected
Claude version is unsupported for writes or the transcript has a corrupt tail.
`praxis export --json` carries those bytes as base64 with explicit encoding
metadata.

Global and project `CLAUDE.md`, unconditional user/project rules, and the first
200 lines of canonical project `MEMORY.md` now assemble into provider-neutral
system context for run and resume. A successful `Read` of a path matching a
conditional rule activates its instruction for later model turns and persists
the Claude 2.1.208 native `nested_memory` attachment, so both Praxis and Claude
Code retain it after resume. Prompt path mentions, Write, Grep, and Bash do not
activate path rules. Edit also remains non-activating; the compatibility probe
pre-reads its target before installing the matching rule so Edit can succeed
without a rule-activating Read.
Linked memory details remain explicit standard `Read` calls. Standard `Write`
and `Edit` calls update the same shared Markdown files, so Claude Code and
Praxis observe one memory plane without import or synchronization. Base system
context stays ephemeral and is not copied into the authoritative transcript.

Global and project commands and skills now expand from the shared Claude files
without entering base context. Slash invocation persists Claude-compatible
command wrapper plus expanded user entries; provider-selected skills use the
`Skill` tool/result flow and inject their scoped body before the next turn.
`--agent <name>` applies shared agent instructions and writes native
`agent-setting` metadata, which both Praxis and Claude restore on resume.

Command hooks load directly from user, project, and local Claude settings.
Praxis executes SessionStart, UserPromptSubmit, PreToolUse,
PermissionRequest, PostToolUse, PostToolUseFailure, Stop, and SessionEnd with
bounded subprocesses and native stdin envelopes. Pre-tool hooks can rewrite
input, decide permission, add resumable context, or block with exit code 2;
Stop hooks can request another model turn. Hook success, failure, and context
attachments before SessionEnd use the Claude 2.1.208 transcript profile and
survive bidirectional resume; SessionEnd executes after `last-prompt` without
writing its output to the transcript. Hook commands run without user shell
startup files or ambient credential variables. Exact credential values are
redacted from commands, stdout, stderr, blocking reasons, and additional
context before they can reach diagnostics or shared JSONL.

MCP servers load from Claude's shared user, project, and project-local config
with local-over-project-over-user precedence. Stdio, Streamable HTTP, and
legacy SSE servers expose `mcp__<server>__<tool>` definitions through the same
permission and hook pipeline as built-in tools. Unavailable servers emit a
warning; connected clients and stdio subprocesses close after each CLI
invocation. Multi-turn stream input intentionally reuses one connection set.
Resource-capable servers also expose Claude-compatible list, read, and
directory-resource tools. Resource discovery follows bounded MCP pagination;
text results stay inline, while bounded binary blobs are exclusively saved under
the active session's shared `tool-results` directory, including ephemeral
sessions that do not write JSONL. Stream init reports connected and failed
configured servers even when a server provides resources but no callable tools.
Stdio servers receive a sanitized ambient environment; values declared in that
server's explicit `env` config remain available to it. Credential-named MCP
environment values and sensitive HTTP headers are redacted from tool results,
discovery warnings, and errors. Plain, NDJSON, and interactive CLI diagnostics
also redact ambient credential values, including provider error bodies, failed
runtime events, tool failures, and approval descriptions that echo a key.
Prompt-capable servers expose `server:prompt (MCP)` slash commands with bounded
pagination, `list_changed` refresh, raw wire-name preservation, reconnect, and
positional argument mapping. Text, image, audio, resource, and resource-link
content follows the same bounded conversion path as MCP tools; binary prompt
content is written to the active session's durable `tool-results` directory so
resume never retains a deleted temporary path.

Normal and safe modes expose `WebFetch`; `WebSearch` is added only when the
selected provider advertises native search support. Bare mode excludes both,
including explicit tool selection. WebFetch upgrades HTTP to HTTPS, rejects
credentials and private/loopback destinations, pins each request to validated
public DNS results, revalidates same-host redirects, converts supported text to
Markdown, and bounds time, response bytes, output bytes, redirects, and cache.
Cross-host redirects are returned for a fresh explicit fetch. Anthropic-native
WebSearch supports allowed or blocked domain filters, links/citations, and the
Claude-compatible source reminder; OpenAI-compatible providers currently do
not advertise native WebSearch.

Provider-neutral context budgeting counts system/history/tool-schema input
before every model turn. When an explicitly configured provider window would
overflow, Praxis summarizes completed history without tools, atomically appends
the Claude 2.1.208 native `compact_boundary` plus compact-summary pair, and
rechecks the reduced request before continuing. Shared JSONL remains
append-only; Claude Code and Praxis both project only the latest summary and
later messages. Activated nested-memory rules remain active across compaction.

## Product boundary

- CLI-only, including interactive and structured non-interactive output
- One local OS user, multiple workspaces and sessions
- Provider-capability-aware rather than tied to one model vendor
- Claude Code-compatible transcripts, configuration, permissions, and memory
- Shared local agent definitions plus background Agent launch, output, stop,
  same-ID messaging, completion notification, and native sidechains
- Shared durable task graph plus foreground/background Bash lifecycle
- Persistent top-level background sessions plus native/Praxis agents dashboard,
  history review/resume, JSON, logs, attach, continuation, and stop controls
- Session-only dynamic wakeups, shared durable scheduled prompts, and
  fixed-interval `/loop`

## Claude Code interoperability

Praxis uses Claude Code's local data layout as its default shared data plane.
The compatibility target is bidirectional: Praxis can resume Claude Code
sessions, and Claude Code can resume sessions written by Praxis. Project
instructions, auto memory, skills, agents, hooks, and MCP configuration are
shared rather than copied into a separate Praxis ecosystem.

See [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) for protocol boundaries and
[docs/ROADMAP.md](docs/ROADMAP.md) for implementation gates.
See [docs/RELEASE.md](docs/RELEASE.md) for release verification and
[docs/RELEASE_AUTOMATION.md](docs/RELEASE_AUTOMATION.md) for maintainer
operations.

## Development

Requires Node.js 24 or newer.
The Grep tool requires `rg`; command execution uses startup-file-free
`/bin/zsh` on macOS and `/bin/bash` on Linux.

```sh
npm install
npm run typecheck
npm test
npm run build
npm run check
npm run test:performance
npm run test:package
node dist/cli.js --help
```

Contributions use Conventional Commit pull-request titles and must pass the
required `CI` check. See [CONTRIBUTING.md](CONTRIBUTING.md).

Configure the first provider adapter, then run a prompt:

```sh
export PRAXIS_API_KEY=...
export PRAXIS_MODEL=...
export PRAXIS_PROVIDER=openai # or anthropic
export PRAXIS_BASE_URL=https://api.openai.com/v1
# Optional startup file API overrides. Bearer token takes precedence.
export PRAXIS_FILES_BASE_URL=https://api.example.com
export PRAXIS_FILES_BEARER_TOKEN=...
# Or use PRAXIS_FILES_API_KEY; PRAXIS_API_KEY is the final fallback.
export PRAXIS_CONTEXT_WINDOW_TOKENS=200000
export PRAXIS_CONTEXT_RESERVE_TOKENS=8192
# Anthropic only: explicitly enable provider-native WebSearch.
export PRAXIS_ANTHROPIC_WEB_SEARCH=true

node dist/cli.js run "Inspect this project"
node dist/cli.js -p --output-format json "Inspect this project"
printf '%s\n' '{"type":"user","message":{"role":"user","content":"Inspect this project"}}' | \
  node dist/cli.js -p --input-format stream-json --output-format stream-json --verbose
node dist/cli.js run "/my-command arguments"
node dist/cli.js run --agent reviewer "Inspect this project"
node dist/cli.js -p --setting-sources project --tools Read,Grep "Inspect this project"
node dist/cli.js -p --system-prompt-file prompt.txt --add-dir ../shared -- "Inspect both roots"
node dist/cli.js -p --continue --fork-session --name experiment "Try another approach"
node dist/cli.js -p --from-pr=owner/repo#42 --fork-session -- "Continue PR work"
node dist/cli.js -p --model claude-sonnet-4-20250514 --effort high "Try another approach"
node dist/cli.js -p --thinking adaptive --max-thinking-tokens 8192 "Reason within a cap"
node dist/cli.js -p --max-budget-usd 0.50 --output-format json "Bound this run"
node dist/cli.js -p --output-format stream-json --verbose --prompt-suggestions "Suggest the next step"
node dist/cli.js -p --prefill "ignored by Claude 2.1.208" "Inspect this project"
node dist/cli.js -p --no-session-persistence "Inspect without saving"
node dist/cli.js -p --file file_abc:input.txt -- "Inspect the downloaded file"
node dist/cli.js sessions --json
node dist/cli.js inspect --json <session-id>
node dist/cli.js export <session-id> > session.jsonl
node dist/cli.js resume <session-id> "Continue"
node dist/cli.js -p --resume="Named session" "Continue"
node dist/cli.js resume --retry-interrupted-tools <session-id> "Continue"
node dist/cli.js -p --resume <session-id> --resume-session-at <message-id> "Try another branch"
CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=true node dist/cli.js -p "Edit with checkpoints"
node dist/cli.js -p --resume <session-id> --rewind-files <user-message-uuid>
node dist/cli.js --init-only
node dist/cli.js -p --init "Run setup hooks, then continue"
node dist/cli.js -p --maintenance "Run maintenance hooks, then continue"
node dist/cli.js fork <session-id>
node dist/cli.js --worktree=review --tmux "Inspect in a native pane"
node dist/cli.js --worktree=review --tmux=classic "Inspect in tmux"
node dist/cli.js --bg "Inspect this project"
node dist/cli.js agents
node dist/cli.js agents --json --all --cwd "$PWD"
node dist/cli.js logs <agent-id>
node dist/cli.js attach <agent-id>
node dist/cli.js stop <agent-id>
node dist/cli.js mcp list
node dist/cli.js mcp add-json fixture '{"type":"stdio","command":"node","args":["server.mjs"]}'
MCP_CLIENT_SECRET=secret node dist/cli.js mcp add-json oauth-fixture '{"type":"http","url":"https://example.test/mcp","oauth":{"clientId":"client"}}' --client-secret
node dist/cli.js mcp get fixture
node dist/cli.js mcp remove fixture --scope local
node dist/cli.js auto-mode defaults --label Read
node dist/cli.js --json plugin list --available
node dist/cli.js plugin init my-plugin --with skills agents
node dist/cli.js plugin marketplace add owner/repo --sparse .claude-plugin plugins
node dist/cli.js plugin disable --all
node dist/cli.js plugin eval --scaffold --allow-tools Bash ./my-plugin
node dist/cli.js plugin eval init --bare smoke-test
node dist/cli.js
```

Claude-style `--output-format json` emits one result object. Stream input and
output require `--verbose`; `--include-partial-messages` adds model delta
records and `--replay-user-messages` echoes normalized input records. Multiple
stdin messages share one session and service lifecycle. Result JSON reports
measured provider API duration and cost when selected model has built-in or
explicit pricing. Unknown models remain `null` rather than invented estimates.
Set `PRAXIS_PRICING_JSON` to a JSON object keyed by model, with
`inputPerMillionUsd`, `outputPerMillionUsd`, and optional cache rates, to price
a private or relay model. `--max-budget-usd` requires print mode and fails closed
when no pricing is available.
Anthropic sessions enable extended thinking by default, matching the isolated
Claude Code 2.1.208 CLI contract. `--thinking enabled|adaptive|disabled`
overrides that mode, and `--max-thinking-tokens` applies a positive token
budget for enabled/adaptive thinking. Signed and redacted thinking blocks stay
hidden from text/JSON results, remain available in partial stream records, and
are preserved through tool continuations and shared Claude JSONL resume.
OpenAI-compatible adapters accept explicit `disabled`; enabled/adaptive or
token-budgeted thinking fail before a provider request because chat-completions
has no lossless mapping.
`--prompt-suggestions` is available only with print-mode stream JSON; it emits
one auxiliary `prompt_suggestion` record after each successful result without
mutating the session transcript.
Claude Code 2.1.208 accepts hidden `--prefill <text>` syntax but does not put
the value in provider requests, output, or persisted transcripts. Praxis
preserves that baseline no-op in text, JSON, stream JSON, resume, fork, and
non-persistent runs; repeated flags are accepted and the final parsed value is
retained only as an invocation control.
`--init` runs matching `Setup` hooks with the `init` trigger before normal
session startup and the provider turn. `--maintenance` uses the
`maintenance` trigger. `--init-only` runs `Setup(init)` and
`SessionStart(startup)` synchronously, exits without a provider request, and
does not write a session transcript. Bare mode skips both lifecycle hook
families, matching Claude's minimal mode.
`--from-pr [number-or-url]` filters native Claude `pr-link` metadata. Interactive
mode opens a filtered resume picker; headless mode resumes only a unique match
and reports zero or ambiguous matches instead of selecting silently. Forks
preserve the PR link with the new session ID, so Claude Code can resume them.
`--file <file_id:relative_path...>` downloads resources before the first model
turn into `<cwd>/<session-id>/uploads`. Paths cannot escape that directory.
`PRAXIS_FILES_BASE_URL` selects a separate Files API endpoint;
`PRAXIS_FILES_BEARER_TOKEN`, `PRAXIS_FILES_API_KEY`, then `PRAXIS_API_KEY` are
checked in that order. Anthropic providers receive their required files beta
and version headers; other providers use a standard Bearer API key.
MCP management commands write Claude-compatible local (`.claude.json` project
state), project (`.mcp.json`), or user (`.claude.json` root) scopes atomically;
`add`, `add-json`, `list`, `get`, `remove`, and `reset-project-choices` are
implemented. `add-json --client-secret` stores OAuth secrets outside shared MCP
configuration and rolls back config replacement if secret persistence fails.
OAuth login/logout and MCP server hosting are separate commands; Claude Desktop
import is intentionally excluded.

Plugin management supports local and marketplace installs, details, strict
manifest validation, typed `--config key=value` persistence (or
`--config server.key=value` for ambiguous MCPB options), JSON marketplace
availability, and native `plugin init <name>` scaffolds under
`~/.claude/skills/<name>`. Skills-directory plugins load with normal plugin
resources and can be enabled or disabled through their `<name>@skills-dir` ID.
Plugin config validates required/default/range/boolean behavior atomically;
sensitive options use shared protected credentials and never enter
`settings.json`.
Marketplace Git sources support bounded `--sparse <paths...>` checkout with
paths preserved for later updates; `plugin disable -a|--all` disables every
enabled native and skills-directory plugin.
`plugin eval` discovers strict YAML or prose cases under `evals/`, runs each case
in an isolated non-persistent session, supports with/without-plugin ablation,
bounded opt-in scaffolds, operator grants for gated tools, deterministic and
three-vote model graders, cost ceilings, scored JSON artifacts, and resumable
Claude JSONL history context. `plugin eval init` provides TTY authoring or an
immediately runnable `--bare` template.
Plugin LSP declarations may be inline objects, JSON paths, or ordered arrays;
manifest entries override same-named `.lsp.json` defaults. LSP subprocesses
receive sanitized ambient state plus explicit plugin env, `CLAUDE_PLUGIN_ROOT`,
and persistent `CLAUDE_PLUGIN_DATA`. Saved LSP options use Claude settings
precedence: local overrides project, project overrides user, and protected
secrets override legacy plaintext values. The same option plane feeds plugin
MCP servers and hooks; model-visible plugin content excludes sensitive values.

`PRAXIS_PROVIDER` defaults to `openai`. `PRAXIS_BASE_URL` defaults to the
selected provider's official `/v1` endpoint. Native Anthropic requests accept
`PRAXIS_MAX_OUTPUT_TOKENS` (default 8192) and
`PRAXIS_ANTHROPIC_VERSION` (default `2023-06-01`). Native Anthropic WebSearch
is advertised only with `PRAXIS_ANTHROPIC_WEB_SEARCH=true`, because arbitrary
models and compatible relays do not necessarily implement it. Context window
configuration is explicit because Praxis accepts arbitrary provider models; when
`PRAXIS_CONTEXT_WINDOW_TOKENS` is absent, Praxis does not invent a model limit.
Reserve defaults to 10% of the configured window, capped at 8192.
Provider credentials stay in the Praxis process. Bash, hooks, Claude version
detection, and ambient MCP stdio environments do not inherit credential-named
variables. Explicit per-server MCP `env` and HTTP headers are treated as
intentional grants to that server, with matching output redaction.

Permissions load from the shared global and current-project Claude settings.
`Read`, `Grep`, `LSP`, `Agent`, `SendMessage`, and Task tools default to `allow`;
`Write`, `Edit`, `Bash`, `WebFetch`, and `WebSearch` default to `ask`.
Interactive mode prompts before an `ask` tool call. Entering plan mode is
automatic; leaving it displays the plan and requires user approval. Question and
plan prompts honor tool cancellation. Headless commands remain non-interactive
and return a denied tool result
unless a compatible `allow` rule exists.

With a Claude Code 2.1.208 installation, run the isolated compatibility probes
separately. Claude-backed probes make real model requests; the context-runtime
probe uses a local provider fixture:

```sh
npm run test:compat:all
```

The aggregate command discovers every `test:*` compatibility gate except the
provider-free package and performance gates, validates each command shape, and
runs 52 isolated gates in sequence. The CLI surface gate dynamically walks all
included Claude Code 2.1.208 command routes and aliases, compares exact
route-local option and positional required/optional/variadic signatures,
verifies functional `help <command>` and alias dispatch, and keeps product-scope
exclusions explicit. Run an individual `test:*` command when iterating on one
surface.

`npm run test:performance` is a local, provider-free release gate covering CLI
process startup, 500-session discovery, and large transcript load, heap, and
append behavior. Exact fixtures and limits are documented in
[docs/PERFORMANCE.md](docs/PERFORMANCE.md).

`npm run test:package` builds the `praxis-agent` tarball, enforces its file and
size boundary, installs it into an empty project, and exercises both provider
adapters through the installed `praxis` bin plus the fail-closed Claude version
matrix. See
[docs/RELEASE.md](docs/RELEASE.md). Publishing remains an explicit separate
operation.

Architecture constraints live in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
Runtime semantics and trust boundaries live in
[docs/RUNTIME_CONTRACT.md](docs/RUNTIME_CONTRACT.md) and
[docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).
