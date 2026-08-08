# Praxis

Praxis is a local-first, single-user general agent for the command line.

The project cleanly reimplements production-proven agent behavior without
copying Claude Code source. It keeps the CLI agent loop, tool use, permissions,
sessions, context compaction, skills, hooks, and MCP concepts while excluding
accounts, organizations, billing, managed enterprise policy, remote control,
IDE surfaces, and telemetry control planes.

## Status

Stage 24 interactive dynamic wakeups and Stage 23 Workflow are implemented on
top of Stage 22 scheduled prompts, Sprint 21
top-level background sessions and agent management, durable tasks, background Bash,
WebFetch/WebSearch, MCP resource tools,
native file globbing, notebook editing, CLI customization and session
controls, print and machine-I/O support, image tool results, native foreground
and background subagents, resilient sessions, native full-history forks, child-process
credential boundaries, shared memory, and native Anthropic/OpenAI-compatible
providers.
Headless runs support Claude-style settings/source isolation, safe and bare
modes, direct/file system prompts, additional canonical directory roots,
explicit tool sets, CLI permission rules and modes, current-directory
continue/fork, native session names, and in-memory no-persistence execution.
Classifier-backed `auto` permissions remain fail-closed until their dedicated
runtime lands; no-persistence runs disable Agent because native
sidechains are disk-backed.
Running `praxis` in a
TTY opens an
Ink session UI with streaming
responses, recent-session selection, runtime status, and ask-permission prompts.
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
User image attachments and MCP tool image-result writers remain disabled until
their distinct native envelopes pass clean-room probes.

Each run or resume holds one session lease through model completion and final
persistence. Native tool calls and results append immediately to the shared
Claude transcript, and Claude Code 2.1.208 can resume a Praxis tool session.
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
eight-hex job ID owns an idle/active/stopped lifecycle. `praxis agents` supports
JSON, historical, and cwd-filtered views; `logs`, `attach`, and `stop` use an
owner-authenticated local control socket. Job state follows Claude's local
`jobs/` and `sessions/` layout while Praxis-only dispatch ownership prevents
cross-runtime process takeover. Background user/assistant entries carry native
`sessionKind: "bg"` metadata, and either CLI can resume the shared transcript.
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
retain the observed Claude inactive result. Claude's active gate could not be
triggered through the isolated API-auth black-box fixture, so active result-shape
parity remains explicitly partial.
The opt-in `Workflow` tool runs sandboxed JavaScript orchestration with agents,
parallel/pipeline helpers, structured results, token targets, worktree isolation,
background task control, native run/journal files, and same-run replay. Praxis can
fallback-replay a unique Claude-created prompt without semantic options. Exact
Praxis-created journal cache reuse in Claude remains partial because Claude's private
replay-key derivation is not observable. Claude Code 2.1.208 exposes no standalone
`Monitor` tool.
Forks preserve the complete supported main-chain native history, including
tool calls/results, compact boundaries/summaries, attachments, agent settings,
titles, images, errors, and interrupted-tool denial records. Existing UUIDs,
parent links, and payload fields remain unchanged; only `sessionId` changes.
Latest mode and permission state is retained. Queue and file-history records
are transient and excluded, while unknown entry types, mismatched session IDs,
and malformed cross-entry links fail closed. Subagent sidechains and orphaned
`last-prompt` hints are excluded from the main-session fork.

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
- Persistent top-level background sessions plus agents/logs/attach/stop controls
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
node dist/cli.js -p --model claude-sonnet-4-20250514 --effort high "Try another approach"
node dist/cli.js -p --max-budget-usd 0.50 --output-format json "Bound this run"
node dist/cli.js -p --output-format stream-json --verbose --prompt-suggestions "Suggest the next step"
node dist/cli.js -p --no-session-persistence "Inspect without saving"
node dist/cli.js -p --file file_abc:input.txt -- "Inspect the downloaded file"
node dist/cli.js sessions --json
node dist/cli.js inspect --json <session-id>
node dist/cli.js export <session-id> > session.jsonl
node dist/cli.js resume <session-id> "Continue"
node dist/cli.js resume --retry-interrupted-tools <session-id> "Continue"
node dist/cli.js fork <session-id>
node dist/cli.js --bg "Inspect this project"
node dist/cli.js agents --json --all --cwd "$PWD"
node dist/cli.js logs <agent-id>
node dist/cli.js attach <agent-id>
node dist/cli.js stop <agent-id>
node dist/cli.js mcp list
node dist/cli.js mcp add-json fixture '{"type":"stdio","command":"node","args":["server.mjs"]}'
node dist/cli.js mcp get fixture
node dist/cli.js mcp remove fixture --scope local
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
`--prompt-suggestions` is available only with print-mode stream JSON; it emits
one auxiliary `prompt_suggestion` record after each successful result without
mutating the session transcript.
`--file <file_id:relative_path...>` downloads resources before the first model
turn into `<cwd>/<session-id>/uploads`. Paths cannot escape that directory.
`PRAXIS_FILES_BASE_URL` selects a separate Files API endpoint;
`PRAXIS_FILES_BEARER_TOKEN`, `PRAXIS_FILES_API_KEY`, then `PRAXIS_API_KEY` are
checked in that order. Anthropic providers receive their required files beta
and version headers; other providers use a standard Bearer API key.
MCP management commands write Claude-compatible local (`.claude.json` project
state), project (`.mcp.json`), or user (`.claude.json` root) scopes atomically;
`add`, `add-json`, `list`, `get`, `remove`, and `reset-project-choices` are
implemented. OAuth login/logout, Desktop import, and MCP server hosting remain
separate management surfaces.

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
`Read`, `Grep`, `Agent`, `SendMessage`, and Task tools default to `allow`;
`Write`, `Edit`, `Bash`, `WebFetch`, and `WebSearch` default to `ask`.
Interactive mode prompts before an `ask` tool
call. Headless commands remain non-interactive and return a denied tool result
unless a compatible `allow` rule exists.

With a Claude Code 2.1.208 installation, run the isolated compatibility probes
separately. Claude-backed probes make real model requests; the context-runtime
probe uses a local provider fixture:

```sh
npm run test:compat:all
```

The aggregate command discovers every `test:*` compatibility gate except the
provider-free package and performance gates, validates each command shape, and
runs 34 isolated gates in sequence. Run an individual `test:*` command when
iterating on one surface.

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
