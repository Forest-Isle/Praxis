import { describe, expect, it } from 'vitest'

import { tmuxChildArgv } from './tmux-worktree.js'

describe('tmux worktree launcher', () => {
  it('removes tmux control and supplies a name for unnamed worktrees', () => {
    const result = tmuxChildArgv(
      ['--tmux', '--worktree', '--', 'inspect'],
      undefined,
    )
    expect(result.argv).toContain(`--worktree=${result.worktreeName}`)
    expect(result.argv).not.toContain('--tmux')
    expect(result.argv).toContain('inspect')
  })

  it('preserves explicit worktree names and classic mode', () => {
    expect(
      tmuxChildArgv(
        ['--worktree', 'review', '--tmux=classic', 'prompt'],
        'review',
      ),
    ).toEqual({
      argv: ['--worktree', 'review', 'prompt'],
      worktreeName: 'review',
    })
  })

  it('does not rewrite prompt values after the option terminator', () => {
    const result = tmuxChildArgv(
      ['--worktree', '--tmux', '--', '--tmux', 'prompt'],
      undefined,
    )
    expect(result.argv).toEqual([
      `--worktree=${result.worktreeName}`,
      '--',
      '--tmux',
      'prompt',
    ])
  })
})
