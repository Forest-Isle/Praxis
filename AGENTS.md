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
- Treat Claude Code's `.claude` layout as the shared data plane. Do not create a
  competing session, memory, skill, or project-instruction ecosystem.
- Store authoritative transcripts as Claude Code-compatible append-only JSONL.
- Never add Praxis-specific entry types or fields to shared transcripts unless
  compatibility tests prove Claude Code accepts them. Use sidecars under the
  Claude config root for private operational state.
- Require focused tests for every runtime behavior change.
