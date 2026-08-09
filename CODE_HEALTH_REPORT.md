# Code Health Report

> Generated: 2026-08-09
> Project: Praxis
> Scanned: 185 source files, 60 scripts, 88 test modules

## Executive Summary

Praxis is buildable and fully wired for current single-user CLI scope. TypeScript
typechecking, boundary checks, focused regressions, package-script references,
and direct production dependencies pass. Stage 87 adds protected plugin option
storage, scoped effective configuration, full LSP/MCP/hook/model-content
substitution, last-scope cleanup, and cross-runtime secret redaction on top of
the Stage 86 LSP runtime. All 88 test modules and 760 tests pass. No
unfinished feature stubs, unresolved imports, or missing script targets remain.
All 51 compatibility gates, clean package install, performance budgets, strict
unused checks, and production dependency audit pass.

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
- Files scanned: 185 source files, 60 scripts, 88 test modules
