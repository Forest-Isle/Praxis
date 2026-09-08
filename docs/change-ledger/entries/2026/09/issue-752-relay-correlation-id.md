---
schema_version: "2"
change_id: "issue-752-relay-correlation-id"
created_at: "2026-09-08T15:17:26+08:00"
title: "Preserve Codex relay correlation diagnostics"
change_kind: "bugfix"
implementation_status: "verified"
review_status: "pending"
project_root: "/Users/wuqisen/dev/Praxis"
parents: ["issue-748-ledger-freshness"]
supersedes: []
scopes: ["project", "provider-gateway", "architecture-model"]
changed_files: ["docs/CLI_REFERENCE.md", "docs/architecture/impact-log.md", "docs/architecture/model-state.json", "src/providers/codex-responses.test.ts", "src/providers/codex-responses.ts"]
excluded_preexisting_files: [".claude", "docs/CLAUDE_EXPERIMENTAL_CAPABILITIES.md", "docs/research"]
base_revision: "git:3fe5cd35ba0222ec1d899e831c96b47fa22212e1"
observed_revision: "git:0df185b210df3682452cab7dbfc81e6ca2213446"
architecture_verdict: "NO_MODEL_CHANGE"
architecture_evidence: "Issue #752's impact entry maps the two bounded-source changes to the existing provider gateway, validates the canonical model, proves two deterministic ten-view renders match canonical output, advances the source checkpoint, and observes zero post-checkpoint drift."
risk: "high"
requirement_ids: ["R1", "R2", "R3", "R4", "R5"]
repair_of: []
---

# Executive Summary
Praxis now preserves a relay-supplied `X-Relay-Request-ID` as the bounded `relay_request_id` field in non-success custom Codex Responses errors. This closes the correlation-evidence gap found by Issue #751's provider-free admission check while retaining the existing allowlist, redaction, deterministic ordering, duplicate suppression, HTTP classification, and retry behavior. No provider completion request occurred.

# Review Contract
Review Issue #752 and the five attributed implementation, test, CLI-documentation, and architecture-evidence paths. Confirm that only a 1-128 character safe ASCII relay identifier can enter the existing error message, that ordering is `type`, `code`, `relay_request_id`, `request_id`, `cf_ray`, and that duplicate values keep the earliest field. Confirm empty, unsafe, oversized, arbitrary-header, provider-message, partial-body, and read/cancel-failure data cannot escape. Confirm request, codec, registration, retry/fallback, transcript, CLI JSON, billing, deployment, and held-out evaluation behavior remain unchanged.

# Before And After
Before this change, the deployed relay could return a non-spoofable `X-Relay-Request-ID`, but Praxis's custom Codex Responses adapter admitted only the upstream `X-Request-ID` and `CF-Ray`; an ordinary relay 4xx could therefore lose the one token needed for a bounded relay-event lookup. Afterward, a safe relay token survives under its distinct field, including when a 4xx body is partial or a response-body read fails. When the header is absent or invalid, the prior diagnostic output remains exact.

# Implementation Path
The primary session failed Issue #751 closed before its authorized request, fixed the one-line adapter contract, and dispatched `/root/issue_752_relay_correlation_id` to the required `gpt-5.6-luna` implementation model. The implementation agent reached terminal `done`, then completed two precise fixture repairs: one removed an accidental collision with the earlier `type` value, and one covered explicit empty/unsafe headers plus partial-JSON 4xx behavior after Spec review. The primary made one narrowly documented direct-edit exception to rename a stale test title after that repeated test-slice oversight. Final independent Standards and Spec reviews returned no findings.

# Change Surface
`src/providers/codex-responses.ts` adds one ordered allowlist candidate sourced from `X-Relay-Request-ID`. `src/providers/codex-responses.test.ts` proves safe ordering, relay/upstream duplicate precedence, empty/unsafe/oversized omission, partial-JSON 4xx retention, failed-read retention, redaction, and existing provider behavior. `docs/CLI_REFERENCE.md` documents the additional bounded field and explicitly avoids availability or causality claims. The architecture impact log records `NO_MODEL_CHANGE`, and model state advances the inspected source fingerprints.

# Contracts And Compatibility
The same `safeValue` predicate requires a nonempty 1-128 character ASCII token beginning alphanumeric and containing only alphanumeric, `.`, `_`, or `-`. The same raw-value `seen` set deduplicates across all admitted identifiers; a relay token precedes and therefore wins over an identical upstream request ID. `ModelProviderError`, status-to-kind and retryable mapping, response-body byte bound, exact status-only fallback, outbound URL/method/headers/body, shared Responses codec, provider registry, fallback routing, transcripts, billing, and native data plane are unchanged.

# Architecture Impact
The verdict is `NO_MODEL_CHANGE`. Incremental collection reported only the custom adapter and its focused test as modified bounded-source paths. Existing `provider-gateway`, `model-provider-apis`, and `provider-contacts-apis` evidence already models adapter-normalized provider errors; no boundary, port, integration, registration, data shape, runtime unit, relation, or critical flow changed. The canonical model validated, two temporary renders produced ten byte-identical views matching canonical output, the checkpoint advanced only afterward, and post-checkpoint collection reported zero drift.

# Verification Evidence
Focused Codex Responses and provider-registry verification passed 46 tests after the two localized fixture repairs. Prettier, ESLint, and TypeScript checks passed. Final `npm run check` passed formatting, lint, documentation, release/coverage/fixture contracts, boundaries, native/build output, 257 test files, and 3,393 tests. Native package verification passed for `praxis-agent-0.70.2.tgz`; performance verification passed projection and quiet-frame thresholds while rejecting the injected regression; `npm audit --omit=dev` reported zero vulnerabilities. Final independent Standards and Spec reviews returned no findings, and architecture validation/render/checkpoint gates passed.

# Risks And Known Gaps
Risk is high because untrusted provider headers can reach a user-visible error surface. The fixed name allowlist, strict ASCII token/length predicate, deterministic order, duplicate filter, existing body bound, and focused redaction/error-path tests mitigate that exposure. No live completion tested the deployed correlation path, so this change does not prove relay or model availability, attribute any historical 404, or authorize a held-out-v4 campaign. Issue #751 remains at 0/1 completion requests and requires a newly pinned Praxis revision plus fresh explicit authorization after merge. Protected PR CI and human review remain pending.

# Lineage And Freshness
This capsule directly descends from `issue-748-ledger-freshness`, inheriting its current project/provider/architecture lineage and overlaying only the five accepted Issue #752 implementation and architecture paths at `0df185b210df3682452cab7dbfc81e6ca2213446`. Pre-existing `.claude`, `docs/CLAUDE_EXPERIMENTAL_CAPABILITIES.md`, `docs/research`, ignored `.agent/**` operations, credentials, build/package output, Relay files, evaluation artifacts, and detached runtimes remain excluded and unattributed. Human review remains pending.

# Reviewer Checklist
- Confirm `parseErrorDiagnostics` adds only `relay_request_id` from the case-insensitive relay header and reuses the existing validator and raw-value deduplicator.
- Confirm exact ordering and that identical relay/upstream values appear once under the earlier relay field without disturbing earlier `type` or `code` values.
- Confirm empty, unsafe, oversized, partial-JSON, failed-read, arbitrary-header, message/body, and secret cases remain bounded and redacted.
- Confirm existing no-relay-header diagnostics, status classification, retry/fallback, request shape, streaming, registry, transcript, billing, and native-data behavior are compatible.
- Confirm CLI documentation limits the claim to optional bounded correlation and makes no relay-availability, response-causality, or historical-404 attribution.
- Confirm Issue #751's request count remains 0/1 and this capsule grants no provider, v4, merge, release, or deployment authority.
- Confirm the `NO_MODEL_CHANGE` evidence and final local high-risk gates are complete while human review and protected CI remain pending.
- Confirm only the five reviewed paths are attributed and all protected local, operational, credential, build, Relay, and evaluation data stays excluded.
