---
schema_version: "2"
change_id: "issue-692-architecture-model"
created_at: "2026-09-06T15:28:01Z"
title: "Bootstrap evidence-backed architecture model"
change_kind: "architecture"
implementation_status: "verified"
review_status: "pending"
project_root: "/Users/wuqisen/dev/Praxis"
parents: []
supersedes: []
scopes: ["architecture-model"]
changed_files: [".prettierignore", "docs/README.md", "docs/architecture/context.md", "docs/architecture/data-flow.md", "docs/architecture/deployment.md", "docs/architecture/flows/agent-turn.md", "docs/architecture/flows/installed-package-startup.md", "docs/architecture/flows/native-persistence-flow.md", "docs/architecture/flows/provider-fallback.md", "docs/architecture/flows/tool-admission-and-settlement.md", "docs/architecture/impact-log.md", "docs/architecture/index.md", "docs/architecture/model-state.json", "docs/architecture/model.yaml", "docs/architecture/modules.md"]
excluded_preexisting_files: [".claude", "docs/CLAUDE_EXPERIMENTAL_CAPABILITIES.md", "docs/research"]
base_revision: "git:1f78926ebc463fed5e2d7a0f22f49c9569171350"
observed_revision: "git:386dcc226ec13b4e7ce261a3b8dc9d2fe2dcfa84"
architecture_verdict: "NO_MODEL_CHANGE"
architecture_evidence: "Architecture-chain mode was BOOTSTRAP: the new canonical model records the already-existing native local CLI architecture at the bounded source checkpoint. The documentation/governance change itself alters no runtime boundary, contract, persistence owner, integration, data shape, or deployment unit."
risk: "medium"
requirement_ids: ["R1", "R2", "R3", "R4", "R5", "R6", "R7"]
repair_of: []
---

# Executive Summary
Praxis now has a canonical schema-v1 living architecture model for its native local CLI coding-agent runtime. The model contains 15 connected context nodes, five critical flows, deterministic Mermaid/Markdown projections, a bounded source checkpoint, and a bootstrap impact record so later changes can produce incremental evidence-backed architecture verdicts.

# Review Contract
Review Issue #692 and requirements R1-R7 against the exact 15 changed paths. Confirm that canonical facts reside in `model.yaml`, generated views are renderer-owned and deterministic, evidence resolves to existing bounded source paths and symbols, the checkpoint follows validation/rendering, the impact log reports every inference, the docs index exposes the model, and the change remains documentation/governance-only.

# Before And After
Before this change, `docs/architecture/model.yaml`, `model-state.json`, and renderer views did not exist, so prior accepted changes could only report `MODEL_REBUILD_REQUIRED`. Afterward, future assessments can compare the exact bounded checkpoint, inspect current modeled boundaries and critical flows, validate stable IDs/evidence, and render ten reproducible views without rediscovering the entire repository.

# Implementation Path
The primary session fixed the nine-module/two-external/three-store/one-runtime-unit boundary and five required flows, then dispatched one bounded `gpt-5.6-luna` implementation agent. Primary review localized ID collision, formatter ownership, persistence, flow sequencing, source revision, and package-startup failure-path defects through recorded repair cycles. One repeated fallback sequencing detail received a documented one-action direct-edit exception. Two-axis Standards and Spec reviews found two omissions, both were repaired, and the final re-review returned zero findings on each axis.

# Change Surface
The coherent product surface is `.prettierignore`, `docs/README.md`, and 13 files under `docs/architecture/`: one canonical YAML model, one JSON source checkpoint, one manual impact log, and ten renderer-owned Markdown views. Exactly the ten generated outputs are excluded from Prettier; hand-maintained model, impact, checkpoint, and documentation index remain checked. No runtime, source, test, fixture, dependency, workflow, package, or data-plane file changed.

# Contracts And Compatibility
The model preserves Praxis as clean-room, local-first, single-user, CLI-only, and native-only. The authoritative conversation record remains append-only `praxis.transcript` JSONL; operational sidecars remain non-authoritative. Provider-specific behavior stays inside adapters, tool execution remains permission/sandbox admitted, remote control/account/organization/RBAC/billing/IDE surfaces remain excluded, and no Claude configuration/session/data-plane compatibility is introduced.

# Architecture Impact
Architecture-chain mode is `BOOTSTRAP`, with no unresolved inferred claims. Schema limitations require this ledger's allowed verdict field to record `NO_MODEL_CHANGE`: the change documents and checkpoints existing architecture but changes no product architecture fact. The bootstrap impact log records the prior `MODEL_REBUILD_REQUIRED` trigger, current source revision, exact include scope, stable counts, flow-ID collision resolution, renderer ownership, and review repairs.

# Verification Evidence
Schema validation returned `model valid`; rendering produced ten views and a second render had identical SHA-256 output. Bounded collection reported zero added, modified, or deleted source files. Structural audit found 15 nodes, five critical flows, 142 evidence entries, 130 existing symbol references, zero missing references, and zero inferred claims. Clean-clone formatting and docs checks passed with 76 Markdown files and 65 links. Local full serial tests passed 253/253 files and 3353/3353 tests; PR #712 then passed exact clean `npm run check`, Coverage, Fixture contracts, Native deletion, Performance, TUI PTY, security audit, four release-package matrix jobs, Dependency Review, CodeQL, and protected aggregate CI.

# Risks And Known Gaps
Risk is medium because later change-impact reviews will rely on this cross-cutting governance source. The model intentionally uses maintainable module granularity rather than exhaustive file/symbol inventory. Evidence proves Praxis-owned adapter and invocation boundaries, not equivalent external-provider behavior. Future source changes must assess and update the model/checkpoint; human review of this capsule remains pending.

# Lineage And Freshness
This capsule starts the dedicated `architecture-model` scope because no prior canonical model lineage exists. Its base is `origin/main` at `1f78926`; its observed product revision is `386dcc2`. Fingerprints bind only the 15 reviewed paths, while pre-existing `.claude`, experimental capability notes, and research content remain explicitly excluded and unattributed.

# Reviewer Checklist
- Confirm the model has exactly nine modules, two external systems, three data stores, one runtime unit, and five critical flows.
- Confirm every evidence path exists, every named symbol resolves, and all confidence values are confirmed or any future inference is explicit in the impact log.
- Confirm agent-turn, native persistence, tool admission/settlement, provider fallback, and installed-package startup each preserve coherent success and fail-closed behavior.
- Confirm only ten renderer-owned Markdown files are ignored by Prettier and all generated bytes reproduce from `model.yaml`.
- Confirm the checkpoint include scope is exactly `CONTEXT.md`, `docs/ARCHITECTURE.md`, `docs/adr`, `package.json`, `scripts`, and `src`, with zero current drift.
- Confirm no runtime, provider, Transcript, configuration, package, dependency, CI, CLI/TUI, or native data-plane behavior changed.
- Confirm the protected pre-existing local paths remain excluded and human review remains pending.
