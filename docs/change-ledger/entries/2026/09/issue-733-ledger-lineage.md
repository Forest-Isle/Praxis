---
schema_version: "2"
change_id: "issue-733-ledger-lineage"
created_at: "2026-09-07T21:40:06+08:00"
title: "Reconcile Issue 733 provider lineage"
change_kind: "contract"
implementation_status: "verified"
review_status: "pending"
project_root: "/Users/wuqisen/dev/Praxis"
parents: ["issue-733-project-eval-provider-settings", "issue-728-codex-responses-relay"]
supersedes: []
scopes: ["project", "project-eval", "fixture-contracts", "architecture-model", "provider-gateway"]
changed_files: ["CHANGELOG.md", "README.md", "README_zh.md", "docs/CLI_REFERENCE.md", "docs/CODING_AGENT_ROADMAP.md", "docs/NATIVE_FIXTURE_CONTRACTS.md", "docs/architecture/context.md", "docs/architecture/deployment.md", "docs/architecture/impact-log.md", "docs/architecture/model-state.json", "docs/architecture/model.yaml", "docs/architecture/modules.md", "package.json", "src/cli-runtime.ts", "src/cli.test.ts"]
excluded_preexisting_files: [".claude", "docs/CLAUDE_EXPERIMENTAL_CAPABILITIES.md", "docs/research"]
base_revision: "git:d85508d48d3f0fdcd1d71fb4d931439ac04a934b"
observed_revision: "git:d85508d48d3f0fdcd1d71fb4d931439ac04a934b+worktree"
architecture_verdict: "NO_MODEL_CHANGE"
architecture_evidence: "This append-only lineage reconciliation changes no product or architecture fact; the parent Issue 733 MODEL_UPDATE_REQUIRED verdict, validated model, deterministic views, and affected IDs remain authoritative."
risk: "low"
requirement_ids: ["L1", "L2", "L3", "L4"]
repair_of: []
---

# Executive Summary
This append-only governance capsule converges the two provider-gateway heads exposed after recording the accepted Issue #733 fix. It joins the new Issue #733 product capsule with the earlier Issue #728 provider capsule while preserving both immutable records, their evidence, and pending human-review status.

# Review Contract
Review the two named parents, the fifteen fingerprint overlays, and the three generated Ledger files. Confirm the Issue #733 capsule remains unchanged, `issue-728-codex-responses-relay` is explicitly represented as the other provider-gateway head, the unchanged `package.json` overlay resolves the parents' 0.70.0 base difference, and this record makes one current pending head for project, project-eval, fixture-contracts, architecture-model, and provider-gateway without attributing new product work.

# Before And After
Before this record, `issue-733-project-eval-provider-settings` was CURRENT for four scopes but shared provider-gateway head status with `issue-728-codex-responses-relay` because intermediate Issue #731 records did not carry that scope. Afterward, one descendant should be CURRENT across all five Issue #733 scopes while both histories remain reachable and unmodified.

# Implementation Path
The primary session recorded the accepted schema-v2 Issue #733 capsule and ran Ledger reconcile/status. Those mechanical checks validated the 27-entry DAG and surfaced exactly two provider-gateway heads. Following the repository's existing append-only reconciliation pattern, this capsule names both heads as direct parents and overlays the already reviewed Issue #733 file fingerprints.

# Change Surface
The durable Git write surface is this new capsule plus renderer-owned `docs/change-ledger/ledger.json` and `docs/change-ledger/index.md`. The fourteen Issue #733 paths and the current `package.json` are fingerprint overlays only; this reconciliation does not edit them, and the package file remains inherited unchanged from `origin/main`.

# Contracts And Compatibility
Review Ledger schema v2, DAG rules, append-only history, deterministic index generation, scope-specific freshness, and pending human review remain unchanged. The Issue #733 provider-only caller root, per-case isolation, public contract compatibility, Issue #731 no-retry result, and roadmap locks are inherited without modification.

# Architecture Impact
The verdict for this governance-only reconciliation is `NO_MODEL_CHANGE`. It changes no runtime boundary, contract, configuration, integration, persistence shape, registration, deployment unit, or modeled flow. The parent Issue #733 `MODEL_UPDATE_REQUIRED` assessment for `cli-composition` and `cli-resolves-provider` remains authoritative.

# Verification Evidence
Before recording, Ledger reconcile reported a valid 27-entry DAG, the Issue #733 capsule CURRENT in project, project-eval, fixture-contracts, and architecture-model, and exactly two provider-gateway heads. The standard record helper validates the prospective graph and path fingerprints atomically. Post-record reconcile and status are required to prove a valid 28-entry DAG and one CURRENT pending head across all five scopes.

# Risks And Known Gaps
Risk is low because this record only reconciles existing immutable lineage and does not alter reviewed behavior or evidence. Human review remains pending. Protected PR CI remains required, and this capsule grants no authority to rerun Issue #731, start another provider campaign, merge, release, or deploy.

# Lineage And Freshness
The capsule directly joins `issue-733-project-eval-provider-settings` and `issue-728-codex-responses-relay`. It reuses the fourteen accepted Issue #733 file fingerprints and overlays the unchanged current 0.70.0 package fingerprint so the new head can reflect current working-tree truth and cover every parent conflict. Protected local paths, ignored `.agent/**` state, build output, and `/tmp/praxis-731-runtime.PBnffI/repo` remain excluded and unattributed.

# Reviewer Checklist
- Confirm both current provider-gateway heads are direct parents and remain immutable.
- Confirm the fifteen overlays exactly cover the accepted Issue #733 review surface plus unchanged `package.json`, and no product path was edited by reconciliation.
- Confirm project, project-eval, fixture-contracts, architecture-model, and provider-gateway each have only `issue-733-ledger-lineage` as CURRENT head.
- Confirm the 28-entry DAG and deterministic index validate with pending human review preserved.
- Confirm protected local paths, prior human-review events, evaluation evidence, and architecture facts remain unchanged.
