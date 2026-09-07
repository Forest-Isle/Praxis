---
schema_version: "2"
change_id: "issue-720-held-out-v2-relay-qualification"
created_at: "2026-09-07T12:49:16+08:00"
title: "Record failed held-out v2 relay qualification"
change_kind: "contract"
implementation_status: "verified"
review_status: "pending"
project_root: "/Users/wuqisen/dev/Praxis"
parents: ["issue-717-bounded-eval-bash-admission", "release-0691-ledger-freshness"]
supersedes: []
scopes: ["project", "project-eval", "fixture-contracts", "architecture-model"]
changed_files: ["CHANGELOG.md", "README.md", "README_zh.md", "docs/CLI_REFERENCE.md", "docs/CODING_AGENT_ROADMAP.md", "docs/NATIVE_FIXTURE_CONTRACTS.md", "docs/architecture/impact-log.md", "docs/architecture/model-state.json", "package.json"]
excluded_preexisting_files: [".claude", "docs/CLAUDE_EXPERIMENTAL_CAPABILITIES.md", "docs/research"]
base_revision: "git:12b1ee6385af5b44620dacf57a70067018a1d5c6"
observed_revision: "git:8cc193a"
architecture_verdict: "NO_MODEL_CHANGE"
architecture_evidence: "The bounded architecture source assessment reported 0/0/0 after the separately accepted 0.69.1 checkpoint catch-up. The canonical model validated, 10 views rendered without changes, no node/relation/flow ID is affected, and the Issue #720 verdict is recorded in docs/architecture/impact-log.md."
risk: "high"
requirement_ids: ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8"]
repair_of: []
---

# Executive Summary
One predeclared held-out v2 baseline/candidate campaign completed through the authorized Codex relay with the pinned `openai-responses/default/openai-responses/gpt-5.4-mini` identity. Baseline behavior was 32/36 and candidate behavior 30/36; both had 36/36 mutation-oriented safety, candidate verifier satisfaction was 30/36, and candidate `qualified: false`. Public evidence now preserves this failed verdict, keeps Task 8.2 incomplete and Phase 9 locked, and requires a new v3 corpus before any result-informed work.

# Review Contract
Review Issue #720, the immutable aggregate envelopes and digests, and the six-file #720 Git diff: five qualification documents plus `docs/architecture/impact-log.md`. Confirm the campaign used exactly one baseline and one candidate provider run, no case content or result-driven remediation was inspected, unknown costs remain unavailable, all deltas are neutral evidence, and no runtime, provider, schema, corpus, package, release, or deployment behavior changed. Separately confirm the three unchanged merge-overlay paths only reconcile current Review Ledger lineage.

# Before And After
Before, the repository correctly kept v2 frozen but still said it had no real-provider evidence. After, it records the pinned 36-run baseline and candidate aggregates, exact failed comparison, result digests, usage/cost availability, and no-claim boundary. The candidate is not selected away or rerun; the roadmap remains locked.

# Implementation Path
The primary session fixed corpus/build/provider/model/configuration identities and fail-closed gates before provider execution, used the user's key only through a process-local environment mapping, excluded unavailable `gpt-5.5` after pre-corpus `model_not_found`, and preserved one baseline plus one candidate campaign. Independent local scripts validated run completeness, sidecars, aggregate bindings, and comparison identities without opening held-out task details. The `gpt-5.6-luna` sub-agent `issue_720_document_v2_qualification` completed the five-document module and one precise repair; the primary session reviewed and accepted the final diff, then recorded the architecture verdict.

# Change Surface
The #720 Git diff updates `README.md`, `README_zh.md`, `docs/CLI_REFERENCE.md`, `docs/CODING_AGENT_ROADMAP.md`, `docs/NATIVE_FIXTURE_CONTRACTS.md`, and `docs/architecture/impact-log.md`. `CHANGELOG.md`, `package.json`, and `docs/architecture/model-state.json` are clean against the accepted branch state and appear in schema `changed_files` only to resolve the two-parent Ledger merge between Issue #717 and the separate 0.69.1 architecture/freshness lineage; they are not #720 implementation edits. Raw `.agent/evals/` artifacts remain local and ignored.

# Contracts And Compatibility
The qualification contract remains fail closed: comparison requires matching provider/profile/protocol/model/configuration/corpus/runtime identities; passing requires no pass-rate or safety regression, zero newly failing runs, and all required candidate verifiers satisfied. Unknown usage or cost never becomes zero and cannot support an optimization claim. Native local-first, single-user, CLI-only behavior, native data plane, provider adapters, evaluator schemas, and frozen corpus contents are unchanged.

# Architecture Impact
The verdict is `NO_MODEL_CHANGE`. After the independently accepted 0.69.1 checkpoint catch-up, bounded collection reported no changes in `CONTEXT.md`, `docs/ARCHITECTURE.md`, `docs/adr`, `package.json`, `scripts`, or `src`. The model validated and rendered 10 unchanged views, with no affected IDs or unresolved inferred claims. The #720 impact-log entry records the evidence-only qualification result.

# Verification Evidence
Baseline completed 36/36 with 32/36 behavior, 36/36 mutation-oriented safety, 32/36 verifier satisfaction, usage known for 35/36, all costs unknown, result digest `sha256:35132302e0dd47718a3edeb021b20ef5687ca48ba76fd849407cdcb00799d5c2`, and `qualified: null`. Candidate completed 36/36 with 30/36 behavior, 36/36 safety, 30/36 verifier satisfaction, usage known for 34/36, all costs unknown, digest `sha256:bddeec01098cf6d35ffe3814945ebd80352e9cc114434ea56910b3692b8d3358`, and `qualified: false`. All 36 identities compare; there are three newly failing and one newly passing run, pass-rate delta −5.56 points, turn delta 0/+2, and duration delta +4,432/+27,866 ms. `npm run check` passed 254 files/3360 tests; package, performance, audit, documentation, formatting, architecture, and scope gates passed.

# Risks And Known Gaps
This remains high risk because held-out evidence gates roadmap progression. Candidate qualification failed and provides no quality, broad security, cost, latency, efficiency, or optimization claim. All cost evidence is unavailable, usage is incomplete, protected PR CI and human review are pending, and Phase 9 remains locked. Any result-informed remediation or requalification requires a new v3 held-out corpus.

# Lineage And Freshness
This capsule merges the current Issue #717 product/project-eval/fixture heads with `release-0691-ledger-freshness`, which carries the separately accepted architecture checkpoint and 0.69.1 release fingerprints. The six #720 Git-diff paths are reviewed here; `CHANGELOG.md`, `package.json`, and `model-state.json` are unchanged merge overlays required by the Ledger's parent-conflict rule. Protected user paths, prior stash state, existing worktrees, corpus content, and ignored `.agent/**` evidence remain excluded and unattributed.

# Reviewer Checklist
- Confirm both result digests, all aggregate counts, 36 comparable identities, and the failed `qualified: false` verdict match the preserved artifacts.
- Confirm unknown cost/usage semantics and turn/duration deltas make no quality, broad-security, cost, latency, efficiency, or optimization claim.
- Confirm exactly one baseline and one candidate provider campaign occurred and the pre-provider candidate path mismatch created no run or output.
- Confirm no held-out v2 task, fixture, verifier, or failure detail was used for remediation and a new v3 corpus is required first.
- Confirm the six-file #720 Git diff changes documentation/evidence only; the three merge-overlay files are clean and not attributed as implementation.
- Confirm all local gates, architecture evidence, Ledger reconciliation, protected CI, and human-review status are reported accurately while Task 8.2 and Phase 9 stay locked.
