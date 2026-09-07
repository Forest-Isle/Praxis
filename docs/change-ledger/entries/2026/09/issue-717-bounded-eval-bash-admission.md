---
schema_version: "2"
change_id: "issue-717-bounded-eval-bash-admission"
created_at: "2026-09-07T10:36:20+08:00"
title: "Bound default eval Bash preapproval"
change_kind: "bugfix"
implementation_status: "verified"
review_status: "pending"
project_root: "/Users/wuqisen/dev/Praxis"
parents: ["issue-715-ledger-freshness"]
supersedes: []
scopes: ["project", "project-eval", "fixture-contracts", "architecture-model"]
changed_files: ["CHANGELOG.md", "README.md", "README_zh.md", "docs/CLI_REFERENCE.md", "docs/CODING_AGENT_ROADMAP.md", "docs/architecture/context.md", "docs/architecture/data-flow.md", "docs/architecture/deployment.md", "docs/architecture/flows/tool-admission-and-settlement.md", "docs/architecture/impact-log.md", "docs/architecture/model-state.json", "docs/architecture/model.yaml", "docs/architecture/modules.md", "src/cli-runtime.ts", "src/evals/eval-tool-admission.test.ts", "src/evals/eval-tool-admission.ts"]
excluded_preexisting_files: [".claude", "docs/CLAUDE_EXPERIMENTAL_CAPABILITIES.md", "docs/research"]
base_revision: "git:e2bc451eb8974cd9e67ccba8e82327d7572a830e"
observed_revision: "git:e2bc451eb8974cd9e67ccba8e82327d7572a830e"
architecture_verdict: "MODEL_UPDATE_REQUIRED"
architecture_evidence: "Issue #717 changes default Project/Plugin Eval permission registration and the critical tool-admission flow. The cli-composition and tool-security-runtime facts, their configures relation, the flow view, impact log, and bounded source checkpoint were updated and validated with no inferred claims."
risk: "high"
requirement_ids: ["R1", "R2", "R3", "R4", "R5"]
repair_of: []
---

# Executive Summary
The default Project/Plugin Eval runtime now treats `allowed_tools` as catalog exposure rather than blanket approval of every Bash argument. Allowed Bash calls are preapproved only after the existing static semantic validator and path-safety validator confirm that recognized paths stay inside the isolated eval working directory or an explicit added directory. Recognized outside-root commands such as `find /` return to the existing `dontAsk` permission failure and cannot reach process execution.

# Review Contract
Review Issue #717 and the exact 16-file product, documentation, and architecture diff from `e2bc451e`. Confirm the new predicate checks the allowed-tool catalog, preserves allowed non-Bash preapproval, requires a string Bash command, applies semantic validation, resolves cwd/addDirs, and applies path safety with `acceptEdits` roots before returning true. Confirm the shared default eval factory uses this predicate while retaining `dontAsk`, filtered tools, provider identity, and runtime construction.

# Before And After
Before this change, the default eval factory returned true whenever a call name appeared in `allowedTools`, so exposing Bash also bypassed argument-level semantic and path checks. Afterward, allowed non-Bash tools behave as before, while Bash preapproval is conditional on the existing static validators. Malformed, unsafe, ambiguous, and recognized outside-root Bash is not preapproved; bounded workspace reads, searches, tests, edits, and explicit addDir access remain available.

# Implementation Path
The primary session fixed the architecture and compatibility contract, then delegated the three-file implementation module to the `gpt-5.6-luna` agent `issue_717_bounded_eval_bash`. Primary review required one focused repair so the runtime-boundary regression used production-shaped `ClaudePermissionResolver.isSessionActionApproved` plus `dontAsk` instead of an approval callback. The repaired agent run reached `done`; independent Standards and Spec reviews returned clean. The primary session directly updated the living architecture model because this high-risk security-boundary verdict and acceptance evidence remain primary-owned.

# Change Surface
`src/evals/eval-tool-admission.ts` owns the pure preapproval predicate, `src/evals/eval-tool-admission.test.ts` covers unit and runtime-boundary behavior, and `src/cli-runtime.ts` wires the shared default Project/Plugin Eval factory. README English/Chinese, CLI reference, roadmap, and Unreleased changelog describe the bounded guarantee and retained roadmap lock. The canonical architecture model, affected deterministic views, impact log, and source checkpoint record the permission-registration and critical-flow change.

# Contracts And Compatibility
The predicate returns false for tools outside the eval catalog, true for allowed non-Bash tools, and for Bash returns true only when `input.command` is a string and both existing validators report safe. Read/write roots are the resolved eval cwd plus resolved explicit addDirs, with `acceptEdits` path semantics. Interactive permission modes, sandbox configuration, Bash AST behavior, provider contracts, transcripts, persistence, evaluation schemas, and opaque executable behavior are unchanged.

# Architecture Impact
The verdict is `MODEL_UPDATE_REQUIRED`. `cli-composition` now records default eval admission composition, `tool-security-runtime` records bounded Bash preapproval, relation `cli-configures-tool-security` records the shared factory wiring, and critical flow `tool-admission-and-settlement` records the fail-closed eval path. The schema validator passed, ten views rendered deterministically twice, the checkpoint converged to zero source changes, and no inferred claim remains.

# Verification Evidence
Focused Vitest passed 6/6 tests. Prettier, ESLint, TypeScript, and the scoped boundary check passed. `npm run check` passed 254/254 test files and 3360/3360 tests. `npm run test:package` passed with the generated `praxis-agent-0.69.0.tgz` and native session listing; `npm run test:performance` passed; `npm audit --omit=dev` reported zero vulnerabilities. Documentation verification passed 869 Markdown files and 79 local links. Standards and Spec reviews reported no findings, and the architecture validator/render/checkpoint gates passed.

# Risks And Known Gaps
This is high risk because an eval permission shortcut previously bypassed Bash argument gates. Static admission does not claim containment of side effects hidden inside opaque interpreters or unknown executables. No held-out corpus changed, no v2 real-provider qualification ran, and this change makes no quality, safety-rate, cost, latency, or optimization improvement claim. Task 8.2 and Phase 9 remain locked; protected CI and human review are still pending.

# Lineage And Freshness
This capsule descends from `issue-715-ledger-freshness` and advances its four current scopes so inherited README, eval, fixture-contract, and architecture fingerprints remain mechanically reconcilable even though fixture behavior itself is unchanged. It overlays only the 16 reviewed #717 files. Pre-existing `.claude`, the experimental-capabilities document, `docs/research`, older stash state, and `.agent/**` operational files remain excluded and unattributed.

# Reviewer Checklist
- Confirm `find /`, wrapped `env find /`, `/etc/hosts` reads, and `/tmp` writes are rejected before execution through the production-shaped `dontAsk` path.
- Confirm `npm test`, `find .`, workspace redirects, and explicit addDir reads remain preapproved when Bash is exposed.
- Confirm allowed non-Bash and disallowed-tool behavior are unchanged and the shared default Project/Plugin Eval factory is the only production wiring change.
- Confirm no interactive permission, sandbox, provider, transcript, schema, corpus, dependency, release, or deployment behavior changed.
- Confirm the architecture verdict and deterministic views match the implemented security boundary with no broad opaque-executable claim.
- Confirm all local gates and independent reviews pass while v2 qualification, Task 8.2, Phase 9, protected CI, and human review remain pending.
