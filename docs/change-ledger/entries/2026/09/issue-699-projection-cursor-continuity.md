---
schema_version: "2"
change_id: "issue-699-projection-cursor-continuity"
created_at: "2026-09-06T01:29:44Z"
title: "Preserve projection cursor continuity across refresh and resume"
change_kind: "bugfix"
implementation_status: "verified"
review_status: "pending"
project_root: "/Users/wuqisen/dev/Praxis"
parents: ["issue-696-compaction-transaction"]
supersedes: []
scopes: ["project", "fixture-contracts", "native-persistence", "turn-persistence"]
changed_files: ["docs/ARCHITECTURE.md", "docs/CODING_AGENT_ROADMAP.md", "src/application/session-service.test.ts", "src/application/session-service.ts", "src/application/turn-persistence.test.ts", "src/application/turn-persistence.ts", "test/fixtures/manifest.json"]
excluded_preexisting_files: [".claude", "docs/CLAUDE_EXPERIMENTAL_CAPABILITIES.md", "docs/research"]
base_revision: "git:044ea290901a55dd5e343e78bdcd6a63d0455a00"
observed_revision: "git:044ea290901a55dd5e343e78bdcd6a63d0455a00"
architecture_verdict: "MODEL_REBUILD_REQUIRED"
architecture_evidence: "The canonical model, impact log, and checkpoint are absent. This change affects the TurnPersistence-to-SessionService state and translation-parent flow, but Issue #692 independently owns the required bootstrap and Issue #699 excludes it."
risk: "high"
requirement_ids: ["R1", "R2", "R3", "R4", "R5", "R6"]
repair_of: []
---

# Executive Summary
`TurnPersistence` now owns an explicit in-memory projection cursor derived from the exact compatibility entries it publishes. Construction, selected-branch resume, successful projection and combined commits, and explicit refresh advance entries and cursor together; failed authoritative appends publish neither. `SessionService` consumes the cursor directly, including recovery-hook batches and post-compaction continuation.

# Review Contract
Review GitHub Issue #699 and requirements R1-R6: explicit cursor ownership; atomic entry/cursor derivation; successful-commit advancement and failed-append rollback; direct SessionService parent selection; preservation of native Transcript, selected-branch, cancellation, compaction, and PostCompact contracts; and executable high-risk recovery evidence. Raw compatibility projection after compaction must retain the complete selected native ancestry.

# Before And After
Previously compatibility parenting reused a fabricated `NativeTranscriptTail`: it started empty over resumed history and remained stale when refresh rebuilt entries. A later compatibility entry could therefore parent to null or abandoned state. Now `TurnProjectionCursor` records the last non-empty projected UUID and exact entry count, and the same derivation rule governs owned projection state and deferred recovery-hook batches.

# Implementation Path
`TurnPersistence` derives, clones, stages, and replaces projection entries with their cursor while keeping commit invocation order and append-before-publication semantics. Compaction commit still leaves compatibility state unchanged until the established explicit refresh. `SessionService` removes the synthetic tail adapter and supplies `projectionCursor.lastEntryId` to translation; deferred hook batches reuse the cursor helper. Existing branch-resume and automatic-compaction service tests capture real call-through persistence commits and compare compatibility parents with durable native predecessors.

# Change Surface
The coherent reviewed surface is exactly seven files: two application production modules, their focused TurnPersistence and SessionService evidence, the fixture manifest, and architecture/roadmap documentation. No new product file, migration, sidecar, dependency, configuration, provider, CLI, or runtime protocol was added. Operational `.agent` state, generated build/package output, renderer-owned ledger storage, and protected user-owned untracked content are not attributed to this change.

# Contracts And Compatibility
The authoritative Transcript remains append-only native JSONL and its event kinds/fields are unchanged. The cursor is private ephemeral state; it is not persisted into Transcript, provider requests, runtime events, sidecars, or CLI results. Entries without a non-empty UUID do not erase or advance the cursor. Selected checkpoints remain owned by `NativeSessionTranscript`, and compaction accounting, ContextPreparation generations, rewind/file history, cancellation, and PostCompact effect ordering remain compatible.

# Architecture Impact
Cursor ownership and the TurnPersistence-to-SessionService translation-parent flow are architecture-model facts, so this is not safely claimable as `NO_MODEL_CHANGE`. The verdict is `MODEL_REBUILD_REQUIRED` because no canonical model/checkpoint exists. Issue #692 remains the separately scoped schema-v1 bootstrap; the maintained narrative architecture and roadmap carry the reviewed facts for this change.

# Verification Evidence
Final post-repair evidence passed the focused TurnPersistence plus named SessionService suite with 2 files and 10 tests; coding eval baseline with 5 files and 20 tests; `npm run check` with format, ESLint, docs, release/CI/fixture/boundary verification, typecheck, native/build output, and 251 files / 3343 tests; native release package; projection and quiet-frame performance gates; and `npm audit --omit=dev` with zero vulnerabilities. Fixture schema v2 reports 74 behaviors, 181 evidence entries, and 47 exemptions. Final independent Standards and Spec reviews each reported zero findings, and Change Control scope verification reported only the seven declared files.

# Risks And Known Gaps
Risk is high because resume and compaction continuation can silently detach compatibility parenting from durable selected history. Tests now prove selected-branch initialization, multi-message projection, non-addressable retention, invalid/uncloneable/failed-append rollback, full compaction ancestry, refresh idempotence, and SessionService parent continuity. Human review remains pending. The architecture model is still absent and must be bootstrapped through #692; this capsule does not grant release or deployment authority.

# Lineage And Freshness
This capsule descends from `issue-696-compaction-transaction`, advances the project, fixture-contract, and native-persistence history, and introduces the `turn-persistence` scope. Base and observed Git revision are the same uncommitted branch HEAD; ledger fingerprints bind the exact seven primary-accepted working-tree files. Existing release-generated drift in inherited heads and the three protected pre-existing local paths are not attributed to #699. Ledger storage generated by this record belongs to its own low-risk Change Control cycle.

# Reviewer Checklist
- Confirm construction and refresh derive the cursor from the lease-selected projection rather than physical file tail state.
- Confirm projection-only and combined commits update entries/cursor together and failed native append, invalid input, or uncloneable commands leave both unchanged while the queue remains usable.
- Confirm only non-empty UUIDs advance the cursor and deferred recovery-hook batches preserve an earlier addressable ID when their last entry is unaddressable.
- Confirm selected-resume, subsequent resume, and first post-compaction compatibility entries parent to the exact durable selected predecessor without duplicate or skipped projection entries.
- Confirm compaction commit does not refresh early and native Transcript, provider/runtime/CLI schemas, accounting, cancellation, and PostCompact ordering remain unchanged.
- Confirm only the seven reviewed files are attributed, protected untracked content remains excluded, and human review status remains pending.
