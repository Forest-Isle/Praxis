import { describe, expect, it } from 'vitest'

import type { TranscriptItem } from './claude-style.js'
import {
  FULLSCREEN_TRANSCRIPT_RESERVED_ROWS,
  projectTranscriptTail,
} from './transcript-viewport.js'
import { projectTuiView, resolveTuiRenderer } from './tui-view-model.js'

const user = (text: string): TranscriptItem => ({ kind: 'user', text })
const assistant = (text: string): TranscriptItem => ({
  kind: 'assistant',
  text,
})
const notice = (text: string): TranscriptItem => ({ kind: 'notice', text })

describe('projectTuiView', () => {
  const base = {
    fixedViewport: false,
    screenReader: false,
    rows: undefined,
    width: 80,
    scrollOffset: 0,
  }

  it('keeps an empty session fresh with the input history untouched', () => {
    const history = [notice('Using flicker-free rendering')]
    const view = projectTuiView({
      ...base,
      initialHistory: history,
      history,
      resume: false,
    })
    expect(view.freshSession).toBe(true)
    expect(view.resumed).toBe(false)
    expect(view.hasConversationHistory).toBe(false)
    expect(view.projectedHistory).toBe(history)
  })

  it('classifies a resumed session only when resume is set and real content exists', () => {
    const initialHistory = [user('continue the work'), assistant('ok')]
    const view = projectTuiView({
      ...base,
      initialHistory,
      history: initialHistory,
      resume: true,
    })
    expect(view.resumed).toBe(true)
    expect(view.freshSession).toBe(false)
    expect(view.hasConversationHistory).toBe(true)

    // Supplying a session id with an empty transcript stays fresh.
    const emptyView = projectTuiView({
      ...base,
      initialHistory: [],
      history: [],
      resume: true,
    })
    expect(emptyView.resumed).toBe(false)
    expect(emptyView.freshSession).toBe(true)
  })

  it('classifies a started conversation as not fresh and not resumed', () => {
    const history = [user('review the diff'), assistant('done')]
    const view = projectTuiView({
      ...base,
      initialHistory: [],
      history,
      resume: false,
    })
    expect(view.resumed).toBe(false)
    expect(view.freshSession).toBe(false)
    expect(view.hasConversationHistory).toBe(true)
  })

  it('preserves transcript identity and order in classic and screen-reader projections', () => {
    const history = [user('a'), assistant('b'), user('c')]
    const classic = projectTuiView({
      ...base,
      initialHistory: history,
      history,
      resume: true,
    })
    expect(classic.projectedHistory).toBe(history)

    const screenReader = projectTuiView({
      ...base,
      fixedViewport: true,
      screenReader: true,
      rows: 24,
      initialHistory: history,
      history,
      resume: true,
    })
    expect(screenReader.projectedHistory).toBe(history)
  })

  it('projects the newest transcript tail in fullscreen while preserving kept item order', () => {
    const history = Array.from({ length: 30 }, (_, index) => [
      user(`prompt ${index + 1}`),
      assistant(`reply ${index + 1}`),
    ]).flat()
    const view = projectTuiView({
      ...base,
      fixedViewport: true,
      rows: 24,
      initialHistory: history,
      history,
      resume: true,
    })
    const tail = projectTranscriptTail(
      history,
      Math.max(1, 24 - FULLSCREEN_TRANSCRIPT_RESERVED_ROWS),
      80,
    )
    expect(view.projectedHistory).toEqual(tail)
    expect(view.projectedHistory.length).toBeGreaterThan(0)
    expect(view.projectedHistory).toContain(history.at(-1))
    // Kept items appear in the original order.
    const kept = view.projectedHistory
    for (let index = 1; index < kept.length; index += 1) {
      expect(history.indexOf(kept[index] as TranscriptItem)).toBeGreaterThan(
        history.indexOf(kept[index - 1] as TranscriptItem),
      )
    }
    // The newest content is retained while the oldest is projected away.
    const projectedText = view.projectedHistory
      .filter(
        (item): item is Extract<TranscriptItem, { text: string }> =>
          'text' in item,
      )
      .map((item) => item.text)
    expect(projectedText).toContain('reply 30')
    expect(projectedText).not.toContain('prompt 1')
  })
})

describe('resolveTuiRenderer', () => {
  it('defaults interactive TTY execution to fullscreen', () => {
    expect(
      resolveTuiRenderer({
        configured: 'default',
        explicitlyConfigured: false,
        interactiveTty: true,
        screenReader: false,
      }),
    ).toBe('fullscreen')
  })

  it('retains classic for screen-reader execution', () => {
    expect(
      resolveTuiRenderer({
        configured: 'fullscreen',
        explicitlyConfigured: true,
        interactiveTty: true,
        screenReader: true,
      }),
    ).toBe('default')
  })

  it('retains classic for non-interactive execution', () => {
    expect(
      resolveTuiRenderer({
        configured: 'default',
        explicitlyConfigured: false,
        interactiveTty: false,
        screenReader: false,
      }),
    ).toBe('default')
  })

  it('honors an explicit fullscreen configuration', () => {
    expect(
      resolveTuiRenderer({
        configured: 'fullscreen',
        explicitlyConfigured: true,
        interactiveTty: true,
        screenReader: false,
      }),
    ).toBe('fullscreen')
  })

  it('honors an explicit classic configuration over the fullscreen default', () => {
    expect(
      resolveTuiRenderer({
        configured: 'default',
        explicitlyConfigured: true,
        interactiveTty: true,
        screenReader: false,
      }),
    ).toBe('default')
  })
})
