---
schema_version: "2"
change_id: "issue-724-held-out-v3-relay-qualification"
created_at: "2026-09-07T15:44:32+08:00"
title: "Record the held-out v3 relay preflight failure"
change_kind: "contract"
implementation_status: "verified"
review_status: "pending"
project_root: "/Users/wuqisen/dev/Praxis"
parents: ["issue-722-held-out-v3-corpus"]
supersedes: []
scopes: ["project", "project-eval", "fixture-contracts", "architecture-model"]
changed_files: ["CHANGELOG.md", "README.md", "README_zh.md", "docs/CLI_REFERENCE.md", "docs/CODING_AGENT_ROADMAP.md", "docs/NATIVE_FIXTURE_CONTRACTS.md", "docs/architecture/impact-log.md"]
excluded_preexisting_files: [".claude", "docs/CLAUDE_EXPERIMENTAL_CAPABILITIES.md", "docs/research"]
base_revision: "git:adcd6cd65fe64885e166261cd55086c9a1977430"
observed_revision: "git:adcd6cd65fe64885e166261cd55086c9a1977430+worktree"
architecture_verdict: "NO_MODEL_CHANGE"
architecture_evidence: "The bounded architecture collector reported zero source changes; model validation passed, ten existing views rendered without diff, and the Issue #724 impact entry records no affected node, relation, or flow IDs."
risk: "high"
requirement_ids: ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R9"]
repair_of: []
---

# Executive Summary
Praxis preserves the fail-closed result of Issue #724's one permitted pre-corpus Praxis Responses smoke. The pinned `gpt-5.5` request returned HTTP 404 after 2,995 ms before any held-out v3 case ran. No retry, route/model/protocol substitution, baseline, candidate, or qualification run followed. The HTTP 404 source remains unknown, Task 8.2 remains incomplete, and Phase 9 remains locked.

# Review Contract
Review Issue #724 and the seven accepted documentation/architecture files. Confirm the public evidence keeps the smoke identity and configuration fixed, separates #720's earlier `model_not_found` event from #724's unclassified HTTP 404, reports relay/model-list health without inferring the failing layer, limits absence claims to v3 corpus results and evidence, preserves the no-rerun/no-substitution boundary, and does not imply qualification or a Phase 9 unlock.

# Before And After
Before #724, the repository contained the frozen but unexecuted `praxis-held-out-v3` corpus and no #724 campaign result. Afterward, project documentation records that provider-free gates passed but the sole no-tool/no-file smoke failed with HTTP 404 before corpus execution. Both planned output roots remain absent, so no v3 qualification, pass, safety, verifier, cost, latency, or model-quality result exists.

# Implementation Path
The primary session fixed the issue contract, validated relay/model visibility without exposing the process-only credential, built clean detached runtimes at the pinned baseline and candidate revisions, and completed provider-free preflight. The one authorized smoke then failed closed. The `gpt-5.6-luna` agent `issue_724_document_smoke_failure` synchronized the six public documents. Primary review issued two bounded repairs: restoring #720's distinct history, then adding the exact #724 configuration, missing verifier boundary, and precise v3-result scope. Final independent Standards and Spec reviews, including the primary-owned architecture entry, were clean.

# Change Surface
`CHANGELOG.md`, both READMEs, the CLI reference, coding-agent roadmap, and native fixture contract record the observed smoke boundary and locked qualification state. `docs/architecture/impact-log.md` records `NO_MODEL_CHANGE`. No source, provider adapter, configuration, corpus, fixture, verifier, artifact, transcript, or data-plane file changed.

# Contracts And Compatibility
The corpus remains `praxis-held-out-v3@sha256:9380f5ccd9b920bf9767381f2d36d91dc04abe645db0a7c1a5f1597279d579ff`. The smoke used the baseline runtime `e2bc451eb8974cd9e67ccba8e82327d7572a830e`, `openai-responses/default/openai-responses/gpt-5.5`, high effort, 32,768 context, 4,096 reserve, provider-managed output, no fallback, 30/60/180-second provider clocks, empty tools, bare/safe mode, an in-memory session, and one attempted turn. Its HTTP 404 had zero tokens, zero API duration, no tool call, and no file access. The existing CLI, provider, corpus, qualification, persistence, and safety contracts remain unchanged.

# Architecture Impact
The verdict is `NO_MODEL_CHANGE`. Incremental collection found no changes under the checkpointed architecture evidence scope: `CONTEXT.md`, `docs/ARCHITECTURE.md`, `docs/adr`, `package.json`, `scripts`, and `src`. The canonical model validated, ten existing views rendered deterministically without diff, and the checkpoint was refreshed. Affected node, relation, and flow IDs are none; unresolved inferred claims are none.

# Verification Evidence
The current v3 contract passed 3/3 and all twelve pristine verifiers exited sentinel status 42. The baseline runtime passed 30 focused held-out, qualification, and Responses tests; the candidate passed 36 including bounded Bash admission. The final `npm run check` passed 255 test files and 3,361 tests. `npm run test:package` passed the native release package, performance gates passed their scaling/regression/frame thresholds, and `npm audit --omit=dev` reported zero vulnerabilities. Focused Prettier, documentation, and diff checks passed. Both final review axes reported clean for the public documents and architecture-impact entry.

# Risks And Known Gaps
The smoke demonstrated only an HTTP 404 terminal boundary; it does not identify `model_not_found`, relay outage, request-shape incompatibility, edge-route failure, or upstream routing failure. No v3 corpus result or qualification verdict exists, so there is no v3 quality, broad safety, cost, latency, or optimization claim. A separate future issue is required for any compatibility diagnosis. Protected CI and explicit human review are still pending.

# Lineage And Freshness
This capsule descends from `issue-722-held-out-v3-corpus` and advances the `project`, `project-eval`, `fixture-contracts`, and `architecture-model` heads. It fingerprints only the seven accepted Issue #724 paths. Pre-existing `.claude`, `docs/CLAUDE_EXPERIMENTAL_CAPABILITIES.md`, `docs/research`, ignored `.agent/**` operational state, detached campaign worktrees, build output, package tarballs, and local relay changes remain excluded and unattributed.

# Reviewer Checklist
- Confirm the v3 digest and pinned baseline runtime match Issue #724 and no corpus task, fixture, verifier, or result artifact changed.
- Confirm the documented 2,995 ms HTTP 404, one attempted turn, zero tokens/API duration, and no tool/file access match the preserved terminal evidence.
- Confirm #720's earlier `model_not_found` is explicitly separate and no cause is assigned to #724's HTTP 404.
- Confirm absence language is limited to v3 corpus results/evidence and does not erase provider-free preflight evidence.
- Confirm no retry, alternate path/model/protocol, baseline, candidate, or qualification run is claimed and Task 8.2/Phase 9 remain locked.
- Confirm all local high-risk gates and dual-axis reviews are reported without treating passing checks as human acceptance or release authority.
