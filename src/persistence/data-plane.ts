import type {
  DataPlane,
  DataPlanePaths,
  DataPlaneRootOptions,
} from './data-plane-adapter.js'
import { nativeDataPlaneAdapter } from './native-data-plane-adapter.js'

export type { DataPlane, DataPlanePaths } from './data-plane-adapter.js'

export function assertNativeDataPlane(
  value: unknown,
): asserts value is DataPlane {
  if (value !== 'native') {
    throw new Error('Praxis supports only the native data plane')
  }
}

export interface ResolveDataPlaneOptions extends DataPlaneRootOptions {
  dataPlane?: DataPlane
  cwd: string
  sessionId: string
}

export function resolveDataPlane(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): DataPlane {
  const value = environment.PRAXIS_DATA_PLANE?.trim()
  if (value === undefined || value === '') return 'native'
  if (value === 'native') return value
  throw new Error('PRAXIS_DATA_PLANE must be "native"')
}

export function resolveDataPlaneRoot(
  options: DataPlaneRootOptions = {},
): string {
  const environment = options.environment ?? process.env
  resolveDataPlane(environment)
  return nativeDataPlaneAdapter.resolveRoot(options)
}

export function resolveDataPlanePaths(
  options: ResolveDataPlaneOptions,
): DataPlanePaths {
  const environment = options.environment ?? process.env
  resolveDataPlane(environment)
  if (options.dataPlane !== undefined) {
    assertNativeDataPlane(options.dataPlane)
  }
  return nativeDataPlaneAdapter.resolvePaths(options)
}

export function resolveScheduledTaskFile(options: {
  dataPlane: DataPlane
  cwd: string
  root: string
}): string {
  assertNativeDataPlane(options.dataPlane)
  return nativeDataPlaneAdapter.resolveScheduledTaskFile(options)
}
