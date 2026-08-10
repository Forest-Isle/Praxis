# Performance Budgets

Praxis treats performance checks as release regression gates, not machine
rankings. The probe uses only local deterministic fixtures and a production
build; provider latency, Claude Code, network services, and hook subprocesses
are outside these budgets.

## Budgets

| Path                | Fixture                                                                       | Budget                |
| ------------------- | ----------------------------------------------------------------------------- | --------------------- |
| CLI process startup | `praxis --version`, seven measured processes after one warmup                 | p95 <= 1,000 ms       |
| Session discovery   | 500 Claude-layout session files, five measured scans after one warmup         | p95 <= 500 ms         |
| Transcript load     | 20,000 JSONL entries and at least 8 MiB, five measured loads after one warmup | p95 <= 750 ms         |
| Transcript memory   | same large transcript, forced GC before and after retained load               | heap growth <= 96 MiB |
| Transcript append   | three leased tail appends to same large transcript                            | p95 <= 750 ms         |

The transcript fixture is currently about 11 MiB. The gate also asserts exact
entry and session counts so an accidentally smaller fixture cannot make a
regression pass.

## Running the gate

Use Node.js 24 or newer:

```sh
npm run test:performance
```

The command builds `dist`, enables explicit garbage collection for the heap
probe, creates an isolated temporary Claude data layout, prints every measured
value beside its limit, and removes the fixture. Any exceeded budget exits
non-zero.

Wall-clock limits intentionally leave headroom for macOS and Linux CI noise.
Hosted CI runs the sentinel on Linux Node 24 and macOS Node 25; the full
installed-package regression still covers Node 24 and 25 on both platforms.
This avoids treating one unusually slow hosted runtime/OS pairing as a machine
ranking while retaining minimum-runtime and cross-platform performance checks.
Changes that intentionally alter fixture size, sampling, or limits must update
this document and receive the same Standards/Spec review as runtime changes.
