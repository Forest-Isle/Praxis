export type TuiSlashCommandSource = 'builtin' | 'command' | 'skill' | 'mcp'

export interface TuiSlashCommand {
  name: string
  description: string
  source: TuiSlashCommandSource
}

export const BUILTIN_TUI_SLASH_COMMANDS: readonly TuiSlashCommand[] = [
  {
    name: 'add-dir',
    description: 'Add a new working directory',
    source: 'builtin',
  },
  {
    name: 'branch',
    description: 'Create a branch of the current conversation at this point',
    source: 'builtin',
  },
  {
    name: 'btw',
    description:
      'Ask a quick side question without adding it to the conversation',
    source: 'builtin',
  },
  {
    name: 'help',
    description: 'Show help and available commands',
    source: 'builtin',
  },
  {
    name: 'hooks',
    description: 'View hook configurations',
    source: 'builtin',
  },
  {
    name: 'clear',
    description:
      'Start a new session with empty context; previous session stays on disk (resumable with /resume)',
    source: 'builtin',
  },
  {
    name: 'compact',
    description: 'Clear conversation history but keep a summary in context',
    source: 'builtin',
  },
  {
    name: 'model',
    description: 'Set the AI model for this session',
    source: 'builtin',
  },
  {
    name: 'effort',
    description: 'Set effort level for model usage',
    source: 'builtin',
  },
  {
    name: 'export',
    description: 'Export the current conversation',
    source: 'builtin',
  },
  {
    name: 'keybindings',
    description: 'Open your keyboard shortcuts file',
    source: 'builtin',
  },
  {
    name: 'memory',
    description: 'Open a memory file in your editor',
    source: 'builtin',
  },
  {
    name: 'permissions',
    description: 'Manage allow and deny tool permission rules',
    source: 'builtin',
  },
  {
    name: 'sandbox',
    description: 'Configure sandbox mode and command isolation',
    source: 'builtin',
  },
  {
    name: 'resume',
    description: 'Resume a previous conversation',
    source: 'builtin',
  },
  {
    name: 'diff',
    description: 'View uncommitted changes and per-turn diffs',
    source: 'builtin',
  },
  {
    name: 'context',
    description: 'Visualize current context usage as a colored grid',
    source: 'builtin',
  },
  {
    name: 'config',
    description: 'Open settings',
    source: 'builtin',
  },
  {
    name: 'copy',
    description:
      "Copy Praxis's last response to clipboard (or /copy N for the Nth-latest)",
    source: 'builtin',
  },
  {
    name: 'status',
    description: 'Show runtime status, configuration, usage, and statistics',
    source: 'builtin',
  },
  {
    name: 'theme',
    description: 'Change the theme',
    source: 'builtin',
  },
  {
    name: 'vim',
    description: 'Toggle between Vim and Normal editing modes',
    source: 'builtin',
  },
  {
    name: 'skills',
    description: 'List available skills',
    source: 'builtin',
  },
  {
    name: 'mcp',
    description: 'Manage MCP servers',
    source: 'builtin',
  },
  {
    name: 'reload-plugins',
    description: 'Activate pending plugin changes in the current session',
    source: 'builtin',
  },
  {
    name: 'release-notes',
    description: 'View release notes',
    source: 'builtin',
  },
  {
    name: 'rename',
    description: 'Rename the current conversation',
    source: 'builtin',
  },
  {
    name: 'rewind',
    description: 'Restore the code and/or conversation to an earlier point',
    source: 'builtin',
  },
  {
    name: 'tasks',
    description: 'View background work',
    source: 'builtin',
  },
  {
    name: 'plan',
    description: 'Enable plan mode for this session',
    source: 'builtin',
  },
  {
    name: 'workflows',
    description: 'Browse running and completed workflows',
    source: 'builtin',
  },
  {
    name: 'exit',
    description: 'Exit the CLI',
    source: 'builtin',
  },
]

function normalizedName(name: string): string {
  return name.replace(/^\/+/, '').trim()
}

export function mergeTuiSlashCommands(
  commands: readonly TuiSlashCommand[],
): readonly TuiSlashCommand[] {
  const merged = new Map<string, TuiSlashCommand>()
  for (const command of [...BUILTIN_TUI_SLASH_COMMANDS, ...commands]) {
    const name = normalizedName(command.name)
    if (!name) continue
    const key = name.toLowerCase()
    if (merged.has(key)) continue
    merged.set(key, { ...command, name })
  }
  return [...merged.values()]
}

export function slashCommandQuery(input: string): string | null {
  if (!input.startsWith('/')) return null
  const query = input.slice(1)
  return /\s/u.test(query) ? null : query.toLowerCase()
}

export function filterTuiSlashCommands(
  commands: readonly TuiSlashCommand[],
  query: string,
): readonly TuiSlashCommand[] {
  return [...commands]
    .filter(
      (command) =>
        !query ||
        command.name.toLowerCase().includes(query) ||
        command.description.toLowerCase().includes(query),
    )
    .sort((left, right) => {
      const leftPrefix = left.name.toLowerCase().startsWith(query)
      const rightPrefix = right.name.toLowerCase().startsWith(query)
      if (leftPrefix !== rightPrefix) return leftPrefix ? -1 : 1
      return left.name.localeCompare(right.name)
    })
}
