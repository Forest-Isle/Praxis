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

Status: in progress.

- [x] Ink TUI over runtime events
- [x] streaming, permission prompts, session picker, and basic diagnostics
- [x] interrupted-tool crash recovery with prepared-input approval
- [x] deterministic CLI/session/transcript time and memory budgets
- [ ] packaging and upgrade compatibility matrix

Performance gate passes against the production build with a 500-session index
and an 11 MiB/20,000-entry transcript. Sprint exit gate remains the end-to-end
release suite on macOS and Linux.
