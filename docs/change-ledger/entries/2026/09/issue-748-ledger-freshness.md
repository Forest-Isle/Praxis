---
schema_version: "2"
change_id: "issue-748-ledger-freshness"
created_at: "2026-09-08T10:26:41+08:00"
title: "Reconcile Issue 748 Ledger freshness"
change_kind: "contract"
implementation_status: "verified"
review_status: "pending"
project_root: "/Users/wuqisen/dev/Praxis"
parents: ["issue-748-held-out-v4-gpt55-repeatability"]
supersedes: []
scopes: ["project", "project-eval", "fixture-contracts", "architecture-model", "provider-gateway"]
changed_files: ["CHANGELOG.md", "package.json"]
excluded_preexisting_files: [".claude", "docs/CLAUDE_EXPERIMENTAL_CAPABILITIES.md", "docs/research"]
base_revision: "git:2f7a4465f5dd1ed76344fce491325a298af48b59"
observed_revision: "git:2f7a4465f5dd1ed76344fce491325a298af48b59"
architecture_verdict: "NO_MODEL_CHANGE"
architecture_evidence: "This append-only Ledger reconciliation edits no package, architecture, or product evidence; it only overlays the current unchanged release fingerprints inherited by the Issue #748 campaign capsule."
risk: "low"
requirement_ids: ["L1", "L2", "L3"]
repair_of: []
---

# Executive Summary
This append-only governance capsule advances the verified Issue #748 campaign lineage over two inherited release-file fingerprints. It resolves the exact remaining drift in `CHANGELOG.md` and `package.json` without editing either file, changing campaign evidence, or rewriting the immutable parent capsule.

# Review Contract
Review direct parent `issue-748-held-out-v4-gpt55-repeatability`, the pre-record Ledger status, and exact current fingerprints for `CHANGELOG.md` and `package.json`. Confirm those were the parent's only mismatches, both files are byte-identical to `origin/main`, the branch does not edit them, and the descendant produces current pending heads while preserving unrelated parallel heads.

# Before And After
Before this record, the Issue #748 campaign capsule correctly fingerprinted its seven reviewed evidence and architecture paths but inherited the pre-0.70.2 `CHANGELOG.md` and `package.json` states from Issue #745, so its heads reported `UNRECORDED_DRIFT`. Afterward, the campaign evidence remains unchanged while these two current release fingerprints are explicit in a descendant.

# Implementation Path
The primary session recorded the verified Issue #748 campaign capsule through the atomic Ledger helper, reconciled the complete graph, and compared the new head's effective fingerprints to the filesystem. The comparison localized exactly two mismatches. A dedicated low-risk Change Control cycle now records their current hashes through the same helper because prior capsules are immutable and Ledger history is append-only.

# Change Surface
The durable Git write surface is this new capsule plus renderer-owned `docs/change-ledger/ledger.json` and `docs/change-ledger/index.md`. `CHANGELOG.md` and `package.json` appear only as fingerprint overlays required by the schema; they remain unchanged from `origin/main` and absent from the branch diff.

# Contracts And Compatibility
Review Ledger schema v2, append-only DAG history, inherited freshness, deterministic rendering, and explicit pending human review remain unchanged. The 0.70.2 package and changelog contents are inherited without edits. Issue #748's one-smoke terminal evidence, no-retry/no-substitution boundary, absent baseline/candidate evidence, Issue #742 immutability, and roadmap locks remain unchanged.

# Architecture Impact
The verdict is `NO_MODEL_CHANGE`. This reconciliation edits no product, package, architecture, provider, evaluation, persistence, deployment, or runtime file. The Issue #748 parent retains its validated architecture evidence; this descendant only refreshes inherited Ledger fingerprints for two already-current release files.

# Verification Evidence
The Issue #748 campaign capsule recorded and reconciled as a valid schema-v2 entry. Exact effective-fingerprint comparison then identified only `CHANGELOG.md` and `package.json` as mismatches; all seven parent-owned paths matched. Both release files have zero branch diff from `origin/main`. Post-record Ledger reconcile/status, deterministic index, documentation checks, diff checks, Change Control scope verification, and final dual-axis review are required before acceptance.

# Risks And Known Gaps
Risk is low because the two overlay files and every product/runtime path remain unmodified. Human review remains pending, protected PR CI is still required, and this record grants no provider request, campaign retry, merge, release, deployment, migration, or issue-closure authority.

# Lineage And Freshness
This capsule directly descends from `issue-748-held-out-v4-gpt55-repeatability`, inherits its seven reviewed campaign and architecture fingerprints, and overlays only the two current release-file mismatches. It advances the same five scopes without rewriting prior history. Protected paths, ignored `.agent/**` state, credentials, relay files, generated output, evaluation artifacts, and detached runtimes remain excluded and unattributed.

# Reviewer Checklist
- Confirm the parent head's only effective-fingerprint mismatches were `CHANGELOG.md` and `package.json`.
- Confirm both overlay files are unchanged from `origin/main` and absent from the branch diff.
- Confirm the capsule has one parent, the same five scopes, exactly two overlay paths, and no repair or supersession claim.
- Confirm Ledger reconcile/status report valid current pending heads for Issue #748 while unrelated parallel scope heads are preserved.
- Confirm no prior capsule, product source, campaign evidence, architecture evidence, package metadata, provider state, or evaluation artifact changed.
- Confirm human review and protected PR CI remain pending and no merge, release, deployment, or provider authority is implied.
