import { describe, expect, it } from 'vitest'

import { projectTuiHelpSurface } from './help-surface-model.js'

describe('projectTuiHelpSurface', () => {
  it('projects the actual invocation, canonical tabs, and semantic shortcut groups', () => {
    const model = projectTuiHelpSurface({
      invocation: '?',
      tabIndex: -1,
      selectedIndex: 9,
      builtinCommands: [],
      customCommands: [],
    })

    expect(model).toMatchObject({
      kind: 'help',
      invocation: '?',
      title: 'Help',
      tabs: [
        { id: 'general', label: 'General', current: true },
        { id: 'commands', label: 'Commands', current: false },
        { id: 'custom-commands', label: 'Custom commands', current: false },
      ],
      activeTab: { id: 'general', label: 'General' },
    })
    expect(model.activeContent.kind).toBe('general')
    if (model.activeContent.kind !== 'general') return

    expect(model.activeContent.shortcutGroups).toEqual([
      {
        id: 'prompt',
        shortcuts: [
          { id: 'bash-mode', key: '!', description: 'for bash mode' },
          { id: 'commands', key: '/', description: 'for commands' },
          { id: 'file-paths', key: '@', description: 'for file paths' },
          { id: 'background', key: '&', description: 'for background' },
          {
            id: 'side-question',
            key: '/btw',
            description: 'for side question',
          },
        ],
      },
      {
        id: 'navigation',
        shortcuts: [
          {
            id: 'clear-input',
            key: 'double tap esc',
            description: 'to clear input',
          },
          {
            id: 'auto-accept-edits',
            key: 'shift + tab',
            description: 'to auto-accept edits',
          },
          {
            id: 'verbose-output',
            key: 'ctrl + o',
            description: 'for verbose output',
          },
          {
            id: 'toggle-tasks',
            key: 'ctrl + t',
            description: 'to toggle tasks',
          },
          {
            id: 'newline',
            key: 'backslash (\\) + return (⏎)',
            description: 'for newline',
          },
        ],
      },
      {
        id: 'editing',
        shortcuts: [
          { id: 'undo', key: 'ctrl + shift + _', description: 'to undo' },
          { id: 'suspend', key: 'ctrl + z', description: 'to suspend' },
          {
            id: 'paste-images',
            key: 'ctrl + v',
            description: 'to paste images',
          },
          {
            id: 'switch-model',
            key: 'opt + p',
            description: 'to switch model',
          },
          {
            id: 'stash-prompt',
            key: 'ctrl + s',
            description: 'to stash prompt',
          },
          {
            id: 'external-editor',
            key: 'ctrl + g',
            description: 'to edit in $EDITOR',
          },
          {
            id: 'customize-keybindings',
            key: '/keybindings',
            description: 'to customize',
          },
        ],
      },
    ])
    const shortcuts = model.activeContent.shortcutGroups.flatMap(
      (group) => group.shortcuts,
    )
    expect(shortcuts).toHaveLength(17)
    expect(new Set(shortcuts.map((shortcut) => shortcut.id)).size).toBe(17)
    expect(
      shortcuts.every((shortcut) => shortcut.key && shortcut.description),
    ).toBe(true)
    expect(model.navigation).toEqual({
      switchTabs: 'Left/Right to switch tabs',
      close: 'Esc to close',
    })
  })

  it('projects /help and preserves command order, duplicate names, ordinals, and focus', () => {
    const builtinCommands = [
      { name: 'first', description: 'First command' },
      { name: 'same', description: 'Built-in same' },
      { name: 'same', description: 'Second same' },
    ]
    const customCommands = [{ name: 'custom', description: 'Custom command' }]
    const commands = projectTuiHelpSurface({
      invocation: '/help',
      tabIndex: 1,
      selectedIndex: 20,
      builtinCommands,
      customCommands,
    })

    expect(commands.invocation).toBe('/help')
    expect(commands.activeContent).toMatchObject({
      kind: 'commands',
      heading: 'Browse default commands',
      focusedIndex: 2,
      commands: [
        { id: 'commands:0:first', ordinal: 1, invocation: '/first' },
        { id: 'commands:1:same', ordinal: 2, invocation: '/same' },
        { id: 'commands:2:same', ordinal: 3, invocation: '/same' },
      ],
      emptyText: 'No commands found.',
    })

    const custom = projectTuiHelpSurface({
      invocation: '/help',
      tabIndex: 2,
      selectedIndex: -10,
      builtinCommands,
      customCommands,
    })
    expect(custom.activeContent).toMatchObject({
      kind: 'custom-commands',
      focusedIndex: 0,
      commands: [
        {
          id: 'custom-commands:0:custom',
          ordinal: 1,
          invocation: '/custom',
          description: 'Custom command',
        },
      ],
      emptyText: 'No commands found.',
    })
  })

  it('uses null focus and omits command browsing for an empty command tab', () => {
    const model = projectTuiHelpSurface({
      invocation: '/help',
      tabIndex: 2,
      selectedIndex: 4,
      builtinCommands: [],
      customCommands: [],
    })

    expect(model.activeContent).toMatchObject({
      kind: 'custom-commands',
      commands: [],
      focusedIndex: null,
      emptyText: 'No commands found.',
    })
    expect(model.navigation).toEqual({
      switchTabs: 'Left/Right to switch tabs',
      close: 'Esc to close',
    })
  })

  it('clamps an oversized tab index to Custom commands', () => {
    const model = projectTuiHelpSurface({
      invocation: '/help',
      tabIndex: 99,
      selectedIndex: 0,
      builtinCommands: [],
      customCommands: [],
    })

    expect(model.activeTab).toEqual({
      id: 'custom-commands',
      label: 'Custom commands',
    })
    expect(model.tabs.filter((tab) => tab.current)).toEqual([
      { id: 'custom-commands', label: 'Custom commands', current: true },
    ])
  })

  it('normalizes non-finite and fractional indices before clamping', () => {
    const fractionalFocus = projectTuiHelpSurface({
      invocation: '/help',
      tabIndex: 1,
      selectedIndex: 1.9,
      builtinCommands: [
        { name: 'first', description: 'First' },
        { name: 'second', description: 'Second' },
      ],
      customCommands: [],
    })
    expect(fractionalFocus.activeContent).toMatchObject({
      kind: 'commands',
      focusedIndex: 1,
    })

    const nanTab = projectTuiHelpSurface({
      invocation: '?',
      tabIndex: Number.NaN,
      selectedIndex: 0,
      builtinCommands: [],
      customCommands: [],
    })
    const infiniteTab = projectTuiHelpSurface({
      invocation: '?',
      tabIndex: Number.POSITIVE_INFINITY,
      selectedIndex: 0,
      builtinCommands: [],
      customCommands: [],
    })
    expect(nanTab.activeTab.id).toBe('general')
    expect(infiniteTab.activeTab.id).toBe('general')
  })
})
