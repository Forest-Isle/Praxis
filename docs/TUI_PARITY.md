# Claude-style TUI parity

## Goal

Reproduce Claude Code 2.1.208's observable single-user terminal presentation
and interaction in Praxis without copying Claude Code source. Keep
Praxis branding, provider neutrality, shared transcript compatibility, and
screen-reader output. Visual resemblance alone is not sufficient evidence for
interactive parity.

## Evidence baseline

The `~/dev/claude-code` 2.1.208 source snapshot is the authoritative command
and design inventory. Black-box captures from the pinned 2.1.208 executable
validate observable behavior, but do not define or limit the required surface.
Together they establish these stable rules:

- full terminal-width (up to 100 columns) bordered welcome card with
  product/version, identity, cwd, and a concise help area;
- conversation and composer remain separate regions;
- composer uses full-width horizontal rules and a `❯` prompt;
- entering `/` opens an unboxed, named, described, filterable command list
  rather than requiring users to remember the available slash commands;
- applicable local commands include direct `/add-dir`, response `/copy [N]`,
  native `/branch` and `/rename`, full-conversation `/export`, `/config`,
  `/usage`, `/mcp`, `/skill`, read-only shared `/hooks`, provider-backed
  `/compact`, native `/rewind`,
  runtime `/cd`, transcript-free `/btw` side questions, persistent
  `/background` terminal handoff, and live plugin/skill reload entries;
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

Account/billing text and hosted features are not native parity requirements.
Local release notes and status-line configuration remain in scope because they
are registered CLI commands in the authoritative source snapshot.

## State matrix

| State         | Observable Claude Code shape             | Praxis evidence                                              |
| ------------- | ---------------------------------------- | ------------------------------------------------------------ |
| Launch        | bordered identity/help card              | 2.1.208-parity border-title + 11-row `WelcomePanel` fixtures |
| Idle          | ruled `❯` composer plus mode footer      | component fixture and PTY gate                               |
| Streaming     | animated-status hierarchy above composer | runtime-event interaction tests                              |
| Slash command | filterable command name and description  | expanded catalog, selection, and PTY fixtures                |
| Help          | shortcut grid plus tabbed command lists  | component, keyboard, and PTY fixtures                        |
| Thinking      | live reasoning plus expandable retention | event, expansion, and redaction fixtures                     |
| Tool          | named call with indented input/result    | structured tool and diff fixtures                            |
| Shell         | ruled `!` composer and immediate result  | runtime, transcript, Ink, and PTY fixtures                   |
| Mentions      | mixed file and described agent entries   | catalog, Ink, interaction, and PTY fixtures                  |
| Editor        | suspended TUI plus external prompt file  | process, Ink, interaction, and PTY fixtures                  |
| Keybindings   | shared template and editor round trip    | black-box, parser, interaction, and PTY gates                |
| Clipboard     | cursor text/image paste with markers     | parser, interaction, image, and PTY fixtures                 |
| Suspend       | stopped shell job plus `fg` recovery     | process, busy-state, and zsh PTY fixtures                    |
| Diff          | source tabs, file list, patch drill-down | keyboard, component, and PTY fixtures                        |
| Permissions   | tabbed rules, search, scoped add flow    | settings, interaction, and PTY fixtures                      |
| Context       | usage grid and skill allocation          | transcript, interaction, and PTY fixtures                    |
| Status        | tabbed runtime/config/usage panels       | component, interaction, and PTY fixtures                     |
| Skills/tasks  | local list and background-task panels    | component, interaction, and PTY fixtures                     |
| Decision      | bordered, numbered choices               | permission/question/plan/MCP tests                           |
| Resume        | selectable list plus active history      | projection, picker, interaction, and Ink tests               |
| Export        | clipboard/file method and filename flow  | formatter, interaction, and PTY fixtures                     |
| Compact       | progress, marker, expandable summary     | service, projection, interaction, and PTY gates              |
| Rewind        | bounded checkpoints and restore actions  | native JSONL/file-history and interaction gates              |
| Cwd           | local result plus relocated session      | service, interaction, and installed PTY gates                |
| Side question | local history panel and Agent handoff    | black-box, service, Ink, and JSONL fixtures                  |
| Background    | blocked job handoff and terminal restore | black-box, manager, Ink, and PTY gate                        |
| Hooks         | read-only event/matcher/hook browser     | live Claude, projection, Ink, and PTY gates                  |
| Accessibility | decoration-free semantic text            | screen-reader fixture                                        |

## Architecture

`InteractiveApp` continues to own input and lifecycle state. Stateless
components under `src/cli/tui` render that state:

```text
RuntimeEvent -> interactive state -> transcript/dialog/composer components
shared JSONL -> active-chain display projection -> restored transcript state
shared extensions -> slash catalog -> command palette -> existing session service
runtime controls -> service retirement/recreation -> existing session service
/cd -> canonical cwd -> native session relocation -> recreated runtime service
/btw -> contextual provider call -> local panel -> optional native Agent sidechain
/background -> source-tail checkpoint -> blocked job -> idempotent fork on attach
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

- `WelcomePanel`: responsive product card and local-first help, with the
  version title embedded in the top border row and a fixed 11-row card,
  matching the Claude 2.1.208 launch frame.
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
- `/tui` switches between the default and fullscreen renderers, persists the
  Claude-compatible `tui` runtime setting, and resumes the active session after
  the renderer restart.
- `ContextUsageBlock`: transcript-native usage grid, autocompact reserve, and
  estimates for skills discovered through the shared Claude data plane.
- `ConfigDashboard`: the shared Status, Config, and Usage pane opened at the
  command-specific default tab by `/status`, `/config`, or `/usage`. Subscription
  account rows and the enterprise-only Gates tab stay outside the product boundary.
- `MemoryDashboard`: shared user/project instruction files, `@`-imported rows,
  `autoMemoryEnabled` state, and the canonical project auto-memory folder. The
  shared compatibility resolver owns recursive imports for both this view and
  provider context. File edits use the suspended editor lifecycle; the next
  turn reloads instructions without adding shared transcript fields.
- `ListDashboard`: shared presentation for `.claude` skills and local
  background task/workflow state.
- `HookDashboard`: read-only 2.1.208 event catalog with bounded event, matcher,
  and individual-hook views projected from fresh shared settings.
- `BtwPanel`: session-local side-question history with bounded answer scrolling,
  clipboard copy, history pruning, cancellation, and native background-Agent
  handoff.
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
  command result on add or cancellation. `/copy [N]` directly copies plain
  responses; fenced-code responses open a Full response/code-block/Always copy
  full response picker. Enter copies and also writes a best-effort fallback under
  the system temp `claude` directory, while `w` writes the focused item only.
  `/status`, `/config`, and `/usage` open the same three-tab pane at their matching
  default tab; `/mcp` lists current
  server status; `/skill` aliases the shared skill list; `/reload-skills` and
  `/reload-plugins` rebuild the active extension-backed service in place.
- `/hooks` opens the observed read-only event catalog. Arrow keys or 1-based
  numeric selection choose an event, scoped matcher, and configured command,
  prompt, agent, or HTTP hook; Enter drills through those layers into hook
  details, and Esc returns one level at a time. Counts, matcher scope,
  status-message labels, and source labels come from active
  user/project/local/plugin settings. Each open uses a fresh local projection
  for the current cwd and needs no provider key or model. The surface never
  rewrites shared settings.
- `/rename [name]` appends Claude-native title records; without a name it asks
  the active provider for a short kebab-case title. `/branch` forks the active
  native transcript, applies the observed ` (Branch)` title, switches the live
  session, and prints the original-session resume target. `/export` opens the
  observed clipboard/file chooser. Clipboard export contains the complete
  terminal-style conversation; file export adds a timestamped editable filename
  prompt and writes under the current working directory without changing JSONL.
- `/compact` runs the configured provider compactor with an interruptible
  progress panel, appends only native `compact_boundary` and compact-summary
  records, merges measured usage, and exposes the durable summary through
  `Ctrl+O`. `/rewind` opens a bounded, scrolling user-message checkpoint list.
  Its confirmation surface can restore code, fork conversation history, or do
  both; conversation forks are created before file restoration so a failed fork
  cannot partially rewind the workspace. Selective `from` and `up_to`
  summarization uses Claude-native `summarizeMetadata` and
  `preservedSegment`/`preservedMessages` UUID replay rather than private JSONL
  fields or serialized messages inside the summary.
- `/cd <path>` canonicalizes absolute, relative, home, and symlinked directory
  inputs, updates every cwd-sensitive TUI surface, and recreates the runtime
  service at the new directory. An active session moves to the corresponding
  shared project root under an exclusive lease and appends only Claude-native
  `relocated`, `system/local_command`, and cwd-change reminder records. Bare
  `/cd` persists the observed native usage pair; target collisions and invalid
  paths fail without changing the active cwd.
- `/btw <question>` asks the active provider with the current conversation
  context but no tools and never appends the answer or question to the main
  conversation JSONL. The command remains in shared `history.jsonl`; its local
  panel supports answer scrolling, left/right history selection, OSC 52 copy,
  and pruning. Esc cancels an in-flight answer. Pressing `f` on a completed answer
  launches the existing native background Agent path, appends the observed
  `system/local_command` pair, persists the Agent sidechain, and records native
  queue operations plus the task notification in the main transcript.
- `/background` rejects a session without a completed model turn using Claude's
  exact local result and three native user records. A completed conversation
  writes only shared input history, renders `Backgrounding…`, closes the
  foreground service, creates a new eight-hex job/session identity, restores the
  terminal, and prints `agents`/`attach`/`logs`/`stop` commands. The worker stays
  blocked without a provider turn; its private dispatch sidecar names the source
  session and active-tail checkpoint, and first attach lazily forks that Claude
  chain into the new job session before resuming it. A durable completion marker
  makes restart recovery idempotent even if the source later advances. The source
  transcript remains byte-for-byte unchanged, while the new transcript is
  resumable by either Claude or Praxis.
- `/model` restores the invocation default, presents distinct capability-aware
  provider choices, or accepts an explicit provider model ID. Enter applies the
  selection to the current session and persists it for future sessions; left/right
  adjusts effort. `/effort` selects `low`, `medium`, `high`,
  `xhigh`, or `max`. Each change retires the idle runtime service so the next
  turn receives the selected provider controls.
- `/theme` opens the observed built-in profile picker with Auto, dark/light,
  colorblind-friendly, and ANSI-only choices. Each choice renders its observed
  syntax-token and diff preview through the same semantic palette applied to the
  complete TUI. Selection recolors immediately, persists Claude's native
  `theme` value to shared user `settings.json`, preserves unrelated settings,
  and is restored before the next interactive render. `Ctrl+T` toggles and
  persists Claude's native `syntaxHighlightingDisabled` setting without leaving
  the picker or invoking a model turn. Per-key writes preserve untouched raw
  values and serialize cooperating Praxis processes with an advisory lease. A
  changed final pre-rename fingerprint triggers a bounded reread/merge/retry;
  atomic rename prevents partial files but is not an OS-level compare-and-swap,
  so a non-cooperating writer can still win the syscall window after that check.
  Custom profiles use Claude's `.claude/themes/<slug>.json` shape, persist
  `theme: "custom:<slug>"`, and support creation, token editing/reset, and
  deletion from the picker. Built-in profiles remain protected; custom sidecars
  are validated, leased, and atomically updated.
- `/terminal-setup` is a provider-free local command. It reports native
  Shift+Enter support for iTerm2, WezTerm, Ghostty, Kitty, and Warp; installs
  the Claude-compatible escape sequence in VS Code-family JSONC keybindings,
  Alacritty TOML, or Zed keymap files with backups and duplicate detection; and
  gives tmux, screen, unsupported, remote-IDE, and non-interactive contexts an
  actionable diagnostic with the backslash+Return fallback. Apple Terminal on
  macOS is handled with a preferences backup, default/startup profile updates,
  visual-bell configuration, and interrupted-setup recovery state.
- `/permissions` loads Claude-native permission arrays into Allow, Ask, Deny,
  and Workspace tabs. Recently denied is a process-local list of actual
  `automode-blocked` actions (newest first, duplicates retained); it opens
  first when non-empty and supports the native approve/retry footer. Rule
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
- `/context` appends a titled Claude-shaped context-usage block with model/token
  summary, 5×5 grid, estimated categories, free space, autocompact reserve,
  memory files, and skills without a model turn. `/status` opens the shared
  Status/Config/Usage pane, `/skills` lists entries from the
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

- focused Ink render fixtures at wide and narrow widths, including exact
  built-in syntax/diff preview palettes, persisted normal-render syntax state,
  and explicit focused-selection announcements in the decoration-free
  screen-reader branch;
- interaction tests for prompts, selection, permission, questions, plan, MCP,
  streaming, tools, direct shell turns, cancellation, and screen-reader mode;
- PTY installed-package capture proving borders, composer, mode footer, bare
  `?` shortcuts, `/` discovery, control-key clearing, `/diff` drill-down,
  context/status/skill dashboards, built-in `/theme` selection, `Ctrl+T` syntax
  toggling, immediate profile application to transcript code and diffs,
  cancellation, restart persistence, and shared settings persistence; plus real
  fixed Claude Code 2.1.208 `/theme` ANSI captures for every built-in profile,
  `Ctrl+T` task access, exact permission rule
  deletion and Workspace add/remove surfaces, providerless `/hooks`
  scope coverage plus installed event/matcher/detail navigation, and `/memory`
  discovery, loading/final hierarchy, imported-file `$EDITOR` lifecycle,
  auto-memory folder-launch sentinel, next-turn provider reload, and recursive
  shared-tree path/type/content no-write snapshot around cancellation with exact
  runtime transcript/lock exclusion and sibling-JSONL mutation detection,
  `Ctrl+G` terminal suspension/edit/redraw, `/keybindings` shared template/editor
  creation, installed-package `Ctrl+V` text paste, and a real zsh
  `Ctrl+Z`/`jobs`/`fg` stop-and-resume cycle with composer retention, plus
  installed-package `!pwd` execution, provider continuation, direct `/add-dir`
  cancellation, `/copy` response output, `/rename`, `/branch`, complete
  `/export` clipboard output, and native transcript tags;
- pinned Claude 2.1.208 and Praxis headless provider-request capture proving inline,
  escaped-space, recursive, depth-four, dedupe/cycle, code/missing boundaries,
  plus next-turn reload after an imported file changes;
  installed-package `/compact` completion and `/rewind` menu gates, interaction
  cancellation coverage, plus native selective-summary projection and
  preserved-message replay, and installed-package `/cd` relocation plus
  post-change `!pwd` execution; `/btw` usage, streaming/history/copy/cancel/fork
  interaction coverage, native sidechain and queue-notification persistence,
  and captured 2.1.208 JSONL records; `/background` empty/success/failure Ink
  coverage plus a live Claude/Praxis PTY handoff, blocked-state, lazy-fork,
  unchanged-source, provider-context, and cross-resume gate;
- full `npm run check`, package regression, and performance budgets;
- parity matrix must not say full interactive parity is complete until every
  state above has executable evidence.

## Remaining interactive parity work

The Stage TUI-1/2/3/4/5/6/7/8/9 controls close the slash presentation, help/shortcut,
searchable-resume, thinking, composer, runtime-control, measured-status,
tool-detail, current/per-turn diff-navigation, context/status/skill/task panels,
plan switching, prompt stash, continuation, file/agent-reference, undo, and
direct shell seams, but they do not justify a blanket “complete Claude Code
TUI” claim. Subsequent stages close
`/terminal-setup` diagnostics/setup (Stage 119/123), `/tui` default/fullscreen
renderer switching with persisted runtime settings and active-session resume
(Stage 125), and exact
denied-history selection, duplicate retention, lifetime, approve/retry, and
Claude-native grant-transcript behavior (Stages 126-130). Stage 132 revalidates
command-specific dialogs directly against the `~/dev/claude-code` 2.1.208 source
snapshot and then cross-checks observable behavior through Ink/PTY gates.
`/statusline` remains excluded as
a user-provided status-line plugin surface; 2.1.208 exposes neither `/vim` nor
`/output-style`. Each included item needs an observed contract and a focused TTY
or Ink gate before the matrix can return to a complete status.
