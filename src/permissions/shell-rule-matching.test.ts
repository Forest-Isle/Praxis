import { describe, expect, it } from 'vitest'

import {
  parseShellRule,
  shellRuleMatches,
  shellWildcardMatches,
} from './shell-rule-matching.js'

describe('Claude shell permission rule matching', () => {
  it('distinguishes exact, legacy prefix, and wildcard rules', () => {
    expect(parseShellRule('npm test')).toEqual({
      type: 'exact',
      command: 'npm test',
    })
    expect(parseShellRule('npm test:*')).toEqual({
      type: 'prefix',
      prefix: 'npm test',
    })
    expect(parseShellRule('git * --stat')).toEqual({
      type: 'wildcard',
      pattern: 'git * --stat',
    })
    expect(parseShellRule('printf \\*')).toEqual({
      type: 'exact',
      command: 'printf \\*',
    })
  })

  it('matches escaped stars and backslashes without treating question marks as wildcards', () => {
    expect(shellWildcardMatches('printf \\* *', 'printf * value')).toBe(true)
    expect(shellWildcardMatches('printf \\\\ *', 'printf \\ value')).toBe(true)
    expect(
      shellWildcardMatches('echo file?.txt *', 'echo file1.txt value'),
    ).toBe(false)
  })

  it('makes a sole trailing argument wildcard optional', () => {
    expect(shellWildcardMatches('git *', 'git')).toBe(true)
    expect(shellWildcardMatches('git *', 'git status --short')).toBe(true)
    expect(shellWildcardMatches('* run *', 'npm run')).toBe(false)
  })

  it('uses token boundaries for prefixes and case-insensitive PowerShell matching', () => {
    expect(shellRuleMatches(parseShellRule('npm test:*'), 'npm test')).toBe(
      true,
    )
    expect(shellRuleMatches(parseShellRule('npm test:*'), 'npm testing')).toBe(
      false,
    )
    expect(
      shellRuleMatches(
        parseShellRule('Get-ChildItem:*'),
        'get-childitem -Force',
        true,
      ),
    ).toBe(true)
  })
})
