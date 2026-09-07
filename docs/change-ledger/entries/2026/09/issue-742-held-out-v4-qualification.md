---
schema_version: "2"
change_id: "issue-742-held-out-v4-qualification"
created_at: "2026-09-08T04:45:58+08:00"
title: "Record the held-out v4 admission failure"
change_kind: "contract"
implementation_status: "verified"
review_status: "pending"
project_root: "/Users/wuqisen/dev/Praxis"
parents: ["issue-740-held-out-v4-corpus"]
supersedes: []
scopes: ["project", "project-eval", "fixture-contracts", "architecture-model", "provider-gateway"]
changed_files: ["README.md", "README_zh.md", "docs/CLI_REFERENCE.md", "docs/CODING_AGENT_ROADMAP.md", "docs/NATIVE_FIXTURE_CONTRACTS.md", "docs/architecture/impact-log.md"]
excluded_preexisting_files: [".claude", "docs/CLAUDE_EXPERIMENTAL_CAPABILITIES.md", "docs/research"]
base_revision: "git:2dfb43e9ea00b38cbc4ca85ce7c2307042140880"
observed_revision: "git:2dfb43e9ea00b38cbc4ca85ce7c2307042140880+worktree"
architecture_verdict: "NO_MODEL_CHANGE"
architecture_evidence: "The Issue #742 impact entry records zero bounded source changes, no changed runtime or public boundary, affected IDs none, a valid canonical model, and two byte-identical temporary renders of ten views."
risk: "high"
requirement_ids: ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8"]
repair_of: []
---

# Executive Summary
Praxis preserves the terminal aggregate evidence from Issue #742's single authorized held-out-v4 pre-corpus smoke. The pinned Codex relay request failed closed with HTTP 404 before any corpus case; its source remains unestablished. Baseline and candidate were not admitted, zero of 36 planned runs occurred for each, v4 remains unexecuted, Task 8.2 remains incomplete, and Phase 9 remains locked.

# Review Contract
Review Issue #742 and the six attributed documentation and architecture-evidence paths. Confirm the fixed source, emitted build artifact, corpus, relay provider identity, smoke configuration, exact terminal result and counters, unknown-cause boundary, zero baseline/candidate execution, absence of corpus and qualification evidence, and permanent no-rerun decision. Confirm no task detail, corpus content, provider/runtime implementation, credential, generated output, or local evaluation artifact entered the product change.

# Before And After
Before this change, v4 was frozen but had never reached a provider request. Afterward, public documentation records one failed-closed pre-corpus smoke and the resulting non-admission of both 36-run phases. This is failure evidence, not a baseline, candidate, comparison, or qualification result; it does not unlock roadmap work.

# Implementation Path
The primary session fixed the high-risk identities and one-shot policy, then owned provider-free preflight, relay health verification, the only smoke, terminal artifact validation, and the decision not to admit or retry corpus execution. The `gpt-5.6-luna` implementation sub-agent `issue_742_docs` reached terminal state `done` for the five-document evidence module and two bounded repairs. Independent Standards and Spec reviewers rechecked the repaired diff and returned no findings. The primary accepted the final evidence language only after the full high-risk local gate and architecture assessment passed.

# Change Surface
Both READMEs add concise failed-admission summaries and link the detailed evidence owner. CLI Reference, Coding Agent Roadmap, and Native Fixture Contracts record the fixed identities, exact terminal result, zero counters, 0/36 non-execution for baseline and candidate, prohibited attribution and inference boundaries, and the continued Task 8.2/Phase 9 lock. The architecture impact log records `NO_MODEL_CHANGE`. No source, provider configuration, corpus, fixture, verifier, package, release, deployment, or persisted runtime state changed.

# Contracts And Compatibility
The campaign pins runtime source `2dfb43e9ea00b38cbc4ca85ce7c2307042140880`, emitted artifact `sha256:f6e99df40f107902d2670c0e6d6a783f980371cbc464ff8e0f90483c7bd56c41`, corpus `praxis-held-out-v4@sha256:a32cb478cd6a99971cb57964c82affa3296546c387a4f1dacf4df7d313480b53`, and `codex-relay/default/codex-responses/gpt-5.6-sol`. Public CLI, provider, evaluation, persistence, safety, transcript, and local-first data-plane contracts are unchanged. No later run may reinterpret or retry Issue #742; a future campaign requires separate diagnosis and explicit authorization.

# Architecture Impact
The verdict is `NO_MODEL_CHANGE`. The established bounded source scope reported `added=0`, `modified=0`, and `deleted=0`; no public contract, persistence shape, integration, registration, runtime/deployment unit, relation, or critical flow changed. The canonical model validated, two temporary render passes produced byte-identical hashes for ten views, affected IDs are none, and no inferred claim remains unresolved.

# Verification Evidence
Provider-free preflight used a clean detached runtime, froze the build identity, and passed six focused files with 84 tests. Relay health reported 3/3 active accounts and zero shadow bans. The only smoke exited 1 after 1,969 ms with terminal subtype `success`, `is_error: true`, `terminal_reason: api_error`, HTTP 404, zero API duration, zero input/output tokens, zero tools/tool calls, empty stderr, and no isolated-workspace entries. Final `npm run check` passed 257 test files and 3,384 tests. Native package verification passed for 0.70.1. Performance passed with projection ratios 1.95/2.00 below 3.25, injected regression rejection at 21.78x and 1,210.6 ms, and quiet-frame p95 1.70/1.68/1.59 ms within limits. `npm audit --omit=dev` reported zero vulnerabilities. Documentation, formatting, diff, dual-axis review, scope, and architecture gates passed.

# Risks And Known Gaps
Risk remains high because the evidence consumed an external relay request and guards the roadmap qualification boundary. The HTTP 404 source is not established and cannot be attributed to edge, relay, upstream, model routing, request shape, or provider. No corpus completion request occurred, so there is no behavior, mutation-oriented safety, verifier, regression, usage, subscription-cost, aggregate, comparison, or qualification verdict evidence. Protected PR CI and explicit human review remain pending; this record grants no retry, merge, release, deployment, or provider authority.

# Lineage And Freshness
This capsule directly descends from `issue-740-held-out-v4-corpus` and advances the project, Project Eval, fixture-contract, architecture-model, and provider-gateway evidence scopes. It fingerprints only the six accepted Issue #742 paths in the worktree based on `2dfb43e9ea00b38cbc4ca85ce7c2307042140880`. Pre-existing `.claude`, `docs/CLAUDE_EXPERIMENTAL_CAPABILITIES.md`, `docs/research`, ignored `.agent` operational state, generated builds/packages, credentials, campaign outputs, and detached runtimes remain excluded and unattributed. Human review remains pending.

# Reviewer Checklist
- Confirm every documented source, artifact, corpus, provider, configuration, timing, counter, and digest matches the preserved Issue #742 evidence.
- Confirm the HTTP 404 is reported without assigning an unsupported source or defect class.
- Confirm baseline and candidate each remain 0/36, v4 remains unexecuted, and no corpus usage, cost, behavior, safety, verifier, comparison, or qualification conclusion is implied.
- Confirm the permanent no-rerun boundary, Task 8.2 incompleteness, Phase 9 lock, and future explicit-authorization requirement remain explicit.
- Confirm the architecture verdict is `NO_MODEL_CHANGE`, affected IDs are none, and no generated view or canonical model change entered the diff.
- Confirm protected local paths, `.agent/**`, credentials, campaign artifacts, source/provider code, corpus content, and detached runtimes remain excluded.
- Confirm local gates and dual-axis review passed while protected CI and human review remain pending.
