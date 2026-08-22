# Native Subagent Contract

## Goal

Praxis executes foreground and background subagents through the same provider-neutral runtime
and writes Claude Code 2.1.237-compatible main-chain and sidechain records.
Claude and Praxis can reopen the resulting main session without conversion.

## Supported Agent input

- `description`: non-empty task label;
- `prompt`: non-empty isolated subagent prompt;
- `subagent_type`: optional; defaults to `general-purpose`, or names a shared
  user/project agent;
- `model`: optional provider model alias override;
- `name`: optional addressable agent name persisted in sidechain metadata;
- `team_name`: accepted as Claude-compatible deprecated metadata; single-user
  Praxis keeps one implicit local team;
- `mode`: optional child permission mode (`acceptEdits`, `auto`,
  `bypassPermissions`, `default`, `dontAsk`, or `plan`);
- `run_in_background`: optional; foreground by default; an agent definition
  with `background: true` forces asynchronous execution;
- `isolation`: optional `worktree`, which runs child tools in a temporary Git
  checkout; remote execution stays outside the local product boundary.

Unknown fields, unknown agent types, empty input, and unsupported isolation fail
as an ordinary error tool result. `Agent` itself follows the active permission
resolver before any sidechain file is created.
Unscoped `Agent` and scoped `Agent(<subagent_type>)` allow, ask, and deny rules
use the same precedence as other Claude-compatible tool permissions.

## Execution

1. Main runtime persists the assistant `Agent` tool call.
2. Agent tool creates a stable agent ID and exclusive native sidechain. Readers
   accept both `a<16 lowercase hex>` and bounded, path-safe
   `a<label-><16 lowercase hex>` IDs.
3. Sidechain root contains requested prompt, main prompt ID, and worktree cwd
   when isolation is enabled.
4. Subagent runs with shared base context plus its selected agent definition.
   Environment, call-site, definition, and parent model selection use Claude's
   precedence; definition permission mode cannot weaken a parent
   `bypassPermissions`, `acceptEdits`, or `auto` mode.
5. Definition tool allow/deny rules, async restrictions, effort, and `maxTurns`
   apply inside the child. External custom agents cannot recursively invoke
   Agent or main-thread coordination tools.
6. Definition skills are preloaded as meta user messages. Persistent agent
   memory uses `<config>/agent-memory/<agent>/`,
   `.claude/agent-memory/<agent>/`, or
   `.claude/agent-memory-local/<agent>/`; its index is added to the child
   system context, and explicit tool lists receive `Read`, `Edit`, and `Write`.
7. Global `SubagentStart`/`SubagentStop` hooks and agent frontmatter tool/stop
   hooks run only for that child lifecycle. Referenced MCP servers reuse parent
   connections; inline agent MCP servers add their tools for the child and
   close on completion or failure. Local tools, Skill, permission,
   cancellation, and redaction behavior is reused from the main runtime.
8. Completed assistant and tool-result records append immediately to sidechain.
   Validated local `Read` image results retain the same native image envelope as
   the main chain.
9. Foreground results contain returned text and completed native metadata. A
   running foreground Agent can be handed to the background without starting a
   second provider/tool operation; identity, sidechain, cwd, usage, and the
   originating tool-use correlation remain unchanged. Parent-turn cancellation
   is detached only after that handoff commits.
10. Background results return `async_launched` metadata immediately while an
    independent abort controller owns execution. The session runtime retains
    the real executor owner across parent turns, so later `TaskOutput`,
    `SendMessage`, and `TaskStop` calls route by exact ID or unique name to that
    live owner rather than an interrupted recovery mirror. An ambiguous name
    fails locally instead of selecting an owner. `TaskOutput` performs bounded blocking or
    non-blocking reads; `TaskStop` cancels only its selected task. Explicit bulk
    kill aborts every live Agent and emits at most one `killed` notification per
    task. Process shutdown instead aborts and boundedly drains live work without
    requiring a later model-facing notification.
11. `SendMessage` queues ordered continuation turns and can hydrate completed,
    failed, killed, or interrupted sidechains in a later process. Continuation
    reconstructs content replacements, keeps complete tool-use/result pairs,
    removes unresolved calls and orphan thinking/whitespace fragments, and
    appends exactly one new prompt. Corrupt state, duplicate tool IDs, and
    multiple persisted sidechains matching one Agent ID or name fail before any
    transcript append.
12. At main-loop stop, terminal work from the current or any retained prior-turn
    owner becomes a persisted `<task-notification>` follow-up and its usage is
    added to main run totals. A still-running prior-turn owner never blocks the
    current stop boundary. Notification correlation and usage are consumed
    exactly once, only after the corresponding parent transcript append
    succeeds. Multi-notification batches commit and acknowledge one item at a
    time, so a later append failure cannot make an earlier item pending again.
    Out-of-turn hosted `/btw` delivery contributes its usage exactly once to
    durable session totals rather than retroactively changing a completed turn.

Bounds are explicit: maximum spawn depth 4, 16 subagent calls per main turn,
32 tool calls per model turn, 1 MiB model output,
1 MiB tool input, and 1 MiB final returned text. Cancellation aborts active
provider and child-tool work and produces an interrupted main run, not a fake
successful Agent result. A child loop has no implicit model-turn cap; a custom
agent definition may opt into an exact positive-integer `maxTurns` policy.

## Native persistence

Files live beside Claude sessions:

```text
<project-root>/<session-id>/subagents/
|-- agent-<agent-id>.jsonl
`-- agent-<agent-id>.meta.json
```

Agent IDs use `a` followed by 16 lowercase hex digits, with an optional bounded
safe label before the final `-<16 hex>`. Every sidechain message has
`isSidechain: true`, `agentId`, main `sessionId`,
and an independent UUID/parent chain. Assistant entries also include
`attributionAgent`. Meta contains `agentType`, `description`, main `toolUseId`,
`spawnDepth`, and optional `name`, `permissionMode`, `isolation`,
`parentAgentId`, and `worktreePath`. Compatible unknown metadata fields survive
read/write. Paths are constructed only after ID validation and cannot escape
the owning `subagents` directory.

Praxis-private operational state is separate from Claude-owned files:

```text
<private-state-root>/subagent-lifecycle/<session-id>/
`-- <agent-id>.json
```

It records the latest `running`, `completed`, `failed`, or `killed` lifecycle
marker, terminal result and usage when known, pending notification records with
stable IDs and consumed state, and the append-only transcript byte boundary
needed to distinguish restart outcomes. Terminal state and its notification are
persisted atomically before the operation settles. A marker whose boundary
predates a later shared append is not allowed to override that transcript. A
missing or stale `running` marker hydrates as explicitly `interrupted`; it never
triggers silent model replay. At each main or nested stop boundary, a fresh
executor discovers retained sidechains and restores pending notifications
without provider work. Notification append happens before acknowledgement; a
restart reconciles an already-appended task ID/tool-use ID/status tuple before
redelivery, including for a still-live owner whose prior durable acknowledgement
failed. Hosted `/btw` owners restart their detached delivery pump for each
`SendMessage` continuation. Their private notification records persist a
detached-delivery intent before parent append and confirm it after the exact
notification identity is visible; restart reconciliation promotes that intent
before acknowledgement. Session cost projection derives only confirmed records
idempotently across restart. A session close stops notification lease
retries without acknowledging the pending record, leaving it recoverable after
restart. Corrupt
or ambiguous automatic recovery is isolated to that sidechain and warns, while
an explicit management request fails locally. Usage already settled before a
later failure or kill is retained in the terminal result and notification.
Praxis-specific fields are never added to shared sidechain JSONL or metadata.
The private state root is `~/.praxis/state` in native mode and
`<CLAUDE_CONFIG_DIR>/praxis` in explicit Claude compatibility mode.

Foreground `toolUseResult` records status, prompt, agent ID/type, returned
content, resolved model, duration, usage, and tool-call count. Background launch
records `isAsync`, `async_launched`, output path, and model before completion.
Failed execution remains visible through output and notification status; any
persisted sidechain remains available for inspection. Exclusive creation
prevents overwriting native or Praxis output.

An isolated Agent records its retained worktree path. Resume restores only a
real registered Git worktree. Missing or invalid retained paths warn and fall
back to the parent cwd; they never mutate the parent's cwd or cause Praxis to
enter an arbitrary directory. Unchanged disposable worktrees, MCP connections,
shell descendants, registry entries, and temporary output links are cleaned
independently from retained audit transcripts.

## Main-thread agent definitions

`--agent`, the effective shared `agent` setting, and resumed native
`agent-setting` records select the same shared definition catalog. A valid
selection is persisted as Claude's append-only `agent-setting`; if a resumed
definition no longer exists, Praxis uses the default runtime.

For a fresh main-thread session, `initialPrompt` is placed before the user's
text so slash expansion observes the same order as Claude Code. It is not
replayed on resume. The custom body, plus its configured persistent memory,
becomes the agent system prompt. In print/headless mode an explicit system
prompt takes precedence; in interactive mode the selected agent body takes
precedence, matching Claude Code 2.1.208's interactive prompt assembly. Agent
model selection applies only when the user did not explicitly select a model.
Tool allow/deny rules scope the final assembled main-thread registry, including
MCP and coordination tools.

Claude Code 2.1.208 does not apply definition `effort`, `maxTurns`,
`permissionMode`, skill preloads, scoped hooks, or private MCP connections to
the main thread. Those fields retain the child-runtime behavior described
above; Praxis does not silently widen them at top level.

## Extended lifecycle

Top-level background sessions, `praxis agents`, background Bash, durable task
graphs, owner-authenticated dispatch, stale-worker repair, and completed-session
resume share the validated native session and sidechain contracts. Live work is
owned by its Praxis worker; persisted output and completed sidechains remain
cross-runtime resumable.

## Acceptance

- unit tests cover input, bounds, concurrency, polling, ordered messaging,
  foreground handoff, restart recovery, bulk kill, bounded shutdown, recursion,
  failure, cancellation, usage, cwd/worktree restore, and native schema
  validation;
- integration tests prove main and sidechain persistence plus custom agents;
- installed OpenAI and Anthropic loops execute foreground/background Agent and
  resume results;
- Claude 2.1.237 reopens Praxis-written main session and discovers sidechain;
- live black-box gate compares Agent/task tool schemas and proves background
  launch, output, messaging, notification, persistence, and Claude resume;
- existing package, performance, recovery, and compatibility gates stay green.
