# CLI Reference

`praxis --help` is the authoritative command and option reference. This document
groups the stable public surface by task and records provider environment
behavior that is otherwise easy to miss.

## Invocation modes

| Mode                 | Example                                                                      | Behavior                                                             |
| -------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Interactive          | `praxis`                                                                     | Opens the terminal UI and persists a session.                        |
| Prompted interactive | `praxis "Review this project"`                                               | Opens the UI and submits one initial prompt.                         |
| Print                | `praxis -p "Review this project"`                                            | Prints a response and exits.                                         |
| JSON result          | `praxis -p --output-format json "Review"`                                    | Emits one machine-readable result.                                   |
| Stream JSON          | `praxis -p --input-format stream-json --output-format stream-json --verbose` | Processes bounded JSONL input and output over one service lifecycle. |
| Background           | `praxis --bg "Review this project"`                                          | Starts a persistent top-level agent.                                 |

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
# Review the displayed project/local hook and MCP origins, then accept the
# current canonical workspace executable fingerprint for this invocation.
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

## Provider environment

| Variable                            | Required           | Meaning                                                                     |
| ----------------------------------- | ------------------ | --------------------------------------------------------------------------- |
| `PRAXIS_API_KEY`                    | Yes for model runs | Provider or compatible-gateway credential.                                  |
| `PRAXIS_MODEL`                      | Yes for model runs | Provider model identifier.                                                  |
| `PRAXIS_PROVIDER`                   | No                 | `openai` (default) or `anthropic`.                                          |
| `PRAXIS_BASE_URL`                   | No                 | Provider base URL; defaults by selected provider.                           |
| `PRAXIS_PROVIDER_DEADLINE_MS`       | No                 | Positive integer absolute deadline per provider attempt; defaults to 90000. |
| `PRAXIS_MAX_OUTPUT_TOKENS`          | No                 | Positive Anthropic-only output-token limit.                                 |
| `PRAXIS_ANTHROPIC_VERSION`          | No                 | Non-empty Anthropic API version override.                                   |
| `PRAXIS_ANTHROPIC_WEB_SEARCH`       | No                 | `true` or `false`; enables provider-native Anthropic WebSearch capability.  |
| `PRAXIS_ANTHROPIC_PROMPT_CACHING`   | No                 | `true` or `false`; explicitly enables or disables Anthropic prompt caching. |
| `PRAXIS_ANTHROPIC_PROMPT_CACHE_TTL` | No                 | `5m` or `1h`; declares endpoint/model support and enables that cache TTL.   |
| `PRAXIS_CONTEXT_WINDOW_TOKENS`      | No                 | Positive explicit provider context window.                                  |
| `PRAXIS_CONTEXT_RESERVE_TOKENS`     | No                 | Positive reserve; requires an explicit context window.                      |
| `PRAXIS_PRICING_JSON`               | No                 | JSON model-pricing overrides used for measured cost and budget enforcement. |
| `PRAXIS_HOME`                       | No                 | Native Praxis root; defaults to `~/.praxis`.                                |
| `PRAXIS_DISABLE_AUTO_MEMORY`        | No                 | `1` or `true`; disables every native Project-memory capability.             |
| `PRAXIS_PROJECT_MEMORY_EXTRACTION`  | No                 | `1` or `true`; enables isolated background Project-memory extraction.       |
| `PRAXIS_PROJECT_MEMORY_RECALL`      | No                 | `1` or `true`; enables non-blocking selective Project-memory recall.        |
| `PRAXIS_ENABLE_TEAMS`               | No                 | `true`; explicitly enables experimental local Team commands and tools.      |

The default base URLs are `https://api.openai.com/v1` for `openai` and
`https://api.anthropic.com/v1` for `anthropic`.

Every direct, retried, or fallback provider attempt has its own absolute
deadline. Set `PRAXIS_PROVIDER_DEADLINE_MS` to a positive integer number of
milliseconds to override the 90-second default.

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
  project/local hook and MCP fingerprint;
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

- Automatically discovered project/local hooks and MCP servers are blocked by
  default. Interactive startup shows their canonical origins and defaults to
  reject; headless startup never prompts. An explicit acceptance or
  `--trust-project` stores only the current executable fingerprint in native
  `state.json`. Changing a command, argument, environment grant, header,
  transport, scope, or resolved source invalidates it. User-scope resources and
  explicit `--settings`/`--mcp-config` inputs retain their existing behavior.
  `--dangerously-skip-permissions` never grants workspace trust, and safe/bare
  modes still suppress shared executables.
- `--dangerously-skip-permissions` bypasses normal checks except explicit deny
  rules and requires explicit enablement.
- `--mcp-config` may start local processes or contact remote endpoints; review
  every server definition before loading it.
- `--add-dir` expands the filesystem boundary for the session.
- Debug output is redacted, but prompts and workspace content may still be
  sensitive. Review logs before sharing them.

For implementation-level schemas and exact parity evidence, use
[PARITY_MATRIX.md](PARITY_MATRIX.md) and `praxis --help`.
