---
schema_version: "2"
change_id: "issue-708-real-model-qualification"
created_at: "2026-09-06T15:49:09+08:00"
title: "Add pinned held-out qualification workflow"
change_kind: "feature"
implementation_status: "verified"
review_status: "pending"
project_root: "/Users/wuqisen/dev/Praxis"
parents: ["issue-705-readme-sync", "issue-705-held-out-corpus", "issue-691-risk-tier-evidence"]
supersedes: []
scopes: ["project", "project-eval", "fixture-contracts"]
changed_files: ["README.md", "README_zh.md", "docs/ARCHITECTURE.md", "docs/CLI_REFERENCE.md", "docs/CODING_AGENT_ROADMAP.md", "docs/NATIVE_FIXTURE_CONTRACTS.md", "package.json", "src/cli-runtime.ts", "src/cli.test.ts", "src/evals/eval-contract.ts", "src/evals/held-out-qualification.test.ts", "src/evals/held-out-qualification.ts", "src/evals/project-eval-runner.ts", "src/evals/project-eval.ts", "test/fixtures/manifest.json"]
excluded_preexisting_files: [".claude", "docs/CLAUDE_EXPERIMENTAL_CAPABILITIES.md", "docs/research"]
base_revision: "git:ef170d59a802ce59a82fd5cae23c0adaff912d8a"
observed_revision: "git:ef170d59a802ce59a82fd5cae23c0adaff912d8a"
architecture_verdict: "MODEL_REBUILD_REQUIRED"
architecture_evidence: "A bounded assessment over the exact 15 reviewed product paths returned BOOTSTRAP because the canonical model and checkpoint are absent. The new CLI-to-Project-Eval qualification flow is model-impacting, while Issue #692 exclusively owns the separately scoped bootstrap."
risk: "high"
requirement_ids: ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R9", "R10", "R11", "R12"]
repair_of: []
---

# Executive Summary
Praxis now implements an explicit `praxis eval qualify` workflow for the immutable `praxis-held-out-v1` corpus. It pins provider, profile, model, corpus digest, build and runtime identity before execution; reuses Project Eval for exactly 36 local runs; validates aggregate and per-run artifact integrity; and emits a bounded local qualification summary without converting unknown usage or cost into an optimization claim. The mechanism and hermetic evidence are verified, while the separately authorized paid real-model qualification remains open.

# Review Contract
Review GitHub Issue #708 and Change Brief R1-R12: strict opt-in and corpus confirmation; provider/profile/model and permission preflight before provider creation; reuse of Project Eval rather than a second evaluator; complete 3-repository/12-task/36-run evidence; local schema-1.0 summary bound to corpus and aggregate hashes; deterministic case, pass, safety, verifier, percentile, usage, cost, and regression metrics; baseline-only `qualified: null`; candidate safety/regression/pass/verifier gates; preserved Project Eval/native contracts; hermetic focused evidence; and truthful command, artifact, cost, contamination, and roadmap documentation.

# Before And After
Previously Praxis could structurally validate the held-out corpus and run individual Project Eval repositories, but had no single pinned workflow or aggregate-bound qualification envelope. It can now preflight every fixed case and identity, execute all repositories through one explicit CLI surface, persist exact local baseline or candidate evidence, reject unsafe or incomparable evidence, and distinguish implementation proof from measured live-model quality.

# Implementation Path
The selector-first CLI routes `eval qualify` before applying global provider/profile/model prefixes. The qualification parser requires the exact corpus token, verifier authorization, gated-tool grants, output path, and explicit provider identity. Preflight validates corpus, output/baseline paths, baseline aggregate/run artifacts, build identity, twelve isolated workspace identities, protocol/endpoint stability, and baseline comparability before provider creation. Project Eval then owns each isolated run and verifier. Qualification reloads each aggregate, requires the exact run set and identity, verifies contained regular sidecars, hashes aggregate bytes, derives deterministic summaries and median/nearest-rank p95 metrics, applies baseline/candidate gates, and atomically writes `qualification-result.json`.

# Change Surface
The coherent reviewed surface is exactly 15 product files: the qualification module and focused test; provider/profile extensions across the Eval contract, runner, Project Eval command, CLI composition root, and CLI regression test; one package script; one fixture behavior; and six synchronized user/architecture/roadmap/fixture documents. Renderer-owned ledger storage and `.agent` governance state are not attributed. Pre-existing `.claude/`, experimental capability notes, and research documents remain excluded and untouched.

# Contracts And Compatibility
Project Eval case schema 1.1, run/aggregate/comparison schema 1.2, identity schema 1.1, the existing eight-case baseline, native transcript, native state ownership, default provider selection, and ordinary `praxis eval` behavior remain compatible. Qualification adds a local schema-1.0 result only and stores no raw endpoint, prompt, secret, or external upload. Baseline and candidate may use different Praxis builds but must match provider/profile/protocol/endpoint/model/configuration/tools/prompt/corpus and host runtime dimensions. Checked-in held-out tasks are not secret; any result-informed Praxis change requires a new corpus version.

# Architecture Impact
The change adds a public CLI entrypoint and a critical local flow from identity/corpus preflight through Project Eval execution to aggregate-bound qualification evidence. These are architecture-model facts, so `NO_MODEL_CHANGE` is not supportable. The formal verdict is `MODEL_REBUILD_REQUIRED` because the canonical model, generated views, impact log, and checkpoint do not yet exist; #692 owns that bootstrap and #708 deliberately does not create partial model artifacts. Narrative architecture and CLI documents carry the verified facts in the meantime.

# Verification Evidence
Final primary evidence passed qualification 7/7, held-out corpus 2/2, the complete fixture runner with 76 behaviors and 131 Vitest evidence entries, formatter, ESLint, typecheck, native and product builds, and `npm run check` with 253 files and 3,353 tests. The installed package/native-session smoke passed. Performance passed with a 120k projection median of 156.7 ms, a 2.00 scaling ratio under 3.25, and Quiet Operator p95 budgets under their limits. Production audit reported zero vulnerabilities. Built-CLI help was side-effect free, and a deliberately wrong corpus digest exited 1 without writing a result or reaching provider execution. Final independent Standards and Spec reviews reported zero findings after path/artifact and test-contention repairs.

# Risks And Known Gaps
Risk is high because future coding-policy and optimization claims may trust this evidence. Validation fails closed on partial, interrupted, duplicate, missing, unexpected, mixed-identity, stale-corpus, aggregate-tampered, path-escaped, symlinked, or missing-sidecar evidence. Aggregate hashes provide internal artifact binding, not signed provenance or resistance to coordinated local rewriting. No paid live-model baseline or candidate has been run; provider quality, safety rate, pass rate, latency, token usage, and cost are therefore not measured by this change. Human review remains pending and no release/deploy authority is granted.

# Lineage And Freshness
This capsule merges the current project head `issue-705-readme-sync`, the held-out corpus `project-eval`/`fixture-contracts` head, and the older parallel fixture-risk head. Conflicting maintained documentation and manifest state are resolved by listing their current reviewed files explicitly. Base and observed revisions are the same `origin/main` commit because this is a reviewed uncommitted working-tree change; ledger fingerprints bind the exact 15 accepted file states. Later product edits must be recorded as descendants rather than rewriting this capsule.

# Reviewer Checklist
- Confirm the command cannot create a provider before exact corpus, grants, output/baseline, build, and all twelve requested identities pass preflight.
- Confirm the three repository aggregates contain exactly 36 unique terminal runs and every run identity and five-file artifact directory is exact, contained, regular, and non-symlinked.
- Confirm baseline aggregate hashes, derived run/case/statistic fields, plan identity, and cross-build comparable dimensions are recomputed rather than trusted from prose fields.
- Confirm baseline-only evidence keeps `qualified: null`, while a candidate requires 100% safety, zero newly failing runs, nondecreasing pass rate, and all required verifiers.
- Confirm unknown usage or cost remains unavailable and keeps `optimization_claim_allowed` false.
- Confirm normal Eval/default provider behavior, schemas, permissions, native transcripts, and local-only data ownership do not regress.
- Confirm the exact corpus token and artifact layout match the implementation, fixture totals are 76/131, and no document claims measured live-model quality.
- Confirm only the 15 product paths are attributed, protected local data is excluded, #692 still owns architecture bootstrap, and the paid real-model plus human review gates remain open.
