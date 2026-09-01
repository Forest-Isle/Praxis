# Outcome-Driven Coding Agent Roadmap

Status: accepted implementation direction
Tracking map: [#540](https://github.com/Forest-Isle/Praxis/issues/540)
First module: [#541](https://github.com/Forest-Isle/Praxis/issues/541)

## Goal

Make Praxis a measurably excellent local-first, single-user CLI coding agent.
Runtime, tool, context, and provider changes must improve repository outcomes,
not merely add surface area or make isolated unit tests pass.

Success means Praxis can repeatedly complete bounded coding tasks while
recording enough local evidence to explain success, regression, cost, safety,
and recovery behavior.

## Product boundaries

- Keep the native Praxis data plane authoritative and append-only.
- Remain local-first, single-user, and CLI-only.
- Keep permissions and sandboxing in the runtime, not optional extensions.
- Keep provider-specific behavior behind capability-aware adapters.
- Do not add accounts, organizations, RBAC, billing, remote control, IDE
  surfaces, hosted dashboards, or a telemetry control plane.
- Do not rewrite `session-service.ts` in one migration.

## Strategy

The dependency order is deliberate:

```text
Outcome evidence
  -> recovery correctness
  -> tool/context efficiency
  -> provider-native depth
  -> turn-kernel deepening
  -> measured coding optimizations
```

## Target architecture

```text
Project eval adapter / Plugin eval adapter
                  |
             Eval kernel
  case -> isolated workspace -> runtime -> trajectory
                         |          |
                  workspace diff   usage/cost
                         |          |
                    verifiers -> deterministic score -> artifacts

SessionService
  -> TurnCoordinator
  -> ContextPreparation
  -> ProviderClientSession
  -> ToolBatchLifecycle
  -> TurnPersistence
  -> TurnAccounting
```

## Evidence contract

Every coding run records a versioned, local-only artifact set:

- case identity and schema version;
- Praxis version, selected provider/model identity, and configuration digest;
- terminal status, turns, duration, usage, and cost availability;
- provider-neutral runtime trajectory;
- added, modified, and deleted workspace paths;
- bounded verifier argv, exit status, timeout, stdout, and stderr;
- expected, allowed, and forbidden path checks;
- permission decisions, tool errors, retry, and termination evidence;
- a deterministic pass/fail result.

Unknown cost is unavailable, never zero. Repository tests and hard workspace
checks outrank LLM judges.

## Phase 0 — Outcome evaluation foundation

### Task 0.1: Project outcome harness [implemented by #541]

- Extract shared provider-neutral eval runtime, trace, and grader contracts from
  the existing plugin-oriented implementation.
- Add `praxis eval <target>` project-case discovery.
- Copy contained fixtures into isolated workspaces without changing sources.
- Detect workspace mutations and enforce explicit changed-path allowlists.
- Run explicitly authorized, no-shell verifier argv with bounded output/time.
- Persist per-run and aggregate artifacts.
- Preserve `praxis plugin eval` behavior and reports.

Acceptance: a deterministic injected runtime passes with complete artifacts;
unsafe paths, unauthorized verifiers, forbidden changes, timeout, and nonzero
verification fail closed.

Task 0.1 is implemented; Task 0.2 is the next dependency-ready slice.

### Task 0.2: Baseline suite [depends: Task 0.1]

Add hermetic fixtures for bug fix, small feature, refactor, repository
navigation, long context/resume, denied permission recovery, malformed tool
input, and active-turn steering. Start with deterministic provider scripts;
add opt-in real-model lanes after artifact stability.

Acceptance: one command compares named baseline and candidate configurations
and reports pass-rate, safety, turn, token, cost, and latency deltas.

## Phase 1 — Recovery correctness

### Task 1.1: Recover malformed tool input [depends: Task 0.2, #138]

Provider decoders return a typed invalid-input call. The runtime emits a paired,
model-visible error result without executing the tool or losing the turn.

### Task 1.2: Stream timeout model [depends: Task 0.2, #121]

Separate connect, idle, and total timeouts. Define retry eligibility before and
after presentation or tool side effects. Add one capability-gated fallback only
where duplicate effects are impossible.

Acceptance: outcome fixtures show no duplicated mutation, orphaned tool call,
or silent partial output across both recovery modules.

## Phase 2 — Tool and context efficiency

### Task 2.1: Deferred tool catalog [depends: Task 0.2, split from #126]

Introduce `ToolCatalog` and per-turn `ActiveToolSet`. Expose base tools plus a
search placeholder, then activate stable tool identities with permission and
scheduling metadata intact.

### Task 2.2: MCP context bounds [depends: Task 2.1, #147]

Bound descriptions, externalize oversized text results, preserve existing
binary resource behavior, and verify how `readOnlyHint` affects both scheduling
and permission policy.

### Task 2.3: Volatile repository context [depends: Task 0.2, #152]

Make git status turn-volatile, bounded, no-optional-locks, and worktree-aware.
Subagents collect their own cwd projection rather than inheriting a stale parent
snapshot.

Acceptance: large MCP and repository fixtures reduce prompt bytes without
regressing tool selection, task outcome, or permission safety.

## Phase 3 — Provider-native depth

### Task 3.1: API-key Responses adapter [depends: Tasks 1.2, 2.1]

Add a public OpenAI Responses protocol adapter with explicit model capability
selection, reasoning/tool item continuity, and request capture fixtures.

### Task 3.2: Turn-scoped provider client [depends: Task 3.1]

Own transport, sticky routing, continuation, retry, and fallback state for one
turn. Never leak provider wire payloads into core or transcripts.

Acceptance: baseline/candidate runs compare Chat Completions and Responses with
the same task, permission, and tool configuration; partial retries cannot repeat
side effects.

## Phase 4 — Turn-kernel deepening

### Task 4.1: TurnCoordinator [depends: Phases 1–3]

Extract single-active-turn ownership, steering/follow-up mailbox, cancellation,
and terminal sealing behind typed outcomes.

### Task 4.2: ContextPreparation and generation [depends: Task 4.1]

Separate stable, volatile, history, memory, and active-tool projections. Add a
monotonic generation for compaction, rollback, and replacement.

### Task 4.3: Persistence and accounting [depends: Task 4.2]

Extract transcript commit boundaries and usage/cost/duration aggregation while
preserving append-only event bytes and lifecycle ordering.

Acceptance: characterization, native fixture, outcome, package, performance,
and security gates remain unchanged or improve after every extraction.

## Phase 5 — Measured optimizations

Admit ApplyPatch, LSP, search, distribution, and cross-platform work only when
Phase 0 artifacts show a specific bottleneck.

## Release gates

Each implementation PR runs focused format, lint, typecheck, build, and tests,
then `npm run check`. Package, persistence, provider, permission, hook, MCP, or
performance work additionally runs `npm run test:package`,
`npm run test:performance`, and `npm audit --omit=dev` as required by the root
workflow. An unavailable external/model gate is reported, never counted green.

## Decision rules

- One child issue and independently reviewable vertical module per PR.
- Shared contracts, migrations, and generated outputs remain sequential.
- No result is called an improvement without baseline/candidate evidence.
- No outcome artifact uploads by default.
- Existing user worktrees and untracked files are never cleaned or staged.
