---
schema_version: "2"
change_id: "release-0703-checkpoint-root"
created_at: "2026-09-16T13:01:00+08:00"
title: "Normalize the 0.70.3 architecture checkpoint root"
change_kind: "contract"
implementation_status: "verified"
review_status: "pending"
project_root: "/Users/wuqisen/dev/Praxis"
parents: ["release-0703-ledger-freshness"]
supersedes: []
scopes: ["project", "architecture-model"]
changed_files: ["docs/architecture/impact-log.md", "docs/architecture/model-state.json"]
excluded_preexisting_files: [".claude", "docs/CLAUDE_EXPERIMENTAL_CAPABILITIES.md", "docs/research"]
base_revision: "worktree:docs/release-0703-evidence@4fd3c4ef9402e26c4358e8192333ef9b23468fb0+release-0703-ledger-freshness"
observed_revision: "worktree:docs/release-0703-evidence@4fd3c4ef9402e26c4358e8192333ef9b23468fb0+canonical-root"
architecture_verdict: "NO_MODEL_CHANGE"
architecture_evidence: "The follow-up changes only model-state.json.repo_root from the temporary linked-worktree path to the established canonical project root and documents that normalization; include scope, fingerprints, canonical model, rendered views, relations, and flows remain unchanged."
risk: "medium"
requirement_ids: ["R1", "R2", "R3", "R4", "R5"]
repair_of: []
---

# Executive Summary
This append-only follow-up normalizes the v0.70.3 architecture checkpoint from a temporary linked-worktree path back to the repository's established canonical project root `/Users/wuqisen/dev/Praxis`. It preserves the first release capsule unchanged, overlays only the corrected architecture impact/checkpoint evidence, and restores one current project and architecture-model head without affecting Praxis behavior or the published release.

# Review Contract
Review direct parent `release-0703-ledger-freshness`, its immutable capsule SHA-256 `6900cabcc801d79dce63aebcb95a104cbaedce184f3ab99641ae51d62c05abe3`, and exactly two corrected paths. Confirm `model-state.json.repo_root` is canonical, the include scope and every file fingerprint are unchanged from the validated v0.70.3 checkpoint, the impact entry transparently records normalization, and this descendant becomes CURRENT/pending in both inherited scopes.

# Before And After
Before this follow-up, the checkpoint fingerprints and release verdict were correct but `repo_root` reflected the isolated worktree used to run the helper, making the newly recorded release capsule stale after canonical normalization. Afterward, the checkpoint retains the same v0.70.3 source fingerprints under the canonical root and this descendant overlays the final two architecture files, while the first capsule remains historical and unmodified.

# Implementation Path
Primary review compared committed checkpoint history, the Issue 768 worktree, and current main, confirming that all established states use `/Users/wuqisen/dev/Praxis`. The first governance Change Control cycle was abandoned with a repair note instead of hiding the problem. A recovery cycle then restored the root with a one-line edit, documented it in the existing release impact entry, revalidated the model, rendered all ten views twice, confirmed byte equality and canonical output, confirmed zero bounded drift, and recorded this direct descendant through the atomic Ledger helper.

# Change Surface
`docs/architecture/model-state.json` changes only the `repo_root` scalar from the temporary worktree path to the canonical project path. `docs/architecture/impact-log.md` adds one normalization disclosure to the existing Release 0.70.3 entry. Ledger recording adds this immutable capsule and regenerates only `docs/change-ledger/ledger.json` and `docs/change-ledger/index.md`; the parent capsule is not edited or deleted.

# Contracts And Compatibility
Architecture model schema, evidence include scope, fingerprints, generated views, Review Ledger schema v2, lineage, inherited freshness, and human-review semantics remain unchanged. No runtime, CLI, provider, persistence, package, workflow, release, tag, asset, dependency, or user-data contract changes. The published npm package and GitHub Release are untouched.

# Architecture Impact
The verdict remains `NO_MODEL_CHANGE`. Canonical-root normalization affects only checkpoint provenance metadata and its impact-log disclosure. The canonical model, all ten renderer-owned views, every bounded source fingerprint, affected architecture IDs, and unresolved inferred claims remain unchanged; affected node, relation, and flow IDs are none.

# Verification Evidence
Committed history and the Issue 768 worktree both report canonical root `/Users/wuqisen/dev/Praxis`. The parent capsule SHA-256 was captured before repair. `validate_model.py` reported `model valid`; two render passes produced ten byte-identical views matching canonical output; bounded `collect_changes.py` reported zero added, modified, or deleted source files after normalization. Post-record Ledger status, reconcile, immutable-parent comparison, focused checks, full repository checks, and protected CI remain required.

# Risks And Known Gaps
Risk is medium because the correction changes durable architecture checkpoint provenance and appends Ledger history, but it does not change modeled facts or product behavior. The parent release capsule and this descendant both remain pending human review. The append-only history intentionally preserves the observable correction instead of pretending the temporary path was never recorded.

# Lineage And Freshness
This capsule directly descends from `release-0703-ledger-freshness` and inherits its project and architecture-model scopes. It overlays only the two final architecture evidence files required after canonical normalization. Unrelated heads, review events, release metadata, original-main protected files, ignored `.agent/**`, temporary render directories, credentials, and isolated install output remain parallel or excluded and unattributed.

# Reviewer Checklist
- Confirm the parent capsule hash remains exactly `6900cabcc801d79dce63aebcb95a104cbaedce184f3ab99641ae51d62c05abe3` and no prior capsule or review event was rewritten.
- Confirm `model-state.json` changes only the package-version fingerprint inherited from the release and its `repo_root` is the established canonical path.
- Confirm the impact log accurately discloses linked-worktree execution and canonical-root normalization without changing the Release 0.70.3 verdict.
- Confirm model validation, two ten-view render passes, canonical-view comparison, and bounded zero-drift collection pass.
- Confirm this capsule is the sole CURRENT/pending project and architecture-model head and all unrelated heads remain unchanged.
- Confirm no release artifact, tag, npm package, provider credential, runtime source, or user-owned file changed during recovery.
