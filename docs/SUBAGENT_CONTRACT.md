# Native Subagent Contract

## Goal

Praxis executes foreground subagents through the same provider-neutral runtime
and writes Claude Code 2.1.208-compatible main-chain and sidechain records.
Claude and Praxis can reopen the resulting main session without conversion.

## Supported Agent input

- `description`: non-empty task label;
- `prompt`: non-empty isolated subagent prompt;
- `subagent_type`: `general-purpose` or a shared user/project agent name;
- `run_in_background`: omitted or `false` only.

Unknown fields, unknown agent types, empty input, and background requests fail
as an ordinary error tool result. `Agent` itself follows the active permission
resolver before any sidechain file is created.
Unscoped `Agent` and scoped `Agent(<subagent_type>)` allow, ask, and deny rules
use the same precedence as other Claude-compatible tool permissions.

## Execution

1. Main runtime persists the assistant `Agent` tool call.
2. Agent tool creates a unique 16-hex agent ID and exclusive native sidechain.
3. Sidechain root contains the requested prompt and the main prompt ID.
4. Subagent runs with shared base context plus its selected agent definition.
5. Local, MCP, Skill, hook, permission, cancellation, and redaction behavior is
   reused from the main runtime. Nested foreground Agent calls use the same
   path with incremented spawn depth.
6. Completed assistant and tool-result records append immediately to sidechain.
   Validated local `Read` image results retain the same native image envelope as
   the main chain.
7. Main tool result contains returned text and native structured execution
   metadata, then the main agent continues.

Bounds are explicit: maximum spawn depth 4, 16 subagent calls per main turn,
16 model turns per subagent, 32 tool calls per model turn, 1 MiB model output,
1 MiB tool input, and 1 MiB final returned text. Cancellation aborts active
provider and child-tool work and produces an interrupted main run, not a fake
successful Agent result.

## Native persistence

Files live beside Claude sessions:

```text
<project-root>/<session-id>/subagents/
├── agent-<agent-id>.jsonl
└── agent-<agent-id>.meta.json
```

Every sidechain message has `isSidechain: true`, `agentId`, main `sessionId`,
and an independent UUID/parent chain. Assistant entries also include
`attributionAgent`. Meta contains `agentType`, `description`, main `toolUseId`,
and `spawnDepth`.

Main `toolUseResult` records status, prompt, agent ID/type, returned content,
resolved model, duration, usage, and tool-call count. Failed Agent execution is
an error tool result; any already persisted sidechain remains available for
inspection. Exclusive creation prevents overwriting native or Praxis output.

## Deferred

- background Agent execution;
- `SendMessage` and persistent agent inboxes;
- concurrent/parallel scheduling and work stealing;
- in-place continuation of a partially written sidechain.

These require separate black-box probes and lifecycle semantics. Foreground
support must not advertise them or silently serialize a background request.

## Acceptance

- unit tests cover input, bounds, recursion, failure, cancellation, and native
  schema validation;
- integration tests prove main and sidechain persistence plus custom agents;
- installed OpenAI and Anthropic loops execute Agent and resume the result;
- Claude 2.1.208 reopens Praxis-written main session and discovers sidechain;
- existing package, performance, recovery, and compatibility gates stay green.
