# Praxis Context

## Core runtime and memory vocabulary

The alignment source of truth is the
[core design map](https://github.com/Forest-Isle/Praxis/issues/336). Use the
terms below consistently in issues, plans, tests, and architecture documents.

- **Transcript**: the authoritative, append-only event history for one
  session. It supports replay, resume, export, and interoperability; it is not
  a summary or a memory store.
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
- **Terminal event**: the single provider-neutral final signal for a successful
  model stream. It tells the agent loop why control returned without exposing
  provider wire details.
- **ContextEngine**: the domain service that measures and reduces the context
  visible to a provider. It is distinct from transcript persistence and both
  forms of memory.

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
- These decisions change presentation and interaction only. Claude-compatible
  transcripts, runtime semantics, permissions, CLI contracts, and the shared
  `.claude` data plane remain authoritative.
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
