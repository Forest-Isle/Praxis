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
├── providers/     capability-aware model adapters
├── tools/         local executable capabilities
├── extensions/    MCP, skills, and hooks
├── persistence/   JSONL transcripts and local indexes
└── platform/      filesystem, process, keychain, and OS adapters
```

## Hard boundaries

- `core` must not import React, Ink, model-vendor SDKs, filesystem, or storage.
- The CLI observes runtime events; it does not own agent state.
- JSONL transcripts remain authoritative and append-only.
- Provider adapters expose capabilities instead of flattening every model to a
  lowest-common-denominator API.
- Tool permissions are local `allow`, `ask`, or `deny` decisions.
- No tenant, organization, role, entitlement, billing, remote-control, or
  telemetry domain exists.

## Clean-room rule

Claude Code may be used to identify observable behavior and build black-box
fixtures. Its source code must not be copied into Praxis.
