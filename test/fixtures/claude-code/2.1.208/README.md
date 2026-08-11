# Claude Code 2.1.208 fixtures

Fixtures were captured by running the installed `claude` CLI against an
isolated temporary `CLAUDE_CONFIG_DIR`, then replacing session IDs, message IDs,
paths, timestamps, token counts, and human text with deterministic values.

- `basic-session.jsonl`: text user/assistant envelope plus physical
  `last-prompt` metadata tail.
- `tool-session.jsonl`: Bash `tool_use` and matching user `tool_result`
  envelope, including `sourceToolAssistantUUID` and `toolUseResult`.
- `compact-session.jsonl`: manual `compact_boundary` and compact-summary pair.
- `selective-compact-session.jsonl`: observed `from` and `up_to` manual
  summary metadata with native preserved UUID segments.
- `cd-records.jsonl`: exact `/cd` excerpt with `relocated`, paired
  `system/local_command` records, and the cwd-change system reminder.
- `btw-records.jsonl`: bare usage, fork handoff, queue operations, and the
  native background task notification produced by `/btw`.
- `btw-fresh-records.jsonl`: fresh-TUI session initialization, bare `/btw`
  usage pair, and its native `last-prompt` metadata tail.
- `background-empty-records.jsonl`: fresh-session initialization plus the
  three native user records emitted when `/background` has no model turn.
- `sidechain-layout/`: valid main session plus native
  `<session-id>/subagents/agent-*.jsonl` entries with `isSidechain`, `agentId`,
  and attribution metadata.
- `media-error-session.jsonl`: image result and non-zero Bash error result.
- `interrupted-session.jsonl`: Ctrl-C tool rejection and interruption message.

They contain no Claude Code source and no user configuration or conversation
data.
