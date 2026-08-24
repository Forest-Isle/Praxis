import type {
  TuiMcpPanelModel,
  TuiMcpPanelState,
} from './mcp-panel-projector.js'

export interface TuiMcpSurfaceModel {
  readonly kind: 'mcp-panel'
  readonly model: TuiMcpPanelModel
  readonly state: TuiMcpPanelState
}

export function projectTuiMcpSurface({
  model,
  state,
}: {
  model: TuiMcpPanelModel
  state: TuiMcpPanelState
}): TuiMcpSurfaceModel {
  return { kind: 'mcp-panel', model, state }
}
