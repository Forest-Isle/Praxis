# Agent Runtime Contract

## Scope

This contract defines the runtime Praxis may implement after compatibility
Sprint 0 passes. It preserves Claude Code's proven CLI agent semantics while
keeping the domain provider-neutral and single-user.

## Execution state machine

```text
idle
  -> assembling-context
  -> compacting -> awaiting-model ...
  -> awaiting-model
  -> streaming
  -> awaiting-permission -> executing-tools -> persisting-results
  -> awaiting-model ...
  -> completed | cancelled | failed
```

Rules:

1. One run owns one session write lease.
2. Model output becomes typed runtime events before UI or persistence observes
   it.
3. A tool executes only after an `allow`, `ask`, or `deny` decision.
4. Tool calls with no result are never silently treated as successful.
5. Cancellation propagates from CLI to model stream and child processes.
6. Completed user, assistant, and tool-result events append immediately to the
   shared transcript; transcript history is never rewritten.
7. Compaction appends Claude-native summary metadata only after a compatibility
   adapter proves the active Claude version accepts it.
8. Shared command hooks run at their lifecycle seam with bounded output,
   timeout, and cancellation; PreToolUse changes precede permission checks and
   Stop blocking creates an explicit persisted continuation turn. SessionEnd
   runs during successful or cancelled teardown without persisting output,
   matching Claude 2.1.208. Its teardown failure emits a warning without
   replacing the completed result or primary runtime error.
9. Shared MCP tools use the same permission, hook, cancellation, observation,
   and transcript path as local tools. Client transports close at turn end;
   an unavailable server warns and does not hide healthy servers.
10. Budgeting includes ephemeral system context, active transcript messages,
    current prompt, and tool definitions before every provider call. Automatic
    compaction summarizes completed history before appending a new prompt; after
    completed tool results it may compact between model turns. Unresolved tool
    calls are never compacted. Between-turn compaction replays current user
    messages verbatim after the summary, and the compactor's own provider call
    must fit the configured full context window.
11. Resume never silently replays an interrupted tool call. Recovery prepares
    the call through the current hook/tool pipeline, asks once against the
    actual prepared input, then applies the current deny/ask/allow policy.
    Decline leaves the append-only transcript unchanged.
12. Child processes do not inherit credential-named ambient variables or shell
    startup injection. Explicit MCP env/header values are per-server grants;
    matching definitions, results, warnings, and errors are redacted before
    they enter model, CLI, or transcript paths. Hook JSON is interpreted before
    redaction so executable input/permission semantics remain unchanged. Plain,
    structured, and interactive CLI diagnostics redact ambient credentials, and
    Bash/hook output limits are enforced after redaction.

## Core ports

The runtime depends on behavior, not SDK or filesystem implementations:

- `ModelProvider`: capabilities, streaming completion, cancellation, usage;
- `ToolRegistry`: schema discovery and invocation;
- `PermissionResolver`: deterministic local allow/ask/deny decision;
- `ContextAssembler`: instructions, memory, skills, history, token budget;
- `Transcript`: load snapshot and optimistic append;
- `RuntimeEventSink`: TUI, JSON output, diagnostics;
- `Compactor`: summary proposal and fidelity checks.

Provider adapters retain native streaming and caching features behind explicit
capabilities. They do not leak provider payloads into core events or shared
Claude transcripts.

## Turn persistence

Praxis translates provider-completed events into Claude-native entries:

```text
user text
  -> assistant text

user text
  -> assistant tool_use
  -> user tool_result
  -> assistant text
```

Each entry receives a UUID and points to the prior persisted UUID. Provider raw
responses, reasoning blocks that lack a Claude-native representation, retry
state, and indexes remain disposable sidecars. A crash may leave a completed
tool call without its result; resume must surface that state and recover or ask,
never invent a result.

Fork creates a new transcript exclusively and copies the supported native
main-chain history losslessly, replacing only `sessionId`. It retains original
UUIDs, parent links, message/tool payloads, compact boundaries and summaries,
attachments, agent settings, titles, images, errors, and interruption records.
The latest title, mode, and permission state are placed first and the latest
`last-prompt` last, matching the Claude 2.1.208 fork profile. Queue operations
and file-history snapshots/deltas are transient and omitted. Unknown entry
types, mismatched source session IDs, malformed UUID/parent/tool/compact/leaf
links, and unsupported Claude versions fail closed before the
target file is created. Subagent sidechains and a `last-prompt` whose logical
UUID leaf is absent from copied history or no longer current are excluded from
the main-session fork. Native Claude may use a user, system, or attachment UUID;
Praxis-generated append metadata remains restricted to assistant leaves.

## Error contract

- Unsupported Claude schema: read-only inspect/export, no shared writes.
- Live or unrecognized lock held: refuse append. A recognized PID/token lock is
  reclaimed only after its owner process is confirmed dead.
- Tail changed: refuse append and offer explicit fork/reload.
- Write interleaving detected after fsync: mark session read-only and require
  reload/fork; never truncate either writer's entries.
- Provider failure: persist only native events already completed.
- Tool failure: append an error `tool_result`, then let model decide.
- Corrupt/truncated JSONL: preserve file, report line and offset, read-only
  inspect/export; never auto-truncate or hide other sessions.
- Context overflow: compact when a window is configured and history is
  compactable; otherwise fail with estimated, window, reserve, available, and
  overflow token data. A summary that still does not fit is not persisted.

## MVP boundary

Included:

- interactive and print-mode CLI;
- one foreground agent loop;
- Anthropic-compatible and OpenAI-compatible provider adapters;
- file read/write/edit, search, shell, and MCP tools;
- local permissions, sessions, resume/fork, compaction, CLAUDE.md, auto memory,
  skills, commands, agents, hooks, and MCP compatible subset;
- text and structured JSON output.

Deferred:

- parallel sub-agent orchestration;
- IDE, browser, desktop, or remote-control surfaces;
- accounts, teams, organization policy, billing, telemetry control planes;
- transcript migration across unsupported Claude versions.

## Acceptance gate

Runtime implementation starts only after versioned path/schema fixtures,
lossless JSONL parsing, provider translation, ownership policy, and concurrent
tail protection pass in CI. Runtime MVP is complete only when the same scenario
suite passes against every provider adapter and Claude/Praxis resume works in
both directions.
