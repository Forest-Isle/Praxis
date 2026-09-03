# Native Fixture Contracts

## Goal

Praxis qualifies supported behavior through executable, native-only evidence.
Every declared observable capability must resolve to a deterministic Vitest
case or a named repository gate. Checked-in fixture files must have an owner in
the contract; documentation alone is never qualification evidence.

This contract implements GitHub issue #528 and respects ADR 0002. Claude Code
may remain a clean-room source of observable CLI/TUI reference captures, but
Praxis never treats Claude paths, transcripts, configuration, or a Claude
binary as a runtime data-plane dependency.

## Selected approach

Use one machine-readable manifest plus one executable runner. The manifest is
the source of truth for supported behavior IDs and evidence ownership. Existing
tests remain at their public seams; they are not rewritten around private
implementation details merely to satisfy the manifest.

Pure algorithms use table or property tests. Persisted data, process protocols,
terminal output, lifecycle transitions, recovery, and security decisions use
fixture-backed integration tests. Expected values must be independent literals
or retained clean-room observations, never values recomputed by production code.

## Confirmed test seams

- CLI process exit status, stdout, stderr, text/JSON/stream-JSON protocols.
- TUI projection and PTY output, including screen-reader and narrow-terminal
  behavior.
- Core Agent, Turn, Session, context, memory, tool scheduling, and lifecycle.
- Native Transcript, persistence, locking, recovery, and concurrency.
- Provider request/response adapters and authentication boundaries.
- Tool, permission, sandbox, hook, MCP, plugin, and extension interfaces.
- Agent, Task, Workflow, Team, and Swarm orchestration interfaces.
- Installed package, maintenance, performance, security, and deletion gates.

## Manifest

`test/fixtures/manifest.json` has schema version 1 and contains:

- `behaviors`: unique stable IDs, seam, observable contract, supported status,
  production modules, required outcomes, and executable evidence.
- `gates`: package-script evidence that is required for qualification and the
  CI job that executes it.
- Evidence kinds:
  - `vitest`: exact repository-relative test file and exact test title.
  - `fixture`: repository-relative fixture path owned by the behavior.
  - `gate`: a package script declared in the manifest's gate table.

Supported behaviors must include passing evidence. A qualified behavior may
not reference a skipped, missing, or failing test. Each production module named
by the contract must exist. Each fixture below `test/fixtures/native/`,
`test/fixtures/project-evals/`, or `test/fixtures/reference/` must be owned by at
least one behavior, and an owned fixture must exist. Duplicate behavior IDs,
fixture ownership ambiguity, path escape, unknown fields, and unknown evidence
kinds fail closed.

## Execution

`npm run test:fixtures` validates the manifest, runs the unique referenced
Vitest files once, consumes structured Vitest results including the final
partial output, and proves that every referenced exact test title passed. It
uses temporary output outside the repository and awaits process completion and
artifact reads before reporting success.

`npm run verify:fixture-contracts` performs the deterministic structural check
without running Vitest. It is part of `npm run check`. Required CI runs the
executable fixture command, not only the structural verifier.

Repository gates remain separate when they exercise installed packages, real
PTYs, performance budgets, native deletion, or security audits. The manifest
must name their exact package scripts and CI jobs so a documentation-only claim
cannot mark them qualified. Gate scripts must be non-empty, non-noop, and
non-self-recursive qualification commands.

## Fixture lifecycle and safe removal

1. Search tracked source, tests, scripts, and documentation for every candidate.
2. Retain an asset only when a current executable behavior owns it.
3. Move retained Claude observations to
   `test/fixtures/reference/claude-code/<version>/`; reference ownership does
   not imply a compatibility data plane.
4. Put current Praxis data under `test/fixtures/native/<seam>/`.
5. Delete an unowned asset only after the manifest verifier and repository
   search both prove it has no consumer.
6. Preserve historical plans only when clearly labelled historical. Replace
   active qualification claims that cannot name executable evidence.
7. Never touch user-owned `.claude/`, `docs/research/`, credentials, generated
   output, or untracked local data.

The completed fixture lifecycle retains four Claude Code 2.1.208 reference
captures under `test/fixtures/reference/`: Config, Hooks, Tasks JSON, and Tasks
text capture. They are clean-room UI reference evidence only and do not provide
live Claude qualification or a Claude data plane. Seventeen unconsumed files—
the legacy fixture README and 16 fixture assets—were removed after manifest
ownership and repository search proved them unowned.

## Error and stability contract

- Referenced fixture tests must be hermetic from provider credentials, host
  Claude state, model overrides, and network access unless a named external
  gate says otherwise.
- Async tests wait for observable completion; fixed sleeps are forbidden.
- Integration tests receive an explicit suite budget that tolerates normal
  full-suite contention while preserving bounded failure.
- A failed fixture run reports the behavior ID, evidence file/title, exit code,
  and captured diagnostic; it never silently retries.
- Required tests have zero skip/todo results. Environment-blocked external
  evidence is `blocked`, never `qualified`.
- `.agent/`, worktrees, coverage, build output, and dependencies are excluded
  from formatter/linter/test discovery.

## Current status

Issue #528 is implemented. The machine-readable manifest and executable runner
are the active qualification source. The manifest declares 74 behaviors: 66
are qualified and 8 are explicitly excluded. It contains 157 evidence entries:
107 Vitest entries, 44 fixture entries, and 6 gate entries.

The OpenAI protocol evidence is a versioned, hermetic comparison of the public
Chat Completions and Responses adapters. It qualifies only the tested plain
text and ordinary function call/output subset; reasoning continuity,
protocol-native terminal/refusal/incomplete meanings, richer usage, and hosted
response state are recorded as incompatible. It makes no claim of live
provider compatibility and keeps automatic cross-protocol fallback
`not_authorized`.

`npm run test:fixtures` executes the native contract, while
`npm run verify:fixture-contracts` performs its structural check and is part of
`npm run check`. `npm run test:core-completion` remains only as a compatibility
alias for `npm run test:fixtures`.

The native project-eval evidence also includes the LSP diagnostics admission
lane. Its four fixtures compare an explicit checker baseline with a test-local
candidate that appends bounded, contained current-file diagnostics after
successful mutations. The measured result is 4/4 task and safety outcomes for
both variants: 21 baseline turns (5.25 average, four expected checker errors)
versus 17 candidate turns (4.25 average, zero tool errors), a -1 average-turn
delta with no permission, retry, timeout, interruption, pass, or safety
regression. This evidence does not implement live LSP diagnostics or establish
Claude/external parity.

## Acceptance

- Every qualified behavior resolves to passing executable evidence; excluded
  behaviors remain explicit and reasoned. Every fixture has one evidence owner.
- No checked-in fixture is orphaned and no evidence names a missing test.
- Qualification cannot pass through prose, nonexistent files, skip, or todo.
- Every production runtime module with statements has nonzero coverage; type-only
  modules with zero statements remain valid.
- Native-only architecture and clean-room TUI reference behavior remain intact.
- All required local and protected CI gates pass.
