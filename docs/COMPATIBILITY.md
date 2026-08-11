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
| Scheduled prompts    | `<cwd>/.claude/scheduled_tasks.json`                                            |

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

Worktree lifecycle follows Claude Code's shared project layout. Dynamic
`EnterWorktree`/`ExitWorktree` keeps session transcript in its pinned project
directory while changing active tool/context cwd. Each transition uses native
`worktree-state` and matching `toolUseResult` metadata. Initial CLI
`--worktree` entry happens before transcript pinning, so its session file uses
worktree project key. Existing worktrees entered by path are keep-only; Praxis
never removes a worktree it did not create in current process.

Memory location is resolved asynchronously by
`resolveClaudeProjectMemoryDirectory` and `loadClaudeSharedResources` because
worktree identity requires reading Git metadata. Callers must not infer a
memory path from the synchronous session-path resolver. Praxis exposes that
single canonical root through standard `Read`, `Write`, and `Edit`; it does not
add a private memory tool or accept sibling paths and symlink escapes.

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
- Praxis-generated `last-prompt` metadata pointing at the final assistant leaf;
- native fork `last-prompt` metadata pointing at the current logical UUID leaf,
  which may be a user, system, or attachment record accepted by Claude;
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
- encode lock owner PID and a unique token, reclaiming only a recognized lock
  whose owner process is no longer alive;
- bound orphan cleanup and remove only recognized unique candidate/stale
  sidecars whose owner process is dead; reclaim fixed-path guards only inside
  the guarded takeover protocol;
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

## Headless machine protocol

Explicit `--output-format json` and `stream-json` use Claude-shaped result and
message envelopes; legacy Praxis `--json` remains a separate runtime-event
format. Stream input consumes raw stdin incrementally, validates each bounded
UTF-8 NDJSON record, and processes user messages sequentially against one
session and one connected MCP/service lifecycle. Each input turn emits its own
init and terminal result records while retaining the same session ID.
An empty stream exits successfully without emitting a record, matching Claude
Code 2.1.208.

An explicit new `--session-id` is reserved with exclusive file creation while
the Praxis lease is held. Existing non-empty and empty files both fail with an
already-in-use error, matching the Claude Code 2.1.208 black-box contract. The
exclusive create also closes the race between an existence check and the first
Praxis append.

Only text user content blocks are writable through stream input in the current
profile. Unsupported records and blocks fail closed; image/file input and SDK
control messages require separate native/provider envelopes before enablement.

Headless customization flags follow the same shared-data boundary.
`--setting-sources` filters instructions, rules, memory, extensions, settings,
hooks, and MCP by user/project/local scope; `--safe-mode` and `--bare` suppress
automatic customizations. Direct/file system prompts stay provider context and
are never persisted. `--add-dir` adds canonical file/search roots without
allowing symlink escape. CLI deny rules still win in bypass mode. The
classifier-backed `auto` permission mode fails closed until Praxis implements
the classifier contract.

With the default system prompt, Praxis assembles machine-specific cwd,
platform/shell/OS, canonical memory path, and bounded Git branch/status/recent
commit context at the start of every session turn. By default those sections remain
system context. `--exclude-dynamic-system-prompt-sections` moves them into a
`<system-reminder>` prefix on the first provider-visible user message, including
the first historical user message after resume. The prefix is rebuilt on each
turn, participates in main-session context budgeting and compaction, reaches
prompt-suggestion requests, and is never written to shared JSONL. Subagents
assemble it from their actual runtime cwd on every model round and include it
in their provider budget; an oversized subagent request fails before transport
instead of performing an implicit sidechain compaction. A custom
`--system-prompt` disables default dynamic sections, so the relocation flag is
ignored; `--append-system-prompt` remains active in either placement mode.

`--no-session-persistence` uses an in-memory transcript. A new ephemeral
session never creates its would-be JSONL path. Resuming an existing disk
session imports its validated history into memory, continues there, and leaves
the source bytes and lock directory unchanged. Foreground Agent is disabled in
this mode because its Claude-compatible sidechain store is disk-backed.

Interactive `/cd <path>` changes the runtime cwd without creating a competing
session namespace. For a persisted active session, Praxis appends Claude's
native `relocated` record, moves the same append-only JSONL to the destination
Claude project root, then appends the native `system/local_command` pair and
cwd-change reminder there. The session ID and existing bytes remain unchanged;
staged publication keeps the source byte-identical if migration fails, and
target collisions fail closed. Subsequent tools, hooks, instructions, memory
discovery, permissions, exports, diffs, and service recreation use the
canonical destination cwd.

Notebook `Read` projects `.ipynb` cells as Claude-compatible `<cell id="...">`
text, using `cell-N` for older cells without native IDs. `NotebookEdit` accepts
an absolute canonical path and replaces, inserts, or deletes one cell only
after a successful Read in the active transcript history. Writes preserve
unmodified notebook and cell fields, stay within configured file roots and
size bounds, and use the same native tool-result persistence as other local
tools.

`Glob` recursively matches files with Claude-compatible basename, brace, and
globstar patterns, including hidden and ignored paths. Results preserve
relative or absolute path style, sort oldest modification time first, and cap
at 100 entries with the native count suffix. Search roots may be the workspace
or configured additional directories; unlike Claude 2.1.208's explicit
symlink-root behavior, Praxis canonicalizes roots and rejects symlink escape.

MCP resource tools are exposed only when a connected server advertises the
resource capability. `ListMcpResourcesTool` caches every bounded discovery page
and appends the originating server to each resource; `ReadMcpResourceTool`
serializes Claude-visible URI, MIME, and text fields while stripping MCP result
metadata, and maps the 2.1.208 not-found response.
Binary resource contents are decoded with a size bound and exclusively written
under `<project>/<session-id>/tool-results`, including no-persistence runs,
without writing raw base64 to the transcript. `ReadMcpResourceDirTool` retains
2.1.208's current fixed disabled response. Resource-only servers appear as
connected in stream init status, and all clients close with the CLI lifecycle.

`WebFetch` and provider-capable `WebSearch` use Claude Code 2.1.208's observed
tool names, descriptions, schemas, result wrappers, and local permission
patterns. Normal and safe modes expose them; bare mode omits them even when
explicitly selected. Both default to `ask`, so headless `dontAsk` runs deny
them without an allow rule; WebFetch accepts Claude's `domain:<host>` rules.
WebSearch is a provider capability: explicitly enabled Anthropic adapters use
the native `web_search_20250305` server tool with at most eight uses and maps
allowed or blocked domains, while OpenAI-compatible providers currently omit
the tool. WebFetch upgrades HTTP to HTTPS, rejects authenticated/private URLs,
pins requests to public DNS results, follows at most five same-host redirects,
reports cross-host redirects, converts supported text to Markdown, and applies
bounded timeout, response, model-output, and 15-minute cache limits.

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

`praxis sessions`, `praxis inspect`, and `praxis export` never require a model
provider. Listing parses each transcript independently, so one corrupt tail is
reported with its line and byte offset without hiding healthy sessions.
Inspection reports schema write mode and physical tail metadata. Export returns
the original JSONL bytes, including any corrupt suffix, without parse/stringify
normalization. Plain export writes the bytes directly; JSON export uses base64
with explicit encoding metadata. Non-session, non-regular, vanished, or
unreadable directory entries are skipped independently rather than failing the
project listing.

Append scope is deliberately smaller than read scope. Praxis reads any
well-formed native entry as opaque data, but only appends validated `user` and
`assistant` conversational entries, path-rule `nested_memory` attachments,
selected-agent `agent-setting` metadata, and the physical `last-prompt` record
required by Claude resume for the selected adapter version. The append profile
also includes the validated `compact_boundary` system record and its paired
`isCompactSummary` user entry; both append atomically under one tail check.
Native session naming adds paired `custom-title` and `agent-name` metadata
before the first user entry or while renaming a resumed session. `agent-setting` and
`last-prompt` do not advance the logical UUID chain; `last-prompt` must name its
current leaf. Message content blocks and attachment envelopes are validated
before append, and every `tool_result` must match the historical `tool_use` plus
`sourceToolAssistantUUID`. Foreground and background Agent sidechain entries become writable
only through the bounded runtime in `docs/SUBAGENT_CONTRACT.md` and its
write/resume probes. Async launch metadata, `TaskOutput`, `TaskStop`,
`SendMessage`, task notifications, and same-ID continuation use that validated
path. Tool denial, user image/document input, and tool-result media writers use
strict message/metadata pairing. Single image/document results carry matching
base64, media type, and decoded size in native `toolUseResult.file`; multiple
media results carry an exact count. MCP results preserve ordered native text and
image blocks, materialize bounded audio/resource blobs, retain structured MCP
metadata and attribution, and reuse the turn prompt ID.

Structured tasks are authoritative shared files under
`<config>/tasks/<session-id>`, not transcript or Praxis-only records. Praxis
preserves Claude's task JSON shape, reciprocal `blocks`/`blockedBy` edges,
metadata null-deletion, deletion cleanup, and numeric high-watermark. ID
allocation also scans existing task files because Claude 2.1.208 can append a
task during cross-runtime resume without advancing an existing high-watermark.
Praxis publishes a fully synced task through an exclusive same-directory link;
if Claude wins the numeric ID race, Praxis rescans and retries without replacing
the native file. Updates fingerprint every involved task immediately before
atomic replacement and retry the complete mutation over newer native state;
no-op updates do not rewrite task files. `TaskList` hides tasks marked with
native `metadata._internal`. A terminal `TaskOutput` consumes its pending
completion notification, while a bounded wait that expires reports `timeout`
and leaves the running task eligible for its eventual notification.
Background Bash output uses Claude's
`/tmp/claude-<uid>/<project>/<session>/tasks` layout; standard `Read` gets
read-only access to that root while mutation and search tools retain their
normal workspace boundaries. Resumable Bash status metadata stays under
`<config>/praxis/`, uses atomic replacement, and is ignored when malformed. It
is never authoritative conversation state. Dynamic completion-notification
fields are XML escaped before transcript insertion.

Top-level background sessions use Claude's observed `jobs/<8-hex-id>` and
`sessions/<pid>.json` layout, including `template: "bg"`, active/blocked/idle
tempo, managed session identity, timeline, and terminal state. Interactive
`/background` creates a fresh job session that remains blocked until input; its
dispatch sidecar privately identifies the foreground source session and active
tail checkpoint. First attach forks that native chain into the fresh session
before resuming it, while the source transcript remains byte-for-byte unchanged.
The checkpoint and a durable completion marker make the lazy fork idempotent
across worker restarts even if the source later advances. A Praxis owner marker,
dispatch record, control token, and bounded `output.log` are operational sidecars:
they coordinate only Praxis workers and are not conversation state.
Claude's private daemon does not discover a synthetic job from state files
alone, so Praxis never fabricates or takes over Claude daemon sockets. Shared
project JSONL remains authoritative and carries native `sessionKind: "bg"`,
`userType: "external"`, and `entrypoint: "cli"` on background messages.

Scheduled prompts use Claude's observed project-local document with eight-hex
IDs, five-field local-time cron, creation session/PID/start metadata, and no
Praxis-private fields. Unknown document and task fields survive mutation.
Session-only jobs never touch disk; durable mutations use a Praxis lease plus
physical fingerprint retry because Claude does not honor that lease. A live
foreign PID is skipped only when its observed process start also matches,
preventing PID reuse from orphaning a task. Interactive delivery is once-only
within one scheduler service, missed durable one-shots catch up and auto-delete,
and recurring jobs execute once more at seven-day expiry before deletion.

Fork uses a separate versioned creation profile because it copies existing
native records rather than appending newly generated records. For Claude Code
2.1.208 it losslessly copies supported main-chain `user`, `assistant`, `system`,
`attachment`, and `agent-setting` entries plus `custom-title`, `agent-name`,
`ai-title`, `mode`, `permission-mode`, and `last-prompt` metadata, replacing only `sessionId` in
each copied record. This preserves tool history, compact history, media and
error payloads, hook/nested-memory attachments, agent state, UUIDs, and parent
links. Latest title/mode/permission state is placed first and latest valid
`last-prompt` that matches the current logical tail last. Queue operations and
file-history snapshots/deltas are
excluded. Ordinary 2.1.208 system subtypes and main-chain attachment envelopes
are copied without requiring Praxis to execute them. Unknown entry types,
mismatched source session IDs, malformed UUID/parent/tool/compact/leaf links,
and unsupported versions fail closed before exclusive target creation.
Sidechain records and orphaned `last-prompt` hints are excluded from the
resumable main-chain copy. Raw root `sessionId` replacement preserves every
other copied JSON token, including integers beyond JavaScript's safe range.

Claude 2.1.208 fixtures cover text, tool use/results, manual compaction,
subagent sidechains, image results, non-zero tool errors, and user interruption.
Compaction, foreground/background sidechains, and `Read` image results have passed their
native writer/reopen gates. Tool-denial and other unimplemented entry writers
remain explicitly rejected by the append adapter.

SDK file checkpointing is opt-in through
`CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=true`. Praxis then writes Claude
2.1.208-native `file-history-snapshot` records at user-message boundaries and
`file-history-delta` records before the first successful `Write`, `Edit`, or
`NotebookEdit` mutation of a newly tracked path. Bounded content backups use
Claude's `<config>/file-history/<session-id>/<path-hash>@v<version>` layout.
`--resume <session-id> --rewind-files <user-message-uuid>` reads either
runtime's records, validates every backup before mutation, restores files by
atomic replacement, removes paths that did not exist at the checkpoint, and
does not call a model or modify conversation history. Rewind targets are
confined to the active workspace, explicit additional roots, and shared memory;
symlink escapes and malformed/unbounded backups fail closed. Fork continues to
exclude file history because backups remain owned by the source session.

## Resource ownership and current access

| Resource                               | Plane          | Praxis access                             |
| -------------------------------------- | -------------- | ----------------------------------------- |
| Transcript                             | Shared         | Append only                               |
| Auto memory                            | Shared         | Read/write                                |
| Instructions, skills, commands, agents | Shared         | Read/execute; source files stay read only |
| Settings, MCP                          | Shared         | Read only until semantic matrix passes    |
| Hooks                                  | Shared         | Read/execute; declarations stay read only |
| Durable task graph                     | Shared         | Read/write                                |
| Background transcript                  | Shared         | Append/resume                             |
| Background job control                 | Owner-scoped   | Praxis jobs only                          |
| Scheduled prompts                      | Shared         | Read/write                                |
| File history/checkpoint backups        | Shared         | Read/write                                |
| Provider payloads, indexes, locks      | Praxis sidecar | Read/write                                |

This matrix is also encoded in `src/compatibility/claude/ownership.ts`; runtime
code must consult that policy instead of inventing ownership per feature.

## Credential boundary

Shared settings remain authoritative, but ambient Praxis/provider credentials
are not shared resources. Bash, command hooks, Claude version detection, and
MCP stdio transports receive the normal runtime environment with
credential-named variables and shell startup injection variables removed.
Hook shells also disable user startup files.

An MCP server's explicit `env` or sensitive HTTP headers are deliberate grants
to that server and therefore apply after ambient sanitization. Praxis records
their exact values, including common authorization and cookie payloads, only in
an in-memory redaction set. MCP definitions, tool results, warnings, and errors
cross back into provider/CLI/transcript paths after redaction. No credential
field or new Praxis entry type is added to shared JSONL.

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
`npm run test:resume-selector-compat` proves installed UUID/title selector
resolution, canonical UUID routing, missing/ambiguous failures, and Claude
resuming a Praxis-named session.
`npm run test:background-agent-compat` captures Claude's current Agent,
SendMessage, TaskOutput, and TaskStop schemas, then proves async launch, output
polling, same-ID continuation, completion notification, sidechain persistence,
usage aggregation, and Claude resume of the Praxis-written main session.
`npm run test:task-compat` compares Bash and durable-task schemas, exercises
Praxis task/dependency/background-Bash lifecycle, has Claude resume and extend
the same graph, then has Praxis resume Claude's public and internal tasks,
exclude the internal task from `TaskList`, repair a stale high-watermark without
ID collision, and persist an XML-safe completion notification.
`npm run test:top-level-agent-compat` captures Claude's launch/list/idle/stop
contract, drives a real detached Praxis worker through logs, attach, and stop,
validates native job/session layout and background transcript metadata, then
proves Claude -> Praxis and Praxis -> Claude resume.
`npm run test:background-command-compat` drives Claude and Praxis through the
interactive `/background` PTY flow and proves fresh job identity,
blocked-until-input state, transcript-free launch, unchanged source JSONL, lazy
fork on attach, complete provider context, and resumable target transcripts.
`npm run test:scheduled-compat` compares `CronCreate`, `CronDelete`, `CronList`,
and exact `ScheduleWakeup` descriptions/schemas, proves Praxis-created native
jobs are visible and deletable after Claude resume, proves Claude-created jobs
survive Praxis resume, and verifies the inactive dynamic-wakeup gate. The gate
also exercises the active built registry against Claude 2.1.208's installed SDK
output type and executable result projection: rounded/clamped minute-aligned
time, pending-wakeup replacement, stop cancellation, and native result fields.
`npm run test:workflow-compat` compares the Claude 2.1.208 Workflow schema, proves
default permission denial is artifact-free, drives background launch/notification/
resume with zero repeated child requests, checks structured output and effort
forwarding, and validates native run/journal/sidechain metadata. Praxis writes Claude's
exact chained `v2` replay keys from the previous key, prompt, and canonical semantic
options; the gate has Claude resume that Praxis-created run with zero child provider
requests and verifies that Claude does not append or change the journal. Before Praxis
exercises its ordered fallback, the gate replaces the journal key with a foreign key; the
private
`.praxis-replay-metadata.jsonl` is removed during resume, so unchanged script/args
ordered replay must still produce a zero-request cache hit. The same gate first
creates a native Claude 2.1.208 workflow, then resumes that session with Praxis;
the Claude journal is used without a Praxis sidecar and produces zero child
provider requests. Praxis replays Claude-created entries only when an unchanged
deterministic script/args pair is available; nested `workflow` and `budget` sources fail
closed. A unique prompt is the final fallback only for a current call with no semantic
options. All semantic-option calls without exact identity, unchanged-script proof, or
Praxis descriptor metadata remain fail-closed.
`npm run test:thinking-compat` captures Claude 2.1.208 enabled/disabled request
behavior, then proves Praxis applies enabled/adaptive/disabled modes and a real
thinking-token budget. It verifies standard result secrecy, partial thinking
deltas, signed tool-turn replay, native JSONL persistence, unsupported-provider
failure before transport, and Claude -> Praxis -> Claude bidirectional resume.
`npm run test:package` additionally drives installed OpenAI and Anthropic loops
through a linked memory `Read`, permission-authorized memory `Write`, native
tool-result persistence, second-process resume, and a provider-free native fork
against that same root. It compares source and fork records field-for-field
after the defined session-ID and transient-record transformation.
`npm run test:compat:all` is the authoritative aggregate: it discovers all 49
compatibility gates from `package.json`, rejects unsupported command shapes or
duplicate entrypoints, and runs each in an isolated child process. The complete
matrix passed on Claude Code 2.1.208 after the conditional-rule and compaction
fixtures were calibrated to current context/tool envelopes.
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
Claude-compatible stream lifecycle records, PreToolUse input/permission
changes, native success/error/context attachments, exit-code-2 blocking,
non-persisted SessionEnd output, Praxis built-CLI execution, and Claude resume
of the Praxis-written hook transcript.
`npm run test:mcp-compat` proves Claude and Praxis share user/project-local
precedence, then exercises Praxis stdio and Streamable HTTP discovery, tool
calls, permission flow, and stdio subprocess cleanup through the built CLI.
`npm run test:web-compat` compares exact schemas and safe/bare exposure, native
filtered search requests, links/citations, domain permissions, private-fetch
rejection, transcript persistence, and bidirectional resume against Claude Code
2.1.208. WebFetch also enforces Claude's URL, response, timeout, markdown,
redirect, and 50 MiB LRU cache bounds, persists binary responses under the
session `tool-results` directory, and bypasses secondary processing for the
native preapproved Markdown hosts. It requires real successful Claude and
Praxis public fetches; the isolated Claude run supplies `skipWebFetchPreflight`
so the probe is independent of the external domain-safety service while
retaining the production fetch and secondary-model paths.
`npm run test:recovery-compat` creates an interrupted native tool call, proves
decline is append-free, approves the prepared retry exactly once, persists its
native result, and requires Claude Code 2.1.208 to resume the recovered turn.
`npm run test:compaction-compat` creates over-budget history, lets Praxis append
an automatic compact pair, proves its next provider request excludes discarded
messages, forks that physical history, and requires Claude 2.1.208 to resume
both source and fork from the active summary without recovering the discarded
marker. `npm run test:runtime-compat` likewise requires Claude 2.1.208 to recover
both tool result and final response from a Praxis-native tool fork.
Unit/integration security gates additionally execute real Bash, hook, stdio,
and HTTP children and assert that ambient canaries are absent while explicit
MCP grants work and return as `[REDACTED]`. The hook lifecycle gate asserts the
same canary is absent from the physical shared transcript.

## Explicit non-goals

- Sharing Claude OAuth credentials or subscription state.
- Reimplementing organization, managed policy, billing, or remote sessions.
- Depending on Claude Code internals beyond the versioned local compatibility
  contract.
- Maintaining a second Praxis-native transcript that later needs syncing.
