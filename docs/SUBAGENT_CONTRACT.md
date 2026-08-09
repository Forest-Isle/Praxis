# Native Subagent Contract

## Goal

Praxis executes foreground and background subagents through the same provider-neutral runtime
and writes Claude Code 2.1.208-compatible main-chain and sidechain records.
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
- `run_in_background`: optional; defaults to `true`;
- `isolation`: optional `worktree`, which runs child tools in a temporary Git
  checkout; remote execution stays outside the local product boundary.

Unknown fields, unknown agent types, empty input, and unsupported isolation fail
as an ordinary error tool result. `Agent` itself follows the active permission
resolver before any sidechain file is created.
Unscoped `Agent` and scoped `Agent(<subagent_type>)` allow, ask, and deny rules
use the same precedence as other Claude-compatible tool permissions.

## Execution

1. Main runtime persists the assistant `Agent` tool call.
2. Agent tool creates a unique 16-hex agent ID and exclusive native sidechain.
3. Sidechain root contains requested prompt, main prompt ID, and worktree cwd
   when isolation is enabled.
4. Subagent runs with shared base context plus its selected agent definition and
   mode-specific permission resolver.
5. Local, MCP, Skill, hook, permission, cancellation, and redaction behavior is
   reused from the main runtime. Nested Agent calls use the same
   path with incremented spawn depth.
6. Completed assistant and tool-result records append immediately to sidechain.
   Validated local `Read` image results retain the same native image envelope as
   the main chain.
7. Foreground results contain returned text and completed native metadata.
   Background results return `async_launched` metadata immediately while an
   independent abort controller owns execution.
8. `TaskOutput` performs bounded blocking or non-blocking reads; `TaskStop`
   cancels only its selected task. `SendMessage` queues ordered continuation
   turns and can hydrate a completed sidechain in a later main-session turn.
9. At main-loop stop, completed work becomes a persisted
   `<task-notification>` follow-up and its usage is added to main run totals.

Bounds are explicit: maximum spawn depth 4, 16 subagent calls per main turn,
16 model turns per subagent, 32 tool calls per model turn, 1 MiB model output,
1 MiB tool input, and 1 MiB final returned text. Cancellation aborts active
provider and child-tool work and produces an interrupted main run, not a fake
successful Agent result.

## Native persistence

Files live beside Claude sessions:

```text
<project-root>/<session-id>/subagents/
|-- agent-<agent-id>.jsonl
`-- agent-<agent-id>.meta.json
```

Agent IDs use `a` followed by 16 lowercase hex digits. Every sidechain message
has `isSidechain: true`, `agentId`, main `sessionId`,
and an independent UUID/parent chain. Assistant entries also include
`attributionAgent`. Meta contains `agentType`, `description`, main `toolUseId`,
`spawnDepth`, and optional `name`, `permissionMode`, and `isolation`.

Foreground `toolUseResult` records status, prompt, agent ID/type, returned
content, resolved model, duration, usage, and tool-call count. Background launch
records `isAsync`, `async_launched`, output path, and model before completion.
Failed execution remains visible through output and notification status; any
persisted sidechain remains available for inspection. Exclusive creation
prevents overwriting native or Praxis output.

## Extended lifecycle

Top-level background sessions, `praxis agents`, background Bash, durable task
graphs, owner-authenticated dispatch, stale-worker repair, and completed-session
resume share the validated native session and sidechain contracts. Live work is
owned by its Praxis worker; persisted output and completed sidechains remain
cross-runtime resumable.

## Acceptance

- unit tests cover input, bounds, concurrency, polling, ordered messaging,
  recursion, failure, cancellation, usage, and native schema validation;
- integration tests prove main and sidechain persistence plus custom agents;
- installed OpenAI and Anthropic loops execute foreground/background Agent and
  resume results;
- Claude 2.1.208 reopens Praxis-written main session and discovers sidechain;
- live black-box gate compares Agent/task tool schemas and proves background
  launch, output, messaging, notification, persistence, and Claude resume;
- existing package, performance, recovery, and compatibility gates stay green.
