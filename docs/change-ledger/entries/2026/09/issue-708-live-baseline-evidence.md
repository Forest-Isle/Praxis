---
schema_version: "2"
change_id: "issue-708-live-baseline-evidence"
created_at: "2026-09-06T21:48:09+08:00"
title: "Record the pinned real-model baseline"
change_kind: "contract"
implementation_status: "verified"
review_status: "pending"
project_root: "/Users/wuqisen/dev/Praxis"
parents: ["issue-708-real-model-qualification"]
supersedes: []
scopes: ["project", "project-eval", "fixture-contracts"]
changed_files: ["README.md", "README_zh.md", "docs/CLI_REFERENCE.md", "docs/CODING_AGENT_ROADMAP.md", "docs/NATIVE_FIXTURE_CONTRACTS.md"]
excluded_preexisting_files: [".claude", "docs/CLAUDE_EXPERIMENTAL_CAPABILITIES.md", "docs/research"]
base_revision: "git:ef170d59a802ce59a82fd5cae23c0adaff912d8a"
observed_revision: "git:ef170d59a802ce59a82fd5cae23c0adaff912d8a"
architecture_verdict: "NO_MODEL_CHANGE"
architecture_evidence: "This descendant records measured local evaluation evidence and updates existing documentation only; it changes no CLI, runtime, provider, persistence, schema, or architecture boundary. The parent's MODEL_REBUILD_REQUIRED verdict for the qualification flow remains unchanged."
risk: "high"
requirement_ids: ["R1", "R2", "R3", "R4"]
repair_of: []
---

# Executive Summary
A deliberately bounded, baseline-only `praxis-held-out-v1` qualification completed all 36 planned runs against `anthropic/default/deepseek-v4-flash`. Thirty-three runs passed behavior verification, all 36 passed safety, and three failed closed when the selected 4,096-token output allowance ended after completed tool calls. The documentation now records the exact result without claiming candidate qualification, total cost, general model quality, or optimization.

# Review Contract
Review the descendant evidence state against the immutable corpus and the accepted #708 qualification contract. Confirm 36 terminal runs, 33 behavior passes, 36 safety passes, three verifier-unsatisfied runs, exact failed case/run identities, baseline-only `qualified: null`, unknown aggregate usage/cost, and `optimization_claim_allowed: false`. Confirm that the recorded cost is explicitly a known 33-run subtotal and that no local evaluation artifact is added to the product diff.

# Before And After
The parent capsule verified the qualification mechanism while truthfully stating that no paid real-model run had occurred. The user then directed the primary session to obtain the configured identity and continue. Read-only inspection selected the existing DeepSeek route, and one bounded baseline completed. The five public documents now replace the obsolete no-run statement with measured, configuration-specific evidence and its limitations.

# Implementation Path
The primary session resolved `anthropic/default/deepseek-v4-flash` from non-secret environment selection, confirmed model availability and sufficient account availability through public DeepSeek endpoints, and used official weekend/off-peak pricing. It executed the existing built CLI with a 32,768-token context bound, 4,096-token output bound, disabled non-streaming fallback, exact corpus confirmation, required verifiers, and gated-tool grants. A bounded documentation packet was then completed by the `gpt-5.6-luna` implementation sub-agent and accepted after primary diff review.

# Change Surface
This descendant changes only the existing qualification-status paragraphs in `README.md`, `README_zh.md`, `docs/CLI_REFERENCE.md`, `docs/CODING_AGENT_ROADMAP.md`, and `docs/NATIVE_FIXTURE_CONTRACTS.md`. Local result and Project Eval artifacts remain under `.agent/evals/issue-708-deepseek-v4-flash-baseline` and are intentionally excluded from Git. Code, tests, corpus, fixture manifest, CHANGELOG, architecture model, and protected user-owned paths are unchanged by this descendant.

# Contracts And Compatibility
The measured run preserves the immutable corpus digest `sha256:47dfad705f94463ce885e06a61601724be309f9d423241a4df91afde1503ccdb` and all native Project Eval schemas and sidecars. Baseline-only evidence retains `qualified: null`; it does not authorize candidate or optimization claims. Three unknown usage/cost runs keep the top-level totals null. Any product change informed by this held-out result requires a new corpus version before requalification.

# Architecture Impact
This is evidence and documentation only, so the descendant verdict is `NO_MODEL_CHANGE`. It introduces no execution path, dependency, schema, data owner, security boundary, runtime configuration surface, or deployment behavior. The parent feature's `MODEL_REBUILD_REQUIRED` verdict remains the authoritative assessment of the new qualification architecture until #692 bootstraps the canonical model.

# Verification Evidence
The qualification process exited zero after 36/36 terminal artifacts and reported 33 passes, 3 failures, 36 safety passes, median/p95 turns 5/7, and median/p95 duration 28,653.5/52,197 ms. Thirty-three runs reported 749,127 input tokens, 57,712 output tokens, 631,808 cache-read input tokens, and a USD 0.068322756 known-cost subtotal; the three failed runs correctly kept usage and cost unknown. All 36 directories contain regular `trace.jsonl`, `workspace-diff.json`, `verification.json`, `identity.json`, and `result.json` files; all three aggregate SHA-256 values match the qualification envelope and no symlink exists. Scoped Prettier, documentation verification, fixture-contract verification, and diff checks pass.

# Risks And Known Gaps
The 91.7% behavior result applies only to the exact pinned 32,768-context/4,096-output/no-fallback configuration. The three failures are fail-closed output-bound outcomes, not safety violations, but seeing them cannot justify tuning corpus v1 or rerunning to select a better score. Because their usage/cost is unavailable, USD 0.068322756 is not total spend. Candidate comparison remains future work and human review remains pending.

# Lineage And Freshness
This capsule is the direct descendant of `issue-708-real-model-qualification` for the project, project-eval, and fixture-contracts scopes. It overlays the five evidence-bearing documents and inherits the parent's accepted implementation fingerprints for all other #708 files. The base and observed revision remain the uncommitted `origin/main` revision; ledger fingerprints bind the exact reviewed documentation state.

# Reviewer Checklist
- Confirm the local envelope binds exactly three aggregate files and 36 complete regular run-artifact sets with no symlinks.
- Confirm the documents distinguish 33/36 behavior pass from 36/36 safety pass and identify all three fail-closed runs accurately.
- Confirm `qualified: null`, unknown totals, and disabled optimization claims remain explicit.
- Confirm USD 0.068322756 is labelled only as the known 33-run subtotal.
- Confirm the evidence is limited to the pinned 32,768-context/4,096-output/no-fallback configuration.
- Confirm no product change is made from held-out results and any future result-informed change requires a new corpus version.
- Confirm local artifacts and protected user-owned files are excluded from the Git diff.
