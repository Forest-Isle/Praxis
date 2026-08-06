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

| Capability                           | Status                   | Evidence / remaining work                                                                                                                      |
| ------------------------------------ | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Interactive TTY                      | Complete                 | Ink event adapter, permission/recovery prompts, session picker; package and unit gates                                                         |
| Print/headless prompt                | Complete                 | `-p`, `--print`, top-level prompt, and legacy `run`; installed package gate                                                                    |
| Resume syntax                        | Complete                 | `-r`, `--resume`, and legacy `resume`; shared transcript continuation                                                                          |
| Explicit session ID                  | Complete                 | UUID validation, atomic `wx` reservation, existing/empty-file rejection matching live 2.1.208                                                  |
| Text output                          | Complete                 | Realtime terminal deltas and final newline                                                                                                     |
| Single JSON result                   | Partial                  | Success/error shape plus measured API duration and priced usage; unknown model pricing remains explicitly `null`                               |
| Stream JSON output                   | Partial                  | Init, assistant, tool result, result, warning, error, measured result metrics, and `prompt_suggestion` records complete; other controls remain |
| Partial messages                     | Complete                 | message/content/tool delta lifecycle under `--include-partial-messages`                                                                        |
| Stream JSON input                    | Complete for text blocks | Incremental UTF-8/CRLF NDJSON parser, bounds, empty-input no-op, multi-turn run-to-resume, replay; installed gate                              |
| User image/file input records        | Missing                  | Requires native input attachment envelopes and provider projection                                                                             |
| SDK control request/response records | Missing                  | Permission and interrupt control protocol not yet exposed over stdin/stdout                                                                    |
| Legacy Praxis `--json`               | Complete                 | Existing runtime NDJSON retained without changing explicit Claude-style formats                                                                |
| `--continue`                         | Complete                 | Most-recent current-project selection with native resume behavior                                                                              |
| `--fork-session`                     | Complete                 | Resume/continue forks preserve native history and title with generated or explicit fresh session identity                                      |
| Session name                         | Complete                 | `--name` writes native `custom-title`/`agent-name`, Claude resumes it, and Praxis session summaries/picker display the native name             |
| No persistence                       | Partial                  | In-memory run and disk-session import leave JSONL untouched; foreground Agent remains disabled without sidechain storage                       |
| Top-level background session         | Complete                 | `--bg`/`--background`, managed session ID, detached persistent worker, idle attach, logs, stop, and live cross-resume gate                     |

## Shared Claude data plane

| Capability                                 | Status                              | Evidence / remaining work                                                                                                        |
| ------------------------------------------ | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Session discovery and bidirectional resume | Complete                            | Live Claude -> Praxis -> Claude and Praxis -> Claude gates for 2.1.208                                                           |
| Native message/tool JSONL                  | Complete                            | Versioned schema, strict links, optimistic tail checks, leases                                                                   |
| Native fork fidelity                       | Complete                            | Full main-chain copy and live Claude reopen                                                                                      |
| Read-only recovery/export                  | Complete                            | Unsupported/corrupt session inspect and byte-exact export                                                                        |
| CLAUDE.md and rules                        | Complete                            | Hierarchy, conditional attachment, live fixtures                                                                                 |
| Auto memory                                | Complete                            | Canonical main-worktree memory path, standard tool access                                                                        |
| Skills and commands                        | Complete at runtime                 | Shared discovery, slash expansion, model-invocable Skill                                                                         |
| Agents                                     | Complete for local runtime          | Shared definitions, foreground/background Agent sidechains, and persistent top-level dispatch with bidirectional resume          |
| Hooks                                      | Complete for current runtime events | Shared settings, bounded child execution, native attachments                                                                     |
| MCP                                        | Partial                             | Shared config, tool/resource calls, configured-server status, and local lifecycle management complete; OAuth/import/serve remain |
| Plugins                                    | Missing                             | Plugin discovery, lifecycle, marketplace, validation, and session loading                                                        |
| Version gate                               | Complete for 2.1.208                | Exact read-write allowlist; all other versions read-only                                                                         |

## Runtime and controls

| Capability                    | Status                      | Evidence / remaining work                                                                                                                     |
| ----------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider-neutral agent loop   | Complete                    | OpenAI-compatible and Anthropic streaming/tool loops                                                                                          |
| Context budget and compaction | Complete                    | Provider capability budget, native compact records, live reopen                                                                               |
| Foreground subagents          | Complete                    | Bounded recursion, sidechains, tools/hooks/MCP, live reopen                                                                                   |
| Background agents and tasks   | Complete for local runtime  | Agent/Bash task lifecycle plus top-level persistent dispatch, live logs, attach, stop, stale-worker repair, and shared transcripts            |
| Agent messaging               | Complete for local Agent    | Ordered SendMessage to running/completed IDs, later-turn sidechain hydration, completion notification                                         |
| Permissions                   | Partial                     | CLI allow/deny, acceptEdits/manual/dontAsk/plan/bypass complete; `auto` classifier missing                                                    |
| Tool selection                | Complete                    | `--tools`, empty/default sets, aliases, exact deny removal, and execution-boundary enforcement                                                |
| Settings sources              | Complete                    | Inline/file `--settings`, source filtering across all customization categories, safe/bare isolation                                           |
| System prompt controls        | Complete                    | replace/append direct and hidden file variants with shared context retained                                                                   |
| Additional directories        | Complete                    | Canonical Read/Write/Edit/Grep roots, provider visibility, and symlink-escape rejection                                                       |
| Model selection               | Complete                    | Environment and `--model` invocation selection, fallback model resolution                                                                     |
| Effort and fallback           | Complete                    | `--effort`, retryable three-attempt fallback chain, print-only validation                                                                     |
| Structured output             | Complete                    | `--json-schema` AJV validation, hidden tool capture, exact-once enforcement, `structured_output` result                                       |
| Cost and budget               | Partial                     | Built-in/explicit pricing, measured API duration, and `--max-budget-usd`; unknown/private model pricing remains null/fail-closed              |
| Prompt suggestions            | Complete                    | `--prompt-suggestions` validates print/stream-json mode, performs an unpersisted auxiliary request, and emits post-result `prompt_suggestion` |
| Cancellation                  | Complete for process signal | SIGINT, provider/tool/hook propagation, exit 130                                                                                              |

## Tool surface

| Capability                         | Status   | Evidence / remaining work                                                                                                       |
| ---------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Read / Write / Edit / Grep / Bash  | Complete | Path, symlink, bounds, permissions, persistence gates                                                                           |
| Skill / Agent / MCP tools          | Complete | Provider-neutral registries, foreground/background sidechains, and native persistence                                           |
| Glob                               | Complete | Native hidden/ignored matching, mtime order, 100-result bound, live resume                                                      |
| WebFetch / WebSearch               | Partial  | Live schemas/search/errors/resume; real Praxis public fetch; Claude public-success oracle needs domain-safety service           |
| NotebookEdit                       | Complete | Native cell view, read-before-edit, replace/insert/delete, Claude resume gate                                                   |
| Worktree enter/exit                | Complete | Native Git lifecycle, state entries, dynamic cwd, CLI `--worktree`, and classic tmux launcher; live bidirectional gate          |
| TaskCreate/Get/List/Update         | Complete | Shared Claude task files, dependencies, metadata, deletion, high-watermark recovery, and bidirectional live gate                |
| CronCreate/List/Delete and `/loop` | Complete | Session/durable jobs, shared native file, idle delivery, expiry, and live bidirectional gate                                    |
| ScheduleWakeup                     | Partial  | Praxis interactive one-shot/stop lifecycle complete; Claude inactive gate live; active Claude gate/result still unobservable    |
| Monitor                            | N/A      | Claude Code 2.1.208 exposes no standalone Monitor tool                                                                          |
| Workflow                           | Partial  | Runtime, sandbox, task lifecycle, native files, options and same-run replay complete; exact Praxis -> Claude replay key unknown |
| MCP resource tools                 | Complete | Conditional schemas, paginated list, text/blob read, directory stub, status, persistence, live resume                           |

## Management commands

| Capability             | Status   | Evidence / remaining work                                                            |
| ---------------------- | -------- | ------------------------------------------------------------------------------------ |
| `agents`               | Complete | Active/history listing, JSON, cwd filter, plus logs/attach/stop                      |
| `mcp`                  | Partial  | add/add-json/get/list/remove/reset-project-choices; login/logout/serve/import remain |
| `plugin`               | Missing  | install/enable/disable/update/list/init/validate/marketplace                         |
| `doctor`               | Missing  | Local installation, provider, config, MCP, and permission diagnostics                |
| `auth` / `setup-token` | Missing  | Provider-neutral credential profiles and validation                                  |
| `install` / `update`   | Missing  | Distribution channel and self-update behavior                                        |
| `project purge`        | Missing  | Safe project state cleanup                                                           |
| `auto-mode`            | Missing  | Classifier configuration surface                                                     |

## Remaining implementation order

1. Complete a live successful Claude WebFetch oracle with its domain-safety
   service available.
2. Exact active Claude `ScheduleWakeup` result and cross-runtime Workflow replay
   key if observable from future black-box evidence.
3. Ephemeral subagents and permission `auto` classifier.
4. Plugin runtime and management.
5. Complete MCP OAuth/login/logout, Desktop import, and server hosting.
6. Complete unknown-model pricing policy, diagnostics,
   auth, and update commands.
7. Final live black-box matrix, package/performance regression, and macOS/Linux
   Node 24/25 clean-room release gates.
