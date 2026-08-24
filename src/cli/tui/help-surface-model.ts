export type TuiHelpTabId = 'general' | 'commands' | 'custom-commands'

export interface TuiHelpShortcut {
  readonly id: string
  readonly key: string
  readonly description: string
}

export interface TuiHelpShortcutGroup {
  readonly id: string
  readonly shortcuts: readonly TuiHelpShortcut[]
}

export interface TuiHelpCommandInput {
  readonly name: string
  readonly description: string
}

export interface TuiHelpCommandRow {
  readonly id: string
  readonly ordinal: number
  readonly invocation: string
  readonly description: string
}

export interface TuiHelpDocumentation {
  readonly label: 'Praxis documentation'
  readonly url: 'https://github.com/Forest-Isle/Praxis'
}

export interface TuiHelpGeneralContent {
  readonly kind: 'general'
  readonly description: string
  readonly shortcutGroups: readonly TuiHelpShortcutGroup[]
}

export interface TuiHelpCommandContent {
  readonly kind: 'commands' | 'custom-commands'
  readonly heading: string
  readonly commands: readonly TuiHelpCommandRow[]
  readonly focusedIndex: number | null
  readonly emptyText: string
}

export type TuiHelpActiveContent = TuiHelpGeneralContent | TuiHelpCommandContent

export interface TuiHelpTab {
  readonly id: TuiHelpTabId
  readonly label: 'General' | 'Commands' | 'Custom commands'
  readonly current: boolean
}

export interface TuiHelpSurfaceInput {
  readonly invocation: '?' | '/help'
  readonly tabIndex: number
  readonly selectedIndex: number
  readonly builtinCommands: readonly TuiHelpCommandInput[]
  readonly customCommands: readonly TuiHelpCommandInput[]
}

export interface TuiHelpSurfaceModel {
  readonly kind: 'help'
  readonly title: 'Help'
  readonly invocation: '?' | '/help'
  readonly tabs: readonly TuiHelpTab[]
  readonly activeTab: {
    readonly id: TuiHelpTabId
    readonly label: TuiHelpTab['label']
  }
  readonly activeContent: TuiHelpActiveContent
  readonly navigation: {
    readonly switchTabs: 'Left/Right to switch tabs'
    readonly browseCommands?: 'Up/Down to browse commands'
    readonly close: 'Esc to close'
  }
  readonly documentation: TuiHelpDocumentation
}

const TAB_DEFINITIONS = [
  { id: 'general', label: 'General' },
  { id: 'commands', label: 'Commands' },
  { id: 'custom-commands', label: 'Custom commands' },
] as const

const SHORTCUT_GROUPS: readonly TuiHelpShortcutGroup[] = [
  {
    id: 'prompt',
    shortcuts: [
      { id: 'bash-mode', key: '!', description: 'for bash mode' },
      { id: 'commands', key: '/', description: 'for commands' },
      { id: 'file-paths', key: '@', description: 'for file paths' },
      { id: 'background', key: '&', description: 'for background' },
      { id: 'side-question', key: '/btw', description: 'for side question' },
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
      { id: 'toggle-tasks', key: 'ctrl + t', description: 'to toggle tasks' },
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
      { id: 'paste-images', key: 'ctrl + v', description: 'to paste images' },
      { id: 'switch-model', key: 'opt + p', description: 'to switch model' },
      { id: 'stash-prompt', key: 'ctrl + s', description: 'to stash prompt' },
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
]

const DOCUMENTATION: TuiHelpDocumentation = {
  label: 'Praxis documentation',
  url: 'https://github.com/Forest-Isle/Praxis',
}

const GENERAL_DESCRIPTION =
  'Praxis understands your codebase, makes edits with your permission, and executes commands from your terminal.'

function normalizeIndex(value: number): number {
  return Number.isFinite(value) ? Math.trunc(value) : 0
}

function clamp(value: number, minimum: number, maximum: number): number {
  const normalized = normalizeIndex(value)
  return Math.max(minimum, Math.min(maximum, normalized))
}

function projectCommands(
  commands: readonly TuiHelpCommandInput[],
  tab: 'commands' | 'custom-commands',
  selectedIndex: number,
): TuiHelpCommandContent {
  const rows = commands.map((command, index) => ({
    id: `${tab}:${index}:${command.name}`,
    ordinal: index + 1,
    invocation: `/${command.name}`,
    description: command.description,
  }))
  return {
    kind: tab,
    heading:
      tab === 'commands'
        ? 'Browse default commands'
        : 'Browse shared commands and skills',
    commands: rows,
    focusedIndex:
      rows.length === 0 ? null : clamp(selectedIndex, 0, rows.length - 1),
    emptyText: 'No commands found.',
  }
}

export function projectTuiHelpSurface(
  input: TuiHelpSurfaceInput,
): TuiHelpSurfaceModel {
  const tabIndex = clamp(input.tabIndex, 0, TAB_DEFINITIONS.length - 1)
  const activeTab =
    tabIndex === 0
      ? TAB_DEFINITIONS[0]
      : tabIndex === 1
        ? TAB_DEFINITIONS[1]
        : TAB_DEFINITIONS[2]
  const tabs = TAB_DEFINITIONS.map((tab) => ({
    ...tab,
    current: tab.id === activeTab.id,
  }))
  const activeContent: TuiHelpActiveContent =
    activeTab.id === 'general'
      ? {
          kind: 'general',
          description: GENERAL_DESCRIPTION,
          shortcutGroups: SHORTCUT_GROUPS,
        }
      : projectCommands(
          activeTab.id === 'commands'
            ? input.builtinCommands
            : input.customCommands,
          activeTab.id,
          input.selectedIndex,
        )
  return {
    kind: 'help',
    title: 'Help',
    invocation: input.invocation,
    tabs,
    activeTab,
    activeContent,
    navigation: {
      switchTabs: 'Left/Right to switch tabs',
      ...(activeContent.kind === 'general' ||
      activeContent.commands.length === 0
        ? {}
        : { browseCommands: 'Up/Down to browse commands' as const }),
      close: 'Esc to close',
    },
    documentation: DOCUMENTATION,
  }
}
