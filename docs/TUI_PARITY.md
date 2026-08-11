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
- applicable local commands include direct `/add-dir`, response `/copy [N]`,
  native `/branch` and `/rename`, full-conversation `/export`, `/config`,
  `/usage`, `/mcp`, `/skill`, and live plugin/skill reload entries;
- permission mode, shortcut hint, and model effort share the footer row;
- entering `?` on an empty composer immediately opens the shortcut grid;
- entering `!` switches the composer to shell mode; submitting runs the command
  first, renders an indented result, and then continues the model turn;
- entering `@` mixes workspace paths with available agents; agent rows include
  their description and selection inserts Claude's quoted agent mention;
- `Ctrl+G` suspends Ink, opens `$VISUAL`, `$EDITOR`, or `vi` with the exact
  composer bytes, then restores and redraws the terminal;
- `/keybindings` creates the observed 2.1.208 template when absent and opens the
  shared Claude config-root file in the same external-editor lifecycle;
- `Ctrl+V` briefly shows `Pasting…`, inserts clipboard text at the real cursor,
  and represents clipboard images as monotonic `[Image #N]` composer markers;
- `Ctrl+Z` releases the terminal, prints the branded suspend/`fg` notice, and
  stops the shell job; `fg` redraws the TUI with in-memory state intact;
- tool calls use `⏺`, results use an indented `⎿`, long output keeps three
  lines before an expandable remainder count, and edits retain inline diffs;
- resumed sessions project the active Claude transcript branch into the TUI;
  consecutive successful reads collapse to `Read N files` and `Ctrl+O`
  restores each file/result pair without changing shared JSONL;
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

| State         | Observable Claude Code shape             | Praxis evidence                                |
| ------------- | ---------------------------------------- | ---------------------------------------------- |
| Launch        | bordered identity/help card              | wide and narrow `WelcomePanel` fixtures        |
| Idle          | ruled `❯` composer plus mode footer      | component fixture and PTY gate                 |
| Streaming     | animated-status hierarchy above composer | runtime-event interaction tests                |
| Slash command | filterable command name and description  | expanded catalog, selection, and PTY fixtures  |
| Help          | shortcut grid plus tabbed command lists  | component, keyboard, and PTY fixtures          |
| Thinking      | live reasoning plus expandable retention | event, expansion, and redaction fixtures       |
| Tool          | named call with indented input/result    | structured tool and diff fixtures              |
| Shell         | ruled `!` composer and immediate result  | runtime, transcript, Ink, and PTY fixtures     |
| Mentions      | mixed file and described agent entries   | catalog, Ink, interaction, and PTY fixtures    |
| Editor        | suspended TUI plus external prompt file  | process, Ink, interaction, and PTY fixtures    |
| Keybindings   | shared template and editor round trip    | black-box, parser, interaction, and PTY gates  |
| Clipboard     | cursor text/image paste with markers     | parser, interaction, image, and PTY fixtures   |
| Suspend       | stopped shell job plus `fg` recovery     | process, busy-state, and zsh PTY fixtures      |
| Diff          | source tabs, file list, patch drill-down | keyboard, component, and PTY fixtures          |
| Permissions   | tabbed rules, search, scoped add flow    | settings, interaction, and PTY fixtures        |
| Context       | usage grid and skill allocation          | transcript, interaction, and PTY fixtures      |
| Status        | tabbed runtime/config/usage panels       | component, interaction, and PTY fixtures       |
| Skills/tasks  | local list and background-task panels    | component, interaction, and PTY fixtures       |
| Decision      | bordered, numbered choices               | permission/question/plan/MCP tests             |
| Resume        | selectable list plus active history      | projection, picker, interaction, and Ink tests |
| Export        | clipboard/file method and filename flow  | formatter, interaction, and PTY fixtures       |
| Accessibility | decoration-free semantic text            | screen-reader fixture                          |

## Architecture

`InteractiveApp` continues to own input and lifecycle state. Stateless
components under `src/cli/tui` render that state:

```text
RuntimeEvent -> interactive state -> transcript/dialog/composer components
shared JSONL -> active-chain display projection -> restored transcript state
shared extensions -> slash catalog -> command palette -> existing session service
runtime controls -> service retirement/recreation -> existing session service
Git worktree ----> read-only diff snapshots ------> diff dashboard
keyboard input -------------------> existing callbacks and session service
`!` command -> direct runtime Bash -> native bash user records -> model turn
`@` agent -> quoted mention -> ephemeral invocation reminders -> model turn
Ctrl+G -> terminal suspension -> external editor -> composer replacement/undo
/keybindings -> shared config-root JSON -> external editor -> live action reload
Ctrl+V -> OS clipboard -> text or ModelImage -> composer -> existing session service
Ctrl+Z -> terminal release -> SIGTSTP -> shell job -> fg/SIGCONT -> full redraw
```

No React or Ink dependency enters core, application, providers, tools, or
persistence. TUI-only metadata (version, cwd, model, effort, permission mode)
is passed from the CLI composition root and never written to shared JSONL.

## Components

- `WelcomePanel`: responsive product card and local-first help.
- `SessionPicker`: selected-row hierarchy, local search, and bounded session
  identity behind the Claude-compatible `/resume` name (`/sessions` remains a
  hidden compatibility alias).
- `Transcript`: user/assistant/tool/shell/result/notice/warning and operational
  lifecycle presentation, with grouped results, compact long output, inline
  edit replacements, and global detailed expansion.
- `DiffDashboard`: current and file-mutating-turn snapshot tabs, file selection,
  and bounded patch scrolling. `git-diff` loads worktree state with path-safe
  argument arrays and never writes repository state.
- `CommandPalette`: bounded, keyboard-selectable list of built-in controls and
  shared commands, skills, and MCP prompts.
- `MentionPicker`: bounded, filterable workspace paths and shared agent
  definitions. Files retain `+ path`; agents render as
  `* name (agent) – description` and insert Claude's quoted mention syntax.
- `ShortcutHelp` and `HelpMenu`: immediate empty-composer shortcut grid plus
  General, Commands, and Custom commands tabs.
- `Composer`: prompt or `!` shell mode, cursor, history, clipboard text/image
  markers, effort, permission mode, busy state, measured context/cost status,
  and keyboard help.
- `ExternalEditorWait`: terminal-suspension handoff status with a semantic
  screen-reader branch; `external-editor` owns command parsing and private
  temporary prompt-file lifecycle.
- `SelectionMenu`: reusable model, effort, and permission-rule scope chooser.
- `conversation-export`: terminal-style, complete in-memory transcript
  projection for native clipboard and cwd-relative file export; it never writes
  an export entry or Praxis-only field into shared JSONL.
- `PermissionDashboard`: Recently denied, Allow, Ask, Deny, and Workspace tabs;
  scoped rule search and atomic creation/removal; original/additional workspace
  directory presentation; and session-local directory add/remove controls.
- `ContextUsageBlock`: transcript-native usage grid, autocompact reserve, and
  estimates for skills discovered through the shared Claude data plane.
- `StatusDashboard`: Settings, Status, Config, Usage, and Stats tabs backed by
  the current local runtime state.
- `ListDashboard`: shared presentation for `.claude` skills and local
  background task/workflow state.
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
  turn, then restores user/assistant/thinking/tool/result/shell history from the
  selected active JSONL branch. `--resume-session-at` truncates that display at
  the same selected message used by runtime continuation. The old `/sessions`
  spelling remains accepted but is not advertised.
- `/add-dir` opens the observed path/completion surface directly and returns a
  command result on add or cancellation. `/copy [N]` writes the selected prior
  assistant response through the native OS clipboard without a model turn.
  `/config` and `/usage` open their matching status tabs; `/mcp` lists current
  server status; `/skill` aliases the shared skill list; `/reload-skills` and
  `/reload-plugins` rebuild the active extension-backed service in place.
- `/rename [name]` appends Claude-native title records; without a name it asks
  the active provider for a short kebab-case title. `/branch` forks the active
  native transcript, applies the observed ` (Branch)` title, switches the live
  session, and prints the original-session resume target. `/export` opens the
  observed clipboard/file chooser. Clipboard export contains the complete
  terminal-style conversation; file export adds a timestamped editable filename
  prompt and writes under the current working directory without changing JSONL.
- `/model` retains the current model, restores the invocation default, or accepts
  an explicit provider model ID. `/effort` selects `low`, `medium`, `high`,
  `xhigh`, or `max`. Each change retires the idle runtime service so the next
  turn receives the selected provider controls.
- `/permissions` loads Claude-native permission arrays into Recently denied,
  Allow, Ask, Deny, and Workspace tabs, opening on Allow like 2.1.208. Rule
  search is local; adding a rule chooses `.claude/settings.local.json`,
  checked-in `.claude/settings.json`, or user `settings.json`. Selecting an
  existing rule opens the observed allowed/ask/denied deletion confirmation.
  Both mutations preserve unrelated settings, use atomic compare-before-commit
  writes, retain Claude's empty arrays, and retire the active service so the
  next turn reloads policy. Workspace shows the immutable original cwd and
  numbered `--add-dir` roots; Tab-completed canonical directories can be added
  or removed for the current interactive runtime. `Shift+Tab` remains the
  permission-mode control and writes native `permission-mode` records.
- The composer edits at its real Unicode code-point cursor. It supports arrow
  movement, Meta-word movement, `Ctrl+A/E/B/F/W/U/K`, backspace/delete,
  multiline `Shift+Enter`, submitted-prompt history, and bounded edit undo with
  `Ctrl+Shift+_`. Typing `@` opens the mixed file/agent picker; Enter or Tab
  replaces only the active reference. Agent selection inserts
  `@"name (agent)"`. The first `Ctrl+C` clears input and asks for confirmation;
  the second exits.
- Submitted agent mentions retain their original user text and inject only
  ephemeral invocation and available-agent reminders into the provider request.
  Those reminders participate in context budgets and compaction, remain stable
  through tool-loop reloads, and never enter the shared append-only JSONL.
- `Ctrl+G` opens `$VISUAL` before `$EDITOR` and otherwise falls back to `vi`.
  The editor receives a private Markdown prompt file as its final argument.
  Praxis releases Ink's raw mode, alternate screen, cursor, and input ownership
  while it runs, then forces a redraw. Successful edits replace the composer
  without trimming any leading/trailing whitespace and participate in existing
  `Ctrl+Shift+_` undo; non-zero exits preserve the original composer and show
  the editor's executable name and exit code. Prompt files are always removed.
- `/keybindings` resolves `keybindings.json` under `CLAUDE_CONFIG_DIR` (or
  `~/.claude`), creates the byte-for-byte observed Claude Code 2.1.208 template
  with private permissions only when absent, and opens that authoritative file
  directly without a temporary copy. Existing content is never overwritten.
  Closing the editor reloads the shared file; partial context overrides merge
  with defaults, `null` explicitly unbinds a chord, supported Chat/Global
  actions can be rebound, and two-stroke sequences such as `Ctrl+X Ctrl+E`
  retain their Claude action names. Invalid JSON is reported without replacing
  the last valid in-memory bindings.
- `Ctrl+V` reads the native OS clipboard without a shell. Text is inserted at
  the live Unicode cursor after the observed `Pasting…` state. Images become
  monotonic `[Image #N]` markers; adjacent images receive the observed separator,
  cursor movement and backspace/delete treat each marker atomically, and
  `Ctrl+Shift+_` can undo a paste without reusing its number. Submission filters
  live markers in prompt order and forwards their existing `ModelImage` values
  through `SessionService`, provider projection, and native Claude content
  blocks. Private image bytes never enter a Praxis-only transcript field.
- `Ctrl+Z` is global across idle, busy, and decision surfaces. Praxis first
  flushes the current frame, releases raw mode, bracketed paste, cursor, and
  keyboard-protocol ownership, prints the observed two-line suspend/undo notice
  with Praxis branding, then sends `SIGTSTP` to its own process. A shell `fg`
  supplies `SIGCONT`; Ink reclaims the terminal and forces a full redraw without
  recreating a session, model service, composer, menu, or active turn.
- A leading `!` enters the distinct shell composer. Submission executes `Bash`
  through the active tool preparation, permission approval, cancellation, and
  PreToolUse/PostToolUse Hook chain, renders `! command` plus its bounded
  `⎿` output, then continues the provider turn. Successful turns append only
  Claude-native `<bash-input>`, `<bash-stdout>`, and `<bash-stderr>` user
  records; no synthetic assistant tool call or Praxis-only transcript field is
  introduced. Esc cancels the child process, avoids a partial shell record, and
  restores the command to the shell composer.
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
- `/context` appends a Claude-shaped context-usage block without a model turn.
  `/status` opens tabbed local runtime details, `/skills` lists entries from the
  existing shared skill catalog, and `/tasks` opens the existing workflow/task
  state; `/workflows` remains a hidden legacy alias. `/plan` switches the
  existing permission runtime into plan mode.
- `Ctrl+T` opens tasks, Option+P opens model selection, and `Ctrl+S` stashes or
  restores the current prompt. Double Esc clears the composer, while a trailing
  backslash plus Return inserts a newline without submitting.
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
  streaming, tools, direct shell turns, cancellation, and screen-reader mode;
- PTY installed-package capture proving borders, composer, mode footer, bare
  `?` shortcuts, `/` discovery, control-key clearing, `/diff` drill-down,
  context/status/skill dashboards, `Ctrl+T` task access, file and agent `@`
  selection, exact permission rule deletion and Workspace add/remove surfaces,
  `Ctrl+G` terminal suspension/edit/redraw, `/keybindings` shared template/editor
  creation, installed-package `Ctrl+V` text paste,
  control-code undo, and a real zsh
  `Ctrl+Z`/`jobs`/`fg` stop-and-resume cycle with composer retention, plus
  installed-package `!pwd` execution, provider continuation, direct `/add-dir`
  cancellation, `/copy` response output, `/rename`, `/branch`, complete
  `/export` clipboard output, and native transcript tags;
- full `npm run check`, package regression, and performance budgets;
- parity matrix must not say full interactive parity is complete until every
  state above has executable evidence.

## Remaining interactive parity work

The Stage TUI-1/2/3/4/5/6/7/8/9 controls close the slash presentation, help/shortcut,
searchable-resume, thinking, composer, runtime-control, measured-status,
tool-detail, current/per-turn diff-navigation, context/status/skill/task panels,
plan switching, prompt stash, continuation, file/agent-reference, undo, and
direct shell seams, but they do not justify a blanket “complete Claude Code
TUI” claim. Remaining
black-box-driven work includes the remaining applicable built-in command catalog
(`/background`, `/btw`, `/cd`, `/compact`, `/hooks`, `/memory`, `/rewind`, and
presentation controls), exact denied-history
behavior, and remaining exact command-specific dialogs and layout behavior. Each
item needs an observed contract and a
focused TTY or Ink gate before the matrix can return to a complete status.
