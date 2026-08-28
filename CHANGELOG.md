# Changelog

All notable changes to Praxis are documented here. Release Please maintains
this file from merged Conventional Commit pull requests.

## [0.41.0](https://github.com/Forest-Isle/Praxis/compare/v0.40.0...v0.41.0) (2026-08-28)


### Features

* gate workspace executables behind trust ([#478](https://github.com/Forest-Isle/Praxis/issues/478)) ([8c108a4](https://github.com/Forest-Isle/Praxis/commit/8c108a46665c44158474a060ef6db83a4ad98633)), closes [#475](https://github.com/Forest-Isle/Praxis/issues/475)

## [0.40.0](https://github.com/Forest-Isle/Praxis/compare/v0.39.0...v0.40.0) (2026-08-28)


### Features

* redesign interactive tui with hybrid ansi renderer ([#472](https://github.com/Forest-Isle/Praxis/issues/472)) ([59fb79f](https://github.com/Forest-Isle/Praxis/commit/59fb79fa16e237ee57e2598288290a2091deaf86))

## [0.39.0](https://github.com/Forest-Isle/Praxis/compare/v0.38.0...v0.39.0) (2026-08-27)


### Features

* publish native-only data plane ([#470](https://github.com/Forest-Isle/Praxis/issues/470)) ([697e2ea](https://github.com/Forest-Isle/Praxis/commit/697e2ea60c7c3328ad4ae90848e39baf479f9f8c))

## [0.38.0](https://github.com/Forest-Isle/Praxis/compare/v0.37.0...v0.38.0) (2026-08-26)


### Features

* complete core design closure and compatibility qualification ([#467](https://github.com/Forest-Isle/Praxis/issues/467)) ([98b6ab1](https://github.com/Forest-Isle/Praxis/commit/98b6ab17cb15baa12d678d579fff0e5d60c6d9d9))

## [Unreleased]

### Added

* bound every Anthropic/OpenAI provider attempt with a configurable absolute
  deadline and abort-aware fallback backoff
* add exact-fingerprint workspace trust that blocks automatically discovered
  project/local hooks and MCP servers until the canonical workspace is accepted
* add a reusable P-loop + spark Praxis TUI logo with semantic theme styling
  and screen-reader/no-color fallbacks
* add a framework-free TUI runtime kernel with pure reducer transitions and
  atomic streaming text/thinking frame publication
* add a shared semantic transcript Row IR with stable source-derived keys and
  renderer-neutral role segments
* add an independent ANSI fullscreen frame renderer with alternate-screen
  lifecycle, synchronized output, and dirty-row diffing
* wire ANSI rendering into interactive TTY sessions with automatic Ink
  fallback while preserving screen-reader and non-TTY paths
* centralize TUI overlay and dialog precedence in a pure FocusStack projection
  without changing existing keybindings or cancellation targets
* keep complex overlay/dialog surfaces on Ink until a complete semantic ANSI
  projection is available, avoiding lossy generic summaries
* guard theme loading with a generation-aware effect runner that aborts on
  replacement/unmount and suppresses stale results
* keep welcome and identity intro frames on Ink so ANSI mode never hides the
  complete first-session surface
* route Row IR through the authoritative transcript viewport layout for
  width-aware Unicode/Markdown physical rows without duplicate prefixes
* unify runtime and composer state behind the framework-free `TuiStore`, with
  cursor clamping, identity-preserving no-ops, and runtime transitions that
  retain composer state
* derive ANSI fullscreen text styles from the active semantic theme, including
  ANSI16/256/truecolor conversion and automatic no-color/screen-reader
  suppression
* add a hermetic PTY smoke for real `runInteractive` ANSI entry, resumed
  transcript rendering, Ctrl-C confirmation, and terminal lifecycle cleanup

### Changed

* make the Praxis data plane native-only: sessions, resources, permissions,
  hooks, MCP, scheduled prompts, and operational state now use `~/.praxis`
  and native project roots; Claude Code directories are never read or written
* rename scheduled-task persistence to `NativeScheduledTaskStore` and keep the
  established JSON task fields and atomic mutation behavior unchanged
* normalize conditional-rule paths through `realpath` so macOS symlink aliases
  match the same native rule glob
* align the WebFetch compatibility description with Claude 2.1.208 and keep
  the agents dashboard light-ANSI accent assertion aligned with the persisted
  theme palette
* extend the native deletion gate through the built CLI sessions/inspect/export
  and fork lifecycle while preserving native-only data-plane isolation
* stream Team mailbox audits with bounded retained tails instead of loading the
  complete mailbox into memory
* complete the TUI semantic screen projection across selectable surfaces and
  add deterministic resize-aware URL/form elicitation rendering
* extend the implemented native build profile with transcript/session closure
  and an emitted-output deletion gate; non-native transcript files fail closed
  without migration
* add an executable #402 core-completion audit covering all 56 PRD stories and
  separating implemented, qualified, and blocked evidence
* keep disabled Team startup free of observability/mailbox module loading, and
  expose durable-local `team status`, `team logs`, and `team attach` projections

### Removed

* remove the Claude compatibility runtime, transcript/index/sidechain stores,
  migration helpers, and compatibility qualification/probe scripts

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
