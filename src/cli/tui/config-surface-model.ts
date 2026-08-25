import type {
  ConfigDashboardTab,
  ConfigEffectiveValues,
  ConfigStatusData,
  ConfigUsageData,
} from './config-dashboard.js'
import type { ConfigSettingsSnapshot } from './config-settings.js'

export interface TuiConfigSurfaceModel {
  readonly kind: 'config-panel'
  readonly tab: ConfigDashboardTab
  readonly snapshot: ConfigSettingsSnapshot
  readonly query: string
  readonly selectedIndex: number
  readonly searchFocused: boolean
  readonly status?: ConfigStatusData
  readonly usage?: ConfigUsageData
  readonly effectiveValues?: ConfigEffectiveValues
}

export function projectTuiConfigSurface(input: {
  tab: ConfigDashboardTab
  snapshot: ConfigSettingsSnapshot
  query?: string
  selectedIndex?: number
  searchFocused?: boolean
  status?: ConfigStatusData
  usage?: ConfigUsageData
  effectiveValues?: ConfigEffectiveValues
}): TuiConfigSurfaceModel {
  return {
    kind: 'config-panel',
    tab: input.tab,
    snapshot: input.snapshot,
    query: input.query ?? '',
    selectedIndex: input.selectedIndex ?? 0,
    searchFocused: input.searchFocused ?? true,
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.usage === undefined ? {} : { usage: input.usage }),
    ...(input.effectiveValues === undefined
      ? {}
      : { effectiveValues: input.effectiveValues }),
  }
}
