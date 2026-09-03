# Managed worktree lifecycle

## Goal

Give Workflow, Agent, and Team worktrees one ownership-safe lifecycle without
changing the existing interactive `EnterWorktree`/`ExitWorktree` contract.
New managed checkouts are discoverable under the repository's ignored
`.praxis/worktrees` root, survive crashes when evidence must be retained, and
are garbage-collected only when Praxis can prove removal is safe.

## Chosen design and rationale

Use one lifecycle kernel with policy adapters instead of making every
worktree behave identically:

- `session`: user-controlled; current paths and explicit keep/remove behavior
  remain unchanged.
- `ephemeral`: Workflow and Agent worktrees are cleaned after successful work
  when they remain unchanged from their base.
- `durable`: Team and failed/orphaned worktrees are retained until the lead or
  an owning lifecycle explicitly releases them.

This centralizes Git validation, ownership, leases, hooks, recovery, and
cleanup while preserving the different product contracts already exposed by
Session, Workflow, Agent, and Team.

## Roadmap scope

- Add the managed-worktree lifecycle kernel and private registry.
- Migrate new Workflow and Agent worktrees to repo-local native paths.
- Register and migrate new Team paths without enabling automatic Team cleanup.
- Run native `WorktreeCreate` and `WorktreeRemove` command hooks.
- Reconcile abandoned ephemeral worktrees on a later Praxis run.
- Add bounded lifecycle diagnostics to doctor/observability surfaces.

## Non-goals

There is no `.claude` dependency, deletion of user-created worktrees,
process-global `cwd` change, remote coordination, daemon, telemetry, or new
transcript field. Dirty, committed, active, ambiguous, Team, failed, orphaned,
or unregistered worktrees are never auto-deleted. Existing Session names,
branches, transcript paths, and explicit removal rules do not change.

## Architecture

### `ManagedWorktreeLifecycle`

The application-level lifecycle owns create, restore, release, reconciliation,
and inspection. Callers supply a fixed policy and owner identity; callers do
not execute raw worktree cleanup themselves.

The lifecycle reuses canonical project identity and `ExclusiveFileLease`.
Git commands continue to use argument arrays through `execFile`; no shell
command construction is permitted.

### Checkout layout

New managed checkouts use the canonical main repository root:

```text
<repo>/.praxis/worktrees/workflow/<run-id>-<agent-id>
<repo>/.praxis/worktrees/agent/<session-id>-<agent-id>
<repo>/.praxis/worktrees/team/<team-id>/<generation-hash>
```

Interactive session worktrees remain at
`<repo>/.praxis/worktrees/<session-name>`.

All generated path components are validated and bounded. Canonical paths must
remain inside the expected kind root. Symlinked targets or parents are
rejected.

### Private registry and marker

Authoritative operational records live outside the shared transcript:

```text
~/.praxis/state/managed-worktrees/<project-key>/<worktree-id>.json
~/.praxis/state/managed-worktrees/<project-key>/<worktree-id>.lock
```

Version 1 records contain only:

- stable worktree ID, kind, policy, and owner identity;
- canonical repository identity and checkout path;
- owned branch, base commit, and current lifecycle state;
- creation/update timestamps and the last retention reason.

The linked worktree Git directory contains a `PRAXIS_WORKTREE` marker with the
same worktree ID and repository identity. Cleanup requires matching registry,
marker, registered Git path, repository identity, and owned branch/base
evidence. A directory name alone never proves ownership.

Registry writes are atomic and serialized by an exclusive project lease.
Per-worktree leases prevent cleanup while an owner is running. Unknown schema
versions fail closed and remain untouched.

### State machine

```text
creating -> active -> releasing -> released
                    -> retained
retained -> releasing -> released
creating -> released     (safe rollback)
```

Only the lifecycle may advance state. Repeated release and reconciliation are
idempotent. `retained` records may be inspected again but do not become
deletable unless current Git and owner evidence independently pass every gate.

## Data flow

### Create

1. Resolve the canonical main repository, HEAD/base commit, kind, and owner.
2. Locally ignore the managed root, validate its path, and acquire both leases.
3. Persist `creating`, create the Git worktree, and write its marker.
4. Run the synchronous `WorktreeCreate` hook in the new checkout.
5. On success, persist `active` before returning the cwd to the caller.
6. On a blocking hook or partial failure, remove only artifacts proven to have
   been created by this operation; otherwise persist `retained` with a reason.

Agent foreground and background executions use the same `agent` kind and
`ephemeral` policy. Each execution creates a fresh ownership record whose
owner token is the exact subagent lifecycle execution token. A clean release
removes the checkout; dirty or committed work is retained with its existing
path and warning surfaces. A clean continuation creates the deterministic
Agent path again under a new owner-token record, while a retained continuation
restores the existing checkout.

### Normal release

1. Persist `releasing` while holding the worktree lease.
2. Inspect registration, marker, status, HEAD, and base commit.
3. Dirty work or commits after the base become `retained` and are reported.
4. Run the synchronous `WorktreeRemove` hook with reason `normal`.
5. Remove the registered checkout and owned branch, then persist `released`.

### Restore and continuation

Managed Agent restore requires the complete ownership proof: record, marker,
Git registration, repository identity, canonical path, kind, policy, matching
Agent owner prefix, and an acquired lease. A hydrated restore that closes
before continuation releases its lease, leaving retained state available for a
later owner. Only the exact former
`<stateRoot>/agent-worktrees/<session-id>-<agent-id>` path may use legacy
validation; it must be a real, registered worktree for the same repository.
Legacy paths are never adopted into the registry or garbage collection, and
arbitrary registered worktrees are rejected so callers fall back to the parent
cwd.

### Crash reconciliation

Reconciliation runs once per process on first use of a project's managed
worktrees and inspects at most 64 registry records. It never scans arbitrary
directories as ownership evidence.

- A live lease or active owner state is skipped.
- Durable, failed, owner-lost, orphaned, and unknown-owner records are retained.
- An interrupted or terminal ephemeral owner is eligible for Git inspection.
- Dirty, committed, mismatched, malformed, or hook-blocked candidates are
  retained with a precise reason.
- A clean, matching ephemeral candidate runs `WorktreeRemove` with reason
  `reconcile`, then removes only its registered checkout and owned branch.
- A missing checkout can become `released`; an ambiguous branch is retained.

Elapsed time alone never authorizes deletion.

## Hooks

`WorktreeCreate` and `WorktreeRemove` are Praxis-native lifecycle hooks. They
are not advertised as Claude Code 2.1.208 parity because the pinned 2.1.208
hook fixture does not expose them.

Hook input includes the standard session fields plus `worktree_path`,
`worktree_kind`, `worktree_id`, `owner_id`, `base_commit`, and, for removal,
`reason`. The matcher value is the worktree kind.

These hooks must be synchronous. Exit code 2, `continue: false`, or an explicit
block decision blocks the transition. Other non-zero exits are recorded and
reported but follow the existing advisory command-hook behavior. Hook output
uses the existing workspace-trust-filtered runner and never enters transcripts.
Asynchronous configuration for these events is rejected during validation.

Workflow and both foreground and background Agent executions use this same
trusted synchronous create/remove lifecycle. Agent hooks match `agent`, and
private ownership or hook data remains outside JSONL transcripts.

## Errors and invariants

- Create fails before exposing a cwd when Git identity, path, registry, marker,
  or hook setup is invalid.
- Before Git removal, cleanup failure returns `retained: true`; after confirmed
  removal, a registry-finalization failure returns removed plus a warning.
- Restore accepts legacy retained paths only when Git still registers the real
  worktree root for the same repository; legacy paths are never GC candidates.
- Branch deletion is attempted only for a matching branch owned by the record,
  using an expected-old-OID compare-and-delete; indeterminate lookups and
  concurrent ref moves fail closed and retain the lifecycle record and any
  remaining artifact.
- A cleanup race loses safely through the lease and idempotent state machine.
- Registry corruption, permission errors, unsupported versions, and uncertain
  process ownership fail closed without deleting files.

## Compatibility

`ManagedWorktree.cleanup()` and Workflow/Agent result fields remain compatible.
Legacy retained paths remain restorable but are not relocated or GC candidates.
Session transcript ordering and `worktree-state` entries do not change. Team
generations, branches, recovery tokens, and orphan retention stay authoritative.
Private state remains outside append-only transcripts.

## Test strategy

- Unit/Git: validation, records, leases, transitions, clean release, retention,
  mismatches, missing paths, idempotence, and concurrent reconciliation.
- Hooks/callers: exact lifecycle input and failures; Workflow, foreground and
  background Agent, restore, Team generation, and unchanged Session behavior.
- Gates: focused Vitest, typecheck, build, `npm run check`, package,
  performance, and dependency audit.

## Delivery sequence

1. #630: lifecycle store, ownership proof, safe rollback, and Workflow migration (complete).
2. #625: lifecycle hooks; #626: bounded reconciliation and safe garbage collection (complete).
3. #627: Agent migration and restore compatibility (complete); #628: durable Team migration (future).
4. #629: doctor/observability surfaces, final gates, and operator documentation (future).
