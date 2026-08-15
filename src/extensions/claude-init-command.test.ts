import { describe, expect, it } from 'vitest'

import {
  claudeInitDescription,
  claudeInitPrompt,
  enhancedClaudeInitEnabled,
} from './claude-init-command.js'

describe('Claude /init command contract', () => {
  it('uses the public 2.1.208 initialization flow by default', () => {
    const environment = {} as NodeJS.ProcessEnv

    expect(enhancedClaudeInitEnabled(environment)).toBe(false)
    expect(claudeInitDescription(environment)).toBe(
      'Initialize a new CLAUDE.md file with codebase documentation',
    )
    const prompt = claudeInitPrompt(environment)
    expect(prompt).toContain('Analyze this repository')
    expect(prompt).toContain('build, lint, test')
    expect(prompt).toContain('If CLAUDE.md already exists')
    expect(prompt).toContain(
      'This file provides guidance to Claude Code (claude.ai/code)',
    )
  })

  it('enables the source-gated skills and hooks flow from the shared flag', () => {
    const environment = {
      CLAUDE_CODE_NEW_INIT: '1',
    } as NodeJS.ProcessEnv

    expect(enhancedClaudeInitEnabled(environment)).toBe(true)
    expect(claudeInitDescription(environment)).toContain(
      'optional skills/hooks',
    )
    const prompt = claudeInitPrompt(environment)
    expect(prompt).toContain('Phase 1')
    expect(prompt).toContain('AskUserQuestion')
    expect(prompt).toContain('CLAUDE.local.md')
    expect(prompt).toContain('.claude/skills/<name>/SKILL.md')
    expect(prompt).toContain('PostToolUse Write|Edit')
    expect(prompt).toContain('Phase 8')
  })

  it.each(['', '0', 'false', 'FALSE', 'no', 'off', 'unexpected'])(
    'treats %j as disabled',
    (value) => {
      expect(
        enhancedClaudeInitEnabled({
          CLAUDE_CODE_NEW_INIT: value,
        } as NodeJS.ProcessEnv),
      ).toBe(false)
    },
  )

  it.each(['1', 'true', 'TRUE', 'yes', 'on'])(
    'treats %j as enabled',
    (value) => {
      expect(
        enhancedClaudeInitEnabled({
          CLAUDE_CODE_NEW_INIT: value,
        } as NodeJS.ProcessEnv),
      ).toBe(true)
    },
  )
})
