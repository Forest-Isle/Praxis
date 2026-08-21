# Praxis Context

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
