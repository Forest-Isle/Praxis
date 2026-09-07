---
schema_version: "2"
change_id: "issue-731-release-0700-ledger-freshness"
created_at: "2026-09-07T19:47:54+08:00"
title: "Reconcile Issue 731 with the 0.70.0 base"
change_kind: "contract"
implementation_status: "verified"
review_status: "pending"
project_root: "/Users/wuqisen/dev/Praxis"
parents: ["issue-731-ledger-lineage"]
supersedes: []
scopes: ["project", "project-eval", "fixture-contracts", "architecture-model"]
changed_files: ["CHANGELOG.md", "package.json"]
excluded_preexisting_files: [".claude", "docs/CLAUDE_EXPERIMENTAL_CAPABILITIES.md", "docs/research"]
base_revision: "git:513540d96cd0c8f765708139a232cbb33c29cdcb"
observed_revision: "git:f82c56127eb5349e13643123feea59e4f14524de"
architecture_verdict: "NO_MODEL_CHANGE"
architecture_evidence: "This append-only Ledger freshness record does not edit product or architecture evidence; the parent Issue 731 NO_MODEL_CHANGE verdict remains authoritative, and the two overlays are unchanged files inherited from the merged 0.70.0 main base."
risk: "low"
requirement_ids: ["F1", "F2", "F3"]
repair_of: []
---

# Executive Summary
This append-only governance capsule reconciles the accepted Issue #731 lineage after the branch merged the newer `origin/main` release commit for 0.70.0. Ledger freshness identified exactly two inherited fingerprint changes, `CHANGELOG.md` and `package.json`. This record overlays their current main-branch fingerprints without editing either file or changing the Issue #731 PR behavior.

# Review Contract
Review `issue-731-ledger-lineage`, merge commit `f82c56127eb5349e13643123feea59e4f14524de`, and the three generated Ledger files. Confirm `CHANGELOG.md` and `package.json` match `origin/main` with no three-dot PR diff, they are the only freshness mismatches on the parent head, and this capsule only reconciles those inherited fingerprints.

# Before And After
Before this record, `issue-731-ledger-lineage` remained the sole four-scope head but became `UNRECORDED_DRIFT` after the 0.70.0 base merge. Afterward, the same Issue #731 evidence and lineage remain intact while the new descendant should be the sole `CURRENT` head for project, project-eval, fixture-contracts, and architecture-model.

# Implementation Path
The primary session fetched and merged `origin/main` commit `513540d96cd0c8f765708139a232cbb33c29cdcb` to satisfy the up-to-date PR requirement. The PR three-dot diff remained restricted to Issue #731 files. Ledger status then reported one drifted four-scope head, and an exact comparison of its effective fingerprints with the working tree identified only `CHANGELOG.md` and `package.json`. This low-risk record uses the standard helper to capture those two current base fingerprints.

# Change Surface
The durable Git write surface is this new capsule plus renderer-owned `docs/change-ledger/ledger.json` and `docs/change-ledger/index.md`. `CHANGELOG.md` and `package.json` are schema-required fingerprint overlays only: they are unchanged from `origin/main` and absent from the Issue #731 three-dot PR diff.

# Contracts And Compatibility
Review Ledger schema v2, append-only history, pending human review, and scope-specific freshness remain unchanged. The 0.70.0 release metadata is inherited unchanged. The Issue #731 smoke, 0/36 baseline, no-candidate/no-regression/no-qualification evidence, no-retry boundary, and locked roadmap remain unchanged. No CLI, provider, corpus, configuration, persistence, release, or deployment behavior changes.

# Architecture Impact
The verdict is `NO_MODEL_CHANGE`. This record edits no product or architecture evidence. The parent Issue #731 architecture impact entry, validated model, deterministic views, no affected IDs, and no unresolved inferred claims remain authoritative.

# Verification Evidence
`git diff origin/main...HEAD` before this record contained only the ten Issue #731 documentation and Ledger files; neither `CHANGELOG.md` nor `package.json` appeared. Ledger status reported `issue-731-ledger-lineage` as the sole but drifted four-scope head. Exact effective-fingerprint comparison found only those two mismatches. After recording, status and reconcile must report a valid 26-entry DAG and `issue-731-release-0700-ledger-freshness` as the sole `CURRENT/pending` head for all four scopes.

# Risks And Known Gaps
Risk is low because the two overlaid product files are unchanged on the PR branch relative to the current base. This capsule does not alter or authorize the 0.70.0 release, provider execution, v3 qualification, human review, merge, or deployment. Protected CI remains required on the final PR head.

# Lineage And Freshness
This capsule directly descends from `issue-731-ledger-lineage`, inherits the accepted Issue #728/#731 evidence convergence, and overlays only the two current 0.70.0 base fingerprints. Protected local files and `.agent/**` operational state remain excluded and unattributed.

# Reviewer Checklist
- Confirm `CHANGELOG.md` and `package.json` have no Issue #731 three-dot diff from `origin/main`.
- Confirm they are the only parent-head freshness mismatches after merging 0.70.0.
- Confirm this capsule becomes the sole current pending head for all four Issue #731 scopes and the ledger remains valid.
- Confirm no product, source, documentation, architecture, release, provider, corpus, or prior capsule content changed.
