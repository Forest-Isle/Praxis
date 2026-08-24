import {
  filterTuiMentionEntries,
  type TuiAgentEntry,
  type TuiFileEntry,
  type TuiMentionEntry,
} from './file-picker.js'

export type TuiMentionPickerRow =
  | {
      readonly id: string
      readonly kind: 'file'
      readonly path: string
      readonly directory: boolean
      readonly ordinal: number
      readonly selected: boolean
    }
  | {
      readonly id: string
      readonly kind: 'agent'
      readonly name: string
      readonly description: string
      readonly ordinal: number
      readonly selected: boolean
    }

export interface TuiMentionPickerModel {
  readonly kind: 'mention-picker'
  readonly query: string
  readonly rows: readonly TuiMentionPickerRow[]
  readonly selectedIndex: number | null
  readonly selectedId: string | null
  readonly visibleRange: { readonly start: number; readonly end: number }
  readonly actions: {
    readonly navigate: string
    readonly select: string
    readonly search: string
    readonly cancel: string
  }
}

export function tuiMentionEntryId(entry: TuiMentionEntry): string {
  return entry.kind === 'file' ? `file:${entry.path}` : `agent:${entry.name}`
}

export function projectTuiMentionPicker(input: {
  readonly files: readonly TuiFileEntry[]
  readonly agents: readonly TuiAgentEntry[]
  readonly query: string
  readonly selectedIndex: number
}): TuiMentionPickerModel {
  const query = typeof input.query === 'string' ? input.query : ''
  const entries = filterTuiMentionEntries(input.files, input.agents, query)
  const rows = entries.map((entry, ordinal) =>
    entry.kind === 'file'
      ? {
          id: tuiMentionEntryId(entry),
          kind: 'file' as const,
          path: entry.path,
          directory: entry.directory,
          ordinal,
          selected: false,
        }
      : {
          id: tuiMentionEntryId(entry),
          kind: 'agent' as const,
          name: entry.name,
          description: entry.description,
          ordinal,
          selected: false,
        },
  )
  const selectedIndex = rows.length
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
    selectedIndex === null ? null : (rows[selectedIndex]?.id ?? null)
  const selectedRows = rows.map((row, index) => ({
    ...row,
    selected: index === selectedIndex,
  }))
  const start =
    selectedIndex === null
      ? 0
      : Math.max(0, Math.min(selectedIndex - 6, rows.length - 12))
  return {
    kind: 'mention-picker',
    query,
    rows: selectedRows,
    selectedIndex,
    selectedId,
    visibleRange: { start, end: Math.min(rows.length, start + 12) },
    actions: {
      navigate: '↑/↓ to navigate',
      select: 'Enter to select · Tab to complete',
      search: 'Type to search',
      cancel: 'Esc to cancel',
    },
  }
}
