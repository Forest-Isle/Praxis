# Praxis TUI C+ Quiet Operator Spec

## Goal

Rebuild the interactive Praxis TUI as a quiet, high-density local operator
surface: visually restrained, fast under long transcripts and streaming, stable
through terminal lifecycle changes, and easy to use without learning decorative
chrome.

Preserve every existing CLI command, keybinding action, runtime event,
permission outcome, provider capability, session lifecycle, screen-reader
meaning, Claude compatibility behavior, and native append-only JSONL transcript.

## Selected Direction

Use **C+ Quiet Operator** as the single visual language for both renderers:

- linear `you>` / `praxis>` conversation instead of cards;
- no decorative panels, persistent sidebar, glow, or ornamental borders;
- successful tools collapse to one stable row, running tools keep one stable
  status row, and failures disclose the useful error detail;
- a minimal composer and one concise status line;
- dense text lists for Team, Tasks, Audit, settings, and diagnostics;
- near-monochrome text with mint accent, amber warning, and red error;
- English-only permission settings and permission decisions;
- `❯` marks selection; `↑/↓` moves; `Enter` confirms; `Esc` cancels.

## Architecture

```text
Runtime state / input
        ↓
interactive.tsx controller
        ↓
TuiScreenModel (semantic application state)
        ↓
Quiet Frame projection (pure layout and disclosure policy)
        ↓
ANSI fullscreen adapter │ Ink classic / screen-reader adapter
```

`interactive.tsx` owns runtime orchestration, input routing, and adapter
selection only. It must not keep independent visual JSX branches for each
surface.

The Quiet Frame module is framework-free and is the only place that decides:

- visible regions and ordering;
- responsive density;
- stable row identity;
- tool success/running/error disclosure;
- selection markers and English permission labels;
- composer/status content;
- truncation and optional secondary detail.

ANSI and Ink are true adapters over the same frame. They may translate styles,
cursor placement, and accessibility wording, but may not invent different
information architecture or permission semantics.

## Frame Contract

A frame contains ordered semantic rows plus cursor metadata. Each row has a
stable key, region, semantic role, plain text segments, and an optional
screen-reader label. Rows never contain terminal control sequences.

Required regions, in order:

1. optional compact identity for a new or resumed session;
2. transcript and active stream;
3. one focused surface: permission/decision, secondary view, or composer;
4. status.

Responsive density is deterministic:

- `>= 100`: full metadata and useful descriptions;
- `80–99`: standard layout;
- `60–79`: omit secondary descriptions and redundant hints;
- `40–59`: one-column compact rows;
- `< 40`: preserve prompt, selection, decision, error, and status meaning only.

Row keys derive from transcript identity, surface identity plus item identity,
or stable chrome identity. Resize, selection movement, streaming append, and
status updates must not churn unrelated keys.

## Visual Language

- Background is terminal-native; normal text is neutral gray/white.
- Mint is limited to Praxis identity, active focus, and positive completion.
- Amber represents caution or waiting; red represents failure or destructive
  impact. Color never carries meaning alone.
- Headings use weight and spacing, not boxes.
- Separators appear only where two adjacent regions would otherwise be
  ambiguous.
- Animation is limited to low-frequency text state changes. No spinner may
  cause full-frame redraw or unstable row width.
- Unicode markers require ASCII/no-color equivalents.

Transcript grammar:

```text
you> explain this diff
praxis> I will inspect the changed module.
✓ Read  src/core/example.ts
… Bash  npm test
! Edit  src/core/example.ts
  permission denied: workspace rule
```

Successful tool output is hidden in normal mode and available in Audit mode.
Failed tool output is shown with a bounded useful excerpt in normal mode and
full projected detail in Audit mode. Active thinking is muted and only shown
when the existing detailed-thinking control allows it.

## Permission and Decision UX

All permission-management and permission-decision copy is English.

Every choice surface uses the same linear grammar:

```text
Allow Bash to run `npm test`?

❯ Allow once
  Always allow for this project
  Deny

↑/↓ select  Enter confirm  Esc cancel
```

Number, `y`/`n`, Tab-feedback, and screen-reader shortcuts remain compatible
where they already exist, but the visible default teaches only arrows, Enter,
and Esc. Destructive choices include a short amber/red consequence line.
Permission queue order, provenance, persistence destinations, and returned
approval values remain unchanged.

## Data Flow and Lifecycle

1. Runtime events update existing controller state and transcript projection.
2. `TuiScreenModel` selects exactly one foreground surface.
3. Quiet Frame projects the screen, composer, status, and display metadata into
   stable semantic rows for the current viewport and accessibility mode.
4. The selected adapter renders only the frame it receives.
5. ANSI performs row/cell diff output; Ink renders the same ordered rows.

Renderer failure falls back to Ink without changing controller state or
transcript data. Mount, suspend, resume, resize, failure, and exit preserve
exactly-once raw-mode, cursor, alternate-screen, and listener cleanup.

Screen-reader mode always uses Ink, linearizes every meaningful label, does not
depend on cursor placement or color, and preserves current input announcements.

## Performance and Stability Budgets

- input echo p95 `< 50 ms`;
- normal fullscreen frame p95 `< 16.7 ms`, low-capability terminal `< 33 ms`;
- 120k-item transcript cold projection `< 100 ms`;
- single transcript append projection `< 5 ms`;
- resize settles within `100 ms`;
- no dropped, duplicated, or reordered streaming text;
- bounded visible-row projection and bounded failure excerpts;
- unchanged rows do not emit ANSI output.

## Error Handling

- Unsafe control characters are removed before they reach either adapter.
- Missing or malformed optional display data degrades to concise neutral text.
- Projection failures retain an English error row and do not mutate runtime
  state.
- ANSI initialization/draw failure switches to Ink for the current session.
- No fallback may silently approve a permission, submit input, or alter a
  stored permission rule.

## Test Strategy

- Pure tests: frame ordering, stable keys, breakpoints, tool disclosure,
  selection grammar, English permission copy, no-control-character invariant.
- Adapter parity: ANSI and Ink expose the same ordered semantic content.
- Focused Ink tests: permission, plan/question, composer/status, Team/Tasks/
  Audit, narrow widths, no-color, and screen-reader output.
- PTY: alternate screen, cursor/raw mode cleanup, resize, streaming, focused
  decisions, and ANSI-to-Ink fallback.
- Performance: cold projection, append, stable-row diff bytes, and streaming
  coalescing.
- Compatibility: existing interactive behavior tests and byte-identical native
  transcript behavior.

## Acceptance Gates

```sh
npm run test:tui:pty
npm run test:performance
npm run test:package
npm audit --omit=dev
npm run check
```

Manual terminal acceptance covers fresh/resumed sessions, long transcripts,
streaming, successful and failed tools, permission queue and settings, plan and
question decisions, Team/Tasks/Audit views, narrow terminal, no-color,
screen-reader, suspend/resume, and renderer fallback.
