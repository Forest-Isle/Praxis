---
schema_version: "2"
change_id: "issue-694-project-eval-evidence"
created_at: "2026-09-05T11:29:32Z"
title: "Harden Project Eval verifier and task-risk evidence"
change_kind: "schema"
implementation_status: "verified"
review_status: "pending"
project_root: "/Users/wuqisen/dev/Praxis"
parents: ["issue-691-ledger-prettier-compat"]
supersedes: []
scopes: ["project", "project-eval", "fixture-contracts"]
changed_files: ["README.md", "README_zh.md", "docs/CLI_REFERENCE.md", "docs/CODING_AGENT_ROADMAP.md", "docs/NATIVE_FIXTURE_CONTRACTS.md", "src/cli.test.ts", "src/evals/apply-patch-admission.test.ts", "src/evals/coding-baseline.test.ts", "src/evals/glob-ripgrep-admission.test.ts", "src/evals/lsp-diagnostics-admission.test.ts", "src/evals/project-eval-comparison.test.ts", "src/evals/project-eval-comparison.ts", "src/evals/project-eval-identity.test.ts", "src/evals/project-eval-identity.ts", "src/evals/project-eval-runner.ts", "src/evals/project-eval-schema.ts", "src/evals/project-eval.test.ts", "src/evals/project-eval.ts", "test/fixtures/manifest.json", "test/fixtures/native/evals/apply-patch-admission/evals/multi-file/case.yaml", "test/fixtures/native/evals/apply-patch-admission/evals/multi-hunk/case.yaml", "test/fixtures/native/evals/apply-patch-admission/evals/path-escape/case.yaml", "test/fixtures/native/evals/apply-patch-admission/evals/stale-context/case.yaml", "test/fixtures/native/evals/glob-ripgrep-admission/evals/default-semantics/case.yaml", "test/fixtures/native/evals/glob-ripgrep-admission/evals/hidden-filter/case.yaml", "test/fixtures/native/evals/glob-ripgrep-admission/evals/ignore-filter/case.yaml", "test/fixtures/native/evals/glob-ripgrep-admission/evals/scope-safety/case.yaml", "test/fixtures/native/evals/lsp-diagnostics-admission/evals/multi-file/case.yaml", "test/fixtures/native/evals/lsp-diagnostics-admission/evals/scope-isolation/case.yaml", "test/fixtures/native/evals/lsp-diagnostics-admission/evals/single-file/case.yaml", "test/fixtures/native/evals/lsp-diagnostics-admission/evals/stale-clear/case.yaml", "test/fixtures/project-evals/evals/active-turn-steering/case.yaml", "test/fixtures/project-evals/evals/bug-fix/case.yaml", "test/fixtures/project-evals/evals/denied-permission-recovery/case.yaml", "test/fixtures/project-evals/evals/long-context-resume/case.yaml", "test/fixtures/project-evals/evals/malformed-tool-input-recovery/case.yaml", "test/fixtures/project-evals/evals/refactor/case.yaml", "test/fixtures/project-evals/evals/repository-navigation/case.yaml", "test/fixtures/project-evals/evals/small-feature/case.yaml"]
excluded_preexisting_files: [".claude", "docs/CLAUDE_EXPERIMENTAL_CAPABILITIES.md", "docs/research"]
base_revision: "git:06f8b43c29fc6ed9604ad2c59506cc9180adc9fb"
observed_revision: "git:06f8b43c29fc6ed9604ad2c59506cc9180adc9fb"
architecture_verdict: "MODEL_REBUILD_REQUIRED"
architecture_evidence: "A bounded collect_changes assessment over the exact 39 reviewed paths returned BOOTSTRAP because the canonical model, impact log, and checkpoint are absent. The public Project Eval contract changed; bootstrap remains separately tracked by #692 and excluded here."
risk: "high"
requirement_ids: ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "C1", "C2", "C3", "D1", "D2", "D3"]
repair_of: []
---

# Executive Summary
Project Eval now binds explicit coding-task risk and required-success verifier contracts into local identities and terminal evidence. Schema-1.2 run and aggregate artifacts retain compact checks, verifier outcomes, and risk totals so aggregate loading can recompute internal consistency, while comparison fails closed on candidate verifier failures and candidate high/release failures.

# Review Contract
Review Issue #694 against its fixed schema versions, exact task-risk semantics, one terminal outcome per verifier, self-contained aggregate validation, candidate qualification gates, twenty shared-case migrations, and the local-first native-only CLI boundary. Do not interpret internal consistency as signed provenance.

# Before And After
Previously case schema 1.0 lacked task risk, verifier success was implicit, prevented verifiers emitted no terminal record, aggregates dropped the checks behind their booleans, and comparison could accept a consistently summarized candidate verifier or critical-risk failure. Now case and verification schemas are 1.1, run/aggregate/comparison schemas are 1.2, and those outcomes are explicit and fail closed.

# Implementation Path
The case parser validates risk plus unique safe required-success verifier definitions. The runner emits ordered passed/failed/not_run records and compact run evidence. Aggregate construction accounts for verifier and risk totals; the loader validates fixed checks, verifier/check bijection, pass/safety derivation, totals, and identity compatibility. Comparison then applies regression, rate, verifier, and critical-risk gates. Shared fixtures, consumers, public docs, and bilingual README summaries migrate with the contract.

# Change Surface
The reviewed coherent surface is exactly 39 files: five Project Eval production modules, eight focused/consumer tests, twenty case definitions, the fixture manifest, three feature documents, the CLI regression consumer, and two README summaries. Operational `.agent` state and renderer-owned Review Ledger artifacts are not attributed to this product change; protected untracked content remains excluded.

# Contracts And Compatibility
Legacy Project Eval case 1.0 and aggregate 1.1 inputs now fail with explicit version diagnostics. Identity sidecars remain 1.1, plugin-eval and workspace-diff contracts remain unchanged, and no provider, runtime, tool, transcript, dependency, CI, hosted, or remote-control behavior changes. Aggregates establish only consistency of included evidence without sidecar traversal, not cryptographic origin or resistance to coordinated rewriting.

# Architecture Impact
The correct architecture verdict is MODEL_REBUILD_REQUIRED because no canonical model or checkpoint exists and this change alters a public local evaluation protocol and qualification flow. A model bootstrap would be material and is already isolated as #692, so #694 writes no architecture artifacts and introduces no inferred architecture claim.

# Verification Evidence
Primary evidence passed 46 focused Project Eval tests, the 20-test canonical baseline, fixture structure with 74 behaviors/172 evidence entries/52 fixtures, executable fixtures with 74 behaviors/114 Vitest entries, final `npm run check` with 249 files/3275 tests, package, native deletion, TUI PTY, performance, and production audit gates with zero vulnerabilities. A connected gpt-5.6-luna built smoke observed eval/compare exit 0 and the expected 1.2/1.1 envelopes without changing Git status. Final independent Standards and Spec reviews reported no findings.

# Risks And Known Gaps
Risk is high because persisted evaluation evidence and qualification decisions changed. The loader cannot authenticate provenance or discover coordinated removal plus recomputation; documentation states that boundary. No canonical release-risk case is invented, so release totals remain explicit zero until real coverage exists. Human review remains pending, and architecture bootstrap #692 remains open governance work rather than a hidden part of this change.

# Lineage And Freshness
This change descends from the current #691 ledger-format head, which already descends from the fixture-risk evidence head, and advances project, project-eval, and fixture-contract scopes. Base and observed Git revision are the same uncommitted branch HEAD; ledger fingerprints bind the exact accepted 39-file working-tree states. Pre-existing local content and generated ledger storage are excluded.

# Reviewer Checklist
- Confirm case schema 1.1 rejects missing/invalid risk and non-required, unsafe, duplicate, or non-pass verifier definitions before runtime creation.
- Confirm each declared verifier gets exactly one ordered passed/failed/not_run record and each compact verifier check matches that status.
- Confirm the loader accepts the legal 523-check maximum and rejects compact-check, safety, verifier-bijection, identity, completion, and risk-total inconsistencies.
- Confirm failing baselines remain comparable while every candidate verifier and candidate high/release task must pass.
- Confirm all twenty shared cases preserve prompts, fixtures, commands, tools, graders, and measured outcomes while carrying honest risk.
- Confirm no provider, runtime, tool, transcript, plugin-eval, dependency, CI, remote, protected-untracked, architecture-bootstrap, or CHANGELOG content entered the 39-file product change.
