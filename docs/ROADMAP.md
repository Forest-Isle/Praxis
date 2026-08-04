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
