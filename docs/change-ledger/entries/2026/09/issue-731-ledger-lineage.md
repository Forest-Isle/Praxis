---
schema_version: "2"
change_id: "issue-731-ledger-lineage"
created_at: "2026-09-07T19:29:30+08:00"
title: "Reconcile Issue 731 evaluation evidence lineage"
change_kind: "contract"
implementation_status: "verified"
review_status: "pending"
project_root: "/Users/wuqisen/dev/Praxis"
parents: ["issue-731-held-out-v3-codex-relay", "issue-724-held-out-v3-relay-qualification"]
supersedes: []
scopes: ["project", "project-eval", "fixture-contracts", "architecture-model"]
changed_files: ["README.md", "README_zh.md", "docs/CLI_REFERENCE.md", "docs/CODING_AGENT_ROADMAP.md", "docs/GETTING_STARTED.md", "docs/NATIVE_FIXTURE_CONTRACTS.md", "docs/adr/0006-native-provider-authentication.md", "docs/adr/0007-openai-chat-responses-portability.md", "docs/architecture/context.md", "docs/architecture/data-flow.md", "docs/architecture/impact-log.md", "docs/architecture/model-state.json", "docs/architecture/model.yaml", "docs/architecture/modules.md", "src/maintenance/doctor.test.ts", "src/providers/codex-responses.test.ts", "src/providers/codex-responses.ts", "src/providers/codex-subscription.test.ts", "src/providers/codex-subscription.ts", "src/providers/openai-responses.test.ts", "src/providers/provider-registry.test.ts", "src/providers/provider-registry.ts", "src/providers/provider-settings.test.ts", "src/providers/provider-settings.ts", "src/providers/responses-codec.ts"]
excluded_preexisting_files: [".claude", "docs/CLAUDE_EXPERIMENTAL_CAPABILITIES.md", "docs/research"]
base_revision: "git:1a7575d05d2de0b2da23a9dbcce48b150e9e53d5"
observed_revision: "git:60a735e77b785bfa60492347b28dfe9ff528ff0d"
architecture_verdict: "NO_MODEL_CHANGE"
architecture_evidence: "This append-only Ledger lineage reconciliation changes no product or architecture evidence; it carries forward the accepted Issue 731 NO_MODEL_CHANGE verdict and overlays the exact 25 current fingerprints that differ between the Issue 724 and Issue 731 parent branches."
risk: "low"
requirement_ids: ["L1", "L2", "L3"]
repair_of: []
---

# Executive Summary
This append-only governance capsule reconciles Issue #731 across the Review Ledger's two lineage branches. The accepted Issue #731 evidence capsule advanced `project` and `architecture-model` from Issue #728, but the Ledger correctly retained Issue #724 as a parallel `project-eval` and `fixture-contracts` head. This record names both current branches and overlays the exact 25 differing current fingerprints inherited from the accepted Issue #728 provider/architecture change and Issue #731 evidence change, so all four scopes converge without rewriting history or changing product files.

# Review Contract
Review the two parents, the accepted Issue #728 and Issue #731 file sets, and the Ledger status before and after this record. Confirm `issue-731-held-out-v3-codex-relay` is the current project/architecture evidence head, `issue-724-held-out-v3-relay-qualification` remained a parallel evaluation/fixture head, the 25 current overlays exactly cover the parents' inherited fingerprint differences, and this descendant only reconciles lineage and freshness.

# Before And After
Before this record, Issue #731 was `CURRENT` for project and architecture-model, while both Issue #724 and Issue #731 remained heads for project-eval and fixture-contracts. Afterward, one current head should own all four scopes. No campaign, provider, source, documentation, architecture, or review-decision content changes.

# Implementation Path
The primary session recorded the accepted high-risk Issue #731 capsule through the standard helper, then inspected scope-specific status. Status exposed two parallel heads in project-eval and fixture-contracts because the first capsule named only the newer Issue #728 branch. The initial low-risk Change Control lane was retained as abandoned rather than falsely accepted. This dedicated reconciliation declares both heads as parents. Its first record attempt was rejected without a write because the six Issue #731 paths did not cover accepted Issue #728 differences inherited by only one parent; the repaired capsule fingerprints the exact 25 differing current paths.

# Change Surface
The durable Git write surface is this new capsule plus renderer-owned `docs/change-ledger/ledger.json` and `docs/change-ledger/index.md`. The 25 `changed_files` are fingerprint overlays required to reconcile inherited differences from the accepted Issue #728 and Issue #731 branches; none is edited by this record. Prior capsules and human review events remain immutable.

# Contracts And Compatibility
Review Ledger schema v2, append-only chronology, acyclic validation, scope-specific heads, freshness, and pending human review remain unchanged. The Issue #731 runtime, corpus, smoke, 0/36 baseline, no-candidate, no-regression-comparison, no-qualification, no-retry, and locked-roadmap evidence remains exactly as accepted. No production, CLI, provider, configuration, persistence, corpus, or qualification contract changes.

# Architecture Impact
The verdict is `NO_MODEL_CHANGE`. This record changes only ledger governance artifacts and does not change model evidence or project behavior. The parent Issue #731 architecture impact entry, validated canonical model, ten deterministic views, no affected IDs, and no unresolved inferred claims remain authoritative.

# Verification Evidence
The parent capsule was schema-v2 valid and pending review. Scope-specific status showed Issue #731 current for project/architecture-model and parallel Issue #724/Issue #731 heads for project-eval/fixture-contracts. A metadata comparison identified exactly 25 differing inherited paths, and the initial under-covered record was rejected before write. After the repaired record, standard status and reconcile commands must report `issue-731-ledger-lineage` as the sole `CURRENT` head for all four scopes, a valid 25-entry DAG, deterministic index output, and no changes outside the new capsule, ledger metadata, and index relative to this reconciliation baseline.

# Risks And Known Gaps
Risk is low because product and architecture content are unchanged. This record corrects only Review Ledger lineage; it does not repair the Project Eval settings-forwarding gap, authorize a provider request, create v3 qualification evidence, mark human review accepted, or grant release/deployment authority. Protected CI and human review remain pending.

# Lineage And Freshness
This capsule directly names both prior Ledger heads needed for convergence: `issue-731-held-out-v3-codex-relay` carries the current project/architecture, accepted Issue #728 inheritance, and accepted campaign evidence, while `issue-724-held-out-v3-relay-qualification` carries the retained project-eval/fixture branch. It overlays exactly the 25 current paths whose inherited fingerprints differ and excludes protected local content plus `.agent/**` state.

# Reviewer Checklist
- Confirm the pre-reconciliation status contains the documented parallel heads and no other current project-eval/fixture head.
- Confirm both parent IDs exist, the graph stays acyclic, and the 25 overlay paths exactly cover their differing inherited fingerprints at the accepted current revision.
- Confirm the new capsule becomes the sole current head for project, project-eval, fixture-contracts, and architecture-model.
- Confirm no product, documentation, architecture model, source, provider, corpus, or prior capsule content changed.
- Confirm both capsules remain pending human review and no release/provider authority is inferred.
