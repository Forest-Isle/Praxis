# ADR 0004: Praxis-owned native Transcript schema

Status: accepted — 2026-08-23

## Decision

The Praxis Core Contract owns one provider-neutral Transcript event model.
Native sessions use a versioned Praxis-owned JSONL schema, while the optional
Claude compatibility data-plane adapter uses a separately versioned
Claude-compatible codec. The adapters encode the same core semantics and never
maintain synchronized duplicate transcripts.

## Consequences

- Claude schema fields, producer versions, paths, and compatibility policies
  may not enter the Praxis Core Contract.
- Existing native Claude-shaped sessions require lossless compatibility reads
  and an explicit, recoverable migration path before native writes switch to
  the Praxis schema.
- New native sessions use the Praxis schema. Migration writes and validates a
  separate destination before an atomic switch, retains the source plus a
  migration manifest, and supports a read-only dry run; it never rewrites the
  only copy in place.
- Unknown native schema versions fail closed; read-only inspection and export
  remain available where the valid prefix can be recovered.
- An unknown or non-lossless legacy entry blocks migration writes without
  blocking inspection or export. Claude compatibility sessions are never
  migrated implicitly.
- Direct Claude/Praxis session handoff continues only through the explicit
  Claude compatibility adapter or an explicit import/export conversion.
- Removing the Claude compatibility adapter must leave the native build,
  runtime, and native test suite functional.
