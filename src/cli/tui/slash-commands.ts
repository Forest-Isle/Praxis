export type TuiSlashCommandSource = 'builtin' | 'command' | 'skill' | 'mcp'

export interface TuiSlashCommand {
  name: string
  description: string
  source: TuiSlashCommandSource
}

export const BUILTIN_TUI_SLASH_COMMANDS: readonly TuiSlashCommand[] = [
  {
    name: 'help',
    description: 'Browse available commands.',
    source: 'builtin',
  },
  {
    name: 'new',
    description: 'Start a new session.',
    source: 'builtin',
  },
  {
    name: 'clear',
    description: 'Start a new session with empty context.',
    source: 'builtin',
  },
  {
    name: 'sessions',
    description: 'Resume an existing session.',
    source: 'builtin',
  },
  {
    name: 'workflows',
    description: 'List local workflows.',
    source: 'builtin',
  },
  {
    name: 'exit',
    description: 'Quit Praxis.',
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
