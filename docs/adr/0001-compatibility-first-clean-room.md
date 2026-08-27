# ADR 0001: Compatibility-first clean-room architecture

Status: accepted — 2026-08-03

> Historical decision. ADR 0002 supersedes this ADR's shared-data-plane and
> migration assumptions; the active runtime is Praxis-native only. Claude
> behavior and message/tool shapes remain clean-room references, while legacy
> Claude data directories are unsupported.

## Decision

Build Praxis as an independent TypeScript CLI. Preserve Claude Code's
observable agent semantics and local data layout, but do not mirror its
internal modules or copy source. Treat shared Claude files as a versioned
external protocol. Keep Praxis-only state in disposable sidecars.

## Rationale

Claude Code's architecture is proven for its full Anthropic product, including
enterprise and remote surfaces Praxis excludes. Copying that internal coupling
would preserve irrelevant constraints. Replacing its local file layout would
split sessions and memory. Protocol compatibility plus a smaller internal
domain keeps interoperability without importing product scope.

## Consequences

- Compatibility adapters and black-box fixtures are release gates.
- Unknown Claude formats fail closed to read-only.
- Runtime core remains independent from UI, filesystem, and provider SDKs.
- Claude and Praxis can hand off sessions, but simultaneous writes to one
  session are refused rather than merged.
