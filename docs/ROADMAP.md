# Development Roadmap

## Sprint 0 — executable compatibility protocol

Status: in progress.

- [x] Claude 2.1.208 project-path resolver, including long-path hash fixture
- [x] versioned schema adapter and unknown-field round-trip
- [x] real black-box text and tool envelope discovery
- [x] append-only JSONL store, advisory lock, tail/parent conflict handling
- [x] provider text/tool persistence translation
- [x] typed shared-data ownership policy
- [x] runtime contract and local threat model
- [x] automated Claude-created → Praxis → Claude resume probe
- [x] Praxis-created → Claude resume probe
- [ ] shared instructions/memory/skill/hook/MCP black-box matrix
- [ ] schema fixtures for compaction, sidechains, images, interruption, and errors

Exit gate: all remaining black-box items pass against installed Claude Code
2.1.208 in isolated config directories. Unknown versions stay read-only.

## Sprint 1 — headless vertical slice

- CLI `run`, `resume`, `fork`, `sessions`, and JSON output
- runtime state machine and event stream
- first provider adapter
- text-only context assembly and shared transcript persistence
- cancellation, retry classification, usage accounting

Exit gate: complete and resume a text conversation from both CLIs.

## Sprint 2 — local tools and permissions

- read, write, edit, search, and shell tools
- allow/ask/deny engine and project/global compatible settings reads
- timeouts, cancellation, output bounds, path normalization
- native `tool_use`/`tool_result` persistence

Exit gate: provider-independent tool scenario suite and denial tests.

## Sprint 3 — context ecosystem

- CLAUDE.md and rules hierarchy
- auto memory
- skills, commands, and agent definitions
- hooks and MCP compatible subset
- context budgeting and version-supported compaction

Exit gate: shared-data black-box matrix and context fidelity tests.

## Sprint 4 — interactive CLI hardening

- Ink TUI over runtime events
- streaming, permission prompts, session picker, diagnostics
- crash recovery, performance budgets, packaging, upgrade compatibility matrix

Exit gate: end-to-end release suite on macOS and Linux.
