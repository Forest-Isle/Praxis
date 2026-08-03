# Architecture

## Direction

Praxis preserves proven CLI agent semantics while rebuilding the code around a
single-user, local-first product boundary.

Core behavior:

```text
input -> context -> model stream -> tool call -> permission -> execution
      -> tool result -> continue, compact, or finish
```

## Intended modules

```text
src/
├── cli/           terminal UI and structured output
├── application/   run, resume, inspect, and configure use cases
├── core/          agent loop and provider-neutral domain types
├── compatibility/ versioned Claude local-protocol adapters
├── providers/     capability-aware model adapters
├── tools/         local executable capabilities
├── extensions/    MCP, skills, and hooks
├── persistence/   Claude-compatible JSONL and local sidecar indexes
└── platform/      filesystem, process, keychain, and OS adapters
```

## Hard boundaries

- `core` must not import React, Ink, model-vendor SDKs, filesystem, or storage.
- The CLI observes runtime events; it does not own agent state.
- Claude Code-compatible JSONL transcripts remain authoritative and
  append-only.
- Provider adapters expose capabilities instead of flattening every model to a
  lowest-common-denominator API.
- Tool permissions are local `allow`, `ask`, or `deny` decisions.
- No tenant, organization, role, entitlement, billing, remote-control, or
  telemetry domain exists.

## Shared Claude data plane

Praxis defaults to the same configuration root as Claude Code:
`CLAUDE_CONFIG_DIR`, falling back to `~/.claude`. It shares:

- workspace session JSONL files and UUID/parent UUID chains;
- `CLAUDE.md`, `.claude/CLAUDE.md`, and `.claude/rules` instructions;
- global and project skills, commands, and agent definitions;
- auto memory under the Claude project memory directory;
- compatible settings, hooks, and MCP configuration.

Praxis-only indexes, provider payloads, and locks are non-authoritative
sidecars under `<claude-config>/praxis/`. They must never be required to resume
the human-visible conversation from Claude Code.

`ContextAssembler` converts selected shared resources into provider-neutral
system messages for each run or resume invocation. The same system message
remains present across that invocation's tool loop. System context is ephemeral
input: it is not appended to the shared Claude transcript. Skills, commands,
agents, hooks, and MCP remain separate extension inputs instead of being
injected wholesale into the base prompt. Path-conditional rules and linked
memory details stay out of base context until a matching-file activation path
is available.

Detailed contract: [COMPATIBILITY.md](COMPATIBILITY.md).

## Clean-room rule

Claude Code may be used to identify observable behavior and build black-box
fixtures. Its source code must not be copied into Praxis.
