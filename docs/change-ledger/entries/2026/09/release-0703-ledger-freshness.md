---
schema_version: "2"
change_id: "release-0703-ledger-freshness"
created_at: "2026-09-16T12:58:14+08:00"
title: "Record the 0.70.3 release boundary"
change_kind: "contract"
implementation_status: "verified"
review_status: "pending"
project_root: "/Users/wuqisen/dev/Praxis"
parents: ["issue-768-release-channel"]
supersedes: []
scopes: ["project", "architecture-model"]
changed_files: [".release-please-manifest.json", "CHANGELOG.md", "docs/architecture/impact-log.md", "docs/architecture/model-state.json", "package-lock.json", "package.json"]
excluded_preexisting_files: [".claude", "docs/CLAUDE_EXPERIMENTAL_CAPABILITIES.md", "docs/research"]
base_revision: "git:115a48297c6b4fc05b21de6aa558df265bace7d5"
observed_revision: "git:4fd3c4ef9402e26c4358e8192333ef9b23468fb0+worktree"
architecture_verdict: "NO_MODEL_CHANGE"
architecture_evidence: "The Release 0.70.3 impact entry records one package-version-only change in the bounded source scope, affected IDs none, a valid unchanged model, two byte-identical ten-view renders matching canonical output, and a converged checkpoint."
risk: "release"
requirement_ids: ["R1", "R2", "R3", "R4", "R5"]
repair_of: []
---

# Executive Summary
Praxis 0.70.3 is published from exact merge revision `4fd3c4ef9402e26c4358e8192333ef9b23468fb0`, with npm `latest`, GitHub assets, SBOM, checksums, provenance, and an isolated installed CLI all agreeing on 0.70.3. This append-only capsule advances the accepted Issue 768 project and architecture-model head across the generated release metadata and its accepted architecture evidence; it introduces no runtime behavior.

# Review Contract
Review direct parent `issue-768-release-channel`, release PR #754 head `80dc1e2eb3783215958d44a1a29bb23d7ae37870`, merge/tag revision `4fd3c4ef9402e26c4358e8192333ef9b23468fb0`, the six exact `changed_files`, and Publish run `35052421913`. Confirm the four generated release files match 0.70.3, the two architecture files contain only the `NO_MODEL_CHANGE` evidence/checkpoint update, and the resulting project and architecture-model head is CURRENT with human review pending.

# Before And After
Before this capsule, accepted head `issue-768-release-channel` was stale on five inherited fingerprints after the generated release and architecture assessment, and did not yet track the release manifest. After recording, `release-0703-ledger-freshness` overlays those five mismatches plus the exact release manifest, preserving one current descendant for the same two scopes while leaving all unrelated parallel heads untouched.

# Implementation Path
Repository automation merged release PR #754 after exact-head protected checks, created GitHub Release and tag `v0.70.3`, and dispatched the exact-tag Publish workflow. That workflow ran complete release gates, created and attested the tarball, SBOM, and checksums, uploaded the assets, and published npm provenance. The primary Codex session then performed the isolated install smoke, assessed the bounded architecture source, validated and rendered the unchanged model twice, advanced its checkpoint, and recorded this capsule through the atomic Ledger helper.

# Change Surface
The original release changed `.release-please-manifest.json`, `CHANGELOG.md`, `package-lock.json`, and `package.json`. This governance branch edits only `docs/architecture/impact-log.md`, `docs/architecture/model-state.json`, the new immutable capsule, and renderer-owned `docs/change-ledger/ledger.json` and `docs/change-ledger/index.md`. The four release files are fingerprint overlays inherited byte-for-byte from `origin/main`, not edits made by this branch.

# Contracts And Compatibility
The package name, CLI `bin` mapping, dependency graph, Node.js engine requirement, public behavior, persistence/data plane, provider contracts, release workflow, and compatibility surface remain unchanged. Review Ledger schema v2, append-only lineage, fingerprint freshness, deterministic index rendering, and explicit pending human review remain intact. No account, remote-control, IDE, telemetry-control-plane, or Claude data-plane compatibility is introduced.

# Architecture Impact
The verdict is `NO_MODEL_CHANGE`. Bounded collection found only `package.json` modified, and its sole diff is version 0.70.2 to 0.70.3. There is no boundary, relation, data shape, registration, integration, deployment unit, or critical-flow change. Affected architecture node, relation, and flow IDs are none; model validation, two byte-identical ten-view renders, canonical-view comparison, and post-checkpoint zero drift all passed with no unresolved inferred claim.

# Verification Evidence
PR #754 exact-head CI, CodeQL, and Dependency Review passed. Release Please and Publish runs succeeded at the exact merge revision. `release:verify`, `npm run check`, `npm run test:package`, `npm run test:performance`, and `npm audit --omit=dev` passed before attested publication. GitHub exposes all three expected assets and attestation `47811186`; npm `latest` is 0.70.3; a clean Node v25.2.1 installation resolved 181 packages and both package metadata and `praxis --version` reported 0.70.3. Architecture collection, validation, render determinism, and checkpoint convergence passed. Ledger reconciliation and repository checks remain required after recording.

# Risks And Known Gaps
Risk is release because this evidence describes an immutable published package, even though this governance branch is documentation-only. v0.70.2 remains immutable and unpublished on npm; no retry or rewrite occurred. Human review of this capsule is pending. One transient local GitHub watch connection error affected only observation and not the successful authoritative run. This capsule authorizes no future release, dependency merge, provider request, or credential access.

# Lineage And Freshness
This capsule directly descends from the accepted `issue-768-release-channel` head and advances only its `project` and `architecture-model` scopes. It overlays the exact release metadata and architecture evidence needed to reconcile that lineage at v0.70.3. Unrelated scope heads remain parallel. Original-main `.claude`, `docs/CLAUDE_EXPERIMENTAL_CAPABILITIES.md`, `docs/research`, ignored `.agent/**`, credentials, temporary render directories, and isolated install output remain excluded and unattributed.

# Reviewer Checklist
- Confirm PR #754 head, squash merge, tag, GitHub Release, Publish run, and npm package all resolve to the stated immutable v0.70.3 boundary.
- Confirm the four generated release files contain only the expected version, lockfile-root, manifest, and release-note changes.
- Confirm the architecture verdict is supported by the one-file bounded source drift, unchanged model, two deterministic renders, and zero-drift checkpoint.
- Confirm the six fingerprint overlays are exactly the coherent release and architecture evidence surface, with no user-owned or unrelated Ledger path attributed.
- Confirm `release-0703-ledger-freshness` is CURRENT and pending for project and architecture-model, unrelated heads remain parallel, and reconciliation is deterministic.
- Confirm this capsule does not imply approval for a future release, dependency PR, provider request, or modification of v0.70.2 or v0.70.3.
