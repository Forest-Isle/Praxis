import { describe, expect, it } from 'vitest'

import {
  launchTmuxWorktree,
  tmuxChildArgv,
  type TmuxWorktreeDependencies,
} from './tmux-worktree.js'

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

  it('uses parameterized iTerm2 AppleScript and shell-quotes child arguments', async () => {
    const calls: {
      command: string
      args: readonly string[]
      inheritStdio: boolean
    }[] = []
    const dependencies: TmuxWorktreeDependencies = {
      platform: 'darwin',
      environment: { TERM_PROGRAM: 'iTerm.app' },
      run: async (command, args, options) => {
        calls.push({ command, args, inheritStdio: options.inheritStdio })
        return { stdout: 'w0t1p2:ABC\n' }
      },
    }
    await expect(
      launchTmuxWorktree(
        {
          argv: ['--worktree=review', '--tmux', '--', "say 'hello'; touch no"],
          cwd: '/repo',
          cliPath: '/app/praxis.js',
          worktreeName: 'review',
          mode: 'native',
          attach: true,
        },
        dependencies,
      ),
    ).resolves.toEqual({
      kind: 'iterm',
      sessionName: 'w0t1p2:ABC',
      worktreeName: 'review',
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.command).toBe('osascript')
    expect(calls[0]?.args[0]).toBe('-e')
    expect(calls[0]?.args[1]).not.toContain("say 'hello'")
    expect(calls[0]?.args[2]).toContain(`'"'"'`)
  })

  it('falls back to classic tmux outside iTerm and attaches only when requested', async () => {
    const calls: {
      command: string
      args: readonly string[]
      inherit: boolean
    }[] = []
    const dependencies: TmuxWorktreeDependencies = {
      platform: 'darwin',
      environment: { TERM_PROGRAM: 'Apple_Terminal' },
      run: async (command, args, options) => {
        calls.push({ command, args, inherit: options.inheritStdio })
        return { stdout: '' }
      },
    }
    const result = await launchTmuxWorktree(
      {
        argv: ['--worktree=review', '--tmux', 'inspect'],
        cwd: '/repo',
        cliPath: '/app/praxis.js',
        worktreeName: 'review',
        mode: 'native',
        attach: true,
      },
      dependencies,
    )
    expect(result.kind).toBe('tmux')
    expect(calls.map((call) => call.command)).toEqual(['tmux', 'tmux'])
    expect(calls[0]?.args.slice(0, 2)).toEqual(['new-session', '-d'])
    expect(calls[1]).toMatchObject({ inherit: true })
  })

  it('keeps classic mode on tmux even inside iTerm', async () => {
    const commands: string[] = []
    const dependencies: TmuxWorktreeDependencies = {
      platform: 'darwin',
      environment: { TERM_PROGRAM: 'iTerm.app' },
      run: async (command) => {
        commands.push(command)
        return { stdout: '' }
      },
    }
    await launchTmuxWorktree(
      {
        argv: ['--worktree=review', '--tmux=classic'],
        cwd: '/repo',
        cliPath: '/app/praxis.js',
        worktreeName: 'review',
        mode: 'classic',
        attach: false,
      },
      dependencies,
    )
    expect(commands).toEqual(['tmux'])
  })

  it('rejects unsafe iTerm metadata and child NUL bytes', async () => {
    const dependencies: TmuxWorktreeDependencies = {
      platform: 'darwin',
      environment: { TERM_PROGRAM: 'iTerm.app' },
      run: async () => ({ stdout: 'pane\ninjection\n' }),
    }
    const options = {
      argv: ['--worktree=review', '--tmux'],
      cwd: '/repo',
      cliPath: '/app/praxis.js',
      worktreeName: 'review',
      mode: 'native' as const,
      attach: false,
    }
    await expect(launchTmuxWorktree(options, dependencies)).rejects.toThrow(
      'invalid pane session ID',
    )
    await expect(
      launchTmuxWorktree(
        { ...options, argv: ['--worktree=review', '--tmux', '--', 'bad\0arg'] },
        dependencies,
      ),
    ).rejects.toThrow('must not contain NUL')
  })
})
