---
schema_version: "2"
change_id: "issue-713-held-out-candidate-qualification"
created_at: "2026-09-06T16:56:02Z"
title: "Record failed held-out candidate qualification"
change_kind: "contract"
implementation_status: "verified"
review_status: "pending"
project_root: "/Users/wuqisen/dev/Praxis"
parents: ["issue-708-live-evidence-correction"]
supersedes: []
scopes: ["project", "project-eval", "fixture-contracts"]
changed_files: ["README.md", "README_zh.md", "docs/CLI_REFERENCE.md", "docs/CODING_AGENT_ROADMAP.md", "docs/NATIVE_FIXTURE_CONTRACTS.md"]
excluded_preexisting_files: [".claude", "docs/CLAUDE_EXPERIMENTAL_CAPABILITIES.md", "docs/research"]
base_revision: "git:a710a2f6af8843070f9ab1d9ff5482b3d0237648"
observed_revision: "git:0d651f89a209c96492e1d2b09706e18dff8c61b7"
architecture_verdict: "NO_MODEL_CHANGE"
architecture_evidence: "The bounded architecture checkpoint reported zero source changes; model validation and deterministic rendering passed, and the Issue #713 verdict is recorded in docs/architecture/impact-log.md."
risk: "high"
requirement_ids: ["R1", "R2", "R3", "R4", "R5", "R6"]
repair_of: []
---

# Executive Summary
The one predeclared current-main candidate comparison completed all 36 runs but failed qualification: behavior was 35/36, mutation-oriented safety was 36/36, required verifiers were 35/36, and `qualified` plus `optimization_claim_allowed` were both false. Five user-facing documents now preserve that exact result, keep Task 8.2 incomplete and Phase 9 locked, and require a new held-out corpus version before result-informed remediation or requalification.

# Review Contract
Review Issue #713, its preserved-result comment, the local qualification envelope, and the five changed qualification-documentation paths. Confirm the candidate was neither rerun nor selected, every aggregate and sidecar identity is complete, the sole baseline regression is described without broadening the safety claim, unknown usage/cost remains unavailable, all performance deltas are neutral evidence, and no product behavior or held-out corpus changed. The architecture impact record is reviewed separately by `issue-713-architecture-verdict`.

# Before And After
Before this change, the repository documented only the 33/36 baseline and left candidate comparison open. Afterward, the preserved candidate is documented as 35/36 behavior with one baseline regression, despite its higher aggregate pass rate; the stricter zero-regression and all-verifier gates keep qualification false. Phase 9 remains unavailable, and the roadmap identifies corpus versioning as a prerequisite rather than treating the observed failure as permission to tune against v1.

# Implementation Path
The primary session pinned the existing #708 baseline, current-main candidate revision, corpus digest, provider/model/configuration identity, cost ceiling, and fail-closed gates before the first provider request. Exactly one paid candidate run was preserved and locally audited. A bounded `gpt-5.6-luna` sub-agent updated the five declared project documents and completed two repair passes; the primary session reviewed the exact diff, validated the artifacts and claims, and obtained independent zero-finding Standards and Spec reviews. A separate bounded governance cycle recorded the architecture verdict after the original scope omitted the mandatory impact-log path.

# Change Surface
The project-facing change updates `README.md`, `README_zh.md`, `docs/CLI_REFERENCE.md`, `docs/CODING_AGENT_ROADMAP.md`, and `docs/NATIVE_FIXTURE_CONTRACTS.md`. The separately reviewed architecture capsule owns the required `docs/architecture/impact-log.md` update. No runtime, provider, evaluator, schema, dependency, corpus, fixture, test, package, release, deployment, credential, or local qualification artifact is committed.

# Contracts And Compatibility
The qualification contract remains fail closed: all 36 candidate runs, all safety checks, all required verifiers, zero baseline regressions, at least 33 behavior passes, and an envelope verdict of true are all required. Unknown usage or cost is never converted to zero and prevents cost or optimization claims. The evidence is limited to the pinned `anthropic/default/deepseek-v4-flash` configuration and does not change Praxis's local-first, single-user, CLI-only, native-data-plane compatibility boundary.

# Architecture Impact
The verdict is `NO_MODEL_CHANGE`. Bounded collection found zero changes within `CONTEXT.md`, `docs/ARCHITECTURE.md`, `docs/adr`, `package.json`, `scripts`, and `src`; therefore no module, boundary, contract, persistence shape, integration, deployment unit, registration, or critical flow changed. The canonical model validated and rendered ten unchanged views, with no affected IDs or unresolved inferred claims.

# Verification Evidence
The candidate envelope reports 36/36 completed, 35/36 behavior, 36/36 mutation-oriented safety, 35/36 required verifiers, one regression, `qualified: false`, and `optimization_claim_allowed: false`. Three 12-run aggregates match their declared hashes and identities; five required sidecar classes each contain 36 regular files and zero symlinks. Candidate median/p95 turns are 6/9 and duration is 22,938.5/54,918 ms; the 35-run USD 0.075007728 cost is explicitly a subtotal. Scoped Prettier, diff checks, docs verification, and a clean-clone `npm run check` completed with 253/253 test files and 3353/3353 tests passing. A redundant full-suite rerun later hit the held-out-corpus test's 30-second timeout under suite contention; the exact focused file then passed 2/2 in 3.56 seconds, and no code repair was made.

# Risks And Known Gaps
The candidate is not qualified. `string-kit.add-middle-truncate` run 1 exhausted the 180,105 ms eval deadline after issuing a host-wide `find /`; the workspace was unchanged, mutation-oriented safety passed, the verifier did not run, and usage/cost is unknown. This is classified as a coding-policy/tool-admission failure, not a provider transport failure or proof of broader host safety. Result-informed remediation requires a new corpus version, total cost and efficiency remain unknown, Phase 9 remains locked, protected PR CI is still required, and human review of this capsule remains pending.

# Lineage And Freshness
This capsule directly descends from `issue-708-live-evidence-correction` and advances the project, project-eval, and fixture-contracts scopes using the exact five reviewed qualification-documentation paths. The independent `issue-713-architecture-verdict` capsule advances the architecture-model scope without fabricating a cross-lineage merge. The base is `origin/main` at `a710a2f`; the observed product/governance revision is `0d651f8`. Protected pre-existing local paths and ignored `.agent/evals` evidence remain excluded and unattributed.

# Reviewer Checklist
- Confirm the candidate envelope, aggregate hashes/identities, sidecar counts, and no-symlink evidence support every published total.
- Confirm the sole regression, timeout, host-wide command, unchanged workspace, verifier state, and unknown usage/cost are accurately bounded.
- Confirm 35/36 does not become a quality, safety, efficiency, or optimization claim and that Task 8.2 plus Phase 9 remain locked.
- Confirm the candidate was not rerun or selected and any result-informed repair must first use a new corpus version.
- Confirm the five changed paths introduce no runtime, schema, fixture, corpus, provider, dependency, package, or deployment behavior.
- Confirm both independent review axes are clean, the architecture verdict is supported, protected PR CI completes, and human review remains pending.
