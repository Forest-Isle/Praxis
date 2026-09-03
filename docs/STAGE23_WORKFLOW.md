# Stage 23 Workflow Contract

## Goal

Implement Claude Code 2.1.208-compatible `Workflow` for single-user CLI: sandboxed
JavaScript orchestration, background task lifecycle, workflow subagents, persisted
runs/journals, deterministic replay, named workflows, cancellation, resume, and
interactive status. Claude and Praxis must read the same user-visible artifacts.

## Solution and rationale

Use `quickjs-emscripten` as the script security boundary, `acorn` for strict static
metadata extraction, and `ajv` for structured agent results. Node `vm` is not a
security boundary. Host code owns model calls, concurrency, persistence, worktrees,
limits, and aborts; QuickJS receives only frozen workflow primitives.

Workflow remains separate from ordinary `Agent`: its IDs, directories, replay journal,
progress, and task lifecycle differ. It may reuse the same provider-neutral model loop
and tool registry, but writes workflow-specific Claude paths and metadata.

## Architecture

```text
Workflow tool -> WorkflowManager -> WorkflowStore
                             |-> QuickJsWorkflowRuntime
                             |      `-> host bridge: agent/workflow/log/phase/budget
                             `-> WorkflowAgentRunner -> provider + tools
                                                    `-> workflow sidechain store

TaskOutput / TaskStop -> workflow IDs first -> existing Agent/Bash routing fallback
Stop / process exit  -> abort task -> abort every active agent -> persist killed state
```

## Key components

- `application/workflow-contract.ts`: schemas, IDs, paths, launch/notification text.
- `persistence/workflow-store.ts`: atomic scripts/run JSON, append-only journal,
  replay index, workflow agent transcript and metadata.
- `application/workflow-meta.ts`: parse module, require pure-literal `meta` first,
  validate name/description/phases without executing script.
- `application/workflow-runtime.ts`: QuickJS runtime, deterministic guards, async host
  bridge, pipeline/parallel semantics, limits, nested depth, budget.
- `application/workflow-manager.ts`: background tasks, status, stop, notifications,
  resume, progress and usage aggregation.
- `tools/claude-workflow-tools.ts`: exact public schema, source precedence, validation,
  permissions and routing.

## Data flow

1. Resolve source in order `scriptPath`, `script`, `name`; saved workflows live under
   project/user Praxis workflow roots; built-ins are `deep-research` and `code-review`.
2. Parse pure first-statement metadata before permission or execution. Permission mode
   defaults to `ask`; denial creates no workflow artifacts.
3. Allocate `wf_<8hex>-<3hex>` and `w<8alnum>`, persist script, return launch result,
   then execute in background.
4. Runtime invokes host agents with bounded concurrency. Host appends `started` and
   `result` journal records and reuses completed matching entries on resume.
5. Every terminal path atomically writes run JSON (`completed`, `failed`, `killed`) and
   queues one task notification. `TaskOutput` terminal retrieval consumes it.
6. Resume reuses run ID/transcript directory and cache but allocates a new task ID and
   overwrites the run summary only after terminal state.
7. A session/run pair may have only one active execution in a process; concurrent resume
   is rejected before any script or run artifact can be overwritten.

## Contract and limits

- Script max 524288 bytes; plain JavaScript; async top-level body.
- Optional metadata `phases` is an array of objects with required string `title` and
  optional string `detail` and `model` fields; string entries are rejected.
- `agent`, `parallel`, `pipeline`, `workflow`, `log`, `phase`, `args`, `budget` only.
- `Date.now`, argless `new Date`, and `Math.random` throw; no Node/filesystem/network.
- Concurrency `min(16, max(1, cpuCount - 2))`; max 1000 agents/run; collection max 4096.
- `parallel` converts each thrown thunk to `null`; `pipeline` drops a failed item to
  `null` while other item chains continue without stage barriers.
- Nested workflow depth is one. Any cancel aborts nested work and all active agents.
- `schema` exposes only `StructuredOutput`, requires exactly one valid final call, and
  stores its input object as result.
- `isolation: 'worktree'` creates an ownership-recorded temporary checkout under
  `<repo>/.praxis/worktrees/workflow`, removes it on terminal completion only after
  its registry, Git marker, repository, registration, base, and cleanliness agree,
  and reports retained user changes or failed cleanup instead of hiding them.

## Errors

- Input/meta/source errors are synchronous tool errors and create no workflow
  artifacts; native sessions still claim and persist the error completion exactly once.
- Individual agent/provider/schema/isolation failures become `null`, append a completed
  replay pair, and let script-level parallel/pipeline logic continue.
- Top-level runtime, token-budget, validation, and agent-count failures fail the run,
  preserve journal/transcripts, and include a recovery invocation.
- Missing resume journal is valid and starts with an empty cache.
- Unknown task IDs fall through to existing task managers, preserving current errors.

## Tests

- Unit: source/meta validation, paths, atomic store, replay, limits, deterministic
  guards, pipeline/parallel, schema, nesting, cancellation, worktree cleanup.
- Integration: tool permission/no-artifact denial, launch, TaskOutput/TaskStop,
  notification consumption, failure/resume, named/built-in workflows, persisted shape.
- Live gate: capture Claude schema; run and same-runtime-resume Praxis workflows with no
  repeated provider call after replacing the journal key; verify private semantic replay
  metadata and native artifacts; require Claude to exact-replay a Praxis-created journal
  without changing it; require Praxis to replay a Claude-created journal without a child
  request.
- Compatibility fixtures: retain captured Claude run/journal/progress/request evidence and
  fixed first/subsequent key values used to define replay behavior.
- Release gates: full Vitest, typecheck/lint/format/build, package, performance, existing
  task/subagent/scheduled compatibility suites.

## Replay compatibility

Claude 2.1.208 journal keys are a chained `v2:<sha256>` identity. Each call hashes the
previous replay key, a NUL separator, prompt, another NUL separator, and JSON for
recursively key-sorted `schema`, `model`, `effort`, `isolation`, and `agentType` options.
The chain starts empty and is shared by top-level and nested agent calls. Label, phase,
callbacks, and undefined values do not affect identity. Fixed first/subsequent-call
fixtures and the live Claude cache-hit gate protect this contract.

Praxis also writes full semantic descriptors to the private
`.praxis-replay-metadata.jsonl` sidecar, so its completed agents replay if a foreign
runtime rewrites the journal key. Without that sidecar, an unchanged script and args can
replay completed journal slots by started order, including semantic
model/effort/schema/isolation options. Sources using nested `workflow` or `budget` are
excluded from this ordinal proof; changed script/args and missing result slots fail
closed. A unique-prompt fallback remains available only for current calls without
semantic options.
