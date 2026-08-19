# Codex Workflow

Praxis changes are local-first and CLI-only. Codex owns issue triage, task boundaries, worker lifecycle, review, acceptance, and the PR decision. Claude workers implement only a complete packet module and never commit, push, merge, or delete user files.

Use a separate worktree for independent work. Validate the packet and repository before dispatch. Treat worker `done` as execution completion only; review the full diff, tests, wiring, policy diagnostics, model evidence, and acceptance snapshot before accepting.

Only blocking policy errors make a run ineligible. Related read-only exploration is recorded for review rather than automatically rejected. The worker model must be `deepseek-v4-flash`.

After every merged PR, immediately refresh the development baseline:

```bash
git switch main
git pull --ff-only origin main
```
