# Agent Runtime Contract

## Scope

This contract defines the runtime Praxis may implement after compatibility
Sprint 0 passes. It preserves Claude Code's proven CLI agent semantics while
keeping the domain provider-neutral and single-user.

## Execution state machine

```text
idle
  -> assembling-context
  -> awaiting-model
  -> streaming
  -> awaiting-permission -> executing-tools -> persisting-results
  -> awaiting-model ...
  -> compacting -> awaiting-model ...
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

Sprint 1 fork is text-only: it projects visible user/assistant text and creates
a new validated UUID/parent chain. It does not copy provider reasoning, queue
operations, tool state, images, sidechains, or compaction metadata. Later fork
profiles require their own versioned writer and Claude reopen probe.

## Error contract

- Unsupported Claude schema: read-only session, no shared writes.
- Tail changed or lock held: refuse append and offer explicit fork/reload.
- Write interleaving detected after fsync: mark session read-only and require
  reload/fork; never truncate either writer's entries.
- Provider failure: persist only native events already completed.
- Tool failure: append an error `tool_result`, then let model decide.
- Corrupt/truncated JSONL: preserve file, report line and offset, read-only
  recovery; never auto-truncate.
- Context overflow: compact when supported or fail with actionable token data.

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
