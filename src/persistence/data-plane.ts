import { claudeDataPlaneAdapter } from '../compatibility/claude/data-plane-adapter.js'
import type {
  DataPlane,
  DataPlaneAdapter,
  DataPlanePaths,
  DataPlaneRootOptions,
} from './data-plane-adapter.js'
import { nativeDataPlaneAdapter } from './native-data-plane-adapter.js'

export type { DataPlane, DataPlanePaths } from './data-plane-adapter.js'

export interface ResolveDataPlaneOptions extends DataPlaneRootOptions {
  dataPlane?: DataPlane
  cwd: string
  sessionId: string
}

function adapterFor(dataPlane: DataPlane): DataPlaneAdapter {
  return dataPlane === 'native'
    ? nativeDataPlaneAdapter
    : claudeDataPlaneAdapter
}

export function resolveDataPlane(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): DataPlane {
  const value = environment.PRAXIS_DATA_PLANE?.trim()
  if (value === undefined || value === '') return 'native'
  if (value === 'native' || value === 'claude') return value
  throw new Error('PRAXIS_DATA_PLANE must be "native" or "claude"')
}

export function resolveDataPlaneRoot(
  options: DataPlaneRootOptions & { dataPlane?: DataPlane } = {},
): string {
  const environment = options.environment ?? process.env
  const dataPlane = options.dataPlane ?? resolveDataPlane(environment)
  return adapterFor(dataPlane).resolveRoot(options)
}

export function resolveDataPlanePaths(
  options: ResolveDataPlaneOptions,
): DataPlanePaths {
  const environment = options.environment ?? process.env
  const dataPlane = options.dataPlane ?? resolveDataPlane(environment)
  return adapterFor(dataPlane).resolvePaths(options)
}

export function resolveScheduledTaskFile(options: {
  dataPlane: DataPlane
  cwd: string
  root: string
}): string {
  return adapterFor(options.dataPlane).resolveScheduledTaskFile(options)
}
