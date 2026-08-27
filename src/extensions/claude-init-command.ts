const NATIVE_LEGACY_DESCRIPTION =
  'Initialize Praxis project instructions with codebase documentation'

const NATIVE_ENHANCED_DESCRIPTION =
  'Initialize Praxis instructions and optional skills/hooks with codebase documentation'

const NATIVE_LEGACY_PROMPT = `Analyze this repository and create .praxis/PRAXIS.md to guide future Praxis sessions in this project.

Document only information that requires repository-wide investigation:
- the commands developers actually use to build, lint, test, and run one focused test;
- the high-level architecture and relationships that are not obvious from opening a single file.

Read the README, manifests, build configuration, AGENTS.md, and any existing instructions for coding agents. Preserve useful project-specific guidance from them.

If .praxis/PRAXIS.md already exists, inspect it and propose targeted improvements instead of replacing it silently. Do not invent workflows, repeat facts, enumerate an easily discoverable file tree, or add generic advice about testing, security, clean code, or error handling.

When creating the file, begin with exactly:

# PRAXIS.md

This file provides guidance to Praxis when working with code in this repository.`

const NATIVE_ENHANCED_PROMPT = `Set up concise Praxis instructions for this repository. Use only Praxis-native resources: user resources under ~/.praxis and project resources under .praxis. Do not create or modify legacy compatibility resources. Instructions load on every session, so retain only information whose absence would cause mistakes.

Phase 1 — choose the scope
Use AskUserQuestion to ask both of these before exploring:
1. Which instruction files to configure: the team-shared project .praxis/PRAXIS.md, the private user ~/.praxis/PRAXIS.md, or both. Explain that the project file is committed and contains shared architecture, conventions, and workflows, while the user file contains personal role, sandbox, test-data, and communication preferences.
2. Whether to add skills and hooks: both, skills only, hooks only, or neither. Explain that skills are invoked on demand and hooks are deterministic commands tied to tool events.
Do not label any scope choice as recommended.

Phase 2 — survey the repository
Launch an Agent to inspect relevant manifests, README and build files, CI, existing Praxis resources, AGENTS.md, other coding-assistant instructions, MCP configuration, existing skills, formatter configuration, and git worktrees. Determine languages, frameworks, package manager, project layout, nonstandard build/test/lint commands, single-test syntax, style deviations, required environment setup, and hidden gotchas. Record only questions the files cannot answer.

Phase 3 — resolve unknowns and approve a proposal
Ask focused follow-up questions for facts that were not discoverable. Build a compact proposal from the findings. Classify deterministic per-edit enforcement as a hook, reusable workflows as skills, and behavioral preferences as instruction-file notes. Treat the user's skills/hooks choice as a hard constraint. Present the proposal only through AskUserQuestion option previews: one concise markdown line per item, no separate preceding explanation, with short accept/drop labels.

Phase 4 — instructions
For project instructions, create or improve .praxis/PRAXIS.md. For private user instructions, create or improve ~/.praxis/PRAXIS.md. Include only non-obvious commands, testing quirks, style differences, repository etiquette, required setup, architectural decisions, and important existing assistant rules. Never overwrite an existing file silently. Begin a new instruction file with:

# PRAXIS.md

This file provides guidance to Praxis when working with code in this repository.

Phase 5 — skills
If selected, turn every approved project skill proposal into .praxis/skills/<name>/SKILL.md and every approved user skill into ~/.praxis/skills/<name>/SKILL.md. Use valid name and description frontmatter and repository-specific instructions. Review existing skills first and never overwrite them. Add disable-model-invocation: true to side-effecting workflows and use $ARGUMENTS when input is needed.

Phase 6 — environment and hooks
Check for GitHub remotes and gh, an appropriate linter, tests, and a formatter. Offer only missing, relevant improvements. Store shared project hook settings in .praxis/settings.json, personal project settings in .praxis/settings.local.json, and user settings in ~/.praxis/settings.json. Preserve unrelated settings, validate JSON, and test each accepted hook safely before continuing.

Phase 7 — handoff
List every file created or changed and summarize its important contents. Tell the user to review and tune the result and that /init may be rerun. Then provide one prioritized list of repository-specific next improvements.`

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
    ? NATIVE_ENHANCED_DESCRIPTION
    : NATIVE_LEGACY_DESCRIPTION
}

export function claudeInitPrompt(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return enhancedClaudeInitEnabled(environment)
    ? NATIVE_ENHANCED_PROMPT
    : NATIVE_LEGACY_PROMPT
}
