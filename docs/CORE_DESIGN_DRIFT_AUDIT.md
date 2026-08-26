# Claude Code 2.1.237 Core Design Drift Audit

## Audit identity and verdict

- Reference: Claude Code 2.1.237, clean-room snapshot `661739f027dd`.
- Praxis baseline before the alignment program: 0.23.1 at
  `6fc0d5f11bcc7d3fa08769a19d83b38f7b9b07e4`.
- Integrated Praxis behavior audited here: 0.34.0 at
  `9cd0fb04aeebd83992cc9c88106ca71c09f66cb9`.
- Scope: provider/runtime terminal behavior, ContextEngine, Session memory,
  Project memory, streaming tool scheduling, prompt/cache control, hooks,
  transcript/session recovery, and subagent lifecycle.

Verdict: no required core-design drift remains in the supported local,
single-user CLI scope. Every required contract below has an active focused
fixture and is connected to at least one executable compatibility gate. This
is design and observable-behavior alignment, not source-code, private-prompt,
or internal-topology equivalence.

The report distinguishes current fixture/provider-free evidence from the full
credentialed qualification suite. A skipped or externally blocked live gate is
never reported as a pass.

## Cross-cutting domain vocabulary

Issue [#342](https://github.com/Forest-Isle/Praxis/issues/342) established the
canonical meanings of Transcript, Session memory, Project memory, session
lifecycle, turn lifecycle, terminal event, and ContextEngine in `CONTEXT.md`.
The executable audit requires all seven terms before accepting the nine domain
areas below.

<!-- core-design-area:runtime -->

### Runtime terminal protocol and loop policy

- Issues: [#135](https://github.com/Forest-Isle/Praxis/issues/135),
  [#277](https://github.com/Forest-Isle/Praxis/issues/277).
- Contract: provider adapters emit one typed terminal taxonomy; the loop owns
  continuation and recovery; fallback cannot replay content or usage; normal
  runs have no implicit model-turn cap while explicit limits remain bounded.
- Fixture evidence: `src/core/runtime.test.ts`,
  `src/providers/fallback-provider.test.ts`, and
  `src/application/session-service.test.ts` cover terminal validation,
  exactly-once fallback, unlimited default turns, explicit limits, cancellation,
  and malformed/conflicting terminal states.
- Compatibility evidence: `test:runtime-compat` and
  `test:stream-json-compat`.
- Contract document: `docs/RUNTIME_CONTRACT.md`.

<!-- core-design-area:context -->

### ContextEngine and reactive recovery

- Issues: [#151](https://github.com/Forest-Isle/Praxis/issues/151),
  [#118](https://github.com/Forest-Isle/Praxis/issues/118).
- Contract: actual provider usage anchors occupancy; deterministic estimates
  cover post-watermark growth; light reduction and full compact preserve model
  invariants; typed prompt-too-long recovery retries once only with progress.
- Fixture evidence: `src/core/context-budget.test.ts` and
  `src/application/session-service.test.ts` cover the usage watermark,
  append-only proactive compact, reactive retry, and no-progress breaker.
- Compatibility evidence: `test:context-compat`, `test:compaction-compat`, and
  `test:cross-version-compaction-compat`.
- Contract document: `docs/RUNTIME_CONTRACT.md`.

<!-- core-design-area:session-memory -->

### Session memory

- Issue: [#344](https://github.com/Forest-Isle/Praxis/issues/344).
- Contract: current-session extraction is asynchronous and isolated; durable
  artifact/watermark updates are atomic; ordinary turns do not wait; compact
  has a bounded wait and preserves an invariant-safe recent suffix.
- Fixture evidence: `src/application/session-memory.test.ts` and
  `src/application/session-service.test.ts` cover nonblocking extraction,
  failed atomic commit, resume watermarks, bounded compact wait, and selective
  compact.
- Compatibility evidence: `test:compaction-compat`,
  `test:cross-version-compaction-compat`, and the complete fixture suite in
  `npm run check`.
- Contract documents: `CONTEXT.md` and `docs/RUNTIME_CONTRACT.md`.

<!-- core-design-area:project-memory -->

### Project memory

- Issue: [#120](https://github.com/Forest-Isle/Praxis/issues/120).
- Contract: a bounded `MEMORY.md` index and typed topic files are durable
  cross-session knowledge; native/compat roots stay isolated; default recall is
  index-first; extraction and zero-to-five recall remain explicit capabilities.
- Fixture evidence: `src/application/project-memory.test.ts` covers canonical
  worktree identity, line/byte bounds, legacy topic parsing, nonblocking recall,
  success-only cursors, tool confinement, and bounded shutdown.
- Compatibility evidence: `test:memory-import-compat` and
  `test:shared-compat`.
- Contract documents: `CONTEXT.md` and `docs/RUNTIME_CONTRACT.md`.

<!-- core-design-area:scheduling -->

### Streaming tool scheduling

- Issue: [#119](https://github.com/Forest-Isle/Praxis/issues/119).
- Contract: a completed streamed tool block may start before the model stream
  ends; only capability-declared safe calls overlap; unknown/unsafe calls fail
  closed into FIFO-exclusive barriers; every tool call settles exactly once.
- Fixture evidence: `src/core/tool-scheduling-policy.test.ts` and
  `src/core/runtime.test.ts` cover fail-closed classification, streaming start,
  safe overlap, exclusive barriers, failure, and cancellation.
- Compatibility evidence: `test:runtime-compat`.
- Contract document: `docs/RUNTIME_CONTRACT.md`.

<!-- core-design-area:prompt-cache -->

### Prompt composition and provider cache control

- Issues: [#129](https://github.com/Forest-Isle/Praxis/issues/129),
  [#117](https://github.com/Forest-Isle/Praxis/issues/117).
- Contract: prompts expose ordered section identity and stability lifetimes;
  invalidation is explicit; cache hints remain provider-neutral; adapters alone
  render capability-gated wire fields and session-latched TTL decisions.
- Fixture evidence: `src/core/prompt-composer.test.ts`,
  `src/compatibility/claude/context.test.ts`,
  `src/providers/anthropic-compatible.test.ts`, and
  `src/providers/anthropic-prompt-cache.test.ts` cover ordering, focused
  invalidation, deterministic stable prefixes, breakpoint bounds, endpoint
  gating, TTL, and usage counters.
- Compatibility evidence: `test:dynamic-system-compat` and
  `test:runtime-compat`.
- Contract document: `docs/RUNTIME_CONTRACT.md`.

<!-- core-design-area:hooks -->

### Lifecycle coordination and hooks

- Issues: [#343](https://github.com/Forest-Isle/Praxis/issues/343),
  [#124](https://github.com/Forest-Isle/Praxis/issues/124).
- Contract: session, prompt/turn, compact, tool, task, and subagent lifecycles
  are separate idempotent owners; async command hooks drain boundedly; only the
  verified local single-user event subset is enabled.
- Fixture evidence: `src/application/session-service.test.ts` and
  `src/hooks/claude-hooks.test.ts` cover one SessionStart/SessionEnd lifecycle,
  compact source transitions, repeated close, event ownership, async drain,
  cancellation, and environment isolation.
- Compatibility evidence: `test:hook-compat`.
- Contract document: `docs/RUNTIME_CONTRACT.md`.

<!-- core-design-area:transcript-session -->

### Transcript preservation and session recovery

- Issues: [#134](https://github.com/Forest-Isle/Praxis/issues/134),
  [#131](https://github.com/Forest-Isle/Praxis/issues/131).
- Contract: reads/exports are open-world and lossless; Praxis-authored writes
  are closed and validated; active-branch selection precedes validation/fork;
  listing is bounded; metadata is reduced last-wins; interrupted replay is
  explicit and exactly once.
- Fixture evidence: `src/compatibility/claude/schema.test.ts`,
  `src/persistence/claude-transcript-store.test.ts`,
  `src/compatibility/claude/history.test.ts`,
  `src/compatibility/claude/fork.test.ts`,
  `src/persistence/claude-session-index.test.ts`, and
  `src/application/session-service.test.ts` cover byte preservation, structural
  write gates, compact logical ancestry, transient-state exclusion, bounded
  discovery, metadata snapshots, and interrupted recovery.
- Compatibility evidence: `test:session-metadata-compat`,
  `test:resume-at-compat`, `test:resume-selector-compat`,
  `test:recovery-compat`, `test:cross-version-session-compat`,
  `test:cross-version-resume-at-compat`, and
  `test:cross-version-fork-compat`.
- Contract documents: `docs/COMPATIBILITY.md` and
  `docs/RUNTIME_CONTRACT.md`.

<!-- core-design-area:subagents -->

### Subagent and sidechain lifecycle

- Issue: [#157](https://github.com/Forest-Isle/Praxis/issues/157).
- Contract: stable IDs and sidechains survive foreground-to-background handoff,
  parent-turn cancellation, retained/incomplete recovery, named continuation,
  and bounded shutdown; terminal notification delivery and usage are exactly
  once; cwd/worktree state is child-owned.
- Fixture evidence: `src/application/subagent-service.test.ts`,
  `src/persistence/claude-sidechain-store.test.ts`, and
  `src/application/session-service.test.ts` cover handoff without replay,
  incomplete/corrupt hydration, metadata preservation, retained worktrees,
  bounded drain, and cross-turn notification/accounting reconciliation.
- Compatibility evidence: `test:subagent-compat`,
  `test:background-agent-compat`, and
  `test:cross-version-sidechain-compat`.
- Contract document: `docs/SUBAGENT_CONTRACT.md`.

## Intentional Praxis differences

- Praxis remains provider-neutral. Provider wire errors, caching fields, and
  optimizations stay inside capability-aware adapters rather than shaping the
  core API.
- Native runs use `~/.praxis` and project `.praxis`; `.claude` is used only in
  explicit compatibility mode.
- Prompt wording, summary prose, module topology, and private rollout switches
  are Praxis-owned. Alignment applies to state models, lifecycle boundaries,
  data flow, recovery policy, and observable behavior.
- The product is local-first, single-user, and CLI-only. It does not reproduce
  service-side model routing, account state, or first-party control planes.

## Deferred capabilities

- Provider cache-edit microcompaction and first-party-only cache scopes.
- Additional cost/time loop budgets beyond the explicit model-turn limit.
- Background Project-memory extraction and selective recall unless explicitly
  enabled by a local capability.
- Auto-background timers, rich subagent progress summaries, and AI-generated
  session titles/task summaries.
- Hook executors or events without verified local single-user behavior.

Deferred items are capability-gated or optional and do not weaken any required
contract above.

## Excluded surfaces

Local, capability-gated Teams and Swarms are supported in the native data
plane. Remote agents, remote Team/Swarm control, IDE/desktop/mobile/hosted
surfaces, accounts, organizations, RBAC, billing, subscription
authentication, remote control, telemetry control planes, and implicit native
dependence on `.claude` remain outside the Praxis product boundary.

## Qualification status

The executable audit is `test:core-design-drift`. It verifies the pinned
version/base, complete prerequisite frontier, contract documents, compatibility
commands, and aggregate-matrix discovery. It also runs the explicit fixture
manifest through Vitest and requires every named contract fixture to execute
exactly once and pass, with zero skipped or todo tests in the selected files.
`npm run test:compat:all` automatically includes this gate.

Required integrated qualification remains:

1. `npm run check` — formatting, lint, docs, boundaries, typecheck, all focused
   fixtures, and build.
2. `npm run test:core-design-drift` — this report/evidence matrix.
3. `npm run test:compat:all` — every runnable isolated compatibility gate.
   Local historical lanes require their explicit binaries; required CI
   provisions exact 2.1.208 and 2.1.233 binaries, so those lanes cannot skip
   there.
4. `npm run test:package`, `npm run test:performance`, and
   `npm audit --omit=dev`.
5. Required GitHub CI, including the credential-free pinned Claude 2.1.237 core
   lane and plugin-eval contract, the historical 2.1.208 CLI/TUI contracts, plus
   bidirectional 2.1.208/2.1.233 session, resume-at, fork, sidechain, and
   compaction contracts.

The historical qualification repair in
[#381](https://github.com/Forest-Isle/Praxis/issues/381) ran all seven formerly
environment-skipped lanes directly with exact 2.1.208, 2.1.233, and 2.1.237
binaries; TUI, plugin-eval, session, resume-at, fork, sidechain, and compaction
all passed. The latest local aggregate run uses exact 2.1.208/2.1.237
binaries and stops at its first credentialed live-model gate with HTTP 401
`Invalid bearer token`. That external result proves neither a product failure
nor a full live-model pass. Provider-free black-box gates and all fixtures
remain required and run independently of provider credentials.
