import {
  routeComposerKey,
  type ComposerKeyProjection,
} from './composer-key-router.js'
import type { ComposerEditorState } from './composer-editor.js'

export type TuiScrollIntent =
  | 'page-older'
  | 'page-newer'
  | 'half-page-older'
  | 'half-page-newer'
  | 'line-older'
  | 'line-newer'
  | 'none'

export type TuiCancellationTarget =
  | 'permission'
  | 'plan-approval'
  | 'question'
  | 'elicitation'
  | 'elicitation-url-waiting'
  | 'elicitation-options'
  | 'file-picker'
  | 'command-palette'

export type TuiInteractionLayer =
  | { readonly kind: 'none' }
  | { readonly kind: 'pending-prefix' }
  | { readonly kind: 'cancelable'; readonly target: TuiCancellationTarget }
  | {
      readonly kind: 'delegated'
      readonly target: 'session-picker' | 'menu'
    }

export type TuiCallerIntent =
  'none' | 'toggle-shortcuts' | 'open-agents' | 'implicit-newline'

export interface TuiInteractionInput {
  globalIntent: 'none' | 'exit' | 'suspend'
  scrollIntent: TuiScrollIntent
  action: string | undefined
  composerKey: ComposerKeyProjection
  timestamp: number
  callerIntent: TuiCallerIntent
}

export interface TuiInteractionSnapshot {
  suspensionPending: boolean
  exitConfirmationArmed: boolean
  layer: TuiInteractionLayer
  busy: boolean
  viewport: {
    enabled: boolean
    offset: number
    maxOffset: number
    pageRows: number
  }
  composer: {
    mode: 'readline' | 'vim-insert' | 'vim-normal'
    editor: ComposerEditorState
    lastCancelAtMs: number
  }
}

export type TuiInteractionEffect =
  | { readonly kind: 'arm-exit-confirmation' }
  | { readonly kind: 'dismiss-exit-confirmation' }
  | { readonly kind: 'exit-application' }
  | { readonly kind: 'request-process-suspension' }
  | {
      readonly kind: 'cancel-tui-layer'
      readonly target: TuiCancellationTarget
    }
  | { readonly kind: 'set-transcript-scroll-offset'; readonly offset: number }
  | { readonly kind: 'interrupt-turn' }
  | { readonly kind: 'set-vim-insert-mode'; readonly insert: boolean }
  | {
      readonly kind: 'set-composer-editor'
      readonly editor: ComposerEditorState
    }
  | { readonly kind: 'clear-composer' }
  | { readonly kind: 'record-composer-cancel'; readonly timestamp: number }

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

const delegated = (
  effects: readonly TuiInteractionEffect[] = [],
): TuiInteractionResult => ({
  disposition: 'delegated',
  effects,
})

function finiteNonNegativeInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0
}

function isEscape(key: ComposerKeyProjection): boolean {
  return key.escape || key.value === '\u001B'
}

function canUseCancelWindow(timestamp: number, previous: number): boolean {
  return Number.isFinite(timestamp) && Number.isFinite(previous)
}

export function routeTuiInteraction(
  snapshot: TuiInteractionSnapshot,
  input: TuiInteractionInput,
): TuiInteractionResult {
  if (input.globalIntent === 'exit') {
    return snapshot.exitConfirmationArmed
      ? handled([{ kind: 'exit-application' }])
      : handled([{ kind: 'clear-composer' }, { kind: 'arm-exit-confirmation' }])
  }

  if (input.globalIntent === 'suspend') {
    return snapshot.suspensionPending
      ? handled()
      : handled([{ kind: 'request-process-suspension' }])
  }

  const confirmationEffects: TuiInteractionEffect[] =
    snapshot.exitConfirmationArmed
      ? [{ kind: 'dismiss-exit-confirmation' }]
      : []

  if (snapshot.layer.kind === 'pending-prefix')
    return handled(confirmationEffects)

  if (snapshot.layer.kind === 'cancelable') {
    if (isEscape(input.composerKey) || input.action === 'chat:cancel') {
      return handled([
        ...confirmationEffects,
        { kind: 'cancel-tui-layer', target: snapshot.layer.target },
      ])
    }
    return delegated(confirmationEffects)
  }

  if (snapshot.layer.kind === 'delegated') return delegated(confirmationEffects)

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
      ...confirmationEffects,
      { kind: 'set-transcript-scroll-offset', offset: nextOffset },
    ])
  }

  if (snapshot.busy) {
    if (
      input.action === 'app:toggleTranscript' ||
      input.action === 'task:background'
    ) {
      return delegated(confirmationEffects)
    }
    if (input.action === 'chat:cancel')
      return handled([...confirmationEffects, { kind: 'interrupt-turn' }])
    return handled(confirmationEffects)
  }

  if (input.callerIntent !== 'none') return delegated(confirmationEffects)

  if (snapshot.composer.mode === 'vim-normal') {
    if (input.composerKey.value === 'i' || input.composerKey.value === 'a') {
      return handled([
        ...confirmationEffects,
        { kind: 'set-vim-insert-mode', insert: true },
      ])
    }
    if (input.composerKey.left || input.composerKey.right) {
      const transition = routeComposerKey(
        snapshot.composer.editor,
        input.composerKey,
      )
      if (transition.kind === 'edit')
        return handled([
          ...confirmationEffects,
          { kind: 'set-composer-editor', editor: transition.editor },
        ])
    }
    return handled(confirmationEffects)
  }

  if (snapshot.composer.mode === 'vim-insert' && isEscape(input.composerKey)) {
    return handled([
      ...confirmationEffects,
      { kind: 'set-vim-insert-mode', insert: false },
    ])
  }

  if (input.action === 'chat:cancel') {
    const timestamp = input.timestamp
    const cancelDelta = timestamp - snapshot.composer.lastCancelAtMs
    const shouldClear =
      canUseCancelWindow(timestamp, snapshot.composer.lastCancelAtMs) &&
      cancelDelta >= 0 &&
      cancelDelta <= 500
    return handled([
      ...confirmationEffects,
      ...(shouldClear ? [{ kind: 'clear-composer' as const }] : []),
      ...(Number.isFinite(timestamp)
        ? [{ kind: 'record-composer-cancel' as const, timestamp }]
        : []),
    ])
  }

  if (input.action !== undefined) return delegated(confirmationEffects)

  const transition = routeComposerKey(
    snapshot.composer.editor,
    input.composerKey,
  )
  if (transition.kind === 'edit')
    return handled([
      ...confirmationEffects,
      { kind: 'set-composer-editor', editor: transition.editor },
    ])
  if (transition.kind === 'cancel')
    return handled([...confirmationEffects, { kind: 'clear-composer' }])
  return delegated(confirmationEffects)
}
