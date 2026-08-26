# Praxis Engineering Rules

- Keep implementation clean-room. Do not copy code from the Claude Code source
  snapshot.
- Preserve observable behavior through black-box fixtures and tests.
- Keep product local-first, single-user, and CLI-only.
- Do not add accounts, organizations, RBAC, billing, remote control, IDE
  surfaces, or telemetry control planes.
- Keep the agent loop small. Add abstractions only when a second implementation
  or a verified boundary requires one.
- Keep provider-specific optimizations inside capability-aware adapters.
- Treat `~/.praxis` and project `.praxis` as the default native data plane.
  Claude Code's `.claude` layout is an explicit compatibility mode, never an
  implicit dependency of native runs.
- Store authoritative transcripts as append-only JSONL. Claude compatibility
  mode must retain Claude Code-compatible entries and paths.
- Never add Praxis-specific entry types or fields to shared transcripts unless
  compatibility tests prove Claude Code accepts them. Use sidecars under the
  Claude config root for private operational state.
- Require focused tests for every runtime behavior change.

## Verified compatibility pitfalls

These are recurring failure modes observed while running the Claude/DeepSeek
compatibility lanes. Apply them before classifying a gate failure:

- Pin the oracle binary per lane. Claude Code `2.1.208` is the CLI/TUI/shared
  compatibility baseline and `2.1.237` is the core-design baseline. The
  ambient `claude` command may be newer (for example `2.1.238`), and current
  npm `latest` is not a valid substitute. Gates must validate the executable
  version before creating fixtures. If a pinned executable is unavailable,
  install the exact npm version under a temporary `/tmp` prefix and set
  `PRAXIS_CLAUDE_BINARY` explicitly.
- Keep provider and oracle variables separate. Shell-level
  `ANTHROPIC_MODEL`/`ANTHROPIC_DEFAULT_*_MODEL` values can leak into Claude
  fixture probes and select a model-dependent prompt branch or produce
  `unrecognized_model`. For a pure Claude baseline, unset model overrides; for
  a provider lane, set the model explicitly and report that it is a separate
  variable from the Claude version.
- Use the correct DeepSeek Anthropic endpoint and credential mapping:
  `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic` and
  `ANTHROPIC_AUTH_TOKEN=$DEEPSEEK_API_KEY`. The OpenAI-compatible `/v1`
  endpoint is not interchangeable for Claude Code probes.
- Match the data plane to path assertions. Native runs default to Praxis
  storage; any probe that writes with `CLAUDE_CONFIG_DIR` and later resolves
  Claude session paths must set `PRAXIS_DATA_PLANE=claude` explicitly.
  Otherwise successful runs can be followed by false `ENOENT` transcript
  failures.
- Separate lifecycle evidence from model prose. For hook failures, inspect
  hook events, transcript contents, and follow-up user messages before
  changing production code. A model not repeating an exact marker does not
  prove that PermissionDenied, retry, persistence, or resume wiring is broken.
- Same endpoint does not mean same request. Claude Code and Praxis can differ
  in model-id capability branching, system-prompt placement, tool schemas,
  continuation messages, and cache headers. Compare captured provider request
  structure before assigning a failure to the model.
- Build before running scripts that import `dist/**`; after source changes use
  `npm run build` (or the package script that includes it) before interpreting
  compatibility output.
- Keep diagnostic instrumentation temporary and tagged, remove it before
  acceptance, and never stage user-owned `.claude/`, `docs/research/`, or other
  untracked local data.

## Mandatory PR Workflow

Every change intended for Praxis must follow this workflow, including changes
to documentation and repository tooling:

1. Inspect `git status`, the current branch, repository instructions, and the
   relevant issue or contract before editing. Preserve all pre-existing user
   changes and never stage untracked local data, generated output, credentials,
   `.claude/`, `.idea/`, or `graphify-out/` unless the task explicitly requires
   that exact file.
2. Select or confirm one focused issue and define the observable behavior,
   compatibility impact, allowed files, and verification commands. Delegate
   ordinary implementation slices through Claude Worker MCP; direct edits are
   reserved for trivial local changes, worker/MCP unavailability, or an
   explicitly documented high-risk exception.
3. Create a dedicated branch from the current `origin/main`. Use a concise
   branch name such as `fix/<issue>-<slug>`, `feat/<issue>-<slug>`, or
   `docs/<slug>`.
4. Keep the diff focused. Add regression coverage for runtime behavior and
   run the narrow formatter, linter, typecheck, and focused tests first. Then
   run `npm run check`. Claude interoperability changes must also run
   `npm run test:compat:all`; package, persistence, provider, permission, hook,
   MCP, or performance changes must additionally run `npm run test:package`,
   `npm run test:performance`, and `npm audit --omit=dev`.
5. If a required gate fails, inspect the exact CI log and classify the cause
   before changing code. Rerun a failed lane only for a demonstrated transient
   environment failure. For a reproducible failure, make a localized repair,
   rerun the failed command, and document any unavailable environment gate.
6. Stage only the intended product files and verify `git diff --cached --check`.
   Commit with a Conventional Commit subject (`fix:`, `feat:`, `docs:`,
   `test:`, `refactor:`, `perf:`, `build:`, `ci:`, or `chore:`). Do not commit,
   push, merge, reset destructively, or delete user files from a worker packet.
7. Push the dedicated branch and open a GitHub PR targeting `main`. The PR
   title must use the same Conventional Commit vocabulary. Its body must state
   user-visible behavior, compatibility impact, changed scope, and every
   verification result, including exact reasons for any blocked gate.
8. Wait for all required CI and review checks. Do not treat a worker's `done`
   state or a partial check result as acceptance. After checks are green and
   required review is satisfied, enable repository-standard squash automerge
   with `gh pr merge --auto --squash`; do not manually merge or create release
   tags. Report the PR URL, commit, checks, and any remaining caveat.

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues; external PRs are not a triage request
surface. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the standard five-role triage vocabulary. See
`docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository. See `docs/agents/domain.md`.
