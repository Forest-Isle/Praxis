# Stage 25 - Native worktrees

## Goal

Add Claude Code 2.1.208-compatible `EnterWorktree`, `ExitWorktree`, CLI
`--worktree`, iTerm2 native panes, and classic tmux launch behavior without introducing another
workspace or session data plane.

## Chosen design

Keep three boundaries separate:

1. Session identity selects authoritative transcript location when a session is
   opened.
2. Active workspace selects tool, hook, subagent, Workflow, and context cwd.
3. Canonical main-repository identity selects shared auto-memory.

This preserves dynamic EnterWorktree transcripts under their original project,
while CLI `--worktree` sessions start under the worktree project path. Memory
continues to resolve through the Git common directory.

## Observable contract

- Native worktrees live at `<repo>/.praxis/worktrees/<name>`. Praxis has one
  worktree layout; there is no alternate Claude data-plane location.
- Created branches use `worktree-<name>` with `/` normalized to `-`.
- Names are at most 64 characters and contain slash-separated segments made of
  letters, digits, dots, underscores, and dashes.
- `EnterWorktree` accepts either optional `name` or optional `path`, never both.
- Missing `name` generates a collision-resistant local name.
- `path` must be a registered worktree owned by the current repository and
  located under the active data plane's worktrees directory.
- `ExitWorktree` requires `action: keep | remove`; `discard_changes` only
  applies to remove.
- Remove refuses dirty or unmerged work unless `discard_changes: true`.
- Existing worktrees entered by path can be kept but are never removed.
- Exit outside an active worktree is a successful no-op.
- Enter/exit results persist Claude-native `toolUseResult` objects.
- Each state transition appends a Claude-native `worktree-state` entry.
- `--worktree [name]` creates and enters before the first transcript entry.
- `--tmux` requires `--worktree`, uses a native iTerm2 split pane when available,
  and falls back to one detached classic tmux session in other terminals.
- `--tmux=classic` always forces traditional tmux. Native pane commands use an
  explicit cwd, parameterized AppleScript, and shell-quoted child arguments.

## Architecture

`SessionWorktreeManager` owns Git lifecycle and one active transition. A shared
`WorkspaceContext` exposes current cwd without changing process-global cwd.
Local tools, permissions, context assembly, and session translation read that
context at execution time.

`ClaudeWorktreeToolRegistry` wraps the existing tool registry. It delegates all
existing tools and owns only EnterWorktree/ExitWorktree validation and
execution. Session service appends pending worktree-state before the matching
tool result so transcript order matches Claude.

Session service pins transcript cwd on first open. Initial CLI worktree entry
happens before pinning; dynamic tool entry happens after pinning.

## Errors

- Non-Git creation fails without modifying workspace state.
- Invalid/colliding names and unregistered paths fail before Git mutation.
- Partial creation attempts remove the newly-created worktree and branch when
  possible, preserving the primary error.
- Failed removal retains active state and reports dirty files/commit counts.
- Service close keeps active worktrees; explicit remove remains user-controlled.
- osascript/tmux errors and invalid pane IDs surface directly and never start a
  second foreground agent.

## Tests

- Unit: name/path validation, create, keep, clean remove, guarded dirty/unmerged
  remove, forced remove, no-op exit, state transition ordering.
- Tool: exact normalized Claude schemas, delegation, native results, permission
  defaults, dynamic local-tool cwd.
- CLI: option parsing, validation, option-only TTY, initial transcript path,
  native/classic/fallback routing, cwd and control-character-safe forwarding.
- Compatibility: live Claude schema capture, Claude -> Praxis resume, Praxis ->
  Claude resume, native worktree layout/transcript state, and packed fake
  osascript/tmux launcher gate.
- Regression: full check, package write matrix, core compatibility gates, and
  performance budgets.
