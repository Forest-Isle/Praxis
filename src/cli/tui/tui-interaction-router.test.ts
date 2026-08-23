import { describe, expect, it } from 'vitest'

import {
  routeTuiInteraction,
  type TuiCancellationTarget,
  type TuiInteractionInput,
} from './tui-interaction-router.js'

const composerKey = {
  value: '',
  left: false,
  right: false,
  backspace: false,
  delete: false,
  ctrl: false,
  meta: false,
  escape: false,
}

const interactionInput = (
  overrides: Partial<TuiInteractionInput> = {},
): TuiInteractionInput => ({
  globalIntent: 'none',
  scrollIntent: 'none',
  action: undefined,
  composerKey,
  timestamp: 0,
  callerIntent: 'none',
  ...overrides,
})

describe('routeTuiInteraction', () => {
  const base = {
    suspensionPending: false,
    exitConfirmationArmed: false,
    layer: { kind: 'none' as const },
    busy: false,
    viewport: { enabled: true, offset: 4, maxOffset: 10, pageRows: 5 },
    composer: {
      mode: 'readline' as const,
      editor: { text: '', cursor: 0 },
      lastCancelAtMs: 0,
    },
  }

  it('handles Ctrl-Z before blocking or busy state and deduplicates pending suspension', () => {
    const input = interactionInput({ globalIntent: 'suspend' })
    const snapshot = {
      suspensionPending: false,
      exitConfirmationArmed: false,
      layer: { kind: 'delegated' as const, target: 'menu' as const },
      busy: true,
      viewport: { enabled: false, offset: 0, maxOffset: 0, pageRows: 0 },
      composer: base.composer,
    }

    expect(routeTuiInteraction(snapshot, input)).toEqual({
      disposition: 'handled',
      effects: [{ kind: 'request-process-suspension' }],
    })
    expect(
      routeTuiInteraction({ ...snapshot, suspensionPending: true }, input),
    ).toEqual({ disposition: 'handled', effects: [] })
  })

  it('delegates blocking layers and ordinary idle input', () => {
    expect(
      routeTuiInteraction(
        { ...base, layer: { kind: 'delegated', target: 'menu' } },
        interactionInput({ scrollIntent: 'page-older' }),
      ),
    ).toEqual({ disposition: 'delegated', effects: [] })
    expect(
      routeTuiInteraction(base, {
        ...interactionInput(),
      }),
    ).toEqual({ disposition: 'delegated', effects: [] })
  })

  it('handles all scroll classes before busy policy and clamps offsets', () => {
    const busy = { ...base, busy: true }
    const route = (scrollIntent: TuiInteractionInput['scrollIntent']) =>
      routeTuiInteraction(busy, {
        ...interactionInput({ scrollIntent }),
      })
    expect(route('page-older')).toEqual({
      disposition: 'handled',
      effects: [{ kind: 'set-transcript-scroll-offset', offset: 9 }],
    })
    expect(route('page-newer')).toEqual({
      disposition: 'handled',
      effects: [{ kind: 'set-transcript-scroll-offset', offset: 0 }],
    })
    expect(route('half-page-older')).toEqual({
      disposition: 'handled',
      effects: [{ kind: 'set-transcript-scroll-offset', offset: 6 }],
    })
    expect(route('half-page-newer')).toEqual({
      disposition: 'handled',
      effects: [{ kind: 'set-transcript-scroll-offset', offset: 2 }],
    })
    expect(route('line-newer')).toEqual({
      disposition: 'handled',
      effects: [{ kind: 'set-transcript-scroll-offset', offset: 3 }],
    })
    expect(route('line-older')).toEqual({
      disposition: 'handled',
      effects: [{ kind: 'set-transcript-scroll-offset', offset: 5 }],
    })
    expect(
      routeTuiInteraction(
        { ...busy, viewport: { ...base.viewport, offset: 9, maxOffset: 10 } },
        interactionInput({ scrollIntent: 'page-older' }),
      ),
    ).toEqual({
      disposition: 'handled',
      effects: [{ kind: 'set-transcript-scroll-offset', offset: 10 }],
    })
  })

  it('delegates busy background/toggle, interrupts cancel, and consumes other input', () => {
    const busy = {
      ...base,
      busy: true,
      viewport: { ...base.viewport, enabled: false },
    }
    for (const action of ['app:toggleTranscript', 'task:background']) {
      expect(
        routeTuiInteraction(busy, {
          ...interactionInput({ action }),
        }),
      ).toEqual({
        disposition: 'delegated',
        effects: [],
      })
    }
    expect(
      routeTuiInteraction(busy, {
        ...interactionInput({ action: 'chat:cancel' }),
      }),
    ).toEqual({
      disposition: 'handled',
      effects: [{ kind: 'interrupt-turn' }],
    })
    expect(
      routeTuiInteraction(busy, {
        ...interactionInput({ action: 'other' }),
      }),
    ).toEqual({
      disposition: 'handled',
      effects: [],
    })
  })

  it('normalizes malformed viewport facts and still consumes clamped scrolling', () => {
    expect(
      routeTuiInteraction(
        {
          ...base,
          viewport: {
            enabled: true,
            offset: Number.NaN,
            maxOffset: -4,
            pageRows: 0,
          },
        },
        interactionInput({ scrollIntent: 'half-page-older' }),
      ),
    ).toEqual({
      disposition: 'handled',
      effects: [{ kind: 'set-transcript-scroll-offset', offset: 0 }],
    })
  })

  it('orders global exit and suspend before every projected layer', () => {
    const layer = {
      ...base,
      layer: { kind: 'cancelable' as const, target: 'permission' as const },
      exitConfirmationArmed: true,
    }
    expect(
      routeTuiInteraction(layer, interactionInput({ globalIntent: 'suspend' })),
    ).toEqual({
      disposition: 'handled',
      effects: [{ kind: 'request-process-suspension' }],
    })
    expect(
      routeTuiInteraction(layer, interactionInput({ globalIntent: 'exit' })),
    ).toEqual({
      disposition: 'handled',
      effects: [{ kind: 'exit-application' }],
    })
    expect(
      routeTuiInteraction(base, interactionInput({ globalIntent: 'exit' })),
    ).toEqual({
      disposition: 'handled',
      effects: [{ kind: 'clear-composer' }, { kind: 'arm-exit-confirmation' }],
    })
  })

  it('lets a pending keybinding prefix consume input before layers and busy policy', () => {
    expect(
      routeTuiInteraction(
        {
          ...base,
          busy: true,
          layer: { kind: 'pending-prefix' },
        },
        interactionInput({
          action: 'chat:cancel',
          composerKey: { ...composerKey, escape: true },
        }),
      ),
    ).toEqual({ disposition: 'handled', effects: [] })
  })

  it.each(['toggle-shortcuts', 'open-agents', 'implicit-newline'] as const)(
    'delegates caller intent %s before composer routing',
    (intent) => {
      expect(
        routeTuiInteraction(base, interactionInput({ callerIntent: intent })),
      ).toEqual({ disposition: 'delegated', effects: [] })
    },
  )

  it.each([
    'permission',
    'plan-approval',
    'question',
    'elicitation',
    'elicitation-url-waiting',
    'elicitation-options',
    'file-picker',
    'command-palette',
  ] satisfies readonly TuiCancellationTarget[])(
    'cancels only the projected %s layer',
    (target) => {
      expect(
        routeTuiInteraction(
          { ...base, layer: { kind: 'cancelable', target } },
          interactionInput({
            composerKey: { ...composerKey, escape: true },
          }),
        ),
      ).toEqual({
        disposition: 'handled',
        effects: [{ kind: 'cancel-tui-layer', target }],
      })
    },
  )

  it('dismisses confirmation before delegating and cancels only the typed layer', () => {
    const snapshot = {
      ...base,
      exitConfirmationArmed: true,
      layer: {
        kind: 'cancelable' as const,
        target: 'elicitation-options' as const,
      },
    }
    expect(
      routeTuiInteraction(
        snapshot,
        interactionInput({ composerKey: { ...composerKey, value: 'x' } }),
      ),
    ).toEqual({
      disposition: 'delegated',
      effects: [{ kind: 'dismiss-exit-confirmation' }],
    })
    expect(
      routeTuiInteraction(
        snapshot,
        interactionInput({ composerKey: { ...composerKey, escape: true } }),
      ),
    ).toEqual({
      disposition: 'handled',
      effects: [
        { kind: 'dismiss-exit-confirmation' },
        { kind: 'cancel-tui-layer', target: 'elicitation-options' },
      ],
    })
  })

  it('routes Vim transitions and normal composer edits through the editing leaf', () => {
    expect(
      routeTuiInteraction(
        {
          ...base,
          composer: {
            mode: 'vim-normal',
            editor: { text: 'abc', cursor: 3 },
            lastCancelAtMs: Number.NaN,
          },
        },
        interactionInput({ composerKey: { ...composerKey, value: 'i' } }),
      ),
    ).toEqual({
      disposition: 'handled',
      effects: [{ kind: 'set-vim-insert-mode', insert: true }],
    })
    expect(
      routeTuiInteraction(
        {
          ...base,
          composer: {
            mode: 'vim-insert',
            editor: { text: 'draft', cursor: 5 },
            lastCancelAtMs: Number.NaN,
          },
        },
        interactionInput({
          composerKey: { ...composerKey, escape: true },
        }),
      ),
    ).toEqual({
      disposition: 'handled',
      effects: [{ kind: 'set-vim-insert-mode', insert: false }],
    })
    expect(
      routeTuiInteraction(
        base,
        interactionInput({ composerKey: { ...composerKey, value: 'x' } }),
      ),
    ).toEqual({
      disposition: 'handled',
      effects: [
        { kind: 'set-composer-editor', editor: { text: 'x', cursor: 1 } },
      ],
    })
  })

  it('requires a finite second cancel within 500ms to clear the draft', () => {
    const snapshot = {
      ...base,
      composer: {
        mode: 'readline' as const,
        editor: { text: 'draft', cursor: 5 },
        lastCancelAtMs: 1_000,
      },
    }
    expect(
      routeTuiInteraction(
        snapshot,
        interactionInput({ action: 'chat:cancel', timestamp: 1_500 }),
      ),
    ).toEqual({
      disposition: 'handled',
      effects: [
        { kind: 'clear-composer' },
        { kind: 'record-composer-cancel', timestamp: 1_500 },
      ],
    })
    expect(
      routeTuiInteraction(
        snapshot,
        interactionInput({ action: 'chat:cancel', timestamp: Number.NaN }),
      ),
    ).toEqual({ disposition: 'handled', effects: [] })
    expect(
      routeTuiInteraction(
        snapshot,
        interactionInput({ action: 'chat:cancel', timestamp: 999 }),
      ),
    ).toEqual({
      disposition: 'handled',
      effects: [{ kind: 'record-composer-cancel', timestamp: 999 }],
    })
  })
})
