# Agent Runtime Contract

## Scope

This contract defines the native Praxis runtime. It preserves the observed
developer-facing CLI semantics while keeping the domain provider-neutral and
single-user.

## Execution state machine

```text
idle
  -> scheduled-prompt -> assembling-context ...
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
7. Compaction appends summary metadata supported by the native transcript
   schema.
8. Shared command hooks run at their lifecycle seam with bounded output,
   timeout, and cancellation. The local single-user surface covers setup,
   session/turn, tool/permission, notification/failure, subagent, compaction,
   task, instruction, and cwd lifecycle events where Praxis owns the
   corresponding lifecycle. CwdChanged/FileChanged command hooks maintain a
   bounded local watcher. CwdChanged replaces the dynamic `watchPaths` set;
   FileChanged replaces it when a hook returns a non-empty set. Setup,
   SessionStart, CwdChanged, and FileChanged command hooks receive a per-session
   `PRAXIS_ENV_FILE`; subsequent Bash tools in that same session receive literal
   `export NAME=value` entries as environment variables. Praxis ignores shell
   commands and expansions in these files, and stores them under the private
   native `state/session-env` sidecar.
   Successful environment-hook `systemMessage` output is a notice, while
   execution failures remain warnings. PreToolUse changes precede permission checks;
   PermissionDenied observes only final auto-mode classifier denials and its
   verified `retry` output adds a Claude-compatible model follow-up;
   TaskCompleted blockers run before mutation;
   TaskCreated blockers remove the just-created task while retaining its
   monotonic ID; and Stop blocking creates an explicit persisted continuation
   turn. Async command hooks never add transcript context and are drained or
   cancelled within a bounded shutdown window. SessionEnd runs during successful or cancelled
   teardown without persisting output, matching Claude 2.1.208. Its teardown
   failure emits a warning without replacing the completed result or primary
   runtime error. Unknown and deferred hook executors remain readable in shared
   settings but are never executed.
9. Shared MCP tools use the same permission, hook, cancellation, observation,
   and transcript path as local tools. Client transports close at turn end;
   an unavailable server warns and does not hide healthy servers.
10. MCP elicitation requests cross the stream-json control boundary as a
    `control_request` with subtype `elicitation`; only validated `accept`,
    `decline`, or `cancel` responses are returned to the server. Out-of-band
    completion notifications emit a typed runtime event and native
    `elicitation_complete` system record.
11. Completed main-agent tool batches may produce a non-critical
    provider-backed `tool_use_summary` event before the next model turn. The
    event references every preceding tool-use ID; summary cancellation or
    generation failure never changes tool results or primary turn outcome.
12. Budgeting includes ephemeral system context, active transcript messages,
    current prompt, and tool definitions before every provider call. Automatic
    compaction summarizes completed history before appending a new prompt; after
    completed tool results it may compact between model turns. Unresolved tool
    calls are never compacted. Between-turn compaction replays current user
    messages verbatim after the summary, and the compactor's own provider call
    must fit the configured full context window.
13. Resume never silently replays an interrupted tool call. Recovery prepares
    the call through the current hook/tool pipeline, asks once against the
    actual prepared input, then applies the current deny/ask/allow policy.
    Decline leaves the append-only transcript unchanged.
14. Child processes do not inherit credential-named ambient variables or shell
    startup injection. Explicit MCP env/header values are per-server grants;
    stdio env grants resolve only defined `${NAME}` references at server
    admission without mutating resource definitions. Reconnect retains that
    derived grant state, while reload derives it again from the current
    registry environment. Resolved secret values are redacted from matching
    definitions, results, warnings, and errors before they enter model, CLI, or
    transcript paths. Hook JSON is interpreted before redaction so executable
    input/permission semantics remain unchanged. Plain,
    structured, and interactive CLI diagnostics redact ambient credentials, and
    Bash/hook output limits are enforced after redaction.
15. Image tool results cross core as typed base64 payloads only when the active
    provider advertises image input. Unsupported providers receive an explicit
    error result; Praxis never persists an image the next model turn cannot
    consume. Native image writes require exact message/metadata pairing.
16. Session-only scheduled prompts live for one interactive service. Durable
    prompts preserve Claude's project-local document, avoid a live foreign
    process owner, and enter the ordinary prompt/runtime path only once while
    the UI is idle. Closing the service cancels waiters and clears in-memory
    jobs; it does not delete durable jobs.
17. Dynamic wakeups are independent process-local one-shots. They clamp delay,
    enter the same idle queue, and are removed before delivery. Stop and close
    cancel pending or queued dynamic work without modifying fixed Cron jobs.
18. Model turns have no implicit runtime limit. A caller may opt into a finite
    positive-integer limit; it counts provider model calls only and fails once
    at the exact boundary without replacing the independent tool-call, retry,
    cancellation, context, or cost bounds.
19. Completed streamed tool calls are scheduled through a synchronous,
    input-aware registry policy. Verified read/search calls may overlap and
    publish progress/results in completion order. Missing, invalid, or throwing
    policies are exclusive, and an exclusive call is a FIFO barrier. Stateful
    transcript/hook decorators may additionally defer execution until the
    assistant tool-use entry is durable. Bash reuses the permission layer's
    conservative read-only analysis, and MCP concurrency requires an explicit
    read-only annotation. Foreground Bash has a 600,000 ms default ceiling and
    retains a validated canonical final cwd per session when the shell returns
    or runs its exit lifecycle, until an explicit host cwd transition replaces
    it. A command that replaces the shell process with `exec` keeps the last
    validated cwd. Cancellation produces one terminal result per emitted call
    while only tools that opt in receive the parent abort.
20. Provider-visible prompt context is composed from ordered sections with
    stable identities, placements, and lifetimes. Product policy is the static
    prefix; shared resources, date, runtime snapshot, and capability guidance
    are lifecycle-scoped; changing MCP instructions and turn-owned plan/memory
    state stay after the stable prefix. Custom system context replaces the
    product base, append context layers after the stable session sections, and
    bare mode loads no automatic context. Ordinary turns do not refresh session
    snapshots; compact, resource/tool reload, and cwd/worktree transitions
    invalidate only their dependent inputs. Prompt context remains ephemeral
    and never creates transcript fields. The provider-neutral model request
    carries the leading stable-system-message count; adapters validate or
    render that hint according to their declared capabilities.
21. A foreground subagent may transfer its existing operation and abort
    controller to the background registry. The transfer does not replay model
    or tool work and detaches parent cancellation only after adoption. Live
    background Agents support individual and explicit bulk kill with one
    terminal notification each; service close silently aborts and boundedly
    drains them. The session task runtime retains actual executor ownership
    across turns and routes later output, messaging, and stop operations by
    exact ID or unique name; ambiguous names fail without dispatch. Terminal
    notifications from prior-turn owners drain at later stop boundaries without
    waiting for still-running prior work.
    Retained sidechains hydrate without provider work. Completed, failed,
    killed, and interrupted state is distinguished by a private lifecycle
    sidecar. Terminal result, already-settled partial usage, and stable
    notification identity are persisted before settlement; fresh executors
    discover pending terminal notifications at stop boundaries, append them
    one at a time before acknowledgement, and both fresh and live executors
    reconcile append-before-ack retries without duplicate delivery. Hosted
    side-question delivery reserves ownership before asynchronous launch,
    restarts for later messaging continuations, and uses a pre-append intent
    plus post-append confirmation so its private detached accounting contributes
    usage once to durable session totals. Close wakes notification waiters and cancels notification
    lease retries without
    consuming their pending sidecars. Corrupt or ambiguous automatic recovery
    warns per sidechain; only `SendMessage` starts one filtered continuation.
    Shared Claude JSONL and metadata remain append-only and contain no
    Praxis-only operational fields. Retained worktrees restore only after Git
    registration validation, otherwise recovery warns and uses the unchanged
    parent cwd.
22. The CLI composition root may provide one fresh
    `(model?: string) => ModelProvider` factory for auxiliary logical Turns. An Agent initial execution, Workflow
    invocation, Team generation, and Project-memory extraction/selection
    operation allocates one client before its request or model/tool loop and
    keeps that client through the loop. A later background `SendMessage` continuation or
    recovered execution allocates a new client from the selected primary route.
    Native sidechain metadata may retain only an optional provider-neutral
    selected model identifier; it never retains provider/profile, fallback
    route or seal, protocol, response, credential, or wire state. Session-memory
    requests reuse a service-owned completion-scoped client whose routing
    restarts from primary for each request; auto-mode critics and eval-judge
    votes remain independently constructed one-shot clients. Callers without
    the factory retain their stable-provider/provider-for-model behavior.

## Core ports

The runtime depends on behavior, not SDK or filesystem implementations:

- `ModelProvider`: capabilities, streaming completion, cancellation, usage;
- `ToolRegistry`: schema discovery, synchronous fail-closed scheduling policy,
  and invocation;
- `PermissionResolver`: deterministic local allow/ask/deny decision;
- `PromptComposer`: ordered section manifest, stability, and message placement;
- `ContextAssembler`: lifecycle snapshots and focused invalidation of prompt
  inputs;
- `Transcript`: load snapshot and optimistic append;
- `RuntimeEventSink`: TUI, JSON output, diagnostics;
- `Compactor`: summary proposal and fidelity checks.

Provider adapters retain native streaming and caching features behind explicit
capabilities. They do not leak provider payloads into core events or shared
Praxis transcripts.

Providers that advertise terminal-reason support emit exactly one final
`terminal` event for each successful stream. The provider-neutral reasons are
`end_turn`, `tool_use`, `max_tokens`, and `prompt_too_long`. No content, usage,
or timing event may follow the terminal event. The runtime rejects a missing,
duplicate, unknown, or tool-call-inconsistent terminal reason before invoking
turn policy. Providers without the capability retain the legacy inferred
boundary until their adapter adopts the typed protocol.

Provider failures use a typed, payload-free classification for authentication,
billing, rate limits, invalid requests, server/API failures, overload, timeout,
context overflow, transport failure, and cancellation. Native status codes,
error objects, and stream stop fields remain inside adapters. Retry/fallback
buffers an attempt until its terminal event so a discarded partial attempt
cannot replay content or usage.

For each main run or resume, the CLI creates a fresh turn-scoped client. One
wrapper owns bounded retry, failed-attempt buffering, request-aware fallback
admission, and the sealed route through that turn's tool continuations.
Incompatible fallback routes fail closed; the next main user turn starts from
the primary route. A `prompt_too_long` reactive compaction retry retains the
same turn client. The same optional factory gives each multi-completion
auxiliary logical Turn its own client: Agent initial/follow-up/recovery,
Workflow, Team, and Project-memory extraction/selection remain sticky through
their own tool continuations, while independent follow-ups and recovered runs
start fresh from primary. Session-memory requests remain isolated through
completion-scoped routing that restarts from primary; auto critic and eval-judge
calls remain independently constructed one-shot requests.

A typed `prompt_too_long` failure bypasses ordinary retry and provider fallback.
The runtime settles any scheduled tool calls but commits no assistant output and
runs no Stop hook for the rejected attempt. When a context budget is available,
the session boundary may compact committed history and retry exactly once, only
when the committed projection has lower occupancy. Intermediate provider errors
remain private to that recovery boundary. Streamed output stays live; if the
terminal signal rejects that attempt, a typed discard event instructs
presentation/protocol consumers to reset its uncommitted assistant, thinking,
usage, and terminal projection before recovery. Cancellation wins during
compaction or retry; otherwise an exhausted recovery emits the original typed
failure exactly once. A failed or non-shrinking compaction leaves the
append-only history unchanged.

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

`last-prompt` is committed only after a successful turn. Its `leafUuid` points
to the final active assistant or completed local-command output, so metadata-only
writes cannot promote an abandoned physical branch. Compaction and graceful
close append one current durable metadata record per supported type. Close
refreshes externally mutable title and tag records through bounded head/tail
windows before appending; a user `custom-title` always outranks `ai-title`.
Operational indexes and cost remain private sidecars and never become shared
transcript entry types.

Resume classifies the active model-visible tail independently from transcript
discovery. Ordinary resume never replays it automatically. The explicit
`CLAUDE_CODE_RESUME_INTERRUPTED_TURN` recovery control removes a plain orphan
prompt before replaying it once. A completed tool result or context attachment
is retained and receives one clean-room continuation prompt instead of
re-running the original request. Unresolved tool execution remains separately
opt-in and permission-checked.

Session discovery reads 64 KiB from the head and 128 KiB from the tail with a
32-worker file pool. It ignores an uncommitted partial final line and isolates
malformed candidates; full JSONL and graph validation occurs only for
inspect/resume. Implicit continue preserves deterministic list order, excluding
live top-level background sessions when liveness is available and falling back
to the same order when it is not. An explicitly supplied regular `.jsonl` path
is validated in full, selects the newest non-sidechain leaf, and pins subsequent
appends to that exact file. Native discovery never searches the Claude root.

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

Opt-in SDK file checkpointing writes non-tail snapshot/delta records plus
bounded backups in the native file-history directory. File rewind is a
standalone, provider-free resume operation: validate the target user UUID,
backup metadata, allowed roots, and all backup bytes before atomically restoring
or deleting any tracked path. It never rewrites the append-only conversation;
forks omit file-history records because their backups remain source-session
state.

## Project-memory contract

Project memory is durable cross-session context, separate from the append-only
Transcript and asynchronous Session memory. Native runs store it under the
Praxis root. The directory is keyed by the canonical main git repository, so
linked worktrees share one `MEMORY.md` index and its Markdown topic files.

The index is injected as background context only and is bounded to its first
200 lines and 25 KiB. Topic frontmatter supports `name`, `description`, and the
closed `user | feedback | project | reference` taxonomy. Untyped, legacy, and
unknown-type topics remain readable. Project memory must not become an
instruction-priority channel or duplicate repository instructions, transient
task state, codebase architecture, implementation patterns, git history, or
fix recipes.

`autoMemoryEnabled: false` is the shared settings switch. Native runs also
recognize `PRAXIS_DISABLE_AUTO_MEMORY` and the Claude-compatible
`CLAUDE_CODE_DISABLE_AUTO_MEMORY` alias. Disabling it suppresses index reads
and injection, maintenance guidance, memory-root tool access, background
extraction, and selective recall.

The compatible default is bounded index injection plus direct main-agent
maintenance. Background extraction and selective recall are explicit local
capabilities through `projectMemory.backgroundExtraction` and
`projectMemory.selectiveRecall`, or the native environment switches
`PRAXIS_PROJECT_MEMORY_EXTRACTION` and `PRAXIS_PROJECT_MEMORY_RECALL`.
Extraction runs after a successful final main-agent stop, never blocks response
delivery, advances its private cursor only after success, coalesces overlapping
turns, and is drained with a bounded close. Its isolated agent has no
transcript, subagent, remote, or non-memory tools.

Each Project-memory selection or extraction operation obtains one fresh client
from the optional turn factory and retains it through its complete request and
tool loop. The next operation obtains another client and starts from its
primary route; no provider route or native state is persisted.

Selective recall starts at most once per user turn and never delays the main
loop. A settled selector may attach zero to five previously unsurfaced topics
only after a tool boundary. Candidate metadata is limited to the 200 newest
topics; attachments are capped at 200 lines/4 KiB per file, 20 KiB per turn,
and 60 KiB per session. Selector, parse, filesystem, and cancellation failures
fail empty. A compact boundary permits relevant topics to surface again.

## Error contract

- Unsupported Claude schema: read-only inspect/export, no shared writes.
- Live or unrecognized lock held: refuse append. A recognized PID/token lock is
  reclaimed only after its owner process is confirmed dead.
- Tail changed: refuse append and offer explicit fork/reload.
- Write interleaving detected after fsync: mark session read-only and require
  reload/fork; never truncate either writer's entries.
- Provider failure: persist only native events already completed.
- Explicit model-turn exhaustion: emit one `error_max_turns` result after the
  configured number of provider calls; keep already completed transcript
  entries append-only.
- Tool failure: append an error `tool_result`, then let model decide.
- Corrupt/truncated JSONL: preserve file, report line and offset, read-only
  inspect/export; never auto-truncate or hide other sessions.
- Context overflow: compact when a window is configured and history is
  compactable; otherwise fail with estimated, window, reserve, available, and
  overflow token data. A summary that still does not fit is not persisted.

## MVP boundary

Included:

- interactive and print-mode CLI;
- one foreground main loop with bounded foreground/background subagents;
- Anthropic-compatible and OpenAI-compatible provider adapters;
- file read/write/edit, search, shell, and MCP tools;
- PNG, JPEG, GIF, and WebP results from the local `Read` tool;
- user image/document inputs and ordered MCP media/structured-content results;
- local permissions, sessions, resume/fork, compaction, PRAXIS.md, auto memory,
  skills, commands, agents, hooks, and MCP compatible subset;
- text and structured JSON output;
- top-level persistent background sessions, durable task graphs, and
  foreground/background Bash lifecycle;
- session-only and shared durable Cron prompts plus fixed-interval `/loop`;
- interactive process-local dynamic `ScheduleWakeup` one-shots;
- resumable sandboxed Workflow runs with exact Claude 2.1.208 chained replay keys and
  fail-closed semantic/ordered fallbacks.

Deferred:

- IDE, browser, desktop, or remote-control surfaces;
- accounts, teams, organization policy, billing, telemetry control planes;

Stream JSON event contract: runtime/provider events are the sole source for
machine records. Compaction, tool timing, retry, and task lifecycle records
must not be synthesized by scanning transcripts. Subscription auth/rate-limit
events remain outside single-user provider-neutral scope.

## Acceptance gate

Runtime implementation starts only after versioned path/schema fixtures,
lossless JSONL parsing, provider translation, ownership policy, and concurrent
tail protection pass in CI. Runtime MVP is complete only when the same scenario
suite passes against every provider adapter and Claude/Praxis resume works in
both directions.
