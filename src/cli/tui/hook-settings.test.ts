import { describe, expect, it } from 'vitest'

import { projectTuiHooks, TUI_HOOK_EVENTS } from './hook-settings.js'

describe('TUI hook settings projection', () => {
  it('projects all observed 2.1.208 events in menu order', () => {
    expect(TUI_HOOK_EVENTS.map((event) => event.name)).toEqual([
      'PreToolUse',
      'PostToolUse',
      'PostToolUseFailure',
      'PostToolBatch',
      'PermissionDenied',
      'Notification',
      'UserPromptSubmit',
      'UserPromptExpansion',
      'SessionStart',
      'Stop',
      'StopFailure',
      'SubagentStart',
      'SubagentStop',
      'PreCompact',
      'PostCompact',
      'SessionEnd',
      'PermissionRequest',
    ])
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
    expect(projected.events[8]?.matchers[0]).toMatchObject({
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
