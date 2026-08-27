# ADR 0004: Praxis-owned native Transcript schema

Status: superseded — 2026-08-27 (see ADR 0002)

This ADR records the historical pre-native-only schema decision. ADR 0002 is
the active decision and defines Praxis as native-only, with one native data
plane and no legacy migration or compatibility fallback.

## Decision

The historical decision was for the Praxis Core Contract to own one
provider-neutral Transcript event model. Native sessions use a versioned
Praxis-owned JSONL schema. The previously contemplated Claude compatibility
data-plane adapter and separately versioned codec are not part of the current
runtime.

## Consequences

- Claude schema fields, producer versions, paths, and compatibility policies
  may not enter the Praxis Core Contract.
- The historical migration design is superseded: existing legacy data is
  unsupported and no migration or compatibility fallback is provided.
- Unknown native schema versions fail closed; read-only inspection and export
  remain constrained by the native runtime's valid schema handling.
- The active runtime has one native data plane and no legacy migration,
  adapter, or fallback path.
