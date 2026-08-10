# Claude-style TUI parity

## Goal

Reproduce Claude Code 2.1.208's observable single-user terminal presentation in
Praxis without reading or copying Claude Code source. Keep Praxis branding,
provider neutrality, shared transcript compatibility, and screen-reader output.

## Evidence baseline

Black-box capture at 100 x 32 columns establishes these stable visual rules:

- capped-width bordered welcome card with product/version, identity, cwd, and a
  concise help area;
- conversation and composer remain separate regions;
- composer uses full-width horizontal rules and a `❯` prompt;
- model effort appears above the composer; permission mode and shortcuts appear
  below it;
- user, assistant, tool, warning, permission, question, plan, hook/MCP
  lifecycle, and busy states have distinct hierarchy rather than sharing one
  plain text style;
- narrow terminals collapse optional welcome content before core controls;
- screen-reader mode removes decorative boxes, animation, and visual-only help.

Dynamic release notes, account/billing text, hosted features, and user-provided
status-line plugins are not native parity requirements.

## State matrix

| State         | Observable Claude Code shape             | Praxis evidence                         |
| ------------- | ---------------------------------------- | --------------------------------------- |
| Launch        | bordered identity/help card              | wide and narrow `WelcomePanel` fixtures |
| Idle          | ruled `❯` composer plus mode footer      | component fixture and PTY gate          |
| Streaming     | animated-status hierarchy above composer | runtime-event interaction tests         |
| Thinking      | distinct dimmed reasoning state          | thinking start/delta/stop rendering     |
| Tool          | named call with indented input/result    | structured tool and diff fixtures       |
| Decision      | bordered, numbered choices               | permission/question/plan/MCP tests      |
| Resume        | bounded selectable conversation list     | picker interaction and viewport tests   |
| Accessibility | decoration-free semantic text            | screen-reader fixture                   |

## Architecture

`InteractiveApp` continues to own input and lifecycle state. Stateless
components under `src/cli/tui` render that state:

```text
RuntimeEvent -> interactive state -> transcript/dialog/composer components
keyboard input -------------------> existing callbacks and session service
```

No React or Ink dependency enters core, application, providers, tools, or
persistence. TUI-only metadata (version, cwd, model, effort, permission mode)
is passed from the CLI composition root and never written to shared JSONL.

## Components

- `WelcomePanel`: responsive product card and local-first help.
- `SessionPicker`: selected-row hierarchy and bounded session identity.
- `Transcript`: user/assistant/tool/result/notice/warning and operational
  lifecycle presentation.
- `Composer`: prompt, effort, mode, busy state, and keyboard help.
- `DialogFrame`: shared bordered surface used by permission, question, plan,
  recovery, and elicitation decisions.
- screen-reader branches: semantic text-only rendering through the same state.

## Interaction rules

- Existing `/new`, `/sessions`, `/workflows`, `/exit`, resume, scheduled prompt,
  cancellation, permission, plan, question, and elicitation behavior is
  unchanged.
- Tool calls retain structured name/input long enough to render a tool card.
- Successful tool results are visible but compact; failures remain prominent.
- Permission policy, MCP elicitation completion, and hook lifecycle events
  remain visible as compact operational feedback.
- Streaming text is rendered once and replaced by the completed assistant turn.
- Empty input shows a suggestion; typed input never gets replaced.
- Terminal resize changes layout only, never session or input state.

## Verification

- focused Ink render fixtures at wide and narrow widths;
- interaction tests for prompts, selection, permission, questions, plan, MCP,
  streaming, tools, cancellation, and screen-reader mode;
- PTY installed-package capture proving borders, composer, mode footer, and
  clean exit;
- full `npm run check`, package regression, and performance budgets;
- parity matrix must say visual parity is complete only after every state above
  has executable evidence.
