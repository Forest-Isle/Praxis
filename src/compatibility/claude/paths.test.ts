import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { resolveClaudePaths, sanitizeClaudeProjectPath } from './paths.js'

describe('Claude project path compatibility', () => {
  it('uses Claude Code character replacement for ordinary paths', () => {
    expect(sanitizeClaudeProjectPath('/Users/alice/dev/Praxis')).toBe(
      '-Users-alice-dev-Praxis',
    )
    expect(sanitizeClaudeProjectPath('C:\\Users\\alice\\project')).toBe(
      'C--Users-alice-project',
    )
  })

  it('uses Claude Code 2.1.208 truncation and hash for long paths', () => {
    const cwd =
      '/private/tmp/praxis-claude-long-probe.ZwF0h0/' +
      [1, 2, 3, 4, 5, 6]
        .map(
          (index) => `segment-segment-segment-segment-segment-segment-${index}`,
        )
        .join('/')

    expect(sanitizeClaudeProjectPath(cwd)).toBe(
      '-private-tmp-praxis-claude-long-probe-ZwF0h0-segment-segment-segment-segment-segment-segment-1-segment-segment-segment-segment-segment-segment-2-segment-segment-segment-segment-segment-segment-3-segme-z3f6qv',
    )
  })

  it('resolves shared and Praxis-owned locations from CLAUDE_CONFIG_DIR', () => {
    const paths = resolveClaudePaths({
      configDir: '/tmp/claude-config',
      cwd: '/Users/alice/dev/Praxis',
      sessionId: 'bbd2f513-d9b7-4202-a632-32d33205b492',
    })

    expect(paths.configRoot).toBe('/tmp/claude-config')
    expect(paths.projectRoot).toBe(
      '/tmp/claude-config/projects/-Users-alice-dev-Praxis',
    )
    expect(paths.sessionFile).toBe(
      '/tmp/claude-config/projects/-Users-alice-dev-Praxis/bbd2f513-d9b7-4202-a632-32d33205b492.jsonl',
    )
    expect(paths.taskRoot).toBe(
      '/tmp/claude-config/tasks/bbd2f513-d9b7-4202-a632-32d33205b492',
    )
    expect(paths.praxisRoot).toBe(join('/tmp/claude-config', 'praxis'))
  })

  it('rejects session identifiers that could escape the project directory', () => {
    expect(() =>
      resolveClaudePaths({
        configDir: '/tmp/claude-config',
        cwd: '/tmp/project',
        sessionId: '../settings',
      }),
    ).toThrow('Invalid Claude session ID')
  })
})
