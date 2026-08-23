import { describe, expect, it } from 'vitest'

import {
  routeTuiInteraction,
  type TuiInteractionInput,
} from './tui-interaction-router.js'

describe('routeTuiInteraction', () => {
  const base = {
    suspensionPending: false,
    blockingLayerActive: false,
    busy: false,
    viewport: { enabled: true, offset: 4, maxOffset: 10, pageRows: 5 },
  }

  it('handles Ctrl-Z before blocking or busy state and deduplicates pending suspension', () => {
    const input = {
      suspend: true,
      scrollIntent: 'none' as const,
      action: undefined,
    }
    const snapshot = {
      suspensionPending: false,
      blockingLayerActive: true,
      busy: true,
      viewport: { enabled: false, offset: 0, maxOffset: 0, pageRows: 0 },
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
        { ...base, blockingLayerActive: true },
        { suspend: false, scrollIntent: 'page-older', action: undefined },
      ),
    ).toEqual({ disposition: 'delegated', effects: [] })
    expect(
      routeTuiInteraction(base, {
        suspend: false,
        scrollIntent: 'none',
        action: undefined,
      }),
    ).toEqual({ disposition: 'delegated', effects: [] })
  })

  it('handles all scroll classes before busy policy and clamps offsets', () => {
    const busy = { ...base, busy: true }
    const route = (scrollIntent: TuiInteractionInput['scrollIntent']) =>
      routeTuiInteraction(busy, {
        suspend: false,
        scrollIntent,
        action: undefined,
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
        { suspend: false, scrollIntent: 'page-older', action: undefined },
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
          suspend: false,
          scrollIntent: 'none',
          action,
        }),
      ).toEqual({
        disposition: 'delegated',
        effects: [],
      })
    }
    expect(
      routeTuiInteraction(busy, {
        suspend: false,
        scrollIntent: 'none',
        action: 'chat:cancel',
      }),
    ).toEqual({
      disposition: 'handled',
      effects: [{ kind: 'interrupt-turn' }],
    })
    expect(
      routeTuiInteraction(busy, {
        suspend: false,
        scrollIntent: 'none',
        action: 'other',
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
        { suspend: false, scrollIntent: 'half-page-older', action: undefined },
      ),
    ).toEqual({
      disposition: 'handled',
      effects: [{ kind: 'set-transcript-scroll-offset', offset: 0 }],
    })
  })
})
