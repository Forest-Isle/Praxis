---
schema_version: "2"
change_id: "issue-745-codex-error-diagnostics"
created_at: "2026-09-08T05:59:13+08:00"
title: "Preserve bounded Codex Responses error diagnostics"
change_kind: "bugfix"
implementation_status: "verified"
review_status: "pending"
project_root: "/Users/wuqisen/dev/Praxis"
parents: ["issue-742-held-out-v4-qualification"]
supersedes: []
scopes: ["project", "provider-gateway", "architecture-model"]
changed_files: ["docs/CLI_REFERENCE.md", "docs/architecture/impact-log.md", "docs/architecture/model-state.json", "src/providers/codex-responses.test.ts", "src/providers/codex-responses.ts"]
excluded_preexisting_files: [".claude", "docs/CLAUDE_EXPERIMENTAL_CAPABILITIES.md", "docs/research"]
base_revision: "git:4ca91ef069f6f1729f2ddff4f403a304ee851214"
observed_revision: "git:72d08d24506872cea6be661ce145bb894fd55c80"
architecture_verdict: "NO_MODEL_CHANGE"
architecture_evidence: "The Issue #745 impact entry maps the two bounded-source changes to existing provider-gateway evidence, confirms no port, integration, registration, relation, or flow change, validates the canonical model, verifies ten deterministic views, and advances the source checkpoint to zero drift."
risk: "high"
requirement_ids: ["R1", "R2", "R3", "R4", "R5", "R6"]
repair_of: []
---

# Executive Summary
Praxis now preserves only bounded, syntactically safe error and correlation identifiers from non-success custom Codex Responses replies. Safe `type`, `code`, `request_id`, and `cf_ray` values appear in deterministic order, while raw response text, provider messages, arbitrary headers, unsafe values, and stream failure details remain redacted. Existing status classification, retryability, request shape, provider selection, and persistence contracts are unchanged.

# Review Contract
Review Issue #745 and the five attributed implementation, test, documentation, and architecture-evidence paths. Confirm that body collection is byte-bounded and complete-only, unfinished bodies are cancelled, reader cleanup cannot mask the original HTTP failure, only the four fixed identifiers pass the exact ASCII token/length rule, duplicates are omitted by value, output order is stable, and all request/classification/retry/transcript contracts remain compatible. Confirm no relay, provider completion, v4 campaign, route inference, or historical 404 attribution entered the change.

# Before And After
Before this change, the custom Codex Responses adapter drained or cancelled a bounded non-success body and then discarded every diagnostic, leaving only an HTTP status. Afterward, a complete bounded JSON object and two fixed response headers can contribute safe identifiers to the same `ModelProviderError` message. Missing, partial, malformed, oversized, non-string, duplicate, or unsafe values are omitted; when nothing survives, the prior status-only message remains exact.

# Implementation Path
The primary session fixed the high-risk allowlist, byte cap, ordering, fallback, and compatibility contract, then dispatched `/root/issue_745_codex_error_diagnostics` to the required `gpt-5.6-luna` implementation model. Its initial run and one bounded repair both reached terminal state `done`; the repair completed the exact 404 and leak/error-path fixtures and protected reader cleanup. The primary added one omitted 404 classification assertion and removed one review-identified single-hop helper as trivial direct-edit exceptions. Independent final Standards and Spec reviewers each returned no findings before acceptance.

# Change Surface
`src/providers/codex-responses.ts` adds the bounded complete-body reader, strict diagnostic extraction, deterministic deduplication/formatting, and status-error message integration. `src/providers/codex-responses.test.ts` adds exact positive, top-level, ordering, deduplication, partial, unsafe, oversized, read-failure, cancellation-failure, and redaction coverage. `docs/CLI_REFERENCE.md` documents the safe diagnostic boundary and #742 non-attribution. The architecture impact log records `NO_MODEL_CHANGE`, and the model-state checkpoint records the reviewed source fingerprints.

# Contracts And Compatibility
The existing `ModelProviderError` type and HTTP status-to-kind/retryability mapping remain unchanged. Request URL, method, headers, serialized Responses dialect, streaming codec, provider registry, fallback logic, CLI JSON, transcript schema, billing behavior, and native data plane are untouched. Nested `error` owns body identifiers; top-level identifiers apply only when a nested error object is absent. Each emitted value is a 1-128 character ASCII token matching the fixed allowlist, and duplicate values are omitted in `type`, `code`, `request_id`, `cf_ray` order.

# Architecture Impact
The verdict is `NO_MODEL_CHANGE`. Incremental collection reported only the provider source and focused test as modified bounded-source paths. Existing `provider-gateway`, `model-provider-apis`, and `provider-contacts-apis` evidence already represents adapter-normalized provider errors; no modeled fact or relation changed. The canonical model validated, three temporary renders produced the same ten canonical views, the checkpoint advanced only afterward, and post-checkpoint collection reported zero additions, modifications, or deletions. No inferred claim remains unresolved.

# Verification Evidence
Focused provider verification passed 44 tests across the Codex Responses and provider-registry suites, including exact leak/error boundaries, and TypeScript typechecking passed. Final `npm run check` passed formatting, lint, documentation, release/coverage/fixture contracts, boundaries, native/build output, 257 test files, and 3,391 tests. Native package verification passed for `praxis-agent-0.70.1.tgz`. Performance verification kept projection ratios and medians within their fixed limits, rejected the injected regression, and passed every quiet-frame p95 threshold. `npm audit --omit=dev` reported zero vulnerabilities. Final Standards and Spec review each reported zero findings; architecture validation/rendering and both Change Control scopes passed.

# Risks And Known Gaps
Risk is high because untrusted provider response data can reach a user-visible error surface. Mitigations are the fixed field allowlist, strict ASCII token/length validation, complete-body byte bound, deterministic formatting, duplicate omission, exact status-only fallback, and focused redaction/failure tests. No live provider request was made, so this change supplies no evidence about current relay/model availability and does not explain or retry Issue #742. Protected PR CI and explicit human review remain pending; this capsule grants no release, deployment, provider, v4, or merge authority.

# Lineage And Freshness
This capsule directly descends from `issue-742-held-out-v4-qualification` and advances the project, provider-gateway, and architecture-model scopes with a verified diagnostic repair rather than a new campaign result. It fingerprints only the five accepted Issue #745 implementation and architecture paths at `72d08d24506872cea6be661ce145bb894fd55c80`. Pre-existing `.claude`, `docs/CLAUDE_EXPERIMENTAL_CAPABILITIES.md`, `docs/research`, ignored `.agent` operations, credentials, build/package output, relay files, and evaluation artifacts remain excluded and unattributed. Human review remains pending.

# Reviewer Checklist
- Confirm the exact 404 fixture retains `model_not_found`, both safe correlation identifiers, HTTP 404, `invalid_request`, and non-retryable classification without exposing the provider message.
- Confirm only `type`, `code`, `request_id`, and `cf_ray` can survive the 1-128 ASCII token rule, deterministic ordering, and duplicate-by-value filter.
- Confirm partial, oversized, invalid, failed-read, and failed-cancel bodies cannot replace or leak through the status-classified error, while safe headers can still survive body failure.
- Confirm outbound request shape, Responses codec, registry, fallback, CLI JSON, transcript, billing, and native data-plane contracts did not change.
- Confirm the documentation describes only the bounded custom-provider diagnostic behavior and does not attribute or authorize a retry of Issue #742.
- Confirm all local high-risk gates and final dual-axis review passed, while protected CI and human review correctly remain pending.
- Confirm the architecture verdict is `NO_MODEL_CHANGE`, canonical model/views are unchanged, and the source checkpoint has zero post-update drift.
- Confirm protected local paths, `.agent/**`, credentials, relay state, generated output, and v4 artifacts remain excluded.
