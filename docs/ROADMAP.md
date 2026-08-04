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

Background execution, `SendMessage`, and parallel scheduling remain a later
sprint and are rejected explicitly rather than serialized or simulated.

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
