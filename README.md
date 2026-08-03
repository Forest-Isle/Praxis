# Praxis

Praxis is a local-first, single-user general agent for the command line.

The project cleanly reimplements production-proven agent behavior without
copying Claude Code source. It keeps the CLI agent loop, tool use, permissions,
sessions, context compaction, skills, hooks, and MCP concepts while excluding
accounts, organizations, billing, managed enterprise policy, remote control,
IDE surfaces, and telemetry control planes.

## Status

Sprint 1 headless runtime complete. Praxis can run, resume, fork, and list
Claude-compatible sessions through a provider-neutral event loop and an
OpenAI-compatible streaming provider. Cancellation, retry classification,
usage accounting, JSON output, and bidirectional Claude Code 2.1.208 resume
pass isolated probes.

## Product boundary

- CLI-only, including interactive and structured non-interactive output
- One local OS user, multiple workspaces and sessions
- Provider-capability-aware rather than tied to one model vendor
- Claude Code-compatible transcripts, configuration, permissions, and memory
- Optional local sub-agents; no multi-tenant control plane

## Claude Code interoperability

Praxis uses Claude Code's local data layout as its default shared data plane.
The compatibility target is bidirectional: Praxis can resume Claude Code
sessions, and Claude Code can resume sessions written by Praxis. Project
instructions, auto memory, skills, agents, hooks, and MCP configuration are
shared rather than copied into a separate Praxis ecosystem.

See [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) for protocol boundaries and
[docs/ROADMAP.md](docs/ROADMAP.md) for implementation gates.

## Development

Requires Node.js 24 or newer.

```sh
npm install
npm run typecheck
npm test
npm run build
npm run check
node dist/cli.js --help
```

Configure the first provider adapter, then run a prompt:

```sh
export PRAXIS_API_KEY=...
export PRAXIS_MODEL=...
export PRAXIS_BASE_URL=https://api.openai.com/v1

node dist/cli.js run "Inspect this project"
node dist/cli.js sessions --json
node dist/cli.js resume <session-id> "Continue"
node dist/cli.js fork <session-id>
```

`PRAXIS_BASE_URL` is optional and defaults to OpenAI's `/v1` endpoint.

With an authenticated Claude Code 2.1.208 installation, run the isolated live
probes separately (they make real model requests):

```sh
npm run test:compat
npm run test:runtime-compat
npm run test:shared-compat
```

Architecture constraints live in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
Runtime semantics and trust boundaries live in
[docs/RUNTIME_CONTRACT.md](docs/RUNTIME_CONTRACT.md) and
[docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).
