import type { TuiAgentEntry } from './file-picker.js'

export type TuiListSurfaceModel = {
  readonly kind: 'list-panel'
  readonly title: string
  readonly rows: readonly {
    readonly label: string
    readonly description?: string
  }[]
  readonly emptyText: string
  readonly selectedIndex: number
}

export type TuiListSurfaceInput =
  | {
      readonly kind: 'agents'
      readonly agents: readonly TuiAgentEntry[]
      readonly selectedIndex: number
    }
  | {
      readonly kind: 'list'
      readonly title: string
      readonly rows: readonly {
        readonly label: string
        readonly description?: string
      }[]
      readonly emptyText: string
      readonly selectedIndex: number
    }

export function projectTuiListSurface(
  input: TuiListSurfaceInput,
): TuiListSurfaceModel {
  if (input.kind === 'agents') {
    return {
      kind: 'list-panel',
      title: 'Agents',
      rows: input.agents.map(({ name, description }) => ({
        label: name,
        description,
      })),
      emptyText: 'No agents configured',
      selectedIndex: input.selectedIndex,
    }
  }
  return {
    kind: 'list-panel',
    title: input.title,
    rows: input.rows,
    emptyText: input.emptyText,
    selectedIndex: input.selectedIndex,
  }
}
