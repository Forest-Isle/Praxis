---
schema_version: "2"
change_id: "issue-748-held-out-v4-gpt55-repeatability"
created_at: "2026-09-08T10:23:45+08:00"
title: "Record held-out v4 gpt-5.5 smoke boundary"
change_kind: "contract"
implementation_status: "verified"
review_status: "pending"
project_root: "/Users/wuqisen/dev/Praxis"
parents: ["issue-745-codex-error-diagnostics"]
supersedes: []
scopes: ["project", "project-eval", "fixture-contracts", "architecture-model", "provider-gateway"]
changed_files: ["README.md", "README_zh.md", "docs/CLI_REFERENCE.md", "docs/CODING_AGENT_ROADMAP.md", "docs/NATIVE_FIXTURE_CONTRACTS.md", "docs/architecture/impact-log.md", "docs/architecture/model-state.json"]
excluded_preexisting_files: [".claude", "docs/CLAUDE_EXPERIMENTAL_CAPABILITIES.md", "docs/research"]
base_revision: "git:e152a2b1c1f2aba150cb28cbf577780d699b0011"
observed_revision: "git:2f7a4465f5dd1ed76344fce491325a298af48b59"
architecture_verdict: "NO_MODEL_CHANGE"
architecture_evidence: "The Issue #748 impact entry maps the release-version-only package.json delta to existing evidence, confirms no architecture boundary or flow change, validates the canonical model, verifies two deterministic ten-view renders against canonical output, advances the checkpoint, and observes zero post-checkpoint drift."
risk: "high"
requirement_ids: ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8"]
repair_of: []
---

# Executive Summary
Praxis preserves the terminal aggregate evidence from Issue #748's single authorized held-out-v4 pre-corpus smoke against the fixed `gpt-5.5` Codex relay identity. The request failed closed with HTTP 404 and bounded `model_not_found` diagnostics before any corpus case. Baseline and candidate were not admitted, each remains 0/36 with no artifacts, v4 remains unexecuted, Task 8.2 remains incomplete, and Phase 9 remains locked.

# Review Contract
Review Issue #748 and the seven attributed documentation and architecture-evidence paths. Confirm the fixed source, emitted artifact, corpus, provider/profile/protocol/model/endpoint, configuration, provider-free admission, sole smoke result, bounded diagnostics, zero mutation and credential occurrence, absent baseline/candidate authorization and evidence, and permanent no-retry/no-substitution decision. Confirm no v4 task detail, corpus content, provider/runtime implementation, credential, generated output, relay mutation, or local evaluation artifact entered the product change.

# Before And After
Before this change, public evidence ended with Issue #742's immutable failed admission and the separate Issue #745 diagnostic capability; there was no result for the newly pinned Issue #748 request. Afterward, the public owners record exactly one failed-closed pre-corpus smoke for the fixed `gpt-5.5` request and the resulting non-admission of both 36-run phases. This is smoke failure evidence, not a baseline, candidate, comparison, corpus aggregate, or qualification result.

# Implementation Path
The primary session fixed the high-risk identities, staged authorization boundaries, one-shot policy, provider-free gates, immutable roots, secret handling, and no-rerun conditions; it then executed and validated the only authorized smoke and stopped the campaign. The required `gpt-5.6-luna` implementation sub-agent `issue_748_document_failed_smoke` reached terminal state `done` for the five-owner evidence module and its bounded prose repair. The primary reviewed the full seven-file diff and accepted the architecture checkpoint only after local high-risk gates and independent Standards and Spec reviewers returned no findings.

# Change Surface
Both READMEs add concise failed-smoke summaries. CLI Reference, Coding Agent Roadmap, and Native Fixture Contracts preserve the exact aggregate boundary, safe diagnostics, digests, zero counters, no-claim constraints, absent baseline/candidate evidence, and continued roadmap lock. The architecture impact log records `NO_MODEL_CHANGE`, while model state advances the already modeled `package.json` evidence fingerprint for the intervening 0.70.2 release version. No source, package manifest, provider configuration, corpus, fixture, verifier, release, deployment, or persisted runtime state changed on this branch.

# Contracts And Compatibility
The campaign pins runtime source `e152a2b1c1f2aba150cb28cbf577780d699b0011`, emitted artifact `sha256:80a4bc792f727b75ab1259c4c6d9fdc4e93dad333d112f2f75bab143c7ea9cdd`, corpus `praxis-held-out-v4@sha256:a32cb478cd6a99971cb57964c82affa3296546c387a4f1dacf4df7d313480b53`, and `codex-relay/default/codex-responses/gpt-5.5` at `https://codex.senyu.blog/responses`. Public CLI, provider, evaluation, persistence, transcript, safety, billing, and native data-plane contracts are unchanged. The observed diagnostic is bounded to this response, does not identify its producing external layer, and does not explain or authorize a retry of Issue #742.

# Architecture Impact
The verdict is `NO_MODEL_CHANGE`. Bounded collection observed only the preceding `origin/main` version change in `package.json`, while its modeled `bin` evidence and all architecture facts remained unchanged. No public boundary, persistence shape, integration, registration, deployment unit, relation, or critical flow changed. The canonical model validated, two temporary renders produced ten byte-identical views matching canonical output, the checkpoint advanced only afterward, and post-checkpoint collection reported zero additions, modifications, or deletions.

# Verification Evidence
Provider-free admission passed a clean install with zero audit vulnerabilities, a clean build, 66 focused tests, one focused Project Eval provider-root regression with 131 skipped, doctor 12/12, four syntax-valid harnesses, a healthy Worker v9 relay root, and a valid eight-record catalog containing fixed `gpt-5.5`. The sole smoke child exited 1; its bounded harness completed in 3,350 ms with terminal `api_error`, HTTP 404, result duration 2,478 ms, API duration 0 ms, zero tokens, tools, stderr, files, timeout, overflow, signal, mutation, or credential occurrence. Final `npm run check` passed 257 files and 3,391 tests; package verification passed for 0.70.2; performance gates passed; `npm audit --omit=dev` found zero vulnerabilities. Documentation, diff, architecture, and initial dual-axis review gates passed.

# Risks And Known Gaps
Risk is high because the evidence consumed one external relay request and guards roadmap qualification. Safe diagnostics were limited to `type=invalid_request_error`, `code=model_not_found`, and the bounded `cf_ray`; they establish neither an external cause nor historical Issue #742 attribution. No baseline or candidate request occurred, so there is no corpus behavior, mutation-oriented safety, verifier, usage, subscription-cost, regression, comparison, or qualification evidence. Protected PR CI and explicit human review remain pending; this capsule grants no provider retry, merge, release, deployment, or migration authority.

# Lineage And Freshness
This capsule directly descends from `issue-745-codex-error-diagnostics` and records the subsequent Issue #748 campaign boundary without changing the diagnostic implementation. It fingerprints only the seven accepted evidence and architecture paths at `2f7a4465f5dd1ed76344fce491325a298af48b59`. Pre-existing `.claude`, `docs/CLAUDE_EXPERIMENTAL_CAPABILITIES.md`, `docs/research`, ignored `.agent/**` operations, credentials, build/package output, relay files, evaluation artifacts, and detached runtimes remain excluded and unattributed. Human review remains pending.

# Reviewer Checklist
- Confirm the documented source, artifact, corpus, provider/profile/protocol/model/endpoint, configuration, terminal counters, timing, and digests match Issue #748's preserved aggregate evidence.
- Confirm exactly one smoke occurred and its HTTP 404 plus bounded identifiers are reported without assigning an unsupported source or explanation.
- Confirm baseline and candidate each remain unattempted at 0/36, v4 remains unexecuted, and no corpus usage, behavior, safety, verifier, cost, comparison, or qualification conclusion is implied.
- Confirm the permanent no-retry/no-substitution boundary, Issue #742 immutability, Task 8.2 incompleteness, and Phase 9 lock remain explicit.
- Confirm the seven changed paths contain no source, package manifest, provider configuration, task detail, corpus content, credential, generated output, relay mutation, or evaluation artifact.
- Confirm the architecture verdict is `NO_MODEL_CHANGE`, ten deterministic views match canonical output, and model state only advances the existing package evidence checkpoint.
- Confirm all local high-risk gates and independent Standards and Spec reviews passed while protected CI and human review correctly remain pending.
- Confirm protected local paths and ignored operational evidence remain excluded from this capsule and product history.
