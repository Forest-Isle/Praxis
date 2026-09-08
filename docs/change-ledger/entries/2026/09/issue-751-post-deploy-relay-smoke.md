---
schema_version: "2"
change_id: "issue-751-post-deploy-relay-smoke"
created_at: "2026-09-08T20:53:45+08:00"
title: "Record successful post-deploy relay smoke"
change_kind: "contract"
implementation_status: "verified"
review_status: "pending"
project_root: "/Users/wuqisen/dev/Praxis"
parents: ["issue-752-relay-correlation-id"]
supersedes: []
scopes: ["project", "relay-smoke", "architecture-model"]
changed_files: ["README.md", "README_zh.md", "docs/CLI_REFERENCE.md", "docs/CODING_AGENT_ROADMAP.md", "docs/NATIVE_FIXTURE_CONTRACTS.md", "docs/architecture/impact-log.md"]
excluded_preexisting_files: [".claude", "docs/CLAUDE_EXPERIMENTAL_CAPABILITIES.md", "docs/research"]
base_revision: "git:ab812daa7c617077f6d7b6960690be42bef67621"
observed_revision: "git:482cab770a3542e027368670d6a9f4cbf9cba8a1"
architecture_verdict: "NO_MODEL_CHANGE"
architecture_evidence: "The Issue #751 impact entry records zero bounded-source drift, no changed architecture boundary or flow, affected IDs none, a valid canonical model, and two byte-identical ten-view renders matching canonical output."
risk: "release"
requirement_ids: ["R1", "R2", "R3", "R4", "R5"]
repair_of: []
---

# Executive Summary
Praxis now records the terminal aggregate evidence from Issue #751's single explicitly authorized post-deploy Codex relay smoke. The fixed `codex-relay/default/codex-responses/gpt-5.6-sol` request completed successfully in one turn with zero tools, retries, substitutions, credential output, or workspace mutation. This proves only bounded connectivity; held-out-v4 remains unexecuted, Task 8.2 remains incomplete, and Phase 9 remains locked.

# Review Contract
Review Issue #751 and exactly the six attributed documentation and architecture-evidence paths. Confirm the fresh exact-identity authorization, provider-free admission, source and artifact identities, one-shot terminal result, safe aggregate counters, absence of retry/fallback/substitution and filesystem mutation, unexercised ordinary-4xx correlation path, and the continued campaign lock. Confirm no corpus detail, runtime implementation, credential, model prose, raw request/response material, or provider log entered the product change.

# Before And After
Before this change, the newly pinned post-deploy request had not run and the prior bounded 404 supplied only failure evidence. Afterward, documentation records one successful connectivity smoke against the fixed deployed relay and provider identity. The result neither executes nor qualifies v4 and authorizes only planning a separately scoped campaign that still requires explicit execution authorization.

# Implementation Path
The primary session fixed the release-risk identities and exactly-once policy, performed provider-free admission, owned the only completion request as a documented high-risk exception, validated the sanitized terminal artifact, and accepted the evidence boundary. The `gpt-5.6-luna` implementation task `/root/issue_751_document_success` reached terminal `done`; a bounded relocation repair moved its exact work into the dedicated branch, and a content repair shortened the READMEs while adding missing authorization and admission evidence. Final independent Standards and Spec reviews returned no findings.

# Change Surface
README English and Chinese add concise connectivity-only summaries and point to the detailed contract. CLI Reference, Coding Agent Roadmap, and Native Fixture Contracts preserve exact admission facts, identities, result counters, safety properties, and non-inference boundaries. The architecture impact log records `NO_MODEL_CHANGE`. No source, test, provider configuration, corpus, fixture, package, relay, deployment, persistence, or runtime file changed.

# Contracts And Compatibility
The fixed request used Praxis `ab812daa7c617077f6d7b6960690be42bef67621`, build artifact `sha256:c047ab2ccddb9756f5c594724d1b37186d6ed8788e60b82621f189c4d3c19c8e`, deployed relay `c86ed42142e65f27d3cfc62f9def83042aa126dc` / `sha256:1193b4ed08cc66e73555a36653d230c73935e926da53b5c6dee12d3c2c1bd5b6`, and `codex-relay/default/codex-responses/gpt-5.6-sol`. CLI, provider, request/response, retry, transcript, persistence, fixture, qualification, and local-first data-plane contracts are unchanged. No success claim extends beyond this one connectivity probe.

# Architecture Impact
The verdict is `NO_MODEL_CHANGE`. Bounded collection of the established source/model scope reported zero added, modified, or deleted paths. The change introduces no boundary, public contract, data shape, integration, registration, runtime/deployment unit, relation, or critical flow. The canonical model validated; two temporary renders produced ten byte-identical views matching canonical output; affected IDs and unresolved inferred claims are none.

# Verification Evidence
Provider-free admission confirmed clean tracked trees, exact deployed checksum and service state, one listener, coherent loopback/direct/edge health, 3/3 active accounts, zero shadow bans, native model-catalog presence, doctor 12/12, harness syntax, empty isolated cwd, absent lock/output roots, and a clean pinned build. The one request exited 0 with completed/end_turn, one turn, 4,634/4,313 ms result/API duration, 346/5 tokens, zero tools/stderr/timeout/overflow/signal/credential occurrence, and unchanged cwd. Final `npm run check` passed 257 files and 3,393 tests; package, performance, audit, focused documentation, formatting, fixture-contract, scope, and dual-axis review gates passed.

# Risks And Known Gaps
Risk is release because the evidence consumed the sole authorized external completion request and constrains the roadmap qualification boundary. No API error or relay request ID occurred, so ordinary-4xx correlation was not exercised. The timings and token counts are one-sample smoke counters, not latency, cost, efficiency, quality, safety, compatibility, optimization, corpus, baseline, candidate, comparison, or qualification evidence. Human review and protected PR CI remain pending; no v4 execution, merge, release, or deployment authority is implied.

# Lineage And Freshness
This capsule directly descends from `issue-752-relay-correlation-id`, advances the current project and architecture-model lineage, and introduces a bounded relay-smoke scope. It fingerprints only the six accepted Issue #751 evidence paths at `482cab770a3542e027368670d6a9f4cbf9cba8a1`. Pre-existing `.claude`, `docs/CLAUDE_EXPERIMENTAL_CAPABILITIES.md`, `docs/research`, ignored `.agent/**` state, credentials, build/package output, relay files, evaluation artifacts, and detached runtimes remain excluded and unattributed. Human review remains pending.

# Reviewer Checklist
- Confirm all fixed Praxis, build, relay, and provider identities match the Issue #751 evidence and no identity substitution occurred.
- Confirm the recorded completion count is exactly one, with one turn, terminal success, zero retries/tools/stderr/workspace mutation, and no retained credential or raw provider material.
- Confirm absence of an API error or relay request ID means the bounded 4xx correlation path was inapplicable, not failed.
- Confirm README language remains concise while the three detailed documents preserve authorization, admission, counters, and non-inference boundaries.
- Confirm v4 is unexecuted, Task 8.2 and Phase 9 remain locked, and the only next frontier is separately scoped planning rather than execution.
- Confirm `NO_MODEL_CHANGE`, final release-risk gates, primary acceptance, and both independent review results are supported by exact evidence.
- Confirm only the six reviewed product paths are attributed and protected local, operational, credential, relay, build, and evaluation data remain excluded.
- Confirm Review Ledger human status and protected PR CI remain pending and this record grants no release, deployment, or provider-request authority.
