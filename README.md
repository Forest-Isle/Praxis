# Praxis

Praxis is a local-first, single-user general agent for the command line.

The project cleanly reimplements production-proven agent behavior without
copying Claude Code source. It keeps the CLI agent loop, tool use, permissions,
sessions, context compaction, skills, hooks, and MCP concepts while excluding
accounts, organizations, billing, managed enterprise policy, remote control,
IDE surfaces, and telemetry control planes.

## Status

Sprint 2 headless tool runtime complete. Praxis can run, resume, fork, and list
Claude-compatible sessions through a provider-neutral event loop and an
OpenAI-compatible streaming provider. Built-in read, write, edit, search, and
shell tools execute behind Claude-compatible local permission rules with
workspace path checks, timeouts, cancellation, and bounded output.

Each run or resume holds one session lease through model completion and final
persistence. Native tool calls and results append immediately to the shared
Claude transcript, and Claude Code 2.1.208 can resume a Praxis tool session.
Sprint 1 forks remain text-only: provider reasoning, queue operations, tools,
images, and compaction metadata are not copied into a fork.

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

Permissions load from the shared global and current-project Claude settings.
`Read` and `Grep` default to `allow`; `Write`, `Edit`, and `Bash` default to
`ask`. Until the interactive permission UI lands in Sprint 4, an `ask` decision
without an approval callback returns a denied tool result; add an explicit
compatible `allow` rule for trusted headless commands.

With an authenticated Claude Code 2.1.208 installation, run the isolated live
probes separately (they make real model requests):

```sh
npm run test:compat
npm run test:permission-compat
npm run test:runtime-compat
npm run test:shared-compat
```

Architecture constraints live in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
Runtime semantics and trust boundaries live in
[docs/RUNTIME_CONTRACT.md](docs/RUNTIME_CONTRACT.md) and
[docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).
