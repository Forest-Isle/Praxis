# Praxis TUI Redesign PRD

## Problem Statement

Praxis has a broad, Claude-compatible Ink TUI surface, but the primary
interaction remains visually noisy and structurally difficult to evolve. A
large interactive component coordinates runtime state, keyboard routing,
transcript projection, dialogs, composer behavior, and layout. Long tool
output competes with conclusions, the composer is not consistently the visual
anchor, and fullscreen/classic/accessibility presentations do not yet share a
strong enough layout and design system.

The redesign must improve stability, performance, visual quality, and ease of
use while preserving the lower-level contracts that make Praxis compatible with
Claude's shared data plane.

## Solution

Introduce a view-model-centered TUI boundary and rebuild the presentation
around a minimal, low-noise reading model:

- fullscreen becomes the default TTY experience;
- classic remains the non-TTY, screen-reader, and explicit fallback renderer;
- normal reading prioritizes user input, assistant conclusions, and current
  activity;
- active tools show stable progress, successful tools collapse to summaries,
  and errors/decisions expand by default;
- thinking is summarized by default and expanded explicitly;
- a neutral palette with one Praxis accent and limited semantic colors creates a
  consistent design system;
- keyboard remains primary, with mouse enhancement where terminal support is
  reliable;
- a shared TUI view model feeds fullscreen, classic, and screen-reader views;
- long transcripts use visible-region rendering, stable row identity, and
  bounded refresh scheduling.

## User Stories

1. As a user starting Praxis, I want a quiet, readable launch surface so that I
   can begin typing without navigating a dashboard.
2. As a user reading an answer, I want the conclusion to dominate the screen so
   that execution detail does not obscure the result.
3. As a user watching an active turn, I want one stable activity indicator so
   that streaming does not cause visual flicker.
4. As a user reviewing a successful tool call, I want a concise summary first so
   that I can scan what changed quickly.
5. As a user debugging behavior, I want to expand complete tool input, output,
   and diffs without losing transcript order.
6. As a user facing an error or permission request, I want it expanded and
   visually prioritized so that I can make the right decision.
7. As a user who cares about reasoning detail, I want an explicit shortcut to
   expand thinking without making it part of the default reading flow.
8. As a user in a long session, I want the composer fixed at the bottom so that
   I can always continue the conversation.
9. As a user in a narrow terminal, I want optional decoration to collapse before
   core controls disappear.
10. As a user resizing a terminal, I want the layout to settle without losing
    input, scroll position, or active output.
11. As a keyboard-oriented user, I want every core action to have a discoverable
    keyboard path with consistent navigation and cancellation.
12. As a mouse user, I want selection, links, and inspection to be accelerated
    without requiring mouse input for core workflows.
13. As a returning user, I want restored sessions to use the same readable
    transcript model as fresh sessions.
14. As a user on a slow or remote terminal, I want bounded rendering and limited
    terminal writes so that the interface remains responsive.
15. As a user with accessibility needs, I want semantic screen-reader output
    without decorative layout or animation being required.
16. As a Claude-compatible user, I want shared JSONL transcripts, permissions,
    sessions, and runtime behavior to remain compatible after the redesign.
17. As a maintainer, I want fullscreen, classic, and screen-reader surfaces to
    consume one view model so that behavior does not drift between renderers.
18. As a maintainer, I want pure projection and rendering seams so that UI
    changes can be tested without providers or live services.

## Implementation Decisions

- Establish one CLI/TUI seam that transforms runtime events and existing session
  callbacks into a stable TUI view model. Keep runtime, application,
  persistence, provider, and core contracts unchanged.
- Move presentation toward a `TuiScreen` composition with separate transcript,
  composer, status, decision, palette, and dashboard surfaces. Keep the
  existing renderer loop during migration and retire old paths only after
  equivalent behavior is proven.
- Project each secondary surface through its own pure semantic model. Keep raw
  interaction state local to keyboard routing, pass only projected surfaces
  through `TuiScreen`, and avoid a universal screen AST or renderer registry.
- Use a reducer/router model for TUI interaction modes so composer editing,
  dialogs, palettes, pickers, scrolling, editor suspension, and accessibility
  behavior share explicit transitions and effects.
- Make fullscreen the default only for interactive TTY sessions. Preserve
  classic behavior for non-TTY, screen-reader, and explicit fallback cases.
- Define transcript items with stable identity, summary/detail projection,
  visibility state, and semantic severity. Do not add Praxis-specific entry
  types or fields to shared Claude JSONL.
- Render active tools as bounded progress rows, successful tools as summaries,
  and errors/decisions as expanded surfaces. Provide an explicit audit mode for
  full tool details.
- Keep thinking collapsed in normal mode and expose expansion through an
  explicit keyboard action.
- Introduce a neutral design token system with one brand accent and limited
  semantic colors. Themes may adapt colors but must preserve hierarchy.
- Use visible-region transcript rendering, memoized stable rows, and a bounded
  streaming scheduler. Preserve exact final text and transcript ordering.
- Keep keyboard-first interaction and add mouse handling only where terminal
  capabilities are detected. `Esc` returns/cancels the current interaction
  layer consistently.
- Pass TUI-only metadata through the CLI composition root; never persist it in
  shared transcripts.

## Testing Decisions

- Test observable behavior at the highest available seam: view-model
  projection, Ink component output, keyboard interaction, and PTY behavior.
- Prefer deterministic fixtures over provider calls, host configuration, or
  timing sleeps.
- Add golden/PTY coverage for fresh launch, active streaming, summarized tool
  output, expanded audit mode, errors, permissions, narrow terminals, resize,
  fullscreen fallback, and screen-reader output.
- Add focused tests for the interaction router and reducer transitions,
  including nested modal cancellation and input preservation.
- Extend performance coverage for input latency, bounded streaming refreshes,
  long-transcript visible rendering, resize stability, memory retention, and
  terminal write volume.
- Preserve and rerun existing TUI compatibility and full project gates after
  each coherent migration slice.

## Out of Scope

- Changes to provider APIs, agent runtime semantics, permission semantics, or
  Claude-compatible transcript schema.
- Accounts, organizations, RBAC, billing, telemetry control planes, IDE
  surfaces, or remote-control features.
- Copying Claude Code source implementation or creating a competing `.claude`
  session, memory, skill, or project-instruction ecosystem.
- Replacing Ink or introducing a browser/GUI frontend.
- A one-shot rewrite that discards existing behavior before compatibility is
  proven.

## Further Notes

The Session Picker now consumes a pure semantic model with stable choice
identity across visual, screen-reader, and keyboard paths.
The Hooks panel follows the same boundary: raw menu navigation remains local
to the interactive controller while a typed semantic surface reaches the
renderer.

The Command Palette now consumes a pure semantic model with stable command IDs
across visual, screen-reader, and keyboard paths.

The Mention Picker now consumes a bounded semantic model with stable file and
agent IDs across visual, screen-reader, and keyboard paths.

The redesign is an expand-contract migration. Its retained transcript window,
atomic presentation environment, root `TuiScreenModel`, semantic Help surface,
Permissions-domain surface, and Decisions-domain surface now form one pure
projection path for fullscreen, classic, and screen-reader structure. Help
retains the user's actual `?` or `/help` invocation and projects one canonical
tab/shortcut/command model. Permissions project active tool and recovery
decisions, dashboard tabs and rows, rule input/scope/deletion, and workspace
input/deletion through one normalized discriminated model. Decisions project
plan approval and `AskUserQuestion` through one two-discriminant model with
normalized indices, exact choices and progress, truthful custom-text guidance,
feedback semantics, and complete screen-reader actions. Their visual and
linear adapters consume only projected models; raw menu, permission, plan, and
question state remains in keyboard/lifecycle routing. Other leaf dialogs,
menus, and dashboards remain behind an explicit legacy secondary marker while
their own semantic surfaces migrate in later slices. Each slice must leave a
demoable path working and preserve the shared transcript/runtime boundary.
Diff now joins this pure semantic projection path through one summary/detail
model shared by visual and screen-reader adapters; other legacy secondary
surfaces remain behind the legacy marker for later migration.
MCP Panel now consumes a semantic TuiScreen payload while controller/runtime
effects remain outside presentation.
Tasks now consume a semantic TuiScreen payload while keyboard and lifecycle routing retain the raw task state.
Doctor now consumes a semantic TuiScreen payload while asynchronous lifecycle routing retains the raw doctor state.
Memory now consumes a semantic TuiScreen payload while memory loading, editing,
folder-opening, and keyboard routing retain the raw menu state.
Config now consumes a semantic TuiScreen payload while settings loading, saving,
search, and keyboard routing retain the raw menu state; status and usage
presentation data are assembled in the pure config surface projection.
Sandbox now consumes a semantic TuiScreen payload while settings and lifecycle
routing retain the raw menu state.
Agents and generic lists now consume a semantic TuiScreen payload while
keyboard routing retains the raw menu state.
