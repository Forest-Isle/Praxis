# ADR 0002: Remove Claude compatibility layers

## Decision

Supersedes: ADR 0004 (Praxis-owned native Transcript schema)

Praxis is native-only. Claude data-plane selection, legacy JSONL transcript
reading, Claude session metadata, `.claude` configuration paths, legacy resume
and fork behavior, live Claude compatibility probes, and their CI/documentation
entries are removed. Existing legacy data is intentionally unsupported; no
migration command is provided.

## Consequences

- Native transcript/config/session schemas are the only supported runtime
  contracts.
- `PRAXIS_DATA_PLANE` accepts no compatibility value and `CLAUDE_CONFIG_DIR`
  is ignored/rejected.
- Claude-shaped source modules are retained only when they implement a native
  Praxis capability; compatibility-only modules and tests are deleted.
- Package and CI gates validate native behavior only.

## Acceptance

`npm run check`, `npm run test:package`, `npm run test:performance`,
`npm audit --omit=dev`, and the complete Vitest suite pass with no live Claude
compatibility probe or legacy data-plane branch remaining.
