# Getting Started

## Prerequisites

Praxis supports macOS and Linux and requires:

- Node.js 24 or newer;
- npm (included with supported Node.js releases);
- `ripgrep` (`rg`) for the Grep and Glob tools;
- an API key and model ID for a stable Anthropic or OpenAI-compatible provider,
  or (experimentally) the Codex OAuth path with its explicit switch and model.

Praxis does not authenticate with a Claude subscription. Claude Code is used
only as a clean-room behavioral reference; Praxis owns and stores all runtime
data in its native local data plane.

Grep and Glob require the same local `ripgrep` executable. Install `ripgrep`
with your system package manager if `rg --version` fails. Production Glob
fails closed when ripgrep is missing or fails; it does not fall back to a
JavaScript directory walker.

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

### OpenAI Responses API

Select the built-in Responses adapter explicitly when using an OpenAI API key:

```sh
export PRAXIS_PROVIDER="openai-responses"
export OPENAI_API_KEY="your-api-key"
export PRAXIS_MODEL="your-responses-model-id"
```

This uses `https://api.openai.com/v1` and the OpenAI Responses `/responses`
endpoint. The `openai` provider remains Chat Completions; model IDs never
switch protocols implicitly. Keep API keys in the environment or a local
secret manager, not in settings files or command arguments.

### Anthropic Messages

```sh
export PRAXIS_PROVIDER="anthropic"
export PRAXIS_API_KEY="your-api-key"
export PRAXIS_MODEL="claude-sonnet-4-6"
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

Praxis gives every direct, retried, and fallback provider attempt independent
connect, byte-idle, and absolute-total timeouts, each defaulting to 90 seconds.
For slower local or compatible endpoints, set positive integer millisecond
overrides such as `PRAXIS_PROVIDER_CONNECT_TIMEOUT_MS=120000`,
`PRAXIS_PROVIDER_IDLE_TIMEOUT_MS=120000`, or
`PRAXIS_PROVIDER_DEADLINE_MS=180000`.

Anthropic Messages also retries once with a bounded non-streaming response when
the streaming attempt ends in an eligible stream transport failure or byte-idle
timeout. Praxis buffers both attempts and exposes only a terminally complete
result, so failed partial text, thinking, usage, or tool calls do not commit.
Connect/total timeout, cancellation, HTTP/auth/rate-limit, prompt-too-long, and
malformed-response errors are not replayed. Set
`PRAXIS_DISABLE_NONSTREAMING_FALLBACK=true` to disable this Anthropic-only
recovery path; detached background agents inherit the setting.

For main-session provider fallback, use the existing `--fallback-model` option
with an explicit list of model IDs on the selected provider target and
protocol. Praxis does not infer cross-protocol fallback routes. Failed attempts
stay buffered; the first successful route, whether primary or fallback, remains
sealed through that turn's tool continuations, and the next main user turn
starts from the primary model.

### Custom providers and profiles

User provider configuration is `PRAXIS_HOME/settings.json` (default
`~/.praxis/settings.json`). It contains provider metadata and credential
references, never key or token values:

```json
{
  "provider": "deepseek",
  "providerProfile": "default",
  "model": "deepseek-chat",
  "providers": {
    "deepseek": {
      "protocol": "openai-compatible",
      "profiles": {
        "default": {
          "baseUrl": "https://api.deepseek.com/v1",
          "credential": { "source": "vault" }
        }
      }
    }
  }
}
```

Custom protocols are `openai-compatible`, `openai-responses`, and
`anthropic-messages`. Credentials
may reference an environment variable, an argv `command`, or a native Vault
profile; these are alternative credential sources. Select a target per session
with `--provider`, `--provider-profile`, and `--model` (or `PRAXIS_PROVIDER`,
`PRAXIS_PROVIDER_PROFILE`, and `PRAXIS_MODEL`). Precedence is explicit CLI >
environment > trusted local selection > trusted project selection > user
settings > native defaults. Project `.praxis/settings.json` and
`.praxis/settings.local.json` can select only a provider/profile/model after
the canonical workspace configuration is trusted; their provider, profile,
and model selection participates in the same exact canonical realpath
fingerprint used for hooks and MCP. `--trust-project` approves that fingerprint
in the same invocation. Symlink aliases reuse the canonical approval, while a
change to provider/profile/model, scope, or source invalidates it. Project
settings can select only built-in or globally user-defined profiles; they
cannot define endpoints, credentials, or helpers. Native
provider resolution never reads `.claude` settings or credentials.

Store an API key without placing it in settings or command arguments:

```sh
praxis auth set-key deepseek
praxis auth status deepseek
praxis auth logout deepseek
```

The command reads interactively from the TTY. For automation, stdin is bounded
and keeps the key out of argv: `printf '%s\n' "$DEEPSEEK_API_KEY" | praxis auth
set-key deepseek`.

`status` displays metadata only. On macOS Praxis defaults to Keychain and uses
the file Vault at `$PRAXIS_HOME/.provider-credentials.json` only when Keychain
is unavailable (directory `0700`, file `0600`, atomic writes). Linux uses the
file store. `PRAXIS_PROVIDER_CREDENTIAL_STORE=file` explicitly bypasses
Keychain; arbitrary Keychain errors fail closed.

### Experimental ChatGPT-backed Codex subscription

This is not OpenAI API-key access or Claude subscription authentication. Add
the opt-in kill switch to `PRAXIS_HOME/settings.json`:

```json
{ "experimental": { "codexSubscription": true } }
```

Then use the browser loopback flow, or explicitly choose device authorization:

```sh
praxis auth login openai-codex --profile work
praxis auth login openai-codex --profile work --device --no-browser
PRAXIS_PROVIDER=openai-codex PRAXIS_PROVIDER_PROFILE=work \
  PRAXIS_MODEL=your-codex-model-id praxis
praxis auth logout openai-codex --profile work
```

The provider requires a Vault OAuth record, uses the fixed
`https://chatgpt.com/backend-api` endpoint, and rejects API keys and base-URL
overrides. Usage retains token and model usage, but `costUsd` is unavailable
and omitted: API pricing does not apply. Numeric USD budgets and plugin-eval
paid LLM judges fail before inference because numeric API-billed cost is
unavailable; subscription usage is never treated as zero or free. The
subscription OAuth/backend contract is not documented by OpenAI as a stable
third-party API; expect it to change. The switch disables login and inference
when false.

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

### Trust workspace-controlled configuration

Praxis discovers project/local provider/profile/model selection, hook, and MCP
configuration as inert data and blocks it by default. On interactive startup,
review the canonical workspace path and every displayed origin. Accepting
stores a grant for only that exact canonical realpath fingerprint; changing
provider/profile/model, a hook or MCP definition, scope, source, or hook
execution environment blocks it again. Rejection ignores project/local
provider selection and blocks project/local hooks and MCP, while ordinary
resources remain available. A legacy `projects[path].trusted: true` value is
not authorization.

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

For a stable API provider, export its key (or configure a Vault/env/helper
reference) and either `PRAXIS_MODEL` or `--model`. For Codex, enable the
experimental switch and complete `praxis auth login openai-codex`; do not set
an API key or endpoint override. Praxis does not read Claude subscription
credentials as a model-provider key.

### Provider or model request fails

Run `praxis doctor` to resolve the final provider and credential source without
network access or executing helpers; configured helpers are reported as
skipped. Check provider/profile/model selection and protocol. `openai-codex`
must have the experimental switch, a Vault OAuth record, and no API key or
base-URL override.

### Grep or Glob is unavailable

Install `ripgrep` and confirm `rg --version` succeeds in the same shell. Grep
and Glob share this local prerequisite; Glob fails closed rather than using a
JavaScript directory walker when `rg` cannot enumerate files.

### Session writes are refused

Run `praxis doctor` and inspect the native state diagnostics. Praxis fails closed
when a native session file is malformed or uses an unsupported schema version;
inspection and export report the error rather than guessing or writing a
replacement. Valid native sessions remain inspectable and export their
authoritative bytes.

### Need more diagnostics

```sh
praxis doctor --json
praxis --debug --debug-file praxis-debug.log
```

Redact workspace paths, prompts, model output, and transcript content before
sharing logs. Never share API keys. For help routing, see [SUPPORT.md](../SUPPORT.md).
