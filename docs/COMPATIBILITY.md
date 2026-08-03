# Claude Code Compatibility Contract

## Goal

Claude Code and Praxis operate on one local data plane:

```text
Claude Code ─┐
             ├── ~/.claude (or CLAUDE_CONFIG_DIR)
Praxis ──────┘
```

Compatibility is bidirectional, not import-only:

1. Praxis can discover and resume a Claude Code session.
2. Claude Code can discover and resume a Praxis session.
3. Both load the same project instructions, memory, skills, hooks, agents, and
   MCP definitions.

## Shared authoritative data

Praxis follows the active Claude Code layout and path derivation for:

| Data                 | Shared location                                                                  |
| -------------------- | -------------------------------------------------------------------------------- |
| Config root          | `CLAUDE_CONFIG_DIR` or `~/.claude`                                               |
| Sessions             | `<config>/projects/<project-key>/<session-id>.jsonl`                             |
| Global instructions  | `<config>/CLAUDE.md`                                                             |
| Project instructions | `CLAUDE.md`, `.claude/CLAUDE.md`, `.claude/rules/**/*.md` from git root to cwd   |
| Auto memory          | `<config>/projects/<git-root-key>/memory/**/*.md`                                |
| Global skills        | `<config>/skills/`                                                               |
| Project skills       | `.claude/skills/`                                                                |
| Commands             | `<config>/commands/`, `.claude/commands/`                                        |
| Agent definitions    | `<config>/agents/`, `.claude/agents/`                                            |
| Settings and hooks   | `<config>/settings.json`, `.claude/settings.json`, `.claude/settings.local.json` |
| Project MCP          | `.mcp.json` and Claude-compatible configured sources                             |

Praxis must reuse Claude Code's canonical project-path sanitization. A similar
but independently invented directory name is not compatible.

## Transcript write profile

Shared session files contain only entries accepted by the supported Claude Code
version. Praxis must preserve:

- session UUID and `<session-id>.jsonl` filename;
- message UUID and `parentUuid` chain;
- `sessionId`, `cwd`, timestamp, version, branch, and sidechain semantics where
  required by the active schema;
- Anthropic-compatible user and assistant message envelopes;
- strict `tool_use` and `tool_result` pairing;
- compaction summary and resume metadata accepted by Claude Code.

Praxis may read optional Claude entry types it does not execute. It must retain
them when continuing a session unless the active Claude schema explicitly marks
them as disposable.

Praxis must not write private event types, provider-native reasoning payloads,
indexes, embeddings, locks, or UI state into the shared JSONL. Claude Code's
unknown-entry tolerance is not a stable contract.

## Provider translation

Claude Code sessions use Anthropic message semantics. When Praxis runs another
provider, it translates completed turns into the Claude-compatible envelope:

- plain output becomes assistant text blocks;
- provider tool calls become `tool_use` blocks with stable unique IDs;
- results become matching `tool_result` blocks;
- unsupported reasoning or provider metadata goes to a Praxis sidecar;
- the shared transcript remains sufficient to resume without that sidecar.

This is a persistence translation only. Praxis does not pretend every provider
supports all Claude model capabilities at runtime.

## Praxis sidecars

Private operational state lives under `<claude-config>/praxis/`, for example:

```text
~/.claude/praxis/
├── compatibility/
├── indexes/
├── locks/
└── providers/
```

Sidecars may contain schema probes, search indexes, process locks, provider raw
payloads, and cached projections. They are disposable and never authoritative
for conversation or memory content.

## Concurrent access

Claude Code and Praxis may list and read the same sessions concurrently, but a
session has one writer at a time. Praxis must:

- acquire a per-session advisory lock before append;
- detect transcript changes before every append;
- refuse or fork if another process advanced the same parent UUID;
- flush and close the transcript before handing it to Claude Code;
- never truncate or rewrite a live shared transcript.

Advisory locks cannot force an unmodified Claude Code process to cooperate.
Praxis therefore checks the physical tail before opening, checks file size on
the append handle, writes one append record, fsyncs, and verifies the exact byte
range afterward. A detected interleaving is reported as a conflict and the
session becomes read-only until reload/fork.

No portable filesystem compare-and-append primitive can make an unmodified
Claude process honor this lease. Users must not run Claude and Praxis as writers
of the same session simultaneously; the checks detect conflicts but cannot
mathematically eliminate the final cross-process race.

## Version compatibility

Claude Code's local format is an implementation contract and can change.
Praxis maintains versioned compatibility adapters rather than one permissive
parser:

```text
Claude installation/version detection
  -> schema adapter selection
  -> read/validate
  -> append native entry
  -> re-open validation
```

Support policy:

- read-write compatibility with explicitly tested Claude Code `2.1.208`;
- preserve unknown fields when round-tripping;
- fail closed before writing an unsupported schema;
- offer read-only recovery/export when write compatibility is unknown.

Current write scope is deliberately smaller than read scope. Praxis reads any
well-formed native entry as opaque data, but only appends validated `user` and
`assistant` conversational entries for the selected adapter version. Message
content blocks are validated before append, and every `tool_result` must match
the historical `tool_use` plus `sourceToolAssistantUUID`. Summary, sidechain,
attachment, image, and other entry writers remain disabled until their runtime
implementations and write/resume probes pass.

Claude 2.1.208 read fixtures now cover text, tool use/results, manual
compaction, subagent sidechains, image results, non-zero tool errors, and user
interruption. Passing a read fixture does not enable its writer: compact
summaries, sidechains, images, and tool-denial entries remain explicitly
rejected by the append adapter.

## Resource ownership and current access

| Resource                               | Plane          | Praxis access                          |
| -------------------------------------- | -------------- | -------------------------------------- |
| Transcript                             | Shared         | Append only                            |
| Auto memory                            | Shared         | Read/write                             |
| Instructions, skills, commands, agents | Shared         | Read only until loaders pass fixtures  |
| Settings, hooks, MCP                   | Shared         | Read only until semantic matrix passes |
| Provider payloads, indexes, locks      | Praxis sidecar | Read/write                             |

This matrix is also encoded in `src/compatibility/claude/ownership.ts`; runtime
code must consult that policy instead of inventing ownership per feature.

## Verification gates

Compatibility work is complete only when black-box tests prove both directions:

1. Claude Code creates a fixture; Praxis resumes and appends a turn.
2. Claude Code resumes the resulting Praxis-written fixture.
3. Praxis creates a fixture; Claude Code lists and resumes it.
4. Both tools observe the same changed `CLAUDE.md`, memory, skill, hook, and MCP
   fixture without synchronization or copying.
5. Concurrent-tail mutation causes a safe refusal or fork, never corruption.

Tests run against isolated temporary `CLAUDE_CONFIG_DIR` directories and a
version matrix of installed Claude Code releases.

For 2.1.208, `npm run test:compat` proves transcript creation/resume in both
directions, including a Praxis-written tool chain. It also reopens captured
compaction, image/error, and interruption fixtures and verifies native subagent
layout beside a resumable main session. `npm run test:shared-compat` proves
Claude and Praxis observe the same nested-project instructions, root-keyed
memory, skill, hook, MCP, command, agent, and settings fixtures without copying
or synchronization.

## Explicit non-goals

- Sharing Claude OAuth credentials or subscription state.
- Reimplementing organization, managed policy, billing, or remote sessions.
- Depending on Claude Code internals beyond the versioned local compatibility
  contract.
- Maintaining a second Praxis-native transcript that later needs syncing.
