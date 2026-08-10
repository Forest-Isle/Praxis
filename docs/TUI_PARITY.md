# Claude-style TUI parity

## Goal

Reproduce Claude Code 2.1.208's observable single-user terminal presentation
and interaction in Praxis without reading or copying Claude Code source. Keep
Praxis branding, provider neutrality, shared transcript compatibility, and
screen-reader output. Visual resemblance alone is not sufficient evidence for
interactive parity.

## Evidence baseline

Black-box capture at 100 x 32 columns establishes these stable visual rules:

- full terminal-width (up to 100 columns) bordered welcome card with
  product/version, identity, cwd, and a concise help area;
- conversation and composer remain separate regions;
- composer uses full-width horizontal rules and a `❯` prompt;
- entering `/` opens an unboxed, named, described, filterable command list
  rather than requiring users to remember the available slash commands;
- permission mode, shortcut hint, and model effort share the footer row;
- entering `?` on an empty composer immediately opens the shortcut grid;
- tool calls use `⏺`, results use an indented `⎿`, long output keeps three
  lines before an expandable remainder count, and edits retain inline diffs;
- `/diff` opens a current/per-turn source dashboard with file selection and a
  scrollable patch view;
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
| Help          | shortcut grid plus tabbed command lists  | component, keyboard, and PTY fixtures    |
| Thinking      | live reasoning plus expandable retention | event, expansion, and redaction fixtures |
| Tool          | named call with indented input/result    | structured tool and diff fixtures        |
| Diff          | source tabs, file list, patch drill-down | keyboard, component, and PTY fixtures    |
| Decision      | bordered, numbered choices               | permission/question/plan/MCP tests       |
| Resume        | bounded selectable conversation list     | picker interaction and viewport tests    |
| Accessibility | decoration-free semantic text            | screen-reader fixture                    |

## Architecture

`InteractiveApp` continues to own input and lifecycle state. Stateless
components under `src/cli/tui` render that state:

```text
RuntimeEvent -> interactive state -> transcript/dialog/composer components
shared extensions -> slash catalog -> command palette -> existing session service
runtime controls -> service retirement/recreation -> existing session service
Git worktree ----> read-only diff snapshots ------> diff dashboard
keyboard input -------------------> existing callbacks and session service
```

No React or Ink dependency enters core, application, providers, tools, or
persistence. TUI-only metadata (version, cwd, model, effort, permission mode)
is passed from the CLI composition root and never written to shared JSONL.

## Components

- `WelcomePanel`: responsive product card and local-first help.
- `SessionPicker`: selected-row hierarchy, local search, and bounded session
  identity behind the Claude-compatible `/resume` name (`/sessions` remains a
  hidden compatibility alias).
- `Transcript`: user/assistant/tool/result/notice/warning and operational
  lifecycle presentation, with grouped tool/result rendering, compact long
  output, inline edit replacements, and global detailed expansion.
- `DiffDashboard`: current and file-mutating-turn snapshot tabs, file selection,
  and bounded patch scrolling. `git-diff` loads worktree state with path-safe
  argument arrays and never writes repository state.
- `CommandPalette`: bounded, keyboard-selectable list of built-in controls and
  shared commands, skills, and MCP prompts.
- `ShortcutHelp` and `HelpMenu`: immediate empty-composer shortcut grid plus
  General, Commands, and Custom commands tabs.
- `Composer`: prompt, cursor, history, effort, mode, busy state, measured
  context/cost status, and keyboard help.
- `SelectionMenu`: reusable model, effort, and permission-mode chooser; it
  does not replace the full Claude Code permission-rule dashboard.
- `DialogFrame`: shared bordered surface used by permission, question, plan,
  recovery, and elicitation decisions.
- screen-reader branches: semantic text-only rendering through the same state.

## Interaction rules

- `/` opens a filterable palette. Up/down select, Tab fills the selected command
  into the composer, and an exact command runs through the existing local or
  shared-command path. The catalog is read from the existing Claude command,
  skill, and MCP prompt discovery rather than duplicated into a Praxis store.
- `?` toggles the shortcut grid only when the normal composer is empty.
  `/help` opens the same shortcuts with separate built-in and shared-command
  tabs. `/resume` filters native session names, prompts, and IDs without a model
  turn; the old `/sessions` spelling remains accepted but is not advertised.
- `/model` retains the current model, restores the invocation default, or accepts
  an explicit provider model ID. `/effort` selects `low`, `medium`, `high`,
  `xhigh`, or `max`. Each change retires the idle runtime service so the next
  turn receives the selected provider controls.
- `/permissions` selects the active session mode. Once a session exists, Praxis
  appends the native Claude-compatible `permission-mode` record under the
  transcript lease before the next turn; it stores no Praxis-only transcript
  fields. `Shift+Tab` cycles the same local mode set.
- The composer edits at its real Unicode code-point cursor. It supports arrow
  movement, Meta-word movement, `Ctrl+A/E/B/F/W/U/K`, backspace/delete,
  multiline `Shift+Enter`, and submitted-prompt history. The first `Ctrl+C`
  clears input and asks for confirmation; the second exits.
- Existing `/new`, `/clear`, `/resume`, `/workflows`, `/exit`, resume,
  scheduled prompt, cancellation, permission, plan, question, and elicitation
  behavior is unchanged.
- Active thinking renders in full as it streams. Retained thinking is compact
  until `Ctrl+O` expands the detailed transcript; the same global toggle expands
  long tool output. Screen-reader output exposes full text. The renderer redacts
  sensitive values in both tool headings and result bodies before display.
- Tool calls retain structured name/input long enough to render Claude-shaped
  Read, Bash, and Update entries. Successful long results keep three lines and
  an exact hidden-line count; failures remain prominent; edits show replacement
  line summaries without adding fields to shared transcripts.
- `/diff` reads `git diff HEAD` without a model turn. Left/right switches
  Current and captured file-mutating-turn sources, up/down selects or scrolls,
  Enter drills into a file, and Esc returns or closes the dashboard.
- ASCII control codes and Ink control-key metadata are both accepted for
  composer navigation, while unrelated non-printable bytes are never inserted.
- Permission policy, MCP elicitation completion, and hook lifecycle events
  remain visible as compact operational feedback.
- Streaming text is rendered once and replaced by the completed assistant turn.
- Empty input shows a suggestion; typed input never gets replaced.
- Per-turn cost comes from the actual model result; context capacity comes from
  the active provider capability rather than a TUI constant.
- Terminal resize changes layout only, never session or input state.

## Verification

- focused Ink render fixtures at wide and narrow widths;
- interaction tests for prompts, selection, permission, questions, plan, MCP,
  streaming, tools, cancellation, and screen-reader mode;
- PTY installed-package capture proving borders, composer, mode footer, bare
  `?` shortcuts, `/` discovery, control-key clearing, and `/diff` drill-down;
- full `npm run check`, package regression, and performance budgets;
- parity matrix must not say full interactive parity is complete until every
  state above has executable evidence.

## Remaining interactive parity work

The Stage TUI-1/2/3/4 controls close the slash presentation, help/shortcut,
searchable-resume, thinking, composer, runtime-control, measured-status,
tool-detail, and current/per-turn diff-navigation seams, but they do not justify
a blanket “complete Claude Code TUI” claim. Remaining black-box-driven work
includes the full built-in command catalog and its command-specific dialogs,
the permission-rule dashboard (rules, tabs, search, and settings editing), exact
multi-read grouping and historical turn attribution, and remaining exact
layout/shortcut behavior. Each item needs an observed contract and a focused
TTY or Ink gate before the matrix can return to a complete status.
