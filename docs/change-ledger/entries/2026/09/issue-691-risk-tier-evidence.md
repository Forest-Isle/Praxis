---
schema_version: "2"
change_id: "issue-691-risk-tier-evidence"
created_at: "2026-09-05T09:34:03Z"
title: "Risk-tiered native fixture evidence"
change_kind: "schema"
implementation_status: "verified"
review_status: "pending"
project_root: "/Users/wuqisen/dev/Praxis"
parents: []
supersedes: []
scopes: ["project", "fixture-contracts"]
changed_files: ["README.md", "README_zh.md", "docs/NATIVE_FIXTURE_CONTRACTS.md", "scripts/fixture-contracts.test.mjs", "scripts/lib/fixture-contracts.mjs", "scripts/verify-fixture-contracts.mjs", "test/fixtures/manifest.json"]
excluded_preexisting_files: [".claude", "docs/CLAUDE_EXPERIMENTAL_CAPABILITIES.md", "docs/research"]
base_revision: "git:7bf8ee5ed06fd5d2a4eb3feefdfd43a33e2c5f79"
observed_revision: "git:8c760a89a9d4ad54279ea43f70ce24cb45d83798"
architecture_verdict: "MODEL_REBUILD_REQUIRED"
architecture_evidence: "Canonical architecture model and checkpoint are absent; bootstrap is tracked by GitHub Issue #692. The reviewed seven-file diff changes no runtime or native data-plane boundary."
risk: "high"
requirement_ids: ["R1", "R2", "R3", "R4", "R5", "R6", "R7"]
repair_of: []
---

# Executive Summary
Native fixture qualification now assigns every behavior a risk tier and mechanically accounts for success, negative, recovery, persistence, rollback, and operations evidence. Executable Vitest and gate entries declare the dimensions they prove; fixture files remain ownership evidence only.

# Review Contract
Review Issue #691 against schema-v2 fail-closed validation, honest risk classification, semantic tier-floor exemptions, exact executable evidence bindings, the 74-behavior native-only scope, and preservation of existing runtime/public contracts.

# Before And After
Before this change, schema v1 proved that evidence existed and ran but could not distinguish risk or failure/recovery dimensions. After the change, 66 qualified rows account for tier floors across 13 low, 12 medium, 40 high, and 1 release behavior; 8 excluded rows remain risk none.

# Implementation Path
The fixture validator owns the schema vocabulary, exact object validation, tier floors, shared executable coverage checks, and uncovered-requirement rejection. The existing focused script tests cover fail-closed malformed cases. The manifest adds reviewed metadata and four existing Vitest bindings, while the structural summary and bilingual documentation expose the resulting totals.

# Change Surface
The coherent surface is exactly seven files: the manifest, validator, focused validator tests, structural reporter, native fixture contract document, and its English/Chinese README summaries. No source runtime, provider, transcript, fixture asset, package script, CI workflow, or dependency changed.

# Contracts And Compatibility
Repository-local manifest schema v1 is intentionally rejected with an explicit numeric-v2 diagnostic. Public CLI/runtime and authoritative native JSONL contracts are unchanged. Exact prior behavior IDs, contracts, modules, outcomes, gates, fixtures, and evidence references are preserved, with only four reviewed existing Vitest references added.

# Architecture Impact
An incremental architecture update cannot be verified because the canonical model files are absent. The appropriate verdict is MODEL_REBUILD_REQUIRED, tracked separately by #692; inspection confirms this schema/test/documentation change does not alter product boundaries or critical runtime flows.

# Verification Evidence
Primary verification passed 68 focused validator tests; structural schema validation; executable qualification of 74 behaviors and 114 exact Vitest entries; manifest normalization comparison; `npm run check` with 249 files and 3270 tests; installed package, native deletion, TUI PTY, and performance gates; and `npm audit --omit=dev` with zero vulnerabilities. Independent final Standards and Spec reviews reported no findings.

# Risks And Known Gaps
The principal residual risk is semantic overstatement of evidence labels; the final two-axis review specifically rechecked the high-risk rows and all exemptions. Human review remains pending. Architecture bootstrap #692 is a governance gap, not a runtime defect in this change.

# Lineage And Freshness
This is the first ledger entry for both project and fixture-contract scopes. It records base `7bf8ee5` and observed `8c760a8`; freshness fingerprints cover only the seven reviewed product files and exclude pre-existing user-owned local content.

# Reviewer Checklist
- Confirm each high/release row accounts for every tier-floor dimension and that exemptions describe behavior-level non-applicability.
- Confirm Vitest/gate `covers` arrays cannot reference undeclared or exempted dimensions and fixture ownership cannot claim executable coverage.
- Confirm the four added exact Vitest bindings genuinely prove compaction failure/persistence, session-memory failure/retry, and mailbox idempotency.
- Confirm the seven-file diff contains no runtime, provider, transcript, CI, dependency, or fixture-asset change.
- Confirm architecture bootstrap remains isolated in #692 and review status remains pending until an explicit human decision.
