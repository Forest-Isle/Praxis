# Development Roadmap

## Sprint 0 — executable compatibility protocol

Status: complete for Claude Code 2.1.208.

- [x] Claude 2.1.208 project-path resolver, including long-path hash fixture
- [x] versioned schema adapter and unknown-field round-trip
- [x] real black-box text and tool envelope discovery
- [x] append-only JSONL store, advisory lock, tail/parent conflict handling
- [x] provider text/tool persistence translation
- [x] typed shared-data ownership policy
- [x] runtime contract and local threat model
- [x] automated Claude-created → Praxis → Claude resume probe
- [x] Praxis-created → Claude discovery/resume probe
- [x] shared instructions/memory/skill/hook/MCP black-box matrix
- [x] schema fixtures for compaction, sidechains, images, interruption, and errors
- [x] worktree/non-git hierarchy and canonical main-repository memory discovery
- [x] strict append version/content/tool-result pairing validation
- [x] real Claude reopen oracle plus Claude-generated subagent layout

Exit gate passed against installed Claude Code 2.1.208 in isolated config
directories. Unknown versions stay read-only; each new Claude release must pass
the same probes before write support is enabled.

## Sprint 1 — headless vertical slice

Status: complete for the OpenAI-compatible text provider.

- [x] CLI `run`, `resume`, `fork`, `sessions`, and JSON output
- [x] runtime state machine and event stream
- [x] OpenAI-compatible streaming provider adapter
- [x] text-only context assembly and shared transcript persistence
- [x] cancellation, retry classification, usage accounting

Exit gate passed against Claude Code 2.1.208: Claude resumes a Praxis runtime
session, and Praxis resumes a Claude-created session that Claude can reopen.

## Sprint 2 — local tools and permissions

Status: complete for the headless OpenAI-compatible runtime.

- [x] read, write, edit, search, and shell tools
- [x] allow/ask/deny engine and project/global compatible settings reads
- [x] timeouts, cancellation, output bounds, path normalization
- [x] native `tool_use`/`tool_result` persistence

Exit gate passed with provider-independent tool and denial scenarios plus a
live Claude Code 2.1.208 reopen probe for a Praxis-created tool round trip and
an allow/ask/deny permission oracle covering scope, glob, `//`, and Bash `:*`.

## Sprint 3 — context ecosystem

Status: complete for Claude Code 2.1.208.

- [x] CLAUDE.md hierarchy and unconditional user/project rules in model context
- [x] canonical `MEMORY.md` index with Claude-compatible 200-line visibility
- [x] path-conditional rule activation through native resumable attachments
- [x] skills, commands, and agent definitions
- [x] command hooks across session, prompt, permission, tool, stop, and end events
- [x] user/project/local MCP sources, stdio/HTTP discovery, calls, and lifecycle
- [x] context budgeting and version-supported compaction

Exit gate passed with shared-data black-box probes, context fidelity tests, 142
unit/integration tests, and bidirectional live compaction resume.

## Sprint 4 — interactive CLI hardening

Status: complete for the local release suite.

- [x] Ink TUI over runtime events
- [x] streaming, permission prompts, session picker, and basic diagnostics
- [x] interrupted-tool crash recovery with prepared-input approval
- [x] deterministic CLI/session/transcript time and memory budgets
- [x] npm tarball, clean-install smoke, and fail-closed upgrade matrix

Performance gate passes against the production build with a 500-session index
and an 11 MiB/20,000-entry transcript. Package gate passes from the installed
tarball. Sprint exit gate passed on macOS with live Claude Code 2.1.208 probes
and in a Linux Node 24 Bookworm container; CI repeats package and performance
gates for Node 24/25 on current macOS and Ubuntu runners.

## Sprint 5 — installed CLI end-to-end closure

Status: complete for the packaged OpenAI-compatible runtime.

- [x] installed npm bin to local HTTP/SSE provider request
- [x] local `Read` plus default-ask `Bash` authorized by shared permission rules
- [x] ordered tool-call/result continuation and native transcript persistence
- [x] installed CLI resume with prior assistant context

Exit gate runs from the clean-installed tarball on the Node 24/25 macOS and
Ubuntu release matrix without contacting an external provider.

## Sprint 6 — native provider contract closure

Status: complete for OpenAI-compatible and Anthropic Messages APIs.

- [x] native Anthropic Messages request and SSE translation
- [x] explicit CLI provider selection with provider-specific safe defaults
- [x] matching text, usage, tool-call, error, cancellation, and bound semantics
- [x] identical installed CLI Read/Bash/persist/resume scenario for both adapters

Exit gate runs both provider protocols through the clean-installed npm bin on
the Node 24/25 macOS and Ubuntu release matrix without external network access.

## Sprint 7 — shared auto-memory access closure

Status: complete for canonical project memory reads and writes.

- [x] canonical main-repository memory root reused across git worktrees
- [x] standard `Read`, `Write`, and `Edit` access without private memory tools
- [x] workspace, sibling-path, and symlink-escape isolation retained
- [x] installed OpenAI/Anthropic linked-detail read and memory-write scenario
- [x] exact run usage, transcript persistence, and second-process resume gate

Exit gate runs from the clean-installed tarball and verifies the written
Markdown is stored in Claude's shared project-memory directory.

## Sprint 8 — child-process credential boundary

Status: complete for Bash, hooks, Claude version detection, and MCP transports.

- [x] central credential-name detection, child environment sanitization, and
      exact-value redaction
- [x] startup-file-free Bash and hook shells with ordinary runtime variables
      retained
- [x] ambient credentials removed from Bash, hooks, version detection, and MCP
      stdio children
- [x] explicit MCP env/header grants retained with result, warning, error, and
      definition redaction
- [x] nested MCP error/cause/stack redaction and plain, NDJSON, and interactive
      CLI diagnostic redaction
- [x] raw hook JSON semantics retained while persisted diagnostics/context are
      redacted
- [x] Bash and hook output budgets enforced after credential redaction
- [x] canary coverage proving shared hook JSONL contains no ambient credential

Exit gate covers direct sanitizer behavior, real child processes, stdio and
HTTP MCP servers, MCP failures, hook lifecycle persistence, package builds, and
the existing compatibility/performance suite.

## Sprint 9 — native full-fidelity session fork

Status: complete for Claude Code 2.1.208 main-chain sessions.

- [x] preserve native text, tool-use/result, media, error, and interruption
      payloads without regenerating UUIDs or parent links
- [x] preserve compact boundaries/summaries, nested-memory and hook
      attachments, agent settings, titles, and `last-prompt`
- [x] replace only root `sessionId` without JSON normalization; retain latest
      title/mode/permission state and exclude transient queue/file-history data
- [x] fail closed on unknown entry types, mismatched session IDs, unsupported
      Claude versions, and malformed cross-entry links; exclude sidechains and
      orphaned `last-prompt` hints from main-session forks
- [x] installed-package fork gate with field-for-field history comparison and
      no provider request
- [x] live Claude 2.1.208 reopen gates for tool and compact-history forks

Exit gate covers fixture profiles, runtime tool history, compact active-context
semantics, installed OpenAI/Anthropic CLI loops, package/performance gates, and
macOS/Linux Node 24 clean-room validation.

## Sprint 10 — session resilience and read-only recovery

Status: complete for local Claude-compatible session storage.

- [x] atomically owned PID/token leases reclaim locks left by dead Praxis
      processes while live and unrecognized locks remain conflicts
- [x] session discovery isolates corrupt JSONL and reports exact line/byte
      diagnostics without hiding healthy sessions
- [x] provider-free `inspect` exposes schema write mode, entry/tail metadata,
      prompt summary, and corruption status
- [x] provider-free `export` preserves exact source bytes for supported,
      unsupported, and corrupt sessions
- [x] unsupported Claude versions remain write/fork closed while listing,
      inspection, and export stay available

Exit gate covers storage/service/CLI behavior, installed-package inspect/export,
the existing compatibility suite, and macOS/Linux Node 24 clean-room validation.

## Sprint 11 — native foreground subagents

Status: complete for Claude Code 2.1.208 foreground Agent execution.

- [x] synchronous `Agent` tool with strict native input and permission flow
- [x] `general-purpose` plus shared user/project custom agent definitions
- [x] recursive provider-neutral runtime with depth, call, turn, input, and
      output bounds
- [x] shared local/MCP/Skill, permission, hook, cancellation, and redaction path
- [x] native sidechain JSONL and `.meta.json` persistence
- [x] native main-chain Agent result metadata and crash/failure semantics
- [x] installed OpenAI/Anthropic execution and Claude reopen/discovery probes

Background execution and `SendMessage` land in Sprint 19. Process-independent
top-level dispatch and scheduled orchestration remain later stages.

## Sprint 12 — native image tool-result closure

Status: complete for Claude Code 2.1.208 `Read` image results.

- [x] provider-neutral bounded image payload and explicit provider capability
- [x] PNG, JPEG, GIF, and WebP `Read` detection by file signature
- [x] native Anthropic tool-result images and OpenAI-compatible image input
- [x] main-chain and foreground-sidechain image persistence and projection
- [x] strict native message/`toolUseResult` metadata consistency validation
- [x] real Claude 2.1.208 resume of a Praxis-written image result

User image attachments and MCP image-result writers remain closed pending
separate Claude black-box envelopes. Exit gate covers focused runtime/provider/
schema tests, real bidirectional projection, and the existing package,
performance, recovery, subagent, and compatibility suites.

## Sprint 13 — print and machine I/O contract

Status: complete for text-only user input and current runtime events. Provider
pricing and API-only timing remain an explicit later metering gate; machine
results report those unknown values as `null` rather than zero.

- [x] Claude-style `-p`/`--print`, `-r`/`--resume`, format, verbose, partial,
      replay, agent, and explicit session-ID options
- [x] atomic explicit session-ID reservation with existing and empty-file
      collision behavior matching Claude Code 2.1.208
- [x] single JSON result and stream JSON init/assistant/tool/result envelopes
- [x] bounded incremental UTF-8/CRLF stream input with realtime multi-turn
      run-to-resume behavior
- [x] optional partial text/tool event lifecycle and user-message replay
- [x] one MCP/service lifecycle across streamed turns and deterministic close
      across headless and interactive paths
- [x] legacy Praxis `--json` behavior retained as a separate compatibility alias
- [x] clean-installed OpenAI/Anthropic two-turn stdin protocol gate

User image/file input records and SDK control request/response messages remain
explicit gaps in [PARITY_MATRIX.md](PARITY_MATRIX.md); they are not silently
accepted or reported as compatible.

## Sprint 14 — CLI customization and session controls

Status: complete for headless single-user controls. The classifier-backed
`auto` permission mode, foreground subagents without sidechain persistence, and
session-name display in the Praxis picker remain explicit later work.

- [x] inline/file settings plus user/project/local source filtering across
      context, extensions, hooks, permissions, and MCP
- [x] safe mode and Claude-style bare mode with the minimal Bash/Edit/Read tool
      surface
- [x] direct/file system prompt replacement and append controls
- [x] canonical additional Read/Write/Edit/Grep roots with symlink containment
- [x] explicit/default/empty tool sets and CLI allow/deny permission rules
- [x] acceptEdits, manual, dontAsk, plan, and bypass permission modes with deny
      precedence
- [x] current-directory continue, native resume/continue fork, and native
      session names
- [x] in-memory session execution with no transcript creation and fail-closed
      foreground subagents
- [x] repository worktree exclusions for formatter, ESLint, and Vitest
- [x] local provider request gate and Claude 2.1.208 named-session reopen

`auto` fails explicitly instead of degrading to a different permission mode.
No-persistence sessions expose the would-be Claude transcript path to hooks but
do not create that file. Existing on-disk sessions can be imported for an
ephemeral continuation without modifying the source JSONL.

## Sprint 15 — native notebook editing

Status: complete for local Jupyter notebook cell reads and edits.

- [x] Claude-compatible `<cell id="...">` Read view with `cell-N` fallback IDs
- [x] structured replace, insert, and delete with untouched notebook metadata
      and cell fields preserved
- [x] mandatory successful Read history across ordinary and recovered turns
- [x] absolute canonical path, additional-root, symlink, size, and stable-file
      boundaries shared with standard file tools
- [x] NotebookEdit permission patterns plus acceptEdits/plan behavior
- [x] live Claude 2.1.208 Read/Edit oracle, Praxis native tool round trip, and
      Claude resume of the Praxis transcript

Notebook execution is not introduced; Praxis edits `.ipynb` JSON only. Web,
worktree, background task, scheduling, and MCP resource tools remain separate
stages in [PARITY_MATRIX.md](PARITY_MATRIX.md).

## Sprint 16 — native file globbing

Status: complete for local recursive file pattern matching.

- [x] Claude-compatible `pattern`/optional `path` schema and default cwd behavior
- [x] hidden and ignored file discovery with basename, globstar, and brace
      matching
- [x] relative/absolute output style and oldest-mtime-first ordering
- [x] 100-result cap with exact native count suffix and bounded output bytes
- [x] workspace/additional-root validation, symlink escape rejection, timeout,
      cancellation, and allow/deny permission behavior
- [x] live Claude 2.1.208 schema/result oracle, Praxis native tool round trip,
      and Claude resume of the Praxis transcript

Directories and symlinks are not returned. Praxis intentionally applies its
canonical-root boundary to an explicitly selected symlink directory even
though Claude 2.1.208 follows that root; this retains the established local
threat model.

## Sprint 17 — MCP resource compatibility

Status: complete for connected MCP resource-capable servers.

- [x] capability-gated Claude-compatible list, read, and directory schemas
- [x] bounded paginated discovery with per-server attribution and caching
- [x] exact text/not-found result projection and disabled directory response
- [x] bounded binary blob persistence under session `tool-results`
- [x] resource-only connection status and ephemeral-session storage
- [x] live Claude 2.1.208 result, persistence, and bidirectional resume gate

## Sprint 18 — web tools

Status: complete for Claude Code 2.1.208.

- [x] exact Claude 2.1.208 schemas, descriptions, safe/bare exposure, and
      permission defaults
- [x] HTTPS-only public fetching with DNS pinning, redirect revalidation, SSRF
      rejection, HTML-to-Markdown conversion, timeout, byte, and cache bounds
- [x] Claude URL/redirect limits, preapproved Markdown fast path, and binary
      response persistence under the session `tool-results` directory
- [x] provider-neutral page processing with untrusted-content isolation
- [x] Anthropic-native `web_search_20250305` requests, domain filters,
      links/citations, usage, and source reminder
- [x] explicit capability omission for providers without native search
- [x] live schemas, search, errors, persistence, resume, and real Praxis public
      fetch
- [x] successful Claude public WebFetch oracle using an isolated preflight-bypass
      fixture while retaining real public fetch and secondary-model processing

## Sprint 19 — native background agents

Status: complete for background Agent tasks owned by one Praxis invocation.

- [x] Claude 2.1.208 Agent, SendMessage, TaskOutput, and TaskStop schema shapes
- [x] background-by-default Agent plus explicit foreground execution
- [x] concurrent native sidechain execution with independent cancellation
- [x] bounded blocking/non-blocking output and task stop semantics
- [x] ordered same-ID SendMessage continuation, including later-turn hydration
- [x] native async launch metadata and persisted task completion notifications
- [x] background usage aggregation into the main run result
- [x] live Claude schema oracle, Praxis lifecycle gate, and Claude resume

This sprint did not include top-level background sessions, durable scheduling,
or native worktree lifecycle. Top-level sessions landed in Sprint 21. Remote
isolation stays outside the local product boundary.

## Sprint 20 — durable tasks and background Bash

Status: complete for persisted single-session task graphs and Bash tasks owned
by one Praxis invocation.

- [x] Claude 2.1.208 TaskCreate/Get/List/Update and background Bash schemas
- [x] shared `<config>/tasks/<session-id>` JSON graph and high-watermark
- [x] reciprocal dependencies, active-blocker filtering, metadata merge/delete,
      and deletion cleanup
- [x] `b` plus eight-character Bash IDs with blocking/non-blocking output,
      failure, timeout, stop, and once-only completion notification consumed by
      terminal output retrieval
- [x] shared Agent/Bash TaskOutput and TaskStop routing in main and nested runs
- [x] bounded redacted Claude-path output with Read-only external access
- [x] live Praxis -> Claude -> Praxis graph and background lifecycle gate

Scheduled prompts land in Stage 22. At this stage, Workflow and native
worktree/tmux lifecycle remained later work; Claude Code 2.1.208 has no standalone
Monitor tool.

## Sprint 21 — top-level background sessions

Status: complete for single-user local persistent sessions.

- [x] Claude 2.1.208 `--bg` conflict, managed-ID, launch, agents, logs, attach,
      and stop contracts
- [x] detached worker with active/idle/stopped lifecycle and attached follow-up
      turns under one shared session
- [x] Claude-shaped `jobs/<id>` state/timeline and `sessions/<pid>` records with
      Praxis owner-scoped dispatch and authenticated local control
- [x] atomic state/dispatch publication, bounded recent output, stale-worker
      repair, startup-stop race handling, and terminal control cleanup
- [x] native background transcript metadata and live Claude <-> Praxis resume

At this stage, Workflow and native worktree/tmux lifecycle remained later work.

## Stage 22 — scheduled prompts and fixed loops

Status: complete for Claude Code 2.1.208 fixed scheduling behavior.

- [x] exact `CronCreate`, `CronDelete`, `CronList`, and `ScheduleWakeup` schemas
- [x] session-only jobs plus shared `.claude/scheduled_tasks.json` durable jobs
- [x] eight-hex IDs, native metadata, unknown-field preservation, atomic retry,
      and live PID/process-start ownership
- [x] local five-field cron, bounded deterministic jitter, missed one-shot
      catch-up, auto-delete, and recurring seven-day final execution
- [x] one interactive service lifecycle with idle prompt submission and cleanup
- [x] built-in fixed-interval `/loop` expansion plus immediate first execution
- [x] live Praxis -> Claude -> Praxis state and bidirectional resume gate

`ScheduleWakeup` matches the observed inactive dynamic gate and stop behavior.
Active dynamic wakeups and the separate resumable multi-agent `Workflow` engine
move to Stage 23. No standalone Monitor tool exists in Claude Code 2.1.208.

## Stage 23 — resumable Workflow engine

Status: complete for Claude Code 2.1.208.

- [x] exact Claude 2.1.208 public schema, opt-in permission gate, source precedence,
      saved project/user workflows, and built-ins
- [x] Acorn pure-literal metadata parsing and QuickJS sandbox with deterministic
      time/random guards, memory/deadline/collection/agent limits
- [x] agent, parallel, pipeline, nested workflow, phase/log, args, and token-budget
      APIs with model/effort/agentType/schema/worktree options
- [x] background task output/stop/notifications, abort propagation, run uniqueness,
      native scripts/runs/journals/progress/sidechains, and interactive status
- [x] exact semantic descriptor sidecar replay independent of journal key, plus
      deterministic started-order replay for unchanged script/args Claude journals
      (with nested workflow/budget sources fail-closed), plus conservative
      unique-prompt fallback when the current call has no semantic options
- [x] Claude-compatible chained `v2` replay keys over previous key, prompt, and
      canonical schema/model/effort/isolation/agentType options
- [x] live schema, permissions, lifecycle, structured output, effort, artifacts, and
      shared-main-session gates; real Claude exact-replays a Praxis-created journal,
      and Praxis exact/ordered-replays Claude-created or deliberately foreign-key
      journals with zero repeated child provider requests

Native top-level EnterWorktree, ExitWorktree, `--worktree`, and tmux lifecycle
remain separate tool/CLI work.

## Stage 24 - interactive dynamic wakeups

Status: complete for Claude Code 2.1.208.

- [x] process-local one-shot scheduling with nearest-second rounding,
      60-3600 second clamp, and next-minute alignment
- [x] shared idle delivery queue, pending-wakeup replacement, and exactly-once
      fire
- [x] stop cancellation for pending/queued dynamic work without touching Cron
- [x] continuous-loop maximum age and inactive/aged-out terminal result
- [x] close/abort cleanup and headless inactive gate
- [x] default scheduling-tool permissions and option-only TTY control forwarding
- [x] focused manager/tool/CLI/permission tests
- [x] exact Claude description, input/output schema, active/inactive/stop result,
      and native shape from installed 2.1.208 SDK and executable implementation

The active Praxis path is compatibility-gated and deliberately creates no shared
artifact. Claude headless/manual inactive behavior remains live-verified.

## Stage 25 - native worktree lifecycle

Status: implemented with live Claude 2.1.208 schema and bidirectional resume
gates.

- [x] Claude-compatible `EnterWorktree` and `ExitWorktree` schemas and default
      permissions
- [x] Git worktree creation under `.claude/worktrees`, `worktree-*` branches,
      clean/dirty/forced removal, existing-path keep-only behavior
- [x] dynamic workspace cwd for local tools, permissions, hooks, context, and
      foreground subagents without changing process-global cwd
- [x] native `worktree-state` transcript entries and `toolUseResult` payloads
- [x] CLI `--worktree [name]` initial entry and worktree-scoped transcript path
- [x] detached classic `--tmux` launcher with argument forwarding and TTY attach
- [x] live schema capture, Enter/Bash/Exit lifecycle, native layout, and
      Claude/Praxis bidirectional resume gates
- [x] focused lifecycle, protocol, tool, tmux, and permission tests

## Stage 45 - local stream-json control records

Status: complete for the supported local single-user CLI profile; remote-only
records are excluded by Stage 49.

- [x] provider retry events preserve actual attempt, delay, status, and error
      kind without duplicating fallback requests
- [x] compaction status and native compact-boundary records
- [x] session state transitions, tool elapsed-time progress, and cancellation
      terminal state
- [x] foreground/background Agent and background Bash task lifecycle records
- [x] protocol field mapping and focused runtime/CLI compatibility tests
- [x] built-package `test:stream-json-compat` gate against a local Anthropic SSE provider
- [x] local command output classified as assistant records by the 2.1.208
      mapper; remote BYOC file persistence excluded from single-user CLI scope

## Stage 46 - machine result envelope contract

Status: implemented for observable SDK fields; provider-neutral unknown pricing
and failed-request API duration remain explicit `null` rather than fabricated.

- [x] init UUID, output style, fast-mode state, and loaded plugin name/path list
- [x] success UUID, stop reason, fast-mode state, and optional structured output
- [x] error subtype classification, `errors`, complete zero usage, empty
      `modelUsage`, stop reason, fast-mode state, and UUID
- [x] exact protocol and CLI redaction tests

## Stage 47 - MCP elicitation stream control

Status: complete for form and URL elicitation requests over the local
stream-json control protocol.

- [x] MCP client elicitation capabilities and request/complete notification
      handlers
- [x] stream-json `control_request`/`control_response` round trip with action
      validation and decline fallback
- [x] native `elicitation_complete` system record and end-to-end fixture gate

## Stage 48 - provider-backed tool-use summaries

Status: implemented for stream-json consumers with a provider-neutral auxiliary
summary request; summary failures never fail the primary turn.

- [x] real completed-tool batch collection with preceding tool-use IDs
- [x] asynchronous provider-backed summary producer using Claude's prompt
      contract and bounded tool input/output context
- [x] native `tool_use_summary` stream record and runtime/protocol tests

## Stage 49 - machine-I/O scope closure

Status: complete for the single-user local CLI boundary.

- [x] source and black-box evidence prove local slash-command output uses
      assistant records rather than `local_command_output`
- [x] `files_persisted` classified as remote BYOC/session-ingress behavior and
      excluded with the enterprise product surface
- [x] provider-neutral unknown price and failed-request timing remain explicit
      `null` instead of fabricated values

## Stage 53 - final compatibility and release matrix

Status: complete for Claude Code 2.1.208 and the supported Node/OS matrix.

- [x] aggregate discovery and isolated execution of all 34 compatibility gates
- [x] deterministic conditional-rule resume fixture validates provider request
      context and native attachments instead of relying on free-form model echo
- [x] compaction fixture keeps irreducible context within the configured window
      while retaining a genuinely over-budget history
- [x] macOS Node 24/25 and Linux ARM64 Node 24/25 clean-tarball package and
      performance gates
