# Claude Code Single-User CLI Parity Matrix

## Scope

Target: observable single-user CLI behavior and shared local data compatibility
with Claude Code 2.1.208. Praxis remains a clean-room, provider-neutral
implementation; module names and private source structure are not compatibility
contracts.

Permanent exclusions are limited to organization, tenant, RBAC, billing,
enterprise gateway, IDE, Chrome, Remote Control, and hosted Ultrareview product
surfaces. A missing CLI feature is not an exclusion.

Evidence levels:

- **Live**: exercised against installed Claude Code 2.1.208 and Praxis.
- **Fixture**: isolated unit/integration or installed-package contract test.
- **Missing**: required implementation or executable evidence is absent.

## Invocation and machine I/O

| Capability                           | Status                   | Evidence / remaining work                                                                                                |
| ------------------------------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Interactive TTY                      | Complete                 | Ink event adapter, permission/recovery prompts, session picker; package and unit gates                                   |
| Print/headless prompt                | Complete                 | `-p`, `--print`, top-level prompt, and legacy `run`; installed package gate                                              |
| Resume syntax                        | Complete                 | `-r`, `--resume`, and legacy `resume`; shared transcript continuation                                                    |
| Explicit session ID                  | Complete                 | UUID validation, atomic `wx` reservation, existing/empty-file rejection matching live 2.1.208                            |
| Text output                          | Complete                 | Realtime terminal deltas and final newline                                                                               |
| Single JSON result                   | Partial                  | Success/error shape complete; provider cost and API-only duration are explicit `null` until metering lands               |
| Stream JSON output                   | Partial                  | Init, assistant, tool result, result, warning, and error envelopes complete; result metering remains missing             |
| Partial messages                     | Complete                 | message/content/tool delta lifecycle under `--include-partial-messages`                                                  |
| Stream JSON input                    | Complete for text blocks | Incremental UTF-8/CRLF NDJSON parser, bounds, empty-input no-op, multi-turn run-to-resume, replay; installed gate        |
| User image/file input records        | Missing                  | Requires native input attachment envelopes and provider projection                                                       |
| SDK control request/response records | Missing                  | Permission and interrupt control protocol not yet exposed over stdin/stdout                                              |
| Legacy Praxis `--json`               | Complete                 | Existing runtime NDJSON retained without changing explicit Claude-style formats                                          |
| `--continue`                         | Complete                 | Most-recent current-project selection with native resume behavior                                                        |
| `--fork-session`                     | Complete                 | Resume/continue forks preserve native history and title with generated or explicit fresh session identity                |
| Session name                         | Partial                  | `--name` writes native `custom-title`/`agent-name` and Claude resumes it; Praxis picker display remains                  |
| No persistence                       | Partial                  | In-memory run and disk-session import leave JSONL untouched; foreground Agent remains disabled without sidechain storage |

## Shared Claude data plane

| Capability                                 | Status                              | Evidence / remaining work                                                                              |
| ------------------------------------------ | ----------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Session discovery and bidirectional resume | Complete                            | Live Claude -> Praxis -> Claude and Praxis -> Claude gates for 2.1.208                                 |
| Native message/tool JSONL                  | Complete                            | Versioned schema, strict links, optimistic tail checks, leases                                         |
| Native fork fidelity                       | Complete                            | Full main-chain copy and live Claude reopen                                                            |
| Read-only recovery/export                  | Complete                            | Unsupported/corrupt session inspect and byte-exact export                                              |
| CLAUDE.md and rules                        | Complete                            | Hierarchy, conditional attachment, live fixtures                                                       |
| Auto memory                                | Complete                            | Canonical main-worktree memory path, standard tool access                                              |
| Skills and commands                        | Complete at runtime                 | Shared discovery, slash expansion, model-invocable Skill                                               |
| Agents                                     | Partial                             | Shared definitions and foreground Agent complete; background lifecycle missing                         |
| Hooks                                      | Complete for current runtime events | Shared settings, bounded child execution, native attachments                                           |
| MCP                                        | Partial                             | Shared config, tool/resource calls, and configured-server status complete; management commands missing |
| Plugins                                    | Missing                             | Plugin discovery, lifecycle, marketplace, validation, and session loading                              |
| Version gate                               | Complete for 2.1.208                | Exact read-write allowlist; all other versions read-only                                               |

## Runtime and controls

| Capability                    | Status                      | Evidence / remaining work                                                                                              |
| ----------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Provider-neutral agent loop   | Complete                    | OpenAI-compatible and Anthropic streaming/tool loops                                                                   |
| Context budget and compaction | Complete                    | Provider capability budget, native compact records, live reopen                                                        |
| Foreground subagents          | Complete                    | Bounded recursion, sidechains, tools/hooks/MCP, live reopen                                                            |
| Background agents and tasks   | Missing                     | Persistent Task lifecycle, output polling, stop, resume, dispatch                                                      |
| Agent messaging               | Missing                     | SendMessage and user communication controls                                                                            |
| Permissions                   | Partial                     | CLI allow/deny, acceptEdits/manual/dontAsk/plan/bypass complete; `auto` classifier missing                             |
| Tool selection                | Complete                    | `--tools`, empty/default sets, aliases, exact deny removal, and execution-boundary enforcement                         |
| Settings sources              | Complete                    | Inline/file `--settings`, source filtering across all customization categories, safe/bare isolation                    |
| System prompt controls        | Complete                    | replace/append direct and hidden file variants with shared context retained                                            |
| Additional directories        | Complete                    | Canonical Read/Write/Edit/Grep roots, provider visibility, and symlink-escape rejection                                |
| Model selection               | Partial                     | Environment selection complete; `--model` invocation option missing                                                    |
| Effort and fallback           | Missing                     | `--effort`, retry fallback model chain                                                                                 |
| Structured output             | Missing                     | `--json-schema` validation and `structured_output` result                                                              |
| Cost and budget               | Missing                     | Provider pricing, accurate cost/API duration, `--max-budget-usd`; result metrics stay `null` rather than claiming zero |
| Prompt suggestions            | Missing                     | Post-turn `prompt_suggestion` event                                                                                    |
| Cancellation                  | Complete for process signal | SIGINT, provider/tool/hook propagation, exit 130                                                                       |

## Tool surface

| Capability                           | Status   | Evidence / remaining work                                                                             |
| ------------------------------------ | -------- | ----------------------------------------------------------------------------------------------------- |
| Read / Write / Edit / Grep / Bash    | Complete | Path, symlink, bounds, permissions, persistence gates                                                 |
| Skill / foreground Agent / MCP tools | Complete | Provider-neutral registries and native persistence                                                    |
| Glob                                 | Complete | Native hidden/ignored matching, mtime order, 100-result bound, live resume                            |
| WebFetch / WebSearch                 | Missing  | Network tools, policy, citation/result bounds                                                         |
| NotebookEdit                         | Complete | Native cell view, read-before-edit, replace/insert/delete, Claude resume gate                         |
| Worktree enter/exit                  | Missing  | `EnterWorktree`, `ExitWorktree`, CLI `--worktree`                                                     |
| Task/Cron/Monitor/Workflow           | Missing  | Durable scheduling and process lifecycle                                                              |
| MCP resource tools                   | Complete | Conditional schemas, paginated list, text/blob read, directory stub, status, persistence, live resume |

## Management commands

| Capability             | Status  | Evidence / remaining work                                             |
| ---------------------- | ------- | --------------------------------------------------------------------- |
| `agents`               | Missing | Background agent list/dispatch/JSON/cwd options                       |
| `mcp`                  | Missing | add/get/list/login/logout/remove/serve/import/reset choices           |
| `plugin`               | Missing | install/enable/disable/update/list/init/validate/marketplace          |
| `doctor`               | Missing | Local installation, provider, config, MCP, and permission diagnostics |
| `auth` / `setup-token` | Missing | Provider-neutral credential profiles and validation                   |
| `install` / `update`   | Missing | Distribution channel and self-update behavior                         |
| `project purge`        | Missing | Safe project state cleanup                                            |
| `auto-mode`            | Missing | Classifier configuration surface                                      |

## Remaining implementation order

1. Missing web tools.
2. Durable background tasks, agents, messaging, cron, monitor, and workflow.
3. Worktree/tmux/background invocation, picker naming, ephemeral subagents,
   and permission `auto` classifier.
4. Plugin runtime and management.
5. MCP management commands.
6. Model effort/fallback, structured output, pricing/budget, suggestions,
   diagnostics, auth, and update commands.
7. Final live black-box matrix, package/performance regression, and macOS/Linux
   Node 24/25 clean-room release gates.
