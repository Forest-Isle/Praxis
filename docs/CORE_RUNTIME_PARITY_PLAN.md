# Claude Core Runtime Parity Plan

## Objective

Bring Praxis' observable core runtime semantics into alignment with the local
Claude Code implementation while preserving Praxis' clean-room, local-first,
CLI-only constraints. Compatibility means equivalent inputs, capability
advertising, state transitions, persistence, recovery, and user-visible errors;
it does not mean copying Claude Code source.

## Design Decisions

1. Keep the existing `ModelProvider` and Claude-compatible JSONL boundaries.
   Add capability and accounting contracts around them instead of replacing
   the provider abstraction.
2. Treat tool exposure as a runtime capability decision. The resolver considers
   role, interactive/simple mode, explicit CLI controls, and environment/build
   gates. It never infers availability from Claude version numbers.
3. Use provider-reported usage as authoritative after a response. Heuristics
   remain a preflight fallback only. Context recovery is staged and bounded:
   result snip/micro-compaction, automatic summary compaction, then one
   reactive retry for a provider prompt-too-long/media-size error.
4. Keep private operational state in the Claude config root under `praxis/`.
   Session Memory is a sidecar with atomic files and progress metadata; it is
   injected into model context but never adds Praxis-only entries to shared
   transcripts.
5. Preserve every Claude transcript producer version. Read and write adapters
   are selected by structural entry shape, with an explicit unsupported-shape
   error rather than a version allowlist.

## Dependency Graph

```
capability resolver ─┐
usage/context gate ──┼─> query/session loop integration ─> compact reinjection
session memory ─────┘                                      │
                                                         v
                                      subagent/background/sidechain parity
                                                         │
                                                         v
                                      cross-version black-box compatibility
```

The first three nodes are independent and are dispatched as a swarm. Loop and
compact integration is sequential because all three feed `SessionService`.
Subagent/sidechain integration follows the stabilized loop contract.

## Phase 1 Modules

### Capability resolver

`ClaudeToolCapabilities` returns enabled tool names for `main`, `worker`, and
`coordinator` roles. It models task-v2, workflow scripts, cron/agent triggers,
background agents, simple mode, interactive mode, explicit allow/disallow, and
the corresponding environment overrides. Registries consume the result and
reject disabled calls with the same deterministic unavailable-tool error.

### Context accounting and recovery

`ContextBudget` gains an observation API for provider usage and effective model
limits. A staged planner exposes preflight, microcompact, auto-compact, and
reactive-retry decisions with a circuit breaker for repeated failures. Existing
heuristic estimates remain available for providers that emit no usage.

### Session Memory

`SessionMemoryStore` persists `summary.md` and a small JSON progress record under
`<configRoot>/praxis/session-memory/<sessionId>/`. `SessionMemoryController`
tracks token/tool thresholds, serializes extraction, exposes bounded waiting,
and updates atomically through an injected extractor. It is safe to resume after
crash and never writes shared transcript entry types.

## Later Sequential Phases

1. Wire the three contracts into `SessionService.executeTurn` and the hosted
   tool registry; add compact post-reinjection for memory, skills, hooks, MCP,
   file history, and agent listing.
2. Align AgentTool filtering, background notifications, stop/retry semantics,
   and sidechain discovery for current and older Claude layouts.
3. Add black-box fixtures for task/workflow/cron/background capability matrices,
   prompt-too-long recovery, session-memory extraction, resume/fork, and every
   supported transcript producer version.

## Implementation Status

The Phase 1 modules and later sequential phases are implemented and merged on
this branch:

- **Capability resolver** — `ClaudeToolCapabilities` derives tool exposure from
  role, interactive/simple mode, explicit CLI controls, and environment/build
  gates, never from an installed Claude version; `CLAUDE_CODE_SIMPLE` changes
  the CLI/runtime surface.
- **Context accounting and recovery** — staged preflight, micro-compact,
  auto-compact, and reactive-retry decisions with provider-reported usage
  authoritative and heuristic estimates as the preflight fallback.
- **Session Memory** — `summary.md` and progress metadata persist under
  `<configRoot>/praxis/session-memory/<sessionId>/`; private session-memory
  progress stays under `<configRoot>/praxis/` and the shared JSONL remains
  Claude-compatible append-only data without Praxis-only entry types or fields.
- **Transcript read/write** — schema adapters are selected from entry structure
  rather than an installed/producer-version allowlist; every semver-like
  producer version is read/write compatible when its entry shape is supported,
  and malformed or unsupported shapes fail closed before writes.
- **Loop integration and compact reinjection** — the three contracts feed
  `SessionService`; post-compact reinjection restores memory, skills, hooks,
  MCP, file history, and agent listing.
- **AgentTool/background/sidechain parity** — filtering, notifications,
  stop/retry semantics, and sidechain discovery follow the stabilized loop
  contract for current and older Claude layouts.
- **Verification** — focused Vitest tests and negative paths, the
  task/workflow/cron/background capability matrices, prompt-too-long recovery,
  session-memory extraction, resume/fork, and supported-transcript-producer
  verification pass in this local environment. The full current-Claude
  compatibility matrix remains blocked here because the externally routed
  `haiku` model request maps to a local provider model that reports
  `unrecognized_model`; this is an external model-routing failure, not a
  schema/version assertion failure. Ordinary current-Claude compatibility and
  probe gates accept a detected semver-like producer version; historical
  cross-version tests retain their explicitly pinned reference binaries.

Known caveat: current Claude Code's internal model routing (which upstream
model serves a given request) is external to the local compatibility contract
and is not observable from the shared filesystem or probe gates. Praxis routes
provider requests through its configured `ModelProvider`, so model-level
routing parity with the current Claude release is not claimed.

## Acceptance Gates

- Focused Vitest tests for each module and its negative paths.
- `npm run format:check`, `npm run lint`, `npm run typecheck`, and the focused
  test files before integration.
- After sequential integration: `npm run check`,
  `npm run test:compat:all`, `npm run test:package`,
  `npm run test:performance`, and `npm audit --omit=dev`.
- A smoke session through the connected Claude Worker MCP proving model -> tool
  -> continuation, compact recovery, and resume from a prior JSONL transcript.
