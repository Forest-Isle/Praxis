# ADR 0003: Local Team and Swarm scope

Status: accepted — 2026-08-23

## Decision

Praxis may provide Team and Swarm as capability-gated, local, single-user
orchestration. A Team has one lead agent and a flat set of named agents; Swarm
is the Team execution strategy for concurrent independent work. Remote agents
remain excluded because cross-host execution would introduce network control,
identity, reconnection, and state-synchronization responsibilities outside the
local-first product scope.

## Consequences

- Existing single-subagent behavior remains required and independent of Team.
- Team and Swarm must be explicitly enabled and may not become dependencies of
  ordinary sessions or turns.
- When disabled, Team tools are absent from the model tool pool and ordinary
  startup performs no Team-state discovery. When enabled, agent concurrency,
  tokens, duration, and shutdown drain are bounded by explicit local budgets.
- Concurrent writers require isolated worktrees; shared-worktree work is
  sequential or read-only.
- A write-capable agent owns one dedicated branch and worktree but may not
  push, merge, rewrite Git history, destructively clean, or delete worktrees.
  Commit permission is an explicit Team policy and defaults to the lead.
- Durable local process state owns teammate lifecycle. Tmux may provide an
  optional attach and pane presentation adapter, but pane existence is never
  authoritative task or agent state.
- The lead agent owns task dependencies, lifecycle coordination, review, and
  acceptance. Team agents own only their assigned work.
- Team membership, Swarm scheduling, and the lead's Hybrid or Coordinator
  policy are orthogonal projections of one Agent-orchestration domain rather
  than separate runtimes.
- Failed or disconnected agents retain their worktree, Transcript, and task
  state as `orphaned` until the lead explicitly recovers or disposes them.
- Team operational state must not add Praxis-specific fields or entries to
  Claude-compatible transcripts.
- Team communication has one durable mailbox. Process state, local sockets,
  and tmux are notification adapters only; repeated delivery is handled by
  stable message identities and durable recipient cursors.
- Accounts, organizations, hosted coordination, and remote execution remain
  excluded.
