import { Console as NodeConsole } from 'node:console'
import { setImmediate } from 'node:timers/promises'

import { cleanup, render } from 'ink-testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ModelToolCall } from '../core/runtime.js'
import {
  InteractiveApp,
  type InteractiveServiceFactory,
  runInteractive,
} from './interactive.js'
import { projectTuiHooks } from './tui/hook-settings.js'

afterEach(() => cleanup())

const flush = async () => {
  await setImmediate()
  await setImmediate()
}

describe('InteractiveApp', () => {
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
    expect(app.lastFrame()).toContain('2. Dark mode ✔')
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
    expect(app.lastFrame()).toContain('Welcome back!')
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
    expect(app.lastFrame()).toContain('Context Usage')
    expect(app.lastFrame()).toContain('review: ~')
    expect(serviceCreations).toBe(0)

    app.stdin.write('/status')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('Settings  Status  Config  Usage  Stats')
    expect(app.lastFrame()).toContain('fixture-model')
    app.stdin.write('\u001B[C')
    await flush()
    expect(app.lastFrame()).toContain('Context window:')
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
    expect(app.lastFrame()).toContain('Available commands:')
    app.stdin.write('\u001B')
    await new Promise((resolve) => setTimeout(resolve, 75))

    app.stdin.write('/usage')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('Input tokens:')
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
    expect(app.lastFrame()).toContain(
      'Copied 2nd-latest response to clipboard.',
    )
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
        onBackground={onBackground}
      />,
    )

    app.stdin.write('/background')
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
                return {
                  sessionId: 'active-session',
                  text: answer,
                  usage: { inputTokens: 2, outputTokens: 1 },
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
    await flush()
    expect(app.lastFrame()).toMatch(/Input tokens:\s+4/u)
    expect(app.lastFrame()).toMatch(/Output tokens:\s+2/u)
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
    await flush()
    expect(app.lastFrame()).toContain('$0.0003')
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

  it('shows Pasting… and inserts clipboard text at the real cursor', async () => {
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
    await new Promise((resolve) => setTimeout(resolve, 25))
    await flush()
    app.stdin.write('2')
    await new Promise((resolve) => setTimeout(resolve, 25))
    await flush()
    expect(memoryEditor).toHaveBeenCalledWith('/workspace/CLAUDE.md', {
      cwd: '/workspace',
    })
    expect(app.lastFrame()).toContain('Opened memory file at ./CLAUDE.md')
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
    expect(app.lastFrame()).toContain('! for shell mode')
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
      <InteractiveApp factory={factory} initialSessions={[]} />,
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
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('Enter model ID')
    app.stdin.write('provider/model-custom')
    app.stdin.write('\r')
    await flush()

    app.stdin.write('run')
    app.stdin.write('\r')
    await flush()
    expect(creates).toContainEqual({
      model: 'provider/model-custom',
      effort: 'low',
    })
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
    app.stdin.write('\r')
    await flush()
    await flush()
    expect(removals).toEqual(['Bash(npm test:*)'])
    expect(app.lastFrame()).toContain('1. Add a new rule…')
    expect(app.lastFrame()).not.toContain('2. Bash(npm test:*)')
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
    expect(app.lastFrame()).toContain('Welcome back!')

    app.stdin.write('second')
    app.stdin.write('\r')
    await flush()
    expect(calls).toEqual(['run:first', 'run:second'])
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
    expect(app.lastFrame()).toContain('! for shell mode')

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
    expect(app.lastFrame()).toContain('! for shell mode')
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
    expect(app.lastFrame()).toContain('Hook started · PreToolUse:Bash')
    expect(app.lastFrame()).toContain('Hook response · PreToolUse:Bash · error')
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

  it('asks before an ask-permission tool and forwards the decision', async () => {
    let approval: boolean | undefined
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
            approval = await approveTool?.(call)
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
        suspendProcess={suspendProcess}
      />,
    )

    await flush()
    app.stdin.write('run tests')
    await flush()
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('Allow Bash')
    expect(app.lastFrame()).toContain('npm test')

    app.stdin.write('\u001a')
    await new Promise((resolve) => setTimeout(resolve, 75))
    await flush()
    expect(suspendProcess).toHaveBeenCalledOnce()
    expect(app.lastFrame()).toContain('Allow Bash')

    app.stdin.write('1')
    await flush()
    expect(approval).toBe(true)
    expect(app.lastFrame()).toContain('done')
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
                  { label: 'Node', description: 'Use Node.js' },
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
      <InteractiveApp factory={factory} initialSessions={[]} />,
    )
    await flush()
    app.stdin.write('start')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('Runtime: Which runtime?')
    app.stdin.write('Bun, with npm')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('Checks: Which checks?')
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

  it('shows plan content and forwards plan approval', async () => {
    let approval: boolean | undefined
    const factory: InteractiveServiceFactory = {
      async createService({ approvePlan }) {
        return {
          async run() {
            approval = await approvePlan?.({
              action: 'exit',
              planPath: '/tmp/plan.md',
              plan: '# Plan\n\n1. Implement.',
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
    app.stdin.write('start')
    app.stdin.write('\r')
    await flush()
    expect(app.lastFrame()).toContain('Approve this plan')
    expect(app.lastFrame()).toContain('1. Implement.')
    app.stdin.write('y')
    await flush()
    expect(approval).toBe(true)
  })

  it('declines plan approval when the tool signal aborts', async () => {
    const controller = new AbortController()
    let approval: boolean | undefined
    const factory: InteractiveServiceFactory = {
      async createService({ approvePlan }) {
        return {
          async run() {
            approval = await approvePlan?.(
              { action: 'exit', planPath: '/tmp/plan.md' },
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
    expect(app.lastFrame()).toContain('Approve this plan')
    controller.abort()
    await flush()
    expect(approval).toBe(false)
    expect(app.lastFrame()).toContain('done')
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
    expect(app.lastFrame()).toContain('MCP elicitation (fixture)')
    app.stdin.write('{"code":"ok"}')
    await flush()
    app.stdin.write('\r')
    await flush()

    expect(result).toEqual({ action: 'accept', content: { code: 'ok' } })
    expect(app.lastFrame()).toContain('done')
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
    let approval: boolean | undefined
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
})
