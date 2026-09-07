---
schema_version: "2"
change_id: "issue-722-held-out-v3-corpus"
created_at: "2026-09-07T14:24:38+08:00"
title: "Freeze the held-out v3 coding corpus"
change_kind: "contract"
implementation_status: "verified"
review_status: "pending"
project_root: "/Users/wuqisen/dev/Praxis"
parents: ["issue-720-held-out-v2-relay-qualification"]
supersedes: []
scopes: ["project", "project-eval", "fixture-contracts", "architecture-model"]
changed_files: ["CHANGELOG.md", "README.md", "README_zh.md", "docs/CLI_REFERENCE.md", "docs/CODING_AGENT_ROADMAP.md", "docs/NATIVE_FIXTURE_CONTRACTS.md", "docs/architecture/impact-log.md", "docs/architecture/model-state.json", "package.json", "src/evals/held-out-corpus-v3.test.ts", "test/corpora/project-evals/praxis-held-out-v3/corpus.yaml", "test/corpora/project-evals/praxis-held-out-v3/repositories/frame-codec/evals/add-encode-frame/case.yaml", "test/corpora/project-evals/praxis-held-out-v3/repositories/frame-codec/evals/add-encode-frame/fixture/src/frame.mjs", "test/corpora/project-evals/praxis-held-out-v3/repositories/frame-codec/evals/copy-decoded-payload/case.yaml", "test/corpora/project-evals/praxis-held-out-v3/repositories/frame-codec/evals/copy-decoded-payload/fixture/src/frame.mjs", "test/corpora/project-evals/praxis-held-out-v3/repositories/frame-codec/evals/reject-invalid-length/case.yaml", "test/corpora/project-evals/praxis-held-out-v3/repositories/frame-codec/evals/reject-invalid-length/fixture/src/frame.mjs", "test/corpora/project-evals/praxis-held-out-v3/repositories/frame-codec/evals/stream-partial-frames/case.yaml", "test/corpora/project-evals/praxis-held-out-v3/repositories/frame-codec/evals/stream-partial-frames/fixture/src/frame.mjs", "test/corpora/project-evals/praxis-held-out-v3/repositories/frame-codec/evals/stream-partial-frames/fixture/src/stream.mjs", "test/corpora/project-evals/praxis-held-out-v3/repositories/graph-craft/evals/add-affected-targets/case.yaml", "test/corpora/project-evals/praxis-held-out-v3/repositories/graph-craft/evals/add-affected-targets/fixture/src/graph.mjs", "test/corpora/project-evals/praxis-held-out-v3/repositories/graph-craft/evals/detect-cycle/case.yaml", "test/corpora/project-evals/praxis-held-out-v3/repositories/graph-craft/evals/detect-cycle/fixture/src/graph.mjs", "test/corpora/project-evals/praxis-held-out-v3/repositories/graph-craft/evals/reject-unknown-dependency/case.yaml", "test/corpora/project-evals/praxis-held-out-v3/repositories/graph-craft/evals/reject-unknown-dependency/fixture/src/graph.mjs", "test/corpora/project-evals/praxis-held-out-v3/repositories/graph-craft/evals/stable-topological-order/case.yaml", "test/corpora/project-evals/praxis-held-out-v3/repositories/graph-craft/evals/stable-topological-order/fixture/src/graph.mjs", "test/corpora/project-evals/praxis-held-out-v3/repositories/route-forge/evals/add-terminal-splat/case.yaml", "test/corpora/project-evals/praxis-held-out-v3/repositories/route-forge/evals/add-terminal-splat/fixture/src/router.mjs", "test/corpora/project-evals/praxis-held-out-v3/repositories/route-forge/evals/decode-parameters/case.yaml", "test/corpora/project-evals/praxis-held-out-v3/repositories/route-forge/evals/decode-parameters/fixture/src/router.mjs", "test/corpora/project-evals/praxis-held-out-v3/repositories/route-forge/evals/fix-static-precedence/case.yaml", "test/corpora/project-evals/praxis-held-out-v3/repositories/route-forge/evals/fix-static-precedence/fixture/src/router.mjs", "test/corpora/project-evals/praxis-held-out-v3/repositories/route-forge/evals/match-request-target/case.yaml", "test/corpora/project-evals/praxis-held-out-v3/repositories/route-forge/evals/match-request-target/fixture/src/index.mjs", "test/corpora/project-evals/praxis-held-out-v3/repositories/route-forge/evals/match-request-target/fixture/src/router.mjs"]
excluded_preexisting_files: [".claude", "docs/CLAUDE_EXPERIMENTAL_CAPABILITIES.md", "docs/research"]
base_revision: "git:1e911cba24f275020e57e1133a6cebb516b557b6"
observed_revision: "git:b31de0a0c2f3a423788ce1d92a7fdf785349e9bf"
architecture_verdict: "NO_MODEL_CHANGE"
architecture_evidence: "Bounded collection reported only the new v3 contract test and the package test-script edit. The generic loader, qualification command, installed bin, runtime boundaries, integrations, persistence, and critical flows are unchanged; the model validated, 10 views rendered unchanged, and the Issue #722 impact verdict/checkpoint were recorded with no affected IDs or inferred claims."
risk: "high"
requirement_ids: ["R1", "R2", "R3", "R4", "R5", "R6"]
repair_of: []
---

# Executive Summary
Praxis now contains a fresh, frozen `praxis-held-out-v3` coding corpus with the independent `frame-codec`, `graph-craft`, and `route-forge` domains. Twelve repository-qualified tasks plan three repetitions each for 36 future runs. Deterministic verifiers, exact mutation paths, forbidden-path policies, and repository-root content digest `sha256:9380f5ccd9b920bf9767381f2d36d91dc04abe645db0a7c1a5f1597279d579ff` are fixed before provider execution. No provider was called and no qualification claim is made.

# Review Contract
Review Issue #722 and the exact 37-file corpus, test wiring, project documentation, and architecture-evidence surface. Confirm the manifest loads as schema 1.0/version 3 with the exact 3/12/36 inventory; every task has a required deterministic verifier, three runs, no model pin or forbidden tuning tag, exact allowed/expected mutations, and non-empty forbidden paths; the pristine fixtures import and each verifier exits exactly 42 for its intentionally unsolved behavior; all digest references agree; and no v2 content, provider execution, qualification decision, or Phase 9 unlock entered the change.

# Before And After
Before this change, result-informed work was blocked on a fresh corpus but only v1/v2 corpus assets existed. Afterward, v3 supplies a separately versioned, independently shaped repository corpus with frozen prompts, fixture APIs, verifier behavior, mutation policy, task inventory, and digest. The existing loader, qualification command, previous corpora, runtime, and provider behavior are unchanged.

# Implementation Path
The primary session fixed the three domains and twelve task contracts, baselined change control, and delegated the complete corpus module to the `gpt-5.6-luna` agent `issue_722_build_held_out_v3`. Primary review rejected short identities and under-covered verifier semantics, then accepted the bounded repair. The same agent synchronized six project documents and performed localized lint and TypeScript repairs. Standards review was clean; Spec review found that the copy task's fixture did not actually possess the exact-length behavior its prompt said to preserve. The worker changed only that fixture comparison and digest pins; final Standards and Spec reviews were both clean. The primary session made one trivial prose de-duplication/link edit and directly recorded the high-risk architecture verdict, retaining acceptance ownership.

# Change Surface
The new v3 root contains one manifest and twelve `case.yaml` plus dependency-free Node ESM fixtures across three repositories. `src/evals/held-out-corpus-v3.test.ts` pins identity, inventory, policy, mutation declarations, tags, digest, and all pristine sentinel exits; `package.json` adds it to the focused held-out contract command. README English/Chinese, CLI reference, coding-agent roadmap, native fixture contract, and Unreleased changelog publish the exact unexecuted corpus boundary. The architecture impact log and bounded source checkpoint record the no-model-change verdict.

# Contracts And Compatibility
Corpus identity is `praxis-held-out-v3` version 3, split `held-out`, with opt-in-only execution, tuning forbidden, and result-informed changes requiring a new version. Repositories and tasks are lexical and globally qualified. Each case uses Project Eval schema 1.1, three runs, allowed tools without a model override, one required verifier, one exact allowed/expected target, and forbidden safety paths. Existing v1/v2 corpora, generic positive-version loading, cross-digest rejection, public CLI/provider behavior, local-first single-user boundaries, and native data-plane contracts remain unchanged.

# Architecture Impact
The verdict is `NO_MODEL_CHANGE`. Incremental collection found only `package.json` and the new `src` test inside the architecture checkpoint scope. The changed package symbol is a test script, while modeled `package.json#bin` evidence remains unchanged; no production loader, qualification, provider, persistence, registration, deployment, or flow evidence changed. `validate_model.py` reported `model valid`, `render_model.py` rendered the existing ten views without diff, and the checkpoint was advanced. Affected node/relation/flow IDs and unresolved inferred claims are both none.

# Verification Evidence
The focused v3 test passed and proves all 12 pristine verifiers exit exactly 42; the combined held-out command passed 3/3 tests. The final post-repair `npm run check` passed 255 test files and 3361 tests after format, lint, docs, release/CI/fixture/boundary, typecheck, native build, and product build gates. `npm run test:package` passed the `praxis-agent-0.69.1.tgz` native package; performance gates passed with 60k/120k projection ratios 1.88/2.02 below 3.25, the injected regression rejected at 21.35x and 1212.9 ms, and quiet-frame p95 limits satisfied. `npm audit --omit=dev` reported zero vulnerabilities. Final Standards and Spec reviews were clean, and architecture validation/render/checkpoint gates passed.

# Risks And Known Gaps
This remains high risk because contamination, task overlap, or weak verifiers could create false qualification evidence. The corpus is checked in rather than secret; held-out means its result cannot tune the same version. It has not been executed against a provider, so it supplies no baseline, candidate, pass-rate, safety-rate, cost, latency, quality, or optimization evidence. Task 8.2 remains incomplete, Phase 9 remains locked, protected CI is pending, and human review intentionally remains pending. Any future result-informed repair requires another corpus version.

# Lineage And Freshness
This capsule descends from `issue-720-held-out-v2-relay-qualification` and advances the current `project`, `project-eval`, `fixture-contracts`, and `architecture-model` heads. It fingerprints only the 37 accepted Issue #722 files. Pre-existing `.claude`, `docs/CLAUDE_EXPERIMENTAL_CAPABILITIES.md`, `docs/research`, ignored `.agent/**` operational packets/memory, build output, package tarballs, and prior result artifacts remain excluded and unattributed.

# Reviewer Checklist
- Confirm the v3 manifest and focused test agree on ID/version, the three repository IDs, all twelve repository-qualified tasks, 36 planned runs, and digest `sha256:9380f5ccd9b920bf9767381f2d36d91dc04abe645db0a7c1a5f1597279d579ff`.
- Confirm every case has a required verifier, exact one-file allowed/expected mutation, non-empty forbidden paths, required tags, no forbidden tuning tag, and no model pin.
- Confirm all pristine verifier exits are 42 for the intended missing behavior, especially that copy-decoded-payload starts with exact-length validation and fails only because its returned bytes alias the frame.
- Confirm no existing corpus, result artifact, runtime/provider/data-plane module, or qualification decision changed and no provider credential was accessed or persisted.
- Confirm README/CLI/roadmap/native-contract wording states v3 is frozen but unexecuted and keeps Task 8.2/Phase 9 locked.
- Confirm final local gates, clean dual-axis review, `NO_MODEL_CHANGE` verdict, protected CI status, and pending human-review status are reported without implying release authority.
