---
schema_version: "2"
change_id: "issue-763-qualification-contract-recovery"
created_at: "2026-09-14T17:22:46+08:00"
title: "Repair qualification footprint and phase gates"
change_kind: "contract"
implementation_status: "verified"
review_status: "pending"
project_root: "/Users/wuqisen/dev/Praxis"
parents: ["dependabot-audit-recovery"]
supersedes: []
scopes: ["project", "qualification-contract", "architecture-model"]
changed_files: ["README.md", "README_zh.md", "docs/CODING_AGENT_ROADMAP.md", "docs/NATIVE_FIXTURE_CONTRACTS.md", "docs/architecture/impact-log.md", "docs/architecture/model-state.json", "src/cli-process.test.ts", "test/fixtures/manifest.json"]
excluded_preexisting_files: [".claude", "docs/CLAUDE_EXPERIMENTAL_CAPABILITIES.md", "docs/research"]
base_revision: "git:abd2f356b7d6ee743c7fad8cec0c0ce10bd56088"
observed_revision: "worktree:test/763-qualification-contract-recovery@abd2f356b7d6ee743c7fad8cec0c0ce10bd56088"
architecture_verdict: "NO_MODEL_CHANGE"
architecture_evidence: "The Issue #763 impact entry records one test-only bounded-source change, no affected architecture IDs, a valid unchanged model, deterministic canonical views, and a post-validation source checkpoint with zero remaining drift."
risk: "medium"
requirement_ids: ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8"]
repair_of: []
---

# Executive Summary
Praxis now has executable full-process evidence for the exact native filesystem footprint created by a successful `--no-session-persistence` CLI run. A hermetic child process uses one local custom Codex Responses request and proves the bounded settings, Project-memory, cost/accounting sidecars, permissions, JSON shapes, empty directories, credential absence, and absence of session Transcript/task/history artifacts. Documentation retains Issue #756 as an immutable harness-contract failure, keeps v4 at 0/36, and separates baseline readiness for Phase 9 measurement from later candidate adoption and release claims.

# Review Contract
Review Issue #763 and exactly the eight attributed test, manifest, documentation, and architecture-evidence files. Confirm the child uses isolated native, cwd, home, provider, model, and test-credential state; sends exactly one structurally valid local Codex-native Responses request; exits successfully; and leaves only the complete expected native footprint with exact types, modes, hashes/content invariants, JSON ownership, empty directories, and forbidden artifact absence. Confirm the roadmap permits Phase 9 measurement only after a complete valid baseline and still requires a genuinely changed strictly qualified candidate for adoption or release claims. Confirm no production runtime, provider, persistence, CLI option, verdict, corpus, relay, or external-request behavior changed.

# Before And After
Before this change, tests covered CLI flag passthrough, direct nonpersistent SessionService behavior, and default provider wiring separately, but no real process asserted their combined native footprint. Issue #756's one authorized P1 request succeeded through the provider and then failed a frozen validator that incorrectly required only `settings.json`; it produced no valid v4 qualification evidence. Afterward, one hermetic process fixture proves the current bounded footprint, registers it as native executable evidence, records #756 without reinterpretation, and defines a baseline-only next campaign authorization boundary. No campaign is executed and Phase 9 remains locked.

# Implementation Path
The primary session fixed the fixture, documentation, compatibility, and campaign boundaries, and dispatched the bounded implementation packet `issue-763-qualification-contract-recovery` to the required `gpt-5.6-luna` worker; implementation and repair runs reached terminal completion before primary review. Two primary-review evidence corrections tightened canonical cwd/home and documentation totals without changing production code. After the independent dependency repair merged in PR #764, the seven-file WIP was recoverably rebased onto the clean audit baseline and revalidated. Final dual-axis review identified partial request-shape proof; `/root/issue_763_request_shape_repair` reached terminal `done` and added only exact existing Codex-native header/body assertions. Fresh Standards and Spec reviews then passed.

# Change Surface
`src/cli-process.test.ts` adds the hermetic child-process fixture and its filesystem/request assertions. `test/fixtures/manifest.json` registers one high-risk qualified native behavior using the existing schema. The English and Chinese READMEs update concise status/totals; the detailed roadmap and native fixture contract define #756 evidence, Phase 9 gates, and next-campaign authorization. The architecture impact log records `NO_MODEL_CHANGE`, and `model-state.json` advances only the accepted test-file fingerprint. No production source, package, configuration, fixture corpus, CI, provider, persistence, or qualification-verdict implementation changes.

# Contracts And Compatibility
The existing `--no-session-persistence` semantics are unchanged: session Transcript persistence is disabled while enabled Project memory and private cost/accounting sidecars retain their current behavior. The test runs with an isolated `PRAXIS_HOME`, HOME, cwd, custom `codex-responses` settings/model, one local test credential, and a loopback SSE server; it captures one `POST /v1/responses` with the native experimental headers and structured request fields. Authoritative transcripts remain append-only JSONL when enabled, and no Claude-shaped data plane or external credential/provider dependency is introduced.

# Architecture Impact
The verdict is `NO_MODEL_CHANGE`. Bounded collection observed only `src/cli-process.test.ts`; the test proves existing `createDefaultService`, `ClaudeSessionService`, Project-memory path, cost state, and unknown-cost sidecar wiring without changing them. There is no boundary, public contract, data shape, integration, registration, runtime/deployment unit, relation, or critical-flow change, and affected IDs are none. The canonical model validated, temporary renders produced ten views matching canonical output, the checkpoint advanced only the test fingerprint while retaining the canonical project root, and final collection reports zero drift.

# Verification Evidence
Fresh post-#764 `npm ci` passed. The exact focused command executed one test with three skipped and passed. Prettier, ESLint, TypeScript, documentation, fixture-contract, and diff checks passed. Final `npm run check` exited zero with 257 test files and 3,394 tests. Native package verification passed for `praxis-agent-0.70.2`; performance passed projection scaling and quiet-frame budgets while correctly rejecting an injected regression; production audit reports zero vulnerabilities. Final Standards and Spec reviews passed after the request-shape repair. Change Control retains two rejected command attempts rather than misreporting empty/missing-script executions as evidence.

# Risks And Known Gaps
Risk is medium because the change strengthens qualification evidence and roadmap gates but changes no production behavior. The fixture intentionally proves the exact current footprint; a future intentional data-plane change must update this contract explicitly. Issue #756 remains immutable and cannot qualify v4. The next campaign, any live provider request, Phase 9 execution, a changed-build candidate, adoption, release, and deployment all remain separately authorized. Human Review Ledger status and protected PR CI are pending.

# Lineage And Freshness
This capsule directly descends from `dependabot-audit-recovery`, so the Issue #763 project and architecture evidence begins from the merged zero-vulnerability baseline, and it introduces a focused qualification-contract scope without manufacturing lineage across older parallel scopes. It fingerprints only the accepted eight-file Issue #763 diff. Pre-existing `.claude`, `docs/CLAUDE_EXPERIMENTAL_CAPABILITIES.md`, `docs/research`, ignored `.agent/**` state, user stashes, credentials, Issue #756 artifacts, build/package output, evaluation output, and relay state remain excluded and unattributed. Human review remains pending.

# Reviewer Checklist
- Confirm the focused process uses only isolated test roots and one local custom Codex Responses provider/model/credential path, with no host override or external request.
- Confirm the captured method, route, headers, core JSON fields, user input, request count, output, and credential non-occurrence structurally prove the selected adapter path.
- Confirm the native descriptor allowlist, file modes/hashes/content, state and sidecar JSON keys/values, empty memory/lock directories, settings/cwd/home invariants, and forbidden Transcript/task/history/lock/symlink/credential assertions.
- Confirm the manifest's one new high-risk behavior and README/native-contract totals match structural verification.
- Confirm #756 remains immutable at one consumed P1 request, v4 remains 0/36, the next campaign is baseline-only and separately authorized, and Phase 9 is currently locked.
- Confirm baseline completion gates measurement only, while adoption or release claims still require a genuinely changed candidate with strict `qualified: true`.
- Confirm the exact eight-file attribution, `NO_MODEL_CHANGE` evidence, zero-drift checkpoint, package/performance/audit/full-check results, and absence of production/compatibility changes.
- Confirm human review and protected PR CI remain pending and this capsule grants no provider-request, campaign, release, deployment, or migration authority.
