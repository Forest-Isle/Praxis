import { describe, expect, it, vi } from 'vitest'

import { detectInstalledClaudeVersion } from './claude-version.js'

describe('detectInstalledClaudeVersion', () => {
  it('uses the installed Claude CLI as the schema authority', async () => {
    const execute = vi.fn(async () => ({
      stdout: '2.1.208 (Claude Code)\n',
    }))

    await expect(detectInstalledClaudeVersion(execute)).resolves.toBe('2.1.208')
    expect(execute).toHaveBeenCalledWith('claude', ['--version'])
  })

  it('uses the pinned executable when one is configured', async () => {
    const execute = vi.fn(async () => ({
      stdout: '2.1.208 (Claude Code)\n',
    }))
    vi.stubEnv('PRAXIS_CLAUDE_BINARY', '/tmp/claude-2.1.208')

    await expect(detectInstalledClaudeVersion(execute)).resolves.toBe('2.1.208')
    expect(execute).toHaveBeenCalledWith('/tmp/claude-2.1.208', ['--version'])

    vi.unstubAllEnvs()
  })
})
