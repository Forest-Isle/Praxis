---
schema_version: "2"
change_id: "issue-768-release-channel"
created_at: "2026-09-16T11:04:26+08:00"
title: "Stabilize the npm release test frontier"
change_kind: "bugfix"
implementation_status: "verified"
review_status: "pending"
project_root: "/Users/wuqisen/dev/Praxis"
parents: ["issue-763-qualification-contract-recovery"]
supersedes: []
scopes: ["project", "architecture-model"]
changed_files: ["docs/architecture/impact-log.md", "docs/architecture/model-state.json", "src/mcp/claude-mcp-tools.test.ts"]
excluded_preexisting_files: [".claude", "docs/CLAUDE_EXPERIMENTAL_CAPABILITIES.md", "docs/research"]
base_revision: "git:b44c0ce2b85435755492817b853381b3da003dd5"
observed_revision: "worktree:fix/768-release-channel@b44c0ce2b85435755492817b853381b3da003dd5"
architecture_verdict: "NO_MODEL_CHANGE"
architecture_evidence: "The Issue #768 impact entry records one test-only bounded-source change, no affected architecture IDs, a valid unchanged model, two deterministic ten-view renders matching canonical output, and a post-validation checkpoint with zero drift."
risk: "release"
requirement_ids: ["R1", "R2", "R3", "R4", "R5"]
repair_of: []
---

# Executive Summary
Praxis now has deterministic regression evidence for the two MCP lifecycle races that blocked or threatened the npm release frontier. The prompt reconnect test proves that generation two has received `initialize` and remains pending before close, while the injected-timeout test keeps its public 25ms timeout and fail-closed permission result without assuming the child records every request before the deadline. Production code and behavior are unchanged.

# Review Contract
Review exactly the MCP test repair and its architecture evidence. Confirm the reconnect fixture uses a dedicated receive marker instead of a fixed response delay, the registry close remains idempotent, the pending reconnect rejects, and no new client catalog is published. Confirm the timeout test still asserts the configured error and permission deny result, and that no runtime, dependency, release, or provider behavior changed.

# Before And After
Before this change, one historical publish run observed only one child-side call before the injected timeout, and PR #765 could close after a delayed reconnect had already succeeded because process generation was mistaken for an in-flight request signal. Afterward, the tests synchronize only on authoritative lifecycle events: externally visible timeout/deny outcomes and actual receipt of the second-generation initialize request. No timeout value, retry policy, or production close path changed.

# Implementation Path
The primary session fixed the diagnosis, scope, compatibility, release boundary, and two sequential bounded packets. The required `gpt-5.6-luna` worker `/root/issue_768_mcp_timeout_test` completed both packets with terminal state `done`; the first repaired the injected-timeout assertion and the second repaired reconnect/close synchronization. The primary session then reviewed the entire diff and production call paths, ran 50 combined stress iterations, completed all release-risk gates, and accepted the one-file product change under Change Control.

# Change Surface
`src/mcp/claude-mcp-tools.test.ts` changes two inline fixtures and their synchronization assertions. `docs/architecture/impact-log.md` records the no-impact verdict, and `docs/architecture/model-state.json` advances only the repaired test fingerprint while retaining the canonical repository root. No production source, package manifest, lockfile, workflow, configuration, generated runtime artifact, or user data changes.

# Contracts And Compatibility
Normal MCP tools still reject after the configured 25ms total timeout, and permission-prompt MCP tools still convert the same bounded failure to `behavior: deny`. Prompt reconnect still relies on the existing session abort and close semantics; the fixture now proves the request is in flight without a scheduler-dependent 500ms response window. The change is test-only and has no public API, transcript, persistence, CLI, provider, or package compatibility impact.

# Architecture Impact
The verdict is `NO_MODEL_CHANGE`. Bounded collection found only the MCP test file modified; review of `permissionPrompt`, `execute`, `McpServerSession.callTool`, prompt reconnect, and close/abort callers confirmed no production boundary, relation, data shape, registration, deployment unit, or critical flow changed. Affected architecture node, relation, and flow IDs are none. The model validated, two ten-view renders were byte-identical and matched canonical views, and the source checkpoint now reports zero drift.

# Verification Evidence
The two repaired tests passed together in 50 sequential processes, for 100 selected test executions. Prettier, ESLint, and TypeScript checks passed. `npm run check` passed 257 test files and 3,394 tests, package verification passed for `praxis-agent-0.70.2`, all performance gates passed including rejection of the injected projection regression, and `npm audit --omit=dev` reported zero vulnerabilities. Final diff and Change Control verification found one declared product file and no undeclared path.

# Risks And Known Gaps
Risk is release because these tests gate the npm release path, even though the implementation is test-only. Local stress and complete gates cannot themselves authorize publication or prove future hosted-runner scheduling behavior, so protected CI remains required. Human Review Ledger status is pending. Merge, automerge, npm publication, release creation, deployment, provider requests, and deletion of the malformed historical PR comment remain unauthorized.

# Lineage And Freshness
This capsule directly descends from `issue-763-qualification-contract-recovery`, the current project and architecture-model head on the exact `origin/main` base. It fingerprints only the accepted test and two architecture-evidence files. Original-main `.claude`, `docs/CLAUDE_EXPERIMENTAL_CAPABILITIES.md`, `docs/research`, ignored `.agent/**` operational state, dependencies, build output, credentials, remote comments, and other open PR branches remain excluded and unattributed.

# Reviewer Checklist
- Confirm generation two writes the marker only after parsing its `initialize` request and intentionally sends no response before close.
- Confirm `registry.close()` identity, reconnect rejection, empty prompt/instruction publication, base `Read` tool retention, and post-close rejection assertions remain intact.
- Confirm the timeout regression still uses `MCP_TOOL_TIMEOUT: '25'`, checks the exact bounded error class/message pattern, and proves permission failure returns deny.
- Confirm no fixed sleep, timeout inflation, retry, production instrumentation, provider request, or runtime source change was introduced.
- Confirm the 50/50 stress gate, full check, package, performance, audit, scope, architecture, and zero-drift evidence matches the reviewed three-file change.
- Confirm human review and protected PR CI remain pending and this capsule grants no merge, release, publication, or deployment authority.
