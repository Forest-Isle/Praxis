export interface TuiSessionPickerChoice {
  readonly sessionId: string
  readonly name?: string | null
  readonly lastPrompt?: string | null
  readonly status: string
}

export type TuiSessionPickerRawChoice = TuiSessionPickerChoice | null

export interface TuiSessionPickerRow {
  readonly id: string
  readonly kind: 'new-session' | 'session'
  readonly label: string
  readonly detail?: string
  readonly status: string
  readonly ordinal: number
  readonly selected: boolean
}

export interface TuiSessionPickerModel {
  readonly kind: 'session-picker'
  readonly query: string
  readonly rows: readonly TuiSessionPickerRow[]
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

export function tuiSessionPickerChoiceId(
  choice: TuiSessionPickerRawChoice,
): string {
  return choice === null ? 'new-session' : `session:${choice.sessionId}`
}

export function filterTuiSessionPickerChoices(
  choices: readonly TuiSessionPickerRawChoice[],
  query: string,
): readonly TuiSessionPickerRawChoice[] {
  const normalized = typeof query === 'string' ? query.trim().toLowerCase() : ''
  if (!normalized) return choices
  return choices.filter((choice) => {
    if (choice === null) return false
    return [choice.sessionId, choice.name, choice.lastPrompt].some(
      (value) =>
        typeof value === 'string' && value.toLowerCase().includes(normalized),
    )
  })
}

function safeText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function projectTuiSessionPicker(input: {
  readonly choices: readonly TuiSessionPickerRawChoice[]
  readonly query: string
  readonly selectedIndex: number
}): TuiSessionPickerModel {
  const query = typeof input.query === 'string' ? input.query : ''
  const choices = filterTuiSessionPickerChoices(input.choices, query)
  const rows = choices.map((choice, ordinal) => {
    if (choice === null) {
      return {
        id: 'new-session',
        kind: 'new-session' as const,
        label: 'Start a new session',
        status: '',
        ordinal,
        selected: false,
      }
    }
    return {
      id: tuiSessionPickerChoiceId(choice),
      kind: 'session' as const,
      label: safeText(choice.name) ?? safeText(choice.lastPrompt) ?? 'Untitled',
      detail: `${choice.sessionId} · ${safeText(choice.status) ?? ''}`,
      status: safeText(choice.status) ?? '',
      ordinal,
      selected: false,
    }
  })
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
      : Math.max(0, Math.min(normalizedIndex - 3, rows.length - 8))
  return {
    kind: 'session-picker',
    query,
    rows: selectedRows,
    selectedIndex: normalizedIndex,
    selectedId,
    visibleRange: { start, end: Math.min(rows.length, start + 8) },
    actions: {
      navigate: '↑/↓ to navigate',
      select: 'Enter to select',
      search: 'Type to search',
      cancel: 'Esc to cancel',
    },
  }
}
