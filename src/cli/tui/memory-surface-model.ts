import type { DataPlane } from '../../persistence/data-plane.js'
import type { TuiMemoryFileEntry } from './memory-files.js'

export interface TuiMemorySurfaceModel {
  readonly kind: 'memory-panel'
  readonly autoMemoryEnabled: boolean
  readonly entries: readonly TuiMemoryFileEntry[]
  readonly selectedIndex: number
  readonly openedIndex: number | null
  readonly loading: boolean
  readonly dataPlane: DataPlane
}

export function projectTuiMemorySurface(input: {
  autoMemoryEnabled: boolean
  entries: readonly TuiMemoryFileEntry[]
  selectedIndex: number
  openedIndex: number | null
  loading?: boolean
  dataPlane: DataPlane
}): TuiMemorySurfaceModel {
  return {
    kind: 'memory-panel',
    autoMemoryEnabled: input.autoMemoryEnabled,
    entries: input.entries,
    selectedIndex: input.selectedIndex,
    openedIndex: input.openedIndex,
    loading: input.loading ?? false,
    dataPlane: input.dataPlane,
  }
}
