---
schema_version: "2"
change_id: "issue-691-ledger-prettier-compat"
created_at: "2026-09-05T09:41:27Z"
title: "Exclude deterministic review-ledger output from Prettier"
change_kind: "configuration"
implementation_status: "verified"
review_status: "pending"
project_root: "/Users/wuqisen/dev/Praxis"
parents: ["issue-691-risk-tier-evidence"]
supersedes: []
scopes: ["project", "change-ledger"]
changed_files: [".prettierignore"]
excluded_preexisting_files: [".claude", "docs/CLAUDE_EXPERIMENTAL_CAPABILITIES.md", "docs/research"]
base_revision: "git:95bd52a154922b667988f4474b5026992cec85b4"
observed_revision: "git:13f9ac08a1a7d5b1a17ca3c9253195399829069f"
architecture_verdict: "MODEL_REBUILD_REQUIRED"
architecture_evidence: "Canonical architecture model and checkpoint remain absent; bootstrap is tracked by GitHub Issue #692. This formatter-boundary configuration does not alter product architecture."
risk: "low"
requirement_ids: ["F1", "F2"]
repair_of: []
---

# Executive Summary
Praxis now excludes deterministic `docs/change-ledger/` output from Prettier so ledger reconciliation and the repository format gate remain compatible.

# Review Contract
Review the exact one-line `.prettierignore` addition for directory confinement, preservation of all product-authored formatting checks, and compatibility with deterministic ledger regeneration.

# Before And After
Before the repair, freshly rendered ledger artifacts failed `prettier --check .`; formatting them would be overwritten by the next reconciliation. After the repair, renderer bytes remain authoritative and the full repository format gate passes.

# Implementation Path
The repository's existing generated-artifact ignore list gains one exact `docs/change-ledger/` entry. No renderer, formatter configuration, script, or generated artifact is modified by the repair itself.

# Change Surface
The accepted configuration change is exactly `.prettierignore`. The subsequent ledger capsule/index/metadata updates are Review Ledger storage, not additional formatter-policy changes.

# Contracts And Compatibility
Prettier continues to check source, tests, configuration, and non-generated documentation. Ledger validation, reconciliation, fingerprinting, and human-review state are unchanged.

# Architecture Impact
This is repository tooling configuration only and does not alter runtime, persistence, provider, CLI/TUI, deployment, or critical flow architecture. The absent canonical model remains tracked by #692.

# Verification Evidence
Ledger artifact SHA-256 values were identical before and after reconciliation. `npx prettier --check .` passed, followed by `npm run check` with all 249 test files and 3270 tests passing. Change Control observed only `.prettierignore`.

# Risks And Known Gaps
The risk is narrowly suppressing formatting outside generated output; the trailing-slash directory entry confines the exclusion. Human review remains pending. Architecture bootstrap #692 remains separate.

# Lineage And Freshness
This entry descends from `issue-691-risk-tier-evidence`, advances project and change-ledger scopes, and fingerprints only the accepted `.prettierignore` state at commit `13f9ac0`.

# Reviewer Checklist
- Confirm the ignore is exactly `docs/change-ledger/` and does not match broader `docs/` content.
- Confirm reconcile preserves the committed renderer bytes and `prettier --check .` passes.
- Confirm no formatter config, renderer implementation, product source, test, or other documentation changed.
- Confirm review remains pending and architecture bootstrap stays isolated in #692.
