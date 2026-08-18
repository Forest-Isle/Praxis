import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  claudeProjectPathPrefix,
  resolveClaudePaths,
  resolveClaudeScheduledTaskFile,
  sanitizeClaudeProjectPath,
} from './paths.js'

function claudeDjb2Hash(value: string): number {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0
  }
  return hash
}

describe('Claude project path compatibility', () => {
  it('uses Claude Code character replacement for ordinary paths', () => {
    expect(sanitizeClaudeProjectPath('/Users/alice/dev/Praxis')).toBe(
      '-Users-alice-dev-Praxis',
    )
    expect(sanitizeClaudeProjectPath('C:\\Users\\alice\\project')).toBe(
      'C--Users-alice-project',
    )
  })

  it('uses Claude Code 2.1.208 truncation and djb2 hash for long paths', () => {
    const cwd =
      '/private/tmp/praxis-claude-long-probe.ZwF0h0/' +
      [1, 2, 3, 4, 5, 6]
        .map(
          (index) => `segment-segment-segment-segment-segment-segment-${index}`,
        )
        .join('/')

    const pinned =
      '-private-tmp-praxis-claude-long-probe-ZwF0h0-segment-segment-segment-segment-segment-segment-1-segment-segment-segment-segment-segment-segment-2-segment-segment-segment-segment-segment-segment-3-segme-z3f6qv'
    expect(sanitizeClaudeProjectPath(cwd)).toBe(pinned)
    expect(sanitizeClaudeProjectPath(cwd)).toBe(
      `${claudeProjectPathPrefix(cwd)}${Math.abs(claudeDjb2Hash(cwd)).toString(36)}`,
    )
  })

  it('returns a truncated prefix only for long project paths', () => {
    expect(claudeProjectPathPrefix('/Users/alice/dev/Praxis')).toBeNull()
    expect(claudeProjectPathPrefix('C:\\Users\\alice\\project')).toBeNull()
    expect(
      claudeProjectPathPrefix(
        '/private/tmp/praxis-claude-long-probe.ZwF0h0/' +
          [1, 2, 3, 4, 5, 6]
            .map(
              (index) =>
                `segment-segment-segment-segment-segment-segment-${index}`,
            )
            .join('/'),
      ),
    ).toMatch(/^[a-zA-Z0-9-]{200}-$/)
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
    expect(resolveClaudeScheduledTaskFile('/tmp/project')).toBe(
      '/tmp/project/.claude/scheduled_tasks.json',
    )
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
