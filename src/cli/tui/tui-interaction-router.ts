export type TuiScrollIntent =
  | 'page-older'
  | 'page-newer'
  | 'half-page-older'
  | 'half-page-newer'
  | 'line-older'
  | 'line-newer'
  | 'none'

export interface TuiInteractionInput {
  suspend: boolean
  scrollIntent: TuiScrollIntent
  action: string | undefined
}

export interface TuiInteractionSnapshot {
  suspensionPending: boolean
  blockingLayerActive: boolean
  busy: boolean
  viewport: {
    enabled: boolean
    offset: number
    maxOffset: number
    pageRows: number
  }
}

export type TuiInteractionEffect =
  | { readonly kind: 'request-process-suspension' }
  | { readonly kind: 'set-transcript-scroll-offset'; readonly offset: number }
  | { readonly kind: 'interrupt-turn' }

export type TuiInteractionResult =
  | {
      readonly disposition: 'handled'
      readonly effects: readonly TuiInteractionEffect[]
    }
  | {
      readonly disposition: 'delegated'
      readonly effects: readonly TuiInteractionEffect[]
    }

const handled = (
  effects: readonly TuiInteractionEffect[] = [],
): TuiInteractionResult => ({
  disposition: 'handled',
  effects,
})

const delegated = (): TuiInteractionResult => ({
  disposition: 'delegated',
  effects: [],
})

function finiteNonNegativeInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0
}

export function routeTuiInteraction(
  snapshot: TuiInteractionSnapshot,
  input: TuiInteractionInput,
): TuiInteractionResult {
  if (input.suspend) {
    return snapshot.suspensionPending
      ? handled()
      : handled([{ kind: 'request-process-suspension' }])
  }
  if (snapshot.blockingLayerActive) return delegated()

  const viewport = snapshot.viewport
  if (viewport.enabled && input.scrollIntent !== 'none') {
    const pageRows = finiteNonNegativeInteger(viewport.pageRows)
    const offset = finiteNonNegativeInteger(viewport.offset)
    const maxOffset = finiteNonNegativeInteger(viewport.maxOffset)
    const halfPage = Math.max(1, Math.trunc(pageRows / 2))
    const movement =
      input.scrollIntent === 'page-older' || input.scrollIntent === 'page-newer'
        ? pageRows
        : input.scrollIntent === 'half-page-older' ||
            input.scrollIntent === 'half-page-newer'
          ? halfPage
          : 1
    const older =
      input.scrollIntent === 'page-older' ||
      input.scrollIntent === 'half-page-older' ||
      input.scrollIntent === 'line-older'
    const nextOffset = Math.min(
      maxOffset,
      Math.max(0, offset + (older ? movement : -movement)),
    )
    return handled([
      { kind: 'set-transcript-scroll-offset', offset: nextOffset },
    ])
  }

  if (!snapshot.busy) return delegated()
  if (
    input.action === 'app:toggleTranscript' ||
    input.action === 'task:background'
  ) {
    return delegated()
  }
  if (input.action === 'chat:cancel')
    return handled([{ kind: 'interrupt-turn' }])
  return handled()
}
