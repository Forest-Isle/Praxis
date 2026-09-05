---
schema_version: "2"
change_id: "issue-696-compaction-transaction"
created_at: "2026-09-05T16:37:21Z"
title: "Make compaction accounting durable and recoverable"
change_kind: "feature"
implementation_status: "verified"
review_status: "pending"
project_root: "/Users/wuqisen/dev/Praxis"
parents: ["issue-694-project-eval-evidence"]
supersedes: []
scopes: ["project", "fixture-contracts", "compaction-accounting", "native-persistence"]
changed_files: ["docs/ARCHITECTURE.md", "docs/CODING_AGENT_ROADMAP.md", "src/application/compaction-accounting.test.ts", "src/application/compaction-accounting.ts", "src/application/compaction-errors.ts", "src/application/context-engine.test.ts", "src/application/context-engine.ts", "src/application/native-session-transcript.test.ts", "src/application/native-session-transcript.ts", "src/application/session-service.test.ts", "src/application/session-service.ts", "src/application/turn-accounting.test.ts", "src/application/turn-accounting.ts", "src/native/ownership.ts", "src/persistence/data-plane.test.ts", "src/persistence/native-compaction-receipt-store.test.ts", "src/persistence/native-compaction-receipt-store.ts", "test/fixtures/manifest.json"]
excluded_preexisting_files: [".claude", "docs/CLAUDE_EXPERIMENTAL_CAPABILITIES.md", "docs/research"]
base_revision: "git:8ed6222ee3a981ea0a00bb484ad43e13e278ab5d"
observed_revision: "git:9bce3d4c910c9fde740c94c7a5200f51a727d1d3"
architecture_verdict: "MODEL_REBUILD_REQUIRED"
architecture_evidence: "A bounded collect_changes assessment over the exact 18 reviewed paths returned BOOTSTRAP because the canonical model, impact log, and checkpoint are absent. The Session accounting and native sidecar flow changed; model bootstrap remains separately tracked by #692 and excluded here."
risk: "high"
requirement_ids: ["R1", "R2", "R3", "R4", "R5", "R6"]
repair_of: []
---

# Executive Summary
Persistent manual, automatic, and reactive compaction now binds preallocated Transcript event IDs to a private durable receipt before append, then converges Session accounting exactly once before post-boundary effects. Typed phase and durable-state failures preserve cancellation identity, while restart recovery follows complete native Transcript evidence and fails closed on malformed, partial, duplicate, mismatched, or ambiguous state.

# Review Contract
Review GitHub Issue #696 against R1-R6: classified failures; receipt-before-append ordering; exact-once Session accounting across save/ack crashes; current-Turn inclusive accounting; native Transcript and public compatibility; and executable high-risk recovery/persistence evidence. Treat Module-level crash tests plus SessionService real-sidecar wiring as layered evidence rather than requiring a caller-by-crash Cartesian matrix.

# Before And After
Previously a compaction boundary could be durable while its process-local accounting closure had not run or its Session cost state had not been saved, and retry could lose or double count the compactor contribution. Now a strict private receipt captures fixed provider-neutral accounting and reserved boundary/summary IDs before append; exact Transcript evidence determines commitment, cost save precedes immutable acknowledgement, and activation recovery converges zero or one contribution.

# Implementation Path
`NativeCompactionReceiptStore` owns strict mode-0600 atomic receipt and acknowledgement artifacts. `CompactionAccounting` prepares fixed-cost receipts, validates full-Transcript evidence, applies Session tracker state, saves configured cost state, acknowledges, and recovers deterministic pending chains or fresh no-store trackers. `NativeSessionTranscript` validates optional reserved IDs before atomic append. `TurnAccounting` retains only current-Turn compaction aggregation. `SessionService` reuses one accounting module per Session across compact, run/resume, and cost snapshots and orders accounting before post-commit effects; `ContextEngine` rethrows committed, persistence, validation, and recovery-integrity failures.

# Change Surface
The coherent product surface is exactly 18 files: three application production files plus the new accounting/error modules, the native receipt Adapter, native Transcript and Turn accounting changes, matching focused tests, native ownership/data-plane assertions, fixture evidence, and architecture/roadmap documentation. Operational `.agent` files, generated build/package output, and protected local content are excluded.

# Contracts And Compatibility
The authoritative Transcript remains append-only native JSONL with no receipt or accounting fields and no new event kind. Optional preallocated IDs preserve generated-ID callers. Provider requests, runtime events, public CLI/results, configuration, hosted behavior, and Claude data-plane compatibility do not change. Missing pricing remains explicit unknown cost, while zero-usage duration-only compaction remains valid without a model row. The private sidecar lives under `state/compaction-receipts/SESSION_ID/`.

# Architecture Impact
The change adds a Session-scoped application accounting seam and a Praxis-private persistence Adapter, and moves Session mutation ownership out of `TurnAccounting`; these are model-impacting facts. The correct verdict is `MODEL_REBUILD_REQUIRED` because no canonical architecture model/checkpoint exists. Issue #692 owns the separate schema-v1 bootstrap, while `docs/ARCHITECTURE.md` and native ownership metadata carry the reviewed current facts.

# Verification Evidence
Primary verification passed the final two focused repair tests; combined compaction coverage of 7 files / 327 tests before the final existing-test strengthening; eval baseline of 5 files / 20 tests; final `npm run check` including formatter, ESLint, docs, release/CI/fixture/boundary verification, both builds, and 251 files / 3342 tests; native release package; projection/quiet-frame performance; and `npm audit --omit=dev` with zero vulnerabilities. Fixture schema v2 reports 74 behaviors and 179 evidence entries. Final committed Standards review found no hard violations, and final Spec review reported no actionable finding.

# Risks And Known Gaps
This is high risk because receipt ordering, restart recovery, Session cost persistence, and failure classification can affect durable user-visible usage/cost totals. Recovery deliberately trusts strict receipt data plus exact Transcript order for fresh no-cost-store reconstruction because ordinary Turn accounting is not durable there; configured-store recovery additionally requires comparable before/after fingerprints. Human review remains pending. Architecture bootstrap #692 and the fixture verifier's inability to prove test-name file ownership are separately scoped governance work, not hidden changes in this capsule.

# Lineage And Freshness
This capsule advances the compatible current `issue-694-project-eval-evidence` project/fixture head while creating `compaction-accounting` and `native-persistence` scopes. The fingerprint-conflicting `issue-691-risk-tier-evidence` fixture head remains parallel because #696 did not review its divergent README and native-fixture documentation paths. Fingerprints cover only the exact 18 committed product paths at `9bce3d4`; the three protected pre-existing local paths are explicitly excluded. Ledger storage generated by recording this capsule belongs to a separate low-risk Change Control cycle.

# Reviewer Checklist
- Confirm every persistent compact prepares a private receipt before the atomic boundary/summary append and uses the exact reserved IDs.
- Confirm configured recovery distinguishes before/after cost images, saves before acknowledgement, and never applies an indeterminate chain.
- Confirm fresh no-store recovery reconstructs acknowledged and committed receipt contributions from full Transcript order without replay in the same service.
- Confirm cancellation identity, provider causes, stale-generation behavior, single reactive retry, manual selection, memory preservation, and tool-pair replay remain compatible.
- Confirm authoritative Transcript JSONL has no transaction/accounting field and sidecars reject malformed, duplicate, symlinked, oversized, non-private, conflicting, and cross-Session artifacts.
- Confirm only the 18 reviewed product files are attributed and human review remains pending.
