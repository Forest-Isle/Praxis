---
schema_version: "2"
change_id: "issue-702-foreground-shutdown-ownership"
created_at: "2026-09-06T02:45:55Z"
title: "Own foreground turn shutdown settlement"
change_kind: "bugfix"
implementation_status: "verified"
review_status: "pending"
project_root: "/Users/wuqisen/dev/Praxis"
parents: ["issue-699-projection-cursor-continuity"]
supersedes: []
scopes: ["project", "fixture-contracts", "native-persistence", "foreground-turn-lifecycle"]
changed_files: ["docs/ACTIVE_TURN_INPUT.md", "docs/ARCHITECTURE.md", "docs/CODING_AGENT_ROADMAP.md", "src/application/session-service.test.ts", "src/application/session-service.ts", "src/application/turn-lifecycle.test.ts", "src/application/turn-lifecycle.ts", "test/fixtures/manifest.json"]
excluded_preexisting_files: [".claude", "docs/CLAUDE_EXPERIMENTAL_CAPABILITIES.md", "docs/research"]
base_revision: "git:2cf43d4b0076066503c32014fe45cf13e26e007f"
observed_revision: "git:6d33b3800ab4ec85d72631f15801092eb48aa3a1"
architecture_verdict: "MODEL_REBUILD_REQUIRED"
architecture_evidence: "The canonical model, impact log, and checkpoint are absent. This change establishes a TurnCoordinator-to-SessionService cancellation and settlement flow with a native persistence boundary, but Issue #692 independently owns the required architecture bootstrap and Issue #702 excludes it."
risk: "high"
requirement_ids: ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8"]
repair_of: []
---

# Executive Summary
`TurnCoordinator` now owns one abort controller, cancellation signal, terminal outcome, and settlement promise for every admitted foreground prompt, retry, or shell turn. Service shutdown seals steering, aborts all active foreground work, and waits until durable work and turn cleanup have settled before `ClaudeSessionService` disposes dependent resources.

# Review Contract
Review GitHub Issue #702 and requirements R1-R8: coordinator-owned cancellation for every foreground turn; shutdown admission closure, mailbox sealing, active abort, and settlement waiting; exactly one cancelled terminal outcome; compatibility of existing success/failure/caller-cancel/steering behavior; SessionService use of only the owned signal and awaited close boundary; durable native prompt recovery; truthful high-risk fixture evidence; and synchronized architecture, active-turn, and roadmap documentation.

# Before And After
Previously foreground work received the caller's signal directly, while `TurnCoordinator.close()` only rejected pending steering and returned synchronously. `ClaudeSessionService.close()` could therefore tear down hooks, memory, accounting, MCP, and related resources while an admitted provider or shell turn was still unwinding. Now caller cancellation and service shutdown feed the same coordinator-owned signal, and close remains pending through terminal emission, mailbox cleanup, native lease release, and unregister settlement.

# Implementation Path
`TurnCoordinator.run()` constructs and registers the owned abort controller and settlement record, forwards a live caller abort listener, exposes the owned signal through `TurnScope`, classifies cancellation from that signal, and prevents late successful work from overwriting cancellation. `close()` publishes one shared promise before abort side effects, blocks new admissions, seals mailboxes, aborts a stable active-turn snapshot, and awaits every settlement. `ClaudeSessionService.executeTurn()` consumes `TurnScope.signal`, while `close()` awaits the coordinator before dependent teardown.

# Change Surface
The coherent reviewed surface is exactly eight files: the coordinator and SessionService production modules, focused lifecycle and native integration tests, the fixture manifest, and three direct project-facing documents. No public CLI/TUI route, provider adapter, native Transcript schema, receipt schema, sidecar, dependency, migration, configuration, or remote surface changed. Operational `.agent` state, generated build/package output, deterministic ledger storage, and protected user-owned untracked content are excluded.

# Contracts And Compatibility
Public SessionService methods, provider request types, hook contracts, permission behavior, accounting formulas, runtime events, and native append-only JSONL remain unchanged. Duplicate-session rejection, validation, caller cancellation, shell behavior, steering withdrawal/rejection, inner-terminal filtering, sink-error precedence, and successful/failed terminal states retain their existing contracts. Shutdown is now intentionally asynchronous and idempotent at the private coordinator boundary; the only production caller awaits it.

# Architecture Impact
Foreground cancellation and settlement ownership, the `TurnCoordinator` to `ClaudeSessionService` teardown ordering, and the native durability boundary are modeled architecture facts. The verdict is `MODEL_REBUILD_REQUIRED`, not `NO_MODEL_CHANGE`, because no canonical architecture model, checkpoint, or impact log exists. Issue #692 remains the separately scoped bootstrap owner; maintained narrative architecture and lifecycle documentation record the accepted facts for #702 without expanding this change.

# Verification Evidence
Final evidence passed focused Prettier, ESLint, typecheck, and build; the TurnCoordinator and SessionService suites with 2 files and 230 tests; coding eval baseline with 5 files and 20 tests; fixture execution with 74 behaviors and 125 executable entries plus schema validation with 183 total evidence entries; documentation contracts; `npm run check` with 251 files and 3344 tests; native package; performance thresholds; and `npm audit --omit=dev` with zero vulnerabilities. The native shutdown and SIGTERM smoke passed 2 tests. A fresh `ClaudeSessionService` resumed the same cancelled native session, and the original prompt remained persisted exactly once. Final independent Standards and Spec reviews each reported zero findings, and Change Control verified only the eight declared files.

# Risks And Known Gaps
Risk is high because cancellation races can otherwise emit a false completion, leak active work, dispose a dependency during provider unwind, or lose durable recovery evidence. Tests cover prompt and shell abort, ignored-signal late return, shutdown reentrancy, pending steering rejection, post-close admission, sink failures, teardown ordering, exactly-once terminal state, prompt persistence, and fresh-service resume. Human review remains pending. Architecture bootstrap is still required through #692, and this capsule grants no release or deployment authority.

# Lineage And Freshness
This capsule descends from `issue-699-projection-cursor-continuity`, advances project, fixture-contract, and native-persistence history, and introduces the `foreground-turn-lifecycle` scope. Base revision is `origin/main` at `2cf43d4b`; observed revision is the accepted two-commit branch head `6d33b38`. Ledger fingerprints bind exactly the eight primary-accepted files. Older parallel-scope drift and the three protected pre-existing local paths are not attributed to #702.

# Reviewer Checklist
- Confirm every admitted prompt, retry, and shell turn receives a coordinator-owned signal that reacts to both caller abort and service shutdown.
- Confirm close publishes one shared promise before synchronous abort callbacks can re-enter, rejects new admissions, seals pending steering, and waits for terminal emission plus unregister settlement.
- Confirm work that returns after cancellation cannot emit `completed`, and each foreground turn emits exactly one outer terminal state without a `completed` or `failed` leak.
- Confirm `ClaudeSessionService.close()` waits for the foreground native lease before hooks, memory, accounting, MCP, and other dependent teardown begins.
- Confirm a fresh service can resume the cancelled native session and the original prompt exists exactly once in the authoritative transcript.
- Confirm public runtime, provider, native Transcript, receipt, permission, hook, accounting, CLI, and TUI contracts remain unchanged.
- Confirm only the eight reviewed files are attributed, protected untracked content remains excluded, and human review status remains pending.
