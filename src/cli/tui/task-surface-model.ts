import type { TuiTaskEntry, TuiTaskPanelState } from './task-panel.js'

export interface TuiTaskSurfaceModel {
  readonly kind: 'tasks-panel'
  readonly tasks: readonly TuiTaskEntry[]
  readonly state: TuiTaskPanelState
}

export function projectTuiTaskSurface(input: {
  tasks: readonly TuiTaskEntry[]
  state: TuiTaskPanelState
}): TuiTaskSurfaceModel {
  return { kind: 'tasks-panel', tasks: input.tasks, state: input.state }
}
