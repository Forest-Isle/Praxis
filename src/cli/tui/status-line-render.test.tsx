import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { Text } from 'ink'
import { cleanup, render } from 'ink-testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createClaudeStatusLineInput,
  useClaudeStatusLine,
  type UseClaudeStatusLineOptions,
} from './status-line.js'

afterEach(cleanup)

function HookProbe(props: UseClaudeStatusLineOptions) {
  const state = useClaudeStatusLine(props)
  return <Text>{`${state.padding}|${state.text ?? ''}`}</Text>
}

describe('useClaudeStatusLine', () => {
  it('publishes configured output and padding from the lifecycle hook', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-statusline-hook-'))
    const configRoot = join(root, 'config')
    const cwd = join(root, 'workspace')
    await Promise.all([mkdir(configRoot), mkdir(cwd)])
    await writeFile(
      join(configRoot, 'settings.json'),
      JSON.stringify({
        statusLine: {
          type: 'command',
          command: 'printf hook-output',
          padding: 3,
        },
      }),
    )
    const input = createClaudeStatusLineInput({
      configRoot,
      cwd,
      projectDir: cwd,
      sessionId: '11111111-1111-4111-8111-111111111111',
      version: '2.1.208',
      outputStyle: 'default',
      additionalDirectories: [],
    })
    const app = render(
      <HookProbe
        configRoot={configRoot}
        cwd={cwd}
        input={input}
        refreshKey="hook"
      />,
    )
    await vi.waitFor(() => expect(app.lastFrame()).toBe('3|hook-output'), {
      timeout: 3_000,
    })
  })

  it('renders configured output and hot reloads shared settings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-statusline-ui-'))
    const configRoot = join(root, 'config')
    const cwd = join(root, 'workspace')
    await Promise.all([mkdir(configRoot), mkdir(cwd)])
    const settingsPath = join(configRoot, 'settings.json')
    await writeFile(
      settingsPath,
      JSON.stringify({
        statusLine: { type: 'command', command: 'printf first', padding: 1 },
      }),
    )
    const input = createClaudeStatusLineInput({
      configRoot,
      cwd,
      projectDir: cwd,
      sessionId: '11111111-1111-4111-8111-111111111111',
      version: '2.1.208',
      outputStyle: 'default',
      additionalDirectories: [],
    })
    const app = render(
      <HookProbe
        configRoot={configRoot}
        cwd={cwd}
        input={input}
        refreshKey="initial"
      />,
    )
    await delay(450)
    expect(app.lastFrame()).toContain('first')

    await writeFile(
      settingsPath,
      JSON.stringify({
        statusLine: { type: 'command', command: 'printf second' },
      }),
    )
    await delay(900)
    expect(app.lastFrame()).toContain('second')
  })

  it('supplies a caller-provided TUI width to the configured command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-statusline-ui-'))
    const configRoot = join(root, 'config')
    const cwd = join(root, 'workspace')
    await Promise.all([mkdir(configRoot), mkdir(cwd)])
    await writeFile(
      join(configRoot, 'settings.json'),
      JSON.stringify({
        statusLine: {
          type: 'command',
          command:
            "node -e \"let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log('width:'+process.env.COLUMNS))\"",
        },
      }),
    )
    const input = createClaudeStatusLineInput({
      configRoot,
      cwd,
      projectDir: cwd,
      sessionId: '11111111-1111-4111-8111-111111111111',
      version: '2.1.208',
      outputStyle: 'default',
      additionalDirectories: [],
    })
    const app = render(
      <HookProbe
        configRoot={configRoot}
        cwd={cwd}
        input={input}
        refreshKey="width"
        width={40}
      />,
    )
    await vi.waitFor(() => expect(app.lastFrame()).toContain('width:40'), {
      timeout: 3_000,
    })
  })
})
