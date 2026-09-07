---
schema_version: "2"
change_id: "release-0701-ledger-freshness"
created_at: "2026-09-07T23:03:00+08:00"
title: "Reconcile 0.70.1 architecture and Ledger freshness"
change_kind: "contract"
implementation_status: "verified"
review_status: "pending"
project_root: "/Users/wuqisen/dev/Praxis"
parents: ["issue-733-ledger-lineage"]
supersedes: []
scopes: ["project", "project-eval", "fixture-contracts", "architecture-model", "provider-gateway"]
changed_files: ["CHANGELOG.md", "docs/architecture/impact-log.md", "docs/architecture/model-state.json", "package.json"]
excluded_preexisting_files: [".claude", "docs/CLAUDE_EXPERIMENTAL_CAPABILITIES.md", "docs/research"]
base_revision: "git:267fddbeac44c833c18685ee3771e6d96975b9a2"
observed_revision: "git:c3f2038fee80e4d969eb6c95918cb4cabbbd7108+worktree"
architecture_verdict: "NO_MODEL_CHANGE"
architecture_evidence: "The accepted Release 0.70.1 entry in docs/architecture/impact-log.md records that only package version metadata changed in the bounded source scope; validation, two byte-identical renders, and checkpoint convergence passed with affected IDs none."
risk: "medium"
requirement_ids: ["R1", "R2", "R3", "R4", "R5", "R6"]
repair_of: []
---

# Executive Summary
This append-only capsule reconciles the accepted Release 0.70.1 architecture checkpoint with the automated release fingerprints inherited after Issue #733. It advances the five existing Issue #733 scopes over exactly four observed mismatches: the two accepted architecture evidence files and the release-owned `CHANGELOG.md` and `package.json`. It changes no product behavior or release metadata.

# Review Contract
Review direct parent `issue-733-ledger-lineage`, release merge `c3f2038fee80e4d969eb6c95918cb4cabbbd7108`, the accepted 0.70.1 architecture impact entry/checkpoint, and the three generated Ledger files. Confirm the four `changed_files` paths exactly match the parent's effective-fingerprint drift, the two release files have no branch diff from `origin/main`, and the new head is CURRENT/pending in all five target scopes.

# Before And After
Before this capsule, `issue-733-ledger-lineage` was the sole head for project, project-eval, fixture-contracts, architecture-model, and provider-gateway but was stale on two automated-release files and the two newly accepted architecture evidence files. After recording, the same Issue #733 product evidence remains intact while `release-0701-ledger-freshness` becomes the sole CURRENT/pending descendant for those five scopes.

# Implementation Path
Release PR #735 advanced version/changelog metadata after Issue #733. Issue #736 then recorded a `NO_MODEL_CHANGE` impact entry, validated the existing model, rendered all ten views twice without byte changes, and advanced the established bounded checkpoint. Exact comparison of the parent head's effective fingerprints against the current worktree localized four mismatches. The primary Codex session records this capsule through the standard atomic helper after accepting the architecture module.

# Change Surface
The durable Git write surface of Ledger recording is this new capsule plus renderer-owned `docs/change-ledger/ledger.json` and `docs/change-ledger/index.md`. `docs/architecture/impact-log.md` and `docs/architecture/model-state.json` are the separately accepted Issue #736 architecture writes. `CHANGELOG.md` and `package.json` are fingerprint overlays only and remain byte-identical to `origin/main`; neither is edited by this branch.

# Contracts And Compatibility
Review Ledger schema v2, append-only DAG history, inherited freshness, deterministic rendering, and explicit pending human review remain unchanged. The 0.70.1 package version and changelog are inherited without edits. Issue #733's provider-root/per-case isolation, public contracts, Issue #731 no-retry evidence, and roadmap locks remain unchanged.

# Architecture Impact
The verdict is `NO_MODEL_CHANGE`. Release 0.70.1 changes package version metadata without changing the installed CLI `bin`, runtime boundary, public contract, persistence shape, provider integration, registration, deployment unit, relation, or critical flow. Validation and two deterministic renders passed, the bounded checkpoint converged, affected IDs are none, and there are no unresolved inferred claims.

# Verification Evidence
Before recording, Ledger status showed `issue-733-ledger-lineage` as the sole drifted head for the five target scopes. Exact effective-fingerprint comparison identified only `CHANGELOG.md`, `docs/architecture/impact-log.md`, `docs/architecture/model-state.json`, and `package.json`. Architecture validation, two byte-identical renders, bounded checkpoint convergence, focused Prettier, documentation-link verification, and Change Control scope review passed. Post-record status, reconcile, deterministic re-render, and full repository checks remain required before final acceptance.

# Risks And Known Gaps
Risk is medium because the coherent evidence change advances a durable architecture source checkpoint, although runtime behavior is unchanged and Ledger mutation is append-only. Human review remains pending. This capsule grants no authority to rerun Issue #731, execute held-out-v3, invoke a provider, modify release metadata, merge without protected checks, release, or deploy.

# Lineage And Freshness
This capsule directly descends from `issue-733-ledger-lineage`, preserving its accepted Issue #733 and Issue #728 convergence. It overlays exactly the four current mismatches needed for one CURRENT head across the same five scopes. Unrelated scope heads remain parallel. Protected local paths, ignored `.agent/**` state, package lock, release manifest, and temporary evaluation repositories remain excluded and unattributed.

# Reviewer Checklist
- Confirm the four `changed_files` entries exactly match the parent's current effective-fingerprint mismatches and no unrelated path is overlaid.
- Confirm `CHANGELOG.md` and `package.json` remain identical to `origin/main`, while the two architecture files contain only the accepted 0.70.1 evidence/checkpoint changes.
- Confirm `release-0701-ledger-freshness` is the sole CURRENT/pending head for all five target scopes and unrelated heads are preserved.
- Confirm the 29-entry DAG and deterministic index reconcile without rewriting prior capsules or human-review events.
- Confirm Issue #733 behavior/evidence, provider and held-out execution locks, protected local files, and release/deployment authority remain unchanged.
