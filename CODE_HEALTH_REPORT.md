# Code Health Report

> Generated: 2026-08-10
> Project: Praxis
> Scanned: 186 source files, 63 scripts, 89 test modules

## Executive Summary

Praxis is buildable and fully wired for current single-user CLI scope. TypeScript
typechecking, boundary checks, focused regressions, package-script references,
and direct production dependencies pass. Stage 91 adds repeatable GitHub and
npm release engineering: complete compatibility CI, version/tag automation,
retryable immutable-tag publication, tarball/SBOM/checksum generation,
provenance attestations, security analysis, dependency maintenance, and open
source governance. Stage 90 hardens the recursive CLI
surface gate with exact option and positional signatures, declaration-only
parsing, alias execution, and one explicit `--tmux=classic` extension across 40
routes, 243 included options, and 46 commands/aliases. Stage 89 established the
route/help/exclusion walk. Stage 88 adds scoped plugin MCP
naming/deduplication, official MCPB/DXT local and remote loading, protected
bundle configuration, bounded cache/extraction, prompt discovery/invocation,
durable prompt binaries, crash recovery, failure isolation, and packed runtime
execution on top of Stage 87 protected options. All 89 test modules and 811
tests pass. No
unfinished feature stubs, unresolved imports, or missing script targets remain.
All 52 compatibility gates, clean package install, performance budgets, strict
unused checks, production dependency audit, release artifact checksums, and
GitHub workflow static validation pass.

## 🔴 Critical Issues

No critical issues detected.

| #   | Location | Issue | Why it matters |
| --- | -------- | ----- | -------------- |

## 🟡 Incomplete Implementations

No incomplete implementations detected. TODO-like matches are documentation, test fixtures, or intentional control-flow catches.

| #   | Location | Pattern found | Notes |
| --- | -------- | ------------- | ----- |

## 🟠 Broken Module Connections

No broken module connections detected. `npm run typecheck`, boundary validation,
direct-dependency inspection, and package-script target checks pass.

| #   | Location | Connection gap | Suggested fix |
| --- | -------- | -------------- | ------------- |

## 🟣 Code Smells

| #   | Location                                         | Smell                                                                                                                        | Severity (H/M/L) |
| --- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 1   | `src/application/top-level-agent-manager.ts:282` | Background worker lifecycle, socket protocol, persistence, and recovery are concentrated in one long orchestration function. | M                |

## 🔵 Optimization Opportunities

| #   | Location          | Opportunity                                                                                                                 | Estimated impact                                    |
| --- | ----------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| 1   | `src/cli.ts:3611` | Cache `sensitiveEnvironmentValues(process.env)` once per execution instead of recomputing it for each event and error path. | Low CPU/allocation reduction in verbose stream runs |

## Recommended Action Plan

1. Keep current orchestration behavior stable; split the background worker into protocol, lifecycle, and persistence helpers only when the next feature requires touching that area.
2. Reuse one per-run sensitive-value snapshot in CLI event sinks and terminal error handling.
3. Re-run full compatibility and package gates after any refactor.

## Stats

- Total issues found: 2
- Critical: 0 | Incomplete: 0 | Broken: 0 | Smells: 1 | Optimizations: 1
- Files scanned: 186 source files, 63 scripts, 89 test modules
