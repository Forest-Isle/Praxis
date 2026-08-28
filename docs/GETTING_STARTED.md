# Getting Started

## Prerequisites

Praxis supports macOS and Linux and requires:

- Node.js 24 or newer;
- npm (included with supported Node.js releases);
- `ripgrep` (`rg`) for the Grep tool;
- an API key and model ID for an Anthropic or OpenAI-compatible provider.

Praxis does not authenticate with a Claude subscription. Claude Code is used
only as a clean-room behavioral reference; Praxis owns and stores all runtime
data in its native local data plane.

Install `ripgrep` with your system package manager if `rg --version` fails.

## Install

```sh
npm install --global praxis-agent
praxis --version
praxis --help
```

The npm package name is `praxis-agent`; the executable is `praxis`.
Source development uses the repository-pinned npm 11 version.

## Configure a provider

### OpenAI or an OpenAI-compatible endpoint

OpenAI-compatible Chat Completions is the default adapter:

```sh
export PRAXIS_API_KEY="your-api-key"
export PRAXIS_MODEL="your-model-id"
```

For a compatible gateway or local endpoint, also set:

```sh
export PRAXIS_BASE_URL="https://api.example.com/v1"
```

Keep `PRAXIS_PROVIDER` unset or set it explicitly to `openai`.

### Anthropic Messages

```sh
export PRAXIS_PROVIDER="anthropic"
export PRAXIS_API_KEY="your-api-key"
export PRAXIS_MODEL="claude-sonnet-4-20250514"
```

The default endpoint is `https://api.anthropic.com/v1`. Set
`PRAXIS_BASE_URL` only when using a compatible gateway.

Prompt caching uses Anthropic's five-minute cache on the official endpoint.
Compatible gateways default to caching off because support varies. Set
`PRAXIS_ANTHROPIC_PROMPT_CACHING=true` to opt a gateway in, optionally with
`PRAXIS_ANTHROPIC_PROMPT_CACHE_TTL=1h` when every selected model and the gateway
support that TTL. This is an explicit capability declaration; Praxis does not
probe compatible gateways. Set the caching variable to `false` to disable it
explicitly.

Do not commit provider credentials to a repository, settings file, transcript,
or shell script. Prefer your shell's private environment or a local secret
manager.

Praxis bounds every direct, retried, and fallback provider attempt with a
90-second absolute deadline. For slower local or compatible endpoints, set a
positive integer millisecond override such as
`PRAXIS_PROVIDER_DEADLINE_MS=180000`.

## Run the first session

Start in a project directory:

```sh
cd /path/to/project
praxis
```

This opens the interactive terminal UI. A positional prompt starts the same UI
and submits the prompt once:

```sh
praxis "Inspect this project and explain its architecture"
```

Use print mode for automation or a one-shot answer:

```sh
praxis -p "Run the tests and summarize failures"
praxis -p --output-format json "List the risky changes"
```

Praxis asks before protected tool actions unless settings or CLI rules already
allow or deny them. Review every command and write request before approving it.

### Trust project executables

Praxis discovers project/local hook and MCP configuration as inert data and
blocks it by default. On interactive startup, review the canonical workspace
path and every displayed executable origin. Accepting stores a grant for only
that exact fingerprint; changing a hook or MCP definition, scope, source, or
hook execution environment blocks it again. Rejection leaves the ordinary
session, instructions, permissions, skills, commands, agents, and memory
available.

Headless runs never prompt. After reviewing the project configuration, approve
the current fingerprint explicitly:

```sh
praxis --trust-project -p "Run with the reviewed project integrations"
```

User-scope resources and explicit `--settings` or `--mcp-config` inputs are
treated as user-authorized. Tool permission bypass does not grant workspace
trust. Safe and bare modes continue to suppress shared hooks and MCP regardless
of stored trust.

### Bound MCP operations

MCP startup and discovery use a 10-second absolute bound by default. Set
`MCP_TIMEOUT` to a strict positive safe-integer millisecond value to override
it. MCP tool calls use a separate 60-second bound; override it with
`MCP_TOOL_TIMEOUT`. Invalid values stop service construction before any
configured MCP transport starts.

When a server disconnects, stale tools, resources, prompts, and instructions
are hidden. An invocation that has not dispatched yet may share a bounded
reconnect; an already-dispatched tool call is never replayed. A later
invocation can reconnect and try again.

## Resume and inspect work

```sh
praxis --resume
praxis --continue
praxis sessions --json
praxis inspect --json <session-id>
praxis export <session-id> > session.jsonl
```

`--resume` opens a picker in a terminal. It also accepts a session UUID, exact
title in print mode, or search text in the interactive picker.

## Native local state

Praxis uses its independent `~/.praxis` data plane by default, or `PRAXIS_HOME`
when set. Sessions, instructions, memory, skills, agents, hooks, settings,
plugins, and MCP configuration are kept in this native local data plane.

## Safe and isolated runs

Use safe mode to disable shared customizations, or bare mode to start with only
explicitly supplied context:

```sh
praxis --safe-mode
praxis -p --bare --tools Read,Grep "Inspect without shared customizations"
praxis -p --no-session-persistence "Answer without writing a session"
```

`--dangerously-skip-permissions` intentionally bypasses normal checks except
explicit deny rules. Do not use it as a routine setup shortcut.

To run Bash commands inside the OS sandbox, open `/sandbox`
and select an isolated mode, or add this to `.praxis/settings.local.json`:

```json
{
  "sandbox": {
    "enabled": true,
    "autoAllowBashIfSandboxed": true
  }
}
```

Auto-allow applies only when the command will actually run inside the sandbox;
explicit ask and deny rules still win. The sandbox restricts filesystem writes
and network access according to native Praxis settings. Use `/sandbox` to check
dependencies and inspect the effective configuration.

## Update or remove Praxis

```sh
# Defaults to the latest release.
praxis update
# Same latest-release target as update.
praxis upgrade
# Install the stable channel by default, or pass a channel/exact semver target.
praxis install [--force] [target]

# Direct npm remains a manual alternative:
npm install --global praxis-agent@latest

npm uninstall --global praxis-agent
```

On supported macOS/Linux global npm layouts, `praxis update` and `praxis
upgrade` validate the current installation, take an exclusive sibling lock,
verify npm metadata and both SHA-512 SRI and SHA-1 checksums, and install only
the verified tarball with lifecycle scripts disabled. The package is staged on
the same filesystem and its manifest and CLI versions are gated before and
after the atomic swap. If an update fails in process, Praxis restores the old
installation; after a crash, its external launcher recovers the journaled
backup. Corrupt or mismatched packages are rejected, concurrent updates are
rejected, and cancellation retains exit code 130. Public failures omit
subprocess stderr and temporary paths. Direct npm installation does not use
these locking, verification, staging, or recovery safeguards.

Every release includes provenance, SBOM, checksums, and GitHub attestations.
See [RELEASE.md](RELEASE.md) for verification details.

## Troubleshooting

### `PRAXIS_API_KEY and a model ... are required`

Export `PRAXIS_API_KEY` and either `PRAXIS_MODEL` or pass `--model` in the shell
that launches Praxis. Praxis does not read Claude subscription credentials as a
model-provider key.

### Provider or model request fails

Check `PRAXIS_PROVIDER`, `PRAXIS_MODEL`, and `PRAXIS_BASE_URL`. The provider must
match the endpoint protocol: `anthropic` for Anthropic Messages, `openai` for
OpenAI-compatible Chat Completions.

### Grep is unavailable

Install `ripgrep` and confirm `rg --version` succeeds in the same shell.

### Session writes are refused

Run `praxis doctor`. Praxis refuses writes when the detected Claude Code local
format is outside its validated profile; inspection and export remain available.

### Need more diagnostics

```sh
praxis doctor --json
praxis --debug --debug-file praxis-debug.log
```

Redact workspace paths, prompts, model output, and transcript content before
sharing logs. Never share API keys. For help routing, see [SUPPORT.md](../SUPPORT.md).
