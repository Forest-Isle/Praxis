# Praxis

Praxis is a local-first, single-user general agent for the command line.

The project cleanly reimplements production-proven agent behavior without
copying Claude Code source. It keeps the CLI agent loop, tool use, permissions,
sessions, context compaction, skills, hooks, and MCP concepts while excluding
accounts, organizations, billing, managed enterprise policy, remote control,
IDE surfaces, and telemetry control planes.

## Status

Sprint 2 headless tool runtime is complete; Sprint 3 context integration is in
progress. Praxis can run, resume, fork, and list Claude-compatible sessions
through a provider-neutral event loop and an OpenAI-compatible streaming
provider. Built-in read, write, edit, search, and shell tools execute behind
Claude-compatible local permission rules with workspace path checks, timeouts,
cancellation, and bounded output.

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
Linked memory details remain explicit reads. Base system context stays
ephemeral and is not copied into the authoritative transcript.

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
writing its output to the transcript.

MCP servers load from Claude's shared user, project, and project-local config
with local-over-project-over-user precedence. Stdio, Streamable HTTP, and
legacy SSE servers expose `mcp__<server>__<tool>` definitions through the same
permission and hook pipeline as built-in tools. Unavailable servers emit a
warning; connected clients and stdio subprocesses close after each CLI turn.

## Product boundary

- CLI-only, including interactive and structured non-interactive output
- One local OS user, multiple workspaces and sessions
- Provider-capability-aware rather than tied to one model vendor
- Claude Code-compatible transcripts, configuration, permissions, and memory
- Optional local sub-agents; no multi-tenant control plane

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

```sh
npm install
npm run typecheck
npm test
npm run build
npm run check
node dist/cli.js --help
```

Configure the first provider adapter, then run a prompt:

```sh
export PRAXIS_API_KEY=...
export PRAXIS_MODEL=...
export PRAXIS_BASE_URL=https://api.openai.com/v1

node dist/cli.js run "Inspect this project"
node dist/cli.js run "/my-command arguments"
node dist/cli.js run --agent reviewer "Inspect this project"
node dist/cli.js sessions --json
node dist/cli.js resume <session-id> "Continue"
node dist/cli.js resume --retry-interrupted-tools <session-id> "Continue"
node dist/cli.js fork <session-id>
```

`PRAXIS_BASE_URL` is optional and defaults to OpenAI's `/v1` endpoint.

Permissions load from the shared global and current-project Claude settings.
`Read` and `Grep` default to `allow`; `Write`, `Edit`, and `Bash` default to
`ask`. Until the interactive permission UI lands in Sprint 4, an `ask` decision
without an approval callback returns a denied tool result; add an explicit
compatible `allow` rule for trusted headless commands.

With a Claude Code 2.1.208 installation, run the isolated compatibility probes
separately. Claude-backed probes make real model requests; the context-runtime
probe uses a local provider fixture:

```sh
npm run test:compat
npm run test:conditional-compat
npm run test:context-compat
npm run test:extension-compat
npm run test:hook-compat
npm run test:mcp-compat
npm run test:permission-compat
npm run test:runtime-compat
npm run test:shared-compat
```

Architecture constraints live in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
Runtime semantics and trust boundaries live in
[docs/RUNTIME_CONTRACT.md](docs/RUNTIME_CONTRACT.md) and
[docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).
