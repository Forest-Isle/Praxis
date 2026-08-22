import { describe, expect, it } from 'vitest'

import {
  parsePermissionUpdates,
  permissionRuleValueFromString,
  permissionRuleValueToString,
  shellInputIsReadOnly,
} from './permission-updates.js'

describe('Claude permission updates', () => {
  it('round-trips escaped permission rule content', () => {
    const rule = {
      toolName: 'Bash',
      ruleContent: 'python -c "print(1)" \\ fixture',
    }
    const serialized = permissionRuleValueToString(rule)
    expect(serialized).toBe('Bash(python -c "print\\(1\\)" \\\\ fixture)')
    expect(permissionRuleValueFromString(serialized)).toEqual(rule)
  })

  it('normalizes empty and wildcard content to tool-wide rules', () => {
    expect(permissionRuleValueFromString('Bash()')).toEqual({
      toolName: 'Bash',
    })
    expect(permissionRuleValueFromString('Bash(*)')).toEqual({
      toolName: 'Bash',
    })
    expect(
      permissionRuleValueToString(permissionRuleValueFromString('Bash(*)')),
    ).toBe('Bash')
  })

  it('accepts only 2.1.208 external modes in setMode updates', () => {
    for (const mode of [
      'acceptEdits',
      'bypassPermissions',
      'default',
      'dontAsk',
      'plan',
    ]) {
      expect(
        parsePermissionUpdates([
          { type: 'setMode', mode, destination: 'session' },
        ]),
      ).toHaveLength(1)
    }
    for (const mode of ['auto', 'manual', 'bubble']) {
      expect(
        parsePermissionUpdates([
          { type: 'setMode', mode, destination: 'session' },
        ]),
      ).toBeUndefined()
    }
  })

  it('classifies only parser-proven non-expanding shell reads as read-only', () => {
    expect(shellInputIsReadOnly('pwd')).toBe(true)
    expect(shellInputIsReadOnly('ls -la')).toBe(true)
    expect(shellInputIsReadOnly('pwd && ls')).toBe(true)
    for (const command of [
      'ls > files.txt',
      'ls $HOME',
      'ls $(pwd)',
      'ls *.ts',
      'ls &',
      "ls '",
      'rm file',
    ]) {
      expect(shellInputIsReadOnly(command), command).toBe(false)
    }
  })
})
