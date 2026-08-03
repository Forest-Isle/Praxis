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
3. Both discover the same project instructions, memory, skills, hooks, agents,
   and project MCP definitions within the validated Sprint 0 profile.

## Shared authoritative data

Praxis follows the active Claude Code layout and path derivation for:

| Data                 | Shared location                                                                 |
| -------------------- | ------------------------------------------------------------------------------- |
| Config root          | `CLAUDE_CONFIG_DIR` or `~/.claude`                                              |
| Sessions             | `<config>/projects/<project-key>/<session-id>.jsonl`                            |
| Global instructions  | `<config>/CLAUDE.md`                                                            |
| Project instructions | `CLAUDE.md`, `CLAUDE.local.md`, `.claude/CLAUDE.md`, rules from boundary to cwd |
| Auto memory          | `<config>/projects/<canonical-repository-key>/memory/**/*.md`                   |
| Global skills        | `<config>/skills/`                                                              |
| Project skills       | `.claude/skills/`                                                               |
| Commands             | `<config>/commands/`, `.claude/commands/`                                       |
| Agent definitions    | `<config>/agents/`, `.claude/agents/`                                           |
| Settings and hooks   | User settings plus project/local `.claude/settings*.json` at original cwd       |
| Project MCP          | Boundary-to-cwd `.mcp.json` sources                                             |

Praxis must reuse Claude Code's canonical project-path sanitization. A similar
but independently invented directory name is not compatible.

For git worktrees, project resources come from the active worktree while auto
memory uses the canonical main-repository key. Outside git, instruction
discovery walks from the user's home boundary through cwd, while project
skills, commands, and agents stop before home so they cannot duplicate or leak
the default global config when `CLAUDE_CONFIG_DIR` changes. Settings retain
Claude's user plus original-cwd project/local boundary. Project MCP resources
are returned broad-to-specific as separate sources. Sprint 0 does not invent a
generic JSON merge because hook, permission, environment, and server fields
have different precedence semantics. User/local MCP registry formats beyond
project `.mcp.json` remain a Sprint 3 compatibility subset.

Memory location is resolved asynchronously by `loadClaudeSharedResources`
because worktree identity requires reading Git metadata. Callers must not infer
a memory path from the synchronous session-path resolver.

Path-conditional rule globs follow their discovery base: project rules are
relative to the directory that owns their `.claude/rules` tree, while user
rules under the config root are relative to the invocation cwd. Valid YAML
frontmatter is parsed once for both base-context exclusion and activation.

## Transcript write profile

Shared session files contain only entries accepted by the supported Claude Code
version. Praxis must preserve:

- session UUID and `<session-id>.jsonl` filename;
- message UUID and `parentUuid` chain;
- `sessionId`, `cwd`, timestamp, version, branch, and sidechain semantics where
  required by the active schema;
- Anthropic-compatible user and assistant message envelopes;
- strict `tool_use` and `tool_result` pairing;
- native `last-prompt` metadata pointing at the final assistant leaf;
- compaction summary and other resume metadata accepted by Claude Code when
  their writers are enabled.

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
`assistant` conversational entries, path-rule `nested_memory` attachments,
selected-agent `agent-setting` metadata, and the physical `last-prompt` record
required by Claude resume for the selected adapter version. The write profile
also includes the validated `compact_boundary` system record and its paired
`isCompactSummary` user entry; both append atomically under one tail check.
`agent-setting` and
`last-prompt` do not advance the logical UUID chain; `last-prompt` must name its
current leaf. Message content blocks and attachment envelopes are validated
before append, and every `tool_result` must match the historical `tool_use` plus
`sourceToolAssistantUUID`. Sidechain, image, tool-denial, and other entry writers
remain disabled until their runtime implementations and write/resume probes
pass. Text forks do not copy attachments or compaction metadata.

Sprint 1 text forks create a new transcript from projected user/assistant text
using the validated writer. They do not clone opaque native entries or bypass
the active version adapter.

Claude 2.1.208 fixtures cover text, tool use/results, manual compaction,
subagent sidechains, image results, non-zero tool errors, and user interruption.
Compaction alone has passed its native writer/reopen gate; sidechains, images,
and tool-denial entries remain explicitly rejected by the append adapter.

## Resource ownership and current access

| Resource                               | Plane          | Praxis access                             |
| -------------------------------------- | -------------- | ----------------------------------------- |
| Transcript                             | Shared         | Append only                               |
| Auto memory                            | Shared         | Read/write                                |
| Instructions, skills, commands, agents | Shared         | Read/execute; source files stay read only |
| Settings, MCP                          | Shared         | Read only until semantic matrix passes    |
| Hooks                                  | Shared         | Read/execute; declarations stay read only |
| Provider payloads, indexes, locks      | Praxis sidecar | Read/write                                |

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
compaction, image/error, and interruption fixtures, verifies native subagent
layout beside a resumable main session, and requires a real Claude run to
generate a sidechain. `npm run test:shared-compat` proves Claude and Praxis
observe the same worktree/non-git hierarchy, canonical shared memory including
a linked detail, skill, hook, layered project MCP, command, agent, and ordered
settings sources without copying or synchronization.
`npm run test:conditional-compat` proves that only a successful matching `Read`
activates a path rule, validates the native attachment envelope and resume
persistence, requires successful native tool results for every negative tool
case (including an Edit pre-read before its matching rule exists), exercises
built CLI message reload, and reopens the Praxis-written attachment with Claude
Code 2.1.208.
`npm run test:extension-compat` proves native slash command/skill expansion,
model-selected `Skill` tool injection, selected-agent metadata, and live resume
in both Claude→Praxis and Praxis→Claude directions.
`npm run test:hook-compat` proves command-hook event order and stdin envelopes,
PreToolUse input/permission changes, native success/error/context attachments,
exit-code-2 blocking, non-persisted SessionEnd output, Praxis built-CLI
execution, and Claude resume of the Praxis-written hook transcript.
`npm run test:mcp-compat` proves Claude and Praxis share user/project-local
precedence, then exercises Praxis stdio and Streamable HTTP discovery, tool
calls, permission flow, and stdio subprocess cleanup through the built CLI.
`npm run test:compaction-compat` creates over-budget history, lets Praxis append
an automatic compact pair, proves its next provider request excludes discarded
messages, and requires Claude 2.1.208 to resume the same active summary without
recovering the discarded marker.

## Explicit non-goals

- Sharing Claude OAuth credentials or subscription state.
- Reimplementing organization, managed policy, billing, or remote sessions.
- Depending on Claude Code internals beyond the versioned local compatibility
  contract.
- Maintaining a second Praxis-native transcript that later needs syncing.
