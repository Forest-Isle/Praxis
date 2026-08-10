# Claude-style TUI parity

## Goal

Reproduce Claude Code 2.1.208's observable single-user terminal presentation
and interaction in Praxis without reading or copying Claude Code source. Keep
Praxis branding, provider neutrality, shared transcript compatibility, and
screen-reader output. Visual resemblance alone is not sufficient evidence for
interactive parity.

## Evidence baseline

Black-box capture at 100 x 32 columns establishes these stable visual rules:

- capped-width bordered welcome card with product/version, identity, cwd, and a
  concise help area;
- conversation and composer remain separate regions;
- composer uses full-width horizontal rules and a `❯` prompt;
- entering `/` opens a named, described, filterable command list rather than
  requiring users to remember the available slash commands;
- model effort appears above the composer; permission mode and shortcuts appear
  below it;
- user, assistant, tool, warning, permission, question, plan, hook/MCP
  lifecycle, and busy states have distinct hierarchy rather than sharing one
  plain text style;
- narrow terminals collapse optional welcome content before core controls;
- screen-reader mode removes decorative boxes, animation, and visual-only help.

Dynamic release notes, account/billing text, hosted features, and user-provided
status-line plugins are not native parity requirements.

## State matrix

| State         | Observable Claude Code shape             | Praxis evidence                          |
| ------------- | ---------------------------------------- | ---------------------------------------- |
| Launch        | bordered identity/help card              | wide and narrow `WelcomePanel` fixtures  |
| Idle          | ruled `❯` composer plus mode footer      | component fixture and PTY gate           |
| Streaming     | animated-status hierarchy above composer | runtime-event interaction tests          |
| Slash command | filterable command name and description  | palette, selection, and PTY fixtures     |
| Thinking      | live reasoning plus expandable retention | event, expansion, and redaction fixtures |
| Tool          | named call with indented input/result    | structured tool and diff fixtures        |
| Decision      | bordered, numbered choices               | permission/question/plan/MCP tests       |
| Resume        | bounded selectable conversation list     | picker interaction and viewport tests    |
| Accessibility | decoration-free semantic text            | screen-reader fixture                    |

## Architecture

`InteractiveApp` continues to own input and lifecycle state. Stateless
components under `src/cli/tui` render that state:

```text
RuntimeEvent -> interactive state -> transcript/dialog/composer components
shared extensions -> slash catalog -> command palette -> existing session service
keyboard input -------------------> existing callbacks and session service
```

No React or Ink dependency enters core, application, providers, tools, or
persistence. TUI-only metadata (version, cwd, model, effort, permission mode)
is passed from the CLI composition root and never written to shared JSONL.

## Components

- `WelcomePanel`: responsive product card and local-first help.
- `SessionPicker`: selected-row hierarchy and bounded session identity.
- `Transcript`: user/assistant/tool/result/notice/warning and operational
  lifecycle presentation, with retained thinking collapsed by default and
  expandable in place.
- `CommandPalette`: bounded, keyboard-selectable list of built-in controls and
  shared commands, skills, and MCP prompts.
- `Composer`: prompt, effort, mode, busy state, and keyboard help.
- `DialogFrame`: shared bordered surface used by permission, question, plan,
  recovery, and elicitation decisions.
- screen-reader branches: semantic text-only rendering through the same state.

## Interaction rules

- `/` opens a filterable palette. Up/down select, Tab fills the selected command
  into the composer, and an exact command runs through the existing local or
  shared-command path. The catalog is read from the existing Claude command,
  skill, and MCP prompt discovery rather than duplicated into a Praxis store.
- Existing `/new`, `/clear`, `/sessions`, `/workflows`, `/exit`, resume,
  scheduled prompt, cancellation, permission, plan, question, and elicitation
  behavior is unchanged.
- Active thinking renders in full as it streams. Retained thinking is compact
  until `Ctrl+O` expands it; screen-reader output exposes the full text. The
  renderer redacts values already classified as sensitive before display.
- Tool calls retain structured name/input long enough to render a tool card.
- Successful tool results are visible but compact; failures remain prominent.
- Permission policy, MCP elicitation completion, and hook lifecycle events
  remain visible as compact operational feedback.
- Streaming text is rendered once and replaced by the completed assistant turn.
- Empty input shows a suggestion; typed input never gets replaced.
- Terminal resize changes layout only, never session or input state.

## Verification

- focused Ink render fixtures at wide and narrow widths;
- interaction tests for prompts, selection, permission, questions, plan, MCP,
  streaming, tools, cancellation, and screen-reader mode;
- PTY installed-package capture proving borders, composer, mode footer, and
  clean exit, plus `/` command-palette discovery;
- full `npm run check`, package regression, and performance budgets;
- parity matrix must not say full interactive parity is complete until every
  state above has executable evidence.

## Remaining interactive parity work

The Stage TUI-1 palette and thinking controls close the previously missing
interaction seam, but they do not justify a blanket “complete Claude Code TUI”
claim. Remaining black-box-driven work includes native picker/menu coverage for
model and permission changes, command-specific interactive controls, editor
history and cursor shortcuts, tool/diff expansion navigation, and richer
context/cost status. Each item needs an observed contract and a focused TTY or
Ink gate before the matrix can return to a complete status.
