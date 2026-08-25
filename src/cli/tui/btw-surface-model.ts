export type TuiBtwEntry = {
  id: number
  question: string
  answer: string
  status: 'answering' | 'complete' | 'forking' | 'error'
  error?: string
}

export type TuiBtwSurfaceModel = {
  kind: 'btw-panel'
  entries: readonly TuiBtwEntry[]
  selectedIndex: number
  scrollOffset: number
  copied: boolean
}

export type TuiBtwSurfaceInput = {
  entries: readonly TuiBtwEntry[]
  selectedIndex: number
  scrollOffset: number
  copied: boolean
}

export function projectTuiBtwSurface(
  input: TuiBtwSurfaceInput,
): TuiBtwSurfaceModel {
  return {
    kind: 'btw-panel',
    entries: input.entries,
    selectedIndex: input.selectedIndex,
    scrollOffset: input.scrollOffset,
    copied: input.copied,
  }
}
