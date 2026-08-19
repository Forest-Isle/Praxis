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
- Treat Claude Code's `.claude` layout as the shared data plane. Do not create a
  competing session, memory, skill, or project-instruction ecosystem.
- Store authoritative transcripts as Claude Code-compatible append-only JSONL.
- Never add Praxis-specific entry types or fields to shared transcripts unless
  compatibility tests prove Claude Code accepts them. Use sidecars under the
  Claude config root for private operational state.
- Require focused tests for every runtime behavior change.

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
