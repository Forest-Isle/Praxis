# ADR 0005: Gate workspace executable configuration behind trust

Status: accepted — 2026-08-28

Issue: [#475](https://github.com/Forest-Isle/Praxis/issues/475)

## Goal

Automatically discovered project configuration must not start hook or MCP
processes until the user explicitly trusts the canonical workspace and the
current executable configuration. Ordinary local-first sessions must remain
usable when that trust is absent or rejected.

## Decision

Praxis owns one native **workspace executable trust** policy. The policy is
separate from tool permission modes and applies before `ClaudeHookRunner` or a
project/local MCP transport can execute.

Trust is keyed by the workspace path returned by `realpath`. The accepted
record lives in native `~/.praxis/state.json` under
`projects[canonicalPath].workspaceTrust` and contains:

- a schema version;
- a SHA-256 fingerprint of executable project configuration;
- the acceptance timestamp.

The fingerprint is a canonical serialization of:

- `hooks` definitions from automatically discovered project/local settings;
- MCP server definitions from automatically discovered project/local MCP
  resources;
- each definition's scope and resolved source path.

Object keys are sorted before hashing; array order remains significant. The
workspace path is the state key rather than duplicated inside the fingerprint.
Changing unrelated settings does not invalidate trust, while changing a hook,
MCP command, argument, environment grant, header, transport, scope, or source
does.

Plugin MCPB references are discovered without downloading or extracting the
bundle. A local MCPB contributes its resolved source path and archive SHA-256;
a remote MCPB contributes its exact HTTPS URL, whose existing sticky cache is
materialized only after trust. The URL grant therefore authorizes the first
bounded fetch from that exact source; normal startup does not refresh a valid
cached bundle. Local archives are rechecked across materialization, and a
changed source is blocked until restart.

User-scope resources and resources explicitly supplied by CLI arguments are
already authorized by the user action and are not included in this automatic
project fingerprint. Plugin-produced project/local hook or MCP resources are
included because their executable origin is still the workspace.

## Runtime flow

1. Resolve the workspace using `realpath`.
2. Load resources as data without starting project processes.
3. Build the executable resource inventory and fingerprint.
4. If the inventory is empty, continue without a trust record.
5. If native state contains the same accepted fingerprint, continue.
6. If `--trust-project` is present, atomically persist the fingerprint and
   continue.
7. In an interactive TTY, request a decision showing the canonical path and
   resource origins. The default choice is reject. Acceptance is persisted;
   rejection is cached only for the current process.
8. In headless mode, or after rejection/cancellation, emit an actionable
   warning and remove only project/local executable hook and MCP resources.
9. Construct hooks and MCP clients from the remaining resources.

The interactive prompt runs during the initial read-only service preflight,
before the main conversation renderer owns stdin. It supports accept, reject,
EOF, abort, and screen-reader output. Acceptance and rejection are cached for
that exact fingerprint. If executable configuration changes after the renderer
starts, the new fingerprint is blocked without competing for terminal input;
the warning asks the user to restart and review it or use `--trust-project` on
the next invocation.

## Persistence and concurrency

Trust mutations use the shared `.praxis-state.lock`, no-follow reads, regular
file validation, compare-before-commit, atomic rename, mode `0600`, and a
bounded retry. Unknown root, project, and project-state fields are preserved.

Missing state means untrusted. Invalid JSON, non-object roots/projects/project
entries, symlinks, or concurrent mutation failures never imply trust and are
reported without overwriting state.

## Compatibility and safety

- `--safe-mode` and bare/simple mode continue to disable shared executable
  capabilities even when trust exists.
- `--dangerously-skip-permissions` does not grant workspace trust.
- Project instructions, rules, permissions, commands, agents, skills, memory,
  and non-hook settings continue loading while executable trust is absent.
- User hooks/MCP and explicit `--settings`/`--mcp-config` keep their existing
  behavior.
- Symlink aliases share the trust state of their canonical workspace.
- MCP reload applies the same policy before connecting newly discovered
  project/local servers.
- `/cd` relocation confirmation remains #90, but any service created for the
  new cwd must still pass this executable trust policy.

## Error handling

- Rejection, cancellation, or non-TTY execution is not a session failure;
  project executable resources are blocked and a warning names the remedy.
- State corruption or an unsafe state path is an actionable configuration
  error and fails closed.
- An approval persistence failure does not execute the resource.
- Fingerprint creation rejects unsupported cyclic/non-JSON values rather than
  hashing an unstable representation.

## Test strategy

- Unit-test canonicalization, source/scope sensitivity, harmless-setting
  stability, changed hook/MCP invalidation, canonical paths, malformed state,
  unknown-field preservation, and concurrent state updates.
- Integration-test `createDefaultService` with user/project/local/explicit
  hook and MCP fixtures, including marker processes that must not start.
- Test interactive accept/reject/cancel caching and headless warning behavior.
- Test `--trust-project` parsing/help and safe/bare precedence.
- Run focused Vitest files, formatter, linter, typecheck, build,
  `npm run check`, package, performance, native deletion, and dependency audit.

## Rejected alternatives

### Trust a path forever

A single `trusted: true` bit would not notice a later malicious config change.
Path plus executable fingerprint makes the authority match what will run.

### Prompt for every hook or MCP server

Per-process prompts provide finer granularity but create repeated decisions,
partial startup states, and a larger durable policy. One reviewed workspace
inventory is smaller and still invalidates on any executable change.

### Reuse tool permission mode

Hooks and MCP transports start outside ordinary model tool calls. Treating
permission bypass or an allow rule as workspace trust would silently broaden
authority and preserve the current vulnerability.
