---
schema_version: "2"
change_id: "issue-740-held-out-v4-corpus"
created_at: "2026-09-08T03:31:24+08:00"
title: "Freeze the held-out v4 coding corpus"
change_kind: "contract"
implementation_status: "verified"
review_status: "pending"
project_root: "/Users/wuqisen/dev/Praxis"
parents: ["issue-738-held-out-v3-requalification"]
supersedes: []
scopes: ["project", "project-eval", "fixture-contracts", "architecture-model"]
changed_files: ["CHANGELOG.md", "README.md", "README_zh.md", "docs/CLI_REFERENCE.md", "docs/CODING_AGENT_ROADMAP.md", "docs/NATIVE_FIXTURE_CONTRACTS.md", "docs/architecture/impact-log.md", "docs/architecture/model-state.json", "package.json", "src/evals/held-out-corpus-v4.test.ts", "test/corpora/project-evals/praxis-held-out-v4/corpus.yaml", "test/corpora/project-evals/praxis-held-out-v4/repositories/csv-lens/evals/parse-quoted-row/case.yaml", "test/corpora/project-evals/praxis-held-out-v4/repositories/csv-lens/evals/parse-quoted-row/fixture/src/csv.mjs", "test/corpora/project-evals/praxis-held-out-v4/repositories/csv-lens/evals/reject-ragged-records/case.yaml", "test/corpora/project-evals/praxis-held-out-v4/repositories/csv-lens/evals/reject-ragged-records/fixture/src/csv.mjs", "test/corpora/project-evals/praxis-held-out-v4/repositories/csv-lens/evals/select-columns/case.yaml", "test/corpora/project-evals/praxis-held-out-v4/repositories/csv-lens/evals/select-columns/fixture/src/csv.mjs", "test/corpora/project-evals/praxis-held-out-v4/repositories/csv-lens/evals/stable-serialize/case.yaml", "test/corpora/project-evals/praxis-held-out-v4/repositories/csv-lens/evals/stable-serialize/fixture/src/csv.mjs", "test/corpora/project-evals/praxis-held-out-v4/repositories/memo-lru/evals/cache-undefined-values/case.yaml", "test/corpora/project-evals/praxis-held-out-v4/repositories/memo-lru/evals/cache-undefined-values/fixture/src/cache.mjs", "test/corpora/project-evals/praxis-held-out-v4/repositories/memo-lru/evals/dedupe-concurrent-loads/case.yaml", "test/corpora/project-evals/praxis-held-out-v4/repositories/memo-lru/evals/dedupe-concurrent-loads/fixture/src/cache.mjs", "test/corpora/project-evals/praxis-held-out-v4/repositories/memo-lru/evals/evict-least-recent/case.yaml", "test/corpora/project-evals/praxis-held-out-v4/repositories/memo-lru/evals/evict-least-recent/fixture/src/cache.mjs", "test/corpora/project-evals/praxis-held-out-v4/repositories/memo-lru/evals/expire-with-clock/case.yaml", "test/corpora/project-evals/praxis-held-out-v4/repositories/memo-lru/evals/expire-with-clock/fixture/src/cache.mjs", "test/corpora/project-evals/praxis-held-out-v4/repositories/patch-tree/evals/apply-atomic-batch/case.yaml", "test/corpora/project-evals/praxis-held-out-v4/repositories/patch-tree/evals/apply-atomic-batch/fixture/src/patch.mjs", "test/corpora/project-evals/praxis-held-out-v4/repositories/patch-tree/evals/decode-pointer-tokens/case.yaml", "test/corpora/project-evals/praxis-held-out-v4/repositories/patch-tree/evals/decode-pointer-tokens/fixture/src/patch.mjs", "test/corpora/project-evals/praxis-held-out-v4/repositories/patch-tree/evals/prevent-prototype-pollution/case.yaml", "test/corpora/project-evals/praxis-held-out-v4/repositories/patch-tree/evals/prevent-prototype-pollution/fixture/src/patch.mjs", "test/corpora/project-evals/praxis-held-out-v4/repositories/patch-tree/evals/remove-array-element/case.yaml", "test/corpora/project-evals/praxis-held-out-v4/repositories/patch-tree/evals/remove-array-element/fixture/src/patch.mjs"]
excluded_preexisting_files: [".claude", "docs/CLAUDE_EXPERIMENTAL_CAPABILITIES.md", "docs/research"]
base_revision: "git:874e77e55ecb3db568b19afa0e3e4b4d5cfef28a"
observed_revision: "git:99b47350fcdb77889622aa857180082c34215fe0"
architecture_verdict: "NO_MODEL_CHANGE"
architecture_evidence: "Bounded collection found only package.json test-command wiring and the new v4 contract test. The generic corpus loader, qualification command, installed bin, runtime boundaries, integrations, persistence, registration, and critical flows are unchanged; the canonical model validated, 10 views rendered byte-identically, and the Issue #740 impact verdict/checkpoint ended at added=0 modified=0 deleted=0 with no affected IDs or inferred claims."
risk: "high"
requirement_ids: ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8"]
repair_of: []
---

# Executive Summary
Praxis now contains a fresh, frozen `praxis-held-out-v4` coding corpus across the independent `csv-lens`, `memo-lru`, and `patch-tree` domains. Twelve repository-qualified tasks plan three repetitions each for 36 future runs. Prompts, isolated fixtures, exact mutation policy, deterministic behavior verifiers, and repository-root digest `sha256:a32cb478cd6a99971cb57964c82affa3296546c387a4f1dacf4df7d313480b53` are fixed before any provider execution. No provider was called and no qualification claim is made.

# Review Contract
Review Issue #740 and the exact 35-file corpus, test wiring, documentation, and architecture-evidence surface. Confirm schema 1.0/version 4 and the exact 3/12/36 inventory; schema 1.1 cases with repository-qualified names, three runs, no model pin or forbidden tuning tag, one exact allowed/expected mutation, and non-empty forbidden paths; every pristine verifier exits 42, a present-but-non-functional export exits 1, and correct behavior exits 0; all digest references agree; and no v3 task-detail evidence, provider execution, qualification result, runtime change, or Phase 9 unlock entered the change.

# Before And After
Before this change, the failed aggregate-only v3 campaign required a fresh corpus before any result-informed remediation or requalification. Afterward, v4 supplies a new independently shaped corpus with frozen acceptance semantics. It remains unexecuted: Task 8.2 is incomplete, Phase 9 stays locked, and a future campaign requires separate scope and authorization.

# Implementation Path
The primary session fixed the v4 contract and delegated the corpus module twice to the `gpt-5.6-luna` task `issue_740_v4_corpus`; both runs reached `done` but were rejected for vacuous or incomplete verifier coverage. Under the recorded direct-edit exception, the primary completed the behavior verifiers and contract assertions. The `gpt-5.6-luna` task `issue_740_v4_docs` completed the six-file documentation sync. A full lint gate exposed eight forbidden non-null assertions, which were locally replaced with explicit guards. Parallel Standards and Spec review found Standards clean and four Spec verifier gaps; the primary added CR quoting, first-ragged-row ordering, order-sensitive pointer decoding, and all-path security preflight checks. The same Spec reviewer confirmed every repair and no new regression.

# Change Surface
The v4 root adds one manifest and twelve `case.yaml` plus dependency-free ESM fixtures. `src/evals/held-out-corpus-v4.test.ts` pins identity, policy, inventory, prompts, risk, tools, mutation declarations, tags, digest, and 42/1 verifier states; `package.json` adds it to the focused held-out contract command. README English/Chinese, CLI reference, coding-agent roadmap, native fixture contract, and Unreleased changelog publish the unexecuted boundary. Architecture impact log and model checkpoint record `NO_MODEL_CHANGE`.

# Contracts And Compatibility
Corpus identity is `praxis-held-out-v4` version 4, split `held-out`, with opt-in-only execution, tuning forbidden, and result-informed changes requiring a new version. Existing v1/v2/v3 identities, files, digests, loader behavior, qualification behavior, and preserved results remain unchanged. The generic loader, Project Eval runtime, providers, permissions, transcript/data plane, local-first single-user CLI boundary, and public CLI behavior are unchanged.

# Architecture Impact
The verdict is `NO_MODEL_CHANGE`. Incremental collection found only the test command and new contract test inside the checkpoint scope. Modeled `package.json` evidence still refers to the unchanged installed `bin`; `loadHeldOutCorpus` and `executeHeldOutQualificationCommand` are unchanged. Validation succeeded, 10 views rendered byte-identically, the bounded checkpoint advanced, and the final assessment reported zero added, modified, or deleted paths. Affected node/relation/flow IDs and unresolved inferred claims are none.

# Verification Evidence
The focused v4 contract passed 3/3 and proves all 12 pristine verifiers return 42 and all 12 object exports return 1. An isolated temporary correct-reference audit passed 12/12 with status 0 and removed its temporary repositories. The combined held-out contract passed 6/6. Final `npm run check` passed 257 test files and 3384 tests after formatting, lint, docs, release/CI/fixture/boundary checks, typecheck, native build, and product build. `npm run test:package` passed the 0.70.1 native package. Performance passed with 60k/120k projection ratios 1.96/1.98 below 3.25, injected regression rejection at 21.97x and 1209.9 ms, and quiet-frame p95 1.79/1.67/1.61 ms within limits. `npm audit --omit=dev` reported zero vulnerabilities. Final Standards and Spec reviews were clean; architecture validation/render/checkpoint and diff/scope checks passed.

# Risks And Known Gaps
This remains high risk because contamination or under-specified verifiers could create false future qualification evidence. The checked-in corpus is not secret; held-out means outcomes cannot tune the same version. It has not run against a provider and supplies no baseline, candidate, pass rate, safety rate, usage, cost, latency, quality, efficiency, optimization, or qualification evidence. Protected PR CI and human review remain pending. A separately authorized future campaign is required.

# Lineage And Freshness
This capsule descends from `issue-738-held-out-v3-requalification` and advances `project`, `project-eval`, `fixture-contracts`, and `architecture-model`. It fingerprints only the 35 accepted Issue #740 files at commit `99b47350fcdb77889622aa857180082c34215fe0`. Pre-existing `.claude`, `docs/CLAUDE_EXPERIMENTAL_CAPABILITIES.md`, `docs/research`, ignored `.agent` operational state, build output, package archives, prior corpus details, and provider evidence remain excluded and unattributed. Human review remains pending.

# Reviewer Checklist
- Confirm v4 manifest and test agree on ID/version, repository IDs, all 12 qualified task names, 36 planned runs, and digest `sha256:a32cb478cd6a99971cb57964c82affa3296546c387a4f1dacf4df7d313480b53`.
- Confirm every case has one required verifier, exact one-file mutation bounds, non-empty forbidden paths, required tags, no forbidden tuning tag, and no model pin.
- Confirm the 42/1/0 audit covers every task, including CSV CR quoting and first-ragged ordering, pointer `~01` decoding, asynchronous rejection cleanup, immutable structures, and safe-first/dangerous-later prototype-pollution preflight.
- Confirm no v3 task-detail artifact, runtime/provider/data-plane module, credential, provider request, or qualification decision entered the change.
- Confirm documentation states v4 is frozen but unexecuted and keeps Task 8.2 and Phase 9 locked.
- Confirm local gates, dual-axis review, `NO_MODEL_CHANGE`, protected CI state, and pending human review are reported without implying release authority.
