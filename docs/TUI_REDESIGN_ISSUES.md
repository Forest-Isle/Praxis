# TUI redesign issue breakdown

These are proposed vertical slices from [PRD_TUI_REDESIGN.md](./PRD_TUI_REDESIGN.md).
They are intentionally written for review before publishing to an external
issue tracker.

## 1. Establish the TUI view-model and fullscreen shell — [#317](https://github.com/Forest-Isle/Praxis/issues/317)

**Blocked by:** None

**Stories:** 1, 8, 13, 17, 18

Create the shared projection boundary and make fullscreen the default
interactive TTY shell while retaining classic and screen-reader fallbacks.
The slice must preserve the current session lifecycle and render a complete
fresh/resumed conversation path through the new shell.

## 2. Implement the minimal reading transcript — [#318](https://github.com/Forest-Isle/Praxis/issues/318)

**Blocked by:** 1

**Stories:** 2, 3, 4, 5, 6, 7

Move transcript presentation to the new view model with stable message rows,
active progress, summary/detail tool states, audit mode, and explicit thinking
expansion. The slice must cover user, assistant, tool, result, warning, and
error states end to end.

## 3. Rebuild composer and interaction routing — [#319](https://github.com/Forest-Isle/Praxis/issues/319)

**Blocked by:** 1

**Stories:** 8, 11, 12

Introduce explicit interaction modes and a consistent keyboard-first router for
composer editing, menus, dialogs, scrolling, cancellation, and mouse-enhanced
selection/links. Existing slash, mention, shell, clipboard, and editor flows
must remain available.

## 4. Apply the unified design system and responsive layout — [#320](https://github.com/Forest-Isle/Praxis/issues/320)

**Blocked by:** 1, 2

**Stories:** 1, 2, 8, 9, 10, 15

Unify spacing, borders, typography emphasis, semantic colors, narrow-terminal
degradation, status placement, and screen-reader branches across the primary
surfaces.

## 5. Rebuild decision and inspection surfaces — [#321](https://github.com/Forest-Isle/Praxis/issues/321)

**Blocked by:** 2, 3, 4

**Stories:** 5, 6, 11, 15

Bring permission, error, plan, question, MCP elicitation, command palette,
session picker, diff, and dashboard surfaces onto the shared hierarchy and
interaction rules.

## 6. Add long-session rendering performance — [#322](https://github.com/Forest-Isle/Praxis/issues/322)

**Blocked by:** 2, 3

**Stories:** 3, 4, 8, 10, 14, 18

Add visible-region rendering, stable row memoization, bounded streaming flushes,
resize scheduling, and long-transcript memory/write budgets without changing
observable transcript order or final content.

## 7. Complete compatibility, accessibility, and fallback migration — [#323](https://github.com/Forest-Isle/Praxis/issues/323)

**Blocked by:** 4, 5, 6

**Stories:** 9, 10, 11, 12, 15, 16

Exercise fullscreen, classic, non-TTY, screen-reader, color capability, PTY,
resize, suspend/resume, and existing Claude compatibility paths. Remove old
presentation paths only after equivalent behavior is covered.

## 8. Final acceptance and old-path contraction — [#324](https://github.com/Forest-Isle/Praxis/issues/324)

**Blocked by:** 7

**Stories:** 14, 16, 17, 18

Run the full project and compatibility gates, verify performance budgets,
review scope and placeholders, and contract temporary migration adapters.
