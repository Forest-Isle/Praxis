# Stage 24 Dynamic Wakeup Contract

## Goal

Complete the single-process `ScheduleWakeup` lifecycle for Praxis interactive
sessions while preserving the native headless behavior and existing Cron
persistence contract.

## Solution and rationale

Dynamic wakeups are session-only one-shot prompts owned by the interactive
service. They reuse the scheduled prompt manager's idle delivery queue, but are
never written to the native durable task store. A new call replaces the prior
pending dynamic wakeup. Durable and recurring work continues to use
`CronCreate`.

The interactive CLI enables the Praxis runtime. Print, background, and other
headless invocations keep the native inactive result. The four
scheduling lifecycle tools are default-allow built-ins so they reach the
scheduler without an unrelated permission denial. Explicit deny rules still win.

## Data flow

```text
model ScheduleWakeup
  -> validate delay/reason/prompt or stop
  -> round delay, clamp to [60, 3600], align to next minute
  -> replace prior pending dynamic wakeup
  -> process-local due map
  -> shared idle delivery queue
  -> interactive nextScheduledPrompt
  -> ordinary run/resume turn
```

## Runtime rules

1. A dynamic wakeup exists only in one `ClaudeSessionService` process.
2. Each call replaces the prior pending dynamic wakeup.
3. Delay rounds to the nearest second, clamps to 60 through 3600 seconds, then
   schedules on the next whole-minute boundary.
4. Firing removes the wakeup before enqueue, so concurrent drains deliver once.
5. A continuously rearmed prompt ends after the same seven-day maximum age as
   recurring jobs; a gap beyond the maximum delay starts a fresh loop.
6. `stop: true` removes pending and already queued dynamic wakeups only.
7. Stop never deletes fixed Cron jobs; `CronDelete` owns that lifecycle.
8. Service close clears dynamic wakeups, loop age, due entries, queues, and
   waiters.
9. Headless service construction leaves the dynamic gate disabled.
10. Option-only TTY invocation enters the interactive runtime and forwards CLI
    controls, matching normal Claude interactive invocation shape.

## Errors and bounds

- Existing tool input validation rejects missing or malformed fields.
- A closed or inactive manager returns the observed inactive result.
- Dynamic wakeups create no disk artifact and need no cross-process ownership.
- Existing deterministic Cron ordering and durable refresh behavior are
  unchanged.

## Tests

- Manager tests cover inactive gate, rounding/clamps, minute alignment,
  replacement, maximum age, concurrent exactly-once drain, and close cleanup.
- Tool tests cover exact active/inactive/stop text and native result shapes.
- CLI tests cover option-only TTY forwarding.
- Permission tests cover default scheduling allow with explicit deny precedence.
- Native manager, tool, CLI, and permission fixtures cover exact descriptions,
  schema, Cron state, resume, inactive behavior, and the built active contract.

## Native evidence

The deterministic Praxis fixtures verify input/output shape, clamp, minute
alignment, replacement, maximum-age, active/inactive/stop projection, and
native fields. The built Praxis registry gate verifies the active contract.
