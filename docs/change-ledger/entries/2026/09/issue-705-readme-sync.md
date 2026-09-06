---
schema_version: "2"
change_id: "issue-705-readme-sync"
created_at: "2026-09-06T12:40:01+08:00"
title: "Synchronize fixture behavior counts"
change_kind: "contract"
implementation_status: "verified"
review_status: "pending"
project_root: "/Users/wuqisen/dev/Praxis"
parents: ["issue-705-held-out-corpus"]
supersedes: []
scopes: ["project"]
changed_files: ["README.md", "README_zh.md"]
excluded_preexisting_files: [".claude", "docs/CLAUDE_EXPERIMENTAL_CAPABILITIES.md", "docs/research"]
base_revision: "git:cdfb04df03516521ee1f366319665ef07c41fdb7"
observed_revision: "git:b151b6384eff2cc629b3b7f2722e10df76035a5c"
architecture_verdict: "MODEL_REBUILD_REQUIRED"
architecture_evidence: "Canonical architecture model assets are absent and tracked by Issue #692. This two-file count synchronization changes no architecture fact, but an incremental NO_MODEL_CHANGE verdict cannot be mechanically proven until bootstrap."
risk: "low"
requirement_ids: ["R1", "R2"]
repair_of: []
---

# Executive Summary
The English and Chinese README development sections now report the fixture manifest's observed totals of 75 behaviors, 67 qualified behaviors, and 8 explicit exclusions.

# Review Contract
Review the independent `issue-705-readme-sync` requirements R1-R2: both language variants must mirror the verified 75/67/8 counts, preserve surrounding wording and structure, and avoid unrelated feature, command, release, or CHANGELOG edits.

# Before And After
The README pair previously reported the pre-#705 totals of 74 behaviors and 66 qualified behaviors. The new held-out loader evidence adds one qualified behavior, so both files now report 75 total and 67 qualified while the eight exclusions remain unchanged.

# Implementation Path
`doc-updater` compared the accepted product diff, current README variants, Release Please-owned CHANGELOG, and fixture verifier output. The only required README change was replacing the two stale numeric totals in each language; dedicated CLI, architecture, roadmap, and fixture-contract documents already contain the feature details.

# Change Surface
The reviewed surface is exactly `README.md` and `README_zh.md`. The 45-file held-out corpus module is recorded separately, while CHANGELOG, product code, tests, configuration, generated artifacts, operational `.agent` state, and protected local content are excluded.

# Contracts And Compatibility
No runtime, schema, CLI, package, dependency, configuration, provider, transcript, permission, corpus, or release contract changed. English and Chinese documentation remain semantically mirrored, and Release Please retains exclusive ownership of merged Conventional Commit changelog generation.

# Architecture Impact
This numeric documentation synchronization changes no architecture fact. The formal verdict remains `MODEL_REBUILD_REQUIRED` solely because the canonical architecture model and checkpoint are absent; Issue #692 owns their bootstrap and is not part of this change.

# Verification Evidence
`npm run verify:fixture-contracts` reported schema v2 with 75 behaviors, 185 evidence entries, 52 fixtures, and 7 gates. Focused Prettier and `npm run test:docs` passed. Change Control observed only the two README files with no undeclared or missing files and accepted the low-risk change.

# Risks And Known Gaps
Risk is low and limited to published documentation becoming stale or language variants diverging. Counts are copied from executable verifier output rather than inferred. Human review remains pending, and no release or deployment authority is implied.

# Lineage And Freshness
This capsule descends directly from `issue-705-held-out-corpus` and advances only the project documentation head. Base is `origin/main` at `cdfb04df`; observed revision is `b151b63`, whose shared commit also contains the separately attributed corpus change. Fingerprints bind only the two README files.

# Reviewer Checklist
- Confirm the fixture verifier reports 75 total behaviors with 67 qualified and 8 excluded.
- Confirm README.md and README_zh.md report the same 75/67/8 values in their development sections.
- Confirm no surrounding README prose, command, feature claim, or structure changed.
- Confirm CHANGELOG remains Release Please-owned and unmodified.
- Confirm only the two README files are attributed and review status remains pending.
