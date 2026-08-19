import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

import { HOOK_EVENTS } from '../../hooks/claude-hooks.js'
import {
  projectTuiHooks,
  TUI_HOOK_EVENTS,
  TUI_HOOK_MENU,
} from './hook-settings.js'

describe('TUI hook settings projection', () => {
  it('matches the fixed Claude Code 2.1.208 event and detail fixture', async () => {
    const fixture = JSON.parse(
      await readFile(
        new URL(
          '../../../test/fixtures/claude-code/2.1.208/hooks-tui.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ) as {
      topLevel: typeof TUI_HOOK_MENU
      events: [string, string][]
      observedDetails: Record<string, string[]>
    }

    expect(TUI_HOOK_MENU).toEqual(fixture.topLevel)
    expect(
      TUI_HOOK_EVENTS.map(({ name, description }) => [name, description]),
    ).toEqual(fixture.events)
    expect(
      Object.fromEntries(
        TUI_HOOK_EVENTS.filter((event) => event.detail.length > 0).map(
          (event) => [event.name, event.detail],
        ),
      ),
    ).toEqual(fixture.observedDetails)
  })

  it('advertises only runtime-executable hook events and excludes removed names', () => {
    const runtimeEvents = new Set<string>(HOOK_EVENTS)
    expect(
      TUI_HOOK_EVENTS.every((event) => runtimeEvents.has(event.name)),
    ).toBe(true)
    const advertised = new Set(TUI_HOOK_EVENTS.map((event) => event.name))
    expect(advertised.has('PostToolBatch')).toBe(false)
    expect(advertised.has('UserPromptExpansion')).toBe(false)
  })

  it('matches observed scopes and hook types from the 2.1.208 fixture', async () => {
    const fixture = JSON.parse(
      await readFile(
        new URL(
          '../../../test/fixtures/claude-code/2.1.208/hooks-tui.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ) as {
      scopes: [string, string][]
      hookTypes: string[]
    }
    const resources = fixture.scopes.map(([scope], index) => ({
      path: `/fixture/${scope.toLowerCase()}.json`,
      scope:
        scope === 'Project'
          ? ('project' as const)
          : scope === 'Local'
            ? ('local' as const)
            : ('user' as const),
      ...(scope === 'Plugin'
        ? {
            plugin: true as const,
            pluginName: 'hooks-fixture',
            pluginSource: 'hooks-fixture@inline',
          }
        : {}),
      value: {
        hooks: {
          PreToolUse: [
            {
              matcher: `fixture-${index}`,
              hooks: [
                {
                  type: fixture.hookTypes[index],
                  command: 'fixture command',
                  prompt: 'fixture prompt',
                  url: 'https://fixture.test/hook',
                },
              ],
            },
          ],
        },
      },
    }))
    resources.reverse()

    const projected = projectTuiHooks(resources)
    expect(
      projected.events[0]?.matchers.map((matcher) => [
        matcher.scope,
        matcher.scopeLabel,
      ]),
    ).toEqual(fixture.scopes)
    expect(
      projected.events[0]?.matchers.map((matcher) => matcher.hooks[0]?.type),
    ).toEqual(fixture.hookTypes)
  })

  it('counts hook types and preserves matcher, scope, and display details', () => {
    const projected = projectTuiHooks([
      {
        path: '/shared/settings.json',
        scope: 'user',
        value: {
          hooks: {
            PreToolUse: [
              {
                matcher: 'Bash|Write',
                hooks: [
                  {
                    type: 'command',
                    command: 'echo hidden by status',
                    statusMessage: 'Checking tool',
                  },
                  { type: 'prompt', prompt: 'Is this safe?' },
                  { type: 'agent', prompt: 'Review this call' },
                  { type: 'http', url: 'https://example.test/hook' },
                ],
              },
              {
                hooks: [{ type: 'command', command: 'printf all' }],
              },
            ],
          },
        },
      },
      {
        path: '/project/.claude/settings.local.json',
        scope: 'local',
        value: {
          hooks: {
            SessionStart: [
              {
                matcher: 'startup|resume',
                hooks: [{ type: 'command', command: 'echo session' }],
              },
            ],
          },
        },
      },
    ])

    expect(projected.hookCount).toBe(6)
    expect(
      projected.events[0]?.matchers.map((matcher) => matcher.matcher),
    ).toEqual(['(all)', 'Bash|Write'])
    expect(projected.events[0]?.matchers[1]?.hooks).toEqual([
      expect.objectContaining({
        type: 'command',
        label: 'Checking tool',
        scopeLabel: 'User Settings',
      }),
      expect.objectContaining({ type: 'prompt', label: 'Is this safe?' }),
      expect.objectContaining({ type: 'agent', label: 'Review this call' }),
      expect.objectContaining({
        type: 'http',
        label: 'https://example.test/hook',
      }),
    ])
    expect(projected.events[4]?.matchers[0]).toMatchObject({
      matcher: 'startup|resume',
      scope: 'Local',
      scopeLabel: 'Local Settings',
    })
  })

  it('ignores malformed groups without inventing settings', () => {
    const projected = projectTuiHooks([
      {
        path: '/shared/settings.json',
        scope: 'user',
        value: {
          hooks: {
            PreToolUse: 'invalid',
            Stop: [{ matcher: 'all' }, null],
          },
        },
      },
    ])
    expect(projected.hookCount).toBe(0)
    expect(projected.events.every((event) => event.matchers.length === 0)).toBe(
      true,
    )
  })
})
