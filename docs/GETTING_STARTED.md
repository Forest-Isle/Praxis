# Getting Started

## Prerequisites

Praxis supports macOS and Linux and requires:

- Node.js 24 or newer;
- npm (included with supported Node.js releases);
- `ripgrep` (`rg`) for the Grep tool;
- an API key and model ID for an Anthropic or OpenAI-compatible provider.

Praxis does not authenticate with a Claude subscription. Its Claude Code
compatibility concerns local data and behavior, not account or billing access.

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

Do not commit provider credentials to a repository, settings file, transcript,
or shell script. Prefer your shell's private environment or a local secret
manager.

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

## Share local state with Claude Code

Praxis uses `~/.claude` by default, or `CLAUDE_CONFIG_DIR` when set. Compatible
sessions, instructions, memory, skills, agents, hooks, settings, plugins, and
MCP configuration remain on that shared data plane.

Before relying on bidirectional writes, check the installed Claude Code version:

```sh
claude --version
praxis doctor
```

Every semver-like Claude Code producer version is structurally validated and
read/write compatible when its entry shapes are supported. Malformed or
unsupported shapes remain available for safe inspection and export but fail
closed for transcript writes. See [COMPATIBILITY.md](COMPATIBILITY.md) for the
exact contract.

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

To run Bash commands inside the Claude-compatible OS sandbox, open `/sandbox`
and select an isolated mode, or add this to `.claude/settings.local.json`:

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
and network access according to shared Claude settings. Use `/sandbox` to check
dependencies and inspect the effective configuration.

## Update or remove Praxis

```sh
praxis update
# Or use npm directly:
npm install --global praxis-agent@latest

npm uninstall --global praxis-agent
```

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
