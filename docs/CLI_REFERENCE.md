# CLI Reference

`praxis --help` is the authoritative command and option reference. This document
groups the stable public surface by task and records provider environment
behavior that is otherwise easy to miss.

## Invocation modes

| Mode                 | Example                                                                      | Behavior                                                                            |
| -------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Interactive          | `praxis`                                                                     | Opens the terminal UI and persists a session.                                       |
| Prompted interactive | `praxis "Review this project"`                                               | Opens the UI and submits one initial prompt.                                        |
| Print                | `praxis -p "Review this project"`                                            | Prints a response and exits. A SIGINT while awaiting the provider exits 0 silently. |
| JSON result          | `praxis -p --output-format json "Review"`                                    | Emits one machine-readable result.                                                  |
| Stream JSON          | `praxis -p --input-format stream-json --output-format stream-json --verbose` | Processes bounded JSONL input and output over one service lifecycle.                |
| Background           | `praxis --bg "Review this project"`                                          | Starts a persistent top-level agent.                                                |

## Common workflows

```sh
# Resume, continue, fork, and inspect
praxis --resume
praxis --continue
praxis --resume <session-id> "Continue"
praxis --resume <session-id> --fork-session "Try another approach"
praxis sessions --json
praxis inspect --json <session-id>
praxis export <session-id> > session.jsonl

# Restrict context and tools
praxis -p --safe-mode "Inspect without shared customizations"
praxis -p --bare --tools Read,Grep "Read only"
praxis -p --setting-sources project --add-dir ../shared "Inspect both roots"
# Review the displayed project/local provider/profile/model selection and hook
# and MCP origins, then accept the current canonical workspace-controlled
# resource/configuration fingerprint.
praxis --trust-project

# Bound model execution
praxis -p --model <model-id> --max-turns 4 "Investigate"
praxis -p --max-budget-usd 0.50 --output-format json "Investigate"
praxis -p --thinking adaptive --max-thinking-tokens 8192 "Reason within a cap"

# Provider-free session color command (also supports JSON and stream JSON)
praxis -p "/color purple"

# Background agents
praxis --bg "Investigate in the background"
praxis agents
praxis agents --json --all --cwd "$PWD"
praxis logs <agent-id>
praxis attach <agent-id>
praxis stop <agent-id>

# Inside the interactive TUI
/init
# Analyze the repository and create or improve its shared PRAXIS.md guidance.
# Set PRAXIS_NEW_INIT=1 before launch to enable the enhanced
# PRAXIS.md + PRAXIS.local.md + skills/hooks onboarding flow.
/btw Explain this result without changing the conversation
# Press f in the answer panel to continue it as a background Agent.
/background
# Moves a completed conversation to a new persistent job and frees the terminal.
# Use the printed praxis attach/logs/stop commands with its eight-hex job ID.
/sandbox
/sandbox exclude "docker:*"
/color purple
# Colors only the current session's prompt-bar separators.
/color default
# Restores the default dim separators.

# MCP and plugins
praxis mcp list
praxis plugin list --available
praxis plugin marketplace list

# Health and maintenance
praxis doctor
praxis update
```

Shell placeholders such as `<session-id>` and `<model-id>` must be replaced;
they are documentation notation, not literal arguments.

With the default tool selection, Praxis exposes `ToolSearch` instead of sending
every `mcp__*` schema in the first model request. A search activates at most
eight matching MCP tools for the next request and resets at the next user turn.
Concrete `--tools` selections load their selected schemas directly. Use
`--disallowedTools ToolSearch` to disable deferral and restore the complete MCP
tool list.

## Glob environment

Glob uses the local `ripgrep` (`rg`) executable shared with Grep. It includes
hidden files and ignores ignore rules by default; if `rg` is missing, fails, or
enumeration is truncated, Glob fails closed and has no JavaScript directory
walker fallback.

| Variable                     | Default behavior                      | Exact-`false` behavior                                       |
| ---------------------------- | ------------------------------------- | ------------------------------------------------------------ |
| `CLAUDE_CODE_GLOB_HIDDEN`    | Include hidden files (`--hidden`)     | Omit `--hidden`                                              |
| `CLAUDE_CODE_GLOB_NO_IGNORE` | Include ignored files (`--no-ignore`) | Omit `--no-ignore` and apply normal ripgrep ignore filtering |

Only the exact lowercase string `false` changes either behavior. Unset, empty,
`0`, uppercase `FALSE`, and every other value retain the defaults.

## Stream JSON compatibility environment

Stream JSON output omits `session_state_changed` records by default. Set
`CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1` to enable the Claude-compatible state
records; unset, empty, `0`, `false`, and every other value leave them disabled.
When enabled, `running` precedes the turn's `system/init` record and terminal
`idle` follows the `result` record, so `result` is not the final JSON line.

For direct print invocations, SIGINT while awaiting the provider exits 0
silently. Stream JSON retains the `system/init` record received before the
signal and emits no synthetic assistant, result, or error record. SIGTERM and
non-print/programmatic cancellation retain the ordinary cancellation diagnostic
and exit code 130.

## Machine result envelopes

JSON and stream JSON result records use the Claude Code 2.1.208 machine-result
shape. Provider-backed successes expose numeric API duration and cost values,
the observed stop reason when available, `terminal_reason: "completed"`, rich
zero-filled usage fields, numeric per-model costs, and provider timing fields
only when request/output boundaries were observed. Provider API failures use
`subtype: "success"` with `is_error: true`, `api_error_status`, a normalized
`API Error: <status> ...` result, `stop_reason: "stop_sequence"`, and
`terminal_reason: "api_error"`; the CLI still exits 1.

Provider-free `/color` produces a zero-turn success envelope with zero duration,
cost, rich zero usage, and empty `modelUsage`. Provider-free `/cost` also has
zero turns and zero current-turn API duration, but preserves its accumulated
`total_cost_usd` and populated `modelUsage`. Provider-only status, timing, and
terminal fields are omitted for both commands; the CLI exits 0.

## Project outcome evaluations

Run strict project cases in isolated workspaces:

```sh
praxis eval ./my-project
praxis eval --case bug-* --tag regression --runs 2 --model <model> ./my-project
praxis eval --allow-tools Bash --run-verification --output-dir ./eval-results ./my-project
praxis eval --json ./my-project
```

Cases are discovered under `<target>/evals/**/case.yaml`. A minimal case is:

```yaml
schema_version: '1.0'
name: writes-result
fixture: fixture
execution:
  prompt: 'Update the result file.'
verification:
  - name: result-check
    command: node
    args: ['-e', "process.exit(require('fs').existsSync('result.txt') ? 0 : 1)"]
expect:
  allowed_changed_paths: [result.txt]
  expected_changed_paths: [result.txt]
  forbidden_changed_paths: [.env]
```

Fixtures and paths must be contained, bounded, and free of symlinks, special
files, `.git`, and `node_modules`. Defaults are one run, ten turns, 120 seconds,
and `Read`, `Glob`, and `Grep` tools. Gated tools require `--allow-tools`.
`expect.allowed_changed_paths` is optional; when omitted (or empty), no
workspace mutation is allowed. Cases may also define deterministic `graders`
using `regex`, `tool_used`, `tool_order`, and `file_exists` checks.
Verifiers require `--run-verification`; they run sequentially by executable and
argv without a shell, with bounded output/time and a minimal environment.

Artifacts default to `$PRAXIS_HOME/evals/results/<timestamp>` (or the configured
native config root), with `aggregate-result.json` and per-case/run
`trace.jsonl`, `workspace-diff.json`, `verification.json`, and `result.json`.

Compare two separate completed runs without rerunning either target:

```sh
praxis eval compare --baseline ./baseline/aggregate-result.json \
  --baseline-name baseline --candidate ./candidate/aggregate-result.json \
  --candidate-name candidate --json
```

The command writes `comparison-result.json` beside the candidate artifact (or
under `--output-dir`). Each input must be an internally consistent v1.0 JSON
regular file of at most 8 MiB, not a symlink. The command requires matching,
complete `(case, run)` sets and fails with status 1 when candidate pass rate or
safety pass rate regresses, or when complete safety evidence is unavailable. A
process interruption returns status 130 without writing a completed comparison.
Safety is the eight harness checks
(`trace-bounds`, `runtime-close`, `workspace-manifest`, `source-unchanged`,
`allowed-paths`, `forbidden-paths`, `artifact-write`, and `temp-cleanup`).
The comparison reports pass/safety rates, average turns and duration, token and
cost totals, permission decisions, tool errors, retries, and terminations.
Metrics whose evidence is unavailable are reported as `null` (including token
deltas when either run has unknown usage and cost deltas when either total is
unknown). The hermetic baseline lane is available with
`npm run test:eval:baseline`. Real-model evaluations remain opt-in through the
ordinary `praxis eval` command and explicit provider/model configuration.
Trace values are recursively redacted for sensitive environment data and are
bounded to 10,000 events and 8 MiB; exceeding a bound fails the run. Use
`--output-dir` to choose another local directory. Exit status is 0 when all
runs pass, 1 for a completed failure, and 130 when interrupted. Unknown cost is
recorded as unavailable (`null`) rather than zero; artifacts remain local.

## Self-update lifecycle

```sh
praxis install [--force] [target]
praxis update
praxis upgrade
```

`install` defaults to the `stable` channel; `update` and `upgrade` default to
`latest`. The accepted channels and exact semantic-version targets are
unchanged. On supported macOS/Linux global npm layouts, self-update validates
the current package, acquires an exclusive sibling lock, resolves npm
distribution metadata, and downloads with `npm pack --ignore-scripts`.
It independently verifies the SHA-512 SRI and SHA-1 shasum, then installs only
the verified tarball with lifecycle scripts disabled into same-filesystem
staging. Manifest and CLI versions are gated before and after the atomic root
swap; a durable external launcher and fsynced journal allow an in-process
failure to restore the old root and a crash to recover the exact journaled
backup. Transaction artifacts are cleaned after completion. Concurrent updates
are rejected, cancellation preserves exit code 130, and public failures redact
subprocess stderr and temporary paths. Windows is unsupported by this
transaction.

Direct `npm install --global praxis-agent@latest` remains a manual alternative,
but bypasses Praxis's locking, verification, staging, and recovery safeguards.

## Experimental local Teams

Local Teams are experimental and require explicit activation for every command:

```sh
export PRAXIS_ENABLE_TEAMS=true
praxis team create <manifest.json> --lead-session-id <session-id>
praxis team resume <team-id> --lead-session-id <session-id>
praxis team list
praxis team accept <team-id> <task-id> --lead-session-id <session-id> --generation <n> --decision accepted
praxis team stop <team-id> --lead-session-id <session-id> [--drain-ms <ms>]
```

`team accept` also accepts `--decision rejected`; generation selects the task
execution being reviewed, and decision records the Lead's acceptance or
rejection. `team stop` uses the Team's durable shutdown-drain budget when
`--drain-ms` is omitted. A create manifest contains the roster, tasks, claims,
and optional immutable policies and budgets:

```json
{
  "teamId": "docs-team",
  "name": "Documentation",
  "roster": [
    { "name": "writer", "agentType": "general-purpose", "access": "write" }
  ],
  "tasks": [
    {
      "id": "readme",
      "description": "Update the README",
      "assignee": "writer",
      "blockedBy": [],
      "claims": {
        "files": ["README.md"],
        "publicContracts": [],
        "generatedArtifacts": [],
        "migrations": [],
        "mergeTargets": []
      }
    }
  ],
  "leadPolicy": "hybrid",
  "executionPolicy": "sequential",
  "commitPolicy": "lead",
  "budgets": {
    "maxAgents": 2,
    "maxConcurrent": 2,
    "maxTokens": 50000,
    "maxDurationMs": 600000,
    "shutdownDrainMs": 5000
  }
}
```

Omitted policies default to Hybrid lead control, sequential execution, and
Lead-owned commits. Team members remain unable to create commits.

`swarm` overlaps only independent, dependency-ready tasks whose claims do not
conflict. Budgets are
durable and enforce agent count, concurrency, tokens, duration, and shutdown
drain. Child permissions inherit the parent and may only become stricter;
concurrent child asks share one FIFO Lead Decision surface with Team, member,
task, and generation provenance. A `coordinator` Lead can use Agent, task
lifecycle/board, decision/message/monitor, and Team tools only; repository
mutation, Workflow, Skill, scheduled, worktree, wrapper, dynamic, and MCP paths
are denied. Custom Team agents receive their selected prompt but no MCP server
or tool capability. Teams remain local-first, single-user, and non-remote.

## Provider authentication

```text
praxis auth status [provider] [--profile <profile>] [--json]
praxis auth set-key <provider> [--profile <profile>] [--json]
praxis auth login openai-codex [--profile <profile>] [--device] [--no-browser] [--json]
praxis auth logout <provider> [--profile <profile>] [--json]
```

`status` shows metadata only. `set-key` reads an API key from stdin/TTY into
the native Vault. `login` is only for experimental `openai-codex`; `logout`
deletes exactly one provider/profile credential. `--device` is valid only for
`auth login`. `--no-browser` is valid for `auth login` and MCP login. `--json`
is a general output flag; `--profile` selects an auth profile, while model
sessions use `--provider-profile`.

## Provider environment

| Variable                               | Required           | Meaning                                                                             |
| -------------------------------------- | ------------------ | ----------------------------------------------------------------------------------- |
| `PRAXIS_API_KEY`                       | No                 | Legacy highest-priority API secret override (never used by Codex).                  |
| `PRAXIS_MODEL`                         | Yes for model runs | Provider model identifier.                                                          |
| `PRAXIS_PROVIDER`                      | No                 | Provider ID: `openai`, `anthropic`, `openai-codex`, or custom.                      |
| `PRAXIS_PROVIDER_PROFILE`              | No                 | Named provider profile.                                                             |
| `PRAXIS_BASE_URL`                      | No                 | Provider base URL; defaults by selected provider.                                   |
| `PRAXIS_PROVIDER_DEADLINE_MS`          | No                 | Positive integer absolute-total timeout per provider attempt; defaults to 90000.    |
| `PRAXIS_PROVIDER_CONNECT_TIMEOUT_MS`   | No                 | Positive integer timeout until provider response headers; defaults to 90000.        |
| `PRAXIS_PROVIDER_IDLE_TIMEOUT_MS`      | No                 | Positive integer timeout between non-empty response-body chunks; defaults to 90000. |
| `PRAXIS_DISABLE_NONSTREAMING_FALLBACK` | No                 | `true` or `false`; disables the default Anthropic non-streaming recovery replay.    |
| `PRAXIS_MAX_OUTPUT_TOKENS`             | No                 | Positive Anthropic-only output-token limit.                                         |
| `PRAXIS_ANTHROPIC_VERSION`             | No                 | Non-empty Anthropic API version override.                                           |
| `PRAXIS_ANTHROPIC_WEB_SEARCH`          | No                 | `true` or `false`; enables provider-native Anthropic WebSearch capability.          |
| `PRAXIS_ANTHROPIC_PROMPT_CACHING`      | No                 | `true` or `false`; explicitly enables or disables Anthropic prompt caching.         |
| `PRAXIS_ANTHROPIC_PROMPT_CACHE_TTL`    | No                 | `5m` or `1h`; declares endpoint/model support and enables that cache TTL.           |
| `PRAXIS_CONTEXT_WINDOW_TOKENS`         | No                 | Positive explicit provider context window.                                          |
| `PRAXIS_CONTEXT_RESERVE_TOKENS`        | No                 | Positive reserve; requires an explicit context window.                              |
| `PRAXIS_PRICING_JSON`                  | No                 | JSON model-pricing overrides used for measured cost and budget enforcement.         |
| `PRAXIS_HOME`                          | No                 | Native Praxis root; defaults to `~/.praxis`.                                        |
| `PRAXIS_PROVIDER_CREDENTIAL_STORE`     | No                 | `file` explicitly selects the native file Vault.                                    |
| `PRAXIS_DISABLE_AUTO_MEMORY`           | No                 | `1` or `true`; disables every native Project-memory capability.                     |
| `PRAXIS_PROJECT_MEMORY_EXTRACTION`     | No                 | `1` or `true`; enables isolated background Project-memory extraction.               |
| `PRAXIS_PROJECT_MEMORY_RECALL`         | No                 | `1` or `true`; enables non-blocking selective Project-memory recall.                |
| `PRAXIS_ENABLE_TEAMS`                  | No                 | `true`; explicitly enables experimental local Team commands and tools.              |

The default base URLs are `https://api.openai.com/v1` for `openai` and
`https://api.anthropic.com/v1` for `anthropic`. `openai-codex` always uses
`https://chatgpt.com/backend-api`; it rejects API keys and endpoint overrides.

Native settings are `$PRAXIS_HOME/settings.json`. Built-ins are `openai`,
`anthropic`, and experimental `openai-codex`; custom profiles use
`openai-compatible` or `anthropic-messages` and credential references (`env`,
argv `command`, or `vault`). Plaintext secrets are rejected. Selection
precedence is explicit CLI > environment > trusted local selection > trusted
project selection > user settings > native defaults.

For a main-session turn, pass an explicit list of model IDs with
`--fallback-model` after selecting the provider target. Fallback models use
that same target and protocol; Praxis does not infer cross-protocol routes.
Failed attempts remain buffered, and the first successful route, whether
primary or fallback, stays sealed through the turn's tool continuations. A new
main user turn starts from the primary model.

`openai-codex` requires `experimental.codexSubscription: true`, a Vault OAuth
credential, and its private Responses/SSE transport. It is a ChatGPT-backed
subscription integration, not a stable OpenAI API-compatible endpoint.

Subscription usage retains token and model usage but omits `costUsd`; API
pricing does not apply. Numeric USD budgets and plugin-eval paid LLM judges
fail before inference because numeric API-billed cost is unavailable. Detached
background agents inherit `PRAXIS_PROVIDER`, `PRAXIS_PROVIDER_PROFILE`,
`PRAXIS_MODEL`, `PRAXIS_BASE_URL`, `PRAXIS_PROVIDER_DEADLINE_MS`,
`PRAXIS_PROVIDER_CONNECT_TIMEOUT_MS`, `PRAXIS_PROVIDER_IDLE_TIMEOUT_MS`, and
`PRAXIS_DISABLE_NONSTREAMING_FALLBACK` through the sanitized environment. The
parent resolves the selected API-key credential and passes only a normalized
`PRAXIS_API_KEY`; configured custom environment names and unrelated secrets are
not inherited. Codex workers reopen the same Vault instead of receiving an
OAuth token, and
`PRAXIS_PROVIDER_CREDENTIAL_STORE` is preserved so parent and worker select the
same storage backend.

Every direct, retried, or fallback provider attempt has independent connect,
stream-idle, and absolute-total clocks. Connect covers provider setup and each
HTTP exchange until response headers arrive. Idle starts at headers and resets
after every non-empty body chunk, including SSE keepalives and partial frames;
it pauses while the async-iterator consumer holds an event. Total remains
absolute across the complete attempt. Set the three timeout variables to
positive integer millisecond values to override their independent 90-second
defaults.

Anthropic Messages uses one default-on recovery replay after an explicitly
eligible streaming transport failure or byte-idle timeout. The first attempt is
fully buffered; only a terminally complete streaming response or terminally
complete bounded non-streaming response is exposed, so partial text, thinking,
usage, and tool calls cannot commit twice. Connect/total timeout, cancellation,
HTTP/auth/rate-limit, prompt-too-long, malformed response, OpenAI-compatible,
and Codex paths do not activate this replay. Set
`PRAXIS_DISABLE_NONSTREAMING_FALLBACK=true` to use only the original Anthropic
streaming attempt. Each attempt still receives independent clocks.

Prompt caching defaults to five minutes on the official Anthropic endpoint and
to disabled on compatible gateways. Configure it with the native
`PRAXIS_ANTHROPIC_PROMPT_CACHING` and `PRAXIS_ANTHROPIC_PROMPT_CACHE_TTL`
variables. Cache policy is captured when a session runtime is
created; changing these variables affects only newly created runtimes. Setting
the one-hour TTL is an explicit operator capability declaration for every model
that runtime may select; Praxis does not probe compatible gateways for it.

Startup file downloads also support `PRAXIS_FILES_BASE_URL`,
`PRAXIS_FILES_BEARER_TOKEN`, and `PRAXIS_FILES_API_KEY`. A bearer token wins;
the files API key is next; `PRAXIS_API_KEY` is the final credential fallback.

## MCP lifecycle environment

These variables control MCP server lifecycle operations; they are separate from
provider environment variables.

| Variable           | Default | Validation                        | Applies to                                                         |
| ------------------ | ------- | --------------------------------- | ------------------------------------------------------------------ |
| `MCP_TIMEOUT`      | `10000` | Strict positive safe integer (ms) | Transport creation/start, initialize, and all paginated discovery. |
| `MCP_TOOL_TIMEOUT` | `60000` | Strict positive safe integer (ms) | Normal and permission-prompt MCP tool calls.                       |

The connection bound is one absolute deadline across transport setup and tool,
resource, and prompt discovery pages. Invalid values fail service construction
before a configured transport starts. After a disconnect, stale catalog entries
are hidden; pre-dispatch invocations share one bounded reconnect (up to three
attempts with 250/500 ms backoff), while an already-dispatched tool call is
never replayed. A later invocation may reconnect and run normally.

## Settings and shared resources

Praxis can load native user, project, and local settings. Important
controls include:

- `--setting-sources user,project,local` to select normal shared sources;
- `--settings <file-or-json>` to add an explicit settings object;
- `--safe-mode` to disable shared customizations;
- `--bare` to use only explicitly supplied context;
- `--trust-project` to accept the current canonical workspace's exact
  project/local provider/profile/model, hook, and MCP fingerprint;
- `--system-prompt` and `--append-system-prompt` for prompt control;
- `--add-dir` for additional canonical filesystem roots;
- `--allowed-tools`, `--disallowed-tools`, and `--permission-mode` for local
  permission behavior.

Project memory is enabled by default. Set `autoMemoryEnabled` to `false` to
disable its index, guidance, tool root, extraction, and recall together. The
opt-in `projectMemory.backgroundExtraction` and
`projectMemory.selectiveRecall` booleans enable their respective gated local
capabilities.

Claude-compatible `sandbox` settings enable OS-level isolation for Bash:

```json
{
  "sandbox": {
    "enabled": true,
    "autoAllowBashIfSandboxed": true,
    "allowUnsandboxedCommands": true,
    "excludedCommands": ["docker:*"]
  }
}
```

Use `/sandbox` for the Mode, Dependencies, Overrides, and Config panels. Use
`/sandbox exclude "pattern"` to append an exclusion to
`.praxis/settings.local.json`. Explicit `Bash(...)` deny and ask rules remain
stronger than sandbox auto-allow. `dangerouslyDisableSandbox` only bypasses
isolation when `allowUnsandboxedCommands` is true.

## Persistence and recovery

Normal runs persist native `praxis.transcript` v1 JSONL under
`$PRAXIS_HOME/sessions/<project-key>/`. `--no-session-persistence` keeps a
print-mode run in memory. `inspect` and `export` preserve malformed or
unsupported native files for diagnostics without rewriting them.

When `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=true`, successful file edits
create compatible checkpoints. Rewind is a provider-free operation:

```sh
praxis -p --resume <session-id> --rewind-files <user-message-uuid>
```

## Security-sensitive controls

- Automatically discovered project/local provider/profile/model selection,
  hooks, and MCP servers are blocked by default. Interactive startup shows the
  canonical workspace and origins and defaults to reject; headless startup
  never prompts. An explicit acceptance or `--trust-project` stores only the
  current canonical configuration fingerprint in native `state.json`.
  Changing provider/profile/model, a command, argument, environment grant,
  header, transport, scope, or resolved source invalidates it. User-scope
  resources and explicit `--settings`/`--mcp-config` inputs retain their
  existing behavior. Rejection ignores project/local provider selection and
  removes project/local hooks and MCP resources; ordinary resources remain
  usable. A legacy `projects[path].trusted: true` value is not authorization.
  `--dangerously-skip-permissions` never grants workspace trust, and safe/bare
  modes still suppress shared executables.
- `--dangerously-skip-permissions` bypasses normal checks except explicit deny
  rules and requires explicit enablement.
- `--mcp-config` may start local processes or contact remote endpoints; review
  every server definition before loading it.
- `--add-dir` expands the filesystem boundary for the session.
- Debug output is redacted, but prompts and workspace content may still be
  sensitive. Review logs before sharing them.

For implementation-level executable evidence, use
[NATIVE_FIXTURE_CONTRACTS.md](NATIVE_FIXTURE_CONTRACTS.md) and its
[`test/fixtures/manifest.json`](../test/fixtures/manifest.json); `praxis --help`
remains the authoritative CLI surface. [PARITY_MATRIX.md](PARITY_MATRIX.md) is
retained as a historical clean-room record.
