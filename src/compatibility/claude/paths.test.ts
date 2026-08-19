import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  discoverClaudeProjectRoot,
  resolveClaudePaths,
  resolveClaudeScheduledTaskFile,
  sanitizeClaudeProjectPath,
} from './paths.js'

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

function longClaudeCwd(): string {
  return (
    '/private/tmp/praxis-claude-long-probe.ZwF0h0/' +
    [1, 2, 3, 4, 5, 6]
      .map(
        (index) => `segment-segment-segment-segment-segment-segment-${index}`,
      )
      .join('/')
  )
}

describe('Claude long-path project root discovery', () => {
  it('returns the exact project directory when it exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-claude-exact-root-'))
    try {
      const configRoot = join(root, 'config')
      const cwd = '/Users/alice/dev/Praxis'
      const exactRoot = join(configRoot, 'projects', '-Users-alice-dev-Praxis')
      const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      await mkdir(exactRoot, { recursive: true })
      await writeFile(join(exactRoot, `${sessionId}.jsonl`), '{}\n')

      await expect(
        discoverClaudeProjectRoot({ configRoot, cwd }),
      ).resolves.toBe(exactRoot)
      await expect(
        discoverClaudeProjectRoot({ configRoot, cwd, sessionId }),
      ).resolves.toBe(exactRoot)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('finds an alternate-hash project directory for a long cwd', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-claude-discover-'))
    try {
      const configRoot = join(root, 'config')
      const cwd = longClaudeCwd()
      const sanitized = sanitizeClaudeProjectPath(cwd)
      expect(sanitized.length).toBeGreaterThan(200)
      const prefix = sanitized.slice(0, 200)
      const alternateRoot = join(
        configRoot,
        'projects',
        `${prefix}-alternate-hash`,
      )
      const sessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
      await mkdir(alternateRoot, { recursive: true })
      await writeFile(join(alternateRoot, `${sessionId}.jsonl`), '{}\n')

      await expect(
        discoverClaudeProjectRoot({ configRoot, cwd, sessionId }),
      ).resolves.toBe(alternateRoot)
      await expect(
        discoverClaudeProjectRoot({ configRoot, cwd }),
      ).resolves.toBe(alternateRoot)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('finds an alternate long-path project directory when the exact directory lacks the session file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-claude-exact-empty-'))
    try {
      const configRoot = join(root, 'config')
      const cwd = longClaudeCwd()
      const sanitized = sanitizeClaudeProjectPath(cwd)
      expect(sanitized.length).toBeGreaterThan(200)
      const prefix = sanitized.slice(0, 200)
      const exactRoot = join(configRoot, 'projects', sanitized)
      const alternateRoot = join(
        configRoot,
        'projects',
        `${prefix}-alternate-hash`,
      )
      const sessionId = '12121212-1212-4212-8212-121212121212'
      await mkdir(exactRoot, { recursive: true })
      await mkdir(alternateRoot, { recursive: true })
      await writeFile(join(alternateRoot, `${sessionId}.jsonl`), '{}\n')

      await expect(
        discoverClaudeProjectRoot({ configRoot, cwd, sessionId }),
      ).resolves.toBe(alternateRoot)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a long-path prefix with multiple candidate project directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-claude-ambiguous-'))
    try {
      const configRoot = join(root, 'config')
      const cwd = longClaudeCwd()
      const prefix = sanitizeClaudeProjectPath(cwd).slice(0, 200)
      const firstRoot = join(configRoot, 'projects', `${prefix}-first-hash`)
      const secondRoot = join(configRoot, 'projects', `${prefix}-second-hash`)
      const firstSessionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
      const secondSessionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
      await mkdir(firstRoot, { recursive: true })
      await mkdir(secondRoot, { recursive: true })
      await writeFile(join(firstRoot, `${firstSessionId}.jsonl`), '{}\n')
      await writeFile(join(secondRoot, `${secondSessionId}.jsonl`), '{}\n')

      await expect(
        discoverClaudeProjectRoot({ configRoot, cwd }),
      ).resolves.toBeUndefined()
      await expect(
        discoverClaudeProjectRoot({
          configRoot,
          cwd,
          sessionId: firstSessionId,
        }),
      ).resolves.toBe(firstRoot)

      const sharedSessionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
      await writeFile(join(secondRoot, `${sharedSessionId}.jsonl`), '{}\n')
      await writeFile(join(firstRoot, `${sharedSessionId}.jsonl`), '{}\n')
      await expect(
        discoverClaudeProjectRoot({
          configRoot,
          cwd,
          sessionId: sharedSessionId,
        }),
      ).resolves.toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not accept malformed transcript names as session evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-claude-malformed-'))
    try {
      const configRoot = join(root, 'config')
      const cwd = longClaudeCwd()
      const prefix = sanitizeClaudeProjectPath(cwd).slice(0, 200)
      const candidateRoot = join(
        configRoot,
        'projects',
        `${prefix}-malformed-only`,
      )
      await mkdir(candidateRoot, { recursive: true })
      await writeFile(join(candidateRoot, 'notes.jsonl'), '{}\n')
      await writeFile(join(candidateRoot, 'not-a-session-id.jsonl'), '{}\n')

      await expect(
        discoverClaudeProjectRoot({ configRoot, cwd }),
      ).resolves.toBeUndefined()
      const sessionId = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
      await expect(
        discoverClaudeProjectRoot({ configRoot, cwd, sessionId }),
      ).resolves.toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
