import type { RewindPoint } from '../../application/session-service.js'

export type TuiRewindAction =
  | 'code-and-conversation'
  | 'conversation'
  | 'code'
  | 'summarize-from'
  | 'summarize-to'
  | 'cancel'

export type TuiRewindActionOption = {
  readonly action: TuiRewindAction
  readonly label: string
}

export function rewindActions(
  point: RewindPoint,
): readonly TuiRewindActionOption[] {
  const shared: readonly TuiRewindActionOption[] = [
    { action: 'summarize-from', label: 'Summarize from here' },
    { action: 'summarize-to', label: 'Summarize up to here' },
    { action: 'cancel', label: 'Never mind' },
  ]
  return point.fileRestoreAvailable && point.fileChanges.length > 0
    ? [
        {
          action: 'code-and-conversation',
          label: 'Restore code and conversation',
        },
        { action: 'conversation', label: 'Restore conversation' },
        { action: 'code', label: 'Restore code' },
        ...shared,
      ]
    : [{ action: 'conversation', label: 'Restore conversation' }, ...shared]
}

export function rewindPointWindow(
  points: readonly RewindPoint[],
  selectedIndex: number,
  size = 6,
): { readonly start: number; readonly end: number } {
  if (points.length <= size) return { start: 0, end: points.length }
  if (selectedIndex >= points.length)
    return { start: points.length - size, end: points.length }
  const start = Math.max(
    0,
    Math.min(points.length - size, selectedIndex - Math.floor(size / 2)),
  )
  return { start, end: start + size }
}

export type TuiRewindSurfaceModel =
  | {
      readonly kind: 'rewind-panel'
      readonly view: 'points'
      readonly points: readonly RewindPoint[]
      readonly selectedIndex: number
      readonly window: { readonly start: number; readonly end: number }
    }
  | {
      readonly kind: 'rewind-panel'
      readonly view: 'confirm'
      readonly points: readonly RewindPoint[]
      readonly point: RewindPoint
      readonly selectedIndex: number
      readonly actions: readonly TuiRewindActionOption[]
    }
  | {
      readonly kind: 'rewind-panel'
      readonly view: 'context'
      readonly points: readonly RewindPoint[]
      readonly point: RewindPoint
      readonly direction: 'from' | 'to'
      readonly context: string
    }

export type TuiRewindSurfaceInput =
  | {
      readonly kind: 'rewind'
      readonly points: readonly RewindPoint[]
      readonly selectedIndex: number
    }
  | {
      readonly kind: 'rewind-confirm'
      readonly points: readonly RewindPoint[]
      readonly point: RewindPoint
      readonly selectedIndex: number
    }
  | {
      readonly kind: 'rewind-context'
      readonly points: readonly RewindPoint[]
      readonly point: RewindPoint
      readonly direction: 'from' | 'to'
      readonly context: string
    }

export function projectTuiRewindSurface(
  input: TuiRewindSurfaceInput,
): TuiRewindSurfaceModel {
  if (input.kind === 'rewind')
    return {
      kind: 'rewind-panel',
      view: 'points',
      points: input.points,
      selectedIndex: input.selectedIndex,
      window: rewindPointWindow(input.points, input.selectedIndex),
    }
  if (input.kind === 'rewind-confirm')
    return {
      kind: 'rewind-panel',
      view: 'confirm',
      points: input.points,
      point: input.point,
      selectedIndex: input.selectedIndex,
      actions: rewindActions(input.point),
    }
  return {
    kind: 'rewind-panel',
    view: 'context',
    points: input.points,
    point: input.point,
    direction: input.direction,
    context: input.context,
  }
}
