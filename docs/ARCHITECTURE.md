# Architecture

## Direction

Praxis preserves proven CLI agent semantics while rebuilding the code around a
single-user, local-first product boundary.

Core behavior:

```text
input -> context -> model stream -> tool call -> permission -> execution
      -> tool result -> continue, compact, or finish
```

The core tool scheduler can start completed calls during the model stream, but
only registry-verified read/search calls participate in overlap. Consecutive
safe calls overlap; exclusive calls form FIFO barriers, and stateful
transcript/hook wrappers may defer their execution until assistant persistence.
Result events follow completion order, while append-only transcripts always
retain assistant-tool-use before tool-result ordering. Registry decorators
either delegate the synchronous policy or explicitly remain exclusive, so
unknown or classifier-failing tools never become concurrent by composition.

## Intended modules

```text
src/
├── cli/           terminal UI and structured output
├── application/   run, resume, inspect, and configure use cases
├── core/          Praxis Core Contract and provider-neutral domain types
├── providers/     capability-aware model adapters
├── tools/         local executable capabilities
├── extensions/    skills, commands, and agents
├── hooks/         shared hook parsing, execution, and tool coordination
├── mcp/           shared MCP config, clients, and tool adapter
├── persistence/   native storage, sessions, transcripts, and indexes
├── sandbox/       settings conversion and OS sandbox runtime adapter
├── security/      workspace trust and other authorization policy
└── platform/      filesystem, process, keychain, and OS adapters
```

## Hard boundaries

- `core` must not import React, Ink, model-vendor SDKs, filesystem, or storage.
- Provider adapters depend inward on the Praxis Core Contract; core never
  imports provider implementations or provider wire types.
- Runtime modules depend on core, platform, and shared seams; storage and
  session behavior is implemented by the Praxis-native path.
- `npm run check:boundaries` rejects reverse source imports. `npm run
build:native` emits the implemented core/provider/native transcript and
  session profile, while
  `npm run test:native:deletion` is an executable emitted-output deletion gate.
  This profile and gate are implemented; the full native package is not yet
  qualified.
- The CLI observes runtime events; it does not own agent state.
- Praxis `praxis.transcript` v1 JSONL transcripts remain authoritative and
  append-only. Claude-shaped message/tool fields are protocol data only; the
  runtime never reads or writes Claude Code session files.
- Provider adapters expose capabilities instead of flattening every model to a
  lowest-common-denominator API.
- Tool permissions are local `allow`, `ask`, or `deny` decisions.
- Sandbox auto-allow is available only after the execution adapter confirms the
  same Bash call will run under an active OS sandbox; explicit deny and ask rules
  remain authoritative.
- Child-process adapters share one ambient-environment sanitizer and one exact
  credential redactor; shell startup files cannot repopulate stripped values.
- No tenant, organization, role, entitlement, billing, remote-control, or
  telemetry domain exists.

## Provider configuration and routing

The CLI composition root resolves configuration in a fixed sequence:

```text
user settings + CLI/environment + project/local selection as inert data
  -> canonical exact-fingerprint trust preflight for project/local selection
  -> Provider Registry (credential resolver + native Vault; adapter + billing mode)
  -> capability-aware protocol Adapter
  -> existing ModelProvider port -> Agent runtime consumers
```

The Registry creates OpenAI-compatible Chat Completions, the public OpenAI
Responses adapter, Anthropic Messages, or the private experimental Codex
subscription adapter. For each main run or resume, the CLI creates a fresh
turn-scoped client. One wrapper owns bounded retry, failed-attempt buffering,
request-aware fallback admission, and the sealed route used by that turn's
tool continuations. Incompatible fallback routes fail closed, and the next
main user turn starts from the primary route. Provider wire payloads do not
enter core or transcripts; unsupported capabilities fail closed.

This turn-scoped seam is also propagated to auxiliary consumers. Each Agent
initial execution, Workflow invocation, Team generation, and Project-memory
extraction/selection operation allocates a fresh client and retains it through
its logical Turn's tool loop. Later background SendMessage continuations and
fresh-process recovered executions allocate another client and start from
primary. Session-memory requests reuse one service-owned completion-scoped
client but restart routing from primary for every request; auto-mode critics
and eval judges remain independently constructed one-shot clients. Recovery
hydration itself performs no provider work.

Anthropic Messages providers are composed as two ordinary `ModelProvider`
adapters, each with its own connect, byte-idle, and absolute-total deadlines.
The streaming attempt is buffered until terminal success. An explicitly marked
stream transport failure or byte-idle timeout triggers at most one bounded
non-streaming replay; partial text, thinking, usage, and tool calls from either
failed attempt never cross the runtime commit boundary. Connect/total timeout,
cancellation, HTTP/auth/rate-limit, prompt-too-long, and malformed-response
errors do not trigger this replay. OpenAI-compatible and Codex providers do not
install it. `PRAXIS_DISABLE_NONSTREAMING_FALLBACK=true` returns Anthropic to its
single streaming attempt.

A `prompt_too_long` reactive compaction retry retains the same turn-scoped
client and its routing state.

The Registry's billing mode composes metering behavior: API mode receives
pricing, cost, and budget enforcement, while subscription mode retains token
and model usage and omits API `costUsd`, rejecting numeric USD budget and
paid-judge paths before inference.

The public API-key OpenAI Responses adapter and the private Codex subscription
transport share one stateless Responses codec. The codec maps full,
provider-neutral local history to Responses items and parses Responses SSE;
each transport owns its authentication and headers. Public Responses uses the
standard Bearer, JSON, and SSE headers, while Codex retains its OAuth/account,
private headers, and fixed endpoint. The codec uses `store:false`, preserves
encrypted reasoning/function-call/output continuity locally, and never uses
`previous_response_id` or provider-native transcript fields. Public Responses
also does not receive the Anthropic non-streaming replay path.

Codex OAuth, token refresh, account identity, fixed endpoint, and
subscription-specific private headers remain private to
`CodexSubscriptionProvider`; its Responses mapping and streaming parsing are
implemented through the shared codec. This keeps the existing core port small
and prevents subscription-specific behavior from spreading into the Agent
loop.

The Ink interactive CLI is an event adapter under `src/cli`: it renders
`RuntimeEvent` state and streaming deltas, requests user decisions through the
existing `approveTool` callback, and starts or resumes application sessions.
Stateless presentation components under `src/cli/tui` provide the responsive
welcome card, Markdown/diff transcript, tool and thinking hierarchy, bounded
session picker, composer/status area, and decision dialogs. `InteractiveApp`
retains raw keyboard/lifecycle state while pure Help, Permissions, and
Decisions-domain projectors produce semantic models that `projectTuiScreen`
carries opaquely to visual and screen-reader adapters. A provider-neutral
streaming frame buffer (`src/cli/tui/streaming-frame-buffer.ts`) sits at the
presentation boundary: it coalesces high-frequency text/thinking deltas into
bounded frames published at a fixed cadence, flushes explicitly at lifecycle
boundaries, and disposes with the mounted app. Active streaming text renders
through a bounded window of stable Markdown lines plus a plain pending tail so
an incomplete fence or heading cannot corrupt the frame and the growing
document is not reparsed every frame; completed turns still render the full
Markdown transcript exactly. Fullscreen mode
also bounds the Ink root to live terminal rows, projects the newest transcript
tail through a deterministic suffix viewport
(`src/cli/tui/transcript-viewport.ts`) so the newest user/assistant content
and the active stream stay visible while active, and keeps the composer/status
area outside the shrinkable transcript region. Classic mode retains full-history
semantics. TUI-only display
metadata never enters shared transcripts. React and Ink do not enter `core`,
application services, providers, tools, or shared persistence. Headless text
and NDJSON modes retain the same runtime ports without terminal prompts. See
[TUI_PARITY.md](TUI_PARITY.md).

Headless protocol adaptation also stays under `src/cli`. Argument parsing
normalizes Claude-style print/resume and machine-format options before the
application boundary. `StreamJsonOutput` projects provider-neutral
`RuntimeEvent` values into init, assistant, tool-result, partial, and terminal
result records; it never changes session state. Incremental stream input accepts
bounded UTF-8 JSONL user text records. One headless invocation owns one service
and MCP connection set across all streamed turns, then closes it exactly once.
The interactive TUI keeps one service while runtime controls and cwd remain
stable. Model, effort, permission, extension, workspace, and `/cd` changes
retire it before creating a replacement with the updated options; ordinary
turns retain one service so session-only scheduled prompts survive. Unknown
provider cost and API-only duration values stay `null` until provider ports
expose verified metering.

Automatically discovered workspace configuration crosses a separate canonical
exact-fingerprint trust preflight before project/local selection reaches the
Provider Registry and before hook runners or MCP transports are constructed.
`security/workspace-trust.ts` canonicalizes the workspace with `realpath`,
fingerprints project/local provider selection, hook, and MCP definitions plus their resolved
origins and hook execution environment, and compares that fingerprint with the
record under `projects[canonicalPath].workspaceTrust` in native `state.json`.
The mutation shares the native state lease, no-follow read, compare-before-
commit, and atomic `0600` replacement conventions. User-scope and explicit CLI
resources remain authorized; rejection ignores project/local provider selection
and removes project/local hook and MCP resources. Interactive approval occurs
before the renderer owns stdin, while a
new fingerprint discovered after renderer startup is blocked until restart.
Headless runs never prompt and emit the `--trust-project` remediation warning.
Tool permission bypass, sandbox mode, and stored path identity do not broaden
this exact-fingerprint grant. Plugin MCPB preflight is side-effect-free: local
references contribute an archive hash and remote references contribute their
exact HTTPS URL. Workspace MCPB downloads, extraction, and cache writes occur
only after that fingerprint is trusted; user-scope MCPB remains explicitly
authorized.

Detached workers receive `PRAXIS_PROVIDER`, `PRAXIS_PROVIDER_PROFILE`,
`PRAXIS_MODEL`, `PRAXIS_BASE_URL`, `PRAXIS_PROVIDER_DEADLINE_MS`,
`PRAXIS_PROVIDER_CONNECT_TIMEOUT_MS`, `PRAXIS_PROVIDER_IDLE_TIMEOUT_MS`, and
`PRAXIS_DISABLE_NONSTREAMING_FALLBACK` through the sanitized environment and
use the same provider resolver. The provider lifecycle module keeps an
absolute-total clock while connect runs until response headers and byte-idle
resets on every non-empty body chunk.
Before spawn, the parent resolves an API-key credential through the selected
target and passes only normalized `PRAXIS_API_KEY`; it never forwards the
configured custom credential variable. Codex OAuth remains in the shared Vault,
while the credential-store selector and safe/bare/simple policy survive the
worker boundary.

Interrupted-tool recovery uses a separate `approveRecovery` port. The runtime
invokes it after tool/hook preparation so the UI displays the input that would
actually execute. One explicit recovery approval satisfies an `ask` decision,
while a current `deny` rule still produces an error result. Missing or declined
approval leaves the unresolved transcript prefix untouched.

Release performance is guarded at public storage and process boundaries rather
than through implementation-specific microbenchmarks. A deterministic local
probe budgets production CLI process startup, 500-session discovery, and
20,000-entry transcript load, retained heap, and tail append. Provider,
network, Claude Code, and hook latency remain separate integration concerns.
See [PERFORMANCE.md](PERFORMANCE.md).

Release artifacts contain compiled `dist` output plus npm-required manifest,
README, and license files only. The package gate installs that tarball in an
empty project and exercises the real npm bin, preventing source-tree resolution
or symlink behavior from masking release failures. Native `praxis.transcript`
v1 is writable; unsupported schema versions and non-native files remain
read-only and are never migrated or mutated. See [RELEASE.md](RELEASE.md).

Provider selection stays at the CLI composition root. `core` receives the same
`ModelProvider` port whether the adapter serializes OpenAI Chat Completions,
OpenAI Responses, or Anthropic Messages, including the registry-owned
Anthropic recovery wrapper. Protocol adapters expose streaming text, usage,
tool schemas, tool calls, image input, cancellation, retry classification, and
explicit context-window capabilities without putting provider-native payloads
in shared transcripts. The public and Codex Responses transports share the
stateless Responses codec while retaining transport-owned authentication and
header differences.
The Anthropic full-response adapter normalizes its bounded response through the
same event state machine as SSE. Image tool results stay provider-neutral in
core: Anthropic keeps them nested under `tool_result`, while OpenAI-compatible
requests pair the tool result with a following user `image_url` message.

Native web search is an optional `ModelProvider` capability, not a generic HTTP
scraper. The Anthropic adapter translates the provider-neutral search request
to its server tool and projects links, citations, text, and usage back into the
runtime only when explicitly configured for a supporting model/relay.
`WebToolRegistry` composes over the local registry in normal and safe
modes; bare mode omits the wrapper. WebFetch stays provider-neutral: it pins
HTTPS requests to validated public DNS addresses, rechecks every same-host
redirect, bounds network/content/model output, converts supported documents to
Markdown, serializes untrusted page data behind a JSON boundary, and asks the
selected provider to process it.

## Native data plane

Praxis defaults to its independent local root, `PRAXIS_HOME` or `~/.praxis`.
The public data-plane facade selects the native `DataPlaneAdapter`, which owns
Praxis root and path construction. Native sessions, memory, tasks, scheduled
prompts, resources, and private state remain under `PRAXIS_HOME` or `~/.praxis`
and never require a Claude Code directory. Praxis-only indexes, provider
payloads, and locks live under `<praxis-root>/state/` and are never part of the
authoritative append-only transcript.

Session reads use a recovery parser that returns the valid prefix plus exact
line/byte diagnostics without changing the source file. Listing, inspection,
and raw export use this read-only path for supported, unsupported, and corrupt
sessions. Write leases use immutable PID/token metadata linked atomically into
the canonical lock path; a dead owner can be reclaimed, while live and
unrecognized lock formats remain conflicts. Before acquisition, a bounded
sidecar pass removes only recognized candidate/stale artifacts whose owner
PID is dead; live and unknown artifacts remain untouched. Reusable `.reclaim`
guards are reclaimed only inside the atomic guard protocol, never by the
background pass.

Background Agent calls return native async metadata immediately, then execute
against an independently leased native sidechain. A per-turn task manager owns
independent cancellation, bounded output waits, ordered messages, completion
notifications, and usage aggregation. Completed sidechains remain authoritative:
a later Praxis turn can hydrate one by its `a` plus 16-hex agent ID and continue
it through `SendMessage` without a private conversation store. Recovery rebuilds
the selected model client only when execution starts, using optional
provider-neutral model metadata; provider/profile, fallback route or seal,
protocol, response, credential, and wire state are never persisted or restored.

`ClaudeTaskToolRegistry` wraps selected base tools once per persisted session.
`ClaudeTaskStore` reads and writes native `tasks/<session-id>` JSON files,
maintains reciprocal dependency edges, and allocates from both
`.highwatermark` and observed task IDs so stale high-watermarks cannot collide.
New task files use exclusive atomic publication so an overlapping create is
never overwritten. Updates use stable file fingerprints and full-operation retry
to rebase requested fields over a simultaneous native writer; no-op updates do
not replace files. Praxis mutations and transcript appends share one
token-owned hard-link lease primitive with ownership-checked release and
guarded dead-owner reclaim. `TaskList` omits native internal tasks.
`BackgroundBashManager` uses the same bounded, credential-sanitized process
runner as foreground Bash, writes Claude-shaped temporary output, and persists
only validated resumable operational metadata through atomic sidecar
replacement. Malformed sidecars do not block resume. Blocking output expiry
reports `timeout`; successful terminal retrieval consumes the pending
completion notification. The
outer subagent registry routes `a...` IDs to Agent tasks and `b...` IDs to Bash
tasks without duplicate definitions. Nested agents share their parent task
graph and notification manager.

`TopLevelAgentManager` publishes an exclusive Claude-shaped job directory,
spawns the hidden detached worker entrypoint, lists owner-marked jobs, repairs
dead workers, and routes logs/attach/stop. `ClaudeJobStore` atomically replaces
state and dispatch files, serializes timeline changes, and bounds the recent
output log. The worker keeps its session runtime alive after a completed turn,
marks `sessions/<pid>.json` idle, and accepts serialized follow-up prompts over
an authenticated local Unix socket. Interactive `/background` allocates a fresh
blocked job identity without touching the source transcript; a private dispatch
reference lets the worker lazily fork the active native chain into the job
session on first attach. Job controls are operational state only; all resumable
conversation content stays in shared project JSONL.

`ScheduledPromptManager` owns session-only jobs in memory and durable jobs in
the native shared file `<praxis-root>/scheduled/<project-key>.json`.
`NativeScheduledTaskStore` preserves the established task fields, serializes
Praxis writers with a sidecar lease, and retries atomic replacement when the
physical native file changes. The manager
uses PID plus process-start identity to avoid stealing a live foreign job,
catches up expired one-shot tasks, bounds deterministic jitter, and queues due
prompts for the idle interactive runtime. Fixed `/loop` expansion remains an
extension command; active dynamic wakeups and Workflow orchestration stay
outside this component.

Starting a caller-selected session ID reserves its transcript with exclusive
creation while holding the Praxis lease. Any existing path, including an empty
JSONL file, is an identity collision. A claimed ID remains claimed if later
startup fails; retry must resume a valid transcript or choose a new ID, never
silently reuse the path.

`PromptComposer` owns one ordered, provider-neutral `ContextSnapshot` for
product, custom/agent, shared-resource, runtime, MCP, plan, Session-memory, and
output sections. Each section has a stable identity, placement (`system` or the
first user message), and lifetime (`static`, `session`, or `volatile`). The
ordered sections are the only authoritative representation; ordinary model
messages, first-user context, and the leading stable-system count are derived
together by a pure core projection. Provider cache fields are not part of the
snapshot. Main turns, side questions, prompt suggestions, compaction refreshes,
and subagents carry the derived stable count to capability-aware adapters
without teaching the composer any provider wire format.

`ContextAssembler` loads the composer inputs and always returns the canonical
lifecycle-scoped snapshot.

`ContextPreparation` owns the turn-scoped provider-visible boundary around that
snapshot: it combines stable then volatile system messages with decorated
active Transcript history, Project-memory recall, and pending input, followed
by a snapshot of active-tool definitions. Live history, settled memory,
volatile context, and tool activation are refreshed at projection time without
advancing the private history generation.

Native context keeps environment and memory stable for a lifecycle and resolved
cwd, while recomputing Git status for every assembly from the caller-resolved
cwd (including isolated subagent worktrees). Default Git status is a volatile
`system` section outside the stable-system prefix; explicit relocation keeps a
volatile first-user wrapper. The rendered Git block is capped at 2,048 UTF-8
bytes with an exact `... [truncated]` marker, collected with
`--no-optional-locks`, and omitted when repository detection or status fails.

The private turn execution module owns the complete per-submission order:
transcript lease, hooks and recovery, context projection, AgentRuntime rounds,
accounting, and Session/Project memory observation. It is the sole owner of a
Turn's terminal transition, emitted only after that order completes or its
cleanup finishes. Session lifecycle retains discovery, fork, rename, and
resource reload operations, while `AgentRuntime` retains model and tool rounds.

Ordinary turns and subagent model rounds reuse byte-identical session sections.
Compact and explicit resource reload refresh shared resources; tool-pool
changes refresh capability guidance and the volatile per-server MCP suffix;
worktree/cwd transitions discard the affected lifecycle snapshot. A new,
restored, forked, or cleared lifecycle gets its own snapshot. System context is
ephemeral input: it is not appended to the shared transcript. Path-conditional
rules stay out of base context; a successful matching `Read` appends the native
Claude `nested_memory` attachment and reloads projected messages before the next
model turn. That attachment is authoritative resume context for both tools.
Commands and skills expand on slash invocation; enabled tool and
model-invocable-skill names appear only as bounded session guidance, while a
skill body remains behind the provider-neutral `Skill` tool. MCP server
instructions are deterministic, provenance-labelled volatile sections rather
than cross-server concatenated prose.
Selected agent definitions add invocation system context and persist native
`agent-setting` metadata for resume. Linked memory details remain explicit
reads. CLI startup resolves and creates only the canonical project memory root;
standard `Read`, `Write`, and `Edit` may access that root in addition to the
workspace. Canonical-path and no-follow checks reject siblings and symlink
escapes, while `Grep` remains workspace-scoped.

`ProjectMemoryRecallController` and `ProjectMemoryExtractionController` are
deep application modules behind narrow runtime interfaces rather than branches
inside the Agent loop. A shared platform project-identity module canonicalizes
git roots and linked worktrees for all callers. The
default context path injects only the bounded `MEMORY.md` index. Capability-
gated recall prefetches bounded topic metadata concurrently and contributes an
ephemeral user-role background attachment only when already settled after
tools. Capability-gated extraction receives the active model-visible
user/assistant closure, persists its success-only cursor in the native private
state root, and delegates maintenance to an isolated four-turn runtime with
only memory-local `Read`, `Write`, and `Edit`. Neither capability writes private
fields to a shared transcript. Direct main-agent memory edits advance the same
cursor and suppress duplicate extraction for that range.

`ClaudeHookRunner` parses layered settings without rewriting them, executes
bounded command hooks, and interprets Claude-compatible JSON/exit semantics.
It parses raw JSON before redaction so `updatedInput` and permission behavior
retain their declared semantics, while commands, stdout/stderr, reasons, and
additional context cross the persistence/diagnostic boundary only after exact
credential redaction. Hook shells disable user startup files and receive a
credential-sanitized environment plus `CLAUDE_PROJECT_DIR`.
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
Capability-aware discovery keeps resource-only servers connected, caches
bounded paginated resource listings, and exposes Claude's three resource tool
schemas only while at least one resource-capable server is live. Text reads are
serialized into ordinary tool results; binary reads use the session-scoped
`tool-results` directory passed through `ToolExecutionContext` and never embed
the raw blob in provider or transcript content. Text-only MCP tool results at
or below 100,000 UTF-8 bytes remain inline. Larger results are redacted, stored
as mode-`0600` `.txt` files in the same session-scoped directory, and replaced
in provider and transcript content by one bounded instruction containing the
absolute path. Structured content, mixed media, and binary-resource handling
remain unchanged. A connected tool declaring `readOnlyHint: true` contributes
grant-only, provider-neutral `ToolPermissionMetadata` during tool preparation.
The permission resolver consumes it only at its final default-decision seam;
explicit PreToolUse outcomes, permission rules and modes, sandbox/path/shell
safety, and automatic classification retain precedence. Missing or false hints
do not grant permission, and this metadata never enters tool definitions,
provider requests, transcripts, persisted state, or MCP protocol payloads. This
is a Praxis permission contract, not verified Claude Code 2.1.208 parity.
Stdio and HTTP clients are connected before model execution and closed after
the run or resume turn completes. Stdio transports inherit sanitized ambient
runtime variables, then apply server-local `env` as an explicit grant.
Sensitive configured env/header values redact MCP definitions, results,
warnings, and error messages before those values reach the model, CLI, or
transcript.

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
compact records. Automatic and reactive replacements use a guarded monotonic
generation commit: the native Transcript append is the durable callback, and
hooks, invalidation, events, and accounting run only after that commit
succeeds.

`ClaudeSessionService.fork` is a version-gated native transcript operation,
not model-history replay. It loads one leased source snapshot, validates the
complete supported main chain, and exclusively creates a new JSONL file whose
entries preserve all native fields and identifiers except `sessionId`.
Latest title, mode, permission, and `last-prompt` metadata retain Claude's
observed physical placement; queue and file-history records are omitted as
transient. Root `sessionId` replacement operates on raw JSON so provider/tool
payload numbers and formatting are not normalized. Unknown entries,
mismatched session IDs, and invalid cross-entry links fail closed so a partial
or semantically reduced fork is never published. Sidechain records and orphaned
`last-prompt` hints are excluded because they do not belong to the resumable
main chain.

## Local Team observability and qualification

Team and Swarm are explicit, local-only capabilities. The native CLI provides
`team status`, `team logs`, and durable-local `team attach` projections in text
or JSON; tmux is optional presentation and never lifecycle authority. The CLI
keeps Team observability modules behind the explicit Team gate, so a disabled
Team does not load mailbox, ownership, or dashboard modules during startup.
The removable Claude Team adapter is fail-closed on unknown fields and covers
fixture-verified lead-only create (empty native roster/task list), delete/send,
shutdown, and plan-response shapes. Native task persistence, notification
projection, context assembly, and Team resume/inbox seams are implemented
behind the same local lead boundary. Their Claude-facing zero-skip black-box
qualification remains separate and is not implied by adapter fixtures.

## Clean-room rule

Claude Code may be used to identify observable behavior and build black-box
fixtures. Its source code must not be copied into Praxis.
