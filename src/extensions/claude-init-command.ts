const LEGACY_DESCRIPTION =
  'Initialize a new CLAUDE.md file with codebase documentation'

const ENHANCED_DESCRIPTION =
  'Initialize new CLAUDE.md file(s) and optional skills/hooks with codebase documentation'

const LEGACY_PROMPT = `Analyze this repository and create a CLAUDE.md that will guide future coding-agent sessions in this project.

Document only information that requires repository-wide investigation:
- the commands developers actually use to build, lint, test, and run one focused test;
- the high-level architecture and relationships that are not obvious from opening a single file.

Read the README, manifests, build configuration, and any existing instructions for Cursor, Copilot, Windsurf, Cline, or other coding agents. Preserve useful project-specific guidance from them.

If CLAUDE.md already exists, inspect it and propose targeted improvements instead of replacing it silently. Do not invent workflows, repeat facts, enumerate an easily discoverable file tree, or add generic advice about testing, security, clean code, or error handling.

When creating the file, begin with exactly:

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.`

const ENHANCED_PROMPT = `Set up concise Claude Code instructions for this repository. The result may include a project CLAUDE.md, a private CLAUDE.local.md, project skills, and hooks, but only the artifacts the user chooses. Instructions load on every session, so retain only information whose absence would cause mistakes.

Phase 1 — choose the scope
Use AskUserQuestion to ask both of these before exploring:
1. Which instruction files to configure: the team-shared project CLAUDE.md, the private CLAUDE.local.md, or both. Explain that the project file is committed and contains shared architecture, conventions, and workflows, while the local file is gitignored and contains personal role, sandbox, test-data, and communication preferences.
2. Whether to add skills and hooks: both, skills only, hooks only, or neither. Explain that skills are invoked on demand and hooks are deterministic commands tied to tool events.
Do not label any scope choice as recommended.

Phase 2 — survey the repository
Launch an Agent to inspect relevant manifests, README and build files, CI, existing CLAUDE.md and .claude/rules, AGENTS.md, other coding-assistant instructions, .mcp.json, existing skills, formatter configuration, and git worktrees. Determine languages, frameworks, package manager, project layout, nonstandard build/test/lint commands, single-test syntax, style deviations, required environment setup, hidden gotchas, and whether personal instructions must work across sibling worktrees. Record only questions the files cannot answer.

Phase 3 — resolve unknowns and approve a proposal
Ask focused follow-up questions for facts that were not discoverable. Project questions concern team conventions and repository quirks; personal questions concern the user's role, familiarity, private test setup, and response preferences. If sibling or external worktrees exist, determine whether a shared home-directory personal-instructions file is required.

Build a compact proposal from the findings. Classify deterministic per-edit enforcement as a hook, reusable workflows as skills, and behavioral preferences as instruction-file notes. Treat the user's skills/hooks choice as a hard constraint and downgrade suggestions to an allowed artifact type when necessary. Present the proposal only through AskUserQuestion option previews: one concise markdown line per item, no separate preceding explanation, with short accept/drop labels.

Phase 4 — project instructions
If selected, create or improve the repository-root CLAUDE.md. Include only non-obvious commands, testing quirks, style differences, repository etiquette, required setup, architectural decisions, and important existing assistant rules. Prefer @path imports for long or frequently changing references. Do not include generic practices, tutorials, obvious manifest commands, exhaustive file listings, or invented sections. Begin a new file with:

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

If the file exists, show specific proposed diffs and explain them before editing. For separate concerns, offer scoped .claude/rules files; for monorepos, offer subdirectory CLAUDE.md files.

Phase 5 — personal instructions
If selected, create or improve a minimal repository-root CLAUDE.local.md and ensure CLAUDE.local.md is ignored by git. Store role, familiarity, private local setup, and personal communication/workflow preferences there. Never overwrite an existing file silently. For sibling or external worktrees, place the real private content in ~/.claude/<project-name>-instructions.md and make each CLAUDE.local.md a one-line @ import; never add that private import to the shared CLAUDE.md.

Phase 6 — skills
If selected, turn every approved skill proposal into .claude/skills/<name>/SKILL.md with valid name and description frontmatter and repository-specific instructions. Review existing skills first and never overwrite them. Add disable-model-invocation: true to side-effecting workflows and use $ARGUMENTS when input is needed. Suggest extra skills only for repeatable workflows or specialist reference knowledge genuinely present in this repository.

Phase 7 — environment and hooks
Check for GitHub remotes and gh, an appropriate linter, tests, and a formatter. Offer only missing, relevant improvements. If hooks were selected, consume approved hook proposals and optionally offer format-on-edit when a formatter exists. Choose project settings.json for shared hooks and settings.local.json for personal hooks; ask once if ambiguous. Map after-edit behavior to PostToolUse Write|Edit, end-of-turn behavior to Stop, and pre-shell behavior to PreToolUse Bash. A literal pre-commit check belongs in the repository's git hook system, not a Bash matcher. Use the update-config skill's hooks-only flow when it is available; otherwise apply the same deduplicate, construct, pipe-test, JSON-validate, live-proof, and cleanup sequence directly. Act on each accepted improvement before continuing.

Phase 8 — handoff
List every file created or changed and summarize its important contents. Tell the user to review and tune the result and that /init may be rerun. Then provide one prioritized list of repository-specific next improvements. Always mention the official skill-creator plugin for creating or evaluating skills and /plugin for browsing official plugins; suggest frontend-design or Playwright plugins only when the detected project makes them relevant.`

function envEnabled(value: string | undefined): boolean {
  if (value === undefined) return false
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

export function enhancedClaudeInitEnabled(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return envEnabled(environment.CLAUDE_CODE_NEW_INIT)
}

export function claudeInitDescription(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return enhancedClaudeInitEnabled(environment)
    ? ENHANCED_DESCRIPTION
    : LEGACY_DESCRIPTION
}

export function claudeInitPrompt(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return enhancedClaudeInitEnabled(environment)
    ? ENHANCED_PROMPT
    : LEGACY_PROMPT
}
