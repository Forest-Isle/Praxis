# Changelog

All notable changes to Praxis are documented here. Release Please maintains
this file from merged Conventional Commit pull requests.

## Unreleased

### Features

* add isolated project outcome evaluations with bounded verifier artifacts ([#541](https://github.com/Forest-Isle/Praxis/issues/541))
* add hermetic coding baseline fixtures and deterministic aggregate comparison ([#544](https://github.com/Forest-Isle/Praxis/issues/544))
* add bounded Anthropic non-streaming recovery for eligible stream failures ([#553](https://github.com/Forest-Isle/Praxis/issues/553))
* bound model-visible MCP tool descriptions to 2,048 Unicode code points ([#558](https://github.com/Forest-Isle/Praxis/issues/558))
* defer default MCP tool schemas behind turn-scoped ToolSearch activation ([#555](https://github.com/Forest-Isle/Praxis/issues/555))
* externalize oversized text-only MCP results to redacted session files ([#561](https://github.com/Forest-Isle/Praxis/issues/561))
* honor MCP read-only hints in default permission decisions ([#564](https://github.com/Forest-Isle/Praxis/issues/564))
* separate provider connect, byte-idle, and absolute-total timeouts ([#550](https://github.com/Forest-Isle/Praxis/issues/550))
* add the explicit API-key OpenAI Responses provider ([#569](https://github.com/Forest-Isle/Praxis/issues/569))
* add turn-scoped main-session provider fallback routing ([#574](https://github.com/Forest-Isle/Praxis/issues/574))
* scope turn-provider fallback routing to independent auxiliary operations ([#576](https://github.com/Forest-Isle/Praxis/issues/576))

### Bug Fixes

* refresh volatile Git repository context per request with bounded, lock-safe collection ([#152](https://github.com/Forest-Isle/Praxis/issues/152))
* recover malformed provider tool arguments without executing the tool or losing resumable native turns ([#138](https://github.com/Forest-Isle/Praxis/issues/138))
* persist Bash working directories and allow 10-minute commands ([#535](https://github.com/Forest-Isle/Praxis/issues/535))
* require prior reads before mutating existing files ([#532](https://github.com/Forest-Isle/Praxis/issues/532))

## [0.53.1](https://github.com/Forest-Isle/Praxis/compare/v0.53.0...v0.53.1) (2026-09-01)


### Bug Fixes

* refresh bounded Git context per request ([#567](https://github.com/Forest-Isle/Praxis/issues/567)) ([709100b](https://github.com/Forest-Isle/Praxis/commit/709100b0d2c0d86a9e2d9c2817b4dfafb206a8a3)), closes [#152](https://github.com/Forest-Isle/Praxis/issues/152)

## [0.53.0](https://github.com/Forest-Isle/Praxis/compare/v0.52.0...v0.53.0) (2026-09-01)


### Features

* honor MCP read-only permission hints ([#565](https://github.com/Forest-Isle/Praxis/issues/565)) ([1202a3d](https://github.com/Forest-Isle/Praxis/commit/1202a3daa3bc5d2beeb4fbf3f968380f517a90ee)), closes [#564](https://github.com/Forest-Isle/Praxis/issues/564)

## [0.52.0](https://github.com/Forest-Isle/Praxis/compare/v0.51.0...v0.52.0) (2026-09-01)


### Features

* externalize oversized MCP text results ([#562](https://github.com/Forest-Isle/Praxis/issues/562)) ([de3edbd](https://github.com/Forest-Isle/Praxis/commit/de3edbd88c568de0379333d69eda8d2793bd47da))

## [0.51.0](https://github.com/Forest-Isle/Praxis/compare/v0.50.0...v0.51.0) (2026-09-01)


### Features

* bound MCP tool descriptions ([#559](https://github.com/Forest-Isle/Praxis/issues/559)) ([ee75dc7](https://github.com/Forest-Isle/Praxis/commit/ee75dc790ec7ed2083afccbd69d075a3db9e26bb))

## [0.50.0](https://github.com/Forest-Isle/Praxis/compare/v0.49.0...v0.50.0) (2026-09-01)


### Features

* defer default MCP schemas behind ToolSearch ([#556](https://github.com/Forest-Isle/Praxis/issues/556)) ([210a40e](https://github.com/Forest-Isle/Praxis/commit/210a40ed45e30d7c28180ee729d6b90c0d81ce0e))

## [0.49.0](https://github.com/Forest-Isle/Praxis/compare/v0.48.1...v0.49.0) (2026-09-01)


### Features

* add non-streaming provider fallback ([#554](https://github.com/Forest-Isle/Praxis/issues/554)) ([afa43bf](https://github.com/Forest-Isle/Praxis/commit/afa43bf30572295e0fbbe59e8430e665188f9be0))
* separate provider timeout phases ([#551](https://github.com/Forest-Isle/Praxis/issues/551)) ([7e94d11](https://github.com/Forest-Isle/Praxis/commit/7e94d11185475d49bdd5900f4add58db623bf664)), closes [#540](https://github.com/Forest-Isle/Praxis/issues/540)

## [0.48.1](https://github.com/Forest-Isle/Praxis/compare/v0.48.0...v0.48.1) (2026-09-01)


### Bug Fixes

* recover malformed tool input ([#547](https://github.com/Forest-Isle/Praxis/issues/547)) ([1bf1e20](https://github.com/Forest-Isle/Praxis/commit/1bf1e209c3392ca188d79c80e464e35b33a46102)), closes [#138](https://github.com/Forest-Isle/Praxis/issues/138)

## [0.48.0](https://github.com/Forest-Isle/Praxis/compare/v0.47.0...v0.48.0) (2026-09-01)


### Features

* add coding baseline comparison ([#545](https://github.com/Forest-Isle/Praxis/issues/545)) ([180e474](https://github.com/Forest-Isle/Praxis/commit/180e4747de61371e787865eadbc26be4fdde2228)), closes [#544](https://github.com/Forest-Isle/Praxis/issues/544)

## [0.47.0](https://github.com/Forest-Isle/Praxis/compare/v0.46.5...v0.47.0) (2026-09-01)


### Features

* add project outcome evaluation harness ([#542](https://github.com/Forest-Isle/Praxis/issues/542)) ([8a65de1](https://github.com/Forest-Isle/Praxis/commit/8a65de1ef3a8d899aad5b4f61ca5d797d3cac79b)), closes [#541](https://github.com/Forest-Isle/Praxis/issues/541)

## [0.46.5](https://github.com/Forest-Isle/Praxis/compare/v0.46.4...v0.46.5) (2026-08-31)


### Bug Fixes

* enforce explicit Read output limits ([#538](https://github.com/Forest-Isle/Praxis/issues/538)) ([ad7041b](https://github.com/Forest-Isle/Praxis/commit/ad7041b18a6c28870376e926af43a030ce90041c)), closes [#127](https://github.com/Forest-Isle/Praxis/issues/127)

## [0.46.4](https://github.com/Forest-Isle/Praxis/compare/v0.46.3...v0.46.4) (2026-08-31)


### Bug Fixes

* persist Bash session working directories ([#536](https://github.com/Forest-Isle/Praxis/issues/536)) ([d3020a7](https://github.com/Forest-Isle/Praxis/commit/d3020a7aaf35f8bcc8da070b24d59ace3c958e6b)), closes [#535](https://github.com/Forest-Isle/Praxis/issues/535)

## [0.46.3](https://github.com/Forest-Isle/Praxis/compare/v0.46.2...v0.46.3) (2026-08-31)


### Bug Fixes

* enforce safe file mutation semantics ([#533](https://github.com/Forest-Isle/Praxis/issues/533)) ([b3e0150](https://github.com/Forest-Isle/Praxis/commit/b3e015000161e723d539977804a7717b3eb8a460))

## [0.46.2](https://github.com/Forest-Isle/Praxis/compare/v0.46.1...v0.46.2) (2026-08-31)


### Bug Fixes

* require trust before changing directories ([#530](https://github.com/Forest-Isle/Praxis/issues/530)) ([111f2bf](https://github.com/Forest-Isle/Praxis/commit/111f2bfe61299c27c2edf363738d5033cf853eea))

## [0.46.1](https://github.com/Forest-Isle/Praxis/compare/v0.46.0...v0.46.1) (2026-08-31)


### Bug Fixes

* restore fullscreen prompt history ([#526](https://github.com/Forest-Isle/Praxis/issues/526)) ([834b820](https://github.com/Forest-Isle/Praxis/commit/834b820923727eadf5db09551cd6caaaefe95001)), closes [#525](https://github.com/Forest-Isle/Praxis/issues/525)

## [0.46.0](https://github.com/Forest-Isle/Praxis/compare/v0.45.4...v0.46.0) (2026-08-30)


### Features

* support active-turn steering and follow-ups ([#523](https://github.com/Forest-Isle/Praxis/issues/523)) ([964e010](https://github.com/Forest-Isle/Praxis/commit/964e01024bf0716e12cde7df03be93aeb52c0e33))

## [0.45.4](https://github.com/Forest-Isle/Praxis/compare/v0.45.3...v0.45.4) (2026-08-30)


### Bug Fixes

* support fullscreen terminal selection ([#521](https://github.com/Forest-Isle/Praxis/issues/521)) ([b3efcf4](https://github.com/Forest-Isle/Praxis/commit/b3efcf4a3eaf9b1ca09702c1ab74d995638db104))

## [0.45.3](https://github.com/Forest-Isle/Praxis/compare/v0.45.2...v0.45.3) (2026-08-30)


### Bug Fixes

* persist Workflow validation failures ([#518](https://github.com/Forest-Isle/Praxis/issues/518)) ([ebab8b7](https://github.com/Forest-Isle/Praxis/commit/ebab8b74b0d64f7d6a8cbba38881587ba5f6d0d8))

## [0.45.2](https://github.com/Forest-Isle/Praxis/compare/v0.45.1...v0.45.2) (2026-08-30)


### Bug Fixes

* accept multiline Bash permission rules ([#517](https://github.com/Forest-Isle/Praxis/issues/517)) ([9f6eb3d](https://github.com/Forest-Isle/Praxis/commit/9f6eb3d7413e4ff8f4979014e6fc3d4da49a20ed))

## [0.45.1](https://github.com/Forest-Isle/Praxis/compare/v0.45.0...v0.45.1) (2026-08-30)


### Bug Fixes

* avoid duplicate thinking preview in audit mode ([#511](https://github.com/Forest-Isle/Praxis/issues/511)) ([4ee13d2](https://github.com/Forest-Isle/Praxis/commit/4ee13d243a36be46b3e8089df5a28ef6be468da6)), closes [#510](https://github.com/Forest-Isle/Praxis/issues/510)

## [0.45.0](https://github.com/Forest-Isle/Praxis/compare/v0.44.0...v0.45.0) (2026-08-30)


### Features

* refresh tui operator visual language ([#505](https://github.com/Forest-Isle/Praxis/issues/505)) ([4f5a140](https://github.com/Forest-Isle/Praxis/commit/4f5a1408de86ddb7e6b9dd3bde94d03ae552a396))


### Bug Fixes

* keep bang shell turns provider-free ([#508](https://github.com/Forest-Isle/Praxis/issues/508)) ([034eb5f](https://github.com/Forest-Isle/Praxis/commit/034eb5fd896a42862458180469ad48622e0d4ea1))

## [0.44.0](https://github.com/Forest-Isle/Praxis/compare/v0.43.1...v0.44.0) (2026-08-28)


### Features

* add native multi-provider authentication ([#502](https://github.com/Forest-Isle/Praxis/issues/502)) ([8ffbf81](https://github.com/Forest-Isle/Praxis/commit/8ffbf8103afea5059144745291e6011532137a47))

## [0.43.1](https://github.com/Forest-Isle/Praxis/compare/v0.43.0...v0.43.1) (2026-08-28)


### Bug Fixes

* require output tty for fullscreen renderer ([#496](https://github.com/Forest-Isle/Praxis/issues/496)) ([06e18e4](https://github.com/Forest-Isle/Praxis/commit/06e18e4083a52a1ee402d6bcc64630bbd16e278d)), closes [#494](https://github.com/Forest-Isle/Praxis/issues/494)

## [0.43.0](https://github.com/Forest-Isle/Praxis/compare/v0.42.1...v0.43.0) (2026-08-28)


### Features

* make self-updates transactional ([#486](https://github.com/Forest-Isle/Praxis/issues/486)) ([8eaa273](https://github.com/Forest-Isle/Praxis/commit/8eaa2730824fcd68e7ef1d9f061f6b5d0aba3cea)), closes [#182](https://github.com/Forest-Isle/Praxis/issues/182)

## [0.42.1](https://github.com/Forest-Isle/Praxis/compare/v0.42.0...v0.42.1) (2026-08-28)


### Bug Fixes

* bound MCP operations and reconnect disconnected servers ([#484](https://github.com/Forest-Isle/Praxis/issues/484)) ([cd32480](https://github.com/Forest-Isle/Praxis/commit/cd32480d606e62848ffb94ef210192c7906c72e1))

## [0.42.0](https://github.com/Forest-Isle/Praxis/compare/v0.41.0...v0.42.0) (2026-08-28)


### Features

* enforce provider request deadlines ([#481](https://github.com/Forest-Isle/Praxis/issues/481)) ([1b04552](https://github.com/Forest-Isle/Praxis/commit/1b045527ec86b29ab23b52de2fe099271f82124e)), closes [#480](https://github.com/Forest-Isle/Praxis/issues/480)

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

* keep the active-turn composer editable, with safe-boundary Enter steering,
  FIFO Tab/Alt+Enter follow-up turns, visible pending input, and Up-to-edit
  withdrawal (#514)
* add transactional checksum-verified self-update with exclusive locking,
  rollback, and crash recovery
* bound every Anthropic/OpenAI provider attempt with a configurable absolute
  deadline and abort-aware fallback backoff
* add exact-fingerprint workspace trust that blocks automatically discovered
  project/local hooks, MCP servers, and provider/profile/model routing until the
  canonical workspace is accepted
* add native multi-provider routing, credential Vault storage, `praxis auth`
  actions, non-executing Doctor diagnostics, and the explicitly experimental
  ChatGPT-backed `openai-codex` OAuth provider with a process-argument-safe
  browser redirect bridge (#477)
* preserve provider profile, deadline, Vault backend, and safely normalized
  credentials in background workers; keep subscription accounting token-only
  without API-dollar charges
* document stable API-key setup, provider profiles, Vault controls, and Codex
  OAuth limitations (#477)
* add a responsive shared QuietFrame projection for every selectable
  interactive surface, rendered through ANSI or Ink adapters with full parity
* adopt the terminal-native C+ Quiet Operator palette with mint, amber, and
  red semantics, linear conversation, compact tool disclosure, and a minimal
  composer/status row
* use English permission/configuration choices with a simple `❯`, Up/Down,
  Enter, and Esc focus/navigation grammar
* add a framework-free TUI runtime kernel with pure reducer transitions and
  atomic streaming text/thinking frame publication
* add a shared semantic transcript Row IR with stable source-derived keys and
  renderer-neutral role segments
* add an independent ANSI fullscreen frame renderer with alternate-screen
  lifecycle, synchronized output, and dirty-row diffing
* wire ANSI rendering into interactive TTY sessions with automatic Ink
  fallback while preserving screen-reader and non-TTY paths, using the shared
  QuietFrame for complete surface parity
* centralize TUI overlay and dialog precedence in a pure FocusStack projection
  without changing existing keybindings or cancellation targets
* guard theme loading with a generation-aware effect runner that aborts on
  replacement/unmount and suppresses stale results
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
* enforce Quiet Operator input-echo and normal/low-capability ANSI frame p95
  budgets with a deterministic production-build performance gate

### Fixed

* require an explicit, default-reject trust decision before `/cd` enters an
  unfamiliar canonical directory, while reusing accepted paths for the current
  session and preserving semantic screen-reader controls (#90)
* support fullscreen `Ctrl+L` redraw and mouse transcript selection with wheel
  scrolling, edge autoscroll, and OSC 52 copy (#516)
* persist Workflow metadata validation failures as ordinary native tool errors
  without unclaimed-call warnings, and document the required phase-object shape
  (#512)
* allow persisted multiline Bash permission rules, including heredoc commands,
  to pass shared validation (#515)

* keep interactive `!` shell turns provider-free after native Bash execution
  while preserving permission, hooks, transcript, cancellation, and accounting

* bound MCP connection, discovery, and tool lifecycles with safe disconnect
  recovery that never replays an already-dispatched tool call

### Changed

* refresh the normal TUI visual grammar with `❯` user prompts, `⏺` assistant
  activity, `✻` thinking markers, and `!` shell input while preserving
  screen-reader labels and transcript semantics
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
