# Stage 24 Dynamic Wakeup Contract

## Goal

Complete the single-process `ScheduleWakeup` lifecycle for Praxis interactive
sessions while preserving Claude Code 2.1.208 headless behavior and existing
Cron persistence compatibility.

## Solution and rationale

Dynamic wakeups are session-only one-shot prompts owned by the interactive
service. They reuse the scheduled prompt manager's idle delivery queue, but are
never written to `.claude/scheduled_tasks.json`. Durable and recurring work
continues to use `CronCreate`.

The interactive CLI enables the Praxis runtime. Print, background, and other
headless invocations keep the observed Claude inactive result. The four
scheduling lifecycle tools are default-allow built-ins so they reach the
scheduler without an unrelated permission denial. Explicit deny rules still win.

## Data flow

```text
model ScheduleWakeup
  -> validate delay/reason/prompt or stop
  -> clamp delay to [60, 3600]
  -> process-local due map
  -> shared idle delivery queue
  -> interactive nextScheduledPrompt
  -> ordinary run/resume turn
```

## Runtime rules

1. A dynamic wakeup exists only in one `ClaudeSessionService` process.
2. Each call creates one independent one-shot wakeup.
3. Delay is clamped to 60 through 3600 seconds.
4. Firing removes the wakeup before enqueue, so concurrent drains deliver once.
5. `stop: true` removes pending and already queued dynamic wakeups only.
6. Stop never deletes fixed Cron jobs; `CronDelete` owns that lifecycle.
7. Service close clears dynamic wakeups, due entries, queues, and waiters.
8. Headless service construction leaves the dynamic gate disabled.
9. Option-only TTY invocation enters the interactive runtime and forwards CLI
   controls, matching normal Claude interactive invocation shape.

## Errors and bounds

- Existing tool input validation rejects missing or malformed fields.
- A closed or inactive manager returns the observed inactive result.
- Dynamic wakeups create no disk artifact and need no cross-process ownership.
- Existing deterministic Cron ordering and durable refresh behavior are
  unchanged.

## Tests

- Manager tests cover inactive gate, lower clamp, cancellation, multiple due
  wakeups, concurrent exactly-once drain, repeat drain, and close cleanup.
- Tool tests cover active scheduling/stop and observed inactive/stop results.
- CLI tests cover option-only TTY forwarding.
- Permission tests cover default scheduling allow with explicit deny precedence.
- `test:scheduled-compat` remains the live Claude schema, native Cron state,
  bidirectional resume, and inactive-gate oracle.

## Compatibility boundary

Claude Code 2.1.208 active dynamic wakeups could not be triggered through the
isolated API-auth black-box fixture, even with interactive PTY, auto mode,
allowlisted `ScheduleWakeup`, cached feature flags, and the documented sentinel.
Therefore active result text and native fields are fixture-level Praxis behavior,
not claimed live parity. Headless/manual inactive behavior remains live-verified.
