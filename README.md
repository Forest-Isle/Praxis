# Praxis

[English](README.md) | [简体中文](README_zh.md)

[![CI](https://github.com/Forest-Isle/Praxis/actions/workflows/ci.yml/badge.svg)](https://github.com/Forest-Isle/Praxis/actions/workflows/ci.yml)
[![CodeQL](https://github.com/Forest-Isle/Praxis/actions/workflows/codeql.yml/badge.svg)](https://github.com/Forest-Isle/Praxis/actions/workflows/codeql.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/Forest-Isle/Praxis/badge)](https://scorecard.dev/viewer/?uri=github.com/Forest-Isle/Praxis)
[![npm](https://img.shields.io/npm/v/praxis-agent)](https://www.npmjs.com/package/praxis-agent)
[![npm provenance](https://img.shields.io/badge/npm-provenance-blue)](https://www.npmjs.com/package/praxis-agent)
[![license](https://img.shields.io/github/license/Forest-Isle/Praxis)](https://github.com/Forest-Isle/Praxis/blob/main/LICENSE)

Praxis is a local-first, single-user general agent for the command line.

It provides an interactive or headless agent loop, local tools, permissions,
sessions, skills, hooks, MCP, plugins, background agents, and provider-neutral
Anthropic/OpenAI-compatible model access. Praxis deliberately excludes
accounts, organizations, billing, managed enterprise policy, remote control,
IDE surfaces, and telemetry control planes.

Claude Code 2.1.208 remains the architecture, design, and observable
compatibility baseline for included and required single-user developer
capabilities. Only entries classified `required` block developer-core
closure; `deferred` entries are optional and demand-driven. Exclusions cover
the existing enterprise, authentication, hosted, and client surfaces plus the
explicitly classified subscription-bound integration, campaign, hidden
maintainer diagnostic, and build-experimental commands. A similar Praxis
surface is not a substitute for the corresponding Claude command or runtime
contract.

## Requirements

- macOS or Linux
- Node.js 24 or newer
- [`ripgrep`](https://github.com/BurntSushi/ripgrep) (`rg`) for the Grep tool
- an API key and model ID for an Anthropic or OpenAI-compatible provider

Praxis does not use Claude subscription authentication. Claude Code
interoperability covers local sessions, configuration, permissions, memory,
skills, hooks, agents, plugins, and MCP data.

## Install

```sh
npm install --global praxis-agent
praxis --version
```

Release tarballs, SBOMs, SHA-256 checksums, and build attestations are attached
to every [GitHub release](https://github.com/Forest-Isle/Praxis/releases).

## Quick start

OpenAI or an OpenAI-compatible endpoint is the default provider:

```sh
export PRAXIS_API_KEY="your-api-key"
export PRAXIS_MODEL="your-model-id"
# Optional for a compatible gateway:
# export PRAXIS_BASE_URL="https://api.example.com/v1"

cd /path/to/project
praxis
```

For Anthropic Messages:

```sh
export PRAXIS_PROVIDER="anthropic"
export PRAXIS_API_KEY="your-api-key"
export PRAXIS_MODEL="claude-sonnet-4-20250514"

cd /path/to/project
praxis
```

Common non-interactive operations:

```sh
praxis -p "Inspect this project"
praxis -p --output-format json "Summarize the test failures"
praxis --resume
praxis sessions --json
praxis doctor
```

See
[Getting Started](https://github.com/Forest-Isle/Praxis/blob/main/docs/GETTING_STARTED.md)
for provider setup, shared Claude state, permissions, updating, and
troubleshooting. Run `praxis --help` for the authoritative command surface.

## What Praxis provides

- **Local agent runtime** — Claude-style responsive TUI with a fixed fullscreen
  viewport, non-shrinking composer/status area, and complete bounded welcome
  surface, plus a shared-command
  slash palette, tabbed help and shortcut surfaces, searchable resume picker,
  restored active-branch conversation history, streaming and expandable
  thinking, grouped multi-file reads, globally expandable tool results,
  command-specific `/add-dir`, code-aware `/copy`, `/branch`, `/rename`, `/export`,
  provider-free read-only shared `/hooks`, provider-backed `/compact`, native
  `/rewind`, runtime `/cd`, transcript-free
  `/btw` side questions with background-Agent handoff, interactive
  `/background` terminal handoff, unified `/status`/`/config`/`/usage` settings
  tabs, `/sandbox` mode/dependency/override/config controls, local cached
  `/release-notes`, Claude-compatible `/statusline` command execution and setup
  agent, source-aligned `/init` project-instruction onboarding with its enhanced
  skills/hooks flow, provider-free per-session `/color` prompt-bar styling,
  `/mcp`, `/memory` shared instruction and auto-memory
  access, and live extension-reload controls,
  cursor/history composer, provider-free `/cost` usage and pricing summaries,
  interactive `/doctor` diagnostics, per-session model/effort/permission controls,
  context/status/skill/task dashboards, prompt stash and continuation shortcuts,
  filterable `@` file and agent references, composer undo, `Ctrl+G` external
  editing, shared `/keybindings` creation/editing and supported-action remapping,
  shared built-in and Claude-compatible custom `/theme` profiles with immediate
  semantic recoloring, token editing/reset, deletion, and persisted syntax
  toggles across transcript code and diff views,
  shared runtime preferences for reduced motion, spinner tips, progress and
  turn-duration display, editor mode, recap, notifications, auto-update channel,
  gitignore-aware file references, and configurable AskUserQuestion timeouts,
  provider-free `/terminal-setup` diagnostics and repeatable Shift+Enter setup
  for supported local terminals,
  `Ctrl+V` text/image clipboard paste, `Ctrl+Z` shell suspension and `fg`
  recovery, permission-gated `!` shell turns, navigable current/per-turn Git
  diff views, rich decision panels, and measured context budgets; print mode,
  structured JSON/JSONL, context compaction, tool loops, and bounded execution.
- **Built-in tools** — read, write, edit, glob, search, shell, notebook, PDF,
  image, web, scheduled prompts, workflows, and worktrees.
- **Permission boundary** — local allow/ask/deny rules, safe and bare modes,
  searchable scoped-rule creation/removal, local/project/user atomic settings
  writes, tool-specific Bash/PowerShell/file/notebook/WebFetch/Skill approval
  dialogs, editable reusable shell and Skill rules, source-root-aware Claude
  file-rule matching, atomic session permission updates, compound-shell rule
  suggestions backed by a bounded Bash AST, source-shaped exact/prefix/wildcard
  matching, wrapper and environment normalization, fail-closed Bash semantic
  checks with control-flow-aware variable scopes, declaration and literal-only
  arithmetic analysis, exact `cat` heredoc handling, argv-based
  command/redirection path validation, full symlink-chain checks, dangerous-removal,
  sensitive-file, and suspicious Windows-path gates, source-ordered strict sed
  constraints, internal auto-memory/session/task path handling, compound `cd` +
  Git protection, mode-ordered `acceptEdits` handling, live raw/resolved-path
  grants for external directories,
  Claude-compatible opt-in Bash sandboxing with filesystem and network
  isolation, explicit ask/deny precedence, sandbox-only auto-allow,
  write-allowlist/deny-within-allow enforcement, per-command overrides and
  exclusions, violation reporting, and bare-repository control-file cleanup,
  safe-property Skill auto-allow, interactive
  workspace-directory add/remove controls, path confinement, credential
  redaction, and sanitized child processes.
- **Durable local work** — resumable sessions, full-history forks, file
  checkpoints, tasks, foreground/background subagents, top-level agents, and
  Claude-compatible main-thread agent definitions with native prompt, model,
  tool, memory, first-turn, and resume behavior. Agent execution uses one
  durable lifecycle vocabulary with bounded cancellation and drain,
  continuation, notifications, and single-owner orphan recovery. Experimental
  local Teams (`PRAXIS_ENABLE_TEAMS=true`) stay absent from ordinary startup by
  default and add durable task ownership plus one ordered mailbox with stable
  identities, fixed broadcast recipients, durable cursors, bounded retention,
  and bounded model-context projection.
- **Claude-compatible ecosystem** — shared instructions with recursive `@`
  imports, memory, skills, commands, agents, hooks, settings, MCP servers,
  plugins, and transcript data.
- **Provider-neutral models** — native Anthropic Messages and OpenAI-compatible
  streaming adapters with explicit capability checks and metering controls.

Detailed feature status and executable evidence live in the
[parity matrix](https://github.com/Forest-Isle/Praxis/blob/main/docs/PARITY_MATRIX.md),
not in this entry-point README.

## Claude Code interoperability

Praxis uses an independent local data plane by default:

```text
Praxis ─── ~/.praxis (or PRAXIS_HOME)
```

Use `praxis --data-plane claude` when you need the legacy shared Claude Code
layout (`~/.claude` or `CLAUDE_CONFIG_DIR`). Praxis can resume Claude Code
sessions in that mode, and Claude Code can resume compatible sessions written
there. Every semver-like Claude Code producer version is
structurally validated and is read/write compatible when its entry shape is
supported; schema adapters are selected from transcript entry structure rather
than an installed or fixed producer version, and malformed or unsupported
shapes fail closed before any write. Each transcript record keeps its original
producer version, so supported shapes may be mixed across versions in one
session. Native fork creation is a separate restricted lossless copy path that
preserves each existing source record's producer version, so it can copy
specific black-box-verified foreign shapes such as the observed Claude Code
2.1.233 records; unsupported record shapes and unverified versions still fail
closed and remain read-only. Maintainers can prove mixed-version Claude JSONL interoperability with
`npm run test:cross-version-session-compat`, `test:cross-version-fork-compat`,
`test:cross-version-sidechain-compat`, `test:cross-version-compaction-compat`,
and `test:cross-version-resume-at-compat`, covering linear resume, native fork,
foreground sidechain, compaction, and `--resume-session-at` branch projection.
Each requires `PRAXIS_CLAUDE_BINARY` (Claude Code 2.1.208) and
`PRAXIS_CLAUDE_CROSS_VERSION_BINARY` (a different Claude Code version).

See the
[compatibility contract](https://github.com/Forest-Isle/Praxis/blob/main/docs/COMPATIBILITY.md)
for exact shared data, version boundaries, exclusions, and verification gates.

## Documentation

| Need                                       | Document                                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Install and run the first session          | [Getting Started](https://github.com/Forest-Isle/Praxis/blob/main/docs/GETTING_STARTED.md) |
| Common commands and environment variables  | [CLI Reference](https://github.com/Forest-Isle/Praxis/blob/main/docs/CLI_REFERENCE.md)     |
| Find all user and maintainer documentation | [Documentation Index](https://github.com/Forest-Isle/Praxis/blob/main/docs/README.md)      |
| Understand module and data-flow boundaries | [Architecture](https://github.com/Forest-Isle/Praxis/blob/main/docs/ARCHITECTURE.md)       |
| Review security assumptions                | [Threat Model](https://github.com/Forest-Isle/Praxis/blob/main/docs/THREAT_MODEL.md)       |
| Check Claude Code parity                   | [Parity Matrix](https://github.com/Forest-Isle/Praxis/blob/main/docs/PARITY_MATRIX.md)     |
| Review interactive TUI design and evidence | [TUI Parity](https://github.com/Forest-Isle/Praxis/blob/main/docs/TUI_PARITY.md)           |
| Build, test, and contribute                | [Contributing](https://github.com/Forest-Isle/Praxis/blob/main/CONTRIBUTING.md)            |
| Verify release and supply-chain controls   | [Release Contract](https://github.com/Forest-Isle/Praxis/blob/main/docs/RELEASE.md)        |

## Project boundary

Praxis targets one local OS user working across multiple repositories and
sessions. It is CLI-only and provider-capability-aware. Organization, tenant,
RBAC, subscription authentication and billing, enterprise gateway,
IDE/Desktop/mobile clients, Remote Control, Claude Desktop import, and hosted
review-product surfaces are permanent non-goals.

## Security and support

Report vulnerabilities through
[GitHub private vulnerability reporting](https://github.com/Forest-Isle/Praxis/security/advisories/new),
not a public issue. See
[SECURITY.md](https://github.com/Forest-Isle/Praxis/blob/main/SECURITY.md) for
response expectations.

Use [GitHub Discussions](https://github.com/Forest-Isle/Praxis/discussions) for
questions and usage help, and issues for reproducible defects or scoped feature
requests. See
[SUPPORT.md](https://github.com/Forest-Isle/Praxis/blob/main/SUPPORT.md).

## Development

```sh
git clone git@github.com:Forest-Isle/Praxis.git
cd Praxis
npm ci
npm run check
```

`npm run build:native` compiles the current Praxis-owned core, provider
adapters, and native data-plane slice without the Claude compatibility adapter.
`npm run check` also enforces the corresponding source dependency direction.

Contributions use Conventional Commit pull-request titles and the protected
squash-merge workflow. Read
[CONTRIBUTING.md](https://github.com/Forest-Isle/Praxis/blob/main/CONTRIBUTING.md)
before changing compatibility, persistence, release, or security behavior.

## License

Praxis is available under the
[MIT License](https://github.com/Forest-Isle/Praxis/blob/main/LICENSE). Vendored
dependency attributions are listed in
[THIRD_PARTY_NOTICES.md](https://github.com/Forest-Isle/Praxis/blob/main/THIRD_PARTY_NOTICES.md).
