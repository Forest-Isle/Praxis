import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  detectTuiTerminal,
  nativeShiftEnterTerminalName,
  setupTuiTerminal,
  terminalSetupTuiSlashCommand,
} from './terminal-setup.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

async function root() {
  const value = await mkdtemp(join(tmpdir(), 'praxis-terminal-setup-'))
  roots.push(value)
  return value
}

describe('terminal detection and setup command catalog', () => {
  it('recognizes native CSI-u terminals and hides setup there', () => {
    expect(
      detectTuiTerminal({ TERM: 'xterm-ghostty', TERM_PROGRAM: undefined }),
    ).toBe('ghostty')
    expect(nativeShiftEnterTerminalName('iTerm.app')).toBe('iTerm2')
    expect(
      terminalSetupTuiSlashCommand({ TERM_PROGRAM: 'iTerm.app' }, 'darwin'),
    ).toBeNull()
  })

  it('offers the command with platform-specific Apple Terminal wording', () => {
    expect(
      terminalSetupTuiSlashCommand(
        { TERM_PROGRAM: 'Apple_Terminal' },
        'darwin',
      ),
    ).toEqual({
      name: 'terminal-setup',
      description:
        'Enable Option+Enter key binding for newlines and visual bell',
      source: 'builtin',
    })
  })
})

describe('VS Code-compatible terminal setup', () => {
  it('preserves JSONC, creates a backup, and is repeatable', async () => {
    const home = await root()
    const user = join(home, '.config', 'Code', 'User')
    const path = join(user, 'keybindings.json')
    await import('node:fs/promises').then(({ mkdir }) =>
      mkdir(user, { recursive: true }),
    )
    await writeFile(
      path,
      '[\n  // existing user bindings\n  {"key":"ctrl+k", "command":"workbench.action.files.openFile"},\n]\n',
    )
    const options = {
      homeDirectory: home,
      platform: 'linux' as const,
      environment: { TERM_PROGRAM: 'vscode' },
    }
    await expect(setupTuiTerminal(options)).resolves.toContain(
      'Installed VSCode terminal Shift+Enter key binding',
    )
    const result = await readFile(path, 'utf8')
    expect(result).toContain('// existing user bindings')
    expect(result).toContain('workbench.action.terminal.sendSequence')
    expect(result).toContain('shift+enter')
    expect(
      (await readdir(user)).filter((entry) => entry.endsWith('.bak')),
    ).toHaveLength(1)
    await expect(setupTuiTerminal(options)).resolves.toContain(
      'Found existing VSCode terminal Shift+Enter key binding',
    )
    expect(
      (await readdir(user)).filter((entry) => entry.endsWith('.bak')),
    ).toHaveLength(1)
  })

  it('does not mutate a remote VS Code session', async () => {
    const home = await root()
    const result = await setupTuiTerminal({
      homeDirectory: home,
      platform: 'linux',
      environment: {
        TERM_PROGRAM: 'vscode',
        VSCODE_GIT_ASKPASS_MAIN: '/remote/.vscode-server/extensions/git.js',
      },
    })
    expect(result).toContain(
      'Cannot install keybindings from a remote VSCode session',
    )
    await expect(readdir(home)).resolves.toEqual([])
  })
})

describe('Alacritty and Zed terminal setup', () => {
  it('adds an Alacritty binding and refuses duplicate installation', async () => {
    const home = await root()
    const path = join(home, '.config', 'alacritty', 'alacritty.toml')
    const options = {
      homeDirectory: home,
      platform: 'linux' as const,
      environment: { ALACRITTY_LOG: '/tmp/alacritty.log' },
    }
    await expect(setupTuiTerminal(options)).resolves.toContain(
      'Installed Alacritty Shift+Enter key binding',
    )
    expect(await readFile(path, 'utf8')).toContain('mods = "Shift"')
    await expect(setupTuiTerminal(options)).resolves.toContain(
      'Found existing Alacritty Shift+Enter key binding',
    )
  })

  it('adds a Zed terminal binding', async () => {
    const home = await root()
    const result = await setupTuiTerminal({
      homeDirectory: home,
      platform: 'linux',
      environment: { ZED_TERM: '1' },
    })
    expect(result).toContain('Installed Zed Shift+Enter key binding')
    expect(
      JSON.parse(
        await readFile(join(home, '.config', 'zed', 'keymap.json'), 'utf8'),
      ),
    ).toEqual([
      {
        context: 'Terminal',
        bindings: { 'shift-enter': ['terminal::SendText', '\u001b\r'] },
      },
    ])
  })
})

it('returns an actionable diagnostic for unsupported terminals', async () => {
  const result = await setupTuiTerminal({
    platform: 'linux',
    environment: { TERM_PROGRAM: 'tmux', TMUX: '/tmp/tmux.sock' },
  })
  expect(result).toContain('Terminal setup cannot be run from tmux')
  expect(result).toContain('backslash (\\) + return')
  expect(result).toContain('Alacritty')
})
