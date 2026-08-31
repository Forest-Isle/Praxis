# Praxis Context

## Core runtime and memory vocabulary

The alignment source of truth is the
[core design map](https://github.com/Forest-Isle/Praxis/issues/336). Use the
terms below consistently in issues, plans, tests, and architecture documents.

- **Transcript**: the authoritative, append-only event history for one
  session. It supports replay, resume, export, and interoperability; it is not
  a summary or a memory store.
- **Transcript event**: one provider-neutral record in the Praxis Core
  Contract. A data-plane adapter encodes the same event into the selected
  versioned native or compatibility schema; external schema fields are not
  part of the event's domain meaning.
- **Session memory**: derived, bounded context from the current session that
  supports compaction and continuation. It is asynchronous and rebuildable,
  never the authoritative conversation record.
- **Project memory**: durable, cross-session knowledge organized by project
  topic. It is distinct from both the transcript and Session memory.
- **Session lifecycle**: the lifetime of one resumable session identity. It
  may contain many turns and is distinct from the lifecycle of any one turn.
- **Turn lifecycle**: the work initiated by one submitted user prompt within a
  session, ending in completion, cancellation, or failure. Prompt submission,
  model work, and tool work are turn-scoped rather than session-scoped.
- **Lifecycle state**: the durable state of a Session, Turn, Agent, or Team:
  `queued`, `running`, `waiting`, `completed`, `failed`, `cancelling`,
  `cancelled`, or `orphaned`. Each lifecycle has one terminal transition;
  process or terminal-pane existence is health evidence rather than state.
- **Acceptance**: the lead owner's review that an assigned outcome satisfies
  its contract and verification gates. Agent `completed` or tool `done` states
  are execution results and never imply acceptance.
- **Terminal event**: the single provider-neutral final signal for a successful
  model stream. It tells the agent loop why control returned without exposing
  provider wire details.
- **ContextEngine**: the domain service that measures and reduces the context
  visible to a provider. It is distinct from transcript persistence and both
  forms of memory.

## Capability and local orchestration vocabulary

- **Praxis Core Contract**: the single authoritative definition of agent-loop,
  context, memory, lifecycle, scheduling, permission, transcript, and agent
  semantics. It is maintained by Praxis and aligned to verified Claude Code
  behavior without depending on Claude paths, formats, binaries, or internal
  topology.
- **Prompt Behavior Contract**: the Praxis-owned definition of a prompt
  policy's role, workflow, constraints, context inputs, tool expectations, and
  observable outcomes. Reference behavior may inform the contract, but private
  prompt wording and provider-specific prose are never compatibility surfaces.
- **Data-plane adapter**: an adapter that maps the Praxis Core Contract to one
  path and encoding scheme. The native adapter exclusively owns Praxis paths
  and formats; provider protocol adapters do not select another persistence
  plane. An adapter may not change core runtime behavior.
- **Capability-gated**: a fully specified optional behavior that is available
  only when a local or provider adapter explicitly advertises support and the
  user or configuration enables it. Required workflows remain correct when the
  capability is unavailable; absence never triggers a silent substitute.
- **Implemented**: production code and required wiring exist and pass focused
  native fixtures. This status does not claim current reference compatibility
  or product-quality qualification.
- **Qualified**: an implemented behavior has passed every executable evidence
  item and applicable package, security, performance, and interaction gate
  declared by the current native contract. An excluded, blocked, or skipped
  gate cannot produce this status.
- **Team**: a local, single-user group of named agents working toward one shared
  goal under a lead agent. A Team may share a task graph and mailbox, while each
  agent retains its own lifecycle, context, and execution ownership.
- **Swarm**: a Team execution strategy that assigns independent work to
  multiple local agents concurrently. Swarm concurrency requires isolated
  writable worktrees or read-only tasks and remains capability-gated.
- **Agent orchestration**: the shared domain that owns Agent admission,
  lifecycle, task dependencies, messages, budgets, and result delivery. A Team
  adds durable membership and collaboration to this domain; Swarm changes its
  scheduling policy rather than creating another orchestration system.
- **Coordinator Lead**: a lead policy that may orchestrate, message, stop,
  resume, synthesize, and accept Agent work but may not directly use repository
  execution or mutation tools. A Hybrid Lead retains those tools. Either policy
  may use temporary workers or a Team.
- **Team mailbox**: the single durable, ordered source of inter-agent messages
  for one Team. In-process state, local sockets, and tmux may wake recipients
  but never store a second authoritative copy; stable message identities and
  durable consumption cursors provide idempotent effects after redelivery.
- **Remote agent**: an agent whose execution lifecycle is owned by another
  machine or network-reached runtime. Remote agents require network control,
  identity, reconnection, and cross-host state synchronization and remain
  outside the Praxis product scope.

## TUI vocabulary

- **Normal reading mode**: the default conversation view. It prioritizes the
  user's request, the assistant's conclusion, and the current agent state.
  Tool output and execution detail remain available through progressive
  disclosure.
- **Audit mode**: an explicit transcript view in which tool calls, results,
  diffs, and other execution details are expanded for inspection.
- **Decision surface**: a permission request, error, confirmation, or other
  interaction that requires a user response. Decision surfaces take priority
  over passive transcript content and are expanded by default.
- **Team dashboard**: the local projection of Team agents, tasks, mailbox,
  worktree ownership, usage, and lifecycle health. It reads authoritative
  durable operational state and events; it is not itself a state store or a
  remote telemetry surface.
- **Progressive disclosure**: showing a concise summary first and retaining
  complete details behind an explicit expand or audit action.
- **Fullscreen renderer**: the bounded TUI layout with an independently
  scrollable transcript and a composer anchored to the terminal bottom.
- **Classic renderer**: the compatibility and degraded-terminal layout. It is
  retained for non-TTY, screen-reader, and explicit fallback scenarios.

## Product principles

- Praxis's redesigned TUI is minimal and low-noise, centered on reading and
  acting on the conversation rather than watching raw logs.
- The normal reading hierarchy is: conclusion, current state, summary, then
  details.
- Tool details are visible while execution is active, summarized after a
  successful completion, and expanded by default for errors or decisions.
- Thinking is represented by a short status or summary in the normal view;
  full thinking is opt-in through an explicit shortcut.
- The fullscreen renderer is the default TTY experience. The classic renderer
  remains a compatibility and accessibility fallback.
- These decisions change presentation and interaction only. Native Praxis
  transcripts, runtime semantics, permissions, CLI contracts, and the
  `~/.praxis` (or `PRAXIS_HOME`) data plane remain authoritative.
- The visual palette is mostly neutral with one Praxis brand accent. Semantic
  colors are reserved for success, warning, error, permission, and active
  states; color is not decorative hierarchy.
- The interaction model is keyboard-first, mouse-enhanced, and fully usable
  without a mouse. Core surfaces share predictable navigation, confirmation,
  and cancellation semantics; `Esc` returns or cancels the current layer.
- TUI quality is judged by observable latency and stability: bounded streaming
  refreshes, responsive input, visible-region updates for long transcripts,
  stable fullscreen anchoring, bounded resize behavior, and semantic output
  across color and screen-reader modes.
