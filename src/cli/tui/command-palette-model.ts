import {
  filterTuiSlashCommands,
  type TuiSlashCommand,
} from './slash-commands.js'

export interface TuiCommandPaletteRow {
  readonly id: string
  readonly name: string
  readonly invocation: string
  readonly description: string
  readonly ordinal: number
  readonly selected: boolean
}

export interface TuiCommandPaletteModel {
  readonly kind: 'command-palette'
  readonly query: string
  readonly rows: readonly TuiCommandPaletteRow[]
  readonly selectedIndex: number | null
  readonly selectedId: string | null
  readonly visibleRange: { readonly start: number; readonly end: number }
  readonly actions: {
    readonly navigate: string
    readonly complete: string
    readonly submit: string
    readonly cancel: string
  }
}

export function tuiCommandPaletteCommandId(
  command: Pick<TuiSlashCommand, 'name'>,
): string {
  return `command:${command.name.toLowerCase()}`
}

export function projectTuiCommandPalette(input: {
  readonly commands: readonly TuiSlashCommand[]
  readonly query: string
  readonly selectedIndex: number
}): TuiCommandPaletteModel {
  const query = typeof input.query === 'string' ? input.query : ''
  const commands = filterTuiSlashCommands(input.commands, query)
  const rows = commands.map((command, ordinal) => ({
    id: tuiCommandPaletteCommandId(command),
    name: command.name,
    invocation: `/${command.name}`,
    description: command.description,
    ordinal,
    selected: false,
  }))
  const normalizedIndex = rows.length
    ? Math.max(
        0,
        Math.min(
          rows.length - 1,
          Number.isFinite(input.selectedIndex)
            ? Math.trunc(input.selectedIndex)
            : 0,
        ),
      )
    : null
  const selectedId =
    normalizedIndex === null ? null : (rows[normalizedIndex]?.id ?? null)
  const selectedRows = rows.map((row, index) => ({
    ...row,
    selected: index === normalizedIndex,
  }))
  const start =
    normalizedIndex === null
      ? 0
      : Math.max(0, Math.min(normalizedIndex - 6, rows.length - 12))
  return {
    kind: 'command-palette',
    query,
    rows: selectedRows,
    selectedIndex: normalizedIndex,
    selectedId,
    visibleRange: { start, end: Math.min(rows.length, start + 12) },
    actions: {
      navigate: '↑/↓ to navigate',
      complete: 'Tab to complete',
      submit: 'Enter to run',
      cancel: 'Esc to cancel',
    },
  }
}
