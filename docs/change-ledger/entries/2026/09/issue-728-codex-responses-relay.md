---
schema_version: "2"
change_id: "issue-728-codex-responses-relay"
created_at: "2026-09-07T17:55:40+08:00"
title: "Add an explicit Codex-native relay provider protocol"
change_kind: "feature"
implementation_status: "verified"
review_status: "pending"
project_root: "/Users/wuqisen/dev/Praxis"
parents: ["issue-724-held-out-v3-relay-qualification"]
supersedes: []
scopes: ["project", "architecture-model", "provider-gateway"]
changed_files: ["README.md", "README_zh.md", "docs/CLI_REFERENCE.md", "docs/GETTING_STARTED.md", "docs/adr/0006-native-provider-authentication.md", "docs/adr/0007-openai-chat-responses-portability.md", "docs/architecture/context.md", "docs/architecture/data-flow.md", "docs/architecture/impact-log.md", "docs/architecture/model-state.json", "docs/architecture/model.yaml", "docs/architecture/modules.md", "src/maintenance/doctor.test.ts", "src/providers/codex-responses.test.ts", "src/providers/codex-responses.ts", "src/providers/codex-subscription.test.ts", "src/providers/codex-subscription.ts", "src/providers/openai-responses.test.ts", "src/providers/provider-registry.test.ts", "src/providers/provider-registry.ts", "src/providers/provider-settings.test.ts", "src/providers/provider-settings.ts", "src/providers/responses-codec.ts"]
excluded_preexisting_files: [".claude", "docs/CLAUDE_EXPERIMENTAL_CAPABILITIES.md", "docs/research"]
base_revision: "git:b18fc9ce0273d3baec62853d8a4f10297dad24b7"
observed_revision: "git:b18fc9ce0273d3baec62853d8a4f10297dad24b7+worktree"
architecture_verdict: "MODEL_UPDATE_REQUIRED"
architecture_evidence: "Issue 728 updates the existing provider-gateway and model-provider-apis evidence plus provider-contacts-apis; the canonical model validates and ten views render deterministically with no unresolved inferred claims."
risk: "high"
requirement_ids: ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R9"]
repair_of: []
---

# Executive Summary
Praxis adds an explicitly selected custom `codex-responses` protocol for API-key-authenticated Codex-native relay profiles. It requires `experimental.codexResponses: true`, a user-supplied relay URL and model, and an existing env, command, or vault API-key credential reference. The target reports subscription billing, so token usage remains available while API-dollar cost and USD-dependent logic stay fail-closed. Praxis ships no relay endpoint, default model, protocol inference, or fallback.

# Review Contract
Review the 23 attributed Issue 728 paths against the issue contract. Confirm settings opt-in and credential selection reach the registry, deadline wrapper, adapter, native request dialect, SSE codec, usage/error handling, doctor output, user documentation, and architecture evidence. Confirm public `openai-responses` keeps its public request dialect, direct `openai-codex` keeps its fixed OAuth endpoint and refresh contract, sensitive transport data is redacted, and no held-out-v3 or relay-deployment work entered the change.

# Before And After
Before this change, Praxis supported public OpenAI Responses and a fixed Vault-OAuth ChatGPT Codex route but had no explicit API-key Codex-native custom relay protocol. Afterward, a custom provider can select `codex-responses` only through the experimental gate and receives explicit context capacity, Codex thinking configuration, injected transport, ordinary deadlines, native typed message items, and automatic parallel tool controls. Existing public Responses requests remain free of the Codex-only fields.

# Implementation Path
The `gpt-5.6-luna` implementation agent `issue_728_codex_responses_relay` completed the coherent provider module and two bounded repair rounds with terminal state `done`. The first repair added bounded non-success-body handling, transport/cancellation/deadline integration evidence, subscription doctor coverage, and corrected protocol documentation. The second restored the legacy subscription validation message, proved native encoding through the real OAuth provider, reconciled ADR 0006, and removed the manually authored Changelog item. Primary review restored one accidentally weakened provider-ID assertion as a trivial direct-edit exception. Independent Standards and Spec re-reviews were clean, and the primary session accepted the implementation after reviewing the complete in-scope diff.

# Change Surface
Provider settings introduce the protocol and separate experimental flag; the registry wires API-key credentials, explicit context, thinking, fetch injection, and deadlines. `CodexResponsesProvider` owns endpoint normalization, private headers, status/transport classification, bounded redacted error-body disposal, and shared codec streaming. `ResponsesCodec` owns the private native request option, and the direct subscription adapter selects it. Focused tests cover settings, registry, transport, doctor, OAuth, and public non-regression. English/Chinese guidance, ADRs, and the living architecture model describe the boundary.

# Contracts And Compatibility
`openai-responses` remains the public OpenAI Responses dialect byte-for-byte with no model, URL, 404, or catalog-based protocol switching. `openai-codex` remains fixed to its ChatGPT endpoint and Vault OAuth identity while now selecting the explicit native codec dialect. Custom `codex-responses` accepts API-key credentials only, posts to the normalized `/responses` endpoint with its fixed private headers, reports subscription billing, and never derives context size, endpoint, model, pricing, or fallback. Native transcript and data-plane schemas do not change.

# Architecture Impact
The verdict is `MODEL_UPDATE_REQUIRED`. The existing `provider-gateway` module now includes the new adapter and shared native dialect evidence, the `model-provider-apis` external boundary includes both Codex transports, and `provider-contacts-apis` records their outbound relation. No new module, external system, relation, critical flow, deployment unit, persistence object, or data-plane authority was introduced. The canonical model validated, ten generated views rendered deterministically, the checkpoint was refreshed, and no inferred claim remains unresolved.

# Verification Evidence
The final focused command over six provider and doctor test files passed 110 tests. Targeted Prettier, ESLint, TypeScript, documentation, and diff checks passed. `npm run check` passed 256 test files and 3,380 tests; `npm run test:package` passed the native package verification; `npm run test:performance` passed scaling, regression-detection, and quiet-frame gates; and `npm audit --omit=dev` reported zero vulnerabilities. Change Control verified both required new files and the implementation scope before architecture output. Independent final Standards and Spec reviews returned clean.

# Risks And Known Gaps
The one authorized no-tool/no-file live smoke exited before provider construction because its harness combined `--bare` and `--safe-mode`, excluding the temporary custom provider settings. It produced the exact 56-byte fail-closed unknown-provider error, was not retried, and proves no relay, model, request-body, or adapter live compatibility. The issue contract permits preserving this exact no-retry failure, but live compatibility remains unverified. Held-out-v3 was not run. Protected CI and explicit human review remain pending; neither passing local gates nor this capsule grants release authority.

# Lineage And Freshness
This capsule directly descends from `issue-724-held-out-v3-relay-qualification`, advances the current `project` and `architecture-model` heads, and establishes the `provider-gateway` scope. It fingerprints only the 23 reviewed product, test, documentation, and architecture files. Pre-existing `.claude`, `docs/CLAUDE_EXPERIMENTAL_CAPABILITIES.md`, `docs/research`, ignored `.agent/**` state, local smoke artifacts, package/build output, and the separate user-modified relay repository remain excluded and unattributed.

# Reviewer Checklist
- Confirm `codex-responses` cannot resolve without `experimental.codexResponses: true` and accepts only the configured API-key credential reference, relay URL, model, and explicit context size.
- Confirm the adapter sends the exact native headers and request controls, bounds and disposes non-success bodies, redacts secrets, and preserves cancellation, timeout, retryability, streaming, usage, and terminal semantics.
- Confirm public `openai-responses` has no Codex-only typed-message or tool-control fields and direct OAuth Codex retains its fixed endpoint and refresh behavior.
- Confirm doctor reports subscription billing without parsing API pricing and never exposes the credential or relay query/fragment.
- Confirm the architecture changes affect only `provider-gateway`, `model-provider-apis`, and `provider-contacts-apis`, with ten deterministic rendered views.
- Confirm the live smoke is described only as an admission failure with no retry and no compatibility conclusion, and that held-out-v3 remains outside this issue.
- Confirm all 23 attributed files are in scope and the three protected pre-existing user paths remain excluded, unmodified, and unstaged.
