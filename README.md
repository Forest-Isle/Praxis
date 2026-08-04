# Praxis

Praxis is a local-first, single-user general agent for the command line.

The project cleanly reimplements production-proven agent behavior without
copying Claude Code source. It keeps the CLI agent loop, tool use, permissions,
sessions, context compaction, skills, hooks, and MCP concepts while excluding
accounts, organizations, billing, managed enterprise policy, remote control,
IDE surfaces, and telemetry control planes.

## Status

Sprint 8 child-process credential boundaries are complete on top of shared
memory and native Anthropic/OpenAI-compatible providers. Running `praxis` in a
TTY opens an
Ink session UI with streaming
responses, recent-session selection, runtime status, and ask-permission prompts.
When resume finds a tool call interrupted before its result was persisted, the
UI shows the prepared tool name/input and requires a separate retry decision.
Praxis can run, resume, fork, and list Claude-compatible sessions
through a provider-neutral event loop and Anthropic-compatible or
OpenAI-compatible streaming providers. Built-in read, write, edit, search, and
shell tools execute behind Claude-compatible local permission rules with path
checks, timeouts, cancellation, and bounded output. `Read`, `Write`, and `Edit`
also accept the canonical shared Claude project-memory root; other external
paths and memory-root symlink escapes remain rejected.

Each run or resume holds one session lease through model completion and final
persistence. Native tool calls and results append immediately to the shared
Claude transcript, and Claude Code 2.1.208 can resume a Praxis tool session.
Sprint 1 forks remain text-only: provider reasoning, queue operations, tools,
images, and compaction metadata are not copied into a fork.

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
warning; connected clients and stdio subprocesses close after each CLI turn.
Stdio servers receive a sanitized ambient environment; values declared in that
server's explicit `env` config remain available to it. Credential-named MCP
environment values and sensitive HTTP headers are redacted from tool results,
discovery warnings, and errors. Plain, NDJSON, and interactive CLI diagnostics
also redact ambient credential values, including provider error bodies, failed
runtime events, tool failures, and approval descriptions that echo a key.

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
- Shared local agent definitions; parallel sub-agent orchestration remains out
  of MVP scope

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
export PRAXIS_CONTEXT_WINDOW_TOKENS=200000
export PRAXIS_CONTEXT_RESERVE_TOKENS=8192

node dist/cli.js run "Inspect this project"
node dist/cli.js run "/my-command arguments"
node dist/cli.js run --agent reviewer "Inspect this project"
node dist/cli.js sessions --json
node dist/cli.js resume <session-id> "Continue"
node dist/cli.js resume --retry-interrupted-tools <session-id> "Continue"
node dist/cli.js fork <session-id>
node dist/cli.js
```

`PRAXIS_PROVIDER` defaults to `openai`. `PRAXIS_BASE_URL` defaults to the
selected provider's official `/v1` endpoint. Native Anthropic requests accept
`PRAXIS_MAX_OUTPUT_TOKENS` (default 8192) and
`PRAXIS_ANTHROPIC_VERSION` (default `2023-06-01`). Context window configuration
is explicit because Praxis accepts arbitrary provider models; when
`PRAXIS_CONTEXT_WINDOW_TOKENS` is absent, Praxis does not invent a model limit.
Reserve defaults to 10% of the configured window, capped at 8192.
Provider credentials stay in the Praxis process. Bash, hooks, Claude version
detection, and ambient MCP stdio environments do not inherit credential-named
variables. Explicit per-server MCP `env` and HTTP headers are treated as
intentional grants to that server, with matching output redaction.

Permissions load from the shared global and current-project Claude settings.
`Read` and `Grep` default to `allow`; `Write`, `Edit`, and `Bash` default to
`ask`. Interactive mode prompts before an `ask` tool call. Headless commands
remain non-interactive and return a denied tool result unless a compatible
`allow` rule exists.

With a Claude Code 2.1.208 installation, run the isolated compatibility probes
separately. Claude-backed probes make real model requests; the context-runtime
probe uses a local provider fixture:

```sh
npm run test:compat
npm run test:compaction-compat
npm run test:conditional-compat
npm run test:context-compat
npm run test:extension-compat
npm run test:hook-compat
npm run test:mcp-compat
npm run test:permission-compat
npm run test:runtime-compat
npm run test:recovery-compat
npm run test:shared-compat
```

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
