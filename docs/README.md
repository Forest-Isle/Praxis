# Praxis Documentation

This index separates task-oriented user guidance from product guidance,
architecture references, and maintainer operations. `praxis --help` remains the
authoritative CLI surface.

## Start here

- [Getting Started](GETTING_STARTED.md) — install, configure a provider, run a
  first session, manage native session state, update, and troubleshoot.
- [CLI Reference](CLI_REFERENCE.md) — common workflows, provider environment,
  execution modes, persistence, and safety controls.
- [Support](../SUPPORT.md) — questions, bug reports, feature requests, and
  security-report routing.

## Product behavior

- [Native Fixture Contracts](NATIVE_FIXTURE_CONTRACTS.md) — current executable
  native behavior contracts and qualification evidence source.
- [Single-User CLI Parity Matrix](PARITY_MATRIX.md) — historical clean-room
  status and evidence record; it is not the current qualification source.
- [Claude-style TUI Parity](TUI_PARITY.md) — black-box visual rules,
  presentation components, interactions, and verification gates.
- [Quiet Operator Spec](TUI_REDESIGN_SPEC.md) — C+ TUI visual language,
  interaction grammar, architecture, and stability budgets.
- [Agent Runtime Contract](RUNTIME_CONTRACT.md) — runtime states, ports,
  persistence, and error behavior.
- [Native Subagent Contract](SUBAGENT_CONTRACT.md) — foreground/background
  subagent execution and persistence.
- [Development Roadmap](ROADMAP.md) — historical implementation stages and
  acceptance gates; it is not a runtime or qualification dependency.
- [Outcome-Driven Coding Agent Roadmap](CODING_AGENT_ROADMAP.md) — current
  dependency order, evidence contract, and staged plan for measurable coding
  outcomes.

## Architecture and security

- [Architecture](ARCHITECTURE.md) — module boundaries and main data flows.
- [Threat Model](THREAT_MODEL.md) — trust assumptions, threats, and required
  controls.
- [Native-only ADR](adr/0002-native-only-removal.md) — why Praxis uses an
  independent native data plane and local-only product boundary.
- [Workspace trust ADR](adr/0005-workspace-executable-trust.md) — canonical
  fingerprint authorization for workspace-controlled resources.
- [Provider authentication ADR](adr/0006-native-provider-authentication.md) —
  native provider routing, credential Vault, and experimental Codex OAuth.
- [Performance Budgets](PERFORMANCE.md) — release performance limits and gate.

## Maintainer operations

- [Contributing](../CONTRIBUTING.md) — development setup, test selection, and PR
  policy.
- [Security Policy](../SECURITY.md) — supported versions and private reporting.
- [Release Contract](RELEASE.md) — package boundary, runtime matrix, and release
  evidence.
- [Release Automation](RELEASE_AUTOMATION.md) — Release Please, OIDC publishing,
  retry, and recovery procedures.
- [Issue Tracker](agents/issue-tracker.md) — local GitHub issue operations and
  triage lifecycle.
- [Triage Labels](agents/triage-labels.md) — canonical role/label governance.

## Community and legal

- [Support](../SUPPORT.md) — route questions, bugs, features, and vulnerabilities.
- [Code of Conduct](../CODE_OF_CONDUCT.md) — Contributor Covenant 2.1 and
  enforcement contact.
- [MIT License](../LICENSE) — project license.
- [Third-Party Notices](../THIRD_PARTY_NOTICES.md) — vendored material and
  attribution.

## Focused design records

- [Active-turn Input](ACTIVE_TURN_INPUT.md) — safe-boundary steering, queued
  follow-up turns, pending-input presentation, and race behavior.
- [Workflow Contract](STAGE23_WORKFLOW.md)
- [Dynamic Wakeup Contract](STAGE24_DYNAMIC_WAKEUP.md)
- [Native Worktrees](STAGE25_WORKTREES.md)

These focused records explain implementation decisions. New users normally
need only Getting Started and CLI Reference.
