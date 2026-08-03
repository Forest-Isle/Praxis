# Praxis

Praxis is a local-first, single-user general agent for the command line.

The project cleanly reimplements production-proven agent behavior without
copying Claude Code source. It keeps the CLI agent loop, tool use, permissions,
sessions, context compaction, skills, hooks, and MCP concepts while excluding
accounts, organizations, billing, managed enterprise policy, remote control,
IDE surfaces, and telemetry control planes.

## Status

Sprint 0 compatibility kernel in progress. Claude 2.1.208 path mapping,
versioned JSONL parsing, provider translation, and concurrent-write protection
are implemented; broad agent runtime remains behind compatibility black-box
gates.

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

With an authenticated Claude Code 2.1.208 installation, run the isolated live
probes separately (they make real model requests):

```sh
npm run test:compat
npm run test:shared-compat
```

Architecture constraints live in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
Runtime semantics and trust boundaries live in
[docs/RUNTIME_CONTRACT.md](docs/RUNTIME_CONTRACT.md) and
[docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).
