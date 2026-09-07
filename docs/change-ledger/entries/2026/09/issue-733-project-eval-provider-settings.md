---
schema_version: "2"
change_id: "issue-733-project-eval-provider-settings"
created_at: "2026-09-07T21:35:25+08:00"
title: "Preserve Project Eval provider settings"
change_kind: "bugfix"
implementation_status: "verified"
review_status: "pending"
project_root: "/Users/wuqisen/dev/Praxis"
parents: ["issue-731-release-0700-ledger-freshness"]
supersedes: []
scopes: ["project", "project-eval", "fixture-contracts", "architecture-model", "provider-gateway"]
changed_files: ["CHANGELOG.md", "README.md", "README_zh.md", "docs/CLI_REFERENCE.md", "docs/CODING_AGENT_ROADMAP.md", "docs/NATIVE_FIXTURE_CONTRACTS.md", "docs/architecture/context.md", "docs/architecture/deployment.md", "docs/architecture/impact-log.md", "docs/architecture/model-state.json", "docs/architecture/model.yaml", "docs/architecture/modules.md", "src/cli-runtime.ts", "src/cli.test.ts"]
excluded_preexisting_files: [".claude", "docs/CLAUDE_EXPERIMENTAL_CAPABILITIES.md", "docs/research"]
base_revision: "git:d85508d48d3f0fdcd1d71fb4d931439ac04a934b"
observed_revision: "git:d85508d48d3f0fdcd1d71fb4d931439ac04a934b+worktree"
architecture_verdict: "MODEL_UPDATE_REQUIRED"
architecture_evidence: "Issue 733 adds a confirmed Project Eval dual-root configuration boundary to cli-composition and createDefaultProjectEvalRuntimeFactory evidence to cli-resolves-provider; no critical flow changes, the model validates, and ten views render deterministically."
risk: "high"
requirement_ids: ["R1", "R2", "R3", "R4", "R5", "R6", "R7"]
repair_of: []
---

# Executive Summary
Project Eval now preserves the caller's explicitly selected native provider configuration across identity preflight and runtime creation. Provider definitions, provider/profile/model selection, and credential resolution use one captured caller root, while every case keeps its own root for runtime settings and local data-plane state. This removes the `unknown_provider` admission failure that blocked the Issue #731 baseline without weakening fixture isolation.

# Review Contract
Review the fourteen attributed Issue #733 paths against the issue and Change Brief. Confirm that `createDefaultDependencies` resolves the Project Eval root once, the constructed project factory uses that root for both `identify` and `create`, `createDefaultService` confines the private override to provider selection/registry/vault behavior, and the case root continues to own runtime settings and state. Confirm Plugin Eval and the public eval factory contracts remain compatible, documentation preserves the Issue #731 outcome, and architecture evidence matches the implementation.

# Before And After
Before this change, the default Project Eval dependency exposed the caller native configuration root but its static factory resolved both identity and provider construction from the isolated case root. A custom provider defined only in the caller root therefore failed closed as unknown before the first run. Afterward, the factory captures the exposed caller root for provider-only resolution and delegates all other runtime behavior to the unchanged isolated case root; absence of the caller definition still fails closed.

# Implementation Path
The primary session established the high-risk dual-root contract and added one deterministic red regression. The `gpt-5.6-luna` implementation sub-agent `issue_733_project_eval_provider_settings` completed the bounded two-file module with terminal state `done`, then handled one precise repair for environment cleanup ownership and a credential-shaped test literal. A separate documentation sub-agent synchronized the six user-facing documents. Primary review, independent standards/specification review, and an evidence-backed architecture update accepted the coherent result.

# Change Surface
`src/cli-runtime.ts` adds a private optional provider configuration root to the default service implementation, centralizes default eval runtime creation, constructs Project Eval with one captured caller root, and leaves Plugin Eval on its existing single-root path. `src/cli.test.ts` proves identity, runtime creation, empty-caller failure, case settings isolation, no network access, and environment restoration. Six documents describe the fixed boundary and preserve roadmap locks. Six architecture artifacts record and render the changed configuration relation.

# Contracts And Compatibility
The exported `IdentifiedEvalRuntimeFactory`, `EvalRuntimeFactoryOptions`, `ProjectEvalDependencies`, and public CLI service contract do not change. Provider selection precedence, built-in providers, model selection, endpoint normalization, errors, and provider environment behavior remain intact. The caller root is authoritative only for provider definitions, selection, and credentials; the case root still owns runtime settings, state, transcripts, hooks, plugins, MCP, memory, artifacts, tools, verifiers, and workspace trust state. Plugin Eval retains its previous behavior.

# Architecture Impact
The verdict is `MODEL_UPDATE_REQUIRED`. `cli-composition` now records the Project Eval dual-root isolation boundary, and `cli-resolves-provider` adds confirmed `createDefaultProjectEvalRuntimeFactory` evidence alongside `createDefaultService`. No new node, relation, data store, deployment unit, or critical flow is required. The canonical model validates, all ten renderer-owned views are deterministic, the established bounded checkpoint was advanced after validation, and no inferred claim remains unresolved.

# Verification Evidence
The focused regression failed twice before the fix with `unknown_provider` and no provider request, then the adjacent identity/create batch passed both tests. The wider CLI/Eval/provider compatibility batch passed 204 tests. Prettier, TypeScript, and documentation checks passed; `npm run check` passed 256 files and 3,381 tests; native 0.70.0 package verification, performance gates, and `npm audit --omit=dev` all passed. Architecture validation, two byte-identical ten-view renders, bounded checkpointing, and independent final standards/specification reviews also passed.

# Risks And Known Gaps
Risk is high because provider configuration and credential lookup cross an eval isolation boundary. The implementation deliberately avoids copying caller settings or exposing caller hooks, plugins, MCP, state, or transcripts to a case. Issue #731 remains an immutable 0/36 failure with no retry, candidate, comparison, or qualification result; Task 8.2 remains incomplete and Phase 9 remains locked. Protected PR CI and explicit human review remain pending, and neither local acceptance nor this capsule authorizes a provider campaign, merge, release, or deployment.

# Lineage And Freshness
This capsule directly descends from `issue-731-release-0700-ledger-freshness`, which already converges the accepted Issue #728/#731 and 0.70.0 lineage. It advances project, project-eval, fixture-contracts, architecture-model, and provider-gateway using only the fourteen reviewed files. Pre-existing `.claude`, `docs/CLAUDE_EXPERIMENTAL_CAPABILITIES.md`, `docs/research`, ignored `.agent/**` state, build output, and `/tmp/praxis-731-runtime.PBnffI/repo` remain excluded and unattributed.

# Reviewer Checklist
- Confirm both Project Eval identity and runtime construction use the exact caller provider root captured by `createDefaultDependencies`.
- Confirm the private provider override reaches only workspace provider-selection assessment, provider registry resolution, and the credential vault while the case root retains every runtime/data-plane responsibility.
- Confirm Plugin Eval, built-in provider selection, public eval factory types, error behavior, and case workspace trust remain compatible.
- Confirm the regression proves custom-provider admission, runtime creation without a network call, missing-definition failure, no settings copy into the case root, and complete environment restoration.
- Confirm the six user-facing documents preserve Issue #731's 0/36 no-retry result and keep Task 8.2 and Phase 9 locked.
- Confirm the architecture verdict affects only `cli-composition` and `cli-resolves-provider`, with no changed critical flow or inferred claim.
- Confirm only the fourteen attributed files belong to Issue #733 and all protected pre-existing user paths remain excluded, unmodified, and unstaged.
