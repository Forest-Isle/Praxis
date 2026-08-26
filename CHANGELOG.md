# Changelog

All notable changes to Praxis are documented here. Release Please maintains
this file from merged Conventional Commit pull requests.

## [Unreleased]

### Changed

* align the WebFetch compatibility description with Claude 2.1.208 and keep
  the agents dashboard light-ANSI accent assertion aligned with the persisted
  theme palette
* make native transcript migration recoverable across every publication
  checkpoint, including a crash before the first rename, with deterministic
  fault-injection coverage
* extend the native deletion gate through the built CLI sessions/inspect/export
  and fork lifecycle while preserving native-only data-plane isolation
* route explicitly requested Claude Team delete/send compatibility calls through
  the native lead-operation seam, while rejecting lossy create and unsupported
  task/notification/context/session-resume shapes
* stream Team mailbox audits with bounded retained tails instead of loading the
  complete mailbox into memory
* complete the TUI semantic screen projection across selectable surfaces and
  add deterministic resize-aware URL/form elicitation rendering
* extend the implemented native build profile with transcript/session closure
  and an emitted-output Claude deletion gate; the full native package remains
  unqualified and transcript migration remains explicit and recoverable
* add an executable #402 core-completion audit covering all 56 PRD stories and
  separating implemented, qualified, and blocked evidence
* keep disabled Team startup free of observability/mailbox module loading, and
  expose durable-local `team status`, `team logs`, and `team attach` projections
* add a removable, fail-closed Claude Team adapter for fixture-verified
  delete/send, shutdown, and plan-response shapes; create rejects lossy input

## [0.37.0](https://github.com/Forest-Isle/Praxis/compare/v0.36.1...v0.37.0) (2026-08-24)


### Features

* add durable local Team ownership ([#432](https://github.com/Forest-Isle/Praxis/issues/432)) ([72838c2](https://github.com/Forest-Isle/Praxis/commit/72838c2d1048c6da249d9b51b382772e1859fc55))
* add durable Team mailbox ([#443](https://github.com/Forest-Isle/Praxis/issues/443)) ([938c7fa](https://github.com/Forest-Isle/Praxis/commit/938c7fa1824ecf2155232f87091d39ddaf93c5f1))
* add Swarm and Lead execution policies ([#447](https://github.com/Forest-Isle/Praxis/issues/447)) ([18dbb89](https://github.com/Forest-Isle/Praxis/commit/18dbb898f90b8d2921014153b32d52cedda1a4ad))


### Performance Improvements

* establish the TUI presentation environment ([#431](https://github.com/Forest-Isle/Praxis/issues/431)) ([3e9e4f7](https://github.com/Forest-Isle/Praxis/commit/3e9e4f7e011f78bc2ea832ada62740ef9211e5ba))

## [0.36.1](https://github.com/Forest-Isle/Praxis/compare/v0.36.0...v0.36.1) (2026-08-24)


### Performance Improvements

* retain and index the TUI transcript window ([#428](https://github.com/Forest-Isle/Praxis/issues/428)) ([ba29ff0](https://github.com/Forest-Isle/Praxis/commit/ba29ff06c3299d613605861a20cfee6b70ed6b16))

## [0.36.0](https://github.com/Forest-Isle/Praxis/compare/v0.35.0...v0.36.0) (2026-08-24)


### Features

* unify durable agent orchestration lifecycle ([#424](https://github.com/Forest-Isle/Praxis/issues/424)) ([3b25523](https://github.com/Forest-Isle/Praxis/commit/3b25523e46ee556016c2dfa5f7a118990607bc0e)), closes [#396](https://github.com/Forest-Isle/Praxis/issues/396)

Releases through 0.35.0 are available in
[GitHub Releases](https://github.com/Forest-Isle/Praxis/releases).
