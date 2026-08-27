export type DataPlane = 'native'

export interface DataPlaneRootOptions {
  root?: string
  environment?: Readonly<Record<string, string | undefined>>
  homeDirectory?: string
}

export interface DataPlaneAdapterOptions extends DataPlaneRootOptions {
  cwd: string
  sessionId: string
}

export interface ScheduledTaskFileOptions {
  cwd: string
  root: string
}

export interface DataPlanePaths {
  dataPlane: DataPlane
  root: string
  projectRoot: string
  sessionFile: string
  taskRoot: string
  stateRoot: string
  praxisRoot: string
  memoryRoot: string
}

export interface DataPlaneAdapter {
  readonly dataPlane: DataPlane
  resolveRoot(options: DataPlaneRootOptions): string
  resolvePaths(options: DataPlaneAdapterOptions): DataPlanePaths
  resolveScheduledTaskFile(options: ScheduledTaskFileOptions): string
}
