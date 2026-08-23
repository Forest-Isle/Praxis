import { describe, expect, it } from 'vitest'

import { FULLSCREEN_TRANSCRIPT_RESERVED_ROWS } from './transcript-viewport.js'
import {
  projectTranscriptPresentation,
  type TranscriptItem,
} from './transcript-presentation.js'
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
    detailedTranscript: false,
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
    expect(view.transcriptEntries).toHaveLength(1)
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
    expect(classic.transcriptEntries).toHaveLength(3)

    const screenReader = projectTuiView({
      ...base,
      fixedViewport: true,
      screenReader: true,
      rows: 24,
      initialHistory: history,
      history,
      resume: true,
    })
    expect(screenReader.transcriptEntries).toHaveLength(3)
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
    expect(view.transcriptEntries.length).toBeGreaterThan(0)
    expect(view.transcriptEntries.at(-1)?.key).toBe('item-59')
    expect(view.transcriptEntries.map((entry) => entry.key)).toEqual(
      expect.arrayContaining(['item-59']),
    )
  })

  it('projects complete presentation entries before the fullscreen viewport', () => {
    const history: TranscriptItem[] = [
      user('before'),
      {
        kind: 'tool',
        call: { id: 'call-1', name: 'Bash', input: { command: 'pwd' } },
        detail: '',
      },
      { kind: 'tool-result', callId: 'call-1', text: '/tmp', isError: false },
      {
        kind: 'tool',
        call: { id: 'read-1', name: 'Read', input: { file_path: '/a' } },
        detail: '',
      },
      { kind: 'tool-result', callId: 'read-1', text: 'a', isError: false },
      {
        kind: 'tool',
        call: { id: 'read-2', name: 'Read', input: { file_path: '/b' } },
        detail: '',
      },
      { kind: 'tool-result', callId: 'read-2', text: 'b', isError: false },
    ]
    const view = projectTuiView({
      ...base,
      fixedViewport: true,
      rows: FULLSCREEN_TRANSCRIPT_RESERVED_ROWS + 1,
      initialHistory: history,
      history,
      resume: true,
    })
    const full = projectTranscriptPresentation(history, 'normal')
    expect(view.transcriptEntries).toEqual([full.at(-1)])
    expect(full.map((entry) => entry.key)).toEqual(
      projectTranscriptPresentation(history, 'normal').map(
        (entry) => entry.key,
      ),
    )
    expect(
      view.transcriptEntries.every(
        (entry) => entry.kind !== 'orphan-tool-result',
      ),
    ).toBe(true)
  })

  it('keeps screen-reader history complete and ungrouped outside the viewport', () => {
    const history: readonly TranscriptItem[] = [
      user('inspect both files'),
      {
        kind: 'tool',
        call: { id: 'read-a', name: 'Read', input: { file_path: '/a' } },
        detail: 'Read /a',
      },
      { kind: 'tool-result', callId: 'read-a', text: 'a', isError: false },
      {
        kind: 'tool',
        call: { id: 'read-b', name: 'Read', input: { file_path: '/b' } },
        detail: 'Read /b',
      },
      { kind: 'tool-result', callId: 'read-b', text: 'b', isError: false },
      assistant('done'),
    ]

    const view = projectTuiView({
      ...base,
      fixedViewport: true,
      screenReader: true,
      rows: FULLSCREEN_TRANSCRIPT_RESERVED_ROWS + 1,
      initialHistory: history,
      history,
      resume: true,
    })

    expect(view.transcriptEntries).toEqual(
      projectTranscriptPresentation(history, 'screen-reader'),
    )
    expect(view.transcriptEntries.map((entry) => entry.kind)).toEqual([
      'item',
      'tool',
      'tool',
      'item',
    ])
    expect(view.transcriptEntries).not.toContainEqual(
      expect.objectContaining({ kind: 'read-summary' }),
    )
  })

  it('keeps classic order while switching normal summaries to audit details', () => {
    const history: readonly TranscriptItem[] = [
      user('inspect'),
      {
        kind: 'tool',
        call: { id: 'read-a', name: 'Read', input: { file_path: '/a' } },
        detail: 'Read /a',
      },
      { kind: 'tool-result', callId: 'read-a', text: 'a', isError: false },
      {
        kind: 'tool',
        call: { id: 'read-b', name: 'Read', input: { file_path: '/b' } },
        detail: 'Read /b',
      },
      { kind: 'tool-result', callId: 'read-b', text: 'b', isError: false },
      assistant('done'),
    ]
    const normal = projectTuiView({
      ...base,
      initialHistory: history,
      history,
      resume: true,
    })
    const audit = projectTuiView({
      ...base,
      detailedTranscript: true,
      initialHistory: history,
      history,
      resume: true,
    })

    expect(normal.transcriptEntries.map((entry) => entry.kind)).toEqual([
      'item',
      'read-summary',
      'item',
    ])
    expect(audit.transcriptEntries.map((entry) => entry.kind)).toEqual([
      'item',
      'tool',
      'tool',
      'item',
    ])
    expect(normal.transcriptEntries.map((entry) => entry.key)).toEqual([
      'item-0',
      'read-summary-1',
      'item-5',
    ])
    expect(audit.transcriptEntries.map((entry) => entry.key)).toEqual([
      'item-0',
      'tool-1-read-a',
      'tool-3-read-b',
      'item-5',
    ])
  })

  it('keeps retained entry keys stable across append, resize, and window movement', () => {
    const history: readonly TranscriptItem[] = Array.from(
      { length: 10 },
      (_, index) => user(`prompt-${index}`),
    )
    const project = (
      currentHistory: readonly TranscriptItem[],
      rows: number,
      width: number,
      scrollOffset: number,
    ) =>
      projectTuiView({
        ...base,
        fixedViewport: true,
        rows,
        width,
        scrollOffset,
        initialHistory: history,
        history: currentHistory,
        resume: true,
      }).transcriptEntries

    const initial = project(
      history,
      FULLSCREEN_TRANSCRIPT_RESERVED_ROWS + 8,
      80,
      0,
    )
    const appended = project(
      [...history, assistant('appended')],
      FULLSCREEN_TRANSCRIPT_RESERVED_ROWS + 8,
      80,
      0,
    )
    const resized = project(
      history,
      FULLSCREEN_TRANSCRIPT_RESERVED_ROWS + 6,
      40,
      0,
    )
    const moved = project(
      history,
      FULLSCREEN_TRANSCRIPT_RESERVED_ROWS + 8,
      80,
      2,
    )
    expect(initial.map((entry) => entry.key)).toEqual([
      'item-6',
      'item-7',
      'item-8',
      'item-9',
    ])
    expect(appended.map((entry) => entry.key)).toEqual([
      'item-7',
      'item-8',
      'item-9',
      'item-10',
    ])
    expect(resized.map((entry) => entry.key)).toEqual([
      'item-7',
      'item-8',
      'item-9',
    ])
    expect(moved.map((entry) => entry.key)).toEqual([
      'item-5',
      'item-6',
      'item-7',
      'item-8',
    ])
  })

  it('moves paired tool, paired shell, and Read summaries across boundaries atomically', () => {
    const history: readonly TranscriptItem[] = [
      {
        kind: 'tool',
        call: { id: 'tool', name: 'Glob', input: { pattern: '*' } },
        detail: 'Glob *',
      },
      {
        kind: 'tool-result',
        callId: 'tool',
        text: 'glob-result',
        isError: false,
      },
      { kind: 'shell', callId: 'shell', command: 'pwd' },
      {
        kind: 'shell-result',
        callId: 'shell',
        stdout: '/tmp',
        stderr: '',
        isError: false,
      },
      {
        kind: 'tool',
        call: { id: 'read-a', name: 'Read', input: { file_path: '/a' } },
        detail: 'Read /a',
      },
      { kind: 'tool-result', callId: 'read-a', text: 'a', isError: false },
      {
        kind: 'tool',
        call: { id: 'read-b', name: 'Read', input: { file_path: '/b' } },
        detail: 'Read /b',
      },
      { kind: 'tool-result', callId: 'read-b', text: 'b', isError: false },
      assistant('tail'),
    ]
    const full = projectTranscriptPresentation(history, 'normal')
    expect(full.map((entry) => entry.kind)).toEqual([
      'tool',
      'shell',
      'read-summary',
      'item',
    ])

    for (let scrollOffset = 0; scrollOffset <= 12; scrollOffset += 1) {
      const entries = projectTuiView({
        ...base,
        fixedViewport: true,
        rows: FULLSCREEN_TRANSCRIPT_RESERVED_ROWS + 4,
        scrollOffset,
        initialHistory: history,
        history,
        resume: true,
      }).transcriptEntries
      expect(
        entries.every((entry) =>
          full.some((fullEntry) => fullEntry.key === entry.key),
        ),
      ).toBe(true)
      expect(
        entries.some(
          (entry) =>
            entry.kind === 'orphan-tool-result' ||
            entry.kind === 'orphan-shell-result',
        ),
      ).toBe(false)
      for (const entry of entries) {
        if (entry.kind === 'tool' || entry.kind === 'shell') {
          expect(entry.result).toBeDefined()
        }
      }
    }
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
