---
schema_version: "2"
change_id: "issue-715-ledger-freshness"
created_at: "2026-09-07T09:46:22+08:00"
title: "Reconcile Issue 715 Ledger freshness"
change_kind: "contract"
implementation_status: "verified"
review_status: "pending"
project_root: "/Users/wuqisen/dev/Praxis"
parents: ["issue-715-held-out-v2-corpus"]
supersedes: []
scopes: ["project", "project-eval", "fixture-contracts", "architecture-model"]
changed_files: ["package.json"]
excluded_preexisting_files: [".claude", "docs/CLAUDE_EXPERIMENTAL_CAPABILITIES.md", "docs/research"]
base_revision: "git:2bd88ee228cedc44eda7a2e3cba41977ed1317b8"
observed_revision: "git:2bd88ee228cedc44eda7a2e3cba41977ed1317b8"
architecture_verdict: "NO_MODEL_CHANGE"
architecture_evidence: "This append-only Ledger reconciliation does not edit package.json, product source, configuration, or architecture artifacts; the Issue #715 MODEL_UPDATE_REQUIRED verdict remains on its parent capsule."
risk: "low"
requirement_ids: ["L1", "L2", "L3"]
repair_of: []
---

# Executive Summary
This append-only governance capsule advances the accepted Issue #715 lineage over the current unchanged `package.json` fingerprint. It resolves the only remaining inherited freshness drift and makes the project, project-eval, fixture-contracts, and architecture-model heads mechanically current without rewriting the parent capsule or changing product files.

# Review Contract
Review the parent `issue-715-held-out-v2-corpus`, its immediate Ledger status, the current `package.json`, and `git diff origin/main -- package.json`. Confirm the parent was valid but inherited a pre-release package fingerprint, the current package file is already part of `origin/main` and unchanged on this branch, and this descendant uses it only as the required effective-fingerprint overlay.

# Before And After
Before this record, the Issue #715 capsule was the correct four-scope head but reported `UNRECORDED_DRIFT` solely because its project parent carried an older `package.json` fingerprint. Afterward, the same Issue #715 product and architecture evidence remains inherited while the current package fingerprint is explicit, so Ledger freshness can report `CURRENT`.

# Implementation Path
The primary session compared the parent heads' effective fingerprints, resolved their only merge conflict through the current unchanged `.prettierignore`, recorded the Issue #715 capsule, and then compared that head's effective fingerprints with the filesystem. The exact remaining mismatch was `package.json`. A dedicated low-risk Change Control cycle now records this one-path reconciliation through the standard Ledger helper.

# Change Surface
The durable write surface is only this new capsule plus the renderer-owned `docs/change-ledger/index.md` and `docs/change-ledger/ledger.json`. The schema requires `package.json` in `changed_files` so its current fingerprint overlays stale inherited state, but the file itself is neither edited nor included in the Git diff.

# Contracts And Compatibility
The Review Ledger remains schema v2, append-only, acyclic, and human-review pending. This record does not change package metadata, runtime behavior, held-out corpus identity, evaluator schemas, architecture facts, dependencies, compatibility, release state, or deployment authority.

# Architecture Impact
The verdict is `NO_MODEL_CHANGE` for this reconciliation capsule because it edits no architecture or product evidence. The parent Issue #715 capsule retains its `MODEL_UPDATE_REQUIRED` verdict and complete `cli-composition` evidence; this descendant only makes the combined Ledger lineage fresh.

# Verification Evidence
The current `package.json` has zero diff from `origin/main`. The standard Ledger record/reconcile/status commands must report a valid DAG and `CURRENT` for the new head in all four scopes. Documentation verification and `git diff --check` must pass, and Change Control must observe only the new capsule plus generated index and JSON.

# Risks And Known Gaps
Risk is low because the product tree and package file are unchanged. Human review remains pending on both the parent and this descendant, protected CI is still required for the PR, and no release, merge, deployment, or provider execution is authorized by this record.

# Lineage And Freshness
This capsule directly descends from `issue-715-held-out-v2-corpus` and advances exactly its four scopes. It inherits the parent's reviewed 53-file Issue #715 change and `.prettierignore` merge resolution, then overlays only the current `package.json` fingerprint. Protected local files and `.agent/**` operational state remain excluded and unattributed.

# Reviewer Checklist
- Confirm `package.json` is unchanged from `origin/main` and absent from the branch diff.
- Confirm the parent head's only effective-fingerprint mismatch was `package.json`.
- Confirm this capsule has one parent, advances the same four scopes, and preserves append-only history.
- Confirm Ledger status reports the new head as `CURRENT` with human review still pending.
- Confirm no package, product, corpus, test, architecture, dependency, release, or deployment behavior changes.
