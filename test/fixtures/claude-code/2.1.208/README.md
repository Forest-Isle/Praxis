# Claude Code 2.1.208 fixtures

Fixtures were captured by running the installed `claude` CLI against an
isolated temporary `CLAUDE_CONFIG_DIR`, then replacing session IDs, message IDs,
paths, timestamps, token counts, and human text with deterministic values.

- `basic-session.jsonl`: text user/assistant envelope plus physical
  `last-prompt` metadata tail.
- `tool-session.jsonl`: Bash `tool_use` and matching user `tool_result`
  envelope, including `sourceToolAssistantUUID` and `toolUseResult`.
- `compact-session.jsonl`: manual `compact_boundary` and compact-summary pair.
- `sidechain-session.jsonl`: subagent transcript entries with `isSidechain`,
  `agentId`, and attribution metadata.
- `media-error-session.jsonl`: image result and non-zero Bash error result.
- `interrupted-session.jsonl`: Ctrl-C tool rejection and interruption message.

They contain no Claude Code source and no user configuration or conversation
data.
