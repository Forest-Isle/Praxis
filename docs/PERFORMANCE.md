# Performance Budgets

Praxis treats performance checks as release regression gates, not machine
rankings. The probe uses only local deterministic fixtures and a production
build; provider latency, Claude Code, network services, and hook subprocesses
are outside these budgets.

## Budgets

| Path                       | Fixture                                                                       | Budget                                         |
| -------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------- |
| CLI process startup        | `praxis --version`, seven measured processes after one warmup                 | p95 <= 1,000 ms                                |
| Session discovery          | 500 Claude-layout session files, five measured scans after one warmup         | p95 <= 500 ms                                  |
| Transcript load            | 20,000 JSONL entries and at least 8 MiB, five measured loads after one warmup | p95 <= 750 ms                                  |
| Transcript memory          | same large transcript, forced GC before and after retained load               | heap growth <= 96 MiB                          |
| Transcript append          | three leased tail appends to same large transcript                            | p95 <= 750 ms                                  |
| Syntax rendering           | 200 transcript responses containing 4,000 highlighted TypeScript lines        | p95 <= 1,500 ms                                |
| TUI cold projection        | 120,000 retained assistant entries, deterministic local fixture               | median <= 1,000 ms                             |
| TUI retained append        | Fullscreen tail append and Read-result grouping on 120,000 retained entries   | p95 <= 50 ms                                   |
| TUI retained scroll        | 120,000-entry oldest window and one 120,000-row entry's middle window         | p95 <= 25 ms                                   |
| TUI retained heap          | 120,000-entry retained projection, forced GC before and after                 | growth <= 128 MiB                              |
| Active-stream rerender     | Unchanged 120,000-entry history with a bounded active stream frame            | p95 <= 50 ms                                   |
| Interactive render cadence | Fullscreen/classic/screen-reader Ink frames with the presentation environment | max 30 FPS                                     |
| Fullscreen PTY writes      | Deterministic 120x40→80x24 resize fixture with a 48-update burst              | <= 24 committed frames and <= 18,000 raw bytes |

The transcript fixture is currently about 11 MiB. The gate also asserts exact
entry and session counts and the final long-render marker, so an accidentally
smaller fixture cannot make a regression pass.

The TUI rows use the same deterministic 120,000-entry fixture. The retained
append gate projects only the fullscreen visible tail, checks an ordinary
append plus incremental Read-result grouping, and asserts marker reachability
and reference reuse in addition to timing. The scroll gate selects both the
oldest window from the post-append 120,000-entry index and a middle window from
one 120,000-row assistant entry, proving boundary projection reuses its retained
row index. The retained heap check forces garbage collection around the
projection and rejects growth above 128 MiB. Active stream rerenders use the
fullscreen visible region and assert the stream marker is present in every
frame.

Interactive rendering has an explicit 30 FPS ceiling in every presentation
mode. The fullscreen PTY fixture also exercises a high-frequency update burst
and a real terminal resize; it must settle on the final 80x24 marker without
more than 24 committed frame markers or 18,000 raw terminal bytes. These are
fixture-specific ceilings with headroom for the deterministic Ink redraw
sequence, not estimates derived from product output at runtime.

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
