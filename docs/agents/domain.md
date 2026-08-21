# Domain docs

Praxis is a single-context repository. Engineering skills should consume its
domain documentation as follows.

## Before exploring

- Read the root `CONTEXT.md`.
- Read ADRs under `docs/adr/` that touch the area being changed.
- If either location is absent, continue silently. Create domain documentation
  only when a concrete modeling decision requires it.

## Use the glossary vocabulary

Use terms as defined in `CONTEXT.md` in issue titles, implementation plans,
tests, and architectural proposals. If a required concept is missing, first
decide whether the proposed term is unnecessary or exposes a real domain gap.

## Flag ADR conflicts

Surface any conflict with an existing ADR explicitly. Do not silently override
an accepted architectural decision.
