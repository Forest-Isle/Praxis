---
schema_version: "2"
change_id: "issue-731-held-out-v3-codex-relay"
created_at: "2026-09-07T19:24:37+08:00"
title: "Record the Codex-native held-out v3 admission boundary"
change_kind: "contract"
implementation_status: "verified"
review_status: "pending"
project_root: "/Users/wuqisen/dev/Praxis"
parents: ["issue-728-codex-responses-relay"]
supersedes: []
scopes: ["project", "project-eval", "fixture-contracts", "architecture-model"]
changed_files: ["README.md", "README_zh.md", "docs/CLI_REFERENCE.md", "docs/CODING_AGENT_ROADMAP.md", "docs/NATIVE_FIXTURE_CONTRACTS.md", "docs/architecture/impact-log.md"]
excluded_preexisting_files: [".claude", "docs/CLAUDE_EXPERIMENTAL_CAPABILITIES.md", "docs/research"]
base_revision: "git:1a7575d05d2de0b2da23a9dbcce48b150e9e53d5"
observed_revision: "git:60a735e77b785bfa60492347b28dfe9ff528ff0d"
architecture_verdict: "NO_MODEL_CHANGE"
architecture_evidence: "Bounded architecture collection reported no source or modeled-contract changes; the canonical model validated, ten views rendered without diff, and the Issue 731 impact entry records no affected node, relation, or flow IDs."
risk: "high"
requirement_ids: ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8"]
repair_of: []
---

# Executive Summary
Praxis preserves Issue #731's bounded Codex-native relay evidence. The single corrected no-tool/no-file smoke reached `codex-relay/default/codex-responses/gpt-5.6-sol` successfully, but the exactly-once held-out-v3 baseline then failed during the first case's provider identity preflight because the isolated Project Eval config root did not contain the campaign custom-provider definition. Baseline completed 0/36 runs, no candidate or regression comparison exists, no v3 qualification result exists, and Task 8.2/Phase 9 remain locked.

# Review Contract
Review Issue #731 and the six accepted documentation/architecture files. Confirm the public evidence separates the successful provider smoke from absent v3 corpus evidence, fixes the runtime/corpus/provider/profile/protocol/model identities, reports the exact first-case unknown-provider admission failure, states 0/36 baseline and no candidate/regression comparison/qualification, preserves no-retry/no-substitution behavior, and makes no quality, broad safety, cost, latency, compatibility, efficiency, or optimization claim.

# Before And After
Before this change, the repository documented the frozen v3 corpus but no Codex-native campaign attempt. Afterward, the public owner documents record that the corrected smoke completed in one turn without tool or file activity and that the single baseline attempt stopped before any corpus completion request. They also state that the missing candidate makes regression comparison unavailable and that a separate settings-forwarding change is required before a separately authorized future campaign.

# Implementation Path
The primary session fixed the high-risk execution contract, built and tested the pinned clean runtime, validated relay identity, and owned the exactly-once external-request harness. The only smoke succeeded; the only baseline failed closed after 810 ms and candidate admission was withheld. Offline source tracing localized the gap to the per-case empty `workspace.config` passed into the production Project Eval runtime factory. The `gpt-5.6-luna` implementation agent `issue_731_document_fail_closed` updated the five public owner documents with terminal state `done`. Primary review accepted a focused R6 repair from the same agent to state that no regression comparison exists. Final independent Standards and Spec reviews were clean.

# Change Surface
Both READMEs, the CLI reference, coding-agent roadmap, and native fixture contract now record the smoke, baseline admission failure, evidence cardinalities, no-retry boundary, unavailable regression/qualification conclusions, and locked roadmap. `docs/architecture/impact-log.md` records `NO_MODEL_CHANGE`. No source, provider adapter, config, corpus, task, fixture, verifier, transcript, data-plane, relay, credential, or local campaign artifact entered the diff.

# Contracts And Compatibility
The corpus remains `praxis-held-out-v3@sha256:9380f5ccd9b920bf9767381f2d36d91dc04abe645db0a7c1a5f1597279d579ff` and runtime remains `1a7575d05d2de0b2da23a9dbcce48b150e9e53d5`. The selected identity was `codex-relay/default/codex-responses/gpt-5.6-sol` with 32,768 context, 4,096 reserve, no fallback, 30/60/180-second provider clocks, and corpus tools `Edit,Write,Bash`. The smoke was one no-tool/no-file turn. The baseline identity preflight could not resolve the custom provider from the per-case isolated config root, so no corpus model request occurred. Existing CLI, provider, corpus, qualification, persistence, and safety contracts are unchanged.

# Architecture Impact
The verdict is `NO_MODEL_CHANGE`. Incremental collection found no changes under the checkpointed evidence scope: `CONTEXT.md`, `docs/ARCHITECTURE.md`, `docs/adr`, `package.json`, `scripts`, and `src`. The canonical model validated and ten generated views rendered deterministically without diff before the unchanged bounded checkpoint was refreshed. Affected node, relation, and flow IDs are none; unresolved inferred claims are none.

# Verification Evidence
The clean pinned runtime build and five-file provider-free batch passed 57 tests. The one-shot smoke exited 0 with one turn, 357 input tokens, 7 output tokens, zero stderr, zero configured tools, and no cwd mutation. Baseline evidence records exit 1 after 810 ms, 85 stdout bytes with digest `sha256:4f231cad805f094d53f7fb6728d1fe3b329a821f6e0f1bab1f3698d0bd6fef51`, zero stderr, zero artifacts, no qualification result, and no credential occurrence. `npm run check` passed 256 test files and 3,380 tests; package, projection/performance, quiet-frame, and audit gates passed, with zero audit vulnerabilities. Documentation, formatting, diff, scope, architecture, and final dual-axis review gates passed.

# Risks And Known Gaps
The successful smoke proves only that one bounded provider turn reached the pinned model; it is not corpus quality, safety, verifier, latency, cost, compatibility, or optimization evidence. Subscription API cost is unavailable. The baseline failure exposes a custom-provider settings-forwarding gap in Project Eval, but this change intentionally does not repair or retry it. A future campaign requires a separate accepted implementation change and separate authorization. Protected CI and explicit human review remain pending.

# Lineage And Freshness
This capsule descends from `issue-728-codex-responses-relay` and advances the `project`, `project-eval`, `fixture-contracts`, and `architecture-model` heads. It fingerprints only the six accepted Issue #731 paths. Pre-existing `.claude`, `docs/CLAUDE_EXPERIMENTAL_CAPABILITIES.md`, `docs/research`, ignored `.agent/**` operational state/evidence, build/package output, the detached runtime, and the separate user-modified relay repository remain excluded and unattributed.

# Reviewer Checklist
- Confirm the runtime and v3 corpus identities match Issue #731 and no corpus, task, fixture, verifier, provider, or config file changed.
- Confirm the smoke is described as one successful no-tool/no-file provider turn, not as a v3 corpus or compatibility qualification.
- Confirm the baseline stopped at first-case provider identity preflight with 0/36 runs, no artifacts/result, no candidate, and no regression comparison.
- Confirm no retry, provider/profile/protocol/model/endpoint substitution, or result selection occurred.
- Confirm Task 8.2 and Phase 9 remain locked and all unavailable quality, safety, verifier, usage/cost, latency, compatibility, efficiency, optimization, and qualification conclusions are bounded correctly.
- Confirm all local high-risk gates and the `NO_MODEL_CHANGE` verdict are recorded while protected CI and human review remain explicitly pending.
