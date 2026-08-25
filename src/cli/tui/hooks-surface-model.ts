import type { TuiHookConfiguration } from './hook-settings.js'

export type TuiHooksDepth = 'events' | 'matchers' | 'hooks' | 'detail'

export interface TuiHooksSurfaceModel {
  readonly kind: 'hooks-panel'
  readonly configuration: TuiHookConfiguration
  readonly depth: TuiHooksDepth
  readonly eventIndex: number
  readonly matcherIndex: number
  readonly hookIndex: number
}

export function projectTuiHooksSurface(input: {
  configuration: TuiHookConfiguration
  depth: TuiHooksDepth
  eventIndex: number
  matcherIndex: number
  hookIndex: number
}): TuiHooksSurfaceModel {
  return {
    kind: 'hooks-panel',
    configuration: input.configuration,
    depth: input.depth,
    eventIndex: input.eventIndex,
    matcherIndex: input.matcherIndex,
    hookIndex: input.hookIndex,
  }
}
