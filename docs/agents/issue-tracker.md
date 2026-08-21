# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues. Use the `gh` CLI for all
operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a
  heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by
  `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json
number,title,body,labels,comments` with appropriate label and state filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`.
- **Apply or remove labels**: `gh issue edit <number> --add-label "..."` or
  `--remove-label "..."`.
- **Close an issue**: `gh issue close <number> --comment "..."`.

Infer the repository from `git remote -v`; `gh` does this automatically when
run inside the clone.

## Pull requests as a triage surface

External pull requests are not a triage request surface. Do not pull them into
the issue triage queue. Collaborator pull requests remain governed by the
repository PR workflow in `AGENTS.md`.

GitHub shares one number space across issues and pull requests, so resolve an
ambiguous `#42` with `gh pr view 42` and fall back to `gh issue view 42`.

## Skill operations

- When a skill says to publish to the issue tracker, create a GitHub issue.
- When a skill says to fetch a ticket, run `gh issue view <number> --comments`.

## Wayfinding operations

Wayfinder uses one map issue and a set of linked child issues.

- **Map**: create one issue labelled `wayfinder:map`. Its body owns the
  destination, notes, decisions so far, unspecified areas, and out-of-scope
  boundaries.
- **Child ticket**: link each ticket as a GitHub sub-issue and apply one of
  `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, or
  `wayfinder:task`. If sub-issues are unavailable, add the child to a task list
  in the map and add `Part of #<map>` to the child body.
- **Blocking**: use GitHub native issue dependencies. Add an edge with the
  `dependencies/blocked_by` API using the blocker issue's numeric database ID,
  not its issue number or node ID. If native dependencies are unavailable, add
  a `Blocked by: #<number>` line to the child body.
- **Frontier**: inspect open map children in map order, exclude assigned issues
  and issues with open blockers, and select the first remaining ticket.
- **Claim**: assign the selected issue to the current user before making its
  first implementation write.
- **Resolve**: comment with the answer, close the child, and append a durable
  pointer to the map's decisions section.
