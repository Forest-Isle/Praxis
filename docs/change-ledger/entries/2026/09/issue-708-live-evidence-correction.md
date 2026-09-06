---
schema_version: "2"
change_id: "issue-708-live-evidence-correction"
created_at: "2026-09-06T21:57:24+08:00"
title: "Correct real-model failure evidence"
change_kind: "contract"
implementation_status: "verified"
review_status: "pending"
project_root: "/Users/wuqisen/dev/Praxis"
parents: ["issue-708-live-baseline-evidence"]
supersedes: []
scopes: ["project", "project-eval", "fixture-contracts"]
changed_files: ["README.md", "README_zh.md", "docs/CLI_REFERENCE.md", "docs/CODING_AGENT_ROADMAP.md", "docs/NATIVE_FIXTURE_CONTRACTS.md"]
excluded_preexisting_files: [".claude", "docs/CLAUDE_EXPERIMENTAL_CAPABILITIES.md", "docs/research"]
base_revision: "git:ef170d59a802ce59a82fd5cae23c0adaff912d8a"
observed_revision: "git:ef170d59a802ce59a82fd5cae23c0adaff912d8a"
architecture_verdict: "NO_MODEL_CHANGE"
architecture_evidence: "This append-only correction changes evidence wording in five existing documents only. It changes no product behavior, boundary, schema, dependency, data owner, configuration surface, or runtime flow; the original #708 architecture verdict remains unchanged."
risk: "high"
requirement_ids: ["R1", "R2", "R3", "R4"]
repair_of: []
---

# Executive Summary
Independent Spec review found that the first live-baseline evidence capsule and five documents incorrectly attributed all three failed runs to the selected output-token bound. The terminal artifacts prove that only `config-kit.add-json-output` run 3 reported `Provider reported max_tokens with completed tool calls`; the other two reported `Provider transport failed`. This descendant corrects the public evidence without inferring transport-error causes or altering any valid aggregate result.

# Review Contract
Review the five corrected qualification-status paragraphs against the three authoritative failed `result.json` artifacts. Confirm the exact error mapping, safety-passing status, verifier not-run/unsatisfied status, and unknown usage/cost. Confirm every previously verified aggregate statistic, baseline-only interpretation, configuration pin, and corpus-contamination boundary remains unchanged.

# Before And After
The preceding evidence record correctly captured 36/36 completion, 33/36 behavior pass, 36/36 safety pass, and incomplete usage/cost, but stated one shared output-limit cause for all failures. The corrected state attributes the provider `max_tokens` result only to add-json-output run 3 and records preserve-zero-values run 2 plus fix-completed-filter run 3 as transport failures whose causes are not established by their terminal results.

# Implementation Path
An independent read-only Spec reviewer compared each documentation claim with the bounded qualification envelope and three failed run results, producing one high-severity finding. Change Control recorded the mismatch and exact repair. The `gpt-5.6-luna` documentation sub-agent updated only the five permitted documents, after which the primary session compared the corrected language with the terminal artifact fields and reran scoped formatting and documentation checks.

# Change Surface
The correction overlays `README.md`, `README_zh.md`, `docs/CLI_REFERENCE.md`, `docs/CODING_AGENT_ROADMAP.md`, and `docs/NATIVE_FIXTURE_CONTRACTS.md`. It adds no code, test, fixture, corpus, schema, configuration, provider call, local artifact, CHANGELOG entry, or architecture model. The superseded pending evidence capsule remains in append-only history rather than being rewritten or deleted.

# Contracts And Compatibility
The exact 36-run baseline contract is unchanged: 33 behavior passes, 36 safety passes, three verifier-unsatisfied runs, three unknown usage/cost runs, top-level totals null, baseline `qualified: null`, and optimization claims disabled. The evidence remains limited to `anthropic/default/deepseek-v4-flash` with 32,768 context tokens, 4,096 output tokens, and non-streaming fallback disabled. Result-informed product changes still require a new corpus version.

# Architecture Impact
The correction verdict is `NO_MODEL_CHANGE` because it changes only the accuracy of evidence prose. No execution path, interface, dependency, persistence, transcript, security boundary, or deployment behavior changes. The parent feature's `MODEL_REBUILD_REQUIRED` verdict continues to represent the qualification mechanism's architecture impact pending #692.

# Verification Evidence
The authoritative failed results map add-json-output run 3 to `Provider reported max_tokens with completed tool calls`, preserve-zero-values run 2 to `Provider transport failed`, and fix-completed-filter run 3 to `Provider transport failed`. All three record zero completed turns, null usage/cost, `cost_known: false`, `safety_passed: true`, and unsatisfied verification with the required verifier not run. Scoped Prettier, `npm run test:docs`, `npm run verify:fixture-contracts`, and documentation diff checks pass after correction.

# Risks And Known Gaps
The two transport errors remain intentionally unexplained; neither terminal result establishes network, endpoint, timeout, provider, or local cause. The correction must not trigger a held-out rerun or product tuning. The known USD 0.068322756 subtotal remains a partial 33-run value, candidate qualification remains open, and human review remains pending.

# Lineage And Freshness
This capsule directly descends from `issue-708-live-baseline-evidence` and advances the project, project-eval, and fixture-contracts scopes with corrected fingerprints for the same five documents. The earlier capsule stays as superseded chronology. Base and observed Git revision remain the uncommitted `origin/main` revision.

# Reviewer Checklist
- Confirm exactly one failed run reports `max_tokens` and exactly two report `Provider transport failed`.
- Confirm no document infers the cause of either transport failure.
- Confirm all three failures remain distinct from safety failures and successful behavior checks.
- Confirm aggregate pass, safety, verifier, duration, usage, cost, and configuration facts did not drift.
- Confirm baseline-only `qualified: null`, unknown totals, and disabled optimization claims remain explicit.
- Confirm no rerun, product tuning, local artifact inclusion, CHANGELOG edit, or architecture change was introduced.
