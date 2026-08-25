export interface TuiSelectionOption {
  readonly label: string
  readonly description: string
  readonly selected?: boolean
}

export interface TuiModelOption extends TuiSelectionOption {
  readonly model?: string
}

export interface TuiModelSurfaceModel {
  readonly kind: 'model-panel'
  readonly options: readonly TuiModelOption[]
  readonly effort: string
  readonly selectedIndex: number
}

export interface TuiEffortSurfaceModel {
  readonly kind: 'effort-panel'
  readonly options: readonly TuiSelectionOption[]
  readonly selectedIndex: number
}

export const projectTuiModelSurface = (input: {
  options: readonly TuiModelOption[]
  effort: string
  selectedIndex: number
}): TuiModelSurfaceModel => ({
  kind: 'model-panel',
  options: input.options,
  effort: input.effort,
  selectedIndex: input.selectedIndex,
})

export const projectTuiEffortSurface = (input: {
  effort: string
  selectedIndex: number
}): TuiEffortSurfaceModel => ({
  kind: 'effort-panel',
  options: [
    {
      label: 'low',
      description: 'Fastest and least deliberative.',
      selected: input.effort === 'low',
    },
    {
      label: 'medium',
      description: 'Use this effort for the next session turns.',
      selected: input.effort === 'medium',
    },
    {
      label: 'high',
      description: 'Use this effort for the next session turns.',
      selected: input.effort === 'high',
    },
    {
      label: 'xhigh',
      description: 'Use this effort for the next session turns.',
      selected: input.effort === 'xhigh',
    },
    {
      label: 'max',
      description: 'Highest available reasoning effort.',
      selected: input.effort === 'max',
    },
  ],
  selectedIndex: input.selectedIndex,
})
