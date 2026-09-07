---
schema_version: "2"
change_id: "issue-738-held-out-v3-requalification"
created_at: "2026-09-08T01:35:39+08:00"
title: "Record held-out v3 requalification evidence"
change_kind: "contract"
implementation_status: "verified"
review_status: "pending"
project_root: "/Users/wuqisen/dev/Praxis"
parents: ["release-0701-ledger-freshness"]
supersedes: []
scopes: ["project", "project-eval", "fixture-contracts", "architecture-model", "provider-gateway"]
changed_files: ["README.md", "README_zh.md", "docs/CLI_REFERENCE.md", "docs/CODING_AGENT_ROADMAP.md", "docs/NATIVE_FIXTURE_CONTRACTS.md", "docs/architecture/impact-log.md"]
excluded_preexisting_files: [".claude", "docs/CLAUDE_EXPERIMENTAL_CAPABILITIES.md", "docs/research"]
base_revision: "git:dd58084aaf8de8daeb468a396873c593971eaa86"
observed_revision: "git:dd58084aaf8de8daeb468a396873c593971eaa86+worktree"
architecture_verdict: "NO_MODEL_CHANGE"
architecture_evidence: "The Issue 738 impact entry records zero bounded source changes, no changed architecture boundary or flow, affected IDs none, a valid canonical model, and two byte-identical temporary renders of ten views."
risk: "high"
requirement_ids: ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8"]
repair_of: []
---

# Executive Summary
Praxis preserves the terminal aggregate evidence from the single authorized held-out-v3 repeatability campaign after the Project Eval provider-root fix. The smoke succeeded, and baseline and candidate each completed all 36 runs, but candidate behavior and verifier satisfaction fell from 24/36 to 18/36 with 13 newly failing and 7 newly passing runs. The candidate is `qualified: false`; Task 8.2 remains incomplete, Phase 9 remains locked, and result-informed work requires a newly frozen v4 corpus.

# Review Contract
Review Issue #738 and the six attributed documentation/architecture paths. Confirm the fixed runtime, build, corpus, relay provider identity, aggregate completion/safety/behavior/verifier/usage/cost evidence, result digests, absolute and delta timing evidence, all-36 comparable identity match, exact negative qualification verdict, no-claim boundary, and v4 lock. Confirm no task-detail, corpus, fixture, verifier, provider, runtime, credential, generated, or local evaluation artifact entered the product change.

# Before And After
Before this change, public documentation ended with Issue #731's immutable 0/36 provider-root admission failure and Issue #733's accepted fix, while v3 still had no completed baseline/candidate result. Afterward, user-facing summaries and detailed evidence owners record one completed v3 baseline/candidate comparison, its exact failed qualification gates, unavailable subscription cost, neutral timing observations, and the continued Task 8.2/Phase 9 lock.

# Implementation Path
The primary Codex session fixed the high-risk identities, one-shot boundaries, no-retry policy, and provider-free gates; it then owned the only smoke, baseline, candidate, artifact validation, secret scan, and aggregate interpretation. The `gpt-5.6-luna` implementation sub-agent `issue_738_document_qualification` reached terminal state `done` for the five-document evidence module and three bounded repair packets. Primary review repaired wording/digest omissions, accepted independent README organization and evidence-completeness findings, caught two remaining prose fragments, and accepted the final six-file diff only after repeated Standards and Spec reviews returned clean.

# Change Surface
Both READMEs now give concise negative-qualification summaries and link the detailed owner. CLI Reference, Coding Agent Roadmap, and Native Fixture Contracts record the exact aggregate identities, digests, counts, comparable-identity match, absolute/delta turn and duration evidence, unavailable subscription cost, and prohibited claims. `docs/architecture/impact-log.md` records `NO_MODEL_CHANGE`. No source, package, provider configuration, corpus, task, fixture, verifier, release, deployment, or persisted runtime state changed.

# Contracts And Compatibility
The campaign pins runtime `dd58084aaf8de8daeb468a396873c593971eaa86`, emitted build artifact `sha256:f6e99df40f107902d2670c0e6d6a783f980371cbc464ff8e0f90483c7bd56c41`, corpus `praxis-held-out-v3@sha256:9380f5ccd9b920bf9767381f2d36d91dc04abe645db0a7c1a5f1597279d579ff`, and `codex-relay/default/codex-responses/gpt-5.6-sol`. All 36 comparison-critical identities matched across provider, profile, protocol, model, endpoint, configuration, tools, prompt, corpus, source/build, host/runtime, repetition, and verifier identity. Public CLI, provider, evaluation, persistence, data-plane, safety, and compatibility contracts are unchanged.

# Architecture Impact
The verdict is `NO_MODEL_CHANGE`. The established bounded source scope reported `added=0`, `modified=0`, and `deleted=0`; no public boundary, persistence shape, integration, registration, runtime/deployment unit, relation, or critical flow changed. The canonical model validated, two temporary render passes produced byte-identical hashes for ten views, affected IDs are none, and no inferred claim remains unresolved.

# Verification Evidence
The one smoke completed in one turn with zero tools, file mutation, stderr, or credential occurrence. Baseline completed 36/36 with 24 behavior passes, 36 mutation-oriented safety passes, and 24 required-verifier satisfactions; candidate completed 36/36 with 18 behavior passes, 36 safety passes, and 18 verifier satisfactions. Result digests and candidate baseline binding validated; all identities matched; candidate is `qualified: false`. The final `npm run check` passed 256 test files and 3,381 tests. Native package, performance, documentation, formatting, diff, scope, architecture, and production dependency audit gates passed; the audit reported zero vulnerabilities. Repeated independent Standards and Spec reviews were clean.

# Risks And Known Gaps
Risk remains high because the evidence derives from provider-backed model-authored tool runs and can gate the roadmap. Candidate behavior regressed, only 18/36 verifiers were satisfied, usage was known for only 18/36 candidate runs, and subscription cost was unavailable for every run. Timing deltas are neutral evidence and support no quality, broad-security, cost, latency, efficiency, or optimization claim. No live attempt may be retried; protected PR CI and explicit human review remain pending, and this record grants no merge, release, deployment, or provider authority.

# Lineage And Freshness
This capsule directly descends from `release-0701-ledger-freshness` and advances its project, project-eval, fixture-contracts, architecture-model, and provider-gateway scopes without inventing a separate lineage branch. It fingerprints only the six accepted Issue #738 paths. Pre-existing `.claude`, `docs/CLAUDE_EXPERIMENTAL_CAPABILITIES.md`, `docs/research`, ignored `.agent/**` operational state, generated builds/packages, credentials, campaign outputs, and detached temporary runtimes remain excluded and unattributed.

# Reviewer Checklist
- Confirm the runtime, build, corpus, provider/model, baseline digest, and candidate digest match Issue #738 exactly.
- Confirm baseline and candidate counts, all-36 identity matching, absolute/delta timing, regression counts, safety evidence, usage availability, and unavailable subscription cost are internally consistent.
- Confirm `qualified: false`, the failed zero-regression/pass-rate/verifier gates, prohibited broad claims, Task 8.2/Phase 9 lock, and v4 prerequisite remain explicit.
- Confirm the READMEs stay user-oriented while the three detailed owner documents carry the full aggregate evidence.
- Confirm the architecture verdict is `NO_MODEL_CHANGE`, affected IDs are none, and no generated view or canonical model change entered the diff.
- Confirm protected local paths, `.agent/**`, credentials, campaign artifacts, source/provider code, corpus content, and detached runtimes remain excluded.
- Confirm human review and protected PR CI remain pending and no merge, release, deployment, or provider action is implied.
