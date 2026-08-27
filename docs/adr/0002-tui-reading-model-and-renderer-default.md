# ADR 0002: TUI reading model and renderer default

## Status

Accepted

## Context

The active runtime is Praxis-native only. References to Claude-compatible
transcripts below describe the retained message/tool protocol shape; sessions,
resources, and operational state are stored under `~/.praxis` (or
`PRAXIS_HOME`) and no legacy Claude data directory is consulted.

Praxis already has a broad Ink-based TUI surface, but its interaction model
still exposes too much implementation detail in the primary conversation flow.
Long tool output can compete with conclusions and the composer. The project
also has both a classic renderer and a bounded fullscreen renderer, but the
fullscreen layout is not yet the primary product surface.

The redesign must improve readability, stability, performance, and ease of use
without changing native transcripts, runtime behavior, permissions, or CLI
contracts.

## Decision

Adopt a minimal, low-noise conversation model based on progressive disclosure:

1. Normal reading mode prioritizes the user's request, the assistant's
   conclusion, and current activity.
2. Active tools show a stable one-line progress state.
3. Successful tools collapse to a concise summary while retaining complete
   output for expansion or audit mode.
4. Errors, permission requests, and confirmations are expanded and visually
   prioritized by default.
5. Thinking is summarized in normal reading mode and fully expanded only by an
   explicit user action.
6. The fullscreen renderer becomes the default TTY experience, with the
   classic renderer retained for non-TTY, screen-reader, and explicit fallback
   scenarios.
7. The visual system uses a mostly neutral palette, one Praxis brand accent,
   and a small semantic color set. Color communicates state, not decoration.
8. Interaction is keyboard-first and mouse-enhanced. Every core operation has
   a discoverable keyboard path, while mouse actions may accelerate selection,
   links, and inspection without becoming a dependency.
9. Acceptance includes measurable TUI responsiveness and stability: bounded
   streaming refreshes, responsive composer input, visible-region updates for
   long transcripts, stable fullscreen anchoring, bounded resize behavior, and
   semantic output across terminal color and screen-reader modes.

## Consequences

Positive:

- The primary screen remains focused on decisions and outcomes.
- Long sessions have a stable composer and a clearer scrolling boundary.
- Tool details remain inspectable without turning the default view into a log.
- Virtualization, memoization, and bounded rendering have a clean target.

Costs and constraints:

- Transcript rows need explicit summary/detail states and stable identity.
- Keyboard navigation must make expansion and audit mode discoverable.
- Fullscreen becomes a compatibility-sensitive default and needs PTY coverage.
- Screen-reader and non-TTY rendering must retain semantic content without
  relying on decorative layout.

## Compatibility boundary

This ADR permits presentation and interaction changes only. It does not permit
Praxis-specific entry types or fields in shared Claude JSONL, changes to runtime
permission semantics, or a competing session/data ecosystem.
