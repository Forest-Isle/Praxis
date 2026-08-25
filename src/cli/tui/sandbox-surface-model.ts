import type { TuiSandboxSnapshot, TuiSandboxTab } from './sandbox-settings.js'

export interface TuiSandboxSurfaceModel {
  readonly kind: 'sandbox-panel'
  readonly snapshot: TuiSandboxSnapshot
  readonly tab: TuiSandboxTab
  readonly selectedIndex: number
}

export function projectTuiSandboxSurface({
  snapshot,
  tab,
  selectedIndex,
}: {
  snapshot: TuiSandboxSnapshot
  tab: TuiSandboxTab
  selectedIndex: number
}): TuiSandboxSurfaceModel {
  return { kind: 'sandbox-panel', snapshot, tab, selectedIndex }
}
