import { describe, expect, it } from 'vitest'

import {
  claudeBashPermissionRuleContent,
  claudeBashPermissionSuggestionContent,
} from './claude-shell-permission.js'

describe('Claude Bash permission suggestions', () => {
  it('suggests stable two-token prefixes for ordinary command families', () => {
    expect(claudeBashPermissionSuggestionContent('npm test -- --run')).toBe(
      'npm test:*',
    )
    expect(
      claudeBashPermissionSuggestionContent('NODE_ENV=test npm run build'),
    ).toBe('npm run:*')
  })

  it('never creates reusable prefixes for shells, wrappers, or unsafe env', () => {
    for (const command of [
      'bash -c "rm -rf build"',
      'sudo apt update',
      'env npm test',
      'CUSTOM_TARGET=x npm test',
    ]) {
      expect(claudeBashPermissionSuggestionContent(command)).toBe(command)
      expect(claudeBashPermissionRuleContent(command)).toBe(command)
    }
  })

  it('uses exact rules for structural shell syntax', () => {
    for (const command of [
      'npm test > output.log',
      'echo $(git status)',
      'cat <<EOF\nvalue\nEOF',
    ]) {
      expect(claudeBashPermissionSuggestionContent(command)).toBe(command)
    }
  })
})
