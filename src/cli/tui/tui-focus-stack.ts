import type { TuiInteractionLayer } from './tui-interaction-router.js'

export interface TuiFocusEntry {
  readonly id: string
  readonly layer: TuiInteractionLayer
}

export interface TuiFocusProjectionInput {
  readonly pendingPrefix: boolean
  readonly permission: boolean
  readonly planApproval: boolean
  readonly question: boolean
  readonly elicitation: 'plain' | 'url-waiting' | 'expanded-options' | false
  readonly selectingSession: boolean
  readonly menu: boolean
  readonly filePicker: boolean
  readonly commandPalette: boolean
}

const composerEntry: TuiFocusEntry = Object.freeze({
  id: 'composer',
  layer: { kind: 'none' as const },
})

export function projectTuiFocusStack(
  input: TuiFocusProjectionInput,
): readonly TuiFocusEntry[] {
  let higher: TuiFocusEntry | undefined

  if (input.pendingPrefix) {
    higher = { id: 'pending-prefix', layer: { kind: 'pending-prefix' } }
  } else if (input.permission) {
    higher = {
      id: 'permission',
      layer: { kind: 'cancelable', target: 'permission' },
    }
  } else if (input.planApproval) {
    higher = {
      id: 'plan-approval',
      layer: { kind: 'cancelable', target: 'plan-approval' },
    }
  } else if (input.question) {
    higher = {
      id: 'question',
      layer: { kind: 'cancelable', target: 'question' },
    }
  } else if (input.elicitation === 'url-waiting') {
    higher = {
      id: 'elicitation-url-waiting',
      layer: { kind: 'cancelable', target: 'elicitation-url-waiting' },
    }
  } else if (input.elicitation === 'expanded-options') {
    higher = {
      id: 'elicitation-options',
      layer: { kind: 'cancelable', target: 'elicitation-options' },
    }
  } else if (input.elicitation === 'plain') {
    higher = {
      id: 'elicitation',
      layer: { kind: 'cancelable', target: 'elicitation' },
    }
  } else if (input.selectingSession) {
    higher = {
      id: 'session-picker',
      layer: { kind: 'delegated', target: 'session-picker' },
    }
  } else if (input.menu) {
    higher = { id: 'menu', layer: { kind: 'delegated', target: 'menu' } }
  } else if (input.filePicker) {
    higher = {
      id: 'file-picker',
      layer: { kind: 'cancelable', target: 'file-picker' },
    }
  } else if (input.commandPalette) {
    higher = {
      id: 'command-palette',
      layer: { kind: 'cancelable', target: 'command-palette' },
    }
  }

  return Object.freeze(
    higher ? [composerEntry, Object.freeze(higher)] : [composerEntry],
  )
}

export function currentTuiInteractionLayer(
  stack: readonly TuiFocusEntry[],
): TuiInteractionLayer {
  return stack.at(-1)?.layer ?? { kind: 'none' }
}
