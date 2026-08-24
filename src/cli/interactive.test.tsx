import { Console as NodeConsole } from 'node:console'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { setTimeout as delay } from 'node:timers/promises'

import { cleanup, render } from 'ink-testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  AGENT_COLORS,
  type AgentColorSelection,
} from '../compatibility/claude/agent-color.js'
import type {
  ModelToolCall,
  PermissionApproval,
  RuntimeEventSink,
} from '../core/runtime.js'
import type { ClaudePlanApprovalResult } from '../tools/claude-interactive-tools.js'
import {
  advanceInteractiveHistoryState,
  InteractiveApp,
  type InteractiveServiceFactory,
  runInteractive,
} from './interactive.js'
import type { ClaudePermissionMode } from '../permissions/claude-permission-resolver.js'
import { projectTuiHooks } from './tui/hook-settings.js'
import type { TuiCustomTheme } from './tui/custom-themes.js'
import type { TuiDiffSnapshot } from './tui/git-diff.js'
import type { TuiThemeSettings } from './tui/theme.js'
import { projectRuntimeSettings } from './tui/runtime-settings.js'
import type { TuiSandboxSnapshot } from './tui/sandbox-settings.js'
import type { ClaudeSessionCostSnapshot } from '../application/session-cost-tracker.js'
import type {
  DoctorProgressListener,
  DoctorReport,
} from '../maintenance/doctor.js'

afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
})

const flush = async () => {
  await setImmediate()
  await setImmediate()
}

it('advances append mutation facts without reading the retained prefix', () => {
  const retained = Array.from({ length: 10_000 }, (_, index) => ({
    kind: 'notice' as const,
    text: `retained-${index}`,
  }))
  const next = [...retained, { kind: 'assistant' as const, text: 'appended' }]
  const guarded = new Proxy(retained, {
    get(source, property, receiver) {
      if (/^\d+$/u.test(String(property)))
        throw new Error(`retained prefix index ${String(property)} was read`)
      return Reflect.get(source, property, receiver)
    },
  })
  const advanced = advanceInteractiveHistoryState(
    {
      items: guarded,
      change: { revision: 7, changedFrom: 0 },
    },
    next,
    retained.length,
  )

  expect(advanced.items).toBe(next)
  expect(advanced.change).toMatchObject({
    revision: 8,
    changedFrom: retained.length,
  })
  expect(() =>
    advanceInteractiveHistoryState(
      { items: retained, change: advanced.change },
      next,
      next.length + 1,
    ),
  ).toThrow(RangeError)
})

function expectNoColorSgr(frame: string): void {
  const sgr = new RegExp(String.raw`\u001b\[([0-9;]*)m`, 'gu')
  for (const match of frame.matchAll(sgr)) {
    const parameters =
      (match[1] ?? '') === '' ? [0] : (match[1] ?? '').split(';').map(Number)
    expect(
      parameters.some(
        (parameter) =>
          (parameter >= 30 && parameter <= 37) ||
          (parameter >= 40 && parameter <= 47) ||
          (parameter >= 90 && parameter <= 97) ||
          (parameter >= 100 && parameter <= 107) ||
          parameter === 38 ||
          parameter === 48,
      ),
    ).toBe(false)
  }
}

async function waitFor<T>(read: () => T | undefined): Promise<T> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const value = read()
    if (value !== undefined) return value
    await delay(25)
    await flush()
  }
  throw new Error('Timed out waiting for test condition')
}

describe('InteractiveApp', () => {
  it('uses the explicitly selected native root when the environment selects Claude', async () => {
    const container = await mkdtemp(join(tmpdir(), 'praxis-interactive-plane-'))
    const configRoot = join(container, 'praxis')
    const cwd = join(container, 'project')
    await Promise.all([
      mkdir(configRoot, { recursive: true }),
      mkdir(join(cwd, '.praxis'), { recursive: true }),
    ])
    await writeFile(
      join(cwd, '.praxis', 'settings.local.json'),
      JSON.stringify({ permissions: { allow: ['Read(./native/**)'] } }),
    )
    vi.stubEnv('PRAXIS_DATA_PLANE', 'claude')

    try {
      const app = render(
        <InteractiveApp
          dataPlane="native"
          configRoot={configRoot}
          statePath={join(configRoot, 'state.json')}
          factory={{
            async createService() {
              throw new Error('unused')
            },
          }}
          initialSessions={[]}
          display={{ version: 'test', cwd }}
        />,
      )

      app.stdin.write('/permissions')
      app.stdin.write('\r')
      await waitFor(() =>
        app.lastFrame()?.includes('Read(./native/**)') ? true : undefined,
      )
    } finally {
      await rm(container, { recursive: true, force: true })
    }
  })

  it('keeps the welcome panel visible alongside startup diagnostics', () => {
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            throw new Error('unused')
          },
        }}
        initialSessions={[]}
        initialHistory={[
          { kind: 'local-result', text: 'Using flicker-free rendering' },
          {
            kind: 'warning',
            text: 'MCP server codex unavailable: connection closed',
          },
        ]}
        display={{ version: '0.20.20', cwd: '/Users/test/dev-tools' }}
      />,
    )

    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('Using flicker-free rendering')
    expect(frame).toContain('MCP server codex unavailable')
    expect(frame).toContain('Welcome to Praxis')
    app.unmount()
  })

  it('shows compact identity above a started conversation and none on resume', () => {
    const fresh = render(
      <InteractiveApp
        factory={{
          async createService() {
            throw new Error('unused')
          },
        }}
        initialSessions={[]}
        initialHistory={[{ kind: 'user', text: 'review the diff' }]}
        display={{ version: '0.20.20', cwd: '/Users/test/dev-tools' }}
      />,
    )
    const freshFrame = fresh.lastFrame() ?? ''
    expect(freshFrame).toContain('Praxis Code v0.20.20')
    expect(freshFrame).toContain('provider default')
    expect(freshFrame).toContain('dev-tools')
    expect(freshFrame).toContain('review the diff')
    expect(freshFrame).not.toContain('Welcome to Praxis')
    fresh.unmount()

    const resumed = render(
      <InteractiveApp
        factory={{
          async createService() {
            throw new Error('unused')
          },
        }}
        initialSessions={[]}
        initialHistory={[{ kind: 'user', text: 'continue the work' }]}
        resume={{ sessionId: 'active-session' }}
        display={{ version: '0.20.20', cwd: '/Users/test/dev-tools' }}
      />,
    )
    const resumedFrame = resumed.lastFrame() ?? ''
    expect(resumedFrame).toContain('continue the work')
    expect(resumedFrame).not.toContain('Praxis Code v')
    expect(resumedFrame).not.toContain('Welcome to Praxis')
    resumed.unmount()
  })

  it('keeps the full welcome panel for an empty session with a supplied session id', () => {
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            throw new Error('unused')
          },
        }}
        initialSessions={[]}
        resume={{ sessionId: 'empty-session' }}
        display={{ version: '0.20.20', cwd: '/Users/test/dev-tools' }}
      />,
    )
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('Welcome to Praxis')
    expect(frame).toContain('Praxis Code v0.20.20')
    expect(frame).not.toContain('review the diff')
    app.unmount()
  })

  it('keeps the full welcome panel when only operational transcript entries exist', () => {
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            throw new Error('unused')
          },
        }}
        initialSessions={[]}
        initialHistory={[
          { kind: 'thinking', text: 'operational reasoning' },
          {
            kind: 'tool',
            call: { id: 'call-1', name: 'Read', input: { file_path: 'a.ts' } },
            detail: 'a.ts',
          },
          { kind: 'shell', callId: 'shell-1', command: 'npm test' },
        ]}
        display={{ version: '0.20.20', cwd: '/Users/test/dev-tools' }}
      />,
    )
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('operational reasoning')
    expect(frame).toContain('npm test')
    expect(frame).toContain('Welcome to Praxis')
    app.unmount()
  })

  it('renders fresh and resumed sessions through the TUI projection with a complete shell', () => {
    const fresh = render(
      <InteractiveApp
        factory={{
          async createService() {
            throw new Error('unused')
          },
        }}
        initialSessions={[]}
        display={{ version: '0.20.20', cwd: '/Users/test/dev-tools' }}
      />,
    )
    const freshFrame = fresh.lastFrame() ?? ''
    // A fresh session renders the full welcome shell with the composer.
    expect(freshFrame).toContain('Welcome to Praxis')
    expect(freshFrame).toContain('⏵⏵')
    fresh.unmount()

    const resumed = render(
      <InteractiveApp
        factory={{
          async createService() {
            throw new Error('unused')
          },
        }}
        initialSessions={[]}
        initialHistory={[
          { kind: 'user', text: 'first prompt' },
          { kind: 'assistant', text: 'first reply' },
          { kind: 'user', text: 'resumed prompt' },
        ]}
        resume={{ sessionId: 'session-1' }}
        display={{ version: '0.20.20', cwd: '/Users/test/dev-tools' }}
      />,
    )
    const resumedFrame = resumed.lastFrame() ?? ''
    // A resumed session keeps the loaded transcript order through the
    // projection and never renders a fresh-session welcome identity, but still
    // renders the composer shell.
    expect(resumedFrame).not.toContain('Welcome to Praxis')
    expect(resumedFrame).not.toContain('Praxis Code v')
    expect(resumedFrame.indexOf('first prompt')).toBeLessThan(
      resumedFrame.indexOf('first reply'),
    )
    expect(resumedFrame.indexOf('first reply')).toBeLessThan(
      resumedFrame.indexOf('resumed prompt'),
    )
    expect(resumedFrame).toContain('⏵⏵')
    resumed.unmount()
  })

  it('lets the projected session-picker body replace transcript and composer', () => {
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            throw new Error('unused')
          },
        }}
        initialSessions={[
          {
            sessionId: 'session-1',
            lastPrompt: 'pick this session',
            updatedAt: '2026-08-24T00:00:00.000Z',
            status: 'ready',
            issue: null,
          },
        ]}
        initialHistory={[{ kind: 'user', text: 'hidden transcript marker' }]}
        resume={{ requireSession: true }}
      />,
    )

    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('pick this session')
    expect(frame).not.toContain('hidden transcript marker')
    expect(frame).not.toContain('Welcome to Praxis')
    expect(frame).not.toContain('⏵⏵')
    app.unmount()
  })

  it('keeps screen-reader transcripts semantic and full under a fullscreen configuration', () => {
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            throw new Error('unused')
          },
        }}
        initialSessions={[]}
        axScreenReader
        runtimeSettings={{
          ...projectRuntimeSettings({ settings: {}, state: {} }),
          tui: 'fullscreen',
        }}
        initialHistory={[
          { kind: 'user', text: 'prompt one' },
          { kind: 'assistant', text: 'answer one' },
        ]}
        display={{ version: '0.20.20', cwd: '/Users/test/dev-tools' }}
      />,
    )
    const frame = app.lastFrame() ?? ''
    // Screen-reader output stays semantic, full, and free of decorative
    // welcome/identity chrome even when the configured renderer is fullscreen.
    expect(frame).toContain('You: ')
    expect(frame).toContain('Praxis:')
    expect(frame).toContain('prompt one')
    expect(frame).toContain('answer one')
    expect(frame).not.toContain('Welcome to Praxis')
    expect(frame).not.toContain('Praxis Code v')
    app.unmount()
  })

  it('propagates screen-reader mode through the semantic theme provider', () => {
    if (process.env.PRAXIS_AX_SCREEN_READER_CHILD === '1') {
      const app = render(
        <InteractiveApp
          factory={{
            async createService() {
              throw new Error('unused')
            },
          }}
          initialSessions={[]}
          axScreenReader
          initialHistory={[
            { kind: 'user', text: 'screen reader prompt' },
            { kind: 'assistant', text: 'screen reader answer' },
          ]}
          display={{ version: '0.20.20', cwd: '/Users/test/dev-tools' }}
        />,
      )
      const frame = app.lastFrame() ?? ''
      expect(frame).toContain('screen reader prompt')
      expect(frame).toContain('screen reader answer')
      expectNoColorSgr(frame)
      app.unmount()
      return
    }

    const childEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      FORCE_COLOR: '3',
      PRAXIS_AX_SCREEN_READER_CHILD: '1',
    }
    delete childEnvironment.NO_COLOR
    const child = spawnSync(
      process.execPath,
      [
        resolve('node_modules/vitest/vitest.mjs'),
        'run',
        'src/cli/interactive.test.tsx',
        '-t',
        'propagates screen-reader mode through the semantic theme provider',
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: childEnvironment,
      },
    )
    expect(child.status, `${child.stdout}\n${child.stderr}`).toBe(0)
  })

  it('configures sandbox mode, overrides, and config through /sandbox', async () => {
    let snapshot: TuiSandboxSnapshot = {
      settings: {
        enabled: false,
        failIfUnavailable: false,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: true,
        excludedCommands: ['docker:*'],
        runtimeConfig: {
          network: {
            allowedDomains: ['api.example.com'],
            deniedDomains: ['blocked.example.com'],
          },
          filesystem: {
            allowWrite: ['.'],
            denyWrite: ['.claude/settings.local.json'],
            denyRead: ['/secrets'],
            allowRead: [],
          },
        },
      },
      dependencies: { errors: [], warnings: [] },
      supported: true,
      platform: 'macos',
    }
    const modes: string[] = []
    const overrides: boolean[] = []
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            throw new Error('unused')
          },
        }}
        initialSessions={[]}
        sandboxStore={{
          async load() {
            return snapshot
          },
          async setMode(mode) {
            modes.push(mode)
            snapshot = {
              ...snapshot,
              settings: {
                ...snapshot.settings,
                enabled: mode !== 'disabled',
                autoAllowBashIfSandboxed: mode === 'auto-allow',
              },
            }
            return snapshot
          },
          async setAllowUnsandboxedCommands(allow) {
            overrides.push(allow)
            snapshot = {
              ...snapshot,
              settings: {
                ...snapshot.settings,
                allowUnsandboxedCommands: allow,
              },
            }
            return snapshot
          },
          async exclude() {
            throw new Error('unused')
          },
        }}
      />,
    )

    app.stdin.write('/sandbox')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('Sandbox:')
    expect(app.lastFrame()).toContain('Sandbox BashTool, with auto-allow')
    expect(app.lastFrame()).toContain('No Sandbox (current)')

    app.stdin.write('\r')
    await flush()
    expect(modes).toEqual(['auto-allow'])
    expect(app.lastFrame()).toContain('auto-allow (current)')

    app.stdin.write('\u001B[C')
    await flush()
    expect(app.lastFrame()).toContain('Allow unsandboxed fallback')
    app.stdin.write('\u001B[B')
    app.stdin.write('\r')
    await flush()
    expect(overrides).toEqual([false])
    expect(app.lastFrame()).toContain('Strict sandbox mode (current)')

    app.stdin.write('\u001B[C')
    await flush()
    expect(app.lastFrame()).toContain('Excluded Commands:')
    expect(app.lastFrame()).toContain('docker:*')
    expect(app.lastFrame()).toContain('api.example.com')
    expect(app.lastFrame()).toContain('blocked.example.com')
  })

  it('persists /sandbox exclude without opening the panel', async () => {
    const exclude = vi.fn(async (pattern: string) => ({
      pattern: pattern.replaceAll('"', ''),
      settingsPath: '.claude/settings.local.json',
      snapshot: {} as TuiSandboxSnapshot,
    }))
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            throw new Error('unused')
          },
        }}
        initialSessions={[]}
        sandboxStore={{
          async load() {
            throw new Error('unused')
          },
          async setMode() {
            throw new Error('unused')
          },
          async setAllowUnsandboxedCommands() {
            throw new Error('unused')
          },
          exclude,
        }}
      />,
    )

    app.stdin.write('/sandbox exclude "npm run test:*"')
    app.stdin.write('\r')
    await flush()
    expect(exclude).toHaveBeenCalledWith('"npm run test:*"')
    expect(app.lastFrame()).toContain(
      'Added "npm run test:*" to excluded commands in .claude/settings.local.json',
    )
  })

  it('creates, selects, edits, resets, and deletes a custom theme from /theme', async () => {
    const customThemes: TuiCustomTheme[] = []
    let settings: TuiThemeSettings = {
      theme: 'auto' as const,
      syntaxHighlightingDisabled: false,
    }
    const saved: unknown[] = []
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            throw new Error('unused')
          },
        }}
        initialSessions={[]}
        initialThemeSettings={settings}
        themeStore={{
          async load() {
            return settings
          },
          async save(update) {
            saved.push(update)
            settings = {
              ...settings,
              ...update,
            }
            return settings
          },
          async loadCustomThemes() {
            return [...customThemes]
          },
          async createCustomTheme(input) {
            const theme = {
              name: input.name,
              slug: input.name.toLowerCase().replace(/\s+/gu, '-'),
              base: input.base,
              overrides: {},
            }
            customThemes.push(theme)
            return theme
          },
          async updateCustomTheme(theme, token, value) {
            const next = {
              ...theme,
              overrides: {
                ...theme.overrides,
                ...(value === undefined ? {} : { [token]: value }),
              },
            }
            if (value === undefined) delete next.overrides[token]
            const index = customThemes.findIndex(
              (entry) => entry.slug === theme.slug,
            )
            customThemes[index] = next
            return next
          },
          async deleteCustomTheme(theme) {
            const index = customThemes.findIndex(
              (entry) => entry.slug === theme.slug,
            )
            customThemes.splice(index, 1)
          },
        }}
      />,
    )

    app.stdin.write('/theme')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('New custom theme…')
    for (let index = 0; index < 7; index += 1) app.stdin.write('\u001B[B')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('New custom theme')

    app.stdin.write('Ocean')
    app.stdin.write('\r')
    await flush()
    expect(settings.theme).toBe('custom:ocean')
    expect(app.lastFrame()).toContain('Using custom theme "Ocean"')

    app.stdin.write('/theme')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('Ocean (custom) ✔')
    app.stdin.write('\u0005')
    await flush()
    expect(app.lastFrame()).toContain('Filter color tokens')
    app.stdin.write('\r')
    await flush()
    app.stdin.write('#00aaff')
    app.stdin.write('\r')
    await flush()
    expect(customThemes[0]?.overrides).toEqual({ autoAccept: '#00aaff' })
    app.stdin.write('\u0009')
    await flush()
    expect(customThemes[0]?.overrides).toEqual({})
    app.stdin.write('\u0004')
    await flush()
    expect(app.lastFrame()).toContain('Delete Ocean permanently?')
    app.stdin.write('\r')
    app.stdin.write('\r')
    await flush()
    expect(customThemes).toEqual([])
    expect(saved.at(-1)).toEqual({ theme: 'dark' })
  })

  it('loads and persists a shared presentation theme without a model turn', async () => {
    const saved: unknown[] = []
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            throw new Error('unused')
          },
        }}
        initialSessions={[]}
        initialThemeSettings={{
          theme: 'dark',
          syntaxHighlightingDisabled: false,
        }}
        themeStore={{
          async load() {
            throw new Error('unused')
          },
          async save(update) {
            saved.push(update)
            return {
              theme: update.theme ?? 'dark',
              syntaxHighlightingDisabled:
                update.syntaxHighlightingDisabled ?? false,
            }
          },
        }}
      />,
    )

    app.stdin.write('/theme')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('Choose the text style')
    expect(app.lastFrame()).toContain('2. Dark mode ✔')

    app.stdin.write('3')
    await flush()
    app.stdin.write('\r')
    await flush()
    expect(saved).toEqual([{ theme: 'light' }])
    expect(app.lastFrame()).toContain('Theme set to light')
    expect(app.lastFrame()).toContain('? for shortcuts')

    app.stdin.write('/theme')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('3. Light mode ✔')
    expect(app.lastFrame()).toContain('Syntax theme: GitHub')
  })

  it('runs /terminal-setup as a local command without creating a model turn', async () => {
    const calls: string[] = []
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            calls.push('service')
            throw new Error('terminal setup must not require a provider')
          },
        }}
        initialSessions={[]}
        terminalSetup={async () => 'Installed terminal Shift+Enter key binding'}
      />,
    )

    app.stdin.write('/terminal-setup')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain(
      'Installed terminal Shift+Enter key binding',
    )
    expect(calls).toEqual([])
  })

  it('toggles the shared editor mode with /vim without creating a model turn', async () => {
    const configRoot = await mkdtemp(join(tmpdir(), 'praxis-vim-settings-'))
    const calls: string[] = []
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            calls.push('service')
            throw new Error('vim must not require a provider')
          },
        }}
        initialSessions={[]}
        runtimeSettingsTarget={configRoot}
      />,
    )

    app.stdin.write('/vim')
    app.stdin.write('\r')
    await waitFor(() =>
      app.lastFrame()?.includes('Editor mode set to vim.') ? true : undefined,
    )
    expect(
      JSON.parse(await readFile(join(configRoot, 'settings.json'), 'utf8')),
    ).toMatchObject({ editorMode: 'vim' })

    app.stdin.write('/vim')
    app.stdin.write('\r')
    await waitFor(() =>
      app.lastFrame()?.includes('Editor mode set to normal.')
        ? true
        : undefined,
    )
    expect(
      JSON.parse(await readFile(join(configRoot, 'settings.json'), 'utf8')),
    ).toMatchObject({ editorMode: 'normal' })
    expect(calls).toEqual([])
    await rm(configRoot, { recursive: true, force: true })
  })

  it('opens the agents menu before Vim normal mode consumes empty-composer Left Arrow', async () => {
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            throw new Error('unused')
          },
        }}
        initialSessions={[]}
        agents={[
          {
            name: 'reviewer',
            description: 'Reviews code for subtle regressions.',
          },
        ]}
        runtimeSettings={projectRuntimeSettings({
          settings: { editorMode: 'vim' },
          state: { leftArrowOpensAgents: true },
        })}
      />,
    )

    app.stdin.write('\u001B')
    await flush()
    app.stdin.write('\u001B[D')
    await flush()

    expect(app.lastFrame()).toContain('Agents')
    expect(app.lastFrame()).toContain('reviewer')
  })

  it('keeps hidden /output-style compatibility local and out of the palette', async () => {
    const calls: string[] = []
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            calls.push('service')
            throw new Error('output-style must not require a provider')
          },
        }}
        initialSessions={[]}
      />,
    )

    app.stdin.write('/output-style')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('/output-style has been deprecated.')
    expect(calls).toEqual([])
  })

  it('shows the removed /agents guidance locally without creating a provider', async () => {
    const calls: string[] = []
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            calls.push('service')
            throw new Error('agents must not require a provider')
          },
        }}
        initialSessions={[]}
      />,
    )

    app.stdin.write('/agents')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('/agents')
    expect(app.lastFrame()).toContain('The /agents wizard has been removed.')
    expect(app.lastFrame()).toContain('.praxis/agents/')
    expect(app.lastFrame()).toContain('~/.praxis/agents/')
    expect(app.lastFrame()).not.toContain('code.claude.com')
    expect(calls).toEqual([])
  })

  it('renders /cost as a local-result cost summary from the active session and zeroes without a session', async () => {
    const creations: Array<{ requireProvider: boolean; cwd?: string }> = []
    let closes = 0
    const runCalls: string[] = []
    const resumeCalls: string[] = []
    const factory: InteractiveServiceFactory = {
      async createService(options) {
        creations.push({
          requireProvider: options.requireProvider,
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        })
        return {
          async run() {
            runCalls.push('run')
            throw new Error('unused')
          },
          async resume() {
            resumeCalls.push('resume')
            throw new Error('unused')
          },
          async fork() {
            throw new Error('unused')
          },
          async sessions() {
            return []
          },
          async costSnapshot(sessionId) {
            return {
              sessionId,
              totalCostUsd: 2.5,
              apiDurationMs: 1_234_567,
              apiDurationWithoutRetriesMs: 1_000_000,
              toolDurationMs: 200_000,
              wallDurationMs: 3_600_000,
              linesAdded: 12,
              linesRemoved: 3,
              hasUnknownModelCost: false,
              modelUsage: {
                'claude-sonnet-4-20250514': {
                  inputTokens: 1500,
                  outputTokens: 300,
                  cacheReadInputTokens: 100,
                  cacheCreationInputTokens: 50,
                  webSearchRequests: 0,
                  costUsd: 2.5,
                },
              },
            }
          },
          async close() {
            closes += 1
          },
        }
      },
    }
    const app = render(
      <InteractiveApp
        factory={factory}
        initialSessions={[
          {
            sessionId: 'active-session',
            lastPrompt: 'hello',
            updatedAt: '2026-01-01T00:00:00.000Z',
            status: 'ready',
            issue: null,
          },
        ]}
        resume={{ sessionId: 'active-session' }}
        display={{ version: 'test', cwd: '/fixture/workspace' }}
      />,
    )

    app.stdin.write('/cost')
    app.stdin.write('\r')
    await waitFor(() =>
      app.lastFrame()?.includes('Total cost:            $2.50')
        ? true
        : undefined,
    )
    const frame = app.lastFrame()
    expect(frame).toContain('⎿ Total cost:            $2.50')
    expect(frame).toContain('Total duration (API):  20m 35s')
    expect(frame).toContain('Total duration (wall): 1h 0m 0s')
    expect(frame).toContain(
      'Total code changes:    12 lines added, 3 lines removed',
    )
    expect(frame).toContain(
      'claude-sonnet-4-0:  1.5k input, 300 output, 100 cache read, 50 cache write ($2.50)',
    )
    expect(frame).toContain('Usage by model:')
    expect(frame?.match(/⎿/gu)?.length).toBe(1)
    expect(frame).not.toContain('Settings')
    expect(frame).not.toContain('Status  Config  Usage')
    expect(frame).not.toContain('Esc to cancel')
    expect(creations).toEqual([
      { requireProvider: false, cwd: '/fixture/workspace' },
    ])
    expect(runCalls).toEqual([])
    expect(resumeCalls).toEqual([])
    expect(closes).toBe(1)
    app.unmount()

    const noSessionCalls: string[] = []
    const noSessionApp = render(
      <InteractiveApp
        factory={{
          async createService() {
            noSessionCalls.push('service')
            throw new Error('cost without a session must not create a service')
          },
        }}
        initialSessions={[]}
        display={{ version: 'test', cwd: '/fixture/workspace' }}
      />,
    )
    noSessionApp.stdin.write('/cost')
    noSessionApp.stdin.write('\r')
    await waitFor(() =>
      noSessionApp
        .lastFrame()
        ?.includes(
          'Usage:                 0 input, 0 output, 0 cache read, 0 cache write',
        )
        ? true
        : undefined,
    )
    expect(noSessionApp.lastFrame()).toContain(
      '⎿ Total cost:            $0.0000',
    )
    expect(noSessionApp.lastFrame()).toContain('Total duration (API):  0s')
    expect(noSessionApp.lastFrame()).toContain('Total duration (wall): 0s')
    expect(noSessionApp.lastFrame()).toContain(
      'Total code changes:    0 lines added, 0 lines removed',
    )
    expect(noSessionApp.lastFrame()).toContain(
      'Usage:                 0 input, 0 output, 0 cache read, 0 cache write',
    )
    expect(noSessionApp.lastFrame()).not.toContain('Settings')
    expect(noSessionApp.lastFrame()).not.toContain('Status  Config  Usage')
    expect(noSessionApp.lastFrame()).not.toContain('Esc to cancel')
    expect(noSessionCalls).toEqual([])
    noSessionApp.unmount()
  })

  it('warns on a failed active-session cost snapshot, closes the local service, and clears the turn without opening Settings', async () => {
    const creations: Array<{ requireProvider: boolean }> = []
    let closes = 0
    const runCalls: string[] = []
    const resumeCalls: string[] = []
    const forkCalls: string[] = []
    const turns: Array<Promise<void> | null> = []
    const factory: InteractiveServiceFactory = {
      async createService(options) {
        creations.push({ requireProvider: options.requireProvider })
        return {
          async run() {
            runCalls.push('run')
            throw new Error('unused')
          },
          async resume() {
            resumeCalls.push('resume')
            throw new Error('unused')
          },
          async fork() {
            forkCalls.push('fork')
            throw new Error('unused')
          },
          async sessions() {
            return []
          },
          async costSnapshot() {
            throw new Error('cost snapshot failed')
          },
          async close() {
            closes += 1
          },
        }
      },
    }
    const app = render(
      <InteractiveApp
        factory={factory}
        initialSessions={[
          {
            sessionId: 'active-session',
            lastPrompt: 'hello',
            updatedAt: '2026-01-01T00:00:00.000Z',
            status: 'ready',
            issue: null,
          },
        ]}
        resume={{ sessionId: 'active-session' }}
        display={{ version: 'test', cwd: '/fixture/workspace' }}
        onTurnChange={(turn) => {
          turns.push(turn)
        }}
      />,
    )

    app.stdin.write('/cost')
    app.stdin.write('\r')
    await waitFor(() =>
      app.lastFrame()?.includes('cost snapshot failed') ? true : undefined,
    )
    await flush()
    expect(app.lastFrame()).toContain('cost snapshot failed')
    expect(app.lastFrame()).not.toContain('Settings')
    expect(app.lastFrame()).not.toContain('Status  Config  Usage')
    expect(app.lastFrame()).not.toContain('Esc to cancel')
    expect(creations).toEqual([{ requireProvider: false }])
    expect(closes).toBe(1)
    expect(runCalls).toEqual([])
    expect(resumeCalls).toEqual([])
    expect(forkCalls).toEqual([])
    expect(turns.at(-1)).toBeNull()
    app.unmount()
  })

  it('navigates Settings to Usage with the current session snapshot and drops stale delayed results', async () => {
    const deferreds: Array<{
      resolve: (value: ClaudeSessionCostSnapshot) => void
      reject: (reason: Error) => void
    }> = []
    const costRequests: string[] = []
    const creations: Array<{ requireProvider: boolean }> = []
    const runCalls: string[] = []
    const resumeCalls: string[] = []
    const turns: Array<Promise<void> | null> = []
    const factory: InteractiveServiceFactory = {
      async createService(options) {
        creations.push({ requireProvider: options.requireProvider })
        return {
          async run() {
            runCalls.push('run')
            throw new Error('unused')
          },
          async resume() {
            resumeCalls.push('resume')
            throw new Error('unused')
          },
          async fork() {
            throw new Error('unused')
          },
          async sessions() {
            return []
          },
          async costSnapshot(sessionId) {
            costRequests.push(sessionId)
            let resolve!: (value: ClaudeSessionCostSnapshot) => void
            let reject!: (reason: Error) => void
            const promise = new Promise<ClaudeSessionCostSnapshot>(
              (res, rej) => {
                resolve = res
                reject = rej
              },
            )
            deferreds.push({ resolve, reject })
            return promise
          },
          async close() {},
        }
      },
    }
    const app = render(
      <InteractiveApp
        factory={factory}
        initialSessions={[
          {
            sessionId: 'active-session',
            lastPrompt: 'hello',
            updatedAt: '2026-01-01T00:00:00.000Z',
            status: 'ready',
            issue: null,
          },
        ]}
        resume={{ sessionId: 'active-session' }}
        display={{ version: 'test', cwd: '/fixture/workspace' }}
        onTurnChange={(turn) => {
          turns.push(turn)
        }}
      />,
    )
    const snapshot = (totalCostUsd: number): ClaudeSessionCostSnapshot => ({
      sessionId: 'active-session',
      totalCostUsd,
      apiDurationMs: 0,
      apiDurationWithoutRetriesMs: 0,
      toolDurationMs: 0,
      wallDurationMs: 0,
      linesAdded: 0,
      linesRemoved: 0,
      hasUnknownModelCost: false,
      modelUsage: {
        'claude-sonnet-4-20250514': {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          webSearchRequests: 0,
          costUsd: totalCostUsd,
        },
      },
    })

    try {
      app.stdin.write('/status')
      app.stdin.write('\r')
      await waitFor(() =>
        app.lastFrame()?.includes('Settings') &&
        app.lastFrame()?.includes('Status  Config  Usage')
          ? true
          : undefined,
      )

      // Status -> Config -> Usage requests a real current-session snapshot.
      app.stdin.write('\u001B[C')
      app.stdin.write('\u001B[C')
      await waitFor(() => (costRequests.length === 1 ? true : undefined))
      expect(costRequests).toEqual(['active-session'])

      // A second Usage entry in the same menu supersedes the first request.
      app.stdin.write('\u001B[D')
      app.stdin.write('\u001B[C')
      await waitFor(() => (costRequests.length === 2 ? true : undefined))
      expect(costRequests).toEqual(['active-session', 'active-session'])

      // Reopening Settings Usage creates a newer menu generation and request.
      app.stdin.write('\u001B')
      await waitFor(() => {
        const frame = app.lastFrame()
        return frame !== undefined && !frame.includes('Status  Config  Usage')
          ? true
          : undefined
      })
      app.stdin.write('/usage')
      app.stdin.write('\r')
      await waitFor(() => (costRequests.length === 3 ? true : undefined))
      expect(costRequests).toEqual([
        'active-session',
        'active-session',
        'active-session',
      ])
      const freshTurn = turns.at(-1)
      expect(freshTurn).not.toBeNull()

      // A superseded request fails late: its warning must not surface either,
      // even when it settles before the oldest stale request resolves.
      deferreds[1]?.reject(new Error('stale cost failure'))
      await flush()
      expect(turns.at(-1)).toBe(freshTurn)
      expect(app.lastFrame()).not.toContain('stale cost failure')

      // The oldest request resolves late with stale data: it must not overwrite
      // the newer menu, and its turn cleanup must not touch the newer operation.
      deferreds[0]?.resolve(snapshot(111.11))
      await flush()
      expect(turns.at(-1)).toBe(freshTurn)
      expect(app.lastFrame()).toContain('Total cost:            $0.0000')
      expect(app.lastFrame()).not.toContain('$111.11')

      // The newest request resolves and its snapshot is the one that remains.
      deferreds[2]?.resolve(snapshot(222.22))
      await waitFor(() =>
        app.lastFrame()?.includes('Total cost:            $222.22')
          ? true
          : undefined,
      )
      expect(app.lastFrame()).toContain('Total cost:            $222.22')
      expect(app.lastFrame()).not.toContain('$111.11')
      expect(app.lastFrame()).not.toContain('stale cost failure')
      expect(turns.at(-1)).toBeNull()
      expect(creations).toEqual([
        { requireProvider: false },
        { requireProvider: false },
        { requireProvider: false },
      ])
      expect(runCalls).toEqual([])
      expect(resumeCalls).toEqual([])
    } finally {
      app.unmount()
    }
  })

  function doctorReport(overrides: Partial<DoctorReport> = {}): DoctorReport {
    return {
      type: 'doctor',
      ok: true,
      praxisVersion: '1.2.3',
      diagnostic: {
        installationType: 'npm',
        version: '1.2.3',
        packageManager: 'npm',
        installationPath:
          '/usr/local/lib/node_modules/praxis-agent/dist/cli.js',
        invokedBinary: '/usr/local/bin/praxis',
        configInstallMethod: 'default (~/.claude)',
        search: {
          working: true,
          mode: 'system',
          systemPath: '/usr/local/bin/rg',
        },
        recommendation: null,
        multipleInstallations: ['/usr/local/bin/praxis'],
        warnings: [],
      },
      updates: {
        autoUpdates: 'Manual (praxis update)',
        hasUpdatePermissions: true,
        channel: 'stable',
        stableVersion: '1.2.3',
        latestVersion: '1.2.4',
        registryStatus: 'available',
      },
      checks: [
        {
          id: 'installation',
          status: 'pass',
          summary: 'Praxis 1.2.3 installation is readable',
        },
        {
          id: 'mcp',
          status: 'warn',
          summary: '1 MCP server configuration(s) are valid',
          details: {
            warnings: ['server filesystem uses a deprecated transport'],
          },
        },
        {
          id: 'plugins',
          status: 'fail',
          summary: 'plugin manifest is missing a name',
        },
      ],
      summary: { passed: 1, warnings: 1, failed: 1 },
      ...overrides,
    }
  }

  it('opens /doctor with an immediate loading screen and renders the completed report without service work', async () => {
    const creations: string[] = []
    let resolveDoctor!: (report: DoctorReport) => void
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            creations.push('service')
            throw new Error('doctor must not create a service')
          },
        }}
        initialSessions={[]}
        display={{ version: 'test', cwd: '/fixture/workspace' }}
        doctorLoader={() =>
          new Promise<DoctorReport>((resolve) => {
            resolveDoctor = resolve
          })
        }
      />,
    )

    app.stdin.write('/doctor')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('Checking installation status…')
    expect(creations).toEqual([])

    resolveDoctor(doctorReport())
    await waitFor(() =>
      app.lastFrame()?.includes('Summary: 1 passed, 1 warnings, 1 failed.')
        ? true
        : undefined,
    )
    const frame = app.lastFrame()
    expect(frame).toContain('Diagnostics')
    expect(frame).toContain('Currently running: Praxis 1.2.3 (npm)')
    expect(frame).toContain('Package manager: npm')
    expect(frame).toContain(
      'Path: /usr/local/lib/node_modules/praxis-agent/dist/cli.js',
    )
    expect(frame).toContain('Invoked: /usr/local/bin/praxis')
    expect(frame).toContain('Config install method: default (~/.claude)')
    expect(frame).toContain('Search: OK (system)')
    expect(frame).toContain('└ /usr/local/bin/rg')
    expect(frame).toContain('Updates')
    expect(frame).toContain('Auto-updates: Manual (praxis update)')
    expect(frame).toContain('Update permissions: yes')
    expect(frame).toContain('Auto-update channel: stable')
    expect(frame).toContain('Stable version: 1.2.3')
    expect(frame).toContain('Latest version: 1.2.4')
    expect(frame).toContain('MCP parsing warnings')
    expect(frame).toContain('Plugin errors')
    expect(frame).toContain('Enter to continue · Esc to cancel')
    expect(frame).not.toContain('not checked')
    expect(frame).not.toContain('Current version: Praxis')
    expect(frame).not.toContain(
      'installation: Praxis 1.2.3 installation is readable',
    )
    expect(frame).not.toContain('⎿')
    expect(creations).toEqual([])

    // Enter dismisses locally without a model turn, transcript item, or service.
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).not.toContain('Diagnostics')
    expect(app.lastFrame()).not.toContain('⎿')
    expect(creations).toEqual([])
    app.unmount()
  })

  it('renders pending doctor progress before replacing only the version state with the final report', async () => {
    const creations: string[] = []
    const turns: Array<Promise<void> | null> = []
    let progressListener: DoctorProgressListener | undefined
    let resolveDoctor!: (report: DoctorReport) => void
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            creations.push('service')
            throw new Error('doctor must not create a service')
          },
        }}
        initialSessions={[]}
        display={{ version: 'test', cwd: '/fixture/workspace' }}
        onTurnChange={(turn) => {
          turns.push(turn)
        }}
        doctorLoader={(onProgress) => {
          progressListener = onProgress
          return new Promise<DoctorReport>((resolve) => {
            resolveDoctor = resolve
          })
        }}
      />,
    )

    app.stdin.write('/doctor')
    app.stdin.write('\r')
    await waitFor(() =>
      app.lastFrame()?.includes('Checking installation status…')
        ? true
        : undefined,
    )

    // Intermediate progress: complete local diagnostics with pending updates.
    progressListener?.({
      ...doctorReport(),
      updates: {
        autoUpdates: 'Manual (praxis update)',
        hasUpdatePermissions: true,
        channel: 'stable',
        stableVersion: null,
        latestVersion: null,
        registryStatus: 'loading',
      },
    })
    await waitFor(() =>
      app.lastFrame()?.includes('Checking for updates…') ? true : undefined,
    )
    const intermediate = app.lastFrame()
    expect(intermediate).toContain('Diagnostics')
    expect(intermediate).toContain('Currently running: Praxis 1.2.3 (npm)')
    expect(intermediate).toContain('Checking for updates…')
    expect(intermediate).toContain('Enter to continue · Esc to cancel')
    expect(intermediate).not.toContain('Stable version:')
    expect(intermediate).not.toContain('Latest version:')
    expect(intermediate).not.toContain('⎿')
    expect(turns.at(-1)).not.toBeNull()
    expect(creations).toEqual([])

    // The final report replaces only the pending update state.
    resolveDoctor(doctorReport())
    await waitFor(() =>
      app.lastFrame()?.includes('Latest version: 1.2.4') ? true : undefined,
    )
    const frame = app.lastFrame()
    expect(frame).toContain('Diagnostics')
    expect(frame).toContain('Stable version: 1.2.3')
    expect(frame).toContain('Latest version: 1.2.4')
    expect(frame).not.toContain('Checking for updates…')
    expect(frame).not.toContain('⎿')
    expect(turns.at(-1)).toBeNull()
    expect(creations).toEqual([])
    app.unmount()
  })

  it('renders a current /doctor loader rejection inside the doctor screen and Esc dismisses', async () => {
    const creations: string[] = []
    let rejectDoctor!: (reason: Error) => void
    const secretEnvName = 'PRAXIS_TEST_TOKEN'
    const priorSecret = process.env[secretEnvName]
    const secret = 'praxis-ambient-secret-7d3c9f1'
    process.env[secretEnvName] = secret
    try {
      const app = render(
        <InteractiveApp
          factory={{
            async createService() {
              creations.push('service')
              throw new Error('doctor must not create a service')
            },
          }}
          initialSessions={[]}
          display={{ version: 'test', cwd: '/fixture/workspace' }}
          doctorLoader={() =>
            new Promise<DoctorReport>((_resolve, reject) => {
              rejectDoctor = reject
            })
          }
        />,
      )

      app.stdin.write('/doctor')
      app.stdin.write('\r')
      await waitFor(() =>
        app.lastFrame()?.includes('Checking installation status…')
          ? true
          : undefined,
      )
      rejectDoctor(new Error(`PRAXIS_TEST_TOKEN is required: ${secret}`))
      await waitFor(() =>
        app.lastFrame()?.includes('Diagnostics failed') ? true : undefined,
      )
      expect(app.lastFrame()).toContain('PRAXIS_TEST_TOKEN is required')
      expect(app.lastFrame()).toContain('[REDACTED]')
      expect(app.lastFrame()).not.toContain(secret)
      expect(app.lastFrame()).toContain('Enter to continue · Esc to cancel')
      expect(app.lastFrame()).not.toContain('⎿')
      expect(creations).toEqual([])

      app.stdin.write('')
      await waitFor(() =>
        app.lastFrame()?.includes('Diagnostics failed') === false
          ? true
          : undefined,
      )
      expect(creations).toEqual([])
      app.unmount()
    } finally {
      if (priorSecret === undefined) delete process.env[secretEnvName]
      else process.env[secretEnvName] = priorSecret
    }
  })

  it('invalidates closed /doctor generations so stale success, failure, and progress stay inert', async () => {
    const deferreds: Array<{
      resolve: (report: DoctorReport) => void
      reject: (reason: Error) => void
    }> = []
    const progressListeners: DoctorProgressListener[] = []
    const loaderCalls: string[] = []
    const creations: string[] = []
    const turns: Array<Promise<void> | null> = []
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            creations.push('service')
            throw new Error('doctor must not create a service')
          },
        }}
        initialSessions={[]}
        display={{ version: 'test', cwd: '/fixture/workspace' }}
        onTurnChange={(turn) => {
          turns.push(turn)
        }}
        doctorLoader={(onProgress) => {
          loaderCalls.push(String(loaderCalls.length))
          if (onProgress !== undefined) progressListeners.push(onProgress)
          let resolve!: (report: DoctorReport) => void
          let reject!: (reason: Error) => void
          const promise = new Promise<DoctorReport>((res, rej) => {
            resolve = res
            reject = rej
          })
          deferreds.push({ resolve, reject })
          return promise
        }}
      />,
    )

    try {
      // Open -> close -> reopen -> close -> reopen yields three loader calls.
      app.stdin.write('/doctor')
      app.stdin.write('\r')
      await waitFor(() =>
        app.lastFrame()?.includes('Checking installation status…')
          ? true
          : undefined,
      )
      app.stdin.write('')
      await waitFor(() =>
        app.lastFrame()?.includes('Checking installation status…') === false
          ? true
          : undefined,
      )
      app.stdin.write('/doctor')
      app.stdin.write('\r')
      await waitFor(() =>
        app.lastFrame()?.includes('Checking installation status…')
          ? true
          : undefined,
      )
      app.stdin.write('')
      await waitFor(() =>
        app.lastFrame()?.includes('Checking installation status…') === false
          ? true
          : undefined,
      )
      app.stdin.write('/doctor')
      app.stdin.write('\r')
      await waitFor(() =>
        app.lastFrame()?.includes('Checking installation status…')
          ? true
          : undefined,
      )
      expect(loaderCalls).toEqual(['0', '1', '2'])
      const freshTurn = turns.at(-1)
      expect(freshTurn).not.toBeNull()

      // The first (stale) loader success must not overwrite the newer panel.
      deferreds[0]?.resolve(doctorReport())
      await flush()
      expect(app.lastFrame()).toContain('Checking installation status…')
      expect(turns.at(-1)).toBe(freshTurn)

      // The second (stale) loader failure must not surface into the newer panel.
      deferreds[1]?.reject(new Error('stale doctor failure'))
      await flush()
      expect(app.lastFrame()).toContain('Checking installation status…')
      expect(app.lastFrame()).not.toContain('stale doctor failure')
      expect(turns.at(-1)).toBe(freshTurn)

      // Stale progress callbacks from closed generations must stay inert too.
      progressListeners[0]?.({
        ...doctorReport(),
        praxisVersion: '0.0.1',
        diagnostic: { ...doctorReport().diagnostic, version: '0.0.1' },
        updates: {
          autoUpdates: 'Manual (praxis update)',
          hasUpdatePermissions: true,
          channel: 'stable',
          stableVersion: null,
          latestVersion: null,
          registryStatus: 'loading',
        },
      })
      progressListeners[1]?.({
        ...doctorReport(),
        praxisVersion: '0.0.2',
        diagnostic: { ...doctorReport().diagnostic, version: '0.0.2' },
        updates: {
          autoUpdates: 'Manual (praxis update)',
          hasUpdatePermissions: true,
          channel: 'stable',
          stableVersion: null,
          latestVersion: null,
          registryStatus: 'loading',
        },
      })
      await flush()
      expect(app.lastFrame()).toContain('Checking installation status…')
      expect(app.lastFrame()).not.toContain('Checking for updates…')
      expect(app.lastFrame()).not.toContain('Praxis 0.0.1')
      expect(app.lastFrame()).not.toContain('Praxis 0.0.2')
      expect(turns.at(-1)).toBe(freshTurn)

      // Closing a current pending report must also invalidate its final result.
      progressListeners[2]?.({
        ...doctorReport(),
        praxisVersion: '9.9.9',
        diagnostic: { ...doctorReport().diagnostic, version: '9.9.9' },
        updates: {
          autoUpdates: 'Manual (praxis update)',
          hasUpdatePermissions: true,
          channel: 'stable',
          stableVersion: null,
          latestVersion: null,
          registryStatus: 'loading',
        },
      })
      await waitFor(() =>
        app.lastFrame()?.includes('Checking for updates…') ? true : undefined,
      )
      expect(app.lastFrame()).toContain('Currently running: Praxis 9.9.9 (npm)')
      expect(turns.at(-1)).toBe(freshTurn)

      app.stdin.write('\u001B')
      await waitFor(() =>
        app.lastFrame()?.includes('Checking for updates…') === false
          ? true
          : undefined,
      )
      expect(turns.at(-1)).toBeNull()

      deferreds[2]?.resolve(doctorReport())
      await flush()
      expect(app.lastFrame()).not.toContain('Currently running: Praxis')
      expect(app.lastFrame()).not.toContain('Checking for updates…')
      expect(app.lastFrame()).not.toContain('stale doctor failure')
      expect(turns.at(-1)).toBeNull()
      expect(creations).toEqual([])
    } finally {
      app.unmount()
    }
  })

  it('lists /doctor in slash discovery with the fixed description', async () => {
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            throw new Error('unused')
          },
        }}
        initialSessions={[]}
      />,
    )
    app.stdin.write('/doc')
    await flush()
    expect(app.lastFrame()).toContain('/doctor')
    expect(app.lastFrame()).toContain(
      'Diagnose and verify your Claude Code installation and settings',
    )
    app.unmount()
  })

  it('reports the current renderer and restarts after switching it', async () => {
    const rendererChanges: Array<{
      mode: 'default' | 'fullscreen'
      sessionId: string | null
    }> = []
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            throw new Error('unused')
          },
        }}
        initialSessions={[]}
        runtimeSettings={{
          ...projectRuntimeSettings({ settings: {}, state: {} }),
          tui: 'default',
        }}
        onRendererChange={(mode, sessionId) => {
          rendererChanges.push({ mode, sessionId })
        }}
      />,
    )

    app.stdin.write('/tui')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('TUI renderer: default')
    expect(app.lastFrame()).toContain('/tui default|fullscreen')

    app.stdin.write('/tui fullscreen')
    app.stdin.write('\r')
    await waitFor(() => rendererChanges[0])
    expect(rendererChanges).toEqual([{ mode: 'fullscreen', sessionId: null }])
  })

  it('anchors the composer and status footer to the bottom of a fixed fullscreen viewport', async () => {
    const renderApp = (tui: 'default' | 'fullscreen') =>
      render(
        <InteractiveApp
          factory={{
            async createService() {
              throw new Error('unused')
            },
          }}
          initialSessions={[]}
          runtimeSettings={{
            ...projectRuntimeSettings({ settings: {}, state: {} }),
            tui,
          }}
        />,
      )
    const frameRows = (frame: string | undefined): string[] => {
      const lines = (frame ?? '').split('\n')
      return lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines
    }

    // Fullscreen mode fixes the viewport to the deterministic terminal height
    // and pushes the composer/status footer down to the bottom of the frame.
    const app = renderApp('fullscreen')
    await flush()
    Object.assign(app.stdout, { rows: 24 })
    app.stdout.emit('resize')
    const body = await waitFor(() => {
      const candidate = frameRows(app.lastFrame())
      return candidate.length === 24 ? candidate : undefined
    })

    // The welcome panel stays anchored to the top of the fixed viewport.
    expect(body[0]?.includes('╭')).toBe(true)
    expect(body[0]?.includes('Praxis')).toBe(true)

    // The composer footer reaches the bottom portion of the 24-row frame.
    const footerIndex = body.findIndex((line) => line.includes('⏵⏵'))
    expect(footerIndex).toBeGreaterThanOrEqual(body.length - 2)

    // Blank spacer rows separate the welcome panel from the composer.
    const welcomeLastIndex = body.findLastIndex((line) => line.includes('╰'))
    expect(welcomeLastIndex).toBeGreaterThanOrEqual(0)
    const promptIndex = body.findIndex((line) =>
      line.includes('Try "review this project"'),
    )
    expect(promptIndex).toBeGreaterThan(welcomeLastIndex)
    const gap = body.slice(welcomeLastIndex + 1, promptIndex)
    expect(gap.length).toBeGreaterThanOrEqual(2)
    expect(
      gap.filter((line) => line.trim() === '').length,
    ).toBeGreaterThanOrEqual(2)

    // Default renderer mode ignores the fixed viewport: the frame stays
    // content-sized and the composer follows the welcome panel closely.
    const defaultApp = renderApp('default')
    await flush()
    Object.assign(defaultApp.stdout, { rows: 24 })
    defaultApp.stdout.emit('resize')
    const defaultBody = await waitFor(() => {
      const candidate = frameRows(defaultApp.lastFrame())
      return candidate.length > 0 && candidate.length < 24
        ? candidate
        : undefined
    })
    expect(defaultBody.length).toBeLessThan(24)
    const defaultWelcomeLastIndex = defaultBody.findLastIndex((line) =>
      line.includes('╰'),
    )
    const defaultPromptIndex = defaultBody.findIndex((line) =>
      line.includes('Try "review this project"'),
    )
    expect(defaultPromptIndex).toBeGreaterThan(defaultWelcomeLastIndex)
    const defaultGap = defaultBody.slice(
      defaultWelcomeLastIndex + 1,
      defaultPromptIndex,
    )
    expect(
      defaultGap.filter((line) => line.trim() === '').length,
    ).toBeLessThanOrEqual(1)
  })

  it('routes fullscreen transcript scrolling through the interaction seam', async () => {
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            throw new Error('unused')
          },
        }}
        initialSessions={[]}
        initialHistory={[
          { kind: 'user', text: 'scroll prompt' },
          {
            kind: 'assistant',
            text: [
              'older marker',
              ...Array.from({ length: 40 }, (_, i) => `line ${i}`),
              'newer marker',
            ].join('\n'),
          },
        ]}
        runtimeSettings={{
          ...projectRuntimeSettings({ settings: {}, state: {} }),
          tui: 'fullscreen',
        }}
      />,
    )
    await flush()
    Object.assign(app.stdout, { rows: 24 })
    app.stdout.emit('resize')
    const before = await waitFor(() => {
      const frame = app.lastFrame() ?? ''
      const rows = frame.endsWith('\n')
        ? frame.slice(0, -1).split('\n')
        : frame.split('\n')
      return rows.length === 24 && frame.includes('newer marker')
        ? frame
        : undefined
    })
    for (let index = 0; index < 12; index += 1) app.stdin.write('\u0015')
    await waitFor(() => {
      const frame = app.lastFrame() ?? ''
      return frame.includes('older marker') ? frame : undefined
    })
    expect(app.lastFrame()).not.toBe(before)
  })

  it('keeps the composer and status anchored when the fullscreen transcript grows', async () => {
    const longText = Array.from(
      { length: 120 },
      (_, index) => `stream line ${index}`,
    ).join('\n')
    const renderApp = (tui: 'default' | 'fullscreen') =>
      render(
        <InteractiveApp
          factory={{
            async createService() {
              throw new Error('unused')
            },
          }}
          initialSessions={[]}
          initialHistory={[
            { kind: 'user', text: 'long prompt' },
            { kind: 'assistant', text: longText },
          ]}
          runtimeSettings={{
            ...projectRuntimeSettings({ settings: {}, state: {} }),
            tui,
          }}
        />,
      )
    const frameRows = (frame: string | undefined): string[] => {
      const lines = (frame ?? '').split('\n')
      return lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines
    }

    // A 120-line transcript far exceeds the fixed 24-row viewport. The
    // transcript region must clip while the composer/status footer stays pinned
    // to the bottom instead of being pushed below the visible frame.
    const app = renderApp('fullscreen')
    await flush()
    Object.assign(app.stdout, { rows: 24 })
    app.stdout.emit('resize')
    const body = await waitFor(() => {
      const candidate = frameRows(app.lastFrame())
      return candidate.length === 24 ? candidate : undefined
    })

    const footerIndex = body.findIndex((line) => line.includes('⏵⏵'))
    expect(footerIndex).toBeGreaterThanOrEqual(body.length - 2)
    const promptIndex = body.findIndex((line) =>
      line.includes('Try "review this project"'),
    )
    expect(promptIndex).toBeGreaterThanOrEqual(body.length - 6)

    // Classic mode stays content-sized and never pins the footer to 24 rows.
    const defaultApp = renderApp('default')
    await flush()
    Object.assign(defaultApp.stdout, { rows: 24 })
    defaultApp.stdout.emit('resize')
    const defaultBody = await waitFor(() => {
      const candidate = frameRows(defaultApp.lastFrame())
      return candidate.length > 0 && candidate.length > 24
        ? candidate
        : undefined
    })
    expect(defaultBody.length).toBeGreaterThan(24)
  })

  it('projects the newest transcript tail into a fixed fullscreen viewport', async () => {
    const turnCount = 21
    const history = Array.from({ length: turnCount }, (_, index) => [
      { kind: 'user' as const, text: `prompt ${index + 1}` },
      {
        kind: 'assistant' as const,
        text: `reply ${index + 1}\n- note ${index + 1} a\n- note ${index + 1} b\n- note ${index + 1} c`,
      },
    ]).flat()
    const renderApp = (tui: 'default' | 'fullscreen') =>
      render(
        <InteractiveApp
          factory={{
            async createService() {
              throw new Error('unused')
            },
          }}
          initialSessions={[]}
          initialHistory={history}
          runtimeSettings={{
            ...projectRuntimeSettings({ settings: {}, state: {} }),
            tui,
          }}
        />,
      )
    const frameRows = (frame: string | undefined): string[] => {
      const lines = (frame ?? '').split('\n')
      return lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines
    }

    // A 105-line multi-turn history far exceeds the fixed 24-row viewport. The
    // fullscreen tail projection must show the newest prompt/reply instead of
    // clipping it below the fold, and the transcript must not render empty.
    const app = renderApp('fullscreen')
    await flush()
    Object.assign(app.stdout, { rows: 24 })
    app.stdout.emit('resize')
    const body = await waitFor(() => {
      const candidate = frameRows(app.lastFrame())
      return candidate.length === 24 ? candidate : undefined
    })
    const frame = body.join('\n')
    expect(frame).toContain(`❯ prompt ${turnCount}`)
    expect(frame).toContain(`reply ${turnCount}`)
    expect(frame).toContain(`note ${turnCount} c`)
    expect(frame).not.toContain('prompt 1')

    // Composer and status footer stay anchored to the bottom of the viewport.
    const footerIndex = body.findIndex((line) => line.includes('⏵⏵'))
    expect(footerIndex).toBeGreaterThanOrEqual(body.length - 2)
    const promptIndex = body.findIndex((line) =>
      line.includes('Try "review this project"'),
    )
    expect(promptIndex).toBeGreaterThanOrEqual(body.length - 6)

    // Classic mode keeps the full multi-turn history.
    const defaultApp = renderApp('default')
    await flush()
    Object.assign(defaultApp.stdout, { rows: 24 })
    defaultApp.stdout.emit('resize')
    const defaultBody = await waitFor(() => {
      const candidate = frameRows(defaultApp.lastFrame())
      return candidate.length > 0 && candidate.length > 24
        ? candidate
        : undefined
    })
    expect(defaultBody.length).toBeGreaterThan(24)
    expect(defaultBody.join('\n')).toContain('prompt 1')
    expect(defaultBody.join('\n')).toContain(`❯ prompt ${turnCount}`)
    expect(defaultBody.join('\n')).toContain(`reply ${turnCount}`)
  })

  it('publishes the latest resize tuple while preserving composer input and transcript tail', async () => {
    const newestMarker = 'latest-resize-tail'
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            throw new Error('unused')
          },
        }}
        initialSessions={[]}
        initialHistory={[{ kind: 'assistant', text: newestMarker }]}
        runtimeSettings={{
          ...projectRuntimeSettings({ settings: {}, state: {} }),
          tui: 'fullscreen',
        }}
      />,
    )
    await flush()
    const resize = (columns: number, rows: number) => {
      Object.defineProperty(app.stdout, 'columns', {
        configurable: true,
        writable: true,
        value: columns,
      })
      Object.defineProperty(app.stdout, 'rows', {
        configurable: true,
        writable: true,
        value: rows,
      })
      app.stdout.emit('resize')
    }
    resize(120, 40)
    resize(90, 30)
    resize(80, 24)
    app.stdin.write('draft input')

    const frame = await waitFor(() => {
      const candidate = app.lastFrame() ?? ''
      const rows = candidate.endsWith('\n')
        ? candidate.slice(0, -1).split('\n')
        : candidate.split('\n')
      return rows.length === 24 &&
        candidate.includes('draft input') &&
        candidate.includes(newestMarker)
        ? candidate
        : undefined
    })
    expect(frame).toContain('draft input')
    expect(frame).toContain(newestMarker)
  })

  it('recomputes the bounded fullscreen frame when the terminal shrinks and never duplicates the composer', async () => {
    const staleMarker = 'stale-sentinel-visible-at-40-rows'
    const newestMarker = 'newest-tail-sentinel'
    // Eight 3-line assistant items: 24 estimated rows total, rendered with a
    // margin row per item. The stale marker lives in the third item, so it is
    // inside the 28-row projection at 40 rows and outside the 12-row
    // projection after shrinking to 24 rows.
    const items = Array.from({ length: 8 }, (_, index) => ({
      kind: 'assistant' as const,
      text: `filler ${index} a\nfiller ${index} b\nfiller ${index} c`,
    }))
    const history = items.map((item, index) =>
      index === 3
        ? { ...item, text: `filler 3 a\nfiller 3 b\n${staleMarker}` }
        : index === 7
          ? { ...item, text: `filler 7 a\nfiller 7 b\n${newestMarker}` }
          : item,
    )
    const renderApp = (tui: 'default' | 'fullscreen') =>
      render(
        <InteractiveApp
          factory={{
            async createService() {
              throw new Error('unused')
            },
          }}
          initialSessions={[]}
          initialHistory={history}
          runtimeSettings={{
            ...projectRuntimeSettings({ settings: {}, state: {} }),
            tui,
          }}
        />,
      )
    const frameRows = (frame: string | undefined): string[] => {
      const lines = (frame ?? '').split('\n')
      return lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines
    }
    const countOccurrences = (haystack: string, needle: string): number =>
      haystack.split(needle).length - 1

    // At 40 terminal rows the fullscreen projection budget is 28 rows, which
    // covers the whole 24-row history, so the stale and newest sentinels are
    // both visible and the composer appears exactly once.
    const app = renderApp('fullscreen')
    await flush()
    Object.assign(app.stdout, { rows: 40 })
    app.stdout.emit('resize')
    const tallBody = await waitFor(() => {
      const candidate = frameRows(app.lastFrame())
      return candidate.length === 40 ? candidate : undefined
    })
    const tallFrame = tallBody.join('\n')
    expect(tallFrame).toContain(staleMarker)
    expect(tallFrame).toContain(newestMarker)
    expect(countOccurrences(tallFrame, '⏵⏵')).toBe(1)

    // Shrinking to 24 rows drops the budget to 12 rows (the newest four items):
    // the stale sentinel must disappear from the next frame while the newest
    // content and the single bottom-anchored composer stay visible.
    Object.assign(app.stdout, { rows: 24 })
    app.stdout.emit('resize')
    const shortBody = await waitFor(() => {
      const candidate = frameRows(app.lastFrame())
      return candidate.length === 24 ? candidate : undefined
    })
    const shortFrame = shortBody.join('\n')
    expect(shortFrame).not.toContain(staleMarker)
    expect(shortFrame).toContain(newestMarker)
    expect(countOccurrences(shortFrame, '⏵⏵')).toBe(1)

    // Classic mode stays content-sized and never bounds the transcript.
    const defaultApp = renderApp('default')
    await flush()
    Object.assign(defaultApp.stdout, { rows: 24 })
    defaultApp.stdout.emit('resize')
    const defaultBody = await waitFor(() => {
      const candidate = frameRows(defaultApp.lastFrame())
      return candidate.length > 0 ? candidate : undefined
    })
    expect(defaultBody.length).toBeGreaterThan(24)
  })

  it('keeps the fullscreen frame height-anchored when the composer grows to multiple lines', async () => {
    const renderApp = (tui: 'default' | 'fullscreen') =>
      render(
        <InteractiveApp
          factory={{
            async createService() {
              throw new Error('unused')
            },
          }}
          initialSessions={[]}
          runtimeSettings={{
            ...projectRuntimeSettings({ settings: {}, state: {} }),
            tui,
          }}
        />,
      )
    const frameRows = (frame: string | undefined): string[] => {
      const lines = (frame ?? '').split('\n')
      return lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines
    }
    const countOccurrences = (haystack: string, needle: string): number =>
      haystack.split(needle).length - 1

    const app = renderApp('fullscreen')
    await flush()
    Object.assign(app.stdout, { rows: 24 })
    app.stdout.emit('resize')
    const body = await waitFor(() => {
      const candidate = frameRows(app.lastFrame())
      return candidate.length === 24 ? candidate : undefined
    })
    expect(countOccurrences(body.join('\n'), '⏵⏵')).toBe(1)

    // ctrl+j (chat:newline) grows the composer to a second line. The frame
    // must stay exactly 24 rows tall with a single composer footer instead of
    // duplicating the composer or leaving stale transcript rows.
    app.stdin.write('first line')
    await flush()
    app.stdin.write('\n')
    await flush()
    app.stdin.write('second line')
    await flush()
    const multilineBody = await waitFor(() => {
      const candidate = frameRows(app.lastFrame())
      const frame = candidate.join('\n')
      return candidate.length === 24 && frame.includes('second line')
        ? candidate
        : undefined
    })
    const frame = multilineBody.join('\n')
    expect(multilineBody.length).toBe(24)
    expect(frame).toContain('first line')
    expect(frame).toContain('second line')
    expect(countOccurrences(frame, '⏵⏵')).toBe(1)
  })

  it('coalesces streamed deltas into bounded frames and preserves the exact final text', async () => {
    const chunks = Array.from({ length: 200 }, (_, index) => `chunk-${index}`)
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const factory: InteractiveServiceFactory = {
      async createService({ eventSink }) {
        return {
          async run() {
            for (const chunk of chunks) {
              eventSink({ type: 'text-delta', delta: chunk })
            }
            await gate
            return {
              sessionId: 'session-1',
              text: chunks.join(''),
              usage: { inputTokens: 1, outputTokens: chunks.length },
            }
          },
          async resume() {
            throw new Error('unused')
          },
          async fork() {
            throw new Error('unused')
          },
          async sessions() {
            return []
          },
        }
      },
    }
    const app = render(
      <InteractiveApp factory={factory} initialSessions={[]} />,
    )
    await flush()
    app.stdin.write('burst')
    await flush()
    app.stdin.write('\r')
    await flush()

    // The delta burst is buffered, not rendered synchronously per delta.
    expect(app.lastFrame()).not.toContain('chunk-0')

    // The first bounded frame publishes the full accumulated stream. Ink wraps
    // the long single-line body, so strip whitespace to compare the contiguous
    // string exactly.
    const normalized = (frame: string | undefined) =>
      (frame ?? '').replace(/\s+/gu, '')
    await waitFor(() => {
      const frame = app.lastFrame()
      return frame?.includes('✳') && normalized(frame).includes(chunks.join(''))
        ? true
        : undefined
    })
    expect(app.lastFrame()).toContain('✳')
    expect(normalized(app.lastFrame())).toContain(chunks.join(''))

    // Releasing the turn replaces streaming text with the completed assistant
    // entry; the observable final text is identical.
    release?.()
    await flush()
    expect(normalized(app.lastFrame())).toContain(chunks.join(''))
    expect(app.lastFrame()).not.toContain('✳')
  })

  it('moves the active foreground Agent to background with the Task keybinding', async () => {
    let finishResume!: (result: {
      sessionId: string
      text: string
      usage: { inputTokens: number; outputTokens: number }
    }) => void
    const activeTurn = new Promise<{
      sessionId: string
      text: string
      usage: { inputTokens: number; outputTokens: number }
    }>((resolve) => {
      finishResume = resolve
    })
    const backgroundForegroundTask = vi.fn()
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            return {
              async run() {
                throw new Error('unused')
              },
              async resume() {
                return activeTurn
              },
              async fork() {
                throw new Error('unused')
              },
              async sessions() {
                return []
              },
              backgroundForegroundTask,
            }
          },
        }}
        initialSessions={[]}
        resume={{ sessionId: 'active-session' }}
      />,
    )

    app.stdin.write('delegate now')
    app.stdin.write('\r')
    await flush()
    app.stdin.write('\u0018')
    app.stdin.write('\u0002')

    await expect.poll(() => backgroundForegroundTask.mock.calls.length).toBe(1)
    expect(backgroundForegroundTask).toHaveBeenCalledWith('active-session')
    await expect
      .poll(() => app.lastFrame() ?? '')
      .toContain('Agent moved to background · continuing this turn')

    finishResume({
      sessionId: 'active-session',
      text: 'parent continued',
      usage: { inputTokens: 1, outputTokens: 1 },
    })
    await flush()
  })

  it('removes live text and completed thinking from a discarded model attempt', async () => {
    let discard: (() => void) | undefined
    const discardGate = new Promise<void>((resolve) => {
      discard = resolve
    })
    const factory: InteractiveServiceFactory = {
      async createService({ eventSink }) {
        return {
          async run() {
            eventSink({ type: 'state', state: 'awaiting-model' })
            eventSink({
              type: 'thinking-start',
              block: { type: 'thinking', thinking: '' },
            })
            eventSink({ type: 'thinking-delta', delta: 'discarded reasoning' })
            eventSink({
              type: 'thinking-stop',
              block: {
                type: 'thinking',
                thinking: 'discarded reasoning',
                signature: 'sig',
              },
            })
            eventSink({ type: 'text-delta', delta: 'discarded answer' })
            await discardGate
            eventSink({ type: 'terminal', reason: 'prompt_too_long' })
            eventSink({
              type: 'model-attempt-discarded',
              reason: 'prompt_too_long',
            })
            eventSink({ type: 'state', state: 'awaiting-model' })
            eventSink({ type: 'text-delta', delta: 'recovered answer' })
            eventSink({ type: 'terminal', reason: 'end_turn' })
            eventSink({ type: 'state', state: 'completed' })
            return {
              sessionId: 'session-1',
              text: 'recovered answer',
              usage: { inputTokens: 1, outputTokens: 1 },
            }
          },
          async resume() {
            throw new Error('unused')
          },
          async fork() {
            throw new Error('unused')
          },
          async sessions() {
            return []
          },
        }
      },
    }
    const app = render(
      <InteractiveApp factory={factory} initialSessions={[]} />,
    )
    app.stdin.write('recover')
    app.stdin.write('\r')
    await waitFor(() =>
      app.lastFrame()?.includes('discarded answer') ? true : undefined,
    )

    discard?.()
    await waitFor(() =>
      app.lastFrame()?.includes('recovered answer') ? true : undefined,
    )
    expect(app.lastFrame()).not.toContain('discarded answer')
    expect(app.lastFrame()).not.toContain('discarded reasoning')
  })

  it('never renders the active stream and its committed final item in the same frame', async () => {
    const finalText = 'stream-commit-no-duplicate-final'
    let releaseRun: (() => void) | undefined
    const runGate = new Promise<void>((resolve) => {
      releaseRun = resolve
    })
    let releaseDiff: (() => void) | undefined
    const diffGate = new Promise<TuiDiffSnapshot>((resolve) => {
      releaseDiff = () => resolve({ files: [], additions: 0, deletions: 0 })
    })
    const factory: InteractiveServiceFactory = {
      async createService({ eventSink }) {
        return {
          async run() {
            // An Edit tool-call marks the turn as file-mutating, which routes
            // the finalization through an awaited diff snapshot load. That await
            // is the boundary where an intermediate render could previously show
            // both the streaming text and the identical committed item.
            eventSink({
              type: 'tool-call',
              call: { id: 'edit-1', name: 'Edit', input: {} },
            })
            eventSink({ type: 'text-delta', delta: finalText })
            await runGate
            return {
              sessionId: 'session-1',
              text: finalText,
              usage: { inputTokens: 1, outputTokens: 1 },
            }
          },
          async resume() {
            throw new Error('unused')
          },
          async fork() {
            throw new Error('unused')
          },
          async sessions() {
            return []
          },
        }
      },
    }
    const app = render(
      <InteractiveApp
        factory={factory}
        initialSessions={[]}
        diffLoader={() => diffGate}
      />,
    )
    await flush()
    app.stdin.write('make an edit')
    await flush()
    app.stdin.write('\r')
    await flush()

    // Wait for the streaming turn to be visible before finalizing it.
    await waitFor(() => (app.lastFrame()?.includes('✳') ? true : undefined))

    // Complete the turn while the diff snapshot loader is still pending. The
    // committed assistant entry and the active stream must never render in the
    // same frame, so no published frame may contain the final text twice.
    releaseRun?.()
    await waitFor(() => (app.lastFrame()?.includes('⏺') ? true : undefined))
    const normalized = (frame: string | undefined) =>
      (frame ?? '').replace(/\s+/gu, '')
    const needle = normalized(finalText)
    for (const frame of app.stdout.frames) {
      expect(normalized(frame).split(needle).length - 1).toBeLessThanOrEqual(1)
    }

    releaseDiff?.()
    await waitFor(() => (app.lastFrame()?.includes('✳') ? undefined : true))
    expect(normalized(app.lastFrame())).toContain(needle)
  })

  it('toggles syntax highlighting in the theme picker and persists immediately', async () => {
    const saved: unknown[] = []
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            throw new Error('unused')
          },
        }}
        initialSessions={[]}
        initialThemeSettings={{
          theme: 'dark-daltonized',
          syntaxHighlightingDisabled: false,
        }}
        themeStore={{
          async load() {
            throw new Error('unused')
          },
          async save(update) {
            saved.push(update)
            return {
              theme: update.theme ?? 'dark-daltonized',
              syntaxHighlightingDisabled:
                update.syntaxHighlightingDisabled ?? false,
            }
          },
        }}
      />,
    )

    app.stdin.write('/theme')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain(
      'Syntax theme: Monokai Extended (ctrl+t to disable)',
    )
    app.stdin.write('\u0014')
    await flush()
    expect(saved).toEqual([{ syntaxHighlightingDisabled: true }])
    expect(app.lastFrame()).toContain(
      'Syntax highlighting disabled (ctrl+t to enable)',
    )
  })

  it('cancels theme selection without writing shared settings', async () => {
    const save = vi.fn(async () => ({
      theme: 'dark' as const,
      syntaxHighlightingDisabled: false,
    }))
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            throw new Error('unused')
          },
        }}
        initialSessions={[]}
        initialThemeSettings={{
          theme: 'dark',
          syntaxHighlightingDisabled: false,
        }}
        themeStore={{
          async load() {
            throw new Error('unused')
          },
          save,
        }}
      />,
    )

    app.stdin.write('/theme')
    app.stdin.write('\r')
    await flush()
    app.stdin.write('\u001B[B')
    await new Promise((resolve) => setTimeout(resolve, 75))
    await flush()
    app.stdin.write('\u001B')
    await new Promise((resolve) => setTimeout(resolve, 75))
    await flush()

    expect(save).not.toHaveBeenCalled()
    expect(app.lastFrame()).not.toContain('Choose the text style')
  })

  it('supports numeric profile selection and clamps theme navigation', async () => {
    const saved: string[] = []
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            throw new Error('unused')
          },
        }}
        initialSessions={[]}
        initialThemeSettings={{
          theme: 'auto',
          syntaxHighlightingDisabled: false,
        }}
        themeStore={{
          async load() {
            throw new Error('unused')
          },
          async save(update) {
            if (update.theme) saved.push(update.theme)
            return {
              theme: update.theme ?? 'auto',
              syntaxHighlightingDisabled:
                update.syntaxHighlightingDisabled ?? false,
            }
          },
        }}
      />,
    )

    app.stdin.write('/theme')
    app.stdin.write('\r')
    await flush()
    app.stdin.write('\u001B[A')
    app.stdin.write('7')
    await flush()
    expect(app.lastFrame()).toContain('Syntax theme: ansi')
    app.stdin.write('\u001B[B')
    app.stdin.write('\u001B[A')
    app.stdin.write('\r')
    await flush()
    expect(saved).toEqual(['light-ansi'])
  })

  it('announces the focused screen-reader theme while navigating', async () => {
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            throw new Error('unused')
          },
        }}
        initialSessions={[]}
        axScreenReader
        initialThemeSettings={{
          theme: 'dark',
          syntaxHighlightingDisabled: false,
        }}
        themeStore={{
          async load() {
            throw new Error('unused')
          },
          async save(update) {
            return {
              theme: update.theme ?? 'dark',
              syntaxHighlightingDisabled:
                update.syntaxHighlightingDisabled ?? false,
            }
          },
        }}
      />,
    )

    app.stdin.write('/theme')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('Selected: Dark mode')
    app.stdin.write('\u001B[B')
    await new Promise((resolve) => setTimeout(resolve, 75))
    await flush()
    expect(app.lastFrame()).toContain('Selected: Light mode')
    expect(app.lastFrame()).toContain('2. Dark mode (current)')
    expect(app.lastFrame()).toContain('3. Light mode (focused)')
    expect(app.lastFrame()).not.toContain('❯')
    expect(app.lastFrame()).not.toContain('✔')
  })

  it('surfaces theme load and save failures without changing the active profile', async () => {
    const loadFailure = render(
      <InteractiveApp
        factory={{
          async createService() {
            throw new Error('unused')
          },
        }}
        initialSessions={[]}
        themeStore={{
          async load() {
            throw new Error('bad theme file')
          },
          async save() {
            throw new Error('unused')
          },
        }}
      />,
    )
    await flush()
    expect(loadFailure.lastFrame()).toContain(
      'Unable to load theme settings: bad theme file',
    )
    loadFailure.unmount()

    const saveFailure = render(
      <InteractiveApp
        factory={{
          async createService() {
            throw new Error('unused')
          },
        }}
        initialSessions={[]}
        initialThemeSettings={{
          theme: 'dark',
          syntaxHighlightingDisabled: false,
        }}
        themeStore={{
          async load() {
            throw new Error('unused')
          },
          async save() {
            throw new Error('settings locked')
          },
        }}
      />,
    )
    saveFailure.stdin.write('/theme')
    saveFailure.stdin.write('\r')
    await flush()
    saveFailure.stdin.write('\u001B[B')
    saveFailure.stdin.write('\r')
    await flush()
    expect(saveFailure.lastFrame()).toContain('settings locked')
    expect(saveFailure.lastFrame()).toContain('2. Dark mode ✔')
  })

  it('uses native session names in the session picker', async () => {
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            return {
              async run() {
                throw new Error('unused')
              },
              async resume() {
                throw new Error('unused')
              },
              async fork() {
                throw new Error('unused')
              },
              async sessions() {
                return []
              },
            }
          },
        }}
        initialSessions={[
          {
            sessionId: 'named-session',
            name: 'Release review',
            lastPrompt: 'inspect the release',
            updatedAt: '2026-08-06T00:00:00.000Z',
            status: 'ready',
            issue: null,
          },
          {
            sessionId: 'other-session',
            name: 'Other work',
            lastPrompt: 'unrelated prompt',
            updatedAt: '2026-08-05T00:00:00.000Z',
            status: 'ready',
            issue: null,
          },
        ]}
      />,
    )
    await flush()
    expect(app.lastFrame()).toContain('Welcome to Praxis')
    expect(app.lastFrame()).not.toContain('Resume a session')
    app.stdin.write('/resume')
    await flush()
    app.stdin.write('\r')
    await flush()
    app.stdin.write('release')
    await flush()
    expect(app.lastFrame()).toContain('⌕ release')
    expect(app.lastFrame()).toContain('Release review · named-session')
    expect(app.lastFrame()).not.toContain('Other work')
    app.stdin.write('\r')
    await flush()
  })

  it('keeps an empty resume search open and cancels without changing session', async () => {
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            throw new Error('unused')
          },
        }}
        initialSessions={[
          {
            sessionId: 'named-session',
            name: 'Release review',
            lastPrompt: 'review release notes',
            updatedAt: '2026-08-06T00:00:00.000Z',
            status: 'ready',
            issue: null,
          },
        ]}
        resume={{ sessionId: 'named-session' }}
      />,
    )

    app.stdin.write('/resume')
    await flush()
    app.stdin.write('\r')
    await flush()
    app.stdin.write('missing')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('Resume session')
    expect(app.lastFrame()).toContain('No sessions found.')

    app.stdin.write('\u001B')
    await new Promise((resolve) => setTimeout(resolve, 75))
    await flush()
    expect(app.lastFrame()).not.toContain('Resume session')
    expect(app.lastFrame()).toContain('? for shortcuts')
  })

  it('ends the active hook session before selecting a resumed session', async () => {
    const transitions: string[] = []
    const sessions = [
      {
        sessionId: 'active-session',
        lastPrompt: 'active prompt',
        updatedAt: '2026-08-06T00:00:00.000Z',
        status: 'ready' as const,
        issue: null,
      },
      {
        sessionId: 'resumed-session',
        lastPrompt: 'resumed prompt',
        updatedAt: '2026-08-05T00:00:00.000Z',
        status: 'ready' as const,
        issue: null,
      },
    ]
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            return {
              async run() {
                throw new Error('unused')
              },
              async resume() {
                throw new Error('unused')
              },
              async fork() {
                throw new Error('unused')
              },
              async sessions() {
                return sessions
              },
              async transcript() {
                return []
              },
              async transitionHookSession(sessionId, reason) {
                transitions.push(`${sessionId}:${reason}`)
              },
            }
          },
        }}
        initialSessions={sessions}
        resume={{ sessionId: 'active-session' }}
      />,
    )

    app.stdin.write('/resume')
    app.stdin.write('\r')
    await flush()
    app.stdin.write('\u001B[B')
    app.stdin.write('\r')
    await flush()
    await flush()
    expect(transitions).toEqual(['active-session:resume'])
  })

  it('omits the new-session choice for a required filtered resume', async () => {
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            throw new Error('unused')
          },
        }}
        initialSessions={[
          {
            sessionId: 'linked-session',
            lastPrompt: 'linked prompt',
            updatedAt: '2026-08-08T00:00:00.000Z',
            status: 'ready',
            issue: null,
            prNumber: 42,
            prUrl: 'https://github.com/owner/repo/pull/42',
            prRepository: 'owner/repo',
          },
        ]}
        allowNewSession={false}
      />,
    )
    await flush()
    expect(app.lastFrame()).toContain('linked prompt · linked-session')
    expect(app.lastFrame()).not.toContain('New session')
  })

  it('keeps the picker for a non-ID resume search with one result', async () => {
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            return {
              async run() {
                throw new Error('unused')
              },
              async resume() {
                throw new Error('unused')
              },
              async fork() {
                throw new Error('unused')
              },
              async sessions() {
                return []
              },
            }
          },
        }}
        initialSessions={[
          {
            sessionId: 'resolved-session',
            name: 'Release review',
            lastPrompt: 'inspect release',
            updatedAt: '2026-08-08T00:00:00.000Z',
            status: 'ready',
            issue: null,
          },
        ]}
        allowNewSession={false}
        resume={{ sessionSelector: 'release', requireSession: true }}
      />,
    )
    await flush()
    expect(app.lastFrame()).toContain('Release review · resolved-session')
    expect(app.lastFrame()).not.toContain('New session')
  })

  it('lists live workflows without sending a model prompt', async () => {
    const factory: InteractiveServiceFactory = {
      async createService() {
        return {
          async run() {
            throw new Error('unused')
          },
          async resume() {
            throw new Error('unused')
          },
          async fork() {
            throw new Error('unused')
          },
          async sessions() {
            return []
          },
          workflows() {
            return [
              {
                task_id: 'w12345678',
                status: 'running',
                summary: 'Review repository',
              },
            ]
          },
        }
      },
    }
    const app = render(
      <InteractiveApp factory={factory} initialSessions={[]} />,
    )
    await flush()
    app.stdin.write('/workflows')
    await flush()
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('w12345678 [running] Review repository')
  })

  it('opens context, status, skills, and tasks as local TUI surfaces', async () => {
    let serviceCreations = 0
    const factory: InteractiveServiceFactory = {
      async createService() {
        serviceCreations += 1
        return {
          async run() {
            throw new Error('unused')
          },
          async resume() {
            throw new Error('unused')
          },
          async fork() {
            throw new Error('unused')
          },
          async sessions() {
            return []
          },
          workflows() {
            return [
              {
                task_id: 'task-1',
                status: 'running',
                summary: 'Audit TUI',
              },
            ]
          },
        }
      },
    }
    const app = render(
      <InteractiveApp
        factory={factory}
        initialSessions={[]}
        display={{
          version: '0.2.0',
          cwd: '/tmp/praxis',
          model: 'fixture-model',
          contextWindowTokens: 200_000,
        }}
        slashCommands={[
          {
            name: 'review',
            description: 'Review the current change.',
            source: 'skill',
          },
        ]}
      />,
    )

    app.stdin.write('/context')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('Free space')
    expect(app.lastFrame()).toContain('Loaded')
    expect(app.lastFrame()).toContain('review: ~')
    expect(serviceCreations).toBe(0)

    app.stdin.write('/status')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('Status  Config  Usage')
    expect(app.lastFrame()).toContain('fixture-model')
    expect(app.lastFrame()).toContain('/rename to add a name')
    expect(app.lastFrame()).toContain('Setting sources:')
    app.stdin.write('\u001B[C')
    await flush()
    expect(app.lastFrame()).toContain('Search settings')
    app.stdin.write('\u001B')
    await new Promise((resolve) => setTimeout(resolve, 75))
    await flush()

    app.stdin.write('/skills')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('Skills')
    expect(app.lastFrame()).toContain('Review the current change.')
    app.stdin.write('\u001B')
    await new Promise((resolve) => setTimeout(resolve, 75))
    await flush()

    app.stdin.write('/tasks')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('Background')
    expect(app.lastFrame()).toContain('task-1 [running] Audit TUI')
    app.stdin.write('')
    await new Promise((resolve) => setTimeout(resolve, 75))
    await flush()

    expect(serviceCreations).toBe(1)
  })

  it('opens command-specific config, usage, MCP, skill, and add-dir surfaces', async () => {
    let creations = 0
    let closes = 0
    const factory: InteractiveServiceFactory = {
      async createService() {
        creations += 1
        return {
          async run() {
            throw new Error('unused')
          },
          async resume() {
            throw new Error('unused')
          },
          async fork() {
            throw new Error('unused')
          },
          async sessions() {
            return []
          },
          runtimeInfo() {
            return {
              cwd: '/tmp/praxis',
              model: 'fixture-model',
              tools: [],
              mcpServers: [{ name: 'filesystem', status: 'connected' }],
              permissionMode: 'default',
              slashCommands: [],
              agents: [],
              skills: [],
              plugins: [],
              claudeCodeVersion: '2.1.208',
            }
          },
          async close() {
            closes += 1
          },
        }
      },
    }
    const app = render(
      <InteractiveApp
        factory={factory}
        initialSessions={[]}
        slashCommands={[
          {
            name: 'review',
            description: 'Review the current change.',
            source: 'skill',
          },
        ]}
        permissionRuleStore={{
          async load() {
            return []
          },
          async add() {},
        }}
      />,
    )

    app.stdin.write('/config')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('Config')
    expect(app.lastFrame()).toContain('Search settings')
    app.stdin.write('\u001B')
    await new Promise((resolve) => setTimeout(resolve, 75))

    app.stdin.write('/usage')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain(
      'Usage:                 0 input, 0 output, 0 cache read, 0 cache write',
    )
    app.stdin.write('\u001B')
    await new Promise((resolve) => setTimeout(resolve, 75))

    app.stdin.write('/skill')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('Review the current change.')
    app.stdin.write('\u001B')
    await new Promise((resolve) => setTimeout(resolve, 75))

    app.stdin.write('/mcp')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('MCP servers')
    expect(app.lastFrame()).toContain('filesystem')
    expect(app.lastFrame()).toContain('connected')
    app.stdin.write('\u001B')
    await new Promise((resolve) => setTimeout(resolve, 75))

    app.stdin.write('/reload-skills')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('Skills reloaded for this session.')
    expect(creations).toBe(2)
    expect(closes).toBe(1)

    app.stdin.write('/add-dir')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('Add directory to workspace')
    expect(app.lastFrame()).toContain('Tab to complete')
    app.stdin.write('\u001B')
    await new Promise((resolve) => setTimeout(resolve, 75))
    await flush()
    expect(app.lastFrame()).toContain('Did not add a working directory.')
  })

  it('shows release notes locally without creating a model session', async () => {
    let creations = 0
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            creations += 1
            throw new Error('unused')
          },
        }}
        initialSessions={[]}
        releaseNotesLoader={async () =>
          'Version 2.1.208:\n· Local release note'
        }
      />,
    )

    app.stdin.write('/release-notes')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('Version 2.1.208:')
    expect(app.lastFrame()).toContain('· Local release note')
    expect(creations).toBe(0)
  })

  it('navigates the read-only hooks event, matcher, and hook menus', async () => {
    const settings = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash|Write',
            hooks: [
              {
                type: 'command',
                command: 'echo check',
                statusMessage: 'Checking tool',
              },
              { type: 'prompt', prompt: 'Is this safe?' },
              { type: 'agent', prompt: 'Review this call' },
            ],
          },
          {
            hooks: [{ type: 'http', url: 'https://example.test/hook' }],
          },
        ],
      },
    }
    const original = JSON.stringify(settings)
    const creations: Array<{
      requireProvider: boolean
      hooksOnly?: boolean
      cwd?: string
    }> = []
    let closes = 0
    const factory: InteractiveServiceFactory = {
      async createService(options) {
        creations.push({
          requireProvider: options.requireProvider,
          ...(options.hooksOnly === undefined
            ? {}
            : { hooksOnly: options.hooksOnly }),
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        })
        return {
          async run() {
            throw new Error('unused')
          },
          async resume() {
            throw new Error('unused')
          },
          async fork() {
            throw new Error('unused')
          },
          async sessions() {
            return []
          },
          async hookConfiguration() {
            return projectTuiHooks([
              {
                path: '/shared/.claude/settings.json',
                scope: 'user',
                value: settings,
              },
            ])
          },
          async close() {
            closes += 1
          },
        }
      },
    }
    const app = render(
      <InteractiveApp
        factory={factory}
        initialSessions={[]}
        display={{ version: 'test', cwd: '/fixture/workspace' }}
      />,
    )

    app.stdin.write('/hooks')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('4 hooks configured')
    expect(app.lastFrame()).toContain('PreToolUse (4)')
    expect(app.lastFrame()).toContain('This menu is read-only')

    app.stdin.write('0')
    await flush()
    expect(app.lastFrame()).toContain('❯ 1. PreToolUse (4)')
    app.stdin.write('1')
    await flush()
    expect(app.lastFrame()).toContain('❯ 1. PreToolUse (4)')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('PreToolUse - Matchers')
    expect(app.lastFrame()).toContain('[User] (all) 1 hook')
    expect(app.lastFrame()).toContain('[User] Bash|Write 3 hooks')

    app.stdin.write('9')
    await flush()
    expect(app.lastFrame()).toContain('❯ 1. [User] (all) 1 hook')
    app.stdin.write('2')
    await flush()
    expect(app.lastFrame()).toContain('❯ 2. [User] Bash|Write 3 hooks')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('PreToolUse - Matcher: Bash|Write')
    expect(app.lastFrame()).toContain('[command] Checking tool')
    expect(app.lastFrame()).toContain('[prompt] Is this safe?')
    expect(app.lastFrame()).toContain('[agent] Review this call')
    expect(app.lastFrame()).toContain('User Settings')

    app.stdin.write('9')
    await flush()
    expect(app.lastFrame()).toContain('❯ 1. [command] Checking tool')
    app.stdin.write('3')
    await flush()
    expect(app.lastFrame()).toContain('❯ 3. [agent] Review this call')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('Hook details')
    expect(app.lastFrame()).toContain('Type: agent')
    expect(app.lastFrame()).toContain('Review this call')

    app.stdin.write('\u001B')
    await new Promise((resolve) => setTimeout(resolve, 75))
    await flush()
    expect(app.lastFrame()).toContain('PreToolUse - Matcher: Bash|Write')
    app.stdin.write('\u001B')
    await new Promise((resolve) => setTimeout(resolve, 75))
    await flush()
    expect(app.lastFrame()).toContain('PreToolUse - Matchers')
    app.stdin.write('\u001B')
    await new Promise((resolve) => setTimeout(resolve, 75))
    await flush()
    expect(app.lastFrame()).toContain('Hooks')
    app.stdin.write('\u001B')
    await new Promise((resolve) => setTimeout(resolve, 75))
    await flush()
    expect(app.lastFrame()).not.toContain('This menu is read-only')
    expect(JSON.stringify(settings)).toBe(original)
    expect(creations).toEqual([
      {
        requireProvider: false,
        hooksOnly: true,
        cwd: '/fixture/workspace',
      },
    ])
    expect(closes).toBe(1)
  })

  it('reloads provider-free hook projections after cwd and plugin changes', async () => {
    const creations: Array<{
      requireProvider: boolean
      hooksOnly?: boolean
      cwd?: string
    }> = []
    let hookGeneration = 0
    const factory: InteractiveServiceFactory = {
      async createService(options) {
        creations.push({
          requireProvider: options.requireProvider,
          ...(options.hooksOnly === undefined
            ? {}
            : { hooksOnly: options.hooksOnly }),
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        })
        if (!options.requireProvider) {
          hookGeneration += 1
          const count = hookGeneration
          return {
            async run() {
              throw new Error('unused')
            },
            async resume() {
              throw new Error('unused')
            },
            async fork() {
              throw new Error('unused')
            },
            async sessions() {
              return []
            },
            async hookConfiguration() {
              return projectTuiHooks([
                {
                  path: `/fixture/hooks-${count}.json`,
                  scope: 'project',
                  value: {
                    hooks: {
                      PreToolUse: [
                        {
                          hooks: Array.from({ length: count }, (_, index) => ({
                            type: 'command',
                            command: `generation-${count}-${index}`,
                          })),
                        },
                      ],
                    },
                  },
                },
              ])
            },
          }
        }
        return {
          async run() {
            throw new Error('unused')
          },
          async resume() {
            throw new Error('unused')
          },
          async fork() {
            throw new Error('unused')
          },
          async sessions() {
            return []
          },
          async changeCwd() {
            return '/fixture/next'
          },
          async close() {},
        }
      },
    }
    const app = render(
      <InteractiveApp
        factory={factory}
        initialSessions={[]}
        display={{ version: 'test', cwd: '/fixture/initial' }}
      />,
    )

    app.stdin.write('/hooks')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('1 hooks configured')
    app.stdin.write('\u001B')
    await new Promise((resolve) => setTimeout(resolve, 75))

    app.stdin.write('/cd next')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('Moved to /fixture/next')
    app.stdin.write('/hooks')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('2 hooks configured')
    app.stdin.write('\u001B')
    await new Promise((resolve) => setTimeout(resolve, 75))

    app.stdin.write('/reload-plugins')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('Plugin changes activated')
    app.stdin.write('/hooks')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('3 hooks configured')

    expect(creations.filter((creation) => !creation.requireProvider)).toEqual([
      {
        requireProvider: false,
        hooksOnly: true,
        cwd: '/fixture/initial',
      },
      {
        requireProvider: false,
        hooksOnly: true,
        cwd: '/fixture/next',
      },
      {
        requireProvider: false,
        hooksOnly: true,
        cwd: '/fixture/next',
      },
    ])
  })

  it('copies the selected prior assistant response without a model turn', async () => {
    const clipboardWriter = vi.fn(async () => undefined)
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            throw new Error('unused')
          },
        }}
        initialSessions={[]}
        initialHistory={[
          { kind: 'assistant', text: 'older answer' },
          { kind: 'assistant', text: 'latest answer' },
        ]}
        clipboardWriter={clipboardWriter}
      />,
    )

    app.stdin.write('/copy 2')
    app.stdin.write('\r')
    await flush()
    expect(clipboardWriter).toHaveBeenCalledWith('older answer')
    await waitFor(() =>
      app.lastFrame()?.includes('Copied to clipboard (12 characters, 1 lines)')
        ? true
        : undefined,
    )
  })

  it('opens the /copy picker for fenced code and copies the selected block', async () => {
    const clipboardWriter = vi.fn(async () => undefined)
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            throw new Error('unused')
          },
        }}
        initialSessions={[]}
        initialHistory={[
          {
            kind: 'assistant',
            text: 'Result:\n```ts\nconst answer = 42\n```',
          },
        ]}
        clipboardWriter={clipboardWriter}
      />,
    )

    app.stdin.write('/copy')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('Select content to copy:')
    expect(app.lastFrame()).toContain('Always copy full response')
    expect(clipboardWriter).not.toHaveBeenCalled()

    app.stdin.write('\u001B[B')
    app.stdin.write('\r')
    await flush()
    expect(clipboardWriter).toHaveBeenCalledWith('const answer = 42')
  })

  it('writes the focused /copy candidate with w without using the clipboard', async () => {
    const path = join(tmpdir(), 'claude', 'copy.praxisstage132')
    const clipboardWriter = vi.fn(async () => undefined)
    try {
      const app = render(
        <InteractiveApp
          factory={{
            async createService() {
              throw new Error('unused')
            },
          }}
          initialSessions={[]}
          initialHistory={[
            {
              kind: 'assistant',
              text: '```praxisstage132\nwrite-only candidate\n```',
            },
          ]}
          clipboardWriter={clipboardWriter}
        />,
      )

      app.stdin.write('/copy')
      app.stdin.write('\r')
      await flush()
      app.stdin.write('\u001B[B')
      app.stdin.write('w')
      await waitFor(() =>
        app.lastFrame()?.includes(`Written to ${path}`) ? true : undefined,
      )
      expect(await readFile(path, 'utf8')).toBe('write-only candidate')
      expect(clipboardWriter).not.toHaveBeenCalled()
    } finally {
      await rm(path, { force: true })
    }
  })

  it('persists the /copy always-full preference', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-copy-settings-'))
    try {
      const clipboardWriter = vi.fn(async () => undefined)
      const app = render(
        <InteractiveApp
          factory={{
            async createService() {
              throw new Error('unused')
            },
          }}
          initialSessions={[]}
          initialHistory={[{ kind: 'assistant', text: '```js\nanswer()\n```' }]}
          clipboardWriter={clipboardWriter}
          runtimeSettingsTarget={root}
        />,
      )

      app.stdin.write('/copy')
      app.stdin.write('\r')
      await flush()
      app.stdin.write('\u001B[B\u001B[B')
      app.stdin.write('\r')
      await waitFor(() =>
        app.lastFrame()?.includes('Preference saved.') ? true : undefined,
      )
      expect(
        JSON.parse(await readFile(join(root, '.claude.json'), 'utf8')),
      ).toMatchObject({ copyFullResponse: true })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('exports the complete conversation to the clipboard or a file', async () => {
    const clipboardWriter = vi.fn<(text: string) => Promise<void>>(async () =>
      Promise.resolve(),
    )
    const exportWriter = vi.fn<(path: string, text: string) => Promise<void>>(
      async () => Promise.resolve(),
    )
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            throw new Error('unused')
          },
        }}
        initialSessions={[]}
        initialHistory={[
          { kind: 'user', text: 'Inspect the repository' },
          { kind: 'assistant', text: 'Everything is clean.' },
        ]}
        display={{ version: '0.2.0', cwd: '/workspace' }}
        clipboardWriter={clipboardWriter}
        exportWriter={exportWriter}
      />,
    )

    app.stdin.write('/export')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('Export conversation')
    expect(app.lastFrame()).toContain('Copy to clipboard')
    expect(app.lastFrame()).toContain('Save to file')

    app.stdin.write('\r')
    await flush()
    expect(clipboardWriter).toHaveBeenCalledOnce()
    expect(clipboardWriter.mock.calls[0]?.[0]).toContain(
      '❯ Inspect the repository',
    )
    expect(clipboardWriter.mock.calls[0]?.[0]).toContain(
      '⏺ Everything is clean.',
    )
    expect(app.lastFrame()).toContain('Conversation copied to clipboard')

    app.stdin.write('/export')
    app.stdin.write('\r')
    await flush()
    app.stdin.write('\u001B[B')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('Enter filename:')
    expect(app.lastFrame()).toContain('praxis-conversation.txt')

    app.stdin.write('\u001B')
    await new Promise((resolve) => setTimeout(resolve, 75))
    await flush()
    expect(app.lastFrame()).toContain('Export conversation')
    expect(app.lastFrame()).toContain('Save to file')
    app.stdin.write('\u001B')
    await new Promise((resolve) => setTimeout(resolve, 75))
    await flush()
    expect(app.lastFrame()).not.toContain('Export conversation')

    app.stdin.write('/export')
    app.stdin.write('\r')
    await flush()
    app.stdin.write('\u001B[B')
    app.stdin.write('\r')
    await flush()

    app.stdin.write('\r')
    await flush()
    expect(exportWriter).toHaveBeenCalledOnce()
    expect(exportWriter.mock.calls[0]?.[0]).toMatch(
      /^\/workspace\/\d{4}-\d{2}-\d{2}-\d{6}-praxis-conversation\.txt$/u,
    )
    expect(exportWriter.mock.calls[0]?.[1]).toContain('❯ /export')
    expect(app.lastFrame()).toContain('Conversation exported to: /workspace/')
  })

  it('manually compacts the active conversation and exposes its summary', async () => {
    let finishCompact:
      | ((value: {
          summary: string
          usage: { inputTokens: number; outputTokens: number }
          preTokens: number
        }) => void)
      | undefined
    const compacted = new Promise<{
      summary: string
      usage: { inputTokens: number; outputTokens: number }
      preTokens: number
    }>((resolve) => {
      finishCompact = resolve
    })
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            return {
              async run() {
                throw new Error('unused')
              },
              async resume() {
                throw new Error('unused')
              },
              async fork() {
                throw new Error('unused')
              },
              async sessions() {
                return []
              },
              async compact() {
                return compacted
              },
              async transcript() {
                return [
                  {
                    kind: 'compact' as const,
                    summary: 'durable compact summary',
                  },
                ]
              },
            }
          },
        }}
        initialSessions={[]}
        initialHistory={[
          { kind: 'user', text: 'old task' },
          { kind: 'assistant', text: 'old answer' },
        ]}
        resume={{ sessionId: 'compact-session' }}
      />,
    )

    app.stdin.write('/compact')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('Compacting conversation…')
    expect(app.lastFrame()).toContain('▱')

    finishCompact?.({
      summary: 'durable compact summary',
      usage: { inputTokens: 12, outputTokens: 4 },
      preTokens: 40,
    })
    await flush()
    expect(app.lastFrame()).toContain('Conversation compacted')
    expect(app.lastFrame()).toContain('/compact')
    expect(app.lastFrame()).toContain('Compacted (ctrl+o to see full summary)')
    expect(app.lastFrame()).not.toContain('durable compact summary')

    app.stdin.write('\u000F')
    await flush()
    expect(app.lastFrame()).toContain('durable compact summary')
  })

  it('shows /cd usage without changing cwd', async () => {
    const changeCwd = vi.fn()
    const recordCdUsage = vi.fn()
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            return {
              async run() {
                throw new Error('unused')
              },
              async resume() {
                throw new Error('unused')
              },
              async fork() {
                throw new Error('unused')
              },
              async sessions() {
                return []
              },
              changeCwd,
              recordCdUsage,
            }
          },
        }}
        initialSessions={[]}
        resume={{ sessionId: 'active-session' }}
      />,
    )

    app.stdin.write('/cd')
    app.stdin.write('\r')
    await flush()

    expect(app.lastFrame()).toContain('Usage: /cd <path>')
    expect(changeCwd).not.toHaveBeenCalled()
    expect(recordCdUsage).toHaveBeenCalledWith('active-session')
  })

  it('shows native /btw usage without starting a model turn', async () => {
    const recordBtwUsage = vi.fn(async () => 'active-session')
    const answerSideQuestion = vi.fn()
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            return {
              async run() {
                throw new Error('unused')
              },
              async resume() {
                throw new Error('unused')
              },
              async fork() {
                throw new Error('unused')
              },
              async sessions() {
                return []
              },
              recordBtwUsage,
              answerSideQuestion,
            }
          },
        }}
        initialSessions={[]}
        resume={{ sessionId: 'active-session' }}
      />,
    )

    app.stdin.write('/btw')
    app.stdin.write('\r')
    await flush()

    expect(app.lastFrame()).toContain('Usage: /btw <your question>')
    expect(recordBtwUsage).toHaveBeenCalledWith('active-session', 'default')
    expect(answerSideQuestion).not.toHaveBeenCalled()
  })

  it('dispatches /color with a named color without a provider call', async () => {
    const recordColorUsage = vi.fn(async () => 'color-session')
    const recordBackgroundUsage = vi.fn(async () => 'background-session')
    const app = render(
      <InteractiveApp
        factory={{
          async createService(options) {
            expect(options.requireProvider).toBe(false)
            return {
              async run() {
                throw new Error('unused')
              },
              async resume() {
                throw new Error('unused')
              },
              async fork() {
                throw new Error('unused')
              },
              async sessions() {
                return []
              },
              recordColorUsage,
              recordBackgroundUsage,
            }
          },
        }}
        initialSessions={[]}
        resume={{ sessionId: 'active-session' }}
      />,
    )

    app.stdin.write('/color purple')
    await flush()
    app.stdin.write('\r')
    await flush()

    expect(app.lastFrame()).toContain('/color purple')
    expect(app.lastFrame()).toContain('Session color set to: purple')
    expect(recordColorUsage).toHaveBeenCalledWith(
      'active-session',
      { kind: 'color', color: 'purple' },
      '/color purple',
      'default',
    )

    app.stdin.write('/background')
    await flush()
    app.stdin.write('\r')
    await flush()
    expect(recordBackgroundUsage).toHaveBeenCalledWith(
      'color-session',
      'default',
    )
  })

  it('assigns a random session color for a bare /color command', async () => {
    const recordColorUsage = vi.fn<
      (
        sessionId: string | undefined,
        selection: AgentColorSelection,
        display: string,
        permissionMode: ClaudePermissionMode,
      ) => Promise<string>
    >(async () => 'color-session')
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            return {
              async run() {
                throw new Error('unused')
              },
              async resume() {
                throw new Error('unused')
              },
              async fork() {
                throw new Error('unused')
              },
              async sessions() {
                return []
              },
              recordColorUsage,
            }
          },
        }}
        initialSessions={[]}
      />,
    )

    app.stdin.write('/color')
    await flush()
    app.stdin.write('\r')
    await flush()

    const selection = recordColorUsage.mock.calls[0]?.[1]
    if (selection?.kind !== 'color') {
      throw new Error('expected a random color selection')
    }
    expect(AGENT_COLORS).toContain(selection.color)
    expect(app.lastFrame()).toContain(
      `Session color set to: ${selection.color}`,
    )
    expect(recordColorUsage).toHaveBeenCalledWith(
      undefined,
      selection,
      '/color',
      'default',
    )
  })

  it('reports invalid colors with the normalized input and no color change', async () => {
    const recordColorUsage = vi.fn(async () => 'color-session')
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            return {
              async run() {
                throw new Error('unused')
              },
              async resume() {
                throw new Error('unused')
              },
              async fork() {
                throw new Error('unused')
              },
              async sessions() {
                return []
              },
              recordColorUsage,
            }
          },
        }}
        initialSessions={[]}
        resume={{ sessionId: 'active-session' }}
      />,
    )

    app.stdin.write('/color Bogus')
    await flush()
    app.stdin.write('\r')
    await flush()

    expect(app.lastFrame()).toContain('/color Bogus')
    expect(app.lastFrame()).toContain(
      'Invalid color "bogus". Available colors: red, blue, green, yellow, purple, orange, pink, cyan',
    )
    expect(app.lastFrame()).toContain('default')
    expect(recordColorUsage).toHaveBeenCalledWith(
      'active-session',
      { kind: 'invalid', input: 'bogus' },
      '/color Bogus',
      'default',
    )
  })

  it('resets the session color from a reset alias', async () => {
    const recordColorUsage = vi.fn(async () => 'color-session')
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            return {
              async run() {
                throw new Error('unused')
              },
              async resume() {
                throw new Error('unused')
              },
              async fork() {
                throw new Error('unused')
              },
              async sessions() {
                return []
              },
              recordColorUsage,
            }
          },
        }}
        initialSessions={[]}
        resume={{ sessionId: 'active-session' }}
      />,
    )

    app.stdin.write('/color reset')
    await flush()
    app.stdin.write('\r')
    await flush()

    expect(app.lastFrame()).toContain('Session color reset to default')
    expect(recordColorUsage).toHaveBeenCalledWith(
      'active-session',
      { kind: 'reset' },
      '/color reset',
      'default',
    )
  })

  it('loads the effective color when opening a session from the picker', async () => {
    const agentColor = vi.fn(async () => 'orange' as const)
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            return {
              async run() {
                throw new Error('unused')
              },
              async resume() {
                throw new Error('unused')
              },
              async fork() {
                throw new Error('unused')
              },
              async sessions() {
                return []
              },
              agentColor,
            }
          },
        }}
        initialSessions={[
          {
            sessionId: 'pick-session',
            lastPrompt: 'release work',
            updatedAt: '2026-08-11T00:00:00.000Z',
            status: 'ready',
            issue: null,
          },
        ]}
      />,
    )
    await flush()
    app.stdin.write('/resume')
    await flush()
    app.stdin.write('\r')
    await flush()
    app.stdin.write('pick')
    await flush()
    app.stdin.write('\r')
    await flush()

    expect(agentColor).toHaveBeenCalledWith('pick-session')
  })

  it('records native /background rejection for a session without a model turn', async () => {
    const recordBackgroundUsage = vi.fn(async () => 'empty-session')
    const onBackground = vi.fn()
    const app = render(
      <InteractiveApp
        factory={{
          async createService(options) {
            expect(options.requireProvider).toBe(false)
            return {
              async run() {
                throw new Error('unused')
              },
              async resume() {
                throw new Error('unused')
              },
              async fork() {
                throw new Error('unused')
              },
              async sessions() {
                return []
              },
              recordBackgroundUsage,
            }
          },
        }}
        initialSessions={[]}
        slashCommands={[
          {
            name: 'tasks',
            description: 'View background work',
            source: 'builtin',
          },
        ]}
        onBackground={onBackground}
      />,
    )

    app.stdin.write('/background')
    await flush()
    app.stdin.write('\r')
    await flush()

    expect(app.lastFrame()).toContain(
      'Nothing to background yet — send a message first.',
    )
    expect(recordBackgroundUsage).toHaveBeenCalledWith(undefined, 'default')
    expect(onBackground).not.toHaveBeenCalled()
  })

  it('rejects /background when an interrupted turn only reached thinking and tools', async () => {
    const recordBackgroundUsage = vi.fn(async () => 'interrupted-session')
    const onBackground = vi.fn()
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            return {
              async run() {
                throw new Error('unused')
              },
              async resume() {
                throw new Error('unused')
              },
              async fork() {
                throw new Error('unused')
              },
              async sessions() {
                return []
              },
              recordBackgroundUsage,
            }
          },
        }}
        initialSessions={[]}
        initialHistory={[
          { kind: 'user', text: 'source prompt' },
          { kind: 'thinking', text: 'partial reasoning' },
          {
            kind: 'tool',
            call: { id: 'call-1', name: 'Read', input: { file_path: 'a.ts' } },
            detail: 'a.ts',
          },
          { kind: 'notice', text: 'Interrupted by user.' },
        ]}
        resume={{ sessionId: 'interrupted-session' }}
        onBackground={onBackground}
      />,
    )

    app.stdin.write('/background')
    app.stdin.write('\r')
    await flush()

    expect(app.lastFrame()).toContain(
      'Nothing to background yet — send a message first.',
    )
    expect(recordBackgroundUsage).toHaveBeenCalledWith(
      'interrupted-session',
      'default',
    )
    expect(onBackground).not.toHaveBeenCalled()
  })

  it('backgrounds a completed conversation through the native handoff seam', async () => {
    let finishBackground:
      ((value: { id: string; sessionId: string }) => void) | undefined
    const recordBackgroundLaunch = vi.fn(async () => ({
      resumeSessionAt: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      entryCount: 4,
    }))
    const onBackground = vi.fn(
      () =>
        new Promise<{ id: string; sessionId: string }>((resolve) => {
          finishBackground = resolve
        }),
    )
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            return {
              async run() {
                throw new Error('unused')
              },
              async resume() {
                throw new Error('unused')
              },
              async fork() {
                throw new Error('unused')
              },
              async sessions() {
                return []
              },
              recordBackgroundLaunch,
            }
          },
        }}
        initialSessions={[]}
        initialHistory={[
          { kind: 'user', text: 'source prompt' },
          { kind: 'assistant', text: 'source answer' },
        ]}
        resume={{ sessionId: 'source-session' }}
        display={{ version: 'test', cwd: '/workspace' }}
        onBackground={onBackground}
      />,
    )

    app.stdin.write('/background')
    app.stdin.write('\r')
    await flush()

    expect(app.lastFrame()).toContain('Backgrounding…')
    expect(recordBackgroundLaunch).toHaveBeenCalledWith('source-session')
    await expect.poll(() => onBackground.mock.calls.length).toBe(1)
    expect(onBackground).toHaveBeenCalledWith({
      sourceSessionId: 'source-session',
      sourceCheckpoint: {
        resumeSessionAt: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        entryCount: 4,
      },
      prompt: 'source prompt',
      detail: 'source answer',
      cwd: '/workspace',
    })

    finishBackground?.({
      id: 'abcd1234',
      sessionId: 'abcd1234-1111-4111-8111-111111111111',
    })
    await flush()
  })

  it('keeps the TUI usable when /background launch fails', async () => {
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            return {
              async run() {
                throw new Error('unused')
              },
              async resume() {
                throw new Error('unused')
              },
              async fork() {
                throw new Error('unused')
              },
              async sessions() {
                return []
              },
              async recordBackgroundLaunch() {
                return {
                  resumeSessionAt: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                  entryCount: 4,
                }
              },
            }
          },
        }}
        initialSessions={[]}
        initialHistory={[
          { kind: 'user', text: 'source prompt' },
          { kind: 'assistant', text: 'source answer' },
        ]}
        resume={{ sessionId: 'source-session' }}
        onBackground={async () => {
          throw new Error('background launch failed')
        }}
      />,
    )

    app.stdin.write('/background')
    app.stdin.write('\r')
    await flush()

    await expect
      .poll(() => app.lastFrame() ?? '')
      .toContain('background launch failed')
    expect(app.lastFrame()).toContain('? for shortcuts')
  })

  it('streams /btw answers and manages history, copy, and clear locally', async () => {
    const clipboardWriter = vi.fn(async () => undefined)
    const questions: string[] = []
    const sideUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUsd: 0,
    }
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            return {
              async run() {
                throw new Error('unused')
              },
              async resume() {
                throw new Error('unused')
              },
              async fork() {
                throw new Error('unused')
              },
              async sessions() {
                return []
              },
              async answerSideQuestion(_sessionId, question, _signal, onDelta) {
                questions.push(question)
                const answer = question === 'first?' ? 'FIRST' : 'SECOND'
                onDelta?.(answer.slice(0, 2))
                onDelta?.(answer.slice(2))
                sideUsage.inputTokens += 2
                sideUsage.outputTokens += 1
                return {
                  sessionId: 'active-session',
                  text: answer,
                  usage: { inputTokens: 2, outputTokens: 1 },
                }
              },
              async costSnapshot(sessionId) {
                return {
                  sessionId,
                  totalCostUsd: sideUsage.costUsd,
                  apiDurationMs: 0,
                  apiDurationWithoutRetriesMs: 0,
                  toolDurationMs: 0,
                  wallDurationMs: 0,
                  linesAdded: 0,
                  linesRemoved: 0,
                  hasUnknownModelCost: false,
                  modelUsage: {
                    'claude-sonnet-4-20250514': { ...sideUsage },
                  },
                }
              },
            }
          },
        }}
        initialSessions={[]}
        resume={{ sessionId: 'active-session' }}
        sideQuestionClipboardWriter={clipboardWriter}
      />,
    )

    app.stdin.write('/btw first?')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('/btw first?')
    expect(app.lastFrame()).toContain('FIRST')
    expect(app.lastFrame()).toContain('c to copy')

    app.stdin.write('\u001B')
    await new Promise((resolve) => setTimeout(resolve, 75))
    app.stdin.write('/btw second?')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('/btw first?')
    expect(app.lastFrame()).toContain('/btw second?')
    expect(app.lastFrame()).toContain('SECOND')
    expect(app.lastFrame()).toContain('←/→ to switch')

    app.stdin.write('\u001B[D')
    await flush()
    expect(app.lastFrame()).toContain('FIRST')
    app.stdin.write('c')
    await flush()
    expect(clipboardWriter).toHaveBeenCalledWith('FIRST')
    expect(app.lastFrame()).toContain('Copied to clipboard')

    app.stdin.write('x')
    await flush()
    expect(app.lastFrame()).toContain('/btw first?')
    expect(app.lastFrame()).not.toContain('/btw second?')
    expect(questions).toEqual(['first?', 'second?'])

    app.stdin.write('\u001B')
    await new Promise((resolve) => setTimeout(resolve, 75))
    app.stdin.write('/usage')
    app.stdin.write('\r')
    await waitFor(() =>
      app.lastFrame()?.includes('4 input, 2 output') ? true : undefined,
    )
    expect(app.lastFrame()).toContain(
      'claude-sonnet-4-0:  4 input, 2 output, 0 cache read, 0 cache write ($0.0000)',
    )
  })

  it('keeps a fresh /btw session for later fork and accumulates its cost', async () => {
    const forkSideQuestion = vi.fn(async () => ({
      agentId: 'a123456789abcdef',
      name: 'fresh-question',
    }))
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            return {
              async run() {
                throw new Error('unused')
              },
              async resume() {
                throw new Error('unused')
              },
              async fork() {
                throw new Error('unused')
              },
              async sessions() {
                return []
              },
              async answerSideQuestion() {
                return {
                  sessionId: 'fresh-session',
                  text: 'ANSWER',
                  usage: { inputTokens: 2, outputTokens: 1 },
                  costUsd: 0.000321,
                }
              },
              async costSnapshot(sessionId) {
                return {
                  sessionId,
                  totalCostUsd: 0.000321,
                  apiDurationMs: 0,
                  apiDurationWithoutRetriesMs: 0,
                  toolDurationMs: 0,
                  wallDurationMs: 0,
                  linesAdded: 0,
                  linesRemoved: 0,
                  hasUnknownModelCost: false,
                  modelUsage: {
                    'claude-sonnet-4-20250514': {
                      inputTokens: 2,
                      outputTokens: 1,
                      cacheReadInputTokens: 0,
                      cacheCreationInputTokens: 0,
                      webSearchRequests: 0,
                      costUsd: 0.000321,
                    },
                  },
                }
              },
              forkSideQuestion,
            }
          },
        }}
        initialSessions={[]}
      />,
    )

    app.stdin.write('/btw fresh question')
    app.stdin.write('\r')
    await flush()
    app.stdin.write('f')
    app.stdin.write('f')
    await flush()

    expect(forkSideQuestion).toHaveBeenCalledWith(
      'fresh-session',
      'fresh question',
    )
    app.stdin.write('\u001B')
    await new Promise((resolve) => setTimeout(resolve, 75))
    app.stdin.write('/usage')
    app.stdin.write('\r')
    await waitFor(() =>
      app.lastFrame()?.includes('($0.0003)') ? true : undefined,
    )
    expect(app.lastFrame()).toContain('($0.0003)')
  })

  it('aborts an in-flight /btw answer when its panel closes', async () => {
    let aborted = false
    let calls = 0
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            return {
              async run() {
                throw new Error('unused')
              },
              async resume() {
                throw new Error('unused')
              },
              async fork() {
                throw new Error('unused')
              },
              async sessions() {
                return []
              },
              async answerSideQuestion(_sessionId, _question, signal, onDelta) {
                calls += 1
                if (calls > 1) {
                  onDelta?.('NEXT')
                  return {
                    sessionId: 'active-session',
                    text: 'NEXT',
                    usage: { inputTokens: 1, outputTokens: 1 },
                  }
                }
                await new Promise<void>((resolve) =>
                  signal?.addEventListener(
                    'abort',
                    () => {
                      aborted = true
                      resolve()
                    },
                    { once: true },
                  ),
                )
                return {
                  sessionId: 'active-session',
                  text: '',
                  usage: { inputTokens: 0, outputTokens: 0 },
                }
              },
            }
          },
        }}
        initialSessions={[]}
        resume={{ sessionId: 'active-session' }}
      />,
    )

    app.stdin.write('/btw wait')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('Answering…')
    app.stdin.write('\u001B')
    await new Promise((resolve) => setTimeout(resolve, 75))
    await flush()
    expect(aborted).toBe(true)
    expect(app.lastFrame()).not.toContain('/btw wait')

    app.stdin.write('/btw next')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('NEXT')
    app.stdin.write('\u001B[D')
    await flush()
    expect(app.lastFrame()).toContain('Cancelled')
  })

  it('forks a completed /btw answer through the native Agent command', async () => {
    const forkSideQuestion = vi.fn(async () => ({
      agentId: 'a123456789abcdef',
      name: 'reply-with-third',
    }))
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            return {
              async run() {
                throw new Error('unused')
              },
              async resume() {
                throw new Error('unused')
              },
              async fork() {
                throw new Error('unused')
              },
              async sessions() {
                return []
              },
              async answerSideQuestion(
                _sessionId,
                _question,
                _signal,
                onDelta,
              ) {
                onDelta?.('THIRD')
                return {
                  sessionId: 'active-session',
                  text: 'THIRD',
                  usage: { inputTokens: 2, outputTokens: 1 },
                }
              },
              forkSideQuestion,
            }
          },
        }}
        initialSessions={[]}
        resume={{ sessionId: 'active-session' }}
      />,
    )

    app.stdin.write('/btw Reply with THIRD only.')
    app.stdin.write('\r')
    await flush()
    app.stdin.write('f')
    app.stdin.write('f')
    await flush()

    expect(forkSideQuestion).toHaveBeenCalledWith(
      'active-session',
      'Reply with THIRD only.',
    )
    expect(forkSideQuestion).toHaveBeenCalledOnce()
    expect(app.lastFrame()).toContain('⑂ forked reply-with-third (cdef)')
    expect(app.lastFrame()).not.toContain('f to fork')
  })

  it('changes cwd and preserves it when recreating the interactive service', async () => {
    const creations: Array<string | undefined> = []
    const changes: Array<[string | undefined, string]> = []
    const resumes: string[] = []
    const factory: InteractiveServiceFactory = {
      async createService(options) {
        creations.push(options.cwd)
        return {
          async run() {
            throw new Error('unused')
          },
          async resume(_sessionId, prompt) {
            resumes.push(prompt)
            return {
              sessionId: 'active-session',
              text: 'continued',
              usage: { inputTokens: 1, outputTokens: 1 },
            }
          },
          async fork() {
            throw new Error('unused')
          },
          async sessions() {
            return []
          },
          async changeCwd(sessionId, cwd) {
            changes.push([sessionId, cwd])
            return '/canonical/next'
          },
          async close() {},
        }
      },
    }
    const app = render(
      <InteractiveApp
        factory={factory}
        initialSessions={[]}
        resume={{ sessionId: 'active-session' }}
        display={{ version: 'test', cwd: '/workspace' }}
      />,
    )

    app.stdin.write('/cd ../next')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('Moved to /canonical/next')
    expect(changes).toEqual([['active-session', '../next']])

    app.stdin.write('continue')
    app.stdin.write('\r')
    await flush()
    expect(creations).toEqual(['/workspace', '/canonical/next'])
    expect(resumes).toEqual(['continue'])
  })

  it('keeps the previous cwd and service when /cd fails', async () => {
    const creations: Array<string | undefined> = []
    const resumes: string[] = []
    const factory: InteractiveServiceFactory = {
      async createService(options) {
        creations.push(options.cwd)
        return {
          async run() {
            throw new Error('unused')
          },
          async resume(_sessionId, prompt) {
            resumes.push(prompt)
            return {
              sessionId: 'active-session',
              text: 'continued',
              usage: { inputTokens: 1, outputTokens: 1 },
            }
          },
          async fork() {
            throw new Error('unused')
          },
          async sessions() {
            return []
          },
          async changeCwd() {
            throw new Error('Directory does not exist')
          },
        }
      },
    }
    const app = render(
      <InteractiveApp
        factory={factory}
        initialSessions={[]}
        resume={{ sessionId: 'active-session' }}
        display={{ version: 'test', cwd: '/workspace' }}
      />,
    )

    app.stdin.write('/cd missing')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('Directory does not exist')

    app.stdin.write('continue')
    app.stdin.write('\r')
    await flush()
    expect(creations).toEqual(['/workspace'])
    expect(resumes).toEqual(['continue'])
  })

  it('cancels manual compaction from its progress panel', async () => {
    let aborted = false
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            return {
              async run() {
                throw new Error('unused')
              },
              async resume() {
                throw new Error('unused')
              },
              async fork() {
                throw new Error('unused')
              },
              async sessions() {
                return []
              },
              async compact(_sessionId, signal) {
                await new Promise<void>((_resolve, reject) => {
                  signal?.addEventListener(
                    'abort',
                    () => {
                      aborted = true
                      reject(new Error('provider aborted'))
                    },
                    { once: true },
                  )
                })
                throw new Error('unreachable')
              },
            }
          },
        }}
        initialSessions={[]}
        initialHistory={[{ kind: 'user', text: 'old task' }]}
        resume={{ sessionId: 'compact-session' }}
      />,
    )

    app.stdin.write('/compact')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('Compacting conversation…')
    app.stdin.write('\u001B')
    await new Promise((resolve) => setTimeout(resolve, 75))
    await flush()
    expect(aborted).toBe(true)
    expect(app.lastFrame()).not.toContain('Compacting conversation…')
  })

  it('rewinds code and forks the conversation before a selected message', async () => {
    const calls: string[] = []
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            return {
              async run() {
                throw new Error('unused')
              },
              async resume() {
                throw new Error('unused')
              },
              async fork(sessionId, _targetSessionId, resumeSessionAt) {
                calls.push(`fork:${sessionId}:${resumeSessionAt}`)
                return {
                  parentSessionId: sessionId,
                  sessionId: 'rewound-session',
                }
              },
              async rename(sessionId, name) {
                calls.push(`rename:${sessionId}:${name}`)
              },
              async sessions() {
                return [
                  {
                    sessionId: 'original-session',
                    name: 'original-title',
                    lastPrompt: 'change the file',
                    updatedAt: '2026-08-11T00:00:00.000Z',
                    status: 'ready' as const,
                    issue: null,
                  },
                ]
              },
              async rewindPoints() {
                return [
                  {
                    messageId: 'first-user',
                    prompt: 'inspect the file',
                    fileChanges: [],
                    fileRestoreAvailable: true,
                  },
                  {
                    messageId: 'second-user',
                    branchMessageId: 'first-assistant',
                    prompt: 'change the file',
                    fileChanges: ['/workspace/changed.ts'],
                    fileRestoreAvailable: true,
                  },
                ]
              },
              async rewindFiles(sessionId, messageId) {
                calls.push(`files:${sessionId}:${messageId}`)
              },
              async transcript(sessionId) {
                calls.push(`transcript:${sessionId}`)
                return [
                  { kind: 'user' as const, text: 'inspect the file' },
                  { kind: 'assistant' as const, text: 'inspection complete' },
                ]
              },
            }
          },
        }}
        initialSessions={[]}
        initialHistory={[
          { kind: 'user', text: 'change the file' },
          { kind: 'assistant', text: 'changed' },
        ]}
        resume={{ sessionId: 'original-session' }}
        display={{ version: '0.2.0', cwd: '/workspace' }}
      />,
    )

    app.stdin.write('/rewind')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('Restore the code and/or conversation')
    expect(app.lastFrame()).toContain('changed.ts')
    expect(app.lastFrame()).toContain('(current)')

    app.stdin.write('\u001B[A')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('Restore code and conversation')
    expect(app.lastFrame()).toContain('Summarize from here')
    expect(app.lastFrame()).toContain('Summarize up to here')

    app.stdin.write('\r')
    await flush()
    expect(calls).toEqual([
      'fork:original-session:first-assistant',
      'rename:rewound-session:original-title (Branch)',
      'transcript:rewound-session',
      'files:original-session:second-user',
    ])
    expect(app.lastFrame()).toContain('inspection complete')
    expect(app.lastFrame()).toContain(
      'Code and conversation restored. Edit the message and submit to continue.',
    )
    expect(app.lastFrame()).toContain('change the file')
  })

  it('keeps long rewind histories inside a bounded scrolling window', async () => {
    const points = Array.from({ length: 10 }, (_, index) => ({
      messageId: `user-${index + 1}`,
      prompt: `prompt ${index + 1}`,
      fileChanges: [],
      fileRestoreAvailable: false,
    }))
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            return {
              async run() {
                throw new Error('unused')
              },
              async resume() {
                throw new Error('unused')
              },
              async fork() {
                throw new Error('unused')
              },
              async sessions() {
                return []
              },
              async rewindPoints() {
                return points
              },
            }
          },
        }}
        initialSessions={[]}
        resume={{ sessionId: 'long-session' }}
      />,
    )

    app.stdin.write('/rewind')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('↑ 4 more above')
    expect(app.lastFrame()).toContain('prompt 10')
    expect(app.lastFrame()).not.toContain('prompt 1\n')

    for (let index = 0; index < 7; index += 1) app.stdin.write('\u001B[A')
    await flush()
    expect(app.lastFrame()).toContain('prompt 4')
    expect(app.lastFrame()).toContain('↓ 4 more below')
    expect(app.lastFrame()).not.toContain('prompt 10')
  })

  it('renames and branches the active conversation without a model turn', async () => {
    const calls: string[] = []
    let currentName = 'original-name'
    const factory: InteractiveServiceFactory = {
      async createService() {
        return {
          async run() {
            throw new Error('unused')
          },
          async resume() {
            throw new Error('unused')
          },
          async fork(sessionId) {
            calls.push(`fork:${sessionId}`)
            return { parentSessionId: sessionId, sessionId: 'branch-session' }
          },
          async rename(sessionId, name) {
            calls.push(`rename:${sessionId}:${name}`)
            if (sessionId === 'original-session') currentName = name
          },
          async sessionNameSuggestion(sessionId) {
            calls.push(`suggest:${sessionId}`)
            return 'generated-session-name'
          },
          async sessions() {
            return [
              {
                sessionId: 'original-session',
                name: currentName,
                lastPrompt: 'work',
                updatedAt: '2026-08-11T00:00:00.000Z',
                status: 'ready' as const,
                issue: null,
              },
            ]
          },
        }
      },
    }
    const app = render(
      <InteractiveApp
        factory={factory}
        initialSessions={[]}
        resume={{ sessionId: 'original-session' }}
      />,
    )

    app.stdin.write('/rename')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain(
      'Session renamed to: generated-session-name',
    )

    app.stdin.write('/rename manual-title')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('Session renamed to: manual-title')

    app.stdin.write('/branch')
    app.stdin.write('\r')
    await flush()
    expect(calls).toEqual([
      'suggest:original-session',
      'rename:original-session:generated-session-name',
      'rename:original-session:manual-title',
      'fork:original-session',
      'rename:branch-session:manual-title (Branch)',
    ])
    expect(app.lastFrame()).toContain('Branched conversation.')
    expect(app.lastFrame()).toContain('branch-session')
    expect(app.lastFrame()).toContain('Use /resume')
    expect(app.lastFrame()).toContain('original-session ("manual-title")')
    expect(app.lastFrame()).toContain('praxis -r original-session')
    expect(app.lastFrame()).toContain('a new terminal.')
  })

  it('keeps Shift+Enter as a multiline composer shortcut', async () => {
    const calls: string[] = []
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            return {
              async run(prompt) {
                calls.push(prompt)
                return {
                  sessionId: 'session-1',
                  text: 'done',
                  usage: { inputTokens: 1, outputTokens: 1 },
                }
              },
              async resume() {
                throw new Error('unused')
              },
              async fork() {
                throw new Error('unused')
              },
              async sessions() {
                return []
              },
            }
          },
        }}
        initialSessions={[]}
      />,
    )

    app.stdin.write('shift first')
    app.stdin.write('\u001B[13;2u')
    app.stdin.write('shift second')
    await flush()
    expect(app.lastFrame()).toContain('shift first')
    expect(app.lastFrame()).toContain('shift second')
    app.stdin.write('\r')
    await flush()
    expect(calls).toEqual(['shift first\nshift second'])
  })

  it('applies ordinary composer text and submission exactly once', async () => {
    const calls: string[] = []
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            return {
              async run(prompt) {
                calls.push(prompt)
                return {
                  sessionId: 'session-1',
                  text: 'done',
                  usage: { inputTokens: 1, outputTokens: 1 },
                }
              },
              async resume() {
                throw new Error('unused')
              },
              async fork() {
                throw new Error('unused')
              },
              async sessions() {
                return []
              },
            }
          },
        }}
        initialSessions={[]}
      />,
    )

    app.stdin.write('single')
    await flush()
    expect(app.lastFrame()).toContain('❯ single')
    expect(app.lastFrame()).not.toContain('singlesingle')

    app.stdin.write('\r')
    await flush()
    expect(calls).toEqual(['single'])
  })

  it('preserves Chat keybindings while the command palette is open', async () => {
    const calls: string[] = []
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            return {
              async run(prompt) {
                calls.push(prompt)
                return {
                  sessionId: 'session-1',
                  text: 'done',
                  usage: { inputTokens: 1, outputTokens: 1 },
                }
              },
              async resume() {
                throw new Error('unused')
              },
              async fork() {
                throw new Error('unused')
              },
              async sessions() {
                return []
              },
            }
          },
        }}
        initialSessions={[]}
        keybindingsLoader={async () =>
          new Map([
            [
              'Chat',
              new Map([
                ['ctrl+y', 'chat:newline'],
                ['enter', 'chat:submit'],
              ]),
            ],
          ])
        }
      />,
    )

    await flush()
    app.stdin.write('/unknown-command')
    await flush()
    expect(app.lastFrame()).toContain('❯ /unknown-command')

    app.stdin.write('\u0019')
    app.stdin.write('continued')
    app.stdin.write('\r')
    await flush()
    expect(calls).toEqual(['/unknown-command\ncontinued'])
  })

  it('accepts the ESC+Return sequence installed by terminal setup', async () => {
    const calls: string[] = []
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            return {
              async run(prompt) {
                calls.push(prompt)
                return {
                  sessionId: 'meta-session',
                  text: 'done',
                  usage: { inputTokens: 1, outputTokens: 1 },
                }
              },
              async resume() {
                throw new Error('unused')
              },
              async fork() {
                throw new Error('unused')
              },
              async sessions() {
                return []
              },
            }
          },
        }}
        initialSessions={[]}
      />,
    )

    app.stdin.write('meta first')
    app.stdin.write('\u001B\r')
    app.stdin.write('meta second')
    await flush()
    app.stdin.write('\r')
    await flush()
    expect(calls).toEqual(['meta first\nmeta second'])
  })

  it('supports task, model, stash, escape, and continuation shortcuts', async () => {
    const calls: string[] = []
    const factory: InteractiveServiceFactory = {
      async createService() {
        return {
          async run(prompt) {
            calls.push(prompt)
            return {
              sessionId: 'session-1',
              text: 'done',
              usage: { inputTokens: 1, outputTokens: 1 },
            }
          },
          async resume() {
            throw new Error('unused')
          },
          async fork() {
            throw new Error('unused')
          },
          async sessions() {
            return []
          },
          workflows() {
            return []
          },
        }
      },
    }
    const app = render(
      <InteractiveApp factory={factory} initialSessions={[]} />,
    )

    app.stdin.write('\u0014')
    await flush()
    expect(app.lastFrame()).toContain('Background')
    expect(app.lastFrame()).toContain('No tasks currently running')
    app.stdin.write('\u001B')
    await new Promise((resolve) => setTimeout(resolve, 75))
    await flush()

    app.stdin.write('\u001B[112;3u')
    await flush()
    expect(app.lastFrame()).toContain('Select model')
    app.stdin.write('\u001B')
    await new Promise((resolve) => setTimeout(resolve, 75))
    await flush()

    app.stdin.write('stashed prompt')
    app.stdin.write('\u0013')
    await flush()
    expect(app.lastFrame()).not.toContain('❯ stashed prompt')
    app.stdin.write('\u0013')
    await flush()
    expect(app.lastFrame()).toContain('❯ stashed prompt')

    app.stdin.write('\u001B')
    await new Promise((resolve) => setTimeout(resolve, 75))
    app.stdin.write('\u001B')
    await new Promise((resolve) => setTimeout(resolve, 75))
    await flush()
    expect(app.lastFrame()).not.toContain('❯ stashed prompt')

    app.stdin.write('first\\')
    app.stdin.write('\r')
    app.stdin.write('second')
    await flush()
    expect(app.lastFrame()).toContain('first')
    expect(app.lastFrame()).toContain('second')
    app.stdin.write('\r')
    await flush()
    expect(calls).toEqual(['first\nsecond'])
  })

  it('filters @ files into the composer and undoes text edits', async () => {
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            throw new Error('unused')
          },
        }}
        initialSessions={[]}
        fileLoader={async () => [
          { path: 'alpha.ts', directory: false },
          { path: 'src/', directory: true },
          { path: 'src/agent.ts', directory: false },
        ]}
      />,
    )

    app.stdin.write('review @src')
    await flush()
    expect(app.lastFrame()).toContain('+ src/')
    expect(app.lastFrame()).toContain('+ src/agent.ts')

    app.stdin.write('\u001B[B')
    await flush()
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('❯ review @src/agent.ts')

    app.stdin.write(' later')
    await flush()
    expect(app.lastFrame()).toContain('review @src/agent.ts later')
    app.stdin.write('\u001F')
    await flush()
    expect(app.lastFrame()).toContain('❯ review @src/agent.ts')
    app.stdin.write('\u001F')
    await flush()
    expect(app.lastFrame()).toContain('❯ review @src')
  })

  it('continues editing the composer after the file picker is open', async () => {
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            throw new Error('unused')
          },
        }}
        initialSessions={[]}
        fileLoader={async () => [
          { path: 'alpha.ts', directory: false },
          { path: 'src/agent.ts', directory: false },
        ]}
      />,
    )

    app.stdin.write('@')
    await waitFor(() =>
      app.lastFrame()?.includes('alpha.ts') ? true : undefined,
    )
    app.stdin.write('s')
    await flush()

    expect(app.lastFrame()).toContain('❯ @s')
    expect(app.lastFrame()).toContain('src/agent.ts')
  })

  it('dismisses command and file pickers without clearing the composer', async () => {
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            throw new Error('unused')
          },
        }}
        initialSessions={[]}
        slashCommands={[
          {
            name: 'inspect-fixture',
            description: 'Inspect the fixture',
            source: 'command',
          },
        ]}
        fileLoader={async () => [{ path: 'alpha.ts', directory: false }]}
      />,
    )

    app.stdin.write('/ins')
    await waitFor(() =>
      app.lastFrame()?.includes('Inspect the fixture') ? true : undefined,
    )
    app.stdin.write('\u001B')
    await delay(75)
    await flush()
    expect(app.lastFrame()).toContain('❯ /ins')
    expect(app.lastFrame()).not.toContain('Inspect the fixture')

    app.stdin.write('\u000c')
    await flush()
    app.stdin.write('@')
    await waitFor(() =>
      app.lastFrame()?.includes('alpha.ts') ? true : undefined,
    )
    app.stdin.write('\u001B')
    await delay(75)
    await flush()
    expect(app.lastFrame()).toContain('❯ @')
    expect(app.lastFrame()).not.toContain('alpha.ts')
  })

  it('shows Pasting… and inserts clipboard text at the real cursor', async () => {
    const previousNoColor = process.env.NO_COLOR
    delete process.env.NO_COLOR
    try {
      let finishPaste: ((text: string) => void) | undefined
      const clipboardReader = vi.fn(
        () =>
          new Promise<{ kind: 'text'; text: string }>((resolve) => {
            finishPaste = (text) => resolve({ kind: 'text', text })
          }),
      )
      const app = render(
        <InteractiveApp
          factory={{
            async createService() {
              throw new Error('unused')
            },
          }}
          initialSessions={[]}
          clipboardReader={clipboardReader}
        />,
      )

      app.stdin.write('abcd')
      app.stdin.write('\u001B[D')
      app.stdin.write('\u001B[D')
      app.stdin.write('\u0016')
      await flush()
      expect(app.lastFrame()).toContain('Pasting…')

      finishPaste?.('clipboard')
      await flush()
      expect(app.lastFrame()).toContain('abclipboardcd')
      expect(clipboardReader).toHaveBeenCalledOnce()
    } finally {
      if (previousNoColor === undefined) delete process.env.NO_COLOR
      else process.env.NO_COLOR = previousNoColor
    }
  })

  it('keeps composer input and reports clipboard read failures', async () => {
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            throw new Error('unused')
          },
        }}
        initialSessions={[]}
        clipboardReader={async () => {
          throw new Error('Clipboard is unavailable')
        }}
      />,
    )

    app.stdin.write('keep this')
    app.stdin.write('\u0016')
    await flush()
    expect(app.lastFrame()).toContain('❯ keep this')
    expect(app.lastFrame()).toContain('Clipboard is unavailable')
  })

  it('pastes, atomically edits, undoes, and submits images on run and resume', async () => {
    const images = ['first-image', 'second-image', 'third-image'].map(
      (data) => ({
        kind: 'image' as const,
        image: {
          type: 'image' as const,
          mediaType: 'image/png' as const,
          data,
        },
      }),
    )
    const clipboardReader = vi.fn(async () => {
      const image = images.shift()
      if (!image) throw new Error('clipboard fixture exhausted')
      return image
    })
    const calls: Array<{
      operation: string
      prompt: string
      images: readonly { data: string }[] | undefined
    }> = []
    const factory: InteractiveServiceFactory = {
      async createService() {
        return {
          async run(prompt, _signal, _sessionId, _name, submittedImages) {
            calls.push({
              operation: 'run',
              prompt,
              images: submittedImages?.map(({ data }) => ({ data })),
            })
            return {
              sessionId: 'session-1',
              text: 'first answer',
              usage: { inputTokens: 1, outputTokens: 1 },
            }
          },
          async resume(sessionId, prompt, _signal, _name, submittedImages) {
            calls.push({
              operation: `resume:${sessionId}`,
              prompt,
              images: submittedImages?.map(({ data }) => ({ data })),
            })
            return {
              sessionId,
              text: 'next answer',
              usage: { inputTokens: 1, outputTokens: 1 },
            }
          },
          async fork() {
            throw new Error('unused')
          },
          async sessions() {
            return []
          },
        }
      },
    }
    const app = render(
      <InteractiveApp
        factory={factory}
        initialSessions={[]}
        clipboardReader={clipboardReader}
      />,
    )

    app.stdin.write('start')
    app.stdin.write('\u0016')
    await flush()
    app.stdin.write('\u0016')
    await flush()
    expect(app.lastFrame()).toContain('start[Image #1] [Image #2]')

    app.stdin.write('\u007F')
    await flush()
    expect(app.lastFrame()).toContain('start[Image #1]')
    expect(app.lastFrame()).not.toContain('[Image #2]')
    app.stdin.write('\u001F')
    await flush()
    expect(app.lastFrame()).toContain('start[Image #1] [Image #2]')

    app.stdin.write('\r')
    await flush()
    app.stdin.write('\u0016')
    await flush()
    expect(app.lastFrame()).toContain('[Image #3]')
    app.stdin.write('\r')
    await flush()

    expect(calls).toEqual([
      {
        operation: 'run',
        prompt: 'start[Image #1] [Image #2]',
        images: [{ data: 'first-image' }, { data: 'second-image' }],
      },
      {
        operation: 'resume:session-1',
        prompt: '[Image #3]',
        images: [{ data: 'third-image' }],
      },
    ])
  })

  it('edits the composer through Ctrl+G without creating a model service', async () => {
    let serviceCreations = 0
    let finishEditor:
      ((result: { content: string; editorName: string }) => void) | undefined
    const externalEditor = vi.fn(
      () =>
        new Promise<{ content: string; editorName: string }>((resolve) => {
          finishEditor = resolve
        }),
    )
    const turns: Array<Promise<void> | null> = []
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            serviceCreations += 1
            throw new Error('unused')
          },
        }}
        initialSessions={[]}
        display={{ version: 'dev', cwd: '/workspace', effort: 'high' }}
        externalEditor={externalEditor}
        onTurnChange={(turn) => turns.push(turn)}
      />,
    )

    app.stdin.write('original prompt')
    app.stdin.write('\u0007')
    await flush()
    expect(app.lastFrame()).toContain('Save and close editor to continue...')
    await new Promise((resolve) => setTimeout(resolve, 75))
    await flush()
    expect(externalEditor).toHaveBeenCalledWith('original prompt', {
      cwd: '/workspace',
    })
    expect(turns[0]).toBeInstanceOf(Promise)

    finishEditor?.({
      content: 'edited first line\nedited second line\n\n',
      editorName: 'Editor-wrapper',
    })
    await flush()
    expect(app.lastFrame()).toContain('edited first line')
    expect(app.lastFrame()).toContain('edited second line')
    expect(app.lastFrame()).toContain('ctrl+g to edit in Editor-wrapper')
    expect(turns.at(-1)).toBeNull()

    app.stdin.write('\u001F')
    await flush()
    expect(app.lastFrame()).toContain('❯ original prompt')
    expect(serviceCreations).toBe(0)
  })

  it('keeps the composer when the Ctrl+G editor fails', async () => {
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            throw new Error('unused')
          },
        }}
        initialSessions={[]}
        externalEditor={async () => {
          throw new Error('Editor-fail quit unexpectedly (exit code 7)')
        }}
      />,
    )

    app.stdin.write('original prompt')
    app.stdin.write('\u0007')
    await new Promise((resolve) => setTimeout(resolve, 75))
    await flush()
    expect(app.lastFrame()).toContain('❯ original prompt')
    expect(app.lastFrame()).toContain(
      'Editor-fail quit unexpectedly (exit code 7)',
    )
  })

  it('loads shared custom keybindings and honors explicit rebinding', async () => {
    const externalEditor = vi.fn(async (prompt: string) => ({
      content: `${prompt} edited`,
      editorName: 'Custom-editor',
    }))
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            throw new Error('unused')
          },
        }}
        initialSessions={[]}
        externalEditor={externalEditor}
        keybindingsLoader={async () =>
          new Map([
            [
              'Chat',
              new Map([
                ['ctrl+y', 'chat:externalEditor'],
                ['ctrl+v', 'chat:imagePaste'],
                ['enter', 'chat:submit'],
              ]),
            ],
          ])
        }
      />,
    )

    await flush()
    app.stdin.write('custom')
    app.stdin.write('\u0007')
    await flush()
    expect(externalEditor).not.toHaveBeenCalled()

    app.stdin.write('\u0019')
    await new Promise((resolve) => setTimeout(resolve, 75))
    await flush()
    expect(externalEditor).toHaveBeenCalledWith('custom', {
      cwd: process.cwd(),
    })
    expect(app.lastFrame()).toContain('custom edited')
  })

  it('opens the Ctrl+G editor from an empty composer', async () => {
    const externalEditor = vi.fn(async () => ({
      content: 'prompt started in editor',
      editorName: 'Vi',
    }))
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            throw new Error('unused')
          },
        }}
        initialSessions={[]}
        externalEditor={externalEditor}
      />,
    )

    app.stdin.write('\u0007')
    await new Promise((resolve) => setTimeout(resolve, 75))
    await flush()
    expect(externalEditor).toHaveBeenCalledWith('', {
      cwd: process.cwd(),
    })
    expect(app.lastFrame()).toContain('❯ prompt started in editor')
  })

  it('supports the default Ctrl+X Ctrl+E external-editor sequence', async () => {
    const externalEditor = vi.fn(async (prompt: string) => ({
      content: prompt,
      editorName: 'Vi',
    }))
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            throw new Error('unused')
          },
        }}
        initialSessions={[]}
        externalEditor={externalEditor}
      />,
    )

    app.stdin.write('sequence prompt')
    app.stdin.write('\u0018')
    await flush()
    expect(externalEditor).not.toHaveBeenCalled()
    app.stdin.write('\u0005')
    await new Promise((resolve) => setTimeout(resolve, 75))
    await flush()
    expect(externalEditor).toHaveBeenCalledWith('sequence prompt', {
      cwd: process.cwd(),
    })
  })

  it('creates and opens the shared keybindings file without a model service', async () => {
    let serviceCreations = 0
    const keybindingsFile = vi.fn(async (configRoot: string) => ({
      path: `${configRoot}/keybindings.json`,
      created: true,
    }))
    const keybindingsEditor = vi.fn(async () => ({ editorName: 'Fixture' }))
    const turns: Array<Promise<void> | null> = []
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            serviceCreations += 1
            throw new Error('unused')
          },
        }}
        initialSessions={[]}
        display={{ version: 'dev', cwd: '/workspace' }}
        keybindingsConfigRoot="/shared-claude"
        keybindingsFile={keybindingsFile}
        keybindingsEditor={keybindingsEditor}
        onTurnChange={(turn) => turns.push(turn)}
      />,
    )

    app.stdin.write('/keyb')
    await flush()
    expect(app.lastFrame()).toContain('/keybindings')
    expect(app.lastFrame()).toContain('Open your keyboard shortcuts file')
    app.stdin.write('\r')
    await flush()
    app.stdin.write('\r')
    await new Promise((resolve) => setTimeout(resolve, 75))
    await flush()

    expect(keybindingsFile).toHaveBeenCalledWith('/shared-claude')
    expect(keybindingsEditor).toHaveBeenCalledWith(
      '/shared-claude/keybindings.json',
      { cwd: '/workspace' },
    )
    expect(app.lastFrame()).toContain(
      'Created /shared-claude/keybindings.json with template. Opened in your editor.',
    )
    expect(turns[0]).toBeInstanceOf(Promise)
    expect(turns.at(-1)).toBeNull()
    expect(serviceCreations).toBe(0)
  })

  it('loads, navigates, opens, and edits shared memory files without a model turn', async () => {
    const memoryFilesLoader = vi.fn(async () => ({
      autoMemoryEnabled: true,
      entries: [
        {
          kind: 'file' as const,
          label: 'User memory',
          path: '/shared-claude/CLAUDE.md',
          displayPath: '~/.claude/CLAUDE.md',
          annotation: 'Saved in ~/.claude/CLAUDE.md',
          scope: 'user' as const,
        },
        {
          kind: 'file' as const,
          label: 'Project memory',
          path: '/workspace/CLAUDE.md',
          displayPath: './CLAUDE.md',
          annotation: 'Saved in ./CLAUDE.md',
          scope: 'project' as const,
        },
        {
          kind: 'folder' as const,
          label: 'Open auto-memory folder',
          path: '/shared-claude/projects/workspace/memory',
          displayPath: '/shared-claude/projects/workspace/memory',
          scope: 'project' as const,
        },
      ],
    }))
    const memoryEditor = vi.fn(async () => ({ editorName: 'Fixture editor' }))
    const memoryFolderOpener = vi.fn(async () => undefined)
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            throw new Error('unused')
          },
        }}
        initialSessions={[]}
        display={{ version: 'dev', cwd: '/workspace' }}
        keybindingsConfigRoot="/shared-claude"
        memoryFilesLoader={memoryFilesLoader}
        memoryEditor={memoryEditor}
        memoryFolderOpener={memoryFolderOpener}
      />,
    )

    app.stdin.write('/mem')
    await flush()
    expect(app.lastFrame()).toContain('/memory')
    expect(app.lastFrame()).toContain('Open a memory file in your editor')
    app.stdin.write('\r')
    await flush()
    app.stdin.write('\r')
    await new Promise((resolve) => setTimeout(resolve, 25))
    await flush()
    expect(memoryFilesLoader).toHaveBeenCalledWith(
      '/shared-claude',
      '/workspace',
    )
    expect(app.lastFrame()).toContain('Auto-memory: on')
    expect(app.lastFrame()).toContain('1. User memory')
    expect(app.lastFrame()).toContain('3. Open auto-memory folder')

    app.stdin.write('\u001B[B')
    app.stdin.write('\u001B[B')
    app.stdin.write('\r')
    app.stdin.write('\r')
    await flush()
    expect(memoryFolderOpener).toHaveBeenCalledWith(
      '/shared-claude/projects/workspace/memory',
    )
    expect(memoryFolderOpener).toHaveBeenCalledOnce()
    expect(app.lastFrame()).toContain('Open auto-memory folder ✔')
    app.stdin.write('\u001B')
    await new Promise((resolve) => setTimeout(resolve, 75))
    await flush()
    expect(app.lastFrame()).toContain('Cancelled memory editing')

    app.stdin.write('/memory')
    app.stdin.write('\r')
    await waitFor(() =>
      app.lastFrame()?.includes('Auto-memory: on') ? true : undefined,
    )
    app.stdin.write('2')
    await waitFor(() =>
      memoryEditor.mock.calls.length === 1 ? true : undefined,
    )
    expect(memoryEditor).toHaveBeenCalledWith('/workspace/CLAUDE.md', {
      cwd: '/workspace',
    })
    await waitFor(() =>
      app.lastFrame()?.includes('Opened memory file at ./CLAUDE.md')
        ? true
        : undefined,
    )
    expect(app.lastFrame()).toContain('Using Fixture editor')
  })

  it('does not apply a stale memory-folder completion to a reopened dialog', async () => {
    const folderResolvers: Array<() => void> = []
    const memoryFolderOpener = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          folderResolvers.push(resolve)
        }),
    )
    const onTurnChange = vi.fn()
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            throw new Error('unused')
          },
        }}
        initialSessions={[]}
        memoryFilesLoader={async () => ({
          autoMemoryEnabled: true,
          entries: [
            {
              kind: 'file',
              label: 'User memory',
              path: '/shared-claude/CLAUDE.md',
              displayPath: '~/.claude/CLAUDE.md',
              scope: 'user',
            },
            {
              kind: 'folder',
              label: 'Open auto-memory folder',
              path: '/shared-claude/projects/workspace/memory',
              displayPath: '/shared-claude/projects/workspace/memory',
              scope: 'project',
            },
          ],
        })}
        memoryFolderOpener={memoryFolderOpener}
        onTurnChange={onTurnChange}
      />,
    )

    app.stdin.write('/memory')
    app.stdin.write('\r')
    await flush()
    app.stdin.write('2')
    await flush()
    expect(memoryFolderOpener).toHaveBeenCalledOnce()

    app.stdin.write('\u001B')
    await new Promise((resolve) => setTimeout(resolve, 75))
    app.stdin.write('/memory')
    app.stdin.write('\r')
    await flush()
    app.stdin.write('2')
    await flush()
    expect(memoryFolderOpener).toHaveBeenCalledTimes(2)

    folderResolvers[0]?.()
    await flush()

    expect(app.lastFrame()).toContain('Open auto-memory folder')
    expect(app.lastFrame()).not.toContain('Open auto-memory folder ✔')
    expect(onTurnChange.mock.calls.at(-1)?.[0]).not.toBeNull()

    folderResolvers[1]?.()
    await flush()
    expect(app.lastFrame()).toContain('Open auto-memory folder ✔')
    expect(onTurnChange.mock.calls.at(-1)?.[0]).toBeNull()
  })

  it('retains the last valid keybindings when editor reload fails', async () => {
    const retained = new Map([
      [
        'Chat',
        new Map([
          ['ctrl+y', 'chat:externalEditor'],
          ['enter', 'chat:submit'],
        ]),
      ],
    ])
    const keybindingsLoader = vi
      .fn()
      .mockResolvedValueOnce(retained)
      .mockRejectedValueOnce(new Error('Invalid shared keybindings JSON'))
    const externalEditor = vi.fn(async (prompt: string) => ({
      content: prompt,
      editorName: 'Retained-editor',
    }))
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            throw new Error('unused')
          },
        }}
        initialSessions={[]}
        externalEditor={externalEditor}
        keybindingsConfigRoot="/shared-claude"
        keybindingsFile={async () => ({
          path: '/shared-claude/keybindings.json',
          created: false,
        })}
        keybindingsLoader={keybindingsLoader}
        keybindingsEditor={async () => ({ editorName: 'Fixture' })}
      />,
    )

    await flush()
    app.stdin.write('/keybindings')
    app.stdin.write('\r')
    await new Promise((resolve) => setTimeout(resolve, 75))
    await flush()
    expect(app.lastFrame()).toContain(
      'Opened /shared-claude/keybindings.json in your editor.',
    )
    expect(app.lastFrame()).toContain('Invalid shared keybindings JSON')

    app.stdin.write('retained')
    app.stdin.write('\u0019')
    await new Promise((resolve) => setTimeout(resolve, 75))
    await flush()
    expect(externalEditor).toHaveBeenCalledWith('retained', {
      cwd: process.cwd(),
    })
  })

  it('suspends on Ctrl+Z and restores the composer without a model service', async () => {
    let serviceCreations = 0
    const suspendProcess = vi.fn()
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            serviceCreations += 1
            throw new Error('unused')
          },
        }}
        initialSessions={[]}
        suspendProcess={suspendProcess}
      />,
    )

    app.stdin.write('preserve me')
    app.stdin.write('\u001a')
    await new Promise((resolve) => setTimeout(resolve, 75))
    await flush()
    expect(suspendProcess).toHaveBeenCalledOnce()
    expect(app.lastFrame()).toContain('❯ preserve me')
    expect(serviceCreations).toBe(0)
  })

  it('allows Ctrl+Z while a model turn is busy', async () => {
    let finishTurn:
      | ((result: {
          sessionId: string
          text: string
          usage: { inputTokens: number; outputTokens: number }
        }) => void)
      | undefined
    const suspendProcess = vi.fn()
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            return {
              run: () =>
                new Promise((resolve) => {
                  finishTurn = resolve
                }),
              async resume() {
                throw new Error('unused')
              },
              async fork() {
                throw new Error('unused')
              },
              async sessions() {
                return []
              },
            }
          },
        }}
        initialSessions={[]}
        suspendProcess={suspendProcess}
      />,
    )

    app.stdin.write('busy suspend')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('esc to interrupt')
    app.stdin.write('\u001a')
    await new Promise((resolve) => setTimeout(resolve, 75))
    await flush()
    expect(suspendProcess).toHaveBeenCalledOnce()

    finishTurn?.({
      sessionId: 'session-1',
      text: 'done',
      usage: { inputTokens: 1, outputTokens: 1 },
    })
    await flush()
  })

  it('selects an @ agent mention and submits Claude-compatible syntax', async () => {
    const calls: string[] = []
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            return {
              async run(prompt) {
                calls.push(prompt)
                return {
                  sessionId: 'session-1',
                  text: 'done',
                  usage: { inputTokens: 1, outputTokens: 1 },
                }
              },
              async resume() {
                throw new Error('unused')
              },
              async fork() {
                throw new Error('unused')
              },
              async sessions() {
                return []
              },
            }
          },
        }}
        initialSessions={[]}
        agents={[
          {
            name: 'reviewer',
            description: 'Reviews code for subtle regressions.',
          },
        ]}
        fileLoader={async () => [{ path: 'alpha.ts', directory: false }]}
      />,
    )

    app.stdin.write('@rev')
    await flush()
    expect(app.lastFrame()).toContain(
      '* reviewer (agent) – Reviews code for subtle regressions.',
    )
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('❯ @"reviewer (agent)"')
    app.stdin.write(' inspect this')
    app.stdin.write('\r')
    await flush()
    expect(calls).toEqual(['@"reviewer (agent)" inspect this'])
  })

  it('enables plan mode locally before the next turn', async () => {
    const modes: Array<string | undefined> = []
    const factory: InteractiveServiceFactory = {
      async createService(options) {
        modes.push(options.permissionMode)
        return {
          async run() {
            return {
              sessionId: 'session-1',
              text: 'done',
              usage: { inputTokens: 1, outputTokens: 1 },
            }
          },
          async resume() {
            throw new Error('unused')
          },
          async fork() {
            throw new Error('unused')
          },
          async sessions() {
            return []
          },
        }
      },
    }
    const app = render(
      <InteractiveApp factory={factory} initialSessions={[]} />,
    )

    app.stdin.write('/plan')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('Permission mode set to plan')
    app.stdin.write('inspect')
    app.stdin.write('\r')
    await flush()
    expect(modes).toEqual(['plan'])
  })

  it('filters shared slash commands and fills a palette selection', async () => {
    const calls: string[] = []
    const factory: InteractiveServiceFactory = {
      async createService() {
        return {
          async run(prompt) {
            calls.push(prompt)
            return {
              sessionId: 'session-1',
              text: 'done',
              usage: { inputTokens: 1, outputTokens: 1 },
            }
          },
          async resume() {
            throw new Error('unused')
          },
          async fork() {
            throw new Error('unused')
          },
          async sessions() {
            return []
          },
          slashCommands() {
            return [
              {
                name: 'review',
                description: 'Review the current change.',
                source: 'command',
              },
            ]
          },
        }
      },
    }
    const app = render(
      <InteractiveApp
        factory={factory}
        initialSessions={[]}
        slashCommands={[
          {
            name: 'review',
            description: 'Review the current change.',
            source: 'command',
          },
        ]}
      />,
    )

    app.stdin.write('/')
    await flush()
    expect(app.lastFrame()).toContain('/add-dir')
    expect(app.lastFrame()).not.toContain('╭─ Commands')

    app.stdin.write('rev')
    await flush()
    expect(app.lastFrame()).toContain('Review the current change.')

    app.stdin.write('\t')
    await flush()
    expect(app.lastFrame()).toContain('❯ /review')
    expect(app.lastFrame()).not.toContain('Review the current change.')

    app.stdin.write('src')
    app.stdin.write('\r')
    await flush()
    expect(calls).toEqual(['/review src'])
  })

  it('opens the shortcut grid and tabbed help without a model turn', async () => {
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            throw new Error('unused')
          },
        }}
        initialSessions={[]}
        slashCommands={[
          {
            name: 'review',
            description: 'Review the current change.',
            source: 'command',
          },
        ]}
      />,
    )

    app.stdin.write('?')
    await flush()
    expect(app.lastFrame()).toContain('! for bash mode')
    expect(app.lastFrame()).toContain('& for background')
    expect(app.lastFrame()).toContain('ctrl + o for verbose output')
    expect(app.lastFrame()).not.toContain('❯ ?')

    app.stdin.write('?')
    app.stdin.write('/help')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('Praxis understands your codebase')
    app.stdin.write('\u001B[C')
    await flush()
    expect(app.lastFrame()).toContain('Browse default commands')
    expect(app.lastFrame()).toContain('/resume')
    app.stdin.write('\u001B[C')
    await flush()
    expect(app.lastFrame()).toContain('Browse shared commands and skills')
    expect(app.lastFrame()).toContain('/review')
  })

  it('projects physical and submitted Help invocations for screen readers', async () => {
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            throw new Error('unused')
          },
        }}
        initialSessions={[]}
        axScreenReader
        slashCommands={[
          {
            name: 'review',
            description: 'Review the current change.',
            source: 'command',
          },
        ]}
      />,
    )

    app.stdin.write('?')
    await flush()
    let frame = app.lastFrame() ?? ''
    expect(frame).toContain('You: ?')
    expect(frame).toContain('Help')
    expect(frame).toContain('Current tab: General')
    expect(frame).toContain('! for bash mode')
    expect(frame).toContain('Left/Right to switch tabs')
    expect(frame).toContain(
      'Praxis documentation: https://github.com/Forest-Isle/Praxis',
    )
    expect(frame).not.toContain('Prompt:')
    expect(frame).not.toMatch(/Actions:.*Enter/u)
    expect(frame).not.toContain('←')
    expect(frame).not.toContain('→')

    app.stdin.write('?')
    await flush()
    expect(app.lastFrame()).toContain('Prompt:')

    app.stdin.write('/help')
    app.stdin.write('\r')
    await flush()
    frame = app.lastFrame() ?? ''
    expect(frame).toContain('You: /help')
    expect(frame).toContain('Help')
    expect(frame).not.toContain('Prompt:')

    app.stdin.write('\u001B[C')
    await flush()
    frame = app.lastFrame() ?? ''
    expect(frame).toContain('Current tab: Commands')
    expect(frame).toContain('1. /add-dir — Add a new working directory')
    expect(frame).toContain('Up/Down to browse commands')
    expect(frame).not.toMatch(/Actions:.*Enter/u)
    expect(frame).not.toContain('←')
    expect(frame).not.toContain('→')

    app.stdin.write('\u001B[B')
    await flush()
    expect(app.lastFrame()).toContain('Focused: 2. /agents')

    app.stdin.write('\u001B')
    await flush()
    await waitFor(() =>
      app.lastFrame()?.includes('Prompt:') ? true : undefined,
    )
  })

  it('edits at the real cursor and restores submitted prompt history', async () => {
    const calls: string[] = []
    const factory: InteractiveServiceFactory = {
      async createService() {
        return {
          async run(prompt) {
            calls.push(`run:${prompt}`)
            return {
              sessionId: 'session-1',
              text: 'done',
              usage: { inputTokens: 1, outputTokens: 1 },
            }
          },
          async resume(sessionId, prompt) {
            calls.push(`resume:${sessionId}:${prompt}`)
            return {
              sessionId,
              text: 'done',
              usage: { inputTokens: 1, outputTokens: 1 },
            }
          },
          async fork() {
            throw new Error('unused')
          },
          async sessions() {
            return []
          },
        }
      },
    }
    const app = render(
      <InteractiveApp factory={factory} initialSessions={[]} />,
    )

    app.stdin.write('discard this')
    app.stdin.write('\u0015')
    await flush()
    expect(app.lastFrame()).not.toContain('discard this')

    app.stdin.write('abcd')
    app.stdin.write('\u001B[D')
    app.stdin.write('\u001B[D')
    app.stdin.write('X')
    app.stdin.write('\r')
    await flush()
    expect(calls).toEqual(['run:abXcd'])

    app.stdin.write('second')
    app.stdin.write('\r')
    await flush()
    app.stdin.write('\u001B[A')
    app.stdin.write('\u001B[A')
    await flush()
    expect(app.lastFrame()).toContain('abXcd')
    app.stdin.write('\r')
    await flush()
    expect(calls).toEqual([
      'run:abXcd',
      'resume:session-1:second',
      'resume:session-1:abXcd',
    ])
  })

  it('applies slash-selected model and effort choices to the next service', async () => {
    const configRoot = await mkdtemp(join(tmpdir(), 'praxis-model-settings-'))
    const creates: Array<{
      model: string | undefined
      effort: string | undefined
    }> = []
    const factory: InteractiveServiceFactory = {
      async createService(options) {
        creates.push({ model: options.model, effort: options.effort })
        return {
          async run() {
            return {
              sessionId: 'session-1',
              text: 'done',
              usage: { inputTokens: 1, outputTokens: 1 },
            }
          },
          async resume() {
            throw new Error('unused')
          },
          async fork() {
            throw new Error('unused')
          },
          async sessions() {
            return []
          },
        }
      },
    }
    const app = render(
      <InteractiveApp
        factory={factory}
        initialSessions={[]}
        runtimeSettingsTarget={configRoot}
      />,
    )

    app.stdin.write('/effort')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('Select effort')
    app.stdin.write('\u001B[A')
    app.stdin.write('\u001B[A')
    app.stdin.write('\r')
    await flush()

    app.stdin.write('/model')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('Select model')
    app.stdin.write('\u001B[B')
    app.stdin.write('\u001B[B')
    app.stdin.write('\u001B[B')
    app.stdin.write('\u001B[B')
    app.stdin.write('\u001B[B')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('Enter model ID')
    app.stdin.write('provider/model-custom')
    app.stdin.write('\r')
    await waitFor(() =>
      app
        .lastFrame()
        ?.includes(
          'provider/model-custom set as default model for new sessions.',
        )
        ? true
        : undefined,
    )

    app.stdin.write('run')
    app.stdin.write('\r')
    await flush()
    expect(creates).toContainEqual({
      model: 'provider/model-custom',
      effort: 'low',
    })
    await rm(configRoot, { recursive: true, force: true })
  })

  it('presents distinct Anthropic model choices and persists Enter selection', async () => {
    vi.stubEnv('PRAXIS_PROVIDER', 'anthropic')
    const configRoot = await mkdtemp(join(tmpdir(), 'praxis-model-picker-'))
    const models: Array<string | undefined> = []
    const app = render(
      <InteractiveApp
        factory={{
          async createService(options) {
            models.push(options.model)
            return {
              async run() {
                return {
                  sessionId: 'session-model',
                  text: 'done',
                  usage: { inputTokens: 1, outputTokens: 1 },
                }
              },
              async resume() {
                throw new Error('unused')
              },
              async fork() {
                throw new Error('unused')
              },
              async sessions() {
                return []
              },
              workflows() {
                return []
              },
            }
          },
        }}
        initialSessions={[]}
        runtimeSettingsTarget={configRoot}
      />,
    )

    app.stdin.write('/model')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('Opus')
    expect(app.lastFrame()).toContain('Sonnet')
    expect(app.lastFrame()).toContain('Haiku')
    expect(app.lastFrame()).not.toContain('s to use this session only')
    app.stdin.write('\u001B[B\u001B[B')
    app.stdin.write('\r')
    const selectedModel = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? 'sonnet'
    await waitFor(() =>
      app
        .lastFrame()
        ?.includes(`${selectedModel} set as default model for new sessions.`)
        ? true
        : undefined,
    )
    app.stdin.write('run')
    app.stdin.write('\r')
    await flush()
    expect(models).toContain(selectedModel)
    expect(
      JSON.parse(await readFile(join(configRoot, 'settings.json'), 'utf8')),
    ).toMatchObject({ model: selectedModel })
    await rm(configRoot, { recursive: true, force: true })
  })

  it('persists a Shift+Tab-selected permission mode before the next resume', async () => {
    const creates: Array<{ permissionMode: string | undefined }> = []
    const changes: Array<{ sessionId: string; mode: string }> = []
    const factory: InteractiveServiceFactory = {
      async createService(options) {
        creates.push({ permissionMode: options.permissionMode })
        return {
          async run() {
            return {
              sessionId: 'session-1',
              text: 'first',
              usage: { inputTokens: 1, outputTokens: 1 },
            }
          },
          async resume(sessionId) {
            return {
              sessionId,
              text: 'second',
              usage: { inputTokens: 1, outputTokens: 1 },
            }
          },
          async fork() {
            throw new Error('unused')
          },
          async sessions() {
            return []
          },
          async setPermissionMode(sessionId, mode) {
            changes.push({ sessionId, mode })
          },
        }
      },
    }
    const app = render(
      <InteractiveApp
        factory={factory}
        initialSessions={[]}
        permissionRuleStore={{
          async load() {
            return []
          },
          async add() {},
        }}
      />,
    )

    app.stdin.write('first')
    app.stdin.write('\r')
    await flush()
    app.stdin.write('\u001B[Z')
    await flush()
    await flush()

    expect(changes).toEqual([{ sessionId: 'session-1', mode: 'acceptEdits' }])
    app.stdin.write('continue')
    app.stdin.write('\r')
    await flush()
    expect(creates).toContainEqual({ permissionMode: 'acceptEdits' })
  })

  it('adds a scoped permission rule through the dashboard', async () => {
    const additions: Array<{
      behavior: string
      rule: string
      scope: string
    }> = []
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            throw new Error('unused')
          },
        }}
        initialSessions={[]}
        permissionRuleStore={{
          async load() {
            return additions.map((addition) => ({
              ...addition,
              behavior: addition.behavior as 'allow',
              scope: addition.scope as 'project',
              path: '/fixture/settings.json',
            }))
          },
          async add(input) {
            additions.push(input)
          },
        }}
      />,
    )

    app.stdin.write('/permissions')
    await flush()
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('Recently denied')
    expect(app.lastFrame()).toContain(
      "Praxis Code won't ask before using allowed tools.",
    )
    app.stdin.write('\u001B[B')
    await flush()
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('Add allow permission rule')
    app.stdin.write('Bash(npm test:*)')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('Where should this rule be saved?')
    app.stdin.write('\u001B[B')
    app.stdin.write('\r')
    await flush()
    expect(additions).toEqual([
      { behavior: 'allow', rule: 'Bash(npm test:*)', scope: 'project' },
    ])
    expect(app.lastFrame()).toContain('Bash(npm test:*)')
  })

  it('confirms and removes an existing scoped permission rule', async () => {
    const rules = [
      {
        behavior: 'allow' as const,
        rule: 'Bash(npm test:*)',
        scope: 'local' as const,
        path: '/workspace/.claude/settings.local.json',
      },
    ]
    const removals: string[] = []
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            throw new Error('unused')
          },
        }}
        initialSessions={[]}
        axScreenReader
        display={{ version: 'dev', cwd: '/workspace' }}
        additionalDirectories={['/shared']}
        permissionRuleStore={{
          async load() {
            return rules
          },
          async add() {},
          async remove(rule) {
            removals.push(rule.rule)
            rules.splice(
              rules.findIndex((candidate) => candidate.rule === rule.rule),
              1,
            )
          },
        }}
      />,
    )

    app.stdin.write('/permissions')
    app.stdin.write('\r')
    await flush()
    app.stdin.write('\u001B[B')
    await flush()
    app.stdin.write('\u001B[B')
    await flush()
    app.stdin.write('\r')
    await flush()

    expect(app.lastFrame()).toContain('Delete allowed tool?')
    expect(app.lastFrame()).toContain('Any Bash command starting with npm test')
    expect(app.lastFrame()).toContain('From project local settings')
    expect(app.lastFrame()).toContain('Selected: 1. Yes')
    expect(app.lastFrame()).not.toContain('❯')
    app.stdin.write('\u001B[B')
    await flush()
    expect(app.lastFrame()).toContain('Selected: 2. No')
    app.stdin.write('\u001B[A')
    await flush()
    app.stdin.write('\r')
    await flush()
    await flush()
    expect(removals).toEqual(['Bash(npm test:*)'])
    expect(app.lastFrame()).toContain('1. Add a new rule…')
    expect(app.lastFrame()).not.toContain('2. Bash(npm test:*)')

    for (let index = 0; index < 3; index += 1) {
      app.stdin.write('\u001B[C')
      await flush()
    }
    expect(app.lastFrame()).toContain('Current tab: Workspace')
    expect(app.lastFrame()).toContain('/shared')
    expect(app.lastFrame()).not.toContain('Selected:')
    app.stdin.write('\u001B[B')
    await new Promise((resolve) => setTimeout(resolve, 100))
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('Remove directory from workspace?')
  })

  it('accepts rapid workspace selection after async permission removal in fullscreen', async () => {
    const rules = [
      {
        behavior: 'allow' as const,
        rule: 'Bash(npm test:*)',
        scope: 'user' as const,
        path: '/fixture/settings.json',
      },
    ]
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            throw new Error('unused')
          },
        }}
        initialSessions={[]}
        display={{ version: 'dev', cwd: '/workspace' }}
        additionalDirectories={['/shared']}
        runtimeSettings={{
          ...projectRuntimeSettings({ settings: {}, state: {} }),
          tui: 'fullscreen',
        }}
        permissionRuleStore={{
          async load() {
            return rules
          },
          async add() {},
          async remove(rule) {
            rules.splice(
              rules.findIndex((candidate) => candidate.rule === rule.rule),
              1,
            )
          },
        }}
      />,
    )

    app.stdin.write('/permissions')
    app.stdin.write('\r')
    await flush()
    app.stdin.write('\u001B[B')
    await flush()
    app.stdin.write('\u001B[B')
    await flush()
    app.stdin.write('\r')
    await flush()
    app.stdin.write('\r')
    await flush()
    await flush()
    expect(app.lastFrame()).not.toContain('2. Bash(npm test:*)')

    for (let index = 0; index < 3; index += 1) {
      app.stdin.write('\u001B[C')
      await flush()
    }
    expect(app.lastFrame()).toContain('/shared')
    expect(app.lastFrame()).not.toContain('❯ 1. /shared')
    app.stdin.write('\u001B[B\r')
    await flush()
    expect(app.lastFrame()).toContain('Remove directory from workspace?')
  })

  it.each([
    ['ask', 'Delete ask tool?'],
    ['deny', 'Delete denied tool?'],
  ] as const)(
    'uses the observed %s deletion title',
    async (behavior, title) => {
      const app = render(
        <InteractiveApp
          factory={{
            async createService() {
              throw new Error('unused')
            },
          }}
          initialSessions={[]}
          permissionRuleStore={{
            async load() {
              return [
                {
                  behavior,
                  rule: 'Read(./fixture/**)',
                  scope: 'user',
                  path: '/fixture/settings.json',
                },
              ]
            },
            async add() {},
          }}
        />,
      )

      app.stdin.write('/permissions')
      app.stdin.write('\r')
      await flush()
      const moves = behavior === 'ask' ? 1 : 2
      for (let index = 0; index < moves; index += 1) {
        app.stdin.write('\u001B[C')
        await flush()
      }
      app.stdin.write('\u001B[B')
      await flush()
      app.stdin.write('\u001B[B')
      await flush()
      app.stdin.write('\r')
      await flush()
      expect(app.lastFrame()).toContain(title)
      expect(app.lastFrame()).toContain('From user settings')
    },
  )

  it('shows and extends workspace directories through the permission dashboard', async () => {
    const creates: Array<readonly string[] | undefined> = []
    const resolver = vi.fn(async () => '/new-shared')
    const completer = vi.fn(async () => './new-shared/')
    const app = render(
      <InteractiveApp
        factory={{
          async createService(options) {
            creates.push(options.additionalDirectories)
            return {
              async run() {
                return {
                  sessionId: 'session-1',
                  text: 'done',
                  usage: { inputTokens: 1, outputTokens: 1 },
                }
              },
              async resume() {
                throw new Error('unused')
              },
              async fork() {
                throw new Error('unused')
              },
              async sessions() {
                return []
              },
            }
          },
        }}
        initialSessions={[]}
        display={{ version: 'dev', cwd: '/workspace' }}
        additionalDirectories={['/shared']}
        workspaceDirectoryResolver={resolver}
        workspaceDirectoryCompleter={completer}
        permissionRuleStore={{
          async load() {
            return []
          },
          async add() {},
        }}
      />,
    )

    app.stdin.write('/permissions')
    app.stdin.write('\r')
    await flush()
    for (let index = 0; index < 3; index += 1) {
      app.stdin.write('\u001B[C')
      await flush()
    }
    expect(app.lastFrame()).toContain('/workspace (Original working directory)')
    expect(app.lastFrame()).toContain('/shared')
    app.stdin.write('\u001B[B')
    await flush()
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('Remove directory from workspace?')
    expect(app.lastFrame()).toContain('/shared')
    app.stdin.write('\r')
    await flush()
    for (let index = 0; index < 3; index += 1) {
      app.stdin.write('\u001B[C')
      await flush()
    }
    expect(app.lastFrame()).not.toContain('/shared')
    app.stdin.write('\u001B[B')
    await flush()
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('Add directory to workspace')
    app.stdin.write('./new')
    app.stdin.write('\t')
    await flush()
    expect(completer).toHaveBeenCalledWith('./new', '/workspace')
    expect(app.lastFrame()).toContain('./new-shared/')
    app.stdin.write('\r')
    await new Promise((resolve) => setTimeout(resolve, 75))
    await flush()
    expect(resolver).toHaveBeenCalledWith('./new-shared/', '/workspace')
    expect(app.lastFrame()).toContain('Permissions')

    app.stdin.write('\u001B')
    await new Promise((resolve) => setTimeout(resolve, 75))
    await flush()
    expect(app.lastFrame()).toContain('Try "review this project"')
    app.stdin.write('continue')
    await flush()
    expect(app.lastFrame()).toContain('continue')
    app.stdin.write('\r')
    await flush()
    expect(creates).toContainEqual(['/new-shared'])
  })

  it('starts a truly empty visible conversation for /clear', async () => {
    const calls: string[] = []
    const factory: InteractiveServiceFactory = {
      async createService() {
        return {
          async run(prompt) {
            calls.push(`run:${prompt}`)
            return {
              sessionId: `session-${calls.length}`,
              text: `answer:${prompt}`,
              usage: { inputTokens: 1, outputTokens: 1 },
            }
          },
          async resume(sessionId, prompt) {
            calls.push(`resume:${sessionId}:${prompt}`)
            return {
              sessionId,
              text: `answer:${prompt}`,
              usage: { inputTokens: 1, outputTokens: 1 },
            }
          },
          async fork() {
            throw new Error('unused')
          },
          async sessions() {
            return []
          },
          async transitionHookSession(sessionId, reason) {
            calls.push(`transition:${sessionId}:${reason}`)
          },
        }
      },
    }
    const app = render(
      <InteractiveApp factory={factory} initialSessions={[]} />,
    )

    app.stdin.write('first')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('answer:first')
    app.stdin.write('/clear')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).not.toContain('answer:first')
    expect(app.lastFrame()).toContain('Welcome to Praxis')

    app.stdin.write('second')
    app.stdin.write('\r')
    await flush()
    expect(calls).toEqual([
      'run:first',
      'transition:session-1:clear',
      'run:second',
    ])
  })

  it('renders measured cost with the active provider context budget', async () => {
    const factory: InteractiveServiceFactory = {
      async createService() {
        return {
          async run() {
            return {
              sessionId: 'session-1',
              text: 'done',
              usage: { inputTokens: 4, outputTokens: 2 },
              costUsd: 0.000321,
            }
          },
          async resume() {
            throw new Error('unused')
          },
          async fork() {
            throw new Error('unused')
          },
          async sessions() {
            return []
          },
          runtimeInfo() {
            return {
              cwd: '/workspace',
              model: 'fixture-model',
              contextWindowTokens: 100,
              tools: [],
              mcpServers: [],
              permissionMode: 'default',
              slashCommands: [],
              agents: [],
              skills: [],
              claudeCodeVersion: '2.1.208',
            }
          },
        }
      },
    }
    const app = render(
      <InteractiveApp factory={factory} initialSessions={[]} />,
    )

    app.stdin.write('run')
    app.stdin.write('\r')
    await flush()

    expect(app.lastFrame()).toContain(
      'Context · 6 tokens / 100 (6%) · $0.000321',
    )
  })

  it('toggles retained thinking with Ctrl+O without losing the full text', async () => {
    const reasoning = `Start ${'detail '.repeat(40)}reasoning tail stays visible`
    const factory: InteractiveServiceFactory = {
      async createService({ eventSink }) {
        return {
          async run() {
            eventSink({
              type: 'thinking-start',
              block: { type: 'thinking', thinking: '' },
            })
            eventSink({ type: 'thinking-delta', delta: reasoning })
            eventSink({
              type: 'thinking-stop',
              block: {
                type: 'thinking',
                thinking: reasoning,
                signature: 'sig',
              },
            })
            return {
              sessionId: 'session-1',
              text: 'done',
              usage: { inputTokens: 1, outputTokens: 1 },
            }
          },
          async resume() {
            throw new Error('unused')
          },
          async fork() {
            throw new Error('unused')
          },
          async sessions() {
            return []
          },
        }
      },
    }
    const app = render(
      <InteractiveApp factory={factory} initialSessions={[]} />,
    )

    app.stdin.write('think')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('Thought for a moment')
    expect(app.lastFrame()).not.toContain('reasoning tail stays visible')

    app.stdin.write('\u000f')
    await flush()
    expect(app.lastFrame()).toContain('reasoning tail stays visible')
    expect(app.lastFrame()).toContain('ctrl+o collapse')
  })

  it('streams a new session and then resumes it', async () => {
    const calls: string[] = []
    let closed = 0
    const factory: InteractiveServiceFactory = {
      async createService({ eventSink }) {
        return {
          async run(prompt) {
            calls.push(`run:${prompt}`)
            eventSink({ type: 'text-delta', delta: 'first answer' })
            return {
              sessionId: 'session-1',
              text: 'first answer',
              usage: { inputTokens: 1, outputTokens: 2 },
            }
          },
          async resume(sessionId, prompt) {
            calls.push(`resume:${sessionId}:${prompt}`)
            eventSink({ type: 'text-delta', delta: 'second answer' })
            return {
              sessionId,
              text: 'second answer',
              usage: { inputTokens: 2, outputTokens: 3 },
            }
          },
          async fork() {
            throw new Error('unused')
          },
          async sessions() {
            return []
          },
          async close() {
            closed += 1
          },
        }
      },
    }
    const app = render(
      <InteractiveApp factory={factory} initialSessions={[]} />,
    )

    await flush()
    app.stdin.write('first prompt')
    await flush()
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('first answer')

    app.stdin.write('continue')
    await flush()
    app.stdin.write('\r')
    await flush()

    expect(app.lastFrame()).toContain('second answer')
    expect(calls).toEqual(['run:first prompt', 'resume:session-1:continue'])
    expect(closed).toBe(2)
  })

  it('renders structured successful tool calls and results', async () => {
    const factory: InteractiveServiceFactory = {
      async createService({ eventSink }) {
        return {
          async run() {
            eventSink({
              type: 'tool-call',
              call: {
                id: 'call-1',
                name: 'Bash',
                input: { command: 'npm test' },
              },
            })
            eventSink({
              type: 'tool-result',
              callId: 'call-1',
              content: 'tests passed\nline 2\nline 3\nline 4\nline 5',
              isError: false,
            })
            return {
              sessionId: 'session-1',
              text: 'done',
              usage: { inputTokens: 1, outputTokens: 1 },
            }
          },
          async resume() {
            throw new Error('unused')
          },
          async fork() {
            throw new Error('unused')
          },
          async sessions() {
            return []
          },
        }
      },
    }
    const app = render(
      <InteractiveApp factory={factory} initialSessions={[]} />,
    )
    app.stdin.write('run tests')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('⏺ Bash(npm test)')
    expect(app.lastFrame()).toContain('npm test')
    expect(app.lastFrame()).toContain('⎿ tests passed')
    expect(app.lastFrame()).toContain('… +2 lines (ctrl+o to expand)')
    expect(app.lastFrame()).not.toContain('line 5')

    app.stdin.write('\u000f')
    await flush()
    expect(app.lastFrame()).toContain('line 5')
  })

  it('enters shell mode and routes new and resumed commands through shell turns', async () => {
    const calls: string[] = []
    let shellCall = 0
    const factory: InteractiveServiceFactory = {
      scheduledPrompts: true,
      async createService({ eventSink }) {
        const execute = async (command: string, sessionId: string) => {
          shellCall += 1
          const callId = `shell-${shellCall}`
          eventSink({ type: 'shell-command', callId, command })
          eventSink({
            type: 'shell-result',
            callId,
            stdout: `/workspace/${command}\n`,
            stderr: '',
            isError: false,
          })
          return {
            sessionId,
            text: `continued ${command}`,
            usage: { inputTokens: 1, outputTokens: 1 },
          }
        }
        return {
          async run() {
            throw new Error('ordinary run is unused')
          },
          async resume() {
            throw new Error('ordinary resume is unused')
          },
          async runShell(command) {
            calls.push(`run-shell:${command}`)
            return execute(command, 'shell-session')
          },
          async resumeShell(sessionId, command) {
            calls.push(`resume-shell:${sessionId}:${command}`)
            return execute(command, sessionId)
          },
          async fork() {
            throw new Error('unused')
          },
          async sessions() {
            return []
          },
        }
      },
    }
    const app = render(
      <InteractiveApp
        factory={factory}
        initialSessions={[]}
        diffLoader={async () => ({ files: [], additions: 0, deletions: 0 })}
      />,
    )

    app.stdin.write('!')
    await flush()
    expect(app.lastFrame()).toContain('! Enter a shell command')
    expect(app.lastFrame()).toContain('! for bash mode')

    app.stdin.write('pwd')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('! pwd')
    expect(app.lastFrame()).toContain('⎿ /workspace/pwd')
    expect(app.lastFrame()).toContain('continued pwd')
    expect(app.lastFrame()).not.toContain('❯ !pwd')

    app.stdin.write('!')
    await flush()
    app.stdin.write('echo ok')
    app.stdin.write('\r')
    await flush()
    expect(calls).toEqual([
      'run-shell:pwd',
      'resume-shell:shell-session:echo ok',
    ])
  })

  it('restores an interrupted shell command to the shell composer', async () => {
    const factory: InteractiveServiceFactory = {
      scheduledPrompts: true,
      async createService({ eventSink }) {
        return {
          async run() {
            throw new Error('unused')
          },
          async resume() {
            throw new Error('unused')
          },
          async runShell(command, signal) {
            const callId = 'shell-cancel'
            eventSink({ type: 'shell-command', callId, command })
            return new Promise((_resolve, reject) => {
              signal?.addEventListener(
                'abort',
                () => {
                  eventSink({ type: 'shell-cancelled', callId })
                  reject(new Error('cancelled'))
                },
                { once: true },
              )
            })
          },
          async fork() {
            throw new Error('unused')
          },
          async sessions() {
            return []
          },
        }
      },
    }
    const app = render(
      <InteractiveApp factory={factory} initialSessions={[]} />,
    )
    app.stdin.write('!')
    await flush()
    app.stdin.write('sleep 30')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('! sleep 30')

    app.stdin.write('\u001B')
    await new Promise((resolve) => setTimeout(resolve, 75))
    await flush()
    expect(app.lastFrame()).toContain('! sleep 30')
    expect(app.lastFrame()).toContain('! for bash mode')
    expect(app.lastFrame()).toContain('Interrupted by user.')
  })

  it('opens the diff dashboard and drills into the selected file', async () => {
    const snapshot = {
      files: [
        {
          path: 'fixture.txt',
          additions: 1,
          deletions: 1,
          patch:
            'diff --git a/fixture.txt b/fixture.txt\n--- a/fixture.txt\n+++ b/fixture.txt\n@@ -1 +1 @@\n-before\n+after\n',
        },
      ],
      additions: 1,
      deletions: 1,
    }
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            throw new Error('unused')
          },
        }}
        initialSessions={[]}
        diffLoader={async () => snapshot}
      />,
    )

    app.stdin.write('/diff')
    await flush()
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('Uncommitted changes (git diff HEAD)')
    expect(app.lastFrame()).toContain('❯ fixture.txt')

    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('-before')
    expect(app.lastFrame()).toContain('+after')
    expect(app.lastFrame()).toContain('Esc to back')
  })

  it('captures file-mutating turns as navigable diff sources', async () => {
    const turnSnapshot = {
      files: [
        {
          path: 'turn-one.txt',
          additions: 1,
          deletions: 1,
          patch: '@@ -1 +1 @@\n-before\n+after\n',
        },
      ],
      additions: 1,
      deletions: 1,
    }
    const currentSnapshot = {
      files: [
        {
          path: 'current.txt',
          additions: 1,
          deletions: 0,
          patch: '@@ -0,0 +1 @@\n+current\n',
        },
      ],
      additions: 1,
      deletions: 0,
    }
    let loadCount = 0
    const app = render(
      <InteractiveApp
        factory={{
          async createService({ eventSink }) {
            return {
              async run() {
                eventSink({
                  type: 'tool-call',
                  call: {
                    id: 'edit-one',
                    name: 'Edit',
                    input: {
                      file_path: '/tmp/turn-one.txt',
                      old_string: 'before',
                      new_string: 'after',
                    },
                  },
                })
                eventSink({
                  type: 'tool-result',
                  callId: 'edit-one',
                  content: 'Replaced 1 occurrence(s)',
                  isError: false,
                })
                return {
                  sessionId: 'session-1',
                  text: 'done',
                  usage: { inputTokens: 1, outputTokens: 1 },
                }
              },
              async resume() {
                throw new Error('unused')
              },
              async fork() {
                throw new Error('unused')
              },
              async sessions() {
                return []
              },
            }
          },
        }}
        initialSessions={[]}
        diffLoader={async () =>
          loadCount++ === 0 ? turnSnapshot : currentSnapshot
        }
      />,
    )

    app.stdin.write('edit it')
    app.stdin.write('\r')
    await flush()
    app.stdin.write('/diff')
    await flush()
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('current.txt')
    expect(app.lastFrame()).toContain('T1')

    app.stdin.write('\u001B[C')
    await flush()
    expect(app.lastFrame()).toContain('turn-one.txt')
    expect(app.lastFrame()).not.toContain('current.txt')
  })

  it('renders permission, MCP, and hook lifecycle feedback', async () => {
    const notifications: unknown[][] = []
    const factory: InteractiveServiceFactory = {
      async createService({ eventSink }) {
        return {
          async run() {
            eventSink({
              type: 'permission-decision',
              callId: 'call-1',
              behavior: 'allow',
            })
            eventSink({
              type: 'elicitation-complete',
              mcpServerName: 'fixture',
              elicitationId: 'elicit-1',
            })
            eventSink({
              type: 'hook',
              event: {
                type: 'started',
                hookId: 'hook-1',
                hookName: 'PreToolUse:Bash',
                hookEvent: 'PreToolUse',
              },
            })
            eventSink({
              type: 'hook',
              event: {
                type: 'response',
                hookId: 'hook-1',
                hookName: 'PreToolUse:Bash',
                hookEvent: 'PreToolUse',
                outcome: 'error',
              },
            })
            return {
              sessionId: 'session-1',
              text: 'done',
              usage: { inputTokens: 1, outputTokens: 1 },
            }
          },
          async resume() {
            throw new Error('unused')
          },
          async fork() {
            throw new Error('unused')
          },
          async sessions() {
            return []
          },
          async notify(...args) {
            notifications.push(args)
          },
        }
      },
    }
    const app = render(
      <InteractiveApp factory={factory} initialSessions={[]} />,
    )
    app.stdin.write('run')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('Permission allowed · call-1')
    expect(app.lastFrame()).toContain('MCP elicitation completed · fixture')
    expect(notifications).toEqual([
      [
        expect.any(String),
        'MCP elicitation completed · fixture',
        'elicitation_complete',
        'Praxis',
      ],
    ])
    expect(app.lastFrame()).toContain('Hook started · PreToolUse:Bash')
    expect(app.lastFrame()).toContain('Hook response · PreToolUse:Bash · error')
  })

  it('approves and retries only blocked auto-mode actions from Recently denied', async () => {
    const approved: Array<{ sessionId: string; display: string }> = []
    const retried: Array<{ sessionId: string; display: string }> = []
    const sessionId = 'session-1'
    let isApproved: ((call: ModelToolCall) => boolean) | undefined
    const deniedCall: ModelToolCall = {
      id: 'blocked-call',
      name: 'Bash',
      input: {
        command: 'rm -rf /tmp/target',
        description: 'Delete target',
      },
    }
    const deniedAction = {
      id: 'denied-1',
      call: deniedCall,
      display: 'Delete target',
      reason: 'Classifier policy',
      sessionId,
    }
    let deniedEntries = [deniedAction]
    const app = render(
      <InteractiveApp
        factory={{
          async createService(options) {
            isApproved = options.isSessionActionApproved
            return {
              async run() {
                return {
                  sessionId,
                  text: 'done',
                  usage: { inputTokens: 1, outputTokens: 1 },
                }
              },
              async resume() {
                throw new Error('unused')
              },
              async retryRecentlyDenied(retrySessionId, display) {
                retried.push({ sessionId: retrySessionId, display })
                return {
                  sessionId: retrySessionId,
                  text: 'retried',
                  usage: { inputTokens: 1, outputTokens: 1 },
                }
              },
              async approveRecentlyDenied(approveSessionId, display) {
                approved.push({ sessionId: approveSessionId, display })
              },
              async fork() {
                throw new Error('unused')
              },
              async sessions() {
                return []
              },
            }
          },
        }}
        initialSessions={[]}
        axScreenReader
        permissionRuleStore={{
          async load() {
            return []
          },
          async add() {},
        }}
        recentlyDeniedStore={{
          async load() {
            return deniedEntries
          },
          async record(action) {
            deniedEntries = [action, ...deniedEntries]
            return deniedEntries
          },
          async remove(id) {
            deniedEntries = deniedEntries.filter((action) => action.id !== id)
            return deniedEntries
          },
        }}
      />,
    )

    app.stdin.write('/permissions')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('Current tab: Recently denied')
    expect(app.lastFrame()).toContain(
      'Selected: 1. Denied: Delete target  Classifier policy',
    )
    expect(app.lastFrame()).not.toContain('rm -rf /tmp/other')

    app.stdin.write('r')
    await flush()
    expect(retried).toEqual([{ sessionId, display: 'Delete target' }])
    expect(isApproved?.(deniedCall)).toBe(true)
    expect(
      isApproved?.({
        ...deniedCall,
        input: { ...deniedCall.input, command: 'rm -rf /tmp/different' },
      }),
    ).toBe(false)

    app.stdin.write('/permissions')
    app.stdin.write('\r')
    await flush()
    app.stdin.write('\r')
    await flush()
    expect(approved).toEqual([{ sessionId, display: 'Delete target' }])
    expect(app.lastFrame()).toContain('Current tab: Allow')
    expect(app.lastFrame()).not.toContain('1. ✘ Delete target')
  })

  it('interrupts a busy turn with escape and restores the composer', async () => {
    const factory: InteractiveServiceFactory = {
      async createService() {
        return {
          async run(_prompt, signal) {
            await new Promise<void>((_resolve, reject) => {
              signal?.addEventListener(
                'abort',
                () => reject(new Error('provider aborted')),
                { once: true },
              )
            })
            throw new Error('unreachable')
          },
          async resume() {
            throw new Error('unused')
          },
          async fork() {
            throw new Error('unused')
          },
          async sessions() {
            return []
          },
        }
      },
    }
    const app = render(
      <InteractiveApp factory={factory} initialSessions={[]} />,
    )
    app.stdin.write('long task')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('esc to interrupt')
    app.stdin.write('\u001B')
    await new Promise((resolve) => setTimeout(resolve, 75))
    await flush()
    expect(app.lastFrame()).toContain('Interrupted by user.')
    expect(app.lastFrame()).toContain('Try "review this project"')
    expect(app.lastFrame()).not.toContain('provider aborted')
  })

  it('submits an initial prompt once after mounting', async () => {
    const calls: string[] = []
    const factory: InteractiveServiceFactory = {
      async createService() {
        return {
          async run(prompt) {
            calls.push(`run:${prompt}`)
            return {
              sessionId: 'initial-session',
              text: 'initial answer',
              usage: { inputTokens: 1, outputTokens: 1 },
            }
          },
          async resume(sessionId, prompt) {
            calls.push(`resume:${sessionId}:${prompt}`)
            return {
              sessionId,
              text: 'resume answer',
              usage: { inputTokens: 1, outputTokens: 1 },
            }
          },
          async fork() {
            throw new Error('unused')
          },
          async sessions() {
            return []
          },
        }
      },
    }
    const app = render(
      <InteractiveApp
        factory={factory}
        initialSessions={[]}
        initialPrompt="review this change"
      />,
    )

    await flush()
    await flush()

    expect(app.lastFrame()).toContain('initial answer')
    expect(calls).toEqual(['run:review this change'])
  })

  it('waits for resume selection before submitting an initial prompt once', async () => {
    const calls: string[] = []
    const factory: InteractiveServiceFactory = {
      async createService() {
        return {
          async run(prompt) {
            calls.push(`run:${prompt}`)
            return {
              sessionId: 'new-session',
              text: 'new answer',
              usage: { inputTokens: 1, outputTokens: 1 },
            }
          },
          async resume(sessionId, prompt) {
            calls.push(`resume:${sessionId}:${prompt}`)
            return {
              sessionId,
              text: 'continued answer',
              usage: { inputTokens: 1, outputTokens: 1 },
            }
          },
          async fork() {
            throw new Error('unused')
          },
          async sessions() {
            return []
          },
        }
      },
    }
    const app = render(
      <InteractiveApp
        factory={factory}
        initialSessions={[
          {
            sessionId: 'resume-session',
            lastPrompt: 'previous prompt',
            updatedAt: '2026-08-09T00:00:00.000Z',
            status: 'ready',
            issue: null,
          },
        ]}
        initialPrompt="continue review"
        allowNewSession={false}
        resume={{ sessionSelector: 'resume', requireSession: true }}
      />,
    )

    await flush()
    expect(calls).toEqual([])
    app.stdin.write('\r')
    await flush()
    await flush()

    expect(app.lastFrame()).toContain('continued answer')
    expect(calls).toEqual(['resume:resume-session:continue review'])
  })

  it('keeps one service alive and submits scheduled prompts while idle', async () => {
    const calls: string[] = []
    let created = 0
    let waits = 0
    const factory: InteractiveServiceFactory = {
      scheduledPrompts: true,
      async createService() {
        created += 1
        return {
          async run(prompt) {
            calls.push(`run:${prompt}`)
            return {
              sessionId: 'scheduled-session',
              text: 'scheduled answer',
              usage: { inputTokens: 1, outputTokens: 1 },
            }
          },
          async resume(sessionId, prompt) {
            calls.push(`resume:${sessionId}:${prompt}`)
            return {
              sessionId,
              text: 'manual answer',
              usage: { inputTokens: 1, outputTokens: 1 },
            }
          },
          async nextScheduledPrompt(signal) {
            waits += 1
            if (waits === 1) return { id: 'abc12345', prompt: 'cron prompt' }
            return new Promise((resolve) =>
              signal?.addEventListener('abort', () => resolve(null), {
                once: true,
              }),
            )
          },
          async fork() {
            throw new Error('unused')
          },
          async sessions() {
            return []
          },
        }
      },
    }
    const app = render(
      <InteractiveApp factory={factory} initialSessions={[]} />,
    )

    await flush()
    await flush()
    expect(app.lastFrame()).toContain('scheduled answer')

    app.stdin.write('manual prompt')
    await flush()
    app.stdin.write('\r')
    await flush()

    expect(calls).toEqual([
      'run:cron prompt',
      'resume:scheduled-session:manual prompt',
    ])
    expect(created).toBe(1)
  })

  it('redacts ambient credentials from interactive diagnostics', async () => {
    const secret = `interactive-diagnostic-secret-${'x'.repeat(200)}-canary`
    const variable = 'PRAXIS_TEST_API_KEY'
    const previous = process.env[variable]
    process.env[variable] = secret
    const factory: InteractiveServiceFactory = {
      async createService({ eventSink }) {
        return {
          async run() {
            eventSink({ type: 'warning', message: `warning ${secret}` })
            eventSink({
              type: 'tool-call',
              call: {
                id: 'secret-call',
                name: 'Bash',
                input: { command: `printf ${secret}` },
              },
            })
            eventSink({
              type: 'tool-result',
              callId: 'secret-call',
              content: `tool error ${secret}`,
              isError: true,
            })
            eventSink({
              type: 'failed',
              message: `runtime failure ${secret}`,
              retryable: false,
            })
            throw new Error(`provider failure ${secret}`)
          },
          async resume() {
            throw new Error('unused')
          },
          async fork() {
            throw new Error('unused')
          },
          async sessions() {
            return []
          },
        }
      },
    }

    try {
      const app = render(
        <InteractiveApp factory={factory} initialSessions={[]} />,
      )
      await flush()
      app.stdin.write('trigger failure')
      await flush()
      app.stdin.write('\r')
      await flush()

      expect(app.lastFrame()).toContain('[REDACTED]')
      expect(app.lastFrame()).not.toContain(secret)
      expect(app.lastFrame()).not.toContain(secret.slice(0, 40))
    } finally {
      if (previous === undefined) delete process.env[variable]
      else process.env[variable] = previous
    }
  })

  it('reports close failures and leaves the prompt usable', async () => {
    const factory: InteractiveServiceFactory = {
      async createService() {
        return {
          async run() {
            return {
              sessionId: 'session-1',
              text: 'done',
              usage: { inputTokens: 1, outputTokens: 1 },
            }
          },
          async resume() {
            throw new Error('unused')
          },
          async fork() {
            throw new Error('unused')
          },
          async sessions() {
            return []
          },
          async close() {
            throw new Error('close failed')
          },
        }
      },
    }
    const app = render(
      <InteractiveApp factory={factory} initialSessions={[]} />,
    )

    await flush()
    app.stdin.write('run')
    await flush()
    app.stdin.write('\r')
    await flush()

    expect(app.lastFrame()).toContain('done')
    expect(app.lastFrame()).toContain('close failed')
    expect(app.lastFrame()).toContain('? for shortcuts')
    expect(app.lastFrame()).not.toContain('ready…')
  })

  it('routes Escape through each Decision surface resolver exactly once', async () => {
    let permissionResult: PermissionApproval | undefined
    let questionResult: unknown = 'pending'
    let planResult: ClaudePlanApprovalResult | undefined
    let elicitationResult: unknown = 'pending'
    const call: ModelToolCall = {
      id: 'decision-cancel',
      name: 'Bash',
      input: { command: 'npm test' },
    }
    const app = render(
      <InteractiveApp
        factory={{
          async createService({
            approveTool,
            askUser,
            approvePlan,
            onElicitation,
          }) {
            return {
              async run() {
                const permission = approveTool?.(call)
                const question = askUser?.([
                  {
                    question: 'Continue?',
                    header: 'Confirm',
                    options: [{ label: 'Yes', description: 'Continue' }],
                    multiSelect: false,
                  },
                ])
                const plan = approvePlan?.({
                  action: 'exit',
                  planPath: '/tmp/plan.md',
                  plan: '# Plan\n\n1. Implement.',
                  previousMode: 'default',
                })
                const elicitation = onElicitation?.({
                  serverName: 'fixture',
                  message: 'Provide a value',
                  mode: 'form',
                  requestedSchema: {
                    type: 'object',
                    properties: { code: { type: 'string' } },
                  },
                })
                permissionResult = await permission
                questionResult = await question
                planResult = await plan
                elicitationResult = await elicitation
                return {
                  sessionId: 'decision-session',
                  text: 'all decisions cancelled',
                  usage: { inputTokens: 1, outputTokens: 1 },
                }
              },
              async resume() {
                throw new Error('unused')
              },
              async fork() {
                throw new Error('unused')
              },
              async sessions() {
                return []
              },
            }
          },
        }}
        initialSessions={[]}
      />,
    )

    app.stdin.write('start')
    app.stdin.write('\r')
    await waitFor(() =>
      app.lastFrame()?.includes('Bash command') ? true : undefined,
    )
    app.stdin.write('\u001B')
    await waitFor(() =>
      app.lastFrame()?.includes('Ready to code?') ? true : undefined,
    )
    app.stdin.write('\u001B')
    await waitFor(() =>
      app.lastFrame()?.includes('Confirm: Continue?') ? true : undefined,
    )
    app.stdin.write('\u001B')
    await waitFor(() =>
      app.lastFrame()?.includes('MCP server “fixture” requests your input')
        ? true
        : undefined,
    )
    app.stdin.write('\u001B')
    await waitFor(() =>
      app.lastFrame()?.includes('all decisions cancelled') ? true : undefined,
    )

    expect(permissionResult).toBe(false)
    expect(questionResult).toBeNull()
    expect(planResult).toEqual({ behavior: 'deny' })
    expect(elicitationResult).toEqual({ action: 'cancel' })
  })

  it('asks before an ask-permission tool and forwards the decision', async () => {
    let approval: PermissionApproval | undefined
    const notifications: unknown[][] = []
    const suspendProcess = vi.fn()
    const call: ModelToolCall = {
      id: 'call-1',
      name: 'Bash',
      input: { command: 'npm test' },
    }
    const factory: InteractiveServiceFactory = {
      async createService({ approveTool }) {
        return {
          async run() {
            approval = await approveTool?.(call, call, {
              behavior: 'ask',
              reason: 'Command requires confirmation.',
            })
            return {
              sessionId: 'session-1',
              text: 'done',
              usage: { inputTokens: 1, outputTokens: 1 },
            }
          },
          async resume() {
            throw new Error('unused')
          },
          async fork() {
            throw new Error('unused')
          },
          async sessions() {
            return []
          },
          async notify(...args) {
            notifications.push(args)
          },
        }
      },
    }
    const app = render(
      <InteractiveApp
        factory={factory}
        initialSessions={[]}
        suspendProcess={suspendProcess}
        notificationDelayMs={1}
        axScreenReader
      />,
    )

    await flush()
    app.stdin.write('run tests')
    await flush()
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('Bash command')
    expect(app.lastFrame()).toContain('npm test')
    expect(app.lastFrame()).toContain('Command requires confirmation.')
    expect(app.lastFrame()).toContain('Selected: 1. Yes')
    expect(app.lastFrame()).toContain(
      'Yes, and don’t ask again for: npm test:*',
    )
    expect(app.lastFrame()).not.toContain('❯')
    await delay(10)
    await flush()
    expect(notifications).toEqual([
      [
        expect.any(String),
        'Approval required for Bash',
        'permission_prompt',
        'Praxis',
      ],
    ])

    app.stdin.write('\u001a')
    await new Promise((resolve) => setTimeout(resolve, 75))
    await flush()
    expect(suspendProcess).toHaveBeenCalledOnce()
    expect(app.lastFrame()).toContain('Bash command')

    app.stdin.write('y')
    await flush()
    expect(approval).toEqual({ behavior: 'allow' })
    expect(app.lastFrame()).toContain('done')
  })

  it('edits, persists, and immediately applies a Bash prefix rule', async () => {
    const added: unknown[] = []
    const approvals: PermissionApproval[] = []
    const call: ModelToolCall = {
      id: 'call-always',
      name: 'Bash',
      input: { command: 'npm test' },
    }
    const app = render(
      <InteractiveApp
        factory={{
          async createService({ approveTool, isSessionActionApproved }) {
            return {
              async run() {
                const approval = await approveTool?.(call)
                if (approval !== undefined) approvals.push(approval)
                expect(
                  isSessionActionApproved?.({
                    ...call,
                    id: 'call-later',
                    input: { command: 'npm run lint' },
                  }),
                ).toBe(true)
                return {
                  sessionId: 'session-permission',
                  text: 'done',
                  usage: { inputTokens: 1, outputTokens: 1 },
                }
              },
              async resume() {
                throw new Error('unused')
              },
              async fork() {
                throw new Error('unused')
              },
              async sessions() {
                return []
              },
            }
          },
        }}
        initialSessions={[]}
        permissionRuleStore={{
          async load() {
            return []
          },
          async add(input) {
            added.push(input)
          },
        }}
        display={{ cwd: '/work/project', version: 'test' }}
      />,
    )

    app.stdin.write('run')
    app.stdin.write('\r')
    await flush()
    app.stdin.write('\u001B[B')
    await flush()
    expect(app.lastFrame()).toContain('❯ 2. Yes, and don’t ask again')
    for (let index = 0; index < 10; index += 1) app.stdin.write('\u007f')
    app.stdin.write('npm run:*')
    await flush()
    app.stdin.write('\r')
    await flush()
    expect(added).toEqual([
      { behavior: 'allow', rule: 'Bash(npm run:*)', scope: 'local' },
    ])
    expect(approvals).toEqual([
      {
        behavior: 'allow',
        updatedPermissions: [
          {
            type: 'addRules',
            rules: [{ toolName: 'Bash', ruleContent: 'npm run:*' }],
            behavior: 'allow',
            destination: 'localSettings',
          },
        ],
      },
    ])
    expect(app.lastFrame()).toContain('done')
  })

  it('forwards ordered permission updates across every destination', async () => {
    const approvals: PermissionApproval[] = []
    const suggestions = [
      {
        type: 'replaceRules' as const,
        rules: [{ toolName: 'Read' }],
        behavior: 'allow' as const,
        destination: 'userSettings' as const,
      },
      {
        type: 'removeRules' as const,
        rules: [{ toolName: 'Bash', ruleContent: 'old:*' }],
        behavior: 'deny' as const,
        destination: 'projectSettings' as const,
      },
      {
        type: 'addDirectories' as const,
        directories: ['/shared'],
        destination: 'localSettings' as const,
      },
      {
        type: 'removeDirectories' as const,
        directories: ['/old'],
        destination: 'session' as const,
      },
      {
        type: 'setMode' as const,
        mode: 'default' as const,
        destination: 'cliArg' as const,
      },
    ]
    const call: ModelToolCall = {
      id: 'permission-destinations',
      name: 'Bash',
      input: { command: 'custom-command' },
    }
    const app = render(
      <InteractiveApp
        factory={{
          async createService({ approveTool }) {
            return {
              async run() {
                const approval = await approveTool?.(call, call, {
                  behavior: 'ask',
                  suggestions,
                })
                if (approval !== undefined) approvals.push(approval)
                return {
                  sessionId: 'session-destinations',
                  text: 'done',
                  usage: { inputTokens: 1, outputTokens: 1 },
                }
              },
              async resume() {
                throw new Error('unused')
              },
              async fork() {
                throw new Error('unused')
              },
              async sessions() {
                return []
              },
            }
          },
        }}
        initialSessions={[]}
        display={{ cwd: '/work/project', version: 'test' }}
      />,
    )

    app.stdin.write('run')
    app.stdin.write('\r')
    await flush()
    app.stdin.write('\u001B[B')
    await flush()
    app.stdin.write('\r')
    await flush()
    expect(approvals).toEqual([
      { behavior: 'allow', updatedPermissions: suggestions },
    ])
    expect(app.lastFrame()).toContain('done')
  })

  it('shows file diffs and allows all edits for the current session', async () => {
    const approvals: PermissionApproval[] = []
    const edit: ModelToolCall = {
      id: 'edit-once',
      name: 'Edit',
      input: {
        file_path: '/work/project/index.ts',
        old_string: 'const before = 1',
        new_string: 'const after = 2',
      },
    }
    const app = render(
      <InteractiveApp
        factory={{
          async createService({ approveTool, isSessionActionApproved }) {
            return {
              async run() {
                const approval = await approveTool?.(edit)
                if (approval !== undefined) approvals.push(approval)
                expect(
                  isSessionActionApproved?.({
                    id: 'write-later',
                    name: 'Write',
                    input: {
                      file_path: '/work/project/output.ts',
                      content: 'export {}',
                    },
                  }),
                ).toBe(true)
                return {
                  sessionId: 'session-edits',
                  text: 'edited',
                  usage: { inputTokens: 1, outputTokens: 1 },
                }
              },
              async resume() {
                throw new Error('unused')
              },
              async fork() {
                throw new Error('unused')
              },
              async sessions() {
                return []
              },
            }
          },
        }}
        initialSessions={[]}
        display={{ cwd: '/work/project', version: 'test' }}
      />,
    )

    app.stdin.write('edit')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('Edit file')
    expect(app.lastFrame()).toContain('- const before = 1')
    expect(app.lastFrame()).toContain('+ const after = 2')
    expect(app.lastFrame()).toContain('allow all edits during this session')

    app.stdin.write('2')
    await flush()
    expect(approvals).toEqual([
      {
        behavior: 'allow',
        updatedPermissions: [
          {
            type: 'setMode',
            mode: 'acceptEdits',
            destination: 'session',
          },
        ],
      },
    ])
    expect(app.lastFrame()).toContain('edited')
  })

  it('persists WebFetch permission by domain and applies it immediately', async () => {
    const added: unknown[] = []
    const first: ModelToolCall = {
      id: 'fetch-first',
      name: 'WebFetch',
      input: { url: 'https://docs.example.com/one', prompt: 'Read it' },
    }
    const app = render(
      <InteractiveApp
        factory={{
          async createService({ approveTool, isSessionActionApproved }) {
            return {
              async run() {
                await approveTool?.(first)
                expect(
                  isSessionActionApproved?.({
                    ...first,
                    id: 'fetch-second',
                    input: {
                      url: 'https://docs.example.com/two',
                      prompt: 'Read more',
                    },
                  }),
                ).toBe(true)
                expect(
                  isSessionActionApproved?.({
                    ...first,
                    id: 'fetch-other',
                    input: { url: 'https://example.net', prompt: 'No' },
                  }),
                ).toBe(false)
                return {
                  sessionId: 'session-fetch',
                  text: 'fetched',
                  usage: { inputTokens: 1, outputTokens: 1 },
                }
              },
              async resume() {
                throw new Error('unused')
              },
              async fork() {
                throw new Error('unused')
              },
              async sessions() {
                return []
              },
            }
          },
        }}
        initialSessions={[]}
        permissionRuleStore={{
          async load() {
            return []
          },
          async add(input) {
            added.push(input)
          },
        }}
        display={{ cwd: '/work/project', version: 'test' }}
      />,
    )

    app.stdin.write('fetch')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('Fetch')
    expect(app.lastFrame()).toContain('docs.example.com')
    app.stdin.write('2')
    await flush()
    expect(added).toEqual([
      {
        behavior: 'allow',
        rule: 'WebFetch(domain:docs.example.com)',
        scope: 'local',
      },
    ])
    expect(app.lastFrame()).toContain('fetched')
  })

  it('returns generic permission feedback with its selected decision', async () => {
    let approval: PermissionApproval | undefined
    const call: ModelToolCall = {
      id: 'call-feedback',
      name: 'Bash',
      input: { command: 'npm test' },
    }
    const app = render(
      <InteractiveApp
        factory={{
          async createService({ approveTool }) {
            return {
              async run() {
                approval = await approveTool?.(call)
                return {
                  sessionId: 'session-feedback',
                  text: 'done',
                  usage: { inputTokens: 1, outputTokens: 1 },
                }
              },
              async resume() {
                throw new Error('unused')
              },
              async fork() {
                throw new Error('unused')
              },
              async sessions() {
                return []
              },
            }
          },
        }}
        initialSessions={[]}
      />,
    )

    app.stdin.write('run')
    app.stdin.write('\r')
    await flush()
    app.stdin.write('\t')
    await flush()
    app.stdin.write('use the focused test')
    app.stdin.write('\r')
    await flush()
    expect(approval).toEqual({
      behavior: 'allow',
      feedback: 'use the focused test',
    })
  })

  it('collects interactive model questions with numbered and custom answers', async () => {
    let result: unknown
    const factory: InteractiveServiceFactory = {
      async createService({ askUser }) {
        return {
          async run() {
            result = await askUser?.([
              {
                question: 'Which runtime?',
                header: 'Runtime',
                options: [
                  {
                    label: 'Node',
                    description: 'Use Node.js',
                    preview: 'Node preview',
                  },
                  { label: 'Bun', description: 'Use Bun' },
                ],
                multiSelect: false,
              },
              {
                question: 'Which checks?',
                header: 'Checks',
                options: [
                  { label: 'Tests', description: 'Run tests' },
                  { label: 'Types', description: 'Run typecheck' },
                ],
                multiSelect: true,
              },
            ])
            return {
              sessionId: 'session-1',
              text: 'done',
              usage: { inputTokens: 1, outputTokens: 1 },
            }
          },
          async resume() {
            throw new Error('unused')
          },
          async fork() {
            throw new Error('unused')
          },
          async sessions() {
            return []
          },
        }
      },
    }
    const app = render(
      <InteractiveApp factory={factory} initialSessions={[]} axScreenReader />,
    )
    await flush()
    app.stdin.write('start')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('Runtime: Which runtime?')
    expect(app.lastFrame()).toContain('Question 1 of 2')
    expect(app.lastFrame()).toContain('1. Node — Use Node.js')
    expect(app.lastFrame()).toContain('Node preview')
    expect(app.lastFrame()).toContain('Current answer: (empty)')
    expect(app.lastFrame()).toContain(
      'Enter one option number or custom text · Escape cancels',
    )
    expect(app.lastFrame()).not.toContain('❯')
    app.stdin.write('Bun, with npm')
    await flush()
    expect(app.lastFrame()).toContain('Current answer: Bun, with npm')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('Checks: Which checks?')
    expect(app.lastFrame()).toContain('Question 2 of 2')
    expect(app.lastFrame()).toContain(
      'Enter comma-separated option numbers or custom text · Escape cancels',
    )
    app.stdin.write('1, custom lint')
    app.stdin.write('\r')
    await flush()
    expect(result).toEqual({
      answers: {
        'Which runtime?': 'Bun, with npm',
        'Which checks?': 'Tests, custom lint',
      },
    })
  })

  it('cancels interactive questions when the tool signal aborts', async () => {
    const controller = new AbortController()
    let result: unknown = 'pending'
    const factory: InteractiveServiceFactory = {
      async createService({ askUser }) {
        return {
          async run() {
            result = await askUser?.(
              [
                {
                  question: 'Continue?',
                  header: 'Confirm',
                  options: [
                    { label: 'Yes', description: 'Continue' },
                    { label: 'No', description: 'Stop' },
                  ],
                  multiSelect: false,
                },
              ],
              controller.signal,
            )
            return {
              sessionId: 'session-1',
              text: 'done',
              usage: { inputTokens: 1, outputTokens: 1 },
            }
          },
          async resume() {
            throw new Error('unused')
          },
          async fork() {
            throw new Error('unused')
          },
          async sessions() {
            return []
          },
        }
      },
    }
    const app = render(
      <InteractiveApp factory={factory} initialSessions={[]} />,
    )
    await flush()
    app.stdin.write('start')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('Confirm: Continue?')
    controller.abort()
    await flush()
    expect(result).toBeNull()
    expect(app.lastFrame()).toContain('done')
  })

  it('times out AskUserQuestion without affecting MCP elicitation', async () => {
    vi.useFakeTimers()
    try {
      let answer: unknown = 'pending'
      const factory: InteractiveServiceFactory = {
        async createService({ askUser }) {
          return {
            async run() {
              answer = await askUser?.([
                {
                  question: 'Continue?',
                  header: 'Confirm',
                  options: [{ label: 'Yes', description: 'Continue' }],
                  multiSelect: false,
                },
              ])
              return {
                sessionId: 'session-1',
                text: 'done',
                usage: { inputTokens: 1, outputTokens: 1 },
              }
            },
            async resume() {
              throw new Error('unused')
            },
            async fork() {
              throw new Error('unused')
            },
            async sessions() {
              return []
            },
          }
        },
      }
      const app = render(
        <InteractiveApp
          factory={factory}
          initialSessions={[]}
          runtimeSettings={projectRuntimeSettings({
            settings: { askUserQuestionTimeout: '60s' },
            state: {},
          })}
        />,
      )
      await vi.runAllTimersAsync()
      app.stdin.write('start')
      app.stdin.write('\r')
      await vi.waitFor(() => {
        expect(app.lastFrame()).toContain('Confirm: Continue?')
      })
      await vi.advanceTimersByTimeAsync(60_000)
      expect(answer).toBeNull()
      await vi.waitFor(() => {
        expect(app.lastFrame()).toContain('done')
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows plan content and forwards plan approval', async () => {
    let approval: ClaudePlanApprovalResult | undefined
    const factory: InteractiveServiceFactory = {
      async createService({ approvePlan }) {
        return {
          async run() {
            approval = await approvePlan?.({
              action: 'exit',
              planPath: '/tmp/plan.md',
              plan: '# Plan\n\n1. Implement.',
              previousMode: 'default',
            })
            return {
              sessionId: 'session-1',
              text: 'done',
              usage: { inputTokens: 1, outputTokens: 1 },
            }
          },
          async resume() {
            throw new Error('unused')
          },
          async fork() {
            throw new Error('unused')
          },
          async sessions() {
            return []
          },
        }
      },
    }
    const app = render(
      <InteractiveApp factory={factory} initialSessions={[]} axScreenReader />,
    )
    await flush()
    app.stdin.write('start')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('Ready to code?')
    expect(app.lastFrame()).toContain('1. Implement.')
    expect(app.lastFrame()).toContain('Selected: 1. Yes, and use auto mode')
    expect(app.lastFrame()).toContain('2. Yes, manually approve edits')
    expect(app.lastFrame()).toContain('3. No, keep planning')
    for (const action of [
      'Enter selection [1-3]',
      'Use up/down arrows to change selection',
      'Press 1, 2, or 3 to choose directly',
      'Press y to approve',
      'Press n to keep planning',
      'Tab to add feedback',
      'Escape to cancel',
    ])
      expect((app.lastFrame() ?? '').replace(/\s+/g, ' ')).toContain(action)
    expect(app.lastFrame()).not.toContain('❯')
    app.stdin.write('y')
    await flush()
    expect(approval).toEqual({ behavior: 'allow', permissionMode: 'auto' })
  })

  it('announces plan approval selection without color', async () => {
    const previousNoColor = process.env.NO_COLOR
    process.env.NO_COLOR = '1'
    try {
      const factory: InteractiveServiceFactory = {
        async createService({ approvePlan }) {
          return {
            async run() {
              await approvePlan?.({
                action: 'exit',
                planPath: '/tmp/plan.md',
                plan: '# Plan\n\n1. Implement.',
                previousMode: 'default',
              })
              return {
                sessionId: 'session-no-color-plan',
                text: 'done',
                usage: { inputTokens: 1, outputTokens: 1 },
              }
            },
            async resume() {
              throw new Error('unused')
            },
            async fork() {
              throw new Error('unused')
            },
            async sessions() {
              return []
            },
          }
        },
      }
      const app = render(
        <InteractiveApp
          factory={factory}
          initialSessions={[]}
          axScreenReader={false}
        />,
      )
      await flush()
      app.stdin.write('start')
      app.stdin.write('\r')
      await flush()
      const first = app.lastFrame() ?? ''
      const firstDecision = first.slice(first.indexOf('Ready to code?'))
      expect(first).toContain('Selected: 1. Yes, and use auto mode')
      expect(firstDecision).not.toContain('❯')
      expectNoColorSgr(first)

      app.stdin.write('\u001B[B')
      await flush()
      const second = app.lastFrame() ?? ''
      const secondDecision = second.slice(second.indexOf('Ready to code?'))
      expect(second).toContain('Selected: 2. Yes, manually approve edits')
      expect(second).not.toContain('Selected: 1. Yes, and use auto mode')
      expect(secondDecision).not.toContain('❯')
      expectNoColorSgr(second)
    } finally {
      if (previousNoColor === undefined) delete process.env.NO_COLOR
      else process.env.NO_COLOR = previousNoColor
    }
  })

  it('preserves plan numeric, navigation, feedback-toggle, and rejection keys', async () => {
    const results: ClaudePlanApprovalResult[] = []
    const request = {
      action: 'exit' as const,
      planPath: '/tmp/plan.md',
      previousMode: 'default' as const,
    }
    const app = render(
      <InteractiveApp
        factory={{
          async createService({ approvePlan }) {
            if (approvePlan === undefined)
              throw new Error('approvePlan callback is required')
            return {
              async run() {
                for (let index = 1; index <= 6; index += 1) {
                  results.push(
                    await approvePlan({
                      ...request,
                      planPath: `/tmp/plan-${index}.md`,
                    }),
                  )
                }
                return {
                  sessionId: 'session-plan-keys',
                  text: 'done',
                  usage: { inputTokens: 1, outputTokens: 1 },
                }
              },
              async resume() {
                throw new Error('unused')
              },
              async fork() {
                throw new Error('unused')
              },
              async sessions() {
                return []
              },
            }
          },
        }}
        initialSessions={[]}
      />,
    )
    await flush()
    app.stdin.write('start')
    app.stdin.write('\r')
    await waitFor(() =>
      app.lastFrame()?.includes('/tmp/plan-1.md') ? true : undefined,
    )
    app.stdin.write('2')
    await waitFor(() => (results.length === 1 ? true : undefined))
    await waitFor(() =>
      app.lastFrame()?.includes('/tmp/plan-2.md') ? true : undefined,
    )
    app.stdin.write('n')
    await waitFor(() => (results.length === 2 ? true : undefined))
    await waitFor(() =>
      app.lastFrame()?.includes('/tmp/plan-3.md') ? true : undefined,
    )
    app.stdin.write('\u001B[B')
    await flush()
    app.stdin.write('\r')
    await waitFor(() => (results.length === 3 ? true : undefined))
    await waitFor(() =>
      app.lastFrame()?.includes('/tmp/plan-4.md') ? true : undefined,
    )
    app.stdin.write('\u001B[B')
    await flush()
    app.stdin.write('\u001B[A')
    await flush()
    app.stdin.write('\r')
    await waitFor(() => (results.length === 4 ? true : undefined))
    await waitFor(() =>
      app.lastFrame()?.includes('/tmp/plan-5.md') ? true : undefined,
    )
    app.stdin.write('\t')
    await flush()
    expect(app.lastFrame()).toContain('Add feedback for implementation')
    app.stdin.write('\t')
    await flush()
    expect(app.lastFrame()).toContain('Enter to confirm')
    app.stdin.write('\r')
    await waitFor(() => (results.length === 5 ? true : undefined))
    await waitFor(() =>
      app.lastFrame()?.includes('/tmp/plan-6.md') ? true : undefined,
    )
    app.stdin.write('\t')
    await flush()
    app.stdin.write('feedback')
    app.stdin.write('\r')
    await waitFor(() => (results.length === 6 ? true : undefined))
    expect(results).toEqual([
      { behavior: 'allow', permissionMode: 'default' },
      { behavior: 'deny' },
      { behavior: 'allow', permissionMode: 'default' },
      { behavior: 'allow', permissionMode: 'auto' },
      { behavior: 'allow', permissionMode: 'auto' },
      { behavior: 'allow', permissionMode: 'auto', feedback: 'feedback' },
    ])
  })

  it('declines plan approval when the tool signal aborts', async () => {
    const controller = new AbortController()
    let approval: ClaudePlanApprovalResult | undefined
    const factory: InteractiveServiceFactory = {
      async createService({ approvePlan }) {
        return {
          async run() {
            approval = await approvePlan?.(
              {
                action: 'exit',
                planPath: '/tmp/plan.md',
                previousMode: 'default',
              },
              controller.signal,
            )
            return {
              sessionId: 'session-1',
              text: 'done',
              usage: { inputTokens: 1, outputTokens: 1 },
            }
          },
          async resume() {
            throw new Error('unused')
          },
          async fork() {
            throw new Error('unused')
          },
          async sessions() {
            return []
          },
        }
      },
    }
    const app = render(
      <InteractiveApp factory={factory} initialSessions={[]} />,
    )
    await flush()
    app.stdin.write('start')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('Ready to code?')
    controller.abort()
    await flush()
    expect(approval).toEqual({ behavior: 'deny' })
    expect(app.lastFrame()).toContain('done')
  })

  it('returns the manually-approved plan mode with implementation feedback', async () => {
    let approval: ClaudePlanApprovalResult | undefined
    const app = render(
      <InteractiveApp
        factory={{
          async createService({ approvePlan }) {
            return {
              async run() {
                approval = await approvePlan?.({
                  action: 'exit',
                  planPath: '/tmp/plan.md',
                  plan: '# Plan',
                  previousMode: 'default',
                })
                return {
                  sessionId: 'session-plan-feedback',
                  text: 'done',
                  usage: { inputTokens: 1, outputTokens: 1 },
                }
              },
              async resume() {
                throw new Error('unused')
              },
              async fork() {
                throw new Error('unused')
              },
              async sessions() {
                return []
              },
            }
          },
        }}
        initialSessions={[]}
      />,
    )

    app.stdin.write('start')
    app.stdin.write('\r')
    await flush()
    app.stdin.write('\u001B[B')
    await flush()
    app.stdin.write('\t')
    await flush()
    app.stdin.write('also update docs')
    app.stdin.write('\r')
    await flush()
    expect(approval).toEqual({
      behavior: 'allow',
      permissionMode: 'default',
      feedback: 'also update docs',
    })
  })

  it('round-trips interactive MCP elicitation form data', async () => {
    let result: unknown
    const factory: InteractiveServiceFactory = {
      async createService({ onElicitation }) {
        return {
          async run() {
            result = await onElicitation?.({
              serverName: 'fixture',
              message: 'Provide a value',
              mode: 'form',
              requestedSchema: {
                type: 'object',
                properties: { code: { type: 'string' } },
              },
            })
            return {
              sessionId: 'session-1',
              text: 'done',
              usage: { inputTokens: 1, outputTokens: 1 },
            }
          },
          async resume() {
            throw new Error('unused')
          },
          async fork() {
            throw new Error('unused')
          },
          async sessions() {
            return []
          },
        }
      },
    }
    const app = render(
      <InteractiveApp factory={factory} initialSessions={[]} />,
    )

    await flush()
    app.stdin.write('run')
    await flush()
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain(
      'MCP server “fixture” requests your input',
    )
    expect(app.lastFrame()).toContain('code: Type something…')
    app.stdin.write('ok')
    await flush()
    app.stdin.write('\r')
    await flush()
    app.stdin.write('\r')
    await flush()

    expect(result).toEqual({ action: 'accept', content: { code: 'ok' } })
    expect(app.lastFrame()).toContain('done')
  })

  it('navigates boolean, enum, and required multi-select elicitation fields', async () => {
    let result: unknown
    const app = render(
      <InteractiveApp
        factory={{
          async createService({ onElicitation }) {
            return {
              async run() {
                result = await onElicitation?.({
                  serverName: 'fixture',
                  message: 'Configure the task',
                  mode: 'form',
                  requestedSchema: {
                    type: 'object',
                    properties: {
                      name: { type: 'string' },
                      enabled: { type: 'boolean' },
                      color: {
                        type: 'string',
                        enum: ['red', 'blue'],
                      },
                      tags: {
                        type: 'array',
                        items: { type: 'string', enum: ['fast', 'safe'] },
                        minItems: 1,
                      },
                    },
                    required: ['name', 'enabled', 'tags'],
                  },
                })
                return {
                  sessionId: 'session-form-controls',
                  text: 'configured',
                  usage: { inputTokens: 1, outputTokens: 1 },
                }
              },
              async resume() {
                throw new Error('unused')
              },
              async fork() {
                throw new Error('unused')
              },
              async sessions() {
                return []
              },
            }
          },
        }}
        initialSessions={[]}
      />,
    )

    app.stdin.write('run')
    app.stdin.write('\r')
    await flush()
    app.stdin.write('Ada')
    await flush()
    app.stdin.write('\r')
    await flush()
    app.stdin.write(' ')
    await flush()
    app.stdin.write('\r')
    await flush()
    app.stdin.write('\u001B[C')
    await flush()
    app.stdin.write('\u001B[B')
    await flush()
    app.stdin.write(' ')
    await flush()
    app.stdin.write('\r')
    await flush()
    app.stdin.write('\u001B[C')
    await flush()
    app.stdin.write(' ')
    await flush()
    app.stdin.write('\r')
    await flush()
    app.stdin.write('\r')
    await flush()

    expect(result).toEqual({
      action: 'accept',
      content: {
        name: 'Ada',
        enabled: true,
        color: 'blue',
        tags: ['fast'],
      },
    })
    expect(app.lastFrame()).toContain('configured')
  })

  it('collapses expanded elicitation options before cancelling the form', async () => {
    let result: unknown = 'pending'
    const app = render(
      <InteractiveApp
        factory={{
          async createService({ onElicitation }) {
            return {
              async run() {
                result = await onElicitation?.({
                  serverName: 'fixture',
                  message: 'Choose a color',
                  mode: 'form',
                  requestedSchema: {
                    type: 'object',
                    properties: {
                      color: { type: 'string', enum: ['red', 'blue'] },
                    },
                  },
                })
                return {
                  sessionId: 'elicitation-options-session',
                  text: 'elicitation finished',
                  usage: { inputTokens: 1, outputTokens: 1 },
                }
              },
              async resume() {
                throw new Error('unused')
              },
              async fork() {
                throw new Error('unused')
              },
              async sessions() {
                return []
              },
            }
          },
        }}
        initialSessions={[]}
      />,
    )

    app.stdin.write('run')
    app.stdin.write('\r')
    await waitFor(() =>
      app.lastFrame()?.includes('Choose a color') ? true : undefined,
    )
    app.stdin.write('\u001B[C')
    await flush()
    app.stdin.write('\u001B')
    await delay(75)
    await flush()
    expect(result).toBe('pending')
    expect(app.lastFrame()).toContain('Choose a color')

    app.stdin.write('\u001B')
    await delay(75)
    await waitFor(() =>
      app.lastFrame()?.includes('elicitation finished') ? true : undefined,
    )
    expect(result).toEqual({ action: 'cancel' })
  })

  it('opens URL elicitations and waits for the matching completion event', async () => {
    let result: unknown
    let eventSink: RuntimeEventSink | undefined
    const opened: string[] = []
    const app = render(
      <InteractiveApp
        factory={{
          async createService(options) {
            eventSink = options.eventSink
            return {
              async run() {
                result = await options.onElicitation?.({
                  serverName: 'browser-fixture',
                  message: 'Authorize access',
                  mode: 'url',
                  url: 'https://example.com/authorize',
                  elicitationId: 'elicit-1',
                })
                return {
                  sessionId: 'session-url',
                  text: 'accepted',
                  usage: { inputTokens: 1, outputTokens: 1 },
                }
              },
              async resume() {
                throw new Error('unused')
              },
              async fork() {
                throw new Error('unused')
              },
              async sessions() {
                return []
              },
            }
          },
        }}
        initialSessions={[]}
        elicitationUrlOpener={(url) => {
          opened.push(url)
        }}
      />,
    )

    app.stdin.write('run')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain(
      'MCP server “browser-fixture” wants to open a URL',
    )
    app.stdin.write('\r')
    await flush()
    expect(result).toEqual({ action: 'accept' })
    expect(opened).toEqual(['https://example.com/authorize'])
    expect(app.lastFrame()).toContain('waiting for completion')
    expect(app.lastFrame()).toContain('Reopen URL')
    expect(app.lastFrame()).toContain('Skip confirmation')

    app.stdin.write('\r')
    await flush()
    expect(opened).toHaveLength(2)
    eventSink?.({
      type: 'elicitation-complete',
      mcpServerName: 'browser-fixture',
      elicitationId: 'different-id',
    })
    await flush()
    expect(app.lastFrame()).toContain('waiting for completion')
    eventSink?.({
      type: 'elicitation-complete',
      mcpServerName: 'browser-fixture',
      elicitationId: 'elicit-1',
    })
    await flush()
    expect(app.lastFrame()).not.toContain('waiting for completion')
    expect(app.lastFrame()).toContain('MCP elicitation completed')
  })

  it('dismisses an accepted URL waiting surface without resolving it again', async () => {
    let result: unknown = 'pending'
    const app = render(
      <InteractiveApp
        factory={{
          async createService({ onElicitation }) {
            return {
              async run() {
                result = await onElicitation?.({
                  serverName: 'browser-fixture',
                  message: 'Authorize access',
                  mode: 'url',
                  url: 'https://example.com/authorize',
                  elicitationId: 'elicit-escape',
                })
                return {
                  sessionId: 'url-waiting-session',
                  text: 'accepted once',
                  usage: { inputTokens: 1, outputTokens: 1 },
                }
              },
              async resume() {
                throw new Error('unused')
              },
              async fork() {
                throw new Error('unused')
              },
              async sessions() {
                return []
              },
            }
          },
        }}
        initialSessions={[]}
        elicitationUrlOpener={() => undefined}
      />,
    )

    app.stdin.write('run')
    app.stdin.write('\r')
    await waitFor(() =>
      app.lastFrame()?.includes('wants to open a URL') ? true : undefined,
    )
    app.stdin.write('\r')
    await waitFor(() =>
      app.lastFrame()?.includes('waiting for completion') ? true : undefined,
    )
    expect(result).toEqual({ action: 'accept' })

    app.stdin.write('\u001B')
    await delay(75)
    await flush()
    expect(result).toEqual({ action: 'accept' })
    expect(app.lastFrame()).not.toContain('waiting for completion')
    expect(app.lastFrame()).toContain('accepted once')
  })

  it('asks before retrying an interrupted tool during resume', async () => {
    let recoveryApproval: boolean | undefined
    const call: ModelToolCall = {
      id: 'call-interrupted',
      name: 'Bash',
      input: { command: 'npm test' },
    }
    const factory: InteractiveServiceFactory = {
      async createService({ approveRecovery }) {
        return {
          async run() {
            throw new Error('unused')
          },
          async resume(sessionId) {
            recoveryApproval = await approveRecovery?.(call)
            return {
              sessionId,
              text: 'recovered',
              usage: { inputTokens: 1, outputTokens: 1 },
            }
          },
          async fork() {
            throw new Error('unused')
          },
          async sessions() {
            return []
          },
        }
      },
    }
    const app = render(
      <InteractiveApp
        factory={factory}
        initialSessions={[
          {
            sessionId: 'session-1',
            lastPrompt: 'interrupted task',
            updatedAt: '2026-08-04T00:00:00.000Z',
            status: 'ready',
            issue: null,
          },
        ]}
        resume={{ requireSession: true }}
      />,
    )

    app.stdin.write('\u001B[B')
    await flush()
    app.stdin.write('\r')
    await flush()
    app.stdin.write('continue')
    await flush()
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('Retry interrupted Bash')
    expect(app.lastFrame()).toContain('npm test')
    expect(app.lastFrame()).toContain(
      'Enter to confirm · Tab to add feedback · Esc to cancel',
    )

    app.stdin.write('y')
    await flush()
    expect(recoveryApproval).toBe(true)
    expect(app.lastFrame()).toContain('recovered')
  })

  it('forks a required session and auto-retries recovery when requested', async () => {
    const calls: string[] = []
    let recoveryApproval: boolean | undefined
    const factory: InteractiveServiceFactory = {
      async createService({ approveRecovery }) {
        recoveryApproval = await approveRecovery?.({
          id: 'call-interrupted',
          name: 'Bash',
          input: { command: 'npm test' },
        })
        return {
          async run() {
            throw new Error('unused')
          },
          async resume(sessionId, prompt) {
            calls.push(`resume:${sessionId}:${prompt}`)
            return {
              sessionId,
              text: 'forked answer',
              usage: { inputTokens: 1, outputTokens: 1 },
            }
          },
          async fork(sessionId, targetSessionId) {
            calls.push(`fork:${sessionId}:${targetSessionId ?? ''}`)
            return {
              parentSessionId: sessionId,
              sessionId: targetSessionId ?? 'generated-fork',
            }
          },
          async sessions() {
            return []
          },
        }
      },
    }
    const app = render(
      <InteractiveApp
        factory={factory}
        initialSessions={[
          {
            sessionId: 'linked-session',
            lastPrompt: 'linked task',
            updatedAt: '2026-08-08T00:00:00.000Z',
            status: 'ready',
            issue: null,
          },
        ]}
        allowNewSession={false}
        resume={{
          forkSession: true,
          forkSessionId: 'explicit-fork',
          retryInterruptedTools: true,
        }}
      />,
    )

    app.stdin.write('\r')
    await flush()
    app.stdin.write('continue')
    await flush()
    app.stdin.write('\r')
    await flush()

    expect(recoveryApproval).toBe(true)
    expect(calls).toEqual([
      'fork:linked-session:explicit-fork',
      'resume:explicit-fork:continue',
    ])
    expect(app.lastFrame()).toContain('forked answer')
    expect(app.lastFrame()).not.toContain('Retry interrupted Bash')
  })

  it('settles a newly-created permission prompt when cancellation races render', async () => {
    const controller = new AbortController()
    let approval: PermissionApproval | undefined
    const call: ModelToolCall = {
      id: 'call-race',
      name: 'Bash',
      input: { command: 'npm test' },
    }
    const factory: InteractiveServiceFactory = {
      async createService({ approveTool }) {
        return {
          async run() {
            const pendingApproval = approveTool?.(call)
            controller.abort()
            approval = await pendingApproval
            return {
              sessionId: 'session-1',
              text: 'cancelled',
              usage: { inputTokens: 0, outputTokens: 0 },
            }
          },
          async resume() {
            throw new Error('unused')
          },
          async fork() {
            throw new Error('unused')
          },
          async sessions() {
            return []
          },
        }
      },
    }
    const app = render(
      <InteractiveApp
        factory={factory}
        initialSessions={[]}
        signal={controller.signal}
      />,
    )

    await flush()
    app.stdin.write('run tests')
    await flush()
    app.stdin.write('\r')
    await flush()

    expect(approval).toBe(false)
  })

  it('lets the session picker own Escape before the Vim composer', async () => {
    const app = render(
      <InteractiveApp
        factory={{
          async createService() {
            throw new Error('unused')
          },
        }}
        initialSessions={[
          {
            sessionId: 'session-1',
            lastPrompt: 'previous task',
            updatedAt: '2026-08-04T00:00:00.000Z',
            status: 'ready',
            issue: null,
          },
        ]}
        resume={{ requireSession: true }}
        runtimeSettings={projectRuntimeSettings({
          settings: { editorMode: 'vim' },
          state: {},
        })}
      />,
    )

    expect(app.lastFrame()).toContain('previous task')
    app.stdin.write('\u001B')
    await delay(75)
    await flush()

    expect(app.lastFrame()).toContain('Welcome to Praxis')
    expect(app.lastFrame()).not.toContain('previous task')
  })

  it('selects an existing session before accepting a prompt', async () => {
    const resumed: string[] = []
    const factory: InteractiveServiceFactory = {
      async createService() {
        return {
          async run() {
            throw new Error('unused')
          },
          async resume(sessionId, prompt) {
            resumed.push(`${sessionId}:${prompt}`)
            return {
              sessionId,
              text: 'resumed answer',
              usage: { inputTokens: 1, outputTokens: 1 },
            }
          },
          async fork() {
            throw new Error('unused')
          },
          async sessions() {
            return []
          },
        }
      },
    }
    const app = render(
      <InteractiveApp
        factory={factory}
        initialSessions={[
          {
            sessionId: 'session-1',
            lastPrompt: 'previous task',
            updatedAt: '2026-08-04T00:00:00.000Z',
            status: 'ready',
            issue: null,
          },
        ]}
        resume={{ requireSession: true }}
      />,
    )

    expect(app.lastFrame()).toContain('previous task')
    app.stdin.write('\u001B[B')
    await flush()
    app.stdin.write('\r')
    await flush()
    app.stdin.write('continue')
    await flush()
    app.stdin.write('\r')
    await flush()

    expect(resumed).toEqual(['session-1:continue'])
    expect(app.lastFrame()).toContain('resumed answer')
  })

  it('requires a second Ctrl+C before cancelling the interactive process', async () => {
    let cancelled = false
    const factory: InteractiveServiceFactory = {
      async createService() {
        throw new Error('unused')
      },
    }
    const app = render(
      <InteractiveApp
        factory={factory}
        initialSessions={[]}
        onCancel={() => {
          cancelled = true
        }}
      />,
    )

    await flush()
    app.stdin.write('\u0003')
    await flush()

    expect(cancelled).toBe(false)
    expect(app.lastFrame()).toContain('Press Ctrl-C again to exit')
    app.stdin.write('\u0018')
    await flush()
    app.stdin.write('\u0003')
    await flush()
    expect(cancelled).toBe(false)
    app.stdin.write('\u0003')
    await flush()
    expect(cancelled).toBe(true)
  })

  it('exposes the active turn promise for shutdown coordination', async () => {
    let finishTurn: (() => void) | undefined
    let activeTurn: Promise<void> | null = null
    const factory: InteractiveServiceFactory = {
      async createService() {
        return {
          async run() {
            await new Promise<void>((resolve) => {
              finishTurn = resolve
            })
            return {
              sessionId: 'session-1',
              text: 'done',
              usage: { inputTokens: 1, outputTokens: 1 },
            }
          },
          async resume() {
            throw new Error('unused')
          },
          async fork() {
            throw new Error('unused')
          },
          async sessions() {
            return []
          },
        }
      },
    }
    const app = render(
      <InteractiveApp
        factory={factory}
        initialSessions={[]}
        onTurnChange={(turn) => {
          activeTurn = turn
        }}
      />,
    )

    await flush()
    app.stdin.write('wait')
    await flush()
    app.stdin.write('\r')
    await flush()
    expect(activeTurn).toBeInstanceOf(Promise)

    finishTurn?.()
    await activeTurn
    await flush()
    expect(activeTurn).toBeNull()
  })

  it('exposes active service cleanup for awaited CLI shutdown', async () => {
    let releaseClose: (() => void) | undefined
    let closed = false
    let cleanup: Promise<void> | null = null
    const factory: InteractiveServiceFactory = {
      async createService() {
        return {
          async run() {
            return {
              sessionId: 'session-1',
              text: 'done',
              usage: { inputTokens: 1, outputTokens: 1 },
            }
          },
          async resume() {
            throw new Error('unused')
          },
          async fork() {
            throw new Error('unused')
          },
          async sessions() {
            return []
          },
          async close() {
            await new Promise<void>((resolve) => {
              releaseClose = resolve
            })
            closed = true
          },
        }
      },
    }
    const app = render(
      <InteractiveApp
        factory={factory}
        initialSessions={[]}
        onCleanup={(closing) => {
          cleanup = closing
        }}
      />,
    )

    app.stdin.write('run')
    await flush()
    app.stdin.write('\r')
    await flush()
    app.unmount()
    expect(cleanup).toBeInstanceOf(Promise)
    expect(closed).toBe(false)
    releaseClose?.()
    if (cleanup) await cleanup
    expect(closed).toBe(true)
  })
})

describe('runInteractive', () => {
  it('prepends the selected agent initial prompt once for a fresh session', async () => {
    const calls: string[] = []
    const controller = new AbortController()
    let creations = 0
    const consoleConstructor = Object.getOwnPropertyDescriptor(
      console,
      'Console',
    )
    const stdinIsTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
    const stdinSetRawMode = Object.getOwnPropertyDescriptor(
      process.stdin,
      'setRawMode',
    )
    Object.defineProperty(console, 'Console', {
      configurable: true,
      value: NodeConsole,
    })
    Object.defineProperty(process.stdin, 'isTTY', {
      configurable: true,
      value: true,
    })
    Object.defineProperty(process.stdin, 'setRawMode', {
      configurable: true,
      value: () => process.stdin,
    })
    const factory: InteractiveServiceFactory = {
      async createService() {
        creations += 1
        return {
          async run(prompt) {
            calls.push(prompt)
            controller.abort()
            return {
              sessionId: 'agent-session',
              text: 'done',
              usage: { inputTokens: 1, outputTokens: 1 },
            }
          },
          async resume() {
            throw new Error('unused')
          },
          async fork() {
            throw new Error('unused')
          },
          async sessions() {
            return []
          },
          initialAgentPrompt() {
            return creations === 1 ? 'AGENT_INITIAL' : undefined
          },
        }
      },
    }

    try {
      await expect(
        runInteractive({
          factory,
          initialPrompt: 'USER_INITIAL',
          signal: controller.signal,
        }),
      ).resolves.toBe(130)
      expect(calls).toEqual(['AGENT_INITIAL\n\nUSER_INITIAL'])
    } finally {
      if (consoleConstructor) {
        Object.defineProperty(console, 'Console', consoleConstructor)
      } else {
        Reflect.deleteProperty(console, 'Console')
      }
      if (stdinIsTty) {
        Object.defineProperty(process.stdin, 'isTTY', stdinIsTty)
      } else {
        Reflect.deleteProperty(process.stdin, 'isTTY')
      }
      if (stdinSetRawMode) {
        Object.defineProperty(process.stdin, 'setRawMode', stdinSetRawMode)
      } else {
        Reflect.deleteProperty(process.stdin, 'setRawMode')
      }
    }
  })

  it('loads resumed transcript history before rendering', async () => {
    let transcriptSession = ''
    let closed = 0
    const controller = new AbortController()
    controller.abort()
    const consoleConstructor = Object.getOwnPropertyDescriptor(
      console,
      'Console',
    )
    Object.defineProperty(console, 'Console', {
      configurable: true,
      value: NodeConsole,
    })
    const factory: InteractiveServiceFactory = {
      async createService() {
        return {
          async run() {
            throw new Error('unused')
          },
          async resume() {
            throw new Error('unused')
          },
          async fork() {
            throw new Error('unused')
          },
          async sessions() {
            return [
              {
                sessionId: 'session-1',
                lastPrompt: 'inspect',
                updatedAt: '2026-08-11T00:00:00.000Z',
                status: 'ready' as const,
                issue: null,
              },
            ]
          },
          async transcript(sessionId: string) {
            transcriptSession = sessionId
            return [{ kind: 'assistant' as const, text: 'restored answer' }]
          },
          async close() {
            closed += 1
          },
        }
      },
    }

    try {
      await expect(
        runInteractive({
          factory,
          signal: controller.signal,
          resume: { sessionId: 'SESSION-1' },
        }),
      ).resolves.toBe(130)
      expect(transcriptSession).toBe('session-1')
      expect(closed).toBe(1)
    } finally {
      if (consoleConstructor) {
        Object.defineProperty(console, 'Console', consoleConstructor)
      } else {
        Reflect.deleteProperty(console, 'Console')
      }
    }
  })

  it('loads the effective agent color for a resumed session', async () => {
    let colorSession = ''
    const controller = new AbortController()
    controller.abort()
    const consoleConstructor = Object.getOwnPropertyDescriptor(
      console,
      'Console',
    )
    Object.defineProperty(console, 'Console', {
      configurable: true,
      value: NodeConsole,
    })
    const factory: InteractiveServiceFactory = {
      async createService() {
        return {
          async run() {
            throw new Error('unused')
          },
          async resume() {
            throw new Error('unused')
          },
          async fork() {
            throw new Error('unused')
          },
          async sessions() {
            return [
              {
                sessionId: 'session-1',
                lastPrompt: 'inspect',
                updatedAt: '2026-08-11T00:00:00.000Z',
                status: 'ready' as const,
                issue: null,
              },
            ]
          },
          async transcript() {
            return []
          },
          async agentColor(sessionId: string) {
            colorSession = sessionId
            return 'cyan'
          },
          async close() {},
        }
      },
    }

    try {
      await expect(
        runInteractive({
          factory,
          signal: controller.signal,
          resume: { sessionId: 'SESSION-1' },
        }),
      ).resolves.toBe(130)
      expect(colorSession).toBe('session-1')
    } finally {
      if (consoleConstructor) {
        Object.defineProperty(console, 'Console', consoleConstructor)
      } else {
        Reflect.deleteProperty(console, 'Console')
      }
    }
  })

  it('closes the listing service after loading sessions', async () => {
    let closed = 0
    const controller = new AbortController()
    controller.abort()
    const consoleConstructor = Object.getOwnPropertyDescriptor(
      console,
      'Console',
    )
    Object.defineProperty(console, 'Console', {
      configurable: true,
      value: NodeConsole,
    })
    const factory: InteractiveServiceFactory = {
      async createService() {
        return {
          async run() {
            throw new Error('unused')
          },
          async resume() {
            throw new Error('unused')
          },
          async fork() {
            throw new Error('unused')
          },
          async sessions() {
            return []
          },
          async close() {
            closed += 1
          },
        }
      },
    }

    try {
      await expect(
        runInteractive({ factory, signal: controller.signal }),
      ).resolves.toBe(130)
      expect(closed).toBe(1)
    } finally {
      if (consoleConstructor) {
        Object.defineProperty(console, 'Console', consoleConstructor)
      } else {
        Reflect.deleteProperty(console, 'Console')
      }
    }
  })

  it('closes the listing service when loading sessions fails', async () => {
    let closed = 0
    const factory: InteractiveServiceFactory = {
      async createService() {
        return {
          async run() {
            throw new Error('unused')
          },
          async resume() {
            throw new Error('unused')
          },
          async fork() {
            throw new Error('unused')
          },
          async sessions() {
            throw new Error('listing failed')
          },
          async close() {
            closed += 1
          },
        }
      },
    }

    await expect(runInteractive({ factory })).rejects.toThrow('listing failed')
    expect(closed).toBe(1)
  })

  it('closes the listing service when a required filter has no matches', async () => {
    let closed = 0
    const factory: InteractiveServiceFactory = {
      async createService() {
        return {
          async run() {
            throw new Error('unused')
          },
          async resume() {
            throw new Error('unused')
          },
          async fork() {
            throw new Error('unused')
          },
          async sessions() {
            return []
          },
          async close() {
            closed += 1
          },
        }
      },
    }

    await expect(
      runInteractive({ factory, requireSession: true }),
    ).rejects.toThrow('No conversation linked')
    expect(closed).toBe(1)
  })

  it('shows a slash command progress message instead of a generic spinner tip', async () => {
    const factory: InteractiveServiceFactory = {
      async createService() {
        return {
          async run(_prompt, signal) {
            await new Promise<void>((_resolve, reject) => {
              signal?.addEventListener(
                'abort',
                () => reject(new Error('provider aborted')),
                { once: true },
              )
            })
            throw new Error('unreachable')
          },
          async resume() {
            throw new Error('unused')
          },
          async fork() {
            throw new Error('unused')
          },
          async sessions() {
            return []
          },
        }
      },
    }
    const app = render(
      <InteractiveApp
        factory={factory}
        initialSessions={[]}
        slashCommands={[
          {
            name: 'init',
            description: 'Initialize project instructions',
            source: 'command',
            progressMessage: 'analyzing your codebase',
          },
        ]}
        runtimeSettings={projectRuntimeSettings({
          settings: { spinnerTipsEnabled: true },
          state: {},
        })}
      />,
    )

    app.stdin.write('/init')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('analyzing your codebase')
    app.stdin.write('\u001B')
    await delay(75)
    await flush()
  })
})
