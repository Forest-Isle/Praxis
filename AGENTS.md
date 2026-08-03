# Praxis Engineering Rules

- Keep implementation clean-room. Do not copy code from the Claude Code source
  snapshot.
- Preserve observable behavior through black-box fixtures and tests.
- Keep product local-first, single-user, and CLI-only.
- Do not add accounts, organizations, RBAC, billing, remote control, IDE
  surfaces, or telemetry control planes.
- Keep the agent loop small. Add abstractions only when a second implementation
  or a verified boundary requires one.
- Keep provider-specific optimizations inside capability-aware adapters.
- Store authoritative transcripts as append-only JSONL.
- Require focused tests for every runtime behavior change.
