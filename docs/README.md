# Praxis Documentation

This index separates task-oriented user guidance from compatibility contracts,
architecture references, and maintainer operations. `praxis --help` remains the
authoritative CLI surface.

## Start here

- [Getting Started](GETTING_STARTED.md) — install, configure a provider, run a
  first session, share Claude Code state, update, and troubleshoot.
- [CLI Reference](CLI_REFERENCE.md) — common workflows, provider environment,
  execution modes, persistence, and safety controls.
- [Support](../SUPPORT.md) — questions, bug reports, feature requests, and
  security-report routing.

## Product and compatibility

- [Claude Code Compatibility Contract](COMPATIBILITY.md) — shared local data,
  versioned write profiles, provider translation, and exclusions.
- [Single-User CLI Parity Matrix](PARITY_MATRIX.md) — feature-by-feature status
  and executable evidence.
- [Claude-style TUI Parity](TUI_PARITY.md) — black-box visual rules,
  presentation components, interactions, and verification gates.
- [Agent Runtime Contract](RUNTIME_CONTRACT.md) — runtime states, ports,
  persistence, and error behavior.
- [Native Subagent Contract](SUBAGENT_CONTRACT.md) — foreground/background
  subagent execution and persistence.
- [Development Roadmap](ROADMAP.md) — historical implementation stages and
  acceptance gates.

## Architecture and security

- [Architecture](ARCHITECTURE.md) — module boundaries and main data flows.
- [Threat Model](THREAT_MODEL.md) — trust assumptions, threats, and required
  controls.
- [Compatibility-first ADR](adr/0001-compatibility-first-clean-room.md) — why
  Praxis uses a clean-room, observable-contract design.
- [Performance Budgets](PERFORMANCE.md) — release performance limits and gate.

## Maintainer operations

- [Contributing](../CONTRIBUTING.md) — development setup, test selection, and PR
  policy.
- [Security Policy](../SECURITY.md) — supported versions and private reporting.
- [Release Contract](RELEASE.md) — package boundary, runtime matrix, and release
  evidence.
- [Release Automation](RELEASE_AUTOMATION.md) — Release Please, OIDC publishing,
  retry, and recovery procedures.

## Community and legal

- [Support](../SUPPORT.md) — route questions, bugs, features, and vulnerabilities.
- [Code of Conduct](../CODE_OF_CONDUCT.md) — Contributor Covenant 2.1 and
  enforcement contact.
- [MIT License](../LICENSE) — project license.
- [Third-Party Notices](../THIRD_PARTY_NOTICES.md) — vendored material and
  attribution.

## Focused design records

- [Workflow Contract](STAGE23_WORKFLOW.md)
- [Dynamic Wakeup Contract](STAGE24_DYNAMIC_WAKEUP.md)
- [Native Worktrees](STAGE25_WORKTREES.md)

These focused records explain implementation decisions. New users normally
need only Getting Started, CLI Reference, and the compatibility contract.
