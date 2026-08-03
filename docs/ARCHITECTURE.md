# Architecture

## Direction

Praxis preserves proven CLI agent semantics while rebuilding the code around a
single-user, local-first product boundary.

Core behavior:

```text
input -> context -> model stream -> tool call -> permission -> execution
      -> tool result -> continue, compact, or finish
```

## Intended modules

```text
src/
├── cli/           terminal UI and structured output
├── application/   run, resume, inspect, and configure use cases
├── core/          agent loop and provider-neutral domain types
├── compatibility/ versioned Claude local-protocol adapters
├── providers/     capability-aware model adapters
├── tools/         local executable capabilities
├── extensions/    skills, commands, and agents
├── hooks/         shared hook parsing, execution, and tool coordination
├── mcp/           shared Claude MCP config, clients, and tool adapter
├── persistence/   Claude-compatible JSONL and local sidecar indexes
└── platform/      filesystem, process, keychain, and OS adapters
```

## Hard boundaries

- `core` must not import React, Ink, model-vendor SDKs, filesystem, or storage.
- The CLI observes runtime events; it does not own agent state.
- Claude Code-compatible JSONL transcripts remain authoritative and
  append-only.
- Provider adapters expose capabilities instead of flattening every model to a
  lowest-common-denominator API.
- Tool permissions are local `allow`, `ask`, or `deny` decisions.
- No tenant, organization, role, entitlement, billing, remote-control, or
  telemetry domain exists.

The Ink interactive CLI is an event adapter under `src/cli`: it renders
`RuntimeEvent` state and streaming deltas, requests user decisions through the
existing `approveTool` callback, and starts or resumes application sessions.
React and Ink do not enter `core`, application services, providers, tools, or
shared persistence. Headless text and NDJSON modes retain the same runtime
ports without terminal prompts.

## Shared Claude data plane

Praxis defaults to the same configuration root as Claude Code:
`CLAUDE_CONFIG_DIR`, falling back to `~/.claude`. It shares:

- workspace session JSONL files and UUID/parent UUID chains;
- `CLAUDE.md`, `.claude/CLAUDE.md`, and `.claude/rules` instructions;
- global and project skills, commands, and agent definitions;
- auto memory under the Claude project memory directory;
- compatible settings, hooks, and MCP configuration.

Praxis-only indexes, provider payloads, and locks are non-authoritative
sidecars under `<claude-config>/praxis/`. They must never be required to resume
the human-visible conversation from Claude Code.

`ContextAssembler` converts selected shared resources into provider-neutral
system messages for each run or resume invocation. The same system message
remains present across that invocation's tool loop. System context is ephemeral
input: it is not appended to the shared Claude transcript. Path-conditional
rules stay out of base context; a successful matching `Read` appends the native
Claude `nested_memory` attachment and reloads projected messages before the next
model turn. That attachment is authoritative resume context for both tools.
Skills, commands, agents, hooks, and MCP remain separate extension inputs
instead of being injected wholesale into the base prompt. Commands and skills
expand on slash invocation; model-invocable skills are exposed through a
provider-neutral `Skill` tool whose result is followed by scoped user context.
Selected agent definitions add invocation system context and persist native
`agent-setting` metadata for resume. Linked memory details remain explicit
reads.

`ClaudeHookRunner` parses layered settings without rewriting them, executes
bounded command hooks, and interprets Claude-compatible JSON/exit semantics.
`ClaudeHookToolCoordinator` wraps tool preparation, permission, execution, and
failure paths while core runtime remains provider-neutral. Hook output before
SessionEnd persists as native `hook_success`, `hook_error`, and
`hook_additional_context` attachments; projected context is reloaded before the
next model turn. SessionEnd runs during teardown, after `last-prompt` on a
successful turn and after cancellation handling on an aborted turn. Matching
Claude Code 2.1.208, it does not append stdout or stderr to the transcript.

`ClaudeMcpToolRegistry` merges user, boundary-to-cwd project, and canonical
project-local Claude MCP sources. It delegates protocol behavior to the
official MCP SDK, maps discovered tools to Claude's `mcp__server__tool` names,
and wraps local tools without changing the provider-neutral runtime port.
Stdio and HTTP clients are connected before model execution and closed after
the run or resume turn completes.

`ContextBudget` estimates provider-neutral request size across ephemeral system
messages, active transcript projection, current prompt, and tool definitions.
Provider capability or explicit CLI configuration supplies the window; Praxis
does not guess model limits. `ModelCompactor` uses the active provider without
tools, budgets its own request against the full provider window, and enforces a
bounded, non-empty summary. `ClaudeSessionService` writes
the native boundary/summary pair as one leased append, then projects only the
latest summary onward while retaining historical nested-memory attachments.
When compaction happens inside an active turn, current user messages are
replayed verbatim after the summary before model execution continues.
Compaction failure, cancellation, or an oversized summary leaves no partial
compact records.

Detailed contract: [COMPATIBILITY.md](COMPATIBILITY.md).

## Clean-room rule

Claude Code may be used to identify observable behavior and build black-box
fixtures. Its source code must not be copied into Praxis.
